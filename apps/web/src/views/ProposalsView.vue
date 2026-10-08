<script setup lang="ts">
import { computed, toRef } from "vue";

import ProposalColumns from "../components/digest/ProposalColumns.vue";
import { useDigest } from "../digest-store";
import { useI18n } from "../i18n";
import { useFeedStore } from "../store";
import DigestStates from "./DigestStates.vue";

const props = defineProps<{ readonly projectKey: string }>();
const state = useDigest(toRef(props, "projectKey"));
const { payload } = useFeedStore();
const { t } = useI18n();
const feedIds = computed(() => (payload.value === undefined ? undefined : new Set(payload.value.entries.map((entry) => entry.displayId))));
</script>

<template>
  <div id="view-proposals" class="digest-view">
    <section v-if="state.kind === 'ok'" class="digest-kips proposals-tab">
      <h1 class="digest-section-title">{{ t("digest.proposals") }} <span class="kind">{{ state.project.profile.proposal.kind }}</span></h1>
      <p v-if="state.project.profile.proposal.quorumNote" class="quorum-note">{{ t(state.project.profile.proposal.quorumNote) }}</p>
      <ProposalColumns :digest="state.digest" :profile="state.project.profile" :feed-ids="feedIds" />
    </section>
    <DigestStates v-else :state="state" :project-key="projectKey" />
  </div>
</template>
