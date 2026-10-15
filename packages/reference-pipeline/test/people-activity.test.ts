/**
 * Spec 019 slice 2b: the activity log (rows from the pipeline's events, month objects, summaries)
 * and the profile read beside the reviews. Rows come from `people-activity.cases.ts`.
 */
import { describe, expect, test } from "bun:test";

import type { DomainEventV1 } from "@oss-knowledge-base/domain";

import { GITHUB_REVIEWS_STATE_SCHEMA, githubReviewsStateKey } from "../src/github-reviews";
import {
  activityMonthsFromEvents,
} from "../src/people/activity-log";
import {
  activityPersonId,
  encodeActivityMonth,
  encodeActivitySummary,
  indexActivityMonth,
  mergeActivityMonth,
  parseActivityMonth,
  PEOPLE_ACTIVITY_STATE_SCHEMA,
  peopleActivityMonthKey,
  peopleActivityStateKey,
  peopleActivitySummaryKey,
  profileView,
  readPersonProfile,
  suppressionDigest,
  type ActivityMonthV1,
  type PeopleBucket,
  type PersonProfileV1,
} from "../src/people";
import { activityPlanRows } from "./people-activity.cases";
import { fixtureEvents, peopleActivityFixture } from "./support/people-activity-fixture";

const RELEASE = peopleActivityFixture.release;
const COVERAGE_FROM = new Date(Date.parse(RELEASE) - 35 * 86_400_000).toISOString();
const NOW = Date.parse(peopleActivityFixture.capturedAt);

function github(entityId: string, data: Partial<Record<string, unknown>>, at: string): DomainEventV1 {
  return {
    schemaVersion: 1, id: `constructed:${entityId}:${at}`, projectId: "apache-kafka", sourceType: "code-host", sourceInstanceId: "kafka:github",
    entityType: "artifact", entityId, eventType: "updated", sourceCursor: at, sourceTimestamp: at, observedAt: at,
    canonicalUrl: `https://github.com/apache/kafka/pull/${data.externalNumber}`, payloadRef: "constructed", sourceConnectorVersion: "constructed",
    communityProfileVersion: "constructed",
    data: {
      contract: "github-record@1", recordKind: "pull-request", title: "Constructed", excerpt: "-", authorRole: "Contributor",
      occurredAt: at, createdAt: at, updatedAt: at, nativeState: "open", labels: [], isBot: false, ...data,
    },
  } as DomainEventV1;
}

/** W3, W4, W12: constructed records on each side of a rule. */
const constructedEvents: DomainEventV1[] = [
  // W3: opened on the last second of September, merged and updated 40 days later.
  github("kafka:github:pull:90001", { externalNumber: 90001, author: "edge-author", createdAt: "2026-09-30T23:59:59Z", updatedAt: "2026-10-10T10:00:00Z", occurredAt: "2026-10-10T10:00:00Z", nativeState: "closed", mergedAt: "2026-10-10T10:00:00Z" }, "2026-10-10T10:00:00Z"),
  // W4: one area label and two process labels.
  github("kafka:github:pull:90002", { externalNumber: 90002, author: "label-author", createdAt: "2026-10-01T00:00:00Z", labels: ["ci-approved", "clients", "small"] }, "2026-10-01T00:00:00Z"),
  // W12: a bot's comment, and a Jira bot.
  github("kafka:github:pull:90002:comment:1", { externalNumber: 90002, recordKind: "comment", parentEntityId: "kafka:github:pull:90002", author: "ci-bot", isBot: true, nativeState: undefined }, "2026-10-02T00:00:00Z"),
  {
    schemaVersion: 1, id: "constructed:jira-bot", projectId: "apache-kafka", sourceType: "issue-tracker", sourceInstanceId: "kafka:jira",
    entityType: "artifact", entityId: "kafka:jira:issue:KAFKA-90003", eventType: "updated", sourceCursor: "2026-10-02T00:00:00Z",
    sourceTimestamp: "2026-10-02T00:00:00Z", observedAt: "2026-10-02T00:00:00Z", canonicalUrl: "https://issues.apache.org/jira/browse/KAFKA-90003",
    payloadRef: "constructed", sourceConnectorVersion: "constructed", communityProfileVersion: "constructed",
    data: { contract: "jira-record@1", recordKind: "issue", key: "KAFKA-90003", title: "KAFKA-90003: built", excerpt: "-", author: "Jenkins Bot", occurredAt: "2026-10-02T00:00:00Z", nativeStatus: "Open", status: "open", kips: [], isBot: true },
  } as DomainEventV1,
];

