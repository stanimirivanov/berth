import assert from "node:assert/strict";
import test from "node:test";
import { retryObserver } from "../src/providers/oci/retry-observation.js";

const scope = {
  region: "eu-frankfurt-1",
  namespace: "retryfixture",
  compartment: "ocid1.compartment.oc1..fixture",
};
const target = { ...scope, bucket: `berth-${"a".repeat(32)}` };

test("a stalled signer never dispatches and a stalled response is cancelled", async () => {
  const keepProcessAlive = setTimeout(() => {}, 1000);
  try {
    const signing = Promise.withResolvers<void>();
    let sends = 0;
    const stalledSigning = retryObserver(
      scope,
      {
        signHttpRequest: () => signing.promise,
      },
      async () => {
        sends++;
        return Response.json([]);
      },
    );
    await assert.rejects(
      stalledSigning.observe(target, "bucket", Date.now() + 50),
    );
    signing.resolve();
    assert.equal(sends, 0);

    let cancelled = false;
    const stalledBody = retryObserver(
      scope,
      { async signHttpRequest() {} },
      async () =>
        new Response(
          new ReadableStream({
            pull() {},
            cancel() {
              cancelled = true;
            },
          }),
        ),
    );
    await assert.rejects(stalledBody.observe(target, "list", Date.now() + 50));
    assert.equal(cancelled, true);
  } finally {
    clearTimeout(keepProcessAlive);
  }
});
