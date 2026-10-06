/** Spec 012 named tests: publication from captured fixtures and per-source pipeline behavior. */
import { describe, expect, test } from "bun:test";
import type { DomainEventV1, FeedDetail } from "@oss-knowledge-base/domain";
import {
  defaultReferenceConfig,
  JiraConnector,
  materializeReferenceFeed,
  PonyMailConnector,
  type GitHubCheckpointV1,
  type SerializedReferenceStateV1,
  type SourceFetch,
  type SourcePollResult,
} from "@oss-knowledge-base/reference-pipeline";
import { buildLexicalIndex, searchLexicalIndex } from "@oss-knowledge-base/search";
import { materializeSearchPublicationFromFeed, type PublicationObjectStore } from "@oss-knowledge-base/serving-contract";

import fixture from "../../../packages/reference-pipeline/test/fixtures/kafka-sources.v1.json";
import { healthBody } from "../src/health";
import {
  runDataPublication,
  type PipelineRunStatus,
  type PipelineStateRepository,
  type PublicationDestination,
} from "../src/pipeline";

const NOW = "2026-10-06T08:00:00.000Z";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function at(offsetMs: number): string {
  return new Date(Date.parse(NOW) + offsetMs).toISOString();
}

function githubPull(pull: (typeof fixture.githubPulls)[number]): DomainEventV1 {
  const entityId = `kafka:github:pull:${pull.number}`;
  return {
    schemaVersion: 1,
    id: `sha256:fixture-${pull.number}`,
    projectId: "apache-kafka",
    sourceType: "code-host",
    sourceInstanceId: "kafka:github",
    entityType: "artifact",
    entityId,
    eventType: "updated",
    sourceCursor: pull.updated_at,
    sourceTimestamp: pull.updated_at,
    observedAt: NOW,
    canonicalUrl: pull.html_url,
    payloadRef: `content-addressed://sha256/fixture-${pull.number}`,
    sourceConnectorVersion: "github@1",
    communityProfileVersion: "apache-kafka@github-live-1",
    data: {
      contract: "github-record@1",
      recordKind: "pull-request",
      externalNumber: pull.number,
      title: pull.title,
      excerpt: "Pull request captured for Spec 012.",
      author: pull.user,
      authorRole: "Contributor",
      occurredAt: pull.updated_at,
      createdAt: pull.created_at,
      updatedAt: pull.updated_at,
      nativeState: "open",
      labels: [],
      isBot: false,
    },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return { status, headers: new Headers(), text: async () => JSON.stringify(body) };
}

/** Serves the captured fixtures; `down` makes a host fail with HTTP 503. */
function apacheFetch(options: { readonly down?: readonly ("mail" | "jira")[]; readonly urls?: string[]; readonly jira?: unknown } = {}): SourceFetch {
  return async (url) => {
    options.urls?.push(url);
    const source = url.includes("lists.apache.org") ? "mail" : "jira";
    if (options.down?.includes(source)) return jsonResponse({ error: "down" }, 503);
    return jsonResponse(source === "mail" ? fixture.ponyStats : options.jira ?? fixture.jiraSearch);
  };
}

const noSleep = async () => undefined;

async function polledEvents(): Promise<readonly DomainEventV1[]> {
  const mail = await new PonyMailConnector({ fetch: apacheFetch() }).poll(undefined, NOW);
  const jira = await new JiraConnector({ fetch: apacheFetch() }).poll(undefined, NOW);
  if (!mail.complete || !jira.complete) throw new Error("fixture poll failed");
  return [githubPull(fixture.githubPulls[0]!), ...mail.events, ...jira.events];
}

function published(events: readonly DomainEventV1[]) {
  return materializeReferenceFeed(events, defaultReferenceConfig(NOW)).publication;
}

function detailOf(publication: ReturnType<typeof published>, displayId: string): FeedDetail {
  const entry = publication.index.entries.find((item) => item.displayId === displayId);
  if (entry === undefined) throw new Error(`no entry ${displayId}`);
  return publication.details.find((detail) => detail.entry.id === entry.entry.id)!;
}

const voteEntry = (publication: ReturnType<typeof published>) =>
  publication.index.entries.find((item) => item.entry.title === "[VOTE] KIP-1279: Cluster Mirroring")!;

function githubConnector(events: readonly DomainEventV1[], updatedAt = NOW, fail = false) {
  return {
    poll: async (): Promise<SourcePollResult> => fail
      ? { complete: false, events: [], error: "GitHub API 502", failureKind: "transport", retryAfterSeconds: 60 }
      : {
          complete: true,
          events,
          candidateCheckpoint: { schema: "osskb.github-checkpoint.v1", connectorRevision: "github@1", sources: { "kafka:github": { updatedAt } } },
          pageCount: 1,
          truncated: false,
        },
  };
}

function kafkaSources(fetch: SourceFetch) {
  return [
    { key: "mail", connector: new PonyMailConnector({ fetch, sleep: noSleep }) },
    { key: "jira", connector: new JiraConnector({ fetch, sleep: noSleep }) },
  ];
}

describe("Spec 012 Kafka sources in publication", () => {
  test("K6: captured fixtures publish the vote thread and the linked Jira issues with citations", async () => {
    const publication = published(await polledEvents());
    const vote = voteEntry(publication);
    const byId = new Map(publication.index.entries.map((item) => [item.displayId, item]));

    expect(vote.displayId).toMatch(/^KAFKA-MAIL-[0-9a-f]{8}$/u);
    expect(vote.links).toEqual({ mail: "https://lists.apache.org/thread/15rddlqk42tqsjh5rw2r6so5cgns122f" });
    expect(vote.sourceCounts).toEqual({ mail: 6 });
    expect(vote.status).toBe("discussing");
    // The oldest retained message anchors the thread: its preview is the summary.
    expect(vote.entry.sourceTitleRecordId).toBe("kafka:mail:dev:message:qqq7mwdbyd74337t4ob5fv8yp28pv8sv");
    expect(vote.entry.id).toBe("feed-entry:feed-record-group:kafka:mail:dev:message:qqq7mwdbyd74337t4ob5fv8yp28pv8sv");
    expect(byId.get("KAFKA-20186")?.sourceCounts).toEqual({ jira: 1 });
    expect(byId.get("KAFKA-20184")?.sourceCounts).toEqual({ jira: 2 });
    expect([byId.get("KAFKA-20186")?.status, byId.get("KAFKA-20184")?.status]).toEqual(["open", "open"]);
    expect(byId.has("KAFKA-21227")).toBe(false);
    expect(byId.get("KAFKA-PR-21518")?.links.github).toBe("https://github.com/apache/kafka/pull/21518");
    const kafka = publication.index.projects.find((project) => project.key === "kafka");
    expect(kafka?.sources).toEqual(["github", "mail", "jira"]);
    expect(kafka?.statuses.map((status) => status.key)).toEqual(["open", "merged", "closed", "discussing", "resolved"]);
    expect(publication.index.projects.find((project) => project.key === "datafusion")?.statuses.map((status) => status.key))
      .toEqual(["open", "merged", "closed"]);
    for (const detail of publication.details) {
      for (const record of detail.records) expect(record.canonicalUrl).toMatch(/^https:\/\//u);
    }
  });

  test("K6: the unlinked KAFKA-21227 is published once a PR title cites it (positive control)", async () => {
    const publication = published([...await polledEvents(), githubPull(fixture.githubPulls[1]!)]);
    expect(publication.index.entries.map((item) => item.displayId)).toContain("KAFKA-21227");
  });

  test("K3: a thread's title is its newest subject without reply prefixes", async () => {
    const thread = (subjects: readonly [string, number][]) => fixture.ponyStats.emails.slice(0, subjects.length).map((email, index) => ({
      ...email, subject: subjects[index]![0], epoch: subjects[index]![1], mid: `k3m${index}`,
    }));
    const stats = { hits: 2, emails: thread([["Re: [vote] kip-1279: cluster mirroring", 1789135335], ["Re: [VOTE] KIP-1279: Cluster  Mirroring", 1789747597]]) };
    const polled = await new PonyMailConnector({ fetch: async () => jsonResponse(stats) }).poll(undefined, NOW);
    if (!polled.complete) throw new Error("poll failed");
    const titles = published(polled.events).index.entries.map((item) => item.entry.title);
    expect(titles).toEqual(["[VOTE] KIP-1279: Cluster Mirroring"]);
  });

  test("K7: Detail links KAFKA-20184 with PR #21518 and the KIP-1279 vote thread with KAFKA-20186, naming the rule", async () => {
    const publication = published(await polledEvents());
    const vote = voteEntry(publication);
    const related = (displayId: string) => (detailOf(publication, displayId).related ?? []).map((link) => `${link.displayId} ${link.rule}`);

    expect(related("KAFKA-20184")).toEqual(["KAFKA-PR-21518 key-in-title"]);
    expect(related("KAFKA-PR-21518")).toEqual(["KAFKA-20184 key-in-title"]);
    expect(related(vote.displayId)).toEqual(["KAFKA-20186 same-kip"]);
    expect(related("KAFKA-20186")).toEqual([`${vote.displayId} same-kip`]);
    expect(detailOf(publication, "KAFKA-20184").related?.[0]?.ruleRevision).toBe("kafka-key-links@1");
  });

  test("K8: Search finds KAFKA-20184 and KIP-1279 as exact matches, and a hit's Detail carries its display id", async () => {
    const feed = published(await polledEvents());
    const search = await materializeSearchPublicationFromFeed({ feed, indexRevision: "test", corpusRevision: "test", generatedAt: NOW });
    const index = buildLexicalIndex({ indexRevision: "test", chunks: search.shards.flatMap((shard) => shard.chunks) });
    const displayIdOf = (root: string) => search.details.find((detail) => detail.groupRootRecordId === root)?.detail.displayId;
    // Exact identifier matches rank first; other entries may follow on shared terms such as "kafka".
    const hits = (query: string) => searchLexicalIndex(index, { query })
      .filter((result) => result.exactMatch)
      .map((result) => displayIdOf(result.groupRootRecordId));

    expect(hits("KAFKA-20184").sort()).toEqual(["KAFKA-20184", "KAFKA-PR-21518"]);
    expect(hits("KIP-1279")).toEqual([voteEntry(feed).displayId]);
    expect(voteEntry(feed).displayId).toMatch(/^KAFKA-MAIL-/u);
  });

  test("K11: with Pony Mail down the run publishes GitHub and Jira, keeps the mail cursor and records, and catches up later", async () => {
    const state = new MemoryState();
    const first = await run(state, githubConnector([githubPull(fixture.githubPulls[0]!)]), apacheFetch(), at(-3 * HOUR));
    expect(first.ok).toBe(true);
    const mailCursor = state.value.checkpoint?.sources["kafka:mail:dev"]?.updatedAt;
    const mailEvents = state.value.events.filter((event) => event.sourceInstanceId === "kafka:mail:dev").length;

    const down = await run(state, githubConnector([]), apacheFetch({ down: ["mail"] }), at(-2 * HOUR));
    expect(down.ok).toBe(true);
    expect(down.sources?.mail).toMatchObject({ ok: false, failureKind: "transport" });
    expect(down.sources?.jira?.ok).toBe(true);
    expect(state.value.checkpoint?.sources["kafka:mail:dev"]?.updatedAt).toBe(mailCursor);
    expect(state.value.events.filter((event) => event.sourceInstanceId === "kafka:mail:dev")).toHaveLength(mailEvents);

    const urls: string[] = [];
    const recovered = await run(state, githubConnector([]), apacheFetch({ urls }), NOW);
    expect(recovered.sources?.mail?.ok).toBe(true);
    expect(urls.find((url) => url.includes("lists.apache.org"))).toContain("d=lte=");
    expect(mailCursor).toBe("2026-09-18T16:06:37.000Z");
    expect(urls.find((url) => url.includes("lists.apache.org"))).toContain(`d=lte=${Math.ceil((Date.parse(NOW) - Date.parse(mailCursor!)) / DAY) + 1}d`);
  });

  test("K15: an event with a stored identity but different content keeps the stored one and counts a conflict", async () => {
    const state = new MemoryState();
    await run(state, githubConnector([]), apacheFetch(), at(-HOUR));
    const changed = { ...fixture.ponyStats, emails: fixture.ponyStats.emails.map((email) => ({ ...email, body: "re-obfuscated preview" })) };
    const status = await run(state, githubConnector([]), async (url) => jsonResponse(url.includes("lists.apache.org") ? changed : fixture.jiraSearch), NOW);

    expect(status.ok).toBe(true);
    expect(status.sources?.mail?.conflicts).toBe(6);
    expect(state.value.events.some((event) => (event.data as { excerpt?: string }).excerpt === "re-obfuscated preview")).toBe(false);
  });

  test("K16: an edited Jira issue replaces the previous version; Feed shows resolved", async () => {
    const events = await polledEvents();
    const resolvedSearch = {
      ...fixture.jiraSearch,
      issues: [{ ...fixture.jiraSearch.issues[0]!, fields: { ...fixture.jiraSearch.issues[0]!.fields, status: { name: "Resolved" }, updated: "2026-10-05T10:00:00.000+0000" } }],
    };
    const edited = await new JiraConnector({ fetch: apacheFetch({ jira: resolvedSearch }) }).poll(undefined, NOW);
    if (!edited.complete) throw new Error("poll failed");
    const before = published(events).index.entries.find((item) => item.displayId === "KAFKA-20184")?.status;
    const after = published([...events, ...edited.events]).index.entries.find((item) => item.displayId === "KAFKA-20184")?.status;

    expect([before, after]).toEqual(["open", "resolved"]);
  });

  test("K17: an issue under a new key is a new entity, and a comment without its issue is not published", async () => {
    const events = await polledEvents();
    const moved = {
      ...fixture.jiraSearch,
      issues: [{ ...fixture.jiraSearch.issues[1]!, key: "KAFKA-30001", fields: { ...fixture.jiraSearch.issues[1]!.fields, updated: "2026-10-06T07:00:00.000+0000" } }],
    };
    const polled = await new JiraConnector({ fetch: apacheFetch({ jira: moved }) }).poll(undefined, NOW);
    if (!polled.complete) throw new Error("poll failed");
    const withMoved = published([...events, ...polled.events]).index.entries.map((item) => item.displayId);
    expect(withMoved).toContain("KAFKA-20186");
    expect(withMoved).toContain("KAFKA-30001");

    const orphanComments = events.filter((event) => !(event.entityId === "kafka:jira:issue:KAFKA-20184"));
    const publication = published(orphanComments);
    expect(publication.index.entries.map((item) => item.displayId)).not.toContain("KAFKA-20184");
    expect(publication.details.flatMap((detail) => detail.records.map((record) => record.id)).some((id) => id.startsWith("kafka:jira:issue:KAFKA-20184:comment:"))).toBe(false);
  });

  test("K18: after 3 days the windows are 4 days and 4,330 minutes; after 40 days both cap at 30 days with gapCapped", async () => {
    for (const [gap, mailDays, jiraMinutes, capped] of [[3 * DAY, 4, 4330, false], [40 * DAY, 30, 43200, true]] as const) {
      const state = new MemoryState();
      state.value = { ...state.value, checkpoint: checkpoint({ "kafka:mail:dev": at(-gap), "kafka:jira": at(-gap) }) };
      const urls: string[] = [];
      const status = await run(state, githubConnector([]), apacheFetch({ urls }), NOW);
      expect(urls[0]).toContain(`d=lte=${mailDays}d`);
      expect(decodeURIComponent(urls[1]!.replaceAll("+", " "))).toContain(`updated >= "-${jiraMinutes}m"`);
      expect([status.sources?.mail?.gapCapped, status.sources?.jira?.gapCapped]).toEqual([capped, capped]);
    }
  });

  test("K19: a run failing after polling commits nothing, and a Jira failure on page 2 commits nothing from Jira", async () => {
    const state = new MemoryState();
    const destination = new MemoryDestination();
    destination.failOnImmutableWrite = 1;
    const failed = await run(state, githubConnector([githubPull(fixture.githubPulls[0]!)]), apacheFetch(), NOW, destination);
    expect(failed.ok).toBe(false);
    expect(state.value.events).toHaveLength(0);
    expect(state.value.checkpoint).toBeUndefined();
    destination.failOnImmutableWrite = undefined;
    expect((await run(state, githubConnector([githubPull(fixture.githubPulls[0]!)]), apacheFetch(), NOW, destination)).ok).toBe(true);

    let jiraCalls = 0;
    const page = (startAt: number) => ({ startAt, maxResults: 100, total: 150, issues: Array.from({ length: 100 }, (_, index) => ({ ...fixture.jiraSearch.issues[1]!, key: `KAFKA-${40000 + index}` })) });
    const pageTwoFails: SourceFetch = async (url) => {
      if (url.includes("lists.apache.org")) return jsonResponse(fixture.ponyStats);
      jiraCalls += 1;
      return jiraCalls === 1 ? jsonResponse(page(0)) : jsonResponse({ error: "down" }, 503);
    };
    const fresh = new MemoryState();
    const status = await run(fresh, githubConnector([]), pageTwoFails, NOW);
    expect(status.sources?.jira).toMatchObject({ ok: false, failureKind: "transport" });
    expect(fresh.value.events.some((event) => event.sourceInstanceId === "kafka:jira")).toBe(false);
    expect(fresh.value.checkpoint?.sources["kafka:jira"]).toBeUndefined();
  });

  test("K23: with GitHub down mail and Jira publish and GitHub keeps its cursor and records; all down publishes nothing", async () => {
    const state = new MemoryState();
    await run(state, githubConnector([githubPull(fixture.githubPulls[0]!)], at(-HOUR)), apacheFetch(), at(-HOUR));
    const githubEvents = state.value.events.filter((event) => event.sourceInstanceId === "kafka:github").length;
    const status = await run(state, githubConnector([], NOW, true), apacheFetch(), NOW);
    expect(status.ok).toBe(true);
    expect(status.sources?.github).toMatchObject({ ok: false, failureKind: "transport" });
    expect(state.value.checkpoint?.sources["kafka:github"]?.updatedAt).toBe(at(-HOUR));
    expect(state.value.events.filter((event) => event.sourceInstanceId === "kafka:github")).toHaveLength(githubEvents);

    const empty = new MemoryDestination();
    const allDown = await run(new MemoryState(), githubConnector([], NOW, true), apacheFetch({ down: ["mail", "jira"] }), NOW, empty);
    expect(allDown.ok).toBe(false);
    expect(empty.objects.size).toBe(0);
  });

  test("K32: after a run that failed while publishing, a failed source still reports its cursor and last success", async () => {
    const state = new MemoryState();
    await run(state, githubConnector([]), apacheFetch(), at(-2 * HOUR));
    const mailCursor = state.value.checkpoint?.sources["kafka:mail:dev"]?.updatedAt;
    const broken = new MemoryDestination();
    broken.failOnImmutableWrite = 1;
    expect((await run(state, githubConnector([]), apacheFetch(), at(-HOUR), broken)).ok).toBe(false);
    const status = await run(state, githubConnector([]), apacheFetch({ down: ["mail"] }), NOW);
    const body = healthBody({ environment: "development", running: false, scheduled: false, phase: undefined, status });

    expect(mailCursor).toBeDefined();
    expect(body.sources?.mail).toMatchObject({ ok: false, cursor: mailCursor, lastSuccessAt: at(-2 * HOUR) });
    expect(body.sources?.jira).toMatchObject({ ok: true, lastSuccessAt: NOW });
  });

  test("K32: a failed source reports its stored cursor even when the last status has no per-source fields", async () => {
    const state = new MemoryState();
    state.value = { ...state.value, checkpoint: checkpoint({ "kafka:mail:dev": at(-DAY) }) };
    const status = await run(state, githubConnector([]), apacheFetch({ down: ["mail"] }), NOW);
    expect(status.sources?.mail).toMatchObject({ ok: false, cursor: at(-DAY), lastSuccessAt: null });
    expect(status.sources?.jira?.ok).toBe(true);
  });

  test("K32: /health lists each source; a failed mail source keeps its previous lastSuccessAt while the run is ok", async () => {
    const state = new MemoryState();
    await run(state, githubConnector([]), apacheFetch(), at(-HOUR));
    const status = await run(state, githubConnector([]), apacheFetch({ down: ["mail"] }), NOW);
    const body = healthBody({ environment: "development", running: false, scheduled: false, phase: undefined, status });

    expect(body.lastRun?.ok).toBe(true);
    expect(body.sources?.github).toMatchObject({ ok: true, lastSuccessAt: NOW });
    expect(body.sources?.jira).toMatchObject({ ok: true, lastSuccessAt: NOW });
    expect(body.sources?.mail).toMatchObject({ ok: false, lastSuccessAt: at(-HOUR), failureKind: "transport" });
  });
});

function checkpoint(sources: Record<string, string>): GitHubCheckpointV1 {
  return {
    schema: "osskb.github-checkpoint.v1",
    connectorRevision: "github@1",
    sources: Object.fromEntries(Object.entries(sources).map(([key, updatedAt]) => [key, { updatedAt }])),
  };
}

async function run(
  state: MemoryState,
  connector: ReturnType<typeof githubConnector>,
  fetch: SourceFetch,
  materializedAt: string,
  destination = new MemoryDestination(),
): Promise<PipelineRunStatus> {
  return runDataPublication({ environment: "development", materializedAt, connector, sources: kafkaSources(fetch), state, destination });
}

class MemoryState implements PipelineStateRepository {
  value: SerializedReferenceStateV1 = { schema: "osskb.reference-state.v1", events: [] };
  last: PipelineRunStatus | undefined;

  async read(): Promise<SerializedReferenceStateV1> { return this.value; }
  async readStatus(): Promise<PipelineRunStatus | undefined> { return this.last; }
  async commit(state: SerializedReferenceStateV1): Promise<void> { this.value = state; }
  async recordStatus(status: PipelineRunStatus): Promise<void> { this.last = status; }
  async recordPhase(): Promise<void> {}
}

class MemoryDestination implements PublicationDestination, PublicationObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  failOnImmutableWrite: number | undefined;
  private writes = 0;

  async get(key: string): Promise<Uint8Array | undefined> { return this.objects.get(key); }
  async putImmutableIfAbsent(key: string, body: Uint8Array): Promise<"created" | "exists"> {
    this.writes += 1;
    if (this.writes === this.failOnImmutableWrite) throw new Error(`injected R2 failure at ${key}`);
    if (this.objects.has(key)) return "exists";
    this.objects.set(key, body);
    return "created";
  }
  async putCurrent(key: string, body: Uint8Array): Promise<void> { this.objects.set(key, body); }
  async putEvidence(key: string, body: Uint8Array): Promise<void> { this.objects.set(key, body); }
}
