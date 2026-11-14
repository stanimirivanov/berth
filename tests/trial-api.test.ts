import assert from "node:assert/strict";
import test from "node:test";
import { makeTrialApi } from "../src/trial/api.js";
import type { TrialIntent, TrialRecord } from "../src/trial/ledger.js";
import { config, evidence, now } from "./fakes/admission.js";

const token = "a".repeat(40);
function fixture() {
  let headroom: unknown = evidence,
    credentials = true,
    starts = 0,
    cleanup = 0,
    time = now,
    verifyDelay = 0,
    failStart = false;
  const records = new Map<string, TrialRecord>();
  const handler = makeTrialApi({
    token,
    previewKey: "b".repeat(40),
    configuration: config,
    now: () => time,
    headroom: async () => headroom,
    verifyCredentials: async () => {
      time += verifyDelay;
      return credentials;
    },
    ledger: {
      async start(i: TrialIntent) {
        starts++;
        let r = records.get(i.operation);
        if (!r) {
          r = {
            ...i,
            marker: "00000000-0000-4000-8000-000000000002",
            bucket: `berth-${i.operation.replaceAll("-", "")}`,
            object_name: "trial.bin",
            outcome: "active",
            started_at: new Date(now).toISOString(),
            expires_at: new Date(now + 14400000).toISOString(),
          };
          records.set(i.operation, r);
        }
        if (failStart) throw Error("private-canary");
        return r;
      },
    },
    async admitCleanup(operation) {
      cleanup++;
      if (!records.has(operation)) throw Error("private-canary");
      return { operation, status: "cleanup-requested" };
    },
  });
  return {
    handler,
    records,
    set failStart(value: boolean) {
      failStart = value;
    },
    set time(value: number) {
      time = value;
    },
    set verifyDelay(value: number) {
      verifyDelay = value;
    },
    get starts() {
      return starts;
    },
    get cleanup() {
      return cleanup;
    },
    set headroom(value: unknown) {
      headroom = value;
    },
    set credentials(value: boolean) {
      credentials = value;
    },
  };
}
function request(route: string, body: unknown = {}, auth = token) {
  return new Request(`https://trial.invalid/${route}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${auth}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
test("authenticated preview is exact and read-only; submission reuses the previewed operation", async () => {
  const f = fixture();
  assert.equal(
    (await f.handler.fetch(request("preview", {}, "wrong"))).status,
    401,
  );
  const preview = await (await f.handler.fetch(request("preview"))).json();
  assert.equal(f.starts, 0);
  assert.equal(preview.proposal.object.bytes, 1048576);
  assert.equal(preview.coverage, "partial-owner-attested");
  assert.equal(preview.hardSpendingCap, false);
  const a = await (
    await f.handler.fetch(request("submit", { preview: preview.preview }))
  ).json();
  const b = await (
    await f.handler.fetch(request("submit", { preview: preview.preview }))
  ).json();
  assert.equal(a.operation, b.operation);
  assert.equal(f.records.size, 1);
  assert.equal(a.runtimeExpiresAt, a.deploymentExpiresAt);
});
test("target/action injection invalid credentials and tampered preview never submit", async () => {
  const f = fixture();
  for (const body of [
    { region: "other" },
    { action: "delete" },
    { token: "private-canary" },
  ])
    assert.equal((await f.handler.fetch(request("preview", body))).status, 400);
  f.credentials = false;
  assert.equal((await f.handler.fetch(request("preview"))).status, 403);
  f.credentials = true;
  const p = await (await f.handler.fetch(request("preview"))).json();
  assert.equal(
    (await f.handler.fetch(request("submit", { preview: `${p.preview}x` })))
      .status,
    400,
  );
  assert.equal(
    (
      await f.handler.fetch(
        request("submit", { preview: p.preview, compartment: "other" }),
      )
    ).status,
    400,
  );
  assert.equal(f.starts, 0);
});
test("stale or missing headroom blocks creation but cannot block owned cleanup admission", async () => {
  const f = fixture();
  const p = await (await f.handler.fetch(request("preview"))).json();
  const submitted = await (
    await f.handler.fetch(request("submit", { preview: p.preview }))
  ).json();
  f.headroom = undefined;
  f.credentials = false;
  assert.equal(
    (await f.handler.fetch(request("submit", { preview: p.preview }))).status,
    409,
  );
  assert.equal(
    (
      await f.handler.fetch(
        request("cleanup", { operation: submitted.operation }),
      )
    ).status,
    202,
  );
  assert.equal(f.cleanup, 1);
  const failure = await f.handler.fetch(
    request("cleanup", { operation: "00000000-0000-4000-8000-000000000000" }),
  );
  assert.equal(failure.status, 503);
  assert.equal((await failure.text()).includes("private-canary"), false);
});

test("preview expires during credential verification and is never submitted", async () => {
  const f = fixture();
  const p = await (await f.handler.fetch(request("preview"))).json();
  f.verifyDelay = 300000;
  assert.equal(
    (await f.handler.fetch(request("submit", { preview: p.preview }))).status,
    400,
  );
  assert.equal(f.starts, 0);
});
test("oversized envelopes and backend errors never leak sentinels or accept arbitrary fields", async () => {
  const f = fixture();
  const huge = await f.handler.fetch(
    request("preview", { secret: "private-canary".repeat(200) }),
  );
  assert.equal(huge.status, 400);
  assert.equal((await huge.text()).includes("private-canary"), false);
  const query = new Request("https://trial.invalid/preview?target=foreign", {
    method: "POST",
  });
  assert.equal((await f.handler.fetch(query)).status, 404);
  assert.equal(
    (await f.handler.fetch(request("cleanup", { operation: "bad" }))).status,
    400,
  );
});

test("uncertain submission returns only the stable operation for reconciliation", async () => {
  const f = fixture();
  const p = await (await f.handler.fetch(request("preview"))).json();
  f.failStart = true;
  const response = await f.handler.fetch(
    request("submit", { preview: p.preview }),
  );
  assert.equal(response.status, 503);
  const result = await response.json();
  assert.equal(result.operation, [...f.records.keys()][0]);
  assert.equal(JSON.stringify(result).includes("private-canary"), false);
  f.failStart = false;
  const repeated = await f.handler.fetch(
    request("submit", { preview: p.preview }),
  );
  assert.equal(repeated.status, 202);
  assert.equal(f.records.size, 1);
});

test("private usage reports bypass creation headroom and never invoke cloud ports", async () => {
  let reads = 0;
  const operation = "00000000-0000-4000-8000-000000000001";
  const handler = makeTrialApi({
    token,
    previewKey: "b".repeat(40),
    configuration: config,
    headroom: async () => {
      throw Error("must not collect");
    },
    verifyCredentials: async () => {
      throw Error("must not contact OCI");
    },
    ledger: {
      start: async () => {
        throw Error();
      },
    },
    admitCleanup: async () => {
      throw Error();
    },
    readUsage: async (op) => {
      reads++;
      return {
        operation: op,
        evidence: "inconclusive",
        coverage: "bucket-operational-not-billing",
        providerHardCap: false,
        threshold: { bytes: 2097152, warningPercent: 50, enforcement: "app" },
        history: [],
        warnings: [],
        uploadedAt: null,
        closedAt: null,
        secret: "private-canary",
      };
    },
  });
  assert.equal(
    (await handler.fetch(request("usage", { operation }, "wrong"))).status,
    401,
  );
  assert.equal(reads, 0);
  assert.equal(
    (await handler.fetch(request("usage", { operation, extra: true }))).status,
    400,
  );
  const response = await handler.fetch(request("usage", { operation }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.evidence, "inconclusive");
  assert.equal(body.providerHardCap, false);
  assert.equal(body.secret, undefined);
  assert.equal(reads, 1);
});

test("read-only usage failures have a fixed diagnostic without uncertain-mutation claims", async () => {
  const operation = "00000000-0000-4000-8000-000000000001";
  const handler = makeTrialApi({
    token,
    previewKey: "b".repeat(40),
    configuration: config,
    headroom: async () => {
      throw Error();
    },
    verifyCredentials: async () => false,
    ledger: {
      start: async () => {
        throw Error();
      },
    },
    admitCleanup: async () => {
      throw Error();
    },
    readUsage: async () => {
      throw Error("private-canary");
    },
  });
  const response = await handler.fetch(request("usage", { operation }));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "usage-unavailable",
    operation,
  });
});

test("prepared API previews bind one fixed operation and reject previews from another deployment", async () => {
  const operation = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const options = {
    token,
    previewKey: "b".repeat(40),
    configuration: config,
    headroom: async () => evidence,
    verifyCredentials: async () => true,
    now: () => now,
    ledger: {
      start: async () => {
        throw Error("must not start");
      },
    },
    admitCleanup: async () => ({
      operation,
      status: "cleanup-requested" as const,
    }),
    operation,
  };
  const handler = makeTrialApi(options);
  const preview = await (await handler.fetch(request("preview"))).json();
  assert.equal(
    preview.proposal.bucket.name,
    `berth-${operation.replaceAll("-", "")}`,
  );
  const changedBinding = makeTrialApi({
    ...options,
    binding: "changed-key-or-window",
  });
  assert.equal(
    (
      await changedBinding.fetch(
        request("submit", { preview: preview.preview }),
      )
    ).status,
    400,
  );
  const other = makeTrialApi({
    ...options,
    operation: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  });
  assert.equal(
    (await other.fetch(request("submit", { preview: preview.preview }))).status,
    400,
  );
});
