import assert from "node:assert/strict";
import test from "node:test";
import { apply, inMemoryState, Plan, Stack, Stage } from "alchemy";
import type { StackSpec } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import type { HttpRequest } from "oci-common";
import { models, ObjectStorageClient, type requests } from "oci-objectstorage";
import {
  bucketProvider,
  makeBucket,
  OciBucket,
} from "../src/providers/oci/bucket.js";
import {
  BucketFailure,
  bucketClient,
  safeBucketSdk,
} from "../src/providers/oci/client.js";
import { dispatcher, FakeOci, intent } from "./fakes/oci.js";

test("bucket plan is exact and create stamps ownership with no hidden retries", async () => {
  const fake = new FakeOci();
  const budget = dispatcher();
  const bucket = makeBucket(intent, bucketClient(fake, budget, intent.region));
  assert.deepEqual(bucket.plan(), {
    namespaceName: "fixture",
    createBucketDetails: {
      compartmentId: intent.compartment,
      name: intent.bucket,
      publicAccessType: "NoPublicAccess",
      storageTier: "Standard",
      versioning: "Disabled",
      autoTiering: "Disabled",
      objectEventsEnabled: false,
      freeformTags: {
        "berth-operation": intent.operation,
        "berth-marker": intent.marker,
      },
    },
  });
  assert.equal(fake.calls.length, 0);
  assert.equal(await bucket.read(), undefined);
  const created = await bucket.create();
  assert.equal(created.id, "ocid1.bucket.oc1..fixture");
  assert.equal(fake.creates, 1);
  assert.equal(budget.calls.length, fake.calls.length);
  assert.deepEqual(await bucket.read(created), created);
  assert.equal(
    fake.calls.every((x) => x.noRetry),
    true,
  );
});
test("bucket refuses collisions, forbidden or unavailable reads and unrecorded identity", async () => {
  for (const status of [403, 404, 500]) {
    const fake = new FakeOci();
    fake.failure = status;
    const bucket = makeBucket(
      intent,
      bucketClient(fake, dispatcher(), intent.region),
    );
    await assert.rejects(
      bucket.read(),
      (error) =>
        String(error).includes(status === 403 ? "forbidden" : "unavailable") &&
        !String(error).includes("private-canary"),
    );
    assert.equal(fake.creates, 0);
  }
  const fake = new FakeOci();
  const bucket = makeBucket(
    intent,
    bucketClient(fake, dispatcher(), intent.region),
  );
  const known = await bucket.create();
  await assert.rejects(bucket.read(), /identity-unrecorded/);
  if (!fake.value) throw Error("fixture");
  fake.value.freeformTags = { "berth-marker": "foreign" };
  await assert.rejects(bucket.read(known), /ownership/);
  await assert.rejects(bucket.create(), /ownership|identity-unrecorded/);
  assert.equal(fake.creates, 1);
});
test("bucket deletion uses fresh revision and refuses nonempty or raced resources", async () => {
  const fake = new FakeOci(),
    budget = dispatcher();
  const bucket = makeBucket(intent, bucketClient(fake, budget, intent.region));
  const known = await bucket.create();
  fake.objects = ["foreign"];
  await assert.rejects(bucket.remove(known), /not-empty/);
  assert.equal(fake.deletes, 0);
  fake.objects = [];
  fake.changeDuringEmptyCheck = true;
  await assert.rejects(bucket.remove(known), /revision/);
  assert.equal(fake.deletes, 0);
  fake.changeDuringEmptyCheck = false;
  fake.deleteFailure = 412;
  await assert.rejects(bucket.remove(known), /precondition/);
  assert.equal(fake.deletes, 1);
  fake.deleteFailure = undefined;
  await bucket.remove(known);
  assert.equal(fake.lastIfMatch, "etag-2");
  assert.equal(fake.value, undefined);
});

