/**
 * Spec 015 slice 1, run from the test-plan case file. Each row's prose input maps to one
 * executable case that computes the row's `expected` text from the real functions, on the
 * captured samples (docs/specs/015-review-queue/samples/) where the row names real data.
 */
import { describe, expect, test } from "bun:test";

import {
  asfPreset,
  buildKipRows,
  buildPrQueue,
  checkStoredCounts,
  classifyPr,
  columnSummary,
  DATAFUSION_REVIEW_PROFILE,
  feedLink,
  KAFKA_REVIEW_PROFILE,
  kipCandidates,
  matchesRosterName,
  mergePrPages,
  parseAsfRoster,
  parsePonyThread,
  parsePrPage,
  parseVoteLines,
  prCardLabel,
  prUrl,
  reviewQueueCounts,
  RosterError,
  tallyText,
  tallyVote,
  threadStats,
  threadUrl,
  voteRule,
  type FeedMailEntry,
  type PrNode,
  type ReviewQueue,
  type Roster,
  type ThreadMessage,
  type VoteRule,
} from "../src";
import { testPlanRows } from "./review-queue.cases";

const samples = new URL("../../../docs/specs/015-review-queue/samples/", import.meta.url);
async function sample<T>(name: string): Promise<T> {
  return await Bun.file(new URL(name, samples)).json() as T;
}

interface SampleThread {
  readonly displayId: string;
  readonly subject: string;
  readonly messages: readonly { mid: string; author: string; at: string; subject: string; voteLikeLines?: string[] }[];
}

const prSample = await sample<{ capturedAt: string; totalCount: number; nodes: PrNode[] }>("github-open-prs.json");
const threadSample = await sample<{ threads: SampleThread[] }>("ponymail-kip-threads.json");
const feedSample = await sample<{ entries: FeedMailEntry[] }>("feed-kip-mail-entries.json");
const ldapSample = await sample<{ projects: unknown; people: unknown }>("asf-roster-kafka.json");

const P = KAFKA_REVIEW_PROFILE;
const PR_NOW = prSample.capturedAt;
const KIP_NOW = "2026-10-08T04:03:37Z";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const roster: Roster = parseAsfRoster({ projects: ldapSample.projects }, { people: ldapSample.people }, "kafka", "2026-10-08T06:30:00Z");
const proposalRule = voteRule(P, "proposal")!;
const releaseRule = voteRule(P, "release")!;

const byNumber = new Map(prSample.nodes.map((node) => [node.number, node]));
function real(number: number): PrNode {
  const node = byNumber.get(number);
  if (node === undefined) throw new Error(`#${number} is not in the sample`);
  return node;
}
const state = (number: number) => classifyPr(real(number), PR_NOW, P);

function pr(over: Partial<PrNode> = {}): PrNode {
  return {
    number: 1, title: "t", isDraft: false, createdAt: "2026-01-01T00:00:00Z",
    author: { login: "alice", __typename: "User" }, reviewDecision: "REVIEW_REQUIRED",
    reviewRequests: { totalCount: 0, nodes: [] }, latestReviews: { totalCount: 0, nodes: [] },
    timelineItems: { nodes: [] }, ...over,
  };
}
const user = (login: string) => ({ login, __typename: "User" as const });
const review = (login: string, submittedAt: string, reviewState = "COMMENTED", typename: "User" | "Bot" = "User") =>
  ({ author: { login, __typename: typename }, state: reviewState, submittedAt });
const commit = (committedDate: string) => ({ __typename: "PullRequestCommit", commit: { committedDate } });
const iso = (base: string, offsetMs: number) => new Date(Date.parse(base) + offsetMs).toISOString();
const bucketText = (value: ReturnType<typeof classifyPr>) => value.bucket ?? "not queued";

function threadMessages(displayId: string): ThreadMessage[] {
  const thread = threadSample.threads.find((item) => item.displayId === displayId);
  if (thread === undefined) throw new Error(`${displayId} is not in the sample`);
  return thread.messages.map((message) => ({
    mid: message.mid, author: message.author, at: message.at, subject: message.subject,
    body: message.voteLikeLines === undefined ? null : message.voteLikeLines.join("\n"),
  }));
}
const threads = new Map(threadSample.threads.map((thread) => [thread.displayId, threadMessages(thread.displayId)]));
const kips = buildKipRows({ entries: feedSample.entries, threads, roster, profile: P, now: KIP_NOW });
const voteRow = (key: string) => kips.vote.find((row) => row.key === key)!;
const discussRow = (key: string) => kips.discuss.find((row) => row.key === key)!;
const voteResult = (row: ReturnType<typeof voteRow>) =>
  `${tallyText(row.tally, proposalRule.quorum)}; ${row.tally.state}; ${row.queued ? "queued" : "not queued"}`;

function message(author: string, at: string, subject: string, body: string | null, mid = `${author}-${at}`): ThreadMessage {
  return { mid, author, at, subject, body };
}
const VOTE_SUBJECT = "[VOTE] KIP-9: x";
function constructedTally(votes: readonly { author: string; body: string }[], opts: { openHours?: number; root?: boolean; rule?: VoteRule } = {}) {
  const openedAt = iso(KIP_NOW, -(opts.openHours ?? 100) * HOUR);
  const members = [
    ...(opts.root === false ? [] : [message("Starter", openedAt, VOTE_SUBJECT, "Please vote.", "root")]),
    ...votes.map((vote, index) => message(vote.author, iso(openedAt, (index + 1) * 60_000), `Re: ${VOTE_SUBJECT}`, vote.body)),
  ];
  return tallyVote(threadStats(members), opts.rule ?? proposalRule, roster, KIP_NOW);
}
const fakeRoster: Roster = {
  adapter: "asf", project: "kafka", fetchedAt: KIP_NOW,
  entries: ["A", "B", "C", "D", "E", "F", "G", "H"].map((id) => ({ id, name: id, roles: ["committer"] as const })),
};
function stateFor(plus: number, minus: number, openHours: number, extra: string[] = []) {
  const votes = [
    ...Array.from({ length: plus }, (_, index) => ({ author: "ABCD"[index]!, body: "+1 (binding)" })),
    ...Array.from({ length: minus }, (_, index) => ({ author: "EFGH"[index]!, body: "-1 (binding)" })),
    ...extra.map((body, index) => ({ author: `X${index}`, body })),
  ];
  const members = [message("Starter", iso(KIP_NOW, -openHours * HOUR), VOTE_SUBJECT, "Please vote.", "root"),
    ...votes.map((vote, index) => message(vote.author, iso(KIP_NOW, -(openHours * HOUR) + (index + 1) * 1000), `Re: ${VOTE_SUBJECT}`, vote.body))];
  return tallyVote(threadStats(members), proposalRule, fakeRoster, KIP_NOW);
}
const queuedText = (queued: boolean) => (queued ? "queued" : "not queued");

