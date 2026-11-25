import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript-ast";

/** Closed runtime owners; adding a module requires an explicit policy review. */
const runtimePackages = {
  "src/http/empty-control.ts": [],
  "src/application/retry/contract.ts": ["effect"],
  "src/application/retry/continuation.ts": ["effect"],
  "src/application/retry/api.ts": ["node:crypto"],
  "src/application/retry/index.ts": [],
  "src/application/retry/runtime.ts": ["node:crypto", "oci-common"],
  "src/application/retry/reconciliation.ts": ["node:crypto"],
  "src/application/retry/observation.ts": [],
  "src/providers/oci/retry-observation.ts": ["effect"],
  "src/application/history/contract.ts": ["effect"],
  "src/application/inventory/contract.ts": ["effect"],
  "src/application/inventory/api.ts": ["node:crypto"],
  "src/application/inventory/index.ts": [],
  "src/application/retained-trial-ledger/sql.ts": [],
  "src/application/retained-trial-ledger/history.ts": ["pg"],
  "src/application/retained-trial-ledger/inventory.ts": ["pg"],
  "src/application/retained-trial-ledger/retry.ts": ["pg"],
  "src/application/history/api.ts": ["node:crypto"],
  "src/application/history/runtime.ts": [],
  "src/application/history/index.ts": [],
  "src/trial/live-admission.ts": ["node:crypto"],
  "src/providers/oci/readiness.ts": ["oci-common"],
  "src/storage/postgres/runtime-access.ts": [],
  "src/trial/live-index.ts": [],
  "src/trial/live-environment.ts": ["node:crypto"],
  "src/trial/live-hosted.ts": ["node:crypto"],
  "src/trial/live-runtime.ts": ["node:crypto", "oci-common", "pg"],
  "src/providers/oci/usage.ts": ["oci-common"],
  "src/trial/warnings.ts": [],
  "src/trial/executor-api.ts": [],
  "src/trial/executor-hosted.ts": ["node:crypto", "pg"],
  "src/trial/executor-synthetic.ts": [],
  "src/trial/scheduled.ts": ["node:crypto"],
  "src/trial/executor.ts": ["node:crypto"],
  "src/trial/executor-store.ts": ["alchemy"],
  "src/trial/executor-resources.ts": ["alchemy", "effect"],
  "src/trial/api.ts": ["node:crypto"],
  "src/trial/preflight.ts": [],
  "src/providers/oci/trial-object.ts": ["node:crypto", "node:stream"],
  "src/providers/oci/bucket.ts": ["alchemy", "effect"],
  "src/providers/oci/client.ts": ["oci-common", "oci-objectstorage"],
  "src/trial/ledger.ts": [],
  "src/trial/checkpoint-index.ts": ["node:crypto", "pg"],
  "src/trial/checkpoint-handler.ts": ["node:crypto"],
  "src/trial/checkpoint-run.ts": ["node:crypto", "effect"],
  "src/trial/fenced-lifecycle.ts": ["alchemy", "effect"],
  "src/trial/fenced-state.ts": ["alchemy", "effect"],
  "src/trial/state-probe.ts": ["node:crypto", "alchemy", "effect"],
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

/** Application imports are explicit, including type-only dependencies across its capability interfaces. */
const applicationImports = /** @type {Record<string, readonly string[]>} */ ({
  "src/application/retry/index.ts": [
    "src/application/retry/api.ts",
    "src/application/retry/runtime.ts",
  ],
  "src/application/retry/api.ts": [
    "src/application/retry/continuation.ts",
    "src/http/empty-control.ts",
    "src/application/retry/contract.ts",
  ],
  "src/application/retry/continuation.ts": [
    "src/application/retry/contract.ts",
  ],
  "src/application/retry/contract.ts": ["src/application/retry/observation.ts"],
  "src/providers/oci/retry-observation.ts": [
    "src/application/retry/observation.ts",
  ],
  "src/application/retry/runtime.ts": [
    "src/application/retry/continuation.ts",
    "src/application/retry/contract.ts",
    "src/application/retry/reconciliation.ts",
    "src/application/retry/observation.ts",
    "src/providers/oci/retry-observation.ts",
    "src/application/retained-trial-ledger/retry.ts",
  ],
  "src/application/retry/reconciliation.ts": [
    "src/application/retry/contract.ts",
    "src/application/retry/observation.ts",
  ],
  "src/application/history/index.ts": [
    "src/application/history/api.ts",
    "src/application/history/runtime.ts",
  ],
  "src/application/history/api.ts": ["src/application/history/contract.ts"],
  "src/application/history/runtime.ts": [
    "src/application/history/contract.ts",
    "src/application/retained-trial-ledger/history.ts",
  ],
  "src/application/inventory/api.ts": ["src/application/inventory/contract.ts"],
  "src/application/inventory/index.ts": [
    "src/application/inventory/api.ts",
    "src/application/retained-trial-ledger/inventory.ts",
  ],
  "src/application/retained-trial-ledger/history.ts": [
    "src/application/history/contract.ts",
    "src/application/retained-trial-ledger/sql.ts",
    "src/storage/postgres/runtime-access.ts",
  ],
  "src/application/retained-trial-ledger/inventory.ts": [
    "src/application/inventory/contract.ts",
    "src/application/retained-trial-ledger/sql.ts",
  ],
  "src/application/retained-trial-ledger/retry.ts": [
    "src/application/retry/continuation.ts",
    "src/application/retry/contract.ts",
    "src/application/retained-trial-ledger/sql.ts",
  ],
});

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

const webSource = /^ui\/(?:src|edge|functions)\//;
const serverSource =
  /^(?:(?:src|scripts|tools|ui\/(?:edge|functions))(?:\/|$)|neon(?:\.[jt]s)?$)/;
const declarationFile = /\.d\.[cm]?ts$/;
const angularFeaturePath = /^ui\/src\/(?<owner>[^/]+)\/(?<module>.+)$/;
const angularPrivateLayer =
  /(?:^(?:state|data-access)\/|(?:^|\/|-)(?:store|data-access|reader)(?:\.d)?(?:\.(?:[cm]?[jt]s|tsx|jsx))?$)/;
const angularCompositionRoots = new Set(["ui/src/app.ts", "ui/src/main.ts"]);

/** Identify ESM forwarding and direct exports of private imports.
 * @param {ts.SourceFile} source
 * @param {ts.Node} node
 */
function exportsAngularDependency(source, node) {
  if (ts.isExportDeclaration(node)) return true;
  if (ts.isImportTypeNode(node) || ts.isCallExpression(node)) {
    const parent = node.parent;
    if (ts.isExportAssignment(parent)) return true;
    const declaration = ts.isVariableDeclaration(parent)
      ? parent.parent.parent
      : parent;
    return (
      (ts.isVariableStatement(declaration) ||
        ts.isTypeAliasDeclaration(declaration)) &&
      !!ts
        .getModifiers(declaration)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    );
  }
  if (!ts.isImportDeclaration(node) || !node.importClause) return false;

  const { name, namedBindings } = node.importClause;
  const names = new Set(name ? [name.text] : []);
  if (namedBindings) {
    if (ts.isNamespaceImport(namedBindings)) names.add(namedBindings.name.text);
    else
      for (const binding of namedBindings.elements)
        names.add(binding.name.text);
  }

  return source.statements.some((statement) => {
    if (
      ts.isExportAssignment(statement) &&
      ts.isIdentifier(statement.expression)
    )
      return names.has(statement.expression.text);
    if (
      ts.isVariableStatement(statement) &&
      ts
        .getModifiers(statement)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    )
      return statement.declarationList.declarations.some(
        ({ initializer }) =>
          initializer &&
          ts.isIdentifier(initializer) &&
          names.has(initializer.text),
      );
    if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    )
      return statement.exportClause.elements.some((binding) =>
        names.has((binding.propertyName ?? binding.name).text),
      );
    return false;
  });
}

