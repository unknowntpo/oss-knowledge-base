<script setup lang="ts">
import type { Sentence } from "@oss-knowledge-base/reference-pipeline/digest";

import { useI18n } from "../../i18n";
import type { ServedDigest } from "../../digest-view";
import CiteChips from "./CiteChips.vue";

// Generated text is rendered as text only; links come from validated cite ids (Behavior 9, 10).
const props = defineProps<{
  readonly sentence: Sentence;
  readonly digest: Pick<ServedDigest, "threads">;
  readonly feedIds?: ReadonlySet<string>;
  readonly tag?: "p" | "span";
}>();
const { t } = useI18n();
</script>

<template>
  <component :is="props.tag ?? 'p'" class="digest-sentence">
    <span class="sentence-text">{{ props.sentence.text }}</span>
    <span v-if="props.sentence.notTranslated" class="not-translated">{{ t("digest.notTranslated") }}</span>
    <CiteChips :cites="props.sentence.cites" :digest="props.digest" :feed-ids="props.feedIds" />
  </component>
</template>
