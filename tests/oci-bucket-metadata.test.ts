import assert from "node:assert/strict";
import test from "node:test";
import type { HttpRequest } from "oci-common";
import { models } from "oci-objectstorage";
import { makeBucket } from "../src/providers/oci/bucket.ts";
import {
  BucketFailure,
  bucketClient,
  safeBucketSdk,
} from "../src/providers/oci/client.ts";
import { dispatcher, FakeOci, intent } from "./fakes/oci.ts";

test("real SDK requests opt-in bucket metadata through read and conditional teardown", async () => {
  const fake = new FakeOci(),
    budget = dispatcher(),
    seen: HttpRequest[] = [];
  const bucketPath = `/n/${intent.namespace}/b/${intent.bucket}`;
  const sdk = safeBucketSdk({
    async send(request) {
      seen.push(request);
      const url = new URL(request.uri);
      if (url.pathname === `/n/${intent.namespace}/b`) {
        if (request.method === "GET")
          return Response.json(fake.value ? [fake.value] : []);
        assert.equal(request.method, "POST");
        const created = await fake.createBucket({
          namespaceName: intent.namespace,
          createBucketDetails: JSON.parse(String(request.body)),
        });
        return Response.json(created.bucket, {
          headers: { etag: created.eTag },
        });
      }
      if (url.pathname === bucketPath) {
        if (request.method === "DELETE") {
          await fake.deleteBucket({
            namespaceName: intent.namespace,
            bucketName: intent.bucket,
            ifMatch: request.headers.get("if-match") ?? "",
          });
          return new Response(null, { status: 204 });
        }
        assert.equal(request.method, "GET");
        assert.ok(fake.value);
        const body = structuredClone(fake.value);
        // GetBucket omits this optional field unless selected; CreateBucket returns it.
        if (!url.searchParams.get("fields")?.split(",").includes("autoTiering"))
          delete body.autoTiering;
        return Response.json(body, { headers: { etag: body.etag } });
      }
      assert.equal(request.method, "GET");
      if (url.pathname === `${bucketPath}/retentionRules`)
        return Response.json({ items: [] });
      if (url.pathname === `${bucketPath}/o`)
        return Response.json({ objects: [] });
      assert.ok([`${bucketPath}/p`, `${bucketPath}/u`].includes(url.pathname));
      return Response.json([]);
    },
  });
  try {
    const bucket = makeBucket(intent, bucketClient(sdk, budget, intent.region));
    const known = await bucket.create();
    assert.equal(fake.creates, 1);
    assert.deepEqual(await bucket.read(known), known);
    const cleanupStart = budget.calls.length;
    await bucket.remove(known);
    assert.equal(fake.value, undefined);
    assert.equal(fake.deletes, 1);
    assert.equal(fake.lastIfMatch, known.etag);
    assert.equal(seen.length, budget.calls.length);
    assert.ok(
      budget.calls
        .slice(cleanupStart)
        .every(
          (action) =>
            action === "inspect_cleanup" || action === "delete_bucket",
        ),
    );
    const reads = seen.filter(
      (r) => r.method === "GET" && new URL(r.uri).pathname === bucketPath,
    );
    assert.equal(reads.length, 3);
    assert.ok(
      reads.every(
        (r) => new URL(r.uri).searchParams.get("fields") === "autoTiering",
      ),
    );
  } finally {
    sdk.close();
  }
});

test("missing unknown or enabled auto-tiering blocks reads and deletion with a safe category", async () => {
  for (const setting of [
    undefined,
    models.Bucket.AutoTiering.UnknownValue,
    models.Bucket.AutoTiering.InfrequentAccess,
  ]) {
    const fake = new FakeOci(),
      bucket = makeBucket(
        intent,
        bucketClient(fake, dispatcher(), intent.region),
      );
    const known = await bucket.create();
    assert.ok(fake.value);
    if (setting === undefined) delete fake.value.autoTiering;
    else fake.value.autoTiering = setting;
    for (const work of [() => bucket.read(known), () => bucket.remove(known)])
      await assert.rejects(
        work(),
        (error) =>
          error instanceof BucketFailure && error.code === "configuration",
      );
    assert.equal(fake.deletes, 0);
  }
});
