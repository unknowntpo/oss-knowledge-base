# ADR-0016: Run the review queue as its own cron job and declare governance in profiles

- Status: Accepted
- Date: 2026-10-08
- Spec: Spec 015 (review queue for PRs and KIPs)
- Related: ADR-0012 (independent data crons), ADR-0014 (per-source publication), Spec 014 (profiles, cron dispatch)

## Context

Maintainers want to see what is waiting for review: open PRs without a
reviewer, PRs waiting on reviewers, approved PRs, KIP votes short of quorum,
and KIP discussions with few repliers.

The data the product has cannot answer this:

- The GitHub connector reads only recently updated issues. The Feed has 337
  open Kafka PRs; GitHub has 625.
- It does not read requested reviewers or reviews. Doing that per PR in the
  hourly publication alarm costs 632 requests, about 10.6 MB, and about 5.7
  min. That alarm already took about 12 of its 15 minutes on a heavy run.
- dev@ retention starts 2026-09-07, and messages keep only a 200-character
  preview. Vote counts and replier counts from that data are wrong.

Whether a vote is binding depends on the community's governance. In Kafka,
active committers are binding on technical decisions and PMC members on
releases (https://cwiki.apache.org/confluence/display/KAFKA/Bylaws); a KIP is
accepted by lazy majority after a vote open at least 72 hours
(https://cwiki.apache.org/confluence/display/KAFKA/Kafka+Improvement+Proposals). Other communities
have other rules and rosters.

## Decision

- **A separate job.** A third cron on the data Worker (Dev `27 * * * *`, Prod
  `57 * * * *`), dispatched by `controller.cron` like Spec 014's digest, runs
  `runReviewQueue(projectId)`. There is no Durable Object: the run takes about
  1–3 minutes each hour. The publication alarm is unchanged.
- **Sources.**
  - GitHub GraphQL: one query per 100 open PRs (7 requests, 306 KB). It uses
    the existing `GITHUB_SOURCE_TOKEN`.
  - Pony Mail: `thread.lua` for each KIP candidate thread, and `email.lua`
    bodies for vote threads only, cached by message id.
  - Candidates come from the pinned Feed release (no second dev@ crawl).
- **Objects.**
  - `public/review-queue/v1/<projectId>/<contentHash>.json`, written first.
  - Then `current.json`, by a put conditional on its ETag.
  - Then `last-run.json`.
  - The roster is the internal object
    `internal/rosters/v1/<adapter>/<project>.json`, refreshed daily.
  - Readers: `GET /api/review-queue?projectId=`, the route
    `/#/review/<projectId>`, and the next run.
- **Governance is profile data plus adapters, not a rule language.**
  - A profile has `governance: { roster: {adapter, project}, votes: [{kind,
    quorum, rule, minOpenHours, bindingRole}] }`.
  - `rule` is an enum (`lazy-majority`), and `bindingRole` is `committer` or
    `pmc`.
  - New mechanisms are added as code behind an interface, such as a
    `RosterAdapter`, never as expressions in a profile.
- **ASF preset.** `asfPreset({project, devList})` gives the shared ASF
  conventions: Pony Mail dev@, Jira, the `asf` roster adapter (whimsy public
  LDAP JSON), `[VOTE]`/`[DISCUSS]`/`[RESULT]` subject tags, and the vote kinds
  proposal (committer) and release (pmc). A project profile is the preset plus
  overrides.
- **Binding.**
  - A declared `(binding)` or `(non-binding)` marker wins.
  - Otherwise a vote is binding when the voter's name exactly matches a roster
    entry with the vote kind's role.
  - Without a roster, only declared markers count, and counts are shown as
    lower bounds ("binding ≥ m").
  - A lower-bound tally never yields a passing, contested, or pending-close
    state; it is short or unresolved, and queued.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| REST reviews per PR, or the GraphQL snapshot, inside the publication alarm | Wall-time risk; a GitHub outage would then affect publication. |
| A Durable Object for the job | Its state, alarm, and lease are not needed for a 1–3-minute hourly run. A conditional pointer write covers overlap. |
| GitHub search counts or Kafka's `triage` labels | Counts only, or Kafka-only, and they disagree with the buckets. |
| PMC roster for KIP votes | Wrong for Kafka: active committers are binding on technical decisions. |
| A rule expression language in profiles | Untestable in general. Enums plus adapters keep every rule in tested code. |
| `committee-info.json` (PMC only) or the kafka-site committer list | The first has no committers. The second has no ids, uses different spellings, and neither marks emeritus. |

## Consequences

- New upstream reads: GitHub GraphQL; Pony Mail `thread.lua` and `email.lua`;
  whimsy `public_ldap_projects.json` and `public_ldap_people.json` (daily).
- Emeritus committers cannot be excluded, because no public source marks
  them. An emeritus committer's unmarked +1 counts as binding, so a passing
  state can be overstated. Roster-based binding votes are labeled "via
  roster".
- A `ReviewProfile` reuses Spec 014's `proposal` and `machineUsers` and adds
  `governance`, `reviewWaitDays`, and `fewRepliers`.
- Retention (gardening G9) must cover `public/review-queue/v1/` and
  `internal/rosters/v1/`.

## Revisit when

- A non-ASF community is added: write its roster adapter and preset.
- Kafka publishes emeritus status, or a vote is wrongly counted because of
  an emeritus or misspelled name. The kafka-site committer list already
  omits exactly the 5 inactive LDAP names; intersecting with it (after
  resolving 7 spellings) is the first option.
- The run's wall time passes 5 minutes, or GitHub GraphQL cost passes 100
  points per run.
