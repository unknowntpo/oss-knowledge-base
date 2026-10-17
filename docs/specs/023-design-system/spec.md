# Spec 023: Design system for the web app

Status: Accepted 2026-10-17 (owner approved the design-system audit and proposal with changes); slice 1 (colour bugs, DS1–DS3) implemented; slice 2 (data-viz tokens and palettes, DS4–DS6) implemented; slices 3–7 not implemented
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

Slice 2, the E2E fixture's profile `/#/kafka/people/github:alice` (reviews
given in Jun, Sep, Oct; GitHub PRs and comments in Sep, Oct; one review
received in Mar; six area labels), local build of `f362711`:

| Mark | Before | After slice 2 (light) |
| --- | --- | --- |
| Reviews given | solid `#3a53b0` (= `--accent`), 6.90:1 | 勿忘草 `#7db9de` at 55% with a 1.2px 千草 `#3a8fb7` outline, 3.63:1 |
| GitHub PRs and comments | solid `#2f8f6b` (= `--area-3`), 3.99:1 | 柳茶 `#91ad70` at 50% with 苔 `#838a2d`, 3.72:1 |
| Reviews received (below the axis) | solid `#b9c0e8` (= `--accent-hover-border`), **1.78:1** | 藤 `#8b81c3` at 30% with `#8b81c3`, 3.48:1 |
| Not recorded (hatch) | `#d8d4cc` on `#faf9f7`, **1.40:1** | `#928e86` on `#faf9f7`, 3.10:1 |
| Jira series (Jira identity) | solid `#2a6089` | 水浅葱 `#66bab7` at 50% with 青碧 `#268785`, 4.30:1 |
| dev@ series (dev@ identity) | solid `#a3542a` (rust, orange family) | 紅梅 `#e16b8c` at 40% with 今様 `#d05a6e`, 3.91:1 |
| Area donut, 6 slices + other | `#3a53b0 #e35b3f #2f8f6b #b07d1a #8a4fb0 #3c8fbf #a7a39a`: min ΔE00 2.7 (protan), orange in slot 2, slot 6 ΔE00 1 from 千草 | `#3a53b0 #ae3756 #0b664f #6b6a1a #7a3266 #3f7292 #737372`: min ΔE00 11.0 (normal, protan, deutan), no orange, ≥ 11.0 from every activity colour |

Dark tokens (no theme sets them yet), measured on the dark card `#202027`:
fills at 25% / 25% / 22% with outlines 勿忘草 `#7db9de` 7.61:1, 柳茶
`#91ad70` 6.49:1, 藤 `#8b81c3` 4.64:1; Jira `#66bab7` 7.15:1, dev@ `#e16b8c`
5.15:1, each at 25%; hatch line `#716e7a` on its base `#26262e` 3.01:1 (the
style guide's `#6e6b77` measures 2.88:1 on `#26262e`; `#716e7a` is the nearest
colour, ΔE00 1.2, that reaches 3:1).

The area palette comes from a constrained search run for the design audit
(outside the repository; the DS6 tests enforce its result): start from the proposal's palette with the orange
slot replaced, require ≥ 3:1 on white, no LCh hue in 30–85° above chroma 15,
a neutral "other", min ΔE00 ≥ 11 under normal, protan and deutan, and ΔE00 ≥ 11
from every activity colour, then minimise the drift from the start.

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
4. Chart colours live in `--data-*` tokens (`apps/web/styles.css`, block
   "Spec 023 DS4–DS6"). A data token holds a literal; it never aliases
   another token, so a hover, tint, border or muted change cannot recolour a
   chart. Each activity series is a fill colour, a fill alpha and an outline
   colour; the chart marks, the legend, tile and tooltip swatches all draw
   the same translucent fill (`color-mix(in srgb, fill alpha, transparent)`)
   with the outline, 1.2px in the chart and 1.5px inset on 10px swatches.
   The outline carries the 3:1 contrast.
5. Dark values are defined on `:root[data-theme="dark"]`; nothing sets the
   attribute until a dark theme exists (G89, G92).
6. The area donut keeps its own solid palette (slot by rank as before) and
   shares no colour with the activity chart, so one colour never means two
   things on a profile.

