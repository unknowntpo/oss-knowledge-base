/**
 * Spec 030: a project's activity per month for the 12-month view, summed at request time from the
 * objects the profile reader already reads (Spec 022's review months, the activity log's months
 * and both `state.json`), through the same per-isolate cache (W29). No new object, no write.
 *
 * Counts are events, not people (decision 7): reviews given by people, and activity-log rows by
 * source. A month a source did not record is `null`, never 0 (the profile chart's rule, W60).
 */
import {
  isBotLogin,
  PEOPLE_PROJECTS,
  profileMonths,
  readActivityMonth,
  readActivityState,
  readMonth,
  readState,
  recordedCoverage,
  type PeopleBucket,
  type PeopleSource,
  type SourceCoverageV1,
} from "./index";

export const PROJECT_ACTIVITY_SCHEMA = "osskb.project-activity.v1";
/** Decision 5: Kafka only in v1 (DataFusion has no This week digest, and its log is over the parse budget, G75). */
export const PROJECT_TREND_PROJECTS: readonly string[] = ["apache-kafka"];

export type ProjectSeries = "reviews" | "github" | "jira" | "mail";

export interface ProjectActivityMonthV1 {
  readonly month: string;
  readonly reviews: number | null;
  readonly github: number | null;
  readonly jira: number | null;
  readonly mail: number | null;
}

export interface ProjectActivityV1 {
  readonly schema: typeof PROJECT_ACTIVITY_SCHEMA;
  readonly projectId: string;
  /** The newest store `updatedAt`; null when neither store is recorded. */
  readonly until: string | null;
  /** The 12 calendar months ending with the current one, oldest first. */
  readonly months: readonly ProjectActivityMonthV1[];
  readonly coverage: readonly SourceCoverageV1[];
  /** W10: months that could not be read; their affected counts are `null`. */
  readonly unavailableMonths: readonly string[];
}

export type ProjectActivityRead =
  | { readonly status: 200; readonly body: ProjectActivityV1 }
  | { readonly status: 400 | 404 | 503; readonly body: { readonly error: string } };

const ACTIVITY_SOURCES = ["github", "jira", "mail"] as const;

/** `GET /api/activity?projectId=` (Spec 030 Behavior 1). */
export async function readProjectActivity(input: {
  readonly bucket: PeopleBucket;
  readonly projectId: string | null | undefined;
  readonly nowMs: number;
}): Promise<ProjectActivityRead> {
  const project = PEOPLE_PROJECTS.find((item) => item.projectId === input.projectId);
  if (project === undefined) return { status: 400, body: { error: "Unknown project" } };
  if (!PROJECT_TREND_PROJECTS.includes(project.projectId)) return { status: 404, body: { error: "No activity trend for this project" } };

  let reviewState: Awaited<ReturnType<typeof readState>>;
  let activityState: Awaited<ReturnType<typeof readActivityState>>;
  try {
    reviewState = await readState(input.bucket, project.projectId, input.nowMs);
    activityState = await readActivityState(input.bucket, project.projectId, input.nowMs);
  } catch (error) {
    return { status: 503, body: { error: error instanceof Error ? error.message : "Unable to read the stores" } };
  }
  const reviewView = reviewState === undefined ? undefined : recordedCoverage("github-reviews", reviewState.coverageFrom, reviewState.updatedAt, input.nowMs);
  const activityView = activityState === undefined
    ? undefined
    : recordedCoverage("github", activityState.coverageFrom, activityState.updatedAt, input.nowMs, activityState.firstAppendAt);
  const coverage: SourceCoverageV1[] = project.sources.map((source: PeopleSource) => {
    if (source === "github-reviews") return reviewView?.coverage ?? { source, status: "not-recorded" as const };
    return activityView === undefined ? { source, status: "not-recorded" as const } : { ...activityView.coverage, source };
  });

  const unavailable = new Set<string>();
  // Reviews: rows by people (W12) submitted from the coverage start, a pull request author's reply excluded (W8).
  const reviewFrom = reviewView === undefined ? Number.POSITIVE_INFINITY : Date.parse(reviewView.coverage.from);
  const reviewMonths = reviewView?.months ?? [];
  const reviewIndexes = await Promise.all(reviewMonths.map((month) => readMonth(input.bucket, project.projectId, month, input.nowMs).catch(() => {
    unavailable.add(month);
    return undefined;
  })));
  // Logins GitHub typed `Bot` in any month of the view count for nobody (W12), as on the profile.
  const learnedBots = new Set(reviewIndexes.flatMap((index) => (index === undefined ? [] : [...index.bots])));
  const reviews = new Map<string, number>();
  reviewMonths.forEach((month, position) => {
    const index = reviewIndexes[position];
    if (index === undefined) return;
    let count = 0;
    for (const [login, entry] of index.people) {
      if (isBotLogin(login, project, learnedBots)) continue;
      count += entry.given.filter((row) => Date.parse(row.submittedAt) >= reviewFrom).length;
    }
    reviews.set(month, count);
  });

  // Activity: each record once, in the month of its newest row (a Jira issue is stored in every month it was updated).
  const activityFrom = activityView === undefined ? "" : activityView.coverage.from;
  const activityMonths = activityView?.months ?? [];
  const readable = new Set<string>();
  const records = new Map<string, { readonly source: (typeof ACTIVITY_SOURCES)[number]; readonly at: string; readonly month: string }>();
  const indexes = await Promise.all(activityMonths.map((month) => readActivityMonth(input.bucket, project.projectId, month, input.nowMs).catch(() => {
    unavailable.add(month);
    return undefined;
  })));
  activityMonths.forEach((month, position) => {
    const index = indexes[position];
    if (index === undefined) return;
    readable.add(month);
    for (const [person, entry] of index.index.people) {
      if (person.startsWith("github:") && isBotLogin(person.slice("github:".length), project, learnedBots)) continue;
      for (const row of entry.rows) {
        if (row.at < activityFrom) continue;
        const previous = records.get(row.id);
        if (previous !== undefined && previous.at >= row.at) continue;
        records.set(row.id, { source: row.source, at: row.at, month });
      }
    }
  });
  const activity = new Map<string, Record<(typeof ACTIVITY_SOURCES)[number], number>>();
  for (const month of readable) activity.set(month, { github: 0, jira: 0, mail: 0 });
  for (const record of records.values()) activity.get(record.month)![record.source] += 1;

  const recorded = (source: PeopleSource) => coverage.some((item) => item.source === source && item.status === "recorded");
  // Only months inside a store's coverage were read: every other month, and an unreadable one, has no count (null).
  const months = profileMonths(input.nowMs, "1970-01-01T00:00:00.000Z").map((month): ProjectActivityMonthV1 => {
    const counts = activity.get(month);
    const value = (source: (typeof ACTIVITY_SOURCES)[number]) => (counts === undefined || !recorded(source) ? null : counts[source]);
    return { month, reviews: reviews.get(month) ?? null, github: value("github"), jira: value("jira"), mail: value("mail") };
  });
  const updates = [reviewState?.updatedAt, activityState?.updatedAt].filter((value): value is string => value !== undefined).sort();
  return {
    status: 200,
    body: {
      schema: PROJECT_ACTIVITY_SCHEMA,
      projectId: project.projectId,
      until: updates.at(-1) ?? null,
      months,
      coverage,
      unavailableMonths: [...unavailable].sort(),
    },
  };
}
