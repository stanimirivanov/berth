import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { inventoryPage, verified } from "./inventory-fixture";

const observedAt = "2026-11-28T14:12:00.000Z";
const respondedAt = "2026-11-28T14:01:00.000Z";
const cutoffAt = "2026-11-28T14:00:00.000Z";
const expiresAt = "2026-11-28T16:00:00.000Z";
const token = "h".repeat(40);

function storageReading(usedBytes = 4_000_000_000) {
  return {
    attemptedAt: observedAt,
    gap: null,
    reading: {
      usedBytes,
      limitBytes: 20_000_000_000,
      observedAt,
      respondedAt,
      accountingCutoff: cutoffAt,
      expiresAt,
      source: "OCI",
    },
  };
}

function storagePanel(page: Page) {
  return page.getByRole("region", { name: "OCI Object Storage allowance" });
}

function collectionStatus(page: Page) {
  return page
    .getByRole("region", { name: "OCI allowances", exact: true })
    .getByRole("status")
    .filter({ hasText: /^Collection / });
}

function refreshAllowances(page: Page) {
  return page.getByRole("button", { name: "Refresh OCI allowances" });
}

async function connect(page: Page) {
  await page.getByLabel("Owner access token").fill(token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
}

async function openInfrastructure(page: Page) {
  await page.clock.install({ time: new Date(observedAt) });
  await page.route(/\/api\/inventory\?/, (route) =>
    route.fulfill({ json: inventoryPage([verified]) }),
  );
  await page.goto("/");
}

test("Infrastructure shows a saved tenancy-wide OCI storage reading after Owner access", async ({
  page,
}) => {
  let requests = 0;
  await page.route("**/api/inventory/oci-storage", (route) => {
    requests++;
    expect(route.request().method()).toBe("GET");
    expect(new URL(route.request().url()).origin).toBe(
      new URL(page.url()).origin,
    );
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
    return route.fulfill({ json: storageReading() });
  });
  await openInfrastructure(page);
  const storage = storagePanel(page);
  await expect(storage).toHaveCount(0);
  expect(requests).toBe(0);

  await connect(page);
  await expect(storage.getByText("Current", { exact: true })).toBeVisible();
  await expect(storage.getByText("4 GB", { exact: true })).toBeVisible();
  await expect(storage.getByText("16 GB", { exact: true })).toBeVisible();
  await expect(storage.getByText("OCI", { exact: true })).toBeVisible();
  await expect(storage.locator(`time[datetime="${observedAt}"]`)).toBeVisible();
  await expect(
    storage.locator(`time[datetime="${respondedAt}"]`),
  ).toBeVisible();
  await expect(storage).toContainText("including buckets outside Berth");
  await expect(
    page.getByRole("heading", { name: "Alpha bucket" }),
  ).toBeVisible();
  expect(requests).toBe(1);
});

test("refreshing saved OCI storage shows the highest warning band and floors exhausted headroom at zero", async ({
  page,
}) => {
  let usedBytes = 15_999_999_999;
  await page.route("**/api/inventory/oci-storage", (route) =>
    route.fulfill({ json: storageReading(usedBytes) }),
  );
  await openInfrastructure(page);
  const inventoryReads: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/inventory") {
      inventoryReads.push(request.method());
    }
  });

  const storage = storagePanel(page);
  const refresh = refreshAllowances(page);
  await connect(page);
  await expect(
    storage.getByText("15.999999999 GB", { exact: true }),
  ).toBeVisible();
  await expect(storage.getByText("Approaching limit")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Alpha bucket" }),
  ).toBeVisible();

  usedBytes = 16_000_000_000;
  await refresh.click();
  await expect(
    storage.getByText("Approaching limit (80% threshold reached)"),
  ).toBeVisible();

  usedBytes = 19_000_000_000;
  await refresh.click();
  await expect(
    storage.getByText("Near limit (95% threshold reached)"),
  ).toBeVisible();
  await expect(storage.getByText("Approaching limit")).toHaveCount(0);

  usedBytes = 20_000_000_000;
  await refresh.click();
  await expect(
    storage.getByText("Limit reached (100% threshold reached)"),
  ).toBeVisible();
  await expect(storage.getByText("0 GB", { exact: true })).toBeVisible();

  usedBytes = 21_000_000_000;
  await refresh.click();
  await expect(storage.getByText("21 GB", { exact: true })).toBeVisible();
  await expect(storage.getByText("0 GB", { exact: true })).toBeVisible();
  expect(inventoryReads).toEqual(["GET"]);
});

