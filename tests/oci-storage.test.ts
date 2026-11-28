import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { ociStorageApi } from "../src/application/oci-storage/api.ts";
import type { StorageSnapshot } from "../src/application/oci-storage/contract.ts";
import {
  ociStorageEvidence,
  storageEvidenceSigner,
} from "../src/providers/oci/storage-evidence.ts";

const tenancy = "ocid1.tenancy.oc1..storagefixture";
const region = "eu-frankfurt-1";
const now = Date.parse("2026-11-28T10:00:00.000Z");
const iso = (time: number) => new Date(time).toISOString();
const token = "s".repeat(40);
const home = [{ regionName: region, isHomeRegion: true, status: "READY" }];
const eligibility = {
  tenancy,
  region,
  observedAt: iso(now - 60_000),
  plan: "always-free-only",
} as const;

/** Run signed fixed-scope requests through the fixture response queue. */
function collector(responses: Response[], account: unknown = eligibility) {
  const urls: URL[] = [];
  const collect = ociStorageEvidence(
    { tenancy, region },
    account,
    {
      async signHttpRequest(request) {
        request.headers.set("authorization", "fixture-signature");
      },
    },
    async (url, options) => {
      if (options?.method === "POST") return availability({ items: [] });
      assert.equal(options?.method, "GET");
      assert.equal(options.redirect, "error");
      assert.equal(
        new Headers(options.headers).get("authorization"),
        "fixture-signature",
      );
      assert.ok(options.signal);
      urls.push(new URL(String(url)));
      const response = responses.shift();
      assert.ok(response);
      return response;
    },
    () => now,
  );
  return { collect, urls };
}

/** Mirror the sanitized regional service-limit example and stamp the response time. */
function availability(
  body: unknown = { used: 46_377, available: 21_474_790_103 },
) {
  return Response.json(body, {
    headers: { date: new Date(now).toUTCString() },
  });
}

test("uses the single verified home region and tenancy-root bytes counter for the shared allowance", async () => {
  const { collect, urls } = collector([Response.json(home), availability()]);
  assert.partialDeepStrictEqual(await collect(), {
    gap: "accounting-cutoff-unverified",
    reading: {
      source: "OCI",
      usedBytes: 46_377,
      limitBytes: 20_000_000_000,
      respondedAt: iso(now),
      accountingCutoff: null,
      observedAt: iso(now),
      expiresAt: iso(now + 2 * 3_600_000),
    },
  });
  assert.equal(urls.length, 2);
  assert.match(
    urls[0]?.href ?? "",
    /identity\.eu-frankfurt-1\.oci\.oraclecloud\.com\/20160918\/tenancies\/.*\/regionSubscriptions$/,
  );
  assert.equal(urls[1]?.hostname, "limits.eu-frankfurt-1.oci.oraclecloud.com");
  assert.equal(
    urls[1]?.pathname,
    "/20190729/services/object-storage/limits/storage-bytes/resourceAvailability",
  );
  assert.deepEqual(
    [...(urls[1]?.searchParams ?? [])],
    [["compartmentId", tenancy]],
  );
});

