import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { buildFunctionBundle } from "@neon/config-runtime/v1";
import { executorFunction } from "../neon.js";

const zip = await buildFunctionBundle(executorFunction);
await writeFile("dist/executor.zip", zip);
console.log(
  JSON.stringify({
    bundle: "dist/executor.zip",
    bytes: zip.length,
    sha256: createHash("sha256").update(zip).digest("hex"),
  }),
);
