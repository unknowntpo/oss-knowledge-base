/**
 * Spec 030 slice 1: the trend card on This week, rendered on the server from the responses
 * `readProjectActivity` gives for the stores of `project-trend.store.ts`. Browser checks (press to
 * expand, one request, order on the page, no request with the flag off) live in
 * `e2e/project-trend.spec.ts`.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { readProjectActivity, type ProjectActivityV1 } from "@oss-knowledge-base/reference-pipeline/project-activity";

import enFixture from "./fixtures/digest/apache-kafka.en.json";
import { CountingBucket, NOW, PROJECT_ID, store, type StoreName } from "./project-trend.store";
import { registerVuePlugin } from "./vue-plugin";

let render: (component: unknown, props: Record<string, unknown>, locale?: string) => Promise<string>;
let ProjectTrendCard: unknown;
let DigestWeek: unknown;
let kafkaProfile: unknown;
const scope = globalThis as unknown as Record<string, unknown>;

beforeAll(async () => {
  scope.document = { documentElement: {}, querySelectorAll: () => [], createElement: () => ({}) };
  scope.window ??= { localStorage: { getItem: () => null, setItem: () => undefined }, navigator: { language: "en" }, dispatchEvent: () => true };
  scope.history ??= { state: null, replaceState: () => undefined, pushState: () => undefined };
  registerVuePlugin();
  await import("../i18n.js");
  const { useI18n } = await import("../src/i18n");
  ProjectTrendCard = (await import("../src/components/digest/ProjectTrendCard.vue")).default;
  DigestWeek = (await import("../src/components/digest/DigestWeek.vue")).default;
  kafkaProfile = (await import("../src/digest-view")).projectByKey("kafka")!.profile;
  const { createSSRApp, h } = await import("vue");
  const { renderToString } = await import("vue/server-renderer");
  const { createMemoryHistory, createRouter } = await import("vue-router");
  render = async (component, props, locale = "zh-Hant") => {
    useI18n().setLocale(locale);
    const app = createSSRApp({ render: () => h(component as never, props) });
    app.use(createRouter({ history: createMemoryHistory("/"), routes: [{ path: "/:pathMatch(.*)*", component: { render: () => null } }] }));
    return renderToString(app);
  };
});

async function body(name: StoreName = "full"): Promise<ProjectActivityV1> {
  const result = await readProjectActivity({ bucket: new CountingBucket(store(name)), projectId: PROJECT_ID, nowMs: NOW });
  if (result.status !== 200) throw new Error(String(result.status));
  return result.body;
}
const card = async (props: Record<string, unknown>, locale?: string) =>
  render(ProjectTrendCard, { projectName: "Apache Kafka", nowMs: NOW, ...props }, locale);
const text = (html: string) => html.replace(/<!--[\s\S]*?-->/gu, "").replace(/<[^>]+>/gu, " ").replace(/&amp;/gu, "&").replace(/\s+/gu, " ").trim();
const inline = (html: string) => html.replace(/<!--[\s\S]*?-->/gu, "").replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ").trim();
const part = (html: string, from: string, to?: string) => {
  const start = html.indexOf(from);
  return start < 0 ? "" : html.slice(start, to === undefined ? undefined : html.indexOf(to, start));
};

describe("Spec 030: the compact card", () => {
  test("PT5: 12 bars, the first and last month labels, the current month in progress to 10/24, and hatched lanes for the three activity series before 9/10", async () => {
    const html = await card({ answer: { kind: "ok", body: await body() } });
    expect(html).toContain('class="project-trend"');
    expect(text(part(html, "project-trend-title", "</h2>"))).toContain("專案活動趨勢");
    expect(html.match(/data-trend-bucket="/gu)).toHaveLength(12);
    expect([...html.matchAll(/data-trend-label="([^"]+)"/gu)].map((match) => match[1])).toEqual(["2025-11", "2026-10"]);
    expect(text(part(html, 'data-trend-label="2026-10"', "</text>"))).toContain("10月");
    expect(inline(part(html, "data-in-progress", "</text>"))).toContain("進行中 · 至 10/24");
    expect(part(html, 'data-trend-bucket="2026-10"', "</g>")).toContain("is-current");
    expect(part(html, 'data-trend-bucket="2026-09"', "</g>")).not.toContain("is-current");
    expect([...html.matchAll(/data-lane="([a-z]+)"/gu)].map((match) => match[1])).toEqual(["github", "jira", "mail"]);
    for (const series of ["github", "jira", "mail"]) {
      const lane = part(html, `data-lane="${series}"`, "</g>");
      expect(lane.match(/data-recorded="no"/gu)).toHaveLength(10);
      expect(lane.match(/data-recorded="yes"/gu)).toHaveLength(2);
    }
    const plot = Number(/data-plot-height="(\d+(?:\.\d+)?)"/u.exec(html)![1]);
    expect(plot).toBeGreaterThan(0);
    expect(plot).toBeLessThanOrEqual(96);
    // No totals written on the bars and no axis ticks in the compact card.
    expect(html).not.toContain("data-total");
    expect(html).not.toContain("person-chart-grid");
    expect(text(part(html, "data-trend-toggle", "</button>").replace(/^[^>]*>/u, ""))).toBe("查看完整趨勢");
  });

  test("PT5: with every series recorded there is no lane (positive control for the hatching)", async () => {
    const recorded = await body();
    const all = { ...recorded, coverage: recorded.coverage.map((item) => (item.status === "recorded" ? { ...item, from: "2025-11-01T00:00:00.000Z" } : item)),
      months: recorded.months.map((month) => ({ ...month, github: month.github ?? 1, jira: month.jira ?? 1, mail: month.mail ?? 1 })) };
    const html = await card({ answer: { kind: "ok", body: all } });
    expect(html).not.toContain("data-lane");
  });

  test("PT5: the card is an image whose text names the range and the newest month's counts", async () => {
    const html = await card({ answer: { kind: "ok", body: await body() } }, "en");
    expect(html).toMatch(/role="img" aria-label="Apache Kafka, November 2025 to October 2026, events per month\. October 2026 \(in progress\): GitHub reviews 31, GitHub PRs and comments 47, Jira issues and comments 44, dev@ messages 20\."/u);
    // Behavior 9: the full view says the same and points to the table.
    const full = await card({ answer: { kind: "ok", body: await body() }, initialExpanded: true }, "en");
    expect(full).toMatch(/role="img" aria-label="Apache Kafka, November 2025 to October 2026, events per month\. October 2026 \(in progress\): GitHub reviews 31, [^"]*dev@ messages 20\. Show as table for every number\."/u);
  });
});

describe("Spec 030: the full view", () => {
  test("PT6: expanded, the card shows the profile chart with no down series, the legend, the table toggle, the 9/10 marker and the data range line", async () => {
    const html = await card({ answer: { kind: "ok", body: await body() }, initialExpanded: true });
    expect(html).toContain("person-chart-svg");
    expect(html).not.toContain("data-trend-bucket");
    expect(html).not.toContain('data-series="received"');
    expect(html).not.toContain('data-total="down"');
    expect([...html.matchAll(/data-legend="([a-z-]+)"/gu)].map((match) => match[1])).toEqual(["given", "github", "jira", "mail", "not-recorded"]);
    expect(text(part(html, "data-chart-legend", "</ul>").replace(/^[^>]*>/u, ""))).toBe("GitHub 審查 GitHub PR 與留言 Jira issue 與留言 dev@ 郵件 尚未記錄");
    expect(text(part(html, "data-table-toggle", "</button>").replace(/^[^>]*>/u, ""))).toBe("以表格檢視");
    expect(text(part(html, "data-marker", "</g>").replace(/^[^>]*>/u, ""))).toBe("PR 與留言自此記錄");
    expect(text(part(html, "data-range", "</summary>"))).toContain("資料範圍：GitHub 審查 11/1 起 · GitHub 留言與 PR、Jira、dev@ 9/10 起");
    expect(text(part(html, "data-trend-toggle", "</button>").replace(/^[^>]*>/u, ""))).toBe("收合");
    expect(html.match(/data-bucket="/gu)).toHaveLength(12);
  });

  test("PT6: without a later-starting series there is no marker (positive control)", async () => {
    const html = await card({ answer: { kind: "ok", body: await body("no-activity") }, initialExpanded: true });
    expect(html).toContain("person-chart-svg");
    expect(html).not.toContain("data-marker");
  });

  test("PT7: the 2026-09 tooltip says the activity series count only from 9/10; a null table cell has class is-unrecorded", async () => {
    const recorded = await body();
    const html = await card({ answer: { kind: "ok", body: recorded }, initialExpanded: true, initialHover: 10, initialTable: true });
    const tip = text(part(html, "data-tip", "</div>"));
    expect(tip).toContain("2026年9月");
    expect(tip).toContain("GitHub PR 與留言自 9/10 起記錄");
    expect(tip).toContain("Jira issue 與留言自 9/10 起記錄");
    expect(tip).toContain("dev@ 郵件自 9/10 起記錄");
    const rows = [...part(html, "data-chart-table").matchAll(/<tr>([\s\S]*?)<\/tr>/gu)].map((match) => match[1]!);
    expect(rows[1]!.match(/class="is-unrecorded"/gu)).toHaveLength(3);
    expect(text(rows[1]!)).toBe("2025年11月 20 尚未記錄 尚未記錄 尚未記錄");
    expect(rows[12]).not.toContain("is-unrecorded");
    // Positive control: a bucket without a partial start has no note.
    const october = text(part(await card({ answer: { kind: "ok", body: recorded }, initialExpanded: true, initialHover: 11 }), "data-tip", "</div>"));
    expect(october).not.toContain("起記錄");
  });

  test("PT15: the full view shows when the stores were updated, from `until`", async () => {
    const html = await card({ answer: { kind: "ok", body: await body() }, initialExpanded: true });
    expect(text(part(html, "data-range", "</details>"))).toContain("資料更新於 2026-10-24 02:45 UTC");
    expect(text(part(html, "data-range", "</details>"))).toContain("計數單位為事件");
  });
});

describe("Spec 030: failure, absence, staleness", () => {
  test("PT9: an unreadable month is named on the card", async () => {
    const html = await card({ answer: { kind: "ok", body: await body("review-month-corrupt") } });
    expect(text(html)).toContain("2026年3月資料暫時無法取得");
    expect(text(await card({ answer: { kind: "ok", body: await body() } }))).not.toContain("暫時無法取得");
  });

  test("PT10: a failed request leaves one line and no chart", async () => {
    const html = await card({ answer: { kind: "error" } });
    expect(text(html)).toBe("活動趨勢暫時無法取得");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("data-trend-toggle");
  });

  test("PT11: nothing recorded: no card at all (positive control: a reviews-only store shows it)", async () => {
    expect(text(await card({ answer: { kind: "ok", body: await body("nothing") } }))).toBe("");
    expect(await card({ answer: { kind: "ok", body: await body("no-activity") } })).toContain("data-trend-bucket");
  });

  test("PT15: data older than 48 hours shows the lag line on the card (positive control: 47 hours does not)", async () => {
    const recorded = await body();
    const at = (hours: number) => Date.parse(recorded.until!) + hours * 3_600_000;
    const stale = await card({ answer: { kind: "ok", body: recorded }, nowMs: at(49) });
    expect(text(part(stale, "digest-lag", "</p>"))).toContain("活動資料更新於 10/24");
    expect(await card({ answer: { kind: "ok", body: recorded }, nowMs: at(47) })).not.toContain("digest-lag");
  });
});

describe("Spec 030: placement and colours", () => {
  test("PT4: with the flag on, This week is stats, trend card, highlights, in that order; with it off there is no card", async () => {
    const props = { digest: enFixture, profile: kafkaProfile, projectName: "Apache Kafka", now: NOW };
    const html = await render(DigestWeek, { ...props, trend: true }, "en");
    const order = ["digest-stats", "project-trend", "digest-highlights"].map((name) => html.indexOf(`class="${name}`));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(await render(DigestWeek, props, "en")).not.toContain("project-trend");
  });

  test("PT8: every mark takes a --data-* series, the current month only adds a dash, and no rule for the card defines a custom property", async () => {
    const html = await card({ answer: { kind: "ok", body: await body() } });
    const series = new Set([...part(html, "<svg", "</svg>").matchAll(/data-series="([a-z]+)"/gu)].map((match) => match[1]));
    expect([...series].sort()).toEqual(["github", "given", "jira", "mail"]);
    expect(part(html, "<svg", "</svg>")).not.toMatch(/\b(?:fill|stroke)="(?!url\()/u);
    const css = readFileSync(join(import.meta.dir, "..", "styles.css"), "utf8");
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].filter((match) => /project-trend/u.test(match[1]!));
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.filter((match) => /(?:^|;)\s*--[\w-]+\s*:/u.test(match[2]!)).map((match) => match[1]!.trim())).toEqual([]);
    const current = rules.find((match) => /is-current/u.test(match[1]!))!;
    expect(current[2]).toMatch(/stroke-dasharray/u);
    expect(current[2]).not.toMatch(/(?:^|;)\s*(?:fill|stroke)\s*:/u);
  });
});
