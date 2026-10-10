# Spec 001 Acceptance Scenarios

These scenarios are the executable intent for the first vertical slice. Test
fixtures must use fixed timestamps and IDs.

## A1. Cross-source thread

**Given** a KIP page, linked Jira issue, mailing-list discussion and vote, and
linked GitHub pull request
**When** their normalized events are materialized
**Then** one Decision Thread contains entries from every available source
**And** every entry exposes its canonical URL and source timestamp.

## A2. Duplicate delivery

**Given** the same event is delivered more than once
**When** the materializer processes all deliveries
**Then** the event and its timeline entry appear exactly once.

## A3. Out-of-order delivery

**Given** a later message arrives before an earlier message
**When** both have been processed
**Then** the timeline is ordered by source time and stable event-ID tie-breaker
regardless of arrival order.

## A4. Deterministic replay

**Given** a fixed event set, schema version, and materializer version
**When** state is discarded and the event set is replayed twice
**Then** both current views are logically identical
**And** any serialized golden representation is byte-identical after canonical
sorting.

## A5. Missing source

**Given** Jira is unavailable while other sources are available
**When** the KIP is refreshed
**Then** existing evidence remains browsable
**And** Jira is marked stale or unavailable
**And** the system does not invent Jira content or delete the last known value.

## A6. Explicit versus inferred links

**Given** one pull request explicitly names `KIP-500` and another is only
semantically similar
**When** linking runs
**Then** the explicit pull request enters the accepted graph
**And** the similar pull request remains a provenance-bearing suggestion until
reviewed.

## A7. Contributor identity safety

**Given** the same display name appears in GitHub and the mailing list without
authoritative matching evidence
**When** identities are resolved
**Then** they remain separate SourceIdentity records
**And** the UI does not claim they are the same contributor.

## A8. LLM-disabled operation

**Given** no model credentials or LLM service are available
**When** a user opens a Decision Thread
**Then** all deterministic entries, relationships, and source links render
**And** the generated overview is clearly unavailable without breaking the
page.

## A9. Cited generated claims

**Given** an overview is generated
**When** it claims that an alternative was rejected or a vote passed
**Then** the claim contains one or more supporting entity/message IDs
**And** those IDs resolve to evidence included in the recorded input set
**And** model and prompt versions are visible in generation metadata.

## A10. Project-neutral core

**Given** a fixture uses a second project ID, project-scoped source instances,
and project-specific artifact and status mappings
**When** its already-normalized events are materialized
**Then** the core timeline code processes them without Kafka-specific branches
**And** only source and status facets declared by that project's profile are
exposed.

## A11. Visual continuity without legacy coupling

**Given** a representative Decision Thread rendered at agreed desktop and
mobile breakpoints
**When** it is reviewed beside the legacy viewer reference screens
**Then** it retains the recognizable typography, palette, spacing rhythm, and
content-first character
**And** the page does not depend on legacy `Kip`, vault parser, generated JSON,
or route contracts.

## A12. GitHub-only project status

**Given** a project profile declares one GitHub source instance, no Jira,
mailing-list, or proposal-wiki source, and selects
`github-pull-request-status@1`
**And** a pull request has a merge event
**When** its topic and filter facets are materialized
**Then** the topic has the project-owned `merged` status with the merge event as
evidence
**And** the UI exposes only the GitHub source and that profile's statuses
**And** switching from another project clears source and status selections that
are not valid in the GitHub-only profile.

## A13. Unbreakable upstream text on a phone

**Given** a Feed entry whose record title, excerpt, author, tags or summary
holds text with no break opportunity: a URL, a class name, a config key, a
file path or a long identifier (reported on Dev from an iPhone, 390 px wide,
zh-Hant: `KAFKA-PR-22458`, excerpt `Ref : https://issues.apache.org/jira/browse/KAFKA 13152 Kip 770 : https://cwiki.apache.org/confluence/pages/viewpage.action?pageId=186878390 This PR continues PR #20292 …`)
**When** the detail page, or any other view that renders that text (Feed
cards and tag filters, Search results, Search detail, This week, Proposals,
Topic page), is opened at 375 px or 390 px wide in `en` or `zh-Hant`
**Then** every character of that text is drawn inside its card or column
**And** the page does not scroll sideways
**And** a page without such text renders as before, at 375 px and at 1280 px.

Clamped text stays clamped (Search result summary 3 lines, evidence excerpt 4
lines). Fixed-vocabulary badges and generated ids stay on one line
(`.status-badge`, `.source-badge`, `.stage-badge`, `.cite`, `.card-project`,
`.tl-time`).

Evidence: `apps/web/e2e/long-text.spec.ts` (`A13:`; one row per selector, the
text appended to the local API responses in the browser). The last clause was
checked once, not by a test: `bun run verify:ui` captures of every view on the
unchanged fixtures, before and after the change, at 375 px and 1280 px in both
locales, report the same element boxes. Not covered: WebKit (the E2E suite
runs Chromium only; gardening G39).

## Release gate

Spec 001 is complete only when A1-A13 are automated or have a documented,
repeatable verification command with captured evidence. A11 may use captured
reference screenshots plus browser checks. A demo without replay, LLM-off, and
provenance checks does not satisfy the spec.
