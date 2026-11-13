import assert from "node:assert/strict";
import { test } from "node:test";
import { analyze, privatePath } from "../tools/harness.mjs";

test("documentation gate requires prose on contracts and nontrivial helpers", () => {
  for (const text of [
    "export function x() {}",
    "export type X = string;",
    "interface X {}",
    "export const x = 1;",
    "class X {}",
    "/** @returns value */\nexport function x() {}",
    "function x(){\nlet a=0;\na++;\na++;\na++;\nreturn a;\n}",
  ]) {
    assert.ok(
      analyze({ "src/trial/runtime-probe.ts": text }).some(
        (x) => x.rule === "documentation",
      ),
      text,
    );
  }
  assert.deepEqual(
    analyze({
      "src/trial/runtime-probe.ts":
        "/** Authenticated entry; never performs provider work without admission. */\nexport function x() {}",
    }),
    [],
  );
});

test("architecture checks all module syntax and rejects runtime administrator access", () => {
  for (const text of [
    'import "../../scripts/oci-admin.js";',
    'export * from "../../scripts/oci-admin.js";',
    'type X = import("../../scripts/oci-admin.js").X;',
    'void import("../../scripts/oci-admin.js");',
    "void import(name);",
    'const fs = require("node:fs");',
    'import "node:fs";',
  ])
    assert.ok(
      analyze({ "src/trial/runtime-probe.ts": text }).some(
        (x) => x.rule === "architecture",
      ),
      text,
    );
  assert.ok(
    analyze({ "src/trial/unknown.ts": "" }).some(
      (x) => x.rule === "architecture",
    ),
  );
});

test("runtime cycles fail while type-only cycles do not", () => {
  const files = {
    "scripts/a.ts": 'import "./b.js";',
    "scripts/b.ts": 'import "./a.js";',
  };
  assert.ok(analyze(files).some((x) => x.rule === "cycle"));
  assert.ok(
    !analyze({
      "scripts/a.ts": 'import type {B} from "./b.js";',
      "scripts/b.ts": 'import type {A} from "./a.js";',
    }).some((x) => x.rule === "cycle"),
  );
});

test("quality sensor rejects disabled tests and real suppression comments, not fixture strings", () => {
  for (const text of [
    'test.skip("case",()=>{});',
    'test("case",{skip:true},()=>{});',
    'test.only("case",()=>{});',
    "// @ts-ignore\nconst x=1;",
  ])
    assert.ok(
      analyze({ "tests/a.test.ts": text }).some((x) => x.rule === "quality"),
    );
  assert.deepEqual(
    analyze({
      "tests/a.test.ts": 'const fixture="// @ts-ignore"; test("case",()=>{});',
    }),
    [],
  );
});

test("private indexed paths are blocked including nested and case variants", () => {
  for (const p of [
    ".env",
    ".env.local",
    "x/PRIVATE-input.json",
    "x/key.PEM",
    ".oci/config",
    "x/oci-admin.json",
    "x/neon-runtime.json",
  ])
    assert.equal(privatePath(p), true, p);
  for (const p of [
    "src/trial/runtime-probe.ts",
    ".env.example",
    "docs/oci-bootstrap.md",
  ])
    assert.equal(privatePath(p), false, p);
});

test("HTTP admission cannot reach the lifecycle adapter through a local import", () => {
  const errors = analyze({
    "src/trial/runtime-probe.ts": 'import "./synthetic-lifecycle.js";',
    "src/trial/synthetic-lifecycle.ts": "",
  });
  assert.ok(errors.some((error) => error.rule === "architecture"));
});

test("unsupported or malformed syntax fails instead of silently shrinking the inventory", () => {
  assert.ok(
    analyze({ "src/trial/deployment.ts": "export function broken( {" }).some(
      (error) => error.rule === "syntax",
    ),
  );
});

test("quality checks include literal bracket calls, quoted options and expected-error suppressions", () => {
  for (const text of [
    'test["skip"]("case",()=>{});',
    'test("case", {"only":true},()=>{});',
    "// @ts-expect-error\nconst x = 1;",
  ]) {
    assert.ok(
      analyze({ "tests/a.test.ts": text }).some(
        (error) => error.rule === "quality",
      ),
      text,
    );
  }
});

test("suppression detection distinguishes template text from actual comments after interpolation", () => {
  assert.ok(
    analyze({
      "tests/a.test.ts": `const x = \`foo \${1} bar\`;\n// @ts-ignore\nconst y=1;`,
    }).some((error) => error.rule === "quality"),
  );
  assert.deepEqual(
    analyze({ "tests/a.test.ts": `const x = \`foo \${1} // @ts-ignore\`;` }),
    [],
  );
});

test("state probe may use Alchemy HTTP state but cannot import administrator tooling", () => {
  assert.equal(
    analyze({
      "src/trial/state-probe.ts":
        "import { makeHttpStateStore } from 'alchemy/State/HttpStateStore';",
    }).length,
    0,
  );
  assert.ok(
    analyze({
      "src/trial/state-probe.ts":
        "import { readPrivateText } from '../../scripts/oci-files.js';",
      "scripts/oci-files.ts": "export const x = 1;",
    }).some((x) => x.rule === "architecture"),
  );
});

test("fenced adapter permits only Alchemy and Effect imports", () => {
  assert.deepEqual(
    analyze({
      "src/trial/fenced-state.ts":
        "import {StateStoreError} from 'alchemy/State/State';",
    }),
    [],
  );
  assert.ok(
    analyze({
      "src/trial/fenced-state.ts": "import {readFile} from 'node:fs';",
    }).some((x) => x.rule === "architecture"),
  );
});

test("hosted checkpoint owns admission, orchestration and composition edges", () => {
  const files = {
    "src/trial/checkpoint-index.ts":
      "import './checkpoint-handler.js'; import './checkpoint-run.js'; import {Client} from 'pg';",
    "src/trial/checkpoint-handler.ts":
      "import {createHash} from 'node:crypto';",
    "src/trial/checkpoint-run.ts":
      "import './fenced-state.js'; import './fenced-lifecycle.js';",
    "src/trial/fenced-state.ts": "",
    "src/trial/fenced-lifecycle.ts": "import {Plan} from 'alchemy';",
  };
  assert.deepEqual(analyze(files), []);
  assert.ok(
    analyze({
      ...files,
      "src/trial/checkpoint-handler.ts": "import './checkpoint-run.js';",
    }).some((x) => x.rule === "architecture"),
  );
  assert.ok(
    analyze({
      ...files,
      "src/trial/checkpoint-run.ts": "import {readFile} from 'node:fs';",
    }).some((x) => x.rule === "architecture"),
  );
});

test("ledger SQL port cannot import providers or administrator tooling", () => {
  assert.deepEqual(
    analyze({
      "src/trial/ledger.ts":
        "/** Parameterized port. */ export interface Port {}",
    }),
    [],
  );
  assert.ok(
    analyze({
      "src/trial/ledger.ts":
        "import {ObjectStorageClient} from 'oci-objectstorage';",
    }).some((x) => x.rule === "architecture"),
  );
});
