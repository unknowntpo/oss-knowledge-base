/**
 * Spec 027 "Eval providers" (owner decision 2026-10-28): the L3 eval's `--provider` option, its USD cap
 * and the Anthropic effort option. Run by eval-providers.test.ts with fake environment variables and the
 * mock model; no network, no key.
 */
export const testPlanRows = [
  { id: "SRE101", case: "provider option", given: "no --provider / --provider anthropic / --provider openai-compatible / --provider openrouter", expected: "workers-ai / anthropic / openai-compatible / error naming the allowed values" },
  { id: "SRE101", case: "keys from the environment", given: "anthropic with no ANTHROPIC_API_KEY / openai-compatible with no OPENAI_COMPATIBLE_BASE_URL / with no OPENAI_COMPATIBLE_API_KEY / each set to a fake value / --stub with none set", expected: "error naming ANTHROPIC_API_KEY / OPENAI_COMPATIBLE_BASE_URL / OPENAI_COMPATIBLE_API_KEY, no error holds the fake value; a model whose modelId is the --model id; no error" },
  { id: "SRE102", case: "price required", given: "claude-sonnet-5-5 / claude-haiku-5-5 with no flag; an unlisted model with no flag / with --usd-per-mtok 1,4 / with --usd-per-mtok 1", expected: "$2 / $10 and $0.10 / $0.50 per million tokens; error naming --usd-per-mtok / $1 / $4 / error" },
  { id: "SRE102", case: "USD cap per diagnosis", given: "a mock model calling a tool on every step at 20,000 input and 1,000 output tokens, priced $2 / $10, cap $0.10, under an unlisted model id whose neuron rates would pass 1,500 on the second call", expected: "reason budget after the call that would pass $0.10, not on the second call; costUsd at most $0.10; costUsd equals the tokens at the price" },
  { id: "SRE102", case: "meter and scoreboard in USD", given: "a meter with budget $0.80 and worst diagnosis $0.10, then $0.65 spent; a scoreboard of runs with costUsd 0.03 and 0.02 and one Workers AI run of 100 neurons", expected: "can start, then cannot; model cost 0.05 + 100 × 0.011 / 1000" },
  { id: "SRE103", case: "anthropic effort", given: "--provider anthropic with no --effort / --effort medium / a call with providerOptions anthropic.sendReasoning false; a workers-ai run", expected: "every call's providerOptions.anthropic.effort low / medium / effort medium and sendReasoning false kept; no anthropic provider option" },
] as const;
