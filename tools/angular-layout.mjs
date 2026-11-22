import { statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import ts from "typescript-ast";

/** Keep Angular component files together and constrain how Angular renders the CSS. */
export const componentFiles = {
  meta: { schema: [] },
  /** Register a layout check for Angular components imported by the file.
   * @param {import("eslint").Rule.RuleContext} context
   */
  create(context) {
    return {
      /** Read component metadata and sibling paths without loading application code. */
      Program() {
        const file = ts.createSourceFile(
          context.filename,
          context.sourceCode.text,
          ts.ScriptTarget.Latest,
          true,
        );
        const imports = new Set();
        for (const statement of file.statements) {
          if (
            !ts.isImportDeclaration(statement) ||
            !ts.isStringLiteral(statement.moduleSpecifier) ||
            statement.moduleSpecifier.text !== "@angular/core"
          ) {
            continue;
          }
          const bindings = statement.importClause?.namedBindings;
          if (bindings && ts.isNamespaceImport(bindings)) {
            imports.add(`${bindings.name.text}.Component`);
          } else if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
              if ((element.propertyName ?? element.name).text === "Component") {
                imports.add(element.name.text);
              }
            }
          }
        }

        for (const statement of file.statements) {
          if (!ts.isClassDeclaration(statement)) continue;
          for (const decorator of ts.getDecorators(statement) ?? []) {
            const call = decorator.expression;
            if (
              !ts.isCallExpression(call) ||
              !imports.has(call.expression.getText(file).replace(/\s/g, ""))
            ) {
              continue;
            }
            const name = basename(context.filename, ".ts");
            const expectedName = statement.name?.text
              .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
              .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
              .toLowerCase();
            const metadata = call.arguments[0];
            const properties =
              metadata && ts.isObjectLiteralExpression(metadata)
                ? metadata.properties.filter(ts.isPropertyAssignment)
                : [];
            /** Resolve a quoted or unquoted metadata property without evaluating it. */
            const propertyName = (
              /** @type {ts.PropertyAssignment} */ property,
            ) =>
              ts.isIdentifier(property.name) ||
              ts.isStringLiteral(property.name)
                ? property.name.text
                : undefined;
            const template = properties.find(
              (property) => propertyName(property) === "templateUrl",
            )?.initializer;
            const style = properties.find(
              (property) => propertyName(property) === "styleUrl",
            )?.initializer;
            const encapsulation = properties.find(
              (property) => propertyName(property) === "encapsulation",
            )?.initializer;
            const inline = properties.some((property) =>
              /^(template|styles|styleUrls)$/.test(
                propertyName(property) ?? "",
              ),
            );
            /** Check that the matched file exists beside the component source. */
            const hasSibling = (/** @type {string} */ extension) =>
              statSync(
                resolve(dirname(context.filename), `${name}.${extension}`),
                {
                  throwIfNoEntry: false,
                },
              )?.isFile();
            if (
              name !== expectedName ||
              !template ||
              !ts.isStringLiteralLike(template) ||
              template.text !== `./${name}.html` ||
              !style ||
              !ts.isStringLiteralLike(style) ||
              style.text !== `./${name}.css` ||
              encapsulation?.getText(file) !== "ViewEncapsulation.None" ||
              inline ||
              !hasSibling("html") ||
              !hasSibling("css")
            ) {
              const { line, character } = file.getLineAndCharacterOfPosition(
                decorator.getStart(file),
              );
              context.report({
                loc: { line: line + 1, column: character },
                message:
                  "Use matching component class and file basenames, relative templateUrl and styleUrl, and ViewEncapsulation.None for CSP hashes.",
              });
            }
          }
        }
      },
    };
  },
};
