import assert from "node:assert/strict";
import test from "node:test";
import { createProposal } from "../src/providers/oci/client.js";
import { probeIntent } from "../src/providers/oci/trial-object.js";
import {
  preflight,
  proposal,
  trialWindow,
  validateConfiguration,
} from "../src/trial/preflight.js";
import { config, evidence, now } from "./fakes/admission.js";

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
