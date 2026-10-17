# Spec 023: Design system for the web app

Status: Accepted 2026-10-17 (owner approved the design-system audit and proposal with changes); slice 1 (colour bugs, DS1–DS3) implemented; slices 2–7 not implemented
Date: 2026-10-17
Traceability: enforced
Builds on: constitution §6 (visual language), Spec 019 (contributor profile chart and area donut), gardening G89 and G92

## Intent

Readers of every page can read every label and tell every chart series
apart, including readers with red–green colour-vision deficiency; and the
next screen an agent builds picks its colours from named roles instead of
copying literals. The look stays the one constitution §6 protects: warm grey
ground, near-black top bar, IBM Plex, one indigo accent, small radii, no
gradients or heavy shadows.

## Evidence

From the design audit of `apps/web` at `979c544` (2026-10-17; WCAG 2.x
contrast, CIEDE2000, Machado 2009 CVD matrices):

- The feed-detail timeline draws white initials on no background: 1.00:1,
  invisible (`.avatar`; the legacy viewer painted a per-author colour, the
  Vue port dropped it).
- `.src-github` is defined twice; the later profile rule (accent indigo)
  wins everywhere, so the GitHub source badge on the feed-detail page looks
  like the wiki badge, while the GitHub timeline dot stays slate.
- `.card-activity` references the undefined `var(--muted)`, and no template
  uses it; `--muted-2` is defined and never used.
- Reviews received in the profile chart use a hover-border token, 1.78:1 on
  white; the unrecorded hatch is 1.40:1 on its base; the area palette has
  pairs at ΔE00 2.7 (protan) and 3.4 (deutan).
- 25 text rules are below 4.5:1, most of them `--muted-3` (2.95:1) labels.
- Feed and digest pages use two badge systems in which "merged" and "open"
  have different colours.

## Example

The E2E fixture's feed detail `/#/feed/KAFKA-PR-43` (one GitHub pull request
by `bob`), local build of `979c544`:

| Element | Before | After slice 1 |
| --- | --- | --- |
| Timeline avatar of `bob` | initials `B` in `#ffffff` on transparent (sits on `#ffffff`): 1.00:1 | initials on `--avatar-2` `#2b7a5b` (`authorHue("bob")` = 2): 5.20:1 |
| GitHub source badge (header and timeline) | `#3a53b0` on `#eef1fb` (same as wiki) | `#4c4959` on `#eeedf1` (slate), 7.49:1 |
| GitHub source badge in the profile header `/#/kafka/people/github:alice` | `#3a53b0` on `#eef1fb` | unchanged |

## Simplification review

1. **Question every requirement.** The avatar background: readers of the
   feed-detail timeline, who today see an empty circle. Restoring slate for
   GitHub: the source-identity encoding every page relies on. Removing dead
   rules: the agents who read the stylesheet to learn the palette.
2. **Delete.** No new avatar images or per-author colour storage: the colour
   is a hash of the author name, as in the legacy viewer. `.card-activity`
   and `--muted-2` are deleted, not repaired (PR 3 adds `--text-muted` with
   the same value as a role).
3. **Simplify.** Six avatar tokens on `:root`; the component only sets
   `data-hue`. The profile header keeps its indigo badge by scoping that rule
   to `.person-meta`.
4. **Shorten the cycle.** A static stylesheet test (no browser) checks token
   references and contrast in milliseconds; one E2E test checks the computed
   colours on the real page.
5. **Automate last.** The stylesheet test is the start of the palette gate
   that later slices extend.

## Behavior

1. Every timeline avatar has a background chosen from six `--avatar-N`
   tokens by a deterministic hash of the author name (`authorHue` in
   `apps/web/src/avatar.ts`), so the same author has the same colour on every
   page. White initials reach at least 4.5:1 on each token.
2. `.src-github` is defined once without a scope: slate `#4c4959` on
   `#eeedf1`. Only the profile header (`.person-meta .src-github`) uses the
   accent.
3. `apps/web/styles.css` references only custom properties it defines, and
   defines no custom property it never references.

## Acceptance

Each item: precondition → action → observable result → evidence.

