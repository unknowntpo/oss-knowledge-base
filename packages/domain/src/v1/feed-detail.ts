import type { FeedProjectId, FeedRecordId } from "./feed-grouping";

export type FeedEntryId = string;

export type FeedEntryReason =
  | {
      readonly kind: "trending";
      readonly label: string;
      readonly evidenceEventIds: readonly string[];
    }
  | {
      readonly kind: "watch-match";
      readonly label: string;
      readonly watchId: string;
      readonly matchedRecordIds: readonly FeedRecordId[];
    }
  | {
      readonly kind: "search-match";
      readonly label: string;
      readonly query: string;
      readonly matchedRecordIds: readonly FeedRecordId[];
    };

/** The compact, rankable object rendered as one card in the feed. */
export interface FeedEntry {
  readonly id: FeedEntryId;
  readonly projectId: FeedProjectId;
  readonly title: string;
  readonly summary: string;
  readonly sourceTitleRecordId: FeedRecordId;
  readonly recordIds: readonly FeedRecordId[];
  readonly highlightedRecordIds: readonly FeedRecordId[];
  readonly reason: FeedEntryReason;
  readonly activity: {
    readonly score: number;
    readonly evidenceEventIds: readonly string[];
  };
  readonly grouping: {
    readonly relationshipIds: readonly string[];
    readonly clusteringRevision: string;
  };
}

/** One hydrated, independently traceable record from an upstream community source. */
export interface SourceRecordView {
  readonly id: FeedRecordId;
  readonly projectId: FeedProjectId;
  readonly sourceInstanceId: string;
  /** Project-profile source facet key used by filters, for example `github` or `mail`. */
  readonly source: string;
  readonly sourceType: string;
  readonly kind: string;
  readonly title: string;
  readonly excerpt: string;
  readonly author: string;
  readonly role: string;
  readonly occurredAt: string;
  readonly canonicalUrl: string;
  readonly sourceVersion: string;
  readonly artifactStatus?: string;
}

export type RecordConnectionKind =
  | "discusses"
  | "implements"
  | "fixes"
  | "duplicates"
  | "references"
  | "related-to";

/** Explains why two records are shown together; it is not presentation-only metadata. */
export interface RecordConnection {
  readonly id: string;
  readonly fromRecordId: FeedRecordId;
  readonly toRecordId: FeedRecordId;
  readonly kind: RecordConnectionKind;
  readonly derivation:
    | { readonly kind: "source-link"; readonly sourceVersion: string }
    | { readonly kind: "deterministic-rule"; readonly revision: string }
    | { readonly kind: "curated"; readonly curatorId: string }
    | {
        readonly kind: "model-inference";
        readonly modelRevision: string;
        readonly confidence: number;
      };
}

export interface FeedDetailKeyPoint {
  readonly id: string;
  readonly text: string;
  /** Every point must cite at least one record contained by this FeedDetail. */
  readonly evidenceRecordIds: readonly [FeedRecordId, ...FeedRecordId[]];
}

export type FeedDetailKeyPoints =
  | {
      readonly status: "unavailable";
      readonly reason: "generator-not-configured";
    }
  | {
      readonly status: "failed";
      readonly reason: "invalid-citation" | "generator-unavailable";
    }
  | {
      readonly status: "generated";
      readonly points: readonly FeedDetailKeyPoint[];
      readonly derivation:
        | { readonly kind: "source-extract"; readonly revision: string }
        | {
            readonly kind: "model";
            readonly provider: string;
            readonly model: string;
            readonly promptRevision: string;
          };
    };

/**
 * Another published entry linked by a deterministic key rule (ADR-0014). Unlike a
 * RecordConnection it names an entry, not a contained record, and never merges entries.
 */
export interface FeedRelatedEntry {
  readonly displayId: string;
  readonly title: string;
  readonly source: string;
  readonly rule: "key-in-title" | "same-kip";
  readonly ruleRevision: string;
}

