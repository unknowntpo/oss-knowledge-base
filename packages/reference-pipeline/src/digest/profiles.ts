/** Spec 014 Behavior 23: the digest fields of each project profile. */
import type { DigestProfile } from "./types";

export const KAFKA_TOPICS = [
  "releases", "group-coordination", "clients", "share-groups", "streams", "connect", "storage",
  "kraft", "security", "observability", "community", "other",
] as const;

export const KAFKA_DIGEST_PROFILE: DigestProfile = {
  projectId: "apache-kafka",
  projectKey: "kafka",
  digest: true,
  sources: ["github", "mail", "jira"],
  taxonomy: { revision: "kafka-topics@1", topics: KAFKA_TOPICS },
  machineUsers: [],
  proposal: {
    kind: "KIP",
    keyPattern: "\\bKIP-\\d+\\b",
    issueKeyPattern: "\\bKAFKA-\\d+\\b",
    stages: [
      { key: "vote", badgeColor: "vote", detect: ["subject-tag:VOTE", "subject-tag:RESULT"] },
      { key: "discuss", badgeColor: "discuss", detect: ["subject-tag:DISCUSS"] },
      { key: "implementing", badgeColor: "implementing", detect: ["pr-title-key", "linked-issue-key"] },
    ],
    quorumNote: "proposal.apache-kafka.quorumNote",
  },
};

export const DATAFUSION_DIGEST_PROFILE: DigestProfile = {
  projectId: "apache-datafusion",
  projectKey: "datafusion",
  digest: false,
  sources: ["github"],
  taxonomy: { revision: "datafusion-topics@0", topics: ["other"] },
  machineUsers: ["adriangbot", "codecov-commenter"],
  proposal: { kind: null, keyPattern: "(?!)", issueKeyPattern: "(?!)", stages: [] },
};

/** Behavior 23: `kind: null` hides the section, its anchor, its stat, and the tab. */
export function proposalSectionVisible(profile: DigestProfile): boolean {
  return profile.proposal.kind !== null;
}