test("refreshing saved evidence preserves the last observation when coverage is incomplete and expires a current reading", async ({
  page,
}) => {
  let saved: unknown = storageReading(19_000_000_000);
  let unavailable = false;
  await page.route("**/api/inventory/oci-storage", (route) =>
    route.fulfill(unavailable ? { status: 503 } : { json: saved }),
  );
  await openInfrastructure(page);
  await connect(page);
  const storage = storagePanel(page);
  const refresh = refreshAllowances(page);

  await expect(storage.getByText("Current", { exact: true })).toBeVisible();
  await expect(storage.getByText("1 GB", { exact: true })).toBeVisible();
  saved = {
    ...storageReading(19_000_000_000),
    gap: "storage-coverage-unverified",
  };
  await refresh.click();
  await expect(storage.getByText("Stale", { exact: true })).toBeVisible();
  await expect(storage).toContainText(
    "OCI did not return a qualifying tenancy-wide storage byte count.",
  );
  await expect(storage.getByText("19 GB", { exact: true })).toBeVisible();
  await expect(storage.getByText("1 GB", { exact: true })).toHaveCount(0);
  await expect(storage.getByText("Near limit")).toHaveCount(0);

  saved = storageReading();
  await refresh.click();
  await expect(storage.getByText("Current", { exact: true })).toBeVisible();
  unavailable = true;
  await refresh.click();
  await expect(storage.getByText("Stale", { exact: true })).toBeVisible();
  await expect(storage).toContainText(
    "Saved OCI storage evidence could not be read.",
  );
  await expect(storage.getByText("4 GB", { exact: true })).toBeVisible();
  await expect(storage.getByText("16 GB", { exact: true })).toHaveCount(0);

  unavailable = false;
  await refresh.click();
  await expect(storage.getByText("Current", { exact: true })).toBeVisible();
  await page.clock.fastForward(2 * 60 * 60 * 1000 + 1);
  await expect(storage.getByText("Stale", { exact: true })).toBeVisible();
  await expect(storage).toContainText("The saved OCI reading has expired.");
  await expect(storage.getByText("4 GB", { exact: true })).toBeVisible();
  await expect(storage.getByText("16 GB", { exact: true })).toHaveCount(0);
});

test("returning to Infrastructure reads saved storage again and explains missing qualifying evidence", async ({
  page,
}) => {
  let saved: unknown = { attemptedAt: null, gap: null, reading: null };
  await page.route("**/api/inventory/oci-storage", (route) =>
    route.fulfill({ json: saved }),
  );
  await page.route("**/api/history", (route) =>
    route.fulfill({ json: { items: [], next: null } }),
  );
  await openInfrastructure(page);
  await connect(page);
  const storage = storagePanel(page);
  await expect(storage.getByText("Unknown", { exact: true })).toBeVisible();
  await expect(storage).toContainText(
    "No qualifying OCI storage reading has been saved.",
  );
  await expect(storage.getByText("Remaining allowance")).toHaveCount(0);
  await expect(storage.getByText("0 GB", { exact: true })).toHaveCount(0);

  await page.getByRole("link", { name: "Open operation history" }).click();
  await expect(
    page.getByRole("heading", { name: "Operation history" }),
  ).toBeVisible();
  saved = { attemptedAt: observedAt, gap: "account-unverified", reading: null };
  await page.getByRole("link", { name: "Infrastructure", exact: true }).click();
  await expect(storage.getByText("Unknown", { exact: true })).toBeVisible();
  await expect(storage).toContainText(
    "Always Free account eligibility could not be verified.",
  );
  await expect(storage.locator(`time[datetime="${observedAt}"]`)).toBeVisible();
  await expect(storage.getByText("Remaining allowance")).toHaveCount(0);

  saved = { attemptedAt: observedAt, gap: "oci-unavailable", reading: null };
  await refreshAllowances(page).click();
  await expect(storage).toContainText(
    "OCI could not provide a storage reading.",
  );
});

