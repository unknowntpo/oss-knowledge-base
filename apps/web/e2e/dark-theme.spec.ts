import { expect, test, type Page } from "@playwright/test";

// Spec 024 in the browser: the theme before first paint (DM1), a stored choice and a live OS change
// (DM1), storage that throws (DM3), the tooltip layer (DM7), color-scheme (DM8), and every page at
// 320/375 px in both themes. Token values are unit-tested in test/dark-theme.test.ts.

const DARK_PAGE = "rgb(24, 24, 29)";
const LIGHT_PAGE = "rgb(245, 244, 241)";
const aliceRoute = `/#/kafka/people/${encodeURIComponent("github:alice")}`;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  return errors;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try { window.localStorage.setItem("community-kb-locale", "en"); } catch { /* DM3 runs without storage */ }
  });
});

test("DM1: a dark OS gets a dark first paint before the app script has run", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/assets/*.js", async (route) => { await held; await route.continue(); });
  await page.goto("/#/kafka/threads", { waitUntil: "commit" });
  await page.waitForFunction(() => document.body !== null && getComputedStyle(document.body).backgroundColor !== "rgba(0, 0, 0, 0)");
  const first = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    background: getComputedStyle(document.body).backgroundColor,
    scheme: getComputedStyle(document.documentElement).colorScheme,
    appMounted: (document.getElementById("app")?.childElementCount ?? 0) > 0,
  }));
  expect(first).toEqual({ theme: "dark", background: DARK_PAGE, scheme: "dark", appMounted: false });
  release();
  await expect(page.locator(".card").first()).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("DM1: a light OS stays light; a stored choice wins over the OS and survives a reload; a live OS change is followed only without one", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/#/kafka/threads");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("body")).toHaveCSS("background-color", LIGHT_PAGE);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("body")).toHaveCSS("background-color", DARK_PAGE);

  await page.evaluate(() => window.localStorage.setItem("osskb.theme", "light"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "light" });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("DM3: storage that throws still renders the OS theme, without errors", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("blocked", "SecurityError"); } });
  });
  const errors = collectErrors(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/#/kafka/threads");
  await expect(page.locator(".card").first()).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(errors).toEqual([]);
});

test("DM7: the chart tooltip sits on the popover layer in dark", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(aliceRoute);
  await expect(page.locator(".person-chart-svg")).toBeVisible();
  const hit = page.locator(".person-chart-hit").nth(10);
  await hit.scrollIntoViewIfNeeded();
  const box = (await hit.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator("[data-tip]")).toHaveCSS("background-color", "rgb(44, 44, 53)");
  await expect(page.locator('.person-chart-svg path[data-series="given"]').first()).toHaveCSS("stroke", "rgb(125, 185, 222)");
});

for (const width of [320, 375]) {
  for (const scheme of ["light", "dark"] as const) {
    test(`DM8: every page at ${width} px in ${scheme} has the theme's page colour and no sideways scroll`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ colorScheme: scheme });
      for (const hash of ["/#/kafka/threads", "/#/feed/KAFKA-PR-43", "/#/kafka/", "/#/kafka/proposals", aliceRoute, `/#/kafka/people/${encodeURIComponent("mail:dana mailer")}`]) {
        await page.goto(hash);
        await page.waitForLoadState("networkidle");
        await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
        await expect(page.locator("body")).toHaveCSS("background-color", scheme === "dark" ? DARK_PAGE : LIGHT_PAGE);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect({ hash, overflow }).toEqual({ hash, overflow: 0 });
      }
    });
  }
}

// Spec 024 DM2: the top-bar toggle.
const themeColors = (page: Page) => page.locator('meta[name="theme-color"]').evaluateAll((metas) => metas.map((meta) => meta.getAttribute("content")));

test("DM2: the toggle switches the theme at once, persists across a reload, and updates theme-color", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 }); // the radio group shows above 420 px
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/#/kafka/threads");
  const group = page.getByRole("radiogroup", { name: "Theme" });
  await expect(group.getByRole("radio", { name: "System" })).toHaveAttribute("aria-checked", "true");
  await group.getByRole("radio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("body")).toHaveCSS("background-color", DARK_PAGE);
  expect(await themeColors(page)).toEqual(["#101013", "#101013"]);
  expect(await page.evaluate(() => window.localStorage.getItem("osskb.theme"))).toBe("dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("radio", { name: "Light" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await themeColors(page)).toEqual(["#16161a", "#16161a"]);
});

test("DM2: 跟隨系統 follows a live OS change; zh-Hant labels", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 }); // the radio group shows above 420 px
  await page.addInitScript(() => window.localStorage.setItem("community-kb-locale", "zh-Hant"));
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/#/kafka/threads");
  const group = page.getByRole("radiogroup", { name: "外觀" });
  await group.getByRole("radio", { name: "深色" }).click();
  await group.getByRole("radio", { name: "跟隨系統" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => window.localStorage.getItem("osskb.theme"))).toBeNull();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await themeColors(page)).toEqual(["#16161a", "#101013"]);
  await expect(group.getByRole("radio", { name: "淺色" })).toBeVisible();
});

test("DM2: the toggle works from the keyboard with the light focus ring", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 }); // the radio group shows above 420 px
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/#/kafka/threads");
  const system = page.getByRole("radio", { name: "System" });
  await system.focus();
  await page.keyboard.press("ArrowLeft");
  const dark = page.getByRole("radio", { name: "Dark" });
  await expect(dark).toBeFocused();
  await expect(dark).toHaveAttribute("aria-checked", "true");
  await expect(dark).toHaveCSS("outline-color", "rgb(140, 155, 232)");
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("radio", { name: "Light" })).toHaveAttribute("tabindex", "0");
});

test("DM2: with storage that throws, the toggle still applies the theme for the session", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 }); // the radio group shows above 420 px
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("blocked", "SecurityError"); } });
  });
  const errors = collectErrors(page);
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/#/kafka/threads");
  await page.getByRole("radio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(errors).toEqual([]);
});

for (const width of [320, 375]) {
  test(`DM2: at ${width} px one theme button inside the top bar cycles the choice, and the stale pill wraps to no more lines than before`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/#/kafka/threads");
    await expect(page.locator("[data-theme-control]")).toBeHidden();
    const button = page.locator("[data-theme-cycle]");
    await expect(button).toHaveAccessibleName("Theme: System (press for Light)");
    const bar = (await page.locator(".topbar").boundingBox())!;
    const box = (await button.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y).toBeGreaterThanOrEqual(bar.y);
    expect(box.y + box.height).toBeLessThanOrEqual(bar.y + bar.height);
    // Before the toggle (main at 3df9bc2) the stale pill was 53 × 142 px at 320 and 108 × 57 px at 375.
    expect(Math.round((await page.locator(".demo-pill").boundingBox())!.height)).toBeLessThanOrEqual(width === 320 ? 142 : 57);
    await button.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(button).toHaveAccessibleName("Theme: Light (press for Dark)");
    await button.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await button.click();
    await expect(button).toHaveAttribute("data-theme-current", "system");
  });
}
