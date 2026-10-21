// bun run measure:kip-pages [-- --days 7] | [-- --agreement [--starters starters.json] [--links links.json]]
// Spec 019 amendment (7), W101 and W112: read-only measurements of the `kip-pages` job against the
// public cwiki and ASF Jira APIs (anonymous GETs, 2 s apart). Nothing is written anywhere.
//
// Default (W101): one run of the job as the Worker runs it, with an in-memory bucket. Without
// `--days` it is the first run (365 days back); `--days N` seeds a last good run N-1 days ago, so
// the window is N days (a normal day is `--days 2`). Prints cwiki and Jira requests, bytes, pages,
// listed / no-list / unparsed, R2 reads and writes, and duration.
//
// `--agreement` (W112): every KIP page of the space (about 29 requests of 50 with bodies, 120 s
// timeout each) and the assignees of the one-issue pages created in the last two years. Prints the
// `JIRA:` field classes, then for those pages: assignee unset, assignee = creator (exact name key),
// assignee among the author line's names, and, given `--starters` (a JSON object `{"KIP-n": "dev@
// starter name"}`, e.g. from the identity-link job's `kipStarters`), assignee = starter (exact,
// other written form, other script, different); given `--links` (a JSON array of
// `{"github": login, "jira": account key}` corroborated links), the KIPs whose assignee reaches a
// GitHub login, and for how many people.
import {
  KAFKA_KIP_PAGES,
  KIP_PAGES_BUDGET,
  KIP_PAGES_LAST_RUN_KEY,
  KIP_PAGES_REVISION,
  jiraAssigneeUrl,
  kipAuthorsKey,
  parseKipHeader,
  runKipPages,
  type KipAuthorsTableV1,
  type KipPagesBucket,
} from "@oss-knowledge-base/reference-pipeline/kip-pages";
import { SOURCE_USER_AGENT } from "@oss-knowledge-base/reference-pipeline";

const DAY_MS = 86_400_000;
const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};

