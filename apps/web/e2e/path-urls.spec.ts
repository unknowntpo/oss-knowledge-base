import { expect, test } from "@playwright/test";

// Spec 032 in the browser, against the local Pages server (`wrangler pages dev dist`), which
// serves index.html for page paths the way Cloudflare Pages does.

const alice = `/kafka/people/${encodeURIComponent("github:alice")}`;

test("U1: a deep path loads index.html with absolute asset URLs and shows the profile", async ({ page, request }) => {
  const response = await request.get(alice);
  expect(response.status()).toBe(200);
  const html = await response.text();
  expect(html).toContain('<div id="app">');
  expect(html).toMatch(/<script type="module" crossorigin src="\/assets\/[^"]+\.js">/u);
  expect(html).toMatch(/<link rel="stylesheet" crossorigin href="\/assets\/[^"]+\.css">/u);

  await page.goto(alice);
  await expect(page.locator(`article.person[data-person="github:alice"]`)).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(alice);
  expect(page.url()).not.toContain("#");
});

test("U2: an in-app link is a path URL and navigates without a page load", async ({ page }) => {
  await page.goto("/feed/KAFKA-PR-43");
  await page.evaluate(() => { (window as unknown as { marker: number }).marker = 1; });
  const author = page.locator("a.author-link", { hasText: "bob" }).first();
  const bob = `/kafka/people/${encodeURIComponent("github:bob")}`;
  await expect(author).toHaveAttribute("href", bob);
  await author.click();
  await expect(page.locator(".person-name")).toHaveText("bob");
  expect(new URL(page.url()).pathname).toBe(bob);
  // Same document: a full page load would have dropped the marker.
  expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(1);
});

test("U2: an internal citation chip is a router link: the URL changes without a page load", async ({ page }) => {
  // The fixture digest cites threads with https source URLs, which link out. Without a source URL a
  // cite links to Detail (Spec 014 Behavior 19), so drop the URLs to get internal cites.
  await page.route("**/api/digest?*", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { threads: Record<string, { url: string | null }> };
    for (const thread of Object.values(body.threads)) thread.url = null;
    await route.fulfill({ response, json: body });
  });
  await page.goto("/kafka/");
  const cite = page.locator('a.cite[href^="/feed/"]').first();
  await expect(cite).toBeVisible();
  const href = (await cite.getAttribute("href"))!;
  await page.evaluate(() => { (window as unknown as { marker: number }).marker = 1; });
  await cite.click();
  await expect(page).toHaveURL((url) => url.pathname === href);
  await expect(page.locator("#view-topic")).toBeAttached();
  expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(1);
});

test("U4: the legacy rewrite replaces the hash URL and adds no history entry", async ({ page }) => {
  await page.goto("/kafka/threads");
  await expect(page.locator("#view-feed")).toBeVisible();
  const before = await page.evaluate(() => history.length);
  await page.goto(`/#${alice}`);
  await expect(page.locator(`article.person[data-person="github:alice"]`)).toBeVisible();
  // One entry for the load itself; a pushState rewrite would add a second.
  expect(await page.evaluate(() => history.length)).toBe(before + 1);
  await page.goBack();
  await expect(page).toHaveURL((url) => url.pathname === "/kafka/threads" && url.hash === "");
});

test("U4: an old #/ link lands on its path form, also when a path precedes the hash", async ({ page }) => {
  await page.goto(`/#${alice}`);
  await expect(page.locator(`article.person[data-person="github:alice"]`)).toBeVisible();
  await expect(page).toHaveURL((url) => url.pathname === alice && url.hash === "");

  await page.goto("/kafka/people/x#/kafka/");
  await expect(page.locator("#view-week")).toBeVisible();
  await expect(page).toHaveURL((url) => url.pathname === "/kafka/" && url.hash === "");
});

test("U5: an in-page anchor that is not #/ keeps its URL", async ({ page }) => {
  await page.goto("/kafka/threads#main");
  await expect(page.locator("#view-feed")).toBeVisible();
  await expect(page).toHaveURL((url) => url.pathname === "/kafka/threads" && url.hash === "#main");
});

test("U6: an unknown deep path shows not-found and /api stays with the Functions", async ({ page, request }) => {
  await page.goto("/kafka/no/such/page");
  await expect(page.locator(".digest-notice.not-found")).toBeVisible();

  const api = await request.get("/api/feed");
  expect(api.status()).toBe(200);
  expect(api.headers()["content-type"]).toContain("application/json");
  expect(typeof (await api.json())).toBe("object");
});
