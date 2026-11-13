import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { capabilities } from "../scripts/oci-admin.js";
import { runOciAdmin } from "../scripts/oci-admin-setup.js";

const id = (kind: string) => `ocid1.${kind}.oc1..aaaaaaaarecovery`;
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const pub = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const fingerprint = createHash("md5")
  .update(keys.publicKey.export({ type: "spki", format: "der" }))
  .digest("hex")
  .match(/../g)
  ?.join(":") as string;
const adminKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const adminPem = adminKeys.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
const adminFingerprint = createHash("md5")
  .update(adminKeys.publicKey.export({ type: "spki", format: "der" }))
  .digest("hex")
  .match(/../g)
  ?.join(":") as string;
const base = "https://identity.eu-frankfurt-1.oci.oraclecloud.com/20160918";
const domain = "https://idcs-aaaaaaaa.identity.oraclecloud.com";
const extension =
  "urn:ietf:params:scim:schemas:oracle:idcs:extension:capabilities:User";
const description =
  "Berth disposable Object Storage trial; owner-managed IAM cleanup";
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "berth-recover-"));
  const config = {
    tenancyOcid: id("tenancy"),
    userOcid: id("user"),
    domainOcid: id("domain"),
    region: "eu-frankfurt-1",
    fingerprint: adminFingerprint,
    privateKeyFile: join(dir, "admin.pem"),
    name: "berth-trial",
    trialEmail: "owner@example.test",
  };
  const events = [
    {
      phase: "start",
      name: config.name,
      tenancyOcid: config.tenancyOcid,
      domainOcid: config.domainOcid,
      region: config.region,
      fingerprint,
    },
    {
      phase: "intent",
      operation: "CreateCompartment",
      url: `${base}/compartments`,
      body: {
        compartmentId: config.tenancyOcid,
        name: config.name,
        description,
      },
    },
    {
      phase: "confirmed",
      operation: "CreateCompartment",
      id: id("compartment"),
    },
    {
      phase: "intent",
      operation: "CreateUser",
      url: `${domain}/admin/v1/Users`,
      body: {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User", extension],
        userName: "berth-trial-executor",
        displayName: "berth-trial-executor",
        active: true,
        userType: "Service",
        [extension]: capabilities,
      },
    },
  ].map((e) => ({ at: "2026-11-12T20:45:37.005Z", ...e }));
  const configFile = join(dir, "admin.json");
  // An existing owner-only directory, as produced by the first bootstrap.
  const out = join(dir, "oci-bootstrap-02");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(out, { mode: 0o700 });
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  await writeFile(config.privateKeyFile, adminPem, { mode: 0o600 });
  await writeFile(join(out, "trial.pem"), pem, { mode: 0o600 });
  await writeFile(join(out, "trial-public.pem"), pub, { mode: 0o600 });
  const journal = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
  await writeFile(join(out, "journal.jsonl"), journal, { mode: 0o600 });
  const calls: { url: string; init: RequestInit }[] = [];
  const transport = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    if (init.method === "POST") {
      const recorded = await readFile(join(out, "journal.jsonl"), "utf8");
      assert.ok(recorded.includes('"phase":"recovery-start"'));
      assert.equal(
        JSON.parse(recorded.trim().split("\n").at(-1) as string).phase,
        "intent",
      );
    }
    let data: unknown;
    if (url.includes("/tenancies/"))
      data = { id: config.tenancyOcid, homeRegionKey: "FRA" };
    else if (url.includes("/domains/"))
      data = {
        id: config.domainOcid,
        compartmentId: config.tenancyOcid,
        lifecycleState: "ACTIVE",
        url: domain,
      };
    else if (url.endsWith("/n/")) data = "namespace";
    else if (url.includes("/compartments/"))
      data = {
        id: id("compartment"),
        compartmentId: config.tenancyOcid,
        name: config.name,
        description,
        lifecycleState: "ACTIVE",
      };
    else if (url.includes("/b?") || url.includes("/policies?")) data = [];
    else if (url.includes("/Users?") || url.includes("/Groups?"))
      data = { totalResults: 0, Resources: [] };
    else if (url.endsWith("/Users"))
      data = {
        id: "user-scim",
        ocid: "ocid1.user.oc1..aaaaaaaatrial",
        [extension]: capabilities,
      };
    else if (url.endsWith("/Groups"))
      data = {
        id: "group-scim",
        ocid: id("group"),
        members: [{ value: "user-scim" }],
      };
    else if (url.endsWith("/ApiKeys")) {
      assert.equal(JSON.parse(String(init.body)).key, pub);
      data = { id: "key-scim", fingerprint };
    } else if (url.endsWith("/policies")) data = { id: id("policy") };
    else assert.fail(`Unexpected operation: ${new URL(url).pathname}`);
    return new Response(JSON.stringify(data));
  };
  const args = (mode = "recover-plan") => [
    "--config",
    configFile,
    "--mode",
    mode,
    "--output-dir",
    out,
    ...(mode === "recover" ? ["--confirm-user-create-rejected"] : []),
  ];
  return { dir, out, events, journal, calls, transport, args, config };
}
async function withFixture(
  run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
) {
  const f = await fixture();
  const log = console.log;
  console.log = () => {};
  try {
    await run(f);
  } finally {
    console.log = log;
    await rm(f.dir, { recursive: true, force: true });
  }
}
test("recovery plan checks live state without writes; recovery reuses compartment and original key", () =>
  withFixture(async (f) => {
    await runOciAdmin(f.args(), f.transport);
    assert.equal(f.calls.length, 8);
    assert.ok(f.calls.every((c) => c.init.method === "GET"));
    assert.equal(
      await readFile(join(f.out, "journal.jsonl"), "utf8"),
      f.journal,
    );
    f.calls.length = 0;
    await runOciAdmin(f.args("recover"), f.transport);
    assert.equal(f.calls.length, 12);
    assert.equal(f.calls.filter((c) => c.init.method === "POST").length, 4);
    assert.ok(
      !f.calls.some(
        (c) => c.init.method === "POST" && c.url.endsWith("/compartments"),
      ),
    );
    assert.equal(await readFile(join(f.out, "trial.pem"), "utf8"), pem);
    const runtime = JSON.parse(
      await readFile(join(f.out, "oci-trial.json"), "utf8"),
    );
    assert.equal(runtime.compartmentOcid, id("compartment"));
    assert.equal(runtime.fingerprint, fingerprint);
    assert.equal(runtime.privateKeyFile, join(f.out, "trial.pem"));
    assert.notEqual(runtime.userOcid, f.config.userOcid);
    const after = await readFile(join(f.out, "journal.jsonl"), "utf8");
    assert.ok(after.startsWith(f.journal));
    assert.equal(
      JSON.parse(after.trim().split("\n").at(-1) as string).phase,
      "complete",
    );
  }));
