/** Spec 019 areas amendment: the taxonomy, the aggregation and the profile's `pullAreas` and `name`, from the generated test plan. */
import { expect, test } from "bun:test";

import {
  encodeReviewMonth,
  GITHUB_REVIEWS_STATE_SCHEMA,
  githubReviewsMonthKey,
  githubReviewsStateKey,
  type ReviewMonthExtras,
  type ReviewRow,
} from "../src/github-reviews";
import {
  areaDistribution,
  areaTaxonomy,
  itemAreas,
  profileAreaSide,
  readPersonProfile,
  suppressionDigest,
  type PersonProfileV1,
} from "../src/people";
import { testPlanRows } from "./profile-areas.cases";

const KAFKA = areaTaxonomy("apache-kafka");
const DATAFUSION = areaTaxonomy("apache-datafusion");
const NOW = Date.parse("2026-10-15T12:00:00Z");

const areas = (taxonomy: typeof KAFKA, labels: readonly string[], kips: readonly string[] = []) => {
  const result = itemAreas(labels, kips, taxonomy);
  return `areas ${result.labels.join(", ") || "none"}; kips ${result.kips.join(", ") || "none"}`;
};
const distribution = (items: readonly { key: string; labels: readonly string[] }[]) => {
  const result = areaDistribution(items.map((item) => ({ ...item, kips: [] })), KAFKA);
  return `items ${result.items}; unlabelled ${result.unlabelled}; assignments ${result.assignments}; slices ${result.slices.map((slice) => `${slice.other === true ? "other" : slice.label} ${slice.items}`).join(", ")}`;
};
const row = (reviewId: number, pr: number, submittedAt: string, reviewer = "ada", prAuthor = "grace"): ReviewRow =>
  ({ reviewId, pr, prAuthor, reviewer, isBot: false, state: "APPROVED", submittedAt, commit: null, inlineComments: 0 });

async function profile(months: readonly { month: string; rows: readonly ReviewRow[]; extras?: ReviewMonthExtras }[], person = "github:ada", suppressed?: Record<string, readonly string[]>): Promise<PersonProfileV1> {
  const map = new Map<string, string>([[githubReviewsStateKey("apache-kafka"), JSON.stringify({ schema: GITHUB_REVIEWS_STATE_SCHEMA, updatedAt: "2026-10-14T22:00:00Z", coverageFrom: "2025-10-14T00:00:00.000Z" })]]);
  for (const entry of months) map.set(githubReviewsMonthKey("apache-kafka", entry.month), encodeReviewMonth("apache-kafka", entry.month, entry.rows, entry.extras));
  // A new bucket object per call: the reader caches per bucket and isolate.
  const bucket = { get: async (key: string) => (map.has(key) ? { text: async () => map.get(key)! } : null) };
  const result = await readPersonProfile({ bucket, projectKey: "kafka", personId: person, nowMs: NOW, ...(suppressed === undefined ? {} : { suppressed }) });
  if (result.status !== 200) throw new Error(`status ${result.status}`);
  return result.body;
}
const pullAreasText = (body: PersonProfileV1) => (body.pullAreas === undefined ? "no pullAreas"
  : `pullAreas ${Object.entries(body.pullAreas).map(([pr, value]) => [pr, ...value.labels, ...(value.kips ?? [])].join(" ")).join("; ")}`);
const SEP = [row(1, 10, "2026-09-10T10:00:00Z")];
const OCT = [row(2, 11, "2026-10-10T10:00:00Z")];

