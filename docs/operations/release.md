# Release workflow

Status: Active since v0.1.0

Decision: ADR-0008

## Delivery path

```text
feature branch ── pull request ──> CI only
main push      ──────────────────> CI ──> development Pages
vX.Y.Z tag     ──────────────────> CI + main ancestry ──> production Pages
```

| Git event | Required evidence | Deployment |
| --- | --- | --- |
| Pull request | typecheck, build, unit, integration, desktop/mobile E2E | none |
| Push to `main` | same CI, exact retained `dist` artifact, deployed Dev E2E | `oss-knowledge-base-dev.pages.dev` |
| Push `vX.Y.Z` tag | same CI, valid tag, tagged commit reachable from `main` | `oss-knowledge-base.pages.dev` |

## Acceptance assertions

### R1 — Branch isolation

Given two open feature branches, when both update or rerun CI, then neither
changes development or production Pages state.

### R2 — Main promotes development only

Given a commit lands on `main`, when any required job fails, then no Pages
deploy job runs. When all jobs pass, only development receives the retained CI
artifact for that exact SHA.

### R3 — Tags promote production only

Given `vX.Y.Z` points to a commit reachable from `main`, when all jobs pass,
then production receives the retained artifact for that SHA. A malformed tag or
a tag outside `main` fails before deployment.

### R4 — Deployment and data publication stay separate

Given either deploy runs, then it performs no GitHub polling and writes no Feed
or Search R2 release/current pointer.

### R5 — Production releases are not cancelled

Given two valid tags arrive close together, then their production deployments
serialize. Development may cancel a superseded deployment.

### R6 — Development proves the deployed data path

Given a commit has deployed to development, a separate Chromium check reads
the Dev Worker health status and follows the public Pages Feed → Search →
query-scoped project facet → project filter → immutable FeedDetail path. The
main workflow is not complete unless that deployed check passes without page,
console, or network errors.

## Automation writes

Scheduled ingestion and manual backfill never push generated data directly to
`main`. Each workflow:

1. starts from the current `main`;
2. checkpoints changes on its dedicated `automation/*` branch;
3. opens or updates a review issue containing the compare/PR link;
4. waits for a human to create the pull request;
5. runs normal pull-request CI and waits for a human to review and merge.

Backfill checkpoints before its golden-query gate because the crawl is costly.
A failed gate preserves the branch but does not open or update its PR.

The workflows use only their ephemeral repository `GITHUB_TOKEN`; no personal
access token, deploy key, repository-wide Actions approval permission,
automatic approval, or automatic merge is allowed.

## One-time bootstrap

External bootstrap state:

1. **Done:** Pages project `oss-knowledge-base-dev` uses production branch
   `main`.
2. **Done:** Pages project `oss-knowledge-base` uses production branch
   `production`.
3. **Superseded by Spec 006:** both projects temporarily bind
   `OSS_KB_BUCKET` to the existing private `oss-knowledge-base-poc` R2 bucket.
4. **Done:** scoped `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`
   repository secrets exist.
5. **Done:** GitHub environments `development` and `production` exist.
6. **Done:** `main` blocks deletion and non-fast-forward updates. Required PR
   and CI rules were enabled after the automation review flow was verified.

Production promotions and public browser smoke tests:

| Release | Commit | Workflow | Result |
| --- | --- | --- | --- |
| `v0.1.0` | recorded in its workflow | first production promotion | passed 2026-08-26 |
| `v0.2.0` | `308d3fa` | [run 33351078887](https://github.com/unknowntpo/oss-knowledge-base/actions/runs/33351078887) | passed 2026-09-01 |

For `v0.2.0`, both public sites were readable after promotion. Production
Search returned query-scoped project facets for `Kafka Streams` (DataFusion 1,
Kafka 38), and desktop/mobile Search → FeedDetail smoke checks had no page,
console, or network errors.

## Environment-isolated data bootstrap

Spec 006 and ADR-0010 replace the temporary shared binding:

| Pages project | Wrangler source of truth | R2 binding |
| --- | --- | --- |
| `oss-knowledge-base-dev` | `wrangler.development.jsonc` | `oss-knowledge-base-dev` |
| `oss-knowledge-base` | `wrangler.production.jsonc` | `oss-knowledge-base-prod` |

Cloudflare Pages does not accept a custom Wrangler configuration path. The
deployment script therefore stages the selected reviewed environment config at
the canonical `wrangler.jsonc` path only for the duration of the deploy, then
restores the local-only config in a `finally` block.

The manual `CI and release` workflow with operation `bootstrap-r2` is the only
bootstrap path. It requires the exact `bootstrap-isolated-r2` confirmation,
uses the scoped GitHub environment credentials, creates a missing bucket
idempotently, and publishes the recorded Feed and Search projections
pointer-last. It is not scheduled and performs no live GitHub fetch, LLM call,
benchmark, or frontend build.

The workflow first expands the version-controlled recorded Feed fixture into
the ignored `apps/web/r2-seed` directory on the ephemeral runner. It never
invokes the live Feed exporter during bootstrap.

For the current recorded release, the clean-checkout plan contains 186 Feed
objects (184 entries) and 188 Search objects covering 353 SourceRecords.

After bootstrap, merging the configuration change to `main` applies the
development binding through the normal development deployment. A later
accepted release tag applies the production binding. Do not deploy either
project with the local-only `wrangler.jsonc`.

## v0.3.0: first Prod data release

The first tag since `v0.2.0` also deploys the Prod data Worker for the first
time. Follow [the runbook's "First Prod release"](../runbooks/cloudflare-data-publisher.md#first-prod-release):
secrets first, save the pointers, then the tag, then a manual first run.

Release notes draft (for `gh release create v0.3.0 --repo unknowntpo/oss-knowledge-base --notes-file`):

```markdown
Prod now publishes live data once a day instead of the recorded snapshot of 2026-08-25.

- Daily publication (22:37 UTC) from GitHub, the Kafka dev@ list and Jira (Specs 009–013, 018), with content-addressed details and streaming search releases.
- Search ranks threads with `bm25-reference@3` (Specs 016, 017): `KIP770` equals `KIP-770`, a bare number lists every identifier, adjacent query words rank higher.
- Freshness and stall visibility: a stale or overdue publication shows in the page (Specs 010, 011, 021).
- Design system and dark theme with a three-way toggle (Specs 023, 024).
- Not on Prod yet: semantic search, the topic digest, review ingestion and contributor profiles (Dev only).
```

## Release command

After the selected commit is merged and green on `main` (for `v0.3.0`, after
the runbook's steps 2 and 3):

```bash
VERSION=v0.3.0
git tag -a "$VERSION" -m "Release $VERSION"
git push origin "$VERSION"
```

Do not move or reuse a published release tag. Roll back by redeploying a prior
accepted commit/tag, not by changing immutable R2 release objects.
