# Cloudflare Free state trial: persistence passed, ownership blocked

Issue #32, 2026-11-13. **No-go for unattended OCI provisioning.** The documented
Cloudflare backend works from Neon Free and persists across fresh processes, but
accepts overlapping writers and stale writes. It does not provide the deployment
ownership contract required by #5/#6. No custom lock or state service was added.

## What actually ran

- Owner confirmed Workers **Free** in the account's Workers Plans screen. Earlier
  API subscription lookup returned 403; the plan remains owner-attested, not
  API-verified. No plan changes or paid services were requested.
- Alchemy / `@alchemy.run/cloudflare` **2.0.0-beta.86**, Effect **4.1.4**,
  local Node **24.22.3**, Neon `nodejs24` in existing AWS Ohio project.
- Dedicated `berth-state-trial` Worker, one SQLite Durable Object namespace,
  a newly created Secrets Store, two secret bindings; two ephemeral Neon functions
  `berthstate32a` and `berthstate32b`. Initial inventories were empty; no adoption.
- Official, unmodified `StateStore/Api` Worker and generated `Store` bridge.
  Metadata follows pinned `StateStore/Deploy.ts`, with observability disabled,
  previews disabled, no custom domains/routes and explicit SQLite storage.
- Neon called the actual `alchemy/State/HttpStateStore.makeHttpStateStore` interface.
  This was a synthetic StateService qualification, **not** a complete Alchemy
  planner/provider lifecycle. The ownership failure blocks that acceptance step.
- Window: **14:13:29–14:19:59 UTC**, including bootstrap and cloud cleanup.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Official Cloudflare Worker JS | 652822 | `3718c41195416404049540e61df0199f6d2bb75a6ba72918951be83111e00ac4` |
| Neon probe ZIP | 73402 | `23c077aba85c4c7a9f6754c6ea560abf8441cd1e3d328f5d83c5572e79a55375` |

These hashes identify the uploaded artifacts, not future rebuilds.

The run used three distinct observed `bootId` values: separate functions initially,
then a new instance of the first function. The new instance read previously stored
state. UUIDs identify process observations, not a claim about provider scheduling
or proof that we killed a server process.

## Outcomes

| Experiment | Actual result |
| --- | --- |
| Missing bearer token, Cloudflare and Neon | HTTP 401, no protected probe work |
| A creates `first`; independent B reads | B sees `first` |
| Older A reads `first`, pauses two seconds; B writes `second` | B completes before A |
| A resumes and writes `stale`; B reads again | Both writes accepted; B sees `stale` — ownership failure |
| A and B update simultaneously | Both HTTP 200; no contention rejection |
| Malformed JSON state write | HTTP 400; next read still sees `second` |
| Discard successful PUT response body, then read from fresh Neon instance | State remains readable as `second`; no mutation retry |
| Delete stack from B, read from A | Missing state (`null` in sanitized evidence) |
| Inspect decoded synthetic record | No state bearer/encryption-key canaries, database URL or private-key marker |
| Remove both Neon functions | Empty functions and triggers inventories |
| Remove Cloudflare Worker, two secrets and newly created empty store | Empty Worker, Durable Object namespace and Secrets Store inventories |

The lost-response check deliberately discarded the response **after receiving its
headers**. It is not a mid-commit network failure or process-kill test. No claim of
crash-safe lifecycle ownership follows from it. No OCI resource request was sent.

## Why this backend alone is insufficient

The pinned native store's `Store.set` encrypts the supplied value and writes its
key without a revision, owner generation or compare-and-swap predicate. The HTTP
client also sends no lease/fencing token. Durable Object storage makes individual
operations durable; it cannot make a multi-invocation read/work/write sequence
exclusive. The live two-process interleaving demonstrates the consequence.

An instance-local mutex, longer timeout, single-user UI or separate Postgres lease
checked before the HTTP call would not fence a delayed write at this backend.
A viable design must enforce ownership at the mutation boundary or prove a single
executor and fail-closed takeover protocol, including in-flight external requests.
That is a separate design decision under #6, not an implicit extension of this trial.

