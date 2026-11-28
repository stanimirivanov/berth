import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { inventoryPage, verified } from "./inventory-fixture";

const observedAt = "2026-11-28T14:12:00.000Z";
const respondedAt = "2026-11-28T14:00:00.000Z";
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
      accountingCutoff: respondedAt,
      expiresAt,
      source: "OCI",
    },
  };
}

function storagePanel(page: Page) {
  return page.getByRole("region", { name: "OCI Object Storage allowance" });
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
  const refresh = storage.getByRole("button", { name: "Refresh OCI storage" });
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
  const refresh = storage.getByRole("button", { name: "Refresh OCI storage" });

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
  await storage.getByRole("button", { name: "Refresh OCI storage" }).click();
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
  await expect(storage.getByText("Unknown", { exact: true })).toBeVisible();
  await expect(storage.getByText("19 GB", { exact: true })).toBeVisible();
  await expect(
    storage.getByText("Remaining allowance", { exact: true }),
  ).toHaveCount(0);
  await expect(storage.getByText("Near limit")).toHaveCount(0);
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
    await storage.getByRole("button", { name: "Refresh OCI storage" }).click();
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
