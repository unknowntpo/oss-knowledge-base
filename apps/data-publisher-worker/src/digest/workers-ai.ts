/**
 * Spec 014 slice 2b: Workers AI through AI Gateway (Behavior 14–15).
 *
 * `env.AI.run(model, inputs, { gateway: { id, skipCache } })` routes a binding call through the
 * named gateway (https://developers.cloudflare.com/ai-gateway/integrations/aig-workers-ai-binding/).
 * The Dev gateway is authenticated, rate-limited to 60 requests per hour, and has a monthly spend
 * limit; binding calls authenticate automatically. The exception shapes are not documented, so
 * they are mapped from the message here and confirmed on Dev (D35).
 */
import type { ClefModel, ClefRequest, ClefResponse, PricedModel } from "@oss-knowledge-base/reference-pipeline";
import { ModelCallError, type DigestModel, type ModelUsage } from "./model";

/** The part of the `Ai` binding the digest uses. */
export interface AiBinding {
  run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
}

/** Maps a thrown binding error to a code and status (`3036: …`, `… 429 …`, `Too Many Requests`). */
export function toModelCallError(error: unknown): ModelCallError {
  if (error instanceof ModelCallError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = /\b(3\d{3}|5\d{3})\b/u.exec(message)?.[1];
  const status = /\b429\b|too many requests/iu.test(message) ? 429 : undefined;
  return new ModelCallError(message, code === undefined ? undefined : Number(code), status);
}

/** Text from a text-generation response; qwen3 may prefix a `<think>` block. */
export function responseText(response: unknown): { text: string; usage?: ModelUsage } {
  const body = (response ?? {}) as { response?: unknown; usage?: ModelUsage };
  const raw = typeof body.response === "string" ? body.response : JSON.stringify(body.response ?? "");
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gu, "").trim();
  return body.usage === undefined ? { text } : { text, usage: body.usage };
}

export class WorkersAiModel implements DigestModel {
  constructor(private readonly ai: AiBinding, private readonly gatewayId: string) {}

  private get options(): Record<string, unknown> {
    // The digest keeps its own content cache (Behavior 11); the gateway cache stays off.
    return { gateway: { id: this.gatewayId, skipCache: true } };
  }

  async run(model: PricedModel, prompt: string, maxTokens: number): Promise<{ text: string; usage?: ModelUsage }> {
    try {
      const response = await this.ai.run(model, {
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        temperature: 0,
      }, this.options);
      return responseText(response);
    } catch (error) {
      throw toModelCallError(error);
    }
  }

  async decide(model: ClefModel, request: ClefRequest): Promise<ClefResponse> {
    try {
      // The request body names the model as "clef" or "clef-flash" as well (Clef docs).
      const name = model.endsWith("/clef") ? "clef" : "clef-flash";
      return await this.ai.run(model, { model: name, ...request }, this.options) as ClefResponse;
    } catch (error) {
      throw toModelCallError(error);
    }
  }
}
