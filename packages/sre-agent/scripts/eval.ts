/**
 * Spec 027 SRE59: the L3 eval. Every `test/eval.cases.ts` row runs `--runs` times per model against
 * Workers AI, one model at a time, and the scoreboard is written as Markdown and JSON.
 *
 *   bun run --cwd packages/sre-agent eval -- [--provider workers-ai|anthropic|openai-compatible] [--model <id>]… [--runs 5]
 *     [--budget-usd 1.29] [--max-usd-per-diagnosis 0.1] [--usd-per-mtok <in>,<out>] [--effort low|medium|high]
 *     [--interleave] [--suffix <s>] [--stub] [--out <dir>]
 *
 * Local or manual, never CI. Workers AI is reached through a remote `AI` binding from
 * `getPlatformProxy` and the `wrangler login` session (no API token), via the same `createAI` call the
 * Worker uses. `--stub` answers with each case's golden answer through the mock model: no network, $0.
 * The `eval` script bundles this file for Node, because Wrangler's proxy does not run under Bun.
 * `--interleave` puts the models in the inner loop; `--suffix b` names the output scoreboard-<date>b.
 * A cost meter refuses to start a diagnosis unless the budget still covers a worst-case one (1,500
 * neurons, the production cap each diagnosis runs under), so the run never passes `--budget-usd`.
 *
 * SRE101–SRE103: `--provider anthropic` reads `ANTHROPIC_API_KEY`, `--provider openai-compatible` reads
 * `OPENAI_COMPATIBLE_BASE_URL` and `OPENAI_COMPATIBLE_API_KEY`, all from the environment. A paid model is
 * priced in USD (`providers.ts`), each diagnosis is capped at `--max-usd-per-diagnosis`, and Anthropic calls
 * carry `--effort`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import { EVAL_CASES } from "./eval/cases";
import { CostMeter, evalLibrary, goldenModel, pickWinner, renderScoreboard, repoRoot, runCase, runCostUsd, scoreboard, type CaseRun } from "./eval/harness";
import { paidModel, parseArgs, priceFor, withEffort, type Options } from "./eval/providers";

type Model = Exclude<LanguageModel, string>;

async function workersAi(root: string): Promise<{ model: (id: string) => Model; dispose: () => Promise<void> }> {
  const { getPlatformProxy } = await import("wrangler");
  const { createAI } = await import("agents/models/ai-sdk");
  const proxy = await getPlatformProxy<{ AI: unknown }>({ configPath: join(root, "packages/sre-agent/scripts/eval.wrangler.jsonc"), persist: false });
  const ai = createAI({ binding: proxy.env.AI as never });
  return { model: (id) => ai.languageModel(id), dispose: () => proxy.dispose() };
}

/** The paid backend; it fails here, before any model call, when a key is missing (SRE101). */
function paidBackend(options: Options): { model: (id: string) => Model; dispose: () => Promise<void> } {
  if (options.provider === "workers-ai") throw new Error("not a paid provider");
  const provider = options.provider;
  const models = new Map(options.models.map((id) => {
    const model = paidModel(provider, id, process.env);
    return [id, provider === "anthropic" ? withEffort(model, options.effort) : model] as const;
  }));
  return { model: (id) => models.get(id)!, dispose: async () => undefined };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  const library = evalLibrary(root);
  const paid = options.provider !== "workers-ai";
  const meter = paid ? new CostMeter(options.budgetUsd, options.maxUsdPerDiagnosis) : new CostMeter(options.budgetUsd);
  const date = new Date().toISOString().slice(0, 10);
  const backend = options.stub ? undefined : paid ? paidBackend(options) : await workersAi(root);
  const runs: CaseRun[] = [];
  let aborted: string | undefined;
  try {
    const order: { modelId: string; evalCase: (typeof EVAL_CASES)[number]; run: number }[] = [];
    if (options.interleave) {
      for (const evalCase of EVAL_CASES) for (let run = 1; run <= options.runs; run += 1) for (const modelId of options.models) order.push({ modelId, evalCase, run });
    } else {
      for (const modelId of options.models) for (const evalCase of EVAL_CASES) for (let run = 1; run <= options.runs; run += 1) order.push({ modelId, evalCase, run });
    }
    for (const { modelId, evalCase, run } of order) {
      if (evalCase.expected !== null && !meter.canStart()) {
        aborted = `budget: $${meter.spentUsd.toFixed(4)} spent; a worst-case diagnosis ($${meter.worstDiagnosisUsd.toFixed(4)}) would pass $${options.budgetUsd}`;
        break;
      }
      const result = await runCase({
        evalCase, modelId, library, run,
        model: (bundle) => (backend === undefined ? goldenModel(evalCase, bundle) : backend.model(modelId)),
        // `--stub` answers with the golden model at $0, so it is not priced.
        ...(paid && backend !== undefined ? { pricing: { price: priceFor(modelId, options.usdPerMtok), maxUsdPerDiagnosis: options.maxUsdPerDiagnosis } } : {}),
      });
      meter.add(runCostUsd(result));
      runs.push(result);
      console.error(`${modelId} ${evalCase.scenario} #${run}: ${result.grade.pass ? "pass" : "FAIL"} cause=${result.cause ?? "-"} verdict=${result.verdict ?? "no-call"}${result.reason === null ? "" : ` reason=${result.reason}`} ${paid ? `tokens=${result.inputTokens}/${result.outputTokens} $${runCostUsd(result).toFixed(4)}` : `neurons=${(result.neuronsReported ?? result.neurons).toFixed(1)}`} ${result.latencyMs} ms; total $${meter.spentUsd.toFixed(4)}`);
    }
  } finally {
    await backend?.dispose();
  }
  const board = scoreboard(runs, { budgetUsd: options.budgetUsd, ...(aborted === undefined ? {} : { aborted }) });
  const paidFlags = paid ? ` --max-usd-per-diagnosis ${options.maxUsdPerDiagnosis}${options.usdPerMtok === undefined ? "" : ` --usd-per-mtok ${options.usdPerMtok}`}${options.provider === "anthropic" ? ` --effort ${options.effort}` : ""}` : "";
  const command = `bun run --cwd packages/sre-agent eval -- ${paid ? `--provider ${options.provider} ` : ""}${options.models.map((id) => `--model ${id}`).join(" ")} --runs ${options.runs} --budget-usd ${options.budgetUsd}${paidFlags}${options.interleave ? " --interleave" : ""}${options.suffix === "" ? "" : ` --suffix ${options.suffix}`}${options.stub ? " --stub" : ""}`;
  const out = options.out ?? (options.stub ? join(root, "packages/sre-agent/.eval") : join(root, "docs/specs/027-sre-agent/eval"));
  mkdirSync(out, { recursive: true });
  const base = join(out, `scoreboard-${date}${options.suffix}${options.stub ? "-stub" : ""}`);
  writeFileSync(`${base}.md`, renderScoreboard(board, { date, command }));
  writeFileSync(`${base}.json`, `${JSON.stringify({ date, command, stub: options.stub, scoreboard: board, winner: pickWinner(board.models)?.modelId ?? null, runs }, null, 2)}\n`);
  console.log(renderScoreboard(board, { date, command }));
  console.log(`written: ${base}.md, ${base}.json`);
  if (aborted !== undefined) process.exitCode = 2;
}

await main();
