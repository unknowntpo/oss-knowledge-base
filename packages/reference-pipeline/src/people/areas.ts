/**
 * Spec 019 Behavior 6 (areas amendment, W46–W50): the one area taxonomy and the one area
 * aggregation of the contributor profile. Fed by review metadata (Spec 022 `metadata@2`: the
 * labels of reviewed pull requests) and by the activity log (slice 2b: the labels of threads), so
 * a label is an area or a process label in the same way everywhere.
 *
 * Measured 2026-10-15 on the pull requests updated 2026-09-15..2026-10-14 (Kafka 603, DataFusion
 * 2,293) and each repository's label list and auto-labeler configuration: the areas are the
 * path-based labels the labeler sets; the process labels describe review status, size, lifecycle,
 * release, issue type or onboarding. Unknown labels count as areas, so a new path label shows up
 * without a code change; a new process label needs an entry here.
 */
import { DATAFUSION_DIGEST_PROFILE, KAFKA_DIGEST_PROFILE } from "../digest/profiles";

export interface AreaTaxonomy {
  /** Labels that describe the process, not an area (exact names). */
  readonly processLabels: readonly string[];
  /** Labels matching this are process labels too (DataFusion's release labels `v55.0.0`). */
  readonly processLabelPattern?: RegExp;
  /** Labels naming a KIP (`KIP-932`, `kip-1332`): counted as that KIP, not as an area. */
  readonly kipLabelPattern?: RegExp;
}

/** Per community. Kafka: `.github/configs/labeler.yml`; DataFusion: `.github/workflows/labeler/labeler-config.yml`. */
export const AREA_TAXONOMIES: Readonly<Record<string, AreaTaxonomy>> = {
  [KAFKA_DIGEST_PROFILE.projectId]: {
    processLabels: [
      // Review status (set by `pr-update.yml`, cleared by `pr-labels-cron.yml`).
      "triage", "needs-attention", "ci-approved",
      // Size, lifecycle, release management, administration.
      "small", "stale", "closed-stale", "do-not-merge", "backport-candidate", "Blocker", "admin", "ctr", "uniform2",
      // The generic KIP marker; a numbered KIP label is a KIP (below).
      "kip",
    ],
    kipLabelPattern: /^kip-(\d+)$/iu,
  },
  [DATAFUSION_DIGEST_PROFILE.projectId]: {
    processLabels: [
      // API compatibility, lifecycle and status.
      "api change", "auto detected api change", "Stale", "review:waiting", "waiting-on-upstream", "backport",
      // Issue type and onboarding.
      "bug", "enhancement", "regression", "question", "discussion", "EPIC", "PROPOSAL EPIC", "tech debt", "good first issue", "help wanted",
      // Dependency bumps by bot, and the bot's ecosystem labels.
      "auto-dependencies", "rust", "javascript", "python:uv",
    ],
    processLabelPattern: /^v\d+\.\d+\.\d+$/u,
  },
};

const NO_TAXONOMY: AreaTaxonomy = { processLabels: [] };

export function areaTaxonomy(projectId: string): AreaTaxonomy {
  return AREA_TAXONOMIES[projectId] ?? NO_TAXONOMY;
}

export function isProcessLabel(label: string, taxonomy: AreaTaxonomy): boolean {
  return taxonomy.processLabels.includes(label) || (taxonomy.processLabelPattern?.test(label) ?? false);
}

/** One pull request's or thread's areas after the taxonomy: area labels, and KIP ids (from the title and from KIP labels). */
export interface ItemAreas {
  readonly labels: readonly string[];
  readonly kips: readonly string[];
}

/** W46: raw label names and title KIP ids → area labels and KIP ids, each sorted and unique. */
export function itemAreas(labels: readonly string[], kips: readonly string[], taxonomy: AreaTaxonomy): ItemAreas {
  const areas = new Set<string>();
  const ids = new Set(kips);
  for (const label of labels) {
    const kip = taxonomy.kipLabelPattern?.exec(label);
    if (kip !== null && kip !== undefined) ids.add(`KIP-${kip[1]}`);
    else if (!isProcessLabel(label, taxonomy)) areas.add(label);
  }
  return { labels: [...areas].sort(), kips: [...ids].sort((a, b) => Number(a.slice(4)) - Number(b.slice(4))) };
}