## Acceptance

Each item: precondition → action → observable result → evidence.

### Behavior
- DS1: given a feed detail with a GitHub record by `bob`, when the timeline renders, the avatar has a non-transparent background from `--avatar-1..6`, chosen by `authorHue("bob")`, and its white initials measure ≥ 4.5:1 on it; every avatar token measures ≥ 4.5:1 with white → unit test over the case file, E2E computed style.
- DS2: given the stylesheet, `.src-github` has exactly one unscoped rule (slate on slate tint, ≥ 4.5:1), and on the feed-detail page the GitHub badge computes to `#4c4959` on `#eeedf1`, while the profile header's badge keeps the accent → unit test, E2E computed style.
- DS3: given `apps/web/styles.css`, every `var(--x)` names a defined custom property and every defined custom property is referenced → unit test.
- DS4: given the stylesheet, the profile activity chart, its legend, tile and tooltip swatches, the hatch and the area donut take colours from `--data-*` tokens only, and no `--data-*` token aliases another token; the activity series are the owner's values — light: reviews given fill `#7db9de` at 55% with outline `#3a8fb7`, own PRs and comments fill `#91ad70` at 50% with outline `#838a2d`, reviews received fill `#8b81c3` at 30% with outline `#8b81c3`, outline width 1.2px, unrecorded hatch line `#928e86` on `#faf9f7`; dark: the same fills at 25% / 25% / 22% with outlines `#7db9de` / `#91ad70` / `#8b81c3` measured on `#202027`, hatch line `#716e7a` on `#26262e`; on the rendered profile the marks compute to those outlines and fill alphas → unit test, E2E computed style.
- DS5: given the data tokens, every outline or solid mark measures ≥ 3:1 on the background it is drawn on: the card `--surface`, the tooltip `--dark-bar`, the hatch base, and in the dark tokens the dark card `#202027` and the dark hatch base `#26262e` → unit test over the case file.
- DS6: given the area tokens, every pair is ΔE00 ≥ 10 apart under normal, protan and deutan simulation (Machado 2009, full severity), every one measures ≥ 3:1 on the card, no data colour is orange (LCh hue 30–85° above chroma 15), and no area colour is within ΔE00 10 of an activity-chart colour → unit test, E2E computed style.
- DS7: [pending] slice 3: every listed text pair (selector, foreground token, background token) measures ≥ 4.5:1, and the focus ring on the dark top bar ≥ 3:1.
- DS8: [pending] slice 4: `docs/product/design-system.md` lists the tokens, roles, rules and data-viz palettes with measured ratios, and constitution §6 links to it.
- DS9: [pending] slice 5: feed and digest badges use six semantic states (success, info, warning, progress, neutral, danger); feed "open" is info and "merged" is success.
- DS10: [pending] slice 6: no colour literal appears in `apps/web` styles or components outside the token block.
- DS11: [pending] slice 7: font sizes come from the 8-step scale (12.5px maps to 13px), and spacing and radius values from their scales (`--space-*`, `--radius-*`).

### Failure and retry
Not applicable: styles have no runtime failure path; a missing token falls
back to the property's initial value, which DS3 prevents.

### Budget
Not applicable: slices 1 and 2 change a stylesheet only; no request,
storage or runtime cost. `color-mix()` needs Chrome 111, Safari 16.2,
Firefox 113 (2023).

### Observability
Not applicable: violations are caught before merge by the stylesheet test
and the E2E computed-style checks.

## Test plan

Generated from the case file by `bun run docs:test-plan`; the unit tests run
exactly these rows.

