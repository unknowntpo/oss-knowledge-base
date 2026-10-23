/**
 * Step 4 of B26: one evidence bundle per job (B29). Items carry ids `E1…En`, are redacted, capped at
 * 24 KB in total (head and tail kept) and enter the prompt inside `<tool-output trust="untrusted">`.
 */
import { CI_JOB, COST_GUARD_JOB } from "./firings";
import { allowedAnswers, parseCauses, type PlaybookLibrary } from "./playbook";
import type { CiRelease, Env, Firing, Health, QuerySignals, SqlArgs } from "./types";

export const BUNDLE_MAX_BYTES = 24 * 1024;

export interface EvidenceItem {
  readonly id: string;
  readonly source: "health" | "sql" | "ci" | "playbook" | "runbook";
  readonly label: string;
  readonly text: string;
}

export interface Bundle {
  readonly job: string;
  readonly items: EvidenceItem[];
  /** Firing rules without a playbook (B35): only `cause: "unknown"` can pass for them. */
  readonly playbookMissing: string[];
  readonly causes: Set<string>;
  readonly runbooks: Set<string>;
  /** Appends a tool result as the next item (redacted, capped) and returns it. */
  add(source: EvidenceItem["source"], label: string, text: string): EvidenceItem;
  render(item: EvidenceItem): string;
}

type Fields = readonly (string | readonly [string, Fields])[];

/**
 * The jobs a firing can name: Spec 028's `SIGNAL_JOBS` ids (`embedding`, not the route name
 * `search-embedding`), plus `review-queue` from Spec 027 A2. A Worker test checks every Spec 028 job
 * is listed, so a renamed job cannot leave its firings without a bundle.
 */
export const SRE_JOBS = ["publication", "digest", "review-queue", "embedding", "identity-links", "kip-pages", "retention", "cost-guard"] as const;
export type SreJob = (typeof SRE_JOBS)[number];

/** Spec 027 A2: the `/health` fields each job's bundle holds, and nothing else. */
export const JOB_HEALTH_FIELDS: Readonly<Record<SreJob, Fields>> = {
  publication: ["running", "scheduled", "followUp", "phase", ["lastRun", ["ok", "runId", "completedAt", "copiedObjectCount", "reusedObjectCount", "r2", "pollTruncated"]], "sources"],
  digest: [["digest", [["lastRun", ["ok", "runId", "completedAt", "durationMs", "rejections"]]]]],
  "review-queue": ["reviewQueue"],
  embedding: [["searchEmbedding", ["lastRun", "lastError", "today"]]],
  "identity-links": [["identityLinks", [["lastRun", ["ok", "status", "at", "durationMs", "r2"]], "lastGoodAt"]]],
  "kip-pages": [["kipPages", [["lastRun", ["ok", "status", "at", "durationMs", "requests", "jiraRequests", "r2", "error"]], "lastGoodAt"]]],
  retention: [["retention", ["mode", "status", "reason", ["lastRun", ["runId", "deleted", "remaining", "elapsedMs", "r2", "failureKind"]]]]],
  // costGuard is in every bundle already; `budget` arrives with Spec 026 CG27.
  [COST_GUARD_JOB]: ["budget"],
};

function pick(value: unknown, fields: Fields): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const [name, nested] = typeof field === "string" ? [field, undefined] : field;
    const child = (value as Record<string, unknown>)[name];
    if (child === undefined) continue;
    result[name] = nested === undefined ? child : (pick(child, nested) ?? child);
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

/** Exact-value redaction of every secret, then `Bearer <token>` (B29). */
export function redact(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) if (secret.length > 0) result = result.split(secret).join("[redacted]");
  return result.replace(/Bearer\s+\S+/giu, "Bearer [redacted]");
}

const bytes = (text: string) => new TextEncoder().encode(text).length;

function cut(text: string, keep: number): string {
  // Cut on characters while counting bytes, so a multi-byte character is never split.
  const chars = [...text];
  let head = "";
  let tail = "";
  let budget = Math.max(0, keep);
  for (let i = 0, j = chars.length - 1; budget > 0 && i <= j; i += 1, j -= 1) {
    const left = bytes(chars[i]!);
    if (left > budget) break;
    head += chars[i];
    budget -= left;
    if (i === j) break;
    const right = bytes(chars[j]!);
    if (right > budget) break;
    tail = chars[j] + tail;
    budget -= right;
  }
  const dropped = bytes(text) - bytes(head) - bytes(tail);
  return `${head}\n…[truncated ${dropped} bytes]…\n${tail}`;
}

/** At most `maxBytes` of item text in total: the largest item keeps its head and tail, with a marker. */
export function capItems(items: readonly EvidenceItem[], maxBytes = BUNDLE_MAX_BYTES): EvidenceItem[] {
  const result = [...items];
  let total = result.reduce((sum, item) => sum + bytes(item.text), 0);
  while (total > maxBytes) {
    const index = result.reduce((best, item, i) => (bytes(item.text) > bytes(result[best]!.text) ? i : best), 0);
    const item = result[index]!;
    const over = total - maxBytes;
    const marker = bytes(`\n…[truncated ${bytes(item.text)} bytes]…\n`);
    const shortened = cut(item.text, bytes(item.text) - over - marker);
    if (bytes(shortened) >= bytes(item.text)) break;
    result[index] = { ...item, text: shortened };
    total = result.reduce((sum, value) => sum + bytes(value.text), 0);
  }
  return result;
}

