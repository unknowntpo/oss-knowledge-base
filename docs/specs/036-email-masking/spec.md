# Spec 036: De-identification policy and email masking at ingestion

Status: Draft
Date: 2026-11-16
Traceability: enforced
Builds on: Spec 012 (dev@ and Jira connectors; the Privacy row), Spec 019
amendment (7) (Jira accounts keep only `key` and `displayName`), ADR-0014
(a re-observed event with different content keeps the stored one), Spec 014
D95 (runtime error-text redaction), `scripts/verify/redact-artifacts.ts`
(CI evidence redaction)

## Intent

The owner can state, and show in code, how OSS KB handles personal data:
which fields count as personal data, what is kept, what is masked, and why.
The concrete rule is narrow: an email address inside mail or Jira text is
masked when the event is built, so no published output, search index or
model prompt receives it.

Honesty boundary. Every source is public. dev@kafka.apache.org is a public
archive, Jira KAFKA is public, and author names are public by design
(Spec 012). This spec does not protect secret data, and it must not be
described that way. It does two things:

1. It writes down a processing policy, so the choices are explicit and
   reviewable.
2. It stops OSS KB from republishing more than the source's own JSON
   publishes: Pony Mail already obfuscates the `from` address, so OSS KB
   applies the same form to addresses in the text.

Observable outcome: for every mail and Jira event built after the rule
ships, `subject`, `title` and `excerpt` contain no unmasked email address,
and `sourceConnectorVersion` names the rule version.

## Evidence

Captured 2026-11-16 with read-only public calls (no R2 read):

- Pony Mail `stats.lua?list=dev&domain=kafka.apache.org&d=lte=30d` returned
  545 messages. The `from` field is obfuscated (`fe...@gmail.com`). The
  `body` preview (at most 203 characters; OSS KB keeps 200 as `excerpt`) is
  **not** obfuscated: 27 of 545 previews contain an address, 28 addresses in
  all (17 personal addresses, 11 `dev@kafka.apache.org`), 0 in the
  obfuscated form. The usual carrier is a reply's quote header
  (`On <date>, <name> <address> wrote:`).
  So the background claim "Pony Mail JSON already masks email" holds for
  `from` only.
- Jira: an address appears as wiki markup
  `[address|mailto:address]`. `jiraPlainText`
  (`packages/reference-pipeline/src/kafka-events.ts`) turns it into the bare
  address, so it reaches `excerpt`. JQL `project = KAFKA AND text ~ "mailto"`
  matched 32 issues; the newest updated 2026-07-19 (KAFKA-17939). Jira is
  rarer than mail, but the code path is the same.
- Jira accounts: `emailAddress` is null for anonymous requests, and Spec 019
  amendment (7) already keeps only `key` and `displayName`. No change.
- `mailAuthor` (`packages/reference-pipeline/src/kafka-rules.ts`) already
  maps a bare or obfuscated address in `from` to `unknown sender`. No change.