class CountingBucket implements PeopleBucket {
  readonly reads: string[] = [];
  constructor(readonly objects: Map<string, string>, private readonly broken: ReadonlySet<string> = new Set()) {}
  async get(key: string) {
    this.reads.push(key);
    if (this.broken.has(key)) throw new Error(`R2 failed for ${key}`);
    const body = this.objects.get(key);
    return body === undefined ? null : { text: async () => body };
  }
}

/** The objects the first append writes at the fixture's release (as the publisher's `appendActivityLog` does). */
function activityStore(events: readonly DomainEventV1[] = [...fixtureEvents(), ...constructedEvents]): Map<string, string> {
  const objects = new Map<string, string>();
  const months = activityMonthsFromEvents(events, COVERAGE_FROM);
  for (const month of months) {
    objects.set(peopleActivityMonthKey(month.projectId, month.month), encodeActivityMonth(month));
    objects.set(peopleActivitySummaryKey(month.projectId, month.month), encodeActivitySummary(month));
  }
  for (const projectId of ["apache-kafka", "apache-datafusion"]) {
    objects.set(peopleActivityStateKey(projectId), JSON.stringify({
      schema: PEOPLE_ACTIVITY_STATE_SCHEMA, firstAppendAt: RELEASE, coverageFrom: COVERAGE_FROM, updatedAt: RELEASE,
      months: months.filter((month) => month.projectId === projectId).map((month) => month.month),
    }));
    // A review store with no months: reviews recorded, nobody reviewed.
    objects.set(githubReviewsStateKey(projectId), JSON.stringify({ schema: GITHUB_REVIEWS_STATE_SCHEMA, updatedAt: "2026-10-14T22:02:21Z", coverageFrom: "2025-10-14T00:00:00.000Z" }));
  }
  return objects;
}

const STORE = activityStore();

async function read(person: string, options: { bucket?: PeopleBucket; suppressed?: readonly string[]; now?: number } = {}) {
  const [id, project = "kafka"] = person.split(" @ ") as [string, string?];
  return readPersonProfile({
    bucket: options.bucket ?? new CountingBucket(STORE),
    projectKey: project,
    personId: id,
    nowMs: options.now ?? NOW,
    suppressed: { "apache-kafka": await Promise.all((options.suppressed ?? []).map((value) => suppressionDigest("apache-kafka", value))) },
  });
}

function columns(body: PersonProfileV1) {
  const view = profileView(body, "12m", NOW).activity!;
  const totals = view.totals;
  const hasGithub = body.activity!.records.some((record) => record.source === "github");
  const hasJira = body.activity!.records.some((record) => record.source === "jira");
  const hasMail = body.activity!.records.some((record) => record.source === "mail");
  const top = <T extends { readonly threads: number }>(items: readonly T[], name: (item: T) => string) => items.slice(0, 5).map((item) => `${name(item)} ${item.threads}`);
  const areaParts = [
    top(view.areas.labels, (item) => item.label).join(", "),
    top(view.areas.kips, (item) => item.kip).join(", "),
    view.areas.noLabelSources.length === 0 ? "" : `no area data from ${view.areas.noLabelSources.join(", ")}`,
  ].filter((part) => part !== "");
  return {
    github: hasGithub ? `PRs ${totals.pullRequests} (merged ${totals.mergedPullRequests}), comments ${totals.comments} on ${totals.commentedThreads} threads (own ${totals.commentsOnOwn})` : "—",
    jira: hasJira ? `issues ${totals.jiraIssues}, comments ${totals.jiraComments}, on ${totals.jiraThreads} issues` : "—",
    mail: hasMail ? `${totals.messages} in ${totals.mailThreads} threads; [DISCUSS] ${totals.discussThreads}, [VOTE] ${totals.voteThreads}` : "—",
    areas: areaParts.length === 0 ? "—" : areaParts.join("; "),
    worksWith: view.wroteInThreadsBy.length === 0 ? "—" : view.wroteInThreadsBy.slice(0, 4).map((entry) => `${entry.display} ${entry.threads}`).join(", "),
  };
}

