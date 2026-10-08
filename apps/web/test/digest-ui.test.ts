/**
 * Spec 014 slice 3: the UI case file and named page tests, rendered server-side in Bun from the
 * fixture digests (`test/fixtures/digest/`). Browser-only checks (layout, navigation) live in
 * `e2e/digest.spec.ts`.
 */
import { beforeAll, describe, expect, test } from "bun:test";

import { readDigest } from "../functions/_shared/digest";
import { testPlanRows } from "../../../packages/reference-pipeline/test/topic-digest-ui.cases";
import enFixture from "./fixtures/digest/apache-kafka.en.json";
import zhFixture from "./fixtures/digest/apache-kafka.zh-Hant.json";
import { registerVuePlugin } from "./vue-plugin";

type Translate = (key: string, variables?: Readonly<Record<string, string | number>>) => string;
type View = typeof import("../src/digest-view");

let view: View;
let translations: (locale: string) => Translate;
let render: (component: unknown, props: Record<string, unknown>, locale?: string) => Promise<string>;
let routes: typeof import("../src/routes");
let components: {
  DigestWeek: unknown; DigestSentence: unknown; ProposalColumns: unknown; TopicPage: unknown; DigestStates: unknown;
};

const scope = globalThis as unknown as Record<string, unknown>;

