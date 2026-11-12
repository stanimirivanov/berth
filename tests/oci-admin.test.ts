import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { bootstrapOci, parseAdminConfig } from "../scripts/oci-admin.js";

const ocid = (kind: string) => `ocid1.${kind}.oc1..aaaaaaaa${kind}`;
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKey = keys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const fingerprint = createHash("md5")
  .update(keys.publicKey.export({ type: "spki", format: "der" }))
  .digest("hex")
  .match(/../g)
  ?.join(":") as string;
const config = {
  tenancyOcid: ocid("tenancy"),
  userOcid: ocid("user"),
  domainOcid: ocid("domain"),
  region: "eu-frankfurt-1",
  fingerprint,
  privateKeyFile: "/private/admin.pem",
  name: "berth-trial",
};
const capabilities = {
  canUseApiKeys: true,
  canUseAuthTokens: false,
  canUseConsole: false,
  canUseConsolePassword: false,
  canUseCustomerSecretKeys: false,
  canUseDbCredentials: false,
  canUseOAuth2ClientCredentials: false,
  canUseSmtpCredentials: false,
};
const extension =
  "urn:ietf:params:scim:schemas:oracle:idcs:extension:capabilities:User";
const results: unknown[] = [
  { id: config.tenancyOcid, homeRegionKey: "FRA" },
  {
    id: config.domainOcid,
    compartmentId: config.tenancyOcid,
    url: "https://idcs-aaaaaaaa.identity.oraclecloud.com:443",
    lifecycleState: "ACTIVE",
  },
  "trialnamespace",
  { id: ocid("compartment") },
  {
    id: "user-scim-id",
    ocid: "ocid1.user.oc1..aaaaaaaatrial",
    [extension]: capabilities,
  },
  {
    id: "group-scim-id",
    ocid: ocid("group"),
    members: [{ value: "user-scim-id" }],
  },
  { id: "key-scim-id", fingerprint },
  { id: ocid("policy") },
];
function fixture(
  overrides: Map<number, unknown> = new Map(),
  failJournal = false,
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const events: Record<string, unknown>[] = [];
  return {
    calls,
    events,
    journal: async (event: Record<string, unknown>) => {
      if (failJournal && event.phase === "intent")
        throw new Error("disk failure");
      events.push(event);
    },
    transport: async (url: string, init: RequestInit) => {
      const index = calls.length;
      calls.push({ url, init });
      if (init.method !== "GET") assert.equal(events.at(-1)?.phase, "intent");
      const value = overrides.has(index)
        ? overrides.get(index)
        : results[index];
      if (value instanceof Error) throw value;
      return new Response(JSON.stringify(value));
    },
  };
}
test("admin config rejects endpoint injection, unknown fields and malformed identities", () => {
  assert.deepEqual(parseAdminConfig(config), config);
  for (const change of [
    { region: "evil.example" },
    { name: "x' to manage all-resources" },
    { domainOcid: ocid("user") },
    { endpoint: "https://evil.example" },
  ])
    assert.throws(() => parseAdminConfig({ ...config, ...change }));
});
test("creates only dedicated domain identity and scoped policy; journals before all five writes", async () => {
  const f = fixture();
  const runtime = await bootstrapOci(
    config,
    pem,
    undefined,
    { publicKey, fingerprint, privateKeyFile: "/private/run/trial.pem" },
    f.journal,
    f.transport,
  );
  assert.equal(f.calls.length, 8);
  assert.deepEqual(
    f.calls.map((c) => c.init.method),
    ["GET", "GET", "GET", "POST", "POST", "POST", "POST", "POST"],
  );
  assert.equal(f.events.filter((e) => e.phase === "intent").length, 5);
  assert.equal(f.events.filter((e) => e.phase === "confirmed").length, 5);
  for (const { init } of f.calls) {
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    assert.match(
      new Headers(init.headers).get("authorization") ?? "",
      /^Signature /,
    );
  }
  const user = JSON.parse(String(f.calls[4]?.init.body));
  assert.deepEqual(user[extension], capabilities);
  assert.equal(user.password, undefined);
  const group = JSON.parse(String(f.calls[5]?.init.body));
  assert.deepEqual(group.members, [{ value: "user-scim-id", type: "User" }]);
  const policy = JSON.parse(String(f.calls[7]?.init.body));
  assert.equal(policy.statements.length, 3);
  assert.ok(
    policy.statements.every((s: string) =>
      s.includes(`in compartment id ${ocid("compartment")}`),
    ),
  );
  assert.notEqual(runtime.userOcid, config.userOcid);
  assert.equal(runtime.privateKeyFile, "/private/run/trial.pem");
  assert.equal(runtime.namespace, "trialnamespace");
  assert.ok(!JSON.stringify(runtime).includes("admin.pem"));
});
test("stops before mutations for wrong home region or untrusted domain endpoint", async () => {
  for (const overrides of [
    new Map([[0, { id: config.tenancyOcid, homeRegionKey: "IAD" }]]),
    new Map([[1, { ...(results[1] as object), url: "https://evil.example" }]]),
  ]) {
    const f = fixture(overrides);
    await assert.rejects(
      bootstrapOci(
        config,
        pem,
        undefined,
        { publicKey, fingerprint, privateKeyFile: "/private/trial.pem" },
        f.journal,
        f.transport,
      ),
    );
    assert.ok(f.calls.every((c) => c.init.method === "GET"));
  }
});
test("uncertain write is never retried and journal failure prevents dispatch", async () => {
  const f = fixture(new Map([[4, new Error("provider-secret")]]));
  await assert.rejects(
    bootstrapOci(
      config,
      pem,
      undefined,
      { publicKey, fingerprint, privateKeyFile: "/private/trial.pem" },
      f.journal,
      f.transport,
    ),
    (e) => e instanceof Error && !e.message.includes("provider-secret"),
  );
  assert.equal(f.calls.length, 5);
  assert.equal(f.events.at(-1)?.phase, "intent");
  const broken = fixture(new Map(), true);
  await assert.rejects(
    bootstrapOci(
      config,
      pem,
      undefined,
      { publicKey, fingerprint, privateKeyFile: "/private/trial.pem" },
      broken.journal,
      broken.transport,
    ),
  );
  assert.equal(broken.calls.length, 3);
});
test("unconfirmed capabilities or missing domain OCID stops before key registration", async () => {
  for (const value of [
    { id: "user-scim-id", ocid: ocid("user") },
    { id: "user-scim-id", [extension]: capabilities },
  ]) {
    const f = fixture(new Map([[4, value]]));
    await assert.rejects(
      bootstrapOci(
        config,
        pem,
        undefined,
        { publicKey, fingerprint, privateKeyFile: "/private/trial.pem" },
        f.journal,
        f.transport,
      ),
    );
    assert.equal(f.calls.length, 5);
  }
});

