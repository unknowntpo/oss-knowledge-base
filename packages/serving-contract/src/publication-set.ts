import type { FeedManifest } from "./index";
import {
  isFeedManifest,
  MANIFEST_KEY,
  type ProjectionObject,
} from "./r2";
import {
  isSearchCurrentPointer,
  isSearchReleaseManifest,
  SEARCH_CURRENT_KEY,
  type SearchCurrentPointerV1,
  type SearchReleaseManifestV1,
} from "./search-r2";

export type Sha256Digest = `sha256:${string}`;
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
  const searchManifestFailure = await verifySearchManifest(
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
    if (projection.kind === "search") {
      const manifestFailure = await verifySearchManifest(projection, bodies);
      if (manifestFailure !== undefined) return manifestFailure;
    }
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
      projection.immutableObjects,
      options.concurrency ?? 1,
      (expected) => promoteImmutableObject(expected, projection.kind, source, destination),
    );
    for (const outcome of outcomes) {
      if (typeof outcome !== "string") return outcome;
      if (outcome === "created") copiedObjectCount += 1;
      else reusedObjectCount += 1;
    }

    const currentBody = encode(JSON.stringify(projection.current));
    try {
      const existingCurrent = await destination.get(projection.currentKey);
      if (existingCurrent !== undefined && bytesEqual(existingCurrent, currentBody)) {
        unchangedProjections.push(projection.kind);
      } else {
        await destination.putCurrent(projection.currentKey, currentBody);
        switchedProjections.push(projection.kind);
      }
    } catch (error) {
      return failure("store-error", errorMessage(error), projection.kind, projection.currentKey);
    }
  }

  return {
    ok: true,
    copiedObjectCount,
    reusedObjectCount,
    switchedProjections,
    unchangedProjections,
  };
}

type ImmutableObject = ProjectionReleaseDescriptorV1["immutableObjects"][number];

