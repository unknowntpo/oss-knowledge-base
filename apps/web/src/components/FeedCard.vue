<script setup lang="ts">
import { badgeState } from "../badge-state";
import { useI18n } from "../i18n";
import type { FeedIndexEntry, FeedProjectProfile } from "../types";

const props = defineProps<{
  readonly item: FeedIndexEntry;
  readonly rank: number;
  readonly trending: boolean;
  readonly profile?: FeedProjectProfile;
}>();

const { t } = useI18n();

function relativeTime(value: string | undefined): string {
  if (value === undefined) return "—";
  const days = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 86_400_000));
  if (days === 0) return t("date.today");
  if (days < 7) return t("date.daysAgo", { count: days });
  if (days < 30) return t("date.weeksAgo", { count: Math.floor(days / 7) });
  return t("date.monthsAgo", { count: Math.floor(days / 30) });
}
</script>

<template>
  <RouterLink class="card" :to="`/feed/${encodeURIComponent(item.displayId)}`" :aria-label="t('a11y.openTopic', { id: item.displayId, title: item.entry.title })">
    <div class="card-head">
      <span class="topic-id">{{ item.displayId }}</span>
      <span class="status-badge" :class="`status-${item.status}`" :data-state="badgeState(item.status)">{{ t(`status.${item.status}`) }}</span>
      <span class="card-project">{{ profile?.label ?? item.projectKey }}</span>
    </div>
    <h3 class="card-title">{{ item.entry.title }}</h3>
    <p class="card-summary">{{ item.entry.summary }}</p>
    <p v-if="trending" class="trending-reason">
      <span class="trending-dot" aria-hidden="true"></span>
      {{ t("card.trendingRank", { rank, count: item.entry.activity.score }) }}
    </p>
    <div class="card-tags">
      <span v-for="tag in item.tags" :key="tag" class="tag-pill">{{ tag }}</span>
    </div>
    <div class="card-foot">
      <span>
        {{ t("card.lastUpdated", { time: relativeTime(item.lastActivityAt) }) }}
        <span class="source-dots">
          <span v-for="source in profile?.sources ?? []" :key="source" class="source-dot" :class="{ off: !item.sourceCounts[source] }">
            {{ t(`source.${source}`) }} {{ item.sourceCounts[source] ?? 0 }}
          </span>
        </span>
      </span>
      <span class="card-open">{{ t("card.open") }}</span>
    </div>
  </RouterLink>
</template>
