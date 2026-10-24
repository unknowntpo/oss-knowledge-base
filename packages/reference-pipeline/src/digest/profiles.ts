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
      other: "other",
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
  // D100: terms the 2026-10-20 Dev output mistranslated (offloading → 遷移, telemetry → 儀表板).
  // D106 (owner 2026-10-24): Kafka terms stay in English (Broker → 代理 and TLS named groups → 名稱組 on
  // Dev 2026-10-23), rotation → 輪替 (旋轉), and Taiwan wording instead of mainland terms (鏡像, 磁盤).
  glossary: {
    revision: "kafka-glossary@2",
    terms: [
      ["offloading", "卸載"], ["telemetry", "遙測"], ["assignor", "指派器"], ["rebalance", "再平衡"], ["rotation", "輪替"],
      ...([
        "broker", "controller", "KRaft", "consumer group", "share group", "streams group", "partition", "offset", "topic",
        "mirroring", "named group", "backport", "cherry-pick",
      ] as const).map((term) => [term, term] as const),
    ],
    avoid: [
      ["鏡像", "映像檔"], ["磁盤", "磁碟"], ["默認", "預設"], ["服務器", "伺服器"], ["數據", "資料"], ["信息", "資訊"],
      ["線程", "執行緒"], ["內存", "記憶體"], ["網絡", "網路"], ["消息", "訊息"], ["調用", "呼叫"], ["接口", "介面"],
      ["異步", "非同步"], ["緩存", "快取"], ["代碼", "程式碼"], ["軟件", "軟體"], ["集群", "叢集"], ["創建", "建立"],
      ["字段", "欄位"], ["模塊", "模組"], ["質量", "品質"],
    ],
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
