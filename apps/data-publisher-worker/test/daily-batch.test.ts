/**
 * Spec 018 T10–T12: a day's updates go through the real connectors and the publication in one
 * run, and a backlog larger than the per-run caps is read by follow-up runs minutes apart.
 * Volumes are the ones measured on 2026-10-13 (Spec 018 Evidence).
 */
import { describe, expect, test } from "bun:test";
import { GitHubConnector, type GitHubIssue, type GitHubJsonTransport } from "@oss-knowledge-base/github-publisher/github-connector";
import {
  JiraConnector,
  PonyMailConnector,
  type SerializedReferenceStateV1,
  type SourceFetch,
} from "@oss-knowledge-base/reference-pipeline";
import type { PublicationObjectStore } from "@oss-knowledge-base/serving-contract";

import { runDataPublication, type PipelineRunStatus, type PipelineStateRepository, type PublicationDestination } from "../src/pipeline";
import { CATCH_UP_DELAY_MS, FOLLOW_UP_KEY, scheduleFollowUp, type FollowUpMarker } from "../src/run-schedule";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const START = Date.parse("2026-10-12T22:07:00.000Z");
const iso = (time: number) => new Date(time).toISOString();
/** The caps the deployed Worker runs with (`MAX_ISSUES_PER_SOURCE` in src/index.ts, `JiraConnector` default). */
const CAP = 200;

interface Upstream {
  readonly github: Record<"kafka" | "datafusion", GitHubIssue[]>;
  readonly jira: { readonly key: string; readonly updated: string }[];
}

/** `count` updates spread evenly over (`from`, `to`], each with its own second. */
function times(count: number, from: number, to: number): string[] {
  return Array.from({ length: count }, (_, n) => iso(from + Math.floor(((n + 1) * (to - from)) / count / 1_000) * 1_000));
}

let serial = 0;
function addUpdates(upstream: Upstream, counts: { readonly kafka: number; readonly datafusion: number; readonly jira: number }, from: number, to: number): void {
  for (const repo of ["kafka", "datafusion"] as const) {
    for (const updatedAt of times(counts[repo], from, to)) {
      const number = (serial += 1);
      upstream.github[repo].push({
        id: number, number, title: `Issue ${number}`, html_url: `https://github.com/apache/${repo}/issues/${number}`,
        comments_url: `https://api.github.com/repos/apache/${repo}/issues/${number}/comments`, body_text: `Body of ${number}`,
        state: "open", created_at: updatedAt, updated_at: updatedAt, comments: 0, user: { login: "someone" },
        author_association: "CONTRIBUTOR", labels: [],
      });
    }
  }
  for (const updated of times(counts.jira, from, to)) upstream.jira.push({ key: `KAFKA-${(serial += 1)}`, updated });
}

function githubTransport(upstream: Upstream, requests: string[]): GitHubJsonTransport {
  return {
    async getJson<T>(url: string): Promise<T> {
      requests.push(url);
      const parsed = new URL(url);
      const repo = /repos\/apache\/(kafka|datafusion)\/issues$/u.exec(parsed.pathname)?.[1] as "kafka" | "datafusion" | undefined;
      if (repo === undefined) throw new Error(`unexpected GitHub request ${url}`);
      const since = parsed.searchParams.get("since")!;
      const perPage = Number(parsed.searchParams.get("per_page"));
      const page = Number(parsed.searchParams.get("page"));
      const matching = upstream.github[repo].filter((issue) => issue.updated_at >= since).sort((left, right) => left.updated_at.localeCompare(right.updated_at));
      return matching.slice((page - 1) * perPage, page * perPage) as T;
    },
  };
}