/** Browser TypeScript erases empty named bindings and bindings with only inline types.
 * @param {ts.Node | undefined} bindings
 */
function webTypeOnlyBindings(bindings) {
  return (
    !!bindings &&
    (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

/** Check owned source text without executing it. Erased type references still obey boundaries.
 * Documentation proves attached prose, not its accuracy; aliasing and runtime effects need review.
 * @param {Record<string,string>} files
 * @param {{requireTsExtensions?: boolean}} [options] Enforce source spelling for a repository scan.
 * @returns {{file:string,line:number,rule:string,message:string}[]}
 */
export function analyze(files, { requireTsExtensions = false } = {}) {
  /** @type {{file:string,line:number,rule:string,message:string}[]} */
  const errors = [];
  /** @type {Map<string,string[]>} */
  const graph = new Map();
  /** @type {ts.ModuleResolutionHost} */
  const webTypeResolutionHost = {
    fileExists: (name) => Object.hasOwn(files, name),
    readFile: (name) => files[name],
  };
  /** @type {ts.ModuleResolutionHost} */
  const webResolutionHost = {
    ...webTypeResolutionHost,
    fileExists: (name) =>
      Object.hasOwn(files, name) && !declarationFile.test(name),
  };
  for (const [file, text] of Object.entries(files)) {
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    if (
      !source.isDeclarationFile &&
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
    const browser = file.startsWith("ui/src/");
    const feature = angularFeaturePath.exec(file)?.groups;
    const featureModule = feature?.module ?? "";
    const web = webSource.test(file);
    const browserTypeScript = browser && /\.(?:[cm]?ts|tsx)$/.test(file);
    const checkImportSpelling =
      requireTsExtensions &&
      file.endsWith(".ts") &&
      (production || file.startsWith("tests/"));
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
      if (!target || !ts.isStringLiteralLike(target)) {
        if (production || web)
          fail(
            node,
            "architecture",
            "Use a literal ESM import; dynamic targets cannot be checked.",
          );
        return;
      }
      const name = target.text;
      const relative = name.startsWith(".");
      const localPath = relative
        ? path.posix.join(path.posix.dirname(file), name.replaceAll("\\", "/"))
        : null;
      if (checkImportSpelling && relative && !name.endsWith(".ts"))
        fail(
          node,
          "import-extension",
          "Use the explicit .ts extension for local backend source imports.",
        );
      if (browser && localPath && serverSource.test(localPath))
        fail(
          node,
          "architecture",
          "Browser code must access server capabilities through the same-origin API.",
        );
      if (web && localPath) {
        const resolutionHost = typeOnly
          ? webTypeResolutionHost
          : webResolutionHost;
        const resolved = resolutionHost.fileExists(localPath)
          ? localPath
          : ts.resolveModuleName(
              name,
              file,
              {
                moduleResolution: ts.ModuleResolutionKind.Bundler,
                allowJs: true,
              },
              resolutionHost,
            ).resolvedModule?.resolvedFileName;
        if (browser) {
          const targetFeature = angularFeaturePath.exec(
            resolved ?? localPath,
          )?.groups;
          if (
            targetFeature?.module &&
            angularPrivateLayer.test(targetFeature.module)
          ) {
            if (featureModule.startsWith("components/"))
              fail(
                node,
                "ui-presentation",
                "Presentational components receive feature data through inputs and emit events through outputs.",
              );
            else if (
              (!angularPrivateLayer.test(featureModule) &&
                exportsAngularDependency(source, node)) ||
              (feature?.owner !== targetFeature.owner &&
                !angularCompositionRoots.has(file))
            )
              fail(
                node,
                "ui-feature",
                "Keep stores, readers and data access private to their feature and shell composition.",
              );
          }
        }
        if (
          resolved &&
          webSource.test(resolved) &&
          !typeOnly &&
          !source.isDeclarationFile
        )
          graph.get(file)?.push(resolved);
      }
      if (!production) return;
      if (relative) {
        const resolved = path.posix
          .join(path.posix.dirname(file), name)
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
            applicationImports[file]?.includes(resolved) ||
            (file === "src/trial/live-admission.ts" &&
              [
                "src/trial/api.ts",
                "src/trial/executor-store.ts",
                "src/trial/ledger.ts",
                "src/trial/live-environment.ts",
                "src/trial/preflight.ts",
              ].includes(resolved)) ||
            (file === "src/trial/live-index.ts" &&
              [
                "src/trial/live-hosted.ts",
                "src/trial/live-runtime.ts",
              ].includes(resolved)) ||
            (file === "src/trial/live-environment.ts" &&
              resolved === "src/storage/postgres/runtime-access.ts") ||
            (file === "src/trial/live-hosted.ts" &&
              [
                "src/http/empty-control.ts",
                "src/trial/live-environment.ts",
                "src/trial/scheduled.ts",
              ].includes(resolved)) ||
            (file === "src/trial/live-runtime.ts" &&
              [
                "src/trial/live-environment.ts",
                "src/trial/live-admission.ts",
                "src/providers/oci/readiness.ts",
                "src/trial/live-hosted.ts",
                "src/storage/postgres/runtime-access.ts",
                "src/trial/executor.ts",
                "src/trial/executor-store.ts",
                "src/trial/ledger.ts",
                "src/trial/warnings.ts",
                "src/providers/oci/client.ts",
                "src/providers/oci/usage.ts",
              ].includes(resolved)) ||
            (file === "src/trial/warnings.ts" &&
              ["src/trial/ledger.ts", "src/providers/oci/usage.ts"].includes(
                resolved,
              )) ||
            (file === "src/trial/executor-api.ts" &&
              [
                "src/trial/api.ts",
                "src/trial/warnings.ts",
                "src/trial/ledger.ts",
                "src/trial/executor-store.ts",
              ].includes(resolved)) ||
            (file === "src/trial/executor-hosted.ts" &&
              [
                "src/trial/executor.ts",
                "src/trial/executor-store.ts",
                "src/trial/executor-synthetic.ts",
                "src/storage/postgres/runtime-access.ts",
                "src/trial/scheduled.ts",
              ].includes(resolved)) ||
            (file === "src/trial/executor-synthetic.ts" &&
              [
                "src/providers/oci/client.ts",
                "src/providers/oci/trial-object.ts",
              ].includes(resolved)) ||
            (file === "src/trial/executor.ts" &&
              [
                "src/trial/warnings.ts",
                "src/providers/oci/usage.ts",
                "src/trial/ledger.ts",
                "src/trial/executor-store.ts",
                "src/trial/executor-resources.ts",
                "src/providers/oci/bucket.ts",
                "src/providers/oci/client.ts",
                "src/providers/oci/trial-object.ts",
              ].includes(resolved)) ||
            (file === "src/trial/executor-store.ts" &&
              [
                "src/trial/ledger.ts",
                "src/providers/oci/bucket.ts",
                "src/providers/oci/trial-object.ts",
              ].includes(resolved)) ||
            (file === "src/trial/executor-resources.ts" &&
              [
                "src/trial/ledger.ts",
                "src/trial/executor-store.ts",
                "src/providers/oci/bucket.ts",
                "src/providers/oci/client.ts",
              ].includes(resolved)) ||
            (file === "src/trial/api.ts" &&
              ["src/trial/preflight.ts", "src/trial/ledger.ts"].includes(
                resolved,
              )) ||
            (file === "src/providers/oci/trial-object.ts" &&
              [
                "src/providers/oci/client.ts",
                "src/providers/oci/bucket.ts",
              ].includes(resolved)) ||
            (file === "src/providers/oci/bucket.ts" &&
              resolved === "src/providers/oci/client.ts") ||
            (file === "src/trial/checkpoint-index.ts" &&
              [
                "src/trial/checkpoint-handler.ts",
                "src/trial/checkpoint-run.ts",
              ].includes(resolved)) ||
            (file === "src/trial/checkpoint-run.ts" &&
              [
                "src/trial/fenced-state.ts",
                "src/trial/fenced-lifecycle.ts",
              ].includes(resolved)) ||
            (file === "src/trial/index.ts" &&
              [
                "src/trial/runtime-probe.ts",
                "src/trial/synthetic-lifecycle.ts",
              ].includes(resolved))
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
            resolved === "src/trial/deployment.ts" ||
            (file === "scripts/history-server.ts" &&
              [
                "src/application/history/api.ts",
                "src/application/history/runtime.ts",
              ].includes(resolved))
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
      if (
        file.startsWith("src/application/") &&
        !file.startsWith("src/application/retained-trial-ledger/") &&
        (ts.isStringLiteralLike(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)) &&
        /\bberth_[a-z0-9_]+"?\s*\./i.test(node.text)
      )
        fail(
          node,
          "architecture",
          "Access retained trial SQL through the named adapter.",
        );
      // verbatimModuleSyntax keeps inline-only type imports as empty runtime imports.
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        dependency(
          node,
          node.moduleSpecifier,
          !!clause?.isTypeOnly ||
            (browserTypeScript &&
              !clause?.name &&
              webTypeOnlyBindings(clause?.namedBindings)),
        );
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier)
        dependency(
          node,
          node.moduleSpecifier,
          node.isTypeOnly ||
            (browserTypeScript && webTypeOnlyBindings(node.exportClause)),
        );
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
          (production || web) &&
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
    if (
      /^(?:src|scripts|tests|tools)\/.*\.(?:ts|mjs)$|^neon\.ts$/.test(name) ||
      (webSource.test(name) && /\.(?:[cm]?[jt]s|tsx|jsx)$/.test(name))
    ) {
      if (privatePath(name) || !lstatSync(name).isFile())
        throw Error(
          "source-inventory: private or unsupported source entry; inspect locally.",
        );
      files[name] = readFileSync(name, "utf8");
    }
  return analyze(files, { requireTsExtensions: true });
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
