# Spec 038: Data samples on the system flow, the system map and the feature map

Status: Draft (owner review of decisions D1–D3 pending; no code yet)
Date: 2026-11-18
Traceability: enforced
Builds on: Spec 033 (system map, `{{map:system}}`, SM19 page budget, SM23 inline-script audit), Spec 025 (docs site, `{{flow:system}}`, DOC4/DOC6/DOC7 output audit, DOC20), Spec 020 (feature-map site), Spec 036 draft (personal-data policy)

## Intent

A reader of the system flow sees boxes and arrows, but not what moves along
the arrows. "R2 · People and identity" does not say that a month object holds
every person's review rows, and "People and activity" does not say that the
profile response is full row lists, not counters. The owner asked on
2026-11-18, after reviewing the Spec 037 data-flow artifact, that data-flow
pages always show example data beside the flow, because a sample makes the
shape clear.

Readers: the owner first; a verifier who checks an API or a store; later a
teammate who learns the system.

Observable outcome:

- A step of `docs/site/flows/system.json` can carry JSON samples. A step with
  samples shows a `{ }` marker. Its detail shows each sample as a labelled
  `<pre>` block with a provenance tag: `real`, `typed` or `proposed`.
- Every store, object, API response and message step has at least one sample.
- `docs/feature-map.md` has a generated section "Data samples", built from the
  same `system.json` samples. Each Web API and Publisher API row links to its
  sample there.

## Evidence

- The owner's request (2026-11-18), relayed with the `dataflow` skill change
  in `unknowntpo/agent-config` commit 29383b2: each data row gets
  `ex: [[label, value, provenance]]`, rendered as a `<pre>` with a provenance
  tag and a `{ }` node marker.
- `system.json` on `main` (d78fa34) has 63 steps in 5 columns. None carries
  data. Of these, 26 are stores, objects, responses or messages (kinds `src`
  and `r2` except the bucket step `r2-bucket`, the Durable Objects and the
  query gate, `api-*`, `health`); the rest are crons, rules and views.
- Measured 2026-11-18 with `bun run docs:build` on d78fa34: the public
  overview page, which renders `{{flow:system}}`, is 96,910 bytes (en) and
  96,355 bytes (zh-Hant). Spec 033 SM19 caps the system map page at 300 KB.
- `main` has no `dist/ops-site` yet: Spec 033 slice 3 (SM24–SM27) is pending,
  so `{{map:system}}` is built only in tests today. This spec does not depend
  on slice 3; the map shows samples once it is built anywhere.
- The Spec 020 feature-map site renders only the Deployed configuration and
  Schedules sections of `docs/feature-map.md` (`scripts/feature-map-site/generate.ts`,
  around line 680). The Web API and Publisher API tables are read on GitHub.
- `auditSite` (`scripts/docs-site/generate.ts`) skips `<script type="application/json">`
  for the SM23 URL check, but runs `SECRET_PATTERNS` and the Worker-hostname
  check (`UNADVERTISED`) on the whole page. A sample that names a
  `*.workers.dev` host or a token fails the build. That is the wanted result.
- `GET /api/feed` on Dev answered 200 with 11,799,397 bytes (captured
  2026-11-18T06:04Z). A sample must be cut to a few hundred bytes.

## Example

Captured 2026-11-18T06:04Z from `https://oss-knowledge-base-dev.pages.dev/api/feed`
(read-only, public). The step `api-feed` gets a `real` sample. Values are
copied; arrays keep one element; person values are replaced (D2); `"…"` marks
elided parts:

```json
{ "id": "api-feed", "...": "existing fields unchanged",
  "ex": [
    { "label": "GET /api/feed",
      "provenance": "real",
      "from": "https://oss-knowledge-base-dev.pages.dev/api/feed 2026-11-18T06:04Z",
      "value": {
        "generatedAt": "2026-11-17T22:07:32.254Z",
        "projects": [{ "key": "datafusion", "label": "Apache DataFusion", "sources": ["github"], "statuses": [{ "key": "open", "label": "Open" }, "…"], "…": "…" }, "…"],
        "entries": [{ "displayId": "DATAFUSION-ISSUE-24461", "projectKey": "datafusion", "status": "open", "releaseLabel": "GitHub Issue #24461", "authors": ["<login>", "…"], "tags": ["Issue"], "links": { "github": "https://github.com/apache/datafusion/issues/24461" }, "sourceCounts": { "github": 68 }, "lastActivityAt": "2026-11-16T15:54:49Z", "searchText": "…", "entry": "…" }, "…"],
        "metadata": { "servingMode": "cloudflare-pages-function-r2", "inputEventCount": 11753, "manifest": { "schema": "osskb.feed-manifest.v3", "releaseId": "2026-11-17T22-07-32-254Z", "feedIndexKey": "public/v2/releases/2026-11-17T22-07-32-254Z/feed/index.json", "detailMapKey": "…", "entryCount": 3540 }, "…": "…" } } } ] }
```

