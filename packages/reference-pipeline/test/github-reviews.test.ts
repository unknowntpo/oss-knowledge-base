/** Spec 022: the review ingestion's pure rules, run from the generated test plan. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  displayName,
  encodeReviewMonth,
  mergeMonthExtras,
  parseReviewMonthObject,
  pullAreaMeta,
  pullDisplayNames,
  resolveGithubReviewsRevision,
  isReviewBot,
  mergeReviewRows,
  nextKeysetPage,
  parsePullReviews,
  parseReviewMonth,
  parseReviewersTrailer,
  pullReviewsQuery,
  resolveBackfillFrom,
  resolveGithubReviews,
  reviewMonth,
  reviewRows,
  selectUpdatedPulls,
  trailerAgreement,
  type PullReviews,
  type ReviewNode,
  type ReviewRow,
  type UpdatedItem,
} from "../src/github-reviews";
import { testPlanRows } from "./github-reviews.cases";

const fixtures = join(import.meta.dir, "fixtures/github-reviews/");
const read = (name: string) => readFileSync(join(fixtures, name), "utf8");
const kafka = JSON.parse(read("graphql-pull-reviews-kafka.json"));
const datafusion = JSON.parse(read("graphql-pull-reviews-datafusion.json"));
const trailers = JSON.parse(read("reviewers-trailers-kafka-2026-10-07.json")) as {
  displayNames: Record<string, string | null>;
  pulls: (PullReviews & { trailer: string[] })[];
};

const EPOCH = "2000-01-01T00:00:00Z";
const kafkaPage = () => {
  const page = parsePullReviews(kafka, [23675, 23809, 99999999, 23165]);
  if (!page.ok) throw new Error(page.error);
  return page;
};
const kafkaPull = (number: number) => kafkaPage().pulls.find((pull) => pull.number === number)!;
const rowsOf = (pull: PullReviews, from = EPOCH, machineUsers: readonly string[] = []) => reviewRows(pull, { from, machineUsers });
const brief = (row: ReviewRow) =>
  `${row.reviewer} ${row.state}${row.isBot ? " bot" : row.reviewer === row.prAuthor ? " self" : ""} ${row.inlineComments} inline`;

const node = (id: number, submittedAt: string | null, extra: Partial<ReviewNode> = {}): ReviewNode => ({
  databaseId: id, author: { login: "ada", __typename: "User" }, state: "COMMENTED", submittedAt, commit: { oid: "c".repeat(40) }, comments: { totalCount: 0 }, ...extra,
});
const pull = (nodes: readonly ReviewNode[], totalCount = nodes.length, author: PullReviews["author"] = { login: "grace", __typename: "User" }): PullReviews =>
  ({ number: 7, author, reviews: { totalCount, nodes } });
const row = (id: number, submittedAt: string, extra: Partial<ReviewRow> = {}): ReviewRow => ({
  reviewId: id, pr: 7, prAuthor: "grace", reviewer: "ada", isBot: false, state: "COMMENTED", submittedAt, commit: null, inlineComments: 0, ...extra,
});
const flag = (value: string | undefined) => {
  try {
    const revision = resolveGithubReviewsRevision(value);
    return revision === undefined ? (resolveGithubReviews(value) ? "on" : "off") : revision === "metadata@2" ? "on, with areas" : "on";
  } catch (error) {
    return /not supported/u.test(String(error)) ? "error: not supported" : String(error);
  }
};
const bot = (login: string, type: string, machineUsers: readonly string[] = []) => (isReviewBot({ login, __typename: type }, machineUsers) ? "bot" : "not a bot");
const item = (number: number, minute: number, isPull = true): UpdatedItem =>
  ({ number, updated_at: `2026-10-13T10:${String(minute).padStart(2, "0")}:00Z`, ...(isPull ? { pull_request: true } : {}) });
const select = (items: readonly UpdatedItem[], maxPulls: number, morePages: boolean, previousCursor = "2026-10-13T09:00:00Z") => {
  const result = selectUpdatedPulls(items, { maxPulls, morePages, previousCursor });
  return { ...result, at: (number: number) => result.cursor === items.find((value) => value.number === number)?.updated_at };
};
const dismissal = (stored: readonly ReviewRow[], incoming: ReviewRow) => {
  const merged = mergeReviewRows(stored, [incoming]);
  const only = merged.rows[0]!;
  return `${merged.rows.length} row ${only.state}, ${only.stateBefore === undefined ? "no stateBefore" : `stateBefore ${only.stateBefore}`}; ` +
    (stored.length === 0 ? `added ${merged.added}` : `changed ${merged.changed}, dismissed ${merged.dismissed}`);
};
const malformed = (extra: Record<string, unknown>) => {
  try {
    parseReviewMonthObject({ ...JSON.parse(encodeReviewMonth("p", "2026-10", [])), ...extra }, "p", "2026-10");
    return "parsed";
  } catch (error) {
    const match = /malformed (pulls|people)/u.exec(String(error));
    return match === null ? String(error) : `error: malformed ${match[1]}`;
  }
};
const meta = (value: PullReviews) => {
  const result = pullAreaMeta(value);
  return `labels ${result.labels.join(", ") || "none"}; ${result.kips === undefined ? "no kips" : `kips ${result.kips.join(", ")}`}`;
};
const many = (oldest: string) => pull(Array.from({ length: 100 }, (_, index) => node(index + 1, index === 0 ? oldest : "2026-10-13T12:00:00Z")), 150);

const BACKFILL_NOW = Date.parse("2026-10-14T12:00:00Z");
const start = (value: string | null, now = BACKFILL_NOW) => {
  const result = resolveBackfillFrom(value, now);
  if (result.ok) return result.from;
  return `error: ${/required/u.test(result.error) ? "required" : /ISO/u.test(result.error) ? "not an ISO date" : /floor/u.test(result.error) ? "before the floor" : /past/u.test(result.error) ? "not in the past" : result.error}`;
};
const keysetItems = (last: string, count = 100) => Array.from({ length: count }, (_, index) => ({ number: index + 1, updated_at: index === count - 1 ? last : "2026-10-13T10:29:59Z" }));
const keyset = (since: string, page: number, items: readonly UpdatedItem[]) => {
  const next = nextKeysetPage({ since, page }, items);
  return `${next.since === since ? "same since" : `next since ${next.since.slice(11, 19)}`}; ${next.page === 1 ? "page 1" : "next page"}`;
};

const scenarios: Record<string, () => string> = {
  "backfill start|constructed: from=2026-04-14, now 2026-10-14T12:00:00Z": () => start("2026-04-14"),
  "backfill start|constructed: from=2026-04-14T06:30:00Z": () => start("2026-04-14T06:30:00Z"),
  "backfill start|constructed: from missing": () => start(null),
  "backfill start|constructed: from=14/04/2026": () => start("14/04/2026"),
  "backfill start|constructed: from exactly 395 days back (about 13 months)": () => (start(new Date(BACKFILL_NOW - 395 * 86_400_000).toISOString()).startsWith("error") ? "refused" : "accepted"),
  "backfill start|constructed: from 395 days and 1 s back": () => start(new Date(BACKFILL_NOW - 395 * 86_400_000 - 1_000).toISOString()),
  "backfill start|constructed: from equal to now": () => start(new Date(BACKFILL_NOW).toISOString()),
  "backfill window|constructed: window 2026-04-14..2026-10-13; reviews 1 s before from, at from, 1 s before until, at until": () => {
    const { rows } = reviewRows(pull([node(1, "2026-04-13T23:59:59Z"), node(2, "2026-04-14T00:00:00Z"), node(3, "2026-10-12T23:59:59Z"), node(4, "2026-10-13T00:00:00Z")]),
      { from: "2026-04-14T00:00:00.000Z", until: "2026-10-13T00:00:00.000Z", machineUsers: [] });
    return `${rows.length} rows${rows.map((value) => value.reviewId).join(",") === "2,3" ? " (at from, 1 s before until)" : ` ${rows.map((value) => value.reviewId).join(",")}`}`;
  },
  "keyset|constructed: page of 100 ending at 10:30:00": () => keyset("2026-10-13T09:00:00Z", 1, keysetItems("2026-10-13T10:30:00Z")),
  "keyset|constructed: page of 100 all inside 10:29:59..10:30:00, since 10:29:59": () => keyset("2026-10-13T10:29:59.000Z", 1, keysetItems("2026-10-13T10:30:00Z")),
  "flag|constructed: GITHUB_REVIEWS unset": () => flag(undefined),
  "flag|constructed: GITHUB_REVIEWS blank": () => flag("  "),
  "flag|constructed: GITHUB_REVIEWS metadata@1": () => flag("metadata@1"),
  "flag|constructed: GITHUB_REVIEWS true": () => flag("true"),
  "flag|constructed: GITHUB_REVIEWS metadata@2": () => flag("metadata@2"),
  "flag|constructed: GITHUB_REVIEWS metadata@3": () => flag("metadata@3"),
  "contract|constructed: a metadata@2 month (pulls, people) read by the rows-only parser": () => {
    const body = JSON.parse(encodeReviewMonth("p", "2026-10", [row(1, "2026-10-13T12:00:00Z")], { pulls: { "7": { labels: ["core"] } }, people: { ada: "Ada" } }));
    return `${parseReviewMonth(body, "p", "2026-10").length} row; ${"pulls" in body && "people" in body ? "extra fields ignored" : "no extra fields"}`;
  },
  "contract|constructed: a metadata@1 month read by the full parser": () => {
    const object = parseReviewMonthObject(JSON.parse(encodeReviewMonth("p", "2026-10", [row(1, "2026-10-13T12:00:00Z")])), "p", "2026-10");
    return `${object.rows.length} row; ${object.pulls === undefined ? "no pulls" : "pulls"}; ${object.people === undefined ? "no people" : "people"}`;
  },
  "contract|constructed: pulls keyed by a non-number": () => malformed({ pulls: { abc: { labels: [] } } }),
  "contract|constructed: people with a number as a name": () => malformed({ people: { ada: 7 } }),
  "area query|constructed: the metadata@2 query for pull request 1": () => {
    const query = pullReviewsQuery([1], { areas: true });
    const asks = [query.includes(" title "), query.includes("labels(first: 30)"), query.includes("... on User { name }")];
    const text = /\b(body|bodyText|bodyHTML|path|diffHunk|email)\b/u.exec(query);
    return `${asks[0] ? "title" : "no title"}; ${asks[1] ? "labels(first: 30)" : "no labels"}; ${asks[2] ? "User name" : "no name"}; ${text === null ? "no body, bodyText, bodyHTML, path, diffHunk or email" : `has ${text[1]}`}`;
  },
  "area query|constructed: the metadata@1 query for pull request 1": () => (/title|labels|on User/u.test(pullReviewsQuery([1])) ? "asks for metadata" : "no title, labels or name"),
  "area meta|constructed: title KAFKA-1: x (KIP-1071, KIP-932), labels triage, streams, streams": () =>
    meta({ ...pull([]), title: "KAFKA-1: x (KIP-1071, KIP-932)", labels: { totalCount: 3, nodes: [{ name: "triage" }, { name: "streams" }, { name: "streams" }] } }),
  "area meta|constructed: title kip-12 and KIP 13 and KIP-14a, no labels": () => meta({ ...pull([]), title: "kip-12 and KIP 13 and KIP-14a", labels: { totalCount: 0, nodes: [] } }),
  "display name|constructed: Chia-Ping Tsai for chia7712": () => displayName("Chia-Ping Tsai", "chia7712") ?? "dropped",
  "display name|constructed: a name with a control character, a zero-width space and doubled spaces": () => displayName(" Ada\u0007\u200b  Lovelace ", "ada") ?? "dropped",
  "display name|constructed: an address typed as the name": () => displayName("ada@example.org", "ada") ?? "dropped",
  "display name|constructed: the login typed as the name": () => displayName("Ada", "ada") ?? "dropped",
  "display name|constructed: 99 letters, then an emoji outside the BMP, then more": () => {
    const kept = displayName(`${"x".repeat(99)}😀tail`, "ada") ?? "";
    const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(kept)].length;
    return `${graphemes} graphemes; ${kept.endsWith("😀") ? "ends with the whole emoji" : "emoji cut"}; ${/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(kept) ? "lone surrogate" : "well-formed"}`;
  },
  "display name|constructed: a family emoji joined by ZWJ, and a right-to-left override": () => {
    const kept = displayName("Ada 👨\u200D👩\u200D👧 \u202Eecalevol", "ada") ?? "";
    return `${kept.includes("👨\u200D👩\u200D👧") ? "joiners kept" : "joiners removed"}; ${kept.includes("\u202E") ? "override kept" : "override removed"}`;
  },
  "display name|constructed: 150 characters": () => `${(displayName("x".repeat(150), "ada") ?? "").length} characters`,
  "display name|constructed: <script>alert(1)</script> as the name": () => displayName("<script>alert(1)</script>", "ada") ?? "dropped",
  "display names|constructed: a User author with a name, a User reviewer without, a Bot reviewer with one": () => {
    const names = pullDisplayNames(pull([
      node(1, "2026-10-13T12:00:00Z", { author: { login: "ada", __typename: "User", name: null } }),
      node(2, "2026-10-13T12:00:00Z", { author: { login: "copilot", __typename: "Bot", name: "Copilot" } }),
    ], 2, { login: "grace", __typename: "User", name: "Grace Hopper" }));
    return [...names].map(([login, name]) => `${login} ${name}`).join("; ");
  },
  "merge extras|constructed: stored #1 core, ada Ada; read #1 core, tests and #2 none; ada null, bob Bob": () => {
    const merged = mergeMonthExtras({ pulls: { "1": { labels: ["core"] } }, people: { ada: "Ada" } }, new Map([[2, { labels: [] }], [1, { labels: ["core", "tests"] }]]), new Map([["bob", "Bob"], ["ada", null]]));
    const again = mergeMonthExtras(merged, new Map([[1, { labels: ["core", "tests"] }]]), new Map([["bob", "Bob"]]));
    const pulls = Object.entries(merged.pulls!).map(([pr, value]) => `${pr} ${value.labels.join(",") || "none"}`).join("; ");
    const people = Object.entries(merged.people!).map(([login, name]) => `${login} ${name}`).join("; ");
    return `pulls ${pulls}; people ${people}; again ${JSON.stringify(again) === JSON.stringify(merged) ? "equal bytes" : "differs"}`;
  },
  "rows|recorded: kafka #23675 (Copilot twice, the author once, one approval)": () => {
    const { rows } = rowsOf(kafkaPull(23675));
    return `${rows.length} rows: ${rows.map(brief).join("; ")}`;
  },
  "rows|recorded: kafka #23809 (no review)": () => `${rowsOf(kafkaPull(23809)).rows.length} rows`,
  "rows|recorded: kafka #23165 (28 reviews)": () => {
    const { rows } = rowsOf(kafkaPull(23165));
    return `${rows.length} rows; ${rows.filter((value) => /^[0-9a-f]{40}$/u.test(value.commit ?? "")).length} with a commit; reviewId ${new Set(rows.map((value) => value.reviewId)).size === rows.length ? "unique" : "repeated"}`;
  },
  "rows|recorded: the batch asked for 99999999, which is not a pull request": () => {
    const page = kafkaPage();
    return `${page.pulls.length} pull requests parsed; dropped ${page.dropped.join(", ")}; cost ${page.cost}`;
  },
  "rows|constructed: a batch whose error has no alias path": () => {
    const page = parsePullReviews({ data: { repository: {} }, errors: [{ message: "Something went wrong" }] }, [1]);
    return page.ok ? "parsed" : `batch fails: ${page.error.startsWith("GraphQL error") ? "GraphQL error" : page.error}`;
  },
  "rows|constructed: a review node without a state": () => {
    const page = parsePullReviews({ data: { repository: { p7: pull([{ ...node(1, "2026-10-13T12:00:00Z"), state: undefined as never }]) } } }, [7]);
    return page.ok ? "parsed" : `batch fails: ${page.error.endsWith("malformed") ? "malformed" : page.error}`;
  },
  "rows|constructed: a PENDING review, and a review with no submittedAt": () =>
    `${rowsOf(pull([node(1, "2026-10-13T12:00:00Z", { state: "PENDING" }), node(2, null)])).rows.length} rows`,
  "rows|constructed: a review by a deleted account on a pull request by a deleted account": () => {
    const { rows } = rowsOf(pull([node(1, "2026-10-13T12:00:00Z", { author: null })], 1, null));
    return `${rows.length} row: reviewer ${rows[0]!.reviewer}, prAuthor ${rows[0]!.prAuthor}, ${rows[0]!.isBot ? "a bot" : "not a bot"}`;
  },
  "dismissed|recorded: datafusion #25716 (one review dismissed)": () => {
    const page = parsePullReviews(datafusion, [25716, 26150]);
    if (!page.ok) throw new Error(page.error);
    const dismissed = rowsOf(page.pulls[0]!).rows.filter((value) => value.state === "DISMISSED");
    return dismissed.map((value) => `${brief(value)}; ${value.stateBefore === undefined ? "no stateBefore" : value.stateBefore}`).join(" | ");
  },
  "dismissed|constructed: stored APPROVED, read again as DISMISSED": () =>
    dismissal([row(1, "2026-10-13T12:00:00Z", { state: "APPROVED" })], row(1, "2026-10-13T12:00:00Z", { state: "DISMISSED" })),
  "dismissed|constructed: stored DISMISSED with stateBefore CHANGES_REQUESTED, read again": () =>
    dismissal([row(1, "2026-10-13T12:00:00Z", { state: "DISMISSED", stateBefore: "CHANGES_REQUESTED" })], row(1, "2026-10-13T12:00:00Z", { state: "DISMISSED" })),
  "dismissed|constructed: first seen already DISMISSED": () => dismissal([], row(1, "2026-10-13T12:00:00Z", { state: "DISMISSED" })),
  "bot|recorded: copilot-pull-request-reviewer, type Bot, no [bot] suffix": () => {
    const author = kafkaPull(23675).reviews.nodes[0]!.author!;
    return author.login === "copilot-pull-request-reviewer" && author.__typename === "Bot" ? bot(author.login, author.__typename) : `unexpected ${JSON.stringify(author)}`;
  },
  "bot|constructed: github-actions[bot], type User": () => bot("github-actions[bot]", "User"),
  "bot|constructed: codecov-commenter, type User, in the project's machine users": () => bot("codecov-commenter", "User", ["codecov-commenter"]),
  "bot|constructed: codecov-commenter, type User, not in the machine users": () => bot("codecov-commenter", "User"),
  "bot|constructed: abbott, type User": () => bot("abbott", "User"),
  "merge|constructed: the same 3 reviews read twice": () => {
    const incoming = [row(1, "2026-10-13T12:00:00Z"), row(2, "2026-10-13T12:01:00Z"), row(3, "2026-10-13T12:02:00Z")];
    const first = mergeReviewRows([], incoming);
    const second = mergeReviewRows(first.rows, incoming);
    const equal = encodeReviewMonth("p", "2026-10", first.rows) === encodeReviewMonth("p", "2026-10", second.rows);
    return `${second.rows.length} rows; second read added ${second.added}, changed ${second.changed}; bytes ${equal ? "equal" : "differ"}`;
  },
  "merge|constructed: rows arriving newest first": () => {
    const merged = mergeReviewRows([], [row(9, "2026-10-13T12:02:00Z"), row(5, "2026-10-13T12:00:00Z"), row(4, "2026-10-13T12:00:00Z"), row(1, "2026-10-13T12:01:00Z")]);
    return merged.rows.map((value) => value.reviewId).join(",") === "4,5,1,9" ? "stored oldest first, ties by review id" : merged.rows.map((value) => value.reviewId).join(",");
  },
  "merge|constructed: a stored review read again with 2 more inline comments": () => {
    const merged = mergeReviewRows([row(1, "2026-10-13T12:00:00Z", { inlineComments: 1 })], [row(1, "2026-10-13T12:00:00Z", { inlineComments: 3 })]);
    return `${merged.rows.length} row with ${merged.rows[0]!.inlineComments === 3 ? "the new count" : "the old count"}; changed ${merged.changed}`;
  },
  "month|constructed: submitted 2026-09-30T23:59:59Z": () => reviewMonth("2026-09-30T23:59:59Z"),
  "month|constructed: submitted 2026-10-01T00:00:00Z": () => reviewMonth("2026-10-01T00:00:00Z"),
  "month|constructed: a month object with another project's id": () => {
    try {
      parseReviewMonth(JSON.parse(encodeReviewMonth("apache-kafka", "2026-10", [])), "apache-datafusion", "2026-10");
      return "parsed";
    } catch (error) {
      return /malformed/u.test(String(error)) ? "error: malformed" : String(error);
    }
  },
  "cap|constructed: 3 pull requests and 2 issues listed, cap 5, no more pages": () => {
    const result = select([item(1, 1), item(2, 2, false), item(3, 3), item(4, 4), item(5, 5, false)], 5, false);
    return `${result.numbers.length} pull requests; cursor ${result.at(5) ? "at the newest item (an issue)" : result.cursor}; ${result.truncated ? "truncated" : "not truncated"}`;
  },
  "cap|constructed: 6 pull requests listed, cap 5": () => {
    const result = select([1, 2, 3, 4, 5, 6].map((number) => item(number, number)), 5, false);
    return `${result.numbers.length} pull requests; cursor ${result.at(5) ? "at the 5th" : result.cursor}; ${result.truncated ? "truncated" : "not truncated"}`;
  },
  "cap|constructed: 5 pull requests listed, cap 5, more pages": () => {
    const result = select([...[1, 2, 3, 4, 5].map((number) => item(number, number)), item(6, 6, false)], 5, true);
    return `${result.numbers.length} pull requests; cursor ${result.at(6) ? "at the newest item" : result.cursor}; ${result.truncated ? "truncated" : "not truncated"}`;
  },
  "cap|constructed: 5 pull requests inside the overlap, then 6 newer ones, cap 5": () => {
    const result = select(Array.from({ length: 11 }, (_, index) => item(index + 1, index + 1)), 5, false, "2026-10-13T10:05:00Z");
    return `${result.numbers.length} pull requests; cursor ${result.at(10) ? "at the 5th newer one" : result.cursor}; ${result.truncated ? "truncated" : "not truncated"}`;
  },
  "cap|constructed: nothing listed": () => {
    const result = select([], 5, false);
    return `${result.numbers.length} pull requests; cursor ${result.cursor === "2026-10-13T09:00:00Z" ? "unchanged" : result.cursor}; ${result.truncated ? "truncated" : "not truncated"}`;
  },
  "cap|constructed: only items older than the stored cursor (the overlap)": () =>
    (select([item(1, 1), item(2, 2)], 5, false, "2026-10-13T10:03:00Z").cursor === "2026-10-13T10:03:00Z" ? "cursor unchanged" : "cursor moved back"),
  "cap|constructed: the same pull request on two pages": () => (select([item(1, 1), item(2, 2), item(1, 3)], 5, false).numbers.join(",") === "1,2" ? "read once" : "repeated"),
  "window|constructed: reviews 1 s before and exactly at the window start": () => {
    const { rows } = rowsOf(pull([node(1, "2026-10-12T23:59:59Z"), node(2, "2026-10-13T00:00:00Z")]), "2026-10-13T00:00:00.000Z");
    return `${rows.length} row${rows[0]?.reviewId === 2 ? " (the one at the start)" : ""}`;
  },
  "window|constructed: 150 reviews on one pull request, 100 read, the oldest read inside the window": () => {
    const result = rowsOf(many("2026-10-13T11:00:00Z"), "2026-10-13T00:00:00Z");
    return `${result.rows.length} rows; ${result.truncated ? "truncated" : "not truncated"}`;
  },
  "window|constructed: 150 reviews on one pull request, 100 read, the oldest read before the window": () =>
    (rowsOf(many("2026-10-12T11:00:00Z"), "2026-10-13T00:00:00Z").truncated ? "truncated" : "not truncated"),
  "no text|constructed: the query for pull requests 1 and 2": () => {
    const query = pullReviewsQuery([1, 2]);
    const asks = query.includes("p1: pullRequest(number: 1)") && query.includes("p2: pullRequest(number: 2)");
    const text = /\b(body|bodyText|bodyHTML|path|diffHunk)\b/u.exec(query);
    return `${asks ? "asks for p1 and p2" : "aliases missing"}; ${text === null ? "no body, bodyText, bodyHTML, path or diffHunk field" : `has ${text[1]}`}`;
  },
  "no text|recorded: the rows of kafka #23675": () =>
    `keys: ${[...new Set(rowsOf(kafkaPull(23675)).rows.flatMap((value) => Object.keys(value)))].sort().join(", ")}`,
  "trailer|constructed: Reviewers: Ada Lovelace <ada@example.org>, Grace Hopper <grace@example.org>": () =>
    parseReviewersTrailer("KAFKA-1: a fix (#1)\n\nReviewers: Ada Lovelace <ada@example.org>, Grace Hopper <grace@example.org>\n").join("; "),
  "trailer|constructed: Reviewers: someone bare@example.org, Ada Lovelace": () => parseReviewersTrailer("Reviewers: someone bare@example.org, Ada Lovelace").join("; "),
  "trailer|constructed: a message with no Reviewers line": () => parseReviewersTrailer("KAFKA-1: a fix\n\nCo-authored-by: Ada").join("; ") || "none",
  "trailer|recorded: 52 Kafka pull requests merged 2026-10-07..13": () => {
    const rows = trailers.pulls.flatMap((value) => rowsOf(value).rows);
    const result = trailerAgreement(trailers.pulls.map((value) => ({ pr: value.number, trailerNames: value.trailer.flatMap(parseReviewersTrailer) })), rows, trailers.displayNames);
    return `${result.pullsWithTrailer} with a trailer; ${result.trailerNames} names; ${result.matched} matched; unmatched ${result.unmatched.map((value) => `#${value.pr} ${value.name}`).join(", ")}; ${result.approversNotInTrailer.length} approvers not named`;
  },
  "trailer|recorded: the trailer fixture file": () => (read("reviewers-trailers-kafka-2026-10-07.json").includes("@") ? "has an address" : "no address"),
};

test.each([...testPlanRows])("$id: $rule — $input", (planned) => {
  const scenario = scenarios[`${planned.rule}|${planned.input}`];
  if (scenario === undefined) throw new Error(`No scenario for ${planned.rule}|${planned.input}`);
  expect(scenario()).toBe(planned.expected);
});

test("RV10: every scenario is a planned row", () => {
  expect(Object.keys(scenarios).sort()).toEqual(testPlanRows.map((planned) => `${planned.rule}|${planned.input}`).sort());
});
