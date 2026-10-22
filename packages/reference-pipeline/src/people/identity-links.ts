/**
 * Spec 019 amendment (7): the identity-link table (`osskb.identity-links.v1`). A pure computation
 * from facts the activity log already holds, the roster and the profile's reviewed list; the
 * identity-link job reads the objects and writes the table. Browser-safe.
 *
 * Bases, strongest first: `roster` (a dev@ name equal to a roster name unique in the roster),
 * `declared` (the profile's `identityLinks`), `corroborated` (W69–W72):
 * - edge A, GitHub ↔ Jira: a pull request's `KAFKA-n` paired with the issue's assignee; a pair
 *   with at least `minIssues` distinct keys and `dominance` times every competing pairing;
 * - edge B, Jira ↔ dev@: a KIP's discussion starter paired with the reporter or assignee of an
 *   issue whose title names the KIP and whose display name has the starter's name key; at least
 *   `minKips` distinct KIPs and no competitor at all;
 * - components: GitHub ↔ dev@ only through a Jira account with both edges; a corroborated
 *   component with two identities of one source publishes none of its links (`conflict`); one that
 *   would join two people the roster or the declared list keeps apart is dropped (`contradiction`).
 */
import { compileIdentifierProfiles } from "@oss-knowledge-base/search";

import { extractKeys } from "../kafka-rules";
import { searchIdentifierProfiles } from "../search/profiles";
import { nameKey } from "../review-queue/roster";
import type { Roster } from "../review-queue/roster";
import { activityPersonId, type ActivityAccountV1, type ActivityMonthV1 } from "./activity";
import { IDENTITY_LINKS_REVISION, isCommitterLink, validDeclaredLink, type CorroborationConfig, type DeclaredLinkV1 } from "./identity-profile";
import { KipStarterAccumulator, type KipStarterV1 } from "./kip-starters";

export const IDENTITY_LINKS_SCHEMA = "osskb.identity-links.v1";
export const identityLinksPrefix = "internal/identity/v1/";
export const identityLinksKey = (projectId: string) => `${identityLinksPrefix}${projectId}/links.json`;
export const IDENTITY_LINKS_LAST_RUN_KEY = `${identityLinksPrefix}last-run.json`;

const JIRA_BROWSE_URL = "https://issues.apache.org/jira/browse/";
/** The roster's public source (Spec 015): the ASF LDAP people file names each id. */
const ROSTER_EVIDENCE_URL = "https://whimsy.apache.org/public/public_ldap_people.json";

export type LinkBasis = "roster" | "declared" | "corroborated";

export interface LinkEvidenceV1 {
  /** `KAFKA-n` (edge A), `KIP-n` (edge B), the ASF id (roster), `declared`. */
  readonly id: string;
  readonly url: string;
  /** Edge A: the pull requests naming the key; edge B: the Jira issues naming the KIP. */
  readonly via?: readonly { readonly id: string; readonly url: string }[];
}

export interface IdentityLinkV1 {
  readonly a: string;
  readonly b: string;
  readonly basis: LinkBasis;
  readonly evidence: readonly LinkEvidenceV1[];
  /** Declared links: the entry's date and reviewer. */
  readonly date?: string;
  readonly reviewer?: string;
}

export interface IdentityMemberV1 {
  readonly id: string;
  /** A Jira account's display name (its key is not a name). */
  readonly display?: string;
}

export interface IdentityPersonV1 {
  readonly members: readonly IdentityMemberV1[];
  readonly links: readonly IdentityLinkV1[];
}

export interface IdentityLinksTableV1 {
  readonly schema: typeof IDENTITY_LINKS_SCHEMA;
  readonly revision: typeof IDENTITY_LINKS_REVISION;
  readonly projectId: string;
  /** The newest input time (activity `updatedAt`, roster `fetchedAt`, committers capture), so equal inputs give equal bytes (W73, W82). */
  readonly generatedAt: string;
  readonly inputs: {
    readonly coverageFrom: string;
    readonly months: readonly string[];
    readonly activityUpdatedAt: string;
    readonly rosterAt: string | null;
  };
  readonly people: readonly IdentityPersonV1[];
}

