import type {
  Headroom,
  TrialConfiguration,
} from "../../src/trial/preflight.js";
export const config: TrialConfiguration = {
  compartment: "ocid1.compartment.oc1..fixture",
  namespace: "fixture",
  region: "eu-frankfurt-1",
  monitoringLimit: 10,
  neonLimit: 20,
};
export const now = Date.parse("2026-11-13T10:00:00Z");
export const evidence: Headroom = {
  checkedAt: now,
  accountType: "always-free",
  homeRegion: config.region,
  storageBytes: 10485760,
  objectRequests: 200,
  transferBytes: 1048576,
  monitoringRequests: 10,
  neonFree: true,
  neonInvocations: 20,
  neonComputeSeconds: 60,
  measuredComputeSeconds: 60,
};
