/**
 * Spec 019 areas amendment (W48, W49, W51, W53): the area charts, the public name and the avatar
 * on the profile page, rendered on the server; and the Prod gate. Browser checks (320/375 px,
 * avatar loading and fallback) live in `e2e/people-areas.spec.ts`.
 */
import { beforeAll, describe, expect, test } from "bun:test";

import {
  encodeReviewMonth,
  GITHUB_REVIEWS_STATE_SCHEMA,
  githubReviewsMonthKey,
  githubReviewsStateKey,
  type ReviewMonthExtras,
  type ReviewRow,
} from "@oss-knowledge-base/reference-pipeline";
import { readPersonProfile, type PersonProfileV1 } from "@oss-knowledge-base/reference-pipeline/people";

import { AVATAR_HOST, githubAvatarUrl } from "../src/avatar";
import { onRequestGet as profileHandler } from "../functions/api/people/[project]/[id]";
import { registerVuePlugin } from "./vue-plugin";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const row = (reviewId: number, pr: number, submittedAt: string, reviewer = "ada", prAuthor = "grace"): ReviewRow =>
  ({ reviewId, pr, prAuthor, reviewer, isBot: false, state: "APPROVED", submittedAt, commit: null, inlineComments: 0 });

function store(months: readonly { month: string; rows: readonly ReviewRow[]; extras?: ReviewMonthExtras }[]) {
  const map = new Map<string, string>([[githubReviewsStateKey("apache-kafka"), JSON.stringify({ schema: GITHUB_REVIEWS_STATE_SCHEMA, updatedAt: "2026-10-14T22:00:00Z", coverageFrom: "2025-10-14T00:00:00.000Z" })]]);
  for (const entry of months) map.set(githubReviewsMonthKey("apache-kafka", entry.month), encodeReviewMonth("apache-kafka", entry.month, entry.rows, entry.extras));
  return { get: async (key: string) => (map.has(key) ? { text: async () => map.get(key)!, json: async () => JSON.parse(map.get(key)!) } : null) };
}
async function profile(months: Parameters<typeof store>[0], person = "github:ada"): Promise<PersonProfileV1> {
  const result = await readPersonProfile({ bucket: store(months), projectKey: "kafka", personId: person, nowMs: NOW });
  if (result.status !== 200) throw new Error(`status ${result.status}`);
  return result.body;
}

const FULL = [
  { month: "2026-09", rows: [row(1, 10, "2026-09-10T10:00:00Z"), row(3, 12, "2026-09-11T10:00:00Z", "grace", "ada")], extras: { pulls: { "10": { labels: ["clients", "triage"] }, "12": { labels: ["streams"] } }, people: { ada: "<b>Ada</b> & Co" } } },
  { month: "2026-10", rows: [row(2, 11, "2026-10-10T10:00:00Z")], extras: { pulls: { "11": { labels: ["core", "KIP-932"] } } } },
];

let render: (component: unknown, props: Record<string, unknown>, locale?: string) => Promise<string>;
let PersonProfile: unknown;
let GithubAvatar: unknown;
const scope = globalThis as unknown as Record<string, unknown>;

beforeAll(async () => {
  scope.document = { documentElement: {}, querySelectorAll: () => [], createElement: () => ({}) };
  scope.window ??= { localStorage: { getItem: () => null, setItem: () => undefined }, navigator: { language: "en" }, dispatchEvent: () => true };
  scope.history ??= { state: null, replaceState: () => undefined, pushState: () => undefined };
  registerVuePlugin();
  await import("../i18n.js");
  const { useI18n } = await import("../src/i18n");
  PersonProfile = (await import("../src/components/PersonProfile.vue")).default;
  GithubAvatar = (await import("../src/components/GithubAvatar.vue")).default;
  const { createSSRApp, h } = await import("vue");
  const { renderToString } = await import("vue/server-renderer");
  const { createMemoryHistory, createRouter } = await import("vue-router");
  render = async (component, props, locale = "en") => {
    useI18n().setLocale(locale);
    const app = createSSRApp({ render: () => h(component as never, props) });
    app.use(createRouter({ history: createMemoryHistory("/"), routes: [{ path: "/:pathMatch(.*)*", component: { render: () => null } }] }));
    return renderToString(app);
  };
});

const text = (html: string) => html.replace(/<!--[\s\S]*?-->/gu, "").replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();