test("public Alchemy lifecycle plans without writes and destroys using only cleanup budget", async () => {
  const fake = new FakeOci();
  let cleanupOnly = false;
  const client = bucketClient(
    fake,
    {
      async dispatch(action, send) {
        if (
          cleanupOnly &&
          action !== "inspect_cleanup" &&
          action !== "delete_bucket"
        )
          throw new BucketFailure("budget");
        return send();
      },
    },
    intent.region,
  );
  const state: Parameters<typeof inMemoryState>[0] = {};
  async function execute(mode: "plan" | "apply" | "destroy") {
    const stack: StackSpec = {
      name: "bucket-test",
      stage: "test",
      resources: {},
      bindings: {},
      actions: {},
      output: {},
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        if (mode === "destroy") {
          yield* apply(
            yield* Plan.destroy({ name: stack.name, stage: stack.stage }),
          );
          return;
        }
        yield* OciBucket("bucket", { operation: intent.operation });
        const plan = yield* Plan.make(stack);
        if (mode === "apply") yield* apply(plan);
      }).pipe(
        Effect.provide(bucketProvider(intent, client, mode === "destroy")),
        Effect.provide(inMemoryState(state)),
        Effect.provideService(Stack, stack),
        Effect.provideService(Stage, "test"),
        Effect.timeout("5 seconds"),
      ),
    );
  }
  await execute("plan");
  assert.equal(fake.creates, 0);
  await execute("apply");
  assert.equal(fake.creates, 1);
  await execute("plan");
  assert.equal(fake.creates, 1);
  cleanupOnly = true;
  await execute("destroy");
  assert.equal(fake.deletes, 1);
  assert.equal(fake.value, undefined);
  assert.equal(Object.keys(state["bucket-test"]?.test ?? {}).length, 0);
});

test("SDK boundary refuses blank conditional revision before reserving a request", async () => {
  const fake = new FakeOci(),
    budget = dispatcher();
  const client = bucketClient(fake, budget, intent.region);
  await assert.rejects(client.remove(intent, ""), /revision/);
  assert.equal(fake.calls.length, 0);
  assert.equal(budget.calls.length, 0);
});
test("budget rejection and duplicate callback cannot dispatch unreserved SDK requests", async () => {
  const fake = new FakeOci();
  const denied = bucketClient(
    fake,
    {
      async dispatch() {
        throw new BucketFailure("budget");
      },
    },
    intent.region,
  );
  await assert.rejects(denied.list(intent), /budget/);
  assert.equal(fake.calls.length, 0);
  const twice = bucketClient(
    fake,
    {
      async dispatch(_action, send) {
        await send();
        return send();
      },
    },
    intent.region,
  );
  await assert.rejects(twice.list(intent), /budget/);
  assert.equal(fake.calls.length, 1);
});
test("configuration drift, identity changes, and partial inventory stop without mutation", async () => {
  const changes: Partial<NonNullable<FakeOci["value"]>>[] = [
    { publicAccessType: models.Bucket.PublicAccessType.ObjectRead },
    { storageTier: models.Bucket.StorageTier.Archive },
    { versioning: models.Bucket.Versioning.Enabled },
    { replicationEnabled: true },
    { objectEventsEnabled: true },
    { isReadOnly: true },
    { autoTiering: models.Bucket.AutoTiering.InfrequentAccess },
    { kmsKeyId: "foreign" },
    { objectLifecyclePolicyEtag: "foreign" },
    { isBucketKeyEnabled: true },
  ];
  for (const change of changes) {
    const fake = new FakeOci(),
      bucket = makeBucket(
        intent,
        bucketClient(fake, dispatcher(), intent.region),
      );
    const known = await bucket.create();
    Object.assign(fake.value ?? {}, change);
    await assert.rejects(bucket.remove(known), /configuration/);
    assert.equal(fake.deletes, 0);
  }
  for (const field of ["retention", "grants", "uploads"] as const) {
    const fake = new FakeOci(),
      bucket = makeBucket(
        intent,
        bucketClient(fake, dispatcher(), intent.region),
      );
    const known = await bucket.create();
    fake[field] = [{}];
    await assert.rejects(bucket.remove(known), /configuration|not-empty/);
    assert.equal(fake.deletes, 0);
  }
  const fake = new FakeOci(),
    bucket = makeBucket(
      intent,
      bucketClient(fake, dispatcher(), intent.region),
    );
  const known = await bucket.create();
  assert.ok(fake.value);
  fake.value.id = "ocid1.bucket.oc1..replaced";
  await assert.rejects(bucket.remove(known), /ownership/);
  fake.page = "next";
  await assert.rejects(bucket.read(known), /collision/);
  assert.equal(fake.deletes, 0);
  assert.throws(
    () =>
      makeBucket(
        { ...intent, bucket: "arbitrary" },
        bucketClient(fake, dispatcher(), intent.region),
      ),
    /invalid-intent/,
  );
});
test("lost create response stays uncertain and matching name is never automatically adopted", async () => {
  class LostResponse extends FakeOci {
    override async createBucket(
      r: requests.CreateBucketRequest,
    ): Promise<never> {
      await super.createBucket(r);
      throw { statusCode: 500, message: "private-canary" };
    }
  }
  const fake = new LostResponse();
  let unresolved = false;
  const bucket = makeBucket(
    intent,
    bucketClient(
      fake,
      {
        async dispatch(action, send) {
          try {
            return await send();
          } catch (error) {
            if (action === "create_bucket") unresolved = true;
            throw error;
          }
        },
      },
      intent.region,
    ),
  );
  await assert.rejects(bucket.create(), /unknown-outcome/);
  assert.equal(unresolved, true);
  await assert.rejects(bucket.create(), /identity-unrecorded/);
  assert.equal(fake.creates, 1);
  assert.ok(fake.value);
});
test("a successful delete followed by forbidden confirmation remains unverified", async () => {
  class LostConfirmation extends FakeOci {
    override async deleteBucket(r: requests.DeleteBucketRequest) {
      const result = await super.deleteBucket(r);
      this.failure = 403;
      return result;
    }
  }
  const fake = new LostConfirmation(),
    bucket = makeBucket(
      intent,
      bucketClient(fake, dispatcher(), intent.region),
    );
  const known = await bucket.create();
  await assert.rejects(bucket.remove(known), /forbidden/);
  assert.equal(fake.deletes, 1);
});