export interface IdentityLinkCounts {
  readonly links: { readonly roster: number; readonly declared: number; readonly corroborated: number };
  /** `dominance`: edge A below `dominance` times a competing pairing; `competitor`: edge B with any competing pairing. */
  readonly rejected: { readonly dominance: number; readonly competitor: number; readonly minimum: number; readonly conflict: number; readonly contradiction: number; readonly removed: number };
  readonly people: number;
  readonly kipStarters: number;
}

interface JiraFact {
  readonly month: string;
  readonly title: string;
  readonly url: string;
  readonly reporter: ActivityAccountV1 | null;
  readonly assignee: ActivityAccountV1 | null;
}

/**
 * The facts the rules need, accumulated one month at a time (Spec 009): pull-request authors per
 * issue key, the newest Jira entry per key (W84), dev@ identities and KIP starters.
 */
export class IdentityFacts {
  private readonly pulls = new Map<string, Map<string, Map<string, string>>>();
  private readonly jira = new Map<string, JiraFact>();
  private readonly mail = new Map<string, string>();
  private readonly starters = new KipStarterAccumulator();
  private readonly identifiers = compileIdentifierProfiles(searchIdentifierProfiles);
  private readonly bots: ReadonlySet<string>;

  constructor(private readonly projectId: string, private readonly issueKey: string, bots: readonly string[]) {
    this.bots = new Set(bots.map((login) => login.toLowerCase()));
  }

  add(month: ActivityMonthV1): void {
    for (const [key, thread] of Object.entries(month.threads)) {
      if (thread.source === "github" && thread.kind === "pull-request" && thread.author !== null) {
        const login = thread.author.slice("github:".length);
        if (this.bots.has(login) || login.endsWith("[bot]")) continue;
        for (const identifier of this.identifiers.identifiersOf(this.projectId, thread.title, "")) {
          const issue = identifier.toUpperCase();
          if (!issue.startsWith(this.issueKey)) continue;
          const authors = this.pulls.get(issue) ?? this.pulls.set(issue, new Map()).get(issue)!;
          (authors.get(thread.author) ?? authors.set(thread.author, new Map()).get(thread.author)!).set(key, thread.url);
        }
      } else if (thread.source === "jira" && thread.kind === "issue" && thread.assignee !== undefined) {
        const previous = this.jira.get(key);
        if (previous !== undefined && previous.month > month.month) continue;
        this.jira.set(key, { month: month.month, title: thread.title, url: thread.url, reporter: thread.reporter ?? null, assignee: thread.assignee });
      }
    }
    for (const [person, display] of Object.entries(month.people)) if (person.startsWith("mail:")) this.mail.set(person, display);
    this.starters.add(month);
  }

  kipStarters(): readonly KipStarterV1[] {
    return this.starters.result();
  }

  /** Every identity the facts name, for the suppression check (P-e). */
  identities(): readonly string[] {
    const ids = new Set<string>(this.mail.keys());
    for (const authors of this.pulls.values()) for (const github of authors.keys()) ids.add(github);
    for (const fact of this.jira.values()) {
      for (const account of [fact.reporter, fact.assignee]) {
        if (account === null) continue;
        ids.add(`jira-account:${account.key}`);
        // A Jira identity suppressed by its display-name id (`jira:<name>`) loses its account too.
        const byName = activityPersonId("jira", account.display);
        if (byName !== undefined) ids.add(byName);
      }
    }
    return [...ids].sort();
  }

  /** The `jira:<name>` id of each account, so a suppressed Jira name suppresses the account. */
  accountNames(): ReadonlyMap<string, string> {
    const names = new Map<string, string>();
    for (const fact of this.jira.values()) {
      for (const account of [fact.reporter, fact.assignee]) {
        const byName = account === null ? undefined : activityPersonId("jira", account.display);
        if (byName !== undefined) names.set(`jira-account:${account!.key}`, byName);
      }
    }
    return names;
  }

