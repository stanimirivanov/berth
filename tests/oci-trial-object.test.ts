import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import type { HttpRequest } from "oci-common";
import { makeBucket } from "../src/providers/oci/bucket.js";
import {
  BucketFailure,
  bucketClient,
  objectClient,
  safeBucketSdk,
} from "../src/providers/oci/client.js";
import {
  makeTrialObject,
  type ProbeReceipt,
  probeContent,
  probeIntent,
} from "../src/providers/oci/trial-object.js";
import { dispatcher, FakeObjects, intent } from "./fakes/oci.js";

async function fixture() {
  const sdk = new FakeObjects(),
    budget = dispatcher();
  const bucket = await makeBucket(
    intent,
    bucketClient(sdk, budget, intent.region),
  ).create();
  const saved = probeIntent(intent);
  let persisted = false;
  let receipt: ProbeReceipt | undefined;
  const journal = {
    async saveIntent(value: typeof saved) {
      assert.deepEqual(value, saved);
      persisted = true;
    },
    async saveReceipt(value: ProbeReceipt) {
      receipt = value;
    },
  };
  const client = objectClient(sdk, budget, intent.region);
  return {
    sdk,
    budget,
    bucket,
    saved,
    journal,
    client,
    get persisted() {
      return persisted;
    },
    get receipt() {
      return receipt;
    },
    probe: makeTrialObject({ intent: saved, bucket }, client, journal),
  };
}
test("fixed probe persists intent before create-only upload and verifies exactly one MiB", async () => {
  const f = await fixture();
  f.sdk.beforePut = () => assert.equal(f.persisted, true);
  const bytes = probeContent();
  assert.equal(bytes.length, 1048576);
  assert.equal(
    f.saved.digest,
    "fbbab289f7f94b25736c58be46a994c441fd02552cc6022352e3d86d2fab7c83",
  );
  assert.deepEqual(bytes, probeContent());
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    f.saved.digest,
  );
  const receipt = await f.probe.upload();
  assert.equal(receipt.digest, f.saved.digest);
  assert.deepEqual(f.receipt, receipt);
  assert.equal(f.sdk.puts, 1);
  assert.equal(f.sdk.lastPut?.ifNoneMatch, "*");
  assert.equal(f.sdk.lastPut?.contentLength, 1048576);
  assert.equal(f.sdk.lastPut?.opcMeta?.["berth-marker"], intent.marker);
  await f.probe.upload();
  assert.equal(f.sdk.puts, 1);
  await f.probe.remove();
  assert.equal(f.sdk.object, undefined);
  assert.equal(f.sdk.lastDelete?.ifMatch, receipt.etag);
  assert.ok(f.sdk.calls.every((c) => c.noRetry));
});
test("unrelated objects and identical bytes with wrong marker are never adopted", async () => {
  const f = await fixture();
  await f.probe.upload();
  assert.ok(f.sdk.object);
  f.sdk.object.meta["berth-marker"] = "foreign";
  await assert.rejects(f.probe.remove(), /ownership/);
  assert.equal(f.sdk.objectDeletes, 0);
  f.sdk.extra = true;
  await assert.rejects(f.probe.upload(), /collision/);
  assert.equal(f.sdk.puts, 1);
});
test("lost upload response is reconciled without a second put; missing pending upload stops", async () => {
  const f = await fixture();
  f.sdk.losePut = true;
  await assert.rejects(f.probe.upload(), /unknown-outcome/);
  const recovered = makeTrialObject(
    { intent: f.saved, bucket: f.bucket, pending: true },
    f.client,
    f.journal,
  );
  await recovered.upload();
  assert.equal(f.sdk.puts, 1);
  f.sdk.object = undefined;
  await assert.rejects(recovered.upload(), /unknown-outcome/);
  assert.equal(f.sdk.puts, 1);
});
test("conditional deletion race leaves replacement untouched and does not retry", async () => {
  const f = await fixture();
  await f.probe.upload();
  f.sdk.replaceOnDelete = true;
  await assert.rejects(f.probe.remove(), /precondition/);
  assert.equal(f.sdk.objectDeletes, 1);
  assert.equal(f.sdk.object?.etag, "replacement");
});
test("version history retention and oversized or corrupt body block cleanup", async () => {
  for (const field of [
    "versions",
    "retention",
    "corrupt",
    "oversized",
  ] as const) {
    const f = await fixture();
    await f.probe.upload();
    if (field === "retention") f.sdk.retention = [{}];
    else f.sdk[field] = true;
    await assert.rejects(f.probe.remove(), /configuration|checksum/);
    assert.equal(f.sdk.objectDeletes, 0);
  }
});