describe("Spec 019 slice 2b: the activity log and the profile", () => {
  test.each([...activityPlanRows])("$id: $person, $case → $status", async (row) => {
    const result = await read(row.person);
    expect(result.status).toBe(row.status);
    if (result.status !== 200) return;
    const { github: g, jira, mail, areas, worksWith } = columns(result.body);
    expect({ github: g, jira, mail, areas, worksWith }).toEqual({ github: row.github, jira: row.jira, mail: row.mail, areas: row.areas, worksWith: row.worksWith });
  });

  test("W1: the profile's 12-month view equals the response's totals, and each identity's source is its own", async () => {
    for (const person of ["github:chia7712", "jira:Chia-Ping Tsai", "mail:Chia-Ping Tsai"]) {
      const result = await read(person);
      expect(result.status).toBe(200);
      const body = result.body as PersonProfileV1;
      expect(profileView(body, "12m", NOW).activity!.totals).toEqual(body.totals.activity!);
      expect(new Set(body.activity!.records.map((record) => record.source))).toEqual(new Set([person.split(":")[0] as "github" | "jira" | "mail"]));
      expect(body.identity.source).toBe(person.split(":")[0] as "github");
    }
    const mail = (await read("mail:chia-ping tsai")).body as PersonProfileV1;
    expect(mail.identity).toEqual({ id: "mail:chia-ping tsai", source: "mail", display: "Chia-Ping Tsai" });
    // A dev@ identity's period is the log's alone (no reviews); a GitHub identity's spans both.
    expect(mail.period).toEqual({ from: COVERAGE_FROM, until: RELEASE, months: ["2026-09", "2026-10"] });
    expect(((await read("github:chia7712")).body as PersonProfileV1).period.from).toBe("2025-11-01T00:00:00.000Z");
  });

  test("W2: a record ingested twice (a retried run, a newer version) is one row; merging the same month again changes no byte", () => {
    const events = fixtureEvents();
    const once = activityMonthsFromEvents(events, COVERAGE_FROM);
    const retried = activityMonthsFromEvents([...events, ...events.slice(0, 50).map((event) => ({ ...event, id: `${event.id}:retry` }))], COVERAGE_FROM);
    expect(retried.map(encodeActivityMonth)).toEqual(once.map(encodeActivityMonth));
    for (const month of once) {
      const merged = mergeActivityMonth(month, month);
      expect(encodeActivityMonth(merged)).toBe(encodeActivityMonth(month));
      expect(new Set(merged.rows.map((row) => row.id)).size).toBe(merged.rows.length);
    }
    // Positive control: a new record adds a row.
    const october = once.find((month) => month.month === "2026-10")!;
    const added = mergeActivityMonth(october, { ...october, rows: [{ ...october.rows[0]!, id: "kafka:github:pull:1:comment:new" }] });
    expect(added.rows.length).toBe(october.rows.length + 1);
  });

  test("W3: a pull request's row sits in its creation month, keeps its merge time, and an update 40 days later moves it nowhere", () => {
    const months = activityMonthsFromEvents(constructedEvents, "2026-09-01T00:00:00Z");
    const september = months.find((month) => month.month === "2026-09")!;
    expect(september.rows).toEqual([{ id: "kafka:github:pull:90001", source: "github", kind: "pull-request", person: "github:edge-author", at: "2026-09-30T23:59:59Z", thread: "KAFKA-PR-90001", merged: "2026-10-10T10:00:00Z" }]);
    expect(months.find((month) => month.month === "2026-10")!.rows.map((row) => row.id)).not.toContain("kafka:github:pull:90001");
    // Positive control: one second later it is October's.
    const later = activityMonthsFromEvents([github("kafka:github:pull:90001", { externalNumber: 90001, author: "edge-author", createdAt: "2026-10-01T00:00:00Z" }, "2026-11-09T00:00:00Z")], "2026-09-01T00:00:00Z");
    expect(later.map((month) => month.month)).toEqual(["2026-10"]);
  });

  test("W3: rows before the log's coverage are not written (a pull request opened before it is not 'authored' in it)", () => {
    const months = activityMonthsFromEvents(fixtureEvents(), COVERAGE_FROM);
    expect(months.every((month) => month.rows.every((row) => row.at >= COVERAGE_FROM))).toBe(true);
    // Positive control: without the coverage bound, m1a2st's 11 older pull requests appear.
    const all = activityMonthsFromEvents(fixtureEvents(), "2000-01-01T00:00:00Z");
    const m1a2st = all.flatMap((month) => month.rows).filter((row) => row.person === "github:m1a2st" && row.kind === "pull-request");
    expect(m1a2st.length).toBe(18);
  });

  test("W4: process labels are left out per project; the same label is an area elsewhere; dev@ and Jira say they have no label data", async () => {
    const body = (await read("github:label-author")).body as PersonProfileV1;
    expect(body.activity!.threads["KAFKA-PR-90002"]!.labels).toEqual(["ci-approved", "clients", "small"]);
    expect(profileView(body, "12m", NOW).activity!.areas.labels).toEqual([{ label: "clients", threads: 1 }]);
    const mail = (await read("mail:Andrew Schofield")).body as PersonProfileV1;
    expect(profileView(mail, "12m", NOW).activity!.areas.noLabelSources).toEqual(["mail"]);
  });

  test("W27: with the log recorded, the coverage line names each source with its own start; the first append's date is stated", async () => {
    const body = (await read("github:chia7712")).body as PersonProfileV1;
    expect(body.coverage).toEqual([
      { source: "github-reviews", status: "recorded", from: "2025-11-01T00:00:00.000Z", until: "2026-10-14T22:02:21Z", storedFrom: "2025-10-14T00:00:00.000Z" },
      ...(["github", "jira", "mail"] as const).map((source) => ({ source, status: "recorded", from: COVERAGE_FROM, until: RELEASE, storedFrom: COVERAGE_FROM, firstAppendAt: RELEASE })),
    ]);
    expect(body.period).toMatchObject({ from: "2025-11-01T00:00:00.000Z", until: RELEASE });
    // Positive control: without the log's state, the same sources are not recorded (2a).
    const objects = new Map(STORE);
    objects.delete(peopleActivityStateKey("apache-kafka"));
    const without = await read("github:chia7712", { bucket: new CountingBucket(objects) });
    expect(without.status).toBe(404);
    expect(without.body.coverage!.filter((item) => item.status === "not-recorded").map((item) => item.source)).toEqual(["github", "jira", "mail"]);
  });

  test("W27: a month before the log's coverage has no activity count (not 0); the coverage's first month has one", async () => {
    const body = (await read("github:chia7712")).body as PersonProfileV1;
    const rows = profileView(body, "12m", NOW).overTime;
    expect(rows.find((row) => row.label === "2026-08")).toEqual({ label: "2026-08", given: 0, received: 0 });
    expect(rows.find((row) => row.label === "2026-09")!.github).toBeGreaterThan(0);
    expect(rows.find((row) => row.label === "2026-10")!.github).toBeGreaterThan(0);
    expect(profileView(body, "90d", NOW).overTime.filter((row) => row.github !== undefined).map((row) => row.label)[0]).toBe("2026-09-07");
  });

  test("W12: a suppressed Jira or dev@ identity has no page; as a thread author it is unnamed; positive control without suppression", async () => {
    expect((await read("mail:Chia-Ping Tsai", { suppressed: ["mail:chia-ping tsai"] })).status).toBe(404);
    expect((await read("jira:Chia-Ping Tsai", { suppressed: ["mail:chia-ping tsai"] })).status).toBe(200);
    const shown = (await read("github:chia7712")).body as PersonProfileV1;
    expect(Object.values(shown.activity!.threads).some((thread) => thread.author === "github:gabriellefu")).toBe(true);
    const hidden = (await read("github:chia7712", { suppressed: ["github:gabriellefu"] })).body as PersonProfileV1;
    expect(Object.values(hidden.activity!.threads).some((thread) => thread.author === "github:gabriellefu")).toBe(false);
    expect(hidden.activity!.people["github:gabriellefu"]).toBeUndefined();
    expect(hidden.totals.activity).toEqual(shown.totals.activity!);
  });

  test("W13: no activity response or stored object holds an address, a body, a score or a rank", async () => {
    for (const row of activityPlanRows.filter((item) => item.status === 200)) {
      const text = JSON.stringify((await read(row.person)).body);
      expect(text).not.toMatch(/@[a-z0-9-]+\.[a-z]/iu);
      expect(text).not.toMatch(/"(score|rank|percentile|grade|excerpt|body|text)"/u);
    }
    for (const [key, body] of STORE) {
      expect(`${key} ${body}`).not.toMatch(/@[a-z0-9-]+\.[a-z]|\(fixture\)/iu);
    }
  });

  test("W10: an unreadable activity month is named; the profile answers with the other months", async () => {
    const broken = new Set([peopleActivityMonthKey("apache-kafka", "2026-09")]);
    const result = await read("mail:Andrew Schofield", { bucket: new CountingBucket(STORE, broken) });
    expect(result.status).toBe(200);
    const body = result.body as PersonProfileV1;
    expect(body.unavailableMonths).toEqual(["2026-09"]);
    expect(body.activity!.records.every((record) => record.at >= "2026-10")).toBe(true);
    // Positive control: September has his messages when readable.
    const whole = (await read("mail:Andrew Schofield")).body as PersonProfileV1;
    expect(whole.activity!.records.some((record) => record.at < "2026-10")).toBe(true);
  });

  test("W29: a cold request reads 2 state objects, the review months and the activity months; a warm one reads nothing", async () => {
    const bucket = new CountingBucket(STORE);
    expect((await read("mail:Andrew Schofield", { bucket })).status).toBe(200);
    // Review months 2025-11 … 2026-10 (12) + activity months from the coverage start (2026-09, 2026-10).
    expect(bucket.reads.filter((key) => key.startsWith("internal/people/")).sort()).toEqual([
      peopleActivityMonthKey("apache-kafka", "2026-09"), peopleActivityMonthKey("apache-kafka", "2026-10"), peopleActivityStateKey("apache-kafka"),
    ]);
    const cold = bucket.reads.length;
    expect((await read("github:chia7712", { bucket })).status).toBe(200);
    expect(bucket.reads.length - cold).toBe(12);
    expect((await read("jira:Chia-Ping Tsai", { bucket })).status).toBe(200);
    expect(bucket.reads.length - cold).toBe(12);
  });

  test("Decision 10: each stored summary holds the counters the reader's per-identity index computes for that month", () => {
    for (const [key, body] of STORE) {
      if (!key.endsWith(".summary.json")) continue;
      const month = parseActivityMonth(JSON.parse(STORE.get(key.replace(".summary.json", ".json"))!), "apache-kafka", key.slice(-20, -13));
      const index = indexActivityMonth(month);
      const summary = JSON.parse(body) as { people: Record<string, { counts: Record<string, number> }> };
      expect(Object.keys(summary.people).sort()).toEqual([...index.people.keys()].sort());
      for (const [person, entry] of index.people) expect(summary.people[person]!.counts).toEqual({ ...entry.summary.counts });
    }
  });

  test("identity: ids are source-keyed and case- and quote-insensitive; names that are no one have no id", () => {
    expect(activityPersonId("mail", "\"Chia-Ping Tsai\"")).toBe("mail:chia-ping tsai");
    expect(activityPersonId("jira", "Chia-Ping Tsai")).toBe("jira:chia-ping tsai");
    expect(activityPersonId("github", "AndrewJSchofield")).toBe("github:andrewjschofield");
    expect([activityPersonId("mail", "unknown sender"), activityPersonId("jira", "unknown"), activityPersonId("github", "ghost"), activityPersonId("mail", " ")]).toEqual([undefined, undefined, undefined, undefined]);
  });

  test("W6: an identity with records only before the 90-day window is empty for 90 days; positive control in 12 months", async () => {
    const body = (await read("mail:Andrew Schofield", { now: Date.parse("2027-01-20T00:00:00Z") })).body as PersonProfileV1;
    expect(profileView(body, "90d", Date.parse("2027-01-20T00:00:00Z")).empty).toBe(true);
    expect(profileView(body, "12m", Date.parse("2027-01-20T00:00:00Z")).empty).toBe(false);
  });
});

export type { ActivityMonthV1 };
