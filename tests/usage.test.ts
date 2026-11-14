import assert from "node:assert/strict";
import test from "node:test";
import { readMetric, usageQuery } from "../src/providers/oci/usage.js";

const uploadedAt = Date.parse("2026-11-14T00:10:00Z"),
  now = uploadedAt + 7200000;
const target = {
  bucketId: "ocid1.bucket.oc1..fixture",
  bucket: "berth-fixture",
  compartment: "ocid1.compartment.oc1..fixture",
  uploadedAt,
};
function stream(name = "StoredBytes", value = 1048576, at = now - 600000) {
  return [
    {
      namespace: "oci_objectstorage",
      name,
      compartmentId: target.compartment,
      dimensions: {
        resourceID: target.bucketId,
        resourceDisplayName: target.bucket,
        ...(name === "AllRequests" ? {} : { tier: "Standard" }),
      },
      aggregatedDatapoints: [{ timestamp: new Date(at).toISOString(), value }],
    },
  ];
}
test("bucket metric queries select only the owned resource and fixed statistics", () => {
  assert.match(
    usageQuery("StoredBytes", target, now).query,
    /resourceID = "ocid1.bucket.oc1..fixture"/,
  );
  assert.match(usageQuery("StoredBytes", target, now).query, /\.max\(\)$/);
  assert.match(usageQuery("AllRequests", target, now).query, /\.sum\(\)$/);
  assert.throws(() =>
    usageQuery("StoredBytes", { ...target, bucketId: 'bad"query' }, now),
  );
});
test("fresh complete post-upload windows preserve source and observation times", () => {
  const result = readMetric("StoredBytes", stream(), target, now);
  assert.equal(result.value, 1048576);
  assert.equal(result.sourceAt, new Date(now - 600000).toISOString());
  assert.equal(result.observedAt, new Date(now).toISOString());
  assert.equal(result.status, "known");
  assert.equal(
    readMetric("StoredBytes", stream("StoredBytes", 0), target, now).value,
    0,
  );
});
test("missing, stale, future, pre-upload and malformed data remain unknown", () => {
  for (const raw of [
    [],
    null,
    stream("StoredBytes", -1),
    stream("StoredBytes", NaN),
    stream("StoredBytes", 1, uploadedAt + 1),
    stream("StoredBytes", 1, now + 1),
    stream("StoredBytes", 1, now - 5400001),
  ]) {
    const result = readMetric("StoredBytes", raw, target, now);
    assert.equal(result.status, "unknown");
    assert.equal(result.value, null);
  }
});
test("wrong bucket, compartment, tier and ambiguous streams cannot warn", () => {
  const raw = stream();
  for (const changed of [
    { ...raw[0], compartmentId: "other" },
    { ...raw[0], dimensions: { ...raw[0]?.dimensions, resourceID: "other" } },
    { ...raw[0], dimensions: { ...raw[0]?.dimensions, tier: "Archive" } },
  ])
    assert.equal(
      readMetric("StoredBytes", [changed], target, now).status,
      "unknown",
    );
  assert.equal(
    readMetric("StoredBytes", [...raw, ...raw], target, now).status,
    "unknown",
  );
  assert.equal(
    readMetric("AllRequests", stream("AllRequests", 7), target, now).value,
    7,
  );
});

test("Monitoring transport bounds bodies, rejects pagination and never retries", async () => {
  const { monitoringTransport } = await import("../src/providers/oci/usage.js");
  for (const mode of ["oversize", "pagination", "error"]) {
    let calls = 0,
      cancelled = false;
    const transport = monitoringTransport(
      "eu-frankfurt-1",
      target.compartment,
      { signHttpRequest() {} },
      async () => {
        calls++;
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(65537));
            },
            cancel() {
              cancelled = true;
            },
          }),
          {
            status: mode === "error" ? 500 : 200,
            headers: mode === "pagination" ? { "opc-next-page": "next" } : {},
          },
        );
      },
    );
    await assert.rejects(
      transport(
        usageQuery("StoredBytes", target, now),
        new AbortController().signal,
      ),
    );
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
  }
});

test("Monitoring transport preserves a fixed signed target and parsed source payload", async () => {
  const { monitoringTransport } = await import("../src/providers/oci/usage.js");
  let sends = 0;
  const transport = monitoringTransport(
    "eu-frankfurt-1",
    target.compartment,
    {
      signHttpRequest(r) {
        assert.equal(r.method, "POST");
      },
    },
    async (url, init) => {
      sends++;
      assert.ok(
        String(url).startsWith(
          "https://telemetry.eu-frankfurt-1.oraclecloud.com/20180401/metrics/actions/summarizeMetricsData?compartmentId=",
        ),
      );
      assert.equal(init?.redirect, "error");
      return Response.json(stream());
    },
  );
  assert.deepEqual(
    await transport(
      usageQuery("StoredBytes", target, now),
      new AbortController().signal,
    ),
    stream(),
  );
  assert.equal(sends, 1);
});

test("standard tier spelling is normalized without accepting archive data", () => {
  const raw = stream();
  const first = raw[0];
  if (!first) throw Error();
  first.dimensions.tier = "standard";
  assert.equal(readMetric("StoredBytes", raw, target, now).status, "known");
});
