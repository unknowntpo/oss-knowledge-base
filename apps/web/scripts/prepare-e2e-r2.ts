import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  buildR2Projection,
  buildR2SearchProjection,
  type FeedPublication,
} from "@oss-knowledge-base/serving-contract";

import { buildGoldenSearchPublication } from "./build-search-fixture";

const webRoot = join(import.meta.dir, "..");
const repositoryRoot = join(webRoot, "..", "..");
const fixturePath = join(
  repositoryRoot,
  "packages",
  "reference-pipeline",
  "test",
  "fixtures",
  "github-feed-projection.v1.json",
);
const searchFixturePath = join(
  repositoryRoot,
  "packages",
  "search",
  "test",
  "fixtures",
  "golden-queries.v1.json",
);
const seedRoot = join(webRoot, ".e2e", "r2-seed");
const stateRoot = join(webRoot, ".wrangler", "e2e-state");

const fixture = await Bun.file(fixturePath).json() as {
  readonly publication: FeedPublication;
};
const objects = [
  ...await buildR2Projection(fixture.publication, "e2e-fixture-v1"),
  ...await buildR2SearchProjection(await buildGoldenSearchPublication(searchFixturePath)),
];

// Stable paths are safe because every run recreates both the input and R2 state.
await rm(seedRoot, { recursive: true, force: true });
await rm(stateRoot, { recursive: true, force: true });

for (const object of objects) {
  const file = join(seedRoot, object.key);
  await mkdir(dirname(file), { recursive: true });
  await Bun.write(file, object.body);

  const process = Bun.spawn([
    "bunx",
    "wrangler",
    "r2",
    "object",
    "put",
    `oss-knowledge-base-local/${object.key}`,
    "--file",
    file,
    "--content-type",
    "application/json",
    "--local",
    "--persist-to",
    stateRoot,
  ], {
    cwd: webRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Unable to seed ${object.key}: ${stderr || stdout}`);
  }
}

console.log(`Prepared ${objects.length} deterministic R2 objects in ${stateRoot}`);