function vote(line: string): string {
  const parsed = parseVoteLines(line);
  if (parsed.votes.length > 0) {
    const last = parsed.votes.at(-1)!;
    return `${last.vote}, ${last.marker === null ? "unmarked" : `declared ${last.marker}`}`;
  }
  return parsed.unclear.length > 0 ? "unclear" : "no vote";
}

function pages(nodes: readonly PrNode[], size: number): unknown[] {
  const bodies: unknown[] = [];
  for (let start = 0; start < nodes.length; start += size) {
    const slice = nodes.slice(start, start + size);
    bodies.push({ data: { repository: { pullRequests: {
      totalCount: nodes.length, pageInfo: { hasNextPage: start + size < nodes.length, endCursor: `c${start}` }, nodes: slice,
    } } } });
  }
  return bodies;
}
function pageBody(nodes: unknown[], extra: Record<string, unknown> = {}, hasNextPage = false): unknown {
  return { data: { repository: { pullRequests: { totalCount: nodes.length, pageInfo: { hasNextPage, endCursor: "c" }, nodes } } }, ...extra };
}
function parsed(body: unknown) {
  const result = parsePrPage(body);
  if (!result.ok) throw new Error(result.error);
  return result;
}
const prQueue = buildPrQueue(prSample.nodes, PR_NOW, P);
const queue: ReviewQueue = { prs: prQueue, kips };

