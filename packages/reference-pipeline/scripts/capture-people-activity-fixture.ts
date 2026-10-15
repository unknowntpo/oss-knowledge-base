/**
 * Spec 019 slice 2b, W1: records the metadata of every Dev Kafka thread in which one of the
 * Example identities wrote, from anonymous GETs of `/api/feed` and `/api/detail/:id`, plus the
 * creation time of the pull requests those identities authored (GitHub REST, read with `gh api`,
 * because the release carries only the last-update time of a root record).
 *
 *   bun packages/reference-pipeline/scripts/capture-people-activity-fixture.ts [--out <file>]
 *
 * Only metadata is kept: no excerpt, no summary, no address. Records by other people are kept
 * only when they are a thread's root (its author is the thread author).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const PAGES = "https://oss-knowledge-base-dev.pages.dev";
export const FIXTURE_IDENTITIES = ["chia7712", "Chia-Ping Tsai", "m1a2st", "Andrew Schofield", "AndrewJSchofield"] as const;

const { values } = parseArgs({
  options: { out: { type: "string", default: join(import.meta.dir, "../test/fixtures/people-activity/kafka-dev.json") } },
});

interface FeedEntry {
  readonly displayId: string;
  readonly projectKey: string;
  readonly authors: readonly string[];
  readonly tags: readonly string[];
  readonly links: Readonly<Record<string, string>>;
  readonly entry: { readonly id: string; readonly title: string };
}
interface DetailRecord {
  readonly id: string;
  readonly source: string;
  readonly kind: string;
  readonly title?: string;
  readonly author: string;
  readonly occurredAt: string;
  readonly canonicalUrl: string;
  readonly artifactStatus?: string;
}

const get = async <T>(path: string): Promise<T> => {
  const response = await fetch(`${PAGES}${path}`, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json() as Promise<T>;
};

const feed = await get<{ readonly generatedAt: string; readonly entries: readonly FeedEntry[] }>("/api/feed");
const wanted = new Set<string>(FIXTURE_IDENTITIES);
const entries = feed.entries.filter((entry) => entry.projectKey === "kafka" && entry.authors.some((author) => wanted.has(author)));
const threads = [];
for (const entry of entries) {
  const detail = await get<{ readonly records: readonly DetailRecord[] }>(`/api/detail/${encodeURIComponent(entry.entry.id)}`);
  const source = Object.keys(entry.links)[0]!;
  const root = detail.records.find((record) => record.title !== undefined) ?? detail.records[0]!;
  const records = detail.records.filter((record) => record === root || wanted.has(record.author)).map((record) => ({
    id: record.id,
    kind: record.kind,
    author: record.author,
    occurredAt: record.occurredAt,
    url: record.canonicalUrl,
    ...(record.artifactStatus === undefined ? {} : { status: record.artifactStatus }),
  }));
  threads.push({
    displayId: entry.displayId,
    source,
    title: entry.entry.title,
    // The feed's tags are the kind label followed by the GitHub labels (materializer).
    labels: source === "github" ? entry.tags.slice(1) : [],
    rootId: root.id,
    records,
  });
}

// Creation time of each pull request or issue an Example identity authored (W3: authored counts by creation).
const createdAt: Record<string, string> = {};
for (const thread of threads) {
  const root = thread.records.find((record) => record.id === thread.rootId)!;
  if (thread.source !== "github" || !wanted.has(root.author)) continue;
  const number = Number(thread.displayId.split("-").at(-1));
  const child = Bun.spawnSync(["gh", "api", `repos/apache/kafka/issues/${number}`, "--jq", ".created_at"]);
  if (child.exitCode !== 0) throw new Error(`gh api failed for #${number}: ${child.stderr}`);
  createdAt[thread.rootId] = child.stdout.toString().trim();
}

writeFileSync(values.out, `${JSON.stringify({
  capturedAt: new Date().toISOString(),
  release: feed.generatedAt,
  source: `${PAGES} /api/feed and /api/detail (anonymous GETs); createdAt from GitHub REST`,
  identities: FIXTURE_IDENTITIES,
  createdAt,
  threads,
}, null, 1)}\n`);
console.log(`${threads.length} threads, ${threads.reduce((sum, thread) => sum + thread.records.length, 0)} records, ${Object.keys(createdAt).length} creation times → ${values.out}`);
