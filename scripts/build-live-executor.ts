import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { buildFunctionBundle } from "@neon/config-runtime/v1";
import { liveFunction } from "../neon.js";

const zip = await buildFunctionBundle(liveFunction);
await writeFile("dist/live-executor.zip", zip);
console.log(
  JSON.stringify({
    bundle: "dist/live-executor.zip",
    bytes: zip.length,
    sha256: createHash("sha256").update(zip).digest("hex"),
  }),
);
