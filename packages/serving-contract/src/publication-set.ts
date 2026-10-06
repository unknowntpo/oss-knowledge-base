import { detailPoolKey, digestOfPoolKey, isSha256Digest, sha256Digest, type Sha256Digest } from "./digest";
import type { FeedManifest } from "./index";
import {
  FEED_DETAIL_POOL,
  isFeedDetailMap,
  isFeedManifest,
  MANIFEST_KEY,
  type EncodedProjectionObject,
  type ProjectionObject,
  type StreamedFeedRelease,
} from "./r2";
import {
  isSearchCurrentPointer,
  isSearchLexicalShard,
  isSearchLexicalShardV2,
  isSearchReleaseManifest,
  SEARCH_CURRENT_KEY,
  SEARCH_DETAIL_POOL,
  SEARCH_RELEASE_SCHEMA,
  SEARCH_RELEASE_SCHEMA_V1,
  searchShardKeys,
  searchTermsKey,
  type SearchCurrentPointerV1,
  type SearchGroupDetailRef,
  type SearchReleaseManifest,
  type StreamedSearchRelease,
} from "./search-r2";

export type PublicationEnvironment = "development" | "production";
export type ProjectionKind = "feed" | "search";

export interface ImmutableProjectionObjectV1 {
  readonly key: string;
  readonly sha256: Sha256Digest;
  readonly byteLength: number;
}

export interface FeedReleaseDescriptorV1 {
  readonly kind: "feed";
  readonly releaseId: string;
  readonly currentKey: typeof MANIFEST_KEY;
  readonly current: FeedManifest;
  readonly immutableObjects: readonly ImmutableProjectionObjectV1[];
}

export interface SearchReleaseDescriptorV1 {
  readonly kind: "search";
  readonly releaseId: string;
  readonly currentKey: typeof SEARCH_CURRENT_KEY;
  readonly current: SearchCurrentPointerV1;
  readonly immutableObjects: readonly ImmutableProjectionObjectV1[];
}

export type ProjectionReleaseDescriptorV1 =
  | FeedReleaseDescriptorV1
  | SearchReleaseDescriptorV1;

export interface PublicationSetV1 {
  readonly schema: "osskb.publication-set.v1";
  readonly id: string;
  readonly generatedAt: string;
  readonly inputDigest: Sha256Digest;
  readonly materializerRevision: string;
  readonly projections: readonly [
    ProjectionReleaseDescriptorV1,
    ProjectionReleaseDescriptorV1,
  ];
}

export interface PromotionRequestV1 {
  readonly schema: "osskb.promotion-request.v1";
  readonly publicationSetId: string;
  readonly from: "development";
  readonly to: "production";
  readonly requestedBy: string;
}

/** Minimal boundary implemented by fake/local stores now and an R2 adapter later. */
export interface PublicationObjectStore {
  readonly get: (key: string) => Promise<Uint8Array | undefined>;
  readonly putImmutableIfAbsent: (
    key: string,
    body: Uint8Array,
  ) => Promise<"created" | "exists">;
  readonly putCurrent: (key: string, body: Uint8Array) => Promise<void>;
  /**
   * Optional single-request write: creates the object only when the key is absent and
   * rejects bytes whose SHA-256 differs from `object.sha256`, so no read-back is needed.
   */
  readonly putVerifiedImmutableIfAbsent?: (
    object: ImmutableProjectionObjectV1,
    body: Uint8Array,
  ) => Promise<"created" | "exists">;
}

export type PublicationFailureKind =
  | "invalid-publication-set"
  | "source-object-missing"
  | "source-object-mismatch"
  | "source-manifest-invalid"
  | "destination-conflict"
  | "store-error";

export interface PublicationFailure {
  readonly ok: false;
  readonly kind: PublicationFailureKind;
  readonly message: string;
  readonly projectionKind?: ProjectionKind;
  readonly objectKey?: string;
}

export interface PublicationVerificationSuccess {
  readonly ok: true;
  readonly verifiedObjectCount: number;
}

export type PublicationVerificationResult =
  | PublicationVerificationSuccess
  | PublicationFailure;

export interface PromotionSuccess {
  readonly ok: true;
  readonly copiedObjectCount: number;
  readonly reusedObjectCount: number;
  readonly switchedProjections: readonly ProjectionKind[];
  readonly unchangedProjections: readonly ProjectionKind[];
}

export type PromotionResult = PromotionSuccess | PublicationFailure;

