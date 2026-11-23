import assert from "node:assert/strict";
import test from "node:test";
import { makeBucket } from "../src/providers/oci/bucket.ts";
import {
  bucketClient,
  objectClient,
  safeBucketSdk,
} from "../src/providers/oci/client.ts";
import {
  makeTrialObject,
  type ProbeReceipt,
  probeIntent,
} from "../src/providers/oci/trial-object.ts";
import { dispatcher, intent } from "./fakes/oci.ts";
import { OciWire } from "./fakes/oci-wire.ts";

async function fixture() {
  const wire = new OciWire(),
    budget = dispatcher();
  const createSdk = () =>
    safeBucketSdk({
      async send(request) {
        // At the actual SDK/HTTP boundary, every send must already have its own budget dispatch.
        assert.equal(budget.calls.length, wire.requests.length + 1);
        return wire.send(request);
      },
    });
  const sdk = createSdk();
  const buckets = makeBucket(intent, bucketClient(sdk, budget, intent.region));
  try {
    const bucket = await buckets.create();
    assert.deepEqual(await buckets.read(bucket), bucket);
    const saved = probeIntent(intent),
      client = objectClient(sdk, budget, intent.region);
    let persisted = false,
      receipt: ProbeReceipt | undefined;
    const journal = {
      async saveIntent(value: typeof saved) {
        assert.deepEqual(value, saved);
        persisted = true;
      },
      async saveReceipt(value: ProbeReceipt) {
        receipt = value;
      },
    };
    wire.beforePut = () => assert.equal(persisted, true);
    const probe = makeTrialObject({ intent: saved, bucket }, client, journal);
    return {
      wire,
      createSdk,
      budget,
      sdk,
      buckets,
      bucket,
      saved,
      client,
      journal,
      probe,
      get receipt() {
        return receipt;
      },
    };
  } catch (error) {
    sdk.close();
    throw error;
  }
}

test("offline pinned OCI SDK completes one-MiB lifecycle across fresh helpers within cleanup reserve", async (t) => {
  const f = await fixture();
  const restoredSdk = f.createSdk();
  const restoredClient = objectClient(restoredSdk, f.budget, intent.region);
  const restoredBucket = makeBucket(intent, restoredClient.bucket);
  try {
    const receipt = await f.probe.upload();
    assert.equal(
      receipt.digest,
      "fbbab289f7f94b25736c58be46a994c441fd02552cc6022352e3d86d2fab7c83",
    );
    assert.equal(f.wire.object?.bytes.length, 1048576);
    assert.deepEqual(f.receipt, receipt);
    const resumed = makeTrialObject(
      structuredClone({ intent: f.saved, bucket: f.bucket, receipt }),
      restoredClient,
      f.journal,
    );
    await resumed.read();
    await resumed.upload();
    assert.equal(f.wire.requests.filter((r) => r.method === "PUT").length, 1);
    const start = f.budget.calls.length;
    assert.ok(start <= 160);
    assert.ok(
      f.budget.calls.every((a) =>
        ["inspect", "create_bucket", "put_object"].includes(a),
      ),
    );
    await resumed.remove();
    await restoredBucket.remove(f.bucket);
    assert.equal(f.wire.object, undefined);
    assert.equal(f.wire.bucket, undefined);
    const cleanup = f.budget.calls.slice(start);

    assert.ok(cleanup.length <= 40);
    assert.ok(cleanup.length > 0);
    assert.ok(
      cleanup.every((a) =>
        ["inspect_cleanup", "delete_object", "delete_bucket"].includes(a),
      ),
    );
    assert.equal(f.budget.calls.length, f.wire.requests.length);
    const deletes = f.wire.requests.filter((r) => r.method === "DELETE");
    assert.equal(deletes.length, 2);
    assert.equal(deletes[0]?.headers.get("if-match"), receipt.etag);
    assert.equal(deletes[1]?.headers.get("if-match"), f.bucket.etag);
    const sent = f.wire.requests.length;
    await restoredBucket.remove(f.bucket);
    assert.equal(
      f.wire.requests.filter((r) => r.method === "DELETE").length,
      2,
    );
    assert.ok(f.wire.requests.length > sent); // An already-absent resource still needs authenticated listing.
    assert.ok(f.budget.calls.length - start <= 40);
    t.diagnostic(
      `normal=${start}/160; teardown=${cleanup.length}/40; including repeated absence=${f.budget.calls.length - start}/40`,
    );
  } finally {
    restoredSdk.close();
    f.sdk.close();
  }
});

test("offline SDK wire corruption foreign metadata and partial inventory cannot authorize deletion", async () => {
  for (const fault of [
    "corrupt",
    "foreignMetadata",
    "partialInventory",
    "revision",
  ] as const) {
    const f = await fixture();
    const restoredSdk = f.createSdk();
    try {
      const receipt = await f.probe.upload();
      if (fault === "revision") {
        assert.ok(f.wire.object);
        f.wire.object.etag = "foreign-revision";
      } else f.wire[fault] = true;
      const resumed = makeTrialObject(
        { intent: f.saved, bucket: f.bucket, receipt },
        objectClient(restoredSdk, f.budget, intent.region),
        f.journal,
      );
      await assert.rejects(
        resumed.remove(),
        {
          corrupt: /checksum/,
          foreignMetadata: /ownership/,
          partialInventory: /collision/,
          revision: /revision/,
        }[fault],
      );
      assert.ok(f.wire.object);
      assert.ok(f.wire.bucket);
      assert.equal(
        f.wire.requests.filter((r) => r.method === "DELETE").length,
        0,
      );
      assert.equal(f.budget.calls.length, f.wire.requests.length);
    } finally {
      restoredSdk.close();
      f.sdk.close();
    }
  }
});

test("offline SDK conditional delete rejection never retries or falls back to unconditional deletion", async () => {
  const f = await fixture();
  try {
    await f.probe.upload();
    f.wire.rejectDelete = true;
    await assert.rejects(f.probe.remove(), /precondition/);
    assert.ok(f.wire.object);
    assert.ok(f.wire.bucket);
    const deletes = f.wire.requests.filter((r) => r.method === "DELETE");
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0]?.headers.get("if-match"), f.receipt?.etag);
    assert.equal(f.budget.calls.length, f.wire.requests.length);
  } finally {
    f.sdk.close();
  }
});
