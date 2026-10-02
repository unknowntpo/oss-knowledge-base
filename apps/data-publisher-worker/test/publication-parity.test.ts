import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { DomainEventV1 } from "@oss-knowledge-base/domain";
import type { GitHubPollResult } from "@oss-knowledge-base/github-publisher/github-connector";
import type { SerializedReferenceStateV1 } from "@oss-knowledge-base/reference-pipeline";
import {
  MANIFEST_KEY,
  SEARCH_CURRENT_KEY,
  type ImmutableProjectionObjectV1,
} from "@oss-knowledge-base/serving-contract";

import { generateSeededGitHubEvents } from "../scripts/seeded-github-events";
import {
  runDataPublication,
  type PipelineRunStatus,
  type PipelineStateRepository,
  type PublicationDestination,
} from "../src/pipeline";

/**
 * Spec 009 M3: for the same events and materializedAt, the published objects, evidence, and
 * pointers are byte-identical to the output recorded before the bounded-memory refactor.
 * Regenerate deliberately with UPDATE_PUBLICATION_PARITY=1.
 */
const GOLDEN = new URL("./fixtures/publication-parity.v1.json", import.meta.url);
const FIRST_RUN_AT = "2026-10-02T01:42:16.361Z";
const SECOND_RUN_AT = "2026-10-02T02:42:16.361Z";

interface ParityRecord {
  readonly objects: Readonly<Record<string, { readonly sha256: string; readonly byteLength: number }>>;
  readonly pointers: Readonly<Record<string, string>>;
  readonly evidence: Readonly<Record<string, string>>;
  readonly statuses: readonly unknown[];
}

describe("Spec 009 publication parity", () => {
  test.each(["verified", "read-back"] as const)("M3: %s writes match the recorded publication", async (mode) => {
    const actual = await publishTwice(mode);
    if (process.env.UPDATE_PUBLICATION_PARITY === "1") {
      await Bun.write(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
    }
    const expected = JSON.parse(await Bun.file(GOLDEN).text()) as ParityRecord;
    expect(Object.keys(actual.objects).length).toBeGreaterThan(100);
    expect(actual).toEqual(expected);
  });
});

/** Two hourly runs: a first release, then a later one that reuses most pool objects. */
async function publishTwice(mode: "verified" | "read-back"): Promise<ParityRecord> {
  const events = generateSeededGitHubEvents({ count: 340, seed: 7, materializedAt: SECOND_RUN_AT })
    .sort((left, right) => left.sourceTimestamp.localeCompare(right.sourceTimestamp) || left.id.localeCompare(right.id));
  const first = events.filter((event) => event.sourceTimestamp <= FIRST_RUN_AT);
  const second = events.filter((event) => event.sourceTimestamp > FIRST_RUN_AT);
  expect(second.length).toBeGreaterThan(0);
  const state = new MemoryState();
  const destination = new RecordingDestination(mode === "verified");

  const statuses: PipelineRunStatus[] = [];
  for (const [materializedAt, polled] of [[FIRST_RUN_AT, first], [SECOND_RUN_AT, second]] as const) {
    statuses.push(await runDataPublication({
      environment: "development",
      materializedAt,
      connector: connector(polled, materializedAt),
      state,
      destination,
    }));
  }
  expect(statuses.every((status) => status.ok)).toBe(true);

  const objects: Record<string, { sha256: string; byteLength: number }> = {};
  const pointers: Record<string, string> = {};
  const evidence: Record<string, string> = {};
  for (const [key, body] of [...destination.objects].sort(([left], [right]) => left.localeCompare(right))) {
    if (key === MANIFEST_KEY || key === SEARCH_CURRENT_KEY) pointers[key] = new TextDecoder().decode(body);
    else if (key.startsWith("publication-sets/")) evidence[key] = sha256(body);
    else objects[key] = { sha256: sha256(body), byteLength: body.byteLength };
  }
  return { objects, pointers, evidence, statuses };
}

function connector(events: readonly DomainEventV1[], observedAt: string) {
  return {
    poll: async (): Promise<GitHubPollResult> => ({
      complete: true,
      events,
      candidateCheckpoint: {
        schema: "osskb.github-checkpoint.v1",
        connectorRevision: "github@1",
        sources: { "kafka:github": { updatedAt: observedAt }, "datafusion:github": { updatedAt: observedAt } },
      },
      pageCount: 1,
      truncated: false,
    }),
  };
}

function sha256(body: Uint8Array): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

class MemoryState implements PipelineStateRepository {
  value: SerializedReferenceStateV1 = { schema: "osskb.reference-state.v1", events: [] };

  async read(): Promise<SerializedReferenceStateV1> { return structuredClone(this.value); }
  async commit(state: SerializedReferenceStateV1): Promise<void> { this.value = structuredClone(state); }
  async recordStatus(): Promise<void> {}
}

/** Stores every body; optionally verifies digests on write like R2's conditional put. */
class RecordingDestination implements PublicationDestination {
  readonly objects = new Map<string, Uint8Array>();
  readonly putVerifiedImmutableIfAbsent?: (object: ImmutableProjectionObjectV1, body: Uint8Array) => Promise<"created" | "exists">;

  constructor(verified: boolean) {
    if (verified) {
      this.putVerifiedImmutableIfAbsent = async (object, body) => {
        if (this.objects.has(object.key)) return "exists";
        if (sha256(body) !== object.sha256) throw new Error(`checksum mismatch: ${object.key}`);
        this.objects.set(object.key, body.slice());
        return "created";
      };
    }
  }

  async get(key: string): Promise<Uint8Array | undefined> { return this.objects.get(key); }
  async putImmutableIfAbsent(key: string, body: Uint8Array): Promise<"created" | "exists"> {
    if (this.objects.has(key)) return "exists";
    this.objects.set(key, body.slice());
    return "created";
  }
  async putCurrent(key: string, body: Uint8Array): Promise<void> { this.objects.set(key, body.slice()); }
  async putEvidence(key: string, body: Uint8Array): Promise<void> {
    const existing = this.objects.get(key);
    if (existing !== undefined && sha256(existing) !== sha256(body)) throw new Error(`conflict:${key}`);
    this.objects.set(key, body.slice());
  }
}
