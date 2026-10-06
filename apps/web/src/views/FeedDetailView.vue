<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { fetchFeedDetail, fetchSearchFeedDetail } from "../api";
import { useI18n } from "../i18n";
import { useFeedStore } from "../store";
import type { FeedDetail, FeedIndexEntry, SourceRecordView } from "../types";

const props = defineProps<{
  readonly id?: string;
  readonly detailRef?: string;
}>();
const { payload } = useFeedStore();
const { t } = useI18n();
const detail = ref<FeedDetail>();
const error = ref<string>();
const sourceFilter = ref("");
const keyPointsOpen = ref(false);
const detailLoading = ref(true);

const feedItem = computed(() => payload.value?.entries.find((entry) => entry.displayId === props.id));
const item = computed<FeedIndexEntry | undefined>(() =>
  feedItem.value ?? (detail.value === undefined ? undefined : searchIndexEntry(detail.value)));
const profile = computed(() => payload.value?.projects.find((profile) => profile.key === item.value?.projectKey));

watch(() => [props.id, props.detailRef, feedItem.value] as const, async () => {
  error.value = undefined;
  detail.value = undefined;
  detailLoading.value = true;
  try {
    if (props.detailRef !== undefined) {
      detail.value = await fetchSearchFeedDetail(props.detailRef);
    } else if (feedItem.value !== undefined) {
      detail.value = await fetchFeedDetail(feedItem.value);
    } else {
      error.value = "Feed entry not found.";
    }
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    detailLoading.value = false;
  }
}, { immediate: true });

function searchIndexEntry(value: FeedDetail): FeedIndexEntry {
  const records = value.records;
  const projectKey = payload.value?.entries.find(
    (entry) => entry.entry.projectId === value.entry.projectId,
  )?.projectKey ?? value.entry.projectId;
  const root = records.find((record) => record.id === value.entry.sourceTitleRecordId);
  return {
    // Details published since Spec 012 carry their display id; older ones fall back to the title prefix.
    displayId: value.displayId ?? root?.title.split(":", 1)[0] ?? value.entry.sourceTitleRecordId,
    projectKey,
    status: root?.artifactStatus ?? "",
    releaseLabel: "Evidence search",
    authors: [...new Set(records.map((record) => record.author))],
    tags: [],
    links: Object.fromEntries(records.map((record) => [record.source, record.canonicalUrl])),
    sourceCounts: Object.fromEntries([...new Set(records.map((record) => record.source))]
      .map((source) => [source, records.filter((record) => record.source === source).length])),
    lastActivityAt: records.map((record) => record.occurredAt).sort().at(-1) ?? "",
    searchText: "",
    entry: value.entry,
  };
}

function recordTime(record: SourceRecordView): string {
  return record.occurredAt;
}

const records = computed(() => detail.value?.records ?? []);
const sources = computed(() => {
  const actualSources = [...new Set(records.value.map((record) => record.source))];
  const preferredOrder = profile.value?.sources ?? [];
  return [...new Set([...preferredOrder, ...actualSources])]
    .filter((source) => actualSources.includes(source));
});
const sourceCounts = computed(() => Object.fromEntries(sources.value.map((source) => [
  source,
  records.value.filter((record) => record.source === source).length,
])));
const maxSourceCount = computed(() => Math.max(1, ...Object.values(sourceCounts.value)));
const timeline = computed(() => [...records.value]
  .filter((record) => sourceFilter.value === "" || record.source === sourceFilter.value)
  .sort((left, right) => Date.parse(recordTime(right)) - Date.parse(recordTime(left))));

function relativeTime(value: string): string {
  const days = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 86_400_000));
  if (days === 0) return t("date.today");
  if (days < 7) return t("date.daysAgo", { count: days });
  if (days < 30) return t("date.weeksAgo", { count: Math.floor(days / 7) });
  if (days < 365) return t("date.monthsAgo", { count: Math.floor(days / 30) });
  return t("date.yearsAgo", { count: Math.floor(days / 365) });
}

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0] ?? "").join("").toUpperCase();
}

