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
    <a
      v-for="id in props.cites"
      :key="id"
      class="cite"
      :href="citeTarget(id, props.digest, props.feedIds).href"
      :title="citeTarget(id, props.digest, props.feedIds).title"
      :target="citeTarget(id, props.digest, props.feedIds).external ? '_blank' : undefined"
      :rel="citeTarget(id, props.digest, props.feedIds).external ? 'noopener noreferrer' : undefined"
    >{{ id }}</a>
  </span>
</template>
