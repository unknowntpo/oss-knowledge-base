<script setup lang="ts">
/** W11 and W27: an identity without recorded activity, with what the community records. */
import { computed } from "vue";

import { peopleProject, type PeopleErrorV1 } from "@oss-knowledge-base/reference-pipeline/people";

import { useI18n } from "../i18n";

const props = defineProps<{ readonly projectKey: string; readonly status: number; readonly error: PeopleErrorV1 }>();
const { t } = useI18n();
const community = computed(() => peopleProject(props.projectKey)?.label ?? props.projectKey);
const day = (iso: string) => iso.slice(0, 10);
const recorded = computed(() => (props.error.coverage ?? []).flatMap((item) => (item.status === "recorded" ? [item] : [])));
const notRecorded = computed(() => (props.error.coverage ?? []).filter((item) => item.status === "not-recorded")
  .map((item) => t(`people.source.${item.source}`)).join(t("people.listSeparator")));
</script>

<template>
  <div class="person-missing load-error" :data-status="status">
    <p>{{ status === 404 ? t("people.notFound", { community }) : error.error }}</p>
    <ul v-if="error.coverage" class="person-coverage">
      <li v-for="item in recorded" :key="item.source">{{ t("people.coverage.reviews", { from: day(item.from), until: day(item.until) }) }}</li>
      <li v-if="notRecorded" class="not-recorded">{{ t("people.coverage.notRecorded", { sources: notRecorded }) }}</li>
    </ul>
  </div>
</template>
