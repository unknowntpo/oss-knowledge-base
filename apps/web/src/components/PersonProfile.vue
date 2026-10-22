<script setup lang="ts">
/**
 * Spec 019 slices 2a and 2b, amendment (5): the profile page in the order of W56 — header with a
 * one-sentence summary, the activity chart, count tiles, then areas, works with, threads, and the
 * identity and method notes. Counts come from `profileView`, the function that computes the
 * response's `totals` (W23). Reviews are shown for a GitHub identity; the activity log's counts for
 * the identity's own source (strict identity).
 */
import { computed, ref } from "vue";

import {
  profileView,
  type ActivityThreadView,
  type PersonProfileV1,
  type ProfilePeriod,
  type ProfileThread,
  type SourceCoverageV1,
} from "@oss-knowledge-base/reference-pipeline/people";

import { useI18n } from "../i18n";
import { nominalStart, type ChartInput, type ChartSeries } from "../profile-chart";
import GithubAvatar from "./GithubAvatar.vue";
import PersonActivityChart from "./PersonActivityChart.vue";
import PersonAreas from "./PersonAreas.vue";
import PersonKips from "./PersonKips.vue";

const props = withDefaults(defineProps<{
  readonly profile: PersonProfileV1;
  readonly nowMs: number;
  readonly initialPeriod?: ProfilePeriod;
}>(), { initialPeriod: "12m" });

const { t } = useI18n();
const period = ref<ProfilePeriod>(props.initialPeriod);
const view = computed(() => profileView(props.profile, period.value, props.nowMs));
const THREAD_PAGE = 20;
const shownThreads = ref(THREAD_PAGE);
const day = (iso: string) => iso.slice(0, 10);
const STATES = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"] as const;
const isGithub = computed(() => props.profile.identity.source === "github");
const source = computed(() => props.profile.identity.source);

type Recorded = Extract<SourceCoverageV1, { status: "recorded" }>;
const recorded = computed(() => props.profile.coverage.filter((item): item is Recorded => item.status === "recorded"));
const reviewCoverage = computed(() => recorded.value.filter((item) => item.source === "github-reviews"));
/** The activity log's sources share one coverage; they are listed on one line (W27). */
const activityCoverage = computed(() => {
  const items = recorded.value.filter((item) => item.source !== "github-reviews");
  return items.length === 0 ? undefined : { ...items[0]!, sources: items.map((item) => t(`people.source.${item.source}`)).join(t("people.listSeparator")) };
});
const notRecorded = computed(() => props.profile.coverage.filter((item) => item.status === "not-recorded")
  .map((item) => t(`people.source.${item.source}`)).join(t("people.listSeparator")));
const sourceRecorded = computed(() => props.profile.coverage.some((item) => item.source === source.value && item.status === "recorded"));
const md = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
const name = computed(() => props.profile.identity.name ?? props.profile.identity.display);
const ownCoverage = computed(() => recorded.value.find((item) => item.source === source.value));
/** W56, W62: the identity's activity source starts after the period the reader selected. */
const since = computed(() => {
  const coverage = ownCoverage.value;
  return coverage !== undefined && coverage.from > nominalStart(period.value, view.value.until, props.nowMs) ? coverage.from : undefined;
});
const chartInput = computed<ChartInput>(() => ({
  source: source.value,
  period: period.value,
  overTime: view.value.overTime,
  coverage: props.profile.coverage,
  from: view.value.from,
  until: view.value.until,
  nowMs: props.nowMs,
}));
/** W63: the collapsed line names where each of the identity's own sources starts. */
const rangeItems = computed(() => recorded.value
  .filter((item) => (isGithub.value && item.source === "github-reviews") || item.source === source.value)
  .map((item) => t("people.range.item", { source: t(`people.source.${item.source}`), date: md(item.from) }))
  .join(" · "));