const escapeDelimiter = (text: string) => text.replace(/<(\/?)tool-output/giu, "<$1tool-output-quoted");
const attribute = (text: string) => text.replace(/["<>&]/gu, "_");

export function renderItem(item: EvidenceItem): string {
  return `<tool-output trust="untrusted" id="${item.id}" source="${item.source}" label="${attribute(item.label)}">\n${escapeDelimiter(item.text)}\n</tool-output>`;
}

export interface BundleInput {
  readonly env: Env;
  readonly job: string;
  readonly firings: readonly Firing[];
  readonly health: Health;
  readonly querySignals: QuerySignals;
  readonly ci: CiRelease;
  readonly library: PlaybookLibrary;
  readonly secrets: readonly string[];
  readonly logTail?: string;
}

const json = (value: unknown) => JSON.stringify(value ?? null, null, 2);

export async function buildBundle(input: BundleInput): Promise<Bundle> {
  const raw: Omit<EvidenceItem, "id">[] = [];
  for (const firing of input.firings) {
    raw.push({ source: firing.job === CI_JOB ? "ci" : "health", label: `signals.rules[${firing.ruleId}]`, text: json(firing.entry) });
  }
  if (input.job !== CI_JOB || input.health.costGuard !== undefined) raw.push({ source: "health", label: "costGuard", text: json(input.health.costGuard) });
  const fields = (JOB_HEALTH_FIELDS as Readonly<Record<string, Fields>>)[input.job];
  const picked = fields === undefined ? undefined : pick(input.health, fields);
  if (picked !== undefined) raw.push({ source: "health", label: `${input.job} /health fields`, text: json(picked) });
  if (input.job === CI_JOB) {
    const lines = [`run: ${input.ci.run?.htmlUrl ?? "unknown"}`, `conclusion: ${input.ci.run?.conclusion ?? "unknown"}`, `failed job: ${input.ci.failedJob ?? "unknown"}`];
    raw.push({ source: "ci", label: "failed job", text: [...lines, ...(input.logTail === undefined ? [] : ["last 60 log lines:", input.logTail])].join("\n") });
  } else {
    for (const args of sqlFor(input)) {
      const result = await input.querySignals(args).then(json, (error: unknown) => `unavailable: ${error instanceof Error ? error.message : String(error)}`);
      raw.push({ source: "sql", label: args.template, text: result });
    }
  }
  const ruleIds = [...new Set(input.firings.map((firing) => firing.ruleId))];
  const allowed = allowedAnswers(input.library, ruleIds);
  const cited: string[] = [];
  for (const ruleId of ruleIds) {
    const text = input.library.playbooks[ruleId];
    if (text === undefined) continue;
    raw.push({ source: "playbook", label: ruleId, text });
    for (const anchor of parseCauses(text).flatMap((cause) => cause.anchors)) if (!cited.includes(anchor)) cited.push(anchor);
  }
  for (const anchor of cited) {
    const text = input.library.runbooks[anchor];
    if (text !== undefined) raw.push({ source: "runbook", label: anchor, text });
  }
  const items = capItems(raw.map((item, index) => ({ ...item, id: `E${index + 1}`, text: redact(item.text, input.secrets) })));
  const bundle: Bundle = {
    job: input.job,
    items,
    playbookMissing: allowed.missing,
    causes: allowed.causes,
    runbooks: allowed.runbooks,
    add(source, label, text) {
      const item = { id: `E${items.length + 1}`, source, label, text: capItems([{ id: "", source, label, text: redact(text, input.secrets) }], TOOL_OUTPUT_MAX_BYTES)[0]!.text };
      items.push(item);
      return item;
    },
    render: renderItem,
  };
  return bundle;
}

/** B30: each tool result is capped at 16 KB. */
export const TOOL_OUTPUT_MAX_BYTES = 16 * 1024;

/** The harness's own queries (B29): Q-run, Q-history, and Q-window for the cost guard and `job.failures`. */
function sqlFor(input: BundleInput): SqlArgs[] {
  const runId = input.firings.find((firing) => firing.runId !== null)?.runId ?? null;
  const at = input.firings[0]?.since;
  const queries: SqlArgs[] = [];
  if (runId !== null) queries.push({ template: "Q-run", env: input.env, runId });
  queries.push({ template: "Q-history", env: input.env, job: input.job });
  if (at !== undefined && (input.job === COST_GUARD_JOB || input.firings.some((firing) => firing.ruleId === "job.failures"))) {
    queries.push({ template: "Q-window", env: input.env, at });
  }
  return queries;
}
