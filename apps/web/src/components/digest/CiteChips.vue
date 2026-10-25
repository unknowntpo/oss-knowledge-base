<script setup lang="ts">
import { citeTarget, type ServedDigest } from "../../digest-view";

const props = defineProps<{
  readonly cites: readonly string[];
  readonly digest: Pick<ServedDigest, "threads">;
  readonly feedIds?: ReadonlySet<string>;
}>();
</script>

<template>
  <span class="cite-chips">
    <template v-for="target in props.cites.map((id) => ({ id, ...citeTarget(id, props.digest, props.feedIds) }))" :key="target.id">
      <a v-if="target.external" class="cite" :href="target.href" :title="target.title" target="_blank" rel="noopener noreferrer">{{ target.id }}</a>
      <!-- Spec 031: an internal cite is a path URL; RouterLink navigates without a page load. -->
      <RouterLink v-else class="cite" :to="target.href" :title="target.title">{{ target.id }}</RouterLink>
    </template>
  </span>
</template>