  /** GitHub identities that authored a pull request naming an issue key (the precision check's recall). */
  pullAuthors(): readonly string[] {
    return [...new Set([...this.pulls.values()].flatMap((authors) => [...authors.keys()]))].sort();
  }

  /** @internal */
  snapshot() {
    return { pulls: this.pulls, jira: this.jira, mail: this.mail };
  }
}

export interface ComputeIdentityLinksInput {
  readonly projectId: string;
  readonly config: CorroborationConfig;
  readonly facts: IdentityFacts;
  readonly roster: Roster | null;
  readonly identityLinks: readonly DeclaredLinkV1[];
  /** `--blind` / `?blind=1` (W103): leave the committers page's entries out. */
  readonly blind?: boolean;
  /** Identities that get no link at all (P-e), already resolved from the suppression digests. */
  readonly suppressed?: ReadonlySet<string>;
  readonly inputs: IdentityLinksTableV1["inputs"];
  readonly committersAt?: string;
}

type Edge = { a: string; b: string; basis: LinkBasis; evidence: LinkEvidenceV1[]; date?: string; reviewer?: string };

const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
const sourceOf = (id: string) => id.slice(0, id.indexOf(":"));

/** Natural order: `KAFKA-9` before `KAFKA-10`, then plain string order. */
export function naturalCompare(a: string, b: string): number {
  const left = /^(.*?)(\d+)$/u.exec(a);
  const right = /^(.*?)(\d+)$/u.exec(b);
  if (left !== null && right !== null && left[1] === right[1]) return Number(left[2]) - Number(right[2]) || (a < b ? -1 : a > b ? 1 : 0);
  return a < b ? -1 : a > b ? 1 : 0;
}

class UnionFind {
  private readonly parent = new Map<string, string>();
  find(id: string): string {
    let root = id;
    while (this.parent.has(root) && this.parent.get(root) !== root) root = this.parent.get(root)!;
    this.parent.set(id, root);
    return root;
  }
  union(a: string, b: string): void {
    const [left, right] = [this.find(a), this.find(b)].sort();
    if (left !== right) this.parent.set(right!, left!);
  }
}

function components(edges: readonly Edge[]): readonly (readonly string[])[] {
  const sets = new UnionFind();
  for (const edge of edges) sets.union(edge.a, edge.b);
  const groups = new Map<string, Set<string>>();
  for (const edge of edges) {
    for (const id of [edge.a, edge.b]) {
      const root = sets.find(id);
      (groups.get(root) ?? groups.set(root, new Set()).get(root)!).add(id);
    }
  }
  return [...groups.values()].map((group) => [...group].sort());
}