## Credentials and exposure

- The Cloudflare account API token stayed in the owner's chmod-600 local file. It
  was used only by the account-pinned management transport, never deployed to Neon.
- Random bearer and encryption keys were created once and bound via Secrets Store.
  Neon received only the dedicated bearer and endpoint, not the encryption key.
- Both injected database URLs were replaced with the existing `berth_runtime` URLs.
  Unused injected AWS/AI credentials were replaced by nonsecret disabling markers.
  Runtime checks rejected administrator variables and owner URL usernames. No SQL
  was executed in this probe; its database denial proof remains the earlier suite.
- HTTP callers could select only fixed synthetic phases with empty bodies. Props
  and attributes were constructed locally. The bearer can nevertheless access the
  entire dedicated state store: this is **not** per-stack authorization.
- Native encryption is an implementation property, not proof of credential-free
  state. We inspected the decoded record and fixed payload construction; we did not
  inspect raw Cloudflare storage or certify the native encryption scheme.
- Cloud secrets and function environments were removed. The owner's temporary
  **bootstrap API token remains active until expiry/revocation**; it was not a
  runtime secret. Revoke `berth-state-trial-bootstrap` in My Profile → API Tokens
  after review. Private local run artifacts remain for audit/reconciliation.

## Request and free-allowance evidence

| Observed activity | Count |
| --- | ---: |
| Cloudflare management requests | 20, including 8 writes |
| Neon management requests | 10, including 4 writes |
| Neon function invocations | 12, including one unauthorized request |
| State HTTP requests made by successful Neon invocations | 18 |
| Direct state endpoint checks/fault probes | 5 |
| Total observed state endpoint requests | 23 |

Management budget: 80 dispatches, last 20 reserved for cleanup; every attempt is
journaled before dispatch, including uncertain writes. The execution driver used
one process at a time and reloaded the private journal before each operation.
The helper's in-process reservation is synchronous; it is **not** a cross-process
lock. Never run two operators against the same journal. Mutation method/path pairs
are not automatically retried. Neon driver bounds were 50 management requests and
20 invocations. Each probe admitted at most eight state calls and 15 seconds of
Effect work, with a one-hour deployment expiry. All resources were removed within
seven minutes; no schedule was created. Readiness was observed with bounded GETs.

