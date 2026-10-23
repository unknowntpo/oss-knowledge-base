/**
 * Spec 019 amendment (8): the `identity-backfill` job in the publisher Worker. Its own cron entry
 * (`IDENTITY_BACKFILL_CRON`, `23 1 * * *` once enabled) and `POST /identity-backfill/run`; it never
 * starts, waits for or is started by another job, and writes only
 * `internal/identity/v1/<projectId>/backfill/` and `internal/identity/v1/backfill-last-run.json`
 * (W124). `IDENTITY_BACKFILL` unset or blank: nothing runs, nothing is read, `/health` has no field (W125).
 */
import {
  IDENTITY_BACKFILL_LAST_RUN_KEY,
  KAFKA_IDENTITY_BACKFILL,
  runIdentityBackfill,
  type IdentityBackfillBucket,
  type IdentityBackfillRecordV1,
  type IdentityBackfillResult,
} from "@oss-knowledge-base/reference-pipeline/identity-backfill";
import { signalsFor, type SignalsEnv } from "../signals/env";
import { identityBackfillSignalRun, runIdFor } from "../signals/point";
import { runLog, type RunContext } from "../signals/recorder";

const metadata = { httpMetadata: { contentType: "application/json", cacheControl: "no-store" } };

export class R2IdentityBackfillBucket implements IdentityBackfillBucket {
  constructor(private readonly bucket: R2Bucket) {}

  async get(key: string): Promise<string | undefined> {
    const object = await this.bucket.get(key);
    return object === null ? undefined : object.text();
  }

  async put(key: string, body: string): Promise<void> {
    await this.bucket.put(key, body, metadata);
  }
}

export interface IdentityBackfillEnv extends Partial<SignalsEnv> {
  readonly IDENTITY_BACKFILL?: string;
  readonly GITHUB_SOURCE_TOKEN?: string;
  readonly OSS_KB_BUCKET: R2Bucket;
}

/** The flag is "set" when it is not blank, whether or not its value is supported (an unsupported value fails the run). */
export function identityBackfillSet(env: Pick<IdentityBackfillEnv, "IDENTITY_BACKFILL">): boolean {
  return (env.IDENTITY_BACKFILL?.trim() ?? "") !== "";
}

/**
 * The scheduled handler may run 15 minutes; a run is at most 9 requests of 30 s plus 8 pauses of
 * 3 s (about 5 minutes). The run stops before a request that could end after 14 minutes, on the
 * cron path and the route alike, leaving time to write the record.
 */
export const IDENTITY_BACKFILL_WALL_MS = 14 * 60_000;

export function identityBackfillRun(env: IdentityBackfillEnv, options: { readonly manual: boolean }): Promise<IdentityBackfillResult> {
  const signals = env.PUBLICATION_ENVIRONMENT === undefined ? undefined : signalsFor(env as SignalsEnv);
  let context: RunContext | undefined;
  return runIdentityBackfill({
    flag: env.IDENTITY_BACKFILL ?? "",
    profile: KAFKA_IDENTITY_BACKFILL,
    bucket: new R2IdentityBackfillBucket(env.OSS_KB_BUCKET),
    githubToken: env.GITHUB_SOURCE_TOKEN ?? "",
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    delay: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    deadline: Date.now() + IDENTITY_BACKFILL_WALL_MS,
    manual: options.manual,
    // Spec 028: the run's point and trend result, in the record put the run already makes.
    ...(signals === undefined ? {} : {
      finish: async (record: IdentityBackfillRecordV1) => {
        if (record.lastRun === null) return record;
        const runId = runIdFor("identity-backfill", record.lastRun.at);
        context = { runId, job: "identity-backfill" };
        return { ...record, lastRun: { ...record.lastRun, runId, trends: await signals.finish(identityBackfillSignalRun(record.lastRun, { runId })) } };
      },
      log: (message: string) => runLog(context, "error", message),
    }),
  });
}

/**
 * W130: `/health` `identityBackfill`, the record as written (1 Class B); before the first run, the
 * revision with nothing run. Undefined (no field, no read) while the flag is unset; null when the
 * record cannot be read.
 */
export async function identityBackfillHealth(env: IdentityBackfillEnv): Promise<IdentityBackfillRecordV1 | null | undefined> {
  if (!identityBackfillSet(env)) return undefined;
  try {
    const object = await env.OSS_KB_BUCKET.get(IDENTITY_BACKFILL_LAST_RUN_KEY);
    if (object === null) return { revision: env.IDENTITY_BACKFILL!.trim(), lastRun: null, months: { done: [], next: null, remaining: 0 }, from: null, until: null };
    return JSON.parse(await object.text()) as IdentityBackfillRecordV1;
  } catch {
    return null;
  }
}
