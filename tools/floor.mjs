import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import ts from "typescript-ast";

/** Collect literal node:test titles as a multiset; bodies and assertion quality still need review.
 * @param {Record<string,string>} files
 */
function titles(files) {
  /** @type {Map<string,number>} */
  const found = new Map();
  for (const [file, text] of Object.entries(files))
    if (/\.test\.(?:ts|mjs)$/.test(file)) {
      const source = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
      );
      /** Walk syntax rather than matching test-like text in fixture strings. @param {ts.Node} node */
      function visit(node) {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          ["test", "it"].includes(node.expression.text) &&
          node.arguments[0] &&
          ts.isStringLiteralLike(node.arguments[0])
        ) {
          const name = node.arguments[0].text;
          found.set(name, (found.get(name) ?? 0) + 1);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  return found;
}

/** Preserve baseline tests and commands; additive named checks must retain the exact original command.
 * This is structural review assistance, not proof that test assertions remain meaningful.
 * @param {Record<string,string>} base @param {Record<string,string>} candidate
 * @returns {string[]}
 */
export function compareBaseline(base, candidate) {
  const errors = [];
  const current = titles(candidate);
  for (const [title, count] of titles(base))
    if ((current.get(title) ?? 0) < count) errors.push("removed-test");
  if (base["package.json"]) {
    const before = JSON.parse(base["package.json"]).scripts ?? {};
    const after = JSON.parse(candidate["package.json"] ?? "{}").scripts ?? {};
    for (const [key, command] of Object.entries(before)) {
      const value = after[key];
      if (value === command) continue;
      if (
        typeof command !== "string" ||
        typeof value !== "string" ||
        !value.startsWith(`${command} && `)
      ) {
        errors.push("changed-gate");
        continue;
      }
      const suffix = value.slice(command.length + 4).split(" && ");
      if (
        !suffix.every((part) => {
          const match = /^pnpm run ([a-z][a-z0-9-]*:[a-z0-9:-]+)$/.exec(part);
          return (
            match?.[1] &&
            Object.hasOwn(after, match[1]) &&
            typeof after[match[1]] === "string" &&
            after[match[1]].trim()
          );
        })
      )
        errors.push("changed-gate");
    }
  }
  return [...new Set(errors)];
}

/** Read a reviewed Git ancestor and candidate inventory without displaying file content.
 * @param {string|undefined} requestedBase
 */
export function checkFloor(requestedBase) {
  /** Execute fixed Git argument vectors; errors invalidate the check. @param {string[]} args */
  const git = (args) =>
    execFileSync("git", args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  const base =
    requestedBase ?? git(["merge-base", "HEAD", "origin/main"]).trim();
  if (!/^[a-f0-9]{40}$/.test(base)) throw Error("invalid-base");
  git(["merge-base", "--is-ancestor", base, "HEAD"]);
  const paths = git(["ls-tree", "-r", "--name-only", "-z", base]).split("\0");
  /** @type {Record<string,string>} */
  const before = {};
  /** @type {Record<string,string>} */
  const after = {};
  const included = (/** @type {string} */ p) =>
    p === "package.json" || /^tests\/.*\.test\.(?:ts|mjs)$/.test(p);
  for (const name of paths.filter(included))
    before[name] = git(["show", `${base}:${name}`]);
  for (const name of new Set(
    git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
      .split("\0")
      .filter(included),
  )) {
    // A tracked deletion is compared as absent, but links are never followed.
    try {
      if (!lstatSync(name).isFile()) throw Error("unsupported-file");
      after[name] = readFileSync(name, "utf8");
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
  }
  return compareBaseline(before, after);
}

if (
  process.argv[1] === "-" ||
  (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
) {
  try {
    const errors = checkFloor(process.argv[2]);
    for (const error of errors)
      console.error(
        `verification-floor: ${error}; restore the baseline or request an explicit policy review.`,
      );
    if (errors.length) process.exitCode = 1;
    else console.log("Verification floor passed.");
  } catch {
    console.error(
      "verification-floor: missing/invalid ancestor or unreadable inputs; fetch origin main and inspect privately.",
    );
    process.exitCode = 1;
  }
}
