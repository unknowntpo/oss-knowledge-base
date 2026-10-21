/**
 * Spec 019 amendment (7), the profile page's KIPs (`PEOPLE_KIPS`, W74–W75, W80, W83, W87, W94–W96,
 * W98, W102, W109, W111): for one identity, every KIP where it, or an identity the link table joins
 * to it, is an author on the KIP page, the assignee of an issue the page's `JIRA:` field names, or
 * the person who started the dev@ discussion. Pure; the reader in `index.ts` supplies the two tables
 * and the activity months it already read. Browser-safe: only type imports from the jobs' modules.
 *
 * - One line per KIP and identity, with the first basis that holds (author, then assignee, then
 *   starter); the other bases that hold follow as "also …" (W94).
 * - An author name links to a profile only through a `declared` link naming `mail:<name key>`, or
 *   because `mail:<name key>` wrote in a dev@ thread whose title names exactly that KIP (W95). A
 *   name never creates or joins an identity.
 * - The assignee is a Jira account; GitHub and dev@ identities reach it only through the link
 *   table (W111). A Jira page is keyed by display name (`jira:<name>`, G76), so an account whose
 *   display name gives that id is the page's own account.
 * - Nothing here carries a Jira account key, a Confluence username or an address (W102, W110): an
 *   account is shown by its display name and linked to its `jira:<name>` page.
 */
import { extractKeys } from "../kafka-rules";
import { activityPersonId, type ActivityAccountV1, type ActivityMonthV1 } from "./activity";
import type { IdentityLinksTableV1, LinkBasis } from "./identity-links";
import type { KipAuthorsTableV1, KipPageV1 } from "./kip-authors-table";
import { KipStarterAccumulator, type KipStarterV1 } from "./kip-starters";

/** `identityLinksKey` of the identity-link job (`identity-links.ts`), kept here so the page does not bundle the job's rule code; a test keeps them equal. */
export const profileIdentityLinksKey = (projectId: string) => `internal/identity/v1/${projectId}/links.json`;
const IDENTITY_LINKS_SCHEMA = "osskb.identity-links.v1";
const JIRA_BROWSE = "https://issues.apache.org/jira/browse/";

/** `PEOPLE_KIPS` on the Pages project: "true" adds the section; anything else, or unset, reads nothing (W74). */
export function peopleKipsEnabled(value: string | undefined): boolean {
  return value?.trim() === "true";
}

// ---- what one activity month contributes (computed once per cached month) --------------------

/** The facts the section needs from one activity month, kept beside the cached month (W87: no new read). */
export interface KipMonthFacts {
  /** The month reduced to dev@ thread roots of KIP discussions, for `KipStarterAccumulator`. */
  readonly roots: ActivityMonthV1;
  /** Per KIP: the dev@ identities that wrote in a thread whose title names exactly that KIP (W95 rule 2). */
  readonly writers: ReadonlyMap<string, ReadonlySet<string>>;
  /** Per Jira issue key: the newest entry's assignee and its update time (W109). */
  readonly jira: ReadonlyMap<string, { readonly at: string; readonly assignee: ActivityAccountV1 | null }>;
  /** dev@ display names. */
  readonly mail: Readonly<Record<string, string>>;
  /** The earliest dev@ row flagged `opens` (W83: where thread starts are known). */
  readonly firstRoot: string | null;
}

export function kipMonthFacts(month: ActivityMonthV1): KipMonthFacts {
  const writers = new Map<string, Set<string>>();
  const jira = new Map<string, { at: string; assignee: ActivityAccountV1 | null }>();
  const rootRows = [];
  const rootThreads: Record<string, ActivityMonthV1["threads"][string]> = {};
  let firstRoot: string | null = null;
  for (const row of month.rows) {
    const thread = month.threads[row.thread];
    if (thread === undefined) continue;
    if (row.source === "mail" && row.kind === "message") {
      const kips = extractKeys(thread.title).kips;
      if (kips.length === 1) (writers.get(kips[0]!) ?? writers.set(kips[0]!, new Set()).get(kips[0]!)!).add(row.person);
      if (row.opens === true) {
        if (firstRoot === null || row.at < firstRoot) firstRoot = row.at;
        rootRows.push(row);
        rootThreads[row.thread] = thread;
      }
    } else if (row.source === "jira" && row.kind === "issue" && thread.assignee !== undefined) {
      const previous = jira.get(row.thread);
      if (previous === undefined || previous.at < row.at) jira.set(row.thread, { at: row.at, assignee: thread.assignee });
    }
  }
  const mail = Object.fromEntries(Object.entries(month.people).filter(([id]) => id.startsWith("mail:")));
  return { roots: { ...month, threads: rootThreads, rows: rootRows, people: mail }, writers, jira, mail, firstRoot };
}

