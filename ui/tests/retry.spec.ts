import { expect, type Page, type Route, test } from "@playwright/test";
import { first, item, second } from "./history-fixture";

const owner = `berth-retry-owner-v1.${"o".repeat(43)}`;
const history = "h".repeat(40);
const root = `/api/retry/operations/${first}`;
const procedure =
  "https://github.com/stanimirivanov/berth/blob/main/docs/trial/retry-continuation.md";

/** Open the saved operation through the existing independently authenticated History read. */
async function openDetail(page: Page) {
  await page.getByLabel("History access token").fill(history);
  await page.getByRole("button", { name: "Load history" }).click();
  await page.getByRole("button", { name: "Retry provisioning" }).click();
}

/** Use the separate owner credential, including when recovering a saved detail after reload. */
async function signIn(page: Page) {
  await page.getByLabel("Retry owner credential").fill(owner);
  await page.getByRole("button", { name: "Sign in to Retry" }).click();
}

/** Issue a synthetic session with the same signed deadline on both wire fields. */
function sessionResponse(route: Route, remainingMs = 240000) {
  const expiry = Date.now() + remainingMs;
  return route.fulfill({
    json: {
      session: `brr1.${expiry}.${first}.${"s".repeat(43)}`,
      expiresAt: new Date(expiry).toISOString(),
    },
  });
}

/** A bounded proposal with fresh times for the browser's deadline checks. */
function proposal() {
  const time = (minutes: number) =>
    new Date(Date.now() + minutes * 60000).toISOString();
  return {
    operation: first,
    stage: "waiting-for-approval",
    proposal: second,
    target: {
      region: "eu-frankfurt-1",
      namespace: "fixture",
      compartment: "ocid1.compartment.oc1..fixture",
      bucket: `berth-${first.replaceAll("-", "")}`,
      instance: null,
    },
    steps: ["create-bucket", "upload-fixture", "verify-and-clean-up"],
    evidence: {
      observedAt: time(-2),
      allowanceCheckedAt: time(-2),
      iamCheckedAt: time(-2),
      reference: "fixture-review",
    },
    startsAt: time(1),
    creationCutoff: time(31),
    expiresAt: time(241),
    approveBy: time(4),
    limits: {
      normal: 160,
      cleanup: 40,
      monitoring: 20,
      application: 64,
      applicationCleanup: 12,
      attemptsPerAction: 3,
    },
  };
}

test("saved operation signs in separately, checks once and recovers a lost approval on reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/history**", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith(first)
        ? item(first)
        : { items: [item(first)], next: null },
    }),
  );
  const offered = proposal();
  let state: object = {
    operation: first,
    stage: "needs-attention",
    reason: "reconciliation-required",
    ownerProcedure: procedure,
  };
  const writes: string[] = [];
  await page.route("**/api/retry/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const authorization = route.request().headers().authorization;
    if (path.endsWith("/session")) {
      expect(authorization).toBe(`Bearer ${owner}`);
      return sessionResponse(route, 360000);
    }
    expect(authorization).toMatch(/^Bearer brr1\./);
    if (route.request().method() === "GET") {
      return route.fulfill({ json: state });
    }
    writes.push(path);
    if (path === root) {
      state = {
        operation: first,
        stage: "checking-provider",
        reason: "reconciliation-in-progress",
        ownerProcedure: procedure,
      };
      return route.fulfill({
        status: 202,
        json: {
          operation: first,
          stage: "checking-provider",
          scope: "after-expiry",
          startedAt: offered.evidence.observedAt,
          observedAt: null,
          reason: null,
          result: null,
          ownerProcedure: null,
          checks: { used: 1, limit: 2 },
        },
      });
    }
    state = {
      operation: first,
      continuation: second,
      stage: "continuing-provisioning",
      scope: "after-expiry",
      authorization: "approved",
      progress: "awaiting-activation",
      reason: null,
      approvedAt: new Date().toISOString(),
      startsAt: offered.startsAt,
      expiresAt: offered.expiresAt,
      ownerProcedure: procedure,
    };
    return route.abort();
  });
  const document = await page.goto(`/operations/${first}`);
  expect(document?.headers()["content-security-policy"]).toContain(
    "connect-src 'self'",
  );
  await openDetail(page);
  await expect(page.getByLabel("Retry owner credential")).toBeFocused();
  await signIn(page);
  await page.getByRole("button", { name: "Check provider" }).press("Enter");
  await expect(
    page.getByText("Checking provider", { exact: true }),
  ).toBeVisible();
  state = offered;
  await page.getByRole("button", { name: "Check retry status" }).click();
  await expect(
    page.getByRole("region", { name: "Retry provisioning" }),
  ).toHaveCSS("border-top-width", "1px");
  await expect(
    page.getByText("Waiting for approval", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(offered.target.bucket, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Protected cleanup reserve", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Approve proposal" }).press("Enter");
  // Wait for the lost response after the fixture has recorded the approval.
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "The response was interrupted." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Check retry status" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Approve proposal" }),
  ).toHaveCount(0);
  await page.reload();
  await openDetail(page);
  await signIn(page);
  await expect(
    page.getByText("Continuing provisioning", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Partial / no-go", { exact: true }),
  ).toBeVisible();
  state = { ...state, stage: "completed", progress: "completed" };
  await page.getByRole("button", { name: "Check retry status" }).click();
  await expect(page.getByText("Completed", { exact: true })).toBeVisible();
  expect(writes).toEqual([root, `${root}/proposals/${second}/approve`]);
});

