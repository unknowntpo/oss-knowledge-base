# Spec 023: Design system for the web app

Status: Accepted 2026-10-17 (owner approved the design-system audit and proposal with changes); slice 1 (colour bugs, DS1–DS3) implemented; slice 2 (data-viz tokens and palettes, DS4–DS6) implemented; slice 3 (text contrast, DS7) implemented; slice 4 (semantic layer, design-system page, DS8) implemented; slice 5 (badge states, DS9) implemented; slices 6–7 not implemented
Date: 2026-10-17
Traceability: enforced
Builds on: constitution §6 (visual language), ADR-0017 (the design system it links), Spec 019 (contributor profile chart and area donut), gardening G89 and G92

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
| Area donut, 6 slices + other | `#3a53b0 #e35b3f #2f8f6b #b07d1a #8a4fb0 #3c8fbf #a7a39a`: min ΔE00 2.7 (protan), orange in slot 2, slot 6 ΔE00 1 from 千草 | `#3a53b0 #ae3756 #0b664f #6b6a1a #7a3266 #3f7292 #737372`: min ΔE00 ≈ 11 under normal, protan and deutan vision (11.01 unrounded; 10.8 with 8-bit quantised simulation; enforced floor 10), no orange, ≥ 11.0 from every activity colour |

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

Slice 3, the E2E fixture's feed `/#/kafka/threads` and detail
`/#/feed/KAFKA-PR-43`, local build of `38bd390`:

| Text | Before | After slice 3 |
| --- | --- | --- |
| "PROJECT", "SOURCE" filter labels (10.5px), facet counts, card project, timeline time, "recorded since" | `--muted-3` `#9a968d`: 2.68:1 on the page | `--text-muted` `#6b6860`: 5.06:1 on the page |
| Search placeholder | `--muted-4` `#a7a39a`: 2.39:1 on `#faf9f7` | `--text-muted`: 5.29:1 |
| Search icon, external-link arrow | `#9a968d` 2.95:1, `#a7a39a` 2.52:1 | `--icon-muted` `#928e86`: 3.10:1 on the field, 3.26:1 on the card |
| "open source · multi-project" in the top bar (11px) | `#7f7c86`: 4.41:1 | `--dark-muted` `#8f8c96`: 5.46:1 |
| Focus ring on the top bar's selects | `#3a53b0`: 2.62:1 | `#8c9be8`: 6.85:1 |
| Profile "unavailable" line | `#e35b3f`: 3.27:1 on the page | `#b8432a`: 4.93:1 |
| Feed badges "Early" / "Open" | `#9a6410` 4.498:1 / `#1f883d` 4.06:1 | `#8a5a0e` 5.33:1 / `#1b7a36` 4.86:1 |

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
7. Text is never lighter than `--text-muted` `#6b6860` (5.06:1 on the page,
   4.89:1 on a chip): small labels, counts, timestamps, the search
   placeholder and the profile's "recorded since" lines use it; hierarchy
   below it comes from size, case and letter-spacing. Glyphs that carry no
   text (the search icon, the external-link arrow) use `--icon-muted`
   `#928e86` (≥ 3:1). Error text uses `--text-danger` `#b8432a`. On the dark
   top bar, small text uses `--dark-muted` and the focus ring
   `--focus-ring-inverse` `#8c9be8` (6.85:1). The feed's `.status-early` and
   `.status-open` get darker foregrounds until slice 5 replaces the badges.
8. Every `color-mix()` declaration follows a plain declaration of the same
   property (the series fill colour), so a browser without `color-mix()`
   draws a solid series instead of a black fill or an empty swatch.
9. Components use semantic tokens (`--surface-*`, `--text-*`, `--border-*`,
   `--accent`, `--brand`, `--icon-muted`, `--focus-ring-inverse`), data
   tokens, avatar tokens or fonts. The rank names (`--text-1..3`,
   `--muted-1`, `--border-1..3`, `--page-bg`, `--dark-*`, `--chip-*`,
   `--accent-tint*`) are gone. `--muted-1` `#716e67` (4.33–4.48:1 on chips
   and badge tints) and `--chip-text` `#6f6c76` (4.52:1 on a chip) become
   `--text-muted`, so no role used on a chip is below 4.5:1. There is no
   primitive layer; `docs/product/design-system.md` says when to add one.
10. No element that holds text is faded with `opacity`: the gate measures a
   token, and opacity lowers the drawn contrast without changing it. The
   timeline filter count was 3.61:1 (pressed 3.25:1); it is now
   `--text-muted` (5.56:1) and, pressed, `--accent` (6.11:1). An absent
   source chip on a feed card (`.source-dot.off`, 0.35) is outlined with
   `--text-muted` instead. `.tag-chip .count` (0.6, 2.74:1) had no element
   using it and is deleted.
