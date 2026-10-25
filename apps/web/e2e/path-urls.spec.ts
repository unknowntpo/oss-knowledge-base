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
