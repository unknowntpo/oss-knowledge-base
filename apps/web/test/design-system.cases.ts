/**
 * Spec 023 test plan: the single source for `design-system.test.ts` and for the table in
 * docs/specs/023-design-system/spec.md (`bun run docs:test-plan` regenerates it).
 *
 * Each row is a colour pair. `foreground` and `background` are a token of `apps/web/styles.css`
 * (`--name`, resolved through aliases, from `:root` or, for `theme: "dark"`, from
 * `:root[data-theme="dark"]` on top) or a literal; `#202027` is the dark card and `#16161a` the
 * tooltip. `ratio` is the measured WCAG 2.x contrast,
 * rounded to two decimals; the test fails when the stylesheet's value no longer gives it or
 * when it is below `min`. DS7 rows name a selector in `pair`: its rule's `color` (or, for a focus
 * ring, `outline-color`) must be that `foreground`, and `background` is the lightest surface it sits
 * on (page, sunken field, chip on hover, the flashed timeline card); `surface` says which, and when
 * it is the conservative (darker) choice. Text needs 4.5:1; an icon glyph or a focus ring 3:1.
 * DS8 rows bind the same way; they cover text that used `opacity` or `--chip-text` before slice 4.
 */
export const testPlanRows = [
  { id: "DS1", theme: "light", pair: "avatar initials on --avatar-1 (indigo)", foreground: "--text-on-accent", background: "--avatar-1", surface: "", min: 4.5, ratio: 6.9 },
  { id: "DS1", theme: "light", pair: "avatar initials on --avatar-2 (green)", foreground: "--text-on-accent", background: "--avatar-2", surface: "", min: 4.5, ratio: 5.2 },
  { id: "DS1", theme: "light", pair: "avatar initials on --avatar-3 (rust)", foreground: "--text-on-accent", background: "--avatar-3", surface: "", min: 4.5, ratio: 5.44 },
  { id: "DS1", theme: "light", pair: "avatar initials on --avatar-4 (purple)", foreground: "--text-on-accent", background: "--avatar-4", surface: "", min: 4.5, ratio: 7.37 },
  { id: "DS1", theme: "light", pair: "avatar initials on --avatar-5 (steel blue, legacy #3f7fa0 darkened)", foreground: "--text-on-accent", background: "--avatar-5", surface: "", min: 4.5, ratio: 4.86 },
  { id: "DS1", theme: "light", pair: "avatar initials on --avatar-6 (brown)", foreground: "--text-on-accent", background: "--avatar-6", surface: "", min: 4.5, ratio: 5.25 },
  { id: "DS2", theme: "light", pair: "GitHub source badge (.src-github)", foreground: "--source-github", background: "--source-github-tint", surface: "", min: 4.5, ratio: 7.49 },
  { id: "DS2", theme: "light", pair: "GitHub badge in the profile header (.person-meta .src-github)", foreground: "--accent", background: "--surface-selected", surface: "", min: 4.5, ratio: 6.11 },
  { id: "DS5", theme: "light", pair: "reviews given outline (千草) on the card", foreground: "--data-given-stroke", background: "--surface-card", surface: "", min: 3, ratio: 3.63 },
  { id: "DS5", theme: "light", pair: "own PRs and comments outline (苔) on the card", foreground: "--data-github-stroke", background: "--surface-card", surface: "", min: 3, ratio: 3.72 },
  { id: "DS5", theme: "light", pair: "reviews received outline (藤) on the card", foreground: "--data-received-stroke", background: "--surface-card", surface: "", min: 3, ratio: 3.48 },
  { id: "DS5", theme: "light", pair: "Jira outline (青碧) on the card", foreground: "--data-jira-stroke", background: "--surface-card", surface: "", min: 3, ratio: 4.3 },
  { id: "DS5", theme: "light", pair: "dev@ outline (今様) on the card", foreground: "--data-mail-stroke", background: "--surface-card", surface: "", min: 3, ratio: 3.91 },
  { id: "DS5", theme: "light", pair: "unrecorded hatch line on its base", foreground: "--data-unrecorded-line", background: "--data-unrecorded-bg", surface: "", min: 3, ratio: 3.1 },
  { id: "DS5", theme: "light", pair: "reviews given swatch outline in the tooltip", foreground: "--data-given-stroke", background: "--surface-inverse", surface: "", min: 3, ratio: 4.98 },
  { id: "DS5", theme: "light", pair: "own PRs swatch outline in the tooltip", foreground: "--data-github-stroke", background: "--surface-inverse", surface: "", min: 3, ratio: 4.84 },
  { id: "DS5", theme: "light", pair: "reviews received swatch outline in the tooltip", foreground: "--data-received-stroke", background: "--surface-inverse", surface: "", min: 3, ratio: 5.18 },
  { id: "DS5", theme: "light", pair: "Jira swatch outline in the tooltip", foreground: "--data-jira-stroke", background: "--surface-inverse", surface: "", min: 3, ratio: 4.2 },
  { id: "DS5", theme: "light", pair: "dev@ swatch outline in the tooltip", foreground: "--data-mail-stroke", background: "--surface-inverse", surface: "", min: 3, ratio: 4.61 },
  { id: "DS5", theme: "dark", pair: "reviews given outline (勿忘草) on the dark card", foreground: "--data-given-stroke", background: "#202027", surface: "", min: 3, ratio: 7.61 },
  { id: "DS5", theme: "dark", pair: "own PRs outline (柳茶) on the dark card", foreground: "--data-github-stroke", background: "#202027", surface: "", min: 3, ratio: 6.49 },
  { id: "DS5", theme: "dark", pair: "reviews received outline (藤) on the dark card", foreground: "--data-received-stroke", background: "#202027", surface: "", min: 3, ratio: 4.64 },
  { id: "DS5", theme: "dark", pair: "Jira outline (水浅葱) on the dark card", foreground: "--data-jira-stroke", background: "#202027", surface: "", min: 3, ratio: 7.15 },
  { id: "DS5", theme: "dark", pair: "dev@ outline (紅梅) on the dark card", foreground: "--data-mail-stroke", background: "#202027", surface: "", min: 3, ratio: 5.15 },
  { id: "DS5", theme: "dark", pair: "unrecorded hatch line on its dark base", foreground: "--data-unrecorded-line", background: "--data-unrecorded-bg", surface: "", min: 3, ratio: 3.01 },
  { id: "DS6", theme: "light", pair: "area 1 (indigo) on the card", foreground: "--data-area-1", background: "--surface-card", surface: "", min: 3, ratio: 6.9 },
  { id: "DS6", theme: "light", pair: "area 2 (rose) on the card", foreground: "--data-area-2", background: "--surface-card", surface: "", min: 3, ratio: 6.03 },
  { id: "DS6", theme: "light", pair: "area 3 (green) on the card", foreground: "--data-area-3", background: "--surface-card", surface: "", min: 3, ratio: 6.94 },
  { id: "DS6", theme: "light", pair: "area 4 (olive) on the card", foreground: "--data-area-4", background: "--surface-card", surface: "", min: 3, ratio: 5.67 },
  { id: "DS6", theme: "light", pair: "area 5 (plum) on the card", foreground: "--data-area-5", background: "--surface-card", surface: "", min: 3, ratio: 8.48 },
  { id: "DS6", theme: "light", pair: "area 6 (steel blue) on the card", foreground: "--data-area-6", background: "--surface-card", surface: "", min: 3, ratio: 5.21 },
  { id: "DS6", theme: "light", pair: "area other (grey) on the card", foreground: "--data-area-other", background: "--surface-card", surface: "", min: 3, ratio: 4.75 },
  { id: "DS7", theme: "light", pair: ".examples-label", foreground: "--text-muted", background: "--surface-page", surface: "the page: the darker of page and card, so the card passes too", min: 4.5, ratio: 5.06 },
  { id: "DS7", theme: "light", pair: ".filter-label", foreground: "--text-muted", background: "--surface-page", surface: "the page: the darker of page and card, so the card passes too", min: 4.5, ratio: 5.06 },
  { id: "DS7", theme: "light", pair: ".card-project", foreground: "--text-muted", background: "--surface-page", surface: "the page: the darker of page and card, so the card passes too", min: 4.5, ratio: 5.06 },
  { id: "DS7", theme: "light", pair: ".evidence-label", foreground: "--text-muted", background: "--surface-page", surface: "the page: the darker of page and card, so the card passes too", min: 4.5, ratio: 5.06 },
  { id: "DS7", theme: "light", pair: ".topic-meta .k", foreground: "--text-muted", background: "--surface-page", surface: "the page: the darker of page and card, so the card passes too", min: 4.5, ratio: 5.06 },
  { id: "DS7", theme: "light", pair: ".ai-item .n", foreground: "--text-muted", background: "--surface-page", surface: "the page: the darker of page and card, so the card passes too", min: 4.5, ratio: 5.06 },
  { id: "DS7", theme: "light", pair: ".tl-period", foreground: "--text-muted", background: "--surface-page", surface: "the page: the darker of page and card, so the card passes too", min: 4.5, ratio: 5.06 },
  { id: "DS7", theme: "light", pair: ".tl-foot", foreground: "--text-muted", background: "--surface-page", surface: "the page: the darker of page and card, so the card passes too", min: 4.5, ratio: 5.06 },
  { id: "DS7", theme: "light", pair: ".rail-label", foreground: "--text-muted", background: "--surface-page", surface: "the page: the darker of page and card, so the card passes too", min: 4.5, ratio: 5.06 },
  { id: "DS7", theme: "light", pair: ".rail-row .num", foreground: "--text-muted", background: "--surface-page", surface: "the page: the darker of page and card, so the card passes too", min: 4.5, ratio: 5.06 },
  { id: "DS7", theme: "light", pair: ".rail-source > .num", foreground: "--text-muted", background: "--surface-page", surface: "the page: the darker of page and card, so the card passes too", min: 4.5, ratio: 5.06 },
  { id: "DS7", theme: "light", pair: ".person-chart-table td.is-unrecorded", foreground: "--text-muted", background: "--surface-page", surface: "the page: the darker of page and card, so the card passes too", min: 4.5, ratio: 5.06 },
  { id: "DS7", theme: "light", pair: ".person-tile-since", foreground: "--text-muted", background: "--surface-page", surface: "the page: the darker of page and card, so the card passes too", min: 4.5, ratio: 5.06 },
  { id: "DS7", theme: "light", pair: "#q::placeholder", foreground: "--text-muted", background: "--surface-sunken", surface: "", min: 4.5, ratio: 5.29 },
  { id: "DS7", theme: "light", pair: ".filter-row .count", foreground: "--text-muted", background: "--surface-chip", surface: "the chip (for facet rows, the hover background), darker than page and card", min: 4.5, ratio: 4.89 },
  { id: "DS7", theme: "light", pair: ".tl-time", foreground: "--text-muted", background: "#fdf7e3", surface: "the flashed timeline card, the darkest it sits on", min: 4.5, ratio: 5.19 },
  { id: "DS7", theme: "light", pair: ".person-unavailable", foreground: "--text-danger", background: "--surface-page", surface: "the page: the darker of page and card, so the card passes too", min: 4.5, ratio: 4.93 },
  { id: "DS7", theme: "light", pair: ".brand-scope", foreground: "--text-inverse-muted", background: "--surface-inverse", surface: "", min: 4.5, ratio: 5.46 },
  { id: "DS7", theme: "light", pair: ".search-icon", foreground: "--icon-muted", background: "--surface-sunken", surface: "", min: 3, ratio: 3.1 },
  { id: "DS7", theme: "light", pair: ".source-link .ext", foreground: "--icon-muted", background: "--surface-card", surface: "", min: 3, ratio: 3.26 },
  { id: "DS7", theme: "light", pair: ".topbar :focus-visible", foreground: "--focus-ring-inverse", background: "--surface-inverse", surface: "", min: 3, ratio: 6.85 },
  { id: "DS8", theme: "light", pair: ".tl-filter .count", foreground: "--text-muted", background: "--surface-card", surface: "the filter button; was opacity 0.7, 3.61:1", min: 4.5, ratio: 5.56 },
  { id: "DS8", theme: "light", pair: ".tl-filter[aria-pressed=\"true\"] .count", foreground: "--accent", background: "--surface-selected", surface: "the pressed filter; was opacity 0.7, 3.25:1", min: 4.5, ratio: 6.11 },
  { id: "DS8", theme: "light", pair: ".source-dot", foreground: "--text-muted", background: "--surface-chip", surface: "the chip; was --chip-text #6f6c76, 4.52:1", min: 4.5, ratio: 4.89 },
  { id: "DS8", theme: "light", pair: ".source-dot.off", foreground: "--text-muted", background: "--surface-card", surface: "the card (no fill, outlined); was opacity 0.35", min: 4.5, ratio: 5.56 },
  { id: "DS8", theme: "light", pair: ".keyword", foreground: "--text-muted", background: "--surface-chip", surface: "the chip; was --chip-text", min: 4.5, ratio: 4.89 },
  { id: "DS5", theme: "light", pair: ".bar", foreground: "--data-bar-stroke", background: "--surface-page", surface: "the page: the feed-detail rail sits on it, darker than a card", min: 3, ratio: 5.04 },
  { id: "DS9", theme: "light", pair: "[data-state=\"success\"]", foreground: "--text-state-success", background: "--surface-state-success", surface: "the badge's own tint", min: 4.5, ratio: 6.59 },
  { id: "DS9", theme: "light", pair: "[data-state=\"info\"]", foreground: "--text-state-info", background: "--surface-state-info", surface: "the badge's own tint", min: 4.5, ratio: 7.14 },
  { id: "DS9", theme: "light", pair: "[data-state=\"warning\"]", foreground: "--text-state-warning", background: "--surface-state-warning", surface: "the badge's own tint", min: 4.5, ratio: 6.67 },
  { id: "DS9", theme: "light", pair: "[data-state=\"progress\"]", foreground: "--text-state-progress", background: "--surface-state-progress", surface: "the badge's own tint", min: 4.5, ratio: 4.79 },
  { id: "DS9", theme: "light", pair: "[data-state=\"neutral\"]", foreground: "--text-state-neutral", background: "--surface-state-neutral", surface: "the badge's own tint", min: 4.5, ratio: 5.19 },
  { id: "DS9", theme: "light", pair: "[data-state=\"danger\"]", foreground: "--text-state-danger", background: "--surface-state-danger", surface: "the badge's own tint", min: 4.5, ratio: 4.71 },
  { id: "DS10", theme: "light", pair: ".tag-chip[aria-pressed=\"true\"]", foreground: "--text-on-accent", background: "--accent", surface: "the pressed chip's accent fill", min: 4.5, ratio: 6.9 },
  { id: "DS10", theme: "light", pair: ".filters-badge", foreground: "--text-on-accent", background: "--accent", surface: "its accent fill", min: 4.5, ratio: 6.9 },
  { id: "DS10", theme: "light", pair: ".trending-reason", foreground: "--text-trending", background: "--surface-card", surface: "the card", min: 4.5, ratio: 6.05 },
  { id: "DS10", theme: "light", pair: ".src-jira", foreground: "--source-jira", background: "--source-jira-tint", surface: "its own tint", min: 4.5, ratio: 5.77 },
  { id: "DS10", theme: "light", pair: ".src-mail", foreground: "--source-mail", background: "--source-mail-tint", surface: "its own tint", min: 4.5, ratio: 4.79 },
  { id: "DS10", theme: "light", pair: ".demo-pill", foreground: "--text-pill", background: "--surface-pill", surface: "its own fill on the top bar", min: 4.5, ratio: 10.49 },
  { id: "DS10", theme: "light", pair: ".demo-pill.is-live", foreground: "--text-pill-live", background: "--surface-pill-live", surface: "its own fill", min: 4.5, ratio: 11.35 },
  { id: "DS10", theme: "light", pair: ".demo-pill.is-overdue", foreground: "--text-pill-overdue", background: "--surface-pill-overdue", surface: "its own fill", min: 4.5, ratio: 11.42 },
  { id: "DS10", theme: "light", pair: ".demo-pill.is-stale", foreground: "--text-pill-stale", background: "--surface-pill-stale", surface: "its own fill", min: 4.5, ratio: 10.82 },
  { id: "DS10", theme: "light", pair: ".digest-freshness.is-stale", foreground: "--text-state-warning", background: "--surface-state-warning", surface: "its own tint", min: 4.5, ratio: 6.67 },
  { id: "DS10", theme: "light", pair: ".digest-lag", foreground: "--text-state-warning", background: "--surface-page", surface: "the page: darker than a card", min: 4.5, ratio: 6.78 },
  { id: "DS10", theme: "light", pair: ".key-points-state.is-error", foreground: "--text-danger", background: "--surface-card", surface: "the key-points card; was #a3542a", min: 4.5, ratio: 5.42 },
] as const;

