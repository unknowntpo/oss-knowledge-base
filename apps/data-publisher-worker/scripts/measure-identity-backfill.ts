/**
 * Spec 019 amendment (8), W128: one `identity-backfill` run against an in-memory bucket.
 *
 *   bun run measure:identity-backfill -- --month 2026-09            (read-only upstream; GITHUB_TOKEN or `gh auth token`)
 *   bun run measure:identity-backfill -- --stub [--prs 328] [--keys 222]   (no upstream request: the largest month's size)
 *
 * The real mode reads one month from GitHub GraphQL search and ASF Jira, exactly as the job does
 * (at most 5 + 4 requests, sequential, 3 s apart, 30 s timeout, no retry), and writes nothing outside
 * memory. `--stub` answers from a generated month and needs no network. Both report the requests per
 * host, the smallest spacing between two requests, the timeout every request carried, the R2 Class A
 * and Class B, the bytes of the month object and the run's status; they fail when a cap is exceeded.
 */
import { parseArgs } from "node:util";

import { PEOPLE_ACTIVITY_STATE_SCHEMA, peopleActivityStateKey } from "@oss-knowledge-base/reference-pipeline";
import {
  addMonths,
  IDENTITY_BACKFILL_BUDGET,
  IDENTITY_BACKFILL_LAST_RUN_KEY,
  KAFKA_IDENTITY_BACKFILL,
  runIdentityBackfill,
} from "@oss-knowledge-base/reference-pipeline/identity-backfill";

const { values } = parseArgs({
  options: {
    month: { type: "string" },
    stub: { type: "boolean", default: false },
    prs: { type: "string", default: "328" },
    keys: { type: "string", default: "222" },
  },
});
if (!values.stub && !/^\d{4}-\d{2}$/u.test(values.month ?? "")) throw new Error("--month YYYY-MM (or --stub) is required");
const month = values.stub ? "2026-09" : values.month!;

class CountingBucket {
  readonly objects = new Map<string, string>();
  classA = 0;
  classB = 0;
  async get(key: string) {
    this.classB += 1;
    return this.objects.get(key);
  }
  async put(key: string, body: string) {
    this.classA += 1;
    this.objects.set(key, body);
  }
}

// The run fetches the newest unfinished month: mark every newer month of the range finished.
const nowMs = Date.parse(`${addMonths(month, 1)}-15T01:23:00Z`);
const bucket = new CountingBucket();
bucket.objects.set(peopleActivityStateKey(KAFKA_IDENTITY_BACKFILL.projectId), JSON.stringify({
  schema: PEOPLE_ACTIVITY_STATE_SCHEMA, firstAppendAt: `${addMonths(month, 1)}-10T00:00:00.000Z`, coverageFrom: `${addMonths(month, 1)}-10T00:00:00.000Z`,
  updatedAt: `${addMonths(month, 1)}-14T22:07:00.000Z`, months: [addMonths(month, 1)],
}));
bucket.classB = 0;

