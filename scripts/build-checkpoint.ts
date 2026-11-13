import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { buildFunctionBundle } from "@neon/config-runtime/v1";
import { checkpointFunction } from "../neon.js";

const zip = await buildFunctionBundle(checkpointFunction);
await writeFile("dist/checkpoint.zip", zip);
console.log(
  JSON.stringify({
    bundle: "dist/checkpoint.zip",
    bytes: zip.length,
    sha256: createHash("sha256").update(zip).digest("hex"),
  }),
);
