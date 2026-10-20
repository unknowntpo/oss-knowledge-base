# Weekly digest

Every day the Dev environment turns the last seven days of Kafka activity into a short bilingual summary: topic cards, KIP proposals by stage, and a headline, each sentence citing the records it is based on. Language models write the text; deterministic rules decide what may be published.

## The pipeline {#flow}

{{flow:digest}}

Models run on Cloudflare Workers AI through AI Gateway (a proxy that adds rate and spend limits). The split of work is deliberate: a small, cheap classifier answers a multiple-choice question per thread; the large model writes only from the threads it was given; a third model translates. Ranking, placement and validation are plain code ([Spec 014](docs/specs/014-topic-digest/spec.md)).

## Why rules check the model {#rules}

A design review of a real week (2026-10-08) found sentences that claimed a pull request was merged while it was still open, and that attributed objections nobody made. Prompting alone does not prevent this, so every sentence is checked against the source records before publication, and a failing sentence is dropped rather than repaired ([validate.ts](packages/reference-pipeline/src/digest/validate.ts)):

| Rejection | What it catches |
| --- | --- |
| `length` | empty or over 240 characters |
| `no-cites`, `cite-outside-inputs` | a sentence with no citation, or citing a record the model was not given |
| `status:<word>` | "merged", "landed", "fixed" without a merged PR or resolved Jira issue; "released", "shipped" without an [ANNOUNCE]; "verified", "accepted" without a [RESULT] or [ANNOUNCE] thread |
| `stance:<word>` | "objected", "rejected", "pushed back" and similar, which overstate a discussion |
| `other-proposal` | a second KIP in a line about one proposal |

In review in [PR #101](https://github.com/unknowntpo/oss-knowledge-base/pull/101), not yet on `main`: a status-tense rule (completion forms such as "is added" or "now supports" for an item that is not finished), and for the translation a status guard (the Chinese status word must match the English one, else the item stays in English) with a small Kafka glossary.

## Quality gate before Prod {#gate}

The digest reaches Prod only after a human labels one real week and the evaluation meets the thresholds ([Spec 014](docs/specs/014-topic-digest/spec.md), Behavior 31).

- **Error classes** for English sentences: `status-mismatch`, `misattribution`, `invented-claim`, `overbroad-stance`.
- **Fixed thresholds:** zero `status-mismatch` and zero `overbroad-stance`. Thresholds for the other two classes and for recall of important threads (an example in the spec is recall ≥ 0.8) are the owner's to set.
- **Golden set:** a labels file in the repository; today it holds the five negatives from the 2026-10-08 review and no important-thread labels yet ([topic-digest-labels.v0.json](packages/reference-pipeline/test/fixtures/topic-digest-labels.v0.json)).
- **Evaluation:** `bun run digest -- eval` (offline, no network) reports kept and dropped sentences by reason, whether every labelled error was rejected, and recall; `bun run digest -- measure` fails when a run would exceed its neuron, call or read limits ([scripts/digest.ts](packages/reference-pipeline/scripts/digest.ts), [eval.ts](packages/reference-pipeline/src/digest/eval.ts)).

Status as of 2026-10-20: the gate has not passed, so the digest runs on Dev only; `DIGEST_ENABLED` is unset on Prod ([docs/feature-map.md](docs/feature-map.md#deployed-configuration)).

## Cost {#cost}

| Item | Value | Source |
| --- | --- | --- |
| Daily cap | 5,000 estimated neurons per UTC day (Dev and Prod) | [estimate.ts](packages/reference-pipeline/src/digest/estimate.ts) |
| Estimate | price table × 1.28, calibrated against the tokens Workers AI reported | [Spec 014](docs/specs/014-topic-digest/spec.md) |
| Last Dev run | 29 model calls, 1,637 estimated neurons, 99 s (2026-10-19 22:47 UTC) | Dev `/health` |
| Gateway | 60 requests an hour, $2 a month; a refused call ends the run as `limited` | [runbook](docs/runbooks/cloudflare-data-publisher.md) |

Caches keyed by input and revision mean an unchanged thread is neither classified nor summarised again; changing a prompt invalidates them, so the next run costs close to a cold run.
