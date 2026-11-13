import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { buildFunctionBundle } from "@neon/config-runtime/v1";
import { stateFunction } from "../neon.js";

const zip = await buildFunctionBundle(stateFunction);
await writeFile("dist/state-probe.zip", zip);
console.log(
  JSON.stringify({
    bundle: "dist/state-probe.zip",
    bytes: zip.length,
    sha256: createHash("sha256").update(zip).digest("hex"),
  }),
);
