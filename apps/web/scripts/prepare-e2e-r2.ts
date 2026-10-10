import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { searchIdentifierProfiles } from "@oss-knowledge-base/reference-pipeline/search-profiles";
import { CODE_TEXT_LEXICAL_REVISION } from "@oss-knowledge-base/search";
import {
  buildR2Projection,
  buildR2SearchProjection,
  type FeedPublication,
} from "@oss-knowledge-base/serving-contract";

import { buildGoldenSearchPublication, buildGoldenV2SearchPublication } from "./build-search-fixture";

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
const searchFixtureV2Path = join(repositoryRoot, "packages", "search", "test", "fixtures", "golden-queries.v2.json");
const seedRoot = join(webRoot, ".e2e", "r2-seed");
const stateRoot = join(webRoot, ".wrangler", "e2e-state");
/** Spec 016: the same bucket with a `bm25-reference@2` Search release current (playwright.lexical2.config.ts). */
const lexical2SeedRoot = join(webRoot, ".e2e", "r2-seed-lexical2");
const lexical2StateRoot = join(webRoot, ".wrangler", "e2e-state-lexical2");

const fixture = await Bun.file(fixturePath).json() as {
  readonly publication: FeedPublication;
};
// Spec 014: the weekly digest fixtures (built by apps/data-publisher-worker/scripts/build-digest-fixture.ts).
const digestRoot = "public/digest/v1/apache-kafka/2026-10-06T13-07-37-000Z/e2e/fixture/";
const digestObjects = await Promise.all(["en", "zh-Hant"].map(async (locale) => ({
  key: `${digestRoot}${locale === "en" ? "en.json" : "zh-Hant.0000000000000000.json"}`,
  body: new TextEncoder().encode(await Bun.file(join(webRoot, "test", "fixtures", "digest", `apache-kafka.${locale}.json`)).text()),
})));
const digestPointer = {
  key: "public/digest/v1/apache-kafka/current.json",
  body: new TextEncoder().encode(JSON.stringify({
    schema: "osskb.digest-pointer.v1",
    objectKeys: { en: digestObjects[0]!.key, "zh-Hant": digestObjects[1]!.key },
    sourceReleaseId: "2026-10-06T13-07-37-000Z",
  })),
};
const objects = [
  ...await buildR2Projection(fixture.publication, "e2e-fixture-v1"),
  ...await buildR2SearchProjection(await buildGoldenSearchPublication(searchFixturePath)),
  ...digestObjects,
  digestPointer,
];

// Golden v2 at `bm25-reference@2`, written with the community search profiles like the publisher.
const lexical2Objects = await buildR2SearchProjection(
  await buildGoldenV2SearchPublication(searchFixtureV2Path, undefined, CODE_TEXT_LEXICAL_REVISION),
  { identifiers: searchIdentifierProfiles },
);

// Stable paths are safe because every run recreates both the input and R2 state.
for (const path of [seedRoot, stateRoot, lexical2SeedRoot, lexical2StateRoot]) await rm(path, { recursive: true, force: true });

await seed(objects, seedRoot, stateRoot);
// Every other object is shared; only the Search pointer and the `@2` release differ.
await cp(stateRoot, lexical2StateRoot, { recursive: true });
await seed(lexical2Objects, lexical2SeedRoot, lexical2StateRoot);

console.log(`Prepared ${objects.length} deterministic R2 objects in ${stateRoot} and ${lexical2Objects.length} more in ${lexical2StateRoot}`);

async function seed(
  seedObjects: readonly { readonly key: string; readonly body: string | Uint8Array }[],
  seedDirectory: string,
  stateDirectory: string,
): Promise<void> {
  for (const object of seedObjects) {
    const file = join(seedDirectory, object.key);
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
      stateDirectory,
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
}
