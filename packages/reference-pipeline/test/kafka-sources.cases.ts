/**
 * Spec 012 test plan: the single source for the unit tests and for the table in
 * docs/specs/012-kafka-mailing-list-jira/spec.md (`bun run docs:test-plan` regenerates it).
 * Inputs are real values captured 2026-10-06 (see the spec's samples/), except rows whose
 * `input` starts with "constructed:". `now` for window rows is 2026-10-06T08:00:00Z.
 */
export const testPlanRows = [
  // K1: a dev@ message becomes one mail record; author is the display name only.
  { id: "K1", rule: "mail record", input: "mid 15rddlqk42tqsjh5rw2r6so5cgns122f, from \"Federico Valeri <fe...@gmail.com>\", subject \"Re: [VOTE] KIP-1279: Cluster Mirroring\", epoch 2026-09-18T16:06:37Z", expected: "entity kafka:mail:dev:message:15rddlqk42tqsjh5rw2r6so5cgns122f; occurredAt 2026-09-18T16:06:37.000Z; author Federico Valeri; url https://lists.apache.org/thread/15rddlqk42tqsjh5rw2r6so5cgns122f; kips KIP-1279; jiraKeys none" },
  { id: "K1", rule: "mail record", input: "constructed: from \"Jun Rao via dev <de...@kafka.apache.org>\"", expected: "author Jun Rao" },
  { id: "K1", rule: "mail record", input: "constructed: from \"<an...@outlook.com>\" (no display name)", expected: "author unknown sender (address never stored)" },
  // Key extraction: \b(KIP|KAFKA)-(\d+)\b, case-sensitive.
  { id: "K1", rule: "keys", input: "[jira] [Created] (KAFKA-21049) Async consumer can busy-loop …", expected: "jiraKeys KAFKA-21049" },
  { id: "K1", rule: "keys", input: "constructed: [DISCUSS] KIP-13680: …", expected: "kips KIP-13680 (not KIP-1368)" },
  { id: "K1", rule: "keys", input: "constructed: re: kip-1279 question", expected: "kips none" },
  // K2: notification mail duplicates a direct source and is not ingested.
  { id: "K2", rule: "mail filter", input: "[jira] [Created] (KAFKA-21049) Async consumer can busy-loop while waiting for fetch progress when retry.backoff.ms is zero", expected: "dropped" },
  { id: "K2", rule: "mail filter", input: "constructed: [PR] MINOR: Fix produce-ack race in ShareConsumerDLQTest multi-topic tests.", expected: "dropped" },
  { id: "K2", rule: "mail filter", input: "[DISCUSS] KIP-1368: Client framework name and version", expected: "kept" },
  { id: "K2", rule: "mail filter", input: "[VOTE] 4.4.0 RC3", expected: "kept" },
  { id: "K2", rule: "mail filter", input: "constructed: Re: [jira] [Created] (KAFKA-21049) Async consumer can busy-loop …", expected: "dropped" },
  { id: "K2", rule: "mail filter", input: "constructed: [JIRA] [Resolved] (KAFKA-20953) Remove hamcrest …", expected: "dropped" },
  // K3: thread key is the normalized subject.
  { id: "K3", rule: "thread key", input: "[VOTE] KIP-1279: Cluster Mirroring", expected: "[vote] kip-1279: cluster mirroring" },
  { id: "K3", rule: "thread key", input: "Re: [VOTE] KIP-1279: Cluster Mirroring", expected: "[vote] kip-1279: cluster mirroring" },
  { id: "K3", rule: "thread key", input: "constructed: RE: Fwd:  Re: [VOTE]  KIP-1279: Cluster Mirroring", expected: "[vote] kip-1279: cluster mirroring" },
  { id: "K3", rule: "thread key", input: "[DISCUSS] KIP-1279: Cluster Mirroring", expected: "[discuss] kip-1279: cluster mirroring" },
  { id: "K3", rule: "thread key", input: "constructed: [RESULT] [VOTE] KIP-1279: Cluster Mirroring", expected: "[result] [vote] kip-1279: cluster mirroring (separate thread)" },
  // K4: a KAFKA issue becomes one Jira record.
  { id: "K4", rule: "jira record", input: "KAFKA-20186 \"Cluster Mirroring\", In Progress, description \"…tracks the development of KIP-1279: …\"", expected: "title KAFKA-20186: Cluster Mirroring; status open; kips KIP-1279" },
  { id: "K4", rule: "jira record", input: "KAFKA-20810, Open, description \"…/pages/440304679/KIP-1368+Client+framework…\"", expected: "status open; kips KIP-1368" },
  { id: "K4", rule: "jira record", input: "KAFKA-20184, Patch Available, no KIP in summary or description", expected: "status open; kips none" },
  { id: "K4", rule: "jira time", input: "updated 2026-09-29T20:24:00.702+0000", expected: "cursor and occurredAt 2026-09-29T20:24:00.702Z" },
  { id: "K4", rule: "jira record", input: "KAFKA-20184 comment by loicgreffier, updated 2026-09-29T20:24:00.702+0000", expected: "entity kafka:jira:issue:KAFKA-20184:comment:<id>; url …/browse/KAFKA-20184?focusedCommentId=<id>" },
  { id: "K4", rule: "jira status", input: "Resolved", expected: "resolved" },
  { id: "K4", rule: "jira status", input: "Closed", expected: "resolved" },
  { id: "K4", rule: "jira status", input: "Reopened", expected: "open" },
  { id: "K4", rule: "jira status", input: "constructed: Triage Needed (unknown name)", expected: "open" },
  // K5: a Jira issue is published only when something links to it.
  { id: "K5", rule: "jira publish", input: "KAFKA-20184; retained PR #21518 \"KAFKA-20184: Remove static jose4j references from DefaultJwtValidator\"", expected: "published" },
  { id: "K5", rule: "jira publish", input: "KAFKA-20186; kips KIP-1279; retained dev@ thread \"[VOTE] KIP-1279: Cluster Mirroring\"; no PR", expected: "published" },
  { id: "K5", rule: "jira publish", input: "constructed: KAFKA-20186; kips KIP-1279; no retained dev@ subject names KIP-1279; no PR", expected: "not published" },
  { id: "K5", rule: "jira publish", input: "constructed: KAFKA-20184; retained dev@ subject \"Re: KAFKA-20184 jose4j at runtime\"", expected: "published" },
  { id: "K5", rule: "jira publish", input: "constructed: KAFKA-20292; retained PR \"WIP: KAFKA-20292: …\" (key mid-title)", expected: "published" },
  { id: "K5", rule: "jira publish", input: "constructed: KAFKA-20292; only PR title cites KAFKA-202920", expected: "not published" },
  { id: "K5", rule: "jira publish", input: "KAFKA-21227 \"Speed up ColdStartStickinessIntegrationTest\"; no PR, mail subject, or KIP cites it", expected: "not published" },
  { id: "K5", rule: "jira publish", input: "constructed: KAFKA-21227; retained PR \"KAFKA-21227: Speed up ColdStartStickinessIntegrationTest\"", expected: "published" },
  // K9: first run backfills exactly 30 days.
  { id: "K9", rule: "backfill window", input: "message epoch 2026-09-06T08:00:00Z (now − 30 d)", expected: "ingested" },
  { id: "K9", rule: "backfill window", input: "message epoch 2026-09-06T07:59:59Z (now − 30 d − 1 s)", expected: "not ingested" },
  { id: "K9", rule: "backfill window", input: "no Jira cursor", expected: "JQL updated >= \"-43200m\"" },
  { id: "K9", rule: "backfill window", input: "no mail cursor", expected: "d=lte=30d" },
  // K10: incremental windows overlap the cursor and are capped at 30 days.
  { id: "K10", rule: "jira window", input: "cursor 60 min before now", expected: "updated >= \"-70m\"; gap capped no" },
  { id: "K10", rule: "jira window", input: "cursor 3 d before now", expected: "updated >= \"-4330m\"; gap capped no" },
  { id: "K10", rule: "jira window", input: "cursor 29 d 23 h 50 min before now", expected: "updated >= \"-43200m\"; gap capped no" },
  { id: "K10", rule: "jira window", input: "cursor 29 d 23 h 51 min before now", expected: "updated >= \"-43200m\"; gap capped no" },
  { id: "K10", rule: "jira window", input: "cursor exactly 30 d before now", expected: "updated >= \"-43200m\"; gap capped no" },
  { id: "K10", rule: "jira window", input: "cursor 30 d 1 min before now", expected: "updated >= \"-43200m\"; gap capped yes" },
  { id: "K10", rule: "jira window", input: "cursor 40 d before now", expected: "updated >= \"-43200m\"; gap capped yes" },
  { id: "K10", rule: "mail window", input: "cursor 1 h before now", expected: "d=lte=2d; gap capped no" },
  { id: "K10", rule: "mail window", input: "cursor exactly 1 d before now", expected: "d=lte=2d; gap capped no" },
  { id: "K10", rule: "mail window", input: "cursor 1 d 1 s before now", expected: "d=lte=3d; gap capped no" },
  { id: "K10", rule: "mail window", input: "cursor 29 d 1 s before now", expected: "d=lte=30d; gap capped no" },
  { id: "K10", rule: "mail window", input: "cursor 30 d 1 s before now", expected: "d=lte=30d; gap capped yes" },
  { id: "K10", rule: "mail window", input: "constructed: cursor 1 h after now (misdated mail)", expected: "d=lte=2d; gap capped no" },
  { id: "K10", rule: "mail window", input: "cursor 40 d before now", expected: "d=lte=30d; gap capped yes" },
  // Failure rows.
  { id: "K12", rule: "retry", input: "constructed: Jira 429 with Retry-After: 30, then 200", expected: "one retry after 30 s; ok" },
  { id: "K12", rule: "retry", input: "constructed: Jira 429 with Retry-After: 120", expected: "no retry; source failed (rate-limit, retry after 120 s); cursor unchanged" },
  { id: "K12", rule: "retry", input: "constructed: Pony Mail 503, then 503", expected: "one retry; source failed (transport); cursor unchanged" },
    { id: "K13", rule: "malformed mail", input: "constructed: message without epoch", expected: "skipped, counted" },
  { id: "K13", rule: "malformed mail", input: "constructed: message with subject null", expected: "skipped, counted" },
  { id: "K13", rule: "malformed mail", input: "constructed: message without mid", expected: "skipped, counted" },
  { id: "K13", rule: "misdated mail", input: "constructed: epoch 2 d after now", expected: "skipped, counted; cursor unchanged" },
  { id: "K13", rule: "misdated mail", input: "constructed: epoch 59 min after now", expected: "ingested; cursor = now" },
  { id: "K14", rule: "malformed jira", input: "constructed: issue without fields.updated", expected: "skipped, counted; cursor = newest valid updated" },
  { id: "K14", rule: "malformed jira", input: "constructed: issue without key", expected: "skipped, counted" },
  { id: "K15", rule: "duplicate", input: "same mid 15rddlqk42tqsjh5rw2r6so5cgns122f in two overlapping windows", expected: "one event" },
  { id: "K15", rule: "conflict", input: "constructed: same mid and epoch, different preview text", expected: "first stored event kept; conflict counted; run not failed" },
  { id: "K20", rule: "truncated mail", input: "constructed: hits 500, emails 499", expected: "source failed (truncated); cursor unchanged" },
  { id: "K20", rule: "truncated mail", input: "hits 500, emails 500 (captured 28-day window)", expected: "ok, 500 read" },
  { id: "K21", rule: "schema", input: "constructed: Pony Mail 200 without emails array", expected: "source failed (schema)" },
  { id: "K21", rule: "schema", input: "constructed: Pony Mail 200 with emails []", expected: "ok, 0 read" },
  { id: "K22", rule: "schema", input: "Jira 200 text/html (login page, as /rest/api/3/search returns)", expected: "source failed (schema)" },
  { id: "K22", rule: "size", input: "Jira page 671 KB (captured 100 issues, 2026-10-06)", expected: "ok" },
  { id: "K22", rule: "size", input: "constructed: response body 4 MB + 1 byte", expected: "source failed (too-large); cursor unchanged" },
] as const;
