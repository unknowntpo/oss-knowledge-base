import { createHash } from "node:crypto";

import type { DomainEventV1 } from "@oss-knowledge-base/domain";

/**
 * Deterministic GitHub-shaped events with the measured shape of the development dataset
 * (35 days, 8,627 events): about 28% issue/PR roots and 72% comments, mostly DataFusion,
 * excerpts cut at 360 characters with "…" so most text is stored as two-byte strings.
 */
export interface SeededGitHubEventsOptions {
  readonly count: number;
  readonly seed: number;
  /** End of the 35-day window; every timestamp falls inside it. */
  readonly materializedAt: string;
}

const WINDOW_MS = 35 * 86_400_000;
const ROOT_SHARE = 0.2755;
const PROJECTS = {
  kafka: {
    projectId: "apache-kafka",
    sourceInstanceId: "kafka:github",
    repo: "apache/kafka",
    profileVersion: "apache-kafka@github-live-1",
    firstNumber: 21_000,
  },
  datafusion: {
    projectId: "apache-datafusion",
    sourceInstanceId: "datafusion:github",
    repo: "apache/datafusion",
    profileVersion: "apache-datafusion@github-live-1",
    firstNumber: 16_000,
  },
} as const;
type ProjectKey = keyof typeof PROJECTS;

const WORDS = [
  "consumer", "producer", "broker", "partition", "offset", "rebalance", "coordinator", "fetch",
  "transaction", "idempotent", "replica", "leader", "follower", "metadata", "controller", "quorum",
  "raft", "snapshot", "segment", "compaction", "retention", "timeout", "latency", "throughput",
  "planner", "optimizer", "physical", "logical", "expression", "aggregate", "window", "join",
  "parquet", "arrow", "schema", "projection", "pushdown", "predicate", "statistics", "batch",
  "stream", "memory", "spill", "sort", "hash", "repartition", "datafusion", "kafka", "test",
  "regression", "benchmark", "refactor", "deprecate", "config", "default", "error", "panic",
  "null", "decimal", "timestamp", "timezone", "cast", "coercion", "UDF", "SQL", "query", "plan",
  "the", "a", "this", "that", "we", "should", "could", "would", "because", "when", "after",
  "before", "with", "without", "for", "in", "on", "of", "to", "is", "not", "it", "PR", "issue",
  "LGTM", "thanks", "I", "think", "maybe", "also", "but", "already", "still", "now", "fixed",
];
const TWO_BYTE = ["…", "’", "—", "→", "≥", "測試", "修正", "é"];
const LABELS = [
  "ci-approved", "small", "tools", "core", "clients", "streams", "connect", "KIP",
  "sql", "physical-expr", "optimizer", "datasource", "functions", "documentation", "enhancement", "bug",
];
const ROLES = ["Contributor", "Member", "Collaborator", "None", "Owner"];
const BOTS = ["github-actions[bot]", "codecov[bot]", "dependabot[bot]"];

interface Root {
  readonly project: ProjectKey;
  readonly kind: "issue" | "pull-request";
  readonly number: number;
  readonly entityId: string;
  readonly url: string;
  readonly createdAt: number;
}

