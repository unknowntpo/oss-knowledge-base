import { parseDomainEventV1, type DomainEventV1 } from "@oss-knowledge-base/domain";

import { canonicalJson } from "./canonical";

export interface GitHubCheckpointV1 {
  readonly schema: "osskb.github-checkpoint.v1";
  readonly connectorRevision: string;
  readonly sources: Readonly<Record<string, { readonly updatedAt: string }>>;
}

export interface SerializedReferenceStateV1 {
  readonly schema: "osskb.reference-state.v1";
  readonly events: readonly DomainEventV1[];
  readonly checkpoint?: GitHubCheckpointV1;
}

export class EventIdentityConflictError extends Error {
  readonly identity: string;

  constructor(identity: string) {
    super(`Conflicting events share dedupe identity ${identity}`);
    this.name = "EventIdentityConflictError";
    this.identity = identity;
  }
}

export function eventDedupeIdentity(event: DomainEventV1): string {
  return [event.projectId, event.sourceInstanceId, event.entityId, event.sourceCursor].join("\u0000");
}

function logicalEvent(event: DomainEventV1): unknown {
  const { observedAt: _observedAt, ...logical } = event;
  return logical;
}

export function dedupeDomainEvents(values: readonly unknown[]): readonly DomainEventV1[] {
  const byIdentity = new Map<string, { readonly event: DomainEventV1; readonly canonical: string }>();
  for (const value of values) {
    const event = parseDomainEventV1(value);
    const identity = eventDedupeIdentity(event);
    const canonical = canonicalJson(logicalEvent(event));
    const existing = byIdentity.get(identity);
    if (existing !== undefined && existing.canonical !== canonical) {
      throw new EventIdentityConflictError(identity);
    }
    if (existing === undefined || event.observedAt < existing.event.observedAt) {
      byIdentity.set(identity, { event, canonical });
    }
  }
  return [...byIdentity.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value.event);
}

function parseCheckpoint(value: unknown): GitHubCheckpointV1 | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") throw new Error("Checkpoint must be an object");
  const candidate = value as Partial<GitHubCheckpointV1>;
  if (
    candidate.schema !== "osskb.github-checkpoint.v1" ||
    typeof candidate.connectorRevision !== "string" ||
    candidate.sources === null ||
    typeof candidate.sources !== "object"
  ) {
    throw new Error("Checkpoint is invalid");
  }
  for (const source of Object.values(candidate.sources)) {
    if (source === null || typeof source !== "object" || typeof source.updatedAt !== "string") {
      throw new Error("Checkpoint source watermark is invalid");
    }
  }
  return candidate as GitHubCheckpointV1;
}

/** In-memory durability model used by the reference controller and restart fixtures. */
export class ReferenceStateStore {
  private events: readonly DomainEventV1[];
  private checkpoint: GitHubCheckpointV1 | undefined;

  constructor(initial: SerializedReferenceStateV1 = { schema: "osskb.reference-state.v1", events: [] }) {
    this.events = dedupeDomainEvents(initial.events);
    this.checkpoint = parseCheckpoint(initial.checkpoint);
  }

  readEvents(): readonly DomainEventV1[] {
    return this.events;
  }

  readCheckpoint(): GitHubCheckpointV1 | undefined {
    return this.checkpoint;
  }

  /** Validates the complete next log before replacing state, so conflicts are atomic. */
  appendDurably(events: readonly unknown[]): void {
    this.events = dedupeDomainEvents([...this.events, ...events]);
  }

  /**
   * Appends events, keeping a stored event when a new one shares its dedupe identity with
   * different content (ADR-0014). Returns the rejected new events so a run can count them.
   */
  appendKeepingStored(events: readonly unknown[]): readonly DomainEventV1[] {
    const stored = new Map(this.events.map((event) => [eventDedupeIdentity(event), canonicalJson(logicalEvent(event))]));
    const accepted: DomainEventV1[] = [];
    const conflicts: DomainEventV1[] = [];
    for (const value of events) {
      const event = parseDomainEventV1(value);
      const existing = stored.get(eventDedupeIdentity(event));
      if (existing === undefined) {
        stored.set(eventDedupeIdentity(event), canonicalJson(logicalEvent(event)));
        accepted.push(event);
      } else if (existing !== canonicalJson(logicalEvent(event))) {
        conflicts.push(event);
      }
    }
    this.events = dedupeDomainEvents([...this.events, ...accepted]);
    return conflicts;
  }

  commitCheckpoint(checkpoint: GitHubCheckpointV1): void {
    this.checkpoint = parseCheckpoint(checkpoint);
  }

  snapshot(): SerializedReferenceStateV1 {
    return {
      schema: "osskb.reference-state.v1",
      events: this.events,
      ...(this.checkpoint === undefined ? {} : { checkpoint: this.checkpoint }),
    };
  }

  serialize(): string {
    return canonicalJson(this.snapshot());
  }

  static deserialize(serialized: string): ReferenceStateStore {
    const value = JSON.parse(serialized) as Partial<SerializedReferenceStateV1>;
    if (value.schema !== "osskb.reference-state.v1" || !Array.isArray(value.events)) {
      throw new Error("Reference state is invalid");
    }
    const checkpoint = parseCheckpoint(value.checkpoint);
    return new ReferenceStateStore({
      schema: "osskb.reference-state.v1",
      events: value.events,
      ...(checkpoint === undefined ? {} : { checkpoint }),
    });
  }
}