<!-- test-plan:start apps/web/test/design-system.cases.ts -->
| id | theme | pair | foreground | background | min | ratio |
| --- | --- | --- | --- | --- | --- | --- |
| DS1 | light | avatar initials on --avatar-1 (indigo) | #ffffff | --avatar-1 | 4.5 | 6.9 |
| DS1 | light | avatar initials on --avatar-2 (green) | #ffffff | --avatar-2 | 4.5 | 5.2 |
| DS1 | light | avatar initials on --avatar-3 (rust) | #ffffff | --avatar-3 | 4.5 | 5.44 |
| DS1 | light | avatar initials on --avatar-4 (purple) | #ffffff | --avatar-4 | 4.5 | 7.37 |
| DS1 | light | avatar initials on --avatar-5 (steel blue, legacy #3f7fa0 darkened) | #ffffff | --avatar-5 | 4.5 | 4.86 |
| DS1 | light | avatar initials on --avatar-6 (brown) | #ffffff | --avatar-6 | 4.5 | 5.25 |
| DS2 | light | GitHub source badge (.src-github) | #4c4959 | #eeedf1 | 4.5 | 7.49 |
| DS2 | light | GitHub badge in the profile header (.person-meta .src-github) | --accent | --accent-tint | 4.5 | 6.11 |
| DS5 | light | reviews given outline (千草) on the card | --data-given-stroke | --surface | 3 | 3.63 |
| DS5 | light | own PRs and comments outline (苔) on the card | --data-github-stroke | --surface | 3 | 3.72 |
| DS5 | light | reviews received outline (藤) on the card | --data-received-stroke | --surface | 3 | 3.48 |
| DS5 | light | Jira outline (青碧) on the card | --data-jira-stroke | --surface | 3 | 4.3 |
| DS5 | light | dev@ outline (今様) on the card | --data-mail-stroke | --surface | 3 | 3.91 |
| DS5 | light | unrecorded hatch line on its base | --data-unrecorded-line | --data-unrecorded-bg | 3 | 3.1 |
| DS5 | light | reviews given swatch outline in the tooltip | --data-given-stroke | --dark-bar | 3 | 4.98 |
| DS5 | light | own PRs swatch outline in the tooltip | --data-github-stroke | --dark-bar | 3 | 4.84 |
| DS5 | light | reviews received swatch outline in the tooltip | --data-received-stroke | --dark-bar | 3 | 5.18 |
| DS5 | light | Jira swatch outline in the tooltip | --data-jira-stroke | --dark-bar | 3 | 4.2 |
| DS5 | light | dev@ swatch outline in the tooltip | --data-mail-stroke | --dark-bar | 3 | 4.61 |
| DS5 | dark | reviews given outline (勿忘草) on the dark card | --data-given-stroke | #202027 | 3 | 7.61 |
| DS5 | dark | own PRs outline (柳茶) on the dark card | --data-github-stroke | #202027 | 3 | 6.49 |
| DS5 | dark | reviews received outline (藤) on the dark card | --data-received-stroke | #202027 | 3 | 4.64 |
| DS5 | dark | Jira outline (水浅葱) on the dark card | --data-jira-stroke | #202027 | 3 | 7.15 |
| DS5 | dark | dev@ outline (紅梅) on the dark card | --data-mail-stroke | #202027 | 3 | 5.15 |
| DS5 | dark | unrecorded hatch line on its dark base | --data-unrecorded-line | --data-unrecorded-bg | 3 | 3.01 |
| DS6 | light | area 1 (indigo) on the card | --data-area-1 | --surface | 3 | 6.9 |
| DS6 | light | area 2 (rose) on the card | --data-area-2 | --surface | 3 | 6.03 |
| DS6 | light | area 3 (green) on the card | --data-area-3 | --surface | 3 | 6.94 |
| DS6 | light | area 4 (olive) on the card | --data-area-4 | --surface | 3 | 5.67 |
| DS6 | light | area 5 (plum) on the card | --data-area-5 | --surface | 3 | 8.48 |
| DS6 | light | area 6 (steel blue) on the card | --data-area-6 | --surface | 3 | 5.21 |
| DS6 | light | area other (grey) on the card | --data-area-other | --surface | 3 | 4.75 |
<!-- test-plan:end -->

## Non-goals

- A dark theme and a theme switch (G89, G92): slice 2 defines dark data
  tokens only.
- A colour per source shared by the chart and the source badges: the Jira
  and dev@ series moved to translucent Japanese traditional colours (the
  owner dislikes orange in charts); the badges keep the source identity
  colours.
- New avatar artwork or GitHub avatars in the feed-detail timeline.
- Changing any page layout.