/** The complete read model loaded after a user opens a FeedEntry. */
export interface FeedDetail {
  /** The entry's public display id, so a Search hit can show it (ADR-0014). */
  readonly displayId?: string;
  readonly entry: FeedEntry;
  readonly records: readonly SourceRecordView[];
  readonly connections: readonly RecordConnection[];
  readonly keyPoints: FeedDetailKeyPoints;
  readonly related?: readonly FeedRelatedEntry[];
}

export interface BuildFeedDetailInput {
  readonly displayId?: string;
  readonly entry: FeedEntry;
  readonly records: readonly SourceRecordView[];
  readonly connections?: readonly RecordConnection[];
  readonly keyPoints?: FeedDetailKeyPoints;
  readonly related?: readonly FeedRelatedEntry[];
}

function duplicates(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const found = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) found.add(value);
    seen.add(value);
  }
  return [...found];
}

/** Enforces the boundary between a feed card and the detail it opens. */
export function buildFeedDetail(input: BuildFeedDetailInput): FeedDetail {
  const recordIds = input.records.map((record) => record.id);
  const duplicateRecordIds = duplicates(recordIds);
  if (duplicateRecordIds.length > 0) {
    throw new Error(`FeedDetail contains duplicate records: ${duplicateRecordIds.join(", ")}`);
  }

  const expectedIds = new Set(input.entry.recordIds);
  const actualIds = new Set(recordIds);
  const missingIds = input.entry.recordIds.filter((recordId) => !actualIds.has(recordId));
  const unexpectedIds = recordIds.filter((recordId) => !expectedIds.has(recordId));
  if (missingIds.length > 0 || unexpectedIds.length > 0) {
    throw new Error(
      `FeedDetail records do not match FeedEntry ${input.entry.id}; missing=[${missingIds.join(", ")}], unexpected=[${unexpectedIds.join(", ")}]`,
    );
  }

  if (!expectedIds.has(input.entry.sourceTitleRecordId)) {
    throw new Error("FeedEntry sourceTitleRecordId must belong to recordIds");
  }
  if (input.entry.highlightedRecordIds.some((recordId) => !expectedIds.has(recordId))) {
    throw new Error("FeedEntry highlightedRecordIds must be a subset of recordIds");
  }
  if (input.records.some((record) => record.projectId !== input.entry.projectId)) {
    throw new Error("FeedDetail cannot contain records from another project");
  }

  const connections = input.connections ?? [];
  if (
    connections.some(
      (connection) =>
        !expectedIds.has(connection.fromRecordId) || !expectedIds.has(connection.toRecordId),
    )
  ) {
    throw new Error("FeedDetail connections must only reference contained records");
  }

  const keyPoints =
    input.keyPoints ?? ({ status: "unavailable", reason: "generator-not-configured" } as const);
  if (
    keyPoints.status === "generated" &&
    keyPoints.points.some((point) =>
      point.evidenceRecordIds.some((recordId) => !expectedIds.has(recordId)),
    )
  ) {
    throw new Error("FeedDetail key points must only cite contained records");
  }

  const related = input.related ?? [];
  if (related.some((link) => link.displayId.length === 0 || link.displayId === input.displayId)) {
    throw new Error("FeedDetail related entries must name another entry");
  }

  return {
    ...(input.displayId === undefined ? {} : { displayId: input.displayId }),
    entry: input.entry,
    records: input.records,
    connections,
    keyPoints,
    ...(related.length === 0 ? {} : { related }),
  };
}

/** Timeline is a deterministic projection of records, not a second stored entity. */
export function feedDetailTimeline(detail: FeedDetail): readonly SourceRecordView[] {
  return [...detail.records].sort(
    (left, right) =>
      Date.parse(right.occurredAt) - Date.parse(left.occurredAt) ||
      left.id.localeCompare(right.id),
  );
}