/** W69: edge A pairs and the pairs that qualify. */
function edgeA(facts: IdentityFacts, config: CorroborationConfig, rejected: { dominance: number; minimum: number }): Edge[] {
  const { pulls, jira } = facts.snapshot();
  // (github, jira-account) → issue key → pull requests naming it.
  const pairs = new Map<string, { github: string; account: string; keys: Map<string, Map<string, string>> }>();
  for (const [issue, authors] of pulls) {
    const assignee = jira.get(issue)?.assignee;
    if (assignee === null || assignee === undefined) continue;
    const account = `jira-account:${assignee.key}`;
    for (const [github, prs] of authors) {
      const key = `${github}\u0000${account}`;
      const pair = pairs.get(key) ?? pairs.set(key, { github, account, keys: new Map() }).get(key)!;
      pair.keys.set(issue, prs);
    }
  }
  const byGithub = new Map<string, number[]>();
  const byAccount = new Map<string, number[]>();
  for (const pair of pairs.values()) {
    (byGithub.get(pair.github) ?? byGithub.set(pair.github, []).get(pair.github)!).push(pair.keys.size);
    (byAccount.get(pair.account) ?? byAccount.set(pair.account, []).get(pair.account)!).push(pair.keys.size);
  }
  const edges: Edge[] = [];
  for (const pair of pairs.values()) {
    const n = pair.keys.size;
    if (n < config.minIssues) {
      rejected.minimum += 1;
      continue;
    }
    // Every other pairing of the login and of the account: remove this pair's own count once.
    const others = (counts: readonly number[]) => {
      const rest = [...counts];
      rest.splice(rest.indexOf(n), 1);
      return rest;
    };
    const competitor = Math.max(0, ...others(byGithub.get(pair.github)!), ...others(byAccount.get(pair.account)!));
    if (n < config.dominance * competitor) {
      rejected.dominance += 1;
      continue;
    }
    edges.push({
      a: pair.github, b: pair.account, basis: "corroborated",
      evidence: [...pair.keys].map(([issue, prs]) => ({
        id: issue, url: jira.get(issue)?.url ?? `${JIRA_BROWSE_URL}${issue}`,
        via: [...prs].map(([id, url]) => ({ id, url })).sort((x, y) => naturalCompare(x.id, y.id)),
      })),
    });
  }
  return edges;
}

/** W70: edge B pairs and the pairs that qualify. */
function edgeB(facts: IdentityFacts, config: CorroborationConfig, starters: readonly KipStarterV1[], rejected: { competitor: number; minimum: number }): Edge[] {
  const { jira } = facts.snapshot();
  const issuesByKip = new Map<string, [string, JiraFact][]>();
  for (const [issue, fact] of jira) {
    for (const kip of extractKeys(fact.title).kips) (issuesByKip.get(kip) ?? issuesByKip.set(kip, []).get(kip)!).push([issue, fact]);
  }
  const pairs = new Map<string, { mail: string; account: string; kips: Map<string, { thread: string; issues: Map<string, string> }> }>();
  for (const starter of starters) {
    for (const [issue, fact] of issuesByKip.get(starter.kip) ?? []) {
      for (const account of [fact.reporter, fact.assignee]) {
        if (account === null || activityPersonId("mail", account.display) !== starter.person) continue;
        const id = `jira-account:${account.key}`;
        const key = `${starter.person}\u0000${id}`;
        const pair = pairs.get(key) ?? pairs.set(key, { mail: starter.person, account: id, kips: new Map() }).get(key)!;
        const kip = pair.kips.get(starter.kip) ?? pair.kips.set(starter.kip, { thread: starter.url, issues: new Map() }).get(starter.kip)!;
        kip.issues.set(issue, fact.url);
      }
    }
  }
  const mailPairs = new Map<string, number>();
  const accountPairs = new Map<string, number>();
  for (const pair of pairs.values()) {
    mailPairs.set(pair.mail, (mailPairs.get(pair.mail) ?? 0) + 1);
    accountPairs.set(pair.account, (accountPairs.get(pair.account) ?? 0) + 1);
  }
  const edges: Edge[] = [];
  for (const pair of pairs.values()) {
    if (pair.kips.size < config.minKips) {
      rejected.minimum += 1;
      continue;
    }
    if (mailPairs.get(pair.mail)! > 1 || accountPairs.get(pair.account)! > 1) {
      rejected.competitor += 1;
      continue;
    }
    edges.push({
      a: pair.account, b: pair.mail, basis: "corroborated",
      evidence: [...pair.kips].map(([kip, value]) => ({
        id: kip, url: value.thread,
        via: [...value.issues].map(([id, url]) => ({ id, url })).sort((x, y) => naturalCompare(x.id, y.id)),
      })),
    });
  }
  return edges;
}

