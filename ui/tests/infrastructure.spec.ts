import { expect, test } from "@playwright/test";
import { first, item } from "./history-fixture";
import { inventoryPage, uncertain, verified } from "./inventory-fixture";

test("Infrastructure shows the catalog before access and links retained instances to History on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const beta = {
    ...verified,
    instance: "10000000-0000-4000-8000-000000000003",
    displayName: "Beta bucket",
  };
  let reads = 0;
  await page.route("**/api/inventory**", (route) => {
    reads++;
    expect(route.request().headers().authorization).toBe(
      `Bearer ${"h".repeat(40)}`,
    );
    return route.fulfill({
      json: {
        offering: "oci-object-storage-bucket",
        coverage: "incomplete",
        items: [beta, verified, uncertain],
        next: null,
      },
    });
  });
  await page.route("**/api/history**", (route) =>
    route.fulfill({
      json:
        new URL(route.request().url()).pathname === "/api/history"
          ? { items: [item(first)], next: null }
          : item(first),
    }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "OCI Object Storage bucket" }),
  ).toBeVisible();
  expect(reads).toBe(0);
  await page.getByLabel("Owner access token").fill("h".repeat(40));
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByText("Inventory coverage incomplete")).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "OCI Object Storage bucket" })
      .getByRole("heading", { level: 3 }),
  ).toHaveText(["Zeta bucket", "Alpha bucket", "Beta bucket"]);
  await expect(page.getByText("Deletion remains unresolved.")).toBeVisible();
  await expect(page.getByText("No known instances")).toHaveCount(0);
  await expect(
    page.getByText("Not yet available", { exact: true }),
  ).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  const review = page.getByRole("link", {
    name: "Review operation for Zeta bucket",
  });
  await expect(review).toHaveCSS("border-top-width", "1px");
  await review.click();
  await expect(page).toHaveURL(new RegExp(`/operations/${first}$`));
  await expect(page.getByLabel("History access token")).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Selected operation" }),
  ).toContainText(first);
  expect(reads).toBe(1);
});

test("Infrastructure preserves rows on paging and refresh failures and reconciles a completed read", async ({
  page,
}) => {
  const after = verified.instance;
  const responses = [
    { json: inventoryPage([verified], after) },
    { status: 503 },
    { json: inventoryPage([uncertain]) },
    { status: 503 },
    { json: inventoryPage([verified], after) },
    { json: inventoryPage([], null, "incomplete") },
    { json: inventoryPage([]) },
  ];
  const cursors: (string | null)[] = [];
  await page.route("**/api/inventory**", (route) => {
    cursors.push(new URL(route.request().url()).searchParams.get("after"));
    const response = responses.shift();
    expect(response).toBeDefined();
    return route.fulfill(response ?? { status: 500 });
  });
  await page.route("**/api/history**", (route) =>
    route.fulfill({
      json:
        new URL(route.request().url()).pathname === "/api/history"
          ? { items: [item(first)], next: null }
          : item(first),
    }),
  );
  await page.goto("/");
  await page.getByLabel("Owner access token").fill("h".repeat(40));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: verified.displayName }),
  ).toBeVisible();
  const stamp = page.locator(".fetched time");
  const fetchedAt = await stamp.getAttribute("datetime");
  expect(fetchedAt).toBeTruthy();
  await page.getByRole("button", { name: "Show more" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "More instances could not be loaded",
  );
  await expect(
    page.getByRole("heading", { name: verified.displayName }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "OCI Object Storage bucket" })
      .getByRole("heading", { level: 3 }),
  ).toHaveText(["Zeta bucket", "Alpha bucket"]);

  await expect(stamp).toHaveAttribute("datetime", fetchedAt ?? "");
  await page.getByRole("button", { name: "Refresh inventory" }).click();
  await expect(page.getByRole("alert")).toContainText("may be out of date");
  await expect(stamp).toHaveAttribute("datetime", fetchedAt ?? "");
  await expect(
    page
      .getByRole("region", { name: "OCI Object Storage bucket" })
      .getByRole("heading", { level: 3 }),
  ).toHaveCount(2);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.getByText(
      "Some previously loaded instances have yet to be refreshed.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: uncertain.displayName }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Show more" }).click();
  await expect(
    page.getByRole("heading", { name: uncertain.displayName }),
  ).toHaveCount(0);
  await expect(page.getByText("Inventory coverage incomplete")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: verified.displayName }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Refresh inventory" }).click();
  await expect(page.getByText("No known instances")).toBeVisible();
  expect(cursors).toEqual([null, after, after, null, null, after, null]);
  await page.getByRole("link", { name: "Open operation history" }).click();
  await page.getByRole("link", { name: first }).click();
  await expect(
    page.getByRole("region", { name: "Selected operation" }),
  ).toContainText(first);
});

test("Infrastructure distinguishes loading, unavailable and incomplete empty inventory", async ({
  page,
}) => {
  const firstRead = Promise.withResolvers<void>();
  let reads = 0;
  await page.route("**/api/inventory**", async (route) => {
    reads++;
    if (reads === 1) {
      await firstRead.promise;
      await route.fulfill({ status: 503 });
      return;
    }
    await route.fulfill({ json: inventoryPage([], null, "incomplete") });
  });
  await page.goto("/");
  await page.getByLabel("Owner access token").fill("h".repeat(40));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Loading inventory…");
  await expect(
    page.getByRole("progressbar", { name: "Inventory read progress" }),
  ).toBeVisible();
  await expect(page.getByText("No known instances")).toHaveCount(0);
  firstRead.resolve();
  await expect(page.getByRole("alert")).toContainText("Inventory unavailable");
  await expect(
    page.getByRole("heading", { name: "OCI Object Storage bucket" }),
  ).toBeVisible();
  await expect(page.getByText("No known instances")).toHaveCount(0);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("Inventory coverage incomplete")).toBeVisible();
  await expect(page.getByText("No known instances")).toHaveCount(0);
});

for (const deniedStatus of [401, 403]) {
  test(`Inventory ${deniedStatus} clears both feature snapshots`, async ({
    page,
  }) => {
    let inventoryReads = 0;
    await page.route("**/api/inventory**", (route) => {
      inventoryReads++;
      return route.fulfill(
        inventoryReads === 1
          ? { json: inventoryPage([verified]) }
          : { status: deniedStatus },
      );
    });
    await page.route("**/api/history**", (route) =>
      route.fulfill({ json: { items: [item(first)], next: null } }),
    );
    await page.goto("/operations");
    await page.getByLabel("History access token").fill("h".repeat(40));
    await page.getByRole("button", { name: "Load history" }).click();
    await expect(page.getByRole("link", { name: first })).toBeVisible();
    await page
      .getByRole("link", { name: "Infrastructure", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: verified.displayName }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Refresh inventory" }).click();
    await expect(
      page.getByRole("heading", { name: verified.displayName }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "OCI Object Storage bucket" }),
    ).toBeVisible();
    if (deniedStatus === 401) {
      await expect(page.getByLabel("Owner access token")).toBeVisible();
    } else {
      await expect(page.getByRole("alert")).toContainText(
        "configured Berth URL",
      );
    }
    await page.getByRole("link", { name: "Open operation history" }).click();
    await expect(page.getByRole("link", { name: first })).toHaveCount(0);
    if (deniedStatus === 401) {
      await expect(page.getByLabel("History access token")).toBeVisible();
    } else {
      await expect(
        page.getByRole("region", { name: "History access" }).getByRole("alert"),
      ).toContainText("configured Berth URL");
    }
  });
}