test("OCI reported bytes without an accounting cutoff leave remaining allowance unknown", async ({
  page,
}) => {
  const observed = storageReading(19_000_000_000);
  await page.route("**/api/inventory/oci-storage", (route) =>
    route.fulfill({
      json: {
        ...observed,
        gap: "accounting-cutoff-unverified",
        reading: { ...observed.reading, accountingCutoff: null },
      },
    }),
  );
  await openInfrastructure(page);
  await connect(page);
  const storage = storagePanel(page);
  await expect(
    storage.getByRole("status").getByText("Unknown", { exact: true }),
  ).toBeVisible();
  await expect(storage.getByText("19 GB", { exact: true })).toBeVisible();
  await expect(
    storage.getByText("Remaining allowance", { exact: true }),
  ).toBeVisible();
  await expect(storage.getByText("Near limit")).toHaveCount(0);
});

test("reported-only bytes stay visible and headroom stays unknown when the observation becomes stale", async ({
  page,
}) => {
  const observed = storageReading(19_000_000_000);
  const reported = {
    ...observed,
    gap: "accounting-cutoff-unverified",
    reading: { ...observed.reading, accountingCutoff: null },
  };
  let saved: unknown = reported;
  let unavailable = false;
  await page.route("**/api/inventory/oci-storage", (route) =>
    route.fulfill(unavailable ? { status: 503 } : { json: saved }),
  );
  await openInfrastructure(page);
  await connect(page);
  const storage = storagePanel(page);
  const refresh = refreshAllowances(page);
  const status = storage.getByRole("status");

  await expect(status.getByText("Unknown", { exact: true })).toBeVisible();
  await expect(storage.getByText("19 GB", { exact: true })).toBeVisible();
  await expect(storage.getByText("Near limit")).toHaveCount(0);

  saved = { ...reported, gap: "oci-unavailable" };
  await refresh.click();
  await expect(status.getByText("Stale", { exact: true })).toBeVisible();
  await expect(status).toContainText(
    "OCI could not provide a storage reading.",
  );
  await expect(storage.getByText("Unknown", { exact: true })).toBeVisible();
  await expect(storage.getByText("19 GB", { exact: true })).toBeVisible();
  await expect(storage.getByText("Near limit")).toHaveCount(0);

  saved = reported;
  await refresh.click();
  await expect(status.getByText("Unknown", { exact: true })).toBeVisible();
  unavailable = true;
  await refresh.click();
  await expect(status.getByText("Stale", { exact: true })).toBeVisible();
  await expect(status).toContainText(
    "Saved OCI storage evidence could not be read.",
  );
  await expect(storage.getByText("Unknown", { exact: true })).toBeVisible();

  unavailable = false;
  await refresh.click();
  await expect(status.getByText("Unknown", { exact: true })).toBeVisible();
  await page.clock.fastForward(2 * 60 * 60 * 1000 + 1);
  await expect(status.getByText("Stale", { exact: true })).toBeVisible();
  await expect(status).toContainText("The saved OCI reading has expired.");
  await expect(storage.getByText("Unknown", { exact: true })).toBeVisible();
  await expect(storage.getByText("19 GB", { exact: true })).toBeVisible();
  await expect(storage.getByText("Near limit")).toHaveCount(0);
});