/** Roster links: a dev@ name equal (`nameKey`) to a roster name that is unique in the roster. */
function rosterEdges(roster: Roster | null, mail: ReadonlyMap<string, string>): Edge[] {
  if (roster === null) return [];
  const byName = new Map<string, string[]>();
  for (const entry of roster.entries) {
    if (entry.name === null || nameKey(entry.name) === "") continue;
    const key = nameKey(entry.name);
    (byName.get(key) ?? byName.set(key, []).get(key)!).push(entry.id);
  }
  const edges: Edge[] = [];
  for (const [person, display] of mail) {
    const ids = byName.get(nameKey(display));
    if (ids?.length !== 1) continue;
    edges.push({ a: `asf:${ids[0]}`, b: person, basis: "roster", evidence: [{ id: ids[0]!, url: ROSTER_EVIDENCE_URL }] });
  }
  return edges;
}

/** W69–W73: the table and its counts. */
export function computeIdentityLinks(input: ComputeIdentityLinksInput): { readonly table: IdentityLinksTableV1; readonly counts: IdentityLinkCounts; readonly starters: readonly KipStarterV1[] } {
  const rejected = { dominance: 0, competitor: 0, minimum: 0, conflict: 0, contradiction: 0, removed: 0 };
  const suppressed = input.suppressed ?? new Set<string>();
  const declared = input.identityLinks.filter((entry) => validDeclaredLink(entry) && !(input.blind === true && isCommitterLink(entry)));
  const removals = new Set(declared.filter((entry) => entry.remove === true).map((entry) => pairKey(entry.a, entry.b)));
  const starters = input.facts.kipStarters();
  const { mail, jira } = input.facts.snapshot();

  // W72: a removal entry suppresses its pair; a suppressed identity gets no link at all.
  const allowed = (edge: Edge) => {
    if (removals.has(pairKey(edge.a, edge.b)) || suppressed.has(edge.a) || suppressed.has(edge.b)) {
      rejected.removed += 1;
      return false;
    }
    return true;
  };
  const base: Edge[] = [
    ...rosterEdges(input.roster, mail),
    ...declared.filter((entry) => entry.remove !== true).map((entry): Edge => ({
      a: entry.a, b: entry.b, basis: "declared", evidence: [{ id: "declared", url: entry.evidence }], date: entry.date, reviewer: entry.reviewer,
    })),
  ].filter(allowed);
  const basePairs = new Set(base.map((edge) => pairKey(edge.a, edge.b)));
  const corroborated = [...edgeA(input.facts, input.config, rejected), ...edgeB(input.facts, input.config, starters, rejected)]
    .filter(allowed)
    // Precedence: a pair the roster or the declared list already links keeps that basis.
    .filter((edge) => !basePairs.has(pairKey(edge.a, edge.b)));

  // The people the roster and the declared list form, before any corroborated link.
  const baseSets = new UnionFind();
  for (const edge of base) baseSets.union(edge.a, edge.b);
  const baseIds = new Set(base.flatMap((edge) => [edge.a, edge.b]));
  const kept: Edge[] = [];
  for (const component of components(corroborated)) {
    const ids = new Set(component);
    const edges = corroborated.filter((edge) => ids.has(edge.a));
    const sources = component.map(sourceOf);
    if (new Set(sources).size !== sources.length) {
      rejected.conflict += 1;
      continue;
    }
    // Contradiction: two people the roster or the declared list keeps apart, or two identities of
    // one source that the base links do not already hold as one person.
    const touched = new Set(component.filter((id) => baseIds.has(id)).map((id) => baseSets.find(id)));
    const merged = new Set(component);
    for (const id of baseIds) if (touched.has(baseSets.find(id))) merged.add(id);
    const bySource = new Map<string, Set<string>>();
    for (const id of merged) (bySource.get(sourceOf(id)) ?? bySource.set(sourceOf(id), new Set()).get(sourceOf(id))!).add(id);
    const split = [...bySource.values()].some((group) => group.size > 1 && new Set([...group].map((id) => (baseIds.has(id) ? baseSets.find(id) : id))).size > 1);
    if (touched.size > 1 || split) {
      rejected.contradiction += 1;
      continue;
    }
    kept.push(...edges);
  }

  const all = [...base, ...kept];
  const accountDisplay = new Map<string, string>();
  for (const fact of jira.values()) {
    for (const account of [fact.reporter, fact.assignee]) if (account !== null) accountDisplay.set(`jira-account:${account.key}`, account.display);
  }
  const people = components(all).map((members): IdentityPersonV1 => {
    const ids = new Set(members);
    return {
      members: [...members].sort(naturalCompare).map((id) => (accountDisplay.has(id) ? { id, display: accountDisplay.get(id)! } : { id })),
      links: all.filter((edge) => ids.has(edge.a))
        .map((edge): IdentityLinkV1 => {
          const [a, b] = edge.a < edge.b ? [edge.a, edge.b] : [edge.b, edge.a];
          return {
            a, b, basis: edge.basis,
            evidence: [...edge.evidence].sort((x, y) => naturalCompare(x.id, y.id) || (x.url < y.url ? -1 : x.url > y.url ? 1 : 0)),
            ...(edge.date === undefined ? {} : { date: edge.date }),
            ...(edge.reviewer === undefined ? {} : { reviewer: edge.reviewer }),
          };
        })
        .sort((x, y) => naturalCompare(x.a, y.a) || naturalCompare(x.b, y.b) || (x.basis < y.basis ? -1 : x.basis > y.basis ? 1 : 0)),
    };
  }).sort((x, y) => naturalCompare(x.members[0]!.id, y.members[0]!.id));

  const generatedAt = [input.inputs.activityUpdatedAt, input.inputs.rosterAt, input.committersAt === undefined ? null : `${input.committersAt}T00:00:00.000Z`]
    .filter((value): value is string => value !== null)
    .map((value) => new Date(value).toISOString())
    .sort()
    .at(-1)!;
  const count = (basis: LinkBasis) => all.filter((edge) => edge.basis === basis).length;
  return {
    table: {
      schema: IDENTITY_LINKS_SCHEMA,
      revision: IDENTITY_LINKS_REVISION,
      projectId: input.projectId,
      generatedAt,
      inputs: { ...input.inputs, months: [...input.inputs.months].sort() },
      people,
    },
    counts: {
      links: { roster: count("roster"), declared: count("declared"), corroborated: count("corroborated") },
      rejected,
      people: people.length,
      kipStarters: starters.length,
    },
    starters,
  };
}

