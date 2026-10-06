/**
 * Spec 009 M1/M2: peak `heapUsed + arrayBuffers` of one full publication under Node/V8.
 *
 *   bun run measure:memory [--events 8600,17200] [--seed 9] [--poll 500]
 *
 * Bun bundles the runner for Node, because the reported numbers must come from V8.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import type { MemoryMeasurement } from "./publication-memory-runner";

/** Spec 009 M1/M2, tightened by Spec 013 L14, by generated event count. */
const LIMITS_MB: Readonly<Record<number, { readonly id: string; readonly limitMB: number }>> = {
  8_600: { id: "M1/L14", limitMB: 96 },
  17_200: { id: "M2/L14", limitMB: 112 },
};
/** Spec 013 L14: Search working set limit, and its allowed growth from 8,600 to 17,200 events. */
const SEARCH_WORKING_SET_MB = 16;
const SEARCH_WORKING_SET_GROWTH_MB = 4;

const { values } = parseArgs({
  options: {
    events: { type: "string", default: "8600,17200" },
    seed: { type: "string", default: "9" },
    poll: { type: "string", default: "500" },
  },
});

const directory = mkdtempSync(join(tmpdir(), "osskb-measure-"));
let failed = false;
const workingSets = new Map<number, number>();
try {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "publication-memory-runner.ts")],
    outdir: directory,
    target: "node",
    format: "esm",
  });
  if (!build.success) throw new AggregateError(build.logs, "Bundling the memory runner failed");
  const runner = join(directory, "publication-memory-runner.js");

  for (const events of values.events.split(",").map(Number)) {
    const output = join(directory, `result-${events}.json`);
    const child = Bun.spawnSync(["node", "--expose-gc", runner, String(events), values.seed, values.poll, output], {
      stdout: "inherit",
      stderr: "inherit",
    });
    if (child.exitCode !== 0) throw new Error(`Runner failed for ${events} events`);
    const result = JSON.parse(readFileSync(output, "utf8")) as MemoryMeasurement;
    const limit = LIMITS_MB[events];
    const verdict = limit === undefined ? "" : ` ${limit.id} limit ${limit.limitMB} MB: ${result.peakMB <= limit.limitMB ? "PASS" : "FAIL"}`;
    if (!result.ok || (limit !== undefined && result.peakMB > limit.limitMB)) failed = true;
    console.log(`\n${events} events (${result.runtime}, seed ${result.seed}, ${result.polledEvents} polled): ` +
      `peak ${result.peakMB} MB at "${result.peakPhase}", baseline ${result.baselineMB} MB, ` +
      `${result.writtenObjects} objects / ${result.writtenMB} MB written in ${result.durationMs} ms, ` +
      `output fingerprint ${result.outputFingerprint.slice(0, 16)}` +
      `${result.ok ? "" : `, run FAILED: ${result.error}`}.${verdict}`);
    console.table(result.phases.map((phase) => ({ phase: phase.phase, "peak MB": phase.peakMB, samples: phase.samples })));
    const peakOf = (name: string) => result.phases.find((phase) => phase.phase === name)?.peakMB ?? 0;
    // Peak while Search objects are written, above the heap when Search writing starts.
    const workingSet = Math.round((peakOf("write search") - peakOf("phase writing-search")) * 10) / 10;
    workingSets.set(events, workingSet);
    const searchPeak = peakOf("write search");
    const feedPeak = peakOf("write feed");
    if (workingSet > SEARCH_WORKING_SET_MB || searchPeak >= feedPeak) failed = true;
    console.log(`Search working set ${workingSet} MB (L14 limit ${SEARCH_WORKING_SET_MB} MB: ` +
      `${workingSet <= SEARCH_WORKING_SET_MB ? "PASS" : "FAIL"}); write search ${searchPeak} MB vs write feed ${feedPeak} MB ` +
      `(Search not the peak: ${searchPeak < feedPeak ? "PASS" : "FAIL"}); ${result.searchShards} Search shards, ` +
      `largest ${result.largestSearchShardMB} MB.`);
  }
  const [small, large] = [workingSets.get(8_600), workingSets.get(17_200)];
  if (small !== undefined && large !== undefined) {
    const growth = Math.round((large - small) * 10) / 10;
    if (growth > SEARCH_WORKING_SET_GROWTH_MB) failed = true;
    console.log(`\nSearch working set growth 8,600 -> 17,200 events: ${growth} MB ` +
      `(L14 limit ${SEARCH_WORKING_SET_GROWTH_MB} MB: ${growth <= SEARCH_WORKING_SET_GROWTH_MB ? "PASS" : "FAIL"}).`);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
