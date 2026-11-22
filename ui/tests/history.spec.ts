import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";

const first = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const second = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
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

/** Open the history screen through the application's main navigation. */
async function openHistory(page: Page) {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Operation history" })
    .click();
}

test("the shell marks the active page and opens the existing history access screen", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/")) {
      requests.push(path);
    }
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Infrastructure" }),
  ).toBeVisible();
  await expect(page.getByText("Inventory is not available yet.")).toBeVisible();
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await expect(navigation).toHaveCSS("display", "flex");
  const infrastructure = navigation.getByRole("link", {
    name: "Infrastructure",
  });
  const history = navigation.getByRole("link", { name: "Operation history" });
  await expect(infrastructure).toHaveAttribute("aria-current", "page");
  await page.getByRole("link", { name: "Open operation history" }).click();
  await expect(page).toHaveURL(/\/operations$/);
  await expect(history).toHaveAttribute("aria-current", "page");
  await expect(infrastructure).not.toHaveAttribute("aria-current", "page");
  await expect(page.getByLabel("History access token")).toBeVisible();
  await expect(page.getByRole("region", { name: "History access" })).toHaveCSS(
    "border-top-width",
    "1px",
  );
  expect(requests).toEqual([]);
});

test("the history detail route passes its operation identifier to the authenticated read", async ({
  page,
}) => {
  const path = `/operations/${first}`;
  const requests: string[] = [];
  await page.route("**/api/history**", (route) => {
    requests.push(new URL(route.request().url()).pathname);
    expect(route.request().headers().authorization).toBe(
      `Bearer ${"h".repeat(40)}`,
    );
    return route.fulfill({
      json:
        requests.at(-1) === "/api/history"
          ? { items: [item(second)], next: null }
          : item(first),
    });
  });
  const document = await page.goto(path);
  expect(document?.status()).toBe(200);
  await expect(page.getByLabel("History access token")).toBeVisible();
  await expect(page.getByRole("region", { name: "History access" })).toHaveCSS(
    "border-top-width",
    "1px",
  );
  expect(requests).toEqual([]);
  await page.getByLabel("History access token").fill("h".repeat(40));
  await page.getByRole("button", { name: "Load history" }).click();
  await expect(
    page.getByRole("heading", { name: "Operation details" }),
  ).toBeVisible();
  expect(requests).toEqual([`/api/history/${first}`]);
  await page.getByRole("button", { name: "Refresh detail" }).click();
  await expect
    .poll(() => requests)
    .toEqual([`/api/history/${first}`, `/api/history/${first}`]);
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Operation history" })
    .click();
  await expect(page.getByRole("button", { name: second })).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Operation details" }),
  ).toBeVisible();
  expect(requests.at(-1)).toBe(`/api/history/${first}`);
  const refreshed = await page.reload();
  expect(refreshed?.status()).toBe(200);
  await expect(page.getByLabel("History access token")).toHaveValue("");
});

test("malformed operation links explain the error without a history read", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/api/history")) {
      requests.push(pathname);
    }
  });
  for (const path of [
    "/operations/not-a-uuid",
    `/operations/not-a-uuid;operation=${first}`,
    "/operations/%ZZ",
    "/operations/;invalid",
    `/operations/${first})`,
    `/operations/${first}()`,
    `/operations/${first};`,
    "/operations/(unknown:foo)",
  ]) {
    const document = await page.goto(path);
    expect(document?.status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: "Invalid operation link" }),
    ).toBeVisible();
    await expect(page.getByLabel("History access token")).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(path);
  }
  await page
    .getByRole("main")
    .getByRole("link", { name: "Operation history" })
    .click();
  await expect(page.getByLabel("History access token")).toBeVisible();
  expect(requests).toEqual([]);

  const refreshed = await page.reload();
  expect(refreshed?.status()).toBe(200);
  await expect(page.getByLabel("History access token")).toBeVisible();
});

