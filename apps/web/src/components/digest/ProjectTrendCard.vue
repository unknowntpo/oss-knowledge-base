<script setup lang="ts">
/**
 * Spec 030 Behavior 4–9: the project activity trend on This week. Compact: 12 stacked monthly bars,
 * the first and last month, the current month in progress (dashed), and a hatched lane per series
 * recorded only in part. Expanded in place: the profile's chart in project mode with the 9/10
 * marker, the table and the data range line. Both read the one response already loaded.
 */
import { computed, onBeforeUnmount, ref, useId, watch } from "vue";

import { useI18n } from "../../i18n";
import { activityChart, type ChartSeries } from "../../profile-chart";
import {
  compactLayout, coverageMarker, inProgressDate, monthDay, recordedCoverage, trendChartInput, trendStale, trendVisible, updatedAt,
  type TrendAnswer,
} from "../../project-trend";
import PersonActivityChart from "../PersonActivityChart.vue";

const props = withDefaults(defineProps<{
  readonly answer: TrendAnswer;
  readonly projectName: string;
  readonly nowMs: number;
  readonly initialExpanded?: boolean;
  readonly initialHover?: number;
  readonly initialTable?: boolean;
}>(), { initialExpanded: false, initialHover: undefined, initialTable: false });
const { t, locale } = useI18n();
const id = useId();
const hatch = `trend-hatch-${id}`;
const expanded = ref(props.initialExpanded);

const width = ref(640);
const wrap = ref<HTMLElement>();
let observer: ResizeObserver | undefined;
const measure = () => { if (wrap.value && wrap.value.clientWidth > 0) width.value = wrap.value.clientWidth; };
/** The compact view mounts after the answer arrives and again after collapsing: observe whichever element is there. */
watch(wrap, (element) => {
  observer?.disconnect();
  observer = undefined;
  if (element === undefined) return;
  measure();
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(measure);
    observer.observe(element);
  }
}, { flush: "post" });
onBeforeUnmount(() => observer?.disconnect());

const body = computed(() => (props.answer.kind === "ok" ? props.answer.body : undefined));
const visible = computed(() => props.answer.kind !== "ok" || trendVisible(props.answer.body));
const input = computed(() => (body.value === undefined ? undefined : trendChartInput(body.value, props.nowMs)));
const chart = computed(() => (input.value === undefined ? undefined : activityChart(input.value)));
const layout = computed(() => (chart.value === undefined ? undefined : compactLayout(chart.value, width.value)));
const lastIndex = computed(() => (chart.value?.buckets.length ?? 0) - 1);

const localeTag = computed(() => (locale.value === "zh-Hant" ? "zh-Hant-TW" : "en"));
const monthName = (label: string, month: "short" | "long" = "short") =>
  new Intl.DateTimeFormat(localeTag.value, { ...(month === "long" ? { year: "numeric" } : {}), month, timeZone: "UTC" }).format(new Date(`${label}-01T00:00:00Z`));
function seriesLabel(series: ChartSeries): string {
  return series === "given" ? t("trend.series.given") : t(`people.chart.series.${series}`);
}

const ariaLabel = computed(() => {
  const current = chart.value?.buckets.at(-1);
  if (chart.value === undefined || current === undefined) return "";
  return t("trend.aria", {
    project: props.projectName,
    from: monthName(chart.value.buckets[0]!.label, "long"),
    to: monthName(current.label, "long"),
    counts: chart.value.up.map((series) => `${seriesLabel(series)} ${current.values[series] ?? t("people.chart.notRecorded")}`).join(t("people.listSeparator")),
  });
});

/** "Data range": where each source starts; the activity log's sources share one start (W27). */
const rangeItems = computed(() => {
  if (body.value === undefined) return "";
  const recorded = recordedCoverage(body.value);
  const groups = new Map<string, string[]>();
  for (const item of recorded) groups.set(item.from, [...(groups.get(item.from) ?? []), t(`people.source.${item.source}`)]);
  return [...groups].map(([from, sources]) => t("people.range.item", { source: sources.join(t("people.listSeparator")), date: monthDay(from) })).join(" · ");
});
const notRecorded = computed(() => (body.value?.coverage ?? []).filter((item) => item.status === "not-recorded")
  .map((item) => t(`people.source.${item.source}`)).join(t("people.listSeparator")));
const marker = computed(() => {
  const at = body.value === undefined ? undefined : coverageMarker(body.value);
  return at === undefined ? undefined : { at, label: t("trend.marker") };
});
const stale = computed(() => body.value !== undefined && trendStale(body.value, props.nowMs));

