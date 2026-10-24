<script setup lang="ts">
/**
 * Spec 019 amendment (5), W57–W61: activity over time, left to right. The person's own actions are
 * stacked above the axis, reviews they received are mirrored below it, on one scale. Buckets with
 * nothing recorded are a hatched band; a series recorded only in part gets a coverage lane. The
 * `svg` is `role="img"` with a text alternative, and "Show as table" gives every number.
 */
import { computed, onBeforeUnmount, onMounted, ref, useId } from "vue";

import type { ProfilePeriod } from "@oss-knowledge-base/reference-pipeline/people";

import { useI18n } from "../i18n";
import { activityChart, bucketEnd, bucketStart, chartLayout, type ChartBucket, type ChartInput, type ChartSeries } from "../profile-chart";

const props = withDefaults(defineProps<{
  readonly input: ChartInput;
  readonly name: string;
  readonly initialTable?: boolean;
  /** Spec 030 decision 4: a vertical line where a later series starts (ISO time) and its label. */
  readonly marker?: { readonly at: string; readonly label: string };
  /** The bucket whose tooltip shows first (server rendering and tests; the browser follows the pointer). */
  readonly initialHover?: number;
  /** Spec 030 Behavior 9: the trend names the range and the newest month instead of the busiest one. */
  readonly label?: string;
}>(), { initialTable: false, marker: undefined, initialHover: undefined, label: undefined });
const { t, locale } = useI18n();
const hatch = `person-hatch-${useId()}`;

/** Server rendering has no width; the browser measures the card and redraws. */
const width = ref(640);
const wrap = ref<HTMLElement>();
let observer: ResizeObserver | undefined;
onMounted(() => {
  const measure = () => { if (wrap.value && wrap.value.clientWidth > 0) width.value = wrap.value.clientWidth; };
  measure();
  if (typeof ResizeObserver !== "undefined" && wrap.value) {
    observer = new ResizeObserver(measure);
    observer.observe(wrap.value);
  }
});
onBeforeUnmount(() => observer?.disconnect());

const chart = computed(() => activityChart(props.input));
const layout = computed(() => chartLayout(chart.value, width.value));
const period = computed<ProfilePeriod>(() => props.input.period);
const hovered = ref<number | undefined>(props.initialHover);
const showTable = ref(props.initialTable);