The step `r2-ptr` gets a `typed` sample. The shape is `FeedManifestV3` in
`packages/serving-contract/src/index.ts`; the values are illustrative:

```json
{ "label": "public/v2/current.json",
  "provenance": "typed",
  "from": "packages/serving-contract/src/index.ts#FeedManifestV3",
  "value": { "schema": "osskb.feed-manifest.v3", "releaseId": "2026-01-01T00-00-00-000Z", "generatedAt": "2026-01-01T00:00:00.000Z", "feedIndexKey": "public/v2/releases/2026-01-01T00-00-00-000Z/feed/index.json", "detailMapKey": "public/v2/releases/2026-01-01T00-00-00-000Z/feed/details.json", "entryCount": 0 } }
```

A step that is not built yet uses `proposed`. For example, the Spec 037 draft
summary object would carry `"provenance": "proposed"` and
`"from": "docs/specs/037-profile-summary/spec.md"` until it ships; today no
`system.json` step is a design-only step, so slice 1 has no `proposed` sample.

Rendered detail of `api-feed` (both views; label and value are not
translated):

```text
GET /api/feed   [real]  from Dev 2026-11-18T06:04Z
{ "generatedAt": "2026-11-17T22:07:32.254Z", "projects": [ … ], … }
```

The generated feature-map section, between
`<!-- samples:start docs/site/flows/system.json -->` and `<!-- samples:end -->`:

````markdown
### `GET /api/feed` {#sample-get-api-feed}

`real` · step `api-feed` · from Dev 2026-11-18T06:04Z

```json
{ "generatedAt": "2026-11-17T22:07:32.254Z", … }
```
````

The Web API row `/api/feed` then ends its "Returns" cell with
`[sample](#sample-get-api-feed)`.

## Forces (約束)

| ID | Force | Kind | Source | Conflicts with |
| --- | --- | --- | --- | --- |
| FC1 | A data-flow page shows what each store, object, response and message holds, not arrows alone. | quality | owner 2026-11-18 (Spec 037 artifact review) | FC4 |
| FC2 | One source: the flow, the map and the feature map show the same sample, so a fix in one place fixes all. | quality | feature map rule "update in the same PR" (`docs/process/workflow.md` Verification kit) | FC6 |
| FC3 | A reader can tell whether a sample is copied from a real response, taken from a type, or a design not built yet, and can find where it came from. | quality | `dataflow` skill provenance rule | — |
| FC4 | The map page stays under 300 KB per locale; one sample stays short (every field once, one element per array, `"…"` for elided parts). | hard limit | Spec 033 SM19; owner brief 2026-11-18 | FC1 |
| FC5 | A sample never holds a credential, a Worker hostname, or an R2 object read for it. Samples come from code types or public Dev API responses only. | hard limit | owner brief 2026-11-18; `auditSite` | — |
| FC6 | **Needs owner (D1).** The public overview page shows samples of internal objects (`internal/…`: people, identity, SRE records) only if the owner accepts it; the ops map is private. | assumption | Spec 033 decision 5 (map is private); repository is public | FC2 |
| FC7 | **Needs owner (D2).** A sample names no person, even though author names are public by design (Spec 036 draft, Intent). | taste | Spec 036 draft; Spec 019 privacy safeguards | FC3 (`real` is no longer an exact copy) |
| FC8 | **Needs owner (D3).** The feature map links each API row to a sample that a public reader can open. | quality | ops site is behind Cloudflare Access (Spec 033 slice 3) | FC2 |
| FC9 | A typed sample can drift when its type changes. | assumption (hypothesis: drift is rare enough to catch in review) | — | FC2 |

Problem: give each data step a short, checked JSON sample that both
`system.json` renderers and `docs/feature-map.md` show from one source,
without growing the map past 300 KB, publishing a person's name, or linking
public readers to a private page.