test("a pending collection keeps its previous observation and becomes stale at its own deadline", async ({
  page,
}) => {
  const attemptedAt = "2026-11-28T14:15:00.000Z";
  const startedAt = "2026-11-28T14:17:00.000Z";
  const overdueAt = "2026-11-28T14:17:10.000Z";
  const previous = storageReading();
  const provenance = {
    lastSettledAttemptAt: observedAt,
    pending: { startedAt, overdueAt },
  };
  let saved: unknown = {
    ...previous,
    attemptedAt,
    provenance,
    monthly: {
      requests: {
        gap: null,
        reading: {
          sku: "B91627",
          used: 40_000,
          source: "OCI Usage API",
          coverage: "complete",
          periodStart: "2026-11-01T00:00:00.000Z",
          periodEnd: "2026-12-01T00:00:00.000Z",
          observedAt,
          respondedAt,
          reportedThrough: cutoffAt,
          accountingCutoff: cutoffAt,
          expiresAt,
        },
      },
      outbound: { gap: "usage-coverage-unverified", reading: null },
    },
  };
  await page.route("**/api/inventory/oci-storage", (route) =>
    route.fulfill({ json: saved }),
  );
  await openInfrastructure(page);
  await connect(page);
  const storage = storagePanel(page);
  const status = storage.getByRole("status");
  const requests = page.getByRole("region", {
    name: "OCI Object Storage API requests",
  });

  await expect(status.getByText("Current", { exact: true })).toBeVisible();
  await expect(requests.getByRole("status")).toContainText("Current");
  await expect(requests).toContainText("10,000 requests");
  await expect(collectionStatus(page)).toContainText("Collection pending.");
  await expect(
    storage.getByText("Previous observation", { exact: true }),
  ).toBeVisible();
  await expect(storage.getByText("16 GB", { exact: true })).toBeVisible();
  await expect(storage.getByText("Last settled collection slot")).toBeVisible();
  await expect(
    storage.locator(`time[datetime="${attemptedAt}"]`),
  ).toBeVisible();
  await expect(storage.locator(`time[datetime="${startedAt}"]`)).toBeVisible();
  await expect(storage.locator(`time[datetime="${cutoffAt}"]`)).toBeVisible();
  await expect(storage.locator(`time[datetime="${expiresAt}"]`)).toBeVisible();

  await page.clock.pauseAt(new Date(startedAt));
  await page.clock.runFor(9_999);
  await expect(collectionStatus(page)).toContainText("Collection pending.");
  await page.clock.runFor(20);
  await expect(collectionStatus(page)).toHaveText("Collection overdue.");
  await expect(status.getByText("Stale", { exact: true })).toBeVisible();
  await expect(requests.getByRole("status")).toContainText("Stale");
  await expect(requests).toHaveAccessibleDescription("Collection overdue.");
  await expect(requests).toContainText("Unknown");
  await expect(requests).not.toContainText("threshold reached");
  await expect(
    storage.getByText("Previous observation", { exact: true }),
  ).toBeVisible();
  await expect(storage.getByText("4 GB", { exact: true })).toBeVisible();
  await expect(storage.getByText("Unknown", { exact: true })).toBeVisible();
  await expect(storage.getByText("16 GB", { exact: true })).toHaveCount(0);
  await expect(storage.locator(`time[datetime="${cutoffAt}"]`)).toBeVisible();
  await expect(storage.locator(`time[datetime="${expiresAt}"]`)).toBeVisible();

  await page.clock.resume();
  saved = {
    ...previous,
    attemptedAt,
    provenance: {
      ...provenance,
      pending: { ...provenance.pending, overdueAt: "2026-11-28T14:18:00.000Z" },
    },
    gap: "accounting-cutoff-unverified",
    reading: {
      ...previous.reading,
      usedBytes: 19_000_000_000,
      accountingCutoff: null,
    },
  };
  await refreshAllowances(page).click();
  await expect(collectionStatus(page)).toContainText("Collection pending.");
  await expect(status.getByText("Unknown", { exact: true })).toBeVisible();
  await expect(storage.getByText("19 GB", { exact: true })).toBeVisible();
  await expect(storage.getByText("Near limit")).toHaveCount(0);
});

test("a new pending slot preserves the stale status of an overdue collection's previous observation", async ({
  page,
}) => {
  const previous = storageReading(19_000_000_000);
  const reading = {
    ...previous.reading,
    accountingCutoff: respondedAt,
    expiresAt: "2026-11-28T16:01:00.000Z",
  };
  const firstClaim = "2026-11-28T15:00:00.000Z";
  const nextClaim = "2026-11-28T16:00:00.000Z";
  let saved: unknown = {
    attemptedAt: firstClaim,
    gap: null,
    reading,
    provenance: {
      lastSettledAttemptAt: observedAt,
      pending: { startedAt: firstClaim, overdueAt: "2026-11-28T15:00:10.000Z" },
    },
  };
  await page.route("**/api/inventory/oci-storage", (route) =>
    route.fulfill({ json: saved }),
  );
  await openInfrastructure(page);
  await connect(page);
  const storage = storagePanel(page);
  const status = storage.getByRole("status");
  await expect(status.getByText("Current", { exact: true })).toBeVisible();
  await expect(storage.getByText("Near limit")).toBeVisible();
  await page.clock.pauseAt(new Date(firstClaim));
  await page.clock.runFor(10_020);
  await expect(collectionStatus(page)).toContainText("Collection overdue.");
  await expect(status.getByText("Stale", { exact: true })).toBeVisible();

  saved = {
    attemptedAt: nextClaim,
    gap: null,
    reading,
    provenance: {
      lastSettledAttemptAt: observedAt,
      pending: {
        startedAt: nextClaim,
        overdueAt: "2026-11-28T16:00:10.000Z",
        previousObservationStale: true,
      },
    },
  };
  await page.clock.setSystemTime(new Date(nextClaim));
  await page.clock.resume();
  await refreshAllowances(page).click();
  await expect(collectionStatus(page)).toContainText("Collection pending.");
  await expect(status.getByText("Stale", { exact: true })).toBeVisible();
  await expect(storage.getByText("Previous observation")).toBeVisible();
  await expect(storage.getByText("19 GB", { exact: true })).toBeVisible();
  await expect(storage.getByText("Unknown", { exact: true })).toBeVisible();
  await expect(storage.getByText("1 GB", { exact: true })).toHaveCount(0);
  await expect(storage.getByText("Near limit")).toHaveCount(0);
  await expect(
    storage.locator(`time[datetime="${reading.expiresAt}"]`),
  ).toBeVisible();
  await expect(storage.getByText("Last settled collection slot")).toBeVisible();
});