export interface BuildPublicationSetInput {
  readonly id: string;
  readonly generatedAt: string;
  readonly inputDigest: Sha256Digest;
  readonly materializerRevision: string;
  readonly feedObjects: readonly ProjectionObject[];
  readonly searchObjects: readonly ProjectionObject[];
}

export async function buildPublicationSetV1(
  input: BuildPublicationSetInput,
): Promise<PublicationSetV1> {
  const feed = await buildDescriptor("feed", input.feedObjects);
  const search = await buildDescriptor("search", input.searchObjects);
  const publicationSet: PublicationSetV1 = {
    schema: "osskb.publication-set.v1",
    id: input.id,
    generatedAt: input.generatedAt,
    inputDigest: input.inputDigest,
    materializerRevision: input.materializerRevision,
    projections: [feed, search],
  };
  assertPublicationSetV1(publicationSet);
  const feedMapFailure = verifyFeedDetailMapBodies(feed, new Map(input.feedObjects
    .filter((object) => object.key !== MANIFEST_KEY)
    .map((object) => [object.key, encode(object.body)])));
  if (feedMapFailure !== undefined) throw new Error(feedMapFailure.message);
  const searchManifestFailure = verifySearchManifestBodies(
    search,
    new Map(input.searchObjects
      .filter((object) => object.key !== SEARCH_CURRENT_KEY)
      .map((object) => [object.key, encode(object.body)])),
  );
  if (searchManifestFailure !== undefined) throw new Error(searchManifestFailure.message);
  return publicationSet;
}

export function publicationSetValidationIssues(value: unknown): readonly string[] {
  if (!isRecord(value)) return ["Publication set must be an object"];
  const issues: string[] = [];
  if (value.schema !== "osskb.publication-set.v1") issues.push("Publication set schema is invalid");
  requireNonEmpty(value.id, "Publication set id", issues);
  requireTimestamp(value.generatedAt, "Publication set generatedAt", issues);
  requireDigest(value.inputDigest, "Publication set inputDigest", issues);
  requireNonEmpty(value.materializerRevision, "Publication set materializerRevision", issues);
  if (!Array.isArray(value.projections) || value.projections.length !== 2) {
    issues.push("Publication set must contain exactly two projections");
    return issues;
  }

  const descriptors = value.projections;
  const kinds = descriptors.map((item) => isRecord(item) ? item.kind : undefined);
  if (kinds.filter((kind) => kind === "feed").length !== 1 ||
      kinds.filter((kind) => kind === "search").length !== 1) {
    issues.push("Publication set must contain exactly one Feed and one Search projection");
  }

  const allKeys: string[] = [];
  for (const raw of descriptors) {
    if (!isRecord(raw)) {
      issues.push("Projection descriptor must be an object");
      continue;
    }
    validateDescriptor(raw, allKeys, issues);
  }
  if (new Set(allKeys).size !== allKeys.length) {
    issues.push("Immutable object keys must be unique across the publication set");
  }
  return issues;
}

export function isPublicationSetV1(value: unknown): value is PublicationSetV1 {
  return publicationSetValidationIssues(value).length === 0;
}

export function assertPublicationSetV1(value: unknown): asserts value is PublicationSetV1 {
  const issues = publicationSetValidationIssues(value);
  if (issues.length > 0) throw new Error(issues.join("; "));
}

export async function verifyPublicationSetSource(
  publicationSet: PublicationSetV1,
  source: Pick<PublicationObjectStore, "get">,
): Promise<PublicationVerificationResult> {
  const issues = publicationSetValidationIssues(publicationSet);
  if (issues.length > 0) return failure("invalid-publication-set", issues.join("; "));

  let verifiedObjectCount = 0;
  for (const projection of publicationSet.projections) {
    const bodies = new Map<string, Uint8Array>();
    for (const expected of projection.immutableObjects) {
      let body: Uint8Array | undefined;
      try {
        body = await source.get(expected.key);
      } catch (error) {
        return failure("store-error", errorMessage(error), projection.kind, expected.key);
      }
      if (body === undefined) {
        return failure(
          "source-object-missing",
          `Source object is missing: ${expected.key}`,
          projection.kind,
          expected.key,
        );
      }
      const mismatch = await objectMismatch(expected, body);
      if (mismatch !== undefined) {
        return failure("source-object-mismatch", mismatch, projection.kind, expected.key);
      }
      bodies.set(expected.key, body);
      verifiedObjectCount += 1;
    }
    const manifestFailure = projection.kind === "search"
      ? verifySearchManifestBodies(projection, bodies)
      : verifyFeedDetailMapBodies(projection, bodies);
    if (manifestFailure !== undefined) return manifestFailure;
  }
  return { ok: true, verifiedObjectCount };
}