function apacheFetch(upstream: Upstream, clock: { now: number }, requests: string[]): SourceFetch {
  return async (url) => {
    requests.push(url);
    const body = (() => {
      if (url.includes("lists.apache.org")) return { emails: [], hits: 0 };
      const params = new URL(url).searchParams;
      const minutes = Number(/updated >= "-(\d+)m"/u.exec(params.get("jql")!)![1]);
      const since = iso(clock.now - minutes * MINUTE);
      const matching = upstream.jira.filter((issue) => issue.updated >= since).sort((left, right) => left.updated.localeCompare(right.updated));
      const startAt = Number(params.get("startAt"));
      return {
        startAt, maxResults: 100, total: matching.length,
        issues: matching.slice(startAt, startAt + 100).map((issue) => ({
          key: issue.key,
          fields: { summary: `Summary of ${issue.key}`, description: "", status: { name: "Open" }, updated: issue.updated, created: issue.updated, reporter: null, comment: { total: 0, comments: [] } },
        })),
      };
    })();
    return { status: 200, headers: new Headers(), text: async () => JSON.stringify(body) };
  };
}

class MemoryState implements PipelineStateRepository {
  value: SerializedReferenceStateV1 = { schema: "osskb.reference-state.v1", events: [] };
  status: PipelineRunStatus | undefined;
  async read(): Promise<SerializedReferenceStateV1> { return this.value; }
  async readStatus(): Promise<PipelineRunStatus | undefined> { return this.status; }
  async commit(state: SerializedReferenceStateV1): Promise<void> { this.value = state; }
  async recordStatus(status: PipelineRunStatus): Promise<void> { this.status = status; }
  async recordPhase(): Promise<void> {}
}

class MemoryDestination implements PublicationDestination, PublicationObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  async get(key: string): Promise<Uint8Array | undefined> { return this.objects.get(key); }
  async putImmutableIfAbsent(key: string, body: Uint8Array): Promise<"created" | "exists"> {
    if (this.objects.has(key)) return "exists";
    this.objects.set(key, body);
    return "created";
  }
  async putCurrent(key: string, body: Uint8Array): Promise<void> { this.objects.set(key, body); }
  async putEvidence(key: string, body: Uint8Array): Promise<void> { this.objects.set(key, body); }
}

class AlarmStorage {
  readonly values = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
  async delete(key: string): Promise<boolean> { return this.values.delete(key); }
  async setAlarm(time: number): Promise<void> { this.alarm = time; }
}

function world() {
  const upstream: Upstream = { github: { kafka: [], datafusion: [] }, jira: [] };
  const clock = { now: START };
  const requests: string[] = [];
  const state = new MemoryState();
  const destination = new MemoryDestination();
  const storage = new AlarmStorage();
  const fetch = apacheFetch(upstream, clock, requests);
  /** One alarm of the `PipelineState` object: the publication, then the follow-up rule. */
  const alarm = async (): Promise<{ readonly status: Extract<PipelineRunStatus, { ok: true }>; readonly followUp: FollowUpMarker | undefined; readonly requests: number }> => {
    const before = requests.length;
    storage.alarm = null;
    const status = await runDataPublication({
      environment: "development",
      materializedAt: iso(clock.now),
      connector: new GitHubConnector({ transport: githubTransport(upstream, requests), maxIssuesPerSource: CAP }),
      sources: [
        { key: "mail", connector: new PonyMailConnector({ fetch, sleep: async () => undefined }) },
        { key: "jira", connector: new JiraConnector({ fetch, sleep: async () => undefined }) },
      ],
      state,
      destination,
    });
    if (!status.ok) throw new Error(`publication failed: ${status.error}`);
    return { status, followUp: await scheduleFollowUp(storage, status, clock.now), requests: requests.length - before };
  };
  /** A Cron tick at `at`, then every follow-up the object schedules for itself. */
  const tick = async (at: number) => {
    clock.now = at;
    storage.values.delete(FOLLOW_UP_KEY);
    const runs = [await alarm()];
    while (storage.alarm !== null) {
      clock.now = storage.alarm;
      runs.push(await alarm());
    }
    return runs;
  };
  const stored = (sourceInstanceId: string) => new Set(state.value.events.filter((event) => event.sourceInstanceId === sourceInstanceId && event.entityType === "artifact").map((event) => event.entityId)).size;
  return { upstream, clock, state, storage, tick, stored };
}

