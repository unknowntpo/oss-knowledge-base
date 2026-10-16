/**
 * Spec 019 amendment (5), W56 and W60–W63: the top of the profile page — summary sentence, chart,
 * count tiles and data range — rendered on the server from the recorded Dev activity fixture
 * (`people-activity-fixture`) with and without the activity log. Browser checks (tooltip, table
 * toggle, 320/375 px, one request) live in `e2e/people-chart.spec.ts`.
 */
import { beforeAll, describe, expect, test } from "bun:test";

import {
  activityMonthsFromEvents,
  encodeActivityMonth,
  encodeReviewMonth,
  githubReviewsMonthKey,
  GITHUB_REVIEWS_STATE_SCHEMA,
  githubReviewsStateKey,
  PEOPLE_ACTIVITY_STATE_SCHEMA,
  peopleActivityMonthKey,
  peopleActivityStateKey,
} from "@oss-knowledge-base/reference-pipeline";
import { profileView, readPersonProfile, type PersonProfileV1 } from "@oss-knowledge-base/reference-pipeline/people";

import { fixtureEvents, peopleActivityFixture } from "../../../packages/reference-pipeline/test/support/people-activity-fixture";
import { registerVuePlugin } from "./vue-plugin";

const RELEASE = peopleActivityFixture.release;
const COVERAGE_FROM = new Date(Date.parse(RELEASE) - 35 * 86_400_000).toISOString();
const NOW = Date.parse(peopleActivityFixture.capturedAt);

function objects(withActivity = true): Map<string, string> {
  const map = new Map<string, string>();
  for (const projectId of ["apache-kafka", "apache-datafusion"]) {
    map.set(githubReviewsStateKey(projectId), JSON.stringify({ schema: GITHUB_REVIEWS_STATE_SCHEMA, updatedAt: "2026-10-14T22:02:21Z", coverageFrom: "2025-10-14T00:00:00.000Z" }));
    if (withActivity) map.set(peopleActivityStateKey(projectId), JSON.stringify({ schema: PEOPLE_ACTIVITY_STATE_SCHEMA, firstAppendAt: RELEASE, coverageFrom: COVERAGE_FROM, updatedAt: RELEASE, months: [] }));
  }
  if (withActivity) for (const month of activityMonthsFromEvents(fixtureEvents(), COVERAGE_FROM)) map.set(peopleActivityMonthKey(month.projectId, month.month), encodeActivityMonth(month));
  // One constructed review given in September, so the GitHub page exists without the log too.
  map.set(githubReviewsMonthKey("apache-kafka", "2026-09"), encodeReviewMonth("apache-kafka", "2026-09", [
    { reviewId: 9001, pr: 23001, prAuthor: "grace", reviewer: "m1a2st", isBot: false, state: "APPROVED", submittedAt: "2026-09-20T10:00:00Z", commit: null, inlineComments: 0 },
  ]));
  return map;
}
const bucket = (map: Map<string, string>) => ({ get: async (key: string) => (map.has(key) ? { text: async () => map.get(key)! } : null) });

async function profile(person: string, withActivity = true): Promise<PersonProfileV1> {
  const result = await readPersonProfile({ bucket: bucket(objects(withActivity)), projectKey: "kafka", personId: person, nowMs: NOW });
  if (result.status !== 200) throw new Error(`${person}: ${result.status}`);
  return result.body;
}
/** The same GitHub identity as if the community had no activity log: coverage says so, no `activity`. */
function withoutLog(body: PersonProfileV1): PersonProfileV1 {
  const { activity: _activity, ...rest } = body;
  return { ...rest, coverage: body.coverage.map((item) => (item.source === "github-reviews" ? item : { source: item.source, status: "not-recorded" as const })) };
}

let render: (component: unknown, props: Record<string, unknown>, locale?: string) => Promise<string>;
let PersonProfile: unknown;
let PersonActivityChart: unknown;
const scope = globalThis as unknown as Record<string, unknown>;

