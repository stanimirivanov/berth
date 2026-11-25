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

test("browser imports stay on the browser side of the server boundary", () => {
  const files = {
    "ui/src/main.ts": 'import "./feature"; import "@angular/core";',
    "ui/src/feature.ts": "",
    "ui/edge/proxy.ts": "",
    "src/trial/deployment.ts": "",
    "ui/functions/api/index.ts": 'export * from "../../edge/proxy.js";',
  };
  assert.deepEqual(analyze(files), []);
  for (const source of [
    'import "../edge/proxy";',
    'import type { Handler } from "../functions/api/index.js";',
    'export * from "../../src/trial/deployment.ts";',
    'void import("../../scripts/history-server.js");',
    'import "../../neon.js";',
  ]) {
    assert.ok(
      analyze({ ...files, "ui/src/main.ts": source }).some(
        (finding) =>
          finding.file === "ui/src/main.ts" && finding.rule === "architecture",
      ),
      source,
    );
  }
});

test("browser and Pages cycles follow each runtime's local imports", () => {
  const browser = {
    "ui/src/feature.ts": 'import "./state";',
    "ui/src/state/index.ts": 'void import("../feature");',
  };
  const pages = {
    "ui/functions/api/index.ts": 'export * from "../../edge/proxy.js";',
    "ui/edge/proxy.ts": 'import "../functions/api/index.js";',
  };
  for (const files of [browser, pages]) {
    const findings = analyze(files);
    assert.deepEqual(
      findings.map((finding) => finding.rule),
      ["cycle"],
    );
  }
  assert.deepEqual(
    analyze({
      ...browser,
      "ui/src/state/index.ts": 'import type { State } from "../feature";',
      ...pages,
      "ui/edge/proxy.ts":
        'export type { Handler } from "../functions/api/index.js";',
    }),
    [],
  );
  assert.deepEqual(
    analyze({
      ...browser,
      "ui/src/state/index.ts": 'import { type State } from "../feature";',
    }),
    [],
  );
  assert.deepEqual(
    analyze({
      ...browser,
      "ui/src/state/index.ts": 'export {} from "../feature";',
    }),
    [],
  );
  assert.ok(
    analyze({
      ...pages,
      "ui/edge/proxy.ts":
        'export { type Handler } from "../functions/api/index.js";',
    }).some((finding) => finding.rule === "cycle"),
  );
});

test("Angular features keep private modules inside their feature and shell composition", () => {
  const files = {
    "ui/src/app.ts":
      'import "./history/history-store"; import "./history/data-access";',
    "ui/src/history/history-store.ts": 'import "./history-reader";',
    "ui/src/history/history-reader.ts": "",
    "ui/src/history/data-access/index.ts": 'export * from "./implementation";',
    "ui/src/history/data-access/implementation.ts": "",
    "ui/src/history/state/index.d.ts": "export interface Token {}",
    "ui/src/history/operation.ts": "",
    "ui/src/owner-access/owner-session.ts": "",
    "ui/src/infrastructure/page.ts":
      'import type { Operation } from "../history/operation"; import "../owner-access/owner-session";',
  };
  assert.deepEqual(analyze(files), []);
  for (const source of [
    'import "../history/history-store";',
    'import type { Reader } from "../history/history-reader.js";',
    'void import("../history/data-access");',
    'import type { Token } from "../history/state";',
  ]) {
    assert.ok(
      analyze({ ...files, "ui/src/infrastructure/page.ts": source }).some(
        (finding) => finding.rule === "ui-feature",
      ),
      source,
    );
  }
  for (const barrel of [
    'export * from "./history-store";',
    'import { HistoryStore as Store } from "./history-store"; export { Store as History };',
    'import * as Store from "./history-store"; export default Store;',
    'import { HistoryStore } from "./history-store"; export const Store = HistoryStore;',
    'export type Reader = import("./history-reader").Reader;',
    'export const reader = import("./history-reader");',
  ]) {
    assert.ok(
      analyze({ ...files, "ui/src/history/index.ts": barrel }).some(
        (finding) => finding.rule === "ui-feature",
      ),
      barrel,
    );
  }
});

