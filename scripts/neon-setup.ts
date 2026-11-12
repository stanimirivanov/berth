import { randomBytes } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client, type ClientConfig } from "pg";
import {
  type DatabaseTarget,
  prepareDatabase,
  SetupError,
  verifyRuntime,
} from "./neon-database.js";

export interface Target extends DatabaseTarget {
  project: string;
  branch: string;
  region: string;
}

export function validateTarget(target: Target): void {
  if (
    !/^[a-z0-9-]{1,60}$/.test(target.project) ||
    !/^br-[a-z0-9-]{1,57}$/.test(target.branch)
  ) {
    throw new SetupError("Invalid project or branch ID");
  }
  for (const value of [
    target.database,
    target.owner,
    target.role,
    target.schema,
  ]) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(value))
      throw new SetupError("Invalid SQL identifier");
  }
  if (["postgres", "template0", "template1"].includes(target.database))
    throw new SetupError("A dedicated trial database is required");
  if (
    !target.role.startsWith("berth_") ||
    !target.schema.startsWith("berth_") ||
    target.role === target.owner
  )
    throw new SetupError("Use separate berth_ runtime role and schema");
  if (
    ![
      "aws-us-east-2",
      "aws-us-east-1",
      "aws-eu-central-1",
      "aws-ap-southeast-1",
    ].includes(target.region)
  ) {
    throw new SetupError("Unsupported Functions region");
  }
}

export function connectionConfig(
  uri: string,
  target: Target,
  host: string,
): ClientConfig {
  const url = new URL(uri);
  if (
    url.protocol !== "postgresql:" ||
    url.hostname !== host ||
    !/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(host) ||
    (url.port !== "" && url.port !== "5432") ||
    decodeURIComponent(url.pathname.slice(1)) !== target.database ||
    decodeURIComponent(url.username) !== target.owner ||
    !url.password
  )
    throw new SetupError("Unexpected connection target");
  // Parse fields explicitly: connection-string sslmode must never override TLS verification.
  return {
    host,
    port: 5432,
    database: target.database,
    user: target.owner,
    password: decodeURIComponent(url.password),
    ssl: { rejectUnauthorized: true },
    enableChannelBinding: true,
    connectionTimeoutMillis: 15_000,
    statement_timeout: 15_000,
    lock_timeout: 5_000,
    application_name: "berth-neon-setup",
  };
}

export async function privatePath(
  path: string,
  directory: boolean,
): Promise<string> {
  if (!isAbsolute(path)) throw new SetupError("Secret paths must be absolute");
  const actual = await realpath(path);
  const repo = await realpath(process.cwd());
  const rel = relative(repo, actual);
  if (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  ) {
    throw new SetupError("Keep secrets outside the working directory");
  }
  const stat = await lstat(path);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.() ||
    (!directory && stat.size > 16384)
  ) {
    throw new SetupError("Expected owner-only regular file or directory");
  }
  return actual;
}

