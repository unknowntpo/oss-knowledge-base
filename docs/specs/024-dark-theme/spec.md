# Spec 024: Dark theme

Status: Implemented 2026-10-18 (owner approved the dark-mode mockup: "lgtm go"); slice A (tokens, first paint, OS preference: DM1, DM3–DM9) and slice B (the three-way toggle, DM2) implemented
Date: 2026-10-18
Traceability: enforced
Builds on: Spec 023 (design system, its tokens and case rows), ADR-0017, gardening G89 and G92

## Intent

A reader whose OS asks for dark gets a dark page from the first frame, with the
same readability guarantees as the light theme: every colour pair measured,
every chart palette CVD-checked. A reader can override the OS per browser
(slice B). The visual language stays: ink greys with a faint indigo bias
(never pure black), warm off-white text, one indigo accent, translucent
Japanese-traditional chart colours, no orange.

## Evidence

- The app had no dark theme; G89 and G92 deferred the dark area palette and a
  browser check of the dark chart tokens until one existed.
- Spec 023 defined dark values for the activity chart only
  (`:root[data-theme="dark"]`), measured on the dark card `#202027`; nothing
  set the attribute.
- The owner approved the mockup and proposal on 2026-10-18 (design audit
  folder `dark-mode/`: `proposal.md`, `mockup.html`, `tools/dark_check.py`).

## Example

E2E fixture, local build of `912e5c7` plus this slice, Chromium with
`prefers-color-scheme: dark`, no stored choice:

| Element | Light (unchanged) | Dark |
| --- | --- | --- |
| `<html data-theme>` before the app script runs | `light` | `dark` |
| Page `body` background | `#f5f4f1` | `#18181d` |
| Card | `#ffffff` | `#202027` |
| Timeline time (`--text-muted`) on the page | 5.06:1 | 6.63:1 |
| Feed "Open" / "Merged" badge | 7.14 / 6.59:1 | `#9cc0ec` on `#1c2a3d` 7.71 / `#8fd1b0` on `#1d3129` 7.82:1 |
| Topic "Discussing" (progress, wisteria) | `#6b61b4` on `#f1eff8` 4.62:1 | `#9991df` on `#2a2742` 5.09:1 |
| dev@ source chip | rust `#a3542a` on `#f7efe9` 4.79:1 | rose `#e7a5b6` on `#36232b` 7.30:1 |
| Chart tooltip | `#16161a` | `--surface-popover` `#2c2c35`, outlines 3.97–6.50:1 |
| Area donut, min ΔE00 normal/protan/deutan | ≈ 11 | 11.94 / 11.52 / 11.52 |

Dark progress deviates from the mockup (`#bcb1e6`). That value is 2.5 and
1.2 ΔE00 from the dark info blue under protan and deutan simulation, so
"discussing" and "open" would look the same to red–green colour-blind
readers. `#9991df` keeps the 藤 hue (LCh 298°) and separates by lightness:
10.5 from info, 16.3 from neutral, under every simulation.

## Simplification review

1. **Question every requirement.** The OS preference: readers who set dark
   system-wide. No light flash: the same readers, on every load. The
   per-browser override: readers whose OS setting does not match their
   reading (slice B). `--surface-popover`: in dark the old tooltip surface
   (`--surface-inverse`) would sit below the card.
2. **Delete.** No `@media (prefers-color-scheme)` copy of the dark block: the
   inline script always sets an explicit attribute, so one block serves both
   the OS default and the override. No server-side preference, no cookie. No
   `-flat` tokens for browsers without `color-mix()`: the light fallback rule
   already paints a solid fill. The top bar, its pills and the brand keep their
   light values (already dark and measured).
3. **Simplify.** One attribute on `<html>`, one dark block per token family,
   one blocking script of about twenty lines that also follows a live OS
   change.
4. **Shorten the cycle.** The dark twins are the Spec 023 case rows measured
   with dark tokens; the script's decisions are unit-tested by running the
   inline script itself against a fake document.
5. **Automate last.** The DM4 test fails on any new token without a dark
   value or an invariant entry.

## Behavior

