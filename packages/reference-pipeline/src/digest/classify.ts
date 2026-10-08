/**
 * Spec 014 Behavior 6 and 16: the deterministic rules classifier (the fallback behind the
 * swappable ThreadClassifier), parsing of model classification output, and confidence gates.
 */
import type { DigestProfile, Thread, ThreadFeatures } from "./types";

export const ROUTINE_THRESHOLD = 0.6;
/** Slice 2d: chosen from the second Dev dry run's Clef confidences (Behavior 6); D34 labels refine it. */
export const TOPIC_THRESHOLD = 0.35;
export const RULES_REVISION = "digest-rules@1";

const ROUTINE_RULES: readonly RegExp[] = [
  /\b(bump|upgrade|update)\b.*\b(to \d|version|plugin)|version updates|dependenc|gradle|develocity|reproducible archives|build scans?\b|grgit|jgit/iu,
  /\bspeed up\b|\btests?\b|flaky|testbed|fuzzer/iu,
  /\b(doc|docs|documentation|javadoc|typo|grammar)\b|\.md\b/iu,
  /\((3|4)\.\d\)$|cherry[- ]pick/iu,
];

/** Kafka topic rules, first match wins; `other` otherwise. */
const KAFKA_TOPIC_RULES: readonly (readonly [string, RegExp])[] = [
  ["community", /committer|\bPMC\b|jira account|ci-approved|review request|cruise control|foundation/iu],
  ["releases", /\bRC\d|release|\[ANNOUNCE\] Apache Kafka/iu],
  ["share-groups", /share group|share partition|share consumer|KIP-1349|KIP-1289|\bDLQ\b/iu],
  ["security", /\bacl|authoriz|oauth|sasl|\btls\b|\bssl\b|jwks|gssapi|kerberos|login|principal|\bCVE\b|KeyFactory|lz4|snappy|zstd|compression/iu],
  ["group-coordination", /assignor|assignment|rebalance|group coordinator|coordinator|static member|REMAIN_IN_GROUP|heartbeat|consumer group|streams group|LeaveGroup/iu],
  ["storage", /remote|tiered|diskless|log dir|segment|FileRecords|compaction|KIP-1023|KIP-1163|KIP-1165|UnifiedLog|time index/iu],
  ["streams", /\bstreams\b|KTable|state store|topology|\bDSL\b|standby/iu],
  ["connect", /\bconnect\b|mirror ?maker|\bMM2\b|ReplaceField/iu],
  ["clients", /consumer|producer|client|fetch|RebalanceListener|telemetry/iu],
  ["kraft", /kraft|controller|quorum|metadata|migration/iu],
  ["observability", /\bmetrics?\b|monitoring/iu],
];

/** Deterministic fallback: title rules, confidence 0.6 on a match, else `other` at 0. */
export function rulesClassify(thread: Pick<Thread, "title">, profile: DigestProfile): ThreadFeatures {
  const routine = ROUTINE_RULES.some((rule) => rule.test(thread.title)) && !/jira account|ci-approved/iu.test(thread.title);
  const match = profile.projectId === "apache-kafka" ? KAFKA_TOPIC_RULES.find(([, rule]) => rule.test(thread.title)) : undefined;
  const topic = match !== undefined && profile.taxonomy.topics.includes(match[0]) ? match[0] : "other";
  return {
    topic,
    topicConfidence: topic === "other" ? 0 : TOPIC_THRESHOLD,
    routine,
    routineConfidence: routine ? ROUTINE_THRESHOLD : 0,
    source: "rules",
    model: RULES_REVISION,
  };
}

/** Behavior 6 gates: the effective topic and whether the thread goes to routine. */
export function placement(features: ThreadFeatures): { topic: string; routine: boolean } {
  return {
    topic: features.topicConfidence >= TOPIC_THRESHOLD ? features.topic : "other",
    routine: features.routine && features.routineConfidence >= ROUTINE_THRESHOLD,
  };
}

function confidence(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export interface ParsedClassification {
  readonly features: Map<string, ThreadFeatures>;
  /** Batch ids that got rules features, with the reason. */
  readonly fallbacks: Map<string, "not-json" | "schema" | "missing">;
}

/**
 * Behavior 16: non-JSON → whole batch to rules; a schema-violating or missing entry → that thread
 * to rules; unknown ids ignored; no retry.
 */
export function parseClassification(
  raw: string,
  batch: readonly Thread[],
  profile: DigestProfile,
  model: { model: string; prompt: string; generatedAt: string },
): ParsedClassification {
  const features = new Map<string, ThreadFeatures>();
  const fallbacks = new Map<string, "not-json" | "schema" | "missing">();
  const fallback = (thread: Thread, reason: "not-json" | "schema" | "missing") => {
    features.set(thread.displayId, rulesClassify(thread, profile));
    fallbacks.set(thread.displayId, reason);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    for (const thread of batch) fallback(thread, "not-json");
    return { features, fallbacks };
  }
  const items = Array.isArray(parsed) ? parsed : (parsed as { threads?: unknown } | null)?.threads;
  if (!Array.isArray(items)) {
    for (const thread of batch) fallback(thread, "not-json");
    return { features, fallbacks };
  }
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of items) {
    if (item !== null && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
      byId.set((item as { id: string }).id, item as Record<string, unknown>);
    }
  }
  for (const thread of batch) {
    const item = byId.get(thread.displayId);
    if (item === undefined) {
      fallback(thread, "missing");
      continue;
    }
    const { topic, topicConfidence, routine, routineConfidence } = item;
    if (typeof topic !== "string" || !profile.taxonomy.topics.includes(topic) || !confidence(topicConfidence)
      || typeof routine !== "boolean" || !confidence(routineConfidence)) {
      fallback(thread, "schema");
      continue;
    }
    features.set(thread.displayId, { topic, topicConfidence, routine, routineConfidence, source: "model", ...model });
  }
  return { features, fallbacks };
}