/**
 * P-e: the identities among `ids` (and the Jira accounts whose display-name id is suppressed) that
 * the suppression list names. The list holds digests, so each id is hashed.
 */
export async function suppressedIdentities(input: {
  readonly ids: readonly string[];
  readonly accountNames: ReadonlyMap<string, string>;
  readonly digests: readonly string[];
  readonly digest: (personId: string) => Promise<string>;
}): Promise<ReadonlySet<string>> {
  const suppressed = new Set<string>();
  if (input.digests.length === 0) return suppressed;
  const listed = new Set(input.digests);
  for (const id of input.ids) if (listed.has(await input.digest(id))) suppressed.add(id);
  for (const [account, byName] of input.accountNames) if (suppressed.has(byName)) suppressed.add(account);
  return suppressed;
}

export interface PrecisionReport {
  readonly corroboratedLinks: number;
  readonly committersTouched: number;
  readonly agree: number;
  readonly contradict: number;
  /** Corroborated components touching a committer that are neither agree nor contradict. */
  readonly committerUnlabelled: number;
  /** Corroborated links of components touching no committer: the labelled sample of W16. */
  readonly toLabel: number;
  /** Committer logins that wrote a pull request in the window, and how many of them are linked. */
  readonly recall: { readonly withEvidence: number; readonly linked: number };
  /** The gate: contradict 0 and committer unlabelled 0 (the labelled sample is checked in the enable PR). */
  readonly pass: boolean;
  readonly components: readonly { readonly members: readonly string[]; readonly committers: readonly string[]; readonly verdict: "agree" | "contradict" | "unlabelled" | "to-label" }[];
}

