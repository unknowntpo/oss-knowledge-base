# SRE agent

On Dev, a scheduled job reads the publisher's own health signals. When a rule fires, a language model diagnoses the cause from a fixed evidence bundle. Code then checks every citation before the result is stored. The agent never detects a problem and never changes the system ([Spec 027](docs/specs/027-sre-agent/spec.md)).

## How a diagnosis runs {#loop}

1. **Detect (code).** Spec 028 rules judge `/health` fields and Workers Analytics Engine (WAE) data points. Each rule has the status `ok`, `warn`, `firing` or `unknown` ([Spec 028](docs/specs/028-observability-signals/spec.md)). A tripped cost guard and a failed release CI run are also firings. Without a firing, the job makes no model call.
2. **Collect (code).** The `sre-agent` job builds one evidence bundle per job. Its items `E1`…`En` hold the rule entry, the job's `/health` fields, the results of fixed WAE queries (`Q-run`, `Q-history`, `Q-window`) and the playbook. Items are redacted, capped at 24 KB in total and marked untrusted in the prompt ([bundle.ts](packages/sre-agent/src/bundle.ts)).
3. **Diagnose (model).** One AI SDK loop runs on Workers AI with Qwen3 30B (`@cf/qwen/qwen3-30b-a3b-fp8`). It has at most 12 steps of up to 4,096 output tokens. Its tools are read-only: `/health` sections, the fixed queries, the playbook and the runbook ([loop.ts](packages/sre-agent/src/loop.ts)).
4. **Check (code).** The evidence check accepts or rejects the answer ([below](#evidence)).
5. **Store.** The run record, the full trajectory and the daily state go to R2 under `internal/sre/v1/<env>/`. `/health` field `sreAgent` shows the last run. The owner reads it; nothing is pushed.

The job runs twice a day on Dev, at 00:30 and 11:00 UTC ([wrangler.development.jsonc](apps/data-publisher-worker/wrangler.development.jsonc)). On Prod, `SRE_AGENT` is `off`.

## What the model answers {#output}

A **playbook** is the runbook page for one rule. It lists the possible causes in the order to check them ([job.failures.md](docs/runbooks/sre/job.failures.md)). The model answers six fields:

| Field | Meaning |
| --- | --- |
| `cause` | the first cause id in the playbook table that the evidence supports, or `unknown` |
| `verdict` | `explained`: the cause is a cause id. `inconclusive`: the cause is `unknown` and the bundle lacks the deciding evidence. `unexplained`: the cause is `unknown` and the cited evidence rules out every cause |
| `confidence` | `low`, `medium` or `high`; it never changes the verdict |
| `evidence` | one entry per cited field: the item id and a path or a quote |
| `runbook` | one anchor from the playbook, or null |
| `ownerAction` | the next step for the owner, which no tool can do |

## How fabrication is caught {#evidence}

The model may cite only what is in the bundle. `checkEvidence` in [evidence.ts](packages/sre-agent/src/evidence.ts) is code only, with no model:

- A JSON item is cited by `path`, for example `kipPages.lastRun.error`. The path must resolve in the item's parsed JSON.
- A text item is cited by `quote`. The quote must occur in the item, or match the key–value pairs of one object in it. Whitespace does not count; an ellipsis fails.
- An unknown item id fails. A cause that is not in the playbook fails. A runbook anchor that the playbook does not list fails.

A failed check changes the verdict to `unverified`. The rest of the answer is kept for the owner to read.

## Budget {#budget}

A ledger reserves neurons before every model call. The default caps are 3 diagnoses and 1,500 neurons per UTC day. Dev raises them to 10 diagnoses and 3,000 neurons while the agent is in development (`SRE_AGENT_MAX_DIAGNOSES`, `SRE_AGENT_DAILY_NEURONS`). An invalid value gives the default, never no cap. A worst-case Qwen3 30B diagnosis uses 576 neurons, so 3,000 neurons is about 5 diagnoses: $0.033 a day if every neuron were billed. With the digest, embedding and query caps, Dev's caps sum to 11,500 neurons. That is at most 1,500 above the 10,000 included each day ([Process & cost](process.html#budgets)).

## Fault-injection drill {#drill}

The evaluation replays fixed bundles; the drill tests the live path on Dev. The owner arms a `throw` or `skip` fault for the `kip-pages` job. The job then fails or does not run, the real WAE point is written, a Spec 028 rule fires, and the next tick diagnoses it. Code grades the diagnosis against expectations that only the code holds ([drill.ts](packages/sre-agent/src/drill.ts)). A `throw` drill passes only with cause `upstream-unavailable`, citations of `kipPages.lastRun.error` and the `Q-window` rows, the expected runbook anchor and the verdict `explained`. On 2026-10-26, Dev drill `throw-20261026T0929Z` graded `pass` ([Spec 033](docs/specs/033-system-map/spec.md)).

## Prompt in Simplified Technical English {#prompt}

The system prompt follows ASD-STE100 (Simplified Technical English): one term per concept, one instruction per sentence, imperative mood, at most about 20 words a sentence. It opens with a System context section ([system.md](docs/runbooks/sre/system.md)). That section describes the publisher, its jobs, `/health`, WAE, and what a rule and a firing are. Each output field section is the same text as that field's schema description, so the model reads one wording. Tests SRE99 and SRE100 fail when a sentence has more than 20 words, when a banned term returns (such as "bundle item" or "verbatim"), or when the sections drift from the schema ([tick.cases.ts](packages/sre-agent/test/tick.cases.ts)).

## Evaluation {#eval}

`bun run --cwd packages/sre-agent eval` replays 7 cases, 5 runs each, with real Workers AI calls. Five cases need a diagnosis, most of them past incidents such as the R2 Class A spike of 2026-10-13. Two cases must make no model call. With `--stub`, a mock model gives the expected answers: no network, $0. Graders are code, with no model as judge. A diagnosis passes when the cause, every required evidence item and the runbook anchor are right. **Fabrication** is the share of answers that the evidence check rejected.

| Qwen3 30B | 2026-10-25, third run | 2026-10-27 |
| --- | --- | --- |
| Diagnoses passing | 2 of 24 | 7 of 25 |
| Cause correct | 63% | 72% |
| Evidence correct | 25% | 40% |
| Fabrication | 63% | 36% |
| Neurons per diagnosis | 62.3 | 58.3 |

The 2026-10-27 run used 1,458 neurons, $0.016 in total ([scoreboard-2026-10-25c](docs/specs/027-sre-agent/eval/scoreboard-2026-10-25c.md), [scoreboard-2026-10-27](docs/specs/027-sre-agent/eval/scoreboard-2026-10-27.md)). Between the two runs, the prompt moved to STE and the evidence check changed: JSON items are cited by path, and quotes ignore whitespace. The gain therefore does not come from the prompt alone.

## Tracing {#tracing}

On Dev, Cloudflare Agent tracing records every tick. The Workers Observability Agents tab shows a replay of the prompt with its bundle, each model step and the final diagnosis, with token usage. Traces are kept 7 days. The R2 trajectory stays the record of a run. Prod has no traces.

## Limits {#limits}

- The most frequent failure, in 8 of 25 diagnoses, is the string `"null"` as `runbook` instead of JSON null. The check rejects it, and the code does not convert it.
- Three of the five diagnosis cases never pass: `dev-stall-2026-10-02`, `kip-pages-two-failures` and `tag-ci-failure-v0.3.0`.
- The agent runs on Dev only. On Prod, `SRE_AGENT` is `off` and no quota or model is set.
