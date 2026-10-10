/**
 * Spec 016 Behavior 14–15: the `SearchEmbeddingRun` Durable Object's logic, free of Workers types
 * so it is testable. Like the digest it has its own object, memory, and alarm: nothing here can
 * fail, delay, or re-run a publication. A real run starts from the alarm; a dry run runs inline
 * and writes nothing.
 */
import {
  resolveSearchEmbedding,
  workersAiEmbedder,
  type EmbeddingAiBinding,
  type EmbedTexts,
  type SearchEmbeddingProfile,
  type VectorIndex,
} from "@oss-knowledge-base/semantic-vectorize";

import { runPending } from "../run-schedule";
import {
  DEFAULT_EMBEDDING_LIMITS,
  failedEmbeddingRun,
  runSearchEmbedding,
  type EmbeddingLimits,
  type EmbeddingRunResult,
  type ReleaseReader,
} from "./run";
import { EmbeddingState, type AcceptedMutation, type EmbeddingStorage, type LastEmbeddingError } from "./state";

export interface SearchEmbeddingRunnerDeps {
  readonly storage: EmbeddingStorage;
  readonly bucket: ReleaseReader;
  /** `SEARCH_EMBEDDING` as configured: blank is off, an unknown value is an error. */
  readonly flag: string | undefined;
  /** `SEARCH_GATEWAY_ID`: the search AI Gateway. */
  readonly gatewayId: string | undefined;
  /** The digest's gateway, which embeddings must never use. */
  readonly digestGatewayId?: string | undefined;
  readonly ai?: EmbeddingAiBinding | undefined;
  readonly index?: VectorIndex | undefined;
  readonly now: () => Date;
  readonly delay: (ms: number) => Promise<void>;
  readonly limits?: Partial<EmbeddingLimits>;
}

export type SearchEmbeddingConfig =
  | { readonly state: "off" }
  | { readonly state: "error"; readonly error: string; readonly profile?: SearchEmbeddingProfile }
  | { readonly state: "on"; readonly profile: SearchEmbeddingProfile; readonly embed: EmbedTexts; readonly index: VectorIndex };

/** Off without the flag; on only with a supported profile, the search gateway, the AI binding, and the index. */
export function searchEmbeddingConfig(deps: Pick<SearchEmbeddingRunnerDeps, "flag" | "gatewayId" | "digestGatewayId" | "ai" | "index">): SearchEmbeddingConfig {
  let profile: SearchEmbeddingProfile | undefined;
  try {
    profile = resolveSearchEmbedding(deps.flag);
  } catch (error) {
    return { state: "error", error: error instanceof Error ? error.message : String(error) };
  }
  if (profile === undefined) return { state: "off" };
  const gatewayId = deps.gatewayId?.trim() ?? "";
  const missing = gatewayId === "" ? "SEARCH_GATEWAY_ID is not set"
    : gatewayId === (deps.digestGatewayId?.trim() ?? "") ? `SEARCH_GATEWAY_ID "${gatewayId}" is the digest gateway`
    : deps.ai === undefined ? "the AI binding is missing"
    : deps.index === undefined ? "the SEARCH_VECTORS binding is missing"
    : undefined;
  if (missing !== undefined || deps.ai === undefined || deps.index === undefined) {
    return { state: "error", error: `SEARCH_EMBEDDING is "${profile.key}" but ${missing}`, profile };
  }
  // The state decides what is embedded; a gateway cache hit would only hide a real call's cost.
  return { state: "on", profile, embed: workersAiEmbedder(deps.ai, gatewayId, profile, { skipCache: true }), index: deps.index };
}

export interface SearchEmbeddingHealth {
  readonly enabled: boolean;
  readonly configError?: string;
  readonly model: string | null;
  readonly revision: string | null;
  readonly semanticRevision: string | null;
  readonly running: boolean;
  readonly scheduled: boolean;
  /** A run that started and never recorded a result (the platform killed it); null otherwise. */
  readonly interrupted: { readonly startedAt: string } | null;
  readonly today: { readonly date: string; readonly estimatedNeurons: number; readonly cap: number; readonly calls: number; readonly callCap: number };
  readonly lastMutation: AcceptedMutation | null;
  /** The last model or vector-store failure, until a later run embeds successfully. */
  readonly lastError: LastEmbeddingError | null;
  readonly lastRun: EmbeddingRunResult | null;
}

/** `/health` `searchEmbedding` where the embedding object is not bound (Prod, local). */
export function unboundSearchEmbeddingHealth(flag: string | undefined, now: Date): SearchEmbeddingHealth {
  const set = (flag?.trim() ?? "") !== "";
  return {
    enabled: false,
    ...(set ? { configError: `SEARCH_EMBEDDING is "${flag}" but the SEARCH_EMBEDDING_RUN binding is missing` } : {}),
    model: null,
    revision: null,
    semanticRevision: null,
    running: false,
    scheduled: false,
    interrupted: null,
    today: { date: now.toISOString().slice(0, 10), estimatedNeurons: 0, cap: DEFAULT_EMBEDDING_LIMITS.dailyNeuronCap, calls: 0, callCap: DEFAULT_EMBEDDING_LIMITS.maxCallsPerDay },
    lastMutation: null,
    lastError: null,
    lastRun: null,
  };
}

const RUN_MARKER = "run-started";

export class SearchEmbeddingRunner {
  private running = false;
  private readonly state: EmbeddingState;

  constructor(private readonly deps: SearchEmbeddingRunnerDeps) {
    this.state = new EmbeddingState(deps.storage);
  }

  private get limits(): EmbeddingLimits {
    return { ...DEFAULT_EMBEDDING_LIMITS, ...this.deps.limits };
  }

