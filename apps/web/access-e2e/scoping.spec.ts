// Header scoping on the wire: the real deployed-E2E fixtures, driven through a local
// proxy that stands in for every host (harness.ts). Dummy token only.
import { expect, test } from "../deployed-e2e/fixtures";
import { startHarness, type Harness, type Seen } from "./harness";

// Set by playwright.access.config.ts (dummy-token.ts), never a real token.
const dummyId = process.env.CF_ACCESS_CLIENT_ID;
const dummySecret = process.env.CF_ACCESS_CLIENT_SECRET;
const port = Number(process.env.ACCESS_HARNESS_PORT ?? 47391);
const dev = "https://oss-knowledge-base-dev.pages.dev";
const lookAlike = "https://evil-oss-knowledge-base-dev.pages.dev";
const accessLogin = "https://unknowntpo.cloudflareaccess.com/cdn-cgi/access/login/oss-knowledge-base-dev.pages.dev";

let harness: Harness;
test.beforeAll(async () => { harness = await startHarness(port); });
test.afterAll(async () => { await harness.close(); });
test.use({ baseURL: dev, proxy: { server: `http://127.0.0.1:${port}` }, ignoreHTTPSErrors: true });

function seenAt(host: string, path?: string): Seen[] {
  return harness.seen.filter((seen) => seen.host === host && (path === undefined || seen.path === path));
}

function tokenOn(host: string, path?: string): "token" | "none" | "not contacted" {
  const seen = seenAt(host, path);
  if (seen.length === 0) return "not contacted";
  const leaked = seen.filter((entry) => entry.id !== undefined || entry.secret !== undefined);
  if (leaked.length === 0) return "none";
  // Every request that carries headers must carry exactly the dummy pair.
  expect(leaked.every((entry) => entry.id === dummyId && entry.secret === dummySecret)).toBe(true);
  return leaked.length === seen.length ? "token" : "none";
}

test("browser: only the Dev Pages host and its preview subdomains receive the token", async ({ page }) => {
  const urls = {
    "oss-knowledge-base-dev.pages.dev": `${dev}/`,
    "abc123.oss-knowledge-base-dev.pages.dev": "https://abc123.oss-knowledge-base-dev.pages.dev/",
    "evil-oss-knowledge-base-dev.pages.dev": `${lookAlike}/`,
    "oss-knowledge-base-dev.pages.dev.evil.example": "https://oss-knowledge-base-dev.pages.dev.evil.example/",
    "fonts.googleapis.com": "https://fonts.googleapis.com/css2",
    "oss-knowledge-base-data-dev.unknowntpo.workers.dev": "https://oss-knowledge-base-data-dev.unknowntpo.workers.dev/health",
    "oss-knowledge-base.pages.dev": "https://oss-knowledge-base.pages.dev/",
  };
  for (const url of Object.values(urls)) await page.goto(url);
  expect(Object.fromEntries(Object.keys(urls).map((host) => [host, tokenOn(host)]))).toEqual({
    "oss-knowledge-base-dev.pages.dev": "token",
    "abc123.oss-knowledge-base-dev.pages.dev": "token",
    "evil-oss-knowledge-base-dev.pages.dev": "none",
    "oss-knowledge-base-dev.pages.dev.evil.example": "none",
    "fonts.googleapis.com": "none",
    "oss-knowledge-base-data-dev.unknowntpo.workers.dev": "none",
    "oss-knowledge-base.pages.dev": "none",
  });
});

for (const [name, target] of [["a look-alike host", `${lookAlike}/after`], ["the Access login", accessLogin]] as const) {
  test(`browser: a 302 from Dev Pages to ${name} does not carry the token`, async ({ page }) => {
    await page.goto(`${dev}/redirect?to=${encodeURIComponent(target)}`);
    const { hostname, pathname } = new URL(target);
    expect(page.url()).toBe(target);
    expect(tokenOn("oss-knowledge-base-dev.pages.dev", "/redirect")).toBe("token");
    expect(tokenOn(hostname, pathname)).toBe("none");
  });
}

test("request: Dev Pages gets the token, a redirect is returned instead of followed, other origins are refused", async ({ request }) => {
  const feed = await request.get("/api/feed");
  expect(feed.status()).toBe(200);
  expect(tokenOn("oss-knowledge-base-dev.pages.dev", "/api/feed")).toBe("token");

  const redirect = await request.get(`/redirect?to=${encodeURIComponent(`${lookAlike}/from-request`)}`);
  expect(redirect.status()).toBe(302);
  expect(tokenOn("evil-oss-knowledge-base-dev.pages.dev", "/from-request")).toBe("not contacted");

  await expect(request.get(`${lookAlike}/absolute`)).rejects.toThrow(/only for the Dev Pages origin/u);
  await expect(request.get("https://oss-knowledge-base-data-dev.unknowntpo.workers.dev/health")).rejects.toThrow(/only for the Dev Pages origin/u);
  expect(tokenOn("evil-oss-knowledge-base-dev.pages.dev", "/absolute")).toBe("not contacted");
});

test("publisherRequest: the publisher never receives the token", async ({ publisherRequest }) => {
  const health = await publisherRequest.get("https://oss-knowledge-base-data-dev.unknowntpo.workers.dev/health");
  expect(health.status()).toBe(200);
  expect(tokenOn("oss-knowledge-base-data-dev.unknowntpo.workers.dev", "/health")).toBe("none");
});
