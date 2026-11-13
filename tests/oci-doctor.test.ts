import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runDoctor } from "../scripts/oci-doctor.js";
import { observedOciResponses } from "./fixtures/oci-observed.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const fingerprint = createHash("md5")
  .update(keys.publicKey.export({ type: "spki", format: "der" }))
  .digest("hex")
  .match(/../g)
  ?.join(":");
async function fixture(
  fn: (f: {
    args: string[];
    dir: string;
    config: string;
    output: string;
  }) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "berth-doctor-"));
  try {
    const config = join(dir, "trial.json");
    await writeFile(
      join(dir, "key.pem"),
      keys.privateKey.export({ type: "pkcs8", format: "pem" }),
      { mode: 0o600 },
    );
    await writeFile(
      config,
      JSON.stringify({
        tenancyOcid: "ocid1.tenancy.oc1..testtenancy",
        userOcid: "ocid1.user.oc1..testuser",
        groupOcid: "ocid1.group.oc1..testgroup",
        compartmentOcid: "ocid1.compartment.oc1..testcompartment",
        namespace: "private_namespace",
        region: "eu-frankfurt-1",
        homeRegion: "eu-frankfurt-1",
        fingerprint,
        privateKeyFile: join(dir, "key.pem"),
      }),
      { mode: 0o600 },
    );
    const output = join(dir, "diagnostics");
    await fn({
      dir,
      config,
      output,
      args: ["--config", config, "--output-dir", output],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const good = async (url: string, init: RequestInit) => {
  assert.ok(init.headers instanceof Headers);
  assert.ok(init.headers.has("authorization"));
  return new Response(
    JSON.stringify(url.endsWith("/n/") ? "private_namespace" : []),
    { headers: { date: new Date().toUTCString() } },
  );
};
test("doctor records redacted read-only success in exclusive private output", async () =>
  fixture(async (f) => {
    const calls: string[] = [];
    const result = await runDoctor(f.args, {
      transport: async (url, init) => {
        calls.push(`${init.method} ${new URL(url).pathname}`);
        return good(url, init);
      },
    });
    assert.equal(result.status, "passed");
    assert.equal(result.requestsDispatched, 3);
    assert.equal(result.usageEvidence, "inconclusive-no-metrics");
    assert.equal(calls.filter((c) => c.startsWith("POST")).length, 1);
    assert.ok(calls.at(-1)?.includes("summarizeMetricsData"));
    assert.doesNotMatch(
      JSON.stringify(result),
      /private_namespace|testuser|PRIVATE KEY|authorization/,
    );
    assert.equal((await stat(f.output)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(join(f.output, "report.json"))).mode & 0o777,
      0o600,
    );
    await assert.rejects(runDoctor(f.args, { transport: good }));
  }));
test("authentication polling is explicit, bounded and saves private bounded evidence", async () =>
  fixture(async (f) => {
    let calls = 0;
    const delays: number[] = [];
    const result = await runDoctor([...f.args, "--attempts", "3"], {
      sleep: async (ms) => {
        delays.push(ms);
      },
      transport: async () => {
        calls++;
        return new Response("PRIVATE_PROVIDER_TEXT".repeat(2000), {
          status: 401,
        });
      },
    });
    assert.equal(calls, 3);
    assert.deepEqual(delays, [5000, 5000]);
    assert.equal(result.status, "failed");
    assert.equal(result.category, "authentication");
    assert.equal(result.stage, "GetNamespace");
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROVIDER/);
    const diagnostic = JSON.parse(
      await readFile(join(f.output, "responses.json"), "utf8"),
    );
    assert.equal(diagnostic.length, 3);
    assert.ok(
      diagnostic.every(
        (r: { body: string; truncated: boolean }) =>
          Buffer.byteLength(r.body) <= 16384 && r.truncated,
      ),
    );
  }));
test("readiness polling stops on success and never retries authorization or malformed responses", async () => {
  for (const kind of [
    "ready",
    "forbidden",
    "json",
    "pagination",
    "clock",
    "transport",
  ]) {
    await fixture(async (f) => {
      let calls = 0;
      const result = await runDoctor([...f.args, "--attempts", "3"], {
        sleep: async () => {},
        transport: async (url, init) => {
          calls++;
          if (kind === "ready" && calls === 1)
            return new Response("{}", {
              status: observedOciResponses.newlyRegisteredKey.status,
            });
          if (kind === "forbidden")
            return new Response("PRIVATE", { status: 403 });
          if (kind === "json") return new Response("PRIVATE_INVALID_JSON");
          if (kind === "clock")
            return new Response('"private_namespace"', {
              headers: { date: new Date(Date.now() - 600000).toUTCString() },
            });
          if (kind === "transport") throw new Error("PRIVATE_TRANSPORT");
          if (kind === "pagination" && url.includes("/b?"))
            return new Response("[]", { headers: { "opc-next-page": "MQ==" } });
          return good(url, init);
        },
      });
      assert.equal(result.status, kind === "ready" ? "passed" : "failed");
      assert.equal(calls, kind === "ready" ? 4 : kind === "pagination" ? 2 : 1);
      if (kind === "clock") assert.equal(result.category, "clock-skew");
      if (kind === "pagination") assert.equal(result.category, "pagination");
      assert.doesNotMatch(
        JSON.stringify(result),
        /PRIVATE_TRANSPORT|PRIVATE_INVALID/,
      );
    });
  }
});
test("invalid attempts, unsafe private inputs and output symlinks dispatch no requests", async () => {
  for (const kind of ["attempts", "permissions", "key", "output-link"]) {
    await fixture(async (f) => {
      const args =
        kind === "attempts" ? [...f.args, "--attempts", "4"] : f.args;
      if (kind === "permissions") await chmod(f.config, 0o644);
      if (kind === "key") await writeFile(join(f.dir, "key.pem"), "not a key");
      if (kind === "output-link") await symlink(f.dir, f.output);
      let calls = 0;
      const outcome = await runDoctor(args, {
        transport: async () => {
          calls++;
          throw new Error("unexpected");
        },
      }).catch(() => null);
      if (outcome) assert.equal(outcome.status, "failed");
      assert.equal(calls, 0);
    });
  }
});
test("CLI comparison uses pinned version, private config and no retries; mismatches fail", async () => {
  for (const mismatch of [false, true])
    await fixture(async (f) => {
      let invocations = 0;
      const result = await runDoctor([...f.args, "--compare-cli"], {
        transport: good,
        cli: async (args) => {
          invocations++;
          if (args[0] === "--version") return "3.96.2\n";
          assert.ok(args.includes("--no-retry"));
          const path = args[args.indexOf("--config-file") + 1];
          assert.ok(path);
          assert.equal((await stat(path)).mode & 0o777, 0o600);
          return JSON.stringify({
            data: mismatch ? "other" : "private_namespace",
          });
        },
      });
      assert.equal(invocations, 2);
      assert.equal(result.cliComparison, mismatch ? "mismatch" : "matched");
      assert.equal(result.status, mismatch ? "failed" : "passed");
      await assert.rejects(stat(join(f.output, "cli.ini")));
    });
});

test("failed response streams are response failures, not readiness retries", async () =>
  fixture(async (f) => {
    let calls = 0;
    const result = await runDoctor([...f.args, "--attempts", "3"], {
      transport: async () => {
        calls++;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("PRIVATE_STREAM"));
            },
          }),
          { status: 401 },
        );
      },
      sleep: async () => {},
    });
    assert.equal(calls, 1);
    assert.equal(result.category, "response");
  }));
