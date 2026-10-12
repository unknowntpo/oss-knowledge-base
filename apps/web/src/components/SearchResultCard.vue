<script setup lang="ts">
import { computed } from "vue";

import { useI18n } from "../i18n";
import type { SearchResultV1 } from "../types";

const props = defineProps<{
  readonly result: SearchResultV1;
  readonly rank: number;
  readonly projectLabel: string;
}>();

const { t } = useI18n();
// Spec 016 Behavior 36: no word of the query located this thread; it was found by meaning alone.
const semanticOnly = computed(() => props.result.matches.every((match) => match.signals.lexicalRank === undefined));
</script>

<template>
  <RouterLink
    class="card search-card"
    :to="`/search/${encodeURIComponent(result.detailRef)}`"
    :aria-label="t('a11y.openSearchResult', { title: result.entry.title })"
  >
    <div class="card-head">
      <span class="topic-id">#{{ rank }}</span>
      <span class="search-match-badge">{{ t("search.lexicalMatch") }}</span>
      <span v-if="semanticOnly" class="search-match-badge semantic-match-badge">{{ t("search.semanticMatch") }}</span>
      <span v-if="result.projectStatus" class="status-badge" :class="`status-${result.projectStatus}`">{{ t(`status.${result.projectStatus}`) }}</span>
      <span class="card-project">{{ projectLabel }}</span>
    </div>
    <h3 class="card-title">{{ result.entry.title }}</h3>
    <p class="card-summary">{{ result.entry.summary }}</p>
    <div
      v-for="match in result.matches.slice(0, 2)"
      :key="match.chunkId"
      class="evidence"
    >
      <span class="evidence-label">{{ t("evidence.match") }}</span>
      <p class="evidence-text">{{ match.excerpt }}</p>
      <div class="evidence-meta">
        <span>{{ match.author }}</span>
        <span class="dot-sep">·</span>
        <time :datetime="match.occurredAt">{{ match.occurredAt.slice(0, 10) }}</time>
        <span v-if="match.signals.exactIdentifier" class="exact-match">{{ t("search.exact") }}</span>
      </div>
    </div>
    <div class="card-foot">
      <span>{{ t("search.evidenceCount", { count: result.matches.length }) }}</span>
      <span class="card-open">{{ t("card.open") }}</span>
    </div>
  </RouterLink>
</template>
