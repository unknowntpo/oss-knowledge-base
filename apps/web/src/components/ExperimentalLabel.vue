<script setup lang="ts">
import { computed } from "vue";

import { experimentalFeature } from "../experimental";
import { useI18n } from "../i18n";

// Spec 014 D109–D111: a badge and a one-line note, only for a feature listed in `experimental.ts`.
const props = defineProps<{ readonly feature: string }>();
const { t } = useI18n();
const entry = computed(() => experimentalFeature(props.feature));
</script>

<template>
  <p v-if="entry" class="experimental-label" role="note" :aria-label="t('experimental.badge')" :data-experimental="feature">
    <span class="experimental-badge">{{ t("experimental.badge") }}</span>
    <span class="experimental-note">{{ t(entry.note) }}</span>
  </p>
</template>
