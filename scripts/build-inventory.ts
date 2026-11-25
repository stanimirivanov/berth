import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { buildFunctionBundle } from "@neon/config-runtime/v1";
import { inventoryFunction } from "../neon.ts";

const bundle = await buildFunctionBundle(inventoryFunction);
await writeFile("dist/inventory.zip", bundle);
console.log(
  JSON.stringify({
    bundle: "dist/inventory.zip",
    bytes: bundle.length,
    sha256: createHash("sha256").update(bundle).digest("hex"),
  }),
);
