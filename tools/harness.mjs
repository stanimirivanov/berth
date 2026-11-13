import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript-ast";

/** Closed runtime owners; adding a module requires an explicit policy review. */
const runtimePackages = {
  "src/trial/runtime-probe.ts": ["node:crypto", "node:timers/promises"],
  "src/trial/deployment.ts": [],
  "src/trial/synthetic-lifecycle.ts": ["alchemy", "effect"],
  "src/trial/index.ts": [
    "node:crypto",
    "oci-common",
    "oci-objectstorage",
    "pg",
  ],
};

/** Reject private indexed paths before reading content; this is not a secret scanner.
 * @param {string} name
 */
export function privatePath(name) {
  return name
    .split("/")
    .some(
      (part) =>
        /^(?:private-|\.oci$|\.neon$|\.alchemy$)|\.(?:pem|key|p12|pfx)$/i.test(
          part,
        ) ||
        (/^\.env(?:\.|$)/i.test(part) && part !== ".env.example") ||
        /^(?:oci-admin|oci-trial|neon-runtime)\.json$/i.test(part),
    );
}

/** Check owned source text without executing it. Type-only edges still obey boundaries.
 * Documentation proves attached prose, not its accuracy; aliasing and runtime effects need review.
 * @param {Record<string,string>} files
 * @returns {{file:string,line:number,rule:string,message:string}[]}
 */
