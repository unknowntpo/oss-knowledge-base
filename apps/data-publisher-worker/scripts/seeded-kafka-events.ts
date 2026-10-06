import type { DomainEventV1 } from "@oss-knowledge-base/domain";
import { jiraEventsFrom, mailEventFrom } from "@oss-knowledge-base/reference-pipeline";

/**
 * Spec 012 K24–K26: deterministic dev@ and KAFKA Jira events at the volume measured on
 * 2026-10-06, built through the real connectors' event builders. At scale 1, within 30 days:
 * about 330 human dev@ messages in threads of about 3.5, 650 Jira issues, and 270 comments in
 * the window. About 15% of issues name a KIP and 20% of subjects name a KIP from the same
 * small range, and 10% of subjects cite an issue key, so a share of issues is published.
 */
export interface SeededKafkaEventsOptions {
  readonly scale: number;
  readonly seed: number;
  readonly materializedAt: string;
}

const WINDOW_MS = 30 * 86_400_000;
const WORDS = [
  "consumer", "producer", "broker", "partition", "offset", "rebalance", "coordinator", "fetch",
  "transaction", "replica", "leader", "metadata", "controller", "quorum", "raft", "share", "group",
  "tiered", "storage", "streams", "connect", "mirror", "cluster", "the", "a", "we", "should", "vote",
  "+1", "binding", "thanks", "I", "think", "proposal", "compatibility", "upgrade", "config", "default",
];
const TWO_BYTE = ["…", "’", "—", "é"];

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function generateSeededKafkaEvents(options: SeededKafkaEventsOptions): DomainEventV1[] {
  const next = random(options.seed * 7919 + 17);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
  const text = (words: number) => Array.from({ length: words }, () => (next() < 0.05 ? pick(TWO_BYTE) : pick(WORDS))).join(" ");
  const end = Date.parse(options.materializedAt);
  const time = () => end - Math.floor(next() * WINDOW_MS);
  const kip = () => `KIP-${1200 + Math.floor(next() * 120)}`;
  const issueCount = Math.round(650 * options.scale);
  const firstKey = 30_000;
  const events: DomainEventV1[] = [];

  const messages = Math.round(330 * options.scale);
  let threadSubject = "";
  for (let index = 0; index < messages; index += 1) {
    if (index === 0 || next() < 1 / 3.5) {
      const roll = next();
      const topic = roll < 0.2 ? `[DISCUSS] ${kip()}: ${text(4)}` :
        roll < 0.3 ? `[DISCUSS] KAFKA-${firstKey + Math.floor(next() * issueCount)} ${text(4)}` : text(6);
      threadSubject = topic;
    }
    const parsed = mailEventFrom({
      mid: `seed${options.seed}m${index}`,
      epoch: Math.floor(time() / 1000),
      subject: next() < 0.7 && index > 0 ? `Re: ${threadSubject}` : threadSubject,
      from: `${pick(WORDS)} ${pick(WORDS)} <x...@example.org>`,
      body: text(40),
    }, options.materializedAt);
    if (parsed.kind === "event") events.push(parsed.event);
  }

  const comments = Math.round(270 * options.scale);
  const commentsPerIssue = new Map<number, number>();
  for (let index = 0; index < comments; index += 1) {
    const issue = Math.floor(next() * issueCount);
    commentsPerIssue.set(issue, (commentsPerIssue.get(issue) ?? 0) + 1);
  }
  for (let index = 0; index < issueCount; index += 1) {
    const updated = new Date(time()).toISOString().replace("Z", "+0000");
    const parsed = jiraEventsFrom({
      key: `KAFKA-${firstKey + index}`,
      fields: {
        summary: text(7),
        description: `${next() < 0.15 ? `This tracks ${kip()}. ` : ""}${text(60)}`,
        status: { name: pick(["Open", "In Progress", "Patch Available", "Resolved", "Open"]) },
        updated,
        reporter: { name: pick(WORDS), displayName: `${pick(WORDS)} ${pick(WORDS)}` },
        comment: {
          comments: Array.from({ length: commentsPerIssue.get(index) ?? 0 }, (_, comment) => ({
            id: `${index}${comment}`,
            author: { name: pick(WORDS), displayName: `${pick(WORDS)} ${pick(WORDS)}` },
            body: text(45),
            created: updated,
            updated,
          })),
        },
      },
    }, options.materializedAt);
    if (parsed.kind === "events") events.push(...parsed.events);
  }
  return events;
}
