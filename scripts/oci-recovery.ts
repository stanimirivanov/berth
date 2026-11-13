import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { OciSetupError } from "./oci-access.js";
import { type AdminConfig, bootstrapOci, capabilities } from "./oci-admin.js";
import { saveUserRejection } from "./oci-diagnostics.js";
import { readPrivateText } from "./oci-files.js";

export interface Recovery {
  compartmentOcid: string;
  userUrl: string;
  journalHash: string;
  planOnly: boolean;
  rejectedAttempts: 1 | 2;
}
export interface RecoveryPlan {
  recovery: "ready";
  requestsDispatched: 8;
  remainingWrites: 4;
}
const description =
  "Berth disposable Object Storage trial; owner-managed IAM cleanup";
const extension =
  "urn:ietf:params:scim:schemas:oracle:idcs:extension:capabilities:User";

export function parseRecoveryJournal(
  text: string,
  config: AdminConfig,
  fingerprint: string,
): Recovery {
  const fail = () =>
    new OciSetupError(
      "Unsupported or mismatched recovery journal. Expected the supported four-entry or six-entry legacy rejected-user journal; do not edit the journal.",
    );
  if (!text.endsWith("\n")) throw fail();
  let entries: Record<string, unknown>[];
  try {
    entries = text
      .trimEnd()
      .split("\n")
      .map((line) => {
        const event = JSON.parse(line);
        if (
          !event ||
          typeof event !== "object" ||
          Array.isArray(event) ||
          typeof event.at !== "string" ||
          !Number.isFinite(Date.parse(event.at))
        )
          throw fail();
        const { at: _at, ...rest } = event;
        return rest;
      });
  } catch {
    throw fail();
  }
  if (entries.length !== 4 && entries.length !== 6) throw fail();
  const [start, intent, confirmed, user] = entries;
  const identity = `https://identity.${config.region}.oci.oraclecloud.com/20160918`;
  if (
    !isDeepStrictEqual(start, {
      phase: "start",
      name: config.name,
      tenancyOcid: config.tenancyOcid,
      domainOcid: config.domainOcid,
      region: config.region,
      fingerprint,
    }) ||
    !isDeepStrictEqual(intent, {
      phase: "intent",
      operation: "CreateCompartment",
      url: `${identity}/compartments`,
      body: {
        compartmentId: config.tenancyOcid,
        name: config.name,
        description,
      },
    }) ||
    !confirmed ||
    typeof confirmed.id !== "string" ||
    !/^ocid1\.compartment\.oc1\.[a-z0-9-]*\.[a-z0-9]{8,255}$/.test(
      confirmed.id,
    ) ||
    !isDeepStrictEqual(confirmed, {
      phase: "confirmed",
      operation: "CreateCompartment",
      id: confirmed.id,
    }) ||
    !user ||
    typeof user.url !== "string" ||
    !/^https:\/\/idcs-[a-z0-9]+\.identity\.oraclecloud\.com\/admin\/v1\/Users$/.test(
      user.url,
    )
  )
    throw fail();
  const body = {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User", extension],
    userName: `${config.name}-executor`,
    displayName: `${config.name}-executor`,
    active: true,
    userType: "Service",
    [extension]: capabilities,
  };
  // Accept the shipped pre-fix payload, or the corrected payload rejected by OCI.
  if (
    !isDeepStrictEqual(user, {
      phase: "intent",
      operation: "CreateUser",
      url: user.url,
      body,
    }) &&
    !isDeepStrictEqual(user, {
      phase: "intent",
      operation: "CreateUser",
      url: user.url,
      body: { ...body, name: { familyName: `${config.name}-executor` } },
    })
  )
    throw fail();
  if (entries.length === 6) {
    const originalText = `${text.split("\n").slice(0, 4).join("\n")}\n`;
    if (
      !isDeepStrictEqual(entries[4], {
        phase: "recovery-start",
        originalJournalHash: createHash("sha256")
          .update(originalText)
          .digest("hex"),
        compartmentOcid: confirmed.id,
        userCreateRejectedAttested: true,
      }) ||
      !isDeepStrictEqual(entries[5], {
        phase: "intent",
        operation: "CreateUser",
        url: user.url,
        body: { ...body, name: { familyName: `${config.name}-executor` } },
      })
    )
      throw fail();
  }
  return {
    rejectedAttempts: entries.length === 6 ? 2 : 1,
    compartmentOcid: confirmed.id,
    userUrl: user.url,
    journalHash: createHash("sha256").update(text).digest("hex"),
    planOnly: true,
  };
}

