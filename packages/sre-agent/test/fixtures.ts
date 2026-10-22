/**
 * Shared fakes for the L1 and L2 tests: an in-memory store that records every call, a GitHub fake
 * that records every request, `/health` built from Dev's real values of 2026-10-22 (Spec 027
 * Example (1)), and scripted `MockLanguageModelV4` responses. No network, no model.
 */
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { DiagnosisOutput, Health, RawStore, RuleEntry, SqlArgs } from "../src";

export const NOW = new Date("2026-10-22T00:30:00.000Z");
export const MODEL_ID = "@cf/zai-org/glm-4.7-flash";

export interface RecordingStore extends RawStore {
  readonly objects: Map<string, string>;
  readonly calls: { op: "get" | "put"; key: string }[];
}

export function memoryStore(initial: Record<string, string> = {}): RecordingStore {
  const objects = new Map(Object.entries(initial));
  const calls: { op: "get" | "put"; key: string }[] = [];
  return {
    objects,
    calls,
    async get(key) {
      calls.push({ op: "get", key });
      return objects.get(key) ?? null;
    },
    async put(key, body) {
      calls.push({ op: "put", key });
      objects.set(key, body);
    },
  };
}

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

type Run = { id: number; head_branch: string; conclusion: string | null; status: string; created_at: string; html_url: string };

/** The public GitHub Actions API for ci.yml runs, recording every request. */
export function githubFake(options: {
  main?: string;
  tag?: string;
  fail?: 403 | 429 | 500 | "timeout";
  jobs?: { name: string; conclusion: string }[];
} = {}) {
  const requests: RecordedRequest[] = [];
  // Newest first, as the API lists them: a main run newer than the tag run.
  const runs: Run[] = [
    { id: 39231615500, head_branch: "main", conclusion: options.main ?? "success", status: "completed", created_at: "2026-10-21T10:00:00Z", html_url: "https://github.com/unknowntpo/oss-knowledge-base/actions/runs/39231615500" },
    { id: 39231615488, head_branch: "v0.3.0", conclusion: options.tag ?? "success", status: "completed", created_at: "2026-10-21T09:00:00Z", html_url: "https://github.com/unknowntpo/oss-knowledge-base/actions/runs/39231615488" },
  ];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => { headers[key] = value; });
    requests.push({ url: request.url, method: request.method, headers });
    if (options.fail === "timeout") {
      return new Promise<Response>((_, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason));
      });
    }
    if (options.fail !== undefined) return new Response("rate limited", { status: options.fail });
    const url = new URL(request.url);
    const jobs = /\/actions\/runs\/(\d+)\/jobs$/u.exec(url.pathname);
    if (jobs !== null) {
      return Response.json({ jobs: options.jobs ?? [{ name: "Unit tests", conclusion: "failure" }, { name: "Typecheck and build", conclusion: "success" }] });
    }
    const run = /\/actions\/runs\/(\d+)$/u.exec(url.pathname);
    if (run !== null) return Response.json(runs.find((value) => String(value.id) === run[1]) ?? {});
    const branch = url.searchParams.get("branch");
    return Response.json({ workflow_runs: runs.filter((value) => branch === null || value.head_branch === branch) });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

export function rule(id: string, job: string, status: RuleEntry["status"], since = "2026-10-21T04:07:00.000Z", runId: string | null = `${job}-2026-10-20T22-07-00-000Z`): RuleEntry {
  return { id, job, status, value: "48.9 h", threshold: "27 h", since, runId };
}

