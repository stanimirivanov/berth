import { execFile } from "node:child_process";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import {
  createOciSigner,
  type OciConfig,
  parseOciConfig,
  verifyOciAccess,
} from "./oci-access.js";
import { readPrivateText } from "./oci-files.js";

const CLI_VERSION = "3.96.2";
type Transport = (url: string, init: RequestInit) => Promise<Response>;
type Category =
  | "local-configuration"
  | "local-key"
  | "authentication"
  | "authorization"
  | "availability-or-authorization"
  | "http"
  | "transport"
  | "response"
  | "pagination"
  | "clock-skew"
  | "validation"
  | "tooling";
interface Report {
  checkedAt: string;
  status: "passed" | "failed";
  stage: string;
  category?: Category;
  httpStatus?: number;
  attempts: number;
  requestsDispatched: number;
  clockSkewSeconds: number | null;
  cliComparison:
    | "not-requested"
    | "not-run"
    | "matched"
    | "mismatch"
    | "failed";
  cliRequestsDispatched: number;
  usageEvidence?: string;
}
interface Dependencies {
  transport?: Transport;
  sleep?: (ms: number) => Promise<void>;
  cli?: (args: string[]) => Promise<string>;
}
async function save(path: string, value: unknown) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(
      typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function createOutput(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path)
    throw new Error("Use a normalized absolute output directory");
  const parent = await realpath(dirname(path));
  const info = await lstat(parent);
  const rel = relative(await realpath(process.cwd()), parent);
  if (
    parent !== dirname(path) ||
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0 ||
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  )
    throw new Error("Use an owner-only private parent outside the checkout");
  await mkdir(path, { mode: 0o700 }); // Exclusive: never reuse a previous diagnostic directory.
}
async function boundedBody(response: Response, limit: number) {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    if (reader)
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const take = Math.min(value.byteLength, limit - size);
        chunks.push(value.subarray(0, take));
        size += take;
        if (size === limit) {
          truncated = true;
          await reader.cancel();
          break;
        }
      }
    return {
      body: new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks),
        { stream: truncated },
      ),
      truncated,
    };
  } finally {
    reader?.releaseLock();
  }
}
function operation(config: OciConfig, url: string, method: string | undefined) {
  const storage = `https://objectstorage.${config.region}.oraclecloud.com`;
  if (method === "GET" && url === `${storage}/n/`) return "GetNamespace";
  const buckets = `${storage}/n/${encodeURIComponent(config.namespace)}/b?${new URLSearchParams({ compartmentId: config.compartmentOcid, limit: "1" })}`;
  if (method === "GET" && url === buckets) return "ListBuckets";
  const metrics = `https://telemetry.${config.region}.oraclecloud.com/20180401/metrics/actions/summarizeMetricsData?${new URLSearchParams({ compartmentId: config.compartmentOcid })}`;
  if (method === "POST" && url === metrics) return "SummarizeMetricsData"; // Read-only query, despite HTTP POST.
  throw new Error("Unexpected operation blocked");
}
const cliExec = promisify(execFile);
async function executeCli(args: string[]) {
  const { stdout } = await cliExec("oci", args, {
    timeout: 20000,
    maxBuffer: 65536,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: "C.UTF-8",
      OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING: "False",
    },
  });
  return stdout;
}