### Behavior
- DS1: given a feed detail with a GitHub record by `bob`, when the timeline renders, the avatar has a non-transparent background from `--avatar-1..6`, chosen by `authorHue("bob")`, and its white initials measure ≥ 4.5:1 on it; every avatar token measures ≥ 4.5:1 with white → unit test over the case file, E2E computed style.
- DS2: given the stylesheet, `.src-github` has exactly one unscoped rule (slate on slate tint, ≥ 4.5:1), and on the feed-detail page the GitHub badge computes to `#4c4959` on `#eeedf1`, while the profile header's badge keeps the accent → unit test, E2E computed style.
- DS3: given `apps/web/styles.css`, every `var(--x)` names a defined custom property and every defined custom property is referenced → unit test.
- DS4: [pending] slice 2: the profile activity chart and the area donut use `--data-*` tokens only; activity series light values: reviews given fill `#7DB9DE` at 55% with stroke `#3A8FB7`, own PRs and comments fill `#91AD70` at 50% with stroke `#838A2D`, reviews received fill `#8B81C3` at 30% with stroke `#8B81C3`, unrecorded hatch line `#928e86` on `#faf9f7`; dark tokens defined for a future theme; no `--data-*` token aliases a UI-state token.
- DS5: [pending] slice 2: every data stroke or solid mark measures ≥ 3:1 on the background it is drawn on (light and dark tokens).
- DS6: [pending] slice 2: the area palette keeps min ΔE00 ≥ 10 between every pair under normal, protan and deutan simulation, ≥ 3:1 on white, contains no orange, and shares no colour with the activity chart.
- DS7: [pending] slice 3: every listed text pair (selector, foreground token, background token) measures ≥ 4.5:1, and the focus ring on the dark top bar ≥ 3:1.
- DS8: [pending] slice 4: `docs/product/design-system.md` lists the tokens, roles, rules and data-viz palettes with measured ratios, and constitution §6 links to it.
- DS9: [pending] slice 5: feed and digest badges use six semantic states (success, info, warning, progress, neutral, danger); feed "open" is info and "merged" is success.
- DS10: [pending] slice 6: no colour literal appears in `apps/web` styles or components outside the token block.
- DS11: [pending] slice 7: font sizes come from the scale (12.5px maps to 13px).

### Failure and retry
Not applicable: styles have no runtime failure path; a missing token falls
back to the property's initial value, which DS3 prevents.

### Budget
Not applicable: slice 1 adds six tokens and six one-line rules to a
stylesheet; no request, storage or runtime cost.

### Observability
Not applicable: violations are caught before merge by the stylesheet test
and the E2E computed-style checks.

## Test plan

Generated from the case file by `bun run docs:test-plan`; the unit tests run
exactly these rows.

<!-- test-plan:start apps/web/test/design-system.cases.ts -->
| id | pair | foreground | background | min | ratio |
| --- | --- | --- | --- | --- | --- |
| DS1 | avatar initials on --avatar-1 (indigo) | #ffffff | --avatar-1 | 4.5 | 6.9 |
| DS1 | avatar initials on --avatar-2 (green) | #ffffff | --avatar-2 | 4.5 | 5.2 |
| DS1 | avatar initials on --avatar-3 (rust) | #ffffff | --avatar-3 | 4.5 | 5.44 |
| DS1 | avatar initials on --avatar-4 (purple) | #ffffff | --avatar-4 | 4.5 | 7.37 |
| DS1 | avatar initials on --avatar-5 (steel blue, legacy #3f7fa0 darkened) | #ffffff | --avatar-5 | 4.5 | 4.86 |
| DS1 | avatar initials on --avatar-6 (brown) | #ffffff | --avatar-6 | 4.5 | 5.25 |
| DS2 | GitHub source badge (.src-github) | #4c4959 | #eeedf1 | 4.5 | 7.49 |
| DS2 | GitHub badge in the profile header (.person-meta .src-github) | --accent | --accent-tint | 4.5 | 6.11 |
<!-- test-plan:end -->

## Non-goals

- A dark theme and a theme switch (G89, G92): slice 2 defines dark data
  tokens only.
- New avatar artwork or GitHub avatars in the feed-detail timeline.
- Changing any page layout.