export function analyze(files) {
  /** @type {{file:string,line:number,rule:string,message:string}[]} */
  const errors = [];
  /** @type {Map<string,string[]>} */
  const graph = new Map();
  for (const [file, text] of Object.entries(files)) {
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS,
    );
    if (
      ts
        .transpileModule(text, {
          fileName: file,
          reportDiagnostics: true,
          compilerOptions: {
            target: ts.ScriptTarget.ESNext,
            module: ts.ModuleKind.ESNext,
          },
        })
        .diagnostics?.some((d) => d.category === ts.DiagnosticCategory.Error)
    ) {
      errors.push({
        file,
        line: 1,
        rule: "syntax",
        message:
          "Source could not be parsed by the pinned sensor; fix syntax or review parser compatibility.",
      });
      continue;
    }
    const document =
      file.startsWith("src/") ||
      file.startsWith("tools/") ||
      file === "neon.ts";
    const production =
      file.startsWith("src/") ||
      file.startsWith("scripts/") ||
      file === "neon.ts";
    /** Report a location and fixed corrective message, never source contents.
     * @param {ts.Node} node @param {string} rule @param {string} message
     */
    const fail = (node, rule, message) =>
      errors.push({
        file,
        line:
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        rule,
        message,
      });
    if (file.startsWith("src/") && !(file in runtimePackages))
      fail(
        source,
        "architecture",
        "Register the new runtime owner and its allowed imports with tests.",
      );
    graph.set(file, []);
    /** Resolve reviewed module forms; unsupported dynamic targets fail closed.
     * @param {ts.Node} node @param {ts.Node|undefined} target @param {boolean} typeOnly
     */
    function dependency(node, target, typeOnly) {
      if (!production) return;
      if (!target || !ts.isStringLiteralLike(target)) {
        fail(
          node,
          "architecture",
          "Use a literal ESM import; dynamic targets cannot be checked.",
        );
        return;
      }
      const name = target.text;
      if (name.startsWith(".")) {
        const resolved = path.posix
          .normalize(path.posix.join(path.posix.dirname(file), name))
          .replace(/\.js$/, ".ts");
        if (!(resolved in files))
          fail(
            node,
            "architecture",
            "Resolve the import to an owned source module.",
          );
        if (
          file.startsWith("src/") &&
          !(
            file === "src/trial/index.ts" &&
            [
              "src/trial/runtime-probe.ts",
              "src/trial/synthetic-lifecycle.ts",
            ].includes(resolved)
          )
        )
          fail(
            node,
            "architecture",
            "Only the hosted composition root may import the handler and synthetic engine; never import admin tooling.",
          );
        if (
          file.startsWith("scripts/") &&
          !(
            resolved.startsWith("scripts/") ||
            resolved === "neon.ts" ||
            resolved === "src/trial/deployment.ts"
          )
        )
          fail(
            node,
            "architecture",
            "Scripts may compose scripts, deployment configuration and the environment allowlist only.",
          );
        if (!typeOnly) graph.get(file)?.push(resolved);
      } else if (file.startsWith("src/")) {
        const allowed =
          runtimePackages[/** @type {keyof typeof runtimePackages} */ (file)] ??
          [];
        if (
          !allowed.some(
            (pkg) =>
              name === pkg ||
              (!pkg.startsWith("node:") && name.startsWith(`${pkg}/`)),
          )
        )
          fail(
            node,
            "architecture",
            "Import is outside this runtime owner’s reviewed package allowlist.",
          );
      }
    }
    /** Visit declaration contracts, import forms and disabled-test syntax.
     * @param {ts.Node} node
     */
    function visit(node) {
      if (ts.isImportDeclaration(node))
        dependency(
          node,
          node.moduleSpecifier,
          Boolean(
            node.importClause?.isTypeOnly ||
              (node.importClause?.namedBindings &&
                ts.isNamedImports(node.importClause.namedBindings) &&
                !node.importClause.name &&
                node.importClause.namedBindings.elements.length > 0 &&
                node.importClause.namedBindings.elements.every(
                  (x) => x.isTypeOnly,
                )),
          ),
        );
      if (ts.isExportDeclaration(node) && node.moduleSpecifier)
        dependency(node, node.moduleSpecifier, node.isTypeOnly);
      if (ts.isImportTypeNode(node))
        dependency(
          node,
          ts.isLiteralTypeNode(node.argument)
            ? node.argument.literal
            : undefined,
          true,
        );
      if (ts.isImportEqualsDeclaration(node))
        fail(
          node,
          "architecture",
          "Use ESM imports instead of CommonJS import assignments.",
        );
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
          dependency(node, node.arguments[0], false);
        if (
          production &&
          ts.isIdentifier(node.expression) &&
          ["require", "createRequire"].includes(node.expression.text)
        )
          fail(
            node,
            "architecture",
            "CommonJS loaders bypass the import graph; use ESM imports.",
          );
        if (
          file.startsWith("tests/") &&
          ["skip", "only", "todo"].includes(
            ts.isPropertyAccessExpression(node.expression)
              ? node.expression.name.text
              : ts.isElementAccessExpression(node.expression) &&
                  ts.isStringLiteralLike(node.expression.argumentExpression)
                ? node.expression.argumentExpression.text
                : "",
          )
        )
          fail(
            node,
            "quality",
            "Remove disabled/focused tests; fix the failing behavior.",
          );
      }
      if (
        file.startsWith("tests/") &&
        ts.isPropertyAssignment(node) &&
        ["skip", "only", "todo"].includes(
          ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)
            ? node.name.text
            : "",
        ) &&
        node.initializer.kind !== ts.SyntaxKind.FalseKeyword
      )
        fail(
          node,
          "quality",
          "Test skip/focus options cannot disable verification.",
        );
      if (document) {
        const exported =
          ts.canHaveModifiers(node) &&
          ts
            .getModifiers(node)
            ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        const lines =
          source.getLineAndCharacterOfPosition(node.end).line -
          source.getLineAndCharacterOfPosition(node.getStart(source)).line +
          1;
        const contract =
          ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isExportAssignment(node) ||
          (ts.isVariableStatement(node) && exported) ||
          (ts.isFunctionDeclaration(node) && (exported || lines >= 6)) ||
          ts.isMethodDeclaration(node) ||
          ts.isGetAccessorDeclaration(node) ||
          ts.isSetAccessorDeclaration(node) ||
          (ts.isConstructorDeclaration(node) && lines >= 6) ||
          (ts.isVariableDeclaration(node) &&
            node.initializer &&
            (ts.isArrowFunction(node.initializer) ||
              ts.isFunctionExpression(node.initializer)) &&
            lines >= 6);
        if (contract) {
          const anchor =
            ts.isVariableDeclaration(node) &&
            ts.isVariableDeclarationList(node.parent) &&
            ts.isVariableStatement(node.parent.parent)
              ? node.parent.parent
              : node;
          const prose = ts
            .getJSDocCommentsAndTags(anchor)
            .some(
              (doc) =>
                ts.isJSDoc(doc) &&
                (typeof doc.comment === "string"
                  ? doc.comment.trim()
                  : doc.comment?.some((p) => p.text.trim())),
            );
          if (!prose)
            fail(
              anchor,
              "documentation",
              "Add attached JSDoc/TSDoc prose explaining purpose, bounds, effects and failures where relevant.",
            );
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    const seenComments = new Set();
    /** Inspect parser-aligned trivia, including closing tokens, without rescanning template text.
     * @param {ts.Node} node
     */
    function comments(node) {
      const ranges = [
        ...(ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []),
        ...(ts.getTrailingCommentRanges(text, node.end) ?? []),
      ];
      for (const range of ranges) {
        if (seenComments.has(range.pos)) continue;
        seenComments.add(range.pos);
        if (
          /@ts-(?:ignore|nocheck|expect-error)|biome-ignore|eslint-disable|(?:istanbul|c8|v8|node:coverage)\s+(?:ignore|disable)/.test(
            text.slice(range.pos, range.end),
          )
        ) {
          errors.push({
            file,
            line: source.getLineAndCharacterOfPosition(range.pos).line + 1,
            rule: "quality",
            message:
              "Remove suppression directives; fix the cause or propose a reviewed policy change.",
          });
        }
      }
      for (const child of node.getChildren(source)) comments(child);
    }
    comments(source);
  }
  const active = new Set();
  const done = new Set();
  /** Follow runtime edges only; an active-path revisit is a dependency cycle.
   * @param {string} file
   */
  function walk(file) {
    if (active.has(file)) {
      errors.push({
        file,
        line: 1,
        rule: "cycle",
        message:
          "Break the runtime import cycle by moving the shared contract.",
      });
      return;
    }
    if (done.has(file)) return;
    active.add(file);
    for (const next of graph.get(file) ?? []) walk(next);
    active.delete(file);
    done.add(file);
  }
  for (const file of graph.keys()) walk(file);
  return errors;
}

/** Read only owned, nonprivate repository files; unsupported entries fail rather than following links. */
export function checkRepository() {
  const indexed = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  if (indexed.some(privatePath))
    throw Error(
      "private-index: remove private material from the index; do not print its contents.",
    );
  const names = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8" },
  ).split("\0");
  /** @type {Record<string,string>} */
  const files = {};
  for (const name of new Set(names))
    if (/^(?:src|scripts|tests|tools)\/.*\.(?:ts|mjs)$|^neon\.ts$/.test(name)) {
      if (privatePath(name) || !lstatSync(name).isFile())
        throw Error(
          "source-inventory: private or unsupported source entry; inspect locally.",
        );
      files[name] = readFileSync(name, "utf8");
    }
  return analyze(files);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const errors = checkRepository();
    for (const e of errors)
      console.error(`${e.file}:${e.line} [${e.rule}] ${e.message}`);
    if (errors.length) process.exitCode = 1;
    else console.log("Harness source checks passed.");
  } catch {
    console.error(
      "harness-input: unable to verify repository inputs; inspect paths and Git state privately.",
    );
    process.exitCode = 1;
  }
}