test("Angular presentational components depend on presentation types and inputs", () => {
  const component = "ui/src/history/components/detail/detail.ts";
  const files = {
    [component]: 'import type { Operation } from "../../operation";',
    "ui/src/history/operation.ts": "",
    "ui/src/history/history-store.ts": "",
    "ui/src/history/history-data-access.ts": "",
    "ui/src/history/history-reader.ts": "",
    "ui/src/history/state/index.d.ts": "export interface Token {}",
    "ui/src/history/page.ts":
      'import "./history-store"; import "./components/detail/detail";',
  };
  assert.deepEqual(analyze(files), []);
  for (const source of [
    'import "../../history-store";',
    'void import("../../history-data-access");',
    'type Reader = import("../../history-reader").HistoryReader;',
    'import type { Token } from "../../state";',
  ]) {
    assert.ok(
      analyze({ ...files, [component]: source }).some(
        (finding) =>
          finding.file === component && finding.rule === "ui-presentation",
      ),
      source,
    );
  }
});

test("browser declaration files stay outside the runtime graph", () => {
  const files = {
    "ui/src/main.ts": 'import "./helper.js";',
    "ui/src/helper.d.ts": "export declare const version: string;",
  };
  assert.deepEqual(analyze(files), []);
  assert.ok(
    analyze({ ...files, "ui/src/helper.js": 'import "./main";' }).some(
      (finding) => finding.rule === "cycle",
    ),
  );
});

test("Pages follows an explicit JavaScript file before TypeScript substitution", () => {
  const findings = analyze({
    "ui/functions/api/index.ts": 'export * from "../../edge/proxy.js";',
    "ui/edge/proxy.ts": "",
    "ui/edge/proxy.js": 'import "../functions/api/index.js";',
  });
  assert.ok(findings.some((finding) => finding.rule === "cycle"));
});

test("inline type imports and re-exports still form runtime cycles", () => {
  const files = {
    "scripts/a.ts": 'import { type B } from "./b.ts"; export type A = B;',
    "scripts/b.ts": 'export { type A } from "./a.ts"; export type B = string;',
  };
  assert.ok(analyze(files).some((finding) => finding.rule === "cycle"));
  assert.deepEqual(
    analyze({
      ...files,
      "scripts/a.ts": 'import type { B } from "./b.ts"; export type A = B;',
    }),
    [],
  );
  assert.deepEqual(
    analyze({
      ...files,
      "scripts/b.ts":
        'export type { A } from "./a.ts"; export type B = string;',
    }),
    [],
  );
});

test("application imports use the owned TypeScript source path", () => {
  const owner = "src/application/history/index.ts";
  const files = {
    "src/application/history/api.ts": "",
    "src/trial/executor.ts": "",
  };
  assert.deepEqual(analyze({ ...files, [owner]: 'import "./api.ts";' }), []);
  assert.deepEqual(analyze({ ...files, [owner]: 'import "./api.js";' }), []);
  assert.ok(
    analyze({ ...files, [owner]: 'import "../../trial/executor.js";' }).some(
      (finding) => finding.file === owner && finding.rule === "architecture",
    ),
  );
  assert.ok(
    analyze({ ...files, [owner]: 'import "../../trial/executor.ts";' }).some(
      (finding) => finding.file === owner && finding.rule === "architecture",
    ),
  );
});

test("declaration-level type imports and re-exports still obey module ownership", () => {
  const owner = "src/application/history/index.ts";
  for (const declaration of [
    'import type { Executor } from "../../trial/executor.ts";',
    'export type { Executor } from "../../trial/executor.ts";',
  ]) {
    const findings = analyze({
      [owner]: declaration,
      "src/trial/executor.ts": "",
    });
    assert.ok(
      findings.some(
        (finding) => finding.file === owner && finding.rule === "architecture",
      ),
      declaration,
    );
  }
});