test("pinned real SDK sends conditional header once even for retryable transport errors", async () => {
  const seen: HttpRequest[] = [];
  const sdk = new ObjectStorageClient({
    httpClient: {
      async send(request) {
        seen.push(request);
        throw {
          statusCode: 500,
          code: "InternalServerError",
          message: "private-canary",
        };
      },
    },
  });
  const client = bucketClient(sdk, dispatcher(), intent.region);
  try {
    await assert.rejects(
      client.remove(intent, "etag-observed"),
      /unknown-outcome/,
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.headers.get("if-match"), "etag-observed");
    assert.equal(seen[0]?.method, "DELETE");
    assert.equal(
      new URL(seen[0]?.uri ?? "").origin,
      "https://objectstorage.eu-frankfurt-1.oraclecloud.com",
    );
    await assert.rejects(client.create(intent), /unknown-outcome/);
    assert.equal(seen.length, 2);
    const body = JSON.parse(String(seen[1]?.body)) as {
      freeformTags: Record<string, string>;
      publicAccessType: string;
      kmsKeyId?: string;
    };
    assert.equal(body.freeformTags["berth-marker"], intent.marker);
    assert.equal(body.publicAccessType, "NoPublicAccess");
    assert.equal(body.kmsKeyId, undefined);
    await assert.rejects(client.list(intent), /unavailable/);
    assert.equal(seen.length, 3);
  } finally {
    sdk.close();
  }
});

test("safe SDK construction redacts service bodies before SDK diagnostics", async () => {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.join(" "));
  };
  const sdk = safeBucketSdk({
    async send() {
      return new Response(
        JSON.stringify({ code: "Forbidden", message: "private-canary" }),
        { status: 403, headers: { "opc-request-id": "private-canary" } },
      );
    },
  });
  try {
    const client = bucketClient(sdk, dispatcher(), intent.region);
    await assert.rejects(
      client.list(intent),
      (error) =>
        error instanceof BucketFailure &&
        error.code === "forbidden" &&
        !String(error).includes("private-canary"),
    );
    assert.ok(warnings.length > 0);
    assert.equal(warnings.join().includes("private-canary"), false);
  } finally {
    console.warn = warn;
    sdk.close();
  }
});
