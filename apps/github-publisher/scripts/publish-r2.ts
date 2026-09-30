import { join } from "node:path";

import {
  detailPoolKey,
  FEED_DETAIL_POOL,
  isFeedDetailMap,
  isFeedManifest,
  MANIFEST_KEY,
} from "@oss-knowledge-base/serving-contract";

import { requireRemotePublicationTarget } from "../../web/scripts/remote-publication-target";

const webRoot = join(import.meta.dir, "..", "..", "web");
const root = join(webRoot, "r2-seed");
const manifestPath = join(root, MANIFEST_KEY);
const manifest: unknown = await Bun.file(manifestPath).json();
if (!isFeedManifest(manifest)) throw new Error("Invalid R2 manifest");

const keys: string[] = [];
for await (const file of new Bun.Glob(`public/v2/releases/${manifest.releaseId}/**/*.json`).scan({ cwd: root })) keys.push(file);
if (manifest.schema === "osskb.feed-manifest.v3") {
  // Shared details live outside the release prefix; publish only those this release maps.
  const detailMap: unknown = await Bun.file(join(root, manifest.detailMapKey)).json();
  if (!isFeedDetailMap(detailMap)) throw new Error("Invalid R2 feed detail map");
  keys.push(...new Set(Object.values(detailMap.details).map((digest) => detailPoolKey(FEED_DETAIL_POOL, digest))));
}
keys.sort();

const { bucket, environment } = requireRemotePublicationTarget();
async function putObject(key: string): Promise<void> {
  const process = Bun.spawn([
    "bunx", "wrangler", "r2", "object", "put", `${bucket}/${key}`,
    "--file", join(root, key),
    "--content-type", "application/json",
    "--remote",
  ], { cwd: webRoot, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code !== 0) throw new Error(`Unable to publish ${key}: ${stderr || stdout}`);
}

const concurrency = 8;
let cursor = 0;
await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, async () => {
  for (;;) {
    const index = cursor++;
    const key = keys[index];
    if (key === undefined) return;
    await putObject(key);
  }
}));

// The only mutable object is deliberately outside the concurrent batch.
await putObject(MANIFEST_KEY);

console.log(`Published ${keys.length + 1} Feed objects to ${environment} bucket ${bucket}; manifest was written last`);
