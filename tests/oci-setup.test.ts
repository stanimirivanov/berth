import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseOciConfig,
  policyStatements,
  verifyOciAccess,
} from "../scripts/oci-access.js";
import { runOciSetup } from "../scripts/oci-setup.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const fingerprint = createHash("md5")
  .update(keys.publicKey.export({ type: "spki", format: "der" }))
  .digest("hex")
  .match(/../g)
  ?.join(":");
const input = {
  tenancyOcid: "ocid1.tenancy.oc1..testtenancy",
  userOcid: "ocid1.user.oc1..testuser",
  groupOcid: "ocid1.group.oc1..testgroup",
  compartmentOcid: "ocid1.compartment.oc1..testcompartment",
  region: "eu-frankfurt-1",
  homeRegion: "eu-frankfurt-1",
  namespace: "testnamespace",
  fingerprint,
  privateKeyFile: "/private/trial.pem",
};

test("offline plan reads only the private config, never the key or network; unsafe file permissions are refused", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "berth-oci-config-"));
  try {
    const config = join(directory, "config.json");
    await writeFile(config, JSON.stringify(input), { mode: 0o600 });
    let calls = 0;
    t.mock.method(globalThis, "fetch", () => {
      calls++;
      throw new Error("No network permitted");
    });
    const logs: string[] = [];
    t.mock.method(console, "log", (value: string) => logs.push(value));
    await runOciSetup(["--config", config, "--mode", "plan"]);
    assert.equal(calls, 0);
    assert.match(logs.join(""), /BUCKET_CREATE/);
    assert.doesNotMatch(
      logs.join(""),
      /privateKeyFile|BEGIN PRIVATE KEY|testuser/,
    );
    await chmod(config, 0o644);
    await assert.rejects(runOciSetup(["--config", config]), /owner-only/);
    await chmod(config, 0o600);
    const link = join(directory, "link");
    await symlink(config, link);
    await assert.rejects(runOciSetup(["--config", link]));
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("policy is compartment-scoped and permits only the approved bucket/object operations and metric reads", () => {
  const statements = policyStatements(parseOciConfig(input));
  assert.equal(statements.length, 3);
  for (const statement of statements) {
    assert.ok(statement.includes(`group id ${input.groupOcid}`));
    assert.ok(statement.includes(`in compartment id ${input.compartmentOcid}`));
    assert.doesNotMatch(
      statement,
      /object-family|in tenancy|OVERWRITE|UPDATE|RETENTION|PAR_MANAGE|VERSION_DELETE/,
    );
  }
  assert.deepEqual(
    statements
      .slice(0, 2)
      .join(" ")
      .match(/request.permission='([^']+)'/g),
    [
      "BUCKET_INSPECT",
      "BUCKET_READ",
      "BUCKET_CREATE",
      "BUCKET_DELETE",
      "OBJECT_INSPECT",
      "OBJECT_READ",
      "OBJECT_CREATE",
      "OBJECT_DELETE",
    ].map((p) => `request.permission='${p}'`),
  );
  assert.match(
    statements[2] ?? "",
    /read metrics.*target.metrics.namespace='oci_objectstorage'/,
  );
});

test("rejects policy injection, wrong OCID types, non-home targets and arbitrary endpoints", () => {
  for (const change of [
    {
      groupOcid:
        "ocid1.group.oc1..testgroup to manage all-resources in tenancy",
    },
    { compartmentOcid: input.tenancyOcid },
    { region: "us-ashburn-1" },
    { region: "attacker.test", homeRegion: "attacker.test" },
    { endpoint: "https://attacker.test" },
    { fingerprint: "invalid" },
    { privateKeyFile: "relative.pem" },
  ])
    assert.throws(() => parseOciConfig({ ...input, ...change }));
});

