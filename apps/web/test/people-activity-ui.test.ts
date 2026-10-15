/**
 * Spec 019 slice 2b: the profile page and `/api/people` with the activity log recorded, from the
 * recorded Dev fixture (`packages/reference-pipeline/test/fixtures/people-activity/kafka-dev.json`)
 * appended as the publication's first append would. Browser checks live in `e2e/people.spec.ts`.
 */
import { beforeAll, describe, expect, test } from "bun:test";

import {
  activityMonthsFromEvents,
  encodeActivityMonth,
  GITHUB_REVIEWS_STATE_SCHEMA,
  githubReviewsStateKey,
  PEOPLE_ACTIVITY_STATE_SCHEMA,
  peopleActivityMonthKey,
  peopleActivityStateKey,
} from "@oss-knowledge-base/reference-pipeline";
import { readPersonProfile, type PeopleErrorV1, type PersonProfileV1 } from "@oss-knowledge-base/reference-pipeline/people";

import { fixtureEvents, peopleActivityFixture } from "../../../packages/reference-pipeline/test/support/people-activity-fixture";
import { onRequestGet as configHandler } from "../functions/api/people/index";
import { registerVuePlugin } from "./vue-plugin";

const RELEASE = peopleActivityFixture.release;
const COVERAGE_FROM = new Date(Date.parse(RELEASE) - 35 * 86_400_000).toISOString();
const NOW = Date.parse(peopleActivityFixture.capturedAt);

function objects(withActivity = true): Map<string, string> {
  const map = new Map<string, string>();
  for (const projectId of ["apache-kafka", "apache-datafusion"]) {
    map.set(githubReviewsStateKey(projectId), JSON.stringify({ schema: GITHUB_REVIEWS_STATE_SCHEMA, updatedAt: "2026-10-14T22:02:21Z", coverageFrom: "2025-10-14T00:00:00.000Z" }));
    if (withActivity) {
      map.set(peopleActivityStateKey(projectId), JSON.stringify({ schema: PEOPLE_ACTIVITY_STATE_SCHEMA, firstAppendAt: RELEASE, coverageFrom: COVERAGE_FROM, updatedAt: RELEASE, months: [] }));
    }
  }
  if (withActivity) for (const month of activityMonthsFromEvents(fixtureEvents(), COVERAGE_FROM)) map.set(peopleActivityMonthKey(month.projectId, month.month), encodeActivityMonth(month));
  return map;
}
const bucket = (map: Map<string, string>) => ({ get: async (key: string) => (map.has(key) ? { text: async () => map.get(key)! } : null) });