Solution Space:

- **Null design: prose in `lead` and `facts`.** Satisfies FC4, FC5. Fails FC1
  (the shape stays hidden) and FC3.
- **Samples pasted into feature-map table cells.** Fails FC2 (two copies) and
  FC4 for readers (a cell of JSON is unreadable).
- **Feature-map rows link to the ops map node.** Satisfies FC2. Fails FC8:
  the ops site is behind Access and is not built on `main` yet.
- **Samples in a separate `samples.json` keyed by step id.** Satisfies FC2,
  but a step and its sample are reviewed in different files and a renamed
  step orphans its sample. Rejected.
- **Chosen: optional `ex` on each `system.json` step; both renderers show it;
  `docs/feature-map.md` gets a generated "Data samples" section with one
  anchor per sample, kept in sync by a check like `check:test-plan`.**
  Satisfies FC1–FC5 and FC8 (the anchor works on GitHub, where the API tables
  are read). FC6 and FC7 are decided by D1 and D2. FC9 is accepted as a cost
  (Non-goals).

Decisions for the owner (recommendation first):

- **D1 (FC6).** Recommended: the public overview flow shows `ex` too, for every
  step. The repository is public, so the types are already public; samples
  carry no real person value (D2) and pass `auditSite`. Alternative: the
  public flow drops `ex` of steps whose label starts with `internal/`.
- **D2 (FC7).** Recommended: every person value (login, display name, email,
  account id) in any sample is the placeholder `"<login>"`, `"<name>"` or
  `"<email>"`, and a `real` sample keeps every other value as captured.
  Alternative: copy logins as captured, since they are public.
- **D3 (FC8).** Recommended: the generated section inside
  `docs/feature-map.md`, linked by anchor. Alternative: link rows to the
  public overview's step anchor (`overview.html#<step id>`); this needs D1 =
  public and sends the reader off GitHub.

## Behavior

1. **Field.** A `system.json` step may carry `ex`: a list of
   `{ label, provenance, from, value }`. `label` is the object key, file name,
   route or message name, one string, not translated. `value` is any JSON
   value. `provenance` is `real`, `typed` or `proposed`. `from` names the
   origin: for `real`, the public Dev URL and the capture time (ISO 8601,
   minutes); for `typed`, a repository path and `#` the type or encoder name;
   for `proposed`, the spec path. Needed by: FC1, FC3.
2. **Which steps.** Every step of kind `src` or `r2` except `r2-bucket` (the
   container, not an object), every Durable Object
   step (`do-*`, `gate`), every `api-*` step and `health` has at least one
   `ex` entry. Crons, rules and views may have none. Needed by: FC1.
3. **Short.** Each array in a `value` has at most one element, optionally
   followed by the string `"…"`. One sample's `JSON.stringify(value)` is at
   most 1,500 characters. The string `"…"` marks an elided value; the key
   `"…"` marks elided fields. Needed by: FC4.
4. **Origin.** A `typed` sample's `from` path exists and the file contains the
   named symbol. A `real` sample's `from` starts with
   `https://oss-knowledge-base-dev.pages.dev/api/` or names a committed test
   fixture. No sample is taken from an R2 object read. Needed by: FC3, FC5.
5. **Personal values.** Per D2. A sample's strings contain no email address
   (the `@` pattern of Spec 036), and `authors`, `login`, `name`,
   `displayName`, `reviewer`, `prAuthor` fields hold placeholders. Needed by:
   FC7.
6. **Rendering.** In `{{map:system}}` (data-flow view and list view) and in
   `{{flow:system}}` (per D1), a step with `ex` shows `{ }` after its title.
   Its detail shows, after `facts`, one block per sample: the label, the
   provenance tag, the `from` text, and the value as `<pre>` pretty-printed
   with one-space indent, where `"…"` prints as `…`. HTML is escaped. A step
   without `ex` renders as today. The map keeps the data in its existing
   `<script type="application/json" class="smap-data">`. Needed by: FC1, FC2.
7. **Feature map section.** `bun run docs:samples` writes the section "Data
   samples" in `docs/feature-map.md` between
   `<!-- samples:start docs/site/flows/system.json -->` and
   `<!-- samples:end -->`: one `###` heading per sample, ordered as in
   `system.json`, with the anchor `sample-<slug of label>`, a line with the
   provenance, the step id and `from`, and a `json` code block.
   `bun run check:samples` fails when the section differs from what
   `docs:samples` would write. Two samples whose labels give the same slug
   fail both commands. Needed by: FC2, FC8.