test("persisted receipt is required for repetition and fresh matching names are not adopted", async () => {
  const f = await fixture();
  await f.probe.upload();
  const fresh = makeTrialObject(
    { intent: f.saved, bucket: f.bucket },
    f.client,
    f.journal,
  );
  await assert.rejects(fresh.upload(), /identity-unrecorded/);
  assert.ok(f.receipt);
  const repeated = makeTrialObject(
    { intent: f.saved, bucket: f.bucket, receipt: f.receipt },
    f.client,
    f.journal,
  );
  await repeated.read();
  assert.equal(f.sdk.puts, 1);
  assert.ok(f.sdk.object);
  f.sdk.object.etag = "replacement";
  await assert.rejects(repeated.remove(), /revision/);
  assert.equal(f.sdk.objectDeletes, 0);
});
test("failed persistence and denied reservation never upload", async () => {
  const f = await fixture();
  const failing = makeTrialObject(
    { intent: f.saved, bucket: f.bucket },
    f.client,
    {
      ...f.journal,
      async saveIntent() {
        throw Error("private-canary");
      },
    },
  );
  await assert.rejects(
    failing.upload(),
    (error) =>
      String(error).includes("unknown-outcome") &&
      !String(error).includes("private-canary"),
  );
  assert.equal(f.sdk.puts, 0);
  const denied = makeTrialObject(
    { intent: f.saved, bucket: f.bucket },
    objectClient(
      f.sdk,
      {
        async dispatch(action, send) {
          if (action === "put_object") throw new BucketFailure("budget");
          return send();
        },
      },
      intent.region,
    ),
    f.journal,
  );
  await assert.rejects(denied.upload(), /budget/);
  assert.equal(f.sdk.puts, 0);
});
test("cleanup uses only protected reservations and auth errors never prove absence", async () => {
  const f = await fixture();
  await f.probe.upload();
  assert.ok(f.receipt);
  const cleanup = makeTrialObject(
    { intent: f.saved, bucket: f.bucket, receipt: f.receipt },
    objectClient(
      f.sdk,
      {
        async dispatch(action, send) {
          assert.ok(action === "inspect_cleanup" || action === "delete_object");
          return send();
        },
      },
      intent.region,
    ),
    f.journal,
  );
  f.sdk.failure = 403;
  await assert.rejects(cleanup.remove(), /forbidden/);
  assert.equal(f.sdk.objectDeletes, 0);
  f.sdk.failure = undefined;
  await cleanup.remove();
  assert.equal(f.sdk.objectDeletes, 1);
  await cleanup.remove();
  assert.equal(f.sdk.objectDeletes, 1);
});
test("pinned SDK serializes create-only PUT and revision-bound GET/DELETE without retries", async () => {
  const calls: HttpRequest[] = [];
  const sdk = safeBucketSdk({
    async send(request) {
      calls.push(request);
      if (request.method === "GET")
        return new Response(new Uint8Array([1]), {
          headers: {
            etag: "e1",
            "opc-meta-berth-marker": intent.marker,
            "content-length": "1",
            "storage-tier": "Standard",
          },
        });
      return new Response(null, { headers: { etag: "e1" } });
    },
  });
  try {
    const client = objectClient(sdk, dispatcher(), intent.region);
    await client.put(
      intent,
      "trial.bin",
      probeContent(),
      probeIntent(intent).digest,
    );
    assert.equal(calls[0]?.headers.get("if-none-match"), "*");
    assert.equal(calls[0]?.headers.get("content-length"), "1048576");
    assert.equal(calls[0]?.headers.get("opc-meta-berth-marker"), intent.marker);
    const result = await client.get(intent, "trial.bin", "e1", false);
    assert.equal(result.eTag, "e1");
    assert.equal(result.opcMeta["berth-marker"], intent.marker);
    if ("cancel" in result.value) await result.value.cancel();
    else result.value.destroy();
    await client.remove(intent, "trial.bin", "e1");
    assert.equal(calls.length, 3);
    assert.equal(calls[1]?.headers.get("if-match"), "e1");
    assert.equal(calls[2]?.headers.get("if-match"), "e1");
  } finally {
    sdk.close();
  }
});

