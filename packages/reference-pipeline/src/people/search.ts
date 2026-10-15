/**
 * Spec 019 slice 3: person results for Search (`GET /api/people/:project?q=`). The index is every
 * identity whose profile answers 200, built from the same review months the profile reads and
 * through the same per-isolate cache, so a search costs no R2 read that a profile would not
 * (W43). No model, no Vectorize: matching is on the login, exact first, then prefixes.
 *
 * Slice 2b adds Jira and dev@ identities as more `PersonIndexEntry` values (keyed by their display
 * names); the response shape and the page do not change.
 */
import { DELETED_ACCOUNT } from "../github-reviews";
import {
  isBotLogin,
  PEOPLE_SUPPRESSED,
  peopleProject,
  personIdOf,
  profileMonths,
  readMonth,
  readState,
  suppressionDigest,
  type PeopleBucket,
  type PeopleProject,
} from "./index";

export const PEOPLE_SEARCH_SCHEMA = "osskb.people-search.v1";
/** W7: person results shown above the thread results, exact match included. */
export const PERSON_RESULTS_CAP = 3;
/** W41: a shorter query matches only an identical login. */
export const PERSON_PREFIX_MIN = 2;
/** A GitHub login, lower-cased: what a query must look like to be looked up at all (W41). */
const LOGIN_KEY = /^[a-z0-9][a-z0-9-]{0,38}$/u;

/** Slice 3 indexes GitHub logins; 2b widens this to its sources. */
export type PersonSource = "github";

export interface PersonMatchV1 {
  /** The profile route's id, e.g. `github:chia7712`. The page links by it and never parses it. */
  readonly id: string;
  readonly source: PersonSource;
  readonly display: string;
  readonly match: "exact" | "prefix";
}

export interface PeopleSearchV1 {
  readonly schema: typeof PEOPLE_SEARCH_SCHEMA;
  readonly project: string;
  /** The key the query was read as (lower-cased, without a leading `@`), or "" when it is not a login. */
  readonly query: string;
  readonly people: readonly PersonMatchV1[];
}

export type PeopleSearchRead =
  | { readonly status: 200; readonly body: PeopleSearchV1 }
  | { readonly status: 400 | 503; readonly body: { readonly error: string } };

/** One identity the search can find. */
export interface PersonIndexEntry {
  /** What a query is compared with: lower-cased. */
  readonly key: string;
  readonly id: string;
  readonly source: PersonSource;
  readonly display: string;
}

/** W41: the lower-cased login a query names (trimmed, one leading `@` dropped), or undefined. */
export function personQueryKey(query: string | null | undefined): string | undefined {
  if (typeof query !== "string") return undefined;
  let key = query.normalize("NFC").trim();
  if (key.startsWith("@")) key = key.slice(1);
  key = key.toLowerCase();
  return LOGIN_KEY.test(key) ? key : undefined;
}

/** W7: the exact key first, then keys starting with it in code-unit order. Uncapped; the caller caps. */
export function matchPeople(entries: readonly PersonIndexEntry[], key: string): PersonMatchV1[] {
  const result = (match: PersonMatchV1["match"]) => (entry: PersonIndexEntry): PersonMatchV1 =>
    ({ id: entry.id, source: entry.source, display: entry.display, match });
  const exact = entries.filter((entry) => entry.key === key);
  const prefix = key.length < PERSON_PREFIX_MIN
    ? []
    : entries.filter((entry) => entry.key !== key && entry.key.startsWith(key))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return [...exact.map(result("exact")), ...prefix.map(result("prefix"))];
}

/**
 * W40: every login with a counted review row in the 12-month view, as the profile counts it:
 * bots (listed, `[bot]`, or typed `Bot` in any row of the view) and the deleted account are left
 * out; a month that cannot be read is skipped. Throws when the review cursor is malformed.
 */
export async function peopleIndex(bucket: PeopleBucket, project: PeopleProject, nowMs: number): Promise<PersonIndexEntry[]> {
  const state = await readState(bucket, project.projectId, nowMs);
  if (state === undefined) return [];
  const months = profileMonths(nowMs, state.coverageFrom);
  if (months.length === 0) return [];
  const from = Math.max(Date.parse(state.coverageFrom), Date.parse(`${months[0]}-01T00:00:00.000Z`));
  const indexes = await Promise.all(months.map((month) => readMonth(bucket, project.projectId, month, nowMs).catch(() => undefined)));
  const learned = new Set(indexes.flatMap((index) => (index === undefined ? [] : [...index.bots])));
  const counted = (row: { readonly submittedAt: string }) => Date.parse(row.submittedAt) >= from;
  const entries = new Map<string, PersonIndexEntry | null>();
  for (const index of indexes) {
    if (index === undefined) continue;
    for (const [key, person] of index.people) {
      if (entries.has(key)) continue;
      const display = person.given.find(counted)?.reviewer ?? person.received.find(counted)?.prAuthor;
      if (display === undefined) continue;
      entries.set(key, key === DELETED_ACCOUNT || isBotLogin(display, project, learned)
        ? null
        : { key, id: personIdOf(display), source: "github", display });
    }
  }
  return [...entries.values()].filter((entry): entry is PersonIndexEntry => entry !== null);
}

/** `GET /api/people/:project?q=` (Spec 019 slice 3). */
export async function searchPeople(input: {
  readonly bucket: PeopleBucket;
  readonly projectKey: string | null | undefined;
  readonly query: string | null | undefined;
  readonly nowMs: number;
  /** Defaults to `PEOPLE_SUPPRESSED`; tests pass their own list (W40). */
  readonly suppressed?: Readonly<Record<string, readonly string[]>>;
}): Promise<PeopleSearchRead> {
  const project = peopleProject(input.projectKey);
  if (project === undefined) return { status: 400, body: { error: "Unknown project" } };
  const key = personQueryKey(input.query);
  const answer = (people: readonly PersonMatchV1[]): PeopleSearchRead =>
    ({ status: 200, body: { schema: PEOPLE_SEARCH_SCHEMA, project: project.projectKey, query: key ?? "", people } });
  if (key === undefined) return answer([]);
  let entries: readonly PersonIndexEntry[];
  try {
    entries = await peopleIndex(input.bucket, project, input.nowMs);
  } catch (error) {
    return { status: 503, body: { error: error instanceof Error ? error.message : "Unable to read the review store" } };
  }
  const suppressed = new Set((input.suppressed ?? PEOPLE_SUPPRESSED)[project.projectId] ?? []);
  const people: PersonMatchV1[] = [];
  for (const match of matchPeople(entries, key)) {
    if (people.length >= PERSON_RESULTS_CAP) break;
    if (suppressed.size > 0 && suppressed.has(await suppressionDigest(project.projectId, match.id))) continue;
    people.push(match);
  }
  return answer(people);
}
