# Design system (web app)

Status: Active (Spec 023; dark theme Spec 024)

This is the colour system of `apps/web`. It keeps the visual language that
[constitution §6](../constitution.md#6-open-formats-and-a-tested-exit-path)
protects and makes it checkable: every colour has a role, and a test measures
each pair a reader sees.

- Tokens: the `:root` blocks of `apps/web/styles.css`.
- Measured pairs: `apps/web/test/design-system.cases.ts` (light), rendered as
  the test plan of [Spec 023](../specs/023-design-system/spec.md), and their
  dark twins in `apps/web/test/dark-theme.cases.ts`
  ([Spec 024](../specs/024-dark-theme/spec.md)).
- Gates: `apps/web/test/design-system.test.ts` and
  `apps/web/test/dark-theme.test.ts` (part of `bun run test`).
- Themes: light and dark. The inline script in `apps/web/index.html` sets
  `data-theme` on `<html>` before first paint: the viewer's stored choice
  (`localStorage["osskb.theme"]`: `light`, `dark` or `system`), else the OS
  `prefers-color-scheme`. Dark values live in `:root[data-theme="dark"]`.
  Every table below gives both; "same" means the token is theme-invariant.
  Readers choose on the top bar (淺色 / 深色 / 跟隨系統; one cycling button at
  420 px and below). If a Content-Security-Policy is ever added, the inline
  script needs its hash or a nonce in `script-src`.

All ratios are WCAG 2.x contrast. Colour differences are CIEDE2000 (ΔE00);
colour-vision simulation uses Machado, Oliveira and Fernandes (2009) at full
severity.

## Visual language

- A warm grey, paper-like reading surface with white cards.
- A near-black top bar, the one strong colour moment, with a small orange
  brand mark.
- IBM Plex: Sans for UI, Mono for identifiers, counts and labels, Serif for
  titles.
- One indigo accent, used sparingly for links, selection and kickers.
  Selected states use tints, not fills.
- Small radii, 1px borders, almost no shadow, no gradients.
- Source identity colours: wiki indigo, Jira steel blue, mail rust (rose in
  dark), GitHub slate.
- Dark: ink greys with a faint indigo bias, never pure black; elevation by
  lightness (top bar < page < sunken < card < chip < popover); warm off-white
  text; the accent becomes the light indigo `#8c9be8`; accent fills take ink
  text; shadows become 1px rings.

## Token layers

| Layer | Names | Rule |
| --- | --- | --- |
| Semantic | `--surface-*`, `--text-*`, `--border-*`, `--accent`, `--brand`, `--icon-muted`, `--focus-ring-inverse`, `--shadow-*`, `--source-*` | What components use for UI. Each holds a literal. The dark theme redefines only this layer and the data layer. |
| Data | `--data-*` | Chart colours. Literals only; never an alias of a semantic token. |
| Identity | `--avatar-1` … `--avatar-6` | Author avatars in the timeline (hashed by name). |
| Component | `--series-fill`, `--series-alpha`, `--series-stroke` | Set per `[data-series]` from the data layer, read by chart marks and swatches. |

There is no primitive layer (named colour ramps). Semantic tokens hold the
values directly; add a ramp only when a second theme needs to share one.

## Semantic roles

| Token | Light | Dark | Role | Measured |
| --- | --- | --- | --- | --- |
| `--surface-page` | `#f5f4f1` | `#18181d` | Page background | — |
| `--surface-card` | `#ffffff` | `#202027` | Cards and panels | — |
| `--surface-sunken` | `#faf9f7` | `#1c1c22` | Inputs, footer, hatch base | — |
| `--surface-chip` | `#f2f0ec` | `#27272f` | Chips, hover rows | — |
| `--surface-selected` | `#eef1fb` | `#262b45` | Selected filter, tab or chip | — |
| `--surface-selected-strong` | `#d9defa` | `#2a3051` | Hover on a selected control | — |
| `--surface-inverse` | `#16161a` | `#101013` | Top bar, tooltip | — |
| `--surface-inverse-raised` | `#202027` | `#1c1c22` | Controls on the top bar | — |
| `--surface-popover` | `#16161a` | `#2c2c35` | Chart tooltip: the highest layer (equals `--surface-inverse` in light) | — |
| `--text-strong` | `#1c1b19` | `#f0eee9` | Titles | 17.21 card, 15.12 chip; dark 13.96 card, 12.78 chip, 11.93 popover |
| `--text-primary` | `#24221d` | `#e7e4de` | Primary text | 15.89 card, 13.96 chip; dark 12.76 card, 11.68 chip |
| `--text-body` | `#33312c` | `#d8d5ce` | Body text | 12.99 card, 11.41 chip; dark 11.04 card, 10.11 chip |
| `--text-secondary` | `#565349` | `#b9b5ad` | Secondary text | 7.69 card, 6.76 chip; dark 7.92 card, 7.25 chip |
| `--text-muted` | `#6b6860` | `#a29e97` | The lightest text: labels, counts, times | 5.56 card, 5.06 page, 5.29 sunken, 4.89 chip, 4.93 selected; dark 6.07 card, 6.63 page, 6.36 sunken, 5.55 chip, 5.20 selected, 5.18 popover, 4.80 selected-strong |
| `--text-danger` | `#b8432a` | `#f0a1a1` | Errors, unavailable | 5.42 card, 4.93 page; dark 7.95 card, 8.69 page |
| `--text-inverse` | `#f5f4f1` | `#f0eee9` | Text on the top bar and tooltip | 16.41 / 14.72 raised; dark 16.38 top bar, 11.93 popover |
| `--text-inverse-muted` | `#8f8c96` | `#a19ea8` | Muted text on the top bar and tooltip | 5.46 / 4.90 raised; dark 7.21 top bar, 6.44 raised, 5.25 popover |
| `--accent` | `#3a53b0` | `#8c9be8` | Links, selected text, primary actions, focus ring | 6.90 card, 6.06 chip, 6.11 selected; dark 6.14 card, 5.62 chip, 5.26 selected, 4.86 selected-strong |
| `--brand` | `#e35b3f` | `#e35b3f` | The brand mark only; never text | `--surface-inverse` text on it 5.01; dark mark letter on it 5.28 |
| `--icon-muted` | `#928e86` | `#86838d` | Glyphs that carry no text | 3.26 card, 3.10 sunken; dark 4.35 card, 4.56 sunken, 3.98 chip |
| `--focus-ring-inverse` | `#8c9be8` | `#8c9be8` | Focus ring on the top bar | 6.85 / 6.14 raised; dark 7.21 top bar, 6.43 raised |
| `--border-default` | `#e6e2db` | `#33333c` | Card and control borders | decorative |
| `--border-strong` | `#d8d4cc` | `#44444f` | Inputs, axes, outlined "off" chips | decorative |
| `--border-subtle` | `#f0eee9` | `#2a2a32` | Dividers, grid lines | decorative |
| `--border-hover` | `#b9c0e8` | `#4f5992` | Hover border, a UI state only | never data |
| `--border-selected` | `#d9defa` | `#3a4373` | Border of a selected control | decorative |
| `--border-inverse` | `#33333b` | `#2c2c34` | Borders on the top bar | decorative |
| `--border-inverse-strong` | `#000000` | `#2a2a32` | The top bar's bottom edge | decorative |
| `--text-on-accent` | `#ffffff` | `#16161a` | The generic "white text on a dark fill" role: an accent fill (pressed chip, filter count badge) and the avatar colours | 6.90 on `--accent`, ≥ 4.86 on every `--avatar-*`; dark 6.85 on `--accent` |
| `--text-trending` | `#9a4d2b` | `#eda39c` | "Trending" reason on a feed card | 6.05 card; dark 7.95 card |
| `--surface-trending-halo` | `#f8e7e1` | `#3a2624` | Ring around the trending dot (the dot is `--brand`) | decorative |
| `--surface-highlight` | `#fbeeb8` | `#4a4220` | `<mark>` in search results | body text on it 11.15 |
| `--surface-flash` | `#fdf7e3` | `#29271c` | A timeline card just jumped to | `--text-muted` on it 5.19 |
| `--border-flash` | `#e6d9a8` | `#5a5236` | Its border | decorative |
| `--surface-error` | `#fff8f5` | `#2a2023` | Load-error panel | body text on it 12.37 |
| `--border-error` | `#d7c7c1` | `#5a3e42` | Its border | decorative |
| `--surface-hover-column` | `rgba(58, 83, 176, 0.06)` | `rgba(140, 155, 232, 0.08)` | Hovered column of the profile chart | — |
| `--shadow-hover` | `0 6px 20px -14px rgba(40, 50, 120, 0.4)` | `0 0 0 1px #4f5992` | Card hover | — |
| `--shadow-popover` | `0 2px 8px rgba(0, 0, 0, 0.15)` | `0 0 0 1px #3a3a44` | Chart tooltip | — |

### Source identity

Wiki uses `--accent` on `--surface-selected` (6.11). Badges, timeline dots.

| Token | Light | Dark | Role | Measured |
| --- | --- | --- | --- | --- |
| `--source-jira` | `#2a6089` | `#93bcdc` | Jira | 5.77 on its tint; dark 7.29 on its tint |
| `--source-jira-tint` | `#e7eff6` | `#1d2a36` | Jira badge fill | — |
| `--source-mail` | `#a3542a` | `#e7a5b6` | dev@ | 4.79 on its tint; dark 7.30 on its tint (rose 薄紅梅 in dark; rust is in the orange band) |
| `--source-mail-tint` | `#f7efe9` | `#36232b` | dev@ badge fill | — |
| `--source-github` | `#4c4959` | `#b8b4c6` | GitHub | 7.49 on its tint; dark 7.22 on its tint |
| `--source-github-tint` | `#eeedf1` | `#29282f` | GitHub badge fill | — |

### Freshness pill (top bar)

| Token | Light | Dark | Role | Measured |
| --- | --- | --- | --- | --- |
| `--text-pill` | `#f0c9a5` | same | Pill text, no state class | 10.49 on its fill |
| `--border-pill` | `#5a3a2c` | same | Its border | — |
| `--surface-pill` | `#2a1e18` | same | Its fill | — |
| `--text-pill-live` | `#b8e4c9` | same | Live | 11.35 |
| `--border-pill-live` | `#35644a` | same | | — |
| `--surface-pill-live` | `#17251e` | same | | — |
| `--text-pill-overdue` | `#e3dba6` | same | Daily feed late (Spec 021) | 11.42 |
| `--border-pill-overdue` | `#5e5a2c` | same | | — |
| `--surface-pill-overdue` | `#232212` | same | | — |
| `--text-pill-stale` | `#f1d1a4` | same | Data may be out of date | 10.82 |
| `--border-pill-stale` | `#755126` | same | | — |
| `--surface-pill-stale` | `#2b2115` | same | | — |

## Badge states

One system for every status and stage badge: feed and search cards
(`.status-badge`), feed detail, proposal stages (`.stage-badge`) and topic
threads (`.thread-status`). `badgeState()` in `apps/web/src/badge-state.ts`
maps a status or stage key to a state; the badge carries `data-state`, and
only the state sets colours. An unknown key is neutral.

| State | Text token | Light | Dark | Tint token | Light | Dark | Ratio (light / dark) | Statuses and stages |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| success | `--text-state-success` | `#1c5e44` | `#8fd1b0` | `--surface-state-success` | `#dff2ea` | `#1d3129` | 6.59 / 7.82 | adopted, accepted, merged, resolved, implementing |
| info | `--text-state-info` | `#1d4e89` | `#9cc0ec` | `--surface-state-info` | `#e3eefa` | `#1c2a3d` | 7.14 / 7.71 | open, discuss |
| warning | `--text-state-warning` | `#7a4a12` | `#d9c27c` | `--surface-state-warning` | `#fbf1e3` | `#2e2a1a` | 6.67 / 8.18 | early, vote; also the digest's stale line (border `--border-state-warning` `#c9965a`), lag note and not-translated mark |
| progress | `--text-state-progress` | `#6b61b4` | `#9991df` | `--surface-state-progress` | `#f1eff8` | `#2a2742` | 4.62 / 5.09 | discussing (藤 wisteria; ΔE00 ≥ 10.5 from info and 13.0 from neutral under normal, protan and deutan vision) |
| neutral | `--text-state-neutral` | `#6b5e79` | `#b5afbf` | `--surface-state-neutral` | `#efeef2` | `#2a2930` | 5.19 / 6.75 | dropped, rejected, closed, anything else |
| danger | `--text-state-danger` | `#b8432a` | `#f0a1a1` | `--surface-state-danger` | `#fbece8` | `#3a2226` | 4.71 / 7.18 | errors (no status uses it yet) |

| Token | Light | Dark | Role | Measured |
| --- | --- | --- | --- | --- |
| `--border-state-warning` | `#c9965a` | `#8a7a45` | Border of an outlined warning (the digest's stale line) | decorative |

## Experimental label

One label for every feature that is live but has not passed its quality gate
(Spec 014 D109–D112): `components/ExperimentalLabel.vue` renders a pill
「實驗中・搶先體驗」 / "Experimental · Early access" and a one-line note, only
for a feature listed in `apps/web/src/experimental.ts`. It is not a status
badge (rule 8): it marks a feature, not an item. 藤 wisteria, a translucent
fill and a 1px outline on all four sides; no stripe, no orange.

| Token | Light | Dark | Role | Measured |
| --- | --- | --- | --- | --- |
| `--text-experimental` | `#574c96` | `#bdb5ee` | Badge text | light 6.45 on its fill over a card, 5.89 over the page; dark 6.63 / 7.24 |
| `--surface-experimental` | `rgba(139, 129, 195, 0.12)` | `rgba(139, 129, 195, 0.18)` | Badge fill (藤 `#8b81c3`, translucent) | — |
| `--border-experimental` | `#8b81c3` | `#8b81c3` | Badge outline (3:1 non-text) | light 3.48 on a card, 3.17 on the page; dark 4.64 / 5.08 |

## Avatars

Initials are `--text-on-accent`: white in light, ink `#16161a` on pastel
fills in dark.

| Token | Light | Dark | Initials (light / dark) |
| --- | --- | --- | --- |
| `--avatar-1` | `#3a53b0` | `#8c9be8` | 6.90 / 6.85 |
| `--avatar-2` | `#2b7a5b` | `#7ebea5` | 5.20 / 8.42 |
| `--avatar-3` | `#a3542a` | `#e0a0b0` | 5.44 / 8.44 |
| `--avatar-4` | `#7a3b8f` | `#b39ddb` | 7.37 / 7.53 |
| `--avatar-5` | `#3a7898` | `#84b6d6` | 4.86 / 8.29 |
| `--avatar-6` | `#96602a` | `#c9b27c` | 5.25 / 8.72 |

## Data-viz palettes

### Profile activity chart (方案二・透明感)

Each series is a translucent fill with a fine outline (1.2px in the chart,
1.5px inset on 10px swatches). The outline carries the 3:1 contrast. The
legend, the count tiles and the tooltip use the same swatch.

| Series | Fill (light) | Outline (light) | Light, on card | Fill (dark) | Outline (dark) | Dark, on `#202027` |
| --- | --- | --- | --- | --- | --- | --- |
| Reviews given | 勿忘草 `#7db9de` 55% | 千草 `#3a8fb7` | 3.63 (tooltip 4.98) | `#7db9de` 25% | `#7db9de` | 7.61 |
| Own PRs and comments | 柳茶 `#91ad70` 50% | 苔 `#838a2d` | 3.72 (tooltip 4.84) | `#91ad70` 25% | `#91ad70` | 6.49 |
| Reviews received (below the axis) | 藤 `#8b81c3` 30% | `#8b81c3` | 3.48 (tooltip 5.18) | `#8b81c3` 22% | `#8b81c3` | 4.64 |
| Jira (Jira identity) | 水浅葱 `#66bab7` 50% | 青碧 `#268785` | 4.30 (tooltip 4.20) | `#66bab7` 25% | `#66bab7` | 7.15 |
| dev@ (dev@ identity) | 紅梅 `#e16b8c` 40% | 今様 `#d05a6e` | 3.91 (tooltip 4.61) | `#e16b8c` 25% | `#e16b8c` | 5.15 |
| Not recorded (hatch) | base `#faf9f7` | line `#928e86` | 3.10 on its base | base `#26262e` | line `#716e7a` | 3.01 on its base |

Dark values are on `:root[data-theme="dark"]`. In dark the tooltip is
`--surface-popover` `#2c2c35`; the outlines measure 6.50, 5.54, 3.97, 6.11 and 4.40 on it.

### Feed detail source distribution

A bar per source, its count as text beside it. Like the chart: a light
translucent fill with a 1px outline that carries the 3:1.

| Token | Light | Dark | Role | Measured |
| --- | --- | --- | --- | --- |
| `--data-bar-fill` | `#a5dee4` | same | 瓶覗 fill | — |
| `--data-bar-alpha` | `70%` | `22%` | Fill opacity (dark composites to `#3d4a51`) | — |
| `--data-bar-stroke` | `#566c73` | `#8fb4ba` | Outline (藍鼠 in light) | 5.04 page, 5.54 card; dark 7.92 page, 7.25 card |

### Area donut (by rank)

Solid colours, kept apart from the activity chart so one colour never means
two things on a profile.

| Token | Light | Dark | Name (light / dark) | On card (light / dark) |
| --- | --- | --- | --- | --- |
| `--data-area-1` | `#3a53b0` | `#7798e7` | indigo / indigo | 6.90 / 5.73 |
| `--data-area-2` | `#ae3756` | `#e49ab2` | rose / rose | 6.03 / 7.37 |
| `--data-area-3` | `#0b664f` | `#52a070` | green / green | 6.94 / 5.10 |
| `--data-area-4` | `#6b6a1a` | `#b9b25e` | olive / olive | 5.67 / 7.39 |
| `--data-area-5` | `#7a3266` | `#af7baa` | plum / plum | 8.48 / 4.81 |
| `--data-area-6` | `#3f7292` | `#aabbe5` | steel blue / periwinkle | 5.21 / 8.44 |
| `--data-area-other` | `#737372` | `#888888` | grey / grey | 4.75 / 4.57 |

Dark: smallest ΔE00 11.52 under protan and deutan (11.94 normal; 11.33 with
8-bit quantised simulation), no orange, every slice ≥ 11.5 from every dark
activity colour (Spec 024 DM6). Slot 6 is periwinkle in dark: a steel blue at
dark lightness lands within ΔE00 10 of 勿忘草.

Light: the smallest ΔE00 between any two slices is ≈ 11 under normal, protan and
deutan vision (11.01 unrounded, 10.8 with 8-bit quantised simulation). The
enforced floor is 10. Every slice is at least ΔE00 10 from every activity
colour.

## Scales

Fonts stay IBM Plex (Sans for UI, Mono for identifiers and counts, Serif for
titles). A new step needs a reason in its PR; the DS11 test fails on a value
outside these scales.

| Type token | Size | Use |
| --- | --- | --- |
| `--fs-2xs` | 11px | Uppercase labels, axis text, badges |
| `--fs-xs` | 12px | Meta, legends, tile detail |
| `--fs-sm` | 13px | Secondary body, chips |
| `--fs-md` | 14px | Body |
| `--fs-lg` | 15px | Lede, card titles |
| `--fs-xl` | 17px | Profile summary, band titles on phones |
| `--fs-2xl` | 22px | Section and band titles |
| `--fs-3xl` | 28px | Person name, tile numbers |
| `--fs-display` | clamp(24px, 4vw, 34px) | Page titles |

Spacing (`padding`, `margin`, `gap`): `--space-2`, `-4`, `-6`, `-8`, `-10`,
`-12`, `-14`, `-16`, `-20`, `-24`, `-28`, `-32`, `-40`, `-48`, `-64`, `-96`
(the number is the pixel value). Negative margins use
`calc(var(--space-N) * -1)`.

Radius: `--radius-xs` 2px (swatches, bars), `--radius-sm` 4px, `--radius-md`
6px (controls), `--radius-lg` 8px (cards, buttons), `--radius-xl` 10px
(tiles, panels), `--radius-pill` 999px, and `50%` for circles.

## Rules

1. **Components use roles, not values.** A rule references a semantic,
   data, identity or component token. A colour literal (hex, `rgb()`,
   `hsl()`, `hwb()`, `lab()`, `lch()`, `oklab()`, `oklch()`, `color()`, or
   one of the 148 CSS named colours) outside the `:root` blocks of
   `apps/web/styles.css`, in a Vue `<style>` block or `style`/`fill`/`stroke`
   attribute, in `apps/web/index.html`, or as a hex or colour-function
   string in `apps/web/src` TypeScript fails the DS10 test.
2. **Data tokens never alias UI tokens.** A hover, tint, border or muted
   change must not recolour a chart.
3. **Text is ≥ 4.5:1 on the surface it sits on** (≥ 3:1 at 24px, or 18.66px
   bold). `--text-muted` is the lightest text colour. Hierarchy below it
   comes from size, case and letter-spacing, not a lighter grey.
4. **No `opacity` on elements that hold text.** Opacity lowers the text's
   contrast without changing its token, so the gate cannot see it. Use a
   solid colour that passes in every state (normal, hover, pressed).
5. **Marks, icons and focus rings are ≥ 3:1** against what they are drawn
   on. On the top bar, the focus ring is `--focus-ring-inverse`.
6. **Categorical palettes keep ΔE00 ≥ 10** between every pair under normal,
   protan and deutan simulation, and contain no orange.
7. **Every `color-mix()` follows a plain declaration** of the same property,
   so an older browser draws a solid colour.
8. **One badge system.** A badge picks one of the six states above through
   `badgeState()`; no status or stage class sets a colour of its own. Source
   badges keep the source identity colours.

## How to add a colour

1. Pick the role. If an existing semantic or data token fits, use it.
2. If none fits, add a token to the right block of `apps/web/styles.css`,
   with a literal value and a one-line comment saying what it is for.
3. Add a row to `apps/web/test/design-system.cases.ts` for every pair a
   reader sees: the rule's selector, foreground, the darkest surface it sits
   on (say so in `surface`), the floor and the measured ratio.
4. Run `bun test apps/web/test/design-system.test.ts`, then
   `bun run docs:test-plan` to refresh the spec's table.
5. Add the token to this page. A test fails when a token in `:root` is
   missing here.
