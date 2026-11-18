/** Explicit context supplied by the caller; this module authenticates none of it. */
export interface ExceptionContext {
  scope?: "verification";
  now: number;
  observedAt: number;
  exitCode: number;
  lockfileHash: string;
  commit: string;
  reportCommit: string;
  complete: boolean;
  diffComplete: boolean;
  supportedFixAvailable: boolean;
  assumptionsUnchanged: boolean;
  approval?:
    | { owner: string; issue: number; approvedAt: number; expiresAt: number }
    | undefined;
  changes: { path: string; status: string; oldMode: string; newMode: string }[];
}
/** Public paths bound to the approved lockfile. */
const approvedPaths = new Set([
  ".>alchemy>tinyglobby>fdir>picomatch",
  ".>alchemy>tinyglobby>picomatch",
  ".>alchemy>picomatch",
  ".>neon>@neon/config-runtime>@vercel/nft>@rollup/pluginutils>picomatch",
  ".>neon>@neon/config-runtime>@vercel/nft>picomatch",
  ".>@neon/config-runtime>@vercel/nft>@rollup/pluginutils>picomatch",
  ".>@neon/config-runtime>@vercel/nft>picomatch",
  ".>@stylistic/eslint-plugin>picomatch",
  ".>@alchemy.run/sql>alchemy>tinyglobby>fdir>picomatch",
  ".>@alchemy.run/sql>alchemy>tinyglobby>picomatch",
  ".>@alchemy.run/sql>alchemy>picomatch",
  ".>@alchemy.run/cloudflare>@alchemy.run/docker>alchemy>tinyglobby>fdir>picomatch",
  ".>@alchemy.run/cloudflare>@alchemy.run/docker>alchemy>tinyglobby>picomatch",
  ".>@alchemy.run/cloudflare>@alchemy.run/docker>alchemy>picomatch",
  ".>@alchemy.run/cloudflare>@alchemy.run/acme>alchemy>tinyglobby>fdir>picomatch",
  ".>@alchemy.run/cloudflare>@alchemy.run/acme>alchemy>tinyglobby>picomatch",
  ".>@alchemy.run/cloudflare>@alchemy.run/acme>alchemy>picomatch",
  ".>@alchemy.run/cloudflare>alchemy>tinyglobby>fdir>picomatch",
  ".>@alchemy.run/cloudflare>alchemy>tinyglobby>picomatch",
  ".>@alchemy.run/cloudflare>alchemy>picomatch",
  ".>@alchemy.run/cloudflare>@alchemy.run/sql>alchemy>tinyglobby>fdir>picomatch",
  ".>@alchemy.run/cloudflare>@alchemy.run/sql>alchemy>tinyglobby>picomatch",
  ".>@alchemy.run/cloudflare>@alchemy.run/sql>alchemy>picomatch",
  ".>@alchemy.run/cloudflare>tinyglobby>fdir>picomatch",
  ".>@alchemy.run/cloudflare>tinyglobby>picomatch",
  ".>@alchemy.run/cloudflare>picomatch",
]);

/** Narrow unknown JSON to an ordinary data record without accepting arrays or null. */
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate ordinary Markdown paths and modes; policy documents cannot authorize their own edits. */
function eligibleChange(change: ExceptionContext["changes"][number]) {
  return (
    /^(?:docs\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+[.]md|tasks\/plan[.]md)$/.test(
      change.path,
    ) &&
    !change.path.startsWith("docs/security/") &&
    ((change.status === "M" && change.oldMode === "100644") ||
      (change.status === "A" && change.oldMode === "000000")) &&
    change.newMode === "100644"
  );
}