const md = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
function seriesLabel(series: ChartSeries): string {
  // Spec 030: a project's reviews are all reviews, not the ones a person gave.
  if (props.input.source === "project" && series === "given") return t("trend.series.given");
  return t(`people.chart.series.${series}`);
}
/** Totals on the bars only where the widest one fits its column (4-digit project counts need wider columns than a person's). */
const totalsFit = computed(() => {
  const digits = String(Math.max(0, ...chart.value.buckets.flatMap((bucket) => [bucket.up, bucket.down]))).length;
  return layout.value.slot >= (digits <= 2 ? 18 : digits * 7 + 6);
});
/** x of the marker: its bucket's left edge plus the elapsed share of the bucket. */
const markerX = computed(() => {
  const at = props.marker?.at;
  if (at === undefined) return undefined;
  const index = chart.value.buckets.findIndex((bucket) => bucketStart(bucket.label) <= at && at <= bucketEnd(bucket.label));
  if (index < 0) return undefined;
  const label = chart.value.buckets[index]!.label;
  const share = (Date.parse(at) - Date.parse(bucketStart(label))) / (Date.parse(bucketEnd(label)) + 1 - Date.parse(bucketStart(label)));
  return layout.value.left + layout.value.slot * (index + share);
});
function axisLabel(label: string): string {
  if (label.length !== 7) return md(label);
  return new Intl.DateTimeFormat(locale.value === "zh-Hant" ? "zh-Hant-TW" : "en", { month: "short", timeZone: "UTC" }).format(new Date(`${label}-01T00:00:00Z`));
}
function bucketName(label: string): string {
  if (label.length !== 7) return t("people.overTime.week", { date: label.slice(5) });
  return new Intl.DateTimeFormat(locale.value === "zh-Hant" ? "zh-Hant-TW" : "en", { year: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${label}-01T00:00:00Z`));
}
function notes(bucket: ChartBucket): string[] {
  return [
    ...bucket.partial.map((item) => t("people.chart.since", { series: seriesLabel(item.series), date: md(item.from) })),
    ...(bucket.clipped && bucket.partial.length === 0 ? [t("people.chart.clipped", { date: md(props.input.from) })] : []),
  ];
}
const allSeries = computed(() => [...chart.value.up, ...chart.value.down]);

const ariaLabel = computed(() => {
  if (props.label !== undefined) return props.label;
  const peak = chart.value.peak;
  return t("people.chart.aria", {
    name: props.name,
    period: t(`people.chart.period.${period.value}`),
    bucket: t(`people.chart.bucket.${period.value}`),
    up: chart.value.up.map(seriesLabel).join(t("people.listSeparator")),
    down: chart.value.down.length === 0 ? "" : t("people.chart.aria.down", { series: chart.value.down.map(seriesLabel).join(t("people.listSeparator")) }),
    peak: peak === undefined ? t("people.chart.aria.none") : t("people.chart.aria.peak", { bucket: bucketName(peak.label), count: peak.up }),
  });
});

/** The tooltip sits above the column, kept inside the card. */
const TIP_WIDTH = 200;
const tip = computed(() => {
  if (hovered.value === undefined) return undefined;
  const column = layout.value.columns[hovered.value];
  const bucket = chart.value.buckets[hovered.value];
  if (column === undefined || bucket === undefined) return undefined;
  const left = Math.max(0, Math.min(layout.value.width - TIP_WIDTH, column.x - TIP_WIDTH / 2));
  return { bucket, left, top: Math.max(0, column.upTop - 8) };
});
function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  const radius = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + radius}Q${x},${y} ${x + radius},${y}H${x + w - radius}Q${x + w},${y} ${x + w},${y + radius}V${y + h}Z`;
}
function roundedBottom(x: number, y: number, w: number, h: number, r: number): string {
  const radius = Math.min(r, h, w / 2);
  return `M${x},${y}H${x + w}V${y + h - radius}Q${x + w},${y + h} ${x + w - radius},${y + h}H${x + radius}Q${x},${y + h} ${x},${y + h - radius}Z`;
}
function segmentPath(x: number, segment: { readonly series: ChartSeries; readonly y: number; readonly height: number; readonly cap: boolean }): string {
  const w = layout.value.barWidth;
  const left = x - w / 2;
  if (chart.value.down.includes(segment.series)) return roundedBottom(left, segment.y + 1, w, Math.max(0, segment.height - 1), 3);
  return segment.cap ? roundedTop(left, segment.y, w, segment.height, 3) : `M${left},${segment.y}h${w}v${segment.height}h${-w}Z`;
}
</script>

<template>
  <div class="person-chart-block">
    <ul class="person-legend" data-chart-legend>
      <li v-for="series in chart.up" :key="series" :data-legend="series"><span class="person-swatch" :data-series="series" aria-hidden="true"></span>{{ seriesLabel(series) }}</li>
      <li v-for="series in chart.down" :key="series" :data-legend="series"><span class="person-swatch" :data-series="series" aria-hidden="true"></span>{{ t("people.chart.below", { series: seriesLabel(series) }) }}</li>
      <li v-if="layout.bands.length > 0 || layout.lanes.length > 0" data-legend="not-recorded"><span class="person-swatch person-swatch-hatch" aria-hidden="true"></span>{{ t("people.chart.notRecorded") }}</li>
    </ul>
    <div ref="wrap" class="person-chart person-over-time" @pointerleave="hovered = undefined">
      <svg class="person-chart-svg" role="img" :aria-label="ariaLabel" :width="layout.width" :height="layout.height" :viewBox="`0 0 ${layout.width} ${layout.height}`">
        <defs>
          <pattern :id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" class="person-hatch-bg" />
            <line x1="0" y1="0" x2="0" y2="6" class="person-hatch-line" />
          </pattern>
        </defs>
        <g v-for="band in layout.bands" :key="`band-${band.first}`" data-band>
          <rect :x="band.x" :y="layout.top" :width="band.width" :height="layout.bottom - layout.top" rx="4" :fill="`url(#${hatch})`" />
          <text v-if="band.width > 56" :x="band.x + band.width / 2" :y="layout.top + (layout.zero - layout.top) / 2 + 4" text-anchor="middle" class="person-chart-band">{{ t("people.chart.notRecorded") }}</text>
        </g>
        <g aria-hidden="true">
          <template v-for="tick in layout.ticks" :key="`tick-${tick.y}`">
            <line :x1="layout.left" :x2="layout.width - layout.right" :y1="tick.y" :y2="tick.y" :class="tick.value === 0 ? 'person-chart-axis' : 'person-chart-grid'" />
            <text :x="layout.left - 6" :y="tick.y + 4" text-anchor="end">{{ tick.value }}</text>
          </template>
        </g>
        <g v-if="marker && markerX !== undefined" data-marker aria-hidden="true">
          <line :x1="markerX" :x2="markerX" :y1="layout.top - 6" :y2="layout.bottom" class="person-chart-marker" />
          <text :x="markerX > layout.width / 2 ? markerX - 4 : markerX + 4" :y="layout.top - 8" :text-anchor="markerX > layout.width / 2 ? 'end' : 'start'" class="person-chart-marker-label">{{ marker.label }}</text>
        </g>
        <g v-for="column in layout.columns" :key="`col-${column.index}`" :data-bucket="chart.buckets[column.index]!.label">
          <path v-for="segment in column.segments" :key="segment.series" :d="segmentPath(column.x, segment)" :data-series="segment.series" />
          <text v-if="chart.buckets[column.index]!.up > 0 && totalsFit" :x="column.x" :y="column.upTop - 4" text-anchor="middle" class="person-chart-total" data-total="up">{{ chart.buckets[column.index]!.up }}</text>
          <text v-if="chart.buckets[column.index]!.down > 0 && totalsFit" :x="column.x" :y="column.downBottom + 12" text-anchor="middle" class="person-chart-total is-down" data-total="down">{{ chart.buckets[column.index]!.down }}</text>
        </g>
        <text v-for="index in layout.labelled" :key="`label-${index}`" :x="layout.columns[index]!.x" :y="layout.labelY" text-anchor="middle">{{ axisLabel(chart.buckets[index]!.label) }}</text>
        <g v-for="lane in layout.lanes" :key="`lane-${lane.series}`" :data-lane="lane.series">
          <text :x="layout.left + 2" :y="lane.y - 5" class="person-chart-lane">{{ t("people.chart.lane", { series: seriesLabel(lane.series) }) }}</text>
          <rect
            v-for="(bucket, index) in chart.buckets"
            :key="bucket.label"
            :x="layout.left + layout.slot * index + 1" :y="lane.y" :width="Math.max(1, layout.slot - 2)" height="8" rx="2"
            :fill="bucket.values[lane.series] === null ? `url(#${hatch})` : undefined"
            :data-series="bucket.values[lane.series] === null ? undefined : lane.series"
            :data-recorded="bucket.values[lane.series] === null ? 'no' : 'yes'"
          />
        </g>
        <rect
          v-for="column in layout.columns" :key="`hit-${column.index}`"
          class="person-chart-hit" :class="{ 'is-on': hovered === column.index }"
          :x="layout.left + layout.slot * column.index" :y="layout.top - 12" :width="layout.slot" :height="layout.labelY - layout.top + 16"
          @pointerenter="hovered = column.index" @pointerdown="hovered = column.index"
        />
      </svg>
      <div v-if="tip" class="person-chart-tip" :style="{ left: `${tip.left}px`, top: `${tip.top}px`, width: `${TIP_WIDTH}px` }" aria-hidden="true" data-tip>
        <strong>{{ bucketName(tip.bucket.label) }}</strong>
        <span v-for="series in allSeries" :key="series" class="person-chart-tip-row">
          <span><span class="person-swatch" :data-series="series"></span>{{ seriesLabel(series) }}</span>
          <b>{{ tip.bucket.values[series] ?? t("people.chart.notRecorded") }}</b>
        </span>
        <span v-for="note in notes(tip.bucket)" :key="note" class="person-chart-tip-note">{{ note }}</span>
      </div>
    </div>
    <div class="person-chart-foot">
      <slot />
      <button type="button" class="person-table-toggle" :aria-expanded="showTable" data-table-toggle @click="showTable = !showTable">{{ t(showTable ? "people.chart.table.hide" : "people.chart.table.show") }}</button>
    </div>
    <div v-if="showTable" class="person-chart-table-wrap">
      <table class="person-chart-table" data-chart-table>
        <caption>{{ t("people.chart.table.caption", { bucket: t(`people.chart.bucket.${period}`) }) }}</caption>
        <thead><tr><th scope="col">{{ t(`people.chart.table.${period}`) }}</th><th v-for="series in allSeries" :key="series" scope="col" :data-column="series">{{ seriesLabel(series) }}</th></tr></thead>
        <tbody>
          <tr v-for="bucket in chart.buckets" :key="bucket.label">
            <th scope="row">{{ bucketName(bucket.label) }}</th>
            <td v-for="series in allSeries" :key="series" :class="{ 'is-unrecorded': bucket.values[series] === null }">{{ bucket.values[series] ?? t("people.chart.notRecorded") }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