export function generateSeededGitHubEvents(options: SeededGitHubEventsOptions): DomainEventV1[] {
  const random = mulberry32(options.seed);
  const end = Date.parse(options.materializedAt);
  if (Number.isNaN(end)) throw new Error("materializedAt must be a timestamp");
  const start = end - WINDOW_MS;
  const observedAt = new Date(end).toISOString();
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
  const between = (from: number, to: number) => from + Math.floor(random() * Math.max(1, to - from));
  const words = (minimum: number) => {
    const parts: string[] = [];
    let length = 0;
    while (length < minimum) {
      const word = random() < 0.012 ? pick(TWO_BYTE) : pick(WORDS);
      parts.push(word);
      length += word.length + 1;
    }
    return parts.join(" ");
  };
  // 62% of real excerpts hit the 360-character cut; the rest are short replies.
  const excerpt = () => random() < 0.62
    ? `${words(400).slice(0, 359)}…`
    : words(between(12, 300)).slice(0, 359);
  let sequence = 0;
  const eventId = () => {
    sequence += 1;
    return `sha256:${hash(`seeded-github-event:${options.seed}:${sequence}`)}`;
  };
  const base = (project: ProjectKey, entityId: string, url: string, timestamp: number) => {
    const profile = PROJECTS[project];
    const time = githubTime(timestamp);
    return {
      schemaVersion: 1,
      id: eventId(),
      projectId: profile.projectId,
      sourceType: "code-host",
      sourceInstanceId: profile.sourceInstanceId,
      entityId,
      eventType: "updated",
      sourceCursor: time,
      sourceTimestamp: time,
      observedAt,
      canonicalUrl: url,
      payloadRef: `content-addressed://sha256/${hash(`${entityId}:${time}`)}`,
      sourceConnectorVersion: "github@1",
      communityProfileVersion: profile.profileVersion,
    } as const;
  };

  const rootCount = Math.max(1, Math.round(options.count * ROOT_SHARE));
  const commentCount = Math.max(0, options.count - rootCount);
  const roots: Record<ProjectKey, Root[]> = { kafka: [], datafusion: [] };
  const nextNumber: Record<ProjectKey, number> = {
    kafka: PROJECTS.kafka.firstNumber,
    datafusion: PROJECTS.datafusion.firstNumber,
  };
  const events: DomainEventV1[] = [];

  for (let index = 0; index < rootCount; index += 1) {
    const draw = random();
    const project: ProjectKey = draw < 0.28 ? "kafka" : "datafusion";
    const kind = project === "kafka" || draw < 0.733 ? "pull-request" : "issue";
    const number = nextNumber[project]++;
    const segment = kind === "issue" ? "issue" : "pull";
    const entityId = `${PROJECTS[project].sourceInstanceId}:${segment}:${number}`;
    const url = `https://github.com/${PROJECTS[project].repo}/${kind === "issue" ? "issues" : "pull"}/${number}`;
    const createdAt = between(start, end - 3_600_000);
    const updatedAt = between(createdAt, end);
    const bot = kind === "pull-request" && random() < 0.08;
    const state = random() < 0.45 ? "open" : "closed";
    const merged = kind === "pull-request" && state === "closed" && random() < 0.85;
    const labelCount = Math.floor(random() * 5);
    const labels = [...new Set(Array.from({ length: labelCount }, () => pick(LABELS)))];
    roots[project].push({ project, kind, number, entityId, url, createdAt });
    events.push({
      ...base(project, entityId, url, updatedAt),
      entityType: "artifact",
      data: {
        contract: "github-record@1",
        recordKind: kind,
        externalNumber: number,
        title: words(between(30, 100)).slice(0, 120),
        excerpt: excerpt(),
        author: bot ? "dependabot[bot]" : `contributor-${between(1, 400)}`,
        authorRole: pick(ROLES),
        occurredAt: githubTime(updatedAt),
        createdAt: githubTime(createdAt),
        updatedAt: githubTime(updatedAt),
        nativeState: state,
        ...(merged ? { mergedAt: githubTime(updatedAt) } : {}),
        labels,
        isBot: bot,
      },
    } as DomainEventV1);
  }

  for (let index = 0; index < commentCount; index += 1) {
    const preferred: ProjectKey = random() < 0.138 ? "kafka" : "datafusion";
    const project = roots[preferred].length > 0 ? preferred : (preferred === "kafka" ? "datafusion" : "kafka");
    const candidates = roots[project];
    // Skewed toward a few busy threads, as on GitHub.
    const root = candidates[Math.min(candidates.length - 1, Math.floor(candidates.length * random() ** 2.5))]!;
    const commentId = 5_000_000_000 + index;
    const entityId = `${root.entityId}:comment:${commentId}`;
    const occurredAt = between(root.createdAt, end);
    const bot = random() < 0.3;
    events.push({
      ...base(project, entityId, `${root.url}#issuecomment-${commentId}`, occurredAt),
      entityType: "message",
      data: {
        contract: "github-record@1",
        recordKind: "comment",
        externalNumber: root.number,
        parentEntityId: root.entityId,
        title: `Comment on #${root.number}`,
        excerpt: excerpt(),
        author: bot ? pick(BOTS) : `contributor-${between(1, 400)}`,
        authorRole: pick(ROLES),
        occurredAt: githubTime(occurredAt),
        createdAt: githubTime(occurredAt),
        updatedAt: githubTime(occurredAt),
        labels: [],
        isBot: bot,
      },
    } as DomainEventV1);
  }
  return events;
}

function githubTime(milliseconds: number): string {
  return new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/u, "Z");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
