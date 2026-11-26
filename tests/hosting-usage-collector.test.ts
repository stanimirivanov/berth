import assert from "node:assert/strict";
import { test } from "node:test";
import { collectHostingUsage } from "../scripts/hosting-usage.ts";

const target = {
  cloudflareAccount: "fixture-account",
  neonOrganization: "org-fixture-01",
  neonProject: "fixture-project-01",
};
const origin = "https://berth.example";
const observedAt = "2026-11-30T23:15:00.000Z";
const clock = () => Date.parse(observedAt);
const fixtureToken = "exampleOperatorCredential";
const project = {
  id: target.neonProject,
  org_id: target.neonOrganization,
  compute_unit_seconds: 287_999,
  consumption_period_start: "2026-11-01T00:00:00Z",
  consumption_period_end: "2026-12-01T00:00:00Z",
  owner: { email: "fixture@example.invalid" },
  data_transfer_bytes: 10,
};

test("the owner collector reads one fixed Neon project and exports only converted advisory evidence", async () => {
  let sends = 0;
  const snapshot = await collectHostingUsage(
    { origin, target, metrics: {} },
    {
      clock,
      neonKey: fixtureToken,
      send: async (url, init) => {
        sends++;
        assert.equal(
          url,
          "https://console.neon.tech/api/v2/projects/fixture-project-01",
        );
        assert.equal(init?.method, "GET");
        assert.equal(init.redirect, "error");
        assert.equal(
          new Headers(init.headers).get("authorization"),
          `Bearer ${fixtureToken}`,
        );
        assert.ok(init.signal);
        return Response.json({ project, sample: fixtureToken });
      },
    },
  );
  assert.equal(sends, 1);
  assert.deepEqual(snapshot.metrics["neon-compute"], {
    source: "neon-project-api",
    value: 287_999 / 3600,
    precision: "exact",
    period: {
      start: "2026-11-01T00:00:00.000Z",
      end: "2026-12-01T00:00:00.000Z",
    },
    observedAt,
    dataThrough: null,
  });
  assert.equal(snapshot.generatedAt, observedAt);
  assert.match(snapshot.target, /^[a-f0-9]{64}$/);
  for (const privateValue of [
    ...Object.values(target),
    fixtureToken,
    "fixture@example.invalid",
    "data_transfer_bytes",
  ]) {
    assert.ok(!JSON.stringify(snapshot).includes(privateValue));
  }
});

test("dated Console evidence requires exact target, meter scope and usable display precision", async () => {
  const row = (
    forTarget: string,
    unit: string,
    source: string,
    value: number,
    precision: string,
  ) => ({
    target: forTarget,
    unit,
    source,
    value,
    precision,
    observedAt,
  });
  const snapshot = await collectHostingUsage(
    {
      origin,
      target,
      metrics: {
        "cloudflare-requests": row(
          target.cloudflareAccount,
          "requests",
          "cloudflare-account-console",
          0,
          "exact",
        ),
        "neon-compute": {
          ...row(
            target.neonProject,
            "CU-hours",
            "neon-project-console",
            12,
            "exact",
          ),
          period: {
            start: "2026-11-01T00:00:00.000Z",
            end: "2026-12-01T00:00:00.000Z",
          },
          dataThrough: "2026-11-30T22:55:00.000Z",
        },
        "neon-project-storage": row(
          target.neonProject,
          "GB",
          "neon-project-console",
          0.9,
          "rounded",
        ),
        "neon-organization-storage": row(
          target.neonOrganization,
          "GB",
          "neon-project-console",
          0.9,
          "exact",
        ),
      },
    },
    {
      clock,
      neonKey: null,
      send: () => {
        throw Error("Console-only collection dispatched a request");
      },
    },
  );
  assert.equal(
    snapshot.metrics["cloudflare-requests"] &&
      "value" in snapshot.metrics["cloudflare-requests"] &&
      snapshot.metrics["cloudflare-requests"].value,
    0,
  );
  assert.equal(
    snapshot.metrics["neon-compute"] &&
      "dataThrough" in snapshot.metrics["neon-compute"] &&
      snapshot.metrics["neon-compute"].dataThrough,
    "2026-11-30T22:55:00.000Z",
  );
  assert.deepEqual(snapshot.metrics["neon-project-storage"], {
    issue: "precision",
  });
  assert.deepEqual(snapshot.metrics["neon-organization-storage"], {
    issue: "scope",
  });
});

test("unexpected, failed, large and wrong-period Neon responses fail without leaking provider details", async () => {
  for (const [response, issue] of [
    [
      () =>
        Response.json({
          project: {
            ...project,
            compute_unit_seconds: undefined,
            active_time_seconds: 0,
          },
        }),
      "unsupported",
    ],
    [
      () => Response.json({ project: { ...project, org_id: "org-wrong" } }),
      "scope",
    ],
    [
      () =>
        Response.json({
          project: {
            ...project,
            consumption_period_end: "2026-11-30T23:15:00Z",
          },
        }),
      "period",
    ],
    [
      () => Response.json({ error: fixtureToken }, { status: 503 }),
      "refresh-failed",
    ],
    [() => new Response(fixtureToken.repeat(4_000)), "refresh-failed"],
    [
      () => {
        throw Error(fixtureToken);
      },
      "refresh-failed",
    ],
  ] as const) {
    const result = await collectHostingUsage(
      { origin, target, metrics: {} },
      {
        clock,
        neonKey: fixtureToken,
        send: async () => response(),
      },
    );
    assert.deepEqual(result.metrics["neon-compute"], { issue });
    assert.ok(!JSON.stringify(result).includes(fixtureToken));
  }

  const supported = await collectHostingUsage(
    { origin, target, metrics: {} },
    {
      clock,
      neonKey: fixtureToken,
      send: async () =>
        Response.json({
          project: {
            ...project,
            compute_unit_seconds: undefined,
            compute_time_seconds: 0,
          },
        }),
    },
  );
  assert.deepEqual(supported.metrics["neon-compute"], {
    source: "neon-project-api",
    precision: "exact",
    value: 0,
    observedAt,
    dataThrough: null,
    period: {
      start: "2026-11-01T00:00:00.000Z",
      end: "2026-12-01T00:00:00.000Z",
    },
  });
});
