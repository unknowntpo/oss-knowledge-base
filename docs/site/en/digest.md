# Weekly digest

Every day the Dev environment turns the last seven days of Kafka activity into a short bilingual summary: topic cards, KIP proposals by stage, and a headline, each sentence citing the records it is based on. Language models write the text; deterministic rules decide what may be published.

## The pipeline {#flow}

{{flow:digest}}

Models run on Cloudflare Workers AI through AI Gateway (a proxy that adds rate and spend limits). The split of work is deliberate: a small, cheap classifier answers a multiple-choice question per thread; the large model writes only from the threads it was given; a third model translates. Ranking, placement and validation are plain code ([Spec 014](docs/specs/014-topic-digest/spec.md)).

## Why rules check the model {#rules}

A design review of a real week of output (the week of 2026-10-08) found sentences that claimed a pull request was merged while it was still open, and that attributed objections nobody made. Prompting alone does not prevent this, so every sentence is checked against the source records before publication, and a failing sentence is dropped rather than repaired ([validate.ts](packages/reference-pipeline/src/digest/validate.ts)):

| Rejection | What it catches |
| --- | --- |
| `length` | empty or over 240 characters |
| `no-cites`, `cite-outside-inputs` | a sentence with no citation, or citing a record the model was not given |
| `status:<word>` | "merged", "landed", "fixed" without a merged PR or resolved Jira issue; "released", "shipped" without an [ANNOUNCE]; "verified", "accepted" without a [RESULT] or [ANNOUNCE] thread |
| `stance:<word>` | "objected", "rejected", "pushed back" and similar, which overstate a discussion |
| `other-proposal` | a second KIP in a line about one proposal |
| `tense:<form>`, `tense:closed`, `tense:partial` | a completion form ("is added", "gets implemented", "now supports") when no cited item is final (a merged PR, a resolved Jira issue, a [RESULT] or [ANNOUNCE] thread); when a cited item is `closed`; or when the only final items are partial PRs (`[1/N]`) and the sentence does not say "first step" or "part k of" |

The tense rule (D97, merged in [PR #101](https://github.com/unknowntpo/oss-knowledge-base/pull/101) on 2026-10-20, running on Dev) exempts a form when a modal ("would", "will", "may", …) comes before it in the same clause, so "would be added" passes. The summarizer prompt was revised at the same time to ask for status-faithful wording (D98, `digest-prompts@4`); because the prompt revision is part of the cache key, the next Dev run (22:47 UTC) regenerates every sentence.

### Translation status guard and glossary {#translation}

- **Status guard (D99).** The Chinese status word inside the citation parentheses must match the English one (open → 仍在進行, merged → 已合併, closed → 已關閉, proposed → 已提出, discussing → 討論中, resolved → 已解決, voting → 投票中, plus listed variants). Words are matched longest first, so 投票進行中 is "voting", never "open". On a mismatch the item keeps its English text labelled "Not translated", the run counts `translate:status-drift`, and the translation is not cached, so the next run tries again; there is no retry in the same run ([translation.ts](packages/reference-pipeline/src/digest/translation.ts)).
- **Glossary (D100).** `kafka-glossary@1` fixes terms the model got wrong on Dev or that must stay stable: offloading → 卸載, telemetry → 遙測, assignor → 指派器, rebalance → 再平衡; share group and KRaft stay in English. The glossary revision is part of the translation cache key ([profiles.ts](packages/reference-pipeline/src/digest/profiles.ts)).

## Quality gate before Prod {#gate}

The digest reaches Prod only after a human labels one real week and the evaluation meets the thresholds ([Spec 014](docs/specs/014-topic-digest/spec.md), Behavior 31).

- **Error classes** for English sentences: `status-mismatch`, `misattribution`, `invented-claim`, `overbroad-stance`.
- **Translation error classes** (D101): `status-drift`, `term-error`, `omission`; a labelled sentence can carry them, and `eval` also runs the status guard over every translated sentence.
- **Fixed thresholds:** zero `status-mismatch` and zero `overbroad-stance`. Thresholds for the other two classes and for recall of important threads (an example in the spec is recall ≥ 0.8) are the owner's to set.
- **Translation thresholds (D102, decided by the owner on 2026-10-20):** `status-drift` 0, `omission` 0, `term-error` at most 2 per labelled week; a labels file may override them.
- **Golden set:** a labels file in the repository; today it holds the five negatives from the 2026-10-08 review and no important-thread labels yet ([topic-digest-labels.v0.json](packages/reference-pipeline/test/fixtures/topic-digest-labels.v0.json)).
- **Evaluation:** `bun run digest -- eval` (offline, no network) reports kept and dropped sentences by reason, whether every labelled error was rejected, and recall; `bun run digest -- measure` fails when a run would exceed its neuron, call or read limits ([scripts/digest.ts](packages/reference-pipeline/scripts/digest.ts), [eval.ts](packages/reference-pipeline/src/digest/eval.ts)).

Status as of 2026-10-20: the gate has not passed, so the digest runs on Dev only; `DIGEST_ENABLED` is unset on Prod ([docs/feature-map.md](docs/feature-map.md#deployed-configuration)).

## Known limitations {#limits}

- The tense rule only knows the listed forms: "X lands" or "X is in trunk" is not caught; the golden set is the backstop.
- The status guard compares the set of statuses, not which status belongs to which citation, so swapped statuses for two items pass; the `status-drift` label catches them.
- The older status-word rule also drops modal sentences such as "would be released" ([issue #104](https://github.com/unknowntpo/oss-knowledge-base/issues/104), open).
- Known false positive ([issue #104](https://github.com/unknowntpo/oss-knowledge-base/issues/104)): a sentence starting "Now <noun>", such as "Now logs are structured", matches `now logs`, because several of the listed verbs are also nouns.
- On the Dev week of 2026-10-20 the tense rule dropped 5 card and proposal sentences and 1 highlight, all stating unfinished work as done; both recorded weeks are committed test fixtures, so the rule's precision is reproducible offline ([Spec 014](docs/specs/014-topic-digest/spec.md), D97).

## Cost {#cost}

| Item | Value | Source |
| --- | --- | --- |
| Daily cap | 5,000 estimated neurons per UTC day (Dev and Prod) | [estimate.ts](packages/reference-pipeline/src/digest/estimate.ts) |
| Estimate | price table × 1.28, calibrated against the tokens Workers AI reported | [Spec 014](docs/specs/014-topic-digest/spec.md) |
| Last Dev run | 29 model calls, 1,637 estimated neurons, 99 s (2026-10-19 22:47 UTC) | Dev `/health` |
| Gateway | 60 requests an hour, $2 a month; a refused call ends the run as `limited` | [runbook](docs/runbooks/cloudflare-data-publisher.md) |

Caches keyed by input and revision mean an unchanged thread is neither classified nor summarised again; changing a prompt invalidates them, so the next run costs close to a cold run. `bun run digest -- measure` puts a cold run with `digest-prompts@4` at 2,215 price-table neurons, about 2,835 estimated, within the 5,000 cap.
