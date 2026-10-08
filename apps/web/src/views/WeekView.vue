<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, toRef } from "vue";

import DigestWeek from "../components/digest/DigestWeek.vue";
import { useDigest } from "../digest-store";
import { useFeedStore } from "../store";
import DigestStates from "./DigestStates.vue";

const props = defineProps<{ readonly projectKey: string }>();
const state = useDigest(toRef(props, "projectKey"));
const { payload } = useFeedStore();
const feedIds = computed(() => (payload.value === undefined ? undefined : new Set(payload.value.entries.map((entry) => entry.displayId))));
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;
onMounted(() => { clock = setInterval(() => { now.value = Date.now(); }, 60_000); });
onUnmounted(() => clearInterval(clock));
</script>

<template>
  <div id="view-week" class="digest-view">
    <DigestWeek
      v-if="state.kind === 'ok'"
      :digest="state.digest"
      :profile="state.project.profile"
      :project-name="state.project.name"
      :feed-ids="feedIds"
      :now="now"
    />
    <DigestStates v-else :state="state" :project-key="projectKey" />
  </div>
</template>
