import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { first, item, second } from "./history-fixture";

/** Open the history screen through the application's main navigation. */
async function openHistory(page: Page) {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Operation history" })
    .click();
}

/** Observe CSP events before visiting the production shell. */
async function observeCspViolations(page: Page) {
  const violations: string[] = [];
  await page.exposeFunction(
    "recordHistoryCspViolation",
    (directive: string) => {
      violations.push(directive);
    },
  );
  await page.addInitScript(() => {
    const browser = window as Window & {
      recordHistoryCspViolation: (directive: string) => Promise<void>;
    };
    document.addEventListener("securitypolicyviolation", (event) => {
      void browser.recordHistoryCspViolation(event.effectiveDirective);
    });
  });
  return violations;
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
  await expect(
    page.getByRole("heading", { name: "OCI Object Storage bucket" }),
  ).toBeVisible();
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
  await expect
    .poll(() => requests)
    .toEqual([`/api/history/${first}`, "/api/history"]);
  await page.getByRole("button", { name: "Refresh detail" }).click();
  await expect
    .poll(() => requests)
    .toEqual([
      `/api/history/${first}`,
      "/api/history",
      `/api/history/${first}`,
    ]);
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Operation history" })
    .click();
  await expect(page.getByRole("link", { name: second })).toBeVisible();
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
  await page.getByRole("link", { name: first, exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Operation details" }),
  ).toBeVisible();
  const detail = page.getByRole("region", { name: "Selected operation" });
  await expect(
    detail.getByText("Unresolved mutations: 1", { exact: true }),
  ).toHaveCount(2);
  await expect(
    detail.getByText("Recorded outcome requires reconciliation."),
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
    page.getByRole("link", { name: second, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Older operations" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Newest operations" }).click();
  await expect(
    page.getByRole("link", { name: first, exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => [localStorage.length, sessionStorage.length]),
  ).toEqual([0, 0]);
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await navigation.getByRole("link", { name: "Infrastructure" }).click();
  await expect(page.getByRole("link", { name: first })).toHaveCount(0);
  await navigation.getByRole("link", { name: "Operation history" }).click();
  await expect(page.getByRole("link", { name: first })).toBeVisible();
  await openHistory(page);
  await expect(page.getByLabel("History access token")).toHaveValue("");
  await page.getByLabel("History access token").fill("h".repeat(40));
  await page.getByRole("button", { name: "Load history" }).click();
  await expect(page.getByRole("link", { name: first })).toBeVisible();
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
  const fetchedAt = page
    .getByRole("region", { name: "Recorded operations" })
    .getByText(/^Last fetched/)
    .locator("time");
  const successfulRead = await fetchedAt.getAttribute("datetime");
  status = 503;
  await page.getByRole("button", { name: "Refresh history" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "History is unavailable.",
  );
  await expect(page.getByText("No recorded operations.")).toBeVisible();
  await expect(fetchedAt).toHaveAttribute("datetime", successfulRead ?? "");
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
    page.getByRole("link", { name: first, exact: true }),
  ).toHaveCount(0);
  await openHistory(page);
  await expect(page.getByLabel("History access token")).toHaveValue("");
});

test("a failed older-page read keeps the successful page and retries the same cursor", async ({
  page,
}) => {
  const requests: string[] = [];
  const held = Promise.withResolvers<void>();
  let olderAttempts = 0;
  await page.route("**/api/history**", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
    if (url.pathname.endsWith(first)) {
      await route.fulfill({ json: item(first) });
      return;
    }
    const cursor = url.searchParams.get("before");
    if (cursor) {
      olderAttempts++;
      if (olderAttempts === 1) {
        await held.promise;
      }
      if (olderAttempts !== 2) {
        await route.fulfill({ status: 503, json: {} });
        return;
      }
    }
    await route.fulfill({
      json: {
        items: [item(cursor ? second : first)],
        next: cursor ? null : first,
      },
    });
  });
  await openHistory(page);
  await page.getByLabel("History access token").fill("h".repeat(40));
  await page.getByRole("button", { name: "Load history" }).click();
  const list = page.getByRole("region", { name: "Recorded operations" });
  const fetchedAt = list.getByText(/^Last fetched/).locator("time");
  await expect(fetchedAt).toHaveAttribute("datetime", /Z$/);
  const successfulRead = await fetchedAt.getAttribute("datetime");
  const older = list.getByRole("button", { name: "Older operations" });
  const firstRow = list.getByRole("link", { name: first });
  const detail = page.getByRole("region", { name: "Selected operation" });
  const olderPath = `/api/history?before=${first}`;
  await older.click();
  try {
    await expect.poll(() => requests).toEqual(["/api/history", olderPath]);
    await firstRow.click();
    await expect(detail.getByText("Loading operation details…")).toBeVisible();
    expect(requests).toEqual(["/api/history", olderPath]);
  } finally {
    held.resolve();
  }
  await expect(list.getByRole("alert")).toContainText("may be out of date");
  await expect(firstRow).toBeVisible();
  await expect(fetchedAt).toHaveAttribute("datetime", successfulRead ?? "");
  await expect(detail.getByText(first)).toBeVisible();
  await list.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(list.getByText(second)).toBeVisible();

  await list.getByRole("button", { name: "Newest operations" }).click();
  await expect(firstRow).toBeVisible();
  await older.click();
  await list.getByRole("button", { name: "Go to newest" }).click();
  await expect(list.getByRole("alert")).toHaveCount(0);
  await expect(firstRow).toBeVisible();
  await expect(detail.getByText(first)).toBeVisible();
  expect(requests).toEqual([
    "/api/history",
    olderPath,
    `/api/history/${first}`,
    olderPath,
    "/api/history",
    olderPath,
    "/api/history",
  ]);
});

test("a pending obsolete detail yields to the latest selection before the queued list refresh", async ({
  page,
}) => {
  const requests: string[] = [];
  const held = Promise.withResolvers<void>();
  const replacement = Promise.withResolvers<void>();
  await page.route("**/api/history**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    if (path.endsWith(first)) {
      await held.promise;
      await route.fulfill({ json: item(first) });
    } else if (path.endsWith(second)) {
      await replacement.promise;
      await route.fulfill({ status: 404, json: {} });
    } else {
      await route.fulfill({
        json: { items: [item(first), item(second)], next: null },
      });
    }
  });
  await openHistory(page);
  await page.getByLabel("History access token").fill("h".repeat(40));
  await page.getByRole("button", { name: "Load history" }).click();
  await page.getByRole("link", { name: first, exact: true }).click();
  try {
    await expect
      .poll(() => requests)
      .toEqual(["/api/history", `/api/history/${first}`]);
    await page
      .getByRole("button", { name: "Refresh history" })
      .click({ timeout: 1500 });
    await page
      .getByRole("link", { name: second, exact: true })
      .click({ timeout: 1500 });
    expect(requests).toEqual(["/api/history", `/api/history/${first}`]);
  } finally {
    held.resolve();
  }
  const detail = page.getByRole("region", { name: "Selected operation" });
  try {
    await expect.poll(() => requests.at(-1)).toBe(`/api/history/${second}`);
    await expect(detail.getByText("Loading operation details…")).toBeVisible();
    await expect(detail.getByText(first)).toHaveCount(0);
  } finally {
    replacement.resolve();
  }
  await expect(page.getByText("Operation not found.")).toBeVisible();
  await expect(
    page.getByRole("link", { name: second, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Selected operation" }).getByText(first),
  ).toHaveCount(0);
  await expect
    .poll(() => requests)
    .toEqual([
      "/api/history",
      `/api/history/${first}`,
      `/api/history/${second}`,
      "/api/history",
    ]);
});

test("detail refresh retains its timestamp on failure and clears only detail on 404", async ({
  page,
}) => {
  let detailStatus = 200;
  await page.route("**/api/history**", (route) => {
    const detail = new URL(route.request().url()).pathname.endsWith(first);
    return route.fulfill(
      detail
        ? {
            status: detailStatus,
            json: detailStatus === 200 ? item(first) : {},
          }
        : { json: { items: [item(second)], next: null } },
    );
  });
  await page.goto(`/operations/${first}`);
  await page.getByLabel("History access token").fill("h".repeat(40));
  await page.getByRole("button", { name: "Load history" }).click();
  const list = page.getByRole("region", { name: "Recorded operations" });
  const detail = page.getByRole("region", { name: "Selected operation" });
  await expect(list.getByRole("link", { name: second })).toBeVisible();
  const fetchedAt = detail.getByText(/^Last fetched/).locator("time");
  await expect(fetchedAt).toHaveAttribute("datetime", /Z$/);
  const successfulRead = await fetchedAt.getAttribute("datetime");
  detailStatus = 503;
  await detail.getByRole("button", { name: "Refresh detail" }).click();
  await expect(detail.getByRole("alert")).toContainText("may be out of date");
  await expect(detail.getByText(first)).toBeVisible();
  await expect(fetchedAt).toHaveAttribute("datetime", successfulRead ?? "");
  detailStatus = 404;
  await detail.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(detail.getByRole("alert")).toHaveText("Operation not found.");
  await expect(detail.getByText(first)).toHaveCount(0);
  await expect(fetchedAt).toHaveCount(0);
  await expect(list.getByRole("link", { name: second })).toBeVisible();
});

for (const status of [401, 403]) {
  test(`a superseded detail returning ${status} clears both panes and discards queued reads`, async ({
    page,
  }) => {
    const requests: string[] = [];
    const held = Promise.withResolvers<void>();
    let rejectDetail = false;
    await page.route("**/api/history**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      requests.push(path);
      if (path.endsWith(first) && rejectDetail) {
        await held.promise;
        await route.fulfill({ status, json: { secret: "must-not-display" } });
      } else {
        await route.fulfill({
          json: path.endsWith(first)
            ? item(first)
            : { items: [item(second)], next: null },
        });
      }
    });
    await page.goto(`/operations/${first}`);
    await page.getByLabel("History access token").fill("h".repeat(40));
    await page.getByRole("button", { name: "Load history" }).click();
    const secondRow = page.getByRole("link", { name: second });
    await expect(secondRow).toBeVisible();
    rejectDetail = true;
    await page.getByRole("button", { name: "Refresh detail" }).click();
    try {
      await expect.poll(() => requests).toHaveLength(3);
      await page.getByRole("button", { name: "Refresh history" }).click();
      await secondRow.click();
      await expect(page).toHaveURL(`/operations/${second}`);
    } finally {
      held.resolve();
    }
    const alert = page.getByRole("alert");
    if (status === 401) {
      await expect(alert).toContainText("Enter a valid history token");
      await expect(page.getByLabel("History access token")).toHaveValue("");
      await expect(page).toHaveURL(`/operations/${second}`);
    } else {
      await expect(alert).toContainText("Open the configured Berth URL");
      await expect(page.getByLabel("History access token")).toHaveCount(0);
    }
    await expect(
      page.getByRole("region", { name: "Recorded operations" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Selected operation" }),
    ).toHaveCount(0);
    await expect(page.getByText("must-not-display")).toHaveCount(0);
    expect(requests).toEqual([
      `/api/history/${first}`,
      "/api/history",
      `/api/history/${first}`,
    ]);
  });
}

test("the Review inbox groups attention separately and leads detail with every reason", async ({
  page,
}) => {
  const violations = await observeCspViolations(page);
  const expired = { ...item(first), outcome: "active" };
  const resolved = {
    ...item(second),
    outcome: "failed",
    unresolved: { requests: 0, mutations: 0 },
  };
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route("**/api/history**", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith(first)
        ? expired
        : { items: [resolved, expired], next: null },
    }),
  );
  await openHistory(page);
  await page.getByLabel("History access token").fill("h".repeat(40));
  await page.getByRole("button", { name: "Load history" }).click();
  const attention = page.getByRole("region", { name: "Needs attention" });
  const other = page.getByRole("region", { name: "Other operations" });
  await expect(attention.getByText("active", { exact: true })).toBeVisible();
  await expect(other.getByText("failed", { exact: true })).toBeVisible();
  await expect(other.getByRole("link", { name: first })).toHaveCount(0);
  const operation = attention
    .getByRole("navigation", { name: "Needs attention" })
    .getByRole("link", { name: first, exact: true });
  await expect(
    other
      .getByRole("navigation", { name: "Other operations" })
      .getByRole("link"),
  ).toHaveCount(1);
  await expect(
    operation.getByText(/Phase: cleanup · Unresolved mutations: 1/),
  ).toBeVisible();
  await expect(operation).toHaveAccessibleDescription(/active.*Phase: cleanup/);
  await expect(operation).toHaveAttribute("href", `/operations/${first}`);
  await operation.focus();
  await operation.press("Enter");
  await expect(operation).toHaveAttribute("aria-current", "page");
  await expect(page).toHaveURL(`/operations/${first}`);
  const detail = page.getByRole("region", { name: "Selected operation" });
  await expect(detail.getByRole("listitem")).toHaveText([
    /Execution window expired.*active/,
    /Unresolved requests/,
    /Unresolved mutations/,
  ]);
  await expect(
    detail.getByRole("link", { name: "Stop conditions" }),
  ).toHaveAttribute(
    "href",
    /owner-recovery\.md#4-stop-conditions-and-leftovers$/,
  );
  await expect(
    detail.getByRole("link", { name: "Owner recovery evidence checks" }),
  ).toHaveAttribute(
    "href",
    /owner-recovery\.md#2-save-a-read-only-sql-snapshot-before-every-local-action$/,
  );
  await expect(detail.getByText("active", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Partial / no-go", { exact: true }),
  ).toBeVisible();
  const listBounds = await page
    .getByRole("region", { name: "Recorded operations" })
    .boundingBox();
  await expect(detail.locator("mat-card")).toHaveCSS(
    "border-top-style",
    "solid",
  );
  await expect(
    detail.getByRole("button", { name: "Refresh detail" }),
  ).toHaveCSS("border-top-width", "1px");
  await expect(
    page.getByRole("button", { name: "Older operations" }),
  ).toBeDisabled();
  expect(violations).toEqual([]);
  const detailBounds = await detail.boundingBox();
  expect(listBounds).not.toBeNull();
  expect(detailBounds).not.toBeNull();
  if (listBounds && detailBounds) {
    expect(listBounds.x + listBounds.width).toBeLessThan(detailBounds.x);
  }
});

test("mobile detail returns keyboard focus to its row on the retained older page", async ({
  page,
}) => {
  const requests: string[] = [];
  let missing = false;
  await page.setViewportSize({ width: 375, height: 820 });
  await page.route("**/api/history**", (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
    if (missing && url.pathname.endsWith(second)) {
      return route.fulfill({ status: 404, json: {} });
    }
    return route.fulfill({
      json: url.pathname.endsWith(second)
        ? item(second)
        : url.searchParams.has("before")
          ? { items: [item(second)], next: null }
          : { items: [item(first)], next: first },
    });
  });
  await openHistory(page);
  await page.getByLabel("History access token").fill("h".repeat(40));
  await page.getByRole("button", { name: "Load history" }).click();
  await page.getByRole("button", { name: "Older operations" }).click();
  const row = page.getByRole("link", { name: second });
  const detailHeading = page.getByRole("heading", {
    name: "Operation details",
  });
  const inbox = page.getByRole("region", { name: "Recorded operations" });
  await page.setViewportSize({ width: 320, height: 820 });
  const summary = row.getByText(/Phase: cleanup · Unresolved mutations: 1/);
  await expect(summary).toHaveCSS("white-space", "normal");
  expect(
    await summary.evaluate(
      (element) =>
        element.scrollWidth <= element.clientWidth &&
        element.scrollHeight <= element.clientHeight,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 375, height: 820 });
  await row.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(row).toBeFocused();
  await expect(row).toHaveCSS("outline-width", "3px");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`/operations/${second}`);
  await expect(detailHeading).toBeFocused();
  await expect(inbox).toBeHidden();
  const detail = page.getByRole("region", { name: "Selected operation" });
  await expect(detail.getByText("14 / 40", { exact: true })).toBeVisible();
  const bounds = await detail.boundingBox();
  expect(bounds?.width).toBeGreaterThan(330);

  await page.goBack();
  await expect(page).toHaveURL("/operations");
  await expect(row).toBeFocused();
  await page.goForward();
  await expect(page).toHaveURL(`/operations/${second}`);
  await expect(detailHeading).toBeFocused();
  await page.getByRole("link", { name: "Back to inbox" }).click();
  await expect(page).toHaveURL("/operations");
  await expect(row).toBeFocused();
  expect(requests.filter((path) => !path.endsWith(second))).toEqual([
    "/api/history",
    `/api/history?before=${first}`,
  ]);

  requests.length = 0;
  missing = true;
  await page.goto(`/operations/${second}`);
  await expect(page.getByLabel("History access token")).toBeVisible();
  expect(requests).toEqual([]);
  await page.getByLabel("History access token").fill("h".repeat(40));
  await page.getByRole("button", { name: "Load history" }).click();
  await expect(detailHeading).toBeFocused();
  await expect
    .poll(() => requests)
    .toEqual([`/api/history/${second}`, "/api/history"]);
  await expect(detail.getByRole("alert")).toHaveText("Operation not found.");
  await page.getByRole("link", { name: "Back to inbox" }).click();
  await expect(page.getByRole("link", { name: first })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Review inbox" }),
  ).toBeFocused();
});

