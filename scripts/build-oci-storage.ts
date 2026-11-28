import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { buildFunctionBundle } from "@neon/config-runtime/v1";
import { ociStorageFunction } from "../neon.ts";

const bundle = await buildFunctionBundle(ociStorageFunction);
await writeFile("dist/oci-storage.zip", bundle);
console.log(
  JSON.stringify({
    bundle: "dist/oci-storage.zip",
    bytes: bundle.length,
    sha256: createHash("sha256").update(bundle).digest("hex"),
  }),
);