- GitHub (outside this spec's sources, see O1): PR bodies carry
  `Reviewers: <name> <address>` trailers. Committed fixtures
  `apps/web/test/fixtures/recorded-feed-publication.v1.json` and
  `packages/search/test/fixtures/real-corpus-snapshot.v1.json` contain such
  full addresses.

## Policy

| Field (source) | Personal data? | Decision | Why |
| --- | --- | --- | --- |
| Author display name (mail `from` name, Jira `displayName`, GitHub login) | Yes, public by design | Keep | Attribution is the product (feed, people pages). Sources publish it on purpose. |
| Sender address (mail `from`) | Yes | Drop (already) | `mailAuthor` keeps only the name. Pony Mail obfuscates it too. |
| Jira account fields other than `key`, `displayName` (`emailAddress`, `name`, `timeZone`, avatars) | Yes | Drop (already) | Spec 019 amendment (7). |
| Email address inside text (mail `subject`, `excerpt`; Jira `title`, `excerpt`; review-queue vote lines) | Yes | **Mask (this spec)** | Not needed by any reader or feature. The source JSON itself masks the sender address. |
| Jira account `key`, GitHub numeric id | Pseudonymous id | Keep | Identity links (Spec 019) need a stable key. |
| Phone numbers, postal addresses, other identifiers in text | Possibly | Not handled (non-goal) | Not observed in the captures. A regex for them has high false-positive cost. Revisit when one is observed. |
| Secrets (Access tokens, API keys) | Not personal data | Existing gates | `redact-artifacts.ts` (CI evidence) and `redactRecord` (Worker bodies). This spec does not change them. |

The policy applies to data OSS KB builds. It does not delete or rewrite the
upstream archives, and it does not make OSS KB a source of record.

## Example

Pony Mail message `k4b8v6d5l1bck72ft9l5zph2`, 2026-10-27T13:55:43Z, subject
`Re: [DISCUSS] Apache Kafka 3.9.3 release`. Its `body` preview contains, at
offset 160:

```text
> On 25 Oct 2026, at 13:19, Chia-Ping Tsai <chia7712@gmail.com> wrote:
```

Today `mailEventFrom` keeps that text in `excerpt` (offset 160 < 200), and
the feed, search and digest prompt receive it. With this spec the excerpt
reads:

```text
> On 25 Oct 2026, at 13:19, Chia-Ping Tsai <ch...@gmail.com> wrote:
```

and the event has `sourceConnectorVersion: "ponymail@2"`. The `from`
handling is unchanged: `author` is the name only.

Jira KAFKA-17939, comment 17944566 (2025-04-15), raw body:
`[mjsax@apache.org|mailto:mjsax@apache.org]`. `jiraPlainText` gives
`mjsax@apache.org`; the mask gives `mj...@apache.org`, with
`sourceConnectorVersion: "jira@2"`. (This comment is older than the 30-day
comment window, so the connector would not read it today; it shows the
form.)

Already masked input is unchanged: `fe...@gmail.com` stays
`fe...@gmail.com`.

## Behavior

1. `maskEmailAddresses(text)` in `packages/reference-pipeline/src/kafka-rules.ts`
   finds each address `<local>@<domain>`: `local` is 1+ characters of
   `[A-Za-z0-9._%+-]`, `domain` is two or more dot-separated labels of
   `[A-Za-z0-9-]`, and the last label is 2+ letters. It replaces `local`
   with its first two characters (one if `local` has one) followed by
   `...`, and keeps `@<domain>`. This is the form Pony Mail uses for `from`.
   - Who needs the domain: a reader can still see `apache.org` versus a
     company domain, which the source already shows in `from`.
   - No allowlist: `dev@kafka.apache.org` becomes `de...@kafka.apache.org`.
     An exception list must name a reader who needs the full list address;
     none is known.
2. The rule is idempotent. A `local` that already ends with `...` is left
   unchanged, so `mask(mask(x)) = mask(x)`.
3. The pattern has no nested quantifiers. Its run time is linear in the text
   length.
4. `mailEventFrom` applies the mask to `subject` and to the body before
   `clip`. `jiraEventsFrom` applies it to `summary` and to the output of
   `jiraPlainText` (after `mailto:` links become plain text), before `clip`,
   for issues and comments. Masking before `clip` means a cut never leaves
   half an address unmasked.
5. KIP and issue-key extraction (`extractKeys`) keeps reading the unmasked
   text, as today. So masking cannot change `kips` or `issueKeys`. DI8
   checks this on the fixtures.
6. Review-queue vote parsing (`parseVoteLines`,
   `packages/reference-pipeline/src/review-queue/votes.ts`) masks each kept
   `line` and `unclear` entry, because they come from the full `email.lua`
   body.
7. Rule version. The connector revisions change from `ponymail@1` to
   `ponymail@2` and from `jira@1` to `jira@2`. The event's existing
   `sourceConnectorVersion` field records it. This table is the mapping:

   | `sourceConnectorVersion` | Text rule |
   | --- | --- |
   | `ponymail@1`, `jira@1` | none |
   | `ponymail@2`, `jira@2` | `email-mask@1` (Behavior 1–4) |

   Rejected: a new `textRule` field in event data. It would change a data
   contract that other jobs read, for information the existing field can
   carry.
8. Stored events. ADR-0014 keeps a stored event when a re-observed one with
   the same identity has different content. So events stored before the
   rule ships keep their unmasked text, and each re-observation in the
   overlap window counts as one `conflicts` in `/health` (expected, not a
   failure). See O2 for how those stored events are handled.
9. `maskEmailAddresses` lives next to `mailAuthor` in `kafka-rules.ts`, not
   in `redact.ts` or `redact-artifacts.ts`. Those two remove secrets from
   evidence and error text. This one transforms source text. Different
   inputs, different owners.

## Acceptance

### Behavior
- DI1: [pending] Given a mail fixture whose `body` contains
  `Alice Example <alice.example@example.org> wrote:` → `mailEventFrom` →
  `excerpt` contains `al...@example.org` and no string matching the address
  pattern without `...` → unit test.
- DI2: [pending] Given a mail fixture whose `subject` contains an address →
  `mailEventFrom` → `subject` is masked → unit test.
- DI3: [pending] Given a Jira issue fixture whose description and one
  comment contain `[bob@example.org|mailto:bob@example.org]` and whose
  summary contains an address → `jiraEventsFrom` → `title` and every
  `excerpt` contain `bo...@example.org` and no unmasked address → unit test.
- DI4: [pending] Given an address at offsets 190–215 of a 260-character
  body → `mailEventFrom` → the 200-character excerpt contains no unmasked
  address prefix (masking happened before `clip`) → unit test.
- DI5: [pending] Given the case-file rows (one-character local part,
  `+` tag, subdomain, uppercase, address in `<…>`, address followed by `.`
  or `,`, already masked `fe...@gmail.com`, `dev@kafka.apache.org`) →
  `maskEmailAddresses` → each row's expected output → `test.each` over
  `packages/reference-pipeline/test/email-mask.cases.ts`.
- DI6: [pending] Given text with no address (`KIP-1390`, `a @ b`,
  `user@localhost`, `@here`) → `maskEmailAddresses` → output equals input →
  unit test (case file rows).
- DI7: [pending] Given every row of DI5 and DI6 → `maskEmailAddresses`
  applied twice → equals applied once → unit test.
- DI8: [pending] Given the mail and Jira fixtures of DI1–DI3 → build events
  → `kips` and `issueKeys` equal those built without masking → unit test.
- DI9: [pending] Given a vote email body with `+1 (binding) carol@example.org`
  and an unclear line containing an address → `parseVoteLines` → kept
  `line` and `unclear` entries are masked → unit test.
- DI10: [pending] Given events built by the connectors → read
  `sourceConnectorVersion` → `ponymail@2` for mail and `jira@2` for Jira →
  unit test.
- DI11: [pending] Given the existing fixture
  `packages/reference-pipeline/test/fixtures/kafka-sources.v1.json` plus the
  DI1–DI3 fixtures run through the reference pipeline → materialize the feed,
  search corpus and digest candidates → no output string matches the
  unmasked-address pattern → integration test (the "fixture has email,
  output has none" check).

### Failure and retry
- DI12: [pending] Given a stored mail event built with `ponymail@1` and the
  same message re-observed with `ponymail@2` → `appendKeepingStored` → the
  stored event is kept, `conflicts` is 1, the run succeeds → unit test.
- DI13: [pending] Given a non-string `body`, `summary` or comment `body` →
  build events → same fallback text as today, no throw → unit test.
- DI14: [pending] Given a 100,000-character text of repeated
  `a.a.a.a@` without a valid domain → `maskEmailAddresses` → returns in
  under 50 ms in the unit test (no catastrophic backtracking) → unit test.

### Budget
- DI15: [measure] CPU added per publication run: mask 545 mail previews
  and 200 Jira issues with their comments (the largest 30-day window).
  Limit: under 5 ms in total. Command (added in the implementation PR):
  `bun packages/reference-pipeline/scripts/measure-email-mask.ts`.
  No new request, R2 operation or neuron.

### Observability
- DI16: [deploy] After the first Dev run on the implementation commit,
  `/health` for `kafka:mail:dev` and `kafka:jira` shows the run succeeded;
  `conflicts` may be above 0 for up to one window (Behavior 8). Evidence:
  the `/health` values and the commit.
- DI17: [deploy] After that run, `bun run verify:health --target dev`
  passes, and a read of `/api/feed` and `/api/search` for records built in
  that run finds no unmasked address. Evidence: the command output with the
  match count, never the matched values.

## Open decisions for the owner

- O1: GitHub text. PR and issue bodies carry `Reviewers:` trailers with full
  addresses. Recommendation: apply the same function to the GitHub event
  `title` and `excerpt` in the same implementation PR, with its own
  acceptance items. It is the largest observed carrier. Alternative: a
  follow-up spec. This spec's acceptance items do not cover GitHub until
  the owner decides.
- O2: Events stored before the rule. Options:
  (a) also apply `maskEmailAddresses` where public outputs read event text
  (materializer `textPreview`, search corpus, digest candidates, people
  activity). It is idempotent and needs no state migration, but it is a
  second call site.
  (b) a one-time rewrite of the stored event log. One call site, but it
  changes persisted state (core, hard to reverse).
  (c) accept that old text stays until it leaves the published windows.
  Recommendation: (a). It covers history and any future source that forgets
  the ingestion mask.
- O3: Committed test fixtures with real public addresses (Evidence, last
  item). Recommendation: leave them. They are copies of public data, and
  rewriting recorded fixtures breaks their provenance. New fixtures for
  this spec use `example.org` addresses (RFC 2606).

## Non-goals

- Protecting secret or non-public data. There is none in these sources.
- Removing or pseudonymizing author names. They are public and are the
  product.
- Detecting phone numbers, postal addresses or national identifiers.
- Masking the upstream archives or links to them. A Pony Mail or Jira link
  opens the source, which shows what the source shows.
- Changing the secret redaction gates (`redact-artifacts.ts`, `redact.ts`).
- A legal compliance claim (for example GDPR or Taiwan's Personal Data
  Protection Act). This spec is an engineering policy, not legal advice.

## Test plan

Scope (implementation PR): `packages/reference-pipeline/test/email-mask.test.ts`
reads `packages/reference-pipeline/test/email-mask.cases.ts` and calls
`maskEmailAddresses` (DI5–DI7, DI14). `kafka-sources.test.ts` calls
`mailEventFrom` and `jiraEventsFrom` on new `example.org` fixtures (DI1–DI4,
DI8, DI10, DI13) and `appendKeepingStored` (DI12). `review-queue.test.ts`
calls `parseVoteLines` (DI9). An integration test runs the reference
pipeline from fixtures to the feed, search corpus and digest candidates
(DI11). The generated table is added with the case file in that PR.
