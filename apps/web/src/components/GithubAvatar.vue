<script setup lang="ts">
/**
 * Spec 019 W53: a GitHub avatar, or a neutral initial when the login is not a GitHub login or the
 * image does not load. Lazy, sized, and sent without a referrer.
 */
import { computed, ref, watch } from "vue";

import { githubAvatarUrl } from "../avatar";

const props = withDefaults(defineProps<{ readonly login: string; readonly size?: number; readonly alt?: string }>(), { size: 24, alt: "" });
const failed = ref(false);
const src = computed(() => githubAvatarUrl(props.login, props.size));
watch(() => props.login, () => { failed.value = false; });
</script>

<template>
  <img
    v-if="src && !failed"
    class="gh-avatar"
    :src="src"
    :width="size"
    :height="size"
    :alt="alt"
    loading="lazy"
    decoding="async"
    referrerpolicy="no-referrer"
    data-avatar="image"
    @error="failed = true"
  >
  <span v-else class="gh-avatar gh-avatar-fallback" :style="{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.45)}px` }" data-avatar="fallback" aria-hidden="true">{{ login.slice(0, 1).toUpperCase() }}</span>
</template>
