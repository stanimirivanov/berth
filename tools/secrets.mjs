import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Canonical scanner release; CI verifies the corresponding archive checksum. */
export const gitleaksVersion = "8.30.1";

/** Convert scanner output to fixed categories; never print raw findings, paths or secrets.
 * @param {{status:number|null,stdout:string,error?:unknown}} result
 */
export function scanResult(result) {
  if (result.error || ![0, 42].includes(result.status ?? -1))
    return "scanner-error";
  try {
    const report = JSON.parse(result.stdout);
    if (!Array.isArray(report)) return "scanner-error";
    return result.status === 0 && report.length === 0
      ? "clean"
      : result.status === 42 && report.length > 0
        ? "secret-finding"
        : "scanner-error";
  } catch {
    return "scanner-error";
  }
}

/** Scan worktree, index and locally fetched history with a bounded, exact-version executable. */
export function scanSecrets() {
  const version = spawnSync("gitleaks", ["version"], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (
    version.error ||
    version.status !== 0 ||
    version.stdout.trim() !== gitleaksVersion
  )
    throw Error("scanner-version");
  for (const args of [
    ["dir", "."],
    ["git", "--staged", "."],
    ["git", "."],
  ]) {
    const result = spawnSync(
      "gitleaks",
      [
        ...args,
        "--config",
        ".gitleaks.toml",
        "--redact=100",
        "--ignore-gitleaks-allow",
        "--exit-code=42",
        "--report-format",
        "json",
        "--report-path",
        "-",
      ],
      {
        encoding: "utf8",
        timeout: 60000,
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const status = scanResult(result);
    if (status !== "clean") throw Error(status);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    scanSecrets();
    console.log(
      "Secret scan passed: worktree, index, locally available history.",
    );
  } catch {
    console.error(
      "secret-scan: findings or incomplete scan; check the pinned tool and inspect locally with full redaction. Raw findings are withheld.",
    );
    process.exitCode = 1;
  }
}