[Cloudflare Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
checked 2026-11-13 lists Free allowances of 100,000 requests/day and 13,000 GB-s/day;
SQLite Free includes 5 million rows read/day, 100,000 rows written/day and 5 GB
stored. Exceeding Free limits rejects operations rather than enabling paid usage.
[Secrets Store beta](https://developers.cloudflare.com/secrets-store/manage-secrets/)
allows one store and up to 100 secrets per account. The trial needed two secrets.

These HTTP counters are **not billing metrics**: internal Durable Object RPCs,
secret reads/retries, CPU duration, SQLite operations and Neon capacity usage were
not measured. Empty initial inventories and tiny synthetic records reduce expected
consumption but do not establish account-wide headroom. Neither usage warnings nor
billing caps are implemented here. Keep #12 and the owner allowance checks open.

## Reproduce the qualification

Local checks require no cloud credentials:

```bash
pnpm install --frozen-lockfile
pnpm run test:cloudflare-trial
pnpm run build:state-probe
pnpm check
```

Cloud bootstrap is an explicit operator experiment, not a CI action or a ready-made
production installer. The trial's account-bound HTTP helper is
`scripts/cloudflare-trial.ts`; it exposes `makeTrialTransport` and `workerMetadata`.
Use a fresh private directory, an exclusive single operator, a synchronized
intent/response journal, and the exact pinned packages. Reconcile any uncertain
write before continuing; never reset the journal or replay bootstrap.

Build the upstream Worker without changing its implementation:

```bash
node --input-type=module <<'JS'
import { writeFile } from 'node:fs/promises';
import { WorkerBundle } from '@alchemy.run/cloudflare/Workers/Sources/Rolldown';
import { API_MAIN } from '@alchemy.run/cloudflare/StateStore/Api';
import { getCompatibility } from '@alchemy.run/cloudflare/Workers/Compatibility';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as Effect from 'effect/Effect';
import * as Context from 'effect/Context';
const compatibility = getCompatibility({
  main: API_MAIN, compatibility: { date: '2026-10-26' },
});
const bundle = await Effect.runPromise(Effect.gen(function* () {
  const builder = yield* WorkerBundle;
  return yield* builder.build({
    id: 'Api', main: API_MAIN, compatibility,
    entry: { kind: 'effect', exports: {
      Store: { kind: 'durableObject', constructor: Effect.never,
        services: Context.empty() },
    } },
    stack: { name: 'CloudflareStateStore', stage: 'berth-state-trial' },
    extraOptions: undefined,
  });
}).pipe(Effect.provide(NodeServices.layer)));
const main = bundle.files.find(file => file.path === 'Api.js');
if (!main) throw Error('Missing upstream Worker entry');
await writeFile('dist/cloudflare-state.js', main.content);
JS
```

The upstream bundler executes successfully in Node. Importing its APIs into the
strict TypeScript application project exposes upstream declarations requiring
uninstalled platform/optional types and a `capnp-es` exact-optional typing error.
No suppression, compiler weakening or production bootstrap integration was added.
The package also declares a `capnp-es` TypeScript 5/6 peer range, while Berth pins 7.
The native JS build and live deployment passed; full typed bootstrap integration
remains unqualified. Cloudflare is a development-only qualification dependency.

Operator sequence used (API calls via the bounded helper; do not paste credentials
into command arguments, source, responses or logs):

1. Read Worker, Durable Object namespace and Secrets Store inventories; require all
   empty for this specific experiment. Persist two 32-byte random hex keys privately.
2. POST `/secrets_store/stores`; record returned store ID. POST its `/secrets` once
   with both names from `workerMetadata`, `workers` scope and generated values.
   Read secret metadata until both are active, within the request/time budget.
3. PUT `/workers/scripts/berth-state-trial` as multipart: `metadata` from
   `workerMetadata` and `Api.js` from the official bundle. Enable only its workers.dev
   subdomain. Record the endpoint, namespace, secret IDs and successful responses.
4. Deploy the same `dist/state-probe.zip` to two new Neon functions, overriding both
   database URLs and all unused service credentials as described above. Set
   `BERTH_STATE_URL`, `BERTH_STATE_TOKEN`, `BERTH_TRIAL_TOKEN` and
   `BERTH_STATE_EXPIRES_AT` (Unix milliseconds, at most one hour). Confirm deployment
   IDs/status before invoking. Do not deploy administrator tokens or schedules.
5. POST empty authenticated `/create` to A, `/read` to B. Start A `/stale`, then B
   `/update` after 400 ms. Require A's prior marker `first`, B completion before A,
   and final B `/read` marker `stale`; otherwise evidence is inconclusive. Send
   simultaneous `/update` calls too. Record request counts and boot IDs, not secrets.
6. Reject malformed JSON at the state endpoint; inspect the surviving fixed record.
   Discard a successful state PUT response, then reconcile through a fresh reader.
7. Invoke `/delete`, confirm `/read` is empty, delete both Neon functions and list
   functions/triggers. Check live ownership against recorded IDs/names; delete only
   the trial Worker (`?force=true`), its two secrets and the newly created empty
   store. List all three Cloudflare inventories again. Preserve unresolved writes.

## Decision and remaining work

The free deployment and persistence hypothesis passed. The ownership hypothesis
failed. #6 remains blocked. Keep the previous native-Postgres rejection; neither
backend is approved for unattended OCI mutations. Decide whether to seek an
upstream fenced-write contract or explicitly scope a narrow adapter/executor
protocol, then repeat lifecycle/crash/fencing and usage verification before #13.
