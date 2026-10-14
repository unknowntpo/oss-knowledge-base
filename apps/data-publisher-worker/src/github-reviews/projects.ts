import { DATAFUSION_REVIEW_PROFILE, githubProjectProfiles, KAFKA_REVIEW_PROFILE } from "@oss-knowledge-base/reference-pipeline";
import type { GithubReviewsProject } from "./run";

const REVIEW_PROFILES = [KAFKA_REVIEW_PROFILE, DATAFUSION_REVIEW_PROFILE];

/** Spec 022: every GitHub project the publisher reads, with its machine users (Behavior 6). */
export const githubReviewsProjects: readonly GithubReviewsProject[] = githubProjectProfiles.map((profile) => ({
  projectId: profile.projectId,
  owner: profile.owner,
  repo: profile.repo,
  machineUsers: REVIEW_PROFILES.find((review) => review.projectId === profile.projectId)?.machineUsers ?? [],
}));