describe("Spec 019 areas amendment: profile page", () => {
  test("W48: with every pull request covered, each side is a donut whose slices are also text with count and share", async () => {
    const page = await render(PersonProfile, { profile: await profile(FULL), nowMs: NOW });
    const given = page.slice(page.indexOf('data-areas="given"'), page.indexOf('data-areas="received"'));
    expect(given).toContain('data-areas-state="chart"');
    expect(text(given)).toContain("clients PRs 1 · 50%");
    expect(text(given)).toContain("core PRs 1 · 50%");
    expect(given).toContain('role="img"');
    expect(given).toContain('aria-label="Pull requests reviewed: clients 50%, core 50%"');
    expect(text(given)).toContain("KIPs in titles or labels: KIP-932 1");
    expect(text(given.slice(given.indexOf("person-area-legend"), given.indexOf("person-area-foot")))).not.toMatch(/triage|KIP-932/u);
    expect(text(page.slice(page.indexOf('data-areas="received"')))).toContain("streams PRs 1 · 100%");
  });

  test("W49: a pull request in a month without metadata: no chart on that side, the coverage in text", async () => {
    const body = await profile([{ ...FULL[0]!, extras: { people: {} } }, FULL[1]!]);
    const page = await render(PersonProfile, { profile: body, nowMs: NOW });
    const given = page.slice(page.indexOf('data-areas="given"'), page.indexOf('data-areas="received"'));
    expect(given).toContain('data-areas-state="partial"');
    expect(given).not.toContain("<svg");
    expect(text(given)).toContain("Area labels cover 1 of 2 pull requests so far");
    const zh = text(await render(PersonProfile, { profile: body, nowMs: NOW }, "zh-Hant"));
    expect(zh).toContain("區域標籤目前只涵蓋 1 / 2 個 PR");
  });

  test("W48: with review areas stored but no review in the selected period, the section says there is no activity instead of nothing", async () => {
    const body = await profile([{ month: "2026-05", rows: [row(5, 50, "2026-05-10T10:00:00Z")], extras: { pulls: { "50": { labels: ["core"] } } } }]);
    const page = await render(PersonProfile, { profile: body, nowMs: NOW, initialPeriod: "90d" });
    const areas = page.slice(page.indexOf('data-section="areas"'), page.indexOf('data-section="threads"'));
    expect(areas).toContain('data-areas-state="empty"');
    expect(text(areas)).toContain("No activity in this period.");
    expect(areas).not.toContain("<svg");
  });

  test("W46: without any metadata the section says what it said before and draws nothing", async () => {
    const page = await render(PersonProfile, { profile: await profile(FULL.map(({ month, rows }) => ({ month, rows }))), nowMs: NOW });
    expect(page).not.toContain("data-areas=");
    expect(text(page)).toContain("No area data from reviews");
  });

  test("W51: the public name is the heading with the login beneath, escaped; without a name the login alone", async () => {
    const page = await render(PersonProfile, { profile: await profile(FULL), nowMs: NOW });
    expect(page).toContain("&lt;b&gt;Ada&lt;/b&gt; &amp; Co");
    expect(page).not.toContain("<b>Ada</b>");
    expect(text(page)).toMatch(/^&lt;b&gt;Ada&lt;\/b&gt; &amp; Co ada Activity in Apache Kafka/u);
    const plain = await render(PersonProfile, { profile: await profile([{ month: "2026-10", rows: [row(2, 11, "2026-10-10T10:00:00Z")] }]), nowMs: NOW });
    expect(plain).not.toContain("data-login");
    expect(plain).toMatch(/class="person-name"[^>]*>ada</u);
  });

  test("W53: the avatar URL is built from a valid login only; anything else gets the neutral initial", async () => {
    expect(githubAvatarUrl("chia7712", 56)).toBe(`${AVATAR_HOST}/chia7712?s=112`);
    for (const bad of ["", "a/b", "../x", "x?y=1", "a b", "evil.com", "x#y", "-lead", "a".repeat(40), "dependabot[bot]", "javascript:alert(1)", null]) {
      expect(githubAvatarUrl(bad, 56)).toBeUndefined();
    }
    const html = await render(GithubAvatar, { login: "a/b", size: 20 });
    expect(html).toContain('data-avatar="fallback"');
    expect(html).not.toContain("<img");
    const image = await render(GithubAvatar, { login: "ada", size: 20, alt: "x" });
    expect(image).toMatch(/src="https:\/\/avatars\.githubusercontent\.com\/ada\?s=40"/u);
    for (const attribute of ['loading="lazy"', 'referrerpolicy="no-referrer"', 'width="20"', 'height="20"', 'alt="x"']) expect(image).toContain(attribute);
  });

  test("W53: on Prod (PEOPLE_PROFILES unset) the profile answers 404 and carries no name or avatar", async () => {
    const response = await (profileHandler as unknown as (context: unknown) => Promise<Response>)({
      env: { OSS_KB_BUCKET: store(FULL) }, params: { project: "kafka", id: "github:ada" }, request: new Request("https://prod.example/api/people/kafka/github:ada"),
    });
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).not.toContain("Ada");
    expect(body).not.toContain("pullAreas");
  });
});