const scenarios: Record<string, () => string | Promise<string>> = {
  "taxonomy|kafka: clients, small, ci-approved, triage, needs-attention, KIP-932, kip": () => areas(KAFKA, ["clients", "small", "ci-approved", "triage", "needs-attention", "KIP-932", "kip"]),
  "taxonomy|kafka: kip-1332 (lower case) and a title KIP-1332": () => areas(KAFKA, ["kip-1332"], ["KIP-1332"]),
  "taxonomy|datafusion: sql, v56.0.0, auto detected api change, bug, rust, auto-dependencies": () => areas(DATAFUSION, ["sql", "v56.0.0", "auto detected api change", "bug", "rust", "auto-dependencies"]),
  "taxonomy|kafka: a label not in the profile (share-groups)": () => areas(KAFKA, ["share-groups"]),
  "taxonomy|datafusion positive control: core, physical-plan, sqllogictest": () => areas(DATAFUSION, ["sqllogictest", "core", "physical-plan"]),
  "distribution|#1 clients, core; #2 clients; #3 triage only": () => distribution([{ key: "1", labels: ["clients", "core"] }, { key: "2", labels: ["clients"] }, { key: "3", labels: ["triage"] }]),
  "distribution|the same pull request listed twice": () => distribution([{ key: "1", labels: ["clients"] }, { key: "1", labels: ["clients"] }]),
  "distribution|8 areas a..h on 8, 7, …, 1 pull requests": () => distribution(Array.from({ length: 8 }, (_, index) => ({
    key: String(index), labels: "abcdefgh".slice(0, 8 - index).split(""),
  }))),
  "distribution|exactly 6 areas": () => distribution("abcdef".split("").map((label) => ({ key: label, labels: [label] }))),
  "coverage|reviewed #1 and #2; metadata for #1 only": () => {
    const side = profileAreaSide([1, 2], { "1": { labels: ["core"] } }, KAFKA);
    return `covered ${side.covered} of ${side.pullRequests}`;
  },
  "coverage|reviewed #1 twice; metadata for #1": () => {
    const side = profileAreaSide([1, 1], { "1": { labels: ["core"] } }, KAFKA);
    return `covered ${side.covered} of ${side.pullRequests}`;
  },
  "profile|every month of the view with metadata; ada reviewed #10 (clients, triage) and #11 (core, KIP-932)": async () => pullAreasText(await profile([
    { month: "2026-09", rows: SEP, extras: { pulls: { "10": { labels: ["clients", "triage"] } } } },
    { month: "2026-10", rows: OCT, extras: { pulls: { "11": { labels: ["KIP-932", "core"] } } } },
  ])),
  "profile|no month with metadata (metadata@1 only)": async () => pullAreasText(await profile([{ month: "2026-09", rows: SEP }, { month: "2026-10", rows: OCT }])),
  "profile|ada's reviews in two months, only the newer with metadata": async () => {
    const body = await profile([{ month: "2026-09", rows: SEP }, { month: "2026-10", rows: OCT, extras: { pulls: { "11": { labels: ["core"], kips: ["KIP-932"] } } } }]);
    return `${pullAreasText(body)}; #10 ${body.pullAreas?.["10"] === undefined ? "not covered" : "covered"}`;
  },
  "profile|#11's labels in an older month and different labels in a newer one": async () => pullAreasText(await profile([
    { month: "2026-09", rows: [row(3, 11, "2026-09-20T10:00:00Z")], extras: { pulls: { "11": { labels: ["core"] } } } },
    { month: "2026-10", rows: OCT, extras: { pulls: { "11": { labels: ["streams"] } } } },
  ])),
  "profile name|ada named Ada Lovelace in the older month and A. Lovelace in the newer": async () => {
    const body = await profile([{ month: "2026-09", rows: SEP, extras: { people: { ada: "Ada Lovelace" } } }, { month: "2026-10", rows: OCT, extras: { people: { ada: "A. Lovelace" } } }]);
    return body.identity.name === undefined ? "no name" : `name ${body.identity.name}`;
  },
  "profile name|no name stored for ada": async () => ((await profile([{ month: "2026-10", rows: OCT }])).identity.name === undefined ? "no name" : "name"),
  "profile name|a suppressed counterpart with a stored name": async () => {
    const digest = await suppressionDigest("apache-kafka", "github:grace");
    const body = await profile([{ month: "2026-10", rows: OCT, extras: { people: { ada: "Ada Lovelace", grace: "Grace Hopper" } } }], "github:ada", { "apache-kafka": [digest] });
    return JSON.stringify(body).includes("Grace Hopper") ? "name in the response" : "name not in the response";
  },
};

test.each([...testPlanRows])("$id: $rule — $input", async (planned) => {
  const scenario = scenarios[`${planned.rule}|${planned.input}`];
  if (scenario === undefined) throw new Error(`No scenario for ${planned.rule}|${planned.input}`);
  expect(await scenario()).toBe(planned.expected);
});

test("W46: every scenario is a planned row", () => {
  expect(Object.keys(scenarios).sort()).toEqual(testPlanRows.map((planned) => `${planned.rule}|${planned.input}`).sort());
});