export async function promotePublicationSet(
  publicationSet: PublicationSetV1,
  source: Pick<PublicationObjectStore, "get">,
  destination: PublicationObjectStore,
  options: { readonly concurrency?: number } = {},
): Promise<PromotionResult> {
  const sourceVerification = await verifyPublicationSetSource(publicationSet, source);
  if (!sourceVerification.ok) return sourceVerification;

  let copiedObjectCount = 0;
  let reusedObjectCount = 0;
  const switchedProjections: ProjectionKind[] = [];
  const unchangedProjections: ProjectionKind[] = [];
  const search = publicationSet.projections.find((projection): projection is SearchReleaseDescriptorV1 =>
    projection.kind === "search")!;
  const feed = publicationSet.projections.find((projection): projection is FeedReleaseDescriptorV1 =>
    projection.kind === "feed")!;
  const projectionOrder: readonly ProjectionReleaseDescriptorV1[] = [search, feed];

  for (const projection of projectionOrder) {
    const outcomes = await mapUntilFailure(
      uniqueObjects(projection.immutableObjects),
      options.concurrency ?? 1,
      (expected) => promoteImmutableObject(expected, projection.kind, () => source.get(expected.key), destination),
    );
    for (const outcome of outcomes) {
      if (typeof outcome !== "string") return outcome;
      if (outcome === "created") copiedObjectCount += 1;
      else reusedObjectCount += 1;
    }

    const pointer = await switchPointer(projection, destination);
    if (typeof pointer !== "string") return pointer;
    (pointer === "switched" ? switchedProjections : unchangedProjections).push(projection.kind);
  }

  return {
    ok: true,
    copiedObjectCount,
    reusedObjectCount,
    switchedProjections,
    unchangedProjections,
  };
}

export interface ProjectionStreamsInput {
  readonly id: string;
  readonly generatedAt: string;
  readonly inputDigest: Sha256Digest;
  readonly materializerRevision: string;
}

/**
 * The two releases to publish. `publishProjectionStreams` takes ownership and clears each
 * stream once it is consumed, so the publication it reads can be collected before the next
 * phase; callers should not keep their own reference to a stream or its publication.
 */
export interface ProjectionStreams {
  search: AsyncGenerator<EncodedProjectionObject, StreamedSearchRelease> | undefined;
  feed: AsyncGenerator<EncodedProjectionObject, StreamedFeedRelease> | undefined;
}

export type StreamedPublicationResult =
  | (PromotionSuccess & { readonly publicationSet: PublicationSetV1 })
  | PublicationFailure;

export type PublicationStreamPhase = "writing-search" | "writing-feed" | "switching-pointers";

export interface PublicationStreamProgress {
  readonly copiedObjectCount: number;
  readonly reusedObjectCount: number;
}

/**
 * Publishes a Feed and a Search release whose objects are produced one at a time (Spec 009).
 * Each body is written as soon as it is produced and released once its write settles, so at
 * most `concurrency` bodies are held. Cross-object invariants are checked on the resulting
 * descriptors, never by re-reading bodies, before any pointer switches; Search's pointer
 * switches before Feed's, and only when its bytes change. A failure leaves both pointers
 * unchanged, and the objects already written are reused by a rerun.
 */
export async function publishProjectionStreams(
  input: ProjectionStreamsInput,
  streams: ProjectionStreams,
  destination: PublicationObjectStore,
  options: {
    readonly concurrency?: number;
    readonly onPhase?: (phase: PublicationStreamPhase, progress: PublicationStreamProgress) => Promise<void>;
  } = {},
): Promise<StreamedPublicationResult> {
  const progress = { copiedObjectCount: 0, reusedObjectCount: 0 };
  const concurrency = Math.max(1, options.concurrency ?? 1);

  await options.onPhase?.("writing-search", { ...progress });
  const search = await writeProjectionStream("search", take(streams, "search"), destination, concurrency, progress);
  if (isFailure(search)) return search;
  await options.onPhase?.("writing-feed", { ...progress });
  const feed = await writeProjectionStream("feed", take(streams, "feed"), destination, concurrency, progress);
  if (isFailure(feed)) return feed;

  const publicationSet: PublicationSetV1 = {
    schema: "osskb.publication-set.v1",
    id: input.id,
    generatedAt: input.generatedAt,
    inputDigest: input.inputDigest,
    materializerRevision: input.materializerRevision,
    projections: [feed.descriptor, search.descriptor],
  };
  const issues = publicationSetValidationIssues(publicationSet);
  if (issues.length > 0) return failure("invalid-publication-set", issues.join("; "));
  const invalid = verifySearchManifest(search.descriptor, search.manifest, (key) => search.shardGroups.get(key)) ??
    verifyFeedDetailMap(feed.descriptor, feed.detailMap);
  if (invalid !== undefined) return invalid;

  await options.onPhase?.("switching-pointers", { ...progress });
  const switchedProjections: ProjectionKind[] = [];
  const unchangedProjections: ProjectionKind[] = [];
  for (const projection of [search.descriptor, feed.descriptor]) {
    const pointer = await switchPointer(projection, destination);
    if (typeof pointer !== "string") return pointer;
    (pointer === "switched" ? switchedProjections : unchangedProjections).push(projection.kind);
  }
  return { ok: true, ...progress, switchedProjections, unchangedProjections, publicationSet };
}