test("an active operation moves to Needs attention at expiry without a history refresh", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-11-20T10:49:45Z") });
  const requests: string[] = [];
  const active = {
    ...item(first),
    outcome: "active",
    unresolved: { requests: 0, mutations: 0 },
  };
  await page.route("**/api/history**", (route) => {
    requests.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: { items: [active], next: null } });
  });
  await openHistory(page);
  await page.getByLabel("History access token").fill("h".repeat(40));
  await page.getByRole("button", { name: "Load history" }).click();
  await expect(
    page
      .getByRole("region", { name: "Other operations" })
      .getByRole("link", { name: first }),
  ).toBeVisible();

  await page.clock.fastForward(20_000);

  const attention = page.getByRole("region", { name: "Needs attention" });
  await expect(attention.getByRole("link", { name: first })).toBeVisible();
  await expect(attention.getByText("active", { exact: true })).toBeVisible();
  expect(requests).toEqual(["/api/history"]);
});

test("returning from desktop detail restores the page it opened from", async ({
  page,
}) => {
  await page.route("**/api/history**", (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({
      json: url.pathname.endsWith(second)
        ? item(second)
        : url.searchParams.has("before")
          ? { items: [item(second)], next: null }
          : { items: [item(first)], next: first },
    });
  });
  await openHistory(page);
  await page.getByLabel("History access token").fill("h".repeat(40));
  await page.getByRole("button", { name: "Load history" }).click();
  await page.getByRole("button", { name: "Older operations" }).click();

  const originalRow = page.getByRole("link", { name: second });
  await originalRow.click();
  await page.getByRole("button", { name: "Newest operations" }).click();
  await expect(page.getByRole("link", { name: first })).toBeVisible();

  await page.getByRole("link", { name: "Back to inbox" }).click();
  await expect(page).toHaveURL("/operations");
  await expect(originalRow).toBeFocused();
  await expect(page.getByRole("link", { name: first })).toHaveCount(0);
});

