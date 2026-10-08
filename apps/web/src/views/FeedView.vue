<script setup lang="ts">
import { computed, ref, watch } from "vue";

import FeedCard from "../components/FeedCard.vue";
import SearchResultCard from "../components/SearchResultCard.vue";
import { fetchEvidenceSearch } from "../api";
import { useI18n } from "../i18n";
import { useFeedStore } from "../store";
import type { FeedIndexEntry, SearchResponseV1 } from "../types";

// Spec 014: All threads is this Feed for the route's project (`/#/<projectKey>/threads`). A typed
// query searches every project (Spec 005), so the route project applies to the list only.
const props = defineProps<{ readonly projectKey?: string }>();
const { payload, searchQuery } = useFeedStore();
const { t } = useI18n();
const query = ref(searchQuery.value);
const project = ref(searchQuery.value.trim() === "" ? props.projectKey ?? "" : "");
searchQuery.value = "";
const source = ref("");
const status = ref("");
const timeWindow = ref<"" | "7d" | "30d" | "365d">("");
const tags = ref(new Set<string>());
const sort = ref<"hot" | "recent" | "relevance">("hot");
const filtersOpen = ref(false);
const searchResponse = ref<SearchResponseV1>();
const searchLoading = ref(false);
const searchError = ref<string>();
let searchRequest = 0;
const searchClock = Date.now();

const exampleKeys = ["example.kafka", "example.datafusion", "example.docs", "example.performance"];
const projects = computed(() => payload.value?.projects ?? []);
const selectedProfile = computed(() => projects.value.find((item) => item.key === project.value));
const availableSources = computed(() => selectedProfile.value?.sources
  ?? [...new Set(projects.value.flatMap((item) => item.sources))]);
const availableStatuses = computed(() => selectedProfile.value?.statuses ?? []);
const availableTags = computed(() => [...new Set((payload.value?.entries ?? [])
  .filter((item) => project.value === "" || item.projectKey === project.value)
  .flatMap((item) => item.tags))].sort());

watch(project, () => {
  source.value = "";
  status.value = "";
  tags.value = new Set();
});

watch(() => props.projectKey, (value) => {
  if (query.value.trim() === "") project.value = value ?? "";
});

watch(query, (value, previous) => {
  if (value.trim() === "") {
    timeWindow.value = "";
    if (previous.trim() !== "" && project.value === "") project.value = props.projectKey ?? "";
    return;
  }
  if (previous.trim() === "" && project.value === (props.projectKey ?? "")) project.value = "";
  source.value = "";
  tags.value = new Set();
});

const selectedProjectId = computed(() => {
  if (project.value === "") return undefined;
  return projectIdForKey(project.value);
});
const projectFacetCounts = computed(() => new Map(
  searchResponse.value?.facets.projects.map((facet) => [facet.projectId, facet.count]) ?? [],
));

const occurredAfter = computed(() => {
  const days = timeWindow.value === "7d" ? 7
    : timeWindow.value === "30d" ? 30
    : timeWindow.value === "365d" ? 365
    : undefined;
  return days === undefined
    ? undefined
    : new Date(searchClock - days * 86_400_000).toISOString();
});

watch(
  [query, selectedProjectId, status, occurredAfter],
  ([nextQuery, nextProjectId, nextStatus, nextOccurredAfter], _previous, onCleanup) => {
    const normalized = nextQuery.trim();
    const request = ++searchRequest;
    searchError.value = undefined;
    if (normalized === "") {
      searchResponse.value = undefined;
      searchLoading.value = false;
      return;
    }
    sort.value = "relevance";
    searchLoading.value = true;
    const timeout = window.setTimeout(async () => {
      try {
        const response = await fetchEvidenceSearch({
          query: normalized,
          ...(nextProjectId === undefined ? {} : { projectId: nextProjectId }),
          ...(nextProjectId === undefined || nextStatus === ""
            ? {}
            : { projectStatus: nextStatus }),
          ...(nextOccurredAfter === undefined ? {} : { occurredAfter: nextOccurredAfter }),
        });
        if (request === searchRequest) searchResponse.value = response;
      } catch (caught) {
        if (request === searchRequest) {
          searchResponse.value = undefined;
          searchError.value = caught instanceof Error ? caught.message : String(caught);
        }
      } finally {
        if (request === searchRequest) searchLoading.value = false;
      }
    }, 180);
    onCleanup(() => window.clearTimeout(timeout));
  },
  { immediate: true },
);

function latestTime(item: FeedIndexEntry): number {
  return Date.parse(item.lastActivityAt);
}

