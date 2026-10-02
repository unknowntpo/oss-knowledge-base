import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { feedDetailTimeline, type DomainEventV1 } from "@oss-knowledge-base/domain";

import {
  canonicalJson,
  materializeReferenceFeed,
  type ReferenceMaterializationConfig,
} from "../src";

const fixturePath = join(import.meta.dir, "fixtures", "github-events.v1.json");
const expectedPath = join(import.meta.dir, "fixtures", "github-feed-projection.v1.json");

async function fixture() {
  return Bun.file(fixturePath).json() as Promise<{
    readonly config: ReferenceMaterializationConfig;
    readonly events: readonly DomainEventV1[];
  }>;
}

describe("Spec 004 reference materializer", () => {
  test("G2: repeated observations deduplicate without changing Feed output", async () => {
    const input = await fixture();
    const duplicate = { ...input.events[0]!, observedAt: "2026-08-24T10:02:00Z" };
    const once = materializeReferenceFeed(input.events, input.config);
    const repeated = materializeReferenceFeed([...input.events, duplicate], input.config);

    expect(repeated.digest).toBe(once.digest);
    expect(repeated.publication.index.metadata.inputEventCount).toBe(input.events.length);
    expect(repeated.publication.index.entries.find((item) => item.displayId === "KAFKA-ISSUE-42")?.entry.activity.score).toBe(2);
  });

  test("G4: out-of-order events produce identical status and timelines", async () => {
    const input = await fixture();
    const ordered = materializeReferenceFeed(input.events, input.config);
    const reversed = materializeReferenceFeed([...input.events].reverse(), input.config);

    expect(reversed.digest).toBe(ordered.digest);
    expect(reversed.publication.index.entries.map((item) => [item.displayId, item.status])).toEqual(
      ordered.publication.index.entries.map((item) => [item.displayId, item.status]),
    );
    for (const detail of reversed.publication.details) {
      expect(feedDetailTimeline(detail).map((record) => record.id)).toEqual(
        feedDetailTimeline(ordered.publication.details.find((candidate) => candidate.entry.id === detail.entry.id)!).map((record) => record.id),
      );
    }
  });

  test("G5: clean-process replay matches the recorded projection and digest", async () => {
    const input = await fixture();
    const expected = await Bun.file(expectedPath).json() as { readonly digest: string; readonly publication: unknown };
    const result = materializeReferenceFeed(input.events, input.config);
    const command = ["bun", join(import.meta.dir, "..", "scripts", "replay-fixture.ts"), fixturePath];
    const first = Bun.spawnSync(command);
    const second = Bun.spawnSync(command);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(first.stdout.toString()).toBe(second.stdout.toString());
    expect(result.digest).toBe(expected.digest);
    expect(canonicalJson(result.publication)).toBe(canonicalJson(expected.publication));
    expect(first.stdout.toString()).toBe(`${expected.digest}\n${canonicalJson(expected.publication)}`);
  });

  test("G9: provenance and citations survive materialization", async () => {
    const input = await fixture();
    const { publication } = materializeReferenceFeed(input.events, input.config);
    const eventIds = new Set(input.events.map((event) => event.id));

    for (const detail of publication.details) {
      const recordIds = new Set(detail.records.map((record) => record.id));
      expect(detail.records.every((record) => record.canonicalUrl.startsWith("https://github.com/apache/") && record.sourceVersion.length > 0 && record.author.length > 0 && record.occurredAt.length > 0)).toBe(true);
      expect(detail.entry.reason.kind === "trending" && detail.entry.reason.evidenceEventIds.every((id) => eventIds.has(id))).toBe(true);
      if (detail.keyPoints.status === "generated") {
        expect(detail.keyPoints.points.every((point) => point.evidenceRecordIds.every((id) => recordIds.has(id)))).toBe(true);
      }
    }
  });

  test("G10: overlapping GitHub numbers remain isolated by project", async () => {
    const input = await fixture();
    const { publication } = materializeReferenceFeed(input.events, input.config);
    const issue42 = publication.index.entries.filter((item) => item.displayId.endsWith("ISSUE-42"));

    expect(issue42.map((item) => item.projectKey).sort()).toEqual(["datafusion", "kafka"]);
    expect(publication.details.every((detail) => new Set(detail.records.map((record) => record.projectId)).size === 1)).toBe(true);
  });
});
