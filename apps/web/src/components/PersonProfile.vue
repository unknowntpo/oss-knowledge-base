<script setup lang="ts">
/**
 * Spec 019 slices 2a and 2b: the profile page's sections 1–8, in the spec's order (W5). Counts come
 * from `profileView`, the function that computes the response's `totals` (W23). Reviews are shown
 * for a GitHub identity; the activity log's counts for the identity's own source (strict identity).
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
const overTimeColumns = computed(() => [
  ...(isGithub.value && reviewCoverage.value.length > 0 ? (["given", "received"] as const) : []),
  ...(sourceRecorded.value ? [source.value] : []),
]);
const barOf = (row: (typeof view.value.overTime)[number]) => overTimeColumns.value.reduce((sum, column) => sum + (row[column] ?? 0), 0);
const maxBar = computed(() => Math.max(1, ...view.value.overTime.map(barOf)));
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
function bucketLabel(label: string): string {
  return period.value === "12m" ? label : t("people.overTime.week", { date: label.slice(5) });
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
      <h1 class="person-name">{{ profile.identity.display }}</h1>
      <p class="person-community">{{ t("people.activityIn", { community: profile.project.label }) }}</p>
      <p class="person-period">{{ t("people.period", { from: day(view.from), until: day(view.until), days: view.days }) }}</p>
      <ul class="person-coverage">
        <li v-for="item in reviewCoverage" :key="item.source">{{ t("people.coverage.reviews", { from: day(item.from), until: day(item.until) }) }}</li>
        <li v-if="activityCoverage" data-coverage="activity">{{ t("people.coverage.source", { sources: activityCoverage.sources, from: day(activityCoverage.from), until: day(activityCoverage.until) }) }}</li>
        <li v-if="notRecorded" class="not-recorded">{{ t("people.coverage.notRecorded", { sources: notRecorded }) }}</li>
      </ul>
      <p v-for="month in profile.unavailableMonths" :key="month" class="person-unavailable">{{ t("people.unavailable", { month }) }}</p>
    </header>

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

    <section class="person-section" data-section="activity">
      <div class="person-section-head">
        <h2 class="section-heading">{{ t("people.section.activity") }}</h2>
        <div class="person-periods" role="group">
          <button v-for="option in (['12m', '90d'] as const)" :key="option" type="button" class="tl-filter" :aria-pressed="period === option" @click="selectPeriod(option)">{{ t(`people.period.${option}`) }}</button>
        </div>
      </div>
      <p v-if="view.empty" class="person-empty">{{ t("people.empty") }}</p>
      <dl v-else class="person-counts">
        <template v-if="isGithub && reviewCoverage.length > 0">
          <div class="person-count" data-count="given">
            <dt>{{ t("people.given") }}</dt>
            <dd>
              <button type="button" class="person-jump" @click="toThreads">{{ t("people.given.count", { reviews: unit("review", view.totals.reviewsGiven.reviews), prs: unit("pr", view.totals.reviewsGiven.pullRequests) }) }}</button>
              <span class="person-detail">{{ stateText(view.totals.reviewsGiven.byState) }}<template v-if="view.totals.reviewsGiven.inlineComments > 0"> · {{ t("people.inline", { count: view.totals.reviewsGiven.inlineComments }) }}</template></span>
            </dd>
          </div>
          <div class="person-count" data-count="received">
            <dt>{{ t("people.received") }}</dt>
            <dd><button type="button" class="person-jump" @click="toThreads">{{ t("people.received.count", { reviews: unit("review", view.totals.reviewsReceived.reviews), prs: unit("pr", view.totals.reviewsReceived.pullRequests), reviewers: unit("reviewer", view.totals.reviewsReceived.reviewers) }) }}</button></dd>
          </div>
        </template>
        <template v-if="view.activity && sourceRecorded">
          <template v-if="source === 'github'">
            <div class="person-count" data-count="pull-requests">
              <dt>{{ t("people.act.pullRequests") }}</dt>
              <dd><button type="button" class="person-jump" @click="toThreads">{{ t("people.act.pullRequests.count", { count: view.activity.totals.pullRequests, merged: view.activity.totals.mergedPullRequests }) }}</button></dd>
            </div>
            <div class="person-count" data-count="issues">
              <dt>{{ t("people.act.issues") }}</dt>
              <dd><button type="button" class="person-jump" @click="toThreads">{{ view.activity.totals.issues }}</button></dd>
            </div>
            <div class="person-count" data-count="comments">
              <dt>{{ t("people.act.comments") }}</dt>
              <dd><button type="button" class="person-jump" @click="toThreads">{{ t("people.act.comments.count", { count: view.activity.totals.comments, threads: unit("thread", view.activity.totals.commentedThreads), own: view.activity.totals.commentsOnOwn }) }}</button></dd>
            </div>
          </template>
          <div v-else-if="source === 'jira'" class="person-count" data-count="jira">
            <dt>{{ t("people.act.jira") }}</dt>
            <dd><button type="button" class="person-jump" @click="toThreads">{{ t("people.act.jira.count", { issues: view.activity.totals.jiraIssues, comments: view.activity.totals.jiraComments, threads: view.activity.totals.jiraThreads }) }}</button></dd>
          </div>
          <div v-else class="person-count" data-count="mail">
            <dt>{{ t("people.act.mail") }}</dt>
            <dd><button type="button" class="person-jump" @click="toThreads">{{ t("people.act.mail.count", { messages: view.activity.totals.messages, threads: unit("thread", view.activity.totals.mailThreads), discuss: view.activity.totals.discussThreads, vote: view.activity.totals.voteThreads }) }}</button></dd>
          </div>
        </template>
      </dl>
    </section>

    <section class="person-section" data-section="over-time">
      <h2 class="section-heading">{{ t("people.section.overTime") }}</h2>
      <p v-if="view.empty" class="person-empty">{{ t("people.empty") }}</p>
      <table v-else class="person-over-time">
        <thead><tr><th></th><th v-for="column in overTimeColumns" :key="column" :data-column="column">{{ t(`people.overTime.${column}`) }}</th><th aria-hidden="true"></th></tr></thead>
        <tbody>
          <tr v-for="row in view.overTime" :key="row.label">
            <th scope="row">{{ bucketLabel(row.label) }}</th>
            <td v-for="column in overTimeColumns" :key="column" class="num">{{ row[column] ?? "—" }}</td>
            <td class="person-bar-cell" aria-hidden="true"><span class="person-bar" :style="{ width: `${barOf(row) / maxBar * 100}%` }"></span></td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="person-section" data-section="areas">
      <h2 class="section-heading">{{ t("people.section.areas") }}</h2>
      <template v-if="view.activity">
        <ul v-if="view.activity.areas.labels.length > 0 || view.activity.areas.kips.length > 0" class="person-areas">
          <li v-for="entry in view.activity.areas.labels" :key="`label:${entry.label}`" data-area="label">{{ entry.label }} <span class="person-detail">{{ unit("thread", entry.threads) }}</span></li>
          <li v-for="entry in view.activity.areas.kips" :key="`kip:${entry.kip}`" data-area="kip">{{ entry.kip }} <span class="person-detail">{{ unit("thread", entry.threads) }}</span></li>
        </ul>
        <p v-else-if="view.activity.areas.noLabelSources.length === 0" class="person-note">{{ view.empty ? t("people.empty") : t("people.areas.empty") }}</p>
        <p v-if="view.activity.areas.noLabelSources.length > 0" class="person-note">{{ t("people.areas.noLabels", { sources: view.activity.areas.noLabelSources.map((item) => t(`people.overTime.${item}`)).join(t("people.listSeparator")) }) }}</p>
      </template>
      <p v-else class="person-note">{{ t("people.areas.none") }}</p>
    </section>

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

    <section class="person-section" data-section="works-with">
      <h2 class="section-heading">{{ t("people.section.worksWith") }}</h2>
      <div class="person-works">
        <template v-if="isGithub && reviewCoverage.length > 0">
          <div v-for="relation in (['reviewedPullRequestsBy', 'reviewedBy'] as const)" :key="relation" class="person-relation" :data-relation="relation">
            <h3 class="rail-label">{{ t(relation === "reviewedBy" ? "people.worksWith.reviewedBy" : "people.worksWith.reviewedPrsBy") }}</h3>
            <p v-if="view.worksWith[relation].length === 0" class="person-note">{{ t("people.worksWith.none") }}</p>
            <ul v-else>
              <li v-for="entry in view.worksWith[relation]" :key="entry.login">
                <RouterLink :to="personLink(`github:${entry.login}`)">{{ entry.login }}</RouterLink>
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