8. **Row links.** Each row of the Web API and Publisher API tables in
   `docs/feature-map.md` whose endpoint has a sample ends its "Returns" cell
   with `[sample](#sample-…)`. `check:samples` fails on a link to an anchor
   that the section does not have. Needed by: FC8.
9. **Build failures.** The docs build and `check:samples` fail, naming the
   step and the label, for: an unknown `provenance`, a missing `label`,
   `from` or `value`, an array with a second element that is not `"…"`, a
   sample over 1,500 characters, a `typed` `from` whose file or symbol is
   missing, or a sample that fails Behavior 5. Needed by: FC3–FC5, FC7.

## Acceptance

All items are `[pending]` until the implementation slice; that slice removes
each tag with its test.

### Behavior
- EX1: [pending] Given a step with one `typed` sample → `{{map:system}}` shows `{ }` on the step in the data-flow view and the list view, and the detail shows the label, the tag `typed`, the `from` text and a `<pre>` whose text equals the value pretty-printed with `"…"` shown as `…`. Evidence: unit test on `scripts/docs-site/system-map.ts`.
- EX2: [pending] Given the same step → `{{flow:system}}` renders the same sample in the step's detail and the `{ }` marker on the step (per D1). Evidence: unit test on `scripts/docs-site/generate.ts`.
- EX3: [pending] Given the repository → every step of Behavior 2 has at least one `ex` entry, and every sample passes Behavior 3–5. Evidence: unit test over `docs/site/flows/system.json`.
- EX4: [pending] Given `system.json` with samples → `bun run docs:samples` writes one heading per sample with anchor `sample-<slug>`, provenance, step id, `from` and a `json` block, in `system.json` order; running it twice changes nothing. Evidence: unit test on the renderer.
- EX5: [pending] Given the repository → `bun run check:samples` passes, and each Web API and Publisher API row whose endpoint has a sample links to an existing anchor. Evidence: unit test plus the CI step.

### Failure and retry
- EX6: [pending] Given a sample with `provenance: "guess"`, a missing `from`, or a non-`"…"` second array element → the docs build fails naming the step and the label. Evidence: unit test.
- EX7: [pending] Given a sample whose `JSON.stringify(value)` is 1,501 characters → the build fails naming the step, the label and the length. Evidence: unit test.
- EX8: [pending] Given a `typed` sample whose `from` file does not exist, or whose file does not contain the symbol → the build fails naming the path and the symbol. Evidence: unit test.
- EX9: [pending] Given a sample with an email address, or a login value that is not a placeholder in a person field of Behavior 5 → the build fails naming the field. Evidence: unit test.
- EX10: [pending] Given a sample with `<script>` or `</pre>` in a string → the page shows it as text (escaped) and the page parses. Evidence: unit test.
- EX11: [pending] Given `docs/feature-map.md` edited by hand inside the samples markers, or a row link `#sample-x` with no such anchor → `check:samples` fails naming the difference or the link. Evidence: unit test.
- EX12: [pending] Given a sample that names a `*.workers.dev` host or matches a `SECRET_PATTERNS` entry → `auditSite` fails the build (existing check, now covering samples). Evidence: unit test.

### Budget
- EX13: [measure] With every Behavior 2 step sampled, the built system map page and the overview page each stay under 300 KB per locale (SM19 limit). Command: `bun run docs:build`, then `wc -c` on the built pages; the measured values go in the implementation PR.

### Observability
- EX14: [measure] A missing or drifting sample is visible before deploy: `check:samples` runs in CI next to `check:test-plan`, and the docs build fails on Behavior 9. Evidence: the CI job log of the implementation PR.

## Non-goals

- FC9: no check that a `typed` sample matches its type field by field.
  Behavior 4 checks that the type exists. Revisit when a verifier or review
  finds a typed sample that disagrees with its type.
- No sample for crons, rules or views (Behavior 2).
- No rendering of samples on the Spec 020 feature-map site; the API tables
  are read on GitHub today. Revisit if the site starts rendering the Web API
  section.
- No R2 object reads to make samples, and no automatic refresh of `real`
  samples from the Dev API.
- No change to the public/private split of Spec 033 decision 5; D1 decides
  only whether the public overview shows `ex`.