describe("Spec 018 a day's batch against the per-run caps", () => {
  test("T10: the day measured on 2026-10-13 (63 + 95 GitHub issues, 47 Jira issues) is read whole by one run, with no follow-up", async () => {
    const w = world();
    await w.tick(START);
    addUpdates(w.upstream, { kafka: 63, datafusion: 95, jira: 47 }, START, START + DAY);
    const runs = await w.tick(START + DAY);

    expect(runs).toHaveLength(1);
    const [{ status, followUp, requests }] = runs as [typeof runs[number]];
    expect(status.pollTruncated).toBe(false);
    expect(status.sources?.github).toMatchObject({ ok: true, read: 63 + 95 });
    expect(status.sources?.jira).toMatchObject({ ok: true, read: 47, gapCapped: false });
    expect(followUp).toBeUndefined();
    expect(w.storage.alarm).toBeNull();
    expect([w.stored("kafka:github"), w.stored("datafusion:github"), w.stored("kafka:jira")]).toEqual([63, 95, 47]);
    // One issues page per repository, one Pony Mail request, one Jira page: far below 20,000 subrequests.
    expect(requests).toBe(4);
  });

  test("T11: five missed days (315 + 475 GitHub issues, 235 Jira issues) are caught up by two follow-up runs five minutes apart", async () => {
    const w = world();
    await w.tick(START);
    addUpdates(w.upstream, { kafka: 315, datafusion: 475, jira: 235 }, START, START + 5 * DAY);
    const at = START + 5 * DAY;
    const runs = await w.tick(at);

    expect(runs.map((run) => run.status.completedAt)).toEqual([iso(at), iso(at + CATCH_UP_DELAY_MS), iso(at + 2 * CATCH_UP_DELAY_MS)]);
    expect(runs.map((run) => run.status.pollTruncated)).toEqual([true, true, false]);
    expect(runs.map((run) => run.followUp?.reason ?? "none")).toEqual(["catch-up", "catch-up", "none"]);
    expect(runs.map((run) => run.followUp?.catchUps ?? 0)).toEqual([1, 2, 0]);
    // No run reads more than the cap from one repository or from Jira.
    expect(runs[0]!.status.sources?.github?.read).toBe(2 * CAP);
    expect(runs[0]!.status.sources?.jira?.read).toBe(CAP);
    for (const run of runs) {
      expect(run.status.sources!.github!.read).toBeLessThanOrEqual(2 * CAP);
      expect(run.status.sources!.jira!.read).toBeLessThanOrEqual(CAP);
    }
    // Everything upstream is stored, the cursors are at the newest update, and nothing is left scheduled.
    expect([w.stored("kafka:github"), w.stored("datafusion:github"), w.stored("kafka:jira")]).toEqual([315, 475, 235]);
    expect(runs.at(-1)!.status.sources?.github?.cursor).toBe(iso(at).replace(".000Z", "Z"));
    expect(w.storage.alarm).toBeNull();
    expect(w.storage.values.has(FOLLOW_UP_KEY)).toBe(false);
  });

  test("T12: a backlog past five catch-up runs stops there and the next tick continues from the cursor, losing nothing", async () => {
    const w = world();
    await w.tick(START);
    // 1,500 issues in one repository: seven full reads of 200 and a rest.
    addUpdates(w.upstream, { kafka: 0, datafusion: 1_500, jira: 0 }, START, START + 7 * DAY);
    const first = await w.tick(START + 7 * DAY);
    expect(first).toHaveLength(6);
    expect(first.at(-1)!.status.pollTruncated).toBe(true);
    expect(first.at(-1)!.followUp).toBeUndefined();
    expect(w.stored("datafusion:github")).toBeLessThan(1_500);
    expect(w.stored("datafusion:github")).toBeGreaterThanOrEqual(6 * (CAP - 1));

    const second = await w.tick(START + 8 * DAY);
    expect(second.at(-1)!.status.pollTruncated).toBe(false);
    expect(w.stored("datafusion:github")).toBe(1_500);
  });
});
