<script setup lang="ts">
/**
 * Spec 019 slice 2a: the profile page's sections 1–8, in the spec's order (W5). Counts come from
 * `profileView`, the function that computes the response's `totals` (W23).
 */
import { computed, ref } from "vue";

import {
  profileView,
  type PersonProfileV1,
  type ProfilePeriod,
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

const recorded = computed(() => props.profile.coverage.filter((item): item is Extract<SourceCoverageV1, { status: "recorded" }> => item.status === "recorded"));
const notRecorded = computed(() => props.profile.coverage.filter((item) => item.status === "not-recorded")
  .map((item) => t(`people.source.${item.source}`)).join(t("people.listSeparator")));
const maxBar = computed(() => Math.max(1, ...view.value.overTime.map((row) => row.given + row.received)));
const issuesUrl = "https://github.com/unknowntpo/oss-knowledge-base/issues";

function personLink(login: string): string {
  return `/${props.profile.project.key}/people/${encodeURIComponent(`github:${login}`)}`;
}
function stateText(states: Readonly<Partial<Record<string, number>>>): string {
  return STATES.filter((state) => (states[state] ?? 0) > 0).map((state) => `${t(`people.state.${state}`)} ${states[state]}`).join(", ");
}
/** English needs the singular for 1 (i18n.js has no plural rules; `results.search.one` does the same). */
function unit(name: "review" | "pr" | "reviewer", count: number): string {
  return t(`people.unit.${name}.${count === 1 ? "one" : "other"}`, { count });
}
function bucketLabel(label: string): string {
  return period.value === "12m" ? label : t("people.overTime.week", { date: label.slice(5) });
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
        <li v-for="item in recorded" :key="item.source">{{ t("people.coverage.reviews", { from: day(item.from), until: day(item.until) }) }}</li>
        <li v-if="notRecorded" class="not-recorded">{{ t("people.coverage.notRecorded", { sources: notRecorded }) }}</li>
      </ul>
      <p v-for="month in profile.unavailableMonths" :key="month" class="person-unavailable">{{ t("people.unavailable", { month }) }}</p>
    </header>

    <section class="person-section" data-section="identities">
      <h2 class="section-heading">{{ t("people.section.identities") }}</h2>
      <p class="person-identity">
        <span class="source-badge src-github">{{ t("people.identity.github") }}</span>
        <a :href="profile.identity.url" target="_blank" rel="noopener noreferrer">{{ profile.identity.display }}<span class="ext" aria-hidden="true">↗</span></a>
      </p>
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
      </dl>
    </section>

    <section class="person-section" data-section="over-time">
      <h2 class="section-heading">{{ t("people.section.overTime") }}</h2>
      <p v-if="view.empty" class="person-empty">{{ t("people.empty") }}</p>
      <table v-else class="person-over-time">
        <thead><tr><th></th><th>{{ t("people.overTime.given") }}</th><th>{{ t("people.overTime.received") }}</th><th aria-hidden="true"></th></tr></thead>
        <tbody>
          <tr v-for="row in view.overTime" :key="row.label">
            <th scope="row">{{ bucketLabel(row.label) }}</th>
            <td class="num">{{ row.given }}</td>
            <td class="num">{{ row.received }}</td>
            <td class="person-bar-cell" aria-hidden="true"><span class="person-bar" :style="{ width: `${(row.given + row.received) / maxBar * 100}%` }"></span></td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="person-section" data-section="areas">
      <h2 class="section-heading">{{ t("people.section.areas") }}</h2>
      <p class="person-note">{{ t("people.areas.none") }}</p>
    </section>

    <section id="person-threads" class="person-section" data-section="threads">
      <h2 class="section-heading">{{ t("people.section.threads") }}</h2>
      <p v-if="view.empty" class="person-empty">{{ t("people.empty") }}</p>
      <ol v-else class="person-threads">
        <li v-for="thread in view.threads.slice(0, shownThreads)" :key="`${thread.role}:${thread.pr}`" class="person-thread">
          <a class="person-thread-pr" :href="thread.url" target="_blank" rel="noopener noreferrer">#{{ thread.pr }}</a>
          <span class="person-thread-part">
            <template v-if="thread.role === 'reviewer'">{{ t("people.thread.reviewer", { author: thread.counterpart ?? t("people.thread.hidden") }) }}</template>
            <template v-else>{{ t("people.thread.author", { reviewers: unit("reviewer", thread.reviewers) }) }}</template>
            · {{ stateText(thread.states) }}
          </span>
          <time class="person-thread-date" :datetime="thread.lastAt">{{ day(thread.lastAt) }}</time>
        </li>
      </ol>
      <button v-if="!view.empty && view.threads.length > shownThreads" type="button" class="btn" @click="shownThreads += THREAD_PAGE">{{ t("people.threads.older") }}</button>
    </section>

    <section class="person-section" data-section="works-with">
      <h2 class="section-heading">{{ t("people.section.worksWith") }}</h2>
      <div class="person-works">
        <div v-for="relation in (['reviewedPullRequestsBy', 'reviewedBy'] as const)" :key="relation" class="person-relation" :data-relation="relation">
          <h3 class="rail-label">{{ t(relation === "reviewedBy" ? "people.worksWith.reviewedBy" : "people.worksWith.reviewedPrsBy") }}</h3>
          <p v-if="view.worksWith[relation].length === 0" class="person-note">{{ t("people.worksWith.none") }}</p>
          <ul v-else>
            <li v-for="entry in view.worksWith[relation]" :key="entry.login">
              <RouterLink :to="personLink(entry.login)">{{ entry.login }}</RouterLink>
              <span class="person-detail">{{ t("people.worksWith.prs", { count: entry.pullRequests }) }}</span>
            </li>
          </ul>
        </div>
      </div>
    </section>

    <section class="person-section person-how" data-section="how">
      <h2 class="section-heading">{{ t("people.section.how") }}</h2>
      <ul>
        <li v-for="item in recorded" :key="item.source">{{ t("people.how.source", { from: day(item.storedFrom) }) }}</li>
        <li>{{ t("people.how.period", { from: day(profile.period.from), until: day(profile.period.until) }) }}</li>
        <li>{{ t("people.how.notCounted") }}</li>
        <li v-if="notRecorded">{{ t("people.how.notRecorded", { sources: notRecorded }) }}</li>
        <li><a :href="issuesUrl" target="_blank" rel="noopener noreferrer">{{ t("people.how.report") }}</a></li>
      </ul>
    </section>
  </article>
</template>
