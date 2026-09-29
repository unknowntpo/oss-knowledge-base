import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { DomainEventV1 } from "@oss-knowledge-base/domain";
import {
  materializeReferenceFeed,
  ReferenceStateStore,
  type GitHubCheckpointV1,
  type ReferenceMaterializationConfig,
} from "@oss-knowledge-base/reference-pipeline";
import { buildR2Projection, MANIFEST_KEY, type FeedPublication } from "@oss-knowledge-base/serving-contract";

import type { GitHubPollResult } from "../github-connector";
import { ReferencePipelineController, type PipelinePublicationSink } from "../pipeline-controller";

const fixturePath = join(import.meta.dir, "..", "..", "..", "packages", "reference-pipeline", "test", "fixtures", "github-events.v1.json");

async function fixture() {
  return Bun.file(fixturePath).json() as Promise<{
    readonly config: ReferenceMaterializationConfig;
    readonly events: readonly DomainEventV1[];
  }>;
}

function checkpoint(updatedAt = "2026-08-25T08:00:00Z"): GitHubCheckpointV1 {
  return {
    schema: "osskb.github-checkpoint.v1",
    connectorRevision: "github@1",
    sources: {
      "kafka:github": { updatedAt },
      "datafusion:github": { updatedAt },
    },
  };
}

function complete(events: readonly DomainEventV1[], candidate = checkpoint()): GitHubPollResult {
  return { complete: true, events, candidateCheckpoint: candidate, pageCount: 2, truncated: false };
}

describe("Spec 004 reference pipeline controller", () => {
  test("G3: restart resumes only from the committed checkpoint", async () => {
    const input = await fixture();
    let received: GitHubCheckpointV1 | undefined;
    const first = new ReferencePipelineController({
      connector: { poll: async (previous) => { received = previous; return complete(input.events); } },
      materialize: (events) => materializeReferenceFeed(events, input.config),
    });
    expect((await first.run(input.config.materializedAt)).ok).toBe(true);
    expect(received).toBeUndefined();

    const restored = ReferenceStateStore.deserialize(first.state.serialize());
    const committed = restored.readCheckpoint();
    const second = new ReferencePipelineController({
      state: restored,
      connector: { poll: async (previous) => { received = previous; return complete(input.events, checkpoint("2026-08-25T09:00:00Z")); } },
      materialize: (events) => materializeReferenceFeed(events, input.config),
    });
    expect((await second.run(input.config.materializedAt)).ok).toBe(true);
    expect(received).toEqual(committed);
    expect(second.state.readEvents()).toHaveLength(input.events.length);

    const beforeFailure = second.state.readCheckpoint();
    const failed = new ReferencePipelineController({
      state: second.state,
      connector: { poll: async () => ({ complete: false, events: [], error: "partial", failureKind: "transport", retryAfterSeconds: 60 }) },
    });
    expect((await failed.run(input.config.materializedAt)).ok).toBe(false);
    expect(second.state.readCheckpoint()).toEqual(beforeFailure);
  });

  test("G6: conflicting duplicate fails before checkpoint or publication", async () => {
    const input = await fixture();
    const initialCheckpoint = checkpoint("2026-08-24T00:00:00Z");
    const state = new ReferenceStateStore({ schema: "osskb.reference-state.v1", events: input.events, checkpoint: initialCheckpoint });
    const first = input.events[0]!;
    const conflict = { ...first, data: { ...first.data, title: "Conflicting title" } } as unknown as DomainEventV1;
    let publishCalls = 0;
    const controller = new ReferencePipelineController({
      state,
      connector: { poll: async () => complete([conflict], checkpoint("2026-08-25T10:00:00Z")) },
      publicationSink: { publish: async () => { publishCalls += 1; } },
    });

    const result = await controller.run(input.config.materializedAt);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.failureKind).toBe("validation");
    expect(!result.ok && result.error).toContain("Conflicting events share dedupe identity");
    expect(state.readCheckpoint()).toEqual(initialCheckpoint);
    expect(publishCalls).toBe(0);
  });

  test("G7: partial fetch keeps the committed checkpoint and current release", async () => {
    const initialCheckpoint = checkpoint("2026-08-24T00:00:00Z");
    const state = new ReferenceStateStore({
      schema: "osskb.reference-state.v1",
      events: [],
      checkpoint: initialCheckpoint,
    });
    let publishCalls = 0;
    const controller = new ReferencePipelineController({
      state,
      connector: {
        poll: async () => ({
          complete: false,
          events: [],
          error: "page 2 unavailable",
          failureKind: "transport",
          retryAfterSeconds: 60,
        }),
      },
      publicationSink: { publish: async () => { publishCalls += 1; } },
    });

    const result = await controller.run("2026-08-25T12:00:00Z");
    expect(result.ok).toBe(false);
    expect(state.readCheckpoint()).toEqual(initialCheckpoint);
    expect(publishCalls).toBe(0);
  });

  test("G8: rate-limit failure preserves the previously published release", async () => {
    let currentRelease = "release-known-good";
    const sink: PipelinePublicationSink = { publish: async () => { currentRelease = "unexpected"; } };
    const controller = new ReferencePipelineController({
      connector: { poll: async () => ({ complete: false, events: [], error: "API rate limit exceeded", failureKind: "rate-limit", retryAfterSeconds: 300 }) },
      publicationSink: sink,
    });

    const result = await controller.run("2026-08-25T12:00:00Z");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.retryAfterSeconds).toBe(300);
    expect(currentRelease).toBe("release-known-good");
  });

  test("G11: controller output publishes through unchanged manifest-last R2 contract", async () => {
    const input = await fixture();
    let objects: ReturnType<typeof buildR2Projection> = [];
    let captured: FeedPublication | undefined;
    const controller = new ReferencePipelineController({
      connector: { poll: async () => complete(input.events) },
      materialize: (events) => materializeReferenceFeed(events, input.config),
      publicationSink: {
        publish: async (publication) => {
          captured = publication;
          objects = buildR2Projection(publication, "fixture-release");
        },
      },
    });

    expect((await controller.run(input.config.materializedAt)).ok).toBe(true);
    expect(captured?.index.schema).toBe("osskb.feed-index.v2");
    expect(objects.at(-1)?.key).toBe(MANIFEST_KEY);
    expect(objects.slice(0, -1).every((object) => object.cacheControl.includes("immutable"))).toBe(true);
    expect(captured?.details.length).toBe(captured?.index.entries.length);
  });
});
