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
    handlers: ["index.ts", "[[rest]].ts"],
    dependencies: ["inventory-proxy.ts", "inventory-page.ts"],
  },
};

/** Copy an allowlisted source file with the same relative import layout.
 * @param {string} relativePath Repository-relative path within the UI package.
 */
function stage(relativePath) {
  const target = resolve(output, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(resolve(ui, relativePath), target);
}

const include = [];
stage("edge/read-proxy.ts");
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