test("one signed tenancy query retains reported request and outbound quantities without inferring accounting completeness", async () => {
  const responses = [
    Response.json(home),
    availability(),
    new Response(
      '{"items":[' +
        '{"skuPartNumber":"B91627","unit":"10K Requests","computedQuantity":0.0085000000000000001,"timeUsageStarted":"2026-11-01T00:00:00Z","timeUsageEnded":"2026-11-02T00:00:00Z"},' +
        '{"skuPartNumber":"B88327","unit":"GB","computedQuantity":0.00000000101,"timeUsageStarted":"2026-11-27T00:00:00Z","timeUsageEnded":"2026-11-28T00:00:00Z"}' +
        "]}",
      { headers: { date: new Date(now).toUTCString() } },
    ),
  ];
  const observed: string[] = [];
  const collect = ociStorageEvidence(
    { tenancy, region },
    eligibility,
    {
      async signHttpRequest(request) {
        if (request.method === "POST") {
          assert.equal(typeof request.body, "string");
          observed.push(String(request.body));
        }
      },
    },
    async (url, options) => {
      if (options?.method === "POST") {
        assert.equal(
          String(url),
          "https://usageapi.eu-frankfurt-1.oci.oraclecloud.com/20200107/usage?limit=200",
        );
        assert.equal(options.body, observed[0]);
        assert.deepEqual(JSON.parse(String(options.body)), {
          tenantId: tenancy,
          timeUsageStarted: "2026-11-01T00:00:00.000Z",
          timeUsageEnded: "2026-11-28T00:00:00.000Z",
          granularity: "DAILY",
          queryType: "USAGE_ONLY",
          isAggregateByTime: false,
          groupBy: ["skuPartNumber", "unit"],
          filter: {
            operator: "OR",
            dimensions: ["B91627", "B88327", "B93455", "B93456"].map(
              (value) => ({ key: "skuPartNumber", value }),
            ),
          },
        });
        assert.equal(options.redirect, "error");
        assert.ok(options.signal);
      }
      const response =
        options?.method === "POST" ? responses.pop() : responses.shift();
      assert.ok(response);
      return response;
    },
    () => now,
  );
  const common = {
    periodStart: "2026-11-01T00:00:00.000Z",
    periodEnd: "2026-12-01T00:00:00.000Z",
    accountingCutoff: null,
    source: "OCI Usage API",
    coverage: "partial",
    respondedAt: iso(now),
    observedAt: iso(now),
    expiresAt: iso(now + 7_200_000),
  };
  assert.partialDeepStrictEqual(await collect(), {
    gap: "accounting-cutoff-unverified",
    monthly: {
      requests: {
        gap: "accounting-cutoff-unverified",
        reading: {
          ...common,
          sku: "B91627",
          used: 86,
          reportedThrough: "2026-11-02T00:00:00.000Z",
        },
      },
      outbound: {
        gap: "accounting-cutoff-unverified",
        reading: {
          ...common,
          sku: "B88327",
          used: 1,
          reportedThrough: "2026-11-28T00:00:00.000Z",
        },
      },
    },
  });
  assert.equal(observed.length, 1);
  assert.equal(responses.length, 0);
});

test("missing or invalid monthly coverage preserves independently usable meter observations", async () => {
  const usage = {
    skuPartNumber: "B91627",
    unit: "10K Requests",
    computedQuantity: 0.001,
    timeUsageStarted: "2026-11-01T00:00:00Z",
    timeUsageEnded: "2026-11-02T00:00:00Z",
  };
  const outbound = { ...usage, skuPartNumber: "B88327", unit: "GB" };
  for (const [items, requests, transfer, headers] of [
    [[usage], "accounting-cutoff-unverified", "usage-coverage-unverified"],
    [
      [usage, { ...outbound, unit: "GB Months" }],
      "accounting-cutoff-unverified",
      "usage-coverage-unverified",
    ],
    [
      [usage, usage, outbound],
      "usage-coverage-unverified",
      "accounting-cutoff-unverified",
    ],
    [
      [{ ...usage, computedQuantity: 0 }, outbound],
      "usage-coverage-unverified",
      "accounting-cutoff-unverified",
    ],
    [
      [{ ...usage, computedQuantity: "0.001" }, outbound],
      "usage-coverage-unverified",
      "accounting-cutoff-unverified",
    ],
    [
      [{ ...usage, timeUsageStarted: "2026-10-31T00:00:00Z" }, outbound],
      "usage-coverage-unverified",
      "accounting-cutoff-unverified",
    ],
    [
      [usage, outbound, { ...outbound, skuPartNumber: "B93456" }],
      "accounting-cutoff-unverified",
      "outbound-scope-unverified",
    ],
    [
      [usage, outbound],
      "usage-coverage-unverified",
      "usage-coverage-unverified",
      { "opc-next-page": "page2" },
    ],
  ] as const) {
    const collect = ociStorageEvidence(
      { tenancy, region },
      eligibility,
      { async signHttpRequest() {} },
      async (url, init) => {
        if (init?.method === "POST") {
          return Response.json(
            { items },
            { headers: { date: new Date(now).toUTCString(), ...headers } },
          );
        }
        return String(url).includes("/regionSubscriptions")
          ? Response.json(home)
          : availability();
      },
      () => now,
    );
    const result = await collect();
    assert.equal(result.reading?.usedBytes, 46_377);
    assert.equal(result.monthly?.requests.gap, requests);
    assert.equal(result.monthly?.outbound.gap, transfer);
  }
});