  async health(): Promise<SearchEmbeddingHealth> {
    const config = searchEmbeddingConfig(this.deps);
    const now = this.deps.now();
    const date = now.toISOString().slice(0, 10);
    const ledger = await this.state.ledger(date);
    const profile = config.state === "off" ? undefined : config.profile;
    const marker = await this.deps.storage.get<{ readonly startedAt: string }>(RUN_MARKER);
    return {
      enabled: config.state === "on",
      ...(config.state === "error" ? { configError: config.error } : {}),
      model: profile?.revision.model ?? null,
      revision: profile?.key ?? null,
      semanticRevision: profile?.semanticRevision ?? null,
      running: this.running,
      scheduled: runPending(false, await this.deps.storage.getAlarm(), now.getTime()),
      interrupted: this.running ? null : marker ?? null,
      today: { date, estimatedNeurons: ledger.neurons, cap: this.limits.dailyNeuronCap, calls: ledger.calls, callCap: this.limits.maxCallsPerDay },
      lastMutation: (await this.state.lastMutation()) ?? null,
      lastError: (await this.state.lastError()) ?? null,
      lastRun: (await this.deps.storage.get<EmbeddingRunResult>("lastRun")) ?? null,
    };
  }

  /**
   * `POST /search-embedding/run[?dryRun=1[&profile=…]][&reset=1]`, and the publisher's trigger after a
   * publication. While the flag is off only the two requests that call no model and no index are
   * served: a dry run for a named profile (the estimate before enabling) and a reset.
   */
  async request(options: { readonly dryRun?: boolean; readonly reset?: boolean; readonly profile?: string } = {}): Promise<{ readonly status: number; readonly body: unknown }> {
    const config = searchEmbeddingConfig(this.deps);
    if (options.dryRun === true && options.reset === true) return { status: 400, body: { ok: false, error: "reset cannot be combined with dryRun" } };
    if (config.state === "off") return this.requestWhileOff(options);
    if (config.state === "error") return { status: 500, body: await this.recordConfigError(config, options.dryRun === true) };
    if (runPending(this.running, await this.deps.storage.getAlarm(), this.deps.now().getTime())) {
      return { status: 409, body: { ok: false, skipped: "already-running" } };
    }
    if (options.dryRun === true) {
      const result = await this.execute(config, true);
      return { status: result.ok ? 200 : 500, body: result };
    }
    const forgotten = options.reset === true ? await this.state.clear() : undefined;
    await this.deps.storage.setAlarm(this.deps.now().getTime());
    return { status: 202, body: { ok: true, scheduled: true, ...(forgotten === undefined ? {} : { forgotten }) } };
  }

  private async requestWhileOff(options: { readonly dryRun?: boolean; readonly reset?: boolean; readonly profile?: string }): Promise<{ readonly status: number; readonly body: unknown }> {
    if (options.reset === true) return { status: 200, body: { ok: true, scheduled: false, forgotten: await this.state.clear() } };
    if (options.dryRun !== true || (options.profile?.trim() ?? "") === "") return { status: 403, body: { ok: false, disabled: true } };
    let profile: SearchEmbeddingProfile;
    try {
      profile = resolveSearchEmbedding(options.profile)!;
    } catch (error) {
      return { status: 400, body: { ok: false, error: error instanceof Error ? error.message : String(error) } };
    }
    // A dry run reaches neither: both refuse, so a mistake here cannot spend or mutate.
    const refuse = async (): Promise<never> => { throw new Error("A dry run must not call the model or the index"); };
    const result = await this.execute({ state: "on", profile, embed: refuse, index: { describe: refuse, upsert: refuse, deleteByIds: refuse, query: refuse } }, true);
    return { status: result.ok ? 200 : 500, body: result };
  }

  /** Never throws: a thrown alarm is retried by the runtime, and each retry could spend again. */
  async alarm(): Promise<void> {
    try {
      const config = searchEmbeddingConfig(this.deps);
      if (config.state === "off") return;
      if (config.state === "error") {
        await this.recordConfigError(config, false);
        return;
      }
      await this.execute(config, false);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      console.error(`search embedding run failed: ${text}`);
      await this.deps.storage.put("lastRun", failedEmbeddingRun("internal", text, this.deps.now(), false)).catch(() => undefined);
    }
  }

  private async recordConfigError(config: Extract<SearchEmbeddingConfig, { state: "error" }>, dryRun: boolean): Promise<EmbeddingRunResult> {
    const result = failedEmbeddingRun("config", config.error, this.deps.now(), dryRun, config.profile);
    if (!dryRun) await this.deps.storage.put("lastRun", result);
    return result;
  }

  private async execute(config: Extract<SearchEmbeddingConfig, { state: "on" }>, dryRun: boolean): Promise<EmbeddingRunResult> {
    this.running = true;
    try {
      // A dry run writes nothing: no marker, no ledger, no vector state, no stored result.
      if (!dryRun) await this.deps.storage.put(RUN_MARKER, { startedAt: this.deps.now().toISOString() });
      const result = await runSearchEmbedding({
        bucket: this.deps.bucket,
        index: config.index,
        embed: config.embed,
        profile: config.profile,
        state: this.state,
        now: this.deps.now,
        delay: this.deps.delay,
        dryRun,
        ...(this.deps.limits === undefined ? {} : { limits: this.deps.limits }),
      });
      if (!dryRun) {
        await this.deps.storage.put("lastRun", result);
        await this.deps.storage.delete(RUN_MARKER);
      }
      return result;
    } finally {
      this.running = false;
    }
  }
}