beforeAll(async () => {
  scope.document = { documentElement: {}, querySelectorAll: () => [], createElement: () => ({}) };
  scope.window ??= { localStorage: { getItem: () => null, setItem: () => undefined }, navigator: { language: "en" }, dispatchEvent: () => true };
  scope.history ??= { state: null, replaceState: () => undefined, pushState: () => undefined };
  registerVuePlugin();
  await import("../i18n.js");
  const { useI18n } = await import("../src/i18n");
  PersonProfile = (await import("../src/components/PersonProfile.vue")).default;
  PersonActivityChart = (await import("../src/components/PersonActivityChart.vue")).default;
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

const text = (html: string) => html.replace(/<!--[\s\S]*?-->/gu, "").replace(/<[^>]+>/gu, " ").replace(/&amp;/gu, "&").replace(/\s+/gu, " ").trim();
/** Tags removed without a space, as a reader sees adjacent inline elements. */
const inline = (html: string) => html.replace(/<!--[\s\S]*?-->/gu, "").replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ").trim();
const part = (html: string, from: string, to?: string) => {
  const start = html.indexOf(from);
  return html.slice(start, to === undefined ? undefined : html.indexOf(to, start));
};
const tile = (html: string, key: string) => {
  const start = html.indexOf(`data-count="${key}"`);
  return start < 0 ? undefined : text(html.slice(start, html.indexOf("</div>", start)).replace(/^[^>]*>/u, ""));
};

describe("Spec 019 amendment (5): the top of the profile", () => {
  test("W56: the sections are header, chart, tiles, areas, works with, threads, identities, how; the header has the name, badge, community and toggle", async () => {
    const html = await render(PersonProfile, { profile: await profile("github:m1a2st"), nowMs: NOW });
    expect([...html.matchAll(/data-section="([a-z-]+)"/gu)].map((match) => match[1])).toEqual(["header", "over-time", "activity", "areas", "works-with", "threads", "identities", "how"]);
    const header = text(part(html, 'data-section="header"', 'data-section="over-time"'));
    expect(header).toContain("m1a2st");
    expect(header).toContain("GitHub");
    expect(header).toContain("Activity in Apache Kafka");
    expect(header).toContain("12 months 90 days");
    expect(part(html, 'data-section="header"', 'data-section="over-time"')).not.toContain("person-coverage");
  });

  test("W56: the summary sentence uses the tiles' totals and says when the source starts inside the period, in both locales", async () => {
    const github = await profile("github:m1a2st");
    const totals = profileView(github, "12m", NOW).activity!.totals;
    const en = text(part(await render(PersonProfile, { profile: github, nowMs: NOW }), "data-summary", "</p>"));
    expect(en).toContain(`Past 12 months: reviewed 1 pull request, opened ${totals.pullRequests} pull requests (${totals.mergedPullRequests} merged), commented in ${totals.commentedThreads} threads (GitHub PRs and comments recorded since ${COVERAGE_FROM.slice(0, 10)})`);
    const zh = inline(part(await render(PersonProfile, { profile: github, nowMs: NOW }, "zh-Hant"), "data-summary", "</p>"));
    expect(zh).toContain(`過去 12 個月：審查了 1 個 PR、開了 ${totals.pullRequests} 個 PR（合併 ${totals.mergedPullRequests} 個）、在 ${totals.commentedThreads} 個討論留言（GitHub PR 與留言自 ${COVERAGE_FROM.slice(0, 10)} 起記錄）`);
    const mail = text(part(await render(PersonProfile, { profile: await profile("mail:Andrew Schofield"), nowMs: NOW }), "data-summary", "</p>"));
    expect(mail).toContain(`Past 12 months: wrote 23 dev@ messages in 11 threads (dev@ messages recorded since ${COVERAGE_FROM.slice(0, 10)})`);
    const jira = text(part(await render(PersonProfile, { profile: await profile("jira:Chia-Ping Tsai"), nowMs: NOW }, "zh-Hant"), "data-summary", "</p>"));
    expect(jira).toContain("回報 72 個 Jira issue、留言 12 則，共 78 個 issue");
  });

  test("W62: a GitHub page has four tiles with large numbers; a source not recorded says so and shows no number", async () => {
    const github = await profile("github:m1a2st");
    const html = await render(PersonProfile, { profile: github, nowMs: NOW });
    const keys = [...part(html, 'data-section="activity"', 'class="person-lower"').matchAll(/data-count="([a-z-]+)"/gu)].map((match) => match[1]);
    expect(keys).toEqual(["given", "received", "pull-requests", "comments"]);
    expect(tile(html, "pull-requests")).toBe(`Pull requests opened 7 5 merged recorded since ${COVERAGE_FROM.slice(0, 10)}`);
    expect(tile(html, "comments")).toBe(`Comments 26 on 20 threads · 7 on their own recorded since ${COVERAGE_FROM.slice(0, 10)}`);
    expect(tile(html, "given")).toBe("Reviews given 1 on 1 pull request · approved 1");
    const unlogged = await render(PersonProfile, { profile: withoutLog(github), nowMs: NOW }, "zh-Hant");
    expect(tile(unlogged, "pull-requests")).toBe("開啟的 PR 尚未記錄");
    expect(tile(unlogged, "comments")).toBe("留言 尚未記錄");
    expect(tile(unlogged, "given")).toBe("給出的審查 1 在 1 個 PR · 核准 1");
    expect(part(unlogged, 'data-count="pull-requests"', 'data-count="comments"')).not.toMatch(/>\s*0\s*</u);
  });

  test("W62: dev@ and Jira pages have three tiles of their own source", async () => {
    const mail = await render(PersonProfile, { profile: await profile("mail:Andrew Schofield"), nowMs: NOW });
    expect(tile(mail, "mail")).toBe(`dev@ messages 23 in 11 threads recorded since ${COVERAGE_FROM.slice(0, 10)}`);
    expect(tile(mail, "mail-discuss")).toContain("[DISCUSS] threads 4");
    expect(tile(mail, "mail-vote")).toContain("[VOTE] threads 4");
    expect(mail).toContain("person-tiles is-three");
    expect(mail).not.toMatch(/data-count="(given|received|pull-requests|comments)"/u);
    const jira = await render(PersonProfile, { profile: await profile("jira:Chia-Ping Tsai"), nowMs: NOW }, "zh-Hant");
    expect(tile(jira, "jira")).toContain("回報的 Jira issue 72");
    expect(tile(jira, "jira-comments")).toContain("Jira 留言 12");
    expect(tile(jira, "jira-threads")).toContain("參與的 Jira issue 78");
  });

  test("W60: a dev@ page with 35 days of data draws a 'not recorded yet' band and no 0 for the months before; a GitHub page without the log gets a lane", async () => {
    const mail = await render(PersonProfile, { profile: await profile("mail:Andrew Schofield"), nowMs: NOW });
    const chart = part(mail, 'data-section="over-time"', 'data-section="activity"');
    expect((chart.match(/data-bucket="/gu) ?? [])).toHaveLength(12);
    expect(chart).toContain("data-band");
    expect(text(chart)).toContain("Not recorded yet");
    expect(chart).not.toContain("data-lane");
    const unlogged = part(await render(PersonProfile, { profile: withoutLog(await profile("github:m1a2st")), nowMs: NOW }), 'data-section="over-time"', 'data-section="activity"');
    expect(unlogged).toContain('data-lane="github"');
    expect(unlogged).not.toContain("data-band");
    expect(unlogged).not.toContain('data-recorded="yes"');
    // Positive control: with the log, the lane has recorded buckets.
    const logged = part(await render(PersonProfile, { profile: await profile("github:m1a2st"), nowMs: NOW }), 'data-section="over-time"', 'data-section="activity"');
    expect(logged).toContain('data-recorded="yes"');
  });

  test("W61: the chart is an image with a text alternative, and its table gives every bucket with 'not recorded yet' for null", async () => {
    const mailProfile = await profile("mail:Andrew Schofield");
    const view = profileView(mailProfile, "12m", NOW);
    const input = { source: "mail", period: "12m", overTime: view.overTime, coverage: mailProfile.coverage, from: view.from, until: view.until, nowMs: NOW };
    const html = await render(PersonActivityChart, { input, name: "Andrew Schofield", initialTable: true });
    expect(html).toMatch(/role="img" aria-label="Activity of Andrew Schofield, past 12 months, per month: dev@ messages stacked above the axis\. Busiest [A-Z][a-z]+ 2026: \d+\. Show as table for every number\."/u);
    const rows = [...part(html, "data-chart-table").matchAll(/<tr>([\s\S]*?)<\/tr>/gu)].map((match) => text(match[1]!));
    expect(rows).toHaveLength(13);
    expect(rows[0]).toBe("Month dev@ messages");
    expect(rows[1]).toBe("November 2025 Not recorded yet");
    expect(rows.slice(1).filter((row) => row.endsWith("Not recorded yet"))).toHaveLength(10);
    expect(rows.at(-1)).toMatch(/^October 2026 \d+$/u);
    const zh = await render(PersonActivityChart, { input, name: "Andrew Schofield", initialTable: true }, "zh-Hant");
    expect(zh).toContain("Andrew Schofield過去 12 個月每月的活動長條圖：dev@ 郵件向上堆疊");
    expect(text(zh)).toContain("2025年11月 尚未記錄");
    // Closed by default: the table is behind "Show as table".
    const closed = await render(PersonActivityChart, { input, name: "Andrew Schofield" });
    expect(closed).not.toContain("data-chart-table");
    expect(text(closed)).toContain("Show as table");
  });

  test("W63: the coverage is one collapsed 'Data range' line under the chart; opened, it lists each source and the period", async () => {
    const html = await render(PersonProfile, { profile: await profile("github:m1a2st"), nowMs: NOW });
    const range = part(html, "data-range", "</details>");
    expect(range).toMatch(/^data-range[^>]*>/u);
    expect(range).not.toMatch(/^data-range[^>]* open/u);
    const from = `${Number(COVERAGE_FROM.slice(5, 7))}/${Number(COVERAGE_FROM.slice(8, 10))}`;
    expect(text(range)).toContain(`Data range: Reviews since 11/1 · Comments, pull requests since ${from}`);
    expect(text(range)).toContain(`Comments, pull requests, Jira, dev@: ${COVERAGE_FROM.slice(0, 10)} to`);
    expect(text(range)).toMatch(/2025-11-01 to \d{4}-\d{2}-\d{2} · \d+ days of data/u);
    const zh = text(part(await render(PersonProfile, { profile: await profile("mail:Andrew Schofield"), nowMs: NOW }, "zh-Hant"), "data-range", "</details>"));
    expect(zh).toContain(`資料範圍：dev@ ${from} 起`);
  });
});