11. Badges have one system (`apps/web/src/badge-state.ts`). Visible changes:
   feed "Open" goes from GitHub green to info blue and "Merged" from purple
   to success green; "Closed without merge" from red to neutral; feed
   "Adopted"/"Accepted" and "Early" move to the success and warning tints;
   the KIP "Vote" stage from orange `#8a4300` to warning brown `#7a4a12`;
   a topic thread "Discussing" from blue to progress rust. "Discuss" and
   "Implementing" keep their colours.
12. The feed-detail source-distribution bar is a data mark (`--data-bar-*`):
   瓶覗 `#a5dee4` at 70% with a 1px 藍鼠 `#566c73` outline, 5.04:1 on the
   page (it was `#d9defa`, 1.33:1, on a surface token). It is 6px high so the
   fill shows inside the outline.
13. The opacity rule allows `opacity: 0` (hidden, not faded) and reads
   percentages; a fade on an element without text needs an entry, with its
   reason, in the test's `NON_TEXT_FADES` list (empty today).

## Acceptance

Each item: precondition → action → observable result → evidence.

### Behavior
- DS1: given a feed detail with a GitHub record by `bob`, when the timeline renders, the avatar has a non-transparent background from `--avatar-1..6`, chosen by `authorHue("bob")`, and its white initials measure ≥ 4.5:1 on it; every avatar token measures ≥ 4.5:1 with white → unit test over the case file, E2E computed style.
- DS2: given the stylesheet, `.src-github` has exactly one unscoped rule (slate on slate tint, ≥ 4.5:1), and on the feed-detail page the GitHub badge computes to `#4c4959` on `#eeedf1`, while the profile header's badge keeps the accent → unit test, E2E computed style.
- DS3: given `apps/web/styles.css`, every `var(--x)` names a defined custom property and every defined custom property is referenced → unit test.
- DS4: given the stylesheet, the profile activity chart, its legend, tile and tooltip swatches, the hatch and the area donut take colours from `--data-*` tokens only, and no `--data-*` token aliases another token; the activity series are the owner's values — light: reviews given fill `#7db9de` at 55% with outline `#3a8fb7`, own PRs and comments fill `#91ad70` at 50% with outline `#838a2d`, reviews received fill `#8b81c3` at 30% with outline `#8b81c3`, outline width 1.2px, unrecorded hatch line `#928e86` on `#faf9f7`; dark: the same fills at 25% / 25% / 22% with outlines `#7db9de` / `#91ad70` / `#8b81c3` measured on `#202027`, hatch line `#716e7a` on `#26262e`; on the rendered profile the marks compute to those outlines and fill alphas → unit test, E2E computed style.
- DS5: given the data tokens, every outline or solid mark measures ≥ 3:1 on the background it is drawn on: the card `--surface`, the tooltip `--dark-bar`, the hatch base, and in the dark tokens the dark card `#202027` and the dark hatch base `#26262e` → unit test over the case file.
- DS6: given the area tokens, every pair is ΔE00 ≥ 10 apart under normal, protan and deutan simulation (Machado 2009, full severity), every one measures ≥ 3:1 on the card, no data colour is orange (LCh hue 30–85° above chroma 15), and no area colour is within ΔE00 10 of an activity-chart colour → unit test, E2E computed style.
- DS7: given the stylesheet, every DS7 row of the case file names a rule whose `color` (for the top-bar focus ring, `outline-color`) is that row's foreground, and the pair measures ≥ 4.5:1 for text or ≥ 3:1 for an icon glyph or focus ring on the lightest surface the rule sits on; no rule sets text in `--muted-3`, `--muted-4`, `--dark-muted-2` or brand orange; on the rendered detail page a focused top-bar control shows `#8c9be8` and the timeline time `#6b6860` → unit test over the case file, E2E computed style.
- DS8: given the stylesheet, every `:root` token outside the data, avatar, font and series families is a role named surface, text, border, accent, brand, icon or focus-ring holding a literal; `docs/product/design-system.md` lists each such token and each area token with its value, and lists none that is undefined; constitution §6 links that page; no rule sets `opacity` below 1, and the timeline filter counts, source chips, keywords and thread-status chips that used opacity or `--chip-text` are bound to solid pairs ≥ 4.5:1 in the normal and pressed states; on the rendered detail page the pressed and unpressed filter counts compute to `#3a53b0` and `#6b6860` at opacity 1 → unit test over the case file, E2E computed style.
- DS9: given any status (feed, search, topic threads) or proposal stage, `badgeState()` maps it to one of six states — success (adopted, accepted, merged, resolved, implementing), info (open, discuss), warning (early, vote), progress (discussing), neutral (dropped, rejected, closed, anything unknown), danger (errors) — the badge carries `data-state`, each state has one colour rule whose text measures ≥ 4.5:1 on its tint, and no status or stage class sets a colour of its own; on the rendered feed "Open" is info blue and "Merged" success green, and every stage and topic-thread badge computes to its state's colour → unit test over the case file, E2E computed style.
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
| id | theme | pair | foreground | background | surface | min | ratio |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DS1 | light | avatar initials on --avatar-1 (indigo) | #ffffff | --avatar-1 |  | 4.5 | 6.9 |
| DS1 | light | avatar initials on --avatar-2 (green) | #ffffff | --avatar-2 |  | 4.5 | 5.2 |
| DS1 | light | avatar initials on --avatar-3 (rust) | #ffffff | --avatar-3 |  | 4.5 | 5.44 |
| DS1 | light | avatar initials on --avatar-4 (purple) | #ffffff | --avatar-4 |  | 4.5 | 7.37 |
| DS1 | light | avatar initials on --avatar-5 (steel blue, legacy #3f7fa0 darkened) | #ffffff | --avatar-5 |  | 4.5 | 4.86 |
| DS1 | light | avatar initials on --avatar-6 (brown) | #ffffff | --avatar-6 |  | 4.5 | 5.25 |
| DS2 | light | GitHub source badge (.src-github) | #4c4959 | #eeedf1 |  | 4.5 | 7.49 |
| DS2 | light | GitHub badge in the profile header (.person-meta .src-github) | --accent | --surface-selected |  | 4.5 | 6.11 |
| DS5 | light | reviews given outline (千草) on the card | --data-given-stroke | --surface-card |  | 3 | 3.63 |
| DS5 | light | own PRs and comments outline (苔) on the card | --data-github-stroke | --surface-card |  | 3 | 3.72 |
| DS5 | light | reviews received outline (藤) on the card | --data-received-stroke | --surface-card |  | 3 | 3.48 |
| DS5 | light | Jira outline (青碧) on the card | --data-jira-stroke | --surface-card |  | 3 | 4.3 |
| DS5 | light | dev@ outline (今様) on the card | --data-mail-stroke | --surface-card |  | 3 | 3.91 |
| DS5 | light | unrecorded hatch line on its base | --data-unrecorded-line | --data-unrecorded-bg |  | 3 | 3.1 |
| DS5 | light | reviews given swatch outline in the tooltip | --data-given-stroke | --surface-inverse |  | 3 | 4.98 |
| DS5 | light | own PRs swatch outline in the tooltip | --data-github-stroke | --surface-inverse |  | 3 | 4.84 |
| DS5 | light | reviews received swatch outline in the tooltip | --data-received-stroke | --surface-inverse |  | 3 | 5.18 |
| DS5 | light | Jira swatch outline in the tooltip | --data-jira-stroke | --surface-inverse |  | 3 | 4.2 |
| DS5 | light | dev@ swatch outline in the tooltip | --data-mail-stroke | --surface-inverse |  | 3 | 4.61 |
| DS5 | dark | reviews given outline (勿忘草) on the dark card | --data-given-stroke | #202027 |  | 3 | 7.61 |
| DS5 | dark | own PRs outline (柳茶) on the dark card | --data-github-stroke | #202027 |  | 3 | 6.49 |
| DS5 | dark | reviews received outline (藤) on the dark card | --data-received-stroke | #202027 |  | 3 | 4.64 |
| DS5 | dark | Jira outline (水浅葱) on the dark card | --data-jira-stroke | #202027 |  | 3 | 7.15 |
| DS5 | dark | dev@ outline (紅梅) on the dark card | --data-mail-stroke | #202027 |  | 3 | 5.15 |
| DS5 | dark | unrecorded hatch line on its dark base | --data-unrecorded-line | --data-unrecorded-bg |  | 3 | 3.01 |
| DS6 | light | area 1 (indigo) on the card | --data-area-1 | --surface-card |  | 3 | 6.9 |
| DS6 | light | area 2 (rose) on the card | --data-area-2 | --surface-card |  | 3 | 6.03 |
| DS6 | light | area 3 (green) on the card | --data-area-3 | --surface-card |  | 3 | 6.94 |
| DS6 | light | area 4 (olive) on the card | --data-area-4 | --surface-card |  | 3 | 5.67 |
| DS6 | light | area 5 (plum) on the card | --data-area-5 | --surface-card |  | 3 | 8.48 |
| DS6 | light | area 6 (steel blue) on the card | --data-area-6 | --surface-card |  | 3 | 5.21 |
| DS6 | light | area other (grey) on the card | --data-area-other | --surface-card |  | 3 | 4.75 |
| DS7 | light | .examples-label | --text-muted | --surface-page | the page: the darker of page and card, so the card passes too | 4.5 | 5.06 |
| DS7 | light | .filter-label | --text-muted | --surface-page | the page: the darker of page and card, so the card passes too | 4.5 | 5.06 |
| DS7 | light | .card-project | --text-muted | --surface-page | the page: the darker of page and card, so the card passes too | 4.5 | 5.06 |
| DS7 | light | .evidence-label | --text-muted | --surface-page | the page: the darker of page and card, so the card passes too | 4.5 | 5.06 |
| DS7 | light | .topic-meta .k | --text-muted | --surface-page | the page: the darker of page and card, so the card passes too | 4.5 | 5.06 |
| DS7 | light | .ai-item .n | --text-muted | --surface-page | the page: the darker of page and card, so the card passes too | 4.5 | 5.06 |
| DS7 | light | .tl-period | --text-muted | --surface-page | the page: the darker of page and card, so the card passes too | 4.5 | 5.06 |
| DS7 | light | .tl-foot | --text-muted | --surface-page | the page: the darker of page and card, so the card passes too | 4.5 | 5.06 |
| DS7 | light | .rail-label | --text-muted | --surface-page | the page: the darker of page and card, so the card passes too | 4.5 | 5.06 |
| DS7 | light | .rail-row .num | --text-muted | --surface-page | the page: the darker of page and card, so the card passes too | 4.5 | 5.06 |
| DS7 | light | .rail-source > .num | --text-muted | --surface-page | the page: the darker of page and card, so the card passes too | 4.5 | 5.06 |
| DS7 | light | .person-chart-table td.is-unrecorded | --text-muted | --surface-page | the page: the darker of page and card, so the card passes too | 4.5 | 5.06 |
| DS7 | light | .person-tile-since | --text-muted | --surface-page | the page: the darker of page and card, so the card passes too | 4.5 | 5.06 |
| DS7 | light | #q::placeholder | --text-muted | --surface-sunken |  | 4.5 | 5.29 |
| DS7 | light | .filter-row .count | --text-muted | --surface-chip | the chip (for facet rows, the hover background), darker than page and card | 4.5 | 4.89 |
| DS7 | light | .tl-time | --text-muted | #fdf7e3 | the flashed timeline card, the darkest it sits on | 4.5 | 5.19 |
| DS7 | light | .person-unavailable | --text-danger | --surface-page | the page: the darker of page and card, so the card passes too | 4.5 | 4.93 |
| DS7 | light | .brand-scope | --text-inverse-muted | --surface-inverse |  | 4.5 | 5.46 |
| DS7 | light | .search-icon | --icon-muted | --surface-sunken |  | 3 | 3.1 |
| DS7 | light | .source-link .ext | --icon-muted | --surface-card |  | 3 | 3.26 |
| DS7 | light | .topbar :focus-visible | --focus-ring-inverse | --surface-inverse |  | 3 | 6.85 |
| DS8 | light | .tl-filter .count | --text-muted | --surface-card | the filter button; was opacity 0.7, 3.61:1 | 4.5 | 5.56 |
| DS8 | light | .tl-filter[aria-pressed="true"] .count | --accent | --surface-selected | the pressed filter; was opacity 0.7, 3.25:1 | 4.5 | 6.11 |
| DS8 | light | .source-dot | --text-muted | --surface-chip | the chip; was --chip-text #6f6c76, 4.52:1 | 4.5 | 4.89 |
| DS8 | light | .source-dot.off | --text-muted | --surface-card | the card (no fill, outlined); was opacity 0.35 | 4.5 | 5.56 |
| DS8 | light | .keyword | --text-muted | --surface-chip | the chip; was --chip-text | 4.5 | 4.89 |
| DS5 | light | .bar | --data-bar-stroke | --surface-page | the page: the feed-detail rail sits on it, darker than a card | 3 | 5.04 |
| DS9 | light | [data-state="success"] | --text-state-success | --surface-state-success | the badge's own tint | 4.5 | 6.59 |
| DS9 | light | [data-state="info"] | --text-state-info | --surface-state-info | the badge's own tint | 4.5 | 7.14 |
| DS9 | light | [data-state="warning"] | --text-state-warning | --surface-state-warning | the badge's own tint | 4.5 | 6.67 |
| DS9 | light | [data-state="progress"] | --text-state-progress | --surface-state-progress | the badge's own tint | 4.5 | 4.79 |
| DS9 | light | [data-state="neutral"] | --text-state-neutral | --surface-state-neutral | the badge's own tint | 4.5 | 5.19 |
| DS9 | light | [data-state="danger"] | --text-state-danger | --surface-state-danger | the badge's own tint | 4.5 | 4.71 |
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
