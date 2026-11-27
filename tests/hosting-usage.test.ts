import assert from "node:assert/strict";
import { test } from "node:test";
import { readUsageSnapshot } from "../ui/src/infrastructure/hosting-usage-contract.ts";
import {
  applyUsageSnapshot,
  hostingUsageRows,
} from "../ui/src/infrastructure/hosting-usage-model.ts";

const origin = "https://berth.example";
const observedAt = "2026-11-30T22:00:00.000Z";
const now = Date.parse(observedAt);
const projectPeriod = {
  start: "2026-11-01T00:00:00.000Z",
  end: "2026-12-01T00:00:00.000Z",
};

function snapshot(
  metrics: unknown,
  generatedAt = observedAt,
  target = "a".repeat(64),
) {
  return readUsageSnapshot(
    { version: 1, origin, target, generatedAt, metrics },
    origin,
    Date.parse(generatedAt),
  );
}

function reading(value: number, overrides = {}) {
  return {
    source: "neon-project-api",
    precision: "exact",
    observedAt,
    period: projectPeriod,
    dataThrough: null,
    value,
    ...overrides,
  };
}

function meter(
  state: ReturnType<typeof applyUsageSnapshot> | null,
  id: string,
  at = now,
) {
  return hostingUsageRows(state, at).find((row) => row.id === id);
}

test("usage decides thresholds on the exact reading, including a verified zero", () => {
  for (const [value, warning, remaining] of [
    [0, null, 100],
    [287_999 / 3600, null, 100 - 287_999 / 3600],
    [80, "Approaching limit", 20],
    [94.999, "Approaching limit", 100 - 94.999],
    [95, "Near limit", 5],
    [99.999, "Near limit", 100 - 99.999],
    [100, "Limit reached", 0],
    [101, "Limit reached", 0],
  ] as const) {
    const state = applyUsageSnapshot(
      null,
      snapshot({ "neon-compute": reading(value) }),
    );
    assert.deepEqual(
      {
        warning: meter(state, "neon-compute")?.warning,
        remaining: meter(state, "neon-compute")?.remaining,
      },
      { warning, remaining },
    );
  }
});

test("usage is current at two hours and expires instantly when either quota period ends", () => {
  const earlier = "2026-11-30T21:59:59.999Z";
  const state = applyUsageSnapshot(
    null,
    snapshot({
      "neon-compute": reading(80),
      "neon-project-storage": reading(0.5, {
        source: "neon-project-console",
        period: null,
        observedAt: earlier,
      }),
    }),
  );
  const twoHours = now + 2 * 60 * 60 * 1_000;
  assert.equal(meter(state, "neon-project-storage", twoHours)?.status, "Stale");
  assert.equal(
    meter(state, "neon-project-storage", twoHours - 1)?.status,
    "Current",
  );
  assert.equal(meter(state, "neon-compute", twoHours - 1)?.remaining, 20);
  assert.equal(meter(state, "neon-compute", twoHours)?.status, "Stale");
  assert.equal(meter(state, "neon-compute", twoHours)?.remaining, null);
  assert.equal(
    meter(state, "neon-compute", twoHours)?.reason,
    "The quota period has ended.",
  );

  const shortlyBeforeMidnight = "2026-11-30T23:59:58.000Z";
  const daily = applyUsageSnapshot(
    null,
    snapshot(
      {
        "cloudflare-requests": reading(0, {
          source: "cloudflare-account-console",
          observedAt: shortlyBeforeMidnight,
          period: {
            start: "2026-11-30T00:00:00.000Z",
            end: "2026-12-01T00:00:00.000Z",
          },
        }),
      },
      shortlyBeforeMidnight,
    ),
  );
  assert.equal(
    meter(daily, "cloudflare-requests", twoHours - 1)?.remaining,
    100_000,
  );
  assert.equal(meter(daily, "cloudflare-requests", twoHours)?.status, "Stale");
  assert.equal(
    meter(daily, "cloudflare-requests", twoHours)?.reading?.value,
    0,
  );
});

test("meter refresh failures and incompatible scopes or periods preserve the prior reading", () => {
  const prior = applyUsageSnapshot(
    null,
    snapshot({
      "neon-compute": reading(90),
      "neon-project-storage": reading(0.5, {
        source: "neon-project-console",
        period: null,
      }),
    }),
  );
  const later = "2026-11-30T22:15:00.000Z";
  const failed = applyUsageSnapshot(
    prior,
    snapshot(
      {
        "neon-compute": { issue: "refresh-failed" },
        "neon-organization-storage": { issue: "scope" },
      },
      later,
    ),
  );
  assert.equal(meter(failed, "neon-compute")?.status, "Stale");
  assert.equal(meter(failed, "neon-compute")?.reading?.value, 90);
  assert.equal(meter(failed, "neon-compute")?.remaining, null);
  assert.equal(meter(failed, "neon-organization-storage")?.status, "Unknown");
  assert.match(
    meter(failed, "neon-organization-storage")?.reason ?? "",
    /target or scope/,
  );
  assert.equal(meter(failed, "neon-project-storage")?.status, "Current");

  assert.throws(() =>
    applyUsageSnapshot(
      prior,
      snapshot({ "neon-compute": reading(0) }, later, "b".repeat(64)),
    ),
  );
  const wrongPeriod = applyUsageSnapshot(
    prior,
    snapshot(
      {
        "neon-compute": reading(0, {
          observedAt: later,
          period: { ...projectPeriod, start: "2026-11-02T00:00:00.000Z" },
        }),
      },
      later,
    ),
  );
  assert.equal(meter(wrongPeriod, "neon-compute")?.reading?.value, 90);
  assert.match(
    meter(wrongPeriod, "neon-compute")?.reason ?? "",
    /quota period/,
  );
  const corrected = applyUsageSnapshot(
    failed,
    snapshot({ "neon-compute": reading(80, { observedAt: later }) }, later),
  );
  assert.equal(
    meter(corrected, "neon-compute", Date.parse(later))?.warning,
    "Approaching limit",
  );
});

test("strict browser validation rejects raw provider fields and unsupported meter figures", () => {
  assert.throws(() =>
    snapshot({ "neon-compute": reading(10, { providerToken: "fixture" }) }),
  );
  assert.throws(() => snapshot({ "neon-transfer": reading(10) }));
  assert.throws(() =>
    snapshot({
      "neon-compute": reading(10, { observedAt: "2026-11-31T22:00:00.000Z" }),
    }),
  );
  assert.equal(meter(null, "neon-transfer")?.status, "Unknown");
  assert.match(
    meter(null, "neon-transfer")?.reason ?? "",
    /Postgres, Object Storage and Functions/,
  );
  assert.match(
    meter(null, "neon-active")?.reason ?? "",
    /verified Free sources/,
  );
});
