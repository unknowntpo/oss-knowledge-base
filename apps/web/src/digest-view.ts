/**
 * Spec 014 slice 3: pure helpers behind the This week, Proposals, and topic pages. Profiles,
 * counts, and the window label come from the reference pipeline, so the page and the digest job
 * cannot disagree (Behavior 23, 26).
 */
import {
  DATAFUSION_DIGEST_PROFILE,
  digestCounts,
  KAFKA_DIGEST_PROFILE,
  lagLabel,
  windowLabel,
  type DigestProfile,
  type DigestThread,
  type DigestV1,
  type ProposalRow,
} from "@oss-knowledge-base/reference-pipeline/digest";

export { digestCounts, windowLabel };

/** The digest as `/api/digest` serves it: cache fields removed, locale fallback flagged. */
export type ServedDigest = Omit<DigestV1, "features" | "translations"> & { readonly localeFallback: boolean };

export interface WebProject {
  readonly profile: DigestProfile;
  readonly name: string;
}

export const PROJECTS: readonly WebProject[] = [
  { profile: KAFKA_DIGEST_PROFILE, name: "Apache Kafka" },
  { profile: DATAFUSION_DIGEST_PROFILE, name: "Apache DataFusion" },
];

export const DEFAULT_PROJECT_KEY = "kafka";
export const LAST_PROJECT_KEY = "community-kb-project";

export function projectByKey(key: string | undefined): WebProject | undefined {
  return PROJECTS.find((project) => project.profile.projectKey === key);
}

/** Behavior 27: bare `/#/` opens the last selected project; storage may be unavailable. */
export function lastProjectKey(storage: Pick<Storage, "getItem"> | undefined): string {
  try {
    const saved = storage?.getItem(LAST_PROJECT_KEY) ?? null;
    if (saved !== null && projectByKey(saved) !== undefined) return saved;
  } catch {
    // Private browsing or blocked storage: fall back to the default project.
  }
  return DEFAULT_PROJECT_KEY;
}

export function rememberProject(storage: Pick<Storage, "setItem"> | undefined, key: string): void {
  try {
    storage?.setItem(LAST_PROJECT_KEY, key);
  } catch {
    // The selection still applies to this page.
  }
}

/** Behavior 23: with `kind: null` the Proposals route redirects to This week. */
export function proposalsRedirect(projectKey: string): string | undefined {
  const project = projectByKey(projectKey);
  return project !== undefined && project.profile.proposal.kind === null ? `/${projectKey}/` : undefined;
}

export const DIGEST_STALE_AFTER_MS = 36 * 60 * 60_000;

export interface DigestFreshness {
  readonly key: "digest.freshness.justNow" | "digest.freshness.minutes" | "digest.freshness.hours" | "digest.freshness.stale";
  readonly n: number;
  readonly stale: boolean;
}

/** Behavior 19: age of `generatedAt`; stale strictly after 36 h. */
export function digestFreshness(generatedAt: string, now: number): DigestFreshness | undefined {
  const at = Date.parse(generatedAt);
  if (Number.isNaN(at)) return undefined;
  const age = Math.max(0, now - at);
  const minutes = Math.floor(age / 60_000);
  const hours = Math.floor(minutes / 60);
  if (age > DIGEST_STALE_AFTER_MS) return { key: "digest.freshness.stale", n: hours, stale: true };
  if (minutes === 0) return { key: "digest.freshness.justNow", n: 0, stale: false };
  if (minutes < 60) return { key: "digest.freshness.minutes", n: minutes, stale: false };
  return { key: "digest.freshness.hours", n: hours, stale: false };
}

const SOURCE_NAMES: Readonly<Record<string, string>> = { github: "GitHub", mail: "dev@", jira: "JIRA" };

/** Lagging sources next to the stats, e.g. "JIRA data through Sep 19" (Behavior 26). */
export function lagNotes(
  digest: Pick<DigestV1, "coverage">,
  locale: string,
  t: (key: string, variables?: Readonly<Record<string, string | number>>) => string,
): string[] {
  return Object.entries(digest.coverage.sources)
    .filter(([, coverage]) => coverage.lagging && coverage.newestAt !== null)
    .map(([source, coverage]) => {
      const date = lagLabel(source, coverage.newestAt!, locale === "zh-Hant" ? "zh-Hant" : "en").replace(/^.* through /u, "");
      return t("digest.lag", { source: SOURCE_NAMES[source] ?? source, date });
    });
}

/**
 * A proposal's title (Behavior 5): from its tagged dev@ subject ("[DISCUSS] KIP-1368: Client
 * framework name and version"), else from a PR title naming it, without issue keys and part
 * markers, else the key.
 */
