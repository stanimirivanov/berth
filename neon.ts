/** Deployment descriptor used by build:runtime-probe; credentials are never bundled. */
export const probeFunction = {
  slug: "berthprobe4",
  name: "Berth authenticated runtime probe",
  source: "./src/trial/index.ts",
  runtime: "nodejs24" as const,
  bundler: "esbuild" as const,
  env: {},
  // Alchemy guards Bun imports by runtime and terminal devtools by development mode.
  // Neither is executed by this Node-only headless probe. All used packages bundle.
  externalPackages: ["@effect/platform-bun", "react-devtools-core"].map(
    (name) => ({ name, includeFiles: false }),
  ),
};

/** Dedicated ephemeral state probe; both deployed copies use only runtime credentials. */
export const stateFunction = {
  ...probeFunction,
  slug: "berthstate32a",
  name: "Berth Cloudflare state qualification",
  source: "./src/trial/state-probe.ts",
};

/** Isolated fenced-state checkpoint; owner SQL and secrets are never bundled. */
export const checkpointFunction = {
  ...probeFunction,
  slug: "berthcheckpoint6",
  name: "Berth scheduled fenced-state checkpoint",
  source: "./src/trial/checkpoint-index.ts",
};

/** Synthetic-only hosted executor proof; schedules are explicitly managed, never enabled by build. */
export const executorFunction = {
  ...probeFunction,
  slug: "berthexecutor11",
  name: "Berth bounded scheduled executor proof",
  source: "./src/trial/executor-hosted.ts",
};
/** Production trial cadence, with runtime window and SQL cutoffs independently enforced. */
export const executorSchedule = {
  type: "schedule" as const,
  function_slug: executorFunction.slug,
  function_path: "/scheduled",
  enabled: false,
  schedule: { cron: "*/15 * * * *" },
};

/** Live executor is separate from the synthetic proof; building never deploys it. */
export const liveFunction = {
  ...probeFunction,
  slug: "berthlive46",
  name: "Berth bounded live OCI executor",
  source: "./src/trial/live-index.ts",
};
/** Owner readiness/admission gates must pass before explicitly enabling this schedule. */
export const liveSchedule = {
  ...executorSchedule,
  function_slug: liveFunction.slug,
  enabled: false,
};
