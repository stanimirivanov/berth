import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { first, item } from "./history-fixture";

/** Check the rendered document against axe's WCAG 2.2 A and AA rules. */
async function expectAccessible(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(violations).toEqual([]);
}

test("History accessibility: access prompt", async ({ page }) => {
  await page.goto("/operations");
  await expect(page.getByLabel("History access token")).toBeVisible();
  await expectAccessible(page);
});

/** Open a populated Review inbox with a synthetic retained operation. */
async function openReviewInbox(page: Page) {
  await page.route("**/api/history", (route) =>
    route.fulfill({ json: { items: [item(first)], next: null } }),
  );
  await page.goto("/operations");
  await page.getByLabel("History access token").fill("h".repeat(40));
  await page.getByRole("button", { name: "Load history" }).click();
  await expect(page.getByRole("link", { name: first })).toBeVisible();
}

test("History accessibility: populated Review inbox", async ({ page }) => {
  await openReviewInbox(page);
  await expectAccessible(page);
});

test("History accessibility: selected operation detail", async ({ page }) => {
  await page.route(`**/api/history/${first}`, (route) =>
    route.fulfill({ json: item(first) }),
  );
  await openReviewInbox(page);
  await page.getByRole("link", { name: first }).click();
  const detail = page.getByRole("region", { name: "Selected operation" });
  await expect(
    detail.getByRole("heading", { name: "Recorded lifecycle state" }),
  ).toBeVisible();
  await expectAccessible(page);
});

test("History accessibility: recoverable refresh error", async ({ page }) => {
  await openReviewInbox(page);
  await page.route("**/api/history", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
  await page.getByRole("button", { name: "Refresh history" }).click();
  await expect(
    page.getByRole("alert", { name: "Review inbox errors" }),
  ).toContainText("History is unavailable.");
  await expect(
    page.getByRole("button", { name: "Retry", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: first })).toBeVisible();
  await expectAccessible(page);
});