function searchScore(item: FeedIndexEntry, normalized: string): number {
  if (normalized === "") return 0;
  const fields = [
    item.displayId,
    item.entry.title,
    item.entry.summary,
    ...item.tags,
    ...item.authors,
    item.searchText,
  ].join(" ").toLowerCase();
  return normalized.split(/\s+/).filter(Boolean).reduce((score, term) => score + (fields.includes(term) ? 1 : 0), 0);
}

const visibleEntries = computed(() => {
  const normalized = "";
  return (payload.value?.entries ?? [])
    .map((item) => ({ item, score: searchScore(item, normalized) }))
    .filter(({ item, score }) => (
      (normalized === "" || score > 0)
      && (project.value === "" || item.projectKey === project.value)
      && (source.value === "" || (item.sourceCounts[source.value] ?? 0) > 0)
      && (status.value === "" || item.status === status.value)
      && [...tags.value].every((tag) => item.tags.includes(tag))
    ))
    .sort((left, right) => {
      if (sort.value === "relevance" && normalized !== "") return right.score - left.score || latestTime(right.item) - latestTime(left.item);
      if (sort.value === "recent") return latestTime(right.item) - latestTime(left.item);
      return right.item.entry.activity.score - left.item.entry.activity.score || latestTime(right.item) - latestTime(left.item);
    })
    .map(({ item }) => item);
});

const activeFilterCount = computed(() => Number(project.value !== "") + Number(source.value !== "") + Number(status.value !== "") + Number(timeWindow.value !== "") + tags.value.size);
const matchingRecordCount = computed(() => searchResponse.value?.results.reduce(
  (total, result) => total + result.matches.length,
  0,
) ?? 0);

function projectLabel(projectId: string): string {
  const indexEntry = payload.value?.entries.find((entry) => entry.entry.projectId === projectId);
  return projects.value.find((profile) => profile.key === indexEntry?.projectKey)?.label ?? projectId;
}

function projectIdForKey(projectKey: string): string | undefined {
  return payload.value?.entries.find((entry) => entry.projectKey === projectKey)?.entry.projectId;
}

function projectCount(projectKey: string): number {
  if (query.value.trim() === "") {
    return payload.value?.entries.filter((entry) => entry.projectKey === projectKey).length ?? 0;
  }
  const projectId = projectIdForKey(projectKey);
  return projectId === undefined ? 0 : projectFacetCounts.value.get(projectId) ?? 0;
}

function toggleTag(tag: string) {
  const next = new Set(tags.value);
  next.has(tag) ? next.delete(tag) : next.add(tag);
  tags.value = next;
}

function reset() {
  query.value = "";
  project.value = "";
  source.value = "";
  status.value = "";
  timeWindow.value = "";
  tags.value = new Set();
  sort.value = "hot";
}
</script>

