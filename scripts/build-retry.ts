import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { buildFunctionBundle } from "@neon/config-runtime/v1";
import { retryFunction } from "../neon.ts";

const bundle = await buildFunctionBundle(retryFunction);
await writeFile("dist/retry.zip", bundle);
console.log(
  JSON.stringify({
    bundle: "dist/retry.zip",
    bytes: bundle.length,
    sha256: createHash("sha256").update(bundle).digest("hex"),
  }),
);