function take<K extends keyof ProjectionStreams>(streams: ProjectionStreams, kind: K): NonNullable<ProjectionStreams[K]> {
  const stream = streams[kind];
  if (stream === undefined) throw new Error(`The ${kind} projection stream was already consumed`);
  streams[kind] = undefined;
  return stream;
}

/** Writes each streamed object with bounded concurrency and returns what the stream declared. */
async function writeProjectionStream<R>(
  kind: ProjectionKind,
  stream: AsyncGenerator<EncodedProjectionObject, R>,
  destination: PublicationObjectStore,
  concurrency: number,
  progress: { copiedObjectCount: number; reusedObjectCount: number },
): Promise<R | PublicationFailure> {
  const inFlight = new Set<Promise<void>>();
  let failed: PublicationFailure | undefined;
  try {
    for (let next = await stream.next(); ; next = await stream.next()) {
      if (next.done) {
        await Promise.all(inFlight);
        return failed ?? next.value;
      }
      const object = next.value;
      // A pool object is reused by name alone, so a misnamed one must never be written.
      failed ??= streamedObjectFailure(kind, object);
      if (failed !== undefined) break;
      const write: Promise<void> = promoteImmutableObject(object, kind, async () => object.body, destination)
        .then((outcome) => {
          if (typeof outcome !== "string") failed ??= outcome;
          else if (outcome === "created") progress.copiedObjectCount += 1;
          else progress.reusedObjectCount += 1;
        })
        .finally(() => inFlight.delete(write));
      inFlight.add(write);
      if (inFlight.size >= concurrency) await Promise.race(inFlight);
      if (failed !== undefined) break;
    }
  } catch (error) {
    await Promise.allSettled(inFlight);
    throw error;
  }
  await Promise.all(inFlight);
  await stream.return(undefined as never);
  return failed!;
}

function streamedObjectFailure(kind: ProjectionKind, object: EncodedProjectionObject): PublicationFailure | undefined {
  const pool = detailPool(kind);
  if (object.key.startsWith(pool) && digestOfPoolKey(pool, object.key) !== object.sha256) {
    return failure("invalid-publication-set", `${object.key} is a ${kind} detail pool key whose name differs from its sha256`, kind, object.key);
  }
  if (object.body.byteLength !== object.byteLength) {
    return failure("invalid-publication-set", `${object.key} byteLength differs from its body`, kind, object.key);
  }
  return undefined;
}

/** Writes a projection's pointer only when its bytes change. */
async function switchPointer(
  projection: ProjectionReleaseDescriptorV1,
  destination: PublicationObjectStore,
): Promise<"switched" | "unchanged" | PublicationFailure> {
  const currentBody = encode(JSON.stringify(projection.current));
  try {
    const existingCurrent = await destination.get(projection.currentKey);
    if (existingCurrent !== undefined && bytesEqual(existingCurrent, currentBody)) return "unchanged";
    await destination.putCurrent(projection.currentKey, currentBody);
    return "switched";
  } catch (error) {
    return failure("store-error", errorMessage(error), projection.kind, projection.currentKey);
  }
}

type ImmutableObject = ProjectionReleaseDescriptorV1["immutableObjects"][number];

type BodyReader = () => Promise<Uint8Array | undefined>;

