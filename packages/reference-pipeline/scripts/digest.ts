/**
 * Spec 014 offline digest command (`bun run digest -- eval|measure`). Replays the committed
 * Kafka fixture with recorded model responses; never calls a model or the network.
 *
 *   bun run digest -- eval      golden-set metrics for the current revisions (D33, D56)
 *   bun run digest -- measure   neurons, model calls, and R2 reads for cold and steady runs (D25, D26)
 */
import { join } from "node:path";

import {
  evaluate, KAFKA_DIGEST_PROFILE, measure,
  type DigestFixture, type GoldenLabels, type RecordedResponses,
} from "../src";

const fixtures = join(import.meta.dir, "..", "test", "fixtures");
const option = (name: string, fallback: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1]! : fallback;
};

const usage = "usage: bun run digest -- eval|measure [--fixture f] [--recorded f] [--labels f]";
const mode = process.argv[2];
// Unknown flags fail instead of being ignored (e.g. `--scale`, D27, belongs to slice 2).
for (let index = 3; index < process.argv.length; index += 2) {
  if (!["--fixture", "--recorded", "--labels"].includes(process.argv[index]!) || process.argv[index + 1] === undefined) {
    console.error(usage);
    process.exit(2);
  }
}
const fixture = await Bun.file(option("fixture", join(fixtures, "topic-digest-kafka-2026-10-06.json"))).json() as DigestFixture;
const recorded = await Bun.file(option("recorded", join(fixtures, "topic-digest-recorded.hand-2026-10-08.json"))).json() as RecordedResponses;

if (mode === "eval") {
  const labels = await Bun.file(option("labels", join(fixtures, "topic-digest-labels.v0.json"))).json() as GoldenLabels;
  console.log(JSON.stringify(evaluate(fixture, recorded, labels, KAFKA_DIGEST_PROFILE), null, 2));
} else if (mode === "measure") {
  const report = measure(fixture, recorded, KAFKA_DIGEST_PROFILE);
  const limits = { coldNeurons: 4_500, steadyNeurons: 2_000, modelCalls: 50, r2Reads: 300 };
  const ok = report.cold.neurons <= limits.coldNeurons && report.steady.neurons <= limits.steadyNeurons
    && report.cold.modelCalls <= limits.modelCalls && report.cold.r2Reads <= limits.r2Reads;
  console.log(JSON.stringify({ ...report, limits, ok }, null, 2));
  if (!ok) process.exit(1);
} else {
  console.error(usage);
  process.exit(2);
}
