import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { buildR2Projection } from "@oss-knowledge-base/serving-contract";

import { loadLiveFeed } from "../live-feed";

const outputRoot = join(import.meta.dir, "..", "..", "web", "r2-seed");
const publication = await loadLiveFeed();
const releaseId = publication.index.generatedAt.replace(/[:.]/g, "-");
const objects = await buildR2Projection(publication, releaseId);

for (const object of objects) {
  const path = join(outputRoot, object.key);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, object.body);
}

console.log(`Exported ${objects.length} R2 objects for ${releaseId} to ${outputRoot}`);