function evidenceLabel(id: string): string {
  const record = records.value.find((item) => item.id === id);
  return record === undefined ? id : `${t(`source.${record.source}`)} · ${recordTime(record).slice(0, 10)}`;
}

function jumpToEvidence(id: string) {
  sourceFilter.value = "";
  requestAnimationFrame(() => document.getElementById(`record-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
}
</script>

<template>
  <section id="view-topic" class="view">
    <div v-if="detailLoading" class="load-error"><p>Loading detail…</p></div>
    <div v-else-if="item" class="topic-wrap">
      <RouterLink class="back-link" to="/"><span aria-hidden="true">←</span> {{ t("topic.back") }}</RouterLink>
      <div class="topic-head">
        <div class="topic-head-row">
          <span class="topic-id">{{ item.displayId }}</span>
          <span v-if="item.status" class="status-badge" :class="`status-${item.status}`">{{ t(`status.${item.status}`) }}</span>
          <span class="card-project">{{ profile?.label ?? item.projectKey }}</span>
        </div>
        <h1 id="topic-title">{{ item.entry.title }}</h1>
        <p class="topic-lede">{{ item.entry.summary }}</p>
        <div class="topic-meta">
          <span><span class="k">{{ t("topic.proposer") }}</span>{{ item.authors.join("、") }}</span>
          <span><span class="k">{{ t("topic.release") }}</span>{{ item.releaseLabel }}</span>
          <span><span class="k">{{ t("topic.records") }}</span>{{ t("topic.recordCount", { count: records.length }) }}</span>
        </div>
        <div class="source-links">
          <a v-for="(url, source) in item.links" :key="source" class="source-link" :href="url" target="_blank" rel="noopener noreferrer">
            <span class="source-badge" :class="`src-${source}`">{{ t(`source.${source}`) }}</span>
            {{ payload?.sourceTypes[source]?.full ?? t(`sourceFull.${source}`) }}<span class="ext" aria-hidden="true">↗</span>
          </a>
        </div>
      </div>

      <div v-if="error" class="load-error"><p>{{ error }}</p></div>
      <div v-else-if="!detail && !records.length" class="load-error"><p>Loading detail…</p></div>
      <div v-else class="topic-grid">
        <div>
          <div class="ai-card">
            <div class="ai-head"><h2 class="ai-title">{{ t("keyPoints.title") }}</h2><span class="optional-tag">{{ t("keyPoints.optional") }}</span></div>
            <p class="ai-note">{{ t("keyPoints.note") }}</p>
            <template v-if="detail?.keyPoints.status === 'generated'">
              <div class="ai-actions">
                <button type="button" class="btn btn-primary" :aria-expanded="keyPointsOpen" @click="keyPointsOpen = !keyPointsOpen">
                  {{ keyPointsOpen ? t("keyPoints.collapse") : t("keyPoints.show") }}
                </button>
                <span class="ai-note">{{ detail.keyPoints.derivation.kind === "source-extract" ? t("keyPoints.sourceExtract") : t("keyPoints.generated") }}</span>
              </div>
              <div v-if="keyPointsOpen" class="ai-body">
                <p class="ai-generated-note">{{ t("keyPoints.count", { count: detail.keyPoints.points.length }) }}</p>
                <ul class="ai-list">
                  <li v-for="(point, index) in detail.keyPoints.points" :key="point.id" class="ai-item">
                    <span class="n">{{ String(index + 1).padStart(2, "0") }}</span>
                    <div><p>{{ point.text }}</p><div class="evidence-links">
                      <button v-for="recordId in point.evidenceRecordIds" :key="recordId" type="button" class="evidence-btn" @click="jumpToEvidence(recordId)">{{ evidenceLabel(recordId) }}</button>
                    </div></div>
                  </li>
                </ul>
              </div>
            </template>
            <p v-else class="key-points-state">{{ detail?.keyPoints.status === "failed" ? t("keyPoints.failed") : t("keyPoints.unavailable") }}</p>
          </div>

          <div class="timeline-head"><h2 class="section-heading">{{ t("timeline.title") }}</h2><span class="tl-kind">{{ t("timeline.order", { count: timeline.length }) }}</span></div>
          <div class="timeline-filters" role="group" :aria-label="t('a11y.timelineFilters')">
            <button type="button" class="tl-filter" :aria-pressed="sourceFilter === ''" @click="sourceFilter = ''">{{ t("filter.allSources") }}<span class="count">{{ records.length }}</span></button>
            <button v-for="source in sources" :key="source" type="button" class="tl-filter" :aria-pressed="sourceFilter === source" @click="sourceFilter = source">
              {{ t(`source.${source}`) }}<span class="count">{{ sourceCounts[source] }}</span>
            </button>
          </div>
          <ol class="timeline">
            <template v-for="(record, index) in timeline" :key="record.id">
              <li v-if="index === 0 || recordTime(timeline[index - 1]!).slice(0, 4) !== recordTime(record).slice(0, 4)" class="tl-period">{{ t("timeline.year", { year: recordTime(record).slice(0, 4) }) }}</li>
              <li :id="`record-${record.id}`" class="tl-item" :class="`is-${record.source}`">
                <div class="tl-card">
                  <div class="tl-meta">
                    <span class="source-badge" :class="`src-${record.source}`">{{ t(`source.${record.source}`) }}</span>
                    <span class="author"><span class="avatar" aria-hidden="true">{{ initials(record.author) }}</span>{{ record.author }}</span>
                    <span class="tl-kind">{{ record.role }} · {{ record.kind }}</span>
                    <span class="tl-time">{{ recordTime(record).slice(0, 10) }}</span>
                  </div>
                  <h3 class="tl-title">{{ record.title }}</h3>
                  <p class="tl-excerpt">{{ record.excerpt }}</p>
                  <div class="tl-foot"><span>{{ relativeTime(recordTime(record)) }} · {{ record.artifactStatus ?? "" }}</span>
                    <a class="tl-link" :href="record.canonicalUrl" target="_blank" rel="noopener noreferrer">{{ t("timeline.openSource") }}</a>
                  </div>
                </div>
              </li>
            </template>
          </ol>
        </div>

        <aside class="rail" :aria-label="t('a11y.topicRail')">
          <div><div class="rail-label">{{ t("rail.sources") }}</div><div class="rail-rows">
            <div v-for="source in sources" :key="source" class="rail-source">
              <span class="rail-source-label">{{ t(`source.${source}`) }}</span>
              <div class="bar" :style="{ width: `${Math.max(6, sourceCounts[source] / maxSourceCount * 100)}%` }"></div>
              <span class="num">{{ sourceCounts[source] }}</span>
            </div>
          </div></div>
          <div v-if="detail?.related?.length"><div class="rail-label">{{ t("rail.related") }}</div>
            <div class="related-list">
              <RouterLink v-for="link in detail.related" :key="link.displayId" class="related-item" :to="`/feed/${encodeURIComponent(link.displayId)}`">
                <span class="rid">{{ link.displayId }} · {{ t(`source.${link.source}`) }} · {{ t(`related.${link.rule}`) }}</span>
                <span class="rtitle">{{ link.title }}</span>
              </RouterLink>
            </div>
          </div>
          <div><div class="rail-label">{{ t("rail.tags") }}</div><div class="tag-chips"><span v-for="tag in item.tags" :key="tag" class="tag-chip">{{ tag }}</span></div></div>
          <p class="rail-note">{{ t("rail.prototype") }}</p>
        </aside>
      </div>
    </div>
    <div v-else class="load-error"><p>Feed entry not found.</p><RouterLink to="/">{{ t("topic.back") }}</RouterLink></div>
  </section>
</template>