type CaseRow = { readonly id: string; readonly rule: string; readonly input: string; readonly expected: string };
const cases: Record<string, () => string> = {
  // Q1
  "snapshot|apache/kafka open PRs, totalCount 625, pages of 100": () => {
    const bodies = pages(prSample.nodes, 100);
    return `${bodies.length} requests; ${mergePrPages(bodies.map(parsed)).nodes.length} PRs`;
  },
  "snapshot|constructed: PR #23700 on page 2 and again on page 3 (moved while paging)": () => {
    const merged = mergePrPages([parsed(pageBody([pr({ number: 1 })], {}, true)), parsed(pageBody([pr({ number: 23700 })], {}, true)), parsed(pageBody([pr({ number: 23700 }), pr({ number: 3 })]))]);
    return merged.nodes.filter((node) => node.number === 23700).length === 1 && merged.nodes.length === 3 ? "counted once" : String(merged.nodes.length);
  },
  "snapshot|constructed: totalCount 625 on page 1, 624 distinct PRs read (one closed while paging)": () => {
    const nodes = prSample.nodes.slice(0, 624);
    const bodies = pages(nodes, 100).map((body, index) => {
      const copy = structuredClone(body) as { data: { repository: { pullRequests: { totalCount: number } } } };
      if (index === 0) copy.data.repository.pullRequests.totalCount = 625;
      return copy;
    });
    return `snapshot of ${mergePrPages(bodies.map(parsed)).nodes.length}`;
  },
  // Q2
  "machine|reviewer copilot-pull-request-reviewer (__typename Bot)": () =>
    classifyPr(pr({ latestReviews: { totalCount: 1, nodes: [review("copilot-pull-request-reviewer", "2026-09-01T00:00:00Z", "COMMENTED", "Bot")] } }), PR_NOW, P).reviewers === 0 ? "machine" : "human",
  "machine|constructed: author dependabot[bot] (__typename Bot)": () => {
    const value = classifyPr(pr({ author: { login: "dependabot[bot]", __typename: "Bot" } }), PR_NOW, P);
    return value.machineAuthor ? `machine; PR ${value.bucket === null ? "not queued" : "queued"}` : "human";
  },
  "machine|constructed: reviewer codecov-commenter (__typename User) listed in the profile machineUsers": () => {
    const profile = { ...P, machineUsers: ["codecov-commenter"] };
    return classifyPr(pr({ latestReviews: { totalCount: 1, nodes: [review("codecov-commenter", "2026-09-01T00:00:00Z")] } }), PR_NOW, profile).reviewers === 0 ? "machine" : "human";
  },
  "machine|constructed: reviewer abbott (__typename User, not listed)": () =>
    classifyPr(pr({ latestReviews: { totalCount: 1, nodes: [review("abbott", "2026-09-01T00:00:00Z")] } }), PR_NOW, P).reviewers === 1 ? "human" : "machine",
  "machine|#20995 author null (deleted account)": () => {
    const value = state(20995);
    return `${value.machineAuthor ? "machine" : "human"} author shown as ${value.author}; ${bucketText(value)}, ${value.waitDays} d`;
  },
  // Q3
  "author update|#23724 created 2026-10-07, last timeline item force-push 2026-10-07T16:46:00Z": () => `author update ${state(23724).authorUpdatedAt}`,
  "author update|#22319 last commit committedDate 2026-05-18T19:33:37Z, human review smjn APPROVED 2026-05-20T18:59:58Z": () =>
    `waiting since ${state(22319).waitingSince}; ${state(22319).waitDays} d`,
  "author update|constructed: PR with no timeline item of the 4 types, createdAt 2026-09-01T00:00:00Z": () =>
    `author update ${classifyPr(pr({ createdAt: "2026-09-01T00:00:00Z" }), PR_NOW, P).authorUpdatedAt}`,
  "author update|constructed: author comment 2026-10-07 after the last review, no new commit": () => {
    const base = pr({ timelineItems: { nodes: [commit("2026-09-01T00:00:00Z")] }, latestReviews: { totalCount: 1, nodes: [review("bob", "2026-09-02T00:00:00Z")] } });
    const withComment = { ...base, comments: { nodes: [{ author: { login: "alice" }, createdAt: "2026-10-07T00:00:00Z" }] } } as PrNode;
    return classifyPr(withComment, PR_NOW, P).authorUpdatedAt === "2026-09-01T00:00:00Z" ? "not an author update (comments are not read)" : "counted";
  },
  // Q4
  "bucket|#22751 isDraft true": () => bucketText(state(22751)),
  "bucket|#23739 reviewDecision APPROVED, 4 reviewers, commit 2026-10-08T03:08:51Z after the approvals": () => `${bucketText(state(23739))}; ${state(23739).waitDays} d`,
  "bucket|#18706 no requested reviewer, no review, created 2025-01-25T13:28:22Z": () => `${bucketText(state(18706))}; ${state(18706).waitDays} d`,
  "bucket|#19236 1 reviewer, author update 2025-10-25T20:04:34Z after the last review": () => `${bucketText(state(19236))}; ${state(19236).waitDays} d`,
  "bucket|#23381 reviewer present, author update after the last review, wait 14.32 d": () => bucketText(state(23381)),
  "bucket|#22996 reviewer present, author update after the last review, wait 13.58 d": () =>
    state(22996).bucket === null ? "not queued (14 d or less)" : bucketText(state(22996)),
  "bucket|constructed: author update at exactly the last review's submittedAt, wait 30 d": () => {
    const at = iso(PR_NOW, -30 * DAY);
    const value = classifyPr(pr({ timelineItems: { nodes: [commit(at)] }, latestReviews: { totalCount: 1, nodes: [review("bob", at)] } }), PR_NOW, P);
    return value.bucket === null ? "not queued (not after the review)" : bucketText(value);
  },
  "bucket|constructed: author update after the last review, wait exactly 14 d 0 ms": () =>
    bucketText(classifyPr(pr({ timelineItems: { nodes: [commit(iso(PR_NOW, -14 * DAY))] }, latestReviews: { totalCount: 1, nodes: [review("bob", iso(PR_NOW, -20 * DAY))] } }), PR_NOW, P)),
  "bucket|constructed: author update after the last review, wait 14 d + 1 ms": () =>
    bucketText(classifyPr(pr({ timelineItems: { nodes: [commit(iso(PR_NOW, -14 * DAY - 1))] }, latestReviews: { totalCount: 1, nodes: [review("bob", iso(PR_NOW, -20 * DAY))] } }), PR_NOW, P)),
  "bucket|constructed: reviewer reviewed after the author's last update (author's turn), wait 40 d": () =>
    bucketText(classifyPr(pr({ timelineItems: { nodes: [commit(iso(PR_NOW, -50 * DAY))] }, latestReviews: { totalCount: 1, nodes: [review("bob", iso(PR_NOW, -40 * DAY))] } }), PR_NOW, P)),
  "bucket|captured snapshot, 625 open PRs": () => {
    const all = prSample.nodes.map((node) => classifyPr(node, PR_NOW, P));
    const count = (predicate: (value: ReturnType<typeof classifyPr>) => boolean) => all.filter(predicate).length;
    const notQueued = all.filter((value) => value.bucket === null);
    return `approved ${count((value) => value.bucket === "approved")}; noReviewer ${count((value) => value.bucket === "noReviewer")}; ` +
      `waiting ${count((value) => value.bucket === "waiting")}; not queued ${notQueued.length} (${notQueued.filter((value) => value.reason === "draft").length} drafts, ` +
      `${notQueued.filter((value) => value.reason === "author-turn").length} author's turn, ${notQueued.filter((value) => value.reason === "recent-review-wait").length} waiting on reviewers 14 d or less, ` +
      `${notQueued.filter((value) => value.reason === "recent-no-reviewer").length} without a reviewer 14 d or less)`;
  },
  "bucket|#23724 no reviewer (Copilot only), wait 0.5 d": () =>
    state(23724).reason === "recent-no-reviewer" ? "not queued (no reviewer, 14 d or less)" : bucketText(state(23724)),
  "bucket|constructed: no reviewer, wait exactly 14 d 0 ms": () => bucketText(classifyPr(pr({ createdAt: iso(PR_NOW, -14 * DAY) }), PR_NOW, P)),
  "bucket|constructed: no reviewer, wait 14 d + 1 ms": () => bucketText(classifyPr(pr({ createdAt: iso(PR_NOW, -14 * DAY - 1) }), PR_NOW, P)),
  // Q5
  "order|no-reviewer bucket of the captured snapshot": () =>
    `first three ${prQueue.noReviewer.slice(0, 3).map((row) => `#${row.number} ${row.waitDays} d`).join(", ")}`,
  "order|constructed: #100 and #99 both 30 d": () => {
    const at = iso(PR_NOW, -30 * DAY - HOUR);
    const built = buildPrQueue([pr({ number: 100, createdAt: at }), pr({ number: 99, createdAt: iso(at, 60_000) })], PR_NOW, P);
    return built.noReviewer.map((row) => `#${row.number}`).join(" before ");
  },
  "home block|column summaries of the captured snapshot and KIP rows": () => {
    const summary = columnSummary(queue);
    const counts = reviewQueueCounts(queue);
    return `PR column ${summary.prs.total} (${counts.noReviewer} / ${counts.waiting} / ${counts.approved}), rows ${summary.prs.top.map((row) => `${row.id} ${row.waitDays} d`).join(", ")}; ` +
      `KIP column ${summary.kips.total} (${counts.vote} votes / ${counts.discuss} discussions), rows ${summary.kips.top.map((row) => `${row.id} ${row.waitDays} d`).join(", ")} (tie broken by proposal number)`;
  },
  // Q6
  "card label|#23724 in the snapshot, Copilot review only": () => prCardLabel(prQueue.reviewState[23724]) ?? "no label",
  "card label|#23739 in the snapshot, 4 human reviewers": () => prCardLabel(prQueue.reviewState[23739]) ?? "no label",
  "card label|#16808 in the snapshot, 1 requested reviewer, no review": () => prCardLabel(prQueue.reviewState[16808]) ?? "no label",
  "card label|constructed: merged PR #23623 (not in the open snapshot)": () => prCardLabel(prQueue.reviewState[23623]) ?? "no label",
  "card label|#22751 isDraft true": () => prCardLabel(prQueue.reviewState[22751]) ?? "no label",
  // Q7
  "kip candidates|Dev release 2026-10-08T03-07-37-000Z: 21 dev@ threads with [VOTE]/[DISCUSS] and a KIP key": () => {
    const tagged = kipCandidates(feedSample.entries, P);
    return `${tagged.tagged.vote} vote threads; ${tagged.tagged.discuss} discuss threads`;
  },
  "kip candidates|KIP-1349 has [VOTE] KAFKA-MAIL-82e0d5b3 and [DISCUSS] KAFKA-MAIL-4bc41094": () => {
    const rows = kipCandidates(feedSample.entries, P).candidates.filter((row) => row.key === "KIP-1349");
    return rows.length === 1 && rows[0]!.stage === "vote" && rows[0]!.displayId === "KAFKA-MAIL-82e0d5b3" ? "vote row only" : JSON.stringify(rows);
  },
  "kip candidates|DISCUSS: KIP-1378 … (no brackets)": () =>
    kipCandidates(feedSample.entries, P).candidates.some((row) => row.key === "KIP-1378") ? "candidate" : "not a candidate (profile tag is [DISCUSS])",
  "kip candidates|constructed: [RESULT][VOTE] KIP-1279 thread in the release": () => {
    const entries = [...feedSample.entries, { displayId: "KAFKA-MAIL-00000001", title: "[RESULT][VOTE] KIP-1279: Cluster Mirroring", lastActivityAt: KIP_NOW }];
    const before = kipCandidates(feedSample.entries, P).candidates.some((row) => row.key === "KIP-1279");
    return before && !kipCandidates(entries, P).candidates.some((row) => row.key === "KIP-1279") ? "KIP-1279 vote row removed" : "kept";
  },
  "kip candidates|constructed: two [VOTE] KIP-9 threads, last activity 09-01 and 10-01": () => {
    const entries = [{ displayId: "KAFKA-MAIL-0000000a", title: "[VOTE] KIP-9: x", lastActivityAt: "2026-09-01T00:00:00.000Z" },
      { displayId: "KAFKA-MAIL-0000000b", title: "[VOTE] KIP-9: x", lastActivityAt: "2026-10-01T00:00:00.000Z" }];
    const pick = (list: typeof entries) => kipCandidates(list, P).candidates[0]?.displayId;
    return pick(entries) === "KAFKA-MAIL-0000000b" && pick([...entries].reverse()) === "KAFKA-MAIL-0000000b" ? "the 10-01 thread" : String(pick(entries));
  },
  "kip candidates|constructed: profile apache-datafusion proposal.kind null": () =>
    kipCandidates(feedSample.entries, DATAFUSION_REVIEW_PROFILE).candidates.length === 0 ? "no KIP candidates" : "candidates",
  "kip candidates|constructed: the Kafka profile and entries with proposal.kind set to null": () =>
    kipCandidates(feedSample.entries, { ...P, proposal: { ...P.proposal, kind: null } }).candidates.length === 0 ? "no KIP candidates" : "candidates",
  // Q8
  "repliers|KAFKA-MAIL-a9696e08 KIP-1163: release has 1 message; full thread 22 messages, root Ivan Yurchenko 2025-04-23": () =>
    `${discussRow("KIP-1163").stats.repliers} repliers; ${discussRow("KIP-1163").queued ? "few" : "not few"}`,
  "repliers|KAFKA-MAIL-3bc971ac KIP-1376: root Mickael Maison, replies Paolo Patierno and Mickael Maison": () =>
    `${discussRow("KIP-1376").stats.repliers} replier; last reply ${discussRow("KIP-1376").stats.lastReplyAt}`,
  "repliers|KAFKA-MAIL-dd798156 KIP-1375: root only, 2026-09-08T03:17:45Z": () => {
    const row = discussRow("KIP-1375");
    return `${row.stats.repliers} repliers; ${row.stats.lastReplyAt === null ? `no replies · opened ${row.waitDays} d ago` : "replied"}`;
  },
  "repliers|constructed: two replies from \"unknown sender\"": () => {
    const subject = "[DISCUSS] KIP-9: x";
    const stats = threadStats([message("Root", "2026-10-01T00:00:00Z", subject, null, "r"),
      message("unknown sender", "2026-10-02T00:00:00Z", `Re: ${subject}`, null, "a"), message("unknown sender", "2026-10-03T00:00:00Z", `Re: ${subject}`, null, "b")]);
    return `${stats.repliers} replier`;
  },
  "repliers|constructed: replies from Alice and \"CI Bot\", profile machineUsers [\"CI Bot\"]": () => {
    const subject = "[DISCUSS] KIP-9: x";
    const stats = threadStats([message("Root", "2026-10-01T00:00:00Z", subject, null, "r"),
      message("Alice", "2026-10-02T00:00:00Z", `Re: ${subject}`, null, "a"), message("CI Bot", "2026-10-03T00:00:00Z", `Re: ${subject}`, null, "b")], subject, ["CI Bot"]);
    return `${stats.repliers} replier`;
  },
  "members|constructed: reply \"[EXTERNAL] RE: [VOTE] KIP-9: x\" and \"SV: [VOTE] KIP-9: x\"": () => {
    const stats = threadStats([message("Root", "2026-10-01T00:00:00Z", VOTE_SUBJECT, null, "r"),
      message("A", "2026-10-02T00:00:00Z", "[EXTERNAL] RE: [VOTE] KIP-9: x", null, "a"), message("B", "2026-10-03T00:00:00Z", "SV: [VOTE] KIP-9: x", null, "b")], VOTE_SUBJECT);
    return stats.members.length === 3 ? "both members" : `${stats.members.length - 1} members`;
  },
  "members|constructed: reply \"Re: [VOTE] KIP-9 (was: x)\" in the tree, subject key differs": () => {
    const stats = threadStats([message("Root", iso(KIP_NOW, -100 * HOUR), VOTE_SUBJECT, "Please vote.", "r"),
      message("A", iso(KIP_NOW, -90 * HOUR), "Re: [VOTE] KIP-9 (was: x)", "-1 (binding)", "a")], VOTE_SUBJECT, [], "KIP-9");
    const tally = tallyVote(stats, proposalRule, roster, KIP_NOW);
    return `${stats.members.some((member) => member.mid === "a") ? "member" : "not a member"}; ${tally.complete ? "tally complete" : `tally incomplete: ${stats.unattributed} reply not attributed`}`;
  },
  "members|KAFKA-MAIL-0b57fb00 KIP-785: only message \"Re: [DISCUSS] KIP-785 …\" by Manan Gupta 2026-09-17, no parent": () => {
    const row = discussRow("KIP-785");
    return `${row.stats.rootArchived ? "root archived" : "root not archived"}; "seen ≥ ${row.stats.repliers} replier"; ${queuedText(row.queued)}`;
  },
  "members|constructed: [VOTE] KIP-9 started as a reply inside the [DISCUSS] KIP-9 tree": () => {
    const tree = [message("Author", "2026-09-01T00:00:00Z", "[DISCUSS] KIP-9: x", null, "d0"), message("Bob", "2026-09-02T00:00:00Z", "Re: [DISCUSS] KIP-9: x", null, "d1"),
      message("Author", "2026-09-10T00:00:00Z", "[VOTE] KIP-9: x", "+1 (binding)", "v0"), message("Carol", "2026-09-11T00:00:00Z", "Re: [VOTE] KIP-9: x", "+1", "v1")];
    const stats = threadStats(tree, "[VOTE] KIP-9: x");
    return stats.members.every((member) => member.subject.includes("[VOTE]")) && stats.root?.mid === "v0"
      ? "vote row uses only the [VOTE] messages; root = oldest [VOTE] message without a reply prefix" : JSON.stringify(stats.members.map((member) => member.mid));
  },
  // Q9
  "vote line|Andrew Schofield: \"+1 (binding)\"": () => vote("+1 (binding)"),
  "vote line|Luke Chen: \"+1 (binding) from me.\"": () => vote("+1 (binding) from me."),
  "vote line|Alieh Saeedi: \"+1 (non-binding)\"": () => vote("+1 (non-binding)"),
  "vote line|Bill Bejeck: \"+1 (biding)\"": () => vote("+1 (biding)"),
  "vote line|José Armando García Sancio: \"+1. LGTM. Looking forward to …\"": () => vote("+1. LGTM. Looking forward to simplifying the bootstrap process for Kafka."),
  "vote line|Andrew Schofield: \"Thanks for the KIP.\" then quoted \"> +1 (binding)\"": () => {
    const result = vote("Thanks for the KIP.\n\nOn 2026-10-01 Bob wrote:\n> +1 (binding)");
    return result === "no vote" ? "no vote (quoted)" : result;
  },
  "vote line|constructed: \"+1 to Chris's suggestion\"": () => vote("+1 to Chris's suggestion"),
  "vote line|Federico Valeri: \"+1 (non-binding): Vaquar Khan\" (vote summary)": () => vote("+1 (non-binding): Vaquar Khan"),
  "vote line|Gabriella Fu: \"0-1. Version 1 was introduced by KIP-1331 …\"": () => vote("0-1. Version 1 was introduced by KIP-1331 and has not been released yet, so"),
  "vote line|constructed: \"I am +1 on this\" (not at line start)": () => vote("I am +1 on this"),
  "vote line|constructed: \"+1 (binding) - Mickael Maison\" (vote summary)": () => vote("+1 (binding) - Mickael Maison"),
  "vote line|constructed: \"+1 (binding).\"": () => vote("+1 (binding)."),
  "vote line|constructed: \"-1 (binding) until the upgrade path is documented\"": () => vote("-1 (binding) until the upgrade path is documented"),
  "vote line|constructed: \"On Mon, … wrote:\", \"> Please vote\", then \"+1 (binding)\" (bottom-posted)": () =>
    vote("On Mon, Oct 5, 2026 at 10:00 AM Alice <al...@apache.org>\nwrote:\n> Please vote\n\n+1 (binding)"),
  "vote line|constructed: \"-1: the upgrade path is missing\"": () => vote("-1: the upgrade path is missing"),
  "vote line|constructed: \"+1: looks good\"": () => vote("+1: looks good"),
  "vote line|constructed: \"+1;\"": () => vote("+1;"),
  "vote line|constructed: \"Thanks\", \"From: Bob\", then an unquoted \"+1 (binding)\"": () => {
    const parsed = parseVoteLines("Thanks\nFrom: Bob <b@x>\nSent: Monday\n+1 (binding)");
    return `${parsed.votes.length === 0 ? "no vote" : "vote"}; ${parsed.ambiguous ? "message ambiguous (vote-like line after a quoted header)" : "clear"}`;
  },
  "vote line|constructed: \"-----Original Message-----\" then \"+1 (binding)\"": () => {
    const result = vote("Thanks\n-----Original Message-----\n+1 (binding)");
    return result === "no vote" ? "no vote (quoted message)" : result;
  },
  // Q10
  "binding|José Armando García Sancio unmarked +1; name in the ASF kafka committer roster (roles committer, pmc)": () => {
    const tally = constructedTally([{ author: "José Armando García Sancio", body: "+1. LGTM." }]);
    return tally.plusBindingViaRoster === 1 && tally.plusBinding === 1 ? "binding via roster" : "not binding";
  },
  "binding|KIP-1349: Sushant Mahajan unmarked +1; roster roles committer (not pmc)": () => {
    const tally = voteRow("KIP-1349").tally;
    return tally.voters.find((voter) => voter.author === "Sushant Mahajan")?.standing === "roster" ? "binding via roster (proposal votes need committer)" : "not binding";
  },
  "binding|constructed: roster member writes \"+1 (non-binding)\"": () =>
    constructedTally([{ author: "José Armando García Sancio", body: "+1 (non-binding)" }]).plusBinding === 0 ? "not binding (declaration wins)" : "binding",
  "binding|KIP-1279: vaquar khan unmarked +1; not in the roster": () => {
    const voter = voteRow("KIP-1279").tally.voters.find((item) => item.author === "vaquar khan");
    return voter?.standing === "unmarked" ? "not binding; counted as unmarked" : String(voter?.standing);
  },
  "binding|constructed: release vote; Sushant Mahajan unmarked +1 (committer, not pmc)": () => {
    const tally = constructedTally([{ author: "Sushant Mahajan", body: "+1" }], { rule: releaseRule });
    return tally.plusBinding === 0 && tally.unmarked === 1 ? "not binding (release votes need pmc); counted as unmarked" : "binding";
  },
  "binding|constructed: \"José Armando García Sancio\" written with a decomposed accent (NFD)": () =>
    matchesRosterName(roster, "José Armando García Sancio".normalize("NFD"), "committer") ? "matches after NFC normalization" : "no match",
  "binding|constructed: voter \"jose armando garcia sancio\"": () =>
    matchesRosterName(roster, "jose armando garcia sancio", "committer") ? "match" : "no match (no case folding or transliteration)",
  // Q11
  "voter|KIP-1349: Sushant Mahajan from su…@gmail.com \"+1\" 17:38:50Z, from sm…@apache.org empty reply 18:05:01Z": () => {
    const voters = voteRow("KIP-1349").tally.voters.filter((voter) => voter.author === "Sushant Mahajan");
    return `${voters.length} voter, ${voters[0]?.vote}`;
  },
  "voter|constructed: A \"+1 (binding)\" then later \"-1 (binding)\"": () => {
    const tally = constructedTally([{ author: "A", body: "+1 (binding)" }, { author: "A", body: "-1 (binding)" }]);
    return tally.minusBinding === 1 && tally.plus === 0 ? "A counts -1 binding" : `${tally.plus}/${tally.minusBinding}`;
  },
  "voter|constructed: one body with \"+1 (binding)\" then \"-1 (binding)\" lines": () => {
    const tally = constructedTally([{ author: "A", body: "+1 (binding)\n-1 (binding)" }]);
    return tally.minusBinding === 1 && tally.plus === 0 ? "counts -1 binding (last line in the body)" : `${tally.plus}/${tally.minusBinding}`;
  },
  // Q12
  "vote row|KAFKA-MAIL-82e0d5b3 KIP-1349: full thread 6 messages, root 2026-08-19": () => voteResult(voteRow("KIP-1349")),
  "vote row|KAFKA-MAIL-e903d023 KIP-1262: Luke Chen declared, Sancio via roster": () => voteResult(voteRow("KIP-1262")),
  "vote row|KAFKA-MAIL-86ae8b63 KIP-1368: root only": () => voteResult(voteRow("KIP-1368")),
  "vote row|KAFKA-MAIL-a614bccc KIP-1097: 3 messages, no vote line": () => voteResult(voteRow("KIP-1097")),
  "vote row|KAFKA-MAIL-75914579 KIP-1357: Lucas Brutschy, Matthias J. Sax, Bill Bejeck declared binding, root 2026-06-25": () => voteResult(voteRow("KIP-1357")),
  "vote row|KAFKA-MAIL-ff6d44a5 KIP-1279: Mickael Maison, Andrew Schofield, Rajini Sivaram binding; vaquar khan unmarked (not a committer); 1 unclear +1 line": () => voteResult(voteRow("KIP-1279")),
  "discuss row|KIP-1153: 2 repliers": () => (discussRow("KIP-1153").queued ? "queued" : `not queued (${discussRow("KIP-1153").stats.repliers} is not fewer than ${P.fewRepliers})`),
  "discuss row|KIP-1379: 1 replier": () => queuedText(discussRow("KIP-1379").queued),
  "discuss row|11 discuss threads without a vote thread": () => {
    const queued = kips.discuss.filter((row) => row.queued);
    const group = (predicate: (row: (typeof kips.discuss)[number]) => boolean) => queued.filter(predicate).map((row) => row.key);
    const zero = group((row) => row.stats.rootArchived && row.stats.repliers === 0);
    const seen = group((row) => !row.stats.rootArchived);
    const one = group((row) => row.stats.rootArchived && row.stats.repliers === 1);
    const not = kips.discuss.filter((row) => !row.queued).map((row) => row.key);
    return `${queued.length} queued (${zero.join(", ")} with 0; ${seen.map((key) => `${key} seen ≥ 1`).join(", ")}; ${one.join(", ")} with 1); ${not.join(" and ")} not`;
  },
  // Q13
  "counts|queue object with stored counts {noReviewer 310, waiting 61, approved 22, vote 5, discuss 9}": () => {
    const stored = reviewQueueCounts(queue);
    const named = `{noReviewer ${stored.noReviewer}, waiting ${stored.waiting}, approved ${stored.approved}, vote ${stored.vote}, discuss ${stored.discuss}}`;
    if (named !== "{noReviewer 310, waiting 61, approved 22, vote 5, discuss 9}") return named;
    return checkStoredCounts(queue, stored) ? "accepted; counts equal the arrays" : "rejected: counts-mismatch";
  },
  "counts|constructed: stored noReviewer 309 with 310 rows": () =>
    checkStoredCounts(queue, { ...reviewQueueCounts(queue), noReviewer: 309 }) ? "accepted; counts equal the arrays" : "rejected: counts-mismatch",
  // Q14
  "cite|#18706": () => prUrl(P, 18706),
  "cite|KIP-1349 vote row": () => `${threadUrl(voteRow("KIP-1349").rootMid!)} and ${feedLink(voteRow("KIP-1349").displayId)}`,
  // Q16
  "wording|KIP-1349, all 6 bodies read, root archived, roster read": () => `"${tallyText(voteRow("KIP-1349").tally, proposalRule.quorum)}"`,
  "wording|constructed: KIP-1349 with Andrew Schofield's message unread": () => {
    const members = threadMessages("KAFKA-MAIL-82e0d5b3").map((item) => (item.author === "Andrew Schofield" ? { ...item, body: null } : item));
    const tally = tallyVote(threadStats(members), proposalRule, roster, KIP_NOW);
    return `"${tallyText(tally, proposalRule.quorum)}"; ${tally.state}`;
  },
  "wording|constructed: 3 declared binding +1 and a reply with an unquoted \"+1 (binding)\" below a \"From:\" header, open 100 h": () => {
    const tally = constructedTally([{ author: "A", body: "+1 (binding)" }, { author: "B", body: "+1 (binding)" }, { author: "C", body: "+1 (binding)" },
      { author: "D", body: "Agreed.\nFrom: E <e@x>\nSent: Monday\n+1 (binding)" }]);
    return `"${tallyText(tally, 3)}"; ${tally.state}`;
  },
  "wording|KIP-1279 with 1 unclear line": () => `"${tallyText(voteRow("KIP-1279").tally, proposalRule.quorum)}"`,
  "wording|constructed: vote thread whose members are all replies, one \"+1 (binding)\"": () =>
    `"${tallyText(constructedTally([{ author: "A", body: "+1 (binding)" }], { root: false }), proposalRule.quorum)}"`,
  // Q19, Q20, Q46: page parsing
  "graphql errors|constructed: HTTP 200, data null, errors[0] \"Something went wrong\" (no path)": () => {
    const result = parsePrPage({ data: null, errors: [{ message: "Something went wrong" }] });
    return result.ok ? "parsed" : `failureKind ${result.failureKind}`;
  },
  "graphql errors|constructed: HTTP 200, data present, errors[0] path [\"repository\"] (not a PR node)": () => {
    const result = parsePrPage(pageBody([pr()], { errors: [{ message: "x", path: ["repository"] }] }));
    return result.ok ? "parsed" : `failureKind ${result.failureKind}`;
  },
  "paging drift|constructed: hasNextPage true with an empty nodes list": () => {
    const result = parsePrPage(pageBody([], {}, true));
    return result.ok ? "parsed" : `failureKind ${result.failureKind} (no endless loop)`;
  },
  "node error|constructed: errors[0].path [\"repository\",\"pullRequests\",\"nodes\",17,\"author\"] on page 2": () => {
    const nodes = Array.from({ length: 20 }, (_, index) => pr({ number: 1000 + index }));
    const result = parsePrPage(pageBody(nodes, { errors: [{ message: "x", path: ["repository", "pullRequests", "nodes", 17, "author"] }] }));
    if (!result.ok) return `failureKind ${result.failureKind}`;
    return !result.nodes.some((node) => node.number === 1017) && result.nodes.length === 19 ? `that PR dropped; droppedNodes ${result.droppedNodes}; page parsed` : "kept";
  },
  // Q21–Q24
  "reopened|#16808 created 2024-08-06, reopened 2026-08-26T05:25:22Z, 1 requested reviewer": () => `waiting since ${state(16808).waitingSince}; ${state(16808).waitDays} d`,
  "force-push|#21333 CHANGES_REQUESTED 2026-08-14, force-push 2026-09-02T10:01:16Z": () => `${bucketText(state(21333))}; ${state(21333).waitDays} d`,
  "bot reviewer|#23724 only review by copilot-pull-request-reviewer": () => `${state(23724).reviewers} reviewers`,
  "bot reviewer|constructed: only requested reviewer is a Bot": () =>
    `${classifyPr(pr({ reviewRequests: { totalCount: 1, nodes: [{ requestedReviewer: { __typename: "Bot", login: "helper" } }] } }), PR_NOW, P).reviewers} reviewers`,
  "reviewers|constructed: only review is the PR author's own COMMENTED review": () =>
    `${classifyPr(pr({ latestReviews: { totalCount: 1, nodes: [review("alice", "2026-09-01T00:00:00Z")] } }), PR_NOW, P).reviewers} reviewers`,
  "reviewers|constructed: requested team apache/kafka-committers, no review": () => {
    const value = classifyPr(pr({ reviewRequests: { totalCount: 1, nodes: [{ requestedReviewer: { __typename: "Team", slug: "kafka-committers" } }] } }), PR_NOW, P);
    return `${value.reviewers} reviewer (team)`;
  },
  "no decision|constructed: reviewDecision null, one human APPROVED review": () => {
    const value = classifyPr(pr({ reviewDecision: null, latestReviews: { totalCount: 1, nodes: [review("bob", "2026-09-01T00:00:00Z", "APPROVED")] } }), PR_NOW, P);
    return value.bucket === "approved" ? "approved" : "not approved; bucket by reviewers";
  },
  // Q28
  "unparsable|constructed: thread.lua returns HTML": () => {
    try { parsePonyThread("<html>busy</html>"); return "parsed"; } catch { return "parse failure, not 0 repliers"; }
  },
  "unparsable|constructed: thread.lua JSON without thread.epoch": () => {
    try { parsePonyThread({ thread: { mid: "m", from: "A <a@b>", subject: "s" } }); return "parsed"; } catch { return "parse failure, not 0 repliers"; }
  },
  "unparsable|constructed: thread.epoch as the string \"1790000000\"": () => {
    try { parsePonyThread({ thread: { mid: "m", from: "A <a@b>", subject: "s", epoch: "1790000000" } }); return "parsed"; } catch { return "parse failure, not 0 repliers"; }
  },
  // Q29
  "roster|KIP-1262 with no roster: Luke Chen declared, Sancio unmarked": () => {
    const tally = tallyVote(threadStats(threadMessages("KAFKA-MAIL-e903d023")), proposalRule, null, KIP_NOW);
    return `"${tallyText(tally, proposalRule.quorum)}"; ${tally.state}; ${queuedText(tally.queued)}`;
  },
  // Q47
  "truncated|constructed: reviewRequests totalCount 12, 10 nodes read, no review": () => {
    const value = classifyPr(pr({ reviewRequests: { totalCount: 12, nodes: Array.from({ length: 10 }, (_, index) => ({ requestedReviewer: user(`r${index}`) })) } }), PR_NOW, P);
    return `"${prCardLabel(value)}"; ${value.bucket === "noReviewer" ? "noReviewer" : "not noReviewer"}`;
  },
  "truncated|#23739 latestReviews totalCount 4, 4 nodes": () => `${state(23739).reviewers} reviewers (${state(23739).reviewersAtLeast ? "at least" : "exact"})`,
  // Q49
  "governance|Kafka profile": () => {
    const preset = asfPreset({ project: "kafka", devList: "dev" });
    const fromPreset = JSON.stringify([P.mail, P.tags, P.governance.roster]) === JSON.stringify([preset.mail, preset.tags, preset.governance.roster]);
    const rule = (value: VoteRule) => `{quorum ${value.quorum}, ${value.rule}, ${value.minOpenHours} h, ${value.bindingRole}}`;
    return `${fromPreset ? "asfPreset(kafka, dev) + overrides" : "not from the preset"}; roster {${P.governance.roster?.adapter}, ${P.governance.roster?.project}}; ` +
      `proposal ${rule(proposalRule)}; release ${rule(releaseRule)}; reviewWaitDays ${P.reviewWaitDays}; fewRepliers ${P.fewRepliers}`;
  },
  "governance|constructed: proposal.kind KIP and no proposal vote rule": () => {
    const profile = { ...P, governance: { ...P.governance, votes: P.governance.votes.filter((rule) => rule.kind !== "proposal") } };
    try { buildKipRows({ entries: feedSample.entries, threads, roster, profile, now: KIP_NOW }); return "built"; } catch (error) { return `error: ${(error as Error).message}`; }
  },
  "governance|DataFusion profile": () => {
    const preset = asfPreset({ project: "datafusion", devList: "dev" });
    const fromPreset = JSON.stringify(DATAFUSION_REVIEW_PROFILE.governance) === JSON.stringify(preset.governance);
    return `${fromPreset ? "asfPreset(datafusion, dev)" : "not from the preset"} with proposal.kind ${DATAFUSION_REVIEW_PROFILE.proposal.kind}; ` +
      `${kipCandidates(feedSample.entries, DATAFUSION_REVIEW_PROFILE).candidates.length === 0 ? "no KIP candidates" : "candidates"}`;
  },
  "governance|asfPreset({project: \"kafka\", devList: \"dev\"})": () => {
    const preset = asfPreset({ project: "kafka", devList: "dev" });
    return `mail list ${preset.mail?.list}; tags ${[preset.tags.vote, preset.tags.discuss, preset.tags.result].join(", ")}; roster adapter ${preset.governance.roster?.adapter}`;
  },
  // Q50, Q54, Q55
  "roster|samples/asf-roster-kafka.json": () => {
    const entry = (id: string) => roster.entries.find((item) => item.id === id)!;
    const show = (id: string) => `${id} ${entry(id).name} [${entry(id).roles.join(", ")}]`;
    return `${roster.entries.length} entries; ${roster.entries.filter((item) => item.roles.includes("pmc")).length} with pmc; ${show("smjn")}; ${show("jsancio")}`;
  },
  "roster|constructed: LDAP file also has projects.flink": () => {
    const projects = { projects: { kafka: { members: ["a"], owners: [] }, flink: { members: ["b"], owners: ["b"] } } };
    const parsedRoster = parseAsfRoster(projects, { people: { a: { name: "A" }, b: { name: "B" } } }, "kafka", KIP_NOW);
    return parsedRoster.entries.map((item) => item.id).join() === "a" ? "only kafka entries kept" : parsedRoster.entries.map((item) => item.id).join();
  },
  "roster|constructed: owners [\"p\"], members [\"c\"]": () => {
    const parsedRoster = parseAsfRoster({ projects: { kafka: { members: ["c"], owners: ["p"] } } }, { people: {} }, "kafka", KIP_NOW);
    return parsedRoster.entries.map((entry) => `${entry.id} [${entry.roles.join(", ")}]`).join("; ");
  },
  "roster|constructed: members has id \"ghostid\" with no people entry": () => {
    const parsedRoster = parseAsfRoster({ projects: { kafka: { members: ["ghostid"], owners: [] } } }, { people: {} }, "kafka", KIP_NOW);
    const [entry] = parsedRoster.entries;
    return `entry {id ${entry?.id}, name ${entry?.name}}; ${matchesRosterName(parsedRoster, "null", "committer") || matchesRosterName(parsedRoster, "", "committer") ? "matches" : "never matches"}`;
  },
  "roster|constructed: LDAP file without projects.kafka": () => {
    try { parseAsfRoster({ projects: {} }, { people: {} }, "kafka", KIP_NOW); return "empty roster"; } catch (error) {
      if (!(error instanceof RosterError)) throw error;
      const tally = tallyVote(threadStats(threadMessages("KAFKA-MAIL-e903d023")), proposalRule, null, KIP_NOW);
      return tally.plusBinding === 1 ? "roster failure; declared markers only" : "roster failure";
    }
  },
  "roster|constructed: projects.kafka with no members field": () => {
    try { parseAsfRoster({ projects: { kafka: { owners: [] } } }, { people: {} }, "kafka", KIP_NOW); return "empty roster"; } catch (error) {
      return error instanceof RosterError ? "roster failure" : "other error";
    }
  },
  // Q51, Q53, Q56
  "vote state|constructed: binding +1 × 3, binding -1 × 0, open exactly 72 h": () => { const tally = stateFor(3, 0, 72); return `${tally.state}; ${queuedText(tally.queued)}`; },
  "vote state|constructed: binding +1 × 3, open 71 h 59 min": () => { const tally = stateFor(3, 0, 71 + 59 / 60); return `${tally.state}; ${queuedText(tally.queued)}`; },
  "vote state|constructed: binding +1 × 3, binding -1 × 3, open 100 h": () => { const tally = stateFor(3, 3, 100); return `${tally.state}; ${queuedText(tally.queued)}`; },
  "vote state|constructed: binding +1 × 4, binding -1 × 1, open 100 h": () => {
    const tally = stateFor(4, 1, 100);
    return `${tally.state}; ${tallyText(tally, 3).includes("binding -1 × 1") ? "shows binding -1 × 1" : tallyText(tally, 3)}`;
  },
  "vote state|constructed: binding +1 × 3 and \"-1 (binding) until …\", open 100 h": () => {
    const tally = stateFor(3, 0, 100, ["-1 (binding) until the upgrade path is documented"]);
    return `${tally.state}; ${tallyText(tally, 3).includes("binding -1 × 1") ? "shows binding -1 × 1" : tallyText(tally, 3)}`;
  },
  "vote state|constructed: binding +1 × 3 and \"-1: no\" from a roster committer, open 100 h": () => {
    const members = [message("Starter", iso(KIP_NOW, -100 * HOUR), VOTE_SUBJECT, "Please vote.", "root"),
      ...["A", "B", "C"].map((author, index) => message(author, iso(KIP_NOW, -90 * HOUR + index), `Re: ${VOTE_SUBJECT}`, "+1 (binding)")),
      message("Sushant Mahajan", iso(KIP_NOW, -80 * HOUR), `Re: ${VOTE_SUBJECT}`, "-1: no")];
    const tally = tallyVote(threadStats(members), proposalRule, roster, KIP_NOW);
    return `${tally.state}; ${tallyText(tally, 3).includes("binding -1 × 1") ? "shows binding -1 × 1" : tallyText(tally, 3)}`;
  },
  "vote state|KIP-1279: binding +1 × 3 and an unclear +1 summary line": () => {
    const tally = voteRow("KIP-1279").tally;
    return tally.unclear === 1 ? `${tally.state}; ${queuedText(tally.queued)} (an unclear line makes the tally a lower bound)` : tally.state;
  },
  "vote state|constructed: binding +1 × 3 declared, 1 body unread, open 100 h": () => {
    const members = [message("Starter", iso(KIP_NOW, -100 * HOUR), VOTE_SUBJECT, "Please vote.", "root"),
      ...["A", "B", "C"].map((author, index) => message(author, iso(KIP_NOW, -90 * HOUR + index), `Re: ${VOTE_SUBJECT}`, "+1 (binding)")),
      message("D", iso(KIP_NOW, -80 * HOUR), `Re: ${VOTE_SUBJECT}`, null)];
    const tally = tallyVote(threadStats(members), proposalRule, roster, KIP_NOW);
    return `${tally.state}; ${queuedText(tally.queued)}`;
  },
  "vote state|constructed: no roster; binding +1 × 3 declared and an unmarked \"-1.\", open 100 h": () => {
    const members = [message("Starter", iso(KIP_NOW, -100 * HOUR), VOTE_SUBJECT, "Please vote.", "root"),
      ...["A", "B", "C"].map((author, index) => message(author, iso(KIP_NOW, -90 * HOUR + index), `Re: ${VOTE_SUBJECT}`, "+1 (binding)")),
      message("D", iso(KIP_NOW, -80 * HOUR), `Re: ${VOTE_SUBJECT}`, "-1.")];
    const tally = tallyVote(threadStats(members), proposalRule, null, KIP_NOW);
    return `${tally.state}; ${queuedText(tally.queued)}; "${tallyText(tally, 3)}"`;
  },
  "via roster|KIP-1262": () => {
    const tally = voteRow("KIP-1262").tally;
    return `binding ${tally.plusBinding} of ${proposalRule.quorum} (${tally.plusBindingViaRoster} via roster)`;
  },
  "via roster|KIP-1357: all 3 binding declared": () => (tallyText(voteRow("KIP-1357").tally, 3).includes("via roster") ? "has via roster" : "no \"via roster\" part"),
  "vote state|constructed: root not archived, binding +1 × 3, newest message 10 d old": () => {
    const tally = constructedTally([{ author: "A", body: "+1 (binding)" }, { author: "B", body: "+1 (binding)" }, { author: "C", body: "+1 (binding)" }], { root: false, openHours: 240 });
    return tally.state === "unresolved" ? `unresolved (a seen tally is never passing); ${queuedText(tally.queued)}` : tally.state;
  },
};

describe("Spec 015 slice 1 test plan", () => {
  test.each([...testPlanRows] as CaseRow[])("$id: $rule — $input", (row) => {
    const run = cases[`${row.rule}|${row.input}`];
    if (run === undefined) throw new Error(`No executable case for ${row.id} ${row.rule}: ${row.input}`);
    expect(run()).toBe(row.expected);
  });

  test("every executable case has a test-plan row", () => {
    const rows = new Set(testPlanRows.map((row) => `${row.rule}|${row.input}`));
    expect(Object.keys(cases).filter((key) => !rows.has(key))).toEqual([]);
  });
});
