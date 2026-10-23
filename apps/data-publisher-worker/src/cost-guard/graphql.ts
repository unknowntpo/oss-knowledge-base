/**
 * Spec 026 Behavior 3: one Cloudflare GraphQL Analytics request for the account's R2 operations
 * (month to date, and over the 7 complete UTC days before today for the CG35 rate) and R2 storage.
 * `datetime_lt` is used as on the same page's bandwidth example. Dataset and field names: R2 "Metrics and analytics",
 * https://developers.cloudflare.com/r2/platform/metrics-analytics/ (read 2026-10-20). The token
 * travels only in the Authorization header and never into an error text.
 */
import { sanitizeErrorMessage } from "@oss-knowledge-base/semantic-vectorize";

import { COST_GUARD_RATE_DAYS } from "./profile";

export const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

/** https://developers.cloudflare.com/r2/pricing/ ("Class A operations"). */
export const R2_CLASS_A_ACTIONS: ReadonlySet<string> = new Set([
  "ListBuckets", "PutBucket", "ListObjects", "PutObject", "CopyObject", "CompleteMultipartUpload", "CreateMultipartUpload",
  "LifecycleStorageTierTransition", "ListMultipartUploads", "UploadPart", "UploadPartCopy", "ListParts", "PutBucketEncryption",
  "PutBucketCors", "PutBucketLifecycleConfiguration",
]);
/** Same page, "Class B operations". */
export const R2_CLASS_B_ACTIONS: ReadonlySet<string> = new Set([
  "HeadBucket", "HeadObject", "GetObject", "UsageSummary", "GetBucketEncryption", "GetBucketLocation", "GetBucketCors",
  "GetBucketLifecycleConfiguration",
]);
/** Same page, "Free operations". */
export const R2_FREE_ACTIONS: ReadonlySet<string> = new Set(["DeleteObject", "DeleteBucket", "AbortMultipartUpload"]);

/** Storage rows are read over this window; the newest row per bucket is the level. */
const STORAGE_WINDOW_MS = 2 * 86_400_000;

const QUERY = `query CostGuardR2($accountTag: string!, $start: Time!, $end: Time!, $storageStart: Time!, $recentStart: Time!, $today: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      operations: r2OperationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_leq: $end }) {
        sum { requests }
        dimensions { actionType }
      }
      recent: r2OperationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $recentStart, datetime_lt: $today }) {
        sum { requests }
        dimensions { actionType }
      }
      storage: r2StorageAdaptiveGroups(limit: 10000, filter: { datetime_geq: $storageStart, datetime_leq: $end }, orderBy: [datetime_DESC]) {
        max { payloadSize metadataSize }
        dimensions { bucketName datetime }
      }
    }
  }
}`;

/**
 * Operations from the first instant of the UTC month to `now` (never more than the 31 days a query
 * may span), and over the 7 complete UTC days before today for the rate (CG35; it may reach into the
 * previous month and never includes today).
 */
export function r2UsageRequest(accountId: string, now: Date): { readonly query: string; readonly variables: Readonly<Record<string, string>> } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return {
    query: QUERY,
    variables: {
      accountTag: accountId,
      start: start.toISOString(),
      end: now.toISOString(),
      storageStart: new Date(now.getTime() - STORAGE_WINDOW_MS).toISOString(),
      recentStart: new Date(today - COST_GUARD_RATE_DAYS * 86_400_000).toISOString(),
      today: new Date(today).toISOString(),
    },
  };
}

export interface R2Usage {
  readonly classA: number;
  readonly classB: number;
  /** The account's operations over the `days` complete UTC days before today (CG35). */
  readonly recent: { readonly classA: number; readonly classB: number; readonly days: number };
  /** Newest `payloadSize + metadataSize` of each bucket, summed. */
  readonly storageBytes: number;
  /** Action types on no list of the pricing page; counted as Class A. */
  readonly unclassifiedActions: readonly string[];
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const count = (value: unknown, what: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`GraphQL answer has no valid ${what}`);
  return value;
};

/** Throws on `errors[]` or any shape it does not expect, so a bad answer never reads as zero. */
export function parseR2Usage(body: unknown): R2Usage {
  const root = record(body);
  if (root === undefined) throw new Error("GraphQL answer is not an object");
  if (Array.isArray(root.errors) && root.errors.length > 0) {
    const messages = root.errors.map((error) => String(record(error)?.message ?? "unknown error")).join("; ");
    throw new Error(`GraphQL errors: ${messages}`);
  }
  const accounts = record(record(root.data)?.viewer)?.accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1) throw new Error("GraphQL answer has no account");
  const account = record(accounts[0]);
  if (account === undefined || !Array.isArray(account.operations) || !Array.isArray(account.recent) || !Array.isArray(account.storage)) {
    throw new Error("GraphQL answer has no R2 datasets");
  }
  const unclassified = new Set<string>();
  const { classA, classB } = classify(account.operations, unclassified);
  const recent = classify(account.recent, unclassified);
  const newest = new Map<string, { readonly at: string; readonly bytes: number }>();
  for (const row of account.storage) {
    const dimensions = record(record(row)?.dimensions);
    const max = record(record(row)?.max);
    const bucket = dimensions?.bucketName;
    const at = dimensions?.datetime;
    if (typeof bucket !== "string" || typeof at !== "string") throw new Error("GraphQL answer has a storage row without bucket or time");
    const bytes = count(max?.payloadSize, "payload size") + count(max?.metadataSize ?? 0, "metadata size");
    const seen = newest.get(bucket);
    if (seen === undefined || at > seen.at) newest.set(bucket, { at, bytes });
  }
  const storageBytes = [...newest.values()].reduce((sum, row) => sum + row.bytes, 0);
  return { classA, classB, storageBytes, recent: { ...recent, days: COST_GUARD_RATE_DAYS }, unclassifiedActions: [...unclassified].sort() };
}

/** Sums operation rows by pricing class; an action on no list counts as Class A and is noted. */
function classify(rows: readonly unknown[], unclassified: Set<string>): { readonly classA: number; readonly classB: number } {
  let classA = 0;
  let classB = 0;
  for (const row of rows) {
    const action = record(record(row)?.dimensions)?.actionType;
    const requests = count(record(record(row)?.sum)?.requests, "request count");
    if (typeof action !== "string") throw new Error("GraphQL answer has an operation without an action type");
    if (R2_FREE_ACTIONS.has(action)) continue;
    if (R2_CLASS_B_ACTIONS.has(action)) classB += requests;
    else {
      if (!R2_CLASS_A_ACTIONS.has(action)) unclassified.add(action);
      classA += requests;
    }
  }
  return { classA, classB };
}

export type GraphqlFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Every error text is sanitized and stripped of the token before it leaves this function. */
export async function fetchR2Usage(input: { readonly fetch: GraphqlFetch; readonly token: string; readonly accountId: string; readonly now: Date }): Promise<R2Usage> {
  const scrub = (text: string) => sanitizeErrorMessage(text.split(input.token).join("[redacted]"));
  try {
    const response = await input.fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
      body: JSON.stringify(r2UsageRequest(input.accountId, input.now)),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`GraphQL answered ${response.status}: ${text.slice(0, 120)}`);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error("GraphQL answer is not JSON");
    }
    return parseR2Usage(body);
  } catch (error) {
    throw new Error(scrub(error instanceof Error ? error.message : String(error)));
  }
}
