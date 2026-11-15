import assert from "node:assert/strict";
import test from "node:test";
import { ESLint } from "eslint";

const adjacent = `function first(): void {}
/** Keep this documentation attached to second. */
export async function second(): Promise<void> {}
const value = 1;
`;
const padded = `function first(): void {}

/** Keep this documentation attached to second. */
export async function second(): Promise<void> {}

const value = 1;
`;

test("spacing gate rejects adjacent declarations and fixes before documentation", async () => {
  const lint = new ESLint();
  const [result] = await lint.lintText(adjacent, {
    filePath: "scripts/fixture.ts",
  });
  assert.ok(result);
  assert.equal(result.errorCount, 2);
  assert.ok(
    result.messages.every(
      (message) =>
        message.ruleId === "@stylistic/padding-line-between-statements",
    ),
  );
  const [fixed] = await new ESLint({ fix: true }).lintText(adjacent, {
    filePath: "scripts/fixture.ts",
  });
  assert.equal(fixed?.output, padded);
});

test("spacing gate accepts padded functions and leaves fixture strings untouched", async () => {
  const source = `${padded}\nconst fixture = ${JSON.stringify(adjacent)};\n`;
  const [result] = await new ESLint({ fix: true }).lintText(source, {
    filePath: "tests/fixture.ts",
  });
  assert.equal(result?.errorCount, 0);
  assert.equal(result?.output, undefined);
});

test("spacing gate covers default exports and JavaScript harness declarations", async () => {
  const lint = new ESLint();
  for (const filePath of ["src/fixture.ts", "tools/fixture.mjs"]) {
    const [result] = await lint.lintText(
      "const value = 1;\n/** Public contract. */\nexport default function main() {}\nconst next = 2;\n",
      { filePath },
    );
    assert.equal(result?.errorCount, 2);
    assert.ok(
      result?.messages.every(
        (message) =>
          message.ruleId === "@stylistic/padding-line-between-statements",
      ),
    );
  }
});
