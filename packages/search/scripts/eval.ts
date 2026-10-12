/**
 * Evaluates the golden v2 queries (Spec 016) and the real-corpus queries (Spec 017): prints a
 * table for each and writes the JSON reports.
 *
 *   bun run eval:search                             # rewrites test/fixtures/golden-evaluation.v2.json
 *                                                   # and test/fixtures/real-corpus-evaluation.v1.json
 *   bun run eval:search -- --out <path>             # writes the golden v2 report elsewhere
 *   bun run eval:search -- --real-corpus-out <path> # writes the real-corpus report elsewhere
 *
 * The committed reports are compared with a fresh run by `golden-v2.test.ts` and
 * `real-corpus.test.ts`, so a change in ranking shows up as a diff of those files.
 */
import { resolve } from "node:path";

import { formatEvaluationTable } from "../src";
import { evaluateGoldenV2, goldenV2ReportPath, loadGoldenV2 } from "../test/support/golden-v2";
import { evaluateRealCorpus, loadRealCorpus, realCorpusReportPath } from "../test/support/real-corpus";

function target(flag: string, fallback: URL): string {
  const index = process.argv.indexOf(flag);
  if (index >= 0 && process.argv[index + 1] === undefined) throw new Error(`${flag} needs a path`);
  return index >= 0 ? resolve(process.argv[index + 1]!) : fallback.pathname;
}

for (const [out, report] of [
  [target("--out", goldenV2ReportPath), await evaluateGoldenV2(await loadGoldenV2())],
  [target("--real-corpus-out", realCorpusReportPath), await evaluateRealCorpus(await loadRealCorpus())],
] as const) {
  await Bun.write(out, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(formatEvaluationTable(report));
  process.stdout.write(`\nWrote ${out}\n\n`);
}
