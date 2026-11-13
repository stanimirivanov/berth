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