/** DS1: authors from the E2E fixture and the hue the legacy viewer's hash gives them. */
export const authorHues = [
  { author: "bob", hue: 2 },
  { author: "alice", hue: 1 },
] as const;

/** DS4: the activity series the owner chose on 2026-10-17 (方案二・透明感), per theme. */
export const activityPalette = {
  light: {
    "--data-given-fill": "#7db9de", "--data-given-alpha": "55%", "--data-given-stroke": "#3a8fb7",
    "--data-github-fill": "#91ad70", "--data-github-alpha": "50%", "--data-github-stroke": "#838a2d",
    "--data-received-fill": "#8b81c3", "--data-received-alpha": "30%", "--data-received-stroke": "#8b81c3",
    "--data-unrecorded-line": "#928e86", "--data-unrecorded-bg": "#faf9f7", "--data-stroke-width": "1.2px",
  },
  dark: {
    "--data-given-fill": "#7db9de", "--data-given-alpha": "25%", "--data-given-stroke": "#7db9de",
    "--data-github-fill": "#91ad70", "--data-github-alpha": "25%", "--data-github-stroke": "#91ad70",
    "--data-received-fill": "#8b81c3", "--data-received-alpha": "22%", "--data-received-stroke": "#8b81c3",
    "--data-unrecorded-line": "#716e7a", "--data-unrecorded-bg": "#26262e", "--data-stroke-width": "1.2px",
  },
} as const;

/** DS6: the area categories in slice order, and the floors they keep. */
export const areaTokens = ["--data-area-1", "--data-area-2", "--data-area-3", "--data-area-4", "--data-area-5", "--data-area-6", "--data-area-other"] as const;
export const AREA_MIN_DELTA_E = 10;
/** The activity chart's colours on the same profile page, which no area colour may come near. */
export const activityColourTokens = ["--data-given-fill", "--data-given-stroke", "--data-github-fill", "--data-github-stroke", "--data-received-fill", "--data-received-stroke", "--data-unrecorded-line"] as const;

/** DS9: every status and proposal stage the app shows, and the badge state it maps to. */
export const badgeStates = [
  { key: "adopted", state: "success" }, { key: "accepted", state: "success" }, { key: "merged", state: "success" },
  { key: "resolved", state: "success" }, { key: "implementing", state: "success" },
  { key: "open", state: "info" }, { key: "discuss", state: "info" },
  { key: "early", state: "warning" }, { key: "vote", state: "warning" },
  { key: "discussing", state: "progress" },
  { key: "dropped", state: "neutral" }, { key: "rejected", state: "neutral" }, { key: "closed", state: "neutral" },
  { key: "something-new", state: "neutral" },
] as const;
