<script setup lang="ts">
/** Spec 019 slice 2a: `/<projectKey>/people/<id>`; the API decides whether profiles are served (W25). */
import { ref, watch } from "vue";

import type { PeopleErrorV1, PersonProfileV1 } from "@oss-knowledge-base/reference-pipeline/people";

import { fetchPersonProfile } from "../api";
import PersonNotFound from "../components/PersonNotFound.vue";
import PersonProfile from "../components/PersonProfile.vue";
import { useI18n } from "../i18n";

const props = defineProps<{ readonly projectKey: string; readonly personId: string }>();
const { t } = useI18n();
const loading = ref(true);
const profile = ref<PersonProfileV1>();
const missing = ref<{ readonly status: number; readonly error: PeopleErrorV1 }>();
const failure = ref<string>();
const nowMs = ref(Date.now());

watch(() => [props.projectKey, props.personId] as const, async ([projectKey, personId]) => {
  loading.value = true;
  profile.value = undefined;
  missing.value = undefined;
  failure.value = undefined;
  try {
    const answer = await fetchPersonProfile(projectKey, personId);
    nowMs.value = Date.now();
    if (answer.ok) profile.value = answer.profile;
    else missing.value = answer;
  } catch (caught) {
    failure.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    loading.value = false;
  }
}, { immediate: true });
</script>

<template>
  <section id="view-person" class="view person-view">
    <RouterLink class="back-link" :to="`/${projectKey}/`"><span aria-hidden="true">←</span> {{ t("topic.back") }}</RouterLink>
    <div v-if="loading" class="load-error"><p>{{ t("people.loading") }}</p></div>
    <PersonProfile v-else-if="profile" :profile="profile" :now-ms="nowMs" />
    <PersonNotFound v-else-if="missing" :project-key="projectKey" :status="missing.status" :error="missing.error" />
    <div v-else class="load-error"><p>{{ t("people.error", { error: failure ?? "" }) }}</p></div>
  </section>
</template>
