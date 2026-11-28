import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ui = fileURLToPath(new URL("../ui/", import.meta.url));
const output = resolve(ui, "dist/read-only");
const routes = {
  history: {
    handlers: ["index.ts", "[operation].ts", "[[rest]].ts"],
    dependencies: ["history-proxy.ts"],
  },
  inventory: {
    handlers: ["index.ts", "[[rest]].ts", "oci-storage.ts"],
    dependencies: [
      "inventory-proxy.ts",
      "inventory-page.ts",
      "oci-storage-proxy.ts",
    ],
  },
};

/** Copy an allowlisted source file with the same relative import layout.
 * @param {string} relativePath Target path within the Pages artifact.
 * @param {string} source Source path for the artifact, defaulting to the UI source layout.
 */
function stage(relativePath, source = resolve(ui, relativePath)) {
  const target = resolve(output, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

const include = [];
stage("edge/read-proxy.ts");
stage("contracts/oci-storage.ts", resolve(ui, "../contracts/oci-storage.ts"));
for (const [capability, { handlers, dependencies }] of Object.entries(routes)) {
  const route = `/api/${capability}`;
  include.push(route, `${route}/*`);
  for (const handler of handlers) {
    stage(`functions${route}/${handler}`);
  }
  for (const dependency of dependencies) {
    stage(`edge/${dependency}`);
  }
}
writeFileSync(
  resolve(output, "browser/_routes.json"),
  `${JSON.stringify({ version: 1, include, exclude: [] }, null, 2)}\n`,
);