/** Slices drawn before the rest is grouped as "other" (W48). */
export const AREA_SLICES = 6;

export interface AreaCount {
  readonly label: string;
  /** Distinct pull requests or threads carrying the label. */
  readonly items: number;
}

export interface AreaDistribution {
  /** Items (pull requests or threads) counted. */
  readonly items: number;
  /** Items with no area label (only process labels, or none). */
  readonly unlabelled: number;
  /** Label assignments: an item with several area labels counts once in each (W47). */
  readonly assignments: number;
  /** Every area, most items first, ties by name. */
  readonly areas: readonly AreaCount[];
  /** The first `AREA_SLICES` areas, then "other" holding the rest's assignments (absent when nothing is left). */
  readonly slices: readonly (AreaCount & { readonly other?: true })[];
  readonly kips: readonly { readonly kip: string; readonly items: number }[];
}

/**
 * W47: the area distribution of a set of items. Items are deduplicated by `key`; an item counts
 * once in each of its area labels; process labels never count; KIP ids are counted apart.
 */
export function areaDistribution(items: readonly ({ readonly key: string } & ItemAreas)[], taxonomy: AreaTaxonomy, slices = AREA_SLICES): AreaDistribution {
  const seen = new Map<string, ItemAreas>();
  for (const item of items) seen.set(item.key, itemAreas(item.labels, item.kips, taxonomy));
  const labels = new Map<string, number>();
  const kips = new Map<string, number>();
  let unlabelled = 0;
  for (const areas of seen.values()) {
    if (areas.labels.length === 0) unlabelled += 1;
    for (const label of areas.labels) labels.set(label, (labels.get(label) ?? 0) + 1);
    for (const kip of areas.kips) kips.set(kip, (kips.get(kip) ?? 0) + 1);
  }
  const areas = [...labels].map(([label, count]) => ({ label, items: count }))
    .sort((a, b) => b.items - a.items || a.label.localeCompare(b.label));
  const rest = areas.slice(slices).reduce((sum, area) => sum + area.items, 0);
  return {
    items: seen.size,
    unlabelled,
    assignments: areas.reduce((sum, area) => sum + area.items, 0),
    areas,
    slices: [...areas.slice(0, slices), ...(rest === 0 ? [] : [{ label: "", items: rest, other: true as const }])],
    kips: [...kips].map(([kip, count]) => ({ kip, items: count }))
      .sort((a, b) => b.items - a.items || Number(a.kip.slice(4)) - Number(b.kip.slice(4))),
  };
}

/** The areas of one reviewed pull request, as the profile response carries them (`pullAreas`). */
export interface PullAreasV1 {
  readonly labels: readonly string[];
  readonly kips?: readonly string[];
}

export interface ProfileAreaSide {
  /** Distinct pull requests in the period. */
  readonly pullRequests: number;
  /** Of them, with stored metadata. The chart is drawn only when equal (W49). */
  readonly covered: number;
  readonly distribution: AreaDistribution;
}

/**
 * W47–W49: the areas of the pull requests a person reviewed (`given`) and of their own pull
 * requests others reviewed (`received`), in the rows of one period. A pull request without stored
 * metadata is counted in `pullRequests` and not in `covered`; the distribution holds the covered ones.
 */
export function profileAreaSide(prs: readonly number[], pullAreas: Readonly<Record<string, PullAreasV1>>, taxonomy: AreaTaxonomy): ProfileAreaSide {
  const distinct = [...new Set(prs)];
  const covered = distinct.filter((pr) => pullAreas[String(pr)] !== undefined);
  return {
    pullRequests: distinct.length,
    covered: covered.length,
    distribution: areaDistribution(covered.map((pr) => ({ key: String(pr), labels: pullAreas[String(pr)]!.labels, kips: pullAreas[String(pr)]!.kips ?? [] })), taxonomy),
  };
}