export async function runDoctor(
  args: string[],
  dependencies: Dependencies = {},
): Promise<Report> {
  const { values } = parseArgs({
    args,
    options: {
      config: { type: "string" },
      "output-dir": { type: "string" },
      attempts: { type: "string", default: "1" },
      "compare-cli": { type: "boolean", default: false },
    },
  });
  if (
    !values.config ||
    !values["output-dir"] ||
    !/^[1-3]$/.test(values.attempts)
  )
    throw new Error(
      "Supply --config, --output-dir and optional --attempts 1|2|3 / --compare-cli",
    );
  const output = values["output-dir"];
  await createOutput(output);
  const report: Report = {
    checkedAt: new Date().toISOString(),
    status: "failed",
    stage: "LocalConfiguration",
    attempts: 0,
    requestsDispatched: 0,
    clockSkewSeconds: null,
    cliComparison: values["compare-cli"] ? "not-run" : "not-requested",
    cliRequestsDispatched: 0,
  };
  const responses: {
    attempt: number;
    stage: string;
    status: number;
    body: string;
    truncated: boolean;
    nextPage?: string;
  }[] = [];
  const sleep =
    dependencies.sleep ??
    (async (ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const cli = dependencies.cli ?? executeCli;
  let category: Category = "local-configuration";
  try {
    const config = parseOciConfig(
      JSON.parse(await readPrivateText(values.config)),
    );
    category = "local-key";
    report.stage = "LocalKey";
    const pem = await readPrivateText(config.privateKeyFile);
    const passphrase =
      config.passphraseFile === undefined
        ? undefined
        : (await readPrivateText(config.passphraseFile)).replace(/\r?\n$/, "");
    createOciSigner(config, pem, passphrase); // Fail locally before any cloud request.
    if (values["compare-cli"]) {
      report.stage = "CliVersion";
      category = "tooling";
      if ((await cli(["--version"])).trim() !== CLI_VERSION)
        throw new Error("CLI version mismatch");
      // No passphrase in process arguments or environment; CLI comparison needs an unencrypted trial key.
      if (config.passphraseFile !== undefined)
        throw new Error("Encrypted key unsupported by CLI comparison");
    }
    for (let attempt = 1; attempt <= Number(values.attempts); attempt++) {
      report.attempts = attempt;
      delete report.httpStatus;
      try {
        const result = await verifyOciAccess(
          config,
          pem,
          passphrase,
          async (url, init) => {
            report.stage = operation(config, url, init.method);
            category = "transport";
            const started = Date.now();
            report.requestsDispatched++;
            const response = await (dependencies.transport ?? fetch)(url, init);
            const ended = Date.now();
            report.httpStatus = response.status;
            const server = Date.parse(response.headers.get("date") ?? "");
            if (Number.isFinite(server)) {
              // Compare to the request window: network latency must not masquerade as skew.
              const skew =
                server < started
                  ? (server - started) / 1000
                  : server > ended
                    ? (server - ended) / 1000
                    : 0;
              report.clockSkewSeconds = Math.round(skew);
              if (Math.abs(skew) > 300) {
                category = "clock-skew";
                await response.body?.cancel();
                throw new Error("Clock skew");
              }
            }
            category =
              response.status === 401
                ? "authentication"
                : response.status === 403
                  ? "authorization"
                  : response.status === 404
                    ? "availability-or-authorization"
                    : response.ok
                      ? "response"
                      : "http";
            let captured: { body: string; truncated: boolean };
            try {
              captured = await boundedBody(
                response,
                response.ok ? 65536 : 16384,
              );
            } catch {
              category = "response";
              responses.push({
                attempt,
                stage: report.stage,
                status: response.status,
                body: "[response body unavailable]",
                truncated: true,
              });
              throw new Error("Response body failed");
            }
            responses.push({
              attempt,
              stage: report.stage,
              status: response.status,
              body: new TextDecoder().decode(
                Buffer.from(captured.body).subarray(0, 16384),
                { stream: true },
              ),
              truncated:
                captured.truncated || Buffer.byteLength(captured.body) > 16384,
              nextPage: (response.headers.get("opc-next-page") ?? "").slice(
                0,
                256,
              ),
            });
            if (!response.ok || captured.truncated) {
              if (response.ok) category = "response";
              throw new Error("HTTP or body limit failure");
            }
            const data: unknown = JSON.parse(captured.body);
            if (
              report.stage === "ListBuckets" &&
              response.headers.has("opc-next-page")
            ) {
              category = "pagination";
              throw new Error("Incomplete collection");
            }
            category = "validation";
            return new Response(JSON.stringify(data), {
              status: response.status,
              headers: response.headers,
            });
          },
        );
        report.status = "passed";
        report.stage = "Complete";
        report.usageEvidence = result.usageEvidence;
        break;
      } catch {
        report.category = category;
        if (
          attempt === Number(values.attempts) ||
          !["authentication", "availability-or-authorization"].includes(
            category,
          )
        )
          break;
        await sleep(5000);
      }
    }
    if (report.status === "passed") delete report.category;
    if (values["compare-cli"] && report.category !== "clock-skew") {
      const primary = { ...report };
      try {
        report.stage = "CliNamespace";
        category = "tooling";
        const ini = join(output, "cli.ini");
        if (/[\r\n]/.test(config.privateKeyFile))
          throw new Error("Invalid CLI key path");
        await save(
          ini,
          `[BERTH_TRIAL]\ntenancy=${config.tenancyOcid}\nuser=${config.userOcid}\nfingerprint=${config.fingerprint}\nkey_file=${config.privateKeyFile}\nregion=${config.region}\n`,
        );
        try {
          report.cliRequestsDispatched = 1;
          const raw = await cli([
            "--config-file",
            ini,
            "--profile",
            "BERTH_TRIAL",
            "--auth",
            "api_key",
            "--no-retry",
            "--cli-rc-file",
            "/dev/null",
            "--endpoint",
            `https://objectstorage.${config.region}.oraclecloud.com`,
            "--connection-timeout",
            "5",
            "--read-timeout",
            "15",
            "os",
            "ns",
            "get",
          ]);
          report.cliComparison =
            JSON.parse(raw).data === config.namespace ? "matched" : "mismatch";
          if (report.cliComparison !== "matched")
            throw new Error("CLI mismatch");
          report.stage = "Complete";
        } finally {
          await unlink(ini);
        }
      } catch {
        if (report.cliComparison !== "mismatch")
          report.cliComparison = "failed";
        if (primary.status === "passed") {
          report.status = "failed";
          report.category = "tooling";
        }
      } finally {
        if (primary.status === "failed") {
          report.status = primary.status;
          report.stage = primary.stage;
          if (primary.category) report.category = primary.category;
        }
      }
    }
  } catch {
    report.status = "failed";
    report.category = category;
    if (report.stage === "CliNamespace" && report.cliComparison !== "mismatch")
      report.cliComparison = "failed";
  }
  await save(join(output, "responses.json"), responses);
  await save(join(output, "report.json"), report);
  return report;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runDoctor(process.argv.slice(2))
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      if (report.status !== "passed") process.exitCode = 1;
    })
    .catch(() => {
      console.error(
        "OCI doctor stopped: invalid arguments or private output unavailable. Existing evidence was not overwritten. No raw errors are printed.",
      );
      process.exitCode = 1;
    });
}