// ---- reading the two tables at request time -------------------------------------------------

/** A stored link table, or undefined when it does not have the shape the section reads (W80: "links not available"). */
export function readableLinks(value: unknown, projectId: string): IdentityLinksTableV1 | undefined {
  const table = value as Partial<IdentityLinksTableV1> | null;
  const text = (item: unknown) => typeof item === "string" && item !== "";
  if (table === null || typeof table !== "object" || table.schema !== IDENTITY_LINKS_SCHEMA || table.projectId !== projectId ||
      !text(table.generatedAt) || !Array.isArray(table.people)) return undefined;
  const ok = table.people.every((person) => person !== null && typeof person === "object" &&
    Array.isArray(person.members) && person.members.every((member: Partial<IdentityLinksTableV1["people"][number]["members"][number]> | null) => text(member?.id) && (member!.display === undefined || typeof member!.display === "string")) &&
    Array.isArray(person.links) && person.links.every((link: Partial<IdentityLinksTableV1["people"][number]["links"][number]> | null) => text(link?.a) && text(link?.b) && ["roster", "declared", "corroborated"].includes(link!.basis as string) &&
      Array.isArray(link?.evidence) && link.evidence!.every((item: { id?: unknown; url?: unknown } | null) => text(item?.id) && text(item?.url))));
  return ok ? table as IdentityLinksTableV1 : undefined;
}

/** A stored authors table, or undefined when it does not have the shape the section reads (W98: "author lists not available"). */
export function readableAuthors(value: unknown): KipAuthorsTableV1 | undefined {
  const table = value as Partial<KipAuthorsTableV1> | null;
  const text = (item: unknown) => typeof item === "string" && item !== "";
  if (table === null || typeof table !== "object" || table.schema !== "osskb.kip-authors.v1" || !text(table.generatedAt) ||
      !text(table.coverageFrom) || !Array.isArray(table.pages)) return undefined;
  const ok = table.pages.every((page) => page !== null && typeof page === "object" && Number.isInteger(page.kip) && text(page.pageId) &&
    typeof page.title === "string" && text(page.url) && ["listed", "no-list", "unparsed"].includes(page.status) &&
    Array.isArray(page.authors) && page.authors.every((author: { name?: unknown } | null) => text(author?.name)) &&
    Array.isArray(page.issues) && page.issues.every((issue: Partial<KipPageV1["issues"][number]> | null) => text(issue?.key) && text(issue!.readAt) &&
      (issue!.assignee === null || (text(issue!.assignee?.key) && typeof issue!.assignee?.display === "string"))));
  return ok ? table as KipAuthorsTableV1 : undefined;
}

// ---- the response ----------------------------------------------------------------------------

/** An identity as the page may show it: never a Jira account key or an ASF id (W102, W110). */
export interface KipIdentityRefV1 {
  readonly source: "github" | "jira" | "mail" | "asf";
  readonly display: string;
  /** The profile id to link (`github:<login>`, `jira:<name>`, `mail:<name>`); absent for the roster. */
  readonly id?: string;
}

/** One link on the way from the page's identity to the identity that holds the basis. */
export interface KipLinkStepV1 {
  readonly to: KipIdentityRefV1;
  readonly basis: LinkBasis;
  /** `KAFKA-n` (corroborated GitHub ↔ Jira), `KIP-n` (corroborated Jira ↔ dev@), `declared`, `roster`; each with its URL. */
  readonly evidence: readonly { readonly id: string; readonly url: string }[];
}

export type KipFactV1 =
  | { readonly basis: "author"; readonly via?: readonly KipLinkStepV1[] }
  | { readonly basis: "assignee"; readonly issues: readonly string[]; readonly via?: readonly KipLinkStepV1[] }
  | { readonly basis: "starter"; readonly via?: readonly KipLinkStepV1[] };