test("recovery rejects changed target, malformed/later journal, wrong key and missing attestation before network", async () => {
  for (const change of [
    "target",
    "truncated",
    "later",
    "key",
    "attestation",
    "permissions",
    "runtime",
    "admin-key-reuse",
  ]) {
    await withFixture(async (f) => {
      let args = f.args("recover");
      if (change === "admin-key-reuse") {
        await writeFile(f.config.privateKeyFile, pem);
        await writeFile(
          join(f.dir, "admin.json"),
          JSON.stringify({ ...f.config, fingerprint }),
        );
      }

      if (change === "target") {
        const altered = JSON.parse(JSON.stringify(f.events));
        altered[0].name = "unrelated";
        await writeFile(
          join(f.out, "journal.jsonl"),
          `${altered.map((event: unknown) => JSON.stringify(event)).join("\n")}\n`,
        );
      }
      if (change === "truncated")
        await writeFile(join(f.out, "journal.jsonl"), f.journal.slice(0, -4));
      if (change === "later")
        await writeFile(
          join(f.out, "journal.jsonl"),
          `${f.journal}{"phase":"recovery-start"}\n`,
        );
      if (change === "key")
        await writeFile(join(f.out, "trial-public.pem"), "not a key");
      if (change === "attestation")
        args = args.filter((v) => v !== "--confirm-user-create-rejected");
      if (change === "permissions")
        await chmod(join(f.out, "journal.jsonl"), 0o644);
      if (change === "runtime")
        await writeFile(join(f.out, "oci-trial.json"), "{}", { mode: 0o600 });
      await assert.rejects(runOciAdmin(args, f.transport));
      assert.equal(f.calls.length, 0, change);
    });
  }
});
test("cloud conflicts, pagination and ambiguous SCIM absence prevent every recovery write", async () => {
  for (const bad of [
    "compartment",
    "bucket",
    "user",
    "group",
    "policy",
    "page",
    "ambiguous",
  ]) {
    await withFixture(async (f) => {
      const transport = async (url: string, init: RequestInit) => {
        if (
          (bad === "compartment" && url.includes("/compartments/")) ||
          (bad === "ambiguous" && url.includes("/Users?"))
        )
          return new Response("{}");
        if (bad === "bucket" && url.includes("/b?"))
          return new Response('[{"name":"existing"}]');
        if (
          (bad === "user" && url.includes("/Users?")) ||
          (bad === "group" && url.includes("/Groups?"))
        )
          return new Response('{"totalResults":1,"Resources":[{}]}');
        if (bad === "policy" && url.includes("/policies?"))
          return new Response("[{}]");
        if (bad === "page" && url.includes("/b?"))
          return new Response("[]", { headers: { "opc-next-page": "more" } });
        return f.transport(url, init);
      };
      await assert.rejects(runOciAdmin(f.args("recover"), transport));
      assert.ok(f.calls.every((c) => c.init.method === "GET"));
      assert.equal(
        await readFile(join(f.out, "journal.jsonl"), "utf8"),
        f.journal,
      );
    });
  }
});
test("interrupted recovery is not replayed, and concurrent recovery is refused", () =>
  withFixture(async (f) => {
    let checkedLock = false;
    const transport = async (url: string, init: RequestInit) => {
      if (!checkedLock) {
        checkedLock = true;
        await assert.rejects(runOciAdmin(f.args("recover"), f.transport));
        assert.equal(f.calls.length, 0);
      }
      if (init.method === "POST") throw new Error("secret response");
      return f.transport(url, init);
    };
    await assert.rejects(
      runOciAdmin(f.args("recover"), transport),
      (e) => e instanceof Error && !e.message.includes("secret response"),
    );
    const count = f.calls.length;
    await assert.rejects(runOciAdmin(f.args("recover"), f.transport));
    assert.equal(f.calls.length, count);
    assert.ok(
      (await readFile(join(f.out, "journal.jsonl"), "utf8")).includes(
        '"phase":"recovery-start"',
      ),
    );
  }));

