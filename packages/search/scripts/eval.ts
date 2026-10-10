/**
 * Evaluates the golden v2 queries (Spec 016): prints a table and writes the JSON report.
 *
 *   bun run eval:search                 # rewrites test/fixtures/golden-evaluation.v2.json
 *   bun run eval:search -- --out <path> # writes the report elsewhere
 *
 * The committed report is compared with a fresh run by `golden-v2.test.ts`, so a change in
 * ranking shows up as a diff of that file.
 */
import { resolve } from "node:path";

import { formatEvaluationTable } from "../src";
import { evaluateGoldenV2, goldenV2ReportPath, loadGoldenV2 } from "../test/support/golden-v2";

const outIndex = process.argv.indexOf("--out");
if (outIndex >= 0 && process.argv[outIndex + 1] === undefined) throw new Error("--out needs a path");
const out = outIndex >= 0 ? resolve(process.argv[outIndex + 1]!) : goldenV2ReportPath.pathname;

const report = await evaluateGoldenV2(await loadGoldenV2());
await Bun.write(out, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(formatEvaluationTable(report));
process.stdout.write(`\nWrote ${out}\n`);