export interface KipLineV1 {
  readonly kip: string;
  readonly title: string;
  /** The KIP page; absent when only the dev@ discussion names the KIP. */
  readonly pageUrl?: string;
  /** The bases that hold, in precedence order: the first is the label, the rest are "also …" (W94). */
  readonly facts: readonly KipFactV1[];
  /** The page's author list in page order (W96); absent without a list. */
  readonly authors?: readonly { readonly name: string; readonly person?: { readonly id: string; readonly rule: "declared" | "discussion" } }[];
  /** The issues the page's `JIRA:` field names, with each assignee's display name. */
  readonly issues?: readonly { readonly key: string; readonly url: string; readonly assignee: string | null }[];
  /** The earliest recorded `[DISCUSS]` thread of the KIP and who started it. */
  readonly discussion?: { readonly title: string; readonly url: string; readonly at: string; readonly starter: string };
}

export interface PersonKipsV1 {
  /** Newest KIP first. */
  readonly lines: readonly KipLineV1[];
  /** The activity log's coverage start: KIPs whose discussion started earlier are not listed (W75). */
  readonly startersFrom: string | null;
  /** The earliest recorded thread start; later than `startersFrom` when older rows predate the flag (W83). */
  readonly startsKnownFrom: string | null;
  readonly authorLists: { readonly available: false } | { readonly available: true; readonly coverageFrom: string; readonly generatedAt: string };
  readonly links: { readonly available: false } | { readonly available: true; readonly generatedAt: string };
}

export interface PersonKipsInput {
  /** The page's identity: `github:<login, lower case>`, `jira:<name>`, `mail:<name>`. */
  readonly personKey: string;
  readonly links: IdentityLinksTableV1 | undefined;
  readonly authors: KipAuthorsTableV1 | undefined;
  readonly months: readonly KipMonthFacts[];
  /** The activity log's coverage start in the profile's view. */
  readonly coverageFrom: string | null;
  /** P-e: identities that are never linked. */
  readonly suppressed?: ReadonlySet<string>;
}

const FACT_ORDER = { author: 0, assignee: 1, starter: 2 } as const;

/** A line's title: the page title or thread subject without a leading `[DISCUSS]` / `DISCUSS:` and `KIP-n:`. */
const kipTitle = (raw: string) => raw.replace(/^\s*(?:\[DISCUSS\]|DISCUSS\s*:)?\s*KIP-\d+\s*[:：-]?\s*/iu, "");
const kipNumber = (kip: string) => Number(kip.slice(4));

