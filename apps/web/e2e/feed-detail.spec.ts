import { expect, test, type Page } from "@playwright/test";

function collectBrowserProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`page: ${error.message}`));
  page.on("requestfailed", (request) => problems.push(
    `request: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`,
  ));
  return problems;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("community-kb-locale", "en");
  });
});

test("evidence search opens its immutable FeedDetail timeline", async ({ page }) => {
  const browserProblems = collectBrowserProblems(page);
  const feedResponse = page.waitForResponse((response) => response.url().endsWith("/api/feed"));

  await page.goto("/#/kafka/threads");
  expect((await feedResponse).status()).toBe(200);
  await expect(page.locator("#view-feed")).toBeVisible();
  await expect(page.locator(".card")).toHaveCount(2);
  // Spec 014: All threads is the Feed for the route project.
  await expect(page.locator(".card-project")).toContainText([
    "Apache Kafka",
    "Apache Kafka",
  ]);

  const searchResponse = page.waitForResponse((response) =>
    response.url().includes("/api/search?") && response.url().includes("KIP-405"));
  await page.locator("#q").fill("KIP-405");
  expect((await searchResponse).status()).toBe(200);
  const result = page.locator(".search-card").first();
  await expect(result).toContainText("KIP-405: Kafka Tiered Storage");
  await expect(result.locator(".evidence").first()).toContainText("Tiered storage");
  await result.click();

  await expect(page).toHaveURL(/#\/search\/sdr1\./);
  await expect(page.getByRole("heading", {
    level: 1,
    name: "KIP-405: Kafka Tiered Storage",
  })).toBeVisible();
  await expect(page.locator(".timeline .tl-item")).toHaveCount(3);
  await expect(page.getByRole("button", { name: /Wiki\s*1/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Mailing list\s*1/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /GitHub\s*1/ })).toBeVisible();
  await expect(page.locator(".tl-link").first()).toHaveAttribute(
    "href",
    /^https:\/\//,
  );
  await expect(page.locator(".key-points-state")).toContainText(
    "No summarizer is configured",
  );
  expect(browserProblems).toEqual([]);
});

test("project facets shrink with the query and stay consistent when selected", async ({ page }) => {
  const browserProblems = collectBrowserProblems(page);
  await page.goto("/#/kafka/threads");
  await expect(page.locator("#view-feed")).toBeVisible();

  const initialResponse = page.waitForResponse((response) =>
    response.url().includes("/api/search?") &&
    response.url().includes("q=producer") &&
    !response.url().includes("projectId="));
  await page.locator("#q").fill("producer");
  expect((await initialResponse).status()).toBe(200);
  const filtersToggle = page.getByRole("button", { name: "Filters" });
  if (await filtersToggle.isVisible()) await filtersToggle.click();
  const kafkaProject = page.getByRole("button", { name: /Apache Kafka/ });
  const dataFusionProject = page.getByRole("button", { name: /Apache DataFusion/ });
  await expect(kafkaProject).toHaveText(/Apache Kafka\s*3/);
  await expect(dataFusionProject).toHaveText(/Apache DataFusion\s*0/);

  const projectResponse = page.waitForResponse((response) =>
    response.url().includes("/api/search?") &&
    response.url().includes("projectId=apache-kafka") &&
    !response.url().includes("projectStatus="));
  await kafkaProject.click();
  const projectBody = await (await projectResponse).json() as {
    readonly results: readonly unknown[];
    readonly facets: { readonly projects: readonly { readonly projectId: string; readonly count: number }[] };
  };
  expect(projectBody.results).toHaveLength(3);
  expect(projectBody.facets.projects.find((facet) => facet.projectId === "apache-kafka")?.count)
    .toBe(3);
  await expect(page.locator(".search-card")).toHaveCount(3);

  const filteredResponse = page.waitForResponse((response) =>
    response.url().includes("/api/search?") &&
    response.url().includes("projectStatus=merged"));
  await page.getByRole("button", { name: "Merged" }).click();
  expect((await filteredResponse).status()).toBe(200);

  const results = page.locator(".search-card");
  await expect(results).toHaveCount(1);
  await expect(results.first()).toContainText("RecordAccumulator.ready()");
  await expect(results.first()).toContainText("Merged");
  expect(browserProblems).toEqual([]);
});

test("H25: the default bucket still serves bm25-reference@1 (the @2 bucket is playwright.lexical2.config.ts)", async ({ request }) => {
  const response = await request.get("/api/search?q=KIP770&limit=5");
  expect(response.status()).toBe(200);
  const body = await response.json() as { readonly results: readonly unknown[]; readonly retrieval: { readonly lexicalRevision: string } };
  expect(body.retrieval.lexicalRevision).toBe("bm25-reference@1");
  expect(body.results).toEqual([]);
  // Positive control: the hyphenated spelling is found at `@1`.
  const hyphenated = await (await request.get("/api/search?q=KIP-405&limit=5")).json() as typeof body;
  expect(hyphenated.results.length).toBeGreaterThan(0);
});

// Spec 023: the computed colours on the real page (the stylesheet rules are unit-tested in
// test/design-system.test.ts).
function channelLuminance(rgb: string): number {
  const [r, g, b] = (rgb.match(/\d+(\.\d+)?/gu) ?? []).slice(0, 3).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [channelLuminance(a), channelLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

test("DS1, DS2: timeline avatars have a per-author background and GitHub badges stay slate", async ({ page }) => {
  await page.goto("/#/feed/KAFKA-PR-43");
  const avatar = page.locator(".tl-meta .avatar").first();
  await expect(avatar).toHaveText("B");
  await expect(avatar).toHaveAttribute("data-hue", "2");
  const avatarColours = await avatar.evaluate((node) => {
    const style = getComputedStyle(node);
    return { color: style.color, background: style.backgroundColor };
  });
  expect(avatarColours.background).toBe("rgb(43, 122, 91)");
  expect(ratio(avatarColours.color, avatarColours.background)).toBeGreaterThanOrEqual(4.5);

  const badges = page.locator(".source-badge.src-github");
  expect(await badges.count()).toBeGreaterThan(0);
  for (const badge of await badges.all()) {
    const colours = await badge.evaluate((node) => {
      const style = getComputedStyle(node);
      return [style.color, style.backgroundColor];
    });
    expect(colours).toEqual(["rgb(76, 73, 89)", "rgb(238, 237, 241)"]);
  }

  await page.goto(`/#/kafka/people/${encodeURIComponent("github:alice")}`);
  const header = page.locator(".person-meta .source-badge.src-github");
  await expect(header).toHaveCSS("color", "rgb(58, 83, 176)");
  await expect(page.locator(".person-identity .source-badge.src-github")).toHaveCSS("color", "rgb(76, 73, 89)");
});

test("DS7: a focused top-bar control shows the light indigo ring; small labels use the text floor", async ({ page }) => {
  await page.goto("/#/feed/KAFKA-PR-43");
  await page.keyboard.press("Tab");
  const locale = page.locator(".locale-control select");
  await locale.focus();
  await expect(locale).toHaveCSS("outline-color", "rgb(140, 155, 232)");
  await expect(page.locator(".brand-scope")).toHaveCSS("color", "rgb(143, 140, 150)");
  await expect(page.locator(".tl-time").first()).toHaveCSS("color", "rgb(107, 104, 96)");
});

test("DS8: timeline filter counts are solid colours that pass in both states", async ({ page }) => {
  await page.goto("/#/feed/KAFKA-PR-43");
  const all = page.locator(".tl-filter", { hasText: "All sources" });
  const github = page.locator(".tl-filter", { hasText: "GitHub" });
  await expect(all).toHaveAttribute("aria-pressed", "true");
  await expect(all.locator(".count")).toHaveCSS("color", "rgb(58, 83, 176)");
  await expect(all.locator(".count")).toHaveCSS("opacity", "1");
  await expect(github.locator(".count")).toHaveCSS("color", "rgb(107, 104, 96)");
  await github.click();
  await expect(github.locator(".count")).toHaveCSS("color", "rgb(58, 83, 176)");
  await expect(github.locator(".count")).toHaveCSS("opacity", "1");
});

// Spec 023 DS9: one badge system on feed, detail, proposals and topic pages.
const STATE_TEXT: Record<string, string> = {
  success: "rgb(28, 94, 68)", info: "rgb(29, 78, 137)", warning: "rgb(122, 74, 18)",
  progress: "rgb(107, 97, 180)", neutral: "rgb(107, 94, 121)", danger: "rgb(184, 67, 42)",
};

test("DS9: open is info blue and merged success green on the feed; every digest badge takes its colour from its state", async ({ page }) => {
  await page.goto("/#/kafka/threads");
  const open = page.locator(".card", { hasText: "KAFKA-ISSUE-42" }).locator(".status-badge");
  const merged = page.locator(".card", { hasText: "KAFKA-PR-43" }).locator(".status-badge");
  await expect(open).toHaveAttribute("data-state", "info");
  await expect(open).toHaveCSS("color", STATE_TEXT.info!);
  await expect(open).toHaveCSS("background-color", "rgb(227, 238, 250)");
  await expect(merged).toHaveAttribute("data-state", "success");
  await expect(merged).toHaveCSS("color", STATE_TEXT.success!);

  await page.goto("/#/kafka/");
  await page.locator("#digest, .digest-notice").first().waitFor();
  const vote = page.locator(".stage-badge.stage-vote").first();
  await expect(vote).toHaveAttribute("data-state", "warning");
  await expect(vote).toHaveCSS("color", STATE_TEXT.warning!);
  await expect(page.locator(".stage-badge.stage-discuss").first()).toHaveCSS("color", STATE_TEXT.info!);
  await expect(page.locator(".stage-badge.stage-implementing").first()).toHaveCSS("color", STATE_TEXT.success!);

  await page.locator(".topic-card-title a").first().click();
  const statuses = page.locator(".thread-status");
  await expect(statuses.first()).toBeVisible();
  for (const badge of await statuses.all()) {
    const state = await badge.getAttribute("data-state");
    await expect(badge).toHaveCSS("color", STATE_TEXT[state!]!);
  }
});

test("DS5: the source-distribution bar is a translucent fill with a 3:1 outline", async ({ page }) => {
  await page.goto("/#/feed/KAFKA-PR-43");
  await expect(page.locator(".rail-source .bar").first()).toHaveCSS("box-shadow", "rgb(86, 108, 115) 0px 0px 0px 1px inset");
});
