/**
 * Spec 015 Behavior 21: community governance as profile data. There is no rule language: `rule`
 * and `bindingRole` are enums, and new mechanisms are adapters (ADR-0016).
 */
import { DATAFUSION_DIGEST_PROFILE, KAFKA_DIGEST_PROFILE } from "../digest/profiles";
import type { ProposalProfile } from "../digest/types";

export type BindingRole = "committer" | "pmc";
export type VoteKind = "proposal" | "release";
export type VoteRuleName = "lazy-majority";
export type RosterAdapterId = "asf";

export interface VoteRule {
  readonly kind: VoteKind;
  readonly quorum: number;
  readonly rule: VoteRuleName;
  readonly minOpenHours: number;
  readonly bindingRole: BindingRole;
}

export interface Governance {
  readonly roster: { readonly adapter: RosterAdapterId; readonly project: string } | null;
  readonly votes: readonly VoteRule[];
}

export interface SubjectTags {
  readonly vote: string;
  readonly discuss: string;
  readonly result: string;
}

export interface ReviewProfile {
  readonly projectId: string;
  readonly projectKey: string;
  readonly github: { readonly owner: string; readonly repo: string };
  readonly mail: { readonly list: string } | null;
  readonly tags: SubjectTags;
  /** Spec 014's proposal fields (kind and key pattern); `kind: null` hides the KIP column. */
  readonly proposal: ProposalProfile;
  readonly machineUsers: readonly string[];
  /** Behavior 5: a PR waits longer than this (strictly) to be queued. */
  readonly reviewWaitDays: number;
  /** Behavior 10: a discussion is queued with fewer distinct repliers than this. */
  readonly fewRepliers: number;
  readonly governance: Governance;
}

export type AsfPreset = Pick<ReviewProfile, "mail" | "tags" | "governance">;

/** The shared Apache Software Foundation conventions (Behavior 21). */
export function asfPreset(options: { readonly project: string; readonly devList: string }): AsfPreset {
  return {
    mail: { list: `${options.devList}@${options.project}.apache.org` },
    tags: { vote: "VOTE", discuss: "DISCUSS", result: "RESULT" },
    governance: {
      roster: { adapter: "asf", project: options.project },
      votes: [
        { kind: "proposal", quorum: 3, rule: "lazy-majority", minOpenHours: 72, bindingRole: "committer" },
        { kind: "release", quorum: 3, rule: "lazy-majority", minOpenHours: 72, bindingRole: "pmc" },
      ],
    },
  };
}

/**
 * Kafka = the ASF preset plus overrides. Bylaws (https://cwiki.apache.org/confluence/display/KAFKA/Bylaws):
 * technical decisions (KIPs) bind active committers; releases bind PMC members; both use Lazy
 * Majority (3 binding +1, more binding +1 than -1), and a vote stays open at least 72 hours.
 */
export const KAFKA_REVIEW_PROFILE: ReviewProfile = {
  ...asfPreset({ project: "kafka", devList: "dev" }),
  projectId: KAFKA_DIGEST_PROFILE.projectId,
  projectKey: KAFKA_DIGEST_PROFILE.projectKey,
  github: { owner: "apache", repo: "kafka" },
  proposal: KAFKA_DIGEST_PROFILE.proposal,
  machineUsers: KAFKA_DIGEST_PROFILE.machineUsers,
  reviewWaitDays: 14,
  fewRepliers: 2,
};

export const DATAFUSION_REVIEW_PROFILE: ReviewProfile = {
  ...asfPreset({ project: "datafusion", devList: "dev" }),
  projectId: DATAFUSION_DIGEST_PROFILE.projectId,
  projectKey: DATAFUSION_DIGEST_PROFILE.projectKey,
  github: { owner: "apache", repo: "datafusion" },
  proposal: DATAFUSION_DIGEST_PROFILE.proposal,
  machineUsers: DATAFUSION_DIGEST_PROFILE.machineUsers,
  reviewWaitDays: 14,
  fewRepliers: 2,
};

export function voteRule(profile: ReviewProfile, kind: VoteKind): VoteRule | undefined {
  return profile.governance.votes.find((rule) => rule.kind === kind);
}
