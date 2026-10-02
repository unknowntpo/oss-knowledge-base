import { join } from "node:path";

import type { DomainEventV1 } from "@oss-knowledge-base/domain";

import { canonicalJson, materializeReferenceFeed, type ReferenceMaterializationConfig } from "../src";

const fixturePath = Bun.argv[2] ?? join(import.meta.dir, "..", "test", "fixtures", "github-events.v1.json");
const fixture = await Bun.file(fixturePath).json() as {
  readonly config: ReferenceMaterializationConfig;
  readonly events: readonly DomainEventV1[];
};
const result = materializeReferenceFeed(fixture.events, fixture.config);
process.stdout.write(`${result.digest}\n${canonicalJson(result.publication)}`);
