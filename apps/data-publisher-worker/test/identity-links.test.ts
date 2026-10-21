/**
 * Spec 019 amendment (7), slice A: KIP discussion starters (W66), the stored fields (W67, W68), the
 * `corroborated` rule (W69–W73, W84), the identity-link job (W76–W79, W81, W82, W85, W91) and the
 * committers capture (W103, W104). Rows come from
 * `packages/reference-pipeline/test/identity-links.cases.ts`; recorded rows read the upstream
 * fixture of 2026-10-21 (`bun run measure:identity-links -- --record`).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DomainEventV1 } from "@oss-knowledge-base/domain";
import {
  activityMonthsFromEvents,
  classifyPrecision,
  committerLinks,
  computeIdentityLinks,
  defaultReferenceConfig,
  encodeActivityMonth,
  encodeIdentityLinks,
  IDENTITY_LINKS_LAST_RUN_KEY,
  IdentityFacts,
  identityLinksKey,
  JIRA_FIELDS,
  jiraEventsFrom,
  KAFKA_COMMITTERS_CAPTURE,
  KAFKA_COMMITTERS_URL,
  KAFKA_IDENTITY_PROFILE,
  kipStarters,
  mailEventFrom,
  materializeReferenceFeed,
  mergeActivityMonth,
  OWNER_DECLARED_EXAMPLE,
  parseActivityMonth,
  parseCommittersPage,
  PEOPLE_ACTIVITY_STATE_SCHEMA,
  peopleActivityMonthKey,
  peopleActivityStateKey,
  suppressedIdentities,
  uniqueCommitterPairs,
  validDeclaredLink,
  type ActivityMonthV1,
  type ActivityRowV1,
  type ActivityThreadV1,
  type CorroborationConfig,
  type DeclaredLinkV1,
  type IdentityLinksTableV1,
  type PeopleIdentityProfile,
  type Roster,
} from "@oss-knowledge-base/reference-pipeline";
import { readPersonProfile, suppressionDigest, type PeopleBucket } from "@oss-knowledge-base/reference-pipeline/people";

import { testPlanRows } from "../../../packages/reference-pipeline/test/identity-links.cases";
import worker, { cronTarget } from "../src/index";
import { runIdentityLinks, type IdentityLinksBucket, type IdentityLinksRecord } from "../src/identity-links/run";

const ROOT = join(import.meta.dir, "../../..");
const FIXTURE = JSON.parse(readFileSync(join(ROOT, "packages/reference-pipeline/test/fixtures/identity-links/upstream-2026-09-15_2026-10-21.json"), "utf8")) as {
  readonly capturedAt: string;
  readonly months: readonly ActivityMonthV1[];
};
const RECORDED = FIXTURE.months.map((month) => parseActivityMonth(month, "apache-kafka", month.month));
const KAFKA = "apache-kafka";
const CONFIG: CorroborationConfig = KAFKA_IDENTITY_PROFILE.corroboration!;
const INPUTS = { coverageFrom: "2026-09-15T00:00:00.000Z", months: ["2026-09", "2026-10"], activityUpdatedAt: "2026-10-21T14:03:02.205Z", rosterAt: null };

type Row = (typeof testPlanRows)[number];

// ---- constructed activity months ------------------------------------------------------------

class MonthBuilder {
  readonly threads: Record<string, ActivityThreadV1> = {};
  readonly rows: ActivityRowV1[] = [];
  readonly people: Record<string, string> = {};
  constructor(readonly month: string) {}

  pr(number: number, login: string, title: string): this {
    const key = `KAFKA-PR-${number}`;
    const author = `github:${login.toLowerCase()}`;
    this.threads[key] = { source: "github", kind: "pull-request", title, url: `https://github.com/apache/kafka/pull/${number}`, author, labels: [], kips: [] };
    this.rows.push({ id: `kafka:github:pull:${number}`, source: "github", kind: "pull-request", person: author, thread: key, at: `${this.month}-10T00:00:00Z` });
    this.people[author] = login;
    return this;
  }

  issue(key: string, summary: string, assignee: readonly [string, string] | null, reporter: readonly [string, string] | null = assignee): this {
    const account = (value: readonly [string, string] | null) => (value === null ? null : { key: value[0], display: value[1] });
    this.threads[key] = {
      source: "jira", kind: "issue", title: `${key}: ${summary}`, url: `https://issues.apache.org/jira/browse/${key}`,
      author: reporter === null ? null : `jira:${reporter[1].toLowerCase()}`, labels: [], kips: [], reporter: account(reporter), assignee: account(assignee),
    };
    const person = `jira:${(reporter ?? ["", "someone"])[1].toLowerCase()}`;
    this.rows.push({ id: `kafka:jira:issue:${key}`, source: "jira", kind: "issue", person, thread: key, at: `${this.month}-11T00:00:00Z` });
    return this;
  }

  mail(thread: string, title: string, display: string, at: string, opens: boolean, id = `kafka:mail:dev:message:${thread}-${at}`): this {
    const person = `mail:${display.toLowerCase()}`;
    this.threads[thread] ??= { source: "mail", kind: "mail-thread", title, url: `https://lists.apache.org/thread/${thread}`, author: person, labels: [], kips: [] };
    this.rows.push({ id, source: "mail", kind: "message", person, thread, at, ...(opens ? { opens: true as const } : {}) });
    this.people[person] = display;
    return this;
  }

  build(): ActivityMonthV1 {
    return parseActivityMonth(JSON.parse(encodeActivityMonth({
      schema: "osskb.people-activity.v1", projectId: KAFKA, month: this.month, people: this.people, threads: this.threads, rows: this.rows,
    })), KAFKA, this.month);
  }
}

function facts(months: readonly ActivityMonthV1[], bots: readonly string[] = []): IdentityFacts {
  const value = new IdentityFacts(KAFKA, "KAFKA-", bots);
  for (const month of months) value.add(month);
  return value;
}

function compute(months: readonly ActivityMonthV1[], options: {
  readonly config?: Partial<CorroborationConfig>;
  readonly identityLinks?: readonly DeclaredLinkV1[];
  readonly roster?: Roster | null;
  readonly blind?: boolean;
  readonly suppressed?: ReadonlySet<string>;
  readonly bots?: readonly string[];
} = {}) {
  return computeIdentityLinks({
    projectId: KAFKA,
    config: { ...CONFIG, ...options.config },
    facts: facts(months, options.bots),
    roster: options.roster ?? null,
    identityLinks: options.identityLinks ?? [],
    blind: options.blind ?? false,
    ...(options.suppressed === undefined ? {} : { suppressed: options.suppressed }),
    inputs: INPUTS,
  });
}

const personOf = (table: IdentityLinksTableV1, id: string) => table.people.find((person) => person.members.some((member) => member.id === id));
const membersOf = (table: IdentityLinksTableV1, id: string) => personOf(table, id)?.members.map((member) => member.id) ?? [];
const linked = (table: IdentityLinksTableV1, a: string, b: string) =>
  table.people.some((person) => person.links.some((link) => (link.a === a && link.b === b) || (link.a === b && link.b === a)));

/** `n` pull requests by `login`, each naming its own key assigned to `account`. */
function pairing(month: MonthBuilder, login: string, account: readonly [string, string], keys: readonly number[]): MonthBuilder {
  for (const key of keys) month.issue(`KAFKA-${key}`, `Issue ${key}`, account).pr(key, login, `KAFKA-${key}: change ${key}`);
  return month;
}