test("Retry shows original authority and owner guidance for blocked states without dispatching a write", async ({
  page,
}) => {
  const window = {
    scope: "original-window",
    creationCutoff: new Date(Date.now() + 60000).toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  let record = {
    ...item(first),
    outcome: "active",
    phase: "bucket",
    cleanupRequested: false,
    pendingUpload: false,
    expiresAt: window.expiresAt,
    unresolved: { requests: 0, mutations: 0 },
  };
  await page.route("**/api/history**", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith(first)
        ? record
        : { items: [record], next: null },
    }),
  );
  let state: object = {
    operation: first,
    stage: "continuing-provisioning",
    ...window,
    reason: "reconciliation-required",
    ownerProcedure: "https://foreign.example",
  };
  const writes: string[] = [];
  await page.route("**/api/retry/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/session")) {
      return sessionResponse(route);
    }
    if (route.request().method() === "POST") {
      writes.push(path);
    }
    return route.fulfill({ json: state });
  });
  await page.goto(`/operations/${first}`);
  await openDetail(page);
  await signIn(page);
  const panel = page.getByRole("region", { name: "Retry provisioning" });
  await expect(
    panel.getByText("Original execution authority.", { exact: false }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Approve proposal" }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "Check provider" }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("link", { name: "Owner procedure" }),
  ).toHaveCount(0);
  record = { ...record, cleanupRequested: true, phase: "cleanup" };
  await page.getByRole("button", { name: "Refresh detail" }).click();
  await expect(
    page
      .getByText("Cleanup requested", { exact: true })
      .locator("xpath=following-sibling::dd[1]"),
  ).toHaveText("Yes");
  state = {
    operation: first,
    stage: "needs-attention",
    reason: "original-authority-unavailable",
    ownerProcedure: procedure,
  };
  await panel.getByRole("button", { name: "Check retry status" }).click();
  await expect(
    panel.getByText("Cleanup has started.", { exact: false }),
  ).toBeVisible();
  await expect(
    panel.getByRole("link", { name: "Owner procedure" }),
  ).toHaveAttribute(
    "href",
    /owner-recovery.md#4-stop-conditions-and-leftovers$/,
  );
  for (const [reason, message] of [
    [
      "unresolved-prior-write",
      "An earlier provider write is still unresolved.",
    ],
    [
      "allowance-evidence-unqualified",
      "Free-plan allowance evidence is missing, stale, or insufficient.",
    ],
  ]) {
    state = {
      operation: first,
      stage: "needs-attention",
      reason,
      ownerProcedure: procedure,
    };
    await panel.getByRole("button", { name: "Check retry status" }).click();
    await expect(
      panel.getByText(message ?? "", { exact: false }),
    ).toBeVisible();
    await expect(
      panel.getByRole("link", { name: "Owner procedure" }),
    ).toHaveAttribute("href", procedure);
    await expect(
      panel.getByRole("button", { name: "Approve proposal" }),
    ).toHaveCount(0);
  }
  expect(writes).toEqual([]);
  await panel.getByRole("button", { name: "Close Retry" }).press("Enter");
  await expect(
    page.getByRole("button", { name: "Retry provisioning" }),
  ).toBeFocused();
  record = {
    ...record,
    outcome: "succeeded",
    cleanupRequested: false,
    objectRemoved: true,
  };
  state = { operation: first, stage: "completed", ...window };
  await page.reload();
  await openDetail(page);
  await signIn(page);
  await expect(panel.getByText("Completed", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Needs attention" }),
  ).toHaveCount(0);
});