test("preview separates static misses from history API errors", async ({
  request,
}) => {
  const htmlResponse = await request.get("/");
  expect(htmlResponse.ok()).toBe(true);
  const shell = await htmlResponse.text();
  const [rewrites, notFound] = await Promise.all([
    readFile(
      new URL("../dist/history/browser/_redirects", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../dist/history/browser/404.html", import.meta.url),
      "utf8",
    ),
  ]);
  expect(rewrites.trim().split("\n")).toEqual([
    "/operations / 200",
    "/operations/:operation / 200",
  ]);
  for (const path of [
    "/operations/",
    "/operations/a/b",
    "/missing-bundle.js",
  ]) {
    const miss = await request.get(path, { maxRedirects: 0 });
    expect(miss.status()).toBe(404);
    expect(miss.headers()["content-type"]).toContain("text/html");
    expect(miss.headers()["content-security-policy"]).toBe(
      htmlResponse.headers()["content-security-policy"],
    );
    expect(await miss.text()).toBe(notFound);
  }
  const apiMiss = await request.get("/api/history/too/deep");
  expect(apiMiss.status()).toBe(404);
  expect(apiMiss.headers()["content-type"]).toContain("application/json");
  expect(await apiMiss.json()).toEqual({ error: "not-found" });
  expect(notFound).not.toBe(shell);
});

test("the production CSP allows compiled component CSS and blocks unlisted inline styles", async ({
  page,
}) => {
  const response = await page.goto("/");
  const policy = response?.headers()["content-security-policy"] ?? "";
  const pagesHeaders = await readFile(
    new URL("../dist/history/browser/_headers", import.meta.url),
    "utf8",
  );
  expect(pagesHeaders).toContain(`Content-Security-Policy: ${policy}\n`);
  expect(policy).toContain("style-src 'self' 'sha256-");
  expect(policy).not.toContain("'unsafe-inline'");
  expect(policy).not.toContain("'nonce-");
  await expect(page.locator("berth-infrastructure")).toHaveCSS(
    "display",
    "block",
  );
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await expect(navigation).toHaveCSS("display", "flex");
  await navigation.getByRole("link", { name: "Operation history" }).click();
  await expect(page.getByRole("region", { name: "History access" })).toHaveCSS(
    "border-top-width",
    "1px",
  );
  const blocked = await page.evaluate(async () => {
    const violation = new Promise<string>((resolve) => {
      document.addEventListener(
        "securitypolicyviolation",
        (event) => resolve(event.effectiveDirective),
        { once: true },
      );
    });
    const probe = document.createElement("style");
    probe.textContent = "body { --berth-unlisted-style: applied; }";
    document.head.append(probe);
    return {
      directive: await violation,
      value: getComputedStyle(document.body).getPropertyValue(
        "--berth-unlisted-style",
      ),
    };
  });
  expect(blocked).toEqual({ directive: "style-src-elem", value: "" });
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
  await openHistory(page);
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
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await navigation.getByRole("link", { name: "Infrastructure" }).click();
  await expect(page.getByRole("button", { name: first })).toHaveCount(0);
  await navigation.getByRole("link", { name: "Operation history" }).click();
  await expect(page.getByRole("button", { name: first })).toBeVisible();
  await openHistory(page);
  await expect(page.getByLabel("History access token")).toHaveValue("");
  await page.getByLabel("History access token").fill("h".repeat(40));
  await page.getByRole("button", { name: "Load history" }).click();
  await expect(page.getByRole("button", { name: first })).toBeVisible();
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
  await openHistory(page);
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

test("returning to history preserves a failed first read until the owner retries", async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route("**/api/history**", (route) => {
    requests.push(route.request().url());
    return route.fulfill({ status: 503, json: { error: "unavailable" } });
  });
  await openHistory(page);
  await page.getByLabel("History access token").fill("h".repeat(40));
  await page.getByRole("button", { name: "Load history" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "History is unavailable.",
  );
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await navigation.getByRole("link", { name: "Infrastructure" }).click();
  await navigation.getByRole("link", { name: "Operation history" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "History is unavailable.",
  );
  expect(requests).toHaveLength(1);
});

test("history remains usable on narrow screens", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await openHistory(page);
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
  await openHistory(page);
  await page.getByLabel("History access token").fill("h".repeat(40));
  await page.getByRole("button", { name: "Load history", exact: true }).click();
  await expect(page.getByText("Loading operation history…")).toBeVisible();
  await page.getByRole("button", { name: "Disconnect" }).click();
  release?.();
  await expect(page.getByLabel("History access token")).toHaveValue("");
  await expect(
    page.getByRole("button", { name: first, exact: true }),
  ).toHaveCount(0);
  await openHistory(page);
  await expect(page.getByLabel("History access token")).toHaveValue("");
});
