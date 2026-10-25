import { mkdir } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

// Spec 019 areas amendment (W48–W53) in the browser, against the constructed review store that
// `bun run e2e:prepare` seeds with `metadata@2` fields (apps/web/scripts/people-e2e-fixture.ts).
// GitHub's avatar host is answered by a constructed image (or refused), so no real avatar loads.
// Set PEOPLE_SCREENSHOT_DIR to keep the screenshots.

const aliceRoute = `/kafka/people/${encodeURIComponent("github:alice")}`;
const bobRoute = `/kafka/people/${encodeURIComponent("github:bob")}`;
const AVATAR = "https://avatars.githubusercontent.com/**";
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="112" height="112"><rect width="112" height="112" fill="#8a4fb0"/><circle cx="56" cy="44" r="22" fill="#eef1fb"/><rect x="20" y="74" width="72" height="38" rx="18" fill="#eef1fb"/></svg>`;

async function open(page: Page, hash: string, options: { readonly locale?: string; readonly avatars?: "image" | "refused" } = {}) {
  const requested: string[] = [];
  await page.route(AVATAR, (route) => {
    requested.push(route.request().url());
    return options.avatars === "refused" ? route.abort() : route.fulfill({ status: 200, contentType: "image/svg+xml", body: SVG });
  });
  await page.addInitScript((value) => window.localStorage.setItem("community-kb-locale", value), options.locale ?? "en");
  await page.goto(hash);
  return requested;
}

async function noHorizontalOverflow(page: Page) {
  const { scroll, width } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  expect(scroll).toBeLessThanOrEqual(width);
}

async function screenshot(page: Page, name: string) {
  const directory = process.env.PEOPLE_SCREENSHOT_DIR;
  if (directory === undefined || directory === "") return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/${name}-${test.info().project.name}.png`, fullPage: true });
}

test("W48: the pull requests alice reviewed as a donut with every slice in text; process and KIP labels are not areas", async ({ page }) => {
  await open(page, aliceRoute);
  const given = page.locator('[data-areas="given"]');
  await expect(given.locator('[data-areas-state="chart"]')).toHaveCount(1);
  await expect(given.locator(".person-area-legend li")).toHaveText([
    /^clients\s*PRs 1 · 16\.7%$/u, /^consumer\s*PRs 1 · 16\.7%$/u, /^core\s*PRs 1 · 16\.7%$/u,
    /^storage\s*PRs 1 · 16\.7%$/u, /^streams\s*PRs 1 · 16\.7%$/u, /^tests\s*PRs 1 · 16\.7%$/u,
  ]);
  await expect(given.locator(".person-donut-slice")).toHaveCount(6);
  await expect(given.locator("svg.person-donut")).toHaveAttribute("aria-label", /^Pull requests reviewed: clients 16\.7%/u);
  await expect(given).toContainText("A pull request with several area labels counts in each");
  await expect(given.locator("[data-areas-kips]")).toHaveText("KIPs in titles or labels: KIP-932 1, KIP-1071 1");
  await expect(given.locator(".person-area-legend")).not.toContainText(/triage|ci-approved|small|KIP-932/u);
});

test("W49: alice's own pull request is in a month without labels: no chart, the coverage is stated", async ({ page }) => {
  await open(page, aliceRoute);
  const received = page.locator('[data-areas="received"]');
  await expect(received.locator('[data-areas-state="partial"]')).toHaveText("Area labels cover 0 of 1 pull requests so far (older months are not filled in yet); no chart until they are, so the shares are not misleading.");
  await expect(received.locator("svg")).toHaveCount(0);
  // 90 days: her own pull request falls out of the period, and the reviewed side has four areas.
  await page.getByRole("button", { name: "90 days" }).click();
  await expect(page.locator('[data-areas="received"]')).toHaveCount(0);
  await expect(page.locator('[data-areas="given"] .person-area-legend li')).toHaveCount(4);
});

test("W51 and W53: the header shows the avatar and the public name with the login beneath; without a name, the login", async ({ page }) => {
  const requested = await open(page, aliceRoute);
  await expect(page.locator(".person-name")).toHaveText("Alice Example");
  await expect(page.locator(".person-login")).toHaveText("alice");
  const avatar = page.locator('.person-head img[data-avatar="image"]');
  await expect(avatar).toHaveAttribute("src", "https://avatars.githubusercontent.com/alice?s=112");
  await expect(avatar).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(avatar).toHaveAttribute("loading", "lazy");
  await expect(avatar).toHaveAttribute("width", "56");
  await expect(avatar).toHaveAttribute("alt", "GitHub avatar of alice");
  await expect.poll(() => requested.some((url) => url.startsWith("https://avatars.githubusercontent.com/alice"))).toBe(true);
  await page.goto(bobRoute);
  await expect(page.locator(".person-name")).toHaveText("bob");
  await expect(page.locator(".person-login")).toHaveCount(0);
});

test("W53: when GitHub's avatar host does not answer, a neutral initial takes the avatar's place", async ({ page }) => {
  await open(page, aliceRoute, { avatars: "refused" });
  await expect(page.locator('.person-head [data-avatar="fallback"]')).toHaveText("A");
  await expect(page.locator('.person-head img[data-avatar="image"]')).toHaveCount(0);
});

for (const width of [320, 375]) {
  test(`W50: at ${width} px the area charts and the header have no horizontal overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page, aliceRoute, { locale: "zh-Hant" });
    await expect(page.locator('[data-areas="given"] .person-area-legend li')).toHaveCount(6);
    await expect(page.locator('[data-areas="given"]')).toContainText("一個 PR 有多個區域標籤時各算一次");
    await noHorizontalOverflow(page);
    await page.locator('[data-section="areas"]').scrollIntoViewIfNeeded();
    await screenshot(page, `profile-areas-alice-${width}-zh`);
  });
}

test("W52: the person result in Search shows the avatar and the public name", async ({ page }) => {
  await open(page, "/kafka/threads");
  const people = page.waitForResponse((response) => response.url().includes("/api/people/kafka?"));
  await page.locator("#q").fill("alice");
  await people;
  const card = page.locator(".person-result").first();
  await expect(card.locator(".person-result-name")).toHaveText("Alice Example");
  await expect(card.locator(".person-result-login")).toHaveText("alice");
  await expect(card.locator('img[data-avatar="image"]')).toHaveAttribute("src", "https://avatars.githubusercontent.com/alice?s=64");
  await screenshot(page, "search-person-alice");
});

test("W50: the desktop profile with both area sides", async ({ page }) => {
  await open(page, aliceRoute);
  await expect(page.locator('[data-areas="given"] .person-donut')).toBeVisible();
  await screenshot(page, "profile-areas-alice");
});
