# Process & cost

The project is built by one person directing AI agents. Trust does not come from reading more AI output; it comes from specifications with numbered acceptance items, tests that were seen failing first, an independent AI verifier, machine gates in CI, and runtime checks. The same discipline keeps the cloud bill inside the platform's included allowances.

## Spec-driven development {#specs}

Every feature starts as a spec in [docs/specs](docs/specs): intent, a worked example on real data, a simplification review, and numbered acceptance items. There are {{value:specs}} specs; {{value:enforcedSpecs}} are marked `Traceability: enforced`. The workflow is written down in [docs/process/workflow.md](docs/process/workflow.md).

1. **Intent** (human): an observable outcome.
2. **Assertions:** numbered items such as `D34` or `DOC4`, each with precondition, action, observable result and evidence. A spec must cover the happy path, failure and retry (at least as many items), budget (with a measured value and a committed command) and observability.
3. **Decision:** an ADR when a choice crosses features ([docs/architecture/decisions](docs/architecture/decisions)).
4. **Slice:** the smallest end-to-end change, tests first.
5. **Gates:** local checks, then CI, then Dev, then Prod.
6. **Runtime:** health fields and freshness are the final judge.

The **simplification review** comes before any design is accepted, in order: question every requirement, delete, simplify, shorten the verification cycle, automate last.

### Traceability {#traceability}

Acceptance IDs are the join key from spec to test to pull request to runtime check. `bun run check:traceability` fails when an item in an enforced spec has no test whose name contains its ID ([check-spec-traceability.ts](scripts/check-spec-traceability.ts)). Test-plan tables in the specs are generated from the same case files the tests iterate, and `bun run check:test-plan` fails when they drift ([render-test-plan.ts](scripts/render-test-plan.ts)), so the table a human reviews is the data the tests run.

### Evidence rules {#evidence}

- A test proves an assertion only after it was observed failing without the change.
- An AI "done" or "LGTM" is not evidence. A merge needs the implementer's line-by-line self-review, green gates, and the **independent verifier**: a different agent given only the spec and the commit, which reruns every acceptance item and records pass, fail or unverifiable with evidence. Any new commit invalidates its verdict.
- The human decides core matters only: intent, contracts, cost, credentials, production releases and public surfaces (such as this site).
- Each lesson moves to the strongest layer that can hold it: types, then CI gates, then tests, then written rules. Known workarounds are tracked in [docs/gardening.md](docs/gardening.md) so agents do not copy them.

## CI/CD and releases {#cicd}

[.github/workflows/ci.yml](.github/workflows/ci.yml) runs typecheck, the traceability and test-plan gates, the build, unit, integration and end-to-end tests on every pull request.

| Event | Result |
| --- | --- |
| Pull request | CI only; nothing is deployed |
| Push to `main` | after every job passes: Dev Pages and the Dev publisher, then end-to-end tests against the deployed Dev site |
| Tag `vX.Y.Z` reachable from `main` | Prod Pages and the Prod publisher, from the exact verified build |

Tags are never moved or reused; a rollback redeploys an earlier tag ([docs/operations/release.md](docs/operations/release.md)). `v0.3.0` failed CI and deployed nothing; `v0.3.1` (2026-10-19) is the first Prod release with live daily data; `v0.3.2` (2026-10-24) adds Workers Logs and ships newer code with every new flag off. A generated status board of every spec is published on every push ([Spec 020](docs/specs/020-feature-map-site/spec.md)).

## The R2 Class A incident {#incident}

R2 bills two request classes: **Class A** (writes and lists, $4.50 per million after 1 million a month) and **Class B** (reads, $0.36 per million after 10 million). A conditional write that fails its precondition is still Class A ([Spec 008](docs/specs/008-content-addressed-details/spec.md)).

- **Cause.** A change on 2026-09-30 replaced "read, then write if absent" with one conditional write per object, including the thousands of objects that already existed. An hourly Dev run sent about 8,190 Class A requests, roughly 5.98 million a month.
- **Detection.** On 2026-10-13 the billing page showed 1.2 million Class A since 2026-10-07, projecting about $20 for the month, against 6.23 thousand Class B.
- **Fix 1.** Check existence with a cheap read (`head`, Class B) and write only new objects: about 38 Class A per hourly run instead of about 8,190. Invariant: Class A ≤ new objects + 3.
- **Fix 2.** Every run reports its own R2 requests in `/health` (`lastRun.r2`), so cost is observable per run.
- **Fix 3.** Publication moved from hourly to daily ([Spec 018](docs/specs/018-daily-publication/spec.md)).
- **After.** The first daily Dev run sent 391 Class A and 8,343 Class B; the 2026-10-19 runs sent 794 / 8,590 (Dev) and 381 / 7,977 (Prod). Spec 018's estimate of the monthly Class A count was ten times too low, and that is recorded rather than hidden.

## Budgets {#budgets}

The account is on the Workers Paid plan; the design keeps each meter inside the plan's included amount, and every job charges a ledger before it spends ([runbook](docs/runbooks/cloudflare-data-publisher.md)).

| Meter | Included | Budgeted use |
| --- | --- | --- |
| Workers AI neurons | 10,000 a day | digest 5,000 + embedding job 2,500 + search queries 1,000 + Dev SRE agent 3,000 = 11,500; a day where every cap is reached passes the included amount by at most 1,500 neurons ($0.0165) |
| R2 Class A | 1 million a month | about 19 thousand a month for Dev and Prod together |
| R2 Class B | 10 million a month | about 0.26 million a month |
| R2 storage | 10 GB | already exceeded on Dev (13.3 GB, 2026-10-19), tracked in [docs/gardening.md](docs/gardening.md) |
| Vectorize | 10 million stored dimensions | about 10.0 million as of 2026-10-20 (9,764 chunks embedded × 1,024), close to the included amount |

Committed `measure:*` commands reproduce these numbers offline (see the root [package.json](package.json)); for example `bun run measure:daily-volume` checks that a day's volume fits the per-run source caps.

## Observability {#observability}

- **`/health`** on each publisher: the last run's outcome per source, objects written, R2 requests, search index size, and today's AI spend against its cap. It never returns credentials.
- **Freshness in the product:** every view shows how old the data is; late after 24 h 30 min, stale after 27 h ([Spec 021](docs/specs/021-publication-overdue/spec.md)). A stall is visible to every reader without push alerts.
- **`bun run verify:health`** compares `/health` with what the site serves, for Dev or Prod, read-only ([scripts/verify/health.ts](scripts/verify/health.ts)).
- **Signals and rules** (Dev): every job run writes one Workers Analytics Engine data point keyed by its `runId`. Fixed rules over those points and `/health` give each check the status `ok`, `warn`, `firing` or `unknown` in `/health.signals`, for example `job.missed` and `job.failures` ([Spec 028](docs/specs/028-observability-signals/spec.md)).
- **Components in `/health`** (Dev; Prod with the next release tag): one status per job and per source, `ok`, `warn`, `failed`, `stale` or `unknown` ([Spec 033](docs/specs/033-system-map/spec.md)).
- **[SRE agent](sre-agent.html)** (Dev): a firing rule starts a model diagnosis whose cited evidence code checks. Cloudflare Agent tracing records each run for the owner.
- **Workers Logs** with redacted error text: on Dev and, since `v0.3.2`, on Prod.

> As of 2026-10-27 at the commit in the footer. Billing figures come from Spec 008 and the runbook; run figures from the public `/health` endpoints.
