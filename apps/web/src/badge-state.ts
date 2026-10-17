/**
 * Spec 023 DS9: one badge system for the feed and the digest. Every status (feed, search, topic
 * threads) and proposal stage is shown as one of six semantic states; the colours live in
 * `--text-state-*` / `--surface-state-*` (apps/web/styles.css, docs/product/design-system.md).
 */
export type BadgeState = "success" | "info" | "warning" | "progress" | "neutral" | "danger";

export const BADGE_STATES: readonly BadgeState[] = ["success", "info", "warning", "progress", "neutral", "danger"];

const STATE_OF: Readonly<Record<string, BadgeState>> = {
  // done, accepted, landed
  adopted: "success",
  accepted: "success",
  merged: "success",
  resolved: "success",
  implementing: "success",
  // in the open, waiting for work
  open: "info",
  discuss: "info",
  // needs attention: early adoption, a vote in progress
  early: "warning",
  vote: "warning",
  // under discussion (dev@ threads, KIPs being discussed)
  discussing: "progress",
  // ended without landing
  dropped: "neutral",
  rejected: "neutral",
  closed: "neutral",
};

/** The badge state of a status or proposal stage key; an unknown key is neutral. `danger` is for errors. */
export function badgeState(key: string | null | undefined): BadgeState {
  return (key !== null && key !== undefined && Object.hasOwn(STATE_OF, key)) ? STATE_OF[key]! : "neutral";
}
