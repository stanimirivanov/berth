import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { first, item, second } from "./history-fixture";
import { inventoryPage, verified } from "./inventory-fixture";

test("the read-only browser artifact opens retained reads without Retry provisioning", async ({
  page,
}) => {
  const clean = {
    ...item(second),
    outcome: "failed",
    unresolved: { requests: 0, mutations: 0 },
  };
  const reads: string[] = [];
  const token = "h".repeat(40);
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    expect(url.origin).toBe(new URL(page.url()).origin);
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
    reads.push(url.pathname);
    if (url.pathname === "/api/inventory") {
      await route.fulfill({ json: inventoryPage([verified]) });
    } else if (url.pathname === "/api/inventory/oci-storage") {
      await route.fulfill({
        json: { attemptedAt: null, gap: null, reading: null },
      });
    } else if (url.pathname === "/api/history") {
      await route.fulfill({
        json: { items: [item(first), clean], next: null },
      });
    } else if (url.pathname === `/api/history/${first}`) {
      await route.fulfill({ json: item(first) });
    } else if (url.pathname === `/api/history/${second}`) {
      await route.fulfill({ json: clean });
    } else {
      await route.fulfill({ status: 404 });
    }
  });

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Infrastructure" }),
  ).toBeVisible();
  await page.getByLabel("Owner access token").fill(token);
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(
    page.getByRole("heading", { name: "Alpha bucket" }),
  ).toBeVisible();

  await expect(
    page
      .getByRole("region", { name: "Usage and free-plan headroom" })
      .getByLabel("Refresh usage from summary"),
  ).toBeVisible();

  await expect(
    page.getByRole("region", { name: "OCI Object Storage allowance" }),
  ).toContainText("Unknown");

  const response = await page.goto(`/operations/${first}`);
  expect(response?.status()).toBe(200);
  expect(response?.headers()["content-security-policy"]).toContain(
    "style-src 'self' 'sha256-",
  );
  await expect(
    page.getByRole("heading", { name: "Operation history" }),
  ).toBeVisible();
  await expect(page.getByLabel("History access token")).toBeVisible();
  await expect(page.getByRole("region", { name: "History access" })).toHaveCSS(
    "border-top-width",
    "1px",
  );
  expect(reads.toSorted()).toEqual([
    "/api/inventory",
    "/api/inventory/oci-storage",
  ]);
  await page.getByLabel("History access token").fill(token);
  await page.getByRole("button", { name: "Load history" }).click();
  await expect(
    page.getByRole("link", { name: new RegExp(first) }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Recorded lifecycle state" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry provisioning" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Attention reasons" }).getByRole("link", {
      name: "Owner recovery evidence checks",
    }),
  ).toBeVisible();

  await page.getByRole("link", { name: new RegExp(second) }).click();
  await expect(
    page.getByRole("region", { name: "Selected operation" }),
  ).toContainText(second);
  await expect(page.getByRole("region", { name: "Retry access" })).toHaveCount(
    0,
  );
  expect(reads.toSorted()).toEqual([
    "/api/history",
    `/api/history/${first}`,
    `/api/history/${second}`,
    "/api/inventory",
    "/api/inventory/oci-storage",
  ]);
});

test("the staged Pages root publishes only History and Inventory Functions", async () => {
  const root = resolve(import.meta.dirname, "../dist/read-only");
  const files = await Promise.all(
    ["functions", "edge", "contracts"].map(async (directory) => {
      const entries = await readdir(join(root, directory), {
        recursive: true,
        withFileTypes: true,
      });
      return entries
        .filter((entry) => !entry.isDirectory())
        .map((entry) => relative(root, join(entry.parentPath, entry.name)));
    }),
  );
  expect(files.flat().sort()).toEqual([
    "contracts/oci-storage.ts",
    "edge/history-proxy.ts",
    "edge/inventory-page.ts",
    "edge/inventory-proxy.ts",
    "edge/oci-storage-proxy.ts",
    "edge/read-proxy.ts",
    "functions/api/history/[[rest]].ts",
    "functions/api/history/[operation].ts",
    "functions/api/history/index.ts",
    "functions/api/inventory/[[rest]].ts",
    "functions/api/inventory/index.ts",
    "functions/api/inventory/oci-storage.ts",
  ]);
  expect(
    JSON.parse(await readFile(join(root, "browser/_routes.json"), "utf8")),
  ).toEqual({
    version: 1,
    include: [
      "/api/history",
      "/api/history/*",
      "/api/inventory",
      "/api/inventory/*",
    ],
    exclude: [],
  });

  expect(await readFile(join(root, "contracts/oci-storage.ts"), "utf8")).toBe(
    await readFile(
      resolve(import.meta.dirname, "../../contracts/oci-storage.ts"),
      "utf8",
    ),
  );

  const assets = await readdir(join(root, "browser"), { recursive: true });
  const scripts = assets.filter((asset) => asset.endsWith(".js"));
  expect(scripts.length).toBeGreaterThan(0);
  for (const script of scripts) {
    const bundle = await readFile(join(root, "browser", script), "utf8");
    expect(/Retry provisioning|Retry access|\/api\/retry/.test(bundle)).toBe(
      false,
    );
  }
});