async function privateDirectory(path: string) {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    (await realpath(path)) !== path
  )
    throw new OciSetupError(
      "Recovery needs a normalized absolute directory without symlinks",
    );
  const info = await lstat(path);
  const rel = relative(await realpath(process.cwd()), path);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0 ||
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  )
    throw new OciSetupError(
      "Recovery directory must be owner-only and outside the checkout",
    );
}
async function syncDirectory(path: string) {
  const file = await open(path, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function runOciRecovery(
  config: AdminConfig,
  output: string,
  planOnly: boolean,
  rejected: boolean,
  transport: (url: string, init: RequestInit) => Promise<Response>,
  primaryEmailRejected = false,
) {
  if (!planOnly && !rejected)
    throw new OciSetupError(
      "Recovery requires --confirm-user-create-rejected: confirm the original HTTP 400 rejection and no concurrent owner writes. An empty listing alone is insufficient.",
    );
  await privateDirectory(output);
  const lockPath = join(output, "recovery.lock");
  let lock: FileHandle;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    throw new OciSetupError(
      "Recovery lock exists or cannot be created. Do not remove a lock until its process and journal are reconciled.",
    );
  }
  try {
    await lock.writeFile(
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
    );
    await lock.sync();
    await syncDirectory(output);
    try {
      await lstat(join(output, "oci-trial.json"));
      throw new OciSetupError(
        "Runtime configuration already exists; recovery will not overwrite it",
      );
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
    const journalPath = join(output, "journal.jsonl");
    const text = await readPrivateText(journalPath);
    const trialPem = await readPrivateText(join(output, "trial.pem"));
    const publicKey = await readPrivateText(join(output, "trial-public.pem"));
    let fingerprint: string;
    try {
      const key = createPrivateKey(trialPem);
      if (
        key.asymmetricKeyType !== "rsa" ||
        (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      )
        throw new Error();
      const der = createPublicKey(key).export({ type: "spki", format: "der" });
      if (
        !der.equals(
          createPublicKey(publicKey).export({ type: "spki", format: "der" }),
        )
      )
        throw new Error();
      fingerprint =
        createHash("md5").update(der).digest("hex").match(/../g)?.join(":") ??
        "";
    } catch {
      throw new OciSetupError(
        "Recovery trial key pair is invalid or mismatched; preserve the original files",
      );
    }
    if (fingerprint === config.fingerprint)
      throw new OciSetupError(
        "Trial key must differ from the administrator key; no recovery requests dispatched",
      );
    const recovery = {
      ...parseRecoveryJournal(text, config, fingerprint),
      planOnly,
    };
    if (recovery.rejectedAttempts === 2 && !primaryEmailRejected)
      throw new OciSetupError(
        "This journal includes a rejected recovery. Supply --confirm-primary-email-rejection only after confirming its Audit message: The primary email must be specified. Do not attest an unknown outcome.",
      );
    const pem = await readPrivateText(config.privateKeyFile);
    const passphrase =
      config.passphraseFile === undefined
        ? undefined
        : (await readPrivateText(config.passphraseFile)).replace(/\r?\n$/, "");
    const journal = await open(
      journalPath,
      constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW,
    );
    try {
      const info = await journal.stat();
      if (
        !info.isFile() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o077) !== 0 ||
        (await journal.readFile("utf8")) !== text
      )
        throw new OciSetupError("Recovery journal changed during validation");
      async function append(event: Record<string, unknown>) {
        await journal.writeFile(
          `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
        );
        await journal.sync();
      }
      const result = await bootstrapOci(
        config,
        pem,
        passphrase,
        { publicKey, fingerprint, privateKeyFile: join(output, "trial.pem") },
        append,
        transport,
        recovery,
      );
      if ("recovery" in result) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const file = await open(join(output, "oci-trial.json"), "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(result, null, 2)}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
      await syncDirectory(output);
      await append({ phase: "complete" });
      console.log(
        JSON.stringify(
          {
            administratorSetup: "recovered",
            compartment: "reused",
            trialKey: "reused",
            iamWrites: 4,
            requestsDispatched: 12,
            remaining: [
              "Owner effective-IAM review and allowance checks",
              "Run setup:oci --mode verify with this directory's oci-trial.json",
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
  } finally {
    await lock.close();
    await unlink(lockPath);
    await syncDirectory(output);
  }
}