1. `apps/web/index.html` runs a blocking inline script before the stylesheet
   and the app. It reads `localStorage["osskb.theme"]` (`light`, `dark`,
   anything else or nothing means `system`), resolves `system` with
   `matchMedia("(prefers-color-scheme: dark)")`, and sets
   `document.documentElement.dataset.theme` to `light` or `dark`. A storage
   error counts as `system`. While the choice is `system`, a change of the OS
   preference re-applies it without a reload.
2. `:root[data-theme="dark"]` redefines every semantic, identity and data
   token, and sets `color-scheme: dark` (`:root` sets `light`). Theme-invariant:
   `--brand`'s value, the freshness pills, the series fills, the stroke width,
   fonts, type, spacing and radius scales.
3. The chart tooltip uses `--surface-popover` (light `#16161a`, the old value;
   dark `#2c2c35`, the highest layer).
4. `<meta name="theme-color">` has a light (`#16161a`) and a dark (`#101013`)
   entry by media query.
5. The design-system page lists every token's light and dark value.
6. Slice B: `window.__osskbTheme.choose()` (defined by the inline script) stores
   and applies a choice; `apps/web/src/theme.ts` is the app's typed handle and
   `ThemeControl.vue` the control. From 1440 px the options are text; below,
   icons (☀ ☾ ◐) with the same accessible names; at 420 px and below a single
   24 px button cycles light → dark → system. There the locale select is drawn
   as a short label ("EN" / "中文", never clipped; the invisible native select
   on top keeps its options, keyboard and accessible name "Language" / 語言),
   which also gives the community switcher room for "Apache Kafka" (112 px).
   The freshness pill is wider than before (53 → 68 px at 320, 108 → 123 px at
   375), so it never wraps to more lines.
   The short label's focus ring follows the select: `.locale-control:has(select:focus-visible)`,
   with `:focus-within` where `:has()` is unsupported. Chromium matches
   `:focus-visible` on a `<select>` after a mouse press too (as on text inputs),
   so there the ring also shows after a click, as it does on the community
   switcher. The zh-Hant group name is 外觀; 主題 is reserved for digest topics.
7. `theme-color`: while a stored choice overrides the OS, both entries carry
   the resolved top-bar colour; under System each media entry keeps its own.
8. Content-Security-Policy: none today. If one is added, the inline script
   needs its sha256 hash or a nonce in `script-src`; without it the page loses
   its theme before first paint (comment in `apps/web/index.html`).

## Acceptance

### Behavior
- DM1: given no stored choice, when the page loads under a dark OS, `data-theme` is `dark` and the page background `#18181d` before the app script has run (the script request held); under a light OS it is `light`; while no choice is stored, a live OS change flips the theme; a stored `light` or `dark` wins over the OS and survives a reload → unit test running the inline script, E2E.
- DM2: given the top bar, a radio group 淺色 / 深色 / 跟隨系統 (Light / Dark / System) applies a choice at once, stores `light` or `dark` in `osskb.theme` (System removes it), and the choice survives a reload; 跟隨系統 follows a live OS change; arrow keys move and select with the `--focus-ring-inverse` ring; when storage throws the choice holds for the session and an OS change does not override it; `theme-color` follows the resolved theme while a choice overrides the OS and the OS entries otherwise; at 420 px and below one button inside the top bar cycles the choice, the stale pill is at least as wide and no taller than in the bar without it, the short locale label (EN / 中文) sits inside the top bar without overlapping the community switcher, the theme button or the pill, is `aria-hidden` while the select keeps its name, and shows the focus ring when its select matches `:focus-visible` (after Tab; after a mouse press only where the browser shows it on a native select, as Chromium does), and each theme option has an `aria-label` → unit test running the inline script, E2E.
- DM3: given storage that throws, the page renders the OS theme with no console or page error → unit test, E2E.
- DM4: given `apps/web/styles.css`, every `:root` token has a dark value or matches the theme-invariant list, the dark blocks define no token that `:root` lacks, and every dark value is a literal → unit test.
- DM5: given each light colour pair of Spec 023 (DS1–DS10), its dark twin measures at or above the same floor with the dark tokens; dark progress stays wisteria and ΔE00 ≥ 10 from info and neutral under normal, protan and deutan vision → unit test over the case file.
- DM6: given the dark area tokens, every pair is ΔE00 ≥ 10 apart under normal, protan and deutan vision, none is orange, each is ≥ 3:1 on the dark card and ΔE00 ≥ 10 from every dark activity colour → unit test.
- DM7: given the stylesheet, the chart tooltip uses `--surface-popover`, the dark layers rise in lightness from top bar to popover, and the tooltip text and swatch outlines pass on it in both themes; on the rendered dark profile the tooltip is `#2c2c35` → unit test, E2E.
- DM8: given either theme, `color-scheme` matches it and `theme-color` has both media entries; every page (feed, detail, digest, proposals, both profiles) at 320 and 375 px shows the theme's page colour with no sideways scroll → unit test, E2E.
- DM9: given `docs/product/design-system.md`, every token with a dark value is listed with its light and dark value → unit test.

