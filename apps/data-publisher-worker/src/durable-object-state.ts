import type { DomainEventV1 } from "@oss-knowledge-base/domain";
import type { SerializedReferenceStateV1 } from "@oss-knowledge-base/reference-pipeline";
import type { PipelinePhaseMarker, PipelineRunStatus, PipelineStateRepository } from "./pipeline";

const EVENT_PREFIX = "event:";
// Durable Object storage accepts at most 128 keys per put or delete.
const BATCH_SIZE = 100;

export class DurableObjectPipelineState implements PipelineStateRepository {
  /** Events as read at run start, by storage key; a commit writes only the difference. */
  private stored: ReadonlyMap<string, DomainEventV1> | undefined;

  constructor(private readonly storage: DurableObjectStorage) {}

  async read(): Promise<SerializedReferenceStateV1> {
    const stored = await this.storage.list<DomainEventV1>({ prefix: EVENT_PREFIX });
    this.stored = stored;
    const checkpoint = await this.storage.get<SerializedReferenceStateV1["checkpoint"]>("checkpoint");
    return {
      schema: "osskb.reference-state.v1",
      events: [...stored.values()],
      ...(checkpoint === undefined ? {} : { checkpoint }),
    };
  }

  /**
   * Puts added or changed events and deletes removed ones, diffing against the events read at
   * run start instead of listing every stored event again (Spec 009).
   */
  async commit(state: SerializedReferenceStateV1): Promise<void> {
    const stored = this.stored;
    if (stored === undefined) throw new Error("Pipeline state must be read before it is committed");
    const desired = new Map(state.events.map((event) => [`${EVENT_PREFIX}${event.id}`, event]));
    const obsolete = [...stored.keys()].filter((key) => !desired.has(key));
    const changed = [...desired].filter(([key, event]) => {
      const previous = stored.get(key);
      // Unchanged events are the objects read at run start; compare content only otherwise.
      return previous !== event && (previous === undefined || JSON.stringify(previous) !== JSON.stringify(event));
    });
    for (let index = 0; index < obsolete.length; index += BATCH_SIZE) {
      await this.storage.delete(obsolete.slice(index, index + BATCH_SIZE));
    }
    for (let index = 0; index < changed.length; index += BATCH_SIZE) {
      await this.storage.put(Object.fromEntries(changed.slice(index, index + BATCH_SIZE)));
    }
    if (state.checkpoint !== undefined) await this.storage.put("checkpoint", state.checkpoint);
    this.stored = desired;
  }

  async readStatus(): Promise<PipelineRunStatus | undefined> {
    return this.storage.get<PipelineRunStatus>("status");
  }

  async recordStatus(status: PipelineRunStatus): Promise<void> {
    await this.storage.put("status", status);
    await this.storage.delete("phase");
  }

  async recordPhase(marker: PipelinePhaseMarker): Promise<void> {
    await this.storage.put("phase", marker);
  }
}
