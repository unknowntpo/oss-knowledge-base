// bun run verify:ui -- --target local|dev --view feed,search-detail --width 375 --locale zh-Hant --at +3h1s
// Opens the web app with a controlled viewport, locale and clock, then records a
// screenshot and element states per view. Read-only: it only issues GET requests.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { chromium, type Page } from "playwright";

import {
  formatUiSummary,
  parseAt,
  parseUiArgs,
  resolveAt,
  targets,
  UsageError,
  type Capture,
  type ElementState,
  type UiOptions,
  type UiSummary,
  type View,
} from "./args";

// The same key the app reads (apps/web/src/i18n.ts).
const localeStorageKey = "community-kb-locale";

async function feedGeneratedAt(baseUrl: string): Promise<string | undefined> {
  const response = await fetch(`${baseUrl}/api/feed`);
  if (!response.ok) throw new Error(`GET ${baseUrl}/api/feed -> ${response.status}`);
  const body = (await response.json()) as { metadata?: { manifest?: { generatedAt?: string } } };
  return body.metadata?.manifest?.generatedAt;
}

async function openView(page: Page, baseUrl: string, options: UiOptions, view: View): Promise<void> {
  await page.goto(`${baseUrl}/#${options.route}`);
  if (options.route !== "/") {
    await page.waitForLoadState("networkidle");
    return;
  }
  await page.locator(".card").first().waitFor();
  if (view === "feed-detail") {
    await page.locator(".card").first().click();
    await page.waitForURL(/#\/feed\//u);
  }
  if (view === "search" || view === "search-detail") {
    await page.locator("#q").fill(options.query);
    await page.locator(".search-card").first().waitFor();
  }
  if (view === "search-detail") {
    await page.locator(".search-card").first().click();
    await page.waitForURL(/#\/search\//u);
  }
  // The detail view reuses .load-error for its loading state; wait for content or a real error.
  if (view !== "feed" && view !== "search") {
    await page.locator(".topic-wrap, .load-error:not(:has-text('Loading detail'))").first().waitFor();
  }
}

async function elementState(page: Page, selector: string): Promise<ElementState> {
  const locator = page.locator(selector);
  const count = await locator.count();
  if (count === 0) return { selector, count, visible: false };
  const first = locator.first();
  const visible = await first.isVisible();
  const details = await first.evaluate((element) => ({
    className: element.getAttribute("class") ?? "",
    text: (element as HTMLElement).innerText ?? element.textContent ?? "",
    overflowX: element.scrollWidth > element.clientWidth,
  }));
  const box = (await first.boundingBox()) ?? undefined;
  return { selector, count, visible, ...details, ...(box ? { box } : {}) };
}

async function capture(page: Page, baseUrl: string, options: UiOptions, view: View, out: string): Promise<Capture> {
  await openView(page, baseUrl, options, view);
  const screenshot = resolve(out, `${view}.png`);
  // Viewport only: a full Dev feed is taller than Chromium can capture.
  await page.screenshot({ path: screenshot });
  const page_ = await page.evaluate(() => ({
    htmlLang: document.documentElement.lang,
    pageOverflowX: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > window.innerWidth,
  }));
  const elements = [];
  for (const selector of options.selectors) elements.push(await elementState(page, selector));
  return { view, url: page.url(), screenshot, ...page_, elements };
}

async function main(): Promise<void> {
  const options = parseUiArgs(process.argv.slice(2));
  const baseUrl = targets[options.target].pages;
  const generatedAt = await feedGeneratedAt(baseUrl).catch((error: unknown) => {
    if (options.target === "local") {
      throw new Error(`${String(error)}\nStart the fixture server first: bun run e2e:prepare && bun run e2e:server`);
    }
    throw error;
  });
  const time = resolveAt(parseAt(options.at), generatedAt);
  const out = resolve(options.out);
  await mkdir(out, { recursive: true });

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: options.width, height: options.height } });
    await context.addInitScript(
      ([key, value]) => window.localStorage.setItem(key!, value!),
      [localeStorageKey, options.locale],
    );
    if (time !== undefined) {
      if (options.frozen) await context.clock.setFixedTime(time);
      else await context.clock.install({ time });
    }
    const page = await context.newPage();
    const captures = [];
    for (const view of options.views) captures.push(await capture(page, baseUrl, options, view, out));
    const summary: UiSummary = {
      target: options.target,
      baseUrl,
      width: options.width,
      height: options.height,
      locale: options.locale,
      ...(generatedAt ? { generatedAt } : {}),
      clock: time === undefined ? "real" : new Date(time).toISOString(),
      frozen: options.frozen,
      captures,
    };
    await writeFile(resolve(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(formatUiSummary(summary));
    console.log(`evidence: ${out}`);
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof UsageError ? `usage: ${error.message}` : error instanceof Error ? error.message : error);
  process.exit(error instanceof UsageError ? 2 : 1);
});
