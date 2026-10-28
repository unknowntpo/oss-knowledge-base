/**
 * Spec 014 D109–D112: features that show the experimental label (`components/ExperimentalLabel.vue`).
 *
 * One entry per feature that is live but has not passed its quality gate. The label renders only for
 * an id listed here, so a feature leaves the label by deleting its entry, in the PR that records its
 * gate as passed. `note` is an i18n key (both locales in `apps/web/i18n.js`) for the one-line note
 * next to the badge; `until` names the gate that removes the entry. See docs/feature-map.md,
 * "Experimental label".
 */
export interface ExperimentalFeature {
  readonly note: string;
  readonly until: string;
}

export const EXPERIMENTAL_FEATURES: Readonly<Record<string, ExperimentalFeature>> = {
  // Owner decision 2026-10-28: on Prod before D102 passed (drift 1, omission 2, term 6 on the Dev 2026-10-23 week).
  digest: { note: "experimental.note.digest", until: "Spec 014 D34 and D102 pass on a labeled week" },
};

/** The entry for `id`, or undefined when the feature is not experimental (inherited keys never match). */
export function experimentalFeature(id: string): ExperimentalFeature | undefined {
  return Object.hasOwn(EXPERIMENTAL_FEATURES, id) ? EXPERIMENTAL_FEATURES[id] : undefined;
}