test("Material access on a saved link preserves the static CSP and keyboard submission", async ({
  page,
}) => {
  const reads: string[] = [];
  const violations = await observeCspViolations(page);
  const detailReply = Promise.withResolvers<void>();
  await page.route("**/api/history**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    reads.push(path);
    expect(route.request().headers().authorization).toBe(
      `Bearer ${"h".repeat(40)}`,
    );
    if (path === `/api/history/${first}`) {
      await detailReply.promise;
      await route.fulfill({ json: item(first) });
    } else {
      await route.fulfill({ json: { items: [], next: null } });
    }
  });

  const response = await page.goto(`/operations/${first}`);
  expect(response?.status()).toBe(200);
  const policy = response?.headers()["content-security-policy"] ?? "";
  const pagesHeaders = await readFile(
    new URL("../dist/history/browser/_headers", import.meta.url),
    "utf8",
  );
  expect(pagesHeaders).toContain(`Content-Security-Policy: ${policy}\n`);
  const token = page.getByLabel("History access token");
  const detail = page.getByRole("region", { name: "Selected operation" });
  try {
    expect(reads).toEqual([]);
    await expect(token).toHaveAttribute("type", "password");
    await expect(token).toHaveAccessibleDescription(
      /Kept in memory for this tab/,
    );
    await expect(page.getByRole("button", { name: "Load history" })).toHaveCSS(
      "background-color",
      "rgb(0, 92, 187)",
    );
    await token.fill("h".repeat(40));
    await token.press("Enter");
    await expect(detail.getByRole("status")).toHaveText(
      "Loading operation details…",
    );
    await expect(
      detail.getByRole("progressbar", { name: "Loading operation details" }),
    ).toHaveCSS("height", "4px");
    await expect.poll(() => reads).toEqual([`/api/history/${first}`]);
  } finally {
    detailReply.resolve();
  }

  await expect(detail.getByText(first, { exact: true })).toBeVisible();
  await expect
    .poll(() => reads)
    .toEqual([`/api/history/${first}`, "/api/history"]);
  expect(violations).toEqual([]);
});