/** W56: one sentence for the period, from the same totals as the tiles. */
const summary = computed(() => {
  const totals = view.value.totals;
  const activity = sourceRecorded.value ? view.value.activity?.totals : undefined;
  const parts: string[] = [];
  if (isGithub.value) {
    if (reviewCoverage.value.length > 0) parts.push(t("people.summary.reviewed", { prs: unit("pr", totals.reviewsGiven.pullRequests) }));
    if (activity) {
      parts.push(t("people.summary.opened", { prs: unit("pr", activity.pullRequests), merged: activity.mergedPullRequests }));
      parts.push(t("people.summary.commented", { threads: unit("thread", activity.commentedThreads) }));
    }
  } else if (activity && source.value === "jira") {
    parts.push(t("people.summary.jira", { issues: activity.jiraIssues, comments: activity.jiraComments, threads: activity.jiraThreads }));
  } else if (activity) {
    parts.push(t("people.summary.mail", { messages: activity.messages, threads: unit("thread", activity.mailThreads) }));
  }
  return {
    lead: t(`people.summary.lead.${period.value}`),
    text: parts.join(t("people.summary.separator")),
    since: since.value === undefined ? "" : t("people.summary.since", { source: t(`people.chart.series.${source.value}`), date: day(since.value) }),
  };
});

/** W62: count tiles; a source not recorded shows "not recorded yet", never 0. */
interface Tile { readonly key: string; readonly series: ChartSeries; readonly label: string; readonly value: number | null; readonly detail: string; readonly since?: string }
const tiles = computed<readonly Tile[]>(() => {
  const totals = view.value.totals;
  const activity = sourceRecorded.value ? view.value.activity?.totals : undefined;
  const sinceText = since.value === undefined ? undefined : t("people.kpi.since", { date: day(since.value) });
  if (isGithub.value) {
    const reviews = reviewCoverage.value.length > 0;
    const given = totals.reviewsGiven;
    const received = totals.reviewsReceived;
    const states = [stateText(given.byState), ...(given.inlineComments > 0 ? [t("people.inline", { count: given.inlineComments })] : [])].filter((part) => part !== "").join(" · ");
    return [
      { key: "given", series: "given", label: t("people.given"), value: reviews ? given.reviews : null, detail: reviews ? [t("people.kpi.on", { prs: unit("pr", given.pullRequests) }), states].filter((part) => part !== "").join(" · ") : "" },
      { key: "received", series: "received", label: t("people.received"), value: reviews ? received.reviews : null, detail: reviews ? t("people.kpi.receivedDetail", { prs: unit("pr", received.pullRequests), reviewers: unit("reviewer", received.reviewers) }) : "" },
      { key: "pull-requests", series: "github", label: t("people.act.pullRequests"), value: activity?.pullRequests ?? null, detail: activity ? t("people.kpi.merged", { merged: activity.mergedPullRequests }) : "", since: sinceText },
      { key: "comments", series: "github", label: t("people.act.comments"), value: activity?.comments ?? null, detail: activity ? t("people.kpi.commentsDetail", { threads: unit("thread", activity.commentedThreads), own: activity.commentsOnOwn }) : "", since: sinceText },
      ...(activity && activity.issues > 0 ? [{ key: "issues", series: "github" as const, label: t("people.act.issues"), value: activity.issues, detail: "", since: sinceText }] : []),
    ];
  }
  if (source.value === "jira") {
    return [
      { key: "jira", series: "jira", label: t("people.kpi.jiraIssues"), value: activity?.jiraIssues ?? null, detail: "", since: sinceText },
      { key: "jira-comments", series: "jira", label: t("people.kpi.jiraComments"), value: activity?.jiraComments ?? null, detail: "", since: sinceText },
      { key: "jira-threads", series: "jira", label: t("people.kpi.jiraThreads"), value: activity?.jiraThreads ?? null, detail: "", since: sinceText },
    ];
  }
  return [
    { key: "mail", series: "mail", label: t("people.act.mail"), value: activity?.messages ?? null, detail: activity ? t("people.kpi.in", { threads: unit("thread", activity.mailThreads) }) : "", since: sinceText },
    { key: "mail-discuss", series: "mail", label: t("people.kpi.discuss"), value: activity?.discussThreads ?? null, detail: t("people.kpi.discussDetail"), since: sinceText },
    { key: "mail-vote", series: "mail", label: t("people.kpi.vote"), value: activity?.voteThreads ?? null, detail: t("people.kpi.voteDetail"), since: sinceText },
  ];
});
const issuesUrl = "https://github.com/unknowntpo/oss-knowledge-base/issues";

/** Reviews and activity threads in one list, newest first. */
type ThreadItem = { readonly kind: "review"; readonly thread: ProfileThread } | { readonly kind: "activity"; readonly thread: ActivityThreadView };
const threadItems = computed<readonly ThreadItem[]>(() => [
  ...view.value.threads.map((thread) => ({ kind: "review" as const, thread })),
  ...(view.value.activity?.threads ?? []).map((thread) => ({ kind: "activity" as const, thread })),
].sort((a, b) => (a.thread.lastAt === b.thread.lastAt ? 0 : a.thread.lastAt < b.thread.lastAt ? 1 : -1)));