test("CLI plan is offline; apply refuses reused/private-invalid output and preserves recovery files", async () => {
  const { mkdtemp, writeFile, readFile, mkdir, stat, rm } = await import(
    "node:fs/promises"
  );
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { runOciAdmin } = await import("../scripts/oci-admin-setup.js");
  const dir = await mkdtemp(join(tmpdir(), "berth-admin-"));
  const originalLog = console.log;
  try {
    console.log = () => {};
    const configPath = join(dir, "admin.json");
    await writeFile(
      configPath,
      JSON.stringify({ ...config, privateKeyFile: join(dir, "missing.pem") }),
      { mode: 0o600 },
    );
    let calls = 0;
    const transport = async () => {
      calls++;
      throw new Error("secret transport failure");
    };
    await runOciAdmin(["--config", configPath, "--mode", "plan"], transport);
    assert.equal(calls, 0);
    await writeFile(join(dir, "admin.pem"), pem, { mode: 0o600 });
    await writeFile(
      configPath,
      JSON.stringify({ ...config, privateKeyFile: join(dir, "admin.pem") }),
      { mode: 0o600 },
    );
    const out = join(dir, "run");
    await assert.rejects(
      runOciAdmin(
        ["--config", configPath, "--mode", "apply", "--output-dir", out],
        transport,
      ),
    );
    assert.equal(calls, 1);
    assert.equal((await stat(join(out, "trial.pem"))).mode & 0o777, 0o600);
    const journal = await readFile(join(out, "journal.jsonl"), "utf8");
    assert.ok(!journal.includes("PRIVATE KEY"));
    assert.ok(!journal.includes("secret transport failure"));
    await assert.rejects(
      runOciAdmin(
        ["--config", configPath, "--mode", "apply", "--output-dir", out],
        transport,
      ),
    );
    assert.equal(calls, 1);
    await mkdir(join(dir, "public"), { mode: 0o755 });
    await assert.rejects(
      runOciAdmin(
        [
          "--config",
          configPath,
          "--mode",
          "apply",
          "--output-dir",
          join(dir, "public", "run"),
        ],
        transport,
      ),
    );
    assert.equal(calls, 1);
  } finally {
    console.log = originalLog;
    await rm(dir, { recursive: true, force: true });
  }
});

