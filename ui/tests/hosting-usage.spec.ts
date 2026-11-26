import { expect, test } from "@playwright/test";
import { inventoryPage, verified } from "./inventory-fixture";

const observedAt = "2026-11-28T14:12:00.000Z";

test("Infrastructure imports owner-only hosting readings and keeps Inventory usable through refresh and expiry", async ({
  page,
}) => {
  const reads: string[] = [];
  await page.clock.install({ time: new Date(observedAt) });
  await page.route("**/api/**", (route) => {
    reads.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: inventoryPage([verified]) });
  });
  await page.goto("/");
  const usage = page.getByRole("region", {
    name: "Usage and free-plan headroom",
  });
  const input = usage.getByLabel("Refresh usage from summary");
  await expect(input).toHaveCount(0);
  await page.getByLabel("Owner access token").fill("h".repeat(40));
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(input).toBeVisible();
  await expect(usage.getByText("Unknown", { exact: true })).toHaveCount(8);

  const summary = {
    version: 1,
    origin: new URL(page.url()).origin,
    target: "b".repeat(64),
    generatedAt: observedAt,
    metrics: {
      "cloudflare-requests": {
        value: 95_000,
        precision: "exact",
        source: "cloudflare-account-console",
        observedAt,
        dataThrough: "2026-11-28T14:10:00.000Z",
        period: {
          start: "2026-11-28T00:00:00.000Z",
          end: "2026-11-29T00:00:00.000Z",
        },
      },
      "neon-project-storage": {
        value: 0.81,
        precision: "upper-bound",
        source: "neon-project-console",
        observedAt,
        dataThrough: null,
        period: null,
      },
    },
  };
  const file = (body: unknown) => ({
    name: "usage.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(body)),
  });

  await input.setInputFiles(file(summary));
  await expect(usage.getByText("Near limit", { exact: true })).toBeVisible();
  await expect(
    usage.getByText("5,000 requests", { exact: true }),
  ).toBeVisible();
  await expect(usage.getByText("Owner-recorded", { exact: false })).toHaveCount(
    2,
  );
  await expect(
    usage.getByText("Approaching limit (based on upper bound)"),
  ).toBeVisible();
  await expect(usage.getByText("Data through", { exact: true })).toBeVisible();
  await expect(
    usage.getByText("Across Postgres, Object Storage and Functions", {
      exact: false,
    }),
  ).toBeVisible();

  await input.setInputFiles(
    file({
      ...summary,
      generatedAt: observedAt,
      metrics: { "cloudflare-requests": { issue: "refresh-failed" } },
    }),
  );
  await expect(usage.getByText("Stale", { exact: true })).toBeVisible();
  await expect(
    usage.getByText("95,000 requests", { exact: true }),
  ).toBeVisible();
  await expect(usage.getByText("5,000 requests", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("heading", { name: "Alpha bucket" }),
  ).toBeVisible();
  expect(reads).toEqual(["/api/inventory"]);

  await page.clock.fastForward(2 * 60 * 60 * 1000 + 1);
  await expect(usage.getByText("Stale", { exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(input).toHaveCount(0);
  await expect(usage.getByText("95,000 requests", { exact: true })).toHaveCount(
    0,
  );
});