<template>
  <section id="view-feed" class="view" aria-labelledby="feed-title">
    <div class="search-band">
      <div class="search-band-inner">
        <h1 id="feed-title" class="band-title">{{ t("feed.title") }}</h1>
        <form class="search-form" role="search" @submit.prevent>
          <label class="visually-hidden" for="q">{{ t("a11y.search") }}</label>
          <span class="search-icon" aria-hidden="true">⌕</span>
          <input id="q" v-model="query" name="q" type="search" autocomplete="off" :placeholder="t('search.placeholder')" />
          <button v-if="query" type="button" class="search-clear" @click="query = ''">{{ t("search.clear") }}</button>
        </form>
        <div class="examples">
          <span class="examples-label">{{ t("search.examples") }}</span>
          <ul class="examples-list">
            <li v-for="key in exampleKeys" :key="key"><button type="button" class="example-btn" @click="query = t(key)">{{ t(key) }}</button></li>
          </ul>
        </div>
      </div>
    </div>

    <div class="feed-layout">
      <button class="filters-toggle" :aria-expanded="filtersOpen" aria-controls="filters" @click="filtersOpen = !filtersOpen">
        {{ t("filter.toggle") }}<span v-if="activeFilterCount" class="filters-badge">{{ activeFilterCount }}</span>
      </button>

      <aside id="filters" class="filters" :class="{ 'is-open': filtersOpen }" :aria-label="t('a11y.filters')">
        <div class="filter-group">
          <div class="filter-label">{{ t("filter.project") }}</div>
          <button class="filter-row" :aria-pressed="project === ''" @click="project = ''"><span>{{ t("filter.allProjects") }}</span></button>
          <button v-for="item in projects" :key="item.key" class="filter-row" :aria-pressed="project === item.key" @click="project = item.key">
            <span>{{ item.label }}</span><span>{{ projectCount(item.key) }}</span>
          </button>
        </div>
        <div v-if="!query" class="filter-group">
          <div class="filter-label">{{ t("filter.source") }}</div>
          <button class="filter-row" :aria-pressed="source === ''" @click="source = ''"><span>{{ t("filter.allSources") }}</span></button>
          <button v-for="item in availableSources" :key="item" class="filter-row" :aria-pressed="source === item" @click="source = item">
            <span>{{ t(`source.${item}`) }}</span>
          </button>
        </div>
        <div v-if="selectedProfile" class="filter-group">
          <div class="filter-label">{{ t(selectedProfile.statusFacetKey) }}</div>
          <button class="filter-row" :aria-pressed="status === ''" @click="status = ''"><span>{{ t("filter.allStatuses") }}</span></button>
          <button v-for="item in availableStatuses" :key="item.key" class="filter-row" :aria-pressed="status === item.key" @click="status = item.key">
            <span>{{ t(`status.${item.key}`) }}</span>
          </button>
        </div>
        <div v-if="query" class="filter-group">
          <div class="filter-label">{{ t("filter.time") }}</div>
          <button class="filter-row" :aria-pressed="timeWindow === ''" @click="timeWindow = ''"><span>{{ t("filter.time.any") }}</span></button>
          <button class="filter-row" :aria-pressed="timeWindow === '7d'" @click="timeWindow = '7d'"><span>{{ t("filter.time.7d") }}</span></button>
          <button class="filter-row" :aria-pressed="timeWindow === '30d'" @click="timeWindow = '30d'"><span>{{ t("filter.time.30d") }}</span></button>
          <button class="filter-row" :aria-pressed="timeWindow === '365d'" @click="timeWindow = '365d'"><span>{{ t("filter.time.365d") }}</span></button>
        </div>
        <div v-if="!query" class="filter-group">
          <div class="filter-label">{{ t("filter.tags") }}</div>
          <div class="tag-chips">
            <button v-for="tag in availableTags" :key="tag" class="tag-chip" :aria-pressed="tags.has(tag)" @click="toggleTag(tag)">{{ tag }}</button>
          </div>
        </div>
        <button v-if="activeFilterCount" type="button" class="clear-filters" @click="reset">{{ t("filter.clear") }}</button>
      </aside>

      <div class="results-col">
        <div class="stream-header">
          <div class="stream-heading">
            <p class="stream-kicker">{{ query ? t("stream.search.kicker") : t("stream.trending.kicker") }}</p>
            <h2 class="stream-title">{{ query ? t("stream.search.title", { query }) : activeFilterCount ? t("stream.filtered.title") : t("stream.trending.title") }}</h2>
            <p class="stream-description">{{ query ? t("stream.search.description") : t("stream.trending.description") }}</p>
          </div>
          <label v-if="!query" class="sort-control">
            <span>{{ t("sort.label") }}</span>
            <select id="sort" v-model="sort">
              <option value="hot">{{ t("sort.hot") }}</option>
              <option value="recent">{{ t("sort.recent") }}</option>
              <option value="relevance">{{ t("sort.relevance") }}</option>
            </select>
          </label>
        </div>
        <p class="results-count" aria-live="polite">
          {{ query ? `${searchResponse?.results.length ?? 0} related entries · ${matchingRecordCount} matching source records` : `${visibleEntries.length} entries` }}
        </p>
        <div v-if="query && searchLoading" class="empty"><p>{{ t("search.loading") }}</p></div>
        <div v-else-if="query && searchError" class="load-error"><p>{{ t("search.failed") }}</p><code>{{ searchError }}</code></div>
        <div v-else-if="query && searchResponse?.results.length" class="cards search-results">
          <SearchResultCard
            v-for="(result, index) in searchResponse.results"
            :key="result.detailRef"
            :result="result"
            :rank="index + 1"
            :project-label="projectLabel(result.entry.projectId)"
          />
        </div>
        <div v-else-if="!query && visibleEntries.length" class="cards">
          <FeedCard
            v-for="(item, index) in visibleEntries"
            :key="item.entry.id"
            :item="item"
            :rank="index + 1"
            :trending="!query && sort === 'hot'"
            :profile="projects.find((profile) => profile.key === item.projectKey)"
          />
        </div>
        <div v-else-if="!searchLoading" class="empty">
          <p>{{ t("empty.message", { reason: t("empty.current") }) }}</p>
          <button type="button" class="empty-action" @click="reset">{{ t("empty.reset") }}</button>
        </div>
      </div>
    </div>
  </section>
</template>