/** Parse a complete native report; high findings remain visible and must match every bound field. */
function auditReport(text: string) {
  if (text.length > 4194304) throw Error("report-size");
  const value: unknown = JSON.parse(text);
  if (
    !record(value) ||
    Object.keys(value).sort().join(",") !== "advisories,metadata" ||
    !record(value.advisories) ||
    !record(value.metadata) ||
    !record(value.metadata.vulnerabilities)
  )
    throw Error("schema");
  const counts: Record<string, number> = {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
  };
  let high = 0;
  const foundPaths = new Set<string>();
  for (const [id, a] of Object.entries(value.advisories)) {
    if (
      !record(a) ||
      String(a.id) !== id ||
      typeof a.severity !== "string" ||
      !Object.hasOwn(counts, a.severity) ||
      typeof a.module_name !== "string" ||
      !a.module_name ||
      typeof a.github_advisory_id !== "string" ||
      !/^GHSA-[a-z0-9-]+$/.test(a.github_advisory_id) ||
      !Array.isArray(a.findings) ||
      !a.findings.length
    )
      throw Error("advisory");
    counts[a.severity] = (counts[a.severity] ?? 0) + 1;
    for (const f of a.findings) {
      if (
        !record(f) ||
        typeof f.version !== "string" ||
        !f.version ||
        !Array.isArray(f.paths) ||
        !f.paths.length ||
        !f.paths.every(
          (p) =>
            typeof p === "string" &&
            p.startsWith(".>") &&
            p.endsWith(`>${a.module_name}`) &&
            !p.includes("\n"),
        ) ||
        [f.dev, f.optional, f.bundled].some((b) => typeof b !== "boolean")
      )
        throw Error("finding");
      if (
        ["high", "critical"].includes(a.severity) &&
        (f.version !== "4.0.7" || !f.paths.every((p) => approvedPaths.has(p)))
      )
        throw Error("version");
    }
    if (["high", "critical"].includes(a.severity)) {
      if (
        a.severity !== "high" ||
        a.module_name !== "picomatch" ||
        a.github_advisory_id !== "GHSA-fc5q-39xc-vjpf" ||
        a.vulnerable_versions !== "<=4.0.7" ||
        a.patched_versions !== null ||
        a.url !== "https://github.com/advisories/GHSA-fc5q-39xc-vjpf"
      )
        throw Error("unqualified");
      for (const f of a.findings) {
        if (!record(f) || !Array.isArray(f.paths)) throw Error("finding");
        for (const path of f.paths) {
          if (typeof path !== "string" || foundPaths.has(path))
            throw Error("duplicate-path");
          foundPaths.add(path);
        }
      }
      high++;
    }
  }
  const vulnerabilities = value.metadata.vulnerabilities;
  if (
    Object.keys(vulnerabilities).sort().join(",") !==
      Object.keys(counts).sort().join(",") ||
    Object.entries(counts).some(
      ([key, count]) => vulnerabilities[key] !== count,
    )
  )
    throw Error("counts");
  if (high > 1 || (high === 1 && foundPaths.size !== approvedPaths.size))
    throw Error("incomplete-paths");
  return high;
}

/**
 * Offline classification only. The caller must authenticate approval,
 * clock, complete diff and fresh audit acquisition; this function cannot attest their origin.
 * No CLI, process, filesystem, CI or deployment action is performed here.
 */
export function evaluateException(
  report: string,
  c: ExceptionContext,
): "clean" | "temporary-exception" | "rejected" {
  try {
    if (
      !Number.isFinite(c.now) ||
      !Number.isFinite(c.observedAt) ||
      c.observedAt > c.now ||
      c.now - c.observedAt > 300000 ||
      c.complete !== true ||
      c.diffComplete !== true ||
      !/^[a-f0-9]{40}$/.test(c.commit) ||
      c.commit !== c.reportCommit
    )
      return "rejected";
    const high = auditReport(report);
    if (c.exitCode !== (high ? 1 : 0)) return "rejected";
    if (!high) return "clean";
    const a = c.approval;
    if (
      a?.owner !== "Stanimir" ||
      a.issue !== 59 ||
      !Number.isFinite(a.approvedAt) ||
      a.approvedAt < Date.parse("2026-11-18T00:00:00Z") ||
      a.approvedAt > c.observedAt ||
      a.expiresAt !== Date.parse("2026-11-25T00:00:00Z") ||
      c.now >= a.expiresAt ||
      c.lockfileHash !==
        "44204ec7857c2de9744a9e807f31a51eda502e9fc8041b6e1529ae374ac282a8" ||
      c.supportedFixAvailable !== false ||
      c.assumptionsUnchanged !== true ||
      (c.scope !== "verification" &&
        (!Array.isArray(c.changes) ||
          !c.changes.length ||
          !c.changes.every(eligibleChange)))
    )
      return "rejected";
    return "temporary-exception";
  } catch {
    return "rejected";
  }
}
