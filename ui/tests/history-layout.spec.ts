import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { first, item, second } from "./history-fixture";

/** Use the production History HTTP contract with synthetic retained records. */
async function mockHistory(page: Page) {
  await page.route("**/api/history**", (route) => {
    const url = new URL(route.request().url());
    const record = url.pathname.split("/").at(-1);
    return route.fulfill({
      json:
        record === first || record === second
          ? item(record)
          : url.searchParams.has("before")
            ? { items: [item(second)], next: null }
            : { items: [item(first)], next: first },
    });
  });
}

/** Check that text fits its available width and any clipping box. */
async function expectReadable(locator: Locator) {
  await expect(locator).toBeVisible();
  expect(
    await locator.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const lines = Array.from(range.getClientRects());
      const clips = (overflow: string) => ["hidden", "clip"].includes(overflow);
      for (
        let container: Element | null = element;
        container;
        container = container.parentElement
      ) {
        const { overflowX, overflowY } = getComputedStyle(container);
        const clipsWidth = container === element || clips(overflowX);
        const clipsHeight = clips(overflowY);
        if (!clipsWidth && !clipsHeight) {
          continue;
        }
        const { left, right, top, bottom } = container.getBoundingClientRect();
        const fits = lines.every(
          (line) =>
            (!clipsWidth ||
              (line.left >= left - 1 && line.right <= right + 1)) &&
            (!clipsHeight ||
              (line.top >= top - 1 && line.bottom <= bottom + 1)),
        );
        if (!fits) {
          return false;
        }
      }
      return lines.length > 0;
    }),
    (await locator.textContent()) ?? undefined,
  ).toBe(true);
}

/** Verify the viewport at each stage, including after scrolling to a control. */
async function expectNoHorizontalScroll(page: Page, width: number) {
  expect(
    await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      offset: window.scrollX,
    })),
  ).toEqual({ viewport: width, document: width, offset: 0 });
}

