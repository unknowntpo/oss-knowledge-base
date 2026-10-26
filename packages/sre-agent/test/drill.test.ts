/**
 * Spec 027 "Dev fault-injection drill", core (drill.cases.ts): the agent never learns it is a drill
 * (SRE71), and the grader judges a live diagnosis against B41 (SRE72). Scripted mock model, in-memory
 * store, no network.
 */
import { describe, expect, test } from "bun:test";
import {
  DRILL_POINTER_KEY,
  PLAYBOOK_LIBRARY,
  buildBundle,
  drillExpectationErrors,
  drillExpectations,
  drillRecordKey,
  gradeActiveDrill,
  readOnlyTools,
  runTick,
  sreKey,
  type DiagnosisOutput,
  type DrillRecord,
  type Health,
  type PlaybookLibrary,
  type TickDeps,
} from "../src";
import { EVAL_CASES, type EvalCase } from "../scripts/eval/cases";
import { evalLibrary, grade } from "../scripts/eval/harness";
import { testPlanRows } from "./drill.cases";
import { MODEL_ID, NOW, answer, devHealth, githubFake, memoryStore, promptTexts, rule, scripted, sqlFake, toolCall, type RecordingStore } from "./fixtures";

const ERROR = "cwiki.apache.org answered 503";
const FIRST_FAILED = "2026-10-21T21:00:00.000Z";
const RUN_ID = "kip-pages-2026-10-21T21-30-00-000Z";
const DRILL_ID = "throw-20261021T2055Z";
const ARMED_AT = "2026-10-21T20:55:00.000Z";
const RUNBOOK = drillExpectations.throw.runbook;

/** Dev /health after two faulted kip-pages runs: job.failures firing since the first one. */
function failingHealth(leak = false): Health {
  const health = devHealth({ rules: [rule("job.failures", "kip-pages", "firing", FIRST_FAILED, RUN_ID)] });
  health.kipPages = {
    revision: "authors@1",
    lastRun: { ok: false, status: "failed", at: "2026-10-21T21:30:00.000Z", durationMs: 14, requests: 1, jiraRequests: 0, r2: { classA: 1, classB: 2 }, error: ERROR, runId: RUN_ID },
    lastGoodAt: "2026-10-21T03:43:00.000Z",
  };
  // As if a harness leaked the agent's own field into its /health: the tool must still refuse it.
  if (leak) health.sreAgent = { mode: "live", lastDrill: { drillId: DRILL_ID, kind: "throw", state: "fired", result: null, reasons: [], runIds: [RUN_ID] } };
  return health;
}

function drillRecord(overrides: Partial<DrillRecord> = {}): DrillRecord {
  return {
    drillId: DRILL_ID, job: "kip-pages", kind: "throw", runs: 2, armedAt: ARMED_AT, expiresAt: "2026-10-23T20:55:00.000Z",
    state: "fired", applied: 2, runIds: ["kip-pages-2026-10-21T21-00-00-000Z", RUN_ID], firedAt: "2026-10-21T21:30:00.000Z",
    result: null, reasons: [], gradedAt: null, diagnosis: null, ...overrides,
  };
}

function storeWithDrill(record: DrillRecord): RecordingStore {
  const { drillId, job, kind, runs, armedAt, expiresAt } = record;
  return memoryStore({
    [DRILL_POINTER_KEY]: JSON.stringify({ drillId, job, kind, runs, armedAt, expiresAt }),
    [drillRecordKey(drillId)]: JSON.stringify(record),
  });
}

/** The bundle of a kip-pages job.failures firing: E3 the job's /health fields, E6 Q-window. */
const GOLDEN: DiagnosisOutput = {
  verdict: "explained",
  cause: "upstream-unavailable",
  confidence: "high",
  evidence: [{ id: "E3", quote: `"error": "${ERROR}"` }, { id: "E6", quote: "\"template\": \"Q-window\"" }],
  runbook: RUNBOOK,
  ownerAction: "Check cwiki's status; run kip-pages by hand once it answers.",
};

