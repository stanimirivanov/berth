import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { buildFunctionBundle } from "@neon/config-runtime/v1";
import { historyFunction } from "../neon.ts";

const bundle = await buildFunctionBundle(historyFunction);
await writeFile("dist/history.zip", bundle);
console.log(
  JSON.stringify({
    bundle: "dist/history.zip",
    bytes: bundle.length,
    sha256: createHash("sha256").update(bundle).digest("hex"),
  }),
);
