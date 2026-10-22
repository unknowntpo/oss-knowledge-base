/**
 * Spec 019 amendment (7): the per-community identity settings the identity-link job reads — the
 * `corroborated` thresholds, the reviewed `identityLinks` list and the roster adapter. Browser-safe.
 */
import { activityPersonId } from "./activity";
import { KAFKA_COMMITTERS_URL, uniqueCommitterPairs, type CommittersCaptureV1 } from "./committers";
import { KAFKA_COMMITTERS_CAPTURE } from "./kafka-committers.capture";

/** The rule revision the job runs and the flag value that turns it on (`IDENTITY_LINKS`). */
export const IDENTITY_LINKS_REVISION = "corroborated@1";

/** Thresholds of `corroborated@1`; changing a number is a new revision and a new precision check. */
export interface CorroborationConfig {
  /** Edge A's issue keys (`KAFKA-`), read with the search profile's identifier pattern. */
  readonly issueKey: string;
  /** Edge A: distinct keys a pair needs. */
  readonly minIssues: number;
  /** Edge A: the pair's count is at least this many times every competing pairing. */
  readonly dominance: number;
  /** Edge B: distinct KIPs a dev@ ↔ Jira pair needs (no competitor allowed). */
  readonly minKips: number;
}

/**
 * One reviewed entry of `identityLinks`: two identity keys (`github:<login>`, `jira-account:<key>`,
 * `mail:<name key>`, `asf:<id>`), a public evidence URL, the date and the reviewer. `remove: true`
 * suppresses the pair (a pair a source still states but the owner knows to be wrong).
 */
export interface DeclaredLinkV1 {
  readonly a: string;
  readonly b: string;
  readonly evidence: string;
  readonly date: string;
  readonly reviewer: string;
  readonly remove?: true;
}

export interface PeopleIdentityProfile {
  readonly projectId: string;
  /** Absent: the job skips the project (DataFusion). */
  readonly corroboration?: CorroborationConfig;
  readonly identityLinks: readonly DeclaredLinkV1[];
  /** The roster cache the job reads (`internal/rosters/v1/<adapter>/<project>.json`), or none. */
  readonly roster: { readonly adapter: string; readonly project: string } | null;
  /** The committers capture's date (`/health` `inputs.committersAt`), when the profile has one. */
  readonly committersAt?: string;
}

const IDENTITY_KEY = /^(?:github:[a-z0-9](?:[a-z0-9-]{0,38})|jira-account:[A-Za-z0-9._@-]{1,100}|mail:\S.{0,199}|asf:[a-z0-9._-]{1,64})$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * W104: whether an entry may make a link. The evidence must be an `https` URL (the owner's TODO
 * example is rejected), both keys well formed and different, a date and a reviewer.
 */
export function validDeclaredLink(entry: DeclaredLinkV1): boolean {
  let url: URL | undefined;
  try {
    url = new URL(entry.evidence);
  } catch {
    url = undefined;
  }
  return url?.protocol === "https:" && IDENTITY_KEY.test(entry.a) && IDENTITY_KEY.test(entry.b) && entry.a !== entry.b &&
    DATE.test(entry.date) && entry.reviewer.trim() !== "" && (entry.remove === undefined || entry.remove === true);
}

/** Owner resolution 3: one `declared` entry per committers-page pair (`github:<login>` ↔ `mail:<name key>`). */
export function committerLinks(capture: CommittersCaptureV1): readonly DeclaredLinkV1[] {
  return uniqueCommitterPairs(capture.committers).map((pair) => ({
    a: `github:${pair.login.toLowerCase()}`,
    b: activityPersonId("mail", pair.name)!,
    evidence: KAFKA_COMMITTERS_URL,
    date: pair.date,
    reviewer: pair.reviewer,
  }));
}

/** `--blind` (W103): the committers page's entries left out, so the precision check cannot be hidden by them. */
export function isCommitterLink(entry: DeclaredLinkV1): boolean {
  return entry.evidence === KAFKA_COMMITTERS_URL && entry.remove === undefined;
}

/**
 * Owner resolution 2: the owner's own entry, a design until he supplies the public URL. It is not
 * in `identityLinks`: its evidence is not an `https` URL, so `validDeclaredLink` rejects it (W104).
 */
export const OWNER_DECLARED_EXAMPLE: DeclaredLinkV1 = {
  a: "github:unknowntpo",
  b: "mail:eric chang",
  evidence: "TODO(owner): public URL where Eric Chang states the GitHub login unknowntpo",
  date: "2026-10-21",
  reviewer: "unknowntpo",
};

export const KAFKA_IDENTITY_PROFILE: PeopleIdentityProfile = {
  projectId: "apache-kafka",
  corroboration: { issueKey: "KAFKA-", minIssues: 3, dominance: 3, minKips: 2 },
  identityLinks: [
    ...committerLinks(KAFKA_COMMITTERS_CAPTURE),
    // TODO(owner): add OWNER_DECLARED_EXAMPLE here with its public evidence URL (owner resolution 2).
  ],
  roster: { adapter: "asf", project: "kafka" },
  committersAt: KAFKA_COMMITTERS_CAPTURE.capturedAt,
};

export const DATAFUSION_IDENTITY_PROFILE: PeopleIdentityProfile = {
  projectId: "apache-datafusion",
  identityLinks: [],
  roster: null,
};

export const PEOPLE_IDENTITY_PROFILES: readonly PeopleIdentityProfile[] = [KAFKA_IDENTITY_PROFILE, DATAFUSION_IDENTITY_PROFILE];