async function promoteImmutableObject(
  expected: ImmutableObject,
  kind: ProjectionKind,
  readBody: BodyReader,
  destination: PublicationObjectStore,
): Promise<"created" | "reused" | PublicationFailure> {
  try {
    if (destination.putVerifiedImmutableIfAbsent !== undefined) {
      return await promoteVerified(expected, kind, readBody, destination);
    }
    if (isPoolKey(kind, expected.key)) return await promotePoolObject(expected, kind, readBody, destination);
    const existing = await destination.get(expected.key);
    if (existing !== undefined) {
      const mismatch = await objectMismatch(expected, existing);
      return mismatch === undefined ? "reused" : failure("destination-conflict", mismatch, kind, expected.key);
    }

    const sourceBody = await readBody();
    if (sourceBody === undefined) {
      return failure("source-object-missing", `Source object disappeared: ${expected.key}`, kind, expected.key);
    }
    const outcome = await destination.putImmutableIfAbsent(expected.key, sourceBody);
    const written = await destination.get(expected.key);
    if (written === undefined) {
      return failure("store-error", `Destination object was not readable after write: ${expected.key}`, kind, expected.key);
    }
    const mismatch = await objectMismatch(expected, written);
    if (mismatch !== undefined) return failure("destination-conflict", mismatch, kind, expected.key);
    return outcome === "created" ? "created" : "reused";
  } catch (error) {
    return failure("store-error", errorMessage(error), kind, expected.key);
  }
}

async function promoteVerified(
  expected: ImmutableObject,
  kind: ProjectionKind,
  readBody: BodyReader,
  destination: PublicationObjectStore,
): Promise<"created" | "reused" | PublicationFailure> {
  const sourceBody = await readBody();
  if (sourceBody === undefined) {
    return failure("source-object-missing", `Source object disappeared: ${expected.key}`, kind, expected.key);
  }
  if (await destination.putVerifiedImmutableIfAbsent!(expected, sourceBody) === "created") return "created";
  // A pool key names its digest, and R2 rejected any write whose bytes did not match it.
  if (isPoolKey(kind, expected.key)) return "reused";
  const existing = await destination.get(expected.key);
  if (existing === undefined) {
    return failure("store-error", `Destination object was not readable after write: ${expected.key}`, kind, expected.key);
  }
  const mismatch = await objectMismatch(expected, existing);
  return mismatch === undefined ? "reused" : failure("destination-conflict", mismatch, kind, expected.key);
}

/**
 * Writes a content-addressed detail only when absent. An existing pool key is reused without
 * a read: validation proved its name equals its digest, and pool keys are never rewritten.
 */
async function promotePoolObject(
  expected: ImmutableObject,
  kind: ProjectionKind,
  readBody: BodyReader,
  destination: PublicationObjectStore,
): Promise<"created" | "reused" | PublicationFailure> {
  const sourceBody = await readBody();
  if (sourceBody === undefined) {
    return failure("source-object-missing", `Source object disappeared: ${expected.key}`, kind, expected.key);
  }
  if (await destination.putImmutableIfAbsent(expected.key, sourceBody) === "exists") return "reused";
  // This store does not verify checksums on write, so check the first write of each digest.
  const written = await destination.get(expected.key);
  if (written === undefined) {
    return failure("store-error", `Destination object was not readable after write: ${expected.key}`, kind, expected.key);
  }
  const mismatch = await objectMismatch(expected, written);
  return mismatch === undefined ? "created" : failure("destination-conflict", mismatch, kind, expected.key);
}

/** Runs workers in input order with bounded concurrency and stops starting new work after a failure. */
async function mapUntilFailure<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<R | PublicationFailure>,
): Promise<readonly (R | PublicationFailure)[]> {
  const results: (R | PublicationFailure)[] = [];
  let next = 0;
  let failed = false;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, values.length)) }, async () => {
    while (!failed && next < values.length) {
      const index = next++;
      const result = await worker(values[index]!);
      results[index] = result;
      if (isFailure(result)) failed = true;
    }
  }));
  return results.filter((result) => result !== undefined);
}

function isFailure(value: unknown): value is PublicationFailure {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
}

function buildDescriptor(
  kind: "feed",
  objects: readonly ProjectionObject[],
): Promise<FeedReleaseDescriptorV1>;
function buildDescriptor(
  kind: "search",
  objects: readonly ProjectionObject[],
): Promise<SearchReleaseDescriptorV1>;
async function buildDescriptor(
  kind: ProjectionKind,
  objects: readonly ProjectionObject[],
): Promise<ProjectionReleaseDescriptorV1> {
  const currentKey = kind === "feed" ? MANIFEST_KEY : SEARCH_CURRENT_KEY;
  const currentObjects = objects.filter((object) => object.key === currentKey);
  if (currentObjects.length !== 1) throw new Error(`${kind} projection must contain exactly one current pointer`);
  const immutableObjects = await Promise.all(objects
    .filter((object) => object.key !== currentKey)
    .map(async (object): Promise<ImmutableProjectionObjectV1> => ({
      key: object.key,
      sha256: await sha256Digest(object.body),
      byteLength: encode(object.body).byteLength,
    })));
  const current = parseJson(currentObjects[0]!.body, `${kind} current pointer`);
  if (kind === "feed") {
    if (!isFeedManifest(current)) throw new Error("Feed current pointer is invalid");
    return { kind, releaseId: current.releaseId, currentKey: MANIFEST_KEY, current, immutableObjects };
  }
  if (!isSearchCurrentPointer(current)) throw new Error("Search current pointer is invalid");
  return { kind, releaseId: current.indexRevision, currentKey: SEARCH_CURRENT_KEY, current, immutableObjects };
}