function tickDeps(store: RecordingStore, health: Health, model: ReturnType<typeof scripted>, grade = true): TickDeps {
  return {
    env: "dev", flag: "live", now: NOW, store, readHealth: async () => structuredClone(health), fetch: githubFake().fetch,
    querySignals: sqlFake().querySignals, model, modelId: MODEL_ID,
    ...(grade ? { afterRun: (input: Parameters<NonNullable<TickDeps["afterRun"]>>[0]) => gradeActiveDrill(store, { ...input, now: NOW }) } : {}),
  };
}

async function graded(output: DiagnosisOutput): Promise<DrillRecord> {
  const store = storeWithDrill(drillRecord());
  await runTick(tickDeps(store, failingHealth(), scripted(answer(output))));
  return JSON.parse(store.objects.get(drillRecordKey(DRILL_ID))!) as DrillRecord;
}

const contains = (text: string) => /drill/iu.test(text) || text.includes(DRILL_ID);

const scenarios: Record<string, () => Promise<void>> = {
  async "blind agent"() {
    const run = async (withDrill: boolean) => {
      const store = withDrill ? storeWithDrill(drillRecord()) : memoryStore();
      const model = scripted(
        toolCall("get_health_section", { path: "sreAgent" }, "c1"),
        toolCall("get_health_section", { path: "sreAgent.lastDrill" }, "c2"),
        toolCall("query_signals", { template: "Q-window", at: FIRST_FAILED }, "c3"),
        answer(GOLDEN),
      );
      const result = await runTick(tickDeps(store, failingHealth(withDrill), model, withDrill));
      const record = result.runRecord!;
      const trajectory = store.objects.get(record.diagnoses[0]!.trajectoryKey)!;
      return { store, model, record, trajectory: JSON.parse(trajectory) as { bundle: unknown[]; steps: { toolResults: { output: string }[] }[] }, raw: trajectory };
    };
    const drill = await run(true);
    // Positive control: the drill was graded, so the agent did diagnose the drill's firing.
    expect(JSON.parse(drill.store.objects.get(drillRecordKey(DRILL_ID))!)).toMatchObject({ state: "graded", result: "pass" });
    expect(drill.record.diagnoses.map((value) => value.verdict)).toEqual(["explained"]);
    // The only "drill" the model ever sees is the path it typed itself; the harness adds none.
    const own = (text: string) => text.replaceAll("sreAgent.lastDrill", "sreAgent.<asked>");
    for (const text of [drill.raw, JSON.stringify(drill.record), ...promptTexts(drill.model)]) expect(contains(own(text))).toBe(false);
    const results = drill.trajectory.steps.flatMap((step) => step.toolResults.map((value) => value.output));
    expect(results.slice(0, 2).every((value) => value.includes("refused: sreAgent"))).toBe(true);
    // Nothing the bundle can hold from the playbooks mentions a drill.
    for (const text of [...Object.values(PLAYBOOK_LIBRARY.playbooks), ...Object.values(PLAYBOOK_LIBRARY.runbooks)]) expect(contains(text)).toBe(false);
    // Control: the same firing without a drill gives the same bundle and the same tool results.
    const plain = await run(false);
    expect(drill.trajectory.bundle).toEqual(plain.trajectory.bundle);
    expect(results).toEqual(plain.trajectory.steps.flatMap((step) => step.toolResults.map((value) => value.output)));
  },

  async "health section refused"() {
    const read: string[] = [];
    const health = new Proxy(failingHealth(true), { get(target, key, receiver) { read.push(String(key)); return Reflect.get(target, key, receiver) as unknown; } });
    const firing = { env: "dev" as const, job: "kip-pages", ruleId: "job.failures", since: FIRST_FAILED, runId: RUN_ID, entry: {} };
    const bundle = await buildBundle({ env: "dev", job: "kip-pages", firings: [firing], health: failingHealth(), querySignals: sqlFake().querySignals, ci: { status: "ok" }, library: PLAYBOOK_LIBRARY, secrets: [] });
    const tools = readOnlyTools(bundle, { env: "dev", health, querySignals: sqlFake().querySignals, fetch: githubFake().fetch, library: PLAYBOOK_LIBRARY, secrets: [], ciRuns: false }, 1000);
    const call = (path: string) => (tools.get_health_section!.execute as (input: { path: string }, options: unknown) => Promise<string>)({ path }, { toolCallId: "t", messages: [] });
    read.length = 0;
    expect(await call("sreAgent")).toContain("refused: sreAgent is not readable");
    expect(await call("sreAgent.lastDrill")).toContain("refused: sreAgent is not readable");
    expect(read).not.toContain("sreAgent");
    // Control: another path is read and served.
    const served = await call("kipPages.lastRun");
    expect(served).toContain(ERROR);
    expect(read).toContain("kipPages");
  },

  async "grade pass"() {
    const store = storeWithDrill(drillRecord());
    const result = await runTick(tickDeps(store, failingHealth(), scripted(answer(GOLDEN))));
    const record = JSON.parse(store.objects.get(drillRecordKey(DRILL_ID))!) as DrillRecord;
    expect(record).toMatchObject({ state: "graded", result: "pass", reasons: [], gradedAt: NOW.toISOString() });
    expect(record.diagnosis).toEqual({ runId: result.runRecord!.runId, trajectoryKey: result.runRecord!.diagnoses[0]!.trajectoryKey });
    expect(store.objects.has(DRILL_POINTER_KEY)).toBe(false);
    const state = JSON.parse(store.objects.get(sreKey("dev", "state.json"))!) as { lastDrill: unknown };
    expect(state.lastDrill).toEqual({ drillId: DRILL_ID, kind: "throw", state: "graded", result: "pass", reasons: [], runIds: drillRecord().runIds });
  },

  async "grade fail"() {
    const cases: [DiagnosisOutput, string[]][] = [
      [{ ...GOLDEN, cause: "unknown" }, ["wrong-cause:unknown"]],
      [{ ...GOLDEN, evidence: [GOLDEN.evidence[0]!] }, ["missing-evidence:Q-window"]],
      [{ ...GOLDEN, runbook: "cloudflare-data-publisher.md#roll-back" }, ["runbook-mismatch:cloudflare-data-publisher.md#roll-back"]],
      [{ ...GOLDEN, evidence: [GOLDEN.evidence[0]!, { id: "E6", quote: "jira is down" }] }, ["verdict:unverified"]],
    ];
    for (const [output, reasons] of cases) expect(await graded(output)).toMatchObject({ state: "graded", result: "fail", reasons });
  },

  async "grade path evidence"() {
    // Owner decision 2026-10-26: required evidence cited by path counts when the cited value holds the field's value.
    const path = (id: string, value: string) => ({ id, path: value });
    const pathCited: DiagnosisOutput = { ...GOLDEN, evidence: [path("E3", "kipPages.lastRun.error"), path("E6", "[0].template")] };
    expect(await graded(pathCited)).toMatchObject({ state: "graded", result: "pass", reasons: [] });
    expect(await graded({ ...pathCited, evidence: [path("E3", "kipPages.lastRun"), path("E6", "[0].template")] })).toMatchObject({ result: "pass", reasons: [] });
    expect(await graded({ ...pathCited, evidence: [path("E3", "kipPages.lastRun.status"), path("E6", "[0].template")] }))
      .toMatchObject({ result: "fail", reasons: ["missing-evidence:kipPages.lastRun.error"] });
    expect(await graded({ ...pathCited, evidence: [path("E3", "kipPages.lastRun.nope"), path("E6", "[0].template")] }))
      .toMatchObject({ result: "fail", reasons: ["missing-evidence:kipPages.lastRun.error", "verdict:unverified"] });
    // The eval grader reads the recorded field of a path citation like a quote.
    const evalCase = EVAL_CASES.find((value) => value.scenario === "kip-pages-two-failures")!;
    const firing = { env: evalCase.env, job: "kip-pages", ruleId: "job.failures", since: "2026-10-21T03:43:00.000Z", runId: "kip-pages-2026-10-22T03-43-00-000Z", entry: {} };
    const querySignals = async (args: { template: keyof EvalCase["sql"] }) => evalCase.sql[args.template] ?? [];
    const library = evalLibrary();
    const bundle = await buildBundle({ env: evalCase.env, job: "kip-pages", firings: [firing], health: evalCase.health, querySignals, ci: evalCase.ci, library, secrets: [] });
    const id = (label: string) => bundle.items.find((item) => item.label === label)!.id;
    const golden = evalCase.golden!;
    const output = (fieldPath: string): DiagnosisOutput => ({
      verdict: golden.verdict, cause: golden.cause, confidence: golden.confidence, runbook: golden.runbook, ownerAction: golden.ownerAction,
      evidence: [path(id("kip-pages /health fields"), fieldPath), path(id("Q-window"), "[0].status")],
    });
    expect(grade(evalCase, bundle, ["job.failures"], output("kipPages.lastRun.error"), library)).toMatchObject({ pass: true, missing: [] });
    expect(grade(evalCase, bundle, ["job.failures"], output("kipPages.lastRun.status"), library)).toMatchObject({ pass: false, missing: ["kipPages.lastRun.error"] });
  },

  async "drill path scope"() {
    // Owner decision 2026-10-26: the exact field or its immediate parent counts; an ancestor further up does not.
    const cites = (e3: string): DiagnosisOutput => ({ ...GOLDEN, evidence: [{ id: "E3", path: e3 }, { id: "E6", path: "[0].template" }] });
    expect(await graded(cites("kipPages.lastRun.error"))).toMatchObject({ result: "pass", reasons: [] });
    expect(await graded(cites("kipPages.lastRun"))).toMatchObject({ result: "pass", reasons: [] });
    // The root path resolves (B32 passes, no verdict reason) but no longer satisfies the requirement.
    expect(await graded(cites("kipPages"))).toMatchObject({ result: "fail", reasons: ["missing-evidence:kipPages.lastRun.error"] });
  },

  async "eval path scope"() {
    const evalCase = EVAL_CASES.find((value) => value.scenario === "kip-pages-two-failures")!;
    const firing = { env: evalCase.env, job: "kip-pages", ruleId: "job.failures", since: "2026-10-21T03:43:00.000Z", runId: "kip-pages-2026-10-22T03-43-00-000Z", entry: {} };
    const querySignals = async (args: { template: keyof EvalCase["sql"] }) => evalCase.sql[args.template] ?? [];
    const library = evalLibrary();
    const bundle = await buildBundle({ env: evalCase.env, job: "kip-pages", firings: [firing], health: evalCase.health, querySignals, ci: evalCase.ci, library, secrets: [] });
    const id = (label: string) => bundle.items.find((item) => item.label === label)!.id;
    const golden = evalCase.golden!;
    const output = (healthPath: string, windowPath = "[0].status"): DiagnosisOutput => ({
      verdict: golden.verdict, cause: golden.cause, confidence: golden.confidence, runbook: golden.runbook, ownerAction: golden.ownerAction,
      evidence: [{ id: id("kip-pages /health fields"), path: healthPath }, { id: id("Q-window"), path: windowPath }],
    });
    const graded = (value: DiagnosisOutput) => grade(evalCase, bundle, ["job.failures"], value, library);
    expect(graded(output("kipPages.lastRun.error"))).toMatchObject({ pass: true, missing: [] });
    expect(graded(output("kipPages.lastRun"))).toMatchObject({ pass: true, missing: [] });
    expect(graded(output("kipPages"))).toMatchObject({ pass: false, fabricated: false, missing: ["kipPages.lastRun.error"] });
    expect(graded(output("kipPages.lastRun.error", "[0]"))).toMatchObject({ pass: true, missing: [] });
  },

  async "no diagnosis"() {
    const tick = async (kind: "throw" | "skip", hoursAgo: number) => {
      const firedAt = new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();
      const store = storeWithDrill(drillRecord({ kind, runs: kind === "throw" ? 2 : 1, firedAt, armedAt: "2026-10-19T00:00:00.000Z", expiresAt: "2026-10-21T00:00:00.000Z" }));
      // A healthy /health: no firing, no diagnosis, no model call.
      await runTick(tickDeps(store, devHealth({ rules: [] }), scripted(answer(GOLDEN))));
      return { record: JSON.parse(store.objects.get(drillRecordKey(DRILL_ID))!) as DrillRecord, pointer: store.objects.has(DRILL_POINTER_KEY) };
    };
    expect(await tick("throw", 23)).toMatchObject({ record: { state: "fired", result: null }, pointer: true });
    expect(await tick("throw", 25)).toMatchObject({ record: { state: "graded", result: "fail", reasons: ["no-diagnosis"] }, pointer: false });
    expect(await tick("skip", 47)).toMatchObject({ record: { state: "fired", result: null }, pointer: true });
    expect(await tick("skip", 49)).toMatchObject({ record: { state: "graded", result: "fail", reasons: ["no-diagnosis"] }, pointer: false });
  },

  async "failure before the drill"() {
    // The firing's since (21:00) predates armedAt (21:10): the diagnosis is of an earlier, real failure.
    const store = storeWithDrill(drillRecord({ armedAt: "2026-10-21T21:10:00.000Z" }));
    const result = await runTick(tickDeps(store, failingHealth(), scripted(answer(GOLDEN))));
    expect(result.runRecord!.diagnoses[0]).toMatchObject({ job: "kip-pages", since: FIRST_FAILED });
    const record = JSON.parse(store.objects.get(drillRecordKey(DRILL_ID))!) as DrillRecord;
    expect(record).toMatchObject({ state: "fired", result: null, reasons: [], gradedAt: null, diagnosis: null });
    expect(store.objects.has(DRILL_POINTER_KEY)).toBe(true);
  },

  async "failure at arming"() {
    // since === armedAt: the boundary belongs to the drill.
    const store = storeWithDrill(drillRecord({ armedAt: FIRST_FAILED }));
    await runTick(tickDeps(store, failingHealth(), scripted(answer(GOLDEN))));
    const record = JSON.parse(store.objects.get(drillRecordKey(DRILL_ID))!) as DrillRecord;
    expect(record).toMatchObject({ state: "graded", result: "pass", reasons: [] });
  },

  async drift() {
    expect(drillExpectationErrors("throw")).toEqual([]);
    expect(drillExpectationErrors("skip")).toEqual([]);
    const without = (rule: string, edit: (text: string) => string | undefined): PlaybookLibrary => {
      const playbooks: Record<string, string> = { ...PLAYBOOK_LIBRARY.playbooks };
      const text = edit(playbooks[rule]!);
      if (text === undefined) delete playbooks[rule];
      else playbooks[rule] = text;
      return { playbooks, runbooks: PLAYBOOK_LIBRARY.runbooks };
    };
    expect(drillExpectationErrors("throw", without("job.failures", (text) => text.replace("`upstream-unavailable`", "`upstream-down`"))))
      .toEqual(["throw: the job.failures playbook does not list cause upstream-unavailable"]);
    expect(drillExpectationErrors("throw", without("job.failures", (text) => text.replaceAll("#upstream-failures-job-runs", "#failure-and-rollback"))))
      .toEqual([`throw: the job.failures playbook does not list ${RUNBOOK} for cause upstream-unavailable`]);
    expect(drillExpectationErrors("skip", without("job.missed", () => undefined))).toEqual(["skip: no playbook for job.missed"]);
  },
};

describe("Spec 027 drill: blindness and grader", () => {
  test("every row has a scenario", () => {
    expect(testPlanRows.filter((row) => scenarios[row.case] === undefined).map((row) => row.case)).toEqual([]);
  });

  test.each(testPlanRows)("$id: $case", async (row) => {
    await scenarios[row.case]!();
  });
});
