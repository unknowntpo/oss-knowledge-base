/**
 * Spec 027 SRE59/SRE60: the eval harness. One case runs the tick's steps 1, 2, 4 and 5 on fixed
 * inputs (firings, plan, bundle, `diagnoseBundle` with a fresh 1,500-neuron day), then the
 * programmatic graders (no LLM judge): the cause id, each required evidence item quoted and passing the
 * evidence check, and the runbook anchor. The scoreboard aggregates runs per model.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { wrapLanguageModel, type LanguageModel } from "ai";
import {
  buildBundle,
  buildLibrary,
  checkEvidence,
  citeEvidence,
  collectFirings,
  diagnoseBundle,
  emptyState,
  NeuronLedger,
  parseCauses,
  planDiagnoses,
  USD_PER_NEURON,
  DAILY_NEURON_CAP,
  type Bundle,
  type DiagnosisOutput,
  type MarkdownFile,
  type PlaybookLibrary,
} from "../../src";
import type { EvalCase } from "./cases";
import { EVAL_PLAYBOOKS } from "./playbooks";

type Model = Exclude<LanguageModel, string>;

/** The repository root: the nearest ancestor of the working directory holding docs/runbooks. */
export function repoRoot(start = process.cwd()): string {
  let dir = start;
  while (!existsSync(join(dir, "docs/runbooks/sre"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no docs/runbooks/sre above ${start}`);
    dir = parent;
  }
  return dir;
}

function readMarkdown(root: string, dir: string): MarkdownFile[] {
  // Runs under Bun (tests) and Node (the bundled eval), so no Bun.Glob.
  return readdirSync(join(root, dir)).filter((name) => name.endsWith(".md")).sort()
    .map((name) => ({ path: `${dir}/${name}`, text: readFileSync(join(root, dir, name), "utf8") }));
}

/** The production playbooks plus the eval-only ones of `playbooks.ts`, with every runbook section they cite. */
export function evalLibrary(root = repoRoot()): PlaybookLibrary {
  return buildLibrary([...readMarkdown(root, "docs/runbooks/sre"), ...EVAL_PLAYBOOKS], readMarkdown(root, "docs/runbooks"));
}

export interface Grade {
  readonly cause: boolean;
  readonly evidence: boolean;
  readonly anchor: boolean;
  /** The evidence check (B32) failed: a quote, cause or runbook not in the bundle. */
  readonly fabricated: boolean;
  readonly pass: boolean;
  /** Required evidence items no valid quote covers. */
  readonly missing: string[];
}

export interface CaseRun {
  readonly scenario: string;
  readonly modelId: string;
  readonly run: number;
  readonly called: boolean;
  readonly firings: number;
  readonly verdict: string | null;
  readonly reason: string | null;
  readonly cause: string | null;
  readonly runbook: string | null;
  /** The model's evidence entries as answered (`quote`, or since 2026-10-26 `path`). */
  readonly evidence: DiagnosisOutput["evidence"];
  readonly evidenceFailures: readonly string[];
  readonly tools: readonly string[];
  readonly steps: number;
  readonly modelCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Neurons at the A2-6 rates from the reported token usage (B31's accounting). */
  readonly neurons: number;
  /** Neurons Workers AI reported in `usage.neurons`, summed; null when no call reported it. */
  readonly neuronsReported: number | null;
  readonly latencyMs: number;
  /** The last step's text and finish reason (first 2,000 characters), to read a malformed answer. */
  readonly finalText?: string;
  readonly finishReason?: string;
  readonly grade: Grade;
}

export interface RunCaseInput {
  readonly evalCase: EvalCase;
  readonly modelId: string;
  readonly library: PlaybookLibrary;
  readonly model: (bundle: Bundle) => Model;
  readonly run: number;
}

/** `get_ci_run` against the fixture's recorded runs; nothing else answers. */
function ciFetch(runs: EvalCase["ciRuns"]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const id = /\/actions\/runs\/(\d+)$/u.exec(new URL(input instanceof Request ? input.url : String(input)).pathname)?.[1];
    const body = id === undefined ? undefined : runs?.[id];
    return body === undefined ? new Response("not found", { status: 404 }) : Response.json(body);
  }) as typeof fetch;
}

const NOT_CALLED: Grade = { cause: true, evidence: true, anchor: true, fabricated: false, pass: true, missing: [] };

export function grade(evalCase: EvalCase, bundle: Bundle, ruleIds: readonly string[], output: DiagnosisOutput | null, library: PlaybookLibrary): Grade {
  const expected = evalCase.expected;
  if (expected === null) return { ...NOT_CALLED, pass: false, cause: false };
  if (output === null) return { cause: false, evidence: false, anchor: false, fabricated: false, pass: false, missing: expected.evidence.map((item) => item.name) };
  const check = checkEvidence(output, bundle);
  // SRE88: a path citation is graded by the verbatim field it resolved to, like a quote.
  const cited = citeEvidence(output.evidence, bundle.items);
  const valid = cited.filter((_, index) => checkEvidence({ ...output, cause: "unknown", runbook: null, evidence: [output.evidence[index]!] }, bundle).ok);
  const label = (id: string) => bundle.items.find((item) => item.id === id)?.label;
  const missing = expected.evidence
    .filter((required) => !valid.some((entry) => required.pattern.test(entry.quote ?? "") && (required.label === undefined || label(entry.id) === required.label)))
    .map((required) => required.name);
  const causeAnchors = ruleIds.flatMap((ruleId) => parseCauses(library.playbooks[ruleId] ?? "")).filter((cause) => cause.id === expected.cause).flatMap((cause) => cause.anchors);
  const accepted: (string | null)[] = expected.runbook === null ? [null] : [expected.runbook, ...causeAnchors];
  const result = {
    cause: output.cause === expected.cause,
    evidence: check.ok && missing.length === 0,
    anchor: accepted.includes(output.runbook),
    fabricated: !check.ok,
    missing,
  };
  return { ...result, pass: result.cause && result.evidence && result.anchor };
}

export async function runCase(input: RunCaseInput): Promise<CaseRun> {
  const { evalCase, modelId, library } = input;
  const date = "2026-10-25";
  const { firings } = collectFirings(evalCase.env, evalCase.health, evalCase.ci);
  const plan = planDiagnoses(firings, emptyState(date), date);
  const base = { scenario: evalCase.scenario, modelId, run: input.run, firings: firings.length };
  const group = plan.groups[0];
  if (group === undefined) {
    return {
      ...base, called: false, verdict: null, reason: null, cause: null, runbook: null, evidence: [], evidenceFailures: [], tools: [],
      steps: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, neurons: 0, neuronsReported: 0, latencyMs: 0,
      grade: evalCase.expected === null ? NOT_CALLED : { cause: false, evidence: false, anchor: false, fabricated: false, pass: false, missing: evalCase.expected.evidence.map((item) => item.name) },
    };
  }
  const querySignals = async (args: { template: keyof EvalCase["sql"] }) => evalCase.sql[args.template] ?? [];
  const fetchFn = ciFetch(evalCase.ciRuns);
  const bundle = await buildBundle({
    env: evalCase.env, job: group.job, firings: group.firings, health: evalCase.health, querySignals, ci: evalCase.ci, library, secrets: [],
    ...(evalCase.logTail === undefined ? {} : { logTail: evalCase.logTail }),
  });
  let reported = null as number | null;
  const model = wrapLanguageModel({
    model: input.model(bundle),
    middleware: {
      specificationVersion: "v4",
      wrapGenerate: async ({ doGenerate }) => {
        const result = await doGenerate();
        const neurons = (result.usage.raw as { neurons?: unknown } | undefined)?.neurons;
        if (typeof neurons === "number") reported = (reported ?? 0) + neurons;
        return result;
      },
    },
  });
  // A fresh UTC day per diagnosis: the production cap (B31) bounds one diagnosis, as on a quiet day.
  const ledger = new NeuronLedger(emptyState(date), async () => undefined, DAILY_NEURON_CAP);
  const started = performance.now();
  const diagnosis = await diagnoseBundle({
    model, modelId, bundle, ledger,
    tools: { env: evalCase.env, health: evalCase.health, querySignals, fetch: fetchFn, library, secrets: [], ciRuns: group.job === "ci.release" },
  });
  const latencyMs = Math.round(performance.now() - started);
  const ruleIds = group.firings.map((value) => value.ruleId);
  return {
    ...base,
    called: true,
    verdict: diagnosis.verdict,
    reason: diagnosis.reason,
    cause: diagnosis.output?.cause ?? null,
    runbook: diagnosis.output?.runbook ?? null,
    evidence: diagnosis.output?.evidence ?? [],
    evidenceFailures: diagnosis.evidenceCheck?.failures ?? [],
    tools: diagnosis.trajectory.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName)),
    steps: diagnosis.steps,
    modelCalls: diagnosis.modelCalls,
    inputTokens: diagnosis.inputTokens,
    outputTokens: diagnosis.outputTokens,
    neurons: diagnosis.neurons,
    neuronsReported: reported,
    latencyMs,
    finalText: diagnosis.trajectory.steps.at(-1)?.text.slice(0, 2000) ?? "",
    finishReason: diagnosis.trajectory.steps.at(-1)?.finishReason ?? "none",
    grade: grade(evalCase, bundle, ruleIds, diagnosis.output, library),
  };
}

export interface GoldenMutation {
  readonly cause?: string;
  readonly runbook?: string;
  /** Alter this evidence entry's quote so it is no longer in its item. */
  readonly alterQuote?: number;
  /** Leave this evidence entry out. */
  readonly dropEvidence?: number;
  /** Add one more entry whose quote is not in the item it cites. */
  readonly extraFabricated?: boolean;
  /** Call a tool on every step with a large usage, never answering. */
  readonly loopTool?: boolean;
}

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

/** A mock model answering a case's golden answer (ids resolved from the bundle's labels), optionally broken. */
export function goldenModel(evalCase: EvalCase, bundle: Bundle, mutate: GoldenMutation = {}): MockLanguageModelV4 {
  let calls = 0;
  return new MockLanguageModelV4({
    modelId: "golden",
    doGenerate: async () => {
      calls += 1;
      if (mutate.loopTool === true) {
        return {
          content: [{ type: "tool-call", toolCallId: `call-${calls}`, toolName: "read_playbook", input: JSON.stringify({ id: "r2.classAInvariant" }) }],
          finishReason: { unified: "tool-calls", raw: undefined }, usage: usage(20_000, 1_000), warnings: [],
        };
      }
      const answer = evalCase.golden;
      if (answer === null) throw new Error(`${evalCase.scenario} has no golden answer`);
      const evidence = answer.evidence
        .filter((_, index) => index !== mutate.dropEvidence)
        .map((entry, index) => {
          const item = bundle.items.find((value) => value.label === entry.label);
          if (item === undefined) throw new Error(`${evalCase.scenario}: no bundle item labelled ${entry.label}`);
          return { id: item.id, quote: index === mutate.alterQuote ? `${entry.quote} (altered)` : entry.quote };
        });
      if (mutate.extraFabricated === true) evidence.push({ id: bundle.items[0]!.id, quote: "a value no item holds" });
      const output: DiagnosisOutput = {
        verdict: answer.verdict, cause: mutate.cause ?? answer.cause, confidence: answer.confidence, evidence,
        runbook: mutate.runbook ?? answer.runbook, ownerAction: answer.ownerAction,
      };
      return { content: [{ type: "text", text: JSON.stringify(output) }], finishReason: { unified: "stop", raw: undefined }, usage: usage(2_000, 200), warnings: [] };
    },
  });
}

/** Spend across the whole eval, checked before each diagnosis against the worst one (the 1,500-neuron cap). */
export class CostMeter {
  readonly budgetNeurons: number;
  spentNeurons = 0;

  constructor(readonly budgetUsd: number) {
    this.budgetNeurons = Math.floor(budgetUsd / USD_PER_NEURON + 1e-6);
  }

  canStart(): boolean {
    return this.spentNeurons + DAILY_NEURON_CAP <= this.budgetNeurons;
  }

  add(neurons: number): void {
    this.spentNeurons += neurons;
  }

  get spentUsd(): number {
    return this.spentNeurons * USD_PER_NEURON;
  }
}

export interface ModelScore {
  readonly modelId: string;
  readonly runs: number;
  readonly diagnoses: number;
  readonly passed: number;
  readonly passRate: number;
  readonly causeCorrect: number;
  readonly evidenceOk: number;
  readonly anchorOk: number;
  readonly fabricated: number;
  /** Of the diagnoses that produced an output. */
  readonly fabricationRate: number;
  readonly failures: Record<string, number>;
  readonly noCallRuns: number;
  readonly noCallPassed: number;
  readonly neurons: number;
  readonly neuronsPerDiagnosis: number;
  readonly latencyMsMean: number;
  readonly latencyMsP50: number;
  readonly costUsd: number;
  readonly byCase: Record<string, { runs: number; passed: number; causes: Record<string, number> }>;
}

export interface Scoreboard {
  readonly budgetUsd: number;
  readonly models: ModelScore[];
  readonly neurons: number;
  readonly costUsd: number;
  readonly aborted?: string;
}

const median = (values: readonly number[]) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** Reported neurons when Workers AI gave them, else the rate estimate. */
const spent = (run: CaseRun) => run.neuronsReported ?? run.neurons;

export function scoreboard(runs: readonly CaseRun[], meta: { budgetUsd: number; aborted?: string }): Scoreboard {
  const ids = [...new Set(runs.map((run) => run.modelId))];
  const models = ids.map((modelId): ModelScore => {
    const mine = runs.filter((run) => run.modelId === modelId);
    const called = mine.filter((run) => run.called);
    const withOutput = called.filter((run) => run.cause !== null);
    const failures: Record<string, number> = {};
    for (const run of called) if (run.reason !== null) failures[run.reason] = (failures[run.reason] ?? 0) + 1;
    const byCase: ModelScore["byCase"] = {};
    for (const run of mine) {
      const entry = (byCase[run.scenario] ??= { runs: 0, passed: 0, causes: {} });
      entry.runs += 1;
      if (run.grade.pass) entry.passed += 1;
      const cause = run.called ? (run.cause ?? `(${run.reason ?? "none"})`) : "(no call)";
      entry.causes[cause] = (entry.causes[cause] ?? 0) + 1;
    }
    const neurons = mine.reduce((total, run) => total + spent(run), 0);
    return {
      modelId,
      runs: mine.length,
      diagnoses: called.length,
      passed: mine.filter((run) => run.grade.pass).length,
      passRate: mine.length === 0 ? 0 : mine.filter((run) => run.grade.pass).length / mine.length,
      causeCorrect: called.filter((run) => run.grade.cause).length,
      evidenceOk: called.filter((run) => run.grade.evidence).length,
      anchorOk: called.filter((run) => run.grade.anchor).length,
      fabricated: called.filter((run) => run.grade.fabricated).length,
      fabricationRate: withOutput.length === 0 ? 0 : withOutput.filter((run) => run.grade.fabricated).length / withOutput.length,
      failures,
      noCallRuns: mine.length - called.length,
      noCallPassed: mine.filter((run) => !run.called && run.grade.pass).length,
      neurons,
      neuronsPerDiagnosis: called.length === 0 ? 0 : neurons / called.length,
      latencyMsMean: called.length === 0 ? 0 : called.reduce((total, run) => total + run.latencyMs, 0) / called.length,
      latencyMsP50: median(called.map((run) => run.latencyMs)),
      costUsd: neurons * USD_PER_NEURON,
      byCase,
    };
  });
  const neurons = models.reduce((total, model) => total + model.neurons, 0);
  return { budgetUsd: meta.budgetUsd, models, neurons, costUsd: neurons * USD_PER_NEURON, ...(meta.aborted === undefined ? {} : { aborted: meta.aborted }) };
}

/** Highest pass rate, then lowest fabrication rate, then fewest neurons per diagnosis. */
export function pickWinner(models: readonly ModelScore[]): ModelScore | undefined {
  return [...models].sort((a, b) => b.passRate - a.passRate || a.fabricationRate - b.fabricationRate || a.neuronsPerDiagnosis - b.neuronsPerDiagnosis)[0];
}

const pct = (part: number, whole: number) => (whole === 0 ? "–" : `${part}/${whole} (${Math.round((100 * part) / whole)}%)`);

export function renderScoreboard(board: Scoreboard, meta: { date?: string; command?: string } = {}): string {
  const winner = pickWinner(board.models);
  const lines = [
    `# Spec 027 SRE59 eval scoreboard${meta.date === undefined ? "" : ` (${meta.date})`}`,
    "",
    "Generated by `bun run --cwd packages/sre-agent eval`; programmatic graders, no LLM judge. A run passes when the",
    "cause id, every required evidence item (quoted and passing the evidence check) and the runbook anchor are right;",
    "a row with trigger `none` passes when no model call is made. Neurons are those Workers AI reported per call",
    "(`usage.neurons`), cost at $0.011 per 1,000 neurons as if all were billed.",
    ...(meta.command === undefined ? [] : ["", `Command: \`${meta.command}\``]),
    ...(board.aborted === undefined ? [] : ["", `**Aborted:** ${board.aborted}`]),
    "",
    "| Model | Pass | Cause | Evidence | Anchor | Fabrication | Failures | Neurons / diagnosis | Latency mean / p50 | Cost |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...board.models.map((model) => `| ${model.modelId} | ${pct(model.passed, model.runs)} | ${pct(model.causeCorrect, model.diagnoses)} | ${pct(model.evidenceOk, model.diagnoses)} | ${pct(model.anchorOk, model.diagnoses)} | ${pct(model.fabricated, model.diagnoses)} | ${Object.entries(model.failures).map(([reason, count]) => `${reason} ${count}`).join(", ") || "none"} | ${model.neuronsPerDiagnosis.toFixed(1)} | ${(model.latencyMsMean / 1000).toFixed(1)} s / ${(model.latencyMsP50 / 1000).toFixed(1)} s | $${model.costUsd.toFixed(4)} |`),
    "",
    `Total: ${board.neurons.toFixed(1)} neurons, $${board.costUsd.toFixed(4)} (budget $${board.budgetUsd.toFixed(Number.isInteger(Math.round(board.budgetUsd * 1000) / 10) ? 2 : 3)}). Winner (pass rate, then fabrication, then neurons): ${winner?.modelId ?? "none"}.`,
    "",
    "## Per case (passed / runs; causes answered)",
    "",
    `| Case | ${board.models.map((model) => model.modelId).join(" | ")} |`,
    `| --- | ${board.models.map(() => "---").join(" | ")} |`,
    ...[...new Set(board.models.flatMap((model) => Object.keys(model.byCase)))].map((scenario) => `| ${scenario} | ${board.models.map((model) => {
      const entry = model.byCase[scenario];
      return entry === undefined ? "–" : `${entry.passed}/${entry.runs}; ${Object.entries(entry.causes).map(([cause, count]) => `${cause} ×${count}`).join(", ")}`;
    }).join(" | ")} |`),
    "",
  ];
  return lines.join("\n");
}
