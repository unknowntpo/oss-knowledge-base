# Design system (web app)

Status: Active (Spec 023; slices 1–4 implemented, badges, literals and scales
pending)

This is the colour system of `apps/web`. It keeps the visual language that
[constitution §6](../constitution.md#6-open-formats-and-a-tested-exit-path)
protects and makes it checkable: every colour has a role, and a test measures
each pair a reader sees.

- Tokens: the `:root` blocks of `apps/web/styles.css`.
- Measured pairs: `apps/web/test/design-system.cases.ts`, rendered as the
  test plan of [Spec 023](../specs/023-design-system/spec.md).
- Gate: `apps/web/test/design-system.test.ts` (part of `bun run test`).

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
- Source identity colours: wiki indigo, Jira steel blue, mail rust, GitHub
  slate.

## Token layers

| Layer | Names | Rule |
| --- | --- | --- |
| Semantic | `--surface-*`, `--text-*`, `--border-*`, `--accent`, `--brand`, `--icon-muted`, `--focus-ring-inverse` | What components use for UI. Each holds a literal. A future dark theme redefines only this layer and the data layer. |
| Data | `--data-*` | Chart colours. Literals only; never an alias of a semantic token. |
| Identity | `--avatar-1` … `--avatar-6` | Author avatars in the timeline (hashed by name). |
| Component | `--series-fill`, `--series-alpha`, `--series-stroke` | Set per `[data-series]` from the data layer, read by chart marks and swatches. |

There is no primitive layer (named colour ramps). Semantic tokens hold the
values directly; add a ramp only when a second theme needs to share one.

## Semantic roles (light)

| Token | Value | Role | Measured |
| --- | --- | --- | --- |
| `--surface-page` | `#f5f4f1` | Page background | — |
| `--surface-card` | `#ffffff` | Cards and panels | — |
| `--surface-sunken` | `#faf9f7` | Inputs, footer, hatch base | — |
| `--surface-chip` | `#f2f0ec` | Chips, hover rows | — |
| `--surface-selected` | `#eef1fb` | Selected filter, tab or chip | — |
| `--surface-selected-strong` | `#d9defa` | Hover on a selected control; the source-distribution bar | — |
| `--surface-inverse` | `#16161a` | Top bar, tooltip | — |
| `--surface-inverse-raised` | `#202027` | Controls on the top bar | — |
| `--text-strong` | `#1c1b19` | Titles | 17.21 card, 15.12 chip |
| `--text-primary` | `#24221d` | Primary text | 15.89 card, 13.96 chip |
| `--text-body` | `#33312c` | Body text | 12.99 card, 11.41 chip |
| `--text-secondary` | `#565349` | Secondary text | 7.69 card, 6.76 chip |
| `--text-muted` | `#6b6860` | The lightest text: labels, counts, times | 5.56 card, 5.06 page, 5.29 sunken, 4.89 chip, 4.93 selected |
| `--text-danger` | `#b8432a` | Errors, unavailable | 5.42 card, 4.93 page |
| `--text-inverse` | `#f5f4f1` | Text on the top bar and tooltip | 16.41 / 14.72 raised |
| `--text-inverse-muted` | `#8f8c96` | Muted text on the top bar and tooltip | 5.46 / 4.90 raised |
| `--accent` | `#3a53b0` | Links, selected text, primary actions, focus ring | 6.90 card, 6.06 chip, 6.11 selected |
| `--brand` | `#e35b3f` | The brand mark only; never text | `--surface-inverse` text on it 5.01 |
| `--icon-muted` | `#928e86` | Glyphs that carry no text | 3.26 card, 3.10 sunken |
| `--focus-ring-inverse` | `#8c9be8` | Focus ring on the top bar | 6.85 / 6.14 raised |
| `--border-default` | `#e6e2db` | Card and control borders | decorative |
| `--border-strong` | `#d8d4cc` | Inputs, axes, outlined "off" chips | decorative |
| `--border-subtle` | `#f0eee9` | Dividers, grid lines | decorative |
| `--border-hover` | `#b9c0e8` | Hover border, a UI state only | never data |
| `--border-selected` | `#d9defa` | Border of a selected control | decorative |
| `--border-inverse` | `#33333b` | Borders on the top bar | decorative |

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

Dark values are on `:root[data-theme="dark"]`; no page sets the attribute
yet (gardening G89, G92).

### Area donut (by rank)

Solid colours, kept apart from the activity chart so one colour never means
two things on a profile.

| Token | Value | On card |
| --- | --- | --- |
| `--data-area-1` | `#3a53b0` indigo | 6.90 |
| `--data-area-2` | `#ae3756` rose | 6.03 |
| `--data-area-3` | `#0b664f` green | 6.94 |
| `--data-area-4` | `#6b6a1a` olive | 5.67 |
| `--data-area-5` | `#7a3266` plum | 8.48 |
| `--data-area-6` | `#3f7292` steel blue | 5.21 |
| `--data-area-other` | `#737372` grey | 4.75 |

The smallest ΔE00 between any two slices is ≈ 11 under normal, protan and
deutan vision (11.01 unrounded, 10.8 with 8-bit quantised simulation). The
enforced floor is 10. Every slice is at least ΔE00 10 from every activity
colour.

## Rules

1. **Components use roles, not values.** A rule references a semantic,
   data, identity or component token. Literals outside `:root` are being
   removed (Spec 023 slice 6 adds the lint).
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
8. **One badge system and one source map** (Spec 023 slice 5). New screens
   pick a state; they do not invent colours.

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
