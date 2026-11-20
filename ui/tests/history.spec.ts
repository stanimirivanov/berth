import { expect, test } from "@playwright/test";

const first = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  second = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const item = (operation: string) => ({
  operation,
  startedAt: "2026-11-20T06:50:00Z",
  expiresAt: "2026-11-20T10:50:00Z",
  outcome: "needs-reconciliation",
  phase: "cleanup",
  pendingUpload: true,
  cleanupRequested: true,
  objectRemoved: false,
  verdict: "partial",
  budgets: {
    normal: { used: 15, limit: 160 },
    cleanup: { used: 14, limit: 40 },
    monitoring: { used: 0, limit: 20 },
    neon: { used: 7, limit: 100 },
  },
  unresolved: { requests: 1, mutations: 1 },
});

test("history supports authenticated pagination, selection, retained expiry, keyboard access and memory-only credentials", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/history**", async (route) => {
    expect(route.request().headers().authorization).toBe(
      `Bearer ${"h".repeat(40)}`,
    );
    const url = new URL(route.request().url());
    await route.fulfill({
      json: url.pathname.endsWith(first)
        ? item(first)
        : {
            items: [item(url.searchParams.has("before") ? second : first)],
            next: url.searchParams.has("before") ? null : first,
          },
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Operation history", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Partial / no-go", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("History access token").fill("h".repeat(40));
  await page.getByRole("button", { name: "Load history", exact: true }).click();
  await page.getByRole("button", { name: first, exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Operation details" }),
  ).toBeVisible();
  await expect(
    page.getByText("Unresolved mutations: 1", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("14 / 40", { exact: true })).toBeVisible();
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.screenshot({
    path: "/tmp/berth-history-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Older operations" }).click();
  await expect(
    page.getByRole("button", { name: second, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Older operations" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Newest operations" }).click();
  await expect(
    page.getByRole("button", { name: first, exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => [localStorage.length, sessionStorage.length]),
  ).toEqual([0, 0]);
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByLabel("History access token")).toHaveValue("");

  expect(errors).toEqual([]);
});

test("history has loading, empty, unavailable and unauthorized states without leaking response text", async ({
  page,
}) => {
  let status = 200;
  await page.route("**/api/history**", async (route) => {
    await new Promise((r) => setTimeout(r, 100));
    await route.fulfill({
      status,
      json:
        status === 200
          ? { items: [], next: null }
          : { secret: "must-not-display" },
    });
  });
  await page.goto("/");
  await page.getByLabel("History access token").fill("h".repeat(40));
  await page.getByRole("button", { name: "Load history", exact: true }).click();
  await expect(page.getByText("Loading operation history…")).toBeVisible();
  await expect(page.getByText("No recorded operations.")).toBeVisible();
  status = 503;
  await page.getByRole("button", { name: "Refresh history" }).click();
  await expect(
    page.getByText(
      "History is unavailable. Retry when the read service is available.",
    ),
  ).toBeVisible();
  status = 401;
  await page.getByRole("button", { name: "Refresh history" }).click();
  await expect(
    page.getByText("Access denied. Enter a valid history token."),
  ).toBeVisible();
  await expect(page.getByText("must-not-display")).toHaveCount(0);
});

test("history remains usable on narrow screens", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Load history", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/berth-history-mobile.png",
    fullPage: true,
  });
});

test("disconnect discards late responses and page reload requires access again", async ({
  page,
}) => {
  let release: (() => void) | undefined;
  await page.route("**/api/history**", async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({ json: { items: [item(first)], next: null } });
  });
  await page.goto("/");
  await page.getByLabel("History access token").fill("h".repeat(40));
  await page.getByRole("button", { name: "Load history", exact: true }).click();
  await expect(page.getByText("Loading operation history…")).toBeVisible();
  await page.getByRole("button", { name: "Disconnect" }).click();
  release?.();
  await expect(page.getByLabel("History access token")).toHaveValue("");
  await expect(
    page.getByRole("button", { name: first, exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel("History access token")).toHaveValue("");
});
