import assert from "node:assert/strict";
import { test } from "node:test";
import { compareBaseline } from "../tools/floor.mjs";

test("floor preserves test-name multiplicity, allowing moves but rejecting removals", () => {
  const base = { "tests/a.test.ts": 'test("one",()=>{});test("one",()=>{});' };
  assert.deepEqual(
    compareBaseline(base, { "tests/b.test.ts": base["tests/a.test.ts"] }),
    [],
  );
  assert.ok(
    compareBaseline(base, {
      "tests/a.test.ts": 'test("one",()=>{});',
    }).includes("removed-test"),
  );
});
test("floor rejects weakened commands but permits bounded additive named checks", () => {
  const base = {
    "package.json": JSON.stringify({ scripts: { lint: "biome check src" } }),
  };
  const candidate = (/** @type {Record<string,string>} */ scripts) => ({
    "package.json": JSON.stringify({ scripts }),
  });
  assert.deepEqual(
    compareBaseline(
      base,
      candidate({
        lint: "biome check src && pnpm run lint:extra",
        "lint:extra": "node tools/extra.mjs",
      }),
    ),
    [],
  );
  for (const lint of [
    "true",
    "biome check src || true",
    "biome check src && echo ok",
    "biome check src && pnpm run lint:missing",
  ])
    assert.ok(
      compareBaseline(base, candidate({ lint })).includes("changed-gate"),
    );
});