test("verification signs exactly three read-only requests and reports missing metrics as inconclusive", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const transport = async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    assert.ok(
      new Headers(init.headers).get("authorization")?.startsWith("Signature "),
    );
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    return Response.json(requests.length === 1 ? input.namespace : []);
  };
  const report = await verifyOciAccess(
    parseOciConfig(input),
    pem,
    undefined,
    transport,
  );
  assert.deepEqual(
    requests.map((r) => r.init.method),
    ["GET", "GET", "POST"],
  );
  assert.equal(new URL(requests[0]?.url ?? "").pathname, "/n/");
  assert.equal(new URL(requests[0]?.url ?? "").search, "");
  assert.equal(
    new URL(requests[1]?.url ?? "").searchParams.get("compartmentId"),
    input.compartmentOcid,
  );
  assert.equal(new URL(requests[1]?.url ?? "").searchParams.get("limit"), "1");
  assert.equal(
    new URL(requests[2]?.url ?? "").pathname,
    "/20180401/metrics/actions/summarizeMetricsData",
  );
  assert.equal(
    JSON.parse(String(requests[2]?.init.body)).namespace,
    "oci_objectstorage",
  );
  assert.equal(report.readOnlyAccess, "passed");
  assert.equal(report.usageEvidence, "inconclusive-no-metrics");
  assert.equal(report.requestsDispatched, 3);
  assert.ok(!JSON.stringify(report).includes(input.tenancyOcid));
  assert.ok(!JSON.stringify(report).includes(input.namespace));
});

test("wrong keys fail before dispatch; failures never retry or continue", async () => {
  let calls = 0;
  const failed = async () => {
    calls++;
    return new Response("private provider error", { status: 403 });
  };
  await assert.rejects(
    verifyOciAccess(
      parseOciConfig({ ...input, fingerprint: `${"00:".repeat(15)}00` }),
      pem,
      undefined,
      failed,
    ),
    /fingerprint/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    verifyOciAccess(parseOciConfig(input), pem, undefined, failed),
    /GetNamespace.*403/,
  );
  assert.equal(calls, 1);
});

test("weak/non-RSA keys cannot reach the network; encrypted RSA keys can verify", async () => {
  let calls = 0;
  const transport = async () => {
    calls++;
    return Response.json(calls === 1 ? input.namespace : []);
  };
  const weak = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey;
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
  for (const key of [weak, ec]) {
    await assert.rejects(
      verifyOciAccess(
        parseOciConfig(input),
        key.export({ type: "pkcs8", format: "pem" }).toString(),
        undefined,
        transport,
      ),
      /RSA signing key/,
    );
  }
  assert.equal(calls, 0);
  const encrypted = keys.privateKey
    .export({
      type: "pkcs8",
      format: "pem",
      cipher: "aes-256-cbc",
      passphrase: "test-only-passphrase",
    })
    .toString();
  const report = await verifyOciAccess(
    parseOciConfig(input),
    encrypted,
    "test-only-passphrase",
    transport,
  );
  assert.equal(report.readOnlyAccess, "passed");
  assert.equal(calls, 3);
});

test("transport interruption stops after one dispatch and never leaks the thrown error", async () => {
  let calls = 0;
  await assert.rejects(
    verifyOciAccess(parseOciConfig(input), pem, undefined, async () => {
      calls++;
      throw new Error("private credential from transport");
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /GetNamespace transport failed.*1 request/);
      assert.doesNotMatch(error.message, /private credential/);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("namespace mismatch, nonempty compartment, pagination and malformed responses stop verification", async () => {
  for (const scenario of ["namespace", "nonempty", "pagination", "malformed"]) {
    let calls = 0;
    const transport = async () => {
      calls++;
      if (calls === 1)
        return Response.json(
          scenario === "namespace" ? "othernamespace" : input.namespace,
        );
      if (scenario === "pagination")
        return Response.json([], { headers: { "opc-next-page": "next" } });
      return Response.json(
        scenario === "nonempty" ? [{ name: "unrelated-bucket" }] : {},
      );
    };
    await assert.rejects(
      verifyOciAccess(parseOciConfig(input), pem, undefined, transport),
    );
    assert.equal(calls, scenario === "namespace" ? 1 : 2);
  }
});