const declared = (a: string, b: string, extra: Partial<DeclaredLinkV1> = {}): DeclaredLinkV1 => ({
  a, b, evidence: "https://example.org/statement", date: "2026-10-21", reviewer: "unknowntpo", ...extra,
});

// ---- the job's bucket and Worker environment -------------------------------------------------

class MemoryBucket implements IdentityLinksBucket {
  readonly objects = new Map<string, string>();
  readonly operations: string[] = [];
  readonly puts: { key: string; body: string }[] = [];
  failGet?: (key: string) => boolean;
  failPut?: (key: string) => boolean;
  async get(key: string) {
    this.operations.push(`get ${key}`);
    if (this.failGet?.(key) === true) throw new Error(`injected R2 failure at ${key}`);
    return this.objects.get(key);
  }
  async put(key: string, body: string) {
    this.operations.push(`put ${key}`);
    if (this.failPut?.(key) === true) throw new Error(`injected R2 failure at ${key}`);
    this.puts.push({ key, body });
    this.objects.set(key, body);
  }
}

const ROSTER: Roster = {
  adapter: "asf", project: "kafka", fetchedAt: "2026-10-20T10:00:00.000Z",
  entries: [{ id: "mimaison", name: "Mickael Maison", roles: ["committer", "pmc"] }, { id: "ecomar", name: "Edoardo Comar", roles: ["committer"] }],
};

function seeded(months: readonly ActivityMonthV1[] = RECORDED, options: { readonly roster?: boolean; readonly state?: boolean } = {}): MemoryBucket {
  const bucket = new MemoryBucket();
  if (options.state !== false) {
    bucket.objects.set(peopleActivityStateKey(KAFKA), JSON.stringify({
      schema: PEOPLE_ACTIVITY_STATE_SCHEMA, firstAppendAt: "2026-09-15T00:00:00.000Z", coverageFrom: "2026-09-15T00:00:00.000Z",
      updatedAt: "2026-10-21T14:03:02.205Z", months: months.map((month) => month.month),
    }));
  }
  for (const month of months) bucket.objects.set(peopleActivityMonthKey(KAFKA, month.month), encodeActivityMonth(month));
  if (options.roster !== false) bucket.objects.set("internal/rosters/v1/asf/kafka.json", JSON.stringify(ROSTER));
  return bucket;
}

let clock = Date.parse("2026-10-22T02:17:00.000Z");
function run(bucket: IdentityLinksBucket, options: { readonly dryRun?: boolean; readonly blind?: boolean; readonly profiles?: readonly PeopleIdentityProfile[]; readonly flag?: string } = {}) {
  return runIdentityLinks({
    flag: options.flag ?? "corroborated@1",
    bucket,
    profiles: options.profiles ?? [KAFKA_IDENTITY_PROFILE, { projectId: "apache-datafusion", identityLinks: [], roster: null }],
    bots: () => [],
    suppressed: {},
    digest: suppressionDigest,
    now: () => clock,
    dryRun: options.dryRun === true,
    blind: options.blind === true,
  });
}

function environment(flag: string | undefined, bucket: MemoryBucket, options: { readonly cron?: string; readonly failingBucket?: boolean } = {}) {
  const publisher: string[] = [];
  const stub = (body: unknown, log?: string[]) => ({
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (url: string, init?: RequestInit) => {
        log?.push(`${init?.method ?? "GET"} ${url}`);
        return Response.json(body, { status: url.endsWith("/run") ? 202 : 200 });
      },
    }),
  });
  const r2Operations: string[] = [];
  const env = {
    PUBLICATION_ENVIRONMENT: "development",
    MANUAL_TRIGGER_TOKEN: "manual-under-test",
    PIPELINE_STATE: stub({ environment: "development", running: false }, publisher),
    DIGEST_RUN: stub({ running: false }),
    IDENTITY_LINKS_CRON: options.cron ?? "17 2 * * *",
    OSS_KB_BUCKET: {
      get: async (key: string) => {
        r2Operations.push(`get ${key}`);
        if (options.failingBucket === true) throw new Error("injected R2 failure");
        const body = bucket.objects.get(key);
        return body === undefined ? null : { json: async () => JSON.parse(body), text: async () => body };
      },
      put: async (key: string, body: string) => {
        r2Operations.push(`put ${key}`);
        if (options.failingBucket === true) throw new Error("injected R2 failure");
        bucket.objects.set(key, body);
        return {};
      },
    },
    ...(flag === undefined ? {} : { IDENTITY_LINKS: flag }),
  };
  const tick = async (cron: string) => {
    const pending: Promise<unknown>[] = [];
    await worker.scheduled({ cron, scheduledTime: clock } as never, env as never, { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as never);
    return Promise.allSettled(pending);
  };
  const manual = (query = "") => worker.fetch(new Request(`https://data.example/identity-links/run${query}`, {
    method: "POST", headers: { authorization: "Bearer manual-under-test" },
  }), env as never);
  return { env, publisher, r2Operations, tick, manual };
}

// ---- recorded Jira and dev@ inputs ------------------------------------------------------------

/** The ASF Jira user object's shape (recorded keys; `name`, `timeZone`, avatars and the email are placeholders). */
const ERIC_JIRA_USER = {
  self: "https://issues.apache.org/jira/rest/api/2/user?username=JIRAUSER306218", key: "JIRAUSER306218", name: "constructed-account-name",
  displayName: "Eric Chang", timeZone: "Constructed/Zone", active: true, emailAddress: "constructed@example.invalid",
  avatarUrls: { "48x48": "https://issues.apache.org/jira/secure/useravatar?constructed=1" },
};

function jiraIssue(assignee: unknown) {
  return {
    key: "KAFKA-20995",
    fields: {
      summary: "KIP-1371: Explicit Wait Conditions for Consumer Request Managers", description: "Constructed description.",
      status: { name: "Open" }, updated: "2026-10-20T08:00:00.000+0000", created: "2026-09-22T08:00:00.000+0000",
      reporter: ERIC_JIRA_USER, assignee, comment: { comments: [] },
    },
  };
}