function personLink(id: string): string {
  return `/${props.profile.project.key}/people/${encodeURIComponent(id)}`;
}
function stateText(states: Readonly<Partial<Record<string, number>>>): string {
  return STATES.filter((state) => (states[state] ?? 0) > 0).map((state) => `${t(`people.state.${state}`)} ${states[state]}`).join(", ");
}
/** English needs the singular for 1 (i18n.js has no plural rules; `results.search.one` does the same). */
function unit(name: "review" | "pr" | "reviewer" | "thread" | "comment" | "message", count: number): string {
  return t(`people.unit.${name}.${count === 1 ? "one" : "other"}`, { count });
}
function activityPart(thread: ActivityThreadView): string {
  const parts: string[] = [];
  if (thread.role === "author") parts.push(t("people.thread.opened"));
  if (thread.merged) parts.push(t("people.thread.merged"));
  if ((thread.kinds.comment ?? 0) > 0) parts.push(unit("comment", thread.kinds.comment ?? 0));
  if ((thread.kinds.message ?? 0) > 0) parts.push(unit("message", thread.kinds.message ?? 0));
  return parts.join(" · ");
}
/** Hash routing owns `#…`, so the counts scroll to the evidence instead of linking to an anchor. */
function toThreads() {
  document.getElementById("person-threads")?.scrollIntoView({ behavior: "smooth", block: "start" });
}
function selectPeriod(next: ProfilePeriod) {
  period.value = next;
  shownThreads.value = THREAD_PAGE;
}
</script>

