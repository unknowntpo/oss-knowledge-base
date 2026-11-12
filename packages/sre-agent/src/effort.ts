/**
 * SRE103, SRE110: the Anthropic `effort` option on every call, so thinking fits the 4,096-token output
 * cap (B30). The Worker's Anthropic model and the eval's both use it.
 */
import { wrapLanguageModel, type LanguageModel } from "ai";

export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

type Model = Exclude<LanguageModel, string>;

export function withEffort(model: Model, effort: Effort): Model {
  return wrapLanguageModel({
    model: model as Parameters<typeof wrapLanguageModel>[0]["model"],
    middleware: {
      specificationVersion: "v4",
      transformParams: async ({ params }) => ({
        ...params,
        providerOptions: { ...params.providerOptions, anthropic: { ...params.providerOptions?.anthropic, effort } },
      }),
    },
  });
}