/** W74–W111: the identity's KIP lines and the section's notes. */
export function personKips(input: PersonKipsInput): PersonKipsV1 {
  const suppressed = input.suppressed ?? new Set<string>();
  const starters = new KipStarterAccumulator();
  const writers = new Map<string, Set<string>>();
  const jira = new Map<string, { at: string; assignee: ActivityAccountV1 | null }>();
  const mailNames: Record<string, string> = {};
  let firstRoot: string | null = null;
  for (const month of input.months) {
    starters.add(month.roots);
    for (const [kip, people] of month.writers) for (const person of people) (writers.get(kip) ?? writers.set(kip, new Set()).get(kip)!).add(person);
    for (const [key, entry] of month.jira) if ((jira.get(key)?.at ?? "") < entry.at) jira.set(key, entry);
    Object.assign(mailNames, month.mail);
    if (month.firstRoot !== null && (firstRoot === null || month.firstRoot < firstRoot)) firstRoot = month.firstRoot;
  }
  // dev@ display names: the activity log's, else the name a KIP page writes.
  for (const item of input.authors?.pages ?? []) {
    for (const author of item.authors) {
      const id = activityPersonId("mail", author.name);
      if (id !== undefined) mailNames[id] ??= author.name;
    }
  }
  const startersByKip = new Map<string, KipStarterV1>(starters.result().map((starter) => [starter.kip, starter]));

  // The link table: the page identity's person, and a path from it to every member.
  const graph = new LinkGraph(input.links, input.personKey);
  const display = (id: string): KipIdentityRefV1 => {
    const source = id.slice(0, id.indexOf(":"));
    const key = id.slice(source.length + 1);
    if (source === "github") return { source, display: key, id };
    if (source === "mail") return { source, display: mailNames[id] ?? key, id };
    if (source === "jira-account") {
      const name = graph.accountDisplay(id) ?? "";
      const page = activityPersonId("jira", name);
      return { source: "jira", display: name, ...(page === undefined ? {} : { id: page }) };
    }
    return { source: "asf", display: "ASF" };
  };
  const via = (target: string) => {
    const steps = graph.path(target);
    if (steps === undefined || steps.length === 0) return {};
    return {
      via: steps.map((step): KipLinkStepV1 => ({
        to: display(step.to),
        basis: step.basis,
        // The roster's evidence id is an ASF id: shown as "roster" with the public file's URL.
        evidence: step.evidence.map((item) => ({ id: step.basis === "roster" ? "roster" : item.id, url: item.url })),
      })),
    };
  };
  /** Whether the identity `id` is the page's identity or joined to it, and the path when joined. */
  const holds = (id: string) => graph.reaches(id);

  // W95: an author name's identity, if one of the two rules gives it.
  const authorPerson = (kip: string, name: string) => {
    const id = activityPersonId("mail", name);
    if (id === undefined || suppressed.has(id)) return undefined;
    if (graph.declared(id)) return { id, rule: "declared" as const, link: graph.profileOf(id) ?? id };
    if (writers.get(kip)?.has(id) === true) return { id, rule: "discussion" as const, link: id };
    return undefined;
  };
  // W109: the newer of the job's reading and the activity log's entry.
  const assigneeOf = (issue: KipPageV1["issues"][number]) => {
    const logged = jira.get(issue.key);
    return logged !== undefined && logged.at > issue.readAt ? logged.assignee : issue.assignee;
  };
  /** W111: the account is the page's own (a `jira:<name>` page) or joined to it through the table. */
  const holdsAccount = (account: ActivityAccountV1) =>
    (input.personKey.startsWith("jira:") && activityPersonId("jira", account.display) === input.personKey)
      ? { target: undefined }
      : holds(`jira-account:${account.key}`) ? { target: `jira-account:${account.key}` } : undefined;

  const pagesByKip = new Map<string, KipPageV1[]>();
  for (const page of input.authors?.pages ?? []) {
    const kip = `KIP-${page.kip}`;
    (pagesByKip.get(kip) ?? pagesByKip.set(kip, []).get(kip)!).push(page);
  }
  const lines: KipLineV1[] = [];
  const discussionOf = (starter: KipStarterV1 | undefined) => starter === undefined
    ? {}
    : { discussion: { title: starter.title, url: starter.url, at: starter.at, starter: starter.display } };
  const starterFact = (starter: KipStarterV1 | undefined): KipFactV1[] =>
    starter !== undefined && holds(starter.person) ? [{ basis: "starter", ...via(starter.person) }] : [];

  for (const kip of new Set([...pagesByKip.keys(), ...startersByKip.keys()])) {
    const pages = [...(pagesByKip.get(kip) ?? [])].sort((a, b) => (a.pageId < b.pageId ? -1 : 1));
    const starter = startersByKip.get(kip);
    // A renumbered KIP (two pages, one number): the discussion cannot be tied to one page, so it is a line of its own.
    const starterOnPage = pages.length === 1;
    for (const page of pages) {
      const authors = page.status === "listed" ? page.authors.map((author) => ({ name: author.name, person: authorPerson(kip, author.name) })) : [];
      const facts: KipFactV1[] = [];
      const author = authors.find((item) => item.person !== undefined && holds(item.person.id));
      if (author !== undefined) facts.push({ basis: "author", ...via(author.person!.id) });
      const assigned = new Map<string, string[]>();
      for (const issue of page.issues) {
        const assignee = assigneeOf(issue);
        const held = assignee === null ? undefined : holdsAccount(assignee);
        if (held === undefined) continue;
        const target = held.target ?? "";
        (assigned.get(target) ?? assigned.set(target, []).get(target)!).push(issue.key);
      }
      for (const [target, issues] of assigned) facts.push({ basis: "assignee", issues, ...(target === "" ? {} : via(target)) });
      if (starterOnPage) facts.push(...starterFact(starter));
      if (facts.length === 0) continue;
      lines.push({
        kip,
        title: kipTitle(page.title),
        pageUrl: page.url,
        facts: facts.sort((a, b) => FACT_ORDER[a.basis] - FACT_ORDER[b.basis]),
        ...(page.status === "listed" ? {
          authors: authors.map((item) => ({ name: item.name, ...(item.person === undefined ? {} : { person: { id: item.person.link, rule: item.person.rule } }) })),
        } : {}),
        issues: page.issues.map((issue) => ({ key: issue.key, url: `${JIRA_BROWSE}${issue.key}`, assignee: assigneeOf(issue)?.display ?? null })),
        ...(starterOnPage ? discussionOf(starter) : {}),
      });
    }
    if (!starterOnPage) {
      const facts = starterFact(starter);
      if (facts.length > 0) lines.push({ kip, title: kipTitle(starter!.title), facts, ...discussionOf(starter) });
    }
  }
  return {
    lines: lines.sort((a, b) => kipNumber(b.kip) - kipNumber(a.kip) || (a.pageUrl ?? "").localeCompare(b.pageUrl ?? "")),
    startersFrom: input.coverageFrom,
    startsKnownFrom: firstRoot,
    authorLists: input.authors === undefined
      ? { available: false }
      : { available: true, coverageFrom: input.authors.coverageFrom, generatedAt: input.authors.generatedAt },
    links: input.links === undefined ? { available: false } : { available: true, generatedAt: input.links.generatedAt },
  };
}