function validateDescriptor(
  descriptor: Readonly<Record<string, unknown>>,
  allKeys: string[],
  issues: string[],
): void {
  const kind = descriptor.kind;
  if (kind !== "feed" && kind !== "search") {
    issues.push("Projection kind must be feed or search");
    return;
  }
  const releaseId = descriptor.releaseId;
  if (typeof releaseId !== "string" || !/^[A-Za-z0-9._-]+$/u.test(releaseId)) {
    issues.push(`${kind} releaseId must be a safe object-key segment`);
    return;
  }
  const expectedCurrentKey = kind === "feed" ? MANIFEST_KEY : SEARCH_CURRENT_KEY;
  if (descriptor.currentKey !== expectedCurrentKey) issues.push(`${kind} currentKey is invalid`);
  const current = descriptor.current;
  if (kind === "feed") {
    if (!isFeedManifest(current)) issues.push("Feed current pointer is invalid");
    else if (current.releaseId !== releaseId) issues.push("Feed releaseId does not match its current pointer");
  } else {
    if (!isSearchCurrentPointer(current)) issues.push("Search current pointer is invalid");
    else if (current.indexRevision !== releaseId) issues.push("Search releaseId does not match its current pointer");
  }

  if (!Array.isArray(descriptor.immutableObjects) || descriptor.immutableObjects.length === 0) {
    issues.push(`${kind} must declare immutable objects`);
    return;
  }
  const prefix = releasePrefix(kind, releaseId);
  const pool = detailPool(kind);
  // Identical details share one pool key, so a repeated key with the same digest is one object.
  const declared = new Map<string, unknown>();
  let conflictingKeys = false;
  for (const rawObject of descriptor.immutableObjects) {
    if (!isRecord(rawObject)) {
      issues.push(`${kind} immutable object must be an object`);
      continue;
    }
    const key = rawObject.key;
    if (typeof key !== "string" || (!key.startsWith(prefix) && !key.startsWith(pool))) {
      issues.push(`${kind} immutable object key must belong to ${prefix} or ${pool}`);
      continue;
    }
    if (key.startsWith(pool) && digestOfPoolKey(pool, key) !== rawObject.sha256) {
      issues.push(`${key} is a ${kind} detail pool key whose name differs from its sha256`);
    }
    requireDigest(rawObject.sha256, `${key} sha256`, issues);
    if (!Number.isSafeInteger(rawObject.byteLength) || Number(rawObject.byteLength) < 0) {
      issues.push(`${key} byteLength must be a non-negative safe integer`);
    }
    if (declared.has(key)) {
      if (declared.get(key) !== rawObject.sha256) conflictingKeys = true;
      continue;
    }
    declared.set(key, rawObject.sha256);
    allKeys.push(key);
  }
  if (conflictingKeys) issues.push(`${kind} immutable object keys must be unique`);
  const projectionKeys = [...declared.keys()];

  if (kind === "feed" && isFeedManifest(current)) {
    if (!projectionKeys.includes(current.feedIndexKey)) issues.push("Feed index is not declared as an immutable object");
    if (current.schema === "osskb.feed-manifest.v3") {
      if (!projectionKeys.includes(current.detailMapKey)) issues.push("Feed detail map is not declared as an immutable object");
      if (!current.feedIndexKey.startsWith(prefix) || !current.detailMapKey.startsWith(prefix)) {
        issues.push("Feed current pointer crosses its release prefix");
      }
    } else {
      if (!current.feedIndexKey.startsWith(prefix) || !current.detailPrefix.startsWith(prefix)) {
        issues.push("Feed current pointer crosses its release prefix");
      }
      if (projectionKeys.some((key) => key.startsWith(pool))) issues.push("feed-manifest.v2 cannot reference pooled details");
      const detailCount = projectionKeys.filter((key) => key.startsWith(current.detailPrefix)).length;
      if (detailCount !== current.entryCount) issues.push("Feed detail count does not match the current pointer");
    }
  }
  if (kind === "search" && isSearchCurrentPointer(current)) {
    if (!projectionKeys.includes(current.releaseManifestKey)) issues.push("Search release manifest is not declared as immutable");
    if (!current.releaseManifestKey.startsWith(prefix)) issues.push("Search current pointer crosses its release prefix");
  }
}