async function profile(person: string): Promise<PersonProfileV1> {
  const result = await readPersonProfile({ bucket: bucket(objects()), projectKey: "kafka", personId: person, nowMs: NOW });
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

describe("Spec 019 slice 2b: profile page with the activity log", () => {
  test("W27: the header states the activity log's own coverage next to the reviews'; nothing is 'not recorded'", async () => {
    const html = text(await render(components.PersonProfile, { profile: await profile("github:chia7712"), nowMs: NOW }));
    expect(html).toContain("Reviews: 2025-11-01 to 2026-10-14");
    expect(html).toContain("Comments, pull requests, Jira, dev@: 2026-09-09 to 2026-10-14");
    expect(html).not.toContain("not recorded");
    expect(html).toContain("Source: the activity log of Comments, pull requests, Jira, dev@, recorded daily since 2026-10-14; its first record held what the site had then, from 2026-09-09.");
    const zh = text(await render(components.PersonProfile, { profile: await profile("github:chia7712"), nowMs: NOW }, "zh-Hant"));
    expect(zh).toContain("GitHub 留言與 PR、Jira、dev@：2026-09-09 至 2026-10-14");
  });

  test("W1 and W5: a GitHub profile shows reviews and its own activity; sections keep the spec's order; areas leave process labels out", async () => {
    const page = await render(components.PersonProfile, { profile: await profile("github:chia7712"), nowMs: NOW });
    expect([...page.matchAll(/data-section="([a-z-]+)"/gu)].map((match) => match[1])).toEqual(["header", "identities", "activity", "over-time", "areas", "threads", "works-with", "how"]);
    const html = text(page);
    expect(html).toContain("Pull requests opened 0 (0 merged)");
    expect(html).toContain("Comments 59 on 48 threads (0 on their own)");
    expect(html).toContain("clients 10 threads");
    expect(html).not.toMatch(/ci-approved|\bsmall \d/u);
    expect(html).toContain("Wrote in threads started by gabriellefu shared threads: 5");
    expect(page).toContain(`href="/kafka/people/${encodeURIComponent("github:gabriellefu")}"`);
    // Strict identity: a GitHub page shows no Jira or dev@ count, not even 0.
    expect(html).not.toMatch(/dev@ messages|Jira \d|issues reported/u);
  });

  test("W1: a dev@ identity has its own page: messages, threads, KIPs, no review or GitHub count", async () => {
    const page = await render(components.PersonProfile, { profile: await profile("mail:Andrew Schofield"), nowMs: NOW });
    const html = text(page);
    expect(html).toContain("Andrew Schofield");
    expect(html).toContain("dev@ messages 23 in 11 threads · [DISCUSS] 4, [VOTE] 4");
    expect(html).toContain("KIP-1368 2 threads");
    expect(html).toContain("No area data from dev@");
    expect(html).toContain("Identified by the name the source shows");
    expect(html).not.toMatch(/Reviews given|Pull requests opened|Comments \d/u);
    expect(page).toContain('data-column="mail"');
    expect(page).not.toContain('data-column="given"');
    expect(page).toContain('data-thread-source="mail"');
  });

  test("W11 and W27: a 404 with the log recorded lists its coverage", async () => {
    const error = (await readPersonProfile({ bucket: bucket(objects()), projectKey: "kafka", personId: "mail:nobody here", nowMs: NOW })).body as PeopleErrorV1;
    const html = text(await render(components.PersonNotFound, { projectKey: "kafka", status: 404, error }));
    expect(html).toContain("Comments, pull requests, Jira, dev@: 2026-09-09 to 2026-10-14");
  });

  test("W28: Jira and dev@ names link only where the community records their source; bots never", () => {
    const recorded = ["github-reviews", "github", "jira", "mail"];
    expect(people.personRoute(true, "kafka", "jira", "Chia-Ping Tsai", recorded)).toBe(`/kafka/people/${encodeURIComponent("jira:chia-ping tsai")}`);
    expect(people.personRoute(true, "kafka", "mail", "Andrew Schofield", recorded)).toBe(`/kafka/people/${encodeURIComponent("mail:andrew schofield")}`);
    expect(people.personRoute(true, "kafka", "mail", "unknown sender", recorded)).toBeUndefined();
    expect(people.personRoute(true, "kafka", "jira", "Jenkins Bot", recorded)).toBeUndefined();
    expect(people.personRoute(false, "kafka", "jira", "Chia-Ping Tsai", recorded)).toBeUndefined();
    // Negative side: before the log is recorded (2a, or the flag off) they do not link.
    expect(people.personRoute(true, "kafka", "jira", "Chia-Ping Tsai", ["github-reviews"])).toBeUndefined();
    expect(people.personRoute(true, "kafka", "mail", "Andrew Schofield")).toBeUndefined();
  });

  test("W28: /api/people says which sources each community records: all four with the log, reviews only without", async () => {
    const call = async (map: Map<string, string>) => {
      const response = await (configHandler as unknown as (context: unknown) => Promise<Response>)({ env: { PEOPLE_PROFILES: "true", OSS_KB_BUCKET: bucket(map) }, params: {}, request: new Request("https://dev.example/api/people") });
      return (await response.json() as { recorded: unknown }).recorded;
    };
    expect(await call(objects())).toEqual({ kafka: ["github-reviews", "github", "jira", "mail"], datafusion: ["github-reviews", "github"] });
    expect(await call(objects(false))).toEqual({ kafka: ["github-reviews"], datafusion: ["github-reviews"] });
  });
});