interface Step { readonly to: string; readonly basis: LinkBasis; readonly evidence: readonly { readonly id: string; readonly url: string }[] }

/**
 * The page identity's person in the link table. Starts: the page identity itself, and for a
 * `jira:<name>` page every account of that display name. Paths are breadth first, ties broken by
 * the table's (sorted) link order, so a response is deterministic.
 */
class LinkGraph {
  private readonly paths = new Map<string, readonly Step[]>();
  private readonly displays = new Map<string, string>();
  private readonly declaredIds = new Set<string>();
  private readonly people = new Map<string, readonly string[]>();

  constructor(table: IdentityLinksTableV1 | undefined, personKey: string) {
    const adjacent = new Map<string, Step[]>();
    for (const person of table?.people ?? []) {
      const members = person.members.map((member) => member.id);
      for (const member of person.members) {
        if (member.display !== undefined) this.displays.set(member.id, member.display);
        this.people.set(member.id, members);
      }
      for (const link of person.links) {
        if (link.basis === "declared") this.declaredIds.add(link.a).add(link.b);
        const evidence = link.evidence.map((item) => ({ id: item.id, url: item.url }));
        (adjacent.get(link.a) ?? adjacent.set(link.a, []).get(link.a)!).push({ to: link.b, basis: link.basis, evidence });
        (adjacent.get(link.b) ?? adjacent.set(link.b, []).get(link.b)!).push({ to: link.a, basis: link.basis, evidence });
      }
    }
    const starts = [personKey];
    if (personKey.startsWith("jira:")) {
      for (const [id, name] of this.displays) if (id.startsWith("jira-account:") && activityPersonId("jira", name) === personKey) starts.push(id);
    }
    const queue: string[] = [];
    for (const start of starts) {
      this.paths.set(start, []);
      queue.push(start);
    }
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const step of adjacent.get(current) ?? []) {
        if (this.paths.has(step.to)) continue;
        this.paths.set(step.to, [...this.paths.get(current)!, step]);
        queue.push(step.to);
      }
    }
  }

  reaches(id: string): boolean {
    return this.paths.has(id);
  }

  path(id: string): readonly Step[] | undefined {
    return this.paths.get(id);
  }

  accountDisplay(id: string): string | undefined {
    return this.displays.get(id);
  }

  /** W95 rule 1: a `declared` link names this identity. */
  declared(id: string): boolean {
    return this.declaredIds.has(id);
  }

  /** The profile an author name links to: the person's GitHub identity when it has one. */
  profileOf(id: string): string | undefined {
    return this.people.get(id)?.find((member) => member.startsWith("github:"));
  }
}
