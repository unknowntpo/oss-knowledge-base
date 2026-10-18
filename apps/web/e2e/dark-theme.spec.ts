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