/** Dev `/health` of 2026-10-22 (Spec 027 Example (1)), with `signals` and every A2 job section. */
export function devHealth(options: { rules?: RuleEntry[] | null; costGuardStatus?: string } = {}): Health {
  const tripped = (options.costGuardStatus ?? "ok") === "tripped";
  const health: Health = {
    ok: true,
    running: false,
    scheduled: true,
    followUp: null,
    phase: null,
    lastRun: {
      ok: true, runId: null, completedAt: "2026-10-21T22:07:13.057Z", copiedObjectCount: 1089, reusedObjectCount: 8150,
      r2: { classA: 1092, classB: 8828 }, pollTruncated: false, generatedAt: "2026-10-21T22:07:00.000Z", events: 4612,
    },
    sources: { github: { ok: true, lastSuccessAt: "2026-10-21T22:07:05.000Z" } },
    digest: { enabled: true, running: false, lastRun: { ok: true, runId: "digest-2026-10-21T22-47-00-000Z", completedAt: "2026-10-21T22:49:00.000Z", durationMs: 86000, rejections: 2, candidates: 40 }, today: { neurons: 900 } },
    reviewQueue: { lastRun: { ok: true, at: "2026-10-21T10:00:00.000Z" } },
    searchEmbedding: { lastRun: { ok: true, durationMs: 1200 }, lastError: null, today: { neurons: 10 }, pending: 0 },
    identityLinks: { lastRun: { ok: true, status: "ok", at: "2026-10-22T02:17:00.000Z", durationMs: 3154, r2: { classA: 3, classB: 4 }, links: 12 }, lastGoodAt: "2026-10-22T02:17:00.000Z" },
    kipPages: { revision: 7, lastRun: { ok: true, status: "ok", at: "2026-10-22T03:43:00.000Z", durationMs: 25990, requests: 40, jiraRequests: 38, r2: { classA: 2, classB: 9 }, error: null, pagesRead: 30 }, lastGoodAt: "2026-10-22T03:43:00.000Z" },
    retention: { mode: "dry", status: "ok", reason: null, lastRun: { runId: "retention-2026-10-21T10-17-00-000Z", deleted: 0, remaining: 10, elapsedMs: 900, r2: { classA: 0, classB: 2 }, failureKind: null, candidates: 3 } },
    costGuard: {
      mode: "monitor", status: options.costGuardStatus ?? "ok", reason: tripped ? "r2ClassA at 206.47% of 1000000 (trips at 80%)" : null,
      checkedAt: "2026-10-21T22:07:14.115Z", metrics: { r2ClassA: 2064777 },
      breaker: tripped
        ? { tripped: true, metric: "r2ClassA", value: 2064777, threshold: 800000, reason: "r2ClassA at 206.47% of 1000000 (trips at 80%)", trippedAt: "2026-10-21T22:07:14.115Z" }
        : { tripped: false },
    },
    searchQuery: { today: { neurons: 4 } },
    githubReviews: { lastRun: { ok: true } },
  };
  if (options.rules !== null) health.signals = { status: "ok", rules: options.rules ?? [] };
  return health;
}

/** Records every harness query; answers with one row naming the template. */
export function sqlFake(options: { hang?: boolean; text?: string } = {}) {
  const queries: SqlArgs[] = [];
  const querySignals = async (args: SqlArgs) => {
    queries.push(args);
    if (options.hang === true) return new Promise<never>(() => {});
    return [{ template: args.template, status: "ok", note: options.text ?? "no other job failed" }];
  };
  return { querySignals, queries };
}

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

export function toolCall(toolName: string, input: unknown, id = `call-${toolName}`, tokens = [1000, 50] as const) {
  return {
    content: [{ type: "tool-call" as const, toolCallId: id, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls" as const, raw: undefined },
    usage: usage(tokens[0], tokens[1]),
    warnings: [],
  };
}

export function answer(value: unknown, tokens = [2000, 200] as const) {
  return {
    content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage: usage(tokens[0], tokens[1]),
    warnings: [],
  };
}

export function retryableError() {
  return new APICallError({ message: "Workers AI 503", url: "workers-ai", requestBodyValues: {}, statusCode: 503, isRetryable: true });
}

type Response1 = ReturnType<typeof toolCall> | ReturnType<typeof answer>;

/** A mock model that answers each call with the next scripted response (the last one repeats). */
export function scripted(...responses: (Response1 | (() => Promise<Response1>))[]) {
  let index = 0;
  return new MockLanguageModelV4({
    modelId: MODEL_ID,
    doGenerate: async () => {
      const next = responses[Math.min(index, responses.length - 1)]!;
      index += 1;
      return typeof next === "function" ? next() : next;
    },
  });
}

/** Every text the model was sent across its calls, as one string per call. */
export function promptTexts(model: MockLanguageModelV4): string[] {
  return model.doGenerateCalls.map((call) => JSON.stringify(call.prompt));
}

export const VALID_OUTPUT: DiagnosisOutput = {
  verdict: "explained",
  cause: "alarm-stuck",
  confidence: "medium",
  evidence: [{ id: "E1", quote: "\"since\": \"2026-10-21T04:07:00.000Z\"" }],
  runbook: "cloudflare-data-publisher.md#follow-up-runs-spec-018",
  ownerAction: "Read Workers Logs for the run; a manual run answers 409 while the alarm is registered.",
};