function stubFetch(prs: number, keys: number) {
  // About two thirds of the pull requests carry a key (the Example: 1,845 of 2,845), and at least
  // `keys` of them, spread evenly; the keyed ones name `keys` distinct keys, so 222 keys mean 3 Jira requests.
  const keyed = Math.min(prs, Math.max(keys, Math.round((prs * 2) / 3)));
  const keyIndex = (index: number) => Math.floor(((index + 1) * keyed) / prs) > Math.floor((index * keyed) / prs) ? Math.floor((index * keyed) / prs) : null;
  const nodes = Array.from({ length: prs }, (_, index) => ({
    number: 20_000 + index, title: keyIndex(index) === null ? `MINOR: change ${index}` : `KAFKA-${19_000 + (keyIndex(index)! % keys)}: change ${index}`,
    createdAt: `${month}-${String(1 + (index % 28)).padStart(2, "0")}T12:00:00Z`, url: `https://github.com/apache/kafka/pull/${20_000 + index}`,
    author: { __typename: "User", login: `dev-${index % 90}` },
  }));
  return async (url: string, init: RequestInit): Promise<Response> => {
    if (url.startsWith("https://api.github.com/")) {
      const after = (JSON.parse(String(init.body)) as { variables: { after: string | null } }).variables.after;
      const page = after === null ? 0 : Number(after);
      return Response.json({ data: {
        rateLimit: { remaining: 4_800, resetAt: new Date(nowMs + 3_600_000).toISOString() },
        search: { issueCount: nodes.length, pageInfo: { hasNextPage: (page + 1) * 100 < nodes.length, endCursor: String(page + 1) }, nodes: nodes.slice(page * 100, page * 100 + 100) },
      } });
    }
    const asked = (/key in \(([^)]*)\)/u.exec(new URL(url).searchParams.get("jql") ?? "")?.[1] ?? "").split(",");
    return Response.json({ issues: asked.map((key, index) => ({ key, fields: { assignee: index % 7 === 0 ? null : { key: `JIRAUSER${300_000 + index}`, displayName: `Person ${index}` } } })) });
  };
}

async function githubToken(): Promise<string> {
  if (values.stub) return "stub";
  const fromEnv = process.env.GITHUB_TOKEN?.trim() ?? "";
  if (fromEnv !== "") return fromEnv;
  const child = Bun.spawnSync(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" });
  return child.stdout.toString().trim();
}

const sent: { readonly host: string; readonly at: number }[] = [];
const timeouts: number[] = [];
const upstream = values.stub ? stubFetch(Number(values.prs), Number(values.keys)) : (url: string, init: RequestInit) => fetch(url, init);
let clock = nowMs;
const started = performance.now();
const result = await runIdentityBackfill({
  flag: "prs@1",
  profile: KAFKA_IDENTITY_BACKFILL,
  bucket,
  githubToken: await githubToken(),
  fetch: async (url, init) => {
    sent.push({ host: new URL(url).host, at: values.stub ? clock : Date.now() });
    return upstream(url, init);
  },
  // The stub mode keeps its own clock so the 3 s pauses cost no wall time; the real mode waits.
  now: () => (values.stub ? clock : nowMs + (performance.now() - started)),
  delay: values.stub ? async (ms) => { clock += ms; } : (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeout: (ms) => {
    timeouts.push(ms);
    return AbortSignal.timeout(ms);
  },
  log: (message) => console.error(message),
});

const record = result.record;
const lastRun = record?.lastRun;
const gaps = sent.slice(1).map((call, index) => call.at - sent[index]!.at);
const github = sent.filter((call) => call.host === "api.github.com").length;
const jira = sent.filter((call) => call.host === "issues.apache.org").length;
const monthBytes = [...bucket.objects].filter(([key]) => key.includes("/backfill/")).reduce((sum, [, body]) => sum + body.length, 0);
console.log(JSON.stringify({
  month: lastRun?.month, status: lastRun?.status, error: lastRun?.error, prs: lastRun?.prs, keyedPrs: lastRun?.keyedPrs, keys: lastRun?.keys, assigned: lastRun?.assigned,
  requests: { github, jira }, minSpacingMs: gaps.length === 0 ? null : Math.min(...gaps), timeoutsMs: [...new Set(timeouts)],
  r2: { classA: bucket.classA, classB: bucket.classB }, monthBytes, recordBytes: bucket.objects.get(IDENTITY_BACKFILL_LAST_RUN_KEY)?.length ?? 0,
}, null, 1));
const within = github <= IDENTITY_BACKFILL_BUDGET.githubRequests && jira <= IDENTITY_BACKFILL_BUDGET.jiraRequests && bucket.classA <= 2 && bucket.classB <= 2 &&
  gaps.every((gap) => gap >= IDENTITY_BACKFILL_BUDGET.spacingMs) && timeouts.every((ms) => ms === IDENTITY_BACKFILL_BUDGET.timeoutMs);
console.log(within ? "PASS" : "FAIL");
process.exit(within ? 0 : 1);
