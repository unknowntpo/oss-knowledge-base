export interface FeedFreshness {
  readonly labelKey: "freshness.justNow" | "freshness.minutes" | "freshness.hours" | "freshness.days";
  readonly value: number;
  readonly stale: boolean;
}

/** Spec 018: the publisher's Cron fires once a day; a config test holds the two together. */
export const PUBLICATION_CADENCE_MS = 24 * 60 * 60_000;
/** Room for a late run and its three retries (10, 30, 60 min, up to 15 min each) before the page calls a stall. */
export const STALE_GRACE_MS = 3 * 60 * 60_000;
/** One missed daily publication plus the grace (Spec 010 Behavior 2): 27 h. */
export const STALE_AFTER_MS = PUBLICATION_CADENCE_MS + STALE_GRACE_MS;

/** Spec 010: age of `metadata.manifest.generatedAt` relative to the browser clock. */
export function feedFreshness(generatedAt: unknown, now: number): FeedFreshness | undefined {
  const published = typeof generatedAt === "string" ? Date.parse(generatedAt) : Number.NaN;
  if (Number.isNaN(published)) return undefined;
  // A clock behind the publisher reads as "just now" rather than a negative age.
  const age = Math.max(0, now - published);
  const minutes = Math.floor(age / 60_000);
  const stale = age > STALE_AFTER_MS;
  if (minutes === 0) return { labelKey: "freshness.justNow", value: 0, stale };
  if (minutes < 60) return { labelKey: "freshness.minutes", value: minutes, stale };
  const hours = Math.floor(minutes / 60);
  // From two days on a stall reads in days ("7 d ago", not "168 h ago"); such an age is always stale.
  if (hours < 2 * 24) return { labelKey: "freshness.hours", value: hours, stale };
  return { labelKey: "freshness.days", value: Math.floor(hours / 24), stale };
}

/** The topbar text for a freshness; stale data names the out-of-date warning instead. */
export function freshnessText(
  freshness: FeedFreshness,
  t: (key: string, variables?: Readonly<Record<string, string | number>>) => string,
): string {
  const staleKey = freshness.labelKey === "freshness.days" ? "freshness.staleDays" : "freshness.stale";
  return t(freshness.stale ? staleKey : freshness.labelKey, { n: freshness.value });
}
