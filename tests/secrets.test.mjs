import assert from "node:assert/strict";
import { test } from "node:test";
import { scanResult } from "../tools/secrets.mjs";

test("secret scan fails closed without disclosing finding text", () => {
  assert.equal(scanResult({ status: 0, stdout: "[]" }), "clean");
  assert.equal(
    scanResult({ status: 42, stdout: '[{"Secret":"never-print"}]' }),
    "secret-finding",
  );
  for (const value of [
    { status: 0, stdout: '[{"Secret":"never-print"}]' },
    { status: 42, stdout: "[]" },
    { status: 0, stdout: "not-json" },
    { status: 1, stdout: "[]" },
    { status: null, stdout: "[]" },
  ])
    assert.equal(scanResult(value), "scanner-error");
});