function jiraEvents(assignee: unknown): readonly DomainEventV1[] {
  const parsed = jiraEventsFrom(jiraIssue(assignee), "2026-10-21T00:00:00.000Z");
  if (parsed.kind !== "events") throw new Error(parsed.reason);
  return parsed.events;
}

function mailEvent(mid: string, subject: string, from: string, at: string): DomainEventV1 {
  const parsed = mailEventFrom({ mid, epoch: Date.parse(at) / 1000, subject, from, body: "-" }, at);
  if (parsed.kind !== "event") throw new Error(`mail ${mid}: ${parsed.kind}`);
  return parsed.event;
}

class ProfileBucket implements PeopleBucket {
  constructor(private readonly objects: ReadonlyMap<string, string>) {}
  async get(key: string) {
    const body = this.objects.get(key);
    return body === undefined ? null : { text: async () => body };
  }
}

const FORBIDDEN = ["constructed-account-name", "Constructed/Zone", "useravatar", "avatarUrls", "timeZone", "emailAddress", "constructed@example.invalid", "\"active\""];

// ---- the executable rows ----------------------------------------------------------------------

const cases: Record<string, (row: Row) => Promise<void> | void> = {
  "W66|a root message starts the KIP discussion": () => {
    const starter = kipStarters(RECORDED).find((item) => item.kip === "KIP-1376");
    expect([starter?.person, starter?.thread, starter?.at.slice(0, 10)]).toEqual(["mail:mickael maison", "KAFKA-MAIL-3bc971ac", "2026-10-06"]);
  },
  "W66|replies only": () => {
    const thread = RECORDED.flatMap((month) => month.rows).filter((row) => row.thread === "KAFKA-MAIL-fd63cd54");
    expect(thread.length).toBeGreaterThan(1);
    expect(thread.some((row) => row.opens === true)).toBe(false);
    expect(kipStarters(RECORDED).map((item) => item.kip)).not.toContain("KIP-1368");
  },
  "W66|title without brackets": () => {
    expect(kipStarters(RECORDED).find((item) => item.kip === "KIP-1378")?.person).toBe("mail:edoardo comar");
  },
  "W66|one KIP number used by two threads": () => {
    const months = [
      new MonthBuilder("2025-04").mail("KAFKA-MAIL-streams", "[DISCUSS] KIP-1153: Streams KIP", "黃竣陽", "2025-04-12T00:00:00Z", true).build(),
      new MonthBuilder("2025-04").mail("KAFKA-MAIL-connect", "[DISCUSS] KIP-1153: Connect microsecond precision", "pritam kumar", "2025-04-04T00:00:00Z", true).build(),
    ];
    expect(kipStarters(months).map((item) => [item.kip, item.person])).toEqual([["KIP-1153", "mail:pritam kumar"]]);
    // Months in the other order give the same starter.
    expect(kipStarters([...months].reverse()).map((item) => item.person)).toEqual(["mail:pritam kumar"]);
  },
  "W66|a title naming two KIPs": () => {
    const two = new MonthBuilder("2026-10").mail("KAFKA-MAIL-two", "[DISCUSS] KIP-1 and KIP-2", "A B", "2026-10-01T00:00:00Z", true).build();
    expect(kipStarters([two])).toEqual([]);
    // Positive control: the same root naming one KIP starts it.
    const one = new MonthBuilder("2026-10").mail("KAFKA-MAIL-one", "[DISCUSS] KIP-1", "A B", "2026-10-01T00:00:00Z", true).build();
    expect(kipStarters([one]).map((item) => item.kip)).toEqual(["KIP-1"]);
  },
  "W66|a [VOTE] root is not a discussion": () => {
    const month = new MonthBuilder("2026-10")
      .mail("KAFKA-MAIL-vote", "[VOTE] KIP-1376", "Voter", "2026-10-01T00:00:00Z", true)
      .mail("KAFKA-MAIL-discuss", "[DISCUSS] KIP-1376: TLS groups", "Mickael Maison", "2026-10-06T00:00:00Z", true).build();
    expect(kipStarters([month]).map((item) => item.person)).toEqual(["mail:mickael maison"]);
  },
  "W67|the root flag on dev@ rows": () => {
    const events = [
      mailEvent("root1342", "[DISCUSS] KIP-1342: Share consumer", "Ming-Yen Chung <m...@gmail.com>", "2026-09-18T10:00:00Z"),
      mailEvent("reply1342", "Re: [DISCUSS] KIP-1342: Share consumer", "Jun Rao <j...@confluent.io>", "2026-09-19T10:00:00Z"),
    ];
    const rows = activityMonthsFromEvents(events, "2026-09-01T00:00:00Z").flatMap((month) => month.rows);
    expect(rows.map((row) => [row.person, row.opens ?? null])).toEqual([["mail:ming-yen chung", true], ["mail:jun rao", null]]);
  },
  "W67|the flag survives the state sliding": () => {
    const root = mailEvent("rootA", "[DISCUSS] KIP-1342: Share consumer", "Ming-Yen Chung <m...@gmail.com>", "2026-09-18T10:00:00Z");
    const reply = mailEvent("replyA", "Re: [DISCUSS] KIP-1342: Share consumer", "Jun Rao <j...@confluent.io>", "2026-09-19T10:00:00Z");
    const [written] = activityMonthsFromEvents([root, reply], "2026-09-01T00:00:00Z");
    const stored = parseActivityMonth(JSON.parse(encodeActivityMonth(written!)), KAFKA, "2026-09");
    // A later run's state holds only the reply: the stored root row keeps its flag.
    const [later] = activityMonthsFromEvents([reply], "2026-09-01T00:00:00Z");
    const merged = parseActivityMonth(JSON.parse(encodeActivityMonth(mergeActivityMonth(stored, later!))), KAFKA, "2026-09");
    expect(merged.rows.find((row) => row.id.endsWith("rootA"))?.opens).toBe(true);
    expect(merged.rows.find((row) => row.id.endsWith("replyA"))?.opens).toBeUndefined();
    expect(kipStarters([merged]).map((item) => item.person)).toEqual(["mail:ming-yen chung"]);
  },
  "W67|Jira accounts on the thread entry": () => {
    expect(JIRA_FIELDS.split(",")).toContain("assignee");
    const thread = activityMonthsFromEvents(jiraEvents(ERIC_JIRA_USER), "2026-09-01T00:00:00Z")[0]!.threads["KAFKA-20995"]!;
    expect([thread.reporter, thread.assignee]).toEqual([{ key: "JIRAUSER306218", display: "Eric Chang" }, { key: "JIRAUSER306218", display: "Eric Chang" }]);
    // The recorded entry of the fixture says the same.
    expect(RECORDED.find((month) => month.threads["KAFKA-20995"] !== undefined)!.threads["KAFKA-20995"]!.assignee).toEqual({ key: "JIRAUSER306218", display: "Eric Chang" });
  },
  "W68|only key and display name are kept": async () => {
    const events = jiraEvents(ERIC_JIRA_USER);
    const data = events[0]!.data as Record<string, unknown>;
    expect([data.reporterKey, data.assignee]).toEqual(["JIRAUSER306218", { key: "JIRAUSER306218", displayName: "Eric Chang" }]);
    const months = activityMonthsFromEvents(events, "2026-09-01T00:00:00Z");
    const table = compute(months).table;
    const internal = [JSON.stringify(events), ...months.map(encodeActivityMonth), encodeIdentityLinks(table)].join("\n");
    for (const value of FORBIDDEN) expect(internal).not.toContain(value);
    // Positive control: the internal objects do hold the account key.
    expect(months.map(encodeActivityMonth).join("")).toContain("JIRAUSER306218");

    // Public responses: the feed and detail, and the profile of the Jira identity.
    // A dev@ thread on KIP-1371 makes the Jira issue a published entry (Spec 012).
    const thread = mailEvent("discuss1371", "[DISCUSS] KIP-1371: Explicit Wait Conditions", "Eric Chang <e...@gmail.com>", "2026-10-20T08:00:00Z");
    const publication = JSON.stringify(materializeReferenceFeed([...events, thread], defaultReferenceConfig("2026-10-21T00:00:00.000Z")).publication);
    expect(publication).toContain("KIP-1371: Explicit Wait Conditions");
    const objects = new Map<string, string>([[peopleActivityStateKey(KAFKA), JSON.stringify({
      schema: PEOPLE_ACTIVITY_STATE_SCHEMA, firstAppendAt: "2026-10-20T22:07:00.000Z", coverageFrom: "2026-09-15T00:00:00.000Z", updatedAt: "2026-10-20T22:07:00.000Z", months: ["2026-10"],
    })], ...months.map((month) => [peopleActivityMonthKey(KAFKA, month.month), encodeActivityMonth(month)] as const)]);
    const profile = await readPersonProfile({ bucket: new ProfileBucket(objects), projectKey: "kafka", personId: "jira:eric chang", nowMs: Date.parse("2026-10-21T00:00:00Z") });
    expect(profile.status).toBe(200);
    const responses = [publication, JSON.stringify(profile.body)].join("\n");
    expect(responses).toContain("KAFKA-20995");
    for (const value of [...FORBIDDEN, "JIRAUSER306218"]) expect(responses).not.toContain(value);
  },
  "W68|an unassigned issue": () => {
    const months = activityMonthsFromEvents(jiraEvents(null), "2026-09-01T00:00:00Z");
    expect(months[0]!.threads["KAFKA-20995"]!.assignee).toBeNull();
    // Three pull requests by one login on the unassigned issue pair nothing.
    const prs = new MonthBuilder("2026-10").pr(1, "x", "KAFKA-20995: a").pr(2, "x", "KAFKA-20995: b").build();
    expect(compute([...months, prs], { config: { minIssues: 1 } }).table.people).toEqual([]);
  },
  "W69|five keys, no competitor": () => {
    const table = compute(RECORDED).table;
    const link = personOf(table, "github:unknowntpo")!.links.find((item) => item.b === "jira-account:JIRAUSER306218" || item.a === "jira-account:JIRAUSER306218")!;
    expect(link.basis).toBe("corroborated");
    expect(link.evidence.map((item) => item.id)).toEqual(["KAFKA-21152", "KAFKA-21172", "KAFKA-21252", "KAFKA-21262", "KAFKA-21266", "KAFKA-21276"]);
  },
  "W69|a competing pairing below the minimum": () => {
    const { table, counts } = compute(RECORDED);
    expect(linked(table, "github:harmadasg", "jira-account:JIRAUSER306203")).toBe(true);
    expect(personOf(table, "github:m1a2st")).toBeUndefined();
    // m1a2st's 2 keys fall to the minimum rule; nothing in the recorded window is a dominance rejection.
    expect(counts.rejected.dominance).toBe(0);
  },
  "W69|a bot author pairs nothing": () => {
    const month = pairing(pairing(new MonthBuilder("2026-10"), "ci-bot", ["Y", "Y Y"], [1, 2, 3]), "helper[bot]", ["Z", "Z Z"], [4, 5, 6]).build();
    expect(compute([month], { bots: ["ci-bot"] }).table.people).toEqual([]);
    // Positive control: off the bot list, ci-bot links; a `[bot]` login never does.
    const control = compute([month]).table;
    expect([linked(control, "github:ci-bot", "jira-account:Y"), personOf(control, "github:helper[bot]")]).toEqual([true, undefined]);
  },
  "W69|split pairings": () => {
    expect(personOf(compute(RECORDED).table, "github:m1a2st")).toBeUndefined();
  },
  "W69|a committer assigned to issues others fixed": () => {
    const table = compute(RECORDED).table;
    expect(personOf(table, "jira-account:chia7712")).toBeUndefined();
    // Positive control: dybyte keeps his own corroborated link.
    expect(linked(table, "github:dybyte", "jira-account:JIRAUSER312871")).toBe(true);
  },
  "W69|a backport counts once": () => {
    const month = new MonthBuilder("2026-10").issue("KAFKA-1", "one", ["Y", "Y Y"]).pr(1, "x", "KAFKA-1: a").pr(2, "x", "KAFKA-1: a (4.1)").pr(3, "x", "KAFKA-1: a (4.0)").build();
    expect(compute([month]).table.people).toEqual([]);
    // Positive control: three distinct keys link.
    expect(linked(compute([pairing(new MonthBuilder("2026-10"), "x", ["Y", "Y Y"], [1, 2, 3]).build()]).table, "github:x", "jira-account:Y")).toBe(true);
  },
  "W69|dominance boundary": () => {
    const at = (competitor: number) => pairing(pairing(new MonthBuilder("2026-10"), "x", ["Y", "Y Y"], [1, 2, 3, 4, 5, 6]), "x", ["Z", "Z Z"], Array.from({ length: competitor }, (_, index) => 10 + index)).build();
    const two = compute([at(2)]);
    expect([linked(two.table, "github:x", "jira-account:Y"), two.counts.rejected.dominance]).toEqual([true, 0]);
    // 6 < 3 × 3: dominance refuses both pairings (not the component check).
    const three = compute([at(3)]);
    expect([linked(three.table, "github:x", "jira-account:Y"), three.counts.rejected.dominance, three.counts.rejected.conflict]).toEqual([false, 2, 0]);
  },
  "W69|minimum boundary": () => {
    expect(compute([pairing(new MonthBuilder("2026-10"), "x", ["Y", "Y Y"], [1, 2]).build()]).table.people).toEqual([]);
    expect(linked(compute([pairing(new MonthBuilder("2026-10"), "x", ["Y", "Y Y"], [1, 2, 3]).build()]).table, "github:x", "jira-account:Y")).toBe(true);
  },
  "W70|one KIP is not enough": () => {
    const { table, starters } = compute(RECORDED);
    expect(starters.find((item) => item.kip === "KIP-1371")?.person).toBe("mail:eric chang");
    expect(personOf(table, "mail:eric chang")).toBeUndefined();
  },
  "W70|two KIPs": () => {
    const second = new MonthBuilder("2026-10")
      .mail("KAFKA-MAIL-9001", "[DISCUSS] KIP-9001: constructed", "Eric Chang", "2026-10-15T00:00:00Z", true)
      .issue("KAFKA-99001", "KIP-9001: constructed", ["JIRAUSER306218", "Eric Chang"]).build();
    const table = compute([...RECORDED, second]).table;
    const link = personOf(table, "mail:eric chang")!.links.find((item) => item.b === "mail:eric chang")!;
    expect([link.a, link.basis, link.evidence.map((item) => item.id)]).toEqual(["jira-account:JIRAUSER306218", "corroborated", ["KIP-1371", "KIP-9001"]]);
    expect(link.evidence[0]!.via).toEqual([{ id: "KAFKA-20995", url: "https://issues.apache.org/jira/browse/KAFKA-20995" }]);
  },
  "W70|a KIP named only in the description": () => {
    // KAFKA-20728 as recorded: KIP-1376 in the description only (its stored `kips`), reporter Netan Mangal, assignee Arnab Nandy.
    const starter = new MonthBuilder("2026-10").mail("KAFKA-MAIL-1376", "[DISCUSS] KIP-1376: TLS groups", "Arnab Nandy", "2026-10-06T00:00:00Z", true);
    const month = starter.issue("KAFKA-20728", "Allow setting TLS named groups", ["JIRAUSER1", "Arnab Nandy"], ["JIRAUSER2", "Netan Mangal"]);
    month.threads["KAFKA-20728"] = { ...month.threads["KAFKA-20728"]!, kips: ["KIP-1376"] };
    expect(compute([month.build()], { config: { minKips: 1 } }).table.people).toEqual([]);
    // Positive control: the same issue naming the KIP in its summary pairs the starter.
    const named = new MonthBuilder("2026-10").mail("KAFKA-MAIL-1376", "[DISCUSS] KIP-1376: TLS groups", "Arnab Nandy", "2026-10-06T00:00:00Z", true)
      .issue("KAFKA-20728", "KIP-1376: Allow setting TLS named groups", ["JIRAUSER1", "Arnab Nandy"], ["JIRAUSER2", "Netan Mangal"]).build();
    expect(linked(compute([named], { config: { minKips: 1 } }).table, "jira-account:JIRAUSER1", "mail:arnab nandy")).toBe(true);
  },
  "W70|two Jira accounts with the starter's name": () => {
    const build = (second: boolean) => {
      const month = new MonthBuilder("2026-10")
        .mail("T1", "[DISCUSS] KIP-1: one", "A B", "2026-10-01T00:00:00Z", true).issue("KAFKA-1", "KIP-1: one", ["K1", "A B"])
        .mail("T2", "[DISCUSS] KIP-2: two", "A B", "2026-10-02T00:00:00Z", true).issue("KAFKA-2", "KIP-2: two", ["K1", "A B"]);
      if (second) month.mail("T3", "[DISCUSS] KIP-3: three", "A B", "2026-10-03T00:00:00Z", true).issue("KAFKA-3", "KIP-3: three", ["K2", "A B"]);
      return month.build();
    };
    const strict = compute([build(true)]);
    expect([strict.table.people, strict.counts.rejected.competitor, strict.counts.rejected.dominance]).toEqual([[], 1, 0]);
    expect(linked(compute([build(false)]).table, "jira-account:K1", "mail:a b")).toBe(true);
  },
  "W71|transitive only through both edges": () => {
    const month = pairing(new MonthBuilder("2026-10"), "x", ["k", "X Person"], [1, 2, 3])
      .mail("T1", "[DISCUSS] KIP-1: one", "X Person", "2026-10-01T00:00:00Z", true).issue("KAFKA-11", "KIP-1: one", ["k", "X Person"])
      .mail("T2", "[DISCUSS] KIP-2: two", "X Person", "2026-10-02T00:00:00Z", true).issue("KAFKA-12", "KIP-2: two", ["k", "X Person"]).build();
    const table = compute([month]).table;
    expect(membersOf(table, "github:x")).toEqual(["github:x", "jira-account:k", "mail:x person"]);
    expect(linked(table, "github:x", "mail:x person")).toBe(false);
  },
  "W71|one edge short": () => {
    const table = compute(RECORDED).table;
    expect(membersOf(table, "github:unknowntpo")).toEqual(["github:unknowntpo", "jira-account:JIRAUSER306218"]);
  },
  "W71|two logins in one component": () => {
    const month = pairing(pairing(new MonthBuilder("2026-10"), "a", ["k", "K"], [1, 2, 3]), "b", ["k", "K"], [4, 5, 6]).build();
    // Dominance 1 lets both pairs qualify, so only the component check stands between them.
    const result = compute([month], { config: { dominance: 1 } });
    expect([result.table.people, result.counts.rejected.conflict]).toEqual([[], 1]);
  },
  "W72|contradicts the roster": () => {
    const roster: Roster = { adapter: "asf", project: "kafka", fetchedAt: "2026-10-20T00:00:00.000Z", entries: [
      { id: "anna", name: "Ann A", roles: ["committer"] }, { id: "bobb", name: "Bob B", roles: ["committer"] }] };
    const month = pairing(new MonthBuilder("2026-10"), "g", ["k", "Ann A"], [1, 2, 3])
      .mail("T1", "[DISCUSS] KIP-1: one", "Ann A", "2026-10-01T00:00:00Z", true).issue("KAFKA-11", "KIP-1: one", ["k", "Ann A"])
      .mail("T2", "[DISCUSS] KIP-2: two", "Ann A", "2026-10-02T00:00:00Z", true).issue("KAFKA-12", "KIP-2: two", ["k", "Ann A"])
      .mail("T3", "Re: hello", "Bob B", "2026-10-03T00:00:00Z", false).build();
    const result = compute([month], { roster, identityLinks: [declared("github:g", "mail:bob b")] });
    expect(result.counts.rejected.contradiction).toBe(1);
    expect(result.counts.links).toEqual({ roster: 2, declared: 1, corroborated: 0 });
    // Positive control: without the declared entry the chain links github:g to asf:anna's person.
    expect(membersOf(compute([month], { roster }).table, "github:g")).toEqual(["asf:anna", "github:g", "jira-account:k", "mail:ann a"]);
  },
  "W72|declared removal": () => {
    const removal = declared("github:unknowntpo", "jira-account:JIRAUSER306218", { remove: true });
    const result = compute(RECORDED, { identityLinks: [removal] });
    expect(linked(result.table, "github:unknowntpo", "jira-account:JIRAUSER306218")).toBe(false);
    expect(result.counts.rejected.removed).toBe(1);
    expect(linked(compute(RECORDED).table, "github:unknowntpo", "jira-account:JIRAUSER306218")).toBe(true);
  },
  "W72|declared and corroborated on one pair": () => {
    const entry = declared("github:unknowntpo", "jira-account:JIRAUSER306218");
    const { table, counts } = compute(RECORDED, { identityLinks: [entry] });
    const pair = personOf(table, "github:unknowntpo")!.links.filter((link) => [link.a, link.b].includes("jira-account:JIRAUSER306218"));
    expect(pair.map((link) => link.basis)).toEqual(["declared"]);
    expect([counts.links.declared, counts.links.corroborated]).toEqual([1, 27]);
  },
  "W72|suppressed identity": async () => {
    const month = pairing(new MonthBuilder("2026-10"), "x", ["Y", "Y Y"], [1, 2, 3]).build();
    const digest = await suppressionDigest(KAFKA, "github:x");
    const suppressed = await suppressedIdentities({ ids: facts([month]).identities(), accountNames: facts([month]).accountNames(), digests: [digest], digest: (id) => suppressionDigest(KAFKA, id) });
    expect([...suppressed]).toEqual(["github:x"]);
    const table = compute([month], { suppressed, identityLinks: [declared("github:x", "mail:x")] }).table;
    expect(table.people).toEqual([]);
    expect(compute([month]).table.people.length).toBe(1);
  },
  "W73|table format and order": () => {
    const shuffled = [...RECORDED].reverse().map((month) => ({ ...month, threads: Object.fromEntries(Object.entries(month.threads).reverse()), rows: [...month.rows].reverse() }));
    const first = encodeIdentityLinks(compute(RECORDED, { identityLinks: KAFKA_IDENTITY_PROFILE.identityLinks }).table);
    expect(encodeIdentityLinks(compute(shuffled, { identityLinks: KAFKA_IDENTITY_PROFILE.identityLinks }).table)).toBe(first);
    const table = JSON.parse(first) as IdentityLinksTableV1;
    expect([table.schema, table.revision, table.generatedAt]).toEqual(["osskb.identity-links.v1", "corroborated@1", "2026-10-21T14:03:02.205Z"]);
    for (const link of table.people.flatMap((person) => person.links)) {
      expect(["roster", "declared", "corroborated"]).toContain(link.basis);
      expect(link.evidence.length).toBeGreaterThan(0);
      for (const evidence of link.evidence) expect(evidence.url).toStartWith("https://");
      if (link.basis === "corroborated") for (const evidence of link.evidence) expect(evidence.via!.every((pr) => pr.url.startsWith("https://github.com/apache/kafka/pull/"))).toBe(true);
    }
  },
  "W76|a month read fails": async () => {
    const bucket = seeded();
    await run(bucket);
    const good = bucket.objects.get(identityLinksKey(KAFKA))!;
    bucket.puts.length = 0;
    bucket.failGet = (key) => key.endsWith("/2026-09.json");
    const record = await run(bucket);
    expect([record.lastRun.ok, record.lastRun.status]).toEqual([false, "failed"]);
    expect(record.lastRun.error).toContain(peopleActivityMonthKey(KAFKA, "2026-09"));
    expect(bucket.puts.map((put) => put.key)).toEqual([IDENTITY_LINKS_LAST_RUN_KEY]);
    expect(bucket.objects.get(identityLinksKey(KAFKA))).toBe(good);
    expect(record.lastGoodAt).toBe(new Date(clock).toISOString());
    // The last read failing carries lastGoodAt from the record read first: no further read (≤ 15 Class B).
    bucket.failGet = (key) => key.endsWith("/2026-10.json");
    const last = await run(bucket);
    expect([last.lastRun.status, last.lastGoodAt, last.lastRun.r2.classB]).toEqual(["failed", new Date(clock).toISOString(), 5]);
    expect(bucket.operations.filter((operation) => operation === `get ${IDENTITY_LINKS_LAST_RUN_KEY}`).length).toBe(3);
    // A previous run record that does not parse fails closed too.
    bucket.failGet = undefined;
    bucket.objects.set(IDENTITY_LINKS_LAST_RUN_KEY, "not json");
    const corrupt = await run(bucket);
    expect([corrupt.lastRun.status, corrupt.lastRun.error?.includes(IDENTITY_LINKS_LAST_RUN_KEY)]).toEqual(["failed", true]);
    expect(bucket.objects.get(identityLinksKey(KAFKA))).toBe(good);
    // A month the state lists but R2 lacks fails closed as well (it could hide a competing pairing).
    const missing = seeded();
    missing.objects.delete(peopleActivityMonthKey(KAFKA, "2026-09"));
    const gap = await run(missing);
    expect([gap.lastRun.status, gap.lastRun.error?.includes(peopleActivityMonthKey(KAFKA, "2026-09")), missing.objects.has(identityLinksKey(KAFKA))]).toEqual(["failed", true, false]);
  },
  "W77|no activity log": async () => {
    const bucket = seeded(RECORDED, { state: false });
    const record = await run(bucket);
    expect([record.lastRun.ok, record.lastRun.status]).toEqual([true, "no-input"]);
    expect(bucket.puts.map((put) => put.key)).toEqual([IDENTITY_LINKS_LAST_RUN_KEY]);
    expect(record.lastGoodAt).toBeNull();
  },
  "W77|no roster": async () => {
    const bucket = seeded(RECORDED, { roster: false });
    const record = await run(bucket);
    const table = JSON.parse(bucket.objects.get(identityLinksKey(KAFKA))!) as IdentityLinksTableV1;
    expect([record.lastRun.status, table.inputs.rosterAt, record.lastRun.links.roster]).toEqual(["ok", null, 0]);
    // Positive control: with the roster, its unique names that wrote on dev@ link.
    const withRoster = await run(seeded());
    expect(withRoster.lastRun.links.roster).toBe(2);
    expect(withRoster.lastRun.inputs.rosterAt).toBe(ROSTER.fetchedAt);
  },
  "W78|unchanged inputs": async () => {
    const bucket = seeded();
    await run(bucket);
    bucket.puts.length = 0;
    const second = await run(bucket);
    expect(second.lastRun.status).toBe("unchanged");
    expect(bucket.puts.map((put) => put.key)).toEqual([IDENTITY_LINKS_LAST_RUN_KEY]);
    // Positive control: one changed month rewrites the table.
    const changed = pairing(new MonthBuilder("2026-10"), "newcomer", ["N1", "New Comer"], [1, 2, 3]).build();
    bucket.objects.set(peopleActivityMonthKey(KAFKA, "2026-10"), encodeActivityMonth(mergeActivityMonth(RECORDED[1]!, changed)));
    bucket.puts.length = 0;
    const third = await run(bucket);
    expect([third.lastRun.status, bucket.puts.map((put) => put.key)]).toEqual(["ok", [identityLinksKey(KAFKA), IDENTITY_LINKS_LAST_RUN_KEY]]);
  },
  "W79|crash between writes": async () => {
    const bucket = seeded();
    bucket.failPut = (key) => key === IDENTITY_LINKS_LAST_RUN_KEY;
    await expect(run(bucket)).rejects.toThrow("injected R2 failure");
    const table = bucket.objects.get(identityLinksKey(KAFKA));
    expect(table).toBeDefined();
    expect(bucket.objects.has(IDENTITY_LINKS_LAST_RUN_KEY)).toBe(false);
    bucket.failPut = undefined;
    bucket.puts.length = 0;
    const next = await run(bucket);
    expect([next.lastRun.status, bucket.objects.get(identityLinksKey(KAFKA)) === table, bucket.puts.map((put) => put.key)]).toEqual(["ok", true, [identityLinksKey(KAFKA), IDENTITY_LINKS_LAST_RUN_KEY]]);
    // Converged: a third run finds the table unchanged.
    expect((await run(bucket)).lastRun.status).toBe("unchanged");
  },
  "W81|isolation from the publication": async () => {
    const throwing = environment("corroborated@1", new MemoryBucket(), { failingBucket: true });
    const results = await throwing.tick("17 2 * * *");
    expect(results.some((result) => result.status === "rejected")).toBe(true);
    expect(throwing.publisher).toEqual([]);
    // A working run writes only under internal/identity/v1/.
    const working = environment("corroborated@1", seeded());
    await working.tick("17 2 * * *");
    expect(working.publisher).toEqual([]);
    const puts = working.r2Operations.filter((operation) => operation.startsWith("put "));
    expect(puts.length).toBe(2);
    expect(puts.every((operation) => operation.startsWith("put internal/identity/v1/"))).toBe(true);
    // The publication's tick never runs the job.
    const publication = environment("corroborated@1", seeded());
    await publication.tick("7 22 * * *");
    expect(publication.publisher).toEqual(["POST https://pipeline.internal/run"]);
    expect(publication.r2Operations.filter((operation) => /internal\/(identity|people)\//u.test(operation))).toEqual([]);
    expect(cronTarget("17 2 * * *", "47 22 * * *", undefined, "17 2 * * *")).toBe("identity-links");
  },
  "W86|13 months in the state": async () => {
    const months = Array.from({ length: 13 }, (_, index) => {
      const month = new Date(Date.UTC(2025, 9 + index, 1)).toISOString().slice(0, 7);
      return new MonthBuilder(month).mail(`T-${month}`, "Re: hello", "A B", `${month}-05T00:00:00Z`, false).build();
    });
    const bucket = seeded(months, { roster: false });
    const record = await run(bucket);
    const read = bucket.operations.filter((operation) => operation.startsWith("get internal/people/v1/apache-kafka/20"));
    expect(read.length).toBe(12);
    expect(read).not.toContain(`get ${peopleActivityMonthKey(KAFKA, "2025-10")}`);
    expect([record.lastRun.inputs.months[0], record.lastRun.r2.classB]).toEqual(["2025-11", 15]);
  },
  "W82|two runs at once": async () => {
    const bucket = seeded();
    const [cron, manual] = await Promise.all([run(bucket), run(bucket)]);
    expect([cron.lastRun.ok, manual.lastRun.ok]).toEqual([true, true]);
    const tables = bucket.puts.filter((put) => put.key === identityLinksKey(KAFKA)).map((put) => put.body);
    expect(tables.length).toBe(2);
    expect(tables[0]).toBe(tables[1]!);
  },
  "W84|issue reassigned": () => {
    const september = new MonthBuilder("2026-09");
    const october = new MonthBuilder("2026-10");
    for (const key of [1, 2, 3]) {
      september.issue(`KAFKA-${key}`, `Issue ${key}`, ["A", "A A"]).pr(key, "x", `KAFKA-${key}: change`);
      october.issue(`KAFKA-${key}`, `Issue ${key}`, ["B", "B B"]);
    }
    for (const months of [[september.build(), october.build()], [october.build(), september.build()]]) {
      const table = compute(months).table;
      expect(membersOf(table, "github:x")).toEqual(["github:x", "jira-account:B"]);
      expect(personOf(table, "github:x")!.links[0]!.evidence.map((item) => item.id)).toEqual(["KAFKA-1", "KAFKA-2", "KAFKA-3"]);
    }
  },
  "W85|job off": async () => {
    const off = environment(undefined, seeded());
    await off.tick("17 2 * * *");
    expect([off.publisher, off.r2Operations]).toEqual([[], []]);
    const route = await off.manual();
    expect(route.status).toBe(404);
    // Off answers 404 before the token is checked.
    const anonymous = await worker.fetch(new Request("https://data.example/identity-links/run", { method: "POST" }), off.env as never);
    expect(anonymous.status).toBe(404);
    expect(off.r2Operations).toEqual([]);
    const health = await (await worker.fetch(new Request("https://data.example/health"), off.env as never)).json() as Record<string, unknown>;
    expect("identityLinks" in health).toBe(false);
    // Positive control: the flag set runs the route and adds the field.
    const on = environment("corroborated@1", seeded());
    expect((await on.manual()).status).toBe(200);
    const onHealth = await (await worker.fetch(new Request("https://data.example/health"), on.env as never)).json() as Record<string, unknown>;
    expect("identityLinks" in onHealth).toBe(true);
    // An unsupported value fails the run (502), never another job.
    const wrong = environment("true", seeded());
    expect((await wrong.manual()).status).toBe(502);
  },
  "W91|health shape": async () => {
    const env = environment("corroborated@1", seeded());
    const record = await (await env.manual()).json() as IdentityLinksRecord;
    expect(Object.keys(record)).toEqual(["revision", "lastRun", "lastGoodAt", "tables"]);
    expect(Object.keys(record.tables!)).toEqual([KAFKA]);
    expect(Object.keys(record.lastRun)).toEqual(["ok", "status", "at", "durationMs", "inputs", "links", "rejected", "people", "kipStarters", "bytesWritten", "r2"]);
    expect(Object.keys(record.lastRun.inputs)).toEqual(["months", "activityUpdatedAt", "rosterAt", "committersAt"]);
    expect(record.lastRun.inputs.committersAt).toBe(KAFKA_COMMITTERS_CAPTURE.capturedAt);
    expect(Object.keys(record.lastRun.rejected)).toEqual(["dominance", "competitor", "minimum", "conflict", "contradiction", "removed"]);
    expect(record.lastRun.r2).toEqual({ classA: 2, classB: 5 });
    const health = await (await worker.fetch(new Request("https://data.example/health"), env.env as never)).json() as { identityLinks: unknown };
    expect(health.identityLinks).toEqual(record);
  },
  "W103|committers capture as declared entries": () => {
    const links = committerLinks(KAFKA_COMMITTERS_CAPTURE);
    expect(links.length).toBe(68);
    expect(links.every((link) => link.a.startsWith("github:") && link.b.startsWith("mail:") && link.evidence === KAFKA_COMMITTERS_URL && validDeclaredLink(link))).toBe(true);
    expect(links).toContainEqual({ a: "github:dajac", b: "mail:david jacot", evidence: KAFKA_COMMITTERS_URL, date: "2026-10-21", reviewer: "unknowntpo" });
    expect(KAFKA_IDENTITY_PROFILE.identityLinks.filter((link) => link.evidence === KAFKA_COMMITTERS_URL).length).toBe(68);
  },
  "W103|a name twice on the page": () => {
    const card = (name: string, login: string) => `<div class="card h-100 committer-card"><h6 class="card-title mb-1">${name}</h6><a href=https://github.com/${login}/ target=_blank>gh</a></div>`;
    const page = parseCommittersPage(`<html>${card("A B", "ab1")}${card("A B", "ab2")}${card("C D", "cd")}</html>`);
    expect(page).toEqual([{ name: "A B", login: "ab1" }, { name: "A B", login: "ab2" }, { name: "C D", login: "cd" }]);
    expect(uniqueCommitterPairs(page)).toEqual([{ name: "C D", login: "cd" }]);
  },
  "W103|refresh prints the diff": () => {
    const directory = mkdtempSync(join(tmpdir(), "committers-"));
    const capture = join(directory, "capture.ts");
    const pair = (name: string, login: string) => ({ name, login, date: "2026-10-01", reviewer: "old" });
    writeFileSync(capture, `export const KAFKA_COMMITTERS_CAPTURE = ${JSON.stringify({ source: KAFKA_COMMITTERS_URL, capturedAt: "2026-10-01", committers: [pair("X", "x"), pair("Y", "y")] })};\n`);
    const html = join(directory, "page.html");
    const card = (name: string, login: string) => `<div class="committer-card"><h6>${name}</h6><a href="https://github.com/${login}">gh</a></div>`;
    writeFileSync(html, `${card("X Two", "x")}${card("Z", "z")}`);
    const result = Bun.spawnSync(["bun", join(ROOT, "packages/reference-pipeline/scripts/refresh-committers.ts"), "--reviewer", "rev", "--date", "2026-10-22", "--html", html, "--capture", capture]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim().split("\n")).toEqual([
      "added 1, removed 1, changed 1; 2 pairs", "+ github:z ↔ Z", "- github:y ↔ Y", "~ github:x ↔ X → github:x ↔ X Two",
    ]);
    const written = readFileSync(capture, "utf8");
    expect(written).not.toContain("\"login\": \"y\"");
    expect(written).toContain("\"reviewer\": \"rev\"");
  },
  "W103|blind leaves the committers out": async () => {
    const seen = compute(RECORDED, { identityLinks: KAFKA_IDENTITY_PROFILE.identityLinks });
    const blind = compute(RECORDED, { identityLinks: KAFKA_IDENTITY_PROFILE.identityLinks, blind: true });
    expect([seen.counts.links.declared, blind.counts.links.declared, blind.counts.links.corroborated]).toEqual([68, 0, 28]);
    const report = classifyPrecision(blind.table, KAFKA_COMMITTERS_CAPTURE.committers);
    expect([report.corroboratedLinks, report.agree, report.contradict, report.committerUnlabelled, report.toLabel]).toEqual([28, 3, 0, 0, 25]);
    // The Worker's dry run takes `blind=1` and writes nothing.
    const env = environment("corroborated@1", seeded(RECORDED, { roster: false }));
    const dry = await (await env.manual("?dryRun=1&blind=1")).json() as IdentityLinksRecord;
    expect([dry.lastRun.links.declared, dry.lastRun.links.corroborated, dry.precision?.contradict, dry.precision?.agree]).toEqual([0, 28, 0, 3]);
    expect(env.r2Operations.filter((operation) => operation.startsWith("put "))).toEqual([]);
  },
  "W104|evidence is not an https URL": () => {
    expect(validDeclaredLink(OWNER_DECLARED_EXAMPLE)).toBe(false);
    expect(validDeclaredLink({ ...OWNER_DECLARED_EXAMPLE, evidence: "http://example.org/x" })).toBe(false);
    expect(KAFKA_IDENTITY_PROFILE.identityLinks.every(validDeclaredLink)).toBe(true);
    expect(linked(compute(RECORDED, { identityLinks: [OWNER_DECLARED_EXAMPLE] }).table, "github:unknowntpo", "mail:eric chang")).toBe(false);
  },
  "W104|the same entry with a URL": () => {
    const entry = { ...OWNER_DECLARED_EXAMPLE, evidence: "https://github.com/unknowntpo" };
    const table = compute(RECORDED, { identityLinks: [entry] }).table;
    expect(membersOf(table, "github:unknowntpo")).toEqual(["github:unknowntpo", "jira-account:JIRAUSER306218", "mail:eric chang"]);
    expect(personOf(table, "github:unknowntpo")!.links.map((link) => link.basis).sort()).toEqual(["corroborated", "declared"]);
  },
};

describe("Spec 019 amendment (7): identity links (slice A)", () => {
  test.each([...testPlanRows])("$id: $case — $input", async (row) => {
    const execute = cases[`${row.id}|${row.case}`];
    if (execute === undefined) throw new Error(`No executable case for ${row.id} ${row.case}`);
    await execute(row);
  });

  test("every executable case has a test-plan row", () => {
    const rows = new Set(testPlanRows.map((row) => `${row.id}|${row.case}`));
    expect(Object.keys(cases).filter((key) => !rows.has(key))).toEqual([]);
  });

  test("W68: the recorded fixture keeps no Jira name, time zone, avatar, active flag or email", () => {
    const text = readFileSync(join(ROOT, "packages/reference-pipeline/test/fixtures/identity-links/upstream-2026-09-15_2026-10-21.json"), "utf8");
    for (const value of ["timeZone", "avatarUrls", "emailAddress", "\"active\"", "\"name\":"]) expect(text).not.toContain(value);
  });
});
