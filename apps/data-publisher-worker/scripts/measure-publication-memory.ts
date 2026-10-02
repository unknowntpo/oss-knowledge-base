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

/** Spec 009 acceptance limits by generated event count. */
const LIMITS_MB: Readonly<Record<number, { readonly id: string; readonly limitMB: number }>> = {
  8_600: { id: "M1", limitMB: 96 },
  17_200: { id: "M2", limitMB: 128 },
};

const { values } = parseArgs({
  options: {
    events: { type: "string", default: "8600,17200" },
    seed: { type: "string", default: "9" },
    poll: { type: "string", default: "500" },
  },
});

const directory = mkdtempSync(join(tmpdir(), "osskb-measure-"));
let failed = false;
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
      `${result.writtenObjects} objects / ${result.writtenMB} MB written in ${result.durationMs} ms` +
      `${result.ok ? "" : `, run FAILED: ${result.error}`}.${verdict}`);
    console.table(result.phases.map((phase) => ({ phase: phase.phase, "peak MB": phase.peakMB, samples: phase.samples })));
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