<template>
  <article class="person" :data-person="profile.identity.id">
    <header class="person-head" data-section="header">
      <div class="person-head-row">
        <div class="person-title">
          <GithubAvatar v-if="isGithub" :login="profile.identity.display" :size="56" :alt="t('people.avatarAlt', { login: profile.identity.display })" />
          <div class="person-title-text">
            <h1 class="person-name">{{ name }}</h1>
            <p class="person-meta">
              <span :class="['source-badge', `src-${profile.identity.source}`]">{{ t(`people.identity.${profile.identity.source}`) }}</span>
              <template v-if="profile.identity.name">
                <a v-if="profile.identity.url" class="person-login" data-login :href="profile.identity.url" target="_blank" rel="noopener noreferrer">{{ profile.identity.display }}</a>
                <span v-else class="person-login" data-login>{{ profile.identity.display }}</span>
              </template>
              <span class="person-community">{{ t("people.activityIn", { community: profile.project.label }) }}</span>
            </p>
          </div>
        </div>
        <div class="person-periods" role="group" :aria-label="t('people.section.activity')">
          <button v-for="option in (['12m', '90d'] as const)" :key="option" type="button" class="tl-filter" :aria-pressed="period === option" @click="selectPeriod(option)">{{ t(`people.period.${option}`) }}</button>
        </div>
      </div>
      <p class="person-summary" data-summary>
        <span class="person-summary-lead">{{ summary.lead }}</span><template v-if="view.empty">{{ t("people.empty") }}</template><template v-else>{{ summary.text }}</template><span v-if="summary.since" class="person-summary-lead">{{ summary.since }}</span>
      </p>
      <p v-for="month in profile.unavailableMonths" :key="month" class="person-unavailable">{{ t("people.unavailable", { month }) }}</p>
    </header>

    <section class="person-section" data-section="over-time">
      <h2 class="section-heading">{{ t(`people.chart.title.${period}`) }}</h2>
      <p v-if="view.empty" class="person-empty">{{ t("people.empty") }}</p>
      <PersonActivityChart v-else :input="chartInput" :name="name">
        <details class="person-range" data-range>
          <summary>{{ t("people.range.summary", { items: rangeItems }) }}</summary>
          <ul class="person-coverage">
            <li v-for="item in reviewCoverage" :key="item.source">{{ t("people.coverage.reviews", { from: day(item.from), until: day(item.until) }) }}</li>
            <li v-if="activityCoverage" data-coverage="activity">{{ t("people.coverage.source", { sources: activityCoverage.sources, from: day(activityCoverage.from), until: day(activityCoverage.until) }) }}</li>
            <li v-if="notRecorded" class="not-recorded">{{ t("people.coverage.notRecorded", { sources: notRecorded }) }}</li>
          </ul>
          <p class="person-period">{{ t("people.period", { from: day(view.from), until: day(view.until), days: view.days }) }}</p>
        </details>
      </PersonActivityChart>
    </section>

    <section class="person-section person-tiles-section" data-section="activity">
      <h2 class="section-heading visually-hidden">{{ t("people.section.activity") }}</h2>
      <p v-if="view.empty" class="person-empty">{{ t("people.empty") }}</p>
      <dl v-else :class="['person-tiles', { 'is-three': tiles.length === 3 }]">
        <div v-for="tile in tiles" :key="tile.key" :class="['person-tile', { 'is-unrecorded': tile.value === null }]" :data-count="tile.key">
          <dt><span :class="['person-swatch', { 'person-swatch-hatch': tile.value === null }]" :data-series="tile.value === null ? undefined : tile.series" aria-hidden="true"></span>{{ tile.label }}</dt>
          <dd>
            <span v-if="tile.value === null" class="person-tile-num is-unrecorded">{{ t("people.chart.notRecorded") }}</span>
            <button v-else type="button" class="person-jump person-tile-num" @click="toThreads">{{ tile.value }}</button>
            <span v-if="tile.detail" class="person-tile-detail">{{ tile.detail }}</span>
            <span v-if="tile.since && tile.value !== null" class="person-tile-since">{{ tile.since }}</span>
          </dd>
        </div>
      </dl>
    </section>

    <!-- Amendment (7): after the activity tiles, only when the response carries it (PEOPLE_KIPS). -->
    <PersonKips v-if="profile.kips" :kips="profile.kips" :project-key="profile.project.key" />

    <div class="person-lower">
      <section class="person-section" data-section="areas">
        <h2 class="section-heading">{{ t("people.section.areas") }}</h2>
        <PersonAreas v-if="profile.pullAreas && !view.empty" :profile="profile" :from="view.from" />
        <template v-if="view.activity">
          <h3 v-if="profile.pullAreas && !view.empty" class="rail-label person-areas-threads">{{ t("people.areas.threads") }}</h3>
          <ul v-if="view.activity.areas.labels.length > 0 || view.activity.areas.kips.length > 0" class="person-areas">
            <li v-for="entry in view.activity.areas.labels" :key="`label:${entry.label}`" data-area="label">{{ entry.label }} <span class="person-detail">{{ unit("thread", entry.threads) }}</span></li>
            <li v-for="entry in view.activity.areas.kips" :key="`kip:${entry.kip}`" data-area="kip">{{ entry.kip }} <span class="person-detail">{{ unit("thread", entry.threads) }}</span></li>
          </ul>
          <p v-else-if="view.activity.areas.noLabelSources.length === 0" class="person-note">{{ view.empty ? t("people.empty") : t("people.areas.empty") }}</p>
          <p v-if="view.activity.areas.noLabelSources.length > 0" class="person-note">{{ t("people.areas.noLabels", { sources: view.activity.areas.noLabelSources.map((item) => t(`people.overTime.${item}`)).join(t("people.listSeparator")) }) }}</p>
        </template>
        <p v-else-if="!profile.pullAreas" class="person-note">{{ t("people.areas.none") }}</p>
        <!-- W48: review areas with nothing in the selected period still say so. -->
        <p v-else-if="view.empty" class="person-note" data-areas-state="empty">{{ t("people.empty") }}</p>
      </section>
      <section class="person-section" data-section="works-with">
        <h2 class="section-heading">{{ t("people.section.worksWith") }}</h2>
        <div class="person-works">
          <template v-if="isGithub && reviewCoverage.length > 0">
            <div v-for="relation in (['reviewedPullRequestsBy', 'reviewedBy'] as const)" :key="relation" class="person-relation" :data-relation="relation">
              <h3 class="rail-label">{{ t(relation === "reviewedBy" ? "people.worksWith.reviewedBy" : "people.worksWith.reviewedPrsBy") }}</h3>
              <p v-if="view.worksWith[relation].length === 0" class="person-note">{{ t("people.worksWith.none") }}</p>
              <ul v-else>
                <li v-for="entry in view.worksWith[relation]" :key="entry.login">
                  <RouterLink class="person-with" :to="personLink(`github:${entry.login}`)"><GithubAvatar :login="entry.login" :size="20" />{{ entry.login }}</RouterLink>
                  <span class="person-detail">{{ t("people.worksWith.prs", { count: entry.pullRequests }) }}</span>
                </li>
              </ul>
            </div>
          </template>
          <div v-if="view.activity" class="person-relation" data-relation="wroteInThreadsBy">
            <h3 class="rail-label">{{ t("people.worksWith.wroteInThreadsBy") }}</h3>
            <p v-if="view.activity.wroteInThreadsBy.length === 0" class="person-note">{{ t("people.worksWith.none") }}</p>
            <ul v-else>
              <li v-for="entry in view.activity.wroteInThreadsBy" :key="entry.id">
                <RouterLink :to="personLink(entry.id)">{{ entry.display }}</RouterLink>
                <span class="person-detail">{{ t("people.worksWith.threads", { count: entry.threads }) }}</span>
              </li>
            </ul>
          </div>
        </div>
      </section>
    </div>

    <section id="person-threads" class="person-section" data-section="threads">
      <h2 class="section-heading">{{ t("people.section.threads") }}</h2>
      <p v-if="view.empty" class="person-empty">{{ t("people.empty") }}</p>
      <ol v-else class="person-threads">
        <li v-for="item in threadItems.slice(0, shownThreads)" :key="item.kind === 'review' ? `${item.thread.role}:${item.thread.pr}` : `activity:${item.thread.key}`" :class="['person-thread', { 'is-activity': item.kind === 'activity' }]" :data-thread-source="item.kind === 'review' ? 'github-reviews' : item.thread.source">
          <template v-if="item.kind === 'review'">
            <a class="person-thread-pr" :href="item.thread.url" target="_blank" rel="noopener noreferrer">#{{ item.thread.pr }}</a>
            <span class="person-thread-part">
              <template v-if="item.thread.role === 'reviewer'">{{ t("people.thread.reviewer", { author: item.thread.counterpart ?? t("people.thread.hidden") }) }}</template>
              <template v-else>{{ t("people.thread.author", { reviewers: unit("reviewer", item.thread.reviewers) }) }}</template>
              · {{ stateText(item.thread.states) }}
            </span>
          </template>
          <template v-else>
            <a class="person-thread-title" :href="item.thread.url" target="_blank" rel="noopener noreferrer">{{ item.thread.title }}</a>
            <span class="person-thread-part"><span class="person-thread-key">{{ item.thread.key }}</span> · {{ activityPart(item.thread) }}</span>
          </template>
          <time class="person-thread-date" :datetime="item.thread.lastAt">{{ day(item.thread.lastAt) }}</time>
        </li>
      </ol>
      <button v-if="!view.empty && threadItems.length > shownThreads" type="button" class="btn" @click="shownThreads += THREAD_PAGE">{{ t("people.threads.older") }}</button>
    </section>

    <section class="person-section" data-section="identities">
      <h2 class="section-heading">{{ t("people.section.identities") }}</h2>
      <p class="person-identity">
        <span :class="['source-badge', `src-${profile.identity.source}`]">{{ t(`people.identity.${profile.identity.source}`) }}</span>
        <a v-if="profile.identity.url" :href="profile.identity.url" target="_blank" rel="noopener noreferrer">{{ profile.identity.display }}<span class="ext" aria-hidden="true">↗</span></a>
        <span v-else>{{ profile.identity.display }}</span>
      </p>
      <p v-if="!isGithub" class="person-note">{{ t("people.identity.byName") }}</p>
      <p class="person-note">{{ t("people.identity.separate") }}</p>
    </section>

    <section class="person-section person-how" data-section="how">
      <h2 class="section-heading">{{ t("people.section.how") }}</h2>
      <ul>
        <li v-for="item in (isGithub ? reviewCoverage : [])" :key="item.source">{{ t("people.how.source", { from: day(item.storedFrom) }) }}</li>
        <li v-if="activityCoverage">{{ t("people.how.activity", { sources: activityCoverage.sources, first: day(activityCoverage.firstAppendAt ?? activityCoverage.storedFrom), from: day(activityCoverage.storedFrom) }) }}</li>
        <li>{{ t("people.how.period", { from: day(profile.period.from), until: day(profile.period.until) }) }}</li>
        <li v-if="isGithub && reviewCoverage.length > 0">{{ t("people.how.notCounted") }}</li>
        <li v-if="activityCoverage">{{ t("people.how.activityNotCounted") }}</li>
        <li v-if="notRecorded">{{ t("people.how.notRecorded", { sources: notRecorded }) }}</li>
        <li><a :href="issuesUrl" target="_blank" rel="noopener noreferrer">{{ t("people.how.report") }}</a></li>
      </ul>
    </section>
  </article>
</template>
