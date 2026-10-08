<script setup lang="ts">
import { computed, ref } from "vue";
import type { DigestProfile, TopicCard } from "@oss-knowledge-base/reference-pipeline/digest";

import { useI18n } from "../../i18n";
import { citeTarget, filterCounts, filterThreads, type ServedDigest, type ThreadFilter } from "../../digest-view";
import DigestSentence from "./DigestSentence.vue";

const props = defineProps<{
  readonly digest: ServedDigest;
  readonly profile: DigestProfile;
  readonly card: TopicCard;
  readonly feedIds?: ReadonlySet<string>;
}>();
const { t } = useI18n();
const filter = ref<ThreadFilter>("all");
const counts = computed(() => filterCounts(props.card.threads, props.digest));
const shown = computed(() => filterThreads(props.card.threads, props.digest, filter.value));
const filters: readonly ThreadFilter[] = ["all", "pr", "mail", "jira"];
const date = (at: string | undefined) => (at === undefined ? "" : at.slice(0, 10));
</script>

<template>
  <article id="view-topic-page" class="topic-page">
    <nav class="breadcrumb">
      <RouterLink :to="`/${profile.projectKey}/`">{{ t("nav.week") }}</RouterLink>
      <span aria-hidden="true">/</span>
      <span>{{ t("topic.breadcrumb") }}</span>
    </nav>
    <h1 class="topic-page-title">{{ t(`taxonomy.${profile.projectId}.${card.topic}`) }}</h1>
    <div v-if="card.status === 'generated'" class="topic-summary">
      <DigestSentence v-for="(sentence, index) in card.sentences" :key="index" :sentence="sentence" :digest="digest" :feed-ids="feedIds" />
    </div>
    <p v-else class="ai-unavailable">{{ t("digest.aiUnavailable") }}</p>
    <ul class="keywords">
      <li v-for="keyword in card.keywords" :key="keyword" class="keyword">{{ keyword }}</li>
    </ul>
    <div class="thread-filters" role="group">
      <button
        v-for="item in filters"
        :key="item"
        type="button"
        class="thread-filter"
        :data-filter="item"
        :aria-pressed="filter === item"
        @click="filter = item"
      >{{ t(`topic.filter.${item}`, { n: counts[item] }) }}</button>
    </div>
    <ul class="thread-cards">
      <li v-for="id in shown" :key="id" class="thread-card" :data-source="digest.threads[id]?.source">
        <div class="thread-card-head">
          <a class="thread-id" :href="`#/feed/${encodeURIComponent(id)}`">{{ id }}</a>
          <span v-if="digest.threads[id]?.status" class="thread-status" :class="`status-${digest.threads[id]?.status}`">
            {{ t(`status.${digest.threads[id]?.status}`) }}
          </span>
        </div>
        <a
          class="thread-title"
          :href="citeTarget(id, digest, new Set()).href"
          :target="digest.threads[id]?.url ? '_blank' : undefined"
          :rel="digest.threads[id]?.url ? 'noopener noreferrer' : undefined"
        >{{ digest.threads[id]?.title ?? id }}</a>
        <p v-if="digest.threads[id]?.excerpt" class="thread-excerpt">{{ digest.threads[id]?.excerpt }}</p>
        <p class="thread-meta">
          {{ digest.threads[id]?.source }}<template v-if="digest.threads[id]?.author"> · {{ digest.threads[id]?.author }}</template>
          <template v-if="digest.threads[id]?.lastActivityAt"> · {{ date(digest.threads[id]?.lastActivityAt) }}</template>
        </p>
      </li>
    </ul>
  </article>
</template>
