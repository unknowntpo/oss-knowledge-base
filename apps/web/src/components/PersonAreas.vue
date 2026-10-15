<script setup lang="ts">
/**
 * Spec 019 W47–W50: the areas of the pull requests a person reviewed, and of their own pull
 * requests others reviewed, as a donut (the six largest areas and "other") with the same numbers
 * as text. Drawn only when every pull request of the period has stored labels (W49); otherwise the
 * page says how many do. Counts come from `profileAreaSide` in the reference pipeline.
 */
import { computed } from "vue";

import {
  areaTaxonomy,
  peopleProject,
  profileAreaSide,
  type PersonProfileV1,
  type ProfileAreaSide,
} from "@oss-knowledge-base/reference-pipeline/people";

import { useI18n } from "../i18n";

const props = defineProps<{ readonly profile: PersonProfileV1; readonly from: string }>();
const { t } = useI18n();

const RADIUS = 15.9155; // circumference 100, so a dash length is a percentage
const SLICE_COLORS = 7;

const sides = computed(() => {
  const pullAreas = props.profile.pullAreas ?? {};
  const taxonomy = peopleProject(props.profile.project.key) ?? areaTaxonomy(props.profile.project.id);
  const from = Date.parse(props.from);
  const inPeriod = (row: { readonly submittedAt: string }) => Date.parse(row.submittedAt) >= from;
  return ([
    ["given", props.profile.reviewsGiven.filter(inPeriod).map((row) => row.pr)],
    ["received", props.profile.reviewsReceived.filter(inPeriod).map((row) => row.pr)],
  ] as const)
    .map(([key, prs]) => ({ key, side: profileAreaSide(prs, pullAreas, taxonomy) }))
    .filter((entry) => entry.side.pullRequests > 0);
});

function percent(part: number, whole: number): string {
  return whole === 0 ? "0%" : `${Math.round(part / whole * 1000) / 10}%`;
}

function arcs(side: ProfileAreaSide) {
  const total = side.distribution.assignments;
  let offset = 0;
  return side.distribution.slices.map((slice, index) => {
    const length = total === 0 ? 0 : slice.items / total * 100;
    const arc = { slice, index, color: slice.other === true ? "other" : String(index % (SLICE_COLORS - 1) + 1), dash: `${length} ${100 - length}`, offset: 25 - offset };
    offset += length;
    return arc;
  });
}

function sliceLabel(slice: { readonly label: string; readonly other?: true }): string {
  return slice.other === true ? t("people.areas.other") : slice.label;
}

function otherLabels(side: ProfileAreaSide): string {
  return side.distribution.areas.slice(side.distribution.slices.filter((slice) => slice.other !== true).length)
    .map((area) => `${area.label} ${area.items}`).join(t("people.listSeparator"));
}

function summary(key: string, side: ProfileAreaSide): string {
  const parts = side.distribution.slices.map((slice) => `${sliceLabel(slice)} ${percent(slice.items, side.distribution.assignments)}`);
  return `${t(`people.areas.${key}`)}: ${parts.join(t("people.listSeparator"))}`;
}
</script>

<template>
  <div class="person-area-charts">
    <div v-for="{ key, side } in sides" :key="key" class="person-area-chart" :data-areas="key">
      <h3 class="rail-label">{{ t(`people.areas.${key}`) }}</h3>
      <p v-if="side.covered < side.pullRequests" class="person-note" data-areas-state="partial">
        {{ t("people.areas.partial", { covered: side.covered, total: side.pullRequests }) }}
      </p>
      <p v-else-if="side.distribution.assignments === 0" class="person-note" data-areas-state="unlabelled">
        {{ t("people.areas.noAreaLabels", { total: side.pullRequests }) }}
      </p>
      <div v-else class="person-area-body" data-areas-state="chart">
        <svg class="person-donut" viewBox="0 0 42 42" role="img" :aria-label="summary(key, side)">
          <circle class="person-donut-track" cx="21" cy="21" :r="RADIUS" fill="none" stroke-width="7" />
          <circle
            v-for="arc in arcs(side)"
            :key="arc.index"
            class="person-donut-slice"
            :data-color="arc.color"
            cx="21" cy="21" :r="RADIUS" fill="none" stroke-width="7"
            pathLength="100"
            :stroke-dasharray="arc.dash"
            :stroke-dashoffset="arc.offset"
          />
          <text x="21" y="20.5" text-anchor="middle" class="person-donut-total">{{ side.covered }}</text>
          <text x="21" y="26" text-anchor="middle" class="person-donut-unit">PR</text>
        </svg>
        <ul class="person-area-legend">
          <li v-for="arc in arcs(side)" :key="arc.index" :data-area-slice="arc.slice.other === true ? 'other' : arc.slice.label" :title="arc.slice.other === true ? otherLabels(side) : undefined">
            <span class="person-swatch" :data-color="arc.color" aria-hidden="true"></span>
            <span class="person-area-name">{{ sliceLabel(arc.slice) }}</span>
            <span class="person-area-count">{{ t("people.areas.count", { count: arc.slice.items, share: percent(arc.slice.items, side.distribution.assignments) }) }}</span>
          </li>
        </ul>
      </div>
      <p v-if="side.covered === side.pullRequests && side.distribution.assignments > 0" class="person-note person-area-foot">
        {{ t("people.areas.how", { prs: side.covered, assignments: side.distribution.assignments }) }}<template v-if="side.distribution.unlabelled > 0"> {{ t("people.areas.unlabelled", { count: side.distribution.unlabelled }) }}</template>
      </p>
      <p v-if="side.covered === side.pullRequests && side.distribution.slices.some((slice) => slice.other === true)" class="person-note" data-areas-other>
        {{ t("people.areas.otherList", { labels: otherLabels(side) }) }}
      </p>
      <p v-if="side.distribution.kips.length > 0" class="person-note" data-areas-kips>
        {{ t("people.areas.kipList", { kips: side.distribution.kips.slice(0, 5).map((entry) => `${entry.kip} ${entry.items}`).join(t("people.listSeparator")) }) }}
      </p>
    </div>
  </div>
</template>
