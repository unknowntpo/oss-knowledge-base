import { DEFAULT_FUSION_REVISION } from "@oss-knowledge-base/search";
import { parseSemanticQueryAnswer, sanitizeErrorMessage, type SemanticQueryPort } from "@oss-knowledge-base/semantic-vectorize";

import type { SemanticSearchOptions } from "./search-projection";

/** The gate object's name; the data Worker reads the same object for `/health`. */
export const SEARCH_QUERY_GATE_NAME = "search-query-gate-v1";

export interface SemanticSearchEnv {
  /**
   * Spec 016 slice 3: unset or blank is lexical search, exactly as before. `rrf-group@1` turns
   * hybrid search on. Any other value, or the flag without the gate binding, answers lexically
   * and says `failed`.
   */
  readonly SEARCH_SEMANTIC?: string;
  /** The data Worker's `SearchQueryGate` Durable Object, the only way to the model and the index. */
  readonly SEARCH_QUERY_GATE?: DurableObjectNamespace;
}

/** The gate behind its Durable Object binding. Anything but a well-formed answer is `failed`. */
export function durableObjectSemanticGate(namespace: DurableObjectNamespace): SemanticQueryPort {
  return {
    async query(request, signal) {
      const stub = namespace.get(namespace.idFromName(SEARCH_QUERY_GATE_NAME));
      const response = await stub.fetch("https://search-query.internal/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) throw new Error(`The semantic query gate answered ${response.status}`);
      return parseSemanticQueryAnswer(await response.json());
    },
  };
}

// One per isolate: until when the gate said its budget is spent.
const refusal = { until: 0 };

/**
 * What the flag and the binding mean for one request. `undefined` is lexical search with the
 * response it always had; `semantic=off` asks a hybrid deployment for the lexical ranking.
 */
export function semanticSearchOptions(env: SemanticSearchEnv, url: URL): SemanticSearchOptions | undefined {
  const flag = env.SEARCH_SEMANTIC?.trim() ?? "";
  if (flag === "") return undefined;
  if (flag !== DEFAULT_FUSION_REVISION || env.SEARCH_QUERY_GATE === undefined) {
    console.error(sanitizeErrorMessage(flag !== DEFAULT_FUSION_REVISION
      ? `SEARCH_SEMANTIC "${flag}" is not supported (${DEFAULT_FUSION_REVISION})`
      : "SEARCH_SEMANTIC is set but the SEARCH_QUERY_GATE binding is missing"));
    return { unavailable: true };
  }
  return { gate: durableObjectSemanticGate(env.SEARCH_QUERY_GATE), off: url.searchParams.get("semantic") === "off", refusal };
}