test("HTTP failures expose only operation/status and stop after one dispatch", async () => {
  const f = fixture();
  let dispatched = 0;
  await assert.rejects(
    bootstrapOci(
      config,
      pem,
      undefined,
      { publicKey, fingerprint, privateKeyFile: "/private/trial.pem" },
      f.journal,
      async () => {
        dispatched++;
        return new Response("provider-secret", { status: 403 });
      },
    ),
    (e) =>
      e instanceof Error &&
      e.message.includes("HTTP 403") &&
      !e.message.includes("provider-secret"),
  );
  assert.equal(dispatched, 1);
});

test("successful CLI apply persists only trial credentials and a complete private journal", async () => {
  const { mkdtemp, writeFile, readFile, stat, rm } = await import(
    "node:fs/promises"
  );
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createPublicKey } = await import("node:crypto");
  const { runOciAdmin } = await import("../scripts/oci-admin-setup.js");
  const dir = await mkdtemp(join(tmpdir(), "berth-admin-success-"));
  const originalLog = console.log;
  try {
    console.log = () => {};
    await writeFile(join(dir, "admin.pem"), pem, { mode: 0o600 });
    await writeFile(
      join(dir, "admin.json"),
      JSON.stringify({ ...config, privateKeyFile: join(dir, "admin.pem") }),
      { mode: 0o600 },
    );
    const out = join(dir, "run");
    let count = 0;
    await runOciAdmin(
      [
        "--config",
        join(dir, "admin.json"),
        "--mode",
        "apply",
        "--output-dir",
        out,
      ],
      async (_url, init) => {
        const index = count++;
        if (index === 6) {
          const body = JSON.parse(String(init.body));
          const fp = createHash("md5")
            .update(
              createPublicKey(body.key).export({ type: "spki", format: "der" }),
            )
            .digest("hex")
            .match(/../g)
            ?.join(":");
          return new Response(
            JSON.stringify({ id: "key-scim-id", fingerprint: fp }),
          );
        }
        return new Response(JSON.stringify(results[index]));
      },
    );
    assert.equal(count, 8);
    const runtime = JSON.parse(
      await readFile(join(out, "oci-trial.json"), "utf8"),
    );
    assert.notEqual(runtime.userOcid, config.userOcid);
    assert.notEqual(runtime.fingerprint, config.fingerprint);
    assert.equal(runtime.privateKeyFile, join(out, "trial.pem"));
    assert.equal((await stat(join(out, "oci-trial.json"))).mode & 0o777, 0o600);
    const entries = (await readFile(join(out, "journal.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(entries.at(-1).phase, "complete");
    assert.equal(entries.filter((e) => e.phase === "intent").length, 5);
    assert.equal(entries.filter((e) => e.phase === "confirmed").length, 5);
  } finally {
    console.log = originalLog;
    await rm(dir, { recursive: true, force: true });
  }
});
