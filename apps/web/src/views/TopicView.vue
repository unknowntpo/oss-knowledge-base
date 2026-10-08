<script setup lang="ts">
import { computed, toRef } from "vue";

import TopicPage from "../components/digest/TopicPage.vue";
import { useDigest } from "../digest-store";
import { useI18n } from "../i18n";
import { useFeedStore } from "../store";
import DigestStates from "./DigestStates.vue";

const props = defineProps<{ readonly projectKey: string; readonly topicKey: string }>();
const state = useDigest(toRef(props, "projectKey"));
const { payload } = useFeedStore();
const { t } = useI18n();
const feedIds = computed(() => (payload.value === undefined ? undefined : new Set(payload.value.entries.map((entry) => entry.displayId))));
const card = computed(() => (state.value.kind === "ok" ? state.value.digest.cards.find((item) => item.topic === props.topicKey) : undefined));
</script>

<template>
  <div class="digest-view">
    <TopicPage v-if="state.kind === 'ok' && card" :digest="state.digest" :profile="state.project.profile" :card="card" :feed-ids="feedIds" />
    <section v-else-if="state.kind === 'ok'" class="digest-notice not-found">
      <p>{{ t("digest.notFound") }}</p>
      <RouterLink :to="`/${projectKey}/`">{{ t("digest.backToWeek") }}</RouterLink>
    </section>
    <DigestStates v-else :state="state" :project-key="projectKey" />
  </div>
</template>