beforeAll(async () => {
  // runtime-dom and vue-router touch these at import time; i18n.js reads window.
  scope.document = { documentElement: {}, querySelectorAll: () => [], createElement: () => ({}) };
  scope.window ??= { localStorage: { getItem: () => null, setItem: () => undefined }, navigator: { language: "en" }, dispatchEvent: () => true };
  scope.history ??= { state: null, replaceState: () => undefined, pushState: () => undefined };
  registerVuePlugin();
  await import("../i18n.js");
  const i18n = (scope.window as { KB_I18N: { setLocale(locale: string): void; t: Translate } }).KB_I18N;
  translations = (locale) => (key, variables) => {
    i18n.setLocale(locale);
    return i18n.t(key, variables);
  };
  view = await import("../src/digest-view");
  routes = await import("../src/routes");
  const { useI18n } = await import("../src/i18n");
  components = {
    DigestWeek: (await import("../src/components/digest/DigestWeek.vue")).default,
    DigestSentence: (await import("../src/components/digest/DigestSentence.vue")).default,
    ProposalColumns: (await import("../src/components/digest/ProposalColumns.vue")).default,
    TopicPage: (await import("../src/components/digest/TopicPage.vue")).default,
    DigestStates: (await import("../src/views/DigestStates.vue")).default,
  };
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

const en = enFixture as unknown as import("../src/digest-view").ServedDigest;
const zh = zhFixture as unknown as import("../src/digest-view").ServedDigest;
const kafka = () => view.projectByKey("kafka")!;
const NOW = Date.parse("2026-10-07T03:37:00.000Z");

function count(html: string, pattern: RegExp): number {
  return (html.match(pattern) ?? []).length;
}

type CaseRow = (typeof testPlanRows)[number];
const cases: Record<string, () => Promise<string>> = {
  "injection|constructed: sentence text contains \"<img src=x onerror=alert(1)>\"": async () => {
    const html = await render(components.DigestSentence, { sentence: { text: "<img src=x onerror=alert(1)>", cites: ["KAFKA-PR-23426"] }, digest: en });
    return html.includes("&lt;img src=x onerror=alert(1)&gt;") && !html.includes("<img") ? "kept as text; rendered escaped" : html;
  },
  "freshness|digest generatedAt 2026-10-07T01:37:00Z, now 2026-10-08T13:37:00Z (36 h)": async () => {
    const freshness = view.digestFreshness("2026-10-07T01:37:00Z", Date.parse("2026-10-08T13:37:00Z"))!;
    return `${translations("en")(freshness.key, { n: freshness.n })}; ${freshness.stale ? "stale" : "not stale"}`;
  },
  "freshness|digest generatedAt 2026-10-07T01:37:00Z, now 2026-10-08T13:37:01Z": async () => {
    const freshness = view.digestFreshness("2026-10-07T01:37:00Z", Date.parse("2026-10-08T13:37:01Z"))!;
    return `${translations("en")(freshness.key, { n: freshness.n })}; ${freshness.stale ? "stale" : "not stale"}`;
  },
  "freshness|constructed: cited KAFKA-PR-23426 absent from the current feed": async () => {
    const target = view.citeTarget("KAFKA-PR-23426", en, new Set(["KAFKA-PR-43"]));
    return target.external && target.title === en.threads["KAFKA-PR-23426"]!.title ? `title from the digest, link to ${target.href}` : target.href;
  },
  "window label|zh-Hant, same window": async () => {
    const label = view.windowLabel(translations("zh-Hant")("digest.windowPrefix"), "zh-Hant", en.window.start, en.window.end);
    const range = new Intl.DateTimeFormat("zh-Hant", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
      .formatRange(new Date(en.window.start), new Date(en.window.end));
    return label === `過去 7 天 · ${range}` && !/週|week/iu.test(label)
      ? "過去 7 天 · Intl.DateTimeFormat(\"zh-Hant\", …).formatRange output; no 週/week number" : label;
  },
  "proposals tab|/#/datafusion/proposals": async () => {
    const { createMemoryHistory, createRouter } = await import("vue-router");
    const router = createRouter({ history: createMemoryHistory("/"), routes: routes.createRoutes(() => undefined) });
    await router.push("/datafusion/proposals");
    return `redirects to /#${router.currentRoute.value.fullPath}`;
  },
  "proposals tab|/#/kafka/proposals, en": async () => {
    const html = await render(components.ProposalColumns, { digest: en, profile: kafka().profile });
    const rows = count(html, /class="kip-row"/gu);
    const note = translations("en")(kafka().profile.proposal.quorumNote!);
    const ordered = [...html.matchAll(/class="stage-column" data-stage="([a-z]+)"/gu)].map((match) => match[1]).join();
    return rows === en.proposals.length && ordered === "discuss,vote,implementing" && note.includes("3 binding +1")
      ? "every row grouped by stage; quorum note \"3 binding +1 votes\"" : `${rows} ${ordered} ${note}`;
  },
  "empty|constructed: digest with empty true": async () => {
    const empty = { ...en, empty: true, cards: [], proposals: [], routine: { threads: [] }, highlights: [], headline: null, threads: {} };
    const html = await render(components.DigestWeek, { digest: empty, profile: kafka().profile, projectName: "Apache Kafka", now: NOW });
    return html.includes("No activity in the past 7 days") && !html.includes("topic-card")
      ? "This week shows \"No activity in the past 7 days\"" : "missing";
  },
};

describe("Spec 014 slice 3 test plan", () => {
  test.each([...testPlanRows] as CaseRow[])("$id: $rule — $input", async (row) => {
    const run = cases[`${row.rule}|${row.input}`];
    if (run === undefined) throw new Error(`No executable case for ${row.id} ${row.rule}: ${row.input}`);
    expect(await run()).toBe(row.expected);
  });

  test("every executable case has a test-plan row", () => {
    const rows = new Set(testPlanRows.map((row) => `${row.rule}|${row.input}`));
    expect(Object.keys(cases).filter((key) => !rows.has(key))).toEqual([]);
  });
});

class FakeBucket {
  constructor(private readonly objects: Record<string, unknown>) {}
  async get(key: string) {
    return Object.hasOwn(this.objects, key) ? { json: async <T>() => this.objects[key] as T } : null;
  }
}

const POINTER = "public/digest/v1/apache-kafka/current.json";
const EN_KEY = "public/digest/v1/apache-kafka/r/h/c/en.json";
const ZH_KEY = "public/digest/v1/apache-kafka/r/h/c/zh-Hant.0123456789abcdef.json";

describe("Spec 014 slice 3 named tests", () => {
  test("D12: /api/digest serves the locale object without cache fields; 400 for an unknown project, 404 for datafusion", async () => {
    const bucket = new FakeBucket({ [POINTER]: { objectKeys: { en: EN_KEY, "zh-Hant": ZH_KEY } }, [EN_KEY]: { ...en, features: { a: 1 } }, [ZH_KEY]: zh });
    const served = await readDigest(bucket, "apache-kafka", "zh-Hant");
    expect(served.status).toBe(200);
    expect(served.body).toMatchObject({ locale: "zh-Hant", localeFallback: false });
    expect(served.body).not.toHaveProperty("features");
    expect((await readDigest(bucket, "apache-kafka", "en")).body).not.toHaveProperty("features");
    expect((await readDigest(bucket, "apache-nope", "en")).status).toBe(400);
    expect((await readDigest(bucket, null, "en")).status).toBe(400);
    expect((await readDigest(bucket, "apache-datafusion", "en")).status).toBe(404);
    // Even a published DataFusion pointer is not served: the profile has no digest.
    const datafusion = new FakeBucket({ "public/digest/v1/apache-datafusion/current.json": { objectKeys: { en: "public/digest/v1/apache-datafusion/x/en.json" } }, "public/digest/v1/apache-datafusion/x/en.json": en });
    expect((await readDigest(datafusion, "apache-datafusion", "en")).status).toBe(404);
    expect((await readDigest(new FakeBucket({}), "apache-kafka", "en")).status).toBe(404);
  });

  test("D58: a missing locale object falls back to en with localeFallback; an unsupported locale is a 400", async () => {
    const bucket = new FakeBucket({ [POINTER]: { objectKeys: { en: EN_KEY } }, [EN_KEY]: en });
    const served = await readDigest(bucket, "apache-kafka", "zh-Hant");
    expect(served).toMatchObject({ status: 200, body: { locale: "en", localeFallback: true } });
    expect((await readDigest(bucket, "apache-kafka", "fr")).status).toBe(400);
    // Positive control: en itself is not a fallback.
    expect((await readDigest(bucket, "apache-kafka", "en")).body).toMatchObject({ localeFallback: false });
    // A pointer that leaves the project prefix is never followed.
    const outside = "public/digest/v1/apache-other/r/h/c/en.json";
    const escaped = new FakeBucket({ [POINTER]: { objectKeys: { en: outside } }, [outside]: en });
    expect((await readDigest(escaped, "apache-kafka", "en")).status).toBe(503);
  });

  test("D44: every generated item on This week and the topic page shows a citation chip", async () => {
    const html = await render(components.DigestWeek, { digest: en, profile: kafka().profile, projectName: "Apache Kafka", now: NOW });
    const sentences = html.split('class="digest-sentence').slice(1);
    const generated = en.cards.reduce((sum, card) => sum + card.sentences.length, 0)
      + en.proposals.filter((row) => row.line !== null).length + en.highlights.length + (en.headline === null ? 0 : 1);
    expect(count(html, /class="sentence-text"/gu)).toBeGreaterThanOrEqual(generated);
    expect(sentences.length).toBeGreaterThanOrEqual(generated);
    for (const segment of sentences) expect(segment).toContain('class="cite"');
    const card = en.cards.find((item) => item.status === "generated")!;
    const topic = await render(components.TopicPage, { digest: en, profile: kafka().profile, card });
    expect(count(topic, /class="digest-sentence"/gu)).toBe(card.sentences.length);
    expect(count(topic, /class="cite"/gu)).toBeGreaterThanOrEqual(card.sentences.length);
  });

  test("D43: topic filter counts equal the lists they filter", () => {
    for (const card of en.cards) {
      const counts = view.filterCounts(card.threads, en);
      for (const filter of ["all", "pr", "mail", "jira"] as const) {
        expect(view.filterThreads(card.threads, en, filter)).toHaveLength(counts[filter]);
      }
    }
    // Positive control: the storage card mixes PRs and dev@ threads.
    // A GitHub issue is neither a PR nor dev@ nor JIRA; it counts only in All.
    const issue = { threads: { "KAFKA-ISSUE-1": { title: "t", source: "github" as const, status: "open", url: null, score: 1 } } };
    expect(view.filterCounts(["KAFKA-ISSUE-1"], issue)).toEqual({ all: 1, pr: 0, mail: 0, jira: 0 });
    const storage = view.filterCounts(en.cards.find((card) => card.topic === "storage")!.threads, en);
    expect(storage.pr).toBeGreaterThan(0);
    expect(storage.mail).toBeGreaterThan(0);
  });

  test("D54: a thread card without a canonical URL links only to Detail", async () => {
    const card = en.cards.find((item) => item.topic === "releases")!;
    const id = card.threads[0]!;
    const noUrl = { ...en, threads: { ...en.threads, [id]: { ...en.threads[id]!, url: null } } };
    const html = await render(components.TopicPage, { digest: noUrl, profile: kafka().profile, card });
    const start = html.lastIndexOf("<li", html.indexOf(`class="thread-id" href="#/feed/${encodeURIComponent(id)}"`));
    const block = html.slice(start, html.indexOf("</li>", start));
    const titleTag = /<a[^>]*class="thread-title"[^>]*>/u.exec(block)![0];
    const titleLink = /href="([^"]*)"/u.exec(titleTag)?.[1];
    expect(titleLink).toBe(`#/feed/${encodeURIComponent(id)}`);
    expect(block).not.toContain('target="_blank"');
    // Positive control: with its URL the same card links to the source.
    const withUrl = await render(components.TopicPage, { digest: en, profile: kafka().profile, card });
    expect(withUrl).toContain(`href="${en.threads[id]!.url}"`);
  });

  test("D23: with no digest or a failed read, This week shows the notice and a link to All threads, no feed", async () => {
    for (const kind of ["none", "error"] as const) {
      const html = await render(components.DigestStates, { state: { kind, project: kafka() }, projectKey: "kafka" });
      expect(html).toContain('href="/kafka/threads"');
      expect(html).not.toContain('class="card"');
    }
    expect(await render(components.DigestStates, { state: { kind: "none", project: kafka() }, projectKey: "kafka" }))
      .toContain("No weekly digest for this community yet");
  });

  test("D53: an unknown project shows a not-found state", async () => {
    expect(view.projectByKey("nope")).toBeUndefined();
    const html = await render(components.DigestStates, { state: { kind: "unknown-project" }, projectKey: "nope" });
    expect(html).toContain("This page does not exist");
  });

  test("D62: bare /#/ opens the last project, else kafka; storage errors fall back", async () => {
    const { createMemoryHistory, createRouter } = await import("vue-router");
    const open = async (storage: () => Pick<Storage, "getItem"> | undefined) => {
      const router = createRouter({ history: createMemoryHistory("/"), routes: routes.createRoutes(storage) });
      await router.push("/");
      return router.currentRoute.value.fullPath;
    };
    expect(await open(() => ({ getItem: () => "datafusion" }))).toBe("/datafusion/");
    expect(await open(() => ({ getItem: () => "unknown" }))).toBe("/kafka/");
    expect(await open(() => ({ getItem: () => { throw new Error("blocked"); } }))).toBe("/kafka/");
    expect(await open(() => undefined)).toBe("/kafka/");
    expect(view.PROJECTS.map((project) => project.profile.projectKey)).toEqual(["kafka", "datafusion"]);
  });

  test("D12: a proposal's title comes from its tagged dev@ subject, else a PR title, else its key", () => {
    const title = (key: string) => view.proposalTitle(en.proposals.find((row) => row.key === key)!, en.threads);
    expect(title("KIP-1368")).toBe("Client framework name and version");
    expect(title("KIP-1306")).toBe("Migrate Connect to RebalanceListener");
    expect(view.proposalTitle({ key: "KIP-1", cites: [] }, en.threads)).toBe("KIP-1");
  });

  test("D18: only https source URLs become external links", () => {
    const thread = en.threads["KAFKA-PR-23426"]!;
    for (const url of ["javascript:alert(1)", "http://example.com/x", "data:text/html,x"]) {
      const target = view.citeTarget("KAFKA-PR-23426", { threads: { "KAFKA-PR-23426": { ...thread, url } } }, new Set());
      expect(target).toMatchObject({ href: "#/feed/KAFKA-PR-23426", external: false });
    }
    // Positive control: the real https URL is external.
    expect(view.citeTarget("KAFKA-PR-23426", en, new Set()).external).toBe(true);
  });

  test("D12: the stats row and section anchors use the counts function; DataFusion has no proposals stat", async () => {
    const counts = view.digestCounts(en);
    const html = await render(components.DigestWeek, { digest: en, profile: kafka().profile, projectName: "Apache Kafka", now: NOW });
    expect(html).toContain(`<strong>${counts.proposals}</strong> proposals with activity`);
    expect(html).toContain(`<strong>${counts.threads}</strong> threads`);
    expect(html).toContain(`<strong>${counts.mailThreads}</strong> dev@ threads`);
    expect(html).toContain(`<strong>${counts.routine}</strong> maintenance items`);
    expect(html).toContain(`Proposals · ${counts.proposals}`);
    expect(html).toContain(`Development · ${counts.topics}`);
    expect(html).toContain(`Maintenance · ${counts.routine}`);
    const datafusion = view.projectByKey("datafusion")!;
    const noProposals = await render(components.DigestWeek, { digest: en, profile: datafusion.profile, projectName: datafusion.name, now: NOW });
    expect(noProposals).not.toContain("proposals with activity");
    expect(noProposals).not.toContain("Proposals ·");
  });

  test("D23: the store maps 404 to the no-digest state, 503 to unavailable, 200 to the digest", async () => {
    const { effectScope, nextTick, ref } = await import("vue");
    const { useDigest } = await import("../src/digest-store");
    const original = globalThis.fetch;
    const stateFor = async (status: number) => {
      globalThis.fetch = (async () => new Response(JSON.stringify(status === 200 ? en : { error: "x" }), { status })) as unknown as typeof fetch;
      const scope = effectScope();
      const state = scope.run(() => useDigest(ref("kafka")))!;
      for (let tries = 0; tries < 20 && state.value.kind === "loading"; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      await nextTick();
      scope.stop();
      return state.value.kind;
    };
    try {
      expect(await stateFor(404)).toBe("none");
      expect(await stateFor(503)).toBe("error");
      expect(await stateFor(200)).toBe("ok");
    } finally {
      globalThis.fetch = original;
    }
  });

  test("D45: i18n.js defines each key once per locale (a later duplicate would silently win)", async () => {
    const source = await Bun.file(new URL("../i18n.js", import.meta.url)).text();
    const blocks = source.split(/^\s{4}(?:"zh-Hant"|en): \{$/mu).slice(1);
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      const keys = [...block.matchAll(/^\s{6}"([^"]+)":/gmu)].map((match) => match[1]!);
      expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([]);
    }
  });

  test("D45: every taxonomy, stage, and quorum key exists in both locales", () => {
    const missing: string[] = [];
    for (const project of view.PROJECTS) {
      const keys = [
        ...project.profile.taxonomy.topics.map((topic) => `taxonomy.${project.profile.projectId}.${topic}`),
        ...project.profile.proposal.stages.map((stage) => `proposal.${project.profile.proposal.kind}.stage.${stage.key}`),
        ...(project.profile.proposal.quorumNote === undefined ? [] : [project.profile.proposal.quorumNote]),
      ];
      for (const locale of ["en", "zh-Hant"]) {
        for (const key of keys) if (translations(locale)(key) === key) missing.push(`${locale} ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("D30: the freshness line, lagging source, and model label at a controlled clock", async () => {
    const html = await render(components.DigestWeek, { digest: en, profile: kafka().profile, projectName: "Apache Kafka", now: Date.parse(en.generatedAt) + 2 * 3_600_000 });
    expect(html).toContain("Digest updated 2 h ago");
    expect(html).toContain("JIRA data through Sep 19");
    // Positive control: sources that are not lagging are not listed.
    expect(html).not.toContain("GitHub data through");
    expect(html).not.toContain("dev@ data through");
    expect(html).toContain("AI summary · unreviewed · llama-3.3-70b-instruct-fp8-fast");
    const stale = await render(components.DigestWeek, { digest: en, profile: kafka().profile, projectName: "Apache Kafka", now: Date.parse(en.generatedAt) + 37 * 3_600_000 });
    expect(stale).toContain("Digest may be out of date · 37 h ago");
    const zhHtml = await render(components.DigestWeek, { digest: zh, profile: kafka().profile, projectName: "Apache Kafka", now: NOW }, "zh-Hant");
    expect(zhHtml).toContain("翻譯：hand-2026-10-08");
  });
});