test("repository import spelling covers backend tests without imposing production ownership", () => {
  const testFile = "tests/integration/example.test.ts";
  const productionFile = "scripts/main.ts";
  const sources = {
    "tests/fakes/example.ts": "",
    "scripts/fixture.ts": "",
    "tests/harness.test.mjs": 'import "../tools/harness.mjs";',
  };
  const options = { requireTsExtensions: true };
  assert.deepEqual(
    analyze(
      {
        ...sources,
        [testFile]:
          'import "../fakes/example.ts"; import "node:assert/strict";',
        [productionFile]: 'import "./fixture.ts";',
      },
      options,
    ),
    [],
  );
  const findings = analyze(
    {
      ...sources,
      [testFile]: [
        'import "../fakes/example.js";',
        'export * from "../fakes/example";',
        'type Example = import("../fakes/example.js").Example;',
        'void import("../fakes/example.js");',
      ].join("\n"),
      [productionFile]: 'import "./fixture.js";',
    },
    options,
  );
  assert.deepEqual(
    findings.map(({ file, line, rule }) => [file, line, rule]),
    [
      [testFile, 1, "import-extension"],
      [testFile, 2, "import-extension"],
      [testFile, 3, "import-extension"],
      [testFile, 4, "import-extension"],
      [productionFile, 1, "import-extension"],
    ],
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

test("OCI provider owns only engine and budgeted SDK boundary", () => {
  const files = {
    "src/providers/oci/bucket.ts":
      "import {Resource} from 'alchemy'; import './client.js';",
    "src/providers/oci/client.ts":
      "import {NoRetryConfigurationDetails} from 'oci-common'; import type {requests} from 'oci-objectstorage';",
  };
  assert.deepEqual(
    analyze(files).filter((x) => x.rule === "architecture"),
    [],
  );
  for (const [file, text] of /** @type {[string, string][]} */ ([
    ["src/providers/oci/bucket.ts", "import 'oci-objectstorage';"],
    ["src/providers/oci/client.ts", "import 'node:fs';"],
    ["src/trial/runtime-probe.ts", "import '../providers/oci/client.js';"],
  ]))
    assert.ok(
      analyze({ ...files, [file]: text }).some(
        (x) => x.rule === "architecture",
      ),
    );
});

test("trial object helper owns hashing and cannot bypass the SDK boundary", () => {
  const files = {
    "src/providers/oci/trial-object.ts":
      "import 'node:crypto'; import 'node:stream'; import './client.js'; import './bucket.js';",
    "src/providers/oci/client.ts": "",
    "src/providers/oci/bucket.ts": "",
  };
  assert.deepEqual(
    analyze(files).filter((x) => x.rule === "architecture"),
    [],
  );
  assert.ok(
    analyze({
      ...files,
      "src/providers/oci/trial-object.ts": "import 'oci-objectstorage';",
    }).some((x) => x.rule === "architecture"),
  );
});

test("trial admission cannot reach cloud SDKs or bypass preflight ownership", () => {
  const files = {
    "src/trial/api.ts":
      "import 'node:crypto'; import './preflight.js'; import type {TrialIntent} from './ledger.js';",
    "src/trial/preflight.ts": "",
    "src/trial/ledger.ts": "",
  };
  assert.deepEqual(
    analyze(files).filter((x) => x.rule === "architecture"),
    [],
  );
  assert.ok(
    analyze({
      ...files,
      "src/trial/api.ts": "import 'oci-objectstorage';",
    }).some((x) => x.rule === "architecture"),
  );
});

test("scheduled continuation separates admission, ledger state and OCI composition", () => {
  const files = {
    "src/trial/scheduled.ts": "import 'node:crypto';",
    "src/trial/executor.ts":
      "import 'node:crypto'; import './ledger.js'; import './executor-store.js'; import './executor-resources.js';",
    "src/trial/ledger.ts": "",
    "src/trial/executor-store.ts": "",
    "src/trial/executor-resources.ts": "",
  };
  assert.deepEqual(
    analyze(files).filter((x) => x.rule === "architecture"),
    [],
  );
  assert.ok(
    analyze({ ...files, "src/trial/scheduled.ts": "import 'pg';" }).some(
      (x) => x.rule === "architecture",
    ),
  );
});

test("usage collector separates signed provider IO from durable warnings and admission", () => {
  const files = {
    "src/providers/oci/usage.ts":
      "import type {RequestSigner} from 'oci-common';",
    "src/trial/warnings.ts":
      "import './ledger.js'; import '../providers/oci/usage.js';",
    "src/trial/ledger.ts": "",
  };
  assert.deepEqual(
    analyze(files).filter((x) => x.rule === "architecture"),
    [],
  );
  assert.ok(
    analyze({ ...files, "src/trial/warnings.ts": "import 'pg';" }).some(
      (x) => x.rule === "architecture",
    ),
  );
});

test("live roots allow reviewed transports but reject synthetic and administrator coupling", () => {
  const controls = {
    "src/trial/live-index.ts":
      'import "./live-hosted.js"; import "./live-runtime.js";',
    "src/trial/live-environment.ts":
      'import "node:crypto"; import "./executor-security.js";',
    "src/trial/live-hosted.ts":
      'import "./live-environment.js"; import "./scheduled.js";',
    "src/trial/live-runtime.ts":
      'import "oci-common"; import "pg"; import "../providers/oci/client.js"; import "./executor.js";',
    "src/trial/executor-security.ts":
      "/** Shared restricted SQL check. */ export const restricted = true;",
  };
  assert.deepEqual(
    analyze({
      ...controls,
      "src/trial/scheduled.ts": "",
      "src/providers/oci/client.ts": "",
      "src/trial/executor.ts": "",
    }),
    [],
  );
  /** @type {[string, string][]} */
  const rejected = [
    ["src/trial/live-index.ts", 'import "../../scripts/oci-admin-setup.js";'],
    ["src/trial/live-hosted.ts", 'import "oci-common";'],
    ["src/trial/live-runtime.ts", 'import "./executor-synthetic.js";'],
    ["src/trial/executor-security.ts", 'import "node:fs";'],
  ];
  for (const [file, text] of rejected)
    assert.ok(analyze({ [file]: text }).some((f) => f.rule === "architecture"));
});

test("live admission owns metering and cannot import credentials from administrator scripts", () => {
  const files = {
    "src/trial/live-admission.ts":
      'import "node:crypto"; import "./api.js"; import "./ledger.js";',
    "src/trial/api.ts": "",
    "src/trial/ledger.ts": "",
    "src/providers/oci/readiness.ts":
      'import type { RequestSigner } from "oci-common";',
  };
  assert.deepEqual(analyze(files), []);
  assert.ok(
    analyze({
      ...files,
      "src/trial/live-admission.ts": 'import "../../scripts/oci-setup.js";',
    }).some((x) => x.rule === "architecture"),
  );
  assert.ok(
    analyze({
      ...files,
      "src/providers/oci/readiness.ts": 'import "node:fs";',
    }).some((x) => x.rule === "architecture"),
  );
});

test("Inventory HTTP uses its read port and leaves database wiring to its entry point", () => {
  const files = {
    "src/application/inventory/index.ts":
      'import "./api.ts"; import "../retained-trial-ledger/inventory.ts";',
    "src/application/inventory/api.ts":
      'import "node:crypto"; import type { InventoryReader } from "./contract.ts";',
    "src/application/inventory/contract.ts": 'import "effect/Schema";',
    "src/application/retained-trial-ledger/inventory.ts":
      'import "pg"; import "../inventory/contract.ts"; import "./sql.ts";',
    "src/application/retained-trial-ledger/sql.ts": "",
  };
  assert.deepEqual(analyze(files), []);
  for (const dependency of [
    "pg",
    "oci-common",
    "../retained-trial-ledger/inventory.ts",
  ]) {
    assert.ok(
      analyze({
        ...files,
        "src/application/inventory/api.ts": `import "${dependency}";`,
      }).some((finding) => finding.rule === "architecture"),
      dependency,
    );
  }
});

test("history boundaries permit only the read composition and reject provider or execution coupling", () => {
  const adapter = "src/application/retained-trial-ledger/";
  const sources = {
    "src/application/history/index.ts":
      'import "./api.js"; import "./runtime.js";',
    "src/application/history/api.ts": "",
    "src/application/history/contract.ts": 'import "effect/Schema";',
    "src/application/history/runtime.ts":
      'import type { HistoryRead } from "./api.js"; import "../retained-trial-ledger/history.js";',
    [`${adapter}history.ts`]:
      'import "../../trial/executor-security.js"; import "../history/contract.js"; import "./sql.js";',
    [`${adapter}inventory.ts`]:
      'import "../inventory/contract.js"; import "./sql.js"; const query = "SELECT berth_inventory.inventory_page($1,$2)";',
    [`${adapter}retry.ts`]: 'import "../retry/contract.js"; import "./sql.js";',
    [`${adapter}sql.ts`]: "",
    "src/application/inventory/contract.ts": 'import "effect/Schema";',
    "src/application/retry/contract.ts": "",
    "src/trial/executor-security.ts": "",
    "src/trial/executor-store.ts": "",
    "src/trial/executor.ts": "",
    "src/trial/live-runtime.ts": "",
    "src/providers/oci/client.ts": "",
  };
  assert.deepEqual(analyze(sources), []);
  for (const [file, text] of /** @type {[string, string][]} */ ([
    ["src/application/history/index.ts", 'import "../../trial/executor.js";'],
    [
      "src/application/history/index.ts",
      'import "../../trial/live-runtime.js";',
    ],
    [
      "src/application/history/index.ts",
      'import "../../providers/oci/client.js";',
    ],
    [
      "src/application/history/runtime.ts",
      "const query = `SELECT BERTH_USAGE.report($1)`;",
    ],
    [
      "src/application/history/runtime.ts",
      'const query = `SELECT "berth_executor".history_page($1,$2)`;',
    ],

    [
      "src/application/history/runtime.ts",
      'import "../../trial/executor-store.js";',
    ],
    [
      "src/application/history/runtime.ts",
      'import "../retained-trial-ledger/retry.js";',
    ],
    [
      "src/application/inventory/contract.ts",
      'import "../retained-trial-ledger/retry.js";',
    ],
    [`${adapter}inventory.ts`, 'import "../../trial/executor-store.js";'],
    [
      "src/application/history/runtime.ts",
      'const query = "SELECT berth_executor.history_page($1,$2)";',
    ],
    ["src/trial/executor-store.ts", 'import "../application/history/api.js";'],
  ])) {
    assert.ok(
      analyze({ ...sources, [file]: text }).some(
        (error) => error.rule === "architecture",
      ),
      file,
    );
  }
});

test("retry boundaries permit the read-only observer and reject executor coupling", () => {
  const sources = {
    "src/http/empty-control.ts": "",
    "src/trial/live-hosted.ts": 'import "../http/empty-control.js";',
    "src/application/retry/api.ts":
      'import "../../http/empty-control.js"; import "./contract.js"; import "./continuation.js";',
    "src/application/retry/continuation.ts": 'import "effect/Schema";',
    "src/application/retry/contract.ts":
      'import "effect/Schema"; import type { RetryObservation } from "../../providers/oci/retry-observation.js";',
    "src/application/retry/index.ts":
      'import "./api.js"; import "./runtime.js";',
    "src/application/retry/runtime.ts":
      'import "./reconciliation.js"; import "./continuation.js"; import type { RetryAction } from "./api.js"; import "../retained-trial-ledger/retry.js"; import "../../providers/oci/retry-observation.js";',
    "src/application/retry/reconciliation.ts":
      'import type { RetryLedger } from "./contract.js"; import type { RetryAction } from "./api.js"; import type { RetryObserver } from "../../providers/oci/retry-observation.js";',
    "src/application/retained-trial-ledger/retry.ts":
      'import "../retry/contract.js"; import "../retry/continuation.js"; import "./sql.js";',
    "src/application/retained-trial-ledger/sql.ts": "",
    "src/providers/oci/retry-observation.ts": 'import "effect/Schema";',
    "src/providers/oci/client.ts": "",
    "src/trial/executor.ts": "",
  };
  assert.deepEqual(analyze(sources), []);
  for (const [file, text] of /** @type {[string, string][]} */ ([
    [
      "src/application/retry/continuation.ts",
      'import "../../trial/executor.js";',
    ],
    [
      "src/application/retry/continuation.ts",
      'import "../../providers/oci/client.js";',
    ],
    ["src/application/retry/contract.ts", 'import "../../trial/executor.js";'],
    ["src/trial/live-hosted.ts", 'import "../application/retry/contract.js";'],
    ["src/application/retry/runtime.ts", 'import "../../trial/executor.js";'],
    [
      "src/application/retry/runtime.ts",
      'import "../retained-trial-ledger/sql.js";',
    ],
    [
      "src/application/retry/reconciliation.ts",
      'import "../retained-trial-ledger/retry.js";',
    ],
    ["src/providers/oci/retry-observation.ts", 'import "./client.js";'],
  ])) {
    assert.ok(
      analyze({ ...sources, [file]: text }).some(
        (error) => error.rule === "architecture",
      ),
      file,
    );
  }
});
