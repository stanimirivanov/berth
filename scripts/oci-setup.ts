import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  OciSetupError,
  parseOciConfig,
  policyStatements,
  verifyOciAccess,
} from "./oci-access.js";

async function readPrivateText(path: string): Promise<string> {
  if (!isAbsolute(path))
    throw new OciSetupError("Use an absolute private file path");
  const rel = relative(await realpath(process.cwd()), await realpath(path));
  if (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  ) {
    throw new OciSetupError(
      "Keep OCI configuration and credentials outside the repository",
    );
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.() ||
      stat.size > 16384
    ) {
      throw new OciSetupError(
        "Expected a small owner-only private file (chmod 600)",
      );
    }
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

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
