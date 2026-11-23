import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript-ast";

/** Read a literal AOT metadata field without evaluating the bundle.
 * @param {ts.ObjectLiteralExpression} object
 * @param {string} name
 */
function field(object, name) {
  let initializer;
  for (const property of object.properties) {
    if (
      ts.isSpreadAssignment(property) ||
      ts.isComputedPropertyName(property.name)
    ) {
      throw new Error("Unsupported Angular AOT component metadata.");
    }
    if (
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === name
    ) {
      if (initializer || !ts.isPropertyAssignment(property)) {
        throw new Error("Unsupported Angular AOT component metadata.");
      }
      initializer = property.initializer;
    }
  }
  return initializer;
}

/** Match the local templates and constant arrays emitted by the pinned optimizer.
 * @param {ts.Statement} statement Wrapper statement before the return.
 */
function isOptimizerDeclaration(statement) {
  return (
    ts.isFunctionDeclaration(statement) ||
    (ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.every(
        ({ name, initializer }) =>
          ts.isIdentifier(name) &&
          initializer &&
          ts.isArrayLiteralExpression(initializer),
      ))
  );
}

/** Read a direct definition or the optimizer's zero-argument declaration wrapper.
 * @param {ts.Expression | undefined} initializer Component definition initializer.
 * @returns {ts.ObjectLiteralExpression} AOT metadata read without executing code.
 */
function componentMetadata(initializer) {
  let definition = initializer;
  if (
    definition &&
    ts.isCallExpression(definition) &&
    ts.isParenthesizedExpression(definition.expression) &&
    ts.isFunctionExpression(definition.expression.expression)
  ) {
    const wrapper = definition.expression.expression;
    const statements = wrapper.body.statements;
    const result = statements.at(-1);
    if (
      definition.arguments.length ||
      wrapper.parameters.length ||
      wrapper.asteriskToken ||
      wrapper.modifiers?.length ||
      !result ||
      !ts.isReturnStatement(result) ||
      !statements.slice(0, -1).every(isOptimizerDeclaration)
    ) {
      throw new Error("Unsupported Angular AOT component wrapper.");
    }
    definition = result.expression;
  }

  if (
    !definition ||
    !ts.isCallExpression(definition) ||
    definition.questionDotToken ||
    definition.arguments.length !== 1
  ) {
    throw new Error("Unsupported Angular AOT component definition.");
  }
  const callee = definition.expression;
  const metadata = definition.arguments[0];
  if (
    !(
      ts.isIdentifier(callee) ||
      (ts.isPropertyAccessExpression(callee) &&
        !callee.questionDotToken &&
        ts.isIdentifier(callee.expression))
    ) ||
    !metadata ||
    !ts.isObjectLiteralExpression(metadata)
  ) {
    throw new Error("Unsupported Angular AOT component definition.");
  }
  return metadata;
}

/** Hash the exact decoded CSS strings in Angular's pinned AOT output.
 * @param {Iterable<string>} chunks Compiled browser JavaScript, including lazy chunks.
 */
export function componentStyleHashes(chunks) {
  const hashes = new Set();
  for (const chunk of chunks) {
    const source = ts.createSourceFile(
      "chunk.js",
      chunk,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );

    /** Visit AOT component definitions and fail closed if CSS needs runtime rewriting.
     * @param {ts.Node} node
     */
    function visit(node) {
      if (
        ts.isPropertyDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "ɵcmp"
      ) {
        const metadata = componentMetadata(node.initializer);
        const styles = field(metadata, "styles");
        if (styles) {
          const encapsulation = field(metadata, "encapsulation");
          // The pinned Angular renderer passes None (2) styles through except for %NS%.
          if (
            !encapsulation ||
            !ts.isNumericLiteral(encapsulation) ||
            encapsulation.text !== "2" ||
            !ts.isArrayLiteralExpression(styles)
          ) {
            throw new Error(
              "Expected literal styles with ViewEncapsulation.None.",
            );
          }
          for (const style of styles.elements) {
            if (
              !ts.isStringLiteralLike(style) ||
              style.text.includes("%COMP%")
            ) {
              throw new Error(
                "Unsupported runtime transformation in Angular CSS.",
              );
            }
            const css = style.text.replaceAll("%NS%", "");
            const digest = createHash("sha256")
              .update(css, "utf8")
              .digest("base64");
            hashes.add(`'sha256-${digest}'`);
          }
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(source);
  }
  if (!hashes.size) {
    throw new Error("No compiled Angular component styles found.");
  }
  return [...hashes].sort();
}

/** Extend only the tracked style-src directive and keep the Pages line within its limit.
 * @param {string} template Tracked Cloudflare Pages header rules.
 * @param {Iterable<string>} chunks Compiled chunks from the same build.
 */
export function renderStyleHeaders(template, chunks) {
  const original = "style-src 'self';";
  if (template.split(original).length !== 2) {
    throw new Error("Expected one style-src template directive.");
  }
  const hashes = componentStyleHashes(chunks);
  const output = template.replace(
    original,
    `style-src 'self' ${hashes.join(" ")};`,
  );
  if (output.split("\n").some((line) => line.length > 2_000)) {
    throw new Error(
      "Generated CSP exceeds the Cloudflare Pages header line limit.",
    );
  }
  return output;
}

/** Generate the published header rules from the browser build without changing its assets. */
function writeStyleHeaders() {
  const ui = fileURLToPath(new URL("../ui/", import.meta.url));
  const directory = resolve(ui, "dist/history/browser");
  const chunks = readdirSync(directory, {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"));
  const template = readFileSync(resolve(ui, "public/_headers"), "utf8");
  writeFileSync(
    resolve(directory, "_headers"),
    renderStyleHeaders(template, chunks),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  writeStyleHeaders();
}
