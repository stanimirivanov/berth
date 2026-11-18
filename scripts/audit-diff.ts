import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Collect a complete committed diff from GitHub's event base; local runs use origin/main. Dirty trees never qualify. */
export function collectAuditDiff() {
  /** Fixed argument vectors, bounded output and no shell interpolation. */
  const git = (args: string[]) => {
    const r = spawnSync("git", args, {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (r.status !== 0 || r.error || r.signal)
      throw Error("git-diff-collection");
    return r.stdout;
  };
  const commit = git(["rev-parse", "HEAD"]).trim();
  if (
    !/^[a-f0-9]{40}$/.test(commit) ||
    git(["status", "--porcelain", "--untracked-files=all"]).trim()
  )
    throw Error("unclean-checkout");
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== commit)
    throw Error("commit-mismatch");
  let base: string;
  if (process.env.GITHUB_EVENT_NAME === "pull_request") {
    if (!process.env.GITHUB_EVENT_PATH) throw Error("missing-event");
    const event = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"),
    );
    if (event.repository?.full_name !== process.env.GITHUB_REPOSITORY)
      throw Error("repository-mismatch");
    base = event.pull_request?.base?.sha;
  } else if (process.env.GITHUB_EVENT_NAME === "push") {
    if (!process.env.GITHUB_EVENT_PATH) throw Error("missing-event");
    const event = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"),
    );
    if (event.repository?.full_name !== process.env.GITHUB_REPOSITORY)
      throw Error("repository-mismatch");
    base = event.before;
  } else base = git(["merge-base", "HEAD", "origin/main"]).trim();
  if (typeof base !== "string" || !/^[a-f0-9]{40}$/.test(base))
    throw Error("invalid-base");
  git(["merge-base", "--is-ancestor", base, commit]);
  const raw = git([
    "diff",
    "--raw",
    "--no-abbrev",
    "--no-renames",
    "-z",
    base,
    commit,
    "--",
  ]);
  return { commit, base, raw, complete: true };
}
