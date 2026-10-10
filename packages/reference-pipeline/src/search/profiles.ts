/**
 * Spec 016 Behavior 3 and 12: the search fields of each project profile. The publisher indexes
 * with these patterns and the Pages reader queries with them, so both import this module. It is
 * data only (one type import) because the reader bundles it.
 */
import type { IdentifierPatternV1, IdentifierProfilesV1 } from "@oss-knowledge-base/search";

export interface SearchProfile {
  readonly projectId: string;
  /** Identifier families of the project; a bare number in a query lists all of them. */
  readonly identifiers: readonly IdentifierPatternV1[];
}

/**
 * A GitHub issue or pull request number. A title or a query writes it `#770`; a record's own
 * number is only in its id, and a comment's id (`…:pull:770:comment:9`) is not the pull request.
 */
const GITHUB_NUMBER: IdentifierPatternV1 = {
  kind: "github-number",
  canonicalPrefix: "#",
  textPattern: "(?<![\\w#])#(\\d+)\\b",
  recordIdPattern: ":github:(?:pull|issue):(\\d+)$",
};

/**
 * Kafka: KIP numbers, Jira keys, GitHub numbers. The hyphen is optional (`KIP770`); a space is
 * not a spelling, because `Kafka 4.2.0` is a version, not `KAFKA-4`.
 */
export const KAFKA_SEARCH_PROFILE: SearchProfile = {
  projectId: "apache-kafka",
  identifiers: [
    { kind: "kip", canonicalPrefix: "KIP-", textPattern: "\\bKIP-?(\\d+)\\b" },
    {
      kind: "jira",
      canonicalPrefix: "KAFKA-",
      textPattern: "\\bKAFKA-?(\\d+)\\b",
      recordIdPattern: ":jira:issue:KAFKA-(\\d+)$",
    },
    GITHUB_NUMBER,
  ],
};

export const DATAFUSION_SEARCH_PROFILE: SearchProfile = {
  projectId: "apache-datafusion",
  identifiers: [GITHUB_NUMBER],
};

export const SEARCH_PROFILES: readonly SearchProfile[] = [KAFKA_SEARCH_PROFILE, DATAFUSION_SEARCH_PROFILE];

/** The profiles' identifier patterns keyed by project, as a `bm25-reference@2` lexical config takes them. */
export const searchIdentifierProfiles: IdentifierProfilesV1 = Object.fromEntries(
  SEARCH_PROFILES.map((profile) => [profile.projectId, profile.identifiers]),
);