function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  const radius = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + radius}Q${x},${y} ${x + radius},${y}H${x + w - radius}Q${x + w},${y} ${x + w},${y + radius}V${y + h}Z`;
}
function segmentPath(x: number, segment: { readonly y: number; readonly height: number; readonly cap: boolean }): string {
  const w = layout.value!.barWidth;
  const left = x - w / 2;
  return segment.cap ? roundedTop(left, segment.y, w, segment.height, 2) : `M${left},${segment.y}h${w}v${segment.height}h${-w}Z`;
}
</script>

<template>
  <p v-if="answer.kind === 'error'" class="project-trend project-trend-error" data-project-trend>{{ t("trend.unavailable") }}</p>
  <section v-else-if="visible" class="project-trend" :class="{ 'is-loading': answer.kind === 'loading' }" :aria-labelledby="`trend-title-${id}`" data-project-trend>
    <div class="project-trend-head">
      <h2 :id="`trend-title-${id}`" class="digest-section-title project-trend-title">{{ t("trend.title") }}</h2>
      <button v-if="body" type="button" class="person-table-toggle project-trend-toggle" :aria-expanded="expanded" data-trend-toggle @click="expanded = !expanded">
        {{ t(expanded ? "trend.collapse" : "trend.expand") }}
      </button>
    </div>
    <template v-if="body && chart && layout">
      <p v-for="month in body.unavailableMonths" :key="month" class="project-trend-note">{{ t("trend.monthUnavailable", { month: monthName(month, "long") }) }}</p>
      <p v-if="stale" class="digest-lag">{{ t("trend.lag", { date: monthDay(body.until!) }) }}</p>
      <div v-if="!expanded" ref="wrap" class="project-trend-compact">
        <ul class="person-legend project-trend-legend">
          <li v-for="series in chart.up" :key="series"><span class="person-swatch" :data-series="series" aria-hidden="true"></span>{{ seriesLabel(series) }}</li>
          <li v-if="layout.lanes.length > 0"><span class="person-swatch person-swatch-hatch" aria-hidden="true"></span>{{ t("people.chart.notRecorded") }}</li>
        </ul>
        <svg
          class="person-chart-svg project-trend-svg" role="img" :aria-label="ariaLabel" :width="layout.width" :height="layout.height"
          :viewBox="`0 0 ${layout.width} ${layout.height}`" :data-plot-height="layout.plotHeight"
        >
          <defs>
            <pattern :id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" class="person-hatch-bg" />
              <line x1="0" y1="0" x2="0" y2="6" class="person-hatch-line" />
            </pattern>
          </defs>
          <line :x1="layout.left" :x2="layout.width - layout.right" :y1="layout.zero" :y2="layout.zero" class="person-chart-axis" aria-hidden="true" />
          <g v-for="column in layout.columns" :key="column.index" :data-trend-bucket="chart.buckets[column.index]!.label">
            <path
              v-for="segment in column.segments" :key="segment.series" :d="segmentPath(column.x, segment)" :data-series="segment.series"
              :class="{ 'is-current': column.index === lastIndex }"
            />
          </g>
          <text :x="layout.left" :y="layout.labelY" text-anchor="start" :data-trend-label="chart.buckets[0]!.label">{{ monthName(chart.buckets[0]!.label) }}</text>
          <text :x="layout.width - layout.right" :y="layout.labelY" text-anchor="end" :data-trend-label="chart.buckets[lastIndex]!.label">{{ monthName(chart.buckets[lastIndex]!.label) }} <tspan class="project-trend-progress" data-in-progress>· {{ t("trend.inProgress", { date: inProgressDate(body, nowMs) }) }}</tspan></text>
          <g v-for="lane in layout.lanes" :key="lane.series" :data-lane="lane.series" aria-hidden="true">
            <rect
              v-for="(bucket, index) in chart.buckets" :key="bucket.label"
              :x="layout.left + layout.slot * index + 1" :y="lane.y" :width="Math.max(1, layout.slot - 2)" :height="layout.laneHeight" rx="1.5"
              :fill="bucket.values[lane.series] === null ? `url(#${hatch})` : undefined"
              :data-series="bucket.values[lane.series] === null ? undefined : lane.series"
              :data-recorded="bucket.values[lane.series] === null ? 'no' : 'yes'"
            />
          </g>
        </svg>
      </div>
      <div v-else class="project-trend-full">
        <PersonActivityChart :input="input!" :name="projectName" :label="`${ariaLabel} ${t('trend.aria.table')}`" :marker="marker" :initial-hover="initialHover" :initial-table="initialTable">
          <details class="person-range" data-range>
            <summary>{{ t("people.range.summary", { items: rangeItems }) }}</summary>
            <ul class="person-coverage">
              <li v-if="notRecorded" class="not-recorded">{{ t("people.coverage.notRecorded", { sources: notRecorded }) }}</li>
              <li v-if="body.until">{{ t("trend.updated", { time: updatedAt(body.until) }) }}</li>
              <li>{{ t("trend.unit") }}</li>
            </ul>
          </details>
        </PersonActivityChart>
      </div>
    </template>
  </section>
</template>
