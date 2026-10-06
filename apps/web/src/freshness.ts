export interface FeedFreshness {
  readonly labelKey: "freshness.justNow" | "freshness.minutes" | "freshness.hours";
  readonly value: number;
  readonly stale: boolean;
}

/** Three missed hourly publications (Spec 010). */
export const STALE_AFTER_MS = 3 * 60 * 60_000;

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
  return { labelKey: "freshness.hours", value: Math.floor(minutes / 60), stale };
}

/** The topbar text for a freshness; stale data names the out-of-date warning instead. */
export function freshnessText(
  freshness: FeedFreshness,
  t: (key: string, variables?: Readonly<Record<string, string | number>>) => string,
): string {
  return t(freshness.stale ? "freshness.stale" : freshness.labelKey, { n: freshness.value });
}