test("a legacy unsettled slot shows an unknown outcome without treating prior usage as current", async ({
  page,
}) => {
  const settled = storageReading(19_000_000_000);
  const attemptedAt = "2026-11-28T15:00:00.000Z";
  let saved: unknown = { ...settled, attemptedAt };
  await page.route("**/api/inventory/oci-storage", (route) =>
    route.fulfill({ json: saved }),
  );
  await openInfrastructure(page);
  await connect(page);
  const storage = storagePanel(page);
  const status = storage.getByRole("status");
  const refresh = refreshAllowances(page);

  await expect(collectionStatus(page)).toContainText(
    "Collection outcome unknown.",
  );
  await expect(status.getByText("Stale", { exact: true })).toBeVisible();
  await expect(storage.getByText("Unsettled collection slot")).toBeVisible();
  await expect(storage.getByText("Previous observation")).toBeVisible();
  await expect(storage.getByText("19 GB", { exact: true })).toBeVisible();
  await expect(storage.getByText("Unknown", { exact: true })).toBeVisible();
  await expect(storage.getByText("1 GB", { exact: true })).toHaveCount(0);
  await expect(storage.getByText("Near limit")).toHaveCount(0);

  saved = { attemptedAt, gap: null, reading: null };
  await refresh.click();
  await expect(status.getByText("Unknown", { exact: true })).toBeVisible();
  await expect(collectionStatus(page)).toContainText(
    "Collection outcome unknown.",
  );
  await expect(storage.getByText("Previous observation")).toHaveCount(0);

  saved = settled;
  await refresh.click();
  await expect(status.getByText("Current", { exact: true })).toBeVisible();
  await expect(storage.getByText("1 GB", { exact: true })).toBeVisible();
  await expect(storage.getByText("Near limit")).toBeVisible();
});

test("the storage deadline still takes effect after the browser clock moves backward", async ({
  page,
}) => {
  const attemptedAt = observedAt;
  const overdueAt = "2026-11-28T14:12:10.000Z";
  const previous = storageReading();
  await page.route("**/api/inventory/oci-storage", (route) =>
    route.fulfill({
      json: {
        ...previous,
        attemptedAt,
        provenance: {
          lastSettledAttemptAt: cutoffAt,
          pending: { startedAt: attemptedAt, overdueAt },
        },
      },
    }),
  );
  await openInfrastructure(page);
  await connect(page);
  const storage = storagePanel(page);
  const status = storage.getByRole("status");
  await expect(status.getByText("Current", { exact: true })).toBeVisible();

  await page.clock.pauseAt(new Date("2026-11-28T14:12:05.000Z"));
  await page.clock.setSystemTime(new Date(observedAt));
  await page.clock.runFor(5_020);
  await expect(collectionStatus(page)).toContainText("Collection pending.");

  await page.clock.runFor(5_000);
  await expect(collectionStatus(page)).toContainText("Collection overdue.");
  await expect(status.getByText("Stale", { exact: true })).toBeVisible();
  await expect(storage.getByText("16 GB", { exact: true })).toHaveCount(0);
});

