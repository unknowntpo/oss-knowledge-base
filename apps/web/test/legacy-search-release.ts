import {
  SEARCH_CURRENT_KEY,
  SEARCH_DETAIL_POOL,
  sha256Digest,
  type ProjectionObject,
  type SearchLexicalShardV2,
  type SearchReleaseManifestV3,
} from "@oss-knowledge-base/serving-contract";

/** Rewrites a search-release.v3 projection into the pre-Spec 013 search-release.v2 layout. */
export async function legacyV2SearchObjects(objects: readonly ProjectionObject[]): Promise<readonly ProjectionObject[]> {
  const bodies = new Map(objects.map((object) => [object.key, object.body]));
  const manifestObject = objects.find((object) => object.key.endsWith("/manifest.json"))!;
  const manifest = JSON.parse(manifestObject.body) as SearchReleaseManifestV3;
  const prefix = manifestObject.key.slice(0, -"manifest.json".length);
  const projects = new Map<string, { chunks: unknown[]; groups: unknown[] }>();
  for (const { key, projectId } of manifest.shards) {
    const shard = JSON.parse(bodies.get(key)!) as SearchLexicalShardV2;
    const project = projects.get(projectId) ?? { chunks: [], groups: [] };
    project.chunks.push(...shard.chunks);
    project.groups.push(...shard.groups);
    projects.set(projectId, project);
  }
  const shards = [...projects].map(([projectId, value]) => ({
    key: `${prefix}lexical/${encodeURIComponent(projectId)}.json`,
    body: JSON.stringify({
      schema: "osskb.search-lexical-shard.v1",
      indexRevision: manifest.indexRevision,
      projectId,
      chunks: value.chunks,
      groups: value.groups,
    }),
    cacheControl: manifestObject.cacheControl,
  }));
  const details = objects.filter((object) => object.key.startsWith(SEARCH_DETAIL_POOL));
  const objectDigests = Object.fromEntries(await Promise.all([...shards, ...details].map(async (object) =>
    [object.key, await sha256Digest(object.body)] as const)));
  return [
    ...shards,
    ...details,
    {
      ...manifestObject,
      body: JSON.stringify({
        schema: "osskb.search-release.v2",
        indexRevision: manifest.indexRevision,
        corpusRevision: manifest.corpusRevision,
        lexicalRevision: manifest.lexicalRevision,
        generatedAt: manifest.generatedAt,
        shardKeys: Object.fromEntries([...projects.keys()].map((projectId, index) => [projectId, shards[index]!.key])),
        chunkCount: manifest.chunkCount,
        groupCount: manifest.groupCount,
        objectDigests,
      }),
    },
    objects.find((object) => object.key === SEARCH_CURRENT_KEY)!,
  ];
}
