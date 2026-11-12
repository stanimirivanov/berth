import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  connectionConfig,
  privatePath,
  runSetup,
  validateTarget,
} from "../scripts/neon-setup.js";

test("secret files must be private, regular files outside the checkout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "berth-secret-test-"));
  try {
    const file = join(directory, "key");
    await writeFile(file, "fake-test-key", { mode: 0o600 });
    assert.equal(await privatePath(file, false), file);
    await chmod(file, 0o644);
    await assert.rejects(privatePath(file, false));
    await chmod(file, 0o600);
    const link = join(directory, "link");
    await symlink(file, link);
    await assert.rejects(privatePath(link, false));
    await assert.rejects(privatePath("relative-key", false));
    await assert.rejects(privatePath(process.cwd(), true));
  } finally {
    await rm(directory, { recursive: true });
  }
});

const target = {
  project: "quiet-river-123456",
  branch: "br-calm-river-123456",
  database: "neondb",
  owner: "neondb_owner",
  role: "berth_runtime",
  schema: "berth_trial",
  region: "aws-us-east-2",
};

test("plan uses only metadata GETs, accepts the default suspension timeout and never exposes its key", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "berth-plan-test-"));
  const messages: string[] = [];
  const requests: string[] = [];
  let timeout = 0;
  try {
    const file = join(directory, "key");
    await writeFile(file, "fake-api-secret", { mode: 0o600 });
    t.mock.method(console, "log", (value: string) => messages.push(value));
    t.mock.method(
      globalThis,
      "fetch",
      async (input: string, init: RequestInit) => {
        assert.equal(init.method, undefined);
        assert.equal(init.redirect, "error");
        requests.push(input);
        const body = input.endsWith("/branches")
          ? { branches: [{ id: target.branch }] }
          : input.endsWith("/endpoints")
            ? {
                endpoints: [
                  {
                    id: "ep-test",
                    host: "ep-test.us-east-2.aws.neon.tech",
                    branch_id: target.branch,
                    type: "read_write",
                    suspend_timeout_seconds: timeout,
                  },
                ],
              }
            : { project: { id: target.project, region_id: target.region } };
        return Response.json(body);
      },
    );
    const args = [
      "--project",
      target.project,
      "--branch",
      target.branch,
      "--api-key-file",
      file,
      "--confirm-free-plan",
    ];
    await runSetup(args);
    assert.equal(requests.length, 3);
    assert.ok(requests.every((url) => !url.includes("connection_uri")));
    assert.ok(!messages.join("").includes("fake-api-secret"));
    assert.match(messages.join(""), /owner-attested, not API-verified/);
    timeout = -1;
    await assert.rejects(runSetup(args), /scale-to-zero/);
    const before = requests.length;
    await assert.rejects(runSetup(args.slice(0, -1)), /attestation/);
    assert.equal(
      requests.length,
      before,
      "Missing Free attestation must fail before network access",
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("Ohio is supported; malformed targets and owner/runtime overlap are rejected", () => {
  assert.doesNotThrow(() => validateTarget(target));
  for (const change of [
    { database: "neondb; DROP ROLE owner" },
    { role: "neondb_owner" },
    { role: "pg_admin" },
    { schema: "public" },
    { region: "aws-moon-1" },
    { project: "../other" },
    { branch: "main" },
  ])
    assert.throws(() => validateTarget({ ...target, ...change }));
});

test("connection credentials only go to the selected Neon endpoint with certificate validation", () => {
  const uri =
    "postgresql://neondb_owner:fake-password@ep-test.us-east-2.aws.neon.tech/neondb?sslmode=require";
  const config = connectionConfig(
    uri,
    target,
    "ep-test.us-east-2.aws.neon.tech",
  );
  assert.deepEqual(config.ssl, { rejectUnauthorized: true });
  assert.equal(config.connectionString, undefined);
  for (const changed of [
    uri.replace(".neon.tech", ".neon.tech.attacker.test"),
    uri.replace("/neondb?", "/other?"),
    uri.replace("neondb_owner:", "other:"),
    uri.replace("postgresql:", "http:"),
  ])
    assert.throws(() =>
      connectionConfig(changed, target, "ep-test.us-east-2.aws.neon.tech"),
    );
});
