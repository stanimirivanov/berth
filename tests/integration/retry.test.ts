import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "pg";
import { retainedRetryLedger } from "../../src/application/retained-trial-ledger/retry.ts";
import { retryApi } from "../../src/application/retry/api.ts";
import { retryActions } from "../../src/application/retry/reconciliation.ts";
import {
  retryContinuationRuntime,
  retryRuntime,
} from "../../src/application/retry/runtime.ts";
import { createProposal } from "../../src/providers/oci/client.ts";
import { retryObserver } from "../../src/providers/oci/retry-observation.ts";
import { runExecutor } from "../../src/trial/executor.ts";
import { executorStore } from "../../src/trial/executor-store.ts";
import { liveAdmissionApi } from "../../src/trial/live-admission.ts";
import { freePolicyFixture } from "../fakes/free-policy.ts";
import { FakeObjects } from "../fakes/oci.ts";

const scope = {
  compartment: "ocid1.compartment.oc1..fixture",
  namespace: "retryfixture",
  region: "eu-frankfurt-1",
};

test("expired retry accounts for one read-only check, deduplicates, and preserves prior authority", async () => {
  const port = Number(process.env.BERTH_TEST_POSTGRES_PORT);
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
  const settings = {
    host: "127.0.0.1",
    port,
    database: "neondb",
    password: "berth-test-only",
    connectionTimeoutMillis: 2500,
    statement_timeout: 5000,
  };
  const admin = new Client({ ...settings, user: "postgres" });
  const owner = new Client({ ...settings, user: "neondb_owner" });
  const runtime = new Client({ ...settings, user: "berth_retry_runtime" });
  try {
    await admin.connect();
    await owner.connect();
    for (const name of [
      "001_trial",
      "002_executor",
      "003_usage",
      "004_admission",
      "005_functions_exception",
      "006_free_functions_policy",
      "007_bounded_allowance_exception",
      "008_operation_history",
      "009_managed_inventory",
      "010_inventory_evidence",
      "011_retry_reconciliation",
      "012_retry_continuation",
    ])
      await owner.query(await readFile(`migrations/${name}.sql`, "utf8"));
    await admin.query(
      "CREATE ROLE berth_retry_runtime LOGIN PASSWORD 'berth-test-only'",
    );
    await admin.query("GRANT berth_retry_action TO berth_retry_runtime");
    await runtime.connect();

    async function seed(
      variant: "expired" | "open" | "cleanup" = "expired",
      pending = false,
    ) {
      const operation = randomUUID();
      const bucket = `berth-${operation.replaceAll("-", "")}`;
      const marker = randomUUID();
      const originalOpen = variant !== "expired";
      await owner.query(
        `INSERT INTO berth_ledger.trials(operation,compartment,region,namespace,digest,bucket,
          marker,started_at,expires_at,outcome,normal_used,cleanup_used,monitoring_limit,neon_limit,cleanup_started)
         VALUES ($1,$2,$3,$4,repeat('a',64),$5,$6,
           now()-CASE WHEN $7 THEN interval '5 minutes' ELSE interval '5 hours' END,
           now()+CASE WHEN $7 THEN interval '235 minutes' ELSE interval '-1 hour' END,
           CASE WHEN $7 THEN 'active' ELSE 'failed' END,4,8,20,40,$8)`,
        [
          operation,
          scope.compartment,
          scope.region,
          scope.namespace,
          bucket,
          marker,
          originalOpen,
          variant === "cleanup",
        ],
      );
      if (pending) {
        const attempt = randomUUID();
        await owner.query(
          "INSERT INTO berth_ledger.attempts(id,operation,action,generation,ordinal) VALUES($1,$2,'create_bucket',1,1)",
          [attempt, operation],
        );
        await owner.query(
          "INSERT INTO berth_ledger.requests(id,attempt,operation,generation,meter,mutation) VALUES($1,$2,$3,1,'normal',true)",
          [randomUUID(), attempt, operation],
        );
      }
      return { operation, bucket, marker };
    }

    const { operation, bucket } = await seed("expired", true);
    const previous = (
      await owner.query(
        "SELECT to_jsonb(t) AS value FROM berth_ledger.trials t WHERE operation=$1",
        [operation],
      )
    ).rows[0]?.value;
    const requests: { url: string; method: string | undefined }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), method: init?.method });
      return new URL(String(input)).pathname.endsWith(`/${bucket}`)
        ? new Response(null, { status: 404 })
        : Response.json([]);
    };
    const act = retryActions(
      retainedRetryLedger(runtime),
      retryObserver(scope, { async signHttpRequest() {} }, fetcher),
    );
    assert.equal(await act("status", operation), null);
    const first = await act("start", operation);
    assert.equal(first?.scope, "after-expiry");
    assert.equal(first?.stage, "needs-attention");
    assert.equal(first?.reason, "unresolved-prior-write");
    assert.deepEqual(first?.checks, { used: 2, limit: 2 });
    assert.equal(requests.length, 2);
    assert.ok(requests.every((request) => request.method === "GET"));
    assert.ok(
      requests[0] && new URL(requests[0].url).pathname.endsWith(`/${bucket}`),
    );
    assert.deepEqual(await act("start", operation), first);
    assert.deepEqual(await act("status", operation), first);
    assert.equal(requests.length, 2);
    assert.deepEqual(
      (
        await owner.query(
          "SELECT to_jsonb(t) AS value FROM berth_ledger.trials t WHERE operation=$1",
          [operation],
        )
      ).rows[0]?.value,
      previous,
    );
    await assert.rejects(runtime.query("SELECT * FROM berth_ledger.trials"), {
      code: "42501",
    });
    let configurationChecked = false;
    const hosted = retryRuntime(
      {
        BERTH_RETRY_DATABASE_URL:
          "postgresql://berth_retry_runtime:fixture@ep-retry.fixture.neon.tech/neondb?sslmode=verify-full",
      },
      (configuration) => {
        assert.deepEqual(configuration.ssl, { rejectUnauthorized: true });
        assert.equal(configuration.user, "berth_retry_runtime");
        configurationChecked = true;
        return new Client({ ...settings, user: "berth_retry_runtime" });
      },
    );
    assert.deepEqual(await hosted("status", operation), first);
    assert.equal(configurationChecked, true);

    await owner.query(
      "GRANT USAGE ON SCHEMA berth_ledger TO berth_retry_action",
    );
    await owner.query(
      "GRANT SELECT ON berth_ledger.trials TO berth_retry_action",
    );
    try {
      await assert.rejects(hosted("status", operation), {
        message: "Retry database unavailable",
      });
    } finally {
      await owner.query(
        "REVOKE ALL ON berth_ledger.trials FROM berth_retry_action",
      );
      await owner.query(
        "REVOKE USAGE ON SCHEMA berth_ledger FROM berth_retry_action",
      );
    }
    await assert.rejects(
      runtime.query("SELECT * FROM berth_retry.reconciliations"),
      { code: "42501" },
    );

    await owner.query(
      "CREATE FUNCTION berth_retry.fixture_extra() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
    );
    try {
      await assert.rejects(hosted("status", operation), {
        message: "Retry database unavailable",
      });
    } finally {
      await owner.query("DROP FUNCTION berth_retry.fixture_extra()");
    }

    const late = await seed("expired", true);
    const mismatch = await seed("expired", true);
    const changedIdentity = await seed("expired", true);
    const drift = await seed("expired", true);
    const queuedRemoval = await seed("expired", true);
    const publishedRemoval = await seed("expired", true);
    const newerRemoval = await seed("expired", true);
    const deniedRead = await seed();
    for (const fixture of [queuedRemoval, publishedRemoval, newerRemoval]) {
      const identity = `ocid1.bucket.oc1..retryFixture${fixture.operation.replaceAll("-", "")}`;
      await owner.query(
        "INSERT INTO berth_inventory.executor_events VALUES($1,$2,$3,now()+CASE WHEN $4 THEN interval '10 seconds' ELSE interval '-2 minutes' END,'removed','{}')",
        [
          `fixture/removal/${fixture.operation}`,
          fixture.operation,
          identity,
          fixture === newerRemoval,
        ],
      );
    }
    await owner.query("SELECT berth_inventory.publish_executor($1)", [
      publishedRemoval.operation,
    ]);
    const expiredCleanup = await seed();
    await owner.query(
      "INSERT INTO berth_inventory.executor_events VALUES('fixture/known',$1,'ocid1.bucket.oc1..previous',now(),'present','{}')",
      [changedIdentity.operation],
    );
    await owner.query(
      "UPDATE berth_ledger.trials SET cleanup_started=true WHERE operation=$1",
      [expiredCleanup.operation],
    );
    const clean = await seed();
    const retained = await seed();
    const paginated = await seed();
    const orphan = await seed();
    const reachedProvider = Promise.withResolvers<void>();
    const returnProvider = Promise.withResolvers<void>();
    let calls = 0;
    let providerDate = "";
    const fixtures = retryObserver(
      scope,
      { async signHttpRequest() {} },
      async (input, init) => {
        calls++;
        assert.equal(init?.method, "GET");
        assert.equal(init?.redirect, "error");
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/b"))
          return pathsProbe === paginated.bucket
            ? Response.json([], { headers: { "opc-next-page": "fixture" } })
            : Response.json([]);
        pathsProbe = path.split("/").at(-1);
        if (pathsProbe === deniedRead.bucket)
          return new Response(null, { status: 403 });
        const saved = [
          late,
          retained,
          mismatch,
          changedIdentity,
          drift,
          queuedRemoval,
          publishedRemoval,
          newerRemoval,
        ].find((item) => item.bucket === pathsProbe);
        if (!saved) return new Response(null, { status: 404 });
        const date = new Date().toUTCString();
        if (saved === late) {
          providerDate = date;
          reachedProvider.resolve();
          await returnProvider.promise;
        }
        return Response.json(
          {
            id: `ocid1.bucket.oc1..retryFixture${saved.operation.replaceAll("-", "")}`,
            etag: "fixture-revision",
            publicAccessType: saved === drift ? "ObjectRead" : "NoPublicAccess",
            storageTier: "Standard",
            versioning: "Disabled",
            autoTiering: "Disabled",
            objectEventsEnabled: false,
            replicationEnabled: false,
            isReadOnly: false,
            namespace: scope.namespace,
            compartmentId: scope.compartment,
            name: saved.bucket,
            freeformTags: {
              "berth-operation": saved.operation,
              "berth-marker": saved === mismatch ? randomUUID() : saved.marker,
            },
          },
          {
            headers: {
              etag: "fixture-revision",
              "opc-request-id": "fixture-get",
              date,
            },
          },
        );
      },
    );
    let pathsProbe: string | undefined;
    const followUp = retryActions(retainedRetryLedger(runtime), fixtures);
    const peer = new Client({ ...settings, user: "berth_retry_runtime" });
    await peer.connect();
    try {
      const firstRequest = followUp("start", late.operation);
      try {
        await Promise.race([
          reachedProvider.promise,
          firstRequest.then(() => assert.fail("Expected a provider check")),
        ]);
        const concurrent = retryActions(retainedRetryLedger(peer), fixtures);
        assert.equal(
          (await concurrent("start", late.operation))?.stage,
          "checking-provider",
        );
        assert.equal(
          (await concurrent("status", late.operation))?.checks.used,
          1,
        );
        assert.equal(calls, 1);
      } finally {
        returnProvider.resolve();
      }
      const recovered = await firstRequest;
      assert.equal(recovered?.result, "owned-instance");
      assert.equal(
        Date.parse(recovered?.observedAt ?? ""),
        Date.parse(providerDate),
      );
      assert.doesNotMatch(
        JSON.stringify(recovered),
        /retryFixture|fixture-revision|fixture-get/,
      );
      const inventory = (
        await owner.query("SELECT berth_inventory.inventory_page() AS value")
      ).rows[0]?.value;
      assert.deepEqual(
        inventory.items.map((row: { operation: string }) => row.operation),
        [late.operation],
      );
    } finally {
      await peer.end();
    }
    assert.equal(
      (await followUp("start", mismatch.operation))?.reason,
      "ownership-conflict",
    );
    assert.equal(
      (await followUp("start", changedIdentity.operation))?.reason,
      "ownership-conflict",
    );
    assert.equal(
      (await followUp("start", drift.operation))?.reason,
      "bucket-configuration-drift",
    );
    assert.equal(
      (await followUp("start", expiredCleanup.operation))?.reason,
      "cleanup-started",
    );
    assert.equal(
      (await followUp("start", clean.operation))?.result,
      "safe-write-needed",
    );
    assert.equal(
      (await followUp("start", paginated.operation))?.reason,
      "provider-check-inconclusive",
    );

    const denied = await followUp("start", deniedRead.operation);
    assert.equal(denied?.reason, "read-access-unavailable");
    assert.ok(denied?.ownerProcedure?.endsWith("#installation-prerequisites"));
    for (const fixture of [queuedRemoval, publishedRemoval]) {
      const contradictory = await followUp("start", fixture.operation);
      assert.equal(contradictory?.reason, "ownership-conflict");
      await owner.query("SELECT berth_inventory.publish_executor($1)", [
        fixture.operation,
      ]);
      const admitted = (
        await owner.query(
          "SELECT source,kind,disposition FROM berth_inventory.evidence WHERE operation=$1",
          [fixture.operation],
        )
      ).rows;
      assert.deepEqual(admitted, [
        { source: "executor", kind: "removed", disposition: "recorded" },
      ]);
    }
    const historical = await followUp("start", newerRemoval.operation);
    assert.equal(historical?.reason, "newer-removal-recorded");
    const ordered = await owner.query(
      "SELECT kind,disposition FROM berth_inventory.evidence WHERE operation=$1 ORDER BY observed_at",
      [newerRemoval.operation],
    );
    assert.deepEqual(ordered.rows, [
      { kind: "present", disposition: "recorded" },
      { kind: "removed", disposition: "recorded" },
    ]);
    const privateDrift = await owner.query(
      "SELECT provider_observation->'configurationMatches' AS matches FROM berth_retry.reconciliations WHERE operation=$1",
      [drift.operation],
    );
    assert.deepEqual(privateDrift.rows, [{ matches: false }]);
    const afterDriftAndRemoval = (
      await owner.query("SELECT berth_inventory.inventory_page() AS value")
    ).rows[0]?.value;
    assert.deepEqual(
      afterDriftAndRemoval.items.map(
        (row: { operation: string }) => row.operation,
      ),
      [late.operation],
    );

    const claim = randomUUID();
    await runtime.query("SELECT berth_retry.begin($1,$2)", [
      orphan.operation,
      claim,
    ]);
    await runtime.query("SELECT berth_retry.reserve($1,$2,'bucket')", [
      orphan.operation,
      claim,
    ]);
    await owner.query(
      "UPDATE berth_retry.reconciliations SET deadline=now()-interval '1 second' WHERE operation=$1",
      [orphan.operation],
    );
    const beforeRecovery = calls;
    const interrupted = await followUp("start", orphan.operation);
    assert.equal(interrupted?.reason, "check-interrupted");
    assert.deepEqual(interrupted?.checks, { used: 1, limit: 2 });
    assert.equal(calls, beforeRecovery);

    assert.equal(
      (
        await runtime.query(
          "SELECT berth_retry.continuation_status($1) AS value",
          [late.operation],
        )
      ).rows[0]?.value.reason,
      "source-not-safe",
      "owned presence cannot settle a still-open CREATE",
    );
    const candidate = await seed("open");
    const originalWindow = (
      await owner.query(
        `UPDATE berth_ledger.trials SET digest=$2, neon_limit=64,
          started_at=date_trunc('milliseconds',started_at),
          expires_at=date_trunc('milliseconds',started_at)+interval '4 hours'
          WHERE operation=$1 RETURNING started_at,expires_at`,
        [
          candidate.operation,
          "fbbab289f7f94b25736c58be46a994c441fd02552cc6022352e3d86d2fab7c83",
        ],
      )
    ).rows[0];
    const originalEvidence = freePolicyFixture(
      candidate.operation,
      originalWindow.started_at.getTime(),
      scope.region,
    );
    const originalBinding = {
      ...scope,
      monitoringLimit: 20,
      neonLimit: 64,
      tenancy: "ocid1.tenancy.oc1..fixture",
      user: "ocid1.user.oc1..fixture",
      fingerprint: Array(16).fill("ab").join(":"),
    };
    await owner.query(
      "INSERT INTO berth_executor.admission(operation,binding,evidence,admitted) VALUES($1,$2,$3,true)",
      [candidate.operation, originalBinding, originalEvidence],
    );
    await owner.query(
      "INSERT INTO berth_executor.functions_policy VALUES($1,$2,$3,$4,$5)",
      [
        candidate.operation,
        originalWindow.started_at,
        originalWindow.expires_at,
        originalBinding,
        originalEvidence,
      ],
    );
    const initialCheck = await followUp("start", candidate.operation);
    assert.equal(initialCheck?.scope, "original-window");
    assert.equal(initialCheck?.result, "safe-write-needed");
    const beforeStatusRead = calls;
    const originalAuthority = (
      await runtime.query(
        "SELECT berth_retry.continuation_status($1) AS value",
        [candidate.operation],
      )
    ).rows[0]?.value;
    assert.equal(originalAuthority.scope, "original-window");
    assert.equal(originalAuthority.stage, "continuing-provisioning");
    assert.equal(originalAuthority.proposal, undefined);
    assert.equal(calls, beforeStatusRead);
    for (const ordinal of [1, 2, 3]) {
      await owner.query(
        "INSERT INTO berth_ledger.attempts(id,operation,action,generation,ordinal,outcome) VALUES($1,$2,'create_bucket',0,$3,'failed')",
        [randomUUID(), candidate.operation, ordinal],
      );
    }
    assert.equal(
      (
        await runtime.query(
          "SELECT berth_retry.continuation_status($1) AS value",
          [candidate.operation],
        )
      ).rows[0]?.value.reason,
      "original-authority-unavailable",
    );

    await owner.query(
      "UPDATE berth_ledger.trials SET started_at=now()-interval '5 hours',expires_at=now()-interval '1 hour' WHERE operation=$1",
      [candidate.operation],
    );
    assert.equal(
      (await followUp("status", candidate.operation))?.scope,
      "original-window",
    );
    const freshCheck = await followUp("start", candidate.operation);
    assert.equal(freshCheck?.scope, "after-expiry");
    assert.equal(freshCheck?.result, "safe-write-needed");
    const originalCheck = await owner.query(
      "SELECT scope,used FROM berth_retry.original_window_checks WHERE operation=$1",
      [candidate.operation],
    );
    assert.deepEqual(originalCheck.rows, [
      { scope: "original-window", used: 2 },
    ]);
    const continuation = randomUUID();
    const starts = Date.now() - 1000;
    const reviewedAt = Date.now() - 1000;
    const reviewed = freePolicyFixture(continuation, starts, scope.region);
    const evidence = {
      ...reviewed,
      checkedAt: reviewedAt,
      iamCheckedAt: reviewedAt,
      functionsPolicy: {
        ...reviewed.functionsPolicy,
        billing: { ...reviewed.functionsPolicy.billing, reviewedAt },
        plan: { ...reviewed.functionsPolicy.plan, checkedAt: reviewedAt },
      },
    };
    const binding = {
      ...scope,
      tenancy: "ocid1.tenancy.oc1..fixture",
      user: "ocid1.user.oc1..fixture",
      fingerprint: Array(16).fill("ab").join(":"),
      monitoringLimit: 20,
      neonLimit: 64,
    };
    const saved = async () =>
      (
        await owner.query(
          "SELECT to_jsonb(t)-'retry_slot_released' AS value FROM berth_ledger.trials t WHERE operation=$1",
          [candidate.operation],
        )
      ).rows[0]?.value;
    const beforeContinuation = await saved();
    const prepare = (snapshot: object, id: string = continuation) =>
      owner.query("SELECT berth_retry.prepare_continuation($1,$2,$3,$4,$5)", [
        candidate.operation,
        id,
        new Date(starts),
        binding,
        snapshot,
      ]);
    const view = async () =>
      (
        await runtime.query(
          "SELECT berth_retry.continuation_status($1) AS value",
          [candidate.operation],
        )
      ).rows[0]?.value;
    assert.equal((await view()).reason, "preparation-required");
    await assert.rejects(
      prepare({ ...evidence, transferBytes: 1 }),
      /Free allowance evidence/,
    );
    await assert.rejects(
      prepare({ ...evidence, functionsKnownInsufficient: true }),
      /Free allowance evidence/,
    );
    await assert.rejects(
      prepare({ ...evidence, iamReviewed: false }),
      /effective IAM evidence/,
    );
    await assert.rejects(
      prepare({
        ...evidence,
        functionsPolicy: {
          ...evidence.functionsPolicy,
          manualRecoveryReady: false,
        },
      }),
      /cleanup readiness evidence/,
    );
    await assert.rejects(
      prepare({ ...evidence, checkedAt: starts - 86400000 }),
    );
    const obsolete = randomUUID();
    await prepare(
      {
        ...evidence,
        functionsPolicy: { ...evidence.functionsPolicy, operation: obsolete },
      },
      obsolete,
    );
    await owner.query(
      "UPDATE berth_retry.proposals SET approve_by=clock_timestamp()-interval '1 second' WHERE id=$1",
      [obsolete],
    );
    assert.equal((await view()).reason, "proposal-expired");
    assert.equal(
      (
        await runtime.query(
          "SELECT berth_retry.approve_continuation($1,$2) AS value",
          [candidate.operation, obsolete],
        )
      ).rows[0]?.value,
      null,
    );

    await prepare(evidence);
    const offered = await view();
    assert.equal(offered.stage, "waiting-for-approval");
    assert.equal(offered.target.bucket, candidate.bucket);
    assert.equal(offered.limits.cleanup, 40);
    assert.equal(offered.limits.applicationCleanup, 12);
    assert.equal(offered.proposal, continuation);
    assert.equal(offered.binding, undefined);
    const approve = async (id: string = continuation) =>
      (
        await runtime.query(
          "SELECT berth_retry.approve_continuation($1,$2) AS value",
          [candidate.operation, id],
        )
      ).rows[0]?.value;
    assert.equal(await approve(randomUUID()), null);

    const openContinuation = retryContinuationRuntime(
      {
        BERTH_RETRY_DATABASE_URL:
          "postgresql://berth_retry_runtime:fixture@ep-retry.fixture.neon.tech/neondb",
      },
      () => new Client({ ...settings, user: "berth_retry_runtime" }),
    );
    const ownerCredential = `berth-retry-owner-v1.${"x".repeat(43)}`;
    let loseResponse = true;
    const retry = retryApi(
      ownerCredential,
      followUp,
      Date.now,
      async (id, proposal) => {
        const committed = await openContinuation(id, proposal);
        if (proposal && loseResponse)
          throw Error("Approval acknowledgement lost");
        return committed;
      },
    );
    const send = (path: string, method: string, bearer: string) =>
      retry.fetch(
        new Request(`https://fixture.invalid${path}`, {
          method,
          headers: { authorization: `Bearer ${bearer}` },
        }),
      );
    const signedIn = await send("/api/retry/session", "POST", ownerCredential);
    const { session } = await signedIn.json();
    const parentRoute = `/api/retry/operations/${candidate.operation}`;
    const approvalRoute = `${parentRoute}/proposals/${continuation}/approve`;
    const [firstApproval, lostAcknowledgement] = await Promise.all([
      approve(),
      send(approvalRoute, "POST", session),
    ]);
    assert.equal(lostAcknowledgement.status, 503);
    assert.equal(firstApproval.continuation, continuation);
    assert.equal(firstApproval.progress, "awaiting-activation");
    loseResponse = false;
    const recovered = await send(`${parentRoute}/continuation`, "GET", session);
    assert.deepEqual(await recovered.json(), firstApproval);
    const repeated = await send(approvalRoute, "POST", session);
    assert.deepEqual(await repeated.json(), firstApproval);
    assert.deepEqual(await saved(), beforeContinuation);
    const executor = new Client({
      ...settings,
      user: "berth_runtime",
      password: "test-runtime-only",
    });
    await executor.connect();
    try {
      const sdk = new FakeObjects();
      const environment = {
        ...binding,
        operation: continuation,
        startedAt: starts,
        expiresAt: starts + 14400000,
        token: "t".repeat(40),
        previewKey: "v".repeat(40),
        privateKey: "unused-by-synthetic-provider",
        connection: "unused",
      };
      await assert.rejects(
        executor.query("SELECT berth_ledger.claim($1,$2,30)", [
          candidate.operation,
          randomUUID(),
        ]),
        /Trial closed/,
      );
      await executor.query("SELECT berth_executor.cleanup($1)", [
        candidate.operation,
      ]);
      const originalReport = await executorStore(executor).report(
        candidate.operation,
      );
      const run = (
        tick: number,
        db: Parameters<typeof runExecutor>[0] = executor,
      ) =>
        runExecutor(db, {
          operation: continuation,
          delivery: createHash("sha256").update(String(tick)).digest("hex"),
          expiresAt: environment.expiresAt,
          sdk: () => sdk,
        });
      const api = liveAdmissionApi(
        executor,
        environment,
        async () => true,
        candidate.bucket,
      );
      const request = (path: string, body: object) =>
        new Request(`https://fixture.invalid${path}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${environment.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
      const preview = await api.fetch(request("/preview", {}));
      assert.equal(preview.status, 200);
      const plan = await preview.json();
      assert.equal(plan.proposal.bucket.name, candidate.bucket);
      assert.equal(
        (await api.fetch(request("/submit", { preview: plan.preview }))).status,
        202,
      );
      assert.equal((await view()).progress, "executing");
      assert.deepEqual(await run(1), { phase: "object" });
      assert.equal(sdk.value?.name, candidate.bucket);
      assert.equal(sdk.value?.freeformTags?.["berth-operation"], continuation);
      assert.equal(sdk.creates, 1);
      assert.deepEqual(await run(1), { phase: "duplicate" });
      assert.equal(sdk.creates, 1);

      let withdrewBetweenReservationAndSend = false;
      await run(2, {
        async query(text, parameters) {
          if (text.includes("berth_executor.confirm_retry_dispatch")) {
            await owner.query("SELECT berth_retry.withdraw_continuation($1)", [
              candidate.operation,
            ]);
            withdrewBetweenReservationAndSend = true;
          }
          return executor.query(text, parameters);
        },
      });
      assert.equal(withdrewBetweenReservationAndSend, true);
      assert.equal((await view()).reason, "authorization-withdrawn");
      assert.equal(sdk.puts, 0);
      await run(3);
      assert.equal(sdk.deletes, 1);
      assert.equal(sdk.value, undefined);
      const newSpend = (
        await owner.query(
          "SELECT cleanup_used FROM berth_ledger.trials WHERE operation=$1",
          [continuation],
        )
      ).rows[0]?.cleanup_used;
      assert.ok(newSpend > 0 && newSpend <= 40);
      assert.deepEqual(await saved(), beforeContinuation);
      assert.deepEqual(
        await executorStore(executor).report(candidate.operation),
        originalReport,
      );
    } finally {
      await executor.end();
    }

    await owner.query(
      "UPDATE berth_ledger.trials SET digest=$2 WHERE operation=$1",
      [
        retained.operation,
        "fbbab289f7f94b25736c58be46a994c441fd02552cc6022352e3d86d2fab7c83",
      ],
    );
    assert.equal(
      (await followUp("start", retained.operation))?.result,
      "owned-instance",
    );
    const retainedChild = randomUUID();
    const retainedStart = Date.now() - 1000;
    await owner.query(
      "SELECT berth_retry.prepare_continuation($1,$2,$3,$4,$5)",
      [
        retained.operation,
        retainedChild,
        new Date(retainedStart),
        binding,
        freePolicyFixture(retainedChild, retainedStart, scope.region),
      ],
    );
    const ownedProposal = (
      await runtime.query(
        "SELECT berth_retry.continuation_status($1) AS value",
        [retained.operation],
      )
    ).rows[0]?.value;
    assert.equal(ownedProposal.stage, "waiting-for-approval");
    assert.ok(ownedProposal.target.instance);
    assert.deepEqual(ownedProposal.steps, [
      "upload-fixture",
      "verify-and-remove-fixture",
    ]);
    assert.equal(
      (
        await runtime.query(
          "SELECT berth_retry.approve_continuation($1,$2) AS value",
          [retained.operation, retainedChild],
        )
      ).rows[0]?.value.continuation,
      retainedChild,
    );
    const reusedRuntime = new Client({
      ...settings,
      user: "berth_runtime",
      password: "test-runtime-only",
    });
    await reusedRuntime.connect();
    try {
      const sdk = new FakeObjects();
      const initialBucket = await sdk.createBucket(
        createProposal({ ...scope, ...retained }),
      );
      sdk.value = {
        ...initialBucket.bucket,
        id: `ocid1.bucket.oc1..retryFixture${retained.operation.replaceAll("-", "")}`,
        etag: "fixture-revision",
      };
      // A limited owner-reviewed read fixture supplies activation proof. Dispatch
      // itself inspects the provider ID, revision, and old ownership tags.
      const env = {
        ...binding,
        operation: retainedChild,
        startedAt: retainedStart,
        expiresAt: retainedStart + 14400000,
        token: "t".repeat(40),
        previewKey: "v".repeat(40),
        privateKey: "unused-by-synthetic-provider",
        connection: "unused",
      };
      const api = liveAdmissionApi(
        reusedRuntime,
        env,
        async () => true,
        retained.bucket,
      );
      const submit = (path: string, body: object) =>
        api.fetch(
          new Request(`https://fixture.invalid${path}`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${env.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          }),
        );
      const proposed = await submit("/preview", {});
      assert.equal(proposed.status, 200);
      assert.equal(
        (await submit("/submit", { preview: (await proposed.json()).preview }))
          .status,
        202,
      );
      const run = (tick: number) =>
        runExecutor(reusedRuntime, {
          operation: retainedChild,
          expiresAt: env.expiresAt,
          delivery: createHash("sha256")
            .update(`retained:${tick}`)
            .digest("hex"),
          sdk: () => sdk,
        });
      assert.deepEqual(await run(1), { phase: "cleanup" });
      assert.equal(sdk.puts, 1);
      assert.deepEqual(await run(2), { phase: "terminal" });
      assert.equal(sdk.objectDeletes, 1);
      assert.equal(
        sdk.creates,
        1,
        "only the original fixture creates the bucket",
      );
      assert.equal(
        sdk.deletes,
        0,
        "the approved scope preserves the original bucket",
      );
      assert.equal(
        sdk.value.freeformTags?.["berth-operation"],
        retained.operation,
      );
    } finally {
      await reusedRuntime.end();
    }

    const missed = await seed();
    await owner.query(
      "UPDATE berth_ledger.trials SET digest=$2 WHERE operation=$1",
      [
        missed.operation,
        "fbbab289f7f94b25736c58be46a994c441fd02552cc6022352e3d86d2fab7c83",
      ],
    );
    assert.equal(
      (await followUp("start", missed.operation))?.result,
      "safe-write-needed",
    );
    const missedChild = randomUUID(),
      missedStart = Date.now() - 1000;
    await owner.query(
      "SELECT berth_retry.prepare_continuation($1,$2,$3,$4,$5)",
      [
        missed.operation,
        missedChild,
        new Date(missedStart),
        binding,
        freePolicyFixture(missedChild, missedStart, scope.region),
      ],
    );
    await runtime.query("SELECT berth_retry.approve_continuation($1,$2)", [
      missed.operation,
      missedChild,
    ]);
    await assert.rejects(
      runtime.query("SELECT berth_retry.close_unactivated($1)", [
        missed.operation,
      ]),
      { code: "42501" },
    );
    const closeDormant = async () =>
      (
        await owner.query(
          "SELECT berth_retry.close_unactivated($1) AS closed",
          [missed.operation],
        )
      ).rows[0]?.closed;
    assert.equal(await closeDormant(), false);
    await owner.query(
      "UPDATE berth_ledger.trials SET started_at=now()-interval '6 minutes' WHERE operation=$1",
      [missedChild],
    );
    assert.equal(await closeDormant(), true);
    const missedApproval = (
      await runtime.query(
        "SELECT berth_retry.approve_continuation($1,$2) AS value",
        [missed.operation, missedChild],
      )
    ).rows[0]?.value;
    assert.equal(missedApproval.continuation, missedChild);
    assert.equal(missedApproval.reason, "activation-expired");

    const timely = await seed("open");
    assert.equal(
      (await followUp("start", timely.operation))?.scope,
      "original-window",
    );
    assert.equal(
      (await followUp("status", timely.operation))?.result,
      "safe-write-needed",
    );
    await owner.query(
      "UPDATE berth_ledger.trials SET outcome='failed' WHERE operation=$1",
      [timely.operation],
    );
    const timelyMeter = await owner.query(
      "SELECT normal_used,cleanup_used FROM berth_ledger.trials WHERE operation=$1",
      [timely.operation],
    );
    assert.deepEqual(timelyMeter.rows[0], { normal_used: 6, cleanup_used: 8 });
    const exhausted = await seed("open");
    await owner.query(
      "UPDATE berth_ledger.trials SET normal_used=160 WHERE operation=$1",
      [exhausted.operation],
    );
    const beforeBudgetStop = calls;
    const limited = await followUp("start", exhausted.operation);
    assert.equal(limited?.reason, "normal-budget-exhausted");
    assert.equal(limited?.checks.used, 0);
    assert.equal(calls, beforeBudgetStop);
    await owner.query(
      "UPDATE berth_ledger.trials SET outcome='failed' WHERE operation=$1",
      [exhausted.operation],
    );
    const cleanup = await seed("cleanup");
    const beforeStop = calls;
    const stopped = await followUp("start", cleanup.operation);
    assert.equal(stopped?.reason, "cleanup-started");
    assert.equal(stopped?.checks.used, 0);
    assert.equal(calls, beforeStop);
  } finally {
    await runtime.end();
    try {
      await owner.query("ROLLBACK");
      for (const schema of [
        "berth_retry",
        "berth_inventory",
        "berth_usage",
        "berth_executor",
        "berth_ledger",
      ])
        await owner.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.query(
        "DROP ROLE IF EXISTS berth_retry_runtime, berth_retry_action, berth_inventory_reader, berth_inventory_recorder",
      );
    } finally {
      await Promise.all([admin.end(), owner.end()]);
    }
  }
});