async function api(
  path: string,
  token: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(`https://console.neon.tech/api/v2/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new SetupError("Neon API request failed");
  return response.json() as Promise<Record<string, unknown>>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SetupError("Unexpected API response");
  return value as Record<string, unknown>;
}

export async function runSetup(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      mode: { type: "string", default: "plan" },
      project: { type: "string" },
      branch: { type: "string" },
      region: { type: "string", default: "aws-us-east-2" },
      database: { type: "string", default: "neondb" },
      owner: { type: "string", default: "neondb_owner" },
      role: { type: "string", default: "berth_runtime" },
      schema: { type: "string", default: "berth_trial" },
      "api-key-file": { type: "string" },
      "secrets-dir": { type: "string" },
      "confirm-free-plan": { type: "boolean", default: false },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: pnpm run setup:neon --project ID --branch br-ID --api-key-file /private/key --confirm-free-plan [--mode plan|apply|verify] [--secrets-dir /private/output] [--region aws-us-east-2] [--database neondb] [--owner neondb_owner] [--role berth_runtime] [--schema berth_trial]",
    );
    return;
  }
  const target: Target = {
    project: values.project ?? "",
    branch: values.branch ?? "",
    region: values.region,
    database: values.database,
    owner: values.owner,
    role: values.role,
    schema: values.schema,
  };
  validateTarget(target);
  if (
    !["plan", "apply", "verify"].includes(values.mode) ||
    !values["confirm-free-plan"] ||
    !values["api-key-file"]
  ) {
    throw new SetupError(
      "Mode, Free-plan attestation and private API key file are required",
    );
  }
  const token = (
    await readFile(await privatePath(values["api-key-file"], false), "utf8")
  ).trim();
  if (!token || /\s/.test(token)) throw new SetupError("Invalid API key file");
  const base = `projects/${target.project}`;
  const project = record((await api(base, token)).project);
  if (project.id !== target.project || project.region_id !== target.region)
    throw new SetupError("Project region mismatch");
  const branches = (await api(`${base}/branches`, token)).branches;
  if (
    !Array.isArray(branches) ||
    branches.length !== 1 ||
    record(branches[0]).id !== target.branch
  ) {
    throw new SetupError(
      "Expected exactly one explicitly selected trial branch",
    );
  }
  const endpoints = (await api(`${base}/endpoints`, token)).endpoints;
  if (!Array.isArray(endpoints) || endpoints.length !== 1)
    throw new SetupError("Expected one trial endpoint");
  const endpoint = record(endpoints[0]);
  if (
    endpoint.branch_id !== target.branch ||
    endpoint.type !== "read_write" ||
    typeof endpoint.host !== "string" ||
    typeof endpoint.id !== "string" ||
    typeof endpoint.suspend_timeout_seconds !== "number" ||
    endpoint.suspend_timeout_seconds < 0 ||
    endpoint.suspend_timeout_seconds > 300
  )
    throw new SetupError("Endpoint or scale-to-zero check failed");
  console.log(
    JSON.stringify(
      {
        mode: values.mode,
        target,
        checks: {
          projectRegion: "verified",
          oneBranchAndEndpoint: "verified",
          scaleToZero: "verified",
          freePlan: "owner-attested, not API-verified",
          functionsAndTriggers: "pending console/deployment verification",
        },
        changes: [
          "Create SQL runtime role and owner-held trial schema",
          "Revoke PUBLIC database CREATE/TEMP and public-schema CREATE (dedicated database only)",
          "Create two empty permission-probe tables; grant CRUD on one",
          "Save runtime credentials privately; verify actual login and permission denials",
        ],
      },
      null,
      2,
    ),
  );
  if (values.mode === "plan") return;
  if (!values["secrets-dir"])
    throw new SetupError("Private output directory required");
  const directory = await privatePath(values["secrets-dir"], true);
  const credentialPath = resolve(directory, "neon-runtime.json");
  const query = new URLSearchParams({
    branch_id: target.branch,
    endpoint_id: endpoint.id,
    database_name: target.database,
    role_name: target.owner,
    pooled: "false",
  });
  const uri = (await api(`${base}/connection_uri?${query}`, token)).uri;
  if (typeof uri !== "string") throw new SetupError("Missing owner connection");
  const config = connectionConfig(uri, target, endpoint.host);
  let password: string;
  if (values.mode === "apply") {
    password = randomBytes(32).toString("base64url");
    const runtimeUrl = new URL(uri);
    runtimeUrl.username = target.role;
    runtimeUrl.password = password;
    runtimeUrl.search = "?sslmode=verify-full&channel_binding=require";
    // Write before any DB mutation; exclusive creation prevents accidental rotation.
    // Retain this file on failure so an uncertain COMMIT can be reconciled by verify.
    await writeFile(
      credentialPath,
      JSON.stringify(
        {
          target,
          password,
          DATABASE_URL: runtimeUrl.toString(),
          DATABASE_URL_UNPOOLED: runtimeUrl.toString(),
          BERTH_TRIAL_TOKEN: randomBytes(32).toString("base64url"),
        },
        null,
        2,
      ),
      { flag: "wx", mode: 0o600 },
    );
    const owner = new Client(config);
    try {
      await owner.connect();
      const identity = await owner.query(
        "SELECT current_user, current_database()",
      );
      if (
        identity.rows[0]?.current_user !== target.owner ||
        identity.rows[0]?.current_database !== target.database
      ) {
        throw new SetupError("Wrong database owner connection");
      }
      await prepareDatabase(owner, target, password);
    } finally {
      await owner.end();
    }
  } else {
    const saved = record(
      JSON.parse(
        await readFile(await privatePath(credentialPath, false), "utf8"),
      ),
    );
    if (
      JSON.stringify(saved.target) !== JSON.stringify(target) ||
      typeof saved.password !== "string"
    ) {
      throw new SetupError("Saved credentials belong to a different target");
    }
    password = saved.password;
  }
  const runtime = new Client({ ...config, user: target.role, password });
  try {
    await runtime.connect();
    await verifyRuntime(runtime, target);
  } finally {
    await runtime.end();
  }
  console.log(
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        databasePermissions: "passed",
        remaining: [
          "Confirm Free plan and current allowance headroom in Console",
          "Confirm Functions and trigger availability; leave schedules disabled",
          "Later deployment must override BOTH injected database URLs and verify no owner credentials remain",
          "OCI setup remains pending",
        ],
      },
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runSetup(process.argv.slice(2)).catch((error: unknown) => {
    if (error instanceof SetupError) console.error(error.message);
    // Provider and driver errors may embed credentials, SQL or connection URLs.
    console.error(
      "Neon setup stopped. No credentials or raw provider errors were printed. Check target, private-file permissions, API access, and fresh-database requirements in docs/neon-bootstrap.md. If apply wrote credentials, retain them and use verify before retrying; no automatic retry or cleanup was attempted.",
    );
    process.exitCode = 1;
  });
}
