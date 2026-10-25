/**
 * Spec 027 SRE59: the L3 eval. Every `test/eval.cases.ts` row runs `--runs` times per model against
 * Workers AI, one model at a time, and the scoreboard is written as Markdown and JSON.
 *
 *   bun run --cwd packages/sre-agent eval -- [--model <id>]… [--runs 5] [--budget-usd 1.29] [--stub] [--out <dir>]
 *
 * Local or manual, never CI. Workers AI is reached through a remote `AI` binding from
 * `getPlatformProxy` and the `wrangler login` session (no API token), via the same `createAI` call the
 * Worker uses. `--stub` answers with each case's golden answer through the mock model: no network, $0.
 * The `eval` script bundles this file for Node, because Wrangler's proxy does not run under Bun.
 * A cost meter refuses to start a diagnosis unless the budget still covers a worst-case one (1,500
 * neurons, the production cap each diagnosis runs under), so the run never passes `--budget-usd`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import { EVAL_CASES } from "./eval/cases";
import { CostMeter, evalLibrary, goldenModel, pickWinner, renderScoreboard, repoRoot, runCase, scoreboard, type CaseRun } from "./eval/harness";

export const CANDIDATES = ["@cf/zai-org/glm-4.7-flash", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/qwen/qwen3-30b-a3b-fp8"] as const;

interface Options {
  models: string[];
  runs: number;
  budgetUsd: number;
  stub: boolean;
  out: string | undefined;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { models: [], runs: 5, budgetUsd: 1.29, stub: false, out: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === "--model") options.models.push(next());
    else if (arg === "--runs") options.runs = Number(next());
    else if (arg === "--budget-usd") options.budgetUsd = Number(next());
    else if (arg === "--stub") options.stub = true;
    else if (arg === "--out") options.out = next();
    else throw new Error(`unknown argument ${arg}`);
  }
  if (options.models.length === 0) options.models = [...CANDIDATES];
  if (!Number.isInteger(options.runs) || options.runs < 1) throw new Error("--runs must be a positive integer");
  if (!(options.budgetUsd > 0)) throw new Error("--budget-usd must be positive");
  return options;
}

type Model = Exclude<LanguageModel, string>;

async function workersAi(root: string): Promise<{ model: (id: string) => Model; dispose: () => Promise<void> }> {
  const { getPlatformProxy } = await import("wrangler");
  const { createAI } = await import("agents/models/ai-sdk");
  const proxy = await getPlatformProxy<{ AI: unknown }>({ configPath: join(root, "packages/sre-agent/scripts/eval.wrangler.jsonc"), persist: false });
  const ai = createAI({ binding: proxy.env.AI as never });
  return { model: (id) => ai.languageModel(id), dispose: () => proxy.dispose() };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  const library = evalLibrary(root);
  const meter = new CostMeter(options.budgetUsd);
  const date = new Date().toISOString().slice(0, 10);
  const backend = options.stub ? undefined : await workersAi(root);
  const runs: CaseRun[] = [];
  let aborted: string | undefined;
  try {
    outer: for (const modelId of options.models) {
      for (const evalCase of EVAL_CASES) {
        for (let run = 1; run <= options.runs; run += 1) {
          if (evalCase.expected !== null && !meter.canStart()) {
            aborted = `budget: ${meter.spentNeurons.toFixed(1)} of ${meter.budgetNeurons} neurons spent; a worst-case diagnosis (1,500) would pass $${options.budgetUsd}`;
            break outer;
          }
          const result = await runCase({
            evalCase, modelId, library, run,
            model: (bundle) => (backend === undefined ? goldenModel(evalCase, bundle) : backend.model(modelId)),
          });
          meter.add(result.neuronsReported ?? result.neurons);
          runs.push(result);
          console.error(`${modelId} ${evalCase.scenario} #${run}: ${result.grade.pass ? "pass" : "FAIL"} cause=${result.cause ?? "-"} verdict=${result.verdict ?? "no-call"}${result.reason === null ? "" : ` reason=${result.reason}`} neurons=${(result.neuronsReported ?? result.neurons).toFixed(1)} ${result.latencyMs} ms; total $${meter.spentUsd.toFixed(4)}`);
        }
      }
    }
  } finally {
    await backend?.dispose();
  }
  const board = scoreboard(runs, { budgetUsd: options.budgetUsd, ...(aborted === undefined ? {} : { aborted }) });
  const command = `bun run --cwd packages/sre-agent eval -- ${options.models.map((id) => `--model ${id}`).join(" ")} --runs ${options.runs}${options.stub ? " --stub" : ""}`;
  const out = options.out ?? (options.stub ? join(root, "packages/sre-agent/.eval") : join(root, "docs/specs/027-sre-agent/eval"));
  mkdirSync(out, { recursive: true });
  const base = join(out, `scoreboard-${date}${options.stub ? "-stub" : ""}`);
  writeFileSync(`${base}.md`, renderScoreboard(board, { date, command }));
  writeFileSync(`${base}.json`, `${JSON.stringify({ date, command, stub: options.stub, scoreboard: board, winner: pickWinner(board.models)?.modelId ?? null, runs }, null, 2)}\n`);
  console.log(renderScoreboard(board, { date, command }));
  console.log(`written: ${base}.md, ${base}.json`);
  if (aborted !== undefined) process.exitCode = 2;
}

await main();