test("upload response revision is persisted before a subsequent read can fail", async () => {
  const f = await fixture();
  const original = f.sdk.headObject.bind(f.sdk);
  f.sdk.headObject = async (request) => {
    assert.equal(f.receipt?.etag, "object-1");
    return original(request);
  };
  await f.probe.upload();
});
test("metadata and revision mismatches cancel the response stream without deleting", async () => {
  const f = await fixture();
  await f.probe.upload();
  let cancelled = false;
  f.sdk.getObject = async () => ({
    eTag: "replaced",
    contentLength: 1048576,
    storageTier: "Standard",
    opcMeta: {},
    value: new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    }),
  });
  await assert.rejects(f.probe.remove(), /revision/);
  assert.equal(cancelled, true);
  assert.equal(f.sdk.objectDeletes, 0);
});

test("fresh unrelated names and incomplete listings block upload without writing", async () => {
  const f = await fixture();
  f.sdk.extra = true;
  await assert.rejects(f.probe.upload(), /collision/);
  assert.equal(f.sdk.puts, 0);
  assert.equal(f.persisted, false);
  f.sdk.extra = false;
  const original = f.sdk.listObjects.bind(f.sdk);
  f.sdk.listObjects = async (request) => {
    const result = await original(request);
    return { listObjects: { ...result.listObjects, nextStartWith: "next" } };
  };
  await assert.rejects(f.probe.upload(), /collision/);
  assert.equal(f.sdk.puts, 0);
});
test("object and empty bucket teardown fit the forty-request cleanup reserve", async () => {
  const f = await fixture();
  await f.probe.upload();
  const before = f.budget.calls.length;
  await f.probe.remove();
  await makeBucket(intent, f.client.bucket).remove(f.bucket);
  const cleanup = f.budget.calls.slice(before);
  assert.ok(cleanup.length <= 40);
  assert.ok(
    cleanup.every((action) =>
      ["inspect_cleanup", "delete_object", "delete_bucket"].includes(action),
    ),
  );
  assert.equal(f.sdk.object, undefined);
  assert.equal(f.sdk.value, undefined);
});
test("real SDK object failures send once and return safe precondition diagnostics", async () => {
  let calls = 0;
  const sdk = safeBucketSdk({
    async send() {
      calls++;
      return new Response(JSON.stringify({ message: "private-canary" }), {
        status: 412,
      });
    },
  });
  try {
    const client = objectClient(sdk, dispatcher(), intent.region);
    await assert.rejects(
      client.put(
        intent,
        "trial.bin",
        probeContent(),
        probeIntent(intent).digest,
      ),
      /precondition/,
    );
    assert.equal(calls, 1);
    await assert.rejects(
      client.remove(intent, "trial.bin", "known"),
      /precondition/,
    );
    assert.equal(calls, 2);
  } finally {
    sdk.close();
  }
});

test("Node response streams are checksummed and truncated bodies stop cleanup", async () => {
  const f = await fixture();
  await f.probe.upload();
  const original = f.sdk.getObject.bind(f.sdk);
  f.sdk.getObject = async (request) => {
    const result = await original(request);
    if ("cancel" in result.value) await result.value.cancel();
    return { ...result, value: Readable.from([probeContent().slice(0, 512)]) };
  };
  await assert.rejects(f.probe.remove(), /checksum/);
  assert.equal(f.sdk.objectDeletes, 0);
  f.sdk.getObject = async (request) => {
    const result = await original(request);
    if ("cancel" in result.value) await result.value.cancel();
    return { ...result, value: Readable.from([Buffer.from(probeContent())]) };
  };
  await f.probe.read();
  assert.equal(f.sdk.puts, 1);
});
