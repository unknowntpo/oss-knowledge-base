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
  taxonomy: {
    revision: "kafka-topics@1",
    topics: KAFKA_TOPICS,
    // Slice 2c: at most 8 words each; Clef reads them as option criteria (Behavior 6).
    descriptions: {
      releases: "release candidates, release votes, release planning",
      "group-coordination": "group coordinator, rebalance protocol, assignors",
      clients: "producer, consumer, admin client behavior",
      "share-groups": "share groups and queues (KIP-932)",
      streams: "Kafka Streams library, state stores, topologies",
      connect: "Kafka Connect, connectors, MirrorMaker",
      storage: "log segments, tiered and diskless storage, replication",
      kraft: "KRaft controller, metadata log, quorum",
      security: "authentication, ACLs, TLS, CVEs, vulnerable dependencies",
      observability: "metrics, logging, monitoring, telemetry",
      community: "committers, PMC, governance, accounts, CI approvals",
      other: "none of the topics above",
      routine: "dependency bumps, build, tests, docs, backports",
    },
  },
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