/** Verify keyboard focus has a painted indicator and an exposed target. */
async function expectExposedFocus(locator: Locator) {
  await expect(locator).toBeFocused();
  if (await locator.evaluate((element) => element.matches("input"))) {
    const outline = locator
      .locator("xpath=ancestor::mat-form-field")
      .locator(".mdc-notched-outline__leading");
    await expect(outline).toBeVisible();
    await expect(outline).toHaveCSS("border-top-style", "solid");
    await expect(outline).toHaveCSS("border-top-width", "2px");
    await expect(outline).toHaveCSS("border-top-color", /^rgb\(/);
  } else {
    await expect(locator).toHaveCSS("outline-style", "solid");
    await expect(locator).toHaveCSS("outline-width", /^[1-9][\d.]*px$/);
    await expect(locator).toHaveCSS("outline-color", /^rgb\(/);
  }
  await expect
    .poll(() =>
      locator.evaluate((element) => {
        const target = element.closest("mat-form-field") ?? element;
        const { left, right, top, bottom } = element.getBoundingClientRect();
        const visibleLeft = Math.max(left, 0);
        const visibleRight = Math.min(right, window.innerWidth);
        const visibleTop = Math.max(top, 0);
        const visibleBottom = Math.min(bottom, window.innerHeight);
        return (
          element.matches(":focus-visible") &&
          visibleLeft < visibleRight &&
          visibleTop < visibleBottom &&
          target.contains(
            document.elementFromPoint(
              (visibleLeft + visibleRight) / 2,
              (visibleTop + visibleBottom) / 2,
            ),
          )
        );
      }),
    )
    .toBe(true);
}

/** Verify each keyboard stop in order. */
async function tabThrough(
  page: Page,
  key: "Tab" | "Shift+Tab",
  ...controls: Locator[]
) {
  for (const control of controls) {
    await page.keyboard.press(key);
    await expectExposedFocus(control);
  }
}

/** Reach and fill the History access field with the keyboard. */
async function enterHistoryToken(page: Page, token: Locator) {
  await tabThrough(
    page,
    "Tab",
    page.getByRole("link", { name: "Berth home" }),
    page.getByRole("link", { name: "Infrastructure" }),
    page.getByRole("link", { name: "Operation history" }),
    token,
  );
  await page.keyboard.insertText("h".repeat(40));
}

/** Follow History access, pagination, an operation and the return link by keyboard. */
async function checkHistoryLayout(
  page: Page,
  {
    width,
    textScale,
    headingSize,
  }: {
    width: number;
    textScale: number;
    headingSize: number;
  },
) {
  await mockHistory(page);
  await page.goto("/operations");
  const heading = page.getByRole("heading", { name: "Operation history" });
  const token = page.getByLabel("History access token");
  const label = page.getByText("History access token", { exact: true });
  const hint = page.getByText("Kept in memory for this tab.", { exact: false });
  const load = page.getByRole("button", { name: "Load history" });
  await expect(page.locator("html")).toHaveCSS(
    "font-size",
    `${16 * textScale}px`,
  );
  await expect(heading).toHaveCSS("font-size", `${headingSize}px`);
  await expect(label).toHaveCSS("font-size", `${16 * textScale}px`);
  await expect(token).toHaveCSS("font-size", `${16 * textScale}px`);
  await expect(hint).toHaveCSS("font-size", `${12 * textScale}px`);
  await expect(load).toHaveCSS("font-size", `${14 * textScale}px`);
  await expectReadable(heading);
  await expectReadable(label);
  await expectReadable(hint);
  await expectNoHorizontalScroll(page, width);

  await enterHistoryToken(page, token);
  await expect
    .poll(async () => {
      const labelBox = await label.boundingBox();
      const inputBox = await token.boundingBox();
      return (
        labelBox !== null &&
        inputBox !== null &&
        labelBox.y + labelBox.height <= inputBox.y
      );
    })
    .toBe(true);
  await page.keyboard.press("Tab");
  await expectExposedFocus(load);
  await expectReadable(load);
  expect(
    await load.evaluate(
      (button) =>
        button.getBoundingClientRect().height >
        Number.parseFloat(getComputedStyle(button).lineHeight),
    ),
  ).toBe(true);
  await page.keyboard.press("Enter");

  const inbox = page.getByRole("region", { name: "Recorded operations" });
  const row = inbox.getByRole("link", { name: first });
  await expect(row).toBeVisible();
  await expectReadable(row.getByText(first, { exact: true }));
  const summary = row.getByText("Phase: cleanup · Unresolved mutations: 1");
  await expect(summary).toHaveCSS("font-size", `${14 * textScale}px`);
  await expectReadable(summary);
  await expectNoHorizontalScroll(page, width);

  await expectExposedFocus(
    inbox.getByRole("heading", { name: "Review inbox" }),
  );
  await page.keyboard.press("Shift+Tab");
  await expectExposedFocus(page.getByRole("button", { name: "Disconnect" }));
  const older = inbox.getByRole("button", { name: "Older operations" });
  await tabThrough(
    page,
    "Tab",
    inbox.getByRole("button", { name: "Refresh history" }),
    row,
    inbox.getByRole("button", { name: "Newest operations" }),
    older,
  );
  await expectReadable(older);
  await page.keyboard.press("Enter");
  const olderRow = inbox.getByRole("link", { name: second });
  await expect(olderRow).toBeVisible();
  await tabThrough(
    page,
    "Shift+Tab",
    inbox.getByRole("button", { name: "Newest operations" }),
    olderRow,
  );
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`/operations/${second}`);

  const detail = page.getByRole("region", { name: "Selected operation" });
  const detailHeading = detail.getByRole("heading", {
    name: "Operation details",
  });
  await expectExposedFocus(detailHeading);
  await expect(detailHeading).toHaveCSS("font-size", `${20 * textScale}px`);
  await expectReadable(detail.getByText(second, { exact: true }));
  await expectReadable(detail.getByText("14 / 40", { exact: true }));
  const recoveryLink = detail.getByRole("link", {
    name: "Owner recovery evidence checks",
  });
  await expectReadable(recoveryLink);
  const refresh = detail.getByRole("button", { name: "Refresh detail" });
  await tabThrough(page, "Tab", refresh, recoveryLink);
  await expectNoHorizontalScroll(page, width);

  await tabThrough(
    page,
    "Shift+Tab",
    refresh,
    detail.getByRole("link", { name: "Back to inbox" }),
  );
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/operations");
  await expectExposedFocus(olderRow);
}

test("History respects the Chromium default font size at 200% text with desktop width", async ({
  playwright,
  baseURL,
}) => {
  const profile = await mkdtemp(join(tmpdir(), "berth-history-font-"));
  try {
    await mkdir(join(profile, "Default"));
    await writeFile(
      join(profile, "Default", "Preferences"),
      JSON.stringify({ webkit: { webprefs: { default_font_size: 32 } } }),
    );
    const context = await playwright.chromium.launchPersistentContext(profile, {
      baseURL,
      channel: "chromium",
      viewport: { width: 1280, height: 820 },
    });
    try {
      await checkHistoryLayout(context.pages()[0], {
        width: 1280,
        textScale: 2,
        headingSize: 80,
      });
    } finally {
      await context.close();
    }
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("History reflows at 320 CSS pixels with default text", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 820 });
  await checkHistoryLayout(page, {
    width: 320,
    textScale: 1,
    headingSize: 28.8,
  });
});

/** Calculate WCAG contrast from Chromium's computed sRGB colors. */
function contrastRatio(foreground: number[], background: number[]) {
  const luminance = (channels: number[]) =>
    channels.reduce((total, channel, index) => {
      const srgb = channel / 255;
      const linear =
        srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
      return total + linear * [0.2126, 0.7152, 0.0722][index];
    }, 0);
  const light = luminance(foreground);
  const dark = luminance(background);
  return (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
}

/** Resolve a History surface and any Material state layer painted over it. */
async function measureContrast(
  subject: Locator,
  property: "color" | "border-top-color" | "outline-color" | "background-color",
  stateLayer?: { selector: string; coversForeground?: boolean },
) {
  const colors = await subject.evaluate(
    (element, { property, stateLayer }) => {
      const rgb = (color: string) => {
        const match = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(color);
        if (!match) {
          throw new Error(`Expected an opaque sRGB color, got ${color}`);
        }
        return match.slice(1).map(Number);
      };
      const style = getComputedStyle(element);
      const foreground = rgb(style.getPropertyValue(property));
      const outside =
        property === "background-color" ||
        property === "border-top-color" ||
        (property === "outline-color" &&
          Number.parseFloat(style.outlineOffset) >= 0);
      let surface = outside ? element.parentElement : element;
      while (surface) {
        const color = getComputedStyle(surface).backgroundColor;
        if (color !== "rgba(0, 0, 0, 0)") {
          const background = rgb(color);
          if (!stateLayer) {
            return { foreground, background };
          }
          const { selector, coversForeground } = stateLayer;
          const layer =
            element.closest(selector) ?? element.querySelector(selector);
          if (!layer) {
            throw new Error(`Missing Material state layer ${selector}`);
          }
          const { opacity, backgroundColor } = getComputedStyle(
            layer,
            "::before",
          );
          const alpha = Number(opacity);
          if (alpha === 0) {
            return { foreground, background };
          }
          const overlay = rgb(backgroundColor);
          const blend = (color: number[]) =>
            color.map(
              (channel, index) =>
                channel * (1 - alpha) + overlay[index] * alpha,
            );
          return {
            foreground: coversForeground ? blend(foreground) : foreground,
            background: blend(background),
          };
        }
        surface = surface.parentElement;
      }
      throw new Error("Expected a painted History surface");
    },
    { property, stateLayer },
  );
  return {
    ...colors,
    ratio: contrastRatio(colors.foreground, colors.background),
  };
}

test("History text, controls and keyboard indicators meet WCAG AA contrast", async ({
  page,
}, testInfo) => {
  const measurements: Record<
    string,
    Awaited<ReturnType<typeof measureContrast>>
  > = {};
  const measure = async (
    label: string,
    subject: Locator,
    property: Parameters<typeof measureContrast>[1] = "color",
    stateLayer?: Parameters<typeof measureContrast>[2],
  ) => {
    const result = await measureContrast(subject, property, stateLayer);
    measurements[label] = result;
    expect
      .soft(result.ratio, label)
      .toBeGreaterThanOrEqual(property === "color" ? 4.5 : 3);
  };

  await page.setViewportSize({ width: 1280, height: 820 });
  let failList = true;
  await page.route("**/api/history**", (route) => {
    if (route.request().url().endsWith(first)) {
      return route.fulfill({ json: item(first) });
    }
    if (failList) {
      return route.fulfill({ status: 503, json: {} });
    }
    return route.fulfill({ json: { items: [item(first)], next: first } });
  });
  await page.goto("/operations");
  const access = page.getByRole("region", { name: "History access" });
  const token = access.getByLabel("History access token");
  const outline = access.locator(".mdc-notched-outline__leading");
  const load = access.getByRole("button", { name: "Load history" });
  await expect(outline).toBeVisible();
  await measure("Token label", access.getByText("History access token"));
  await measure(
    "Token hint",
    access.getByText("Kept in memory for this tab.", { exact: false }),
  );
  await measure("Token field outline", outline, "border-top-color");
  await measure("Submit control fill", load, "background-color");

  await enterHistoryToken(page, token);
  await measure("Focused token outline", outline, "border-top-color");
  await page.keyboard.press("Tab");
  await expectExposedFocus(load);
  await measure("Focused submit label", load, "color", {
    selector: ".mat-mdc-button-persistent-ripple",
  });
  await measure("Submit focus ring", load, "outline-color");
  await page.keyboard.press("Enter");

  const inbox = page.getByRole("region", { name: "Recorded operations" });
  const retry = inbox.getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeVisible();
  await measure("Recoverable list error", inbox.locator(".error"));
  await measure("Retry button border", retry, "border-top-color");

  failList = false;
  await retry.click();
  const row = inbox.getByRole("link", { name: first });
  await expect(row).toBeVisible();
  const summary = row.getByText("Phase: cleanup · Unresolved mutations: 1");
  // The list state layer sits above row content and the inset focus ring.
  const rowStateLayer = { selector: ".operation-row", coversForeground: true };
  await page.mouse.move(0, 0);
  await measure("Inbox row summary", summary, "color", rowStateLayer);
  await row.click();
  await page.mouse.move(0, 0);
  const detail = page.getByRole("region", { name: "Selected operation" });
  await measure(
    "Owner recovery link",
    detail.getByRole("link", { name: "Owner recovery evidence checks" }),
  );
  await measure(
    "Detail budget value",
    detail.getByText("14 / 40", { exact: true }),
  );

  await expect(
    detail.getByRole("heading", { name: "Operation details" }),
  ).toBeFocused();
  await tabThrough(
    page,
    "Shift+Tab",
    detail.getByRole("link", { name: "Back to inbox" }),
    inbox.getByRole("button", { name: "Older operations" }),
    inbox.getByRole("button", { name: "Newest operations" }),
    row,
  );
  await expect(row).toHaveAttribute("aria-current", "page");
  await measure(
    "Selected row ID while focused",
    row.getByText(first, { exact: true }),
    "color",
    rowStateLayer,
  );
  await measure(
    "Selected row summary while focused",
    summary,
    "color",
    rowStateLayer,
  );
  await measure("Selected row focus ring", row, "outline-color", rowStateLayer);

  await testInfo.attach("wcag-contrast.json", {
    body: JSON.stringify(measurements, null, 2),
    contentType: "application/json",
  });
});
