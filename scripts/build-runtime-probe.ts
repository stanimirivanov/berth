import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { buildFunctionBundle } from "@neon/config-runtime/v1";
import { probeFunction } from "../neon.js";

const zip = await buildFunctionBundle(probeFunction);
await writeFile("dist/runtime-probe.zip", zip);
console.log(
  JSON.stringify({
    bundle: "dist/runtime-probe.zip",
    bytes: zip.length,
    sha256: createHash("sha256").update(zip).digest("hex"),
  }),
);
