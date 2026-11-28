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
  assert.deepEqual(await collect(), {
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
  const responses = [Response.json(home), availability()];
  const collect = ociStorageEvidence(
    { tenancy, region },
    eligibility,
    signer,
    async (_input, init) => {
      assert.equal(init?.method, "GET");
      const authorization = new Headers(init?.headers).get("authorization");
      assert.ok(
        authorization?.includes(`keyId="${tenancy}/${user}/${fingerprint}"`),
      );
      assert.ok(authorization?.includes("rsa-sha256"));
      const response = responses.shift();
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
    assert.deepEqual(await collect(), {
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
    assert.deepEqual(await collect(), { gap, reading: null });
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
