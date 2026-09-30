import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { buildR2Projection } from "@oss-knowledge-base/serving-contract";

import { loadRecordedFeedFixture } from "./load-recorded-feed-publication";

const outputRoot = join(import.meta.dir, "..", "r2-seed");
const recorded = await loadRecordedFeedFixture();
const objects = await buildR2Projection(recorded.publication, recorded.releaseId);

await rm(outputRoot, { recursive: true, force: true });
for (const object of objects) {
  const path = join(outputRoot, object.key);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, object.body);
}

console.log(
  `Prepared ${objects.length} recorded Feed objects for ${recorded.releaseId} without an upstream fetch`,
);
