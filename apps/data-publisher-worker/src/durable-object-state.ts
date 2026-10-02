import type { DomainEventV1 } from "@oss-knowledge-base/domain";
import type { SerializedReferenceStateV1 } from "@oss-knowledge-base/reference-pipeline";
import type { PipelinePhaseMarker, PipelineRunStatus, PipelineStateRepository } from "./pipeline";

export class DurableObjectPipelineState implements PipelineStateRepository {
  constructor(private readonly storage: DurableObjectStorage) {}

  async read(): Promise<SerializedReferenceStateV1> {
    const events = [...(await this.storage.list<DomainEventV1>({ prefix: "event:" })).values()];
    const checkpoint = await this.storage.get<SerializedReferenceStateV1["checkpoint"]>("checkpoint");
    return {
      schema: "osskb.reference-state.v1",
      events,
      ...(checkpoint === undefined ? {} : { checkpoint }),
    };
  }

  async commit(state: SerializedReferenceStateV1): Promise<void> {
    const desired = new Map<string, DomainEventV1>(
      state.events.map((event) => [`event:${event.id}`, event]),
    );
    const existing = await this.storage.list({ prefix: "event:" });
    const obsolete = [...existing.keys()].filter((key) => !desired.has(key));
    for (let index = 0; index < obsolete.length; index += 100) {
      await this.storage.delete(obsolete.slice(index, index + 100));
    }
    const entries = [...desired.entries()];
    for (let index = 0; index < entries.length; index += 100) {
      await this.storage.put(Object.fromEntries(entries.slice(index, index + 100)));
    }
    if (state.checkpoint !== undefined) await this.storage.put("checkpoint", state.checkpoint);
  }

  async recordStatus(status: PipelineRunStatus): Promise<void> {
    await this.storage.put("status", status);
    await this.storage.delete("phase");
  }

  async recordPhase(marker: PipelinePhaseMarker): Promise<void> {
    await this.storage.put("phase", marker);
  }
}