test("CLI version mismatch prevents cloud calls and process errors stay private", async () => {
  for (const mode of ["version", "process"]) {
    await fixture(async (f) => {
      let calls = 0;
      let isolated = false;
      const result = await runDoctor([...f.args, "--compare-cli"], {
        transport: async (url, init) => {
          calls++;
          return good(url, init);
        },
        cli: async (args) => {
          if (args[0] === "--version")
            return mode === "version" ? "wrong-version" : "3.96.2";
          isolated =
            args.includes("--cli-rc-file") && args.includes("--endpoint");
          throw new Error("PRIVATE_STDERR");
        },
      });
      assert.equal(calls, mode === "version" ? 0 : 3);
      if (mode === "process") assert.equal(isolated, true);
      assert.equal(result.status, "failed");
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_STDERR/);
      await assert.rejects(stat(join(f.output, "cli.ini")));
    });
  }
});

test("CLI independently compares failed authentication without hiding the primary failure", async () =>
  fixture(async (f) => {
    let cliCalls = 0;
    const result = await runDoctor([...f.args, "--compare-cli"], {
      transport: async () => new Response("{}", { status: 401 }),
      cli: async (args) => {
        cliCalls++;
        return args[0] === "--version"
          ? "3.96.2"
          : JSON.stringify({ data: "private_namespace" });
      },
    });
    assert.equal(cliCalls, 2);
    assert.equal(result.cliComparison, "matched");
    assert.equal(result.status, "failed");
    assert.equal(result.category, "authentication");
    assert.equal(result.stage, "GetNamespace");
  }));

test("private evidence retains pagination metadata without printing it", async () =>
  fixture(async (f) => {
    const result = await runDoctor(f.args, {
      transport: async (url, init) =>
        url.includes("/b?")
          ? new Response("[]", {
              headers: { "opc-next-page": "PRIVATE_PAGE_TOKEN" },
            })
          : good(url, init),
    });
    assert.equal(result.category, "pagination");
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PAGE_TOKEN/);
    const evidence = JSON.parse(
      await readFile(join(f.output, "responses.json"), "utf8"),
    );
    assert.equal(evidence.at(-1).nextPage, "PRIVATE_PAGE_TOKEN");
    assert.equal(evidence.at(-1).body, "[]");
    assert.doesNotMatch(
      JSON.stringify(evidence),
      /authorization|BEGIN PRIVATE/,
    );
  }));
