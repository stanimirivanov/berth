import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  OciSetupError,
  parseOciConfig,
  policyStatements,
  verifyOciAccess,
} from "./oci-access.js";
import { readPrivateText } from "./oci-files.js";

export async function runOciSetup(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      config: { type: "string" },
      mode: { type: "string", default: "plan" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: pnpm run setup:oci --config /private/oci-trial.json --mode plan|verify",
    );
    return;
  }
  if (!values.config || !["plan", "verify"].includes(values.mode))
    throw new OciSetupError("Supply --config and mode plan or verify");
  const config = parseOciConfig(
    JSON.parse(await readPrivateText(values.config)),
  );
  if (values.mode === "plan") {
    console.log(
      JSON.stringify(
        {
          mode: "plan",
          policyStatements: policyStatements(config),
          note: "Offline policy text only. Contains group/compartment identifiers; keep this output private. An owner must install and inspect IAM. No cloud requests or key reads performed.",
        },
        null,
        2,
      ),
    );
    return;
  }
  const pem = await readPrivateText(config.privateKeyFile);
  const passphrase =
    config.passphraseFile === undefined
      ? undefined
      : (await readPrivateText(config.passphraseFile)).replace(/\r?\n$/, "");
  console.log(
    JSON.stringify(await verifyOciAccess(config, pem, passphrase), null, 2),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runOciSetup(process.argv.slice(2)).catch((error: unknown) => {
    if (error instanceof OciSetupError) console.error(error.message);
    console.error(
      "OCI setup stopped. Provider bodies, signing headers and credentials were not printed. Check docs/oci-bootstrap.md; no retry, permission changes or resource mutations were attempted.",
    );
    process.exitCode = 1;
  });
}
