import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, open, realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { OciSetupError } from "./oci-access.js";
import { bootstrapOci, parseAdminConfig } from "./oci-admin.js";
import { saveUserRejection } from "./oci-diagnostics.js";
import { readPrivateText } from "./oci-files.js";
import { runOciRecovery } from "./oci-recovery.js";

async function save(path: string, text: string) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(text);
    await file.sync();
  } finally {
    await file.close();
  }
}
async function syncDirectory(path: string) {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function createOutput(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path)
    throw new OciSetupError(
      "Use a normalized absolute output directory outside the repository",
    );
  const parent = await realpath(dirname(path));
  const rel = relative(await realpath(process.cwd()), parent);
  const info = await stat(parent);
  if (
    parent !== dirname(path) ||
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0 ||
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  )
    throw new OciSetupError(
      "Output parent must be an owner-only directory outside the repository, without symlinks",
    );
  const target = join(parent, basename(path));
  // No recursive/existing-directory fallback: reruns cannot overwrite recovery state.
  await mkdir(target, { mode: 0o700 });
  await syncDirectory(parent);
  return target;
}

export async function runOciAdmin(
  args: string[],
  transport: (url: string, init: RequestInit) => Promise<Response> = fetch,
) {
  const { values } = parseArgs({
    args,
    options: {
      config: { type: "string" },
      mode: { type: "string", default: "plan" },
      "output-dir": { type: "string" },
      help: { type: "boolean" },
      "confirm-user-create-rejected": { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: pnpm run setup:oci-admin --config /private/admin.json --mode plan|apply|recover-plan|recover [--output-dir /private/run] [--confirm-user-create-rejected]",
    );
    return;
  }
  if (
    !values.config ||
    !["plan", "apply", "recover-plan", "recover"].includes(values.mode)
  )
    throw new OciSetupError(
      "Supply --config and mode plan, apply, recover-plan or recover",
    );
  const config = parseAdminConfig(
    JSON.parse(await readPrivateText(values.config)),
  );
  if (values.mode === "recover-plan" || values.mode === "recover") {
    if (!values["output-dir"])
      throw new OciSetupError("Recovery requires the existing --output-dir");
    return runOciRecovery(
      config,
      values["output-dir"],
      values.mode === "recover-plan",
      values["confirm-user-create-rejected"] === true,
      transport,
    );
  }
  if (values.mode === "plan") {
    console.log(
      JSON.stringify(
        {
          mode: "plan",
          name: config.name,
          region: config.region,
          actions: [
            "Verify tenancy home region, existing root domain and namespace",
            "Create root compartment",
            "Create API-only service user and dedicated group in existing domain",
            "Generate RSA 3072 signing key and register its public key",
            "Create three compartment-scoped Object Storage / Monitoring policy statements",
            "Save runtime configuration privately; owner IAM review and read-only verification remain required",
          ],
          note: "Offline; no key reads or cloud requests. Five IAM writes on apply, no retries. No domain, bucket, object or schedule is created. Existing names/resources are not adopted.",
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!values["output-dir"])
    throw new OciSetupError("Apply requires a fresh --output-dir");
  const pem = await readPrivateText(config.privateKeyFile);
  const passphrase =
    config.passphraseFile === undefined
      ? undefined
      : (await readPrivateText(config.passphraseFile)).replace(/\r?\n$/, "");
  const output = await createOutput(values["output-dir"]);
  const keys = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const privateKeyFile = join(output, "trial.pem");
  const publicKey = keys.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const fingerprint = createHash("md5")
    .update(keys.publicKey.export({ type: "spki", format: "der" }))
    .digest("hex")
    .match(/../g)
    ?.join(":");
  if (!fingerprint)
    throw new OciSetupError("Could not derive trial key fingerprint");
  await save(
    privateKeyFile,
    keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  await save(join(output, "trial-public.pem"), publicKey);
  const journal = await open(join(output, "journal.jsonl"), "ax", 0o600);
  try {
    async function append(event: Record<string, unknown>) {
      await journal.writeFile(
        `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
      );
      await journal.sync();
    }
    await append({
      phase: "start",
      name: config.name,
      tenancyOcid: config.tenancyOcid,
      domainOcid: config.domainOcid,
      region: config.region,
      fingerprint,
    });
    await syncDirectory(output);
    const runtime = await bootstrapOci(
      config,
      pem,
      passphrase,
      { publicKey, fingerprint, privateKeyFile },
      append,
      transport,
    );
    await save(
      join(output, "oci-trial.json"),
      `${JSON.stringify(runtime, null, 2)}\n`,
    );
    await syncDirectory(output);
    await append({ phase: "complete" });
    console.log(
      JSON.stringify(
        {
          administratorSetup: "created",
          iamWrites: 5,
          remaining: [
            "Review all effective IAM grants, including automatic groups and any-user policies",
            "Run setup:oci --mode verify with the generated oci-trial.json after propagation",
            "Confirm account eligibility and aggregate allowance headroom; no spending cap is enforced",
          ],
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await saveUserRejection(output, error);
    throw error;
  } finally {
    await journal.close();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runOciAdmin(process.argv.slice(2)).catch((error: unknown) => {
    if (error instanceof OciSetupError) console.error(error.message);
    console.error(
      "OCI administrator setup stopped. Keep the output directory and journal. Do not rerun with a new directory until the owner reconciles any recorded writes. No automatic retry or rollback was performed; provider bodies and credentials were not printed.",
    );
    process.exitCode = 1;
  });
}
