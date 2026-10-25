/**
 * Spec 019 amendment (7), KIP authors revision: the `kip-pages` job in the publisher Worker. Its own
 * cron entry (`KIP_PAGES_CRON`, 03:43 UTC once enabled) and `POST /kip-pages/run`; it never starts,
 * waits for or is started by another job, and writes only under `internal/kips/v1/` (W98).
 * `KIP_PAGES` unset or blank: nothing runs, nothing is read, `/health` has no field (W99).
 */
import { KAFKA_KIP_PAGES, KIP_PAGES_LAST_RUN_KEY, runKipPages, type KipPagesBucket, type KipPagesHealthV1 } from "@oss-knowledge-base/reference-pipeline/kip-pages";
import { signalsFor, type SignalsEnv } from "../signals/env";
import { kipPagesSignalRun, runIdFor } from "../signals/point";
import { runLog, type RunContext } from "../signals/recorder";

const metadata = { httpMetadata: { contentType: "application/json", cacheControl: "no-store" } };

export class R2KipPagesBucket implements KipPagesBucket {
  constructor(private readonly bucket: R2Bucket) {}

  async get(key: string): Promise<string | undefined> {
    const object = await this.bucket.get(key);
    return object === null ? undefined : object.text();
  }

  async put(key: string, body: string): Promise<void> {
    await this.bucket.put(key, body, metadata);
  }
}

export interface KipPagesEnv extends Partial<SignalsEnv> {
  readonly KIP_PAGES?: string;
  readonly OSS_KB_BUCKET: R2Bucket;
}

/** The flag is "set" when it is not blank, whether or not its value is supported (an unsupported value fails the run). */
export function kipPagesSet(env: Pick<KipPagesEnv, "KIP_PAGES">): boolean {
  return (env.KIP_PAGES?.trim() ?? "") !== "";
}

/**
 * The scheduled handler may run 15 minutes; the worst case of a run is 13 requests of 90 s plus
 * 12 pauses of 2 s, about 19.9 minutes. The cron path stops before a request that could end after
 * 14 minutes, leaving time to write `last-run.json`. `POST /kip-pages/run` has no such limit.
 */
export const KIP_PAGES_CRON_WALL_MS = 14 * 60_000;

/** The job's upstream transport; Spec 027's `throw` drill (B40) swaps it for one that answers 503 without sending. */
export type KipPagesTransport = (url: string, init: RequestInit) => Promise<Response>;

export function kipPagesRun(env: KipPagesEnv, dryRun: boolean, deadline?: number, transport: KipPagesTransport = (url, init) => fetch(url, init)): Promise<KipPagesHealthV1> {
  const signals = env.PUBLICATION_ENVIRONMENT === undefined ? undefined : signalsFor(env as SignalsEnv);
  let context: RunContext | undefined;
  return runKipPages({
    flag: env.KIP_PAGES ?? "",
    profile: KAFKA_KIP_PAGES,
    bucket: new R2KipPagesBucket(env.OSS_KB_BUCKET),
    fetch: transport,
    now: () => Date.now(),
    delay: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    dryRun,
    ...(deadline === undefined ? {} : { deadline }),
    // Spec 028: the run's point and trend result, in the `last-run.json` put the run already makes.
    ...(signals === undefined ? {} : {
      finish: async (health: KipPagesHealthV1) => {
        if (health.lastRun === null) return health;
        const runId = runIdFor("kip-pages", health.lastRun.at);
        context = { runId, job: "kip-pages" };
        return { ...health, lastRun: { ...health.lastRun, runId, trends: await signals.finish(kipPagesSignalRun(health.lastRun, { runId })) } as KipPagesHealthV1["lastRun"] };
      },
      log: (message: string) => runLog(context, "error", message),
    }),
  });
}

/**
 * W100: `/health` `kipPages`, the run record as written; before the first run, the revision with
 * nothing run. Undefined (no field) while the flag is unset; null when the record cannot be read.
 */
export async function kipPagesHealth(env: KipPagesEnv): Promise<KipPagesHealthV1 | null | undefined> {
  if (!kipPagesSet(env)) return undefined;
  try {
    const object = await env.OSS_KB_BUCKET.get(KIP_PAGES_LAST_RUN_KEY);
    if (object === null) return { revision: env.KIP_PAGES!.trim(), lastRun: null, lastGoodAt: null, coverageFrom: null };
    return JSON.parse(await object.text()) as KipPagesHealthV1;
  } catch {
    return null;
  }
}