class MemoryBucket implements KipPagesBucket {
  readonly objects = new Map<string, string>();
  gets = 0;
  puts = 0;
  async get(key: string) {
    this.gets += 1;
    return this.objects.get(key);
  }
  async put(key: string, body: string) {
    this.puts += 1;
    this.objects.set(key, body);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function measureRun(days: number | undefined): Promise<void> {
  const bucket = new MemoryBucket();
  const start = Date.now();
  if (days !== undefined) {
    const lastGoodAt = new Date(start - (days - 1) * DAY_MS).toISOString();
    const table: KipAuthorsTableV1 = { schema: "osskb.kip-authors.v1", generatedAt: lastGoodAt, coverageFrom: lastGoodAt, pages: [] };
    bucket.objects.set(kipAuthorsKey(KAFKA_KIP_PAGES.projectId), JSON.stringify(table));
    bucket.objects.set(KIP_PAGES_LAST_RUN_KEY, JSON.stringify({ revision: KIP_PAGES_REVISION, lastRun: null, lastGoodAt, coverageFrom: lastGoodAt }));
  }
  const log: string[] = [];
  let bytes = 0;
  const result = await runKipPages({
    flag: KIP_PAGES_REVISION,
    profile: KAFKA_KIP_PAGES,
    bucket,
    fetch: async (url, init) => {
      const began = Date.now();
      const response = await fetch(url, init);
      const body = await response.arrayBuffer();
      bytes += body.byteLength;
      log.push(`${new URL(url).host} ${response.status} ${body.byteLength} B ${Date.now() - began} ms`);
      return new Response(body, { status: response.status, headers: response.headers });
    },
    now: () => Date.now(),
    delay: sleep,
  });
  for (const line of log) console.log(line);
  const table = bucket.objects.get(kipAuthorsKey(KAFKA_KIP_PAGES.projectId));
  const pages = table === undefined ? [] : (JSON.parse(table) as KipAuthorsTableV1).pages;
  const count = (status: string) => pages.filter((page) => page.status === status).length;
  const run = result.lastRun!;
  console.log(JSON.stringify({
    window: days === undefined ? "first run (365 days)" : `${days} days`,
    ok: run.ok, status: run.status, error: run.error, since: run.since,
    cwikiRequests: run.requests, jiraRequests: run.jiraRequests, bytesReceived: bytes,
    pagesRead: run.pagesRead, kipPages: pages.length, listed: count("listed"), noList: count("no-list"), unparsed: count("unparsed"),
    issuesRead: run.issuesRead, unassigned: run.unassigned, tableBytes: run.bytesWritten,
    r2: { reads: bucket.gets, writes: bucket.puts }, durationMs: run.durationMs,
  }, null, 2));
}

interface FullPage {
  readonly title: string;
  readonly html: string;
  readonly createdAt: string | undefined;
  readonly creator: string | undefined;
}

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": SOURCE_USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`);
  return response.json();
}

const key = (name: string) => name.normalize("NFC").replace(/["']/gu, "").trim().toLowerCase();
const folded = (name: string) => key(name).normalize("NFD").replace(/\p{M}/gu, "").replace(/[^\p{L}]/gu, "");
const latin = (name: string) => /^[\p{Script=Latin}\p{M}\s.'-]*$/u.test(name);

async function measureAgreement(): Promise<void> {
  const profile = KAFKA_KIP_PAGES;
  const pages: FullPage[] = [];
  let url: string | undefined = `https://cwiki.apache.org/confluence/rest/api/content/search?${new URLSearchParams({
    cql: `space=${profile.space} and type=page and title~"KIP" order by created asc`, expand: "body.view,version,history", limit: "50",
  })}`;
  let requests = 0;
  while (url !== undefined) {
    if (requests > 0) await sleep(KIP_PAGES_BUDGET.spacingMs);
    requests += 1;
    const body = await getJson(url, 120_000) as { results: { title: string; body: { view: { value: string } }; history?: { createdDate?: string; createdBy?: { displayName?: string } } }[]; _links: { next?: string; base: string } };
    for (const result of body.results) pages.push({ title: result.title, html: result.body.view.value, createdAt: result.history?.createdDate, creator: result.history?.createdBy?.displayName });
    console.error(`cwiki request ${requests}: ${pages.length} pages`);
    url = body._links.next === undefined ? undefined : `${body._links.base}${body._links.next}`;
  }
  const kips = pages.flatMap((page) => {
    const kip = /^KIP-(\d+)\b/u.exec(page.title);
    return kip === null ? [] : [{ ...page, kip: Number(kip[1]), header: parseKipHeader(page.html, profile) }];
  });
  const classes = { one: 0, several: 0, empty: 0, query: 0, none: 0 };
  for (const page of kips) classes[page.header.jira] += 1;
  const since = Date.now() - 730 * DAY_MS;
  const recent = kips.filter((page) => page.header.jira === "one" && page.createdAt !== undefined && Date.parse(page.createdAt) >= since);
  const assignees = new Map<string, { key: string; display: string } | null>();
  const keys = recent.map((page) => page.header.keys[0]!);
  for (let offset = 0; offset < keys.length; offset += 100) {
    await sleep(KIP_PAGES_BUDGET.spacingMs);
    const body = await getJson(jiraAssigneeUrl(keys.slice(offset, offset + 100)), 120_000) as { issues: { key: string; fields: { assignee: { key: string; displayName: string } | null } }[] };
    for (const issue of body.issues) assignees.set(issue.key, issue.fields.assignee === null ? null : { key: issue.fields.assignee.key, display: issue.fields.assignee.displayName });
  }
  const starters = option("--starters") === undefined ? undefined : JSON.parse(await Bun.file(option("--starters")!).text()) as Record<string, string>;
  const links = option("--links") === undefined ? undefined : JSON.parse(await Bun.file(option("--links")!).text()) as { github: string; jira: string }[];
  const assigned = recent.flatMap((page) => {
    const assignee = assignees.get(page.header.keys[0]!);
    return assignee === null || assignee === undefined ? [] : [{ page, assignee }];
  });
  const starter = { exact: 0, otherForm: 0, otherScript: 0, different: 0, compared: 0 };
  if (starters !== undefined) {
    for (const { page, assignee } of assigned) {
      const name = starters[`KIP-${page.kip}`];
      if (name === undefined) continue;
      starter.compared += 1;
      if (key(name) === key(assignee.display)) starter.exact += 1;
      else if (latin(name) !== latin(assignee.display)) starter.otherScript += 1;
      else if (folded(name) === folded(assignee.display) || [...folded(name)].sort().join("") === [...folded(assignee.display)].sort().join("")) starter.otherForm += 1;
      else starter.different += 1;
    }
  }
  const linked = links === undefined ? undefined : assigned.filter(({ assignee }) => links.some((link) => link.jira === assignee.key));
  console.log(JSON.stringify({
    cwikiRequests: requests, jiraRequests: Math.ceil(keys.length / 100), kipPages: kips.length,
    jiraField: classes,
    oneIssueLastTwoYears: recent.length,
    assigneeUnset: recent.length - assigned.length,
    assigneeIsCreator: `${assigned.filter(({ page, assignee }) => page.creator !== undefined && key(page.creator) === key(assignee.display)).length} of ${assigned.length}`,
    assigneeInAuthorLine: (() => {
      const withLine = assigned.filter(({ page }) => page.header.status === "listed");
      return `${withLine.filter(({ page, assignee }) => page.header.authors.some((author) => author.nameKey === key(assignee.display))).length} of ${withLine.length}`;
    })(),
    assigneeVsStarter: starters === undefined ? "pass --starters" : starter,
    reachesGithub: linked === undefined ? "pass --links" : { kips: linked.length, people: new Set(linked.map(({ assignee }) => links!.find((link) => link.jira === assignee.key)!.github)).size },
  }, null, 2));
}

if (args.includes("--agreement")) await measureAgreement();
else await measureRun(option("--days") === undefined ? undefined : Number(option("--days")));
