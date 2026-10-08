/**
 * Spec 014 digest types: the project profile fields the digest reads, the inputs it takes from
 * a published Feed release, and the `osskb.digest.v1` object it produces (Contract changes).
 */

export type DigestSource = "github" | "mail" | "jira";

/** How a proposal stage is detected (Behavior 4, 23). */
export type ProposalDetect = `subject-tag:${string}` | "pr-title-key" | "linked-issue-key";

export interface ProposalStageProfile {
  readonly key: string;
  readonly badgeColor: string;
  readonly detect: readonly ProposalDetect[];
}

export interface ProposalProfile {
  readonly kind: "KIP" | "FLIP" | "PEP" | "RFC" | null;
  /** Regex source for proposal keys in titles and subjects (global, case-sensitive). */
  readonly keyPattern: string;
  /** Regex source for tracker issue keys that PR titles cite. */
  readonly issueKeyPattern: string;
  /** Stages in display priority order (Behavior 5: first present is the group). */
  readonly stages: readonly ProposalStageProfile[];
  /** i18n key of the quorum note, if any. */
  readonly quorumNote?: string;
}

export interface DigestProfile {
  readonly projectId: string;
  readonly projectKey: string;
  /** Whether this project gets a weekly digest (Behavior 23, 27). */
  readonly digest: boolean;
  readonly sources: readonly DigestSource[];
  readonly taxonomy: { readonly revision: string; readonly topics: readonly string[] };
  readonly machineUsers: readonly string[];
  readonly proposal: ProposalProfile;
}

/** A Feed index entry, reduced to what the digest reads. */
export interface DigestEntry {
  readonly id: string;
  readonly displayId: string;
  readonly projectKey: string;
  readonly status: string | null;
  readonly title: string;
  readonly lastActivityAt: string;
  readonly sourceCounts: Readonly<Record<string, number>>;
  readonly links?: Readonly<Record<string, string>> | null;
}

/** A Feed Detail record, reduced to what the digest reads. */
export interface DigestRecord {
  readonly id: string;
  readonly source: DigestSource;
  readonly kind?: string;
  readonly title: string;
  readonly author: string;
  readonly occurredAt: string;
  readonly canonicalUrl: string;
  readonly excerpt: string;
  readonly artifactStatus?: string;
}

export interface DigestDetail {
  readonly displayId: string;
  readonly title: string;
  readonly records: readonly DigestRecord[];
}

/** A candidate thread after stage 1 (Behavior 1–3). */
export interface Thread {
  readonly displayId: string;
  readonly entryId: string;
  readonly title: string;
  readonly source: DigestSource;
  /** Feed status: merged/open/closed (GitHub), discussing (mail), open/resolved (Jira). */
  readonly status: string | null;
  readonly url: string | null;
  /** The root record's excerpt (oldest record of the Detail). */
  readonly rootExcerpt: string;
  /** In-window human records, oldest first. */
  readonly records: readonly DigestRecord[];
  readonly score: number;
  readonly lastActivityAt: string;
}

export interface ThreadFeatures {
  readonly topic: string;
  readonly topicConfidence: number;
  readonly routine: boolean;
  readonly routineConfidence: number;
  readonly source: "model" | "rules" | "cache";
  readonly model?: string;
  readonly prompt?: string;
  readonly generatedAt?: string;
}

export interface Sentence {
  readonly text: string;
  readonly cites: readonly string[];
  /** zh-Hant only: the translation failed verification, so `text` is the English source. */
  readonly notTranslated?: true;
}

/** Behavior 9: provenance of one generated card, proposal line, or headline-and-highlights call. */
export interface Provenance {
  readonly source: "model" | "cache";
  readonly model: string;
  readonly prompt: string;
  /** Record ids whose text the model was given. */
  readonly inputRecordIds: readonly string[];
  /** Hash of the exact model input and revision (the cache key, Behavior 11). */
  readonly inputHash: string;
  readonly generatedAt: string;
  readonly reviewStatus: "unreviewed";
}

export interface ProposalRow {
  readonly key: string;
  /** First stage present in profile order (Behavior 5). */
  readonly group: string;
  /** Every stage present, in profile order. */
  readonly stages: readonly string[];
  /** Every in-window thread naming the proposal, plus PRs linked through issue keys. */
  readonly cites: readonly string[];
  readonly newestActivityAt: string;
  readonly line: Sentence | null;
  readonly provenance?: Provenance;
}

export interface TopicCard {
  readonly topic: string;
  /** Sum of the top-3 thread scores. */
  readonly score: number;
  /** Every thread of the card, by score (ties by display id). */
  readonly threads: readonly string[];
  readonly keywords: readonly string[];
  readonly sentences: readonly Sentence[];
  readonly status: "generated" | "fallback";
  readonly provenance?: Provenance;
}

export interface Highlight {
  readonly title: string;
  readonly body: Sentence;
  /** zh-Hant only: the title's translation failed verification. */
  readonly titleNotTranslated?: true;
}

/** A thread as the page shows it (Behavior 27): its card and its citation fallback. */
export interface DigestThread {
  readonly title: string;
  readonly source: DigestSource;
  readonly status: string | null;
  readonly url: string | null;
  readonly score: number;
  /** Root record excerpt, at most 280 characters. */
  readonly excerpt?: string;
  /** Author of the newest in-window human record; anonymous senders are omitted. */
  readonly author?: string;
  readonly lastActivityAt?: string;
}

export interface SourceCoverage {
  readonly newestAt: string | null;
  readonly lagging: boolean;
}

export interface DigestV1 {
  readonly schema: "osskb.digest.v1";
  readonly projectId: string;
  readonly locale: "en" | "zh-Hant";
  readonly window: { readonly start: string; readonly end: string };
  readonly generatedAt: string;
  readonly sourceRelease: { readonly releaseId: string; readonly generatedAt: string };
  readonly revisions: {
    readonly scoring: string;
    readonly taxonomy: string;
    readonly classifier: { readonly model: string; readonly prompt: string };
    readonly summarizer: { readonly model: string; readonly prompt: string };
    readonly translator: { readonly model: string; readonly prompt: string };
  };
  readonly coverage: {
    readonly candidates: number;
    readonly classifiedByModel: number;
    readonly cached: number;
    readonly fallbacks: number;
    readonly notTranslated: number;
    readonly modelCalls: number;
    readonly limited: boolean;
    readonly estimatedNeurons: number;
    readonly sources: Readonly<Record<string, SourceCoverage>>;
  };
  readonly empty: boolean;
  readonly headline: Sentence | null;
  readonly highlights: readonly Highlight[];
  /** Provenance of the headline-and-highlights call; null for the fallback. */
  readonly highlightsProvenance: Provenance | null;
  readonly proposals: readonly ProposalRow[];
  readonly cards: readonly TopicCard[];
  readonly routine: { readonly threads: readonly string[] };
  readonly threads: Readonly<Record<string, DigestThread>>;
  /** Behavior 11: thread features keyed by hash(model input, classifier revision). */
  readonly features: Readonly<Record<string, ThreadFeatures & { readonly displayId: string }>>;
  /** zh-Hant only: translations keyed by hash(English text, translator revision). */
  readonly translations?: Readonly<Record<string, string>>;
}