test("a stale approval refreshes by read and Retry denial discards the proposal and session", async ({
  page,
}) => {
  await page.route("**/api/history**", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith(first)
        ? item(first)
        : { items: [item(first)], next: null },
    }),
  );
  let state: object = proposal();
  let denied = false;
  let posts = 0;
  await page.route("**/api/retry/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/session")) {
      return sessionResponse(route);
    }
    if (route.request().method() === "POST") {
      posts++;
      state = {
        operation: first,
        stage: "needs-attention",
        reason: "proposal-expired",
        ownerProcedure: procedure,
      };
      return route.fulfill({
        status: 409,
        json: { error: "proposal-no-longer-current" },
      });
    }
    return route.fulfill({ status: denied ? 401 : 200, json: state });
  });
  await page.goto(`/operations/${first}`);
  await openDetail(page);
  await signIn(page);
  await page
    .getByRole("button", { name: "Approve proposal" })
    .evaluate((element: HTMLButtonElement) => {
      element.click();
      element.click();
    });
  await expect(
    page.getByText("The previous proposal is no longer current.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("This proposal expired.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Approve proposal" }),
  ).toHaveCount(0);
  denied = true;
  await page.getByRole("button", { name: "Check retry status" }).click();
  await expect(
    page.getByText("Retry access denied.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel("Retry owner credential")).toHaveValue("");
  await expect(
    page.getByText("This proposal expired.", { exact: false }),
  ).toHaveCount(0);
  await expect(
    page.getByText("History access connected", { exact: true }),
  ).toBeVisible();
  expect(posts).toBe(1);
});

test("an expired original check allows a fresh scoped check and an expiring proposal retains focus", async ({
  page,
}) => {
  await page.clock.install();
  await page.route("**/api/history**", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith(first)
        ? item(first)
        : { items: [item(first)], next: null },
    }),
  );
  const expired = {
    ...proposal(),
    approveBy: new Date(Date.now() + 60000).toISOString(),
  };
  let started = 0;
  await page.route("**/api/retry/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/session")) {
      return sessionResponse(route);
    }
    if (route.request().method() === "POST") {
      started++;
      return route.fulfill({
        status: 202,
        json: { operation: first, stage: "checking-provider" },
      });
    }
    if (path === root) {
      return route.fulfill({
        json: {
          operation: first,
          stage: "needs-attention",
          scope: "original-window",
          reason: "read-access-unavailable",
          ownerProcedure: procedure,
        },
      });
    }
    return route.fulfill({
      json: started
        ? expired
        : {
            operation: first,
            stage: "needs-attention",
            reason: "reconciliation-stopped",
            ownerProcedure: procedure,
          },
    });
  });
  await page.goto(`/operations/${first}`);
  await openDetail(page);
  await signIn(page);
  await page.getByRole("button", { name: "Check provider" }).press("Enter");
  const approve = page.getByRole("button", { name: "Approve proposal" });
  await approve.focus();
  await page.clock.fastForward(75000);
  await expect(approve).toHaveCount(0);
  const panel = page.getByRole("region", { name: "Retry provisioning" });
  await expect(
    panel.getByText("Needs attention", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("This proposal expired.", { exact: false }),
  ).toBeVisible();
  await expect(
    panel.getByRole("heading", { name: "Retry provisioning" }),
  ).toBeFocused();
  expect(started).toBe(1);
});