/** A feed-manifest.v3 release must map exactly `entryCount` entries onto its declared pool objects. */
function verifyFeedDetailMapBodies(
  projection: FeedReleaseDescriptorV1,
  bodies: ReadonlyMap<string, Uint8Array>,
): PublicationFailure | undefined {
  const current = projection.current;
  if (current.schema !== "osskb.feed-manifest.v3") return undefined;
  return verifyFeedDetailMap(projection, parseBody(bodies.get(current.detailMapKey)));
}

function verifyFeedDetailMap(
  projection: FeedReleaseDescriptorV1,
  map: unknown,
): PublicationFailure | undefined {
  const current = projection.current;
  if (current.schema !== "osskb.feed-manifest.v3") return undefined;
  const invalid = (message: string, key = current.detailMapKey) =>
    failure("source-manifest-invalid", message, "feed", key);
  if (!isFeedDetailMap(map) || map.releaseId !== projection.releaseId) {
    return invalid("Feed detail map is missing or invalid");
  }
  const digests = Object.values(map.details);
  if (digests.length !== current.entryCount) return invalid("Feed detail map count does not match entryCount");

  const declared = new Map(projection.immutableObjects.map((object) => [object.key, object.sha256]));
  const referenced = new Set<string>();
  for (const digest of digests) {
    const key = detailPoolKey(FEED_DETAIL_POOL, digest);
    if (declared.get(key) !== digest) return invalid(`Feed detail map names an undeclared detail ${key}`, key);
    referenced.add(key);
  }
  const orphan = [...declared.keys()].find((key) => key.startsWith(FEED_DETAIL_POOL) && !referenced.has(key));
  return orphan === undefined ? undefined : invalid(`Feed release declares an unmapped detail ${orphan}`, orphan);
}

function verifySearchManifestBodies(
  projection: SearchReleaseDescriptorV1,
  bodies: ReadonlyMap<string, Uint8Array>,
): PublicationFailure | undefined {
  const manifestBody = bodies.get(projection.current.releaseManifestKey);
  if (manifestBody === undefined) {
    return failure("source-manifest-invalid", "Search release manifest is missing", "search", projection.current.releaseManifestKey);
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBody)) as unknown;
  } catch (error) {
    return failure("source-manifest-invalid", `Search release manifest is invalid: ${errorMessage(error)}`, "search", projection.current.releaseManifestKey);
  }
  return verifySearchManifest(projection, manifest, (key) => {
    const shard = parseBody(bodies.get(key));
    return isSearchLexicalShard(shard) || isSearchLexicalShardV2(shard) ? shard.groups : undefined;
  });
}

