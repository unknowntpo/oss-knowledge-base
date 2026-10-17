# ADR-0017: State the visual language as a tested design system

- Status: Accepted
- Date: 2026-10-17
- Spec: Spec 023 (design system for the web app)
- Related: constitution §6

## Context

Constitution §6 requires new screens to keep the legacy visual language
(typography, palette, spacing rhythm, content-focused character), but the
only written statement of that language was one comment at the top of
`apps/web/styles.css`. Without roles, each feature picked colours by
example. The 2026-10-17 design audit traced the profile chart's 1.78:1
"reviews received" colour, 25 text rules below 4.5:1, and a GitHub badge
recoloured by a profile rule to that gap. The owner approved the audit's
proposal on 2026-10-17.

## Decision

- `docs/product/design-system.md` states the visual language as semantic
  tokens, data-viz palettes and rules, with measured contrast.
- `apps/web/test/design-system.test.ts` checks every colour pair listed in
  `apps/web/test/design-system.cases.ts` and the rules a test can see (no
  data aliases, no faded text, CVD separation, token references).
- Constitution §6 links to the design system. The principle itself is
  unchanged: the visual language is still the one to preserve; the link
  says where it is written down.

## Consequences

- A new colour needs a role, a case row and an entry in the design system;
  the test fails otherwise.
- A dark theme (gardening G89, G92) redefines the semantic and data blocks
  and adds dark case rows.
- Compatibility: no data format, API or route changes. The visible changes
  of Spec 023 are the contrast fixes (slices 1, 3, 4), the profile chart and
  area donut palettes the owner chose (slice 2), and the unified badge
  states (slice 5).

## Revisit when

- A second web app or a component library needs the same tokens (then move
  them to a shared package with a primitive layer).
