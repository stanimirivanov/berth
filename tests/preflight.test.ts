import assert from "node:assert/strict";
import test from "node:test";
import { createProposal } from "../src/providers/oci/client.ts";
import { probeIntent } from "../src/providers/oci/trial-object.ts";
import {
  preflight,
  proposal,
  trialWindow,
  validateConfiguration,
} from "../src/trial/preflight.ts";
import { config, evidence, now } from "./fakes/admission.ts";

test("headroom accepts exact bounds and rejects stale unknown or insufficient allowances", () => {
  assert.deepEqual(preflight(config, evidence, now), []);
  for (const change of [
    { checkedAt: now - 86400001 },
    { checkedAt: now + 1 },
    { homeRegion: "us-ashburn-1" },
    { storageBytes: 10485759 },
    { objectRequests: 199 },
    { neonFree: false },
    { measuredComputeSeconds: 0 },
    { neonComputeSeconds: 59 },
    { monitoringRequests: 9 },
    { accountType: "paid" },
    { transferBytes: 0 },
  ])
    assert.ok(preflight(config, { ...evidence, ...change }, now).length);
  assert.ok(preflight(config, undefined, now).length);
});
test("runtime and deployment use the same ledger four-hour window", () => {
  const started = new Date(now).toISOString(),
    expires = new Date(now + 14400000).toISOString();
  assert.deepEqual(trialWindow(started, expires), {
    startedAt: started,
    runtimeExpiresAt: expires,
    deploymentExpiresAt: expires,
  });
  assert.throws(() =>
    trialWindow(started, new Date(now + 1200000).toISOString()),
  );
});

test("proposal agrees with the implemented provider settings and deterministic payload", () => {
  const operation = "00000000-0000-4000-8000-000000000001";
  const p = proposal(config, operation);
  const intent = {
    ...config,
    operation,
    marker: "00000000-0000-4000-8000-000000000002",
    bucket: p.bucket.name,
  };
  const bucket = createProposal(intent).createBucketDetails;
  for (const name of [
    "name",
    "publicAccessType",
    "storageTier",
    "versioning",
    "autoTiering",
    "objectEventsEnabled",
  ] as const)
    assert.equal(p.bucket[name], bucket[name]);
  assert.equal(p.object.sha256, probeIntent(intent).digest);
  assert.equal(p.object.name, "trial.bin");
  assert.throws(() =>
    validateConfiguration({ ...config, namespace: "bad/path" }),
  );
});

test("one-trial exception accepts unknown Functions only with bound owner commitments", () => {
  const c = { ...config, neonLimit: 64 };
  const context = {
    operation: "00000000-0000-4000-8000-000000000055",
    startedAt: now,
    expiresAt: now + 14400000,
  };
  const {
    neonInvocations: _i,
    neonComputeSeconds: _c,
    measuredComputeSeconds: _m,
    ...other
  } = evidence;
  const exceptional = {
    ...other,
    functionsMode: "free-functions-one-trial",
    functionsException: {
      ...context,
      unknownAllowanceAccepted: true,
      partialVerdictAccepted: true,
      exclusiveProjectUse: true,
      manualRecoveryReady: true,
      otherServicesEvidence: "owner-review-2026-11-15",
      shutdownBy: context.expiresAt + 900000,
      probeClientMs: 2252,
      scenario: "64x60-plus36x60-v1",
    },
  };
  assert.deepEqual(preflight(c, exceptional, now, context), []);
  assert.ok(preflight(c, exceptional, now).length);
  for (const change of [
    { functionsMode: "unknown" },
    { neonInvocations: 1000 },
    { neonComputeSeconds: 0 },
    { measuredComputeSeconds: 6000 },
    { neonFree: false },
    { storageBytes: 0 },
    { objectRequests: 199 },
    { monitoringRequests: 0 },
    { transferBytes: 0 },
    { checkedAt: now - 86340000 },
  ])
    assert.ok(preflight(c, { ...exceptional, ...change }, now, context).length);
  for (const change of [
    { operation: "00000000-0000-4000-8000-000000000056" },
    { startedAt: now + 1 },
    { expiresAt: now + 14400001 },
    { shutdownBy: context.expiresAt + 900001 },
    { unknownAllowanceAccepted: false },
    { partialVerdictAccepted: false },
    { exclusiveProjectUse: false },
    { manualRecoveryReady: false },
    { otherServicesEvidence: "" },
    { probeClientMs: 3001 },
    { probeClientMs: 0 },
  ])
    assert.ok(
      preflight(
        c,
        {
          ...exceptional,
          functionsException: { ...exceptional.functionsException, ...change },
        },
        now,
        context,
      ).length,
    );
  assert.ok(
    preflight({ ...c, neonLimit: 65 }, exceptional, now, context).length,
  );
  assert.ok(
    preflight(c, exceptional, now, { ...context, expiresAt: now + 14400001 })
      .length,
  );
  assert.ok(preflight(c, exceptional, now + 300000, context).length);
});
