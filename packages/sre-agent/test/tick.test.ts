/**
 * Spec 027 Amendment (2) L1: the deterministic tick (tick.cases.ts). Each row runs the scenario named
 * by its `case`; no network and no real model (the live positive controls use a scripted mock).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUNDLE_MAX_BYTES,
  BudgetExceededError,
  DAILY_NEURON_CAP,
  JOB_HEALTH_FIELDS,
  SYSTEM_PROMPT,
  NeuronLedger,
  PLAYBOOK_LIBRARY,
  WriteScopeError,
  buildBundle,
  capItems,
  checkEvidence,
  checkPlaybooks,
  citeEvidence,
  collectFirings,
  diagnosisOutputSchema,
  emptyState,
  fingerprint,
  parseFlag,
  readCiRelease,
  renderPrompt,
  renderPlaybookModule,
  runTick,
  scopedStore,
  sreKey,
  type Bundle,
  type EvidenceItem,
  type Health,
  type SqlArgs,
  type SreState,
  type TickDeps,
} from "../src";
import { testPlanRows } from "./tick.cases";
import {
  MODEL_ID,
  NOW,
  VALID_OUTPUT,
  answer,
  devHealth,
  githubFake,
  memoryStore,
  rule,
  scripted,
  sqlFake,
  toolCall,
  type RecordingStore,
  type Run,
} from "./fixtures";

const repo = join(import.meta.dir, "../../..");
const STATE = sreKey("dev", "state.json");

function deps(overrides: Partial<TickDeps> & { health?: Health } = {}): TickDeps & { healthReads: () => number } {
  let reads = 0;
  const health = overrides.health ?? devHealth();
  return {
    env: "dev",
    flag: "live",
    now: NOW,
    store: memoryStore(),
    readHealth: async () => { reads += 1; return structuredClone(health); },
    fetch: githubFake().fetch,
    querySignals: sqlFake().querySignals,
    model: scripted(answer(VALID_OUTPUT)),
    modelId: MODEL_ID,
    ...overrides,
    healthReads: () => reads,
  };
}

const missed = (job = "publication", runId?: string | null) => rule("job.missed", job, "firing", "2026-10-21T04:07:00.000Z", runId);
const state = (store: RecordingStore): SreState => JSON.parse(store.objects.get(STATE)!);

function item(id: string, text: string, source: EvidenceItem["source"] = "health"): EvidenceItem {
  return { id, source, label: id, text };
}

const scenarios: Record<string, () => Promise<void>> = {
  async flag() {
    for (const [flag, reason] of [[undefined, undefined], ["off", undefined], ["Live", "invalid-flag"]] as const) {
      expect(parseFlag(flag)).toEqual(reason === undefined ? { mode: "off" } : { mode: "off", reason });
      const store = memoryStore();
      const { fetch, requests } = githubFake();
      const model = scripted(answer(VALID_OUTPUT));
      const input = deps({ flag, store, fetch, model, health: devHealth({ rules: [missed()] }) });
      const result = await runTick(input);
      expect(result).toEqual(reason === undefined ? { mode: "off" } : { mode: "off", reason });
      expect(store.calls).toEqual([]);
      expect(requests).toEqual([]);
      expect(input.healthReads()).toBe(0);
      expect(model.doGenerateCalls).toHaveLength(0);
    }
    const dryStore = memoryStore();
    const dryModel = scripted(answer(VALID_OUTPUT));
    const dry = await runTick(deps({ flag: "dry", store: dryStore, model: dryModel, health: devHealth({ rules: [missed()] }) }));
    expect(dry.mode).toBe("dry");
    expect(dryModel.doGenerateCalls).toHaveLength(0);
    expect(dry.runRecord!.diagnoses.map((value) => value.verdict)).toEqual(["dry-run"]);
    expect(dryStore.objects.has(dry.runRecord!.recordKey)).toBe(true);
    // Positive control: live calls the model for the same firing.
    const liveModel = scripted(answer(VALID_OUTPUT));
    const live = await runTick(deps({ flag: "live", model: liveModel, health: devHealth({ rules: [missed()] }) }));
    expect(live.mode).toBe("live");
    expect(liveModel.doGenerateCalls).toHaveLength(1);
    expect(live.runRecord!.diagnoses.map((value) => value.verdict)).toEqual(["explained"]);
  },

  async "firing collected"() {
    const { firings, signals } = collectFirings("dev", devHealth({ rules: [rule("job.failures", "kip-pages", "firing", "2026-10-22T03:43:00.000Z", "kip-pages-2026-10-22T03-43-00-000Z")] }), { status: "ok" });
    expect(signals).toBe("available");
    expect(firings).toHaveLength(1);
    expect(firings[0]).toMatchObject({ env: "dev", job: "kip-pages", ruleId: "job.failures", since: "2026-10-22T03:43:00.000Z", runId: "kip-pages-2026-10-22T03-43-00-000Z" });
  },

  async "warn or unknown"() {
    const quiet = [rule("job.missed", "digest", "warn"), rule("job.failures", "kip-pages", "unknown")];
    expect(collectFirings("dev", devHealth({ rules: quiet }), { status: "ok" }).firings).toEqual([]);
    const model = scripted(answer(VALID_OUTPUT));
    await runTick(deps({ model, health: devHealth({ rules: quiet }) }));
    expect(model.doGenerateCalls).toHaveLength(0);
    // Positive control: the same entries with one of them firing start one diagnosis.
    const control = scripted(answer(VALID_OUTPUT));
    await runTick(deps({ model: control, health: devHealth({ rules: [quiet[0]!, { ...quiet[1]!, status: "firing" }] }) }));
    expect(control.doGenerateCalls).toHaveLength(1);
  },

  async "cost guard"() {
    const tripped = collectFirings("dev", devHealth({ rules: null, costGuardStatus: "tripped" }), { status: "ok" }).firings;
    expect(tripped).toHaveLength(1);
    expect(tripped[0]).toMatchObject({ env: "dev", job: "cost-guard", ruleId: "tripped", since: "2026-10-21T22:07:14.115Z" });
    expect(fingerprint(tripped[0]!)).toBe("dev:cost-guard:tripped:2026-10-21T22:07:14.115Z");
    expect(collectFirings("dev", devHealth({ rules: null, costGuardStatus: "warn" }), { status: "ok" }).firings).toEqual([]);
    // A warn that still carries an earlier breaker trippedAt starts nothing either.
    const warn = devHealth({ rules: null, costGuardStatus: "tripped" });
    warn.costGuard = { ...(warn.costGuard as object), status: "warn" };
    expect(collectFirings("dev", warn, { status: "ok" }).firings).toEqual([]);
  },

  async "signals absent"() {
    const absent = collectFirings("dev", devHealth({ rules: null }), { status: "ok" });
    expect(absent).toEqual({ firings: [], signals: "unavailable" });
    // Positive control: the same health with signals present is available and fires its rule.
    const present = collectFirings("dev", devHealth({ rules: [missed()] }), { status: "ok" });
    expect(present.signals).toBe("available");
    expect(present.firings).toHaveLength(1);
    const run = await runTick(deps({ health: devHealth({ rules: null }) }));
    expect(run.runRecord!.signals).toBe("unavailable");
    expect(run.runRecord!.modelCalls).toBe(0);
  },

  async "ci.release per env"() {
    const mainFailed = githubFake({ main: "failure", tag: "success" });
    const dev = await readCiRelease("dev", mainFailed.fetch);
    const prod = await readCiRelease("prod", mainFailed.fetch);
    expect(dev).toMatchObject({ status: "firing", run: { id: 39231615500, conclusion: "failure", headBranch: "main" }, failedJob: "Unit tests" });
    expect(prod).toMatchObject({ status: "ok", run: { id: 39231615488, conclusion: "success", headBranch: "v0.3.0" } });
    const devFirings = collectFirings("dev", devHealth(), dev).firings;
    expect(devFirings).toHaveLength(1);
    expect(devFirings[0]).toMatchObject({ env: "dev", job: "ci.release", ruleId: "ci.release", runId: "39231615500", since: "2026-10-21T10:00:00Z" });
    expect(collectFirings("prod", devHealth(), prod).firings).toEqual([]);
    const tagFailed = githubFake({ main: "success", tag: "failure" });
    expect((await readCiRelease("prod", tagFailed.fetch)).status).toBe("firing");
    expect((await readCiRelease("dev", tagFailed.fetch)).status).toBe("ok");
  },

  async "GitHub unavailable"() {
    for (const fail of [403, 429, 500, "timeout"] as const) {
      const github = githubFake({ main: "failure", fail });
      const ci = await readCiRelease("dev", github.fetch, { timeoutMs: 20 });
      expect(ci.status).toBe("unknown");
      expect(ci.reason).toMatch(fail === "timeout" ? /timeout/u : new RegExp(`HTTP ${fail}`, "u"));
      expect(collectFirings("dev", devHealth(), ci).firings).toEqual([]);
      for (const request of github.requests) {
        expect(request.method).toBe("GET");
        expect(new URL(request.url).host).toBe("api.github.com");
        expect(Object.keys(request.headers).map((key) => key.toLowerCase())).not.toContain("authorization");
      }
      expect(github.requests.length).toBeGreaterThan(0);
    }
    // The run record carries the unknown status; positive control: a reachable API fires.
    const run = await runTick(deps({ fetch: githubFake({ main: "failure", fail: 500 }).fetch }));
    expect(run.runRecord!.ci).toEqual({ status: "unknown", reason: "HTTP 500" });
    const reachable = await runTick(deps({ fetch: githubFake({ main: "failure" }).fetch }));
    expect(reachable.runRecord!.diagnoses.map((value) => value.job)).toEqual(["ci.release"]);
  },

  async dedupe() {
    const firing = missed("publication", "publication-2026-10-21T22-07-00-000Z");
    const seen: SreState = { ...emptyState("2026-10-22"), fingerprints: { [fingerprint({ env: "dev", job: "publication", ruleId: "job.missed", since: firing.since! })]: { runId: firing.runId!, diagnosedOn: "2026-10-21" } } };
    const sameRun = memoryStore({ [STATE]: JSON.stringify(seen) });
    const same = scripted(answer(VALID_OUTPUT));
    await runTick(deps({ store: sameRun, model: same, health: devHealth({ rules: [firing] }) }));
    expect(same.doGenerateCalls).toHaveLength(0);
    // A new runId is diagnosed once that UTC day, not twice.
    const store = memoryStore({ [STATE]: JSON.stringify(seen) });
    const model = scripted(answer(VALID_OUTPUT));
    const first = await runTick(deps({ store, model, health: devHealth({ rules: [{ ...firing, runId: "publication-2026-10-22T22-07-00-000Z" }] }) }));
    const second = await runTick(deps({ store, model, now: new Date("2026-10-22T11:00:00.000Z"), health: devHealth({ rules: [{ ...firing, runId: "publication-2026-10-23T22-07-00-000Z" }] }) }));
    expect(first.runRecord!.diagnosed).toBe(1);
    expect(second.runRecord!.diagnosed).toBe(0);
    expect(model.doGenerateCalls).toHaveLength(1);
    // ok then firing again: a new since, a new fingerprint, a new diagnosis.
    const again = scripted(answer(VALID_OUTPUT));
    const rerun = await runTick(deps({ store: memoryStore({ [STATE]: JSON.stringify(seen) }), model: again, health: devHealth({ rules: [{ ...firing, since: "2026-10-22T05:00:00.000Z" }] }) }));
    expect(rerun.runRecord!.diagnoses[0]!.fingerprints).toEqual(["dev:publication:job.missed:2026-10-22T05:00:00.000Z"]);
    expect(again.doGenerateCalls).toHaveLength(1);
  },

  async "daily diagnosis cap"() {
    const jobs = ["publication", "digest", "identity-links", "kip-pages", "retention"];
    const store = memoryStore();
    const model = scripted(answer(VALID_OUTPUT));
    const first = await runTick(deps({ store, model, health: devHealth({ rules: jobs.map((job) => missed(job)) }) }));
    expect(first.runRecord!.diagnosed).toBe(3);
    expect(first.runRecord!.diagnoses.map((value) => value.job)).toEqual(jobs.slice(0, 3));
    expect(first.runRecord!.notDiagnosed).toEqual(jobs.slice(3).map((job) => ({ fingerprint: `dev:${job}:job.missed:2026-10-21T04:07:00.000Z`, reason: "daily-cap" })));
    const second = await runTick(deps({ store, model, now: new Date("2026-10-22T11:00:00.000Z"), health: devHealth({ rules: jobs.map((job) => missed(job)) }) }));
    expect(second.runRecord!.diagnosed).toBe(0);
    expect(second.runRecord!.notDiagnosed.map((value) => value.reason)).toEqual(["daily-cap", "daily-cap"]);
    expect(model.doGenerateCalls).toHaveLength(3);
  },

  async "neuron cap boundary"() {
    expect(DAILY_NEURON_CAP).toBe(1500);
    const writes: number[] = [];
    const at = (neurons: number) => new NeuronLedger({ ...emptyState("2026-10-22"), today: { date: "2026-10-22", diagnoses: 0, neurons } }, async (value) => { writes.push(value.today.neurons); });
    const fits = at(1000);
    await fits.reserve(500);
    expect(fits.state.today.neurons).toBe(1500);
    expect(writes).toEqual([1500]);
    const over = at(1000);
    await expect(over.reserve(501)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(over.state.today.neurons).toBe(1000);
    // Through a tick: a day already at the cap stops the diagnosis before any model call.
    const full: SreState = { ...emptyState("2026-10-22"), today: { date: "2026-10-22", diagnoses: 0, neurons: 1499 } };
    const model = scripted(answer(VALID_OUTPUT));
    const run = await runTick(deps({ store: memoryStore({ [STATE]: JSON.stringify(full) }), model, health: devHealth({ rules: [missed()] }) }));
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(run.runRecord!.diagnoses[0]).toMatchObject({ verdict: "inconclusive", reason: "budget" });
  },

  async "crash after reservation"() {
    const store = memoryStore();
    let called!: () => void;
    const reached = new Promise<void>((resolve) => { called = resolve; });
    const hung = scripted(async () => { called(); return new Promise<never>(() => {}); });
    void runTick(deps({ store, model: hung, health: devHealth({ rules: [missed()] }) }));
    await reached;
    const reserved = state(store).today.neurons;
    expect(reserved).toBeGreaterThan(0);
    // The process ends here. The next tick (no firing) starts from the stored state and keeps the reservation.
    await runTick(deps({ store, now: new Date("2026-10-22T11:00:00.000Z"), health: devHealth() }));
    expect(state(store).today.neurons).toBe(reserved);
  },

  async "Prod newest tag"() {
    const run = (id: number, tag: string, conclusion: string): Run => ({ id, head_branch: tag, conclusion, status: "completed", created_at: "2026-10-22T09:00:00Z", html_url: `https://github.com/unknowntpo/oss-knowledge-base/actions/runs/${id}` });
    const github = githubFake({ tags: ["v0.10.0", "v0.2.9", "v0.9.0"], runs: [run(1010, "v0.10.0", "failure"), run(1009, "v0.9.0", "success")] });
    const ci = await readCiRelease("prod", github.fetch);
    expect(ci).toMatchObject({ status: "firing", run: { id: 1010, headBranch: "v0.10.0" } });
    expect(github.requests.map((request) => new URL(request.url).searchParams.get("branch")).filter(Boolean)).toEqual(["v0.10.0"]);
    for (const request of github.requests) expect(request.method).toBe("GET");
    // Only a non-version tag: unknown, never that tag's run.
    expect(await readCiRelease("prod", githubFake({ tags: ["vscode-test"], runs: [run(1020, "vscode-test", "failure")] }).fetch)).toEqual({ status: "unknown", reason: "no tag" });
    // The newest tag has no run (total_count 0): unknown, never an older tag's run.
    expect(await readCiRelease("prod", githubFake({ tags: ["v0.3.0", "v0.4.0"] }).fetch)).toEqual({ status: "unknown", reason: "no run" });
  },

  async "new UTC day"() {
    const yesterday: SreState = { ...emptyState("2026-10-21"), today: { date: "2026-10-21", diagnoses: 3, neurons: 1500 } };
    const store = memoryStore({ [STATE]: JSON.stringify(yesterday) });
    const model = scripted(answer(VALID_OUTPUT));
    const run = await runTick(deps({ store, model, health: devHealth({ rules: [missed()] }) }));
    expect(run.runRecord!.diagnosed).toBe(1);
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(state(store).today).toMatchObject({ date: "2026-10-22", diagnoses: 1 });
    expect(state(store).today.neurons).toBeLessThan(100);
  },

  async "tool results"() {
    const secret = ["not", "a", "real", "worker", "secret"].join("-");
    const health = devHealth({ rules: [missed()] });
    (health.kipPages as { lastRun: Record<string, unknown> }).lastRun.error = `jira 401 ${secret}, retried with ${secret}; header Bearer abc.def.ghi`;
    health.bigField = "y".repeat(20 * 1024);
    const querySignals = async (args: SqlArgs) => {
      if (args.template === "Q-window") throw new Error(`query denied for ${secret}`);
      return [{ template: args.template }];
    };
    const store = memoryStore();
    const model = scripted(
      toolCall("get_health_section", { path: "kipPages.lastRun" }, "c1"),
      toolCall("query_signals", { template: "Q-window", at: "2026-10-21T04:07:00.000Z" }, "c2"),
      toolCall("get_health_section", { path: "bigField" }, "c3"),
      answer({ ...VALID_OUTPUT, cause: "unknown", runbook: null }),
    );
    await runTick(deps({ store, model, health, querySignals, secrets: [secret] }));
    expect(model.doGenerateCalls).toHaveLength(4);
    const trajectory = [...store.objects.entries()].find(([key]) => key.includes("/trajectories/"))![1];
    const prompts = JSON.stringify(model.doGenerateCalls.map((call) => call.prompt));
    for (const text of [trajectory, prompts]) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain("abc.def.ghi");
      expect(text).toContain("jira 401 [redacted], retried with [redacted]; header Bearer [redacted]");
      expect(text).toContain("query denied for [redacted]");
    }
    const big = (JSON.parse(trajectory).steps[2].toolResults[0].output as string);
    expect(big).toMatch(/\[truncated \d+ bytes\]/u);
    expect(Buffer.byteLength(big)).toBeLessThan(16 * 1024 + 200);
    expect(Buffer.byteLength(big)).toBeGreaterThan(16 * 1024 - 200);
  },

  async "no new firing"() {
    const store = memoryStore();
    const model = scripted(answer(VALID_OUTPUT));
    const healthy = await runTick(deps({ store, model }));
    expect(healthy.runRecord).toMatchObject({ verdict: "healthy", firings: 0, modelCalls: 0, diagnosed: 0 });
    expect(JSON.parse(store.objects.get(healthy.runRecord!.recordKey)!)).toMatchObject({ verdict: "healthy", modelCalls: 0 });
    expect(model.doGenerateCalls).toHaveLength(0);
    const one = await runTick(deps({ model, health: devHealth({ rules: [missed()] }) }));
    expect(one.runRecord!.diagnosed).toBe(1);
    expect(model.doGenerateCalls).toHaveLength(1);
  },

  async "group by job"() {
    const store = memoryStore();
    const model = scripted(answer(VALID_OUTPUT));
    const run = await runTick(deps({ store, model, health: devHealth({ rules: [missed(), rule("publication.freshness", "publication", "firing")] }) }));
    expect(run.runRecord!.diagnosed).toBe(1);
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(run.runRecord!.diagnoses[0]!.ruleIds).toEqual(["job.missed", "publication.freshness"]);
    expect(Object.keys(state(store).fingerprints).sort()).toEqual([
      "dev:publication:job.missed:2026-10-21T04:07:00.000Z",
      "dev:publication:publication.freshness:2026-10-21T04:07:00.000Z",
    ]);
  },

  async "bundle per job"() {
    const health = devHealth({ costGuardStatus: "tripped" });
    const cases: { job: string; ruleId: string; window: boolean }[] = [
      { job: "publication", ruleId: "job.missed", window: false },
      { job: "digest", ruleId: "job.missed", window: false },
      { job: "review-queue", ruleId: "job.failures", window: true },
      { job: "embedding", ruleId: "job.failures", window: true },
      { job: "identity-links", ruleId: "job.missed", window: false },
      { job: "kip-pages", ruleId: "job.failures", window: true },
      { job: "retention", ruleId: "job.missed", window: false },
      { job: "cost-guard", ruleId: "tripped", window: true },
    ];
    for (const { job, ruleId, window } of cases) {
      const sql = sqlFake();
      const entry = rule(ruleId, job, "firing", "2026-10-21T22:07:14.115Z", `${job}-2026-10-21T22-07-00-000Z`);
      const bundle = await buildBundle({ env: "dev", job, firings: [{ env: "dev", job, ruleId, since: entry.since!, runId: entry.runId!, entry }], health, querySignals: sql.querySignals, ci: { status: "ok" }, library: PLAYBOOK_LIBRARY, secrets: [] });
      expect(bundle.items.map((value) => value.id)).toEqual(bundle.items.map((_, index) => `E${index + 1}`));
      expect(bundle.items[0]).toMatchObject({ source: "health", label: `signals.rules[${ruleId}]` });
      expect(JSON.parse(bundle.items[0]!.text)).toEqual(entry);
      const costGuard = bundle.items.find((value) => value.label === "costGuard")!;
      expect(JSON.parse(costGuard.text)).toEqual(health.costGuard);
      const fields = bundle.items.find((value) => value.label === `${job} /health fields`);
      if (job === "cost-guard") expect(fields).toBeUndefined();
      else expect(JSON.parse(fields!.text)).toEqual(expectedFields(job, health));
      expect(sql.queries.map((value) => value.template as string)).toEqual(["Q-run", "Q-history", ...(window ? ["Q-window"] : [])]);
      expect(sql.queries.every((value) => value.env === "dev")).toBe(true);
      expect(bundle.items.filter((value) => value.source === "sql").map((value) => value.label)).toEqual(sql.queries.map((value) => value.template));
      const playbooks = bundle.items.filter((value) => value.source === "playbook");
      const runbooks = bundle.items.filter((value) => value.source === "runbook").map((value) => value.label);
      if (ruleId === "job.missed") {
        expect(playbooks.map((value) => value.label)).toEqual(["job.missed"]);
        expect(runbooks).toEqual(["cloudflare-data-publisher.md#health-and-manual-run", "cloudflare-data-publisher.md#follow-up-runs-spec-018", "cloudflare-data-publisher.md#read-health", "cloudflare-data-publisher.md#reset-the-breaker", "cloudflare-data-publisher.md#failure-and-rollback", "cloudflare-data-publisher.md#roll-back"]);
        expect(bundle.playbookMissing).toEqual([]);
      } else if (ruleId === "job.failures") {
        expect(playbooks.map((value) => value.label)).toEqual(["job.failures"]);
        expect(runbooks).toEqual(["cloudflare-data-publisher.md#upstream-failures-job-runs", "cloudflare-data-publisher.md#roll-back", "cloudflare-data-publisher.md#environment-map"]);
        expect(bundle.playbookMissing).toEqual([]);
      } else {
        expect(playbooks).toEqual([]);
        expect(bundle.playbookMissing).toEqual([ruleId]);
      }
      expect(bundle.items.length).toBe(3 - (job === "cost-guard" ? 1 : 0) + sql.queries.length + playbooks.length + runbooks.length);
    }
    // ci.release: the run and its failed job, no SQL.
    const sql = sqlFake();
    const ci = await readCiRelease("dev", githubFake({ main: "failure" }).fetch);
    const [firing] = collectFirings("dev", health, ci).firings.filter((value) => value.job === "ci.release");
    const bundle = await buildBundle({ env: "dev", job: "ci.release", firings: [firing!], health, querySignals: sql.querySignals, ci, library: PLAYBOOK_LIBRARY, secrets: [] });
    expect(sql.queries).toEqual([]);
    expect(bundle.items.map((value) => `${value.id} ${value.source} ${value.label}`)).toEqual(["E1 ci signals.rules[ci.release]", "E2 health costGuard", "E3 ci failed job"]);
    expect(bundle.items[2]!.text).toContain("Unit tests");
    // Every item enters the prompt inside the untrusted delimiter.
    for (const value of bundle.items) expect(bundle.render(value)).toMatch(new RegExp(`^<tool-output trust="untrusted" id="${value.id}"[^>]*>\\n[\\s\\S]*\\n</tool-output>$`, "u"));
  },

  async "bundle size boundary"() {
    const text = (bytes: number) => "x".repeat(bytes);
    const exact = [item("E1", text(BUNDLE_MAX_BYTES - 4000)), item("E2", text(4000))];
    expect(BUNDLE_MAX_BYTES).toBe(24 * 1024);
    expect(capItems(exact)).toEqual(exact);
    const over = [item("E1", `HEAD${text(BUNDLE_MAX_BYTES - 4000 - 7)}TAIL`), item("E2", text(4000))];
    expect(over.reduce((total, value) => total + Buffer.byteLength(value.text), 0)).toBe(BUNDLE_MAX_BYTES + 1);
    const capped = capItems(over);
    expect(capped.reduce((total, value) => total + Buffer.byteLength(value.text), 0)).toBeLessThanOrEqual(BUNDLE_MAX_BYTES);
    expect(capped[0]!.text.startsWith("HEAD")).toBe(true);
    expect(capped[0]!.text.endsWith("TAIL")).toBe(true);
    expect(capped[0]!.text).toMatch(/\[truncated \d+ bytes\]/u);
    expect(capped[1]).toEqual(over[1]!);
  },

  async "secret in input"() {
    // A made-up value built at runtime: no secret-looking literal in the source.
    const secret = ["not", "a", "real", "worker", "secret"].join("-");
    const health = devHealth({ rules: [rule("job.failures", "kip-pages", "firing")] });
    (health.kipPages as { lastRun: Record<string, unknown> }).lastRun.error = `jira 401 with Authorization ${secret}`;
    const store = memoryStore();
    const model = scripted(answer({ ...VALID_OUTPUT, cause: "unknown", runbook: null }));
    const run = await runTick(deps({ store, model, health, secrets: [secret] }));
    const trajectory = [...store.objects.entries()].find(([key]) => key.includes("/trajectories/"))![1];
    const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt);
    for (const text of [trajectory, prompt]) {
      expect(text).not.toContain(secret);
      expect(text).toContain("jira 401 with Authorization [redacted]");
    }
    expect(JSON.stringify(run.runRecord)).not.toContain(secret);
    // Positive control: without the secret listed, the same value reaches the prompt.
    const leaky = scripted(answer({ ...VALID_OUTPUT, cause: "unknown", runbook: null }));
    await runTick(deps({ model: leaky, health, secrets: [] }));
    expect(JSON.stringify(leaky.doGenerateCalls[0]!.prompt)).toContain(secret);
  },

  async "verbatim quote"() {
    const bundle = { items: [item("E1", "{\n  \"completedAt\":   \"2026-09-30T01:07:00Z\",\n  \"ok\": true\n}")], causes: new Set(["alarm-stuck", "unknown"]), runbooks: new Set(["cloudflare-data-publisher.md#health-and-manual-run"]) };
    const check = checkEvidence({ ...VALID_OUTPUT, evidence: [{ id: "E1", quote: "\"completedAt\": \"2026-09-30T01:07:00Z\", \"ok\": true" }], runbook: "cloudflare-data-publisher.md#health-and-manual-run" }, bundle);
    expect(check).toEqual({ ok: true, failures: [] });
  },

  async "fabricated or misplaced quote"() {
    const bundle = { items: [item("E1", "\"completedAt\": \"2026-09-30T01:07:00Z\""), item("E2", "\"error\": \"jira 503\"")], causes: new Set(["alarm-stuck", "unknown"]), runbooks: new Set<string>() };
    const base = { ...VALID_OUTPUT, runbook: null };
    expect(checkEvidence({ ...base, evidence: [{ id: "E1", quote: "\"completedAt\": \"2026-10-02T02:42:00Z\"" }] }, bundle)).toEqual({ ok: false, failures: ["quote-not-in-item:E1"] });
    expect(checkEvidence({ ...base, evidence: [{ id: "E1", quote: "jira 503" }] }, bundle)).toEqual({ ok: false, failures: ["quote-not-in-item:E1"] });
    expect(checkEvidence({ ...base, evidence: [{ id: "E9", quote: "jira 503" }] }, bundle)).toEqual({ ok: false, failures: ["unknown-evidence-id:E9"] });
    for (const quote of ["", "  \n "]) expect(checkEvidence({ ...base, evidence: [{ id: "E2", quote }] }, bundle)).toEqual({ ok: false, failures: ["quote-not-in-item:E2"] });
    // Positive control: the same quote cited from its own item passes.
    expect(checkEvidence({ ...base, evidence: [{ id: "E2", quote: "jira 503" }] }, bundle)).toEqual({ ok: true, failures: [] });
    // A failed check makes the tick's verdict unverified and lists the failure.
    const run = await runTick(deps({ model: scripted(answer({ ...VALID_OUTPUT, evidence: [{ id: "E1", quote: "fabricated" }] })), health: devHealth({ rules: [missed()] }) }));
    expect(run.runRecord!.diagnoses[0]).toMatchObject({ verdict: "unverified", evidenceCheck: { ok: false, failures: ["quote-not-in-item:E1"] } });
  },

  async "compact JSON quote"() {
    const pretty = JSON.stringify({ ok: false, status: "failed", r2: { classA: 8190 } }, null, 2);
    const bundle = { items: [item("E1", pretty), item("E2", JSON.stringify({ error: "jira 503" }, null, 2)), item("E3", "conclusion: failure")], causes: new Set(["alarm-stuck", "unknown"]), runbooks: new Set<string>() };
    const base = { ...VALID_OUTPUT, runbook: null };
    const quote = (id: string, text: string) => checkEvidence({ ...base, evidence: [{ id, quote: text }] }, bundle);
    // Verbatim from the compact serialization of the cited item passes.
    expect(quote("E1", "{\"ok\":false,\"status\":\"failed\"")).toEqual({ ok: true, failures: [] });
    expect(quote("E1", "\"r2\":{\"classA\":8190}")).toEqual({ ok: true, failures: [] });
    // A paraphrase still fails.
    expect(quote("E1", "\"r2.classA\":8190")).toEqual({ ok: false, failures: ["quote-not-in-item:E1"] });
    // Mixed spacing passes since whitespace is insignificant (owner 2026-10-25, row "whitespace-insensitive quote").
    expect(quote("E1", "{\"ok\": false,\"status\": \"failed\"")).toEqual({ ok: true, failures: [] });
    // Compact JSON of another item still fails.
    expect(quote("E1", "{\"error\":\"jira 503\"}")).toEqual({ ok: false, failures: ["quote-not-in-item:E1"] });
    expect(quote("E2", "{\"error\":\"jira 503\"}")).toEqual({ ok: true, failures: [] });
    // A non-JSON item has only its text form.
    expect(quote("E3", "conclusion: failure")).toEqual({ ok: true, failures: [] });
    expect(quote("E3", "\"conclusion: failure\"")).toEqual({ ok: false, failures: ["quote-not-in-item:E3"] });
  },

  async "whitespace-insensitive quote"() {
    const lastRun = { status: "failed", error: "cwiki.apache.org answered 503", r2: { classA: 81900 } };
    const bundle = {
      items: [item("E1", JSON.stringify({ kipPages: { lastRun } }, null, 2)), item("E2", JSON.stringify({ costGuard: { status: "ok" } }, null, 2))],
      causes: new Set(["alarm-stuck", "unknown"]), runbooks: new Set<string>(),
    };
    const quote = (id: string, text: string) => checkEvidence({ ...VALID_OUTPUT, runbook: null, evidence: [{ id, quote: text }] }, bundle);
    const passes = { ok: true, failures: [] };
    const fails = (id: string) => ({ ok: false, failures: [`quote-not-in-item:${id}`] });
    // One-line quotes of the multi-line item, spaced after ":" and "," (drill throw-20261025T0627Z).
    expect(quote("E1", "\"status\": \"failed\", \"error\": \"cwiki.apache.org answered 503\"")).toEqual(passes);
    expect(quote("E1", "{\"status\": \"failed\", \"error\": \"cwiki.apache.org answered 503\"")).toEqual(passes);
    expect(quote("E1", "\"lastRun\": {\"status\": \"failed\", \"error\": \"cwiki.apache.org answered 503\", \"r2\": {\"classA\": 81900}}")).toEqual(passes);
    // Mixed spacing, tabs and newlines.
    expect(quote("E1", "\"lastRun\": {\"status\":\"failed\", \"error\": \"cwiki.apache.org answered 503\"")).toEqual(passes);
    expect(quote("E1", "\"status\":\"failed\",  \"error\" :\t\"cwiki.apache.org answered 503\",\n\"r2\"")).toEqual(passes);
    expect(quote("E1", "cwiki.apache.org  answered\n503")).toEqual(passes);
    // Elisions still fail.
    expect(quote("E1", "\"status\": \"failed\", ... \"error\": \"cwiki.apache.org answered 503\"")).toEqual(fails("E1"));
    expect(quote("E1", "\"status\": \"failed\", \u2026 \"error\": \"cwiki.apache.org answered 503\"")).toEqual(fails("E1"));
    // Letters, digits and other punctuation still match exactly.
    expect(quote("E1", "\"error\": \"cwiki.apache.org answered 502\"")).toEqual(fails("E1"));
    expect(quote("E1", "status: failed")).toEqual(fails("E1"));
    expect(quote("E1", "\"error\": \"cwiki-apache.org answered 503\"")).toEqual(fails("E1"));
    expect(quote("E1", "cwikiapache.org answered 503")).toEqual(fails("E1"));
    // Token boundaries hold across lines.
    expect(quote("E1", "\"r2\": {\n  \"classA\": 8190")).toEqual(fails("E1"));
    expect(quote("E1", "\"r2\": {\n  \"classA\": 81900")).toEqual(passes);
    // A quote from another item still fails.
    expect(quote("E2", "\"status\": \"failed\", \"error\": \"cwiki.apache.org answered 503\"")).toEqual(fails("E2"));
    expect(quote("E2", "{\"costGuard\": {\"status\": \"ok\"}}")).toEqual(passes);
    // Arrays: whitespace beside [ and ] is insignificant too, numbers still whole.
    const rules = { signals: { rules: [{ id: "job.missed", state: "firing" }, { id: "job.failures", state: "ok" }], counts: [1, 2] } };
    const arrays = { ...bundle, items: [item("E3", JSON.stringify(rules, null, 2))] };
    const quoteE3 = (text: string) => checkEvidence({ ...VALID_OUTPUT, runbook: null, evidence: [{ id: "E3", quote: text }] }, arrays);
    expect(quoteE3("\"rules\": [{\"id\": \"job.missed\", \"state\": \"firing\"}, {\"id\": \"job.failures\"")).toEqual(passes);
    expect(quoteE3("\"counts\": [1, 2]")).toEqual(passes);
    expect(quoteE3("\"counts\": [1, 22]")).toEqual(fails("E3"));
  },

  ...(() => {
    // Modeled on Dev drill throw-20261025T0745Z: E3 the kip-pages /health field, E6 the Q-window rows.
    const lastRun = { ok: false, status: "failed", at: "2026-10-25T07:45:12.000Z", error: "cwiki.apache.org answered 503", durationMs: 1210, r2: { classA: 4, classB: 2 } };
    const rows = [
      { runId: "kip-pages-2026-10-25T07-45-00-000Z", job: "kip-pages", at: "2026-10-25T07:45:12.000Z", status: "failed", error: "cwiki.apache.org answered 503" },
      { runId: "publication-2026-10-24T22-07-00-000Z", job: "publication", at: "2026-10-24T22:09:41.000Z", status: "ok", error: null },
    ];
    const bundle = {
      items: [
        item("E3", JSON.stringify({ kipPages: { lastRun } }, null, 2)),
        item("E5", JSON.stringify({ costGuard: { status: "ok" } }, null, 2)),
        item("E6", JSON.stringify(rows, null, 2), "sql"),
        item("E7", "conclusion: failure"),
      ],
      causes: new Set(["upstream-unavailable", "unknown"]), runbooks: new Set<string>(),
    };
    const quote = (id: string, text: string) => checkEvidence({ ...VALID_OUTPUT, cause: "upstream-unavailable", runbook: null, evidence: [{ id, quote: text }] }, bundle);
    const passes = { ok: true, failures: [] };
    const fails = (id: string) => ({ ok: false, failures: [`quote-not-in-item:${id}`] });
    return {
      async "JSON pair quote"() {
        // One pair, several pairs, a balanced object (drill E3), any order, a subset of one object.
        expect(quote("E3", "\"error\": \"cwiki.apache.org answered 503\"")).toEqual(passes);
        expect(quote("E3", "{\"error\": \"cwiki.apache.org answered 503\"}")).toEqual(passes);
        expect(quote("E3", "{\"error\": \"cwiki.apache.org answered 503\", \"status\": \"failed\"}")).toEqual(passes);
        expect(quote("E3", "\"durationMs\": 1210, \"ok\": false")).toEqual(passes);
        // A nested object value, keys reordered: deep equality.
        expect(quote("E3", "\"r2\": {\"classB\": 2, \"classA\": 4}")).toEqual(passes);
        // One SQL row, fields reordered and runId left out (drill E6), as pairs or an object.
        expect(quote("E6", "{\"status\": \"failed\", \"job\": \"kip-pages\", \"at\": \"2026-10-25T07:45:12.000Z\", \"error\": \"cwiki.apache.org answered 503\"}")).toEqual(passes);
        expect(quote("E6", "\"job\": \"kip-pages\", \"status\": \"failed\"")).toEqual(passes);
        expect(quote("E6", "\"error\": null")).toEqual(passes);
        // Positive control: the whole row, verbatim.
        expect(quote("E6", JSON.stringify(rows[1]))).toEqual(passes);
      },

      async "JSON pair quote rejected"() {
        // Drill E3: two pairs and an invented closing brace; the item has more fields after "error". Falls back and fails.
        expect(quote("E3", "\"status\": \"failed\", \"at\": \"2026-10-25T07:45:12.000Z\", \"error\": \"cwiki.apache.org answered 503\"}")).toEqual(fails("E3"));
        expect(quote("E3", "{\"error\": \"cwiki.apache.org answered 503\"}}")).toEqual(fails("E3"));
        // A value changed: a letter or digit, a type, a partial nested object.
        expect(quote("E3", "{\"error\": \"cwiki.apache.org answered 502\"}")).toEqual(fails("E3"));
        expect(quote("E3", "\"durationMs\": \"1210\"")).toEqual(fails("E3"));
        expect(quote("E3", "\"r2\": {\"classA\": 4}")).toEqual(fails("E3"));
        expect(quote("E3", "\"r2\": {\"classA\": 4, \"classB\": 2, \"classC\": 0}")).toEqual(fails("E3"));
        // An invented key.
        expect(quote("E3", "{\"error\": \"cwiki.apache.org answered 503\", \"retries\": 3}")).toEqual(fails("E3"));
        // Pairs from two rows.
        expect(quote("E6", "\"job\": \"kip-pages\", \"status\": \"ok\"")).toEqual(fails("E6"));
        expect(quote("E6", "{\"job\": \"publication\", \"error\": \"cwiki.apache.org answered 503\"}")).toEqual(fails("E6"));
        // The object cited from another item.
        expect(quote("E5", "{\"status\": \"failed\", \"error\": \"cwiki.apache.org answered 503\"}")).toEqual(fails("E5"));
        // A duplicate key: JSON.parse keeps the last value, so the invented first one must not hide.
        expect(quote("E6", "\"status\": \"ok\", \"status\": \"failed\", \"job\": \"kip-pages\"")).toEqual(fails("E6"));
        // No letter or digit.
        expect(quote("E6", "{\"\": \"\"}")).toEqual(fails("E6"));
        // A JSON pair against a non-JSON item: only its text counts.
        expect(quote("E7", "\"conclusion\": \"failure\"")).toEqual(fails("E7"));
        expect(quote("E7", "conclusion: failure")).toEqual(passes);
      },
    };
  })(),

  ...(() => {
    // Owner decision 2026-10-26: JSON items are cited by path, the code records the verbatim field.
    const lastRun = { ok: false, status: "failed", error: "cwiki.apache.org answered 503", r2: { classA: 4, classB: 2 } };
    const rows = [{ job: "kip-pages", status: "failed", error: "cwiki.apache.org answered 503" }, { job: "publication", status: "ok", error: null }];
    const bundle = {
      items: [
        item("E3", JSON.stringify({ kipPages: { lastRun } }, null, 2)),
        item("E6", JSON.stringify(rows, null, 2), "sql"),
        item("E7", "## Causes\n1. upstream-unavailable: the source answered 5xx", "playbook"),
        item("E8", JSON.stringify({ "a.b": 1, "a": { b: 2 }, "[\"a.b\"]": 3, "x y": { c: true } }, null, 2)),
        item("E9", capItems([item("E9", JSON.stringify({ big: "x".repeat(400) }, null, 2))], 200)[0]!.text),
      ],
      causes: new Set(["upstream-unavailable", "unknown"]), runbooks: new Set<string>(),
    };
    type Entry = { id: string; path?: string | null; quote?: string | null };
    const check = (...evidence: Entry[]) => checkEvidence({ ...VALID_OUTPUT, cause: "upstream-unavailable", runbook: null, evidence }, bundle);
    const cite = (...evidence: Entry[]) => citeEvidence(evidence, bundle.items);
    const passes = { ok: true, failures: [] };
    return {
      async "path citation"() {
        const cases: [string, string, string][] = [
          ["E3", "kipPages.lastRun.error", "\"error\": \"cwiki.apache.org answered 503\""],
          ["E3", "kipPages.lastRun.r2.classA", "\"classA\": 4"],
          ["E3", "kipPages.lastRun.r2", "\"r2\": {\"classA\":4,\"classB\":2}"],
          ["E6", "[0].status", "\"status\": \"failed\""],
          ["E6", "[0]", "{\"job\":\"kip-pages\",\"status\":\"failed\",\"error\":\"cwiki.apache.org answered 503\"}"],
          ["E6", "[1].error", "\"error\": null"],
          ["E6", "[1][\"error\"]", "\"error\": null"],
          ["E8", "[\"a.b\"]", "\"a.b\": 1"],
          ["E8", "a.b", "\"b\": 2"],
          ["E8", "[\"[\\\"a.b\\\"]\"]", "\"[\\\"a.b\\\"]\": 3"],
          ["E8", "[\"x y\"].c", "\"c\": true"],
        ];
        for (const [id, path, quote] of cases) {
          expect([path, check({ id, path })]).toEqual([path, passes]);
          expect(cite({ id, path })).toEqual([{ id, path, quote }]);
        }
        // A quote entry is recorded as given.
        expect(cite({ id: "E7", quote: "the source answered 5xx" })).toEqual([{ id: "E7", quote: "the source answered 5xx" }]);
        // Through a live tick: the drill's E1 field "status" (the rule entry), recorded verbatim in the run record and trajectory.
        const store = memoryStore();
        const run = await runTick(deps({ store, model: scripted(answer({ ...VALID_OUTPUT, evidence: [{ id: "E1", path: "status" }] })), health: devHealth({ rules: [missed()] }) }));
        const diagnosis = run.runRecord!.diagnoses[0]!;
        expect(diagnosis).toMatchObject({ verdict: "explained", evidenceCheck: passes, evidence: [{ id: "E1", path: "status", quote: "\"status\": \"firing\"" }] });
        expect(JSON.parse(store.objects.get(diagnosis.trajectoryKey)!).evidence).toEqual([{ id: "E1", path: "status", quote: "\"status\": \"firing\"" }]);
        // Positive control: the 2026-10-26 drill's quote of the same field fails the quote check.
        const quoted = await runTick(deps({ model: scripted(answer({ ...VALID_OUTPUT, evidence: [{ id: "E1", quote: "status: firing" }] })), health: devHealth({ rules: [missed()] }) }));
        expect(quoted.runRecord!.diagnoses[0]!.verdict).toBe("unverified");
      },

      async "path not in item"() {
        const fails = (id: string) => ({ ok: false, failures: [`path-not-in-item:${id}`] });
        const missing = [
          ["E3", "kipPages.lastRun.retries"], ["E6", "[2].status"], ["E3", "kipPages[0]"], ["E6", "status"], ["E6", "0.status"],
          ["E3", "kipPages.lastRun.error.length"], ["E3", "constructor"], ["E3", "__proto__"], ["E3", "kipPages.toString"], ["E6", "[0].constructor"],
          ["E3", ""], ["E3", "kipPages..lastRun"], ["E3", ".kipPages"], ["E3", "kipPages."], ["E3", "kipPages["], ["E6", "[01].status"],
          ["E6", "[-1].status"], ["E8", "[\"a.b]"], ["E3", "kipPages lastRun"], ["E7", "Causes"], ["E9", "big"],
        ] as const;
        for (const [id, path] of missing) {
          expect([path, check({ id, path })]).toEqual([path, fails(id)]);
          expect(cite({ id, path })).toEqual([{ id, path, quote: null }]);
        }
        expect(check({ id: "E99", path: "status" })).toEqual({ ok: false, failures: ["unknown-evidence-id:E99"] });
        // Positive controls: the nearest valid paths resolve.
        for (const [id, path] of [["E3", "kipPages.lastRun"], ["E6", "[1].status"], ["E8", "[\"a.b\"]"]] as const) expect(check({ id, path })).toEqual(passes);
      },

      async "path or quote"() {
        const fails = (id: string) => ({ ok: false, failures: [`evidence-needs-path-or-quote:${id}`] });
        expect(check({ id: "E3", path: "kipPages.lastRun.error", quote: "\"error\": \"cwiki.apache.org answered 503\"" })).toEqual(fails("E3"));
        expect(check({ id: "E3" })).toEqual(fails("E3"));
        expect(check({ id: "E3", path: null, quote: null })).toEqual(fails("E3"));
        expect(cite({ id: "E3" })).toEqual([{ id: "E3", quote: null }]);
        // An empty string beside the other field is read as absent.
        expect(check({ id: "E3", path: "kipPages.lastRun.error", quote: "" })).toEqual(passes);
        expect(check({ id: "E7", path: " ", quote: "upstream-unavailable" })).toEqual(passes);
        expect(cite({ id: "E3", path: "kipPages.lastRun.error", quote: "" })).toEqual([{ id: "E3", path: "kipPages.lastRun.error", quote: "\"error\": \"cwiki.apache.org answered 503\"" }]);
        // Positive controls: one field each, the quote path unchanged (SRE78).
        expect(check({ id: "E3", quote: "\"error\": \"cwiki.apache.org answered 503\"" })).toEqual(passes);
        expect(check({ id: "E3", path: "kipPages.lastRun.error" })).toEqual(passes);
        expect(check({ id: "E3", path: null, quote: "\"status\": \"failed\"" })).toEqual(passes);
        // The schema accepts every shape, so a bad entry costs the verdict, never the record.
        for (const entry of [{ id: "E3" }, { id: "E3", path: "a", quote: "b" }, { id: "E3", path: null, quote: null }, { id: "E3", path: "a" }]) {
          expect(diagnosisOutputSchema.safeParse({ ...VALID_OUTPUT, evidence: [entry] }).success).toBe(true);
        }
      },
    };
  })(),

  async "path instruction"() {
    const prompt = renderPrompt({ job: "kip-pages", items: [] } as unknown as Bundle);
    const shape = diagnosisOutputSchema.shape.evidence.element.shape;
    const path = shape.path.description ?? "";
    const quote = shape.quote.description ?? "";
    for (const text of [SYSTEM_PROMPT, prompt, path, quote]) {
      expect(text).toMatch(/JSON item/u);
      expect(text).toMatch(/non-JSON item/u);
      expect(text).not.toContain("\"key\": value");
    }
    for (const text of [SYSTEM_PROMPT, prompt, path]) {
      expect(text).toContain("[0]");
      expect(text).toContain("[\"");
      expect(text).toMatch(/kipPages\.lastRun\.error/u);
    }
    for (const text of [SYSTEM_PROMPT, prompt]) expect(text).toMatch(/exactly one of path or quote/u);
    for (const text of [SYSTEM_PROMPT, quote]) {
      expect(text).toMatch(/verbatim/u);
      expect(text).toMatch(/no ellipsis/u);
    }
  },

  async "quote precision"() {
    const bundle = {
      items: [item("E1", "{\"ok\":false}"), item("E2", JSON.stringify({ classA: 81900, status: "failed" }, null, 2)), item("E3", "run 39231615488 failed"), item("E4", "état: échoué"), item("E5", "status failed; retry fail")],
      causes: new Set(["alarm-stuck", "unknown"]), runbooks: new Set<string>(),
    };
    const quote = (id: string, text: string) => checkEvidence({ ...VALID_OUTPUT, runbook: null, evidence: [{ id, quote: text }] }, bundle);
    const fails = (id: string) => ({ ok: false, failures: [`quote-not-in-item:${id}`] });
    // Syntax only: no letter or digit.
    expect(quote("E1", "{\"")).toEqual(fails("E1"));
    expect(quote("E1", "\":\"")).toEqual(fails("E1"));
    // Ends inside a token, compact and text forms.
    expect(quote("E2", "\"classA\":8190")).toEqual(fails("E2"));
    expect(quote("E2", "\"classA\": 8190")).toEqual(fails("E2"));
    expect(quote("E2", "\"status\":\"fail")).toEqual(fails("E2"));
    expect(quote("E2", "\"status\": \"fail")).toEqual(fails("E2"));
    // Starts inside a token.
    expect(quote("E3", "9231615488 failed")).toEqual(fails("E3"));
    expect(quote("E2", "lassA\": 81900")).toEqual(fails("E2"));
    // Unicode letters are word characters.
    expect(quote("E4", "échou")).toEqual(fails("E4"));
    // Positive controls: whole values pass in both forms.
    expect(quote("E1", "{\"ok\":false}")).toEqual({ ok: true, failures: [] });
    expect(quote("E2", "\"classA\":81900")).toEqual({ ok: true, failures: [] });
    expect(quote("E2", "\"classA\": 81900")).toEqual({ ok: true, failures: [] });
    expect(quote("E2", "\"status\":\"failed\"")).toEqual({ ok: true, failures: [] });
    expect(quote("E3", "39231615488")).toEqual({ ok: true, failures: [] });
    expect(quote("E3", "failed")).toEqual({ ok: true, failures: [] });
    expect(quote("E4", "échoué")).toEqual({ ok: true, failures: [] });
    // A later whole occurrence counts even when the first is inside a token.
    expect(quote("E5", "fail")).toEqual({ ok: true, failures: [] });
  },

  async "cause and runbook"() {
    const bundle = { items: [item("E1", "x")], causes: new Set(["alarm-stuck", "unknown"]), runbooks: new Set(["cloudflare-data-publisher.md#roll-back"]) };
    const base = { ...VALID_OUTPUT, evidence: [{ id: "E1", quote: "x" }] };
    expect(checkEvidence({ ...base, cause: "exceeded-memory", runbook: null }, bundle).failures).toEqual(["cause-not-in-playbook:exceeded-memory"]);
    expect(checkEvidence({ ...base, runbook: "cloudflare-data-publisher.md#r2-operations-and-cost" }, bundle).failures).toEqual(["runbook-not-in-playbook:cloudflare-data-publisher.md#r2-operations-and-cost"]);
    expect(checkEvidence({ ...base, cause: "unknown", runbook: null }, bundle)).toEqual({ ok: true, failures: [] });
    expect(checkEvidence({ ...base, runbook: "cloudflare-data-publisher.md#roll-back" }, bundle)).toEqual({ ok: true, failures: [] });
  },

  async "output schema"() {
    expect(diagnosisOutputSchema.safeParse(VALID_OUTPUT).success).toBe(true);
    const { evidence: _, ...missing } = VALID_OUTPUT;
    expect(diagnosisOutputSchema.safeParse(missing).success).toBe(false);
    expect(diagnosisOutputSchema.safeParse({ ...VALID_OUTPUT, confidence: "sure" }).success).toBe(false);
    // The run record's diagnosis carries B33's fields.
    const run = await runTick(deps({ health: devHealth({ rules: [missed()] }) }));
    expect(Object.keys(run.runRecord!.diagnoses[0]!).sort()).toEqual([
      "at", "cause", "confidence", "costUsd", "env", "evidence", "evidenceCheck", "fingerprints", "inputTokens", "job",
      "model", "modelCalls", "neurons", "outputTokens", "ownerAction", "playbookMissing", "reason", "ruleIds", "runId",
      "runbook", "since", "steps", "toolCalls", "trajectoryKey", "verdict",
    ]);
  },

  async "write scope"() {
    const raw = memoryStore();
    const store = scopedStore("dev", raw);
    await store.put("internal/sre/v1/dev/runs/x.json", "{}");
    expect(raw.calls).toEqual([{ op: "put", key: "internal/sre/v1/dev/runs/x.json" }]);
    for (const key of ["internal/sre/v1/prod/x", "public/v2/current.json", "internal/identity/v1/last-run.json", "public/x/internal/sre/v1/dev/y", "internal/sre/v1/dev/../../identity/v1/last-run.json"]) {
      await expect(store.put(key, "{}")).rejects.toBeInstanceOf(WriteScopeError);
      await expect(store.get(key)).rejects.toBeInstanceOf(WriteScopeError);
    }
    expect(raw.calls).toHaveLength(1);
  },

  async "delete scope"() {
    const outside = ["internal/sre/v1/prod/drills/armed/kip-pages.json", "public/v2/current.json", "internal/identity/v1/last-run.json", "public/x/internal/sre/v1/dev/y", "internal/sre/v1/dev/../../identity/v1/last-run.json"];
    const raw = memoryStore();
    for (const key of outside) raw.objects.set(key, "{}");
    const store = scopedStore("dev", raw);
    for (const key of outside) await expect(store.delete!(key)).rejects.toBeInstanceOf(WriteScopeError);
    expect(raw.calls).toEqual([]);
    expect([...raw.objects.keys()].sort()).toEqual([...outside].sort());
    // Positive control: a key inside the Dev prefix is deleted.
    raw.objects.set("internal/sre/v1/dev/drills/armed/kip-pages.json", "{}");
    await store.delete!("internal/sre/v1/dev/drills/armed/kip-pages.json");
    expect(raw.calls).toEqual([{ op: "delete", key: "internal/sre/v1/dev/drills/armed/kip-pages.json" }]);
    expect(raw.objects.has("internal/sre/v1/dev/drills/armed/kip-pages.json")).toBe(false);
  },

  async "forbidden requests"() {
    for (const flag of ["dry", "live"]) {
      const raw = memoryStore();
      const github = githubFake({ main: "failure" });
      const model = scripted(toolCall("get_ci_run", { runId: "39231615500" }), toolCall("get_health_section", { path: "costGuard" }, "c2"), answer({ ...VALID_OUTPUT, evidence: [], cause: "unknown", runbook: null }));
      const run = await runTick(deps({ flag, store: raw, fetch: github.fetch, model }));
      expect(run.runRecord!.diagnoses.map((value) => `${value.job} ${value.verdict}`)).toEqual([`ci.release ${flag === "live" ? "explained" : "dry-run"}`]);
      expect(github.requests.length).toBeGreaterThan(flag === "live" ? 2 : 1);
      for (const request of github.requests) {
        expect(request.method).toBe("GET");
        expect(request.url.startsWith("https://api.github.com/repos/unknowntpo/oss-knowledge-base/actions/")).toBe(true);
        expect(request.url).not.toMatch(/\/run(\?|$)|\/cost-guard\//u);
        expect(Object.keys(request.headers).map((key) => key.toLowerCase())).not.toContain("authorization");
      }
      expect(raw.calls.filter((call) => call.op === "put").length).toBeGreaterThan(0);
      for (const call of raw.calls) expect(call.key.startsWith("internal/sre/v1/dev/")).toBe(true);
    }
  },

  async "playbook format"() {
    const runbooks = [{ path: "docs/runbooks/ops.md", text: "# Ops\n\n## Health and manual run\n\ntext\n\n```sh\n# not a heading\n```\n" }];
    const good = playbook("| 1 | `alarm-stuck` | stuck | evidence | [Health](../ops.md#health-and-manual-run) |\n| 2 | `unknown` | Unknown | none | Say so |");
    expect(checkPlaybooks([{ path: "docs/runbooks/sre/good.md", text: good }], runbooks)).toEqual([]);
    const noWhy = good.replace("## Why\n", "## Reason\n");
    const noAnchor = playbook("| 1 | `alarm-stuck` | stuck | evidence | none |");
    const badAnchor = playbook("| 1 | `alarm-stuck` | stuck | evidence | [Health](../ops.md#not-a-heading) |");
    expect(checkPlaybooks([{ path: "docs/runbooks/sre/a.md", text: noWhy }], runbooks)).toEqual(["docs/runbooks/sre/a.md: missing section \"Why\""]);
    expect(checkPlaybooks([{ path: "docs/runbooks/sre/b.md", text: noAnchor }], runbooks)).toEqual(["docs/runbooks/sre/b.md: cause alarm-stuck has no runbook anchor"]);
    expect(checkPlaybooks([{ path: "docs/runbooks/sre/c.md", text: badAnchor }], runbooks)).toEqual(["docs/runbooks/sre/c.md: anchor ops.md#not-a-heading is not a heading in docs/runbooks/"]);
    // The repository's playbooks pass, and the generated module matches them (drift check).
    const files = readDir("docs/runbooks/sre");
    expect(files.length).toBeGreaterThan(0);
    const repoRunbooks = readDir("docs/runbooks");
    expect(checkPlaybooks(files, repoRunbooks)).toEqual([]);
    expect(readFileSync(join(repo, "packages/sre-agent/src/playbooks.generated.ts"), "utf8")).toBe(renderPlaybookModule(files, repoRunbooks));
  },

  async "playbook missing"() {
    const firing = rule("publication.freshness", "publication", "firing");
    const bundle = await buildBundle({ env: "dev", job: "publication", firings: [{ env: "dev", job: "publication", ruleId: firing.id, since: firing.since!, runId: firing.runId!, entry: firing }], health: devHealth(), querySignals: sqlFake().querySignals, ci: { status: "ok" }, library: PLAYBOOK_LIBRARY, secrets: [] });
    expect(bundle.playbookMissing).toEqual(["publication.freshness"]);
    const evidence = [{ id: "E1", quote: "publication.freshness" }];
    expect(checkEvidence({ ...VALID_OUTPUT, evidence, runbook: null }, bundle).failures).toEqual(["cause-not-in-playbook:alarm-stuck"]);
    expect(checkEvidence({ ...VALID_OUTPUT, evidence, cause: "unknown", runbook: null }, bundle)).toEqual({ ok: true, failures: [] });
    const run = await runTick(deps({ health: devHealth({ rules: [firing] }), model: scripted(answer({ ...VALID_OUTPUT, evidence, cause: "unknown", runbook: null })) }));
    expect(run.runRecord!.diagnoses[0]).toMatchObject({ playbookMissing: true, verdict: "explained" });
  },

  async "scope v1"() {
    const model = scripted(answer({ ...VALID_OUTPUT, cause: "unknown", runbook: null }));
    const out = await runTick(deps({ model, health: devHealth({ rules: [rule("job.duration", "kip-pages", "firing")] }) }));
    expect(out.runRecord!.notDiagnosed).toEqual([{ fingerprint: "dev:kip-pages:job.duration:2026-10-21T04:07:00.000Z", reason: "out-of-scope" }]);
    expect(model.doGenerateCalls).toHaveLength(0);
    const inScope = await runTick(deps({ model, health: devHealth({ rules: [rule("job.r2ClassA", "publication", "firing")] }) }));
    expect(inScope.runRecord!.diagnoses.map((value) => value.ruleIds)).toEqual([["job.r2ClassA"]]);
    expect(model.doGenerateCalls).toHaveLength(1);
  },
};

function expectedFields(job: string, health: Health): unknown {
  const pick = (value: unknown, keys: readonly string[]) => Object.fromEntries(keys.filter((key) => (value as Record<string, unknown>)[key] !== undefined).map((key) => [key, (value as Record<string, unknown>)[key]]));
  const lastRun = health.lastRun as Record<string, unknown>;
  switch (job) {
    case "publication": return { running: health.running, scheduled: health.scheduled, followUp: health.followUp, phase: health.phase, lastRun: pick(lastRun, ["ok", "runId", "completedAt", "copiedObjectCount", "reusedObjectCount", "r2", "pollTruncated"]), sources: health.sources };
    case "digest": return { digest: { lastRun: pick((health.digest as { lastRun: unknown }).lastRun, ["ok", "runId", "completedAt", "durationMs", "rejections"]) } };
    case "review-queue": return { reviewQueue: health.reviewQueue };
    case "embedding": return { searchEmbedding: pick(health.searchEmbedding, ["lastRun", "lastError", "today"]) };
    case "identity-links": return { identityLinks: { lastRun: pick((health.identityLinks as { lastRun: unknown }).lastRun, ["ok", "status", "at", "durationMs", "r2"]), lastGoodAt: (health.identityLinks as { lastGoodAt: unknown }).lastGoodAt } };
    case "kip-pages": return { kipPages: { lastRun: pick((health.kipPages as { lastRun: unknown }).lastRun, ["ok", "status", "at", "durationMs", "requests", "jiraRequests", "r2", "error"]), lastGoodAt: (health.kipPages as { lastGoodAt: unknown }).lastGoodAt } };
    case "retention": {
      const retention = health.retention as Record<string, unknown>;
      return { retention: { ...pick(retention, ["mode", "status", "reason"]), lastRun: pick(retention.lastRun, ["runId", "deleted", "remaining", "elapsedMs", "r2", "failureKind"]) } };
    }
    default: throw new Error(job);
  }
}

function playbook(causeRows: string): string {
  return ["# Invariant playbook: `x`", "", "## Statement", "", "s", "", "## Why", "", "w", "", "## Evidence the agent gets", "", "e", "", "## Hard check", "", "h", "",
    "## Causes, in order", "", "| # | Cause id | Cause | Distinguishing evidence | Runbook |", "| --- | --- | --- | --- | --- |", causeRows, "", "## Judgment guidance", "", "j", ""].join("\n");
}

function readDir(dir: string): { path: string; text: string }[] {
  return [...new Bun.Glob("*.md").scanSync({ cwd: join(repo, dir) })].sort().map((name) => ({ path: `${dir}/${name}`, text: readFileSync(join(repo, dir, name), "utf8") }));
}

describe("Spec 027 Amendment (2) L1 tick", () => {
  test("every row has a scenario and every A2 job has a field list", () => {
    expect(testPlanRows.filter((row) => scenarios[row.case] === undefined).map((row) => row.case)).toEqual([]);
    expect(Object.keys(JOB_HEALTH_FIELDS).sort()).toEqual(["cost-guard", "digest", "embedding", "identity-backfill", "identity-links", "kip-pages", "publication", "retention", "review-queue"]);
  });

  test.each(testPlanRows)("$id: $case", async (row) => {
    await scenarios[row.case]!();
  });
});