test("owner access stays unverified until a protected response decodes", async ({
  page,
}) => {
  let attempt = 0;
  await page.route("**/api/history", (route) => {
    attempt++;
    if (attempt === 1) {
      return route.fulfill({ status: 503, json: {} });
    }
    const record = { ...item(first), startedAt: "2026-11-20T06:50:00+00:00" };
    return route.fulfill({
      json: {
        items: [
          attempt === 2 ? { ...record, startedAt: [record.startedAt] } : record,
        ],
        next: null,
      },
    });
  });

  await openHistory(page);
  const token = page.getByLabel("History access token");
  const submit = page.getByRole("button", { name: "Load history" });
  await token.fill("invalid");
  await submit.click();
  await expect(page.getByRole("alert")).toHaveText(
    "Enter a valid history token.",
  );
  expect(attempt).toBe(0);

  await token.fill("h".repeat(40));
  await submit.click();
  const access = page.getByRole("region", { name: "History access" });
  const inbox = page.getByRole("region", { name: "Recorded operations" });
  const retry = inbox.getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeVisible();
  await expect(access).toContainText("History access has not been verified");
  await retry.click();
  await expect(retry).toBeVisible();
  await expect(access).toContainText("History access has not been verified");
  await expect(inbox.getByRole("link", { name: first })).toHaveCount(0);
  await retry.click();
  await expect(inbox.getByRole("link", { name: first })).toBeVisible();
  await expect(access).toContainText("History access connected");
  expect(attempt).toBe(3);
});

