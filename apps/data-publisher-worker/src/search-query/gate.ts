/**
 * Spec 016 slice 3 (Behavior 32): wires the `SearchQueryGate` Durable Object's variables and
 * bindings into the query gate. Free of Workers types, so the wiring is tested. The gate uses the
 * embedding job's profile, gateway, and index, and its own object, storage, and ledger.
 */
import { PRICES, type PricedModel } from "@oss-knowledge-base/reference-pipeline";
import {
  SemanticQueryGate,
  type EmbeddingAiBinding,
  type QueryGateConfig,
  type QueryGateLimits,
  type QueryGateStorage,
  type VectorIndex,
} from "@oss-knowledge-base/semantic-vectorize";

import { modelErrorKind } from "../digest/model";
import { toModelCallError } from "../digest/workers-ai";
import { searchEmbeddingConfig } from "../search-embedding/runner";

export interface SearchQueryGateDeps {
  readonly storage: QueryGateStorage;
  /** `SEARCH_EMBEDDING`: the profile queries are embedded with; blank is off. */
  readonly flag: string | undefined;
  /** `SEARCH_GATEWAY_ID`: every query-time model call goes through this AI Gateway. */
  readonly gatewayId: string | undefined;
  readonly digestGatewayId?: string | undefined;
  readonly ai?: EmbeddingAiBinding | undefined;
  readonly index?: VectorIndex | undefined;
  readonly now: () => Date;
  readonly limits?: Partial<QueryGateLimits>;
}

/** Off without the embedding flag; an error names what is missing; on with the job's own embedder. */
export function searchQueryGateConfig(deps: Pick<SearchQueryGateDeps, "flag" | "gatewayId" | "digestGatewayId" | "ai" | "index">): QueryGateConfig {
  const config = searchEmbeddingConfig(deps);
  if (config.state !== "on") return config.state === "off" ? { state: "off" } : { state: "error", error: config.error };
  if (!Object.hasOwn(PRICES, config.profile.revision.model)) {
    return { state: "error", error: `No Workers AI price is recorded for ${config.profile.revision.model}` };
  }
  return config;
}

export function createSearchQueryGate(deps: SearchQueryGateDeps): SemanticQueryGate {
  const config = () => searchQueryGateConfig(deps);
  const resolved = config();
  return new SemanticQueryGate({
    storage: deps.storage,
    config,
    // Variables and bindings do not change while an object lives; without a price the gate is not on.
    neuronsPerMillionTokens: resolved.state === "on" ? PRICES[resolved.profile.revision.model as PricedModel].inputPerM : 0,
    isRefusal: (error) => modelErrorKind(toModelCallError(error)) === "limit",
    now: deps.now,
    ...(deps.limits === undefined ? {} : { limits: deps.limits }),
  });
}