/** Checks a Search release's manifest and shard groups against its declared objects. */
function verifySearchManifest(
  projection: SearchReleaseDescriptorV1,
  value: unknown,
  shardGroups: (key: string) => readonly SearchGroupDetailRef[] | undefined,
): PublicationFailure | undefined {
  if (!isSearchReleaseManifest(value)) {
    return failure("source-manifest-invalid", "Search release manifest is invalid: schema validation failed", "search", projection.current.releaseManifestKey);
  }
  const manifest: SearchReleaseManifest = value;
  if (manifest.indexRevision !== projection.releaseId || (manifest.schema === SEARCH_RELEASE_SCHEMA_V1 &&
      manifest.detailPrefix !== `${releasePrefix("search", projection.releaseId)}details/`)) {
    return failure("source-manifest-invalid", "Search release manifest crosses its declared release", "search", projection.current.releaseManifestKey);
  }

  const declared = new Map(projection.immutableObjects.map((object) => [object.key, object]));
  const dataKeys = [...declared.keys()].filter((key) => key !== projection.current.releaseManifestKey).sort();
  const manifestKeys = Object.keys(manifest.objectDigests).sort();
  if (JSON.stringify(manifestKeys) !== JSON.stringify(dataKeys)) {
    return failure("source-manifest-invalid", "Search manifest object list is incomplete or contains an orphan", "search", projection.current.releaseManifestKey);
  }
  for (const [key, digest] of Object.entries(manifest.objectDigests)) {
    if (declared.get(key)?.sha256 !== digest) {
      return failure("source-manifest-invalid", `Search manifest digest differs for ${key}`, "search", key);
    }
  }
  const shardKeys = searchShardKeys(manifest);
  if (!shardKeys.every((key) => declared.has(key)) || new Set(shardKeys).size !== shardKeys.length) {
    return failure("source-manifest-invalid", "Search manifest names an undeclared shard", "search", projection.current.releaseManifestKey);
  }
  if (manifest.schema === SEARCH_RELEASE_SCHEMA && !declared.has(searchTermsKey(manifest.indexRevision))) {
    return failure("source-manifest-invalid", "Search release does not declare its terms object", "search", projection.current.releaseManifestKey);
  }
  if (manifest.schema === SEARCH_RELEASE_SCHEMA_V1) {
    const detailCount = dataKeys.filter((key) => key.startsWith(manifest.detailPrefix)).length;
    if (detailCount !== manifest.groupCount) {
      return failure("source-manifest-invalid", "Search detail count does not match groupCount", "search", projection.current.releaseManifestKey);
    }
    return undefined;
  }

  // search-release.v2/v3: every group names a declared pool detail, and every pool detail is named.
  const referenced = new Set<string>();
  let groupCount = 0;
  for (const shardKey of shardKeys) {
    const groups = shardGroups(shardKey);
    if (groups === undefined) {
      return failure("source-manifest-invalid", `Search shard is invalid: ${shardKey}`, "search", shardKey);
    }
    for (const group of groups) {
      groupCount += 1;
      const digest = group.detailSha256;
      const key = isSha256Digest(digest) ? detailPoolKey(SEARCH_DETAIL_POOL, digest) : undefined;
      if (key === undefined || manifest.objectDigests[key] !== digest) {
        return failure("source-manifest-invalid", `Search group ${group.groupRootRecordId} names an undeclared detail`, "search", shardKey);
      }
      referenced.add(key);
    }
  }
  if (groupCount !== manifest.groupCount) {
    return failure("source-manifest-invalid", "Search group count does not match groupCount", "search", projection.current.releaseManifestKey);
  }
  const orphan = dataKeys.find((key) => key.startsWith(SEARCH_DETAIL_POOL) && !referenced.has(key));
  if (orphan !== undefined) {
    return failure("source-manifest-invalid", `Search release declares an unreferenced detail ${orphan}`, "search", orphan);
  }
  return undefined;
}

async function objectMismatch(
  expected: ImmutableProjectionObjectV1,
  body: Uint8Array,
): Promise<string | undefined> {
  if (body.byteLength !== expected.byteLength) {
    return `Byte length mismatch for ${expected.key}: expected ${expected.byteLength}, got ${body.byteLength}`;
  }
  const digest = await sha256Digest(body);
  if (digest !== expected.sha256) {
    return `SHA-256 mismatch for ${expected.key}: expected ${expected.sha256}, got ${digest}`;
  }
  return undefined;
}

function detailPool(kind: ProjectionKind): string {
  return kind === "feed" ? FEED_DETAIL_POOL : SEARCH_DETAIL_POOL;
}

function isPoolKey(kind: ProjectionKind, key: string): boolean {
  return digestOfPoolKey(detailPool(kind), key) !== undefined;
}

function uniqueObjects(objects: readonly ImmutableProjectionObjectV1[]): readonly ImmutableProjectionObjectV1[] {
  return [...new Map(objects.map((object) => [object.key, object])).values()];
}

function releasePrefix(kind: ProjectionKind, releaseId: string): string {
  return kind === "feed"
    ? `public/v2/releases/${releaseId}/`
    : `public/search/v1/releases/${releaseId}/`;
}

function failure(
  kind: PublicationFailureKind,
  message: string,
  projectionKind?: ProjectionKind,
  objectKey?: string,
): PublicationFailure {
  return {
    ok: false,
    kind,
    message,
    ...(projectionKind === undefined ? {} : { projectionKind }),
    ...(objectKey === undefined ? {} : { objectKey }),
  };
}

function requireNonEmpty(value: unknown, label: string, issues: string[]): void {
  if (typeof value !== "string" || value.trim().length === 0) issues.push(`${label} must not be empty`);
}

function requireTimestamp(value: unknown, label: string, issues: string[]): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) issues.push(`${label} must be a timestamp`);
}

function requireDigest(value: unknown, label: string, issues: string[]): void {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) issues.push(`${label} must be a SHA-256 digest`);
}

function parseJson(body: string, label: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function parseBody(body: Uint8Array | undefined): unknown {
  if (body === undefined) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
