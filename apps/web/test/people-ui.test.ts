/**
 * Spec 019 slice 2a: the profile page rendered server-side in Bun from profiles the reader builds
 * out of Spec 022's recorded rows. Browser-only checks (navigation, layout at 320/375 px) live in
 * `e2e/people.spec.ts`.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  encodeReviewMonth,
  GITHUB_REVIEWS_STATE_SCHEMA,
  githubReviewsMonthKey,
  githubReviewsStateKey,
  parsePullReviews,
  reviewMonth,
  reviewRows,
  type ReviewRow,
} from "@oss-knowledge-base/reference-pipeline";
import { readPersonProfile, type PeopleErrorV1, type PersonProfileV1 } from "@oss-knowledge-base/reference-pipeline/people";

import { constructedRows } from "../../../packages/reference-pipeline/test/contributor-profile.cases";
import { registerVuePlugin } from "./vue-plugin";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const STATE = { schema: GITHUB_REVIEWS_STATE_SCHEMA, updatedAt: "2026-10-14T22:02:21Z", coverageFrom: "2025-10-14T00:00:00.000Z" };
const recorded = JSON.parse(readFileSync(join(import.meta.dir, "../../../packages/reference-pipeline/test/fixtures/github-reviews/graphql-pull-reviews-kafka.json"), "utf8"));
const page = parsePullReviews(recorded, [23675, 23809, 99999999, 23165]);
if (!page.ok) throw new Error(page.error);
const rows: readonly ReviewRow[] = [
  ...page.pulls.flatMap((pull) => reviewRows(pull, { from: STATE.coverageFrom, machineUsers: [] }).rows),
  ...(constructedRows as unknown as readonly ReviewRow[]),
];

function bucket(projectId: string, broken: readonly string[] = []) {
  const objects = new Map<string, string>([[githubReviewsStateKey(projectId), JSON.stringify(STATE)]]);
  const byMonth = new Map<string, ReviewRow[]>();
  for (const row of rows) byMonth.set(reviewMonth(row.submittedAt), [...(byMonth.get(reviewMonth(row.submittedAt)) ?? []), row]);
  for (const [month, monthRows] of byMonth) objects.set(githubReviewsMonthKey(projectId, month), encodeReviewMonth(projectId, month, monthRows));
  for (const month of broken) objects.set(githubReviewsMonthKey(projectId, month), "{");
  return { get: async (key: string) => (objects.has(key) ? { text: async () => objects.get(key)! } : null) };
}

async function profile(person: string, options: { project?: string; broken?: readonly string[] } = {}): Promise<PersonProfileV1> {
  const project = options.project ?? "kafka";
  const result = await readPersonProfile({ bucket: bucket(project === "kafka" ? "apache-kafka" : "apache-datafusion", options.broken), projectKey: project, personId: person, nowMs: NOW });
  if (result.status !== 200) throw new Error(`${person}: ${result.status}`);
  return result.body;
}

let render: (component: unknown, props: Record<string, unknown>, locale?: string) => Promise<string>;
let components: { PersonProfile: unknown; PersonNotFound: unknown };
let people: typeof import("../src/people");
const scope = globalThis as unknown as Record<string, unknown>;

beforeAll(async () => {
  scope.document = { documentElement: {}, querySelectorAll: () => [], createElement: () => ({}) };
  scope.window ??= { localStorage: { getItem: () => null, setItem: () => undefined }, navigator: { language: "en" }, dispatchEvent: () => true };
  scope.history ??= { state: null, replaceState: () => undefined, pushState: () => undefined };
  registerVuePlugin();
  await import("../i18n.js");
  const { useI18n } = await import("../src/i18n");
  components = {
    PersonProfile: (await import("../src/components/PersonProfile.vue")).default,
    PersonNotFound: (await import("../src/components/PersonNotFound.vue")).default,
  };
  people = await import("../src/people");
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

describe("Spec 019 slice 2a: profile page", () => {
  test("W5: sections appear in the spec's order; the header names the person, the community, the period and the days of data", async () => {
    const html = await render(components.PersonProfile, { profile: await profile("github:lucasbru"), nowMs: NOW });
    const order = [...html.matchAll(/data-section="([a-z-]+)"/gu)].map((match) => match[1]);
    expect(order).toEqual(["header", "identities", "activity", "over-time", "areas", "threads", "works-with", "how"]);
    const header = text(html.slice(0, html.indexOf('data-section="identities"')));
    expect(header).toContain("lucasbru");
    expect(header).toContain("Activity in Apache Kafka");
    expect(header).toContain("2025-11-01 to 2026-10-14 · 348 days of data");
    const body = text(html);
    expect(body).toContain("Reviews given 4 reviews on 1 pull request approved 1, commented 3");
    expect(body).toContain("Reviews received 1 review on 1 pull request from 1 reviewer");
    expect(body).toContain("#23165 reviewed · PR by gabriellefu · approved 1, commented 3 2026-10-06");
    expect(html).toContain('href="https://github.com/apache/kafka/pull/23165#pullrequestreview-5425459798"');
    expect(html).toContain(`href="/kafka/people/${encodeURIComponent("github:bbejeck")}"`);
  });

  test("W27: the header lists each source's coverage; a source not recorded has no count", async () => {
    const kafka = text(await render(components.PersonProfile, { profile: await profile("github:chia7712"), nowMs: NOW }));
    expect(kafka).toContain("Reviews: 2025-11-01 to 2026-10-14");
    expect(kafka).toContain("Comments, pull requests, Jira, dev@: not recorded yet");
    expect(kafka).toContain("Not recorded yet: Comments, pull requests, Jira, dev@.");
    expect(kafka).not.toMatch(/(Jira|dev@)\s*:?\s*0\b/u);
    const datafusion = text(await render(components.PersonProfile, { profile: await profile("github:chia7712", { project: "datafusion" }), nowMs: NOW }));
    expect(datafusion).toContain("Comments, pull requests: not recorded yet");
    expect(datafusion).not.toContain("Jira");
    const zh = text(await render(components.PersonProfile, { profile: await profile("github:chia7712"), nowMs: NOW }, "zh-Hant"));
    expect(zh).toContain("審查：2025-11-01 至 2026-10-14");
    expect(zh).toContain("GitHub 留言與 PR、Jira、dev@：尚未記錄");
  });

  test("W6: with rows only before the selected period the page says so and draws no chart; positive control in 12 months", async () => {
    const edge = await profile("github:edge-reviewer");
    const quarter = await render(components.PersonProfile, { profile: edge, nowMs: NOW, initialPeriod: "90d" });
    expect(text(quarter)).toContain("No activity in this period.");
    expect(quarter).not.toContain("person-over-time");
    const year = await render(components.PersonProfile, { profile: edge, nowMs: NOW });
    expect(text(year)).not.toContain("No activity in this period.");
    expect(year).toContain("person-over-time");
  });

  test("W10: a month that could not be read is named on the page", async () => {
    const html = text(await render(components.PersonProfile, { profile: await profile("github:mjsax", { broken: ["2026-09"] }), nowMs: NOW }));
    expect(html).toContain("Data for 2026-09 is unavailable and not counted.");
    expect(html).toContain("Reviews given 1 review on 1 pull request");
    // Positive control: nothing is named when every month reads.
    expect(text(await render(components.PersonProfile, { profile: await profile("github:mjsax"), nowMs: NOW }))).not.toContain("unavailable");
  });

  test("W11: an identity without recorded activity says so and names what is recorded", async () => {
    const error: PeopleErrorV1 = (await readPersonProfile({ bucket: bucket("apache-kafka"), projectKey: "kafka", personId: "github:nobody-here", nowMs: NOW })).body as PeopleErrorV1;
    const html = text(await render(components.PersonNotFound, { projectKey: "kafka", status: 404, error }));
    expect(html).toContain("No recorded activity for this identity in Apache Kafka.");
    expect(html).toContain("Reviews: 2025-11-01 to 2026-10-14");
    expect(html).toContain("Comments, pull requests, Jira, dev@: not recorded yet");
  });

  test("W28: a GitHub author links to the profile on Dev; bots, Jira and dev@ authors do not; nothing links with profiles off", () => {
    expect(people.personRoute(true, "kafka", "github", "chia7712")).toBe(`/kafka/people/${encodeURIComponent("github:chia7712")}`);
    expect(people.personRoute(true, "datafusion", "github", "alamb")).toBe(`/datafusion/people/${encodeURIComponent("github:alamb")}`);
    expect(people.personRoute(true, "kafka", "github", "github-actions[bot]")).toBeUndefined();
    expect(people.personRoute(true, "datafusion", "github", "codecov-commenter")).toBeUndefined();
    expect(people.personRoute(true, "kafka", "jira", "Chia-Ping Tsai")).toBeUndefined();
    expect(people.personRoute(true, "kafka", "mail", "Andrew Schofield")).toBeUndefined();
    // A Jira or dev@ name that happens to look like a login is still not a GitHub identity (strict identity).
    expect(people.personRoute(true, "kafka", "jira", "chia7712")).toBeUndefined();
    expect(people.personRoute(true, "kafka", "mail", "mjsax")).toBeUndefined();
    expect(people.personRoute(true, "kafka", "github", "not a login")).toBeUndefined();
    expect(people.personRoute(false, "kafka", "github", "chia7712")).toBeUndefined();
  });
});
