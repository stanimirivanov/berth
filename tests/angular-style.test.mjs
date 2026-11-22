import assert from "node:assert/strict";
import test from "node:test";
import { ESLint } from "eslint";

const lint = new ESLint({ overrideConfigFile: "ui/eslint.angular.mjs" });

test("Angular lint rejects inline component files and selector conventions", async () => {
  const [result] = await lint.lintText(
    `import { Component as View } from "@angular/core";
@View({ selector: "app-example", template: "<p>Example</p>", styleUrl: "./app.css" })
export class Example {}`,
    { filePath: "ui/src/app.ts" },
  );
  assert.ok(result);
  assert.ok(
    result.messages.some(({ ruleId }) => ruleId === "berth/component-files"),
  );

  const [selector] = await lint.lintText(
    `import { Component } from "@angular/core";
@Component({ selector: "app-example", templateUrl: "./app.html" })
export class App {}`,
    { filePath: "ui/src/app.ts" },
  );
  assert.deepEqual(
    selector?.messages.map(({ ruleId }) => ruleId),
    ["@angular-eslint/component-selector"],
  );
});

test("Angular lint accepts the shell and rejects template type escapes", async () => {
  const [shell] = await lint.lintFiles("ui/src/app.ts");
  assert.equal(shell?.errorCount, 0);
  const [template] = await lint.lintText("<p>{{ $any(value) }}</p>", {
    filePath: "ui/src/app.html",
  });
  assert.deepEqual(
    template?.messages.map(({ ruleId }) => ruleId),
    ["@angular-eslint/template/no-any"],
  );
});

test("Angular lint checks component basenames and colocated files for namespace imports", async () => {
  const [result] = await lint.lintText(
    `import * as ng from "@angular/core";
@ng.Component({ selector: "berth-missing", templateUrl: "./missing.html" })
export class Missing {}`,
    { filePath: "ui/src/missing.ts" },
  );
  assert.deepEqual(
    result?.messages.map(({ ruleId }) => ruleId),
    ["berth/component-files"],
  );
});

test("UI TypeScript lint requires braces and one variable per declaration", async () => {
  const [result] = await new ESLint().lintText(
    "let left = 1, right = 2; if (left < right) right = 3;",
    { filePath: "ui/src/example.ts" },
  );
  assert.deepEqual(
    result?.messages.map(({ ruleId }) => ruleId),
    ["one-var", "curly"],
  );
});
