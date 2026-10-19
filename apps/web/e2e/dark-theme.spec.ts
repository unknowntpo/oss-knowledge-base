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
    // Compare with the bar as it was before the toggle (main at 3df9bc2), in the same browser and fonts:
    // no theme button, the full-width locale select, the old community width and gap. The pill must be
    // at least as wide, so it cannot wrap to more lines in any font.
    const pill = async () => { const box = (await page.locator(".demo-pill").boundingBox())!; return { width: Math.round(box.width), height: Math.round(box.height) }; };
    const withToggle = await pill();
    const before = await page.addStyleTag({ content: "@media (max-width: 420px) { .theme-cycle { display: none !important; } .locale-short { display: none !important; } .locale-control select { position: static !important; opacity: 1 !important; width: auto !important; height: 30px !important; padding: 0 var(--space-24) 0 var(--space-8) !important; } .community-control select { max-width: 92px !important; } .topbar-right { gap: var(--space-6) !important; } }" });
    const without = await pill();
    await before.evaluate((element) => element.remove());
    expect(withToggle.width).toBeGreaterThanOrEqual(without.width);
    expect(withToggle.height).toBeLessThanOrEqual(without.height);
    await button.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(button).toHaveAccessibleName("Theme: Light (press for Dark)");
    await button.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await button.click();
    await expect(button).toHaveAttribute("data-theme-current", "system");
  });
}

for (const width of [320, 375]) {
  for (const locale of ["en", "zh-Hant"] as const) {
    test(`DM2: at ${width} px (${locale}) the short locale label sits inside the top bar, overlaps no other control, is hidden from assistive tech, and still switches the language`, async ({ page }) => {
      await page.addInitScript((value) => window.localStorage.setItem("community-kb-locale", value), locale);
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/#/kafka/threads");
      const short = page.locator(".locale-short");
      await expect(short).toHaveText(locale === "en" ? "EN" : "中文");
      const box = async (selector: string) => (await page.locator(selector).boundingBox())!;
      const label = await box(".locale-short");
      const bar = await box(".topbar");
      expect(label.x).toBeGreaterThanOrEqual(bar.x);
      expect(label.y).toBeGreaterThanOrEqual(bar.y);
      expect(label.x + label.width).toBeLessThanOrEqual(bar.x + bar.width);
      expect(label.y + label.height).toBeLessThanOrEqual(bar.y + bar.height);
      const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
        a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      for (const other of [".community-control", "[data-theme-cycle]", ".demo-pill"]) {
        expect({ other, overlaps: overlaps(label, await box(other)) }).toEqual({ other, overlaps: false });
      }
      // One announcement: the short label is hidden; the select carries the name and its own value.
      await expect(short).toHaveAttribute("aria-hidden", "true");
      const select = page.getByRole("combobox", { name: locale === "en" ? "Language" : "語言", exact: true });
      await expect(select).toHaveCount(1);
      await expect(page.getByText(locale === "en" ? "EN" : "中文", { exact: true }).filter({ visible: true })).toHaveAttribute("aria-hidden", "true");
      await select.selectOption(locale === "en" ? "zh-Hant" : "en");
      await expect(short).toHaveText(locale === "en" ? "中文" : "EN");
    });
  }
}

test("DM2: at 375 px the locale focus ring follows the select's :focus-visible: shown after Tab, and after a mouse press exactly when the browser shows it on a native select", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/#/kafka/threads");
  const short = page.locator(".locale-short");
  const select = page.locator(".locale-control select");
  await expect(short).toHaveCSS("outline-style", "none");
  await page.locator("[data-theme-cycle]").focus();
  await page.keyboard.press("Tab");
  await expect(select).toBeFocused();
  await expect(short).toHaveCSS("outline-style", "solid");
  await expect(short).toHaveCSS("outline-color", "rgb(140, 155, 232)");
  // A mouse press (no key event). Chromium matches :focus-visible on a focused <select> even after a
  // mouse press, as for text inputs, so the proxy ring must do what the native community select does.
  await page.locator("main").click({ position: { x: 5, y: 5 } });
  const press = async (selector: string) => {
    const box = (await page.locator(selector).boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  };
  await press(".community-switcher");
  const native = await page.locator(".community-switcher").evaluate((element) => getComputedStyle(element).outlineStyle);
  await page.locator("main").click({ position: { x: 5, y: 5 } });
  await press(".locale-control select");
  await expect(select).toBeFocused();
  const matches = await select.evaluate((element) => element.matches(":focus-visible"));
  await expect(short).toHaveCSS("outline-style", matches ? "solid" : "none");
  expect(matches ? "solid" : "none").toBe(native);
});

test("DM2: every theme option has its own accessible name (not only a title)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/#/kafka/threads");
  for (const [choice, name] of [["light", "Light"], ["dark", "Dark"], ["system", "System"]]) {
    await expect(page.locator(`[data-theme-choice="${choice}"]`)).toHaveAttribute("aria-label", name);
  }
});