test("the new UTC month has no elapsed day to query and does not reuse the previous period", async () => {
  const monthStart = Date.parse("2026-12-01T00:00:00.000Z");
  let posts = 0;
  const collect = ociStorageEvidence(
    { tenancy, region },
    { ...eligibility, observedAt: iso(monthStart - 1_000) },
    { async signHttpRequest() {} },
    async (url, init) => {
      if (init?.method === "POST") posts++;
      if (String(url).includes("/regionSubscriptions"))
        return Response.json(home);
      return Response.json(
        { used: 46_377, available: 21_474_790_103 },
        {
          headers: { date: new Date(monthStart).toUTCString() },
        },
      );
    },
    () => monthStart,
  );
  const result = await collect();
  assert.equal(posts, 0);
  assert.equal(result.reading?.usedBytes, 46_377);
  assert.deepEqual(result.monthly, {
    requests: { gap: "usage-coverage-unverified", reading: null },
    outbound: { gap: "usage-coverage-unverified", reading: null },
  });
});

test("only an in-window IMF-fixdate qualifies as OCI response time", async () => {
  for (const [date, valid] of [
    ["Sat, 28 Nov 2026 10:00:00 GMT", true],
    ["Sat, 28 Nov 2026 09:59:30 GMT", true],
    ["2026-11-28T10:00:00.000Z", false],
    ["Fri, 28 Nov 2026 10:00:00 GMT", false],
    ["Sat, 28 Nov 2026 09:59:29 GMT", false],
    ["Sat, 28 Nov 2026 10:00:01 GMT", false],
  ] as const) {
    const { collect } = collector([
      Response.json(home),
      Response.json(
        { used: 46_377, available: 21_474_790_103 },
        { headers: { date } },
      ),
    ]);
    const evidence = await collect();
    assert.equal(
      evidence.gap,
      valid ? "accounting-cutoff-unverified" : "response-time-unverified",
      date,
    );
    assert.equal(evidence.reading?.accountingCutoff ?? null, null);
  }
});

test("the pinned OCI signer signs both fixed GETs with the configured identity", async () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const fingerprint = createHash("md5")
    .update(keys.publicKey.export({ type: "spki", format: "der" }))
    .digest("hex")
    .match(/../g)
    ?.join(":");
  const user = "ocid1.user.oc1..storagefixture";
  const signer = storageEvidenceSigner(
    tenancy,
    user,
    keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    fingerprint,
  );
  const responses = [
    Response.json(home),
    availability(),
    availability({ items: [] }),
  ];
  const collect = ociStorageEvidence(
    { tenancy, region },
    eligibility,
    signer,
    async (_input, init) => {
      const headers = new Headers(init?.headers);
      if (init?.method === "POST") {
        const body = String(init.body);
        assert.equal(
          headers.get("content-length"),
          String(Buffer.byteLength(body)),
        );
        assert.equal(
          headers.get("x-content-sha256"),
          createHash("sha256").update(body).digest("base64"),
        );
      } else {
        assert.equal(init?.method, "GET");
      }
      const authorization = new Headers(init?.headers).get("authorization");
      assert.ok(
        authorization?.includes(`keyId="${tenancy}/${user}/${fingerprint}"`),
      );
      assert.ok(authorization?.includes("rsa-sha256"));
      const response =
        init?.method === "POST" ? responses.pop() : responses.shift();
      assert.ok(response);
      return response;
    },
    () => now,
  );
  assert.equal((await collect()).gap, "accounting-cutoff-unverified");
  assert.equal(responses.length, 0);
});