for (const status of [401, 403]) {
  test(`OCI storage access denial ${status} clears the owner session and its protected Infrastructure data`, async ({
    page,
  }) => {
    let denied = false;
    let usedBytes = 4_000_000_000;
    await page.route("**/api/inventory/oci-storage", (route) =>
      route.fulfill(denied ? { status } : { json: storageReading(usedBytes) }),
    );
    await openInfrastructure(page);
    await connect(page);
    const storage = storagePanel(page);
    const inventoryItem = page.getByRole("heading", { name: "Alpha bucket" });
    const hostingRefresh = page.getByLabel("Refresh usage from summary");
    await expect(storage.getByText("4 GB", { exact: true })).toBeVisible();
    await expect(inventoryItem).toBeVisible();
    await expect(hostingRefresh).toBeVisible();

    denied = true;
    await refreshAllowances(page).click();
    await expect(storage).toHaveCount(0);
    await expect(inventoryItem).toHaveCount(0);
    await expect(hostingRefresh).toHaveCount(0);

    if (status === 401) {
      await expect(page.getByRole("alert")).toContainText("Access denied");
      denied = false;
      usedBytes = 8_000_000_000;
      await connect(page);
      await expect(storage.getByText("8 GB", { exact: true })).toBeVisible();
      await expect(storage.getByText("4 GB", { exact: true })).toHaveCount(0);
    } else {
      await expect(page.getByRole("alert")).toContainText(
        "configured Berth URL",
      );
    }
  });
}

test("monthly OCI warnings and rollover are independent from storage and transfer", async ({
  page,
}) => {
  const checkTime = "2026-11-30T23:55:00.000Z";
  const periodStart = "2026-11-01T00:00:00.000Z";
  const periodEnd = "2026-12-01T00:00:00.000Z";
  const cutoff = "2026-11-30T23:54:00.000Z";
  let used = 39_999;
  let qualifiedOutbound = false;
  let lastReadMethod = "";
  await page.clock.install({ time: new Date(checkTime) });
  await page.route(/\/api\/inventory\?/, (route) =>
    route.fulfill({ json: inventoryPage([verified]) }),
  );
  await page.route("**/api/inventory/oci-storage", (route) => {
    lastReadMethod = route.request().method();
    const storage = storageReading();
    const hasCutoff = {
      source: "OCI Usage API",
      coverage: "complete",
      periodStart,
      periodEnd,
      observedAt: checkTime,
      respondedAt: checkTime,
      reportedThrough: cutoff,
      accountingCutoff: cutoff,
      expiresAt: periodEnd,
    };
    return route.fulfill({
      json: {
        attemptedAt: checkTime,
        gap: null,
        reading: {
          ...storage.reading,
          observedAt: checkTime,
          respondedAt: checkTime,
          accountingCutoff: cutoff,
          expiresAt: "2026-12-01T01:00:00.000Z",
        },
        monthly: {
          requests: {
            gap: qualifiedOutbound ? "oci-unavailable" : null,
            reading: { ...hasCutoff, sku: "B91627", used },
          },
          outbound: qualifiedOutbound
            ? {
                gap: null,
                reading: { ...hasCutoff, sku: "B88327", used: 9_500_000 },
              }
            : { gap: "usage-coverage-unverified", reading: null },
        },
      },
    });
  });
  await page.goto("/");
  await connect(page);

  const storage = storagePanel(page);
  const requests = page.getByRole("region", {
    name: "OCI Object Storage API requests",
  });
  const outbound = page.getByRole("region", { name: "OCI outbound transfer" });
  await expect(storage.getByRole("status")).toContainText("Current");
  await expect(requests.getByRole("status")).toContainText("Current");
  await expect(outbound.getByRole("status")).toContainText("Unknown");
  await expect(outbound).toContainText("Advisory");
  await expect(requests).toContainText("10,001 requests");
  await expect(requests).not.toContainText("threshold reached");
  await expect(
    requests.locator(`time[datetime="${periodStart}"]`),
  ).toBeVisible();
  const refresh = refreshAllowances(page);
  for (const [amount, band] of [
    [40_000, 80],
    [47_500, 95],
    [50_000, 100],
  ]) {
    used = amount;
    await refresh.click();
    await expect(requests).toContainText(`${band}% threshold reached`);
  }
  qualifiedOutbound = true;
  await refresh.click();
  await expect(outbound.getByRole("status")).toContainText("Current");
  await expect(outbound).toContainText("North America, Europe and UK");
  await expect(outbound).toContainText("500 GB");
  await expect(outbound).toContainText("95% threshold reached");
  await expect(requests.getByRole("status")).toContainText("Stale");
  await expect(requests).not.toContainText("threshold reached");
  expect(lastReadMethod).toBe("GET");
  await page.clock.fastForward(5 * 60_000);
  await expect(requests.getByRole("status")).toContainText("Stale");
  await expect(requests).toContainText("Previous billing period");
  await expect(requests).not.toContainText("threshold reached");
  await expect(storage.getByRole("status")).toContainText("Current");
  await expect(outbound.getByRole("status")).toContainText("Stale");
  await expect(outbound).not.toContainText("threshold reached");
});