test("recovery refuses symlinked files/directories and a journal for a different domain", async () => {
  for (const kind of ["file", "directory", "domain"]) {
    await withFixture(async (f) => {
      const { rename, symlink } = await import("node:fs/promises");
      if (kind === "file") {
        await rename(join(f.out, "trial.pem"), join(f.out, "saved.pem"));
        await symlink(join(f.out, "saved.pem"), join(f.out, "trial.pem"));
      }
      if (kind === "directory") {
        await rename(f.out, `${f.out}-saved`);
        await symlink(`${f.out}-saved`, f.out);
      }
      if (kind === "domain")
        await writeFile(
          join(f.out, "journal.jsonl"),
          f.journal.replace(
            domain,
            "https://idcs-bbbbbbbb.identity.oraclecloud.com",
          ),
        );
      await assert.rejects(runOciAdmin(f.args("recover"), f.transport));
      assert.ok(f.calls.every((c) => c.init.method === "GET"));
      if (kind !== "domain") assert.equal(f.calls.length, 0);
    });
  }
});
test("every remaining mutation failure preserves the original key and prevents replay", async () => {
  for (const failed of ["Users", "Groups", "ApiKeys", "policies"]) {
    await withFixture(async (f) => {
      let writes = 0;
      const transport = async (url: string, init: RequestInit) => {
        if (init.method === "POST") {
          writes++;
          if (url.endsWith(`/${failed}`))
            return new Response("private-provider-body", { status: 400 });
        }
        return f.transport(url, init);
      };
      await assert.rejects(
        runOciAdmin(f.args("recover"), transport),
        (e) =>
          e instanceof Error &&
          e.message.includes("HTTP 400") &&
          !e.message.includes("private-provider-body"),
      );
      assert.equal(
        writes,
        ["Users", "Groups", "ApiKeys", "policies"].indexOf(failed) + 1,
      );
      assert.equal(await readFile(join(f.out, "trial.pem"), "utf8"), pem);
      if (failed === "Users") {
        const diagnostic = JSON.parse(
          await readFile(join(f.out, "create-user-error.json"), "utf8"),
        );
        assert.equal(diagnostic.body, "private-provider-body");
        assert.ok(
          !(await readFile(join(f.out, "journal.jsonl"), "utf8")).includes(
            "private-provider-body",
          ),
        );
      }

      const count = f.calls.length;
      await assert.rejects(runOciAdmin(f.args("recover"), f.transport));
      assert.equal(f.calls.length, count);
    });
  }
});

test("second legacy rejection needs its own attestation and exact journal linkage", async () => {
  for (const variant of [
    "success",
    "missing-attestation",
    "bad-hash",
    "later",
  ]) {
    await withFixture(async (f) => {
      const oldUser = JSON.parse(JSON.stringify(f.events[3]));
      oldUser.body.name = { familyName: "berth-trial-executor" };
      const marker = {
        at: "2026-11-13T08:00:00.000Z",
        phase: "recovery-start",
        originalJournalHash: createHash("sha256")
          .update(f.journal)
          .digest("hex"),
        compartmentOcid: id("compartment"),
        userCreateRejectedAttested: true,
      };
      if (variant === "bad-hash") marker.originalJournalHash = "bad";
      const text =
        f.journal +
        JSON.stringify(marker) +
        "\n" +
        JSON.stringify(oldUser) +
        "\n" +
        (variant === "later" ? "{}\n" : "");
      await writeFile(join(f.out, "journal.jsonl"), text);
      const args = [
        ...f.args("recover"),
        ...(variant === "missing-attestation"
          ? []
          : ["--confirm-primary-email-rejection"]),
      ];
      if (variant !== "success") {
        await assert.rejects(runOciAdmin(args, f.transport));
        assert.equal(f.calls.length, 0);
        return;
      }
      await runOciAdmin(args, f.transport);
      assert.equal(f.calls.length, 12);
      const posted = JSON.parse(
        String(
          f.calls.find(
            (c) => c.init.method === "POST" && c.url.endsWith("/Users"),
          )?.init.body,
        ),
      );
      assert.deepEqual(posted.emails, [
        { value: f.config.trialEmail, type: "work", primary: true },
      ]);
      assert.ok(
        (await readFile(join(f.out, "journal.jsonl"), "utf8")).startsWith(text),
      );
      const count = f.calls.length;
      await assert.rejects(runOciAdmin(args, f.transport));
      assert.equal(f.calls.length, count);
    });
  }
});