### Failure and retry
- DM3 covers storage failure. A failed or blocked inline script leaves the page light (the app cannot run without JavaScript either). Not otherwise applicable: no network or state.

### Budget
Not applicable: about 1 KB of inline script and one more `:root` block; no request.

### Observability
Not applicable: the gates are the unit and E2E tests above.

## Test plan

Generated from the case file by `bun run docs:test-plan`; the unit tests run
exactly these rows (light and dark ratio of every Spec 023 pair).

<!-- test-plan:start apps/web/test/dark-theme.cases.ts -->
| id | twin | pair | foreground | background | min | light | dark |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DM5 | DS1 | avatar initials on --avatar-1 (indigo) | --text-on-accent | --avatar-1 | 4.5 | 6.9 | 6.85 |
| DM5 | DS1 | avatar initials on --avatar-2 (green) | --text-on-accent | --avatar-2 | 4.5 | 5.2 | 8.42 |
| DM5 | DS1 | avatar initials on --avatar-3 (rust) | --text-on-accent | --avatar-3 | 4.5 | 5.44 | 8.44 |
| DM5 | DS1 | avatar initials on --avatar-4 (purple) | --text-on-accent | --avatar-4 | 4.5 | 7.37 | 7.53 |
| DM5 | DS1 | avatar initials on --avatar-5 (steel blue, legacy #3f7fa0 darkened) | --text-on-accent | --avatar-5 | 4.5 | 4.86 | 8.29 |
| DM5 | DS1 | avatar initials on --avatar-6 (brown) | --text-on-accent | --avatar-6 | 4.5 | 5.25 | 8.72 |
| DM5 | DS2 | GitHub source badge (.src-github) | --source-github | --source-github-tint | 4.5 | 7.49 | 7.22 |
| DM5 | DS2 | GitHub badge in the profile header (.person-meta .src-github) | --accent | --surface-selected | 4.5 | 6.11 | 5.26 |
| DM5 | DS5 | reviews given outline (千草) on the card | --data-given-stroke | --surface-card | 3 | 3.63 | 7.61 |
| DM5 | DS5 | own PRs and comments outline (苔) on the card | --data-github-stroke | --surface-card | 3 | 3.72 | 6.49 |
| DM5 | DS5 | reviews received outline (藤) on the card | --data-received-stroke | --surface-card | 3 | 3.48 | 4.64 |
| DM5 | DS5 | Jira outline (青碧) on the card | --data-jira-stroke | --surface-card | 3 | 4.3 | 7.15 |
| DM5 | DS5 | dev@ outline (今様) on the card | --data-mail-stroke | --surface-card | 3 | 3.91 | 5.15 |
| DM5 | DS5 | unrecorded hatch line on its base | --data-unrecorded-line | --data-unrecorded-bg | 3 | 3.1 | 3.01 |
| DM5 | DS5 | reviews given swatch outline in the tooltip | --data-given-stroke | --surface-popover | 3 | 4.98 | 6.5 |
| DM5 | DS5 | own PRs swatch outline in the tooltip | --data-github-stroke | --surface-popover | 3 | 4.84 | 5.54 |
| DM5 | DS5 | reviews received swatch outline in the tooltip | --data-received-stroke | --surface-popover | 3 | 5.18 | 3.97 |
| DM5 | DS5 | Jira swatch outline in the tooltip | --data-jira-stroke | --surface-popover | 3 | 4.2 | 6.11 |
| DM5 | DS5 | dev@ swatch outline in the tooltip | --data-mail-stroke | --surface-popover | 3 | 4.61 | 4.4 |
| DM5 | DS6 | area 1 (indigo) on the card | --data-area-1 | --surface-card | 3 | 6.9 | 5.73 |
| DM5 | DS6 | area 2 (rose) on the card | --data-area-2 | --surface-card | 3 | 6.03 | 7.37 |
| DM5 | DS6 | area 3 (green) on the card | --data-area-3 | --surface-card | 3 | 6.94 | 5.1 |
| DM5 | DS6 | area 4 (olive) on the card | --data-area-4 | --surface-card | 3 | 5.67 | 7.39 |
| DM5 | DS6 | area 5 (plum) on the card | --data-area-5 | --surface-card | 3 | 8.48 | 4.81 |
| DM5 | DS6 | area 6 (steel blue) on the card | --data-area-6 | --surface-card | 3 | 5.21 | 8.44 |
| DM5 | DS6 | area other (grey) on the card | --data-area-other | --surface-card | 3 | 4.75 | 4.57 |
| DM5 | DS7 | .examples-label | --text-muted | --surface-page | 4.5 | 5.06 | 6.63 |
| DM5 | DS7 | .filter-label | --text-muted | --surface-page | 4.5 | 5.06 | 6.63 |
| DM5 | DS7 | .card-project | --text-muted | --surface-page | 4.5 | 5.06 | 6.63 |
| DM5 | DS7 | .evidence-label | --text-muted | --surface-page | 4.5 | 5.06 | 6.63 |
| DM5 | DS7 | .topic-meta .k | --text-muted | --surface-page | 4.5 | 5.06 | 6.63 |
| DM5 | DS7 | .ai-item .n | --text-muted | --surface-page | 4.5 | 5.06 | 6.63 |
| DM5 | DS7 | .tl-period | --text-muted | --surface-page | 4.5 | 5.06 | 6.63 |
| DM5 | DS7 | .tl-foot | --text-muted | --surface-page | 4.5 | 5.06 | 6.63 |
| DM5 | DS7 | .rail-label | --text-muted | --surface-page | 4.5 | 5.06 | 6.63 |
| DM5 | DS7 | .rail-row .num | --text-muted | --surface-page | 4.5 | 5.06 | 6.63 |
| DM5 | DS7 | .rail-source > .num | --text-muted | --surface-page | 4.5 | 5.06 | 6.63 |
| DM5 | DS7 | .person-chart-table td.is-unrecorded | --text-muted | --surface-page | 4.5 | 5.06 | 6.63 |
| DM5 | DS7 | .person-tile-since | --text-muted | --surface-page | 4.5 | 5.06 | 6.63 |
| DM5 | DS7 | #q::placeholder | --text-muted | --surface-sunken | 4.5 | 5.29 | 6.36 |
| DM5 | DS7 | .filter-row .count | --text-muted | --surface-chip | 4.5 | 4.89 | 5.55 |
| DM5 | DS7 | .tl-time | --text-muted | --surface-flash | 4.5 | 5.19 | 5.62 |
| DM5 | DS7 | .person-unavailable | --text-danger | --surface-page | 4.5 | 4.93 | 8.69 |
| DM5 | DS7 | .brand-scope | --text-inverse-muted | --surface-inverse | 4.5 | 5.46 | 7.21 |
| DM5 | DS7 | .search-icon | --icon-muted | --surface-sunken | 3 | 3.1 | 4.56 |
| DM5 | DS7 | .source-link .ext | --icon-muted | --surface-card | 3 | 3.26 | 4.35 |
| DM5 | DS7 | .topbar :focus-visible | --focus-ring-inverse | --surface-inverse | 3 | 6.85 | 7.21 |
| DM5 | DS8 | .tl-filter .count | --text-muted | --surface-card | 4.5 | 5.56 | 6.07 |
| DM5 | DS8 | .tl-filter[aria-pressed="true"] .count | --accent | --surface-selected | 4.5 | 6.11 | 5.26 |
| DM5 | DS8 | .source-dot | --text-muted | --surface-chip | 4.5 | 4.89 | 5.55 |
| DM5 | DS8 | .source-dot.off | --text-muted | --surface-card | 4.5 | 5.56 | 6.07 |
| DM5 | DS8 | .keyword | --text-muted | --surface-chip | 4.5 | 4.89 | 5.55 |
| DM5 | DS5 | .bar | --data-bar-stroke | --surface-page | 3 | 5.04 | 7.92 |
| DM5 | DS9 | [data-state="success"] | --text-state-success | --surface-state-success | 4.5 | 6.59 | 7.82 |
| DM5 | DS9 | [data-state="info"] | --text-state-info | --surface-state-info | 4.5 | 7.14 | 7.71 |
| DM5 | DS9 | [data-state="warning"] | --text-state-warning | --surface-state-warning | 4.5 | 6.67 | 8.18 |
| DM5 | DS9 | [data-state="progress"] | --text-state-progress | --surface-state-progress | 4.5 | 4.62 | 5.09 |
| DM5 | DS9 | [data-state="neutral"] | --text-state-neutral | --surface-state-neutral | 4.5 | 5.19 | 6.75 |
| DM5 | DS9 | [data-state="danger"] | --text-state-danger | --surface-state-danger | 4.5 | 4.71 | 7.18 |
| DM5 | DS10 | .tag-chip[aria-pressed="true"] | --text-on-accent | --accent | 4.5 | 6.9 | 6.85 |
| DM5 | DS10 | .filters-badge | --text-on-accent | --accent | 4.5 | 6.9 | 6.85 |
| DM5 | DS10 | .trending-reason | --text-trending | --surface-card | 4.5 | 6.05 | 7.95 |
| DM5 | DS10 | .src-jira | --source-jira | --source-jira-tint | 4.5 | 5.77 | 7.29 |
| DM5 | DS10 | .src-mail | --source-mail | --source-mail-tint | 4.5 | 4.79 | 7.3 |
| DM5 | DS10 | .demo-pill | --text-pill | --surface-pill | 4.5 | 10.49 | 10.49 |
| DM5 | DS10 | .demo-pill.is-live | --text-pill-live | --surface-pill-live | 4.5 | 11.35 | 11.35 |
| DM5 | DS10 | .demo-pill.is-overdue | --text-pill-overdue | --surface-pill-overdue | 4.5 | 11.42 | 11.42 |
| DM5 | DS10 | .demo-pill.is-stale | --text-pill-stale | --surface-pill-stale | 4.5 | 10.82 | 10.82 |
| DM5 | DS10 | .digest-freshness.is-stale | --text-state-warning | --surface-state-warning | 4.5 | 6.67 | 8.18 |
| DM5 | DS10 | .digest-lag | --text-state-warning | --surface-page | 4.5 | 6.78 | 10.07 |
| DM5 | DS10 | .key-points-state.is-error | --text-danger | --surface-card | 4.5 | 5.42 | 7.95 |
| DM2 | — | .theme-option (theme toggle, unchecked) | --text-inverse-muted | --surface-inverse-raised | 4.5 | 4.9 | 6.44 |
| DM2 | — | .theme-option[aria-checked="true"] | --text-inverse | --border-inverse | 4.5 | 11.38 | 11.94 |
| DM2 | — | focus ring on the toggle (--focus-ring-inverse) | --focus-ring-inverse | --border-inverse | 3 | 4.75 | 5.25 |
| DM7 | — | .person-chart-tip (tooltip text) | --text-inverse | --surface-popover | 4.5 | 16.41 | 11.93 |
| DM7 | — | .person-chart-tip-note | --text-inverse-muted | --surface-popover | 4.5 | 5.46 | 5.25 |
<!-- test-plan:end -->

## Non-goals

- A per-account theme stored on a server.
- High-contrast or forced-colors themes.
- Changing the light palette.