test("stops for expired or mismatched plan evidence before an OCI call", async () => {
  for (const [key, value] of [
    ["observedAt", iso(now - 24 * 3_600_000)],
    ["tenancy", "wrong"],
    ["plan", "trial"],
  ]) {
    const { collect, urls } = collector([], {
      ...eligibility,
      [String(key)]: value,
    });
    assert.partialDeepStrictEqual(await collect(), {
      gap: "account-unverified",
      reading: null,
    });
    assert.equal(urls.length, 0);
  }
});

test("keeps the reading unknown for partial regions, pagination, missing bytes and unavailable reads", async () => {
  const examples = [
    {
      responses: [
        Response.json([
          ...home,
          { regionName: "us-ashburn-1", status: "IN_PROGRESS" },
        ]),
      ],
      gap: "region-coverage-unverified",
      calls: 1,
    },
    {
      responses: [
        Response.json(home, { headers: { "opc-next-page": "next" } }),
      ],
      gap: "region-coverage-unverified",
      calls: 1,
    },
    {
      responses: [
        Response.json(home),
        availability({ computedQuantity: 0, unit: "GB Months" }),
      ],
      gap: "storage-coverage-unverified",
      calls: 2,
    },
    {
      responses: [Response.json(home), Response.json({ used: 0 })],
      gap: "storage-coverage-unverified",
      calls: 2,
    },
    {
      responses: [
        Response.json(home),
        Response.json({ used: 0, available: 20_000_000_000 }),
      ],
      gap: "response-time-unverified",
      calls: 2,
    },
    {
      responses: [Response.json(home), availability({ used: 0, available: 0 })],
      gap: "storage-coverage-unverified",
      calls: 2,
    },
    {
      responses: [new Response(null, { status: 403 })],
      gap: "region-coverage-unverified",
      calls: 1,
    },
  ];
  for (const { responses, gap, calls } of examples) {
    const { collect, urls } = collector(responses);
    assert.partialDeepStrictEqual(await collect(), { gap, reading: null });
    assert.equal(urls.length, calls);
  }
});

test("protected snapshot reads never collect and a repeated schedule slot dispatches only once", async () => {
  let calls = 0;
  let snapshot: StorageSnapshot = {
    attemptedAt: null,
    gap: null,
    reading: null,
  };
  const api = ociStorageApi(
    token,
    {
      async read() {
        return snapshot;
      },
      async claim(attemptedAt) {
        if (snapshot.attemptedAt) return false;
        snapshot = { ...snapshot, attemptedAt };
        return true;
      },
      async finish(attemptedAt, result) {
        snapshot = { attemptedAt, ...result };
      },
    },
    async () => {
      calls++;
      return { gap: "storage-coverage-unverified", reading: null };
    },
    "fixture",
    () => now,
  );
  const get = (access = "") =>
    new Request("https://fixture.test/api/inventory/oci-storage", {
      headers: { authorization: access },
    });
  const schedule = (native = true) =>
    new Request("https://fixture.test/scheduled", {
      method: "POST",
      headers: native
        ? { "x-neon-trigger-invocation-id": "fixture-delivery" }
        : {},
      body: JSON.stringify({
        version: 1,
        invocation_id: "fixture-delivery",
        trigger: { id: "fixture", type: "schedule" },
        data: { scheduled_at: iso(now) },
      }),
    });
  assert.equal((await api.fetch(get())).status, 401);
  assert.deepEqual(
    await (await api.fetch(get(`Bearer ${token}`))).json(),
    snapshot,
  );
  assert.equal((await api.fetch(schedule(false))).status, 401);
  assert.equal(calls, 0);
  assert.equal((await api.fetch(schedule())).status, 200);
  assert.equal((await api.fetch(schedule())).status, 200);
  assert.deepEqual(await (await api.fetch(get(`Bearer ${token}`))).json(), {
    attemptedAt: iso(now),
    gap: "storage-coverage-unverified",
    reading: null,
  });
  assert.equal(calls, 1);
});