/**
 * Precision check step 3 (W89, W90): classify every corroborated component against the committers
 * page. The name comparison is an oracle for the check only, never a link basis.
 */
export function classifyPrecision(
  table: IdentityLinksTableV1,
  committers: readonly { readonly name: string; readonly login: string }[],
  authors: readonly string[] = [],
): PrecisionReport {
  const byLogin = new Map(committers.map((pair) => [`github:${pair.login.toLowerCase()}`, pair.login.toLowerCase()]));
  const byName = new Map(committers.map((pair) => [nameKey(pair.name).toLowerCase(), pair.login.toLowerCase()]));
  const nameOf = new Map(committers.map((pair) => [pair.login.toLowerCase(), nameKey(pair.name).toLowerCase()]));
  let corroboratedLinks = 0;
  let agree = 0;
  let contradict = 0;
  let committerUnlabelled = 0;
  let toLabel = 0;
  const touched = new Set<string>();
  const linked = new Set<string>();
  const components: PrecisionReport["components"][number][] = [];
  for (const person of table.people) {
    const links = person.links.filter((link) => link.basis === "corroborated");
    if (links.length === 0) continue;
    corroboratedLinks += links.length;
    const members = [...new Set(links.flatMap((link) => [link.a, link.b]))].sort();
    const display = new Map(person.members.map((member) => [member.id, member.display]));
    const names = members.flatMap((id) => {
      if (id.startsWith("mail:")) return [id.slice("mail:".length)];
      const shown = display.get(id);
      return id.startsWith("jira-account:") && shown !== undefined ? [nameKey(shown).toLowerCase()] : [];
    });
    const logins = members.filter((id) => byLogin.has(id)).map((id) => byLogin.get(id)!);
    const fromNames = names.filter((name) => byName.has(name)).map((name) => byName.get(name)!);
    const matched = [...new Set([...logins, ...fromNames])].sort();
    for (const login of logins) linked.add(login);
    let verdict: "agree" | "contradict" | "unlabelled" | "to-label";
    if (matched.length === 0) {
      verdict = "to-label";
      toLabel += links.length;
    } else {
      for (const login of matched) touched.add(login);
      if (matched.length > 1) verdict = "contradict";
      else if (logins.includes(matched[0]!) && names.includes(nameOf.get(matched[0]!)!)) verdict = "agree";
      else verdict = "unlabelled";
      if (verdict === "contradict") contradict += 1;
      else if (verdict === "agree") agree += 1;
      else committerUnlabelled += 1;
    }
    components.push({ members, committers: matched, verdict });
  }
  const withEvidence = new Set(authors.filter((id) => byLogin.has(id)).map((id) => byLogin.get(id)!));
  return {
    corroboratedLinks, committersTouched: touched.size, agree, contradict, committerUnlabelled, toLabel,
    recall: { withEvidence: withEvidence.size, linked: [...withEvidence].filter((login) => linked.has(login)).length },
    pass: contradict === 0 && committerUnlabelled === 0,
    components,
  };
}

/** Deterministic bytes: the table is built sorted, so equal inputs encode equally (W73). */
export function encodeIdentityLinks(table: IdentityLinksTableV1): string {
  return JSON.stringify(table);
}

/** Reads a stored table; throws on any other shape (the job then fails closed, W76). */
export function parseIdentityLinks(value: unknown, projectId: string): IdentityLinksTableV1 {
  const table = value as Partial<IdentityLinksTableV1> | null;
  if (table === null || typeof table !== "object" || table.schema !== IDENTITY_LINKS_SCHEMA || table.projectId !== projectId ||
      typeof table.generatedAt !== "string" || !Array.isArray(table.people) ||
      !table.people.every((person) => Array.isArray(person?.members) && Array.isArray(person?.links))) {
    throw new Error(`Identity links of ${projectId} are malformed`);
  }
  return table as IdentityLinksTableV1;
}