test("leaving History discards the old detail and keeps access unverified on return", async ({
  page,
}) => {
  const pending = Promise.withResolvers<void>();
  const resumed = Promise.withResolvers<void>();
  const reads: string[] = [];
  const path = `/operations/${first}`;
  const endpoint = `/api/history/${first}`;
  let detailReads = 0;
  await page.route("**/api/history**", async (route) => {
    const requestPath = new URL(route.request().url()).pathname;
    reads.push(requestPath);
    if (requestPath !== endpoint) {
      await route.fulfill({ json: { items: [], next: null } });
      return;
    }
    detailReads++;
    if (detailReads === 1) {
      await pending.promise;
    } else {
      await resumed.promise;
    }
    await route.fulfill({ json: item(first) });
  });

  await page.goto(path);
  await page.getByLabel("History access token").fill("h".repeat(40));
  await page.getByRole("button", { name: "Load history" }).click();
  try {
    await expect.poll(() => reads).toEqual([endpoint]);
    const oldReply = page.waitForResponse(
      (response) => new URL(response.url()).pathname === endpoint,
    );
    await page
      .getByRole("link", { name: "Infrastructure", exact: true })
      .click();
    await expect(page).toHaveURL("/");
    pending.resolve();
    await oldReply;
    await page.goBack();
    await expect(page).toHaveURL(path);
    await expect(
      page.getByText("History access has not been verified."),
    ).toBeVisible();
    await expect(page.getByText("Loading operation details…")).toBeVisible();
    await expect.poll(() => reads).toEqual([endpoint, endpoint]);
  } finally {
    pending.resolve();
    resumed.resolve();
  }
  await expect(page.getByText("History access connected")).toBeVisible();
  await expect.poll(() => reads).toEqual([endpoint, endpoint, "/api/history"]);
});
