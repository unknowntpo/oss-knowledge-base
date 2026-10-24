<script setup lang="ts">
/**
 * Spec 030 Behavior 4: the trend card's one request, separate from `/api/digest`. Shown only when
 * the digest answer carried the trend header (`PROJECT_TREND`); a failure leaves one line and is
 * not retried (PT10).
 */
import { onMounted, ref, watch } from "vue";

import { fetchProjectActivity } from "../../api";
import type { TrendAnswer } from "../../project-trend";
import ProjectTrendCard from "./ProjectTrendCard.vue";

const props = defineProps<{ readonly projectId: string; readonly projectName: string; readonly now: number }>();
const answer = ref<TrendAnswer>({ kind: "loading" });
let request = 0;

async function load() {
  const current = ++request;
  answer.value = { kind: "loading" };
  try {
    const body = await fetchProjectActivity(props.projectId);
    if (current === request) answer.value = { kind: "ok", body };
  } catch {
    if (current === request) answer.value = { kind: "error" };
  }
}
onMounted(() => { void load(); });
watch(() => props.projectId, () => { void load(); });
</script>

<template>
  <ProjectTrendCard :answer="answer" :project-name="projectName" :now-ms="now" />
</template>