async function promoteImmutableObject(
  expected: ImmutableObject,
  kind: ProjectionKind,
  source: Pick<PublicationObjectStore, "get">,
  destination: PublicationObjectStore,
): Promise<"created" | "reused" | PublicationFailure> {
  try {
    if (destination.putVerifiedImmutableIfAbsent !== undefined) {
      return await promoteVerified(expected, kind, source, destination);
    }
    const existing = await destination.get(expected.key);
    if (existing !== undefined) {
      const mismatch = await objectMismatch(expected, existing);
      return mismatch === undefined ? "reused" : failure("destination-conflict", mismatch, kind, expected.key);
    }

    const sourceBody = await source.get(expected.key);
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
  source: Pick<PublicationObjectStore, "get">,
  destination: PublicationObjectStore,
): Promise<"created" | "reused" | PublicationFailure> {
  const sourceBody = await source.get(expected.key);
  if (sourceBody === undefined) {
    return failure("source-object-missing", `Source object disappeared: ${expected.key}`, kind, expected.key);
  }
  if (await destination.putVerifiedImmutableIfAbsent!(expected, sourceBody) === "created") return "created";
  const existing = await destination.get(expected.key);
  if (existing === undefined) {
    return failure("store-error", `Destination object was not readable after write: ${expected.key}`, kind, expected.key);
  }
  const mismatch = await objectMismatch(expected, existing);
  return mismatch === undefined ? "reused" : failure("destination-conflict", mismatch, kind, expected.key);
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

export async function sha256Digest(body: Uint8Array | string): Promise<Sha256Digest> {
  const bytes = typeof body === "string" ? encode(body) : body;
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
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
  const projectionKeys: string[] = [];
  for (const rawObject of descriptor.immutableObjects) {
    if (!isRecord(rawObject)) {
      issues.push(`${kind} immutable object must be an object`);
      continue;
    }
    if (typeof rawObject.key !== "string" || !rawObject.key.startsWith(prefix)) {
      issues.push(`${kind} immutable object key must belong to ${prefix}`);
      continue;
    }
    projectionKeys.push(rawObject.key);
    allKeys.push(rawObject.key);
    requireDigest(rawObject.sha256, `${rawObject.key} sha256`, issues);
    if (!Number.isSafeInteger(rawObject.byteLength) || Number(rawObject.byteLength) < 0) {
      issues.push(`${rawObject.key} byteLength must be a non-negative safe integer`);
    }
  }
  if (new Set(projectionKeys).size !== projectionKeys.length) {
    issues.push(`${kind} immutable object keys must be unique`);
  }

  if (kind === "feed" && isFeedManifest(current)) {
    if (!projectionKeys.includes(current.feedIndexKey)) issues.push("Feed index is not declared as an immutable object");
    if (!current.feedIndexKey.startsWith(prefix) || !current.detailPrefix.startsWith(prefix)) {
      issues.push("Feed current pointer crosses its release prefix");
    }
    const detailCount = projectionKeys.filter((key) => key.startsWith(current.detailPrefix)).length;
    if (detailCount !== current.entryCount) issues.push("Feed detail count does not match the current pointer");
  }
  if (kind === "search" && isSearchCurrentPointer(current)) {
    if (!projectionKeys.includes(current.releaseManifestKey)) issues.push("Search release manifest is not declared as immutable");
    if (!current.releaseManifestKey.startsWith(prefix)) issues.push("Search current pointer crosses its release prefix");
  }
}

async function verifySearchManifest(
  projection: SearchReleaseDescriptorV1,
  bodies: ReadonlyMap<string, Uint8Array>,
): Promise<PublicationFailure | undefined> {
  const manifestBody = bodies.get(projection.current.releaseManifestKey);
  if (manifestBody === undefined) {
    return failure("source-manifest-invalid", "Search release manifest is missing", "search", projection.current.releaseManifestKey);
  }
  let manifest: SearchReleaseManifestV1;
  try {
    const value = JSON.parse(new TextDecoder().decode(manifestBody)) as unknown;
    if (!isSearchReleaseManifest(value)) throw new Error("schema validation failed");
    manifest = value;
  } catch (error) {
    return failure("source-manifest-invalid", `Search release manifest is invalid: ${errorMessage(error)}`, "search", projection.current.releaseManifestKey);
  }
  if (manifest.indexRevision !== projection.releaseId ||
      manifest.detailPrefix !== `${releasePrefix("search", projection.releaseId)}details/`) {
    return failure("source-manifest-invalid", "Search release manifest crosses its declared release", "search", projection.current.releaseManifestKey);
  }

  const declared = new Map(projection.immutableObjects.map((object) => [object.key, object]));
  const dataObjects = projection.immutableObjects.filter((object) => object.key !== projection.current.releaseManifestKey);
  const manifestKeys = Object.keys(manifest.objectDigests).sort();
  const dataKeys = dataObjects.map((object) => object.key).sort();
  if (JSON.stringify(manifestKeys) !== JSON.stringify(dataKeys)) {
    return failure("source-manifest-invalid", "Search manifest object list is incomplete or contains an orphan", "search", projection.current.releaseManifestKey);
  }
  for (const [key, digest] of Object.entries(manifest.objectDigests)) {
    if (declared.get(key)?.sha256 !== digest) {
      return failure("source-manifest-invalid", `Search manifest digest differs for ${key}`, "search", key);
    }
  }
  if (!Object.values(manifest.shardKeys).every((key) => declared.has(key))) {
    return failure("source-manifest-invalid", "Search manifest names an undeclared shard", "search", projection.current.releaseManifestKey);
  }
  const detailCount = dataKeys.filter((key) => key.startsWith(manifest.detailPrefix)).length;
  if (detailCount !== manifest.groupCount) {
    return failure("source-manifest-invalid", "Search detail count does not match groupCount", "search", projection.current.releaseManifestKey);
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