export function proposalTitle(row: Pick<ProposalRow, "key" | "cites">, threads: Readonly<Record<string, DigestThread>>): string {
  const after = (title: string) => title.slice(title.indexOf(row.key) + row.key.length).replace(/^\s*[:：-]?\s*/u, "").trim();
  for (const id of row.cites) {
    const thread = threads[id];
    if (thread?.source === "mail" && /\[(?:discuss|vote|result)\]/iu.test(thread.title) && thread.title.includes(row.key)) {
      const rest = after(thread.title);
      if (rest.length > 0) return rest;
    }
  }
  for (const id of row.cites) {
    const thread = threads[id];
    if (thread === undefined || !id.includes("-PR-")) continue;
    const cleaned = thread.title.replace(/^(?:\[[^\]]*\]\s*)*(?:[A-Z]+-\d+\s*)?(?:\[\d+\/N\]\s*)?[:：]?\s*/u, "").trim();
    if (cleaned.length > 0) return cleaned;
  }
  return row.key;
}

/** The vote thread a vote row links to: its newest cited dev@ thread with a [VOTE] subject. */
export function voteThread(row: Pick<ProposalRow, "key" | "cites" | "stages">, threads: Readonly<Record<string, DigestThread>>): string | undefined {
  if (!row.stages.includes("vote")) return undefined;
  return row.cites.find((id) => threads[id]?.source === "mail" && /\[(?:vote|result)\]/iu.test(threads[id]!.title));
}

export interface StageColumn {
  readonly stage: string;
  readonly rows: readonly ProposalRow[];
  readonly more: number;
}

/**
 * Proposal columns in process order (discuss, vote, implementing) as the design shows them; a row
 * sits in its group (Behavior 5). `limit` caps This week; the Proposals tab passes none.
 */
export function stageColumns(rows: readonly ProposalRow[], profile: DigestProfile, limit?: number): StageColumn[] {
  const display = ["discuss", "vote", "implementing"].filter((stage) => profile.proposal.stages.some((item) => item.key === stage));
  const others = profile.proposal.stages.map((stage) => stage.key).filter((stage) => !display.includes(stage));
  return [...display, ...others].map((stage) => {
    const members = rows.filter((row) => row.group === stage);
    const shown = limit === undefined ? members : members.slice(0, limit);
    return { stage, rows: shown, more: members.length - shown.length };
  });
}

export interface CiteTarget {
  readonly href: string;
  readonly external: boolean;
  readonly title: string;
}

/**
 * A citation chip's link: the Detail view when the thread is in the current Feed, otherwise its
 * canonical source URL with the title kept in the digest (Behavior 19).
 */
export function citeTarget(id: string, digest: Pick<DigestV1, "threads">, feedIds: ReadonlySet<string> | undefined): CiteTarget {
  const thread = digest.threads[id];
  const title = thread?.title ?? id;
  if (feedIds === undefined || feedIds.has(id) || thread?.url === null || thread?.url === undefined) {
    return { href: `#/feed/${encodeURIComponent(id)}`, external: false, title };
  }
  return { href: thread.url, external: true, title };
}

export type ThreadFilter = "all" | "pr" | "mail" | "jira";

export function threadKind(id: string, thread: Pick<DigestThread, "source"> | undefined): Exclude<ThreadFilter, "all"> | "github" {
  if (thread?.source === "mail") return "mail";
  if (thread?.source === "jira") return "jira";
  return id.includes("-PR-") ? "pr" : "github";
}

/** Topic-page filter counts, from the same thread list the cards render (Behavior 26). */
export function filterCounts(ids: readonly string[], digest: Pick<DigestV1, "threads">): Record<ThreadFilter, number> {
  const counts: Record<ThreadFilter, number> = { all: ids.length, pr: 0, mail: 0, jira: 0 };
  for (const id of ids) {
    const kind = threadKind(id, digest.threads[id]);
    if (kind !== "github") counts[kind] += 1;
  }
  return counts;
}

export function filterThreads(ids: readonly string[], digest: Pick<DigestV1, "threads">, filter: ThreadFilter): string[] {
  return filter === "all" ? [...ids] : ids.filter((id) => threadKind(id, digest.threads[id]) === filter);
}

/** The AI label names the summarizer, and the translator on zh-Hant (Behavior 13). */
export function aiLabel(
  digest: Pick<DigestV1, "locale" | "revisions">,
  t: (key: string, variables?: Readonly<Record<string, string | number>>) => string,
): string {
  const short = (model: string) => model.split("/").pop() ?? model;
  return digest.locale === "zh-Hant"
    ? t("digest.aiLabelTranslated", { model: short(digest.revisions.summarizer.model), translator: short(digest.revisions.translator.model) })
    : t("digest.aiLabel", { model: short(digest.revisions.summarizer.model) });
}
