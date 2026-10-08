<script setup lang="ts">
import { computed } from "vue";
import type { DigestProfile } from "@oss-knowledge-base/reference-pipeline/digest";

import { useI18n } from "../../i18n";
import { citeTarget, proposalTitle, stageColumns, voteThread, type ServedDigest } from "../../digest-view";
import CiteChips from "./CiteChips.vue";
import DigestSentence from "./DigestSentence.vue";

const props = defineProps<{
  readonly digest: ServedDigest;
  readonly profile: DigestProfile;
  readonly feedIds?: ReadonlySet<string>;
  /** This week caps each stage at 6 rows (Behavior 5); the Proposals tab passes none. */
  readonly limit?: number;
}>();
const { t } = useI18n();
const columns = computed(() => stageColumns(props.digest.proposals, props.profile, props.limit));
const kind = computed(() => props.profile.proposal.kind ?? "");
const newest = (cites: readonly string[]) => [...cites]
  .sort((a, b) => (props.digest.threads[b]?.lastActivityAt ?? "").localeCompare(props.digest.threads[a]?.lastActivityAt ?? ""))[0];
</script>

<template>
  <div class="stage-columns">
    <section v-for="column in columns" :key="column.stage" class="stage-column" :data-stage="column.stage">
      <h3 class="stage-heading">
        <span class="stage-badge" :class="`stage-${column.stage}`">{{ t(`proposal.${kind}.stage.${column.stage}`) }}</span>
        <span class="stage-count">{{ column.rows.length + column.more }}</span>
      </h3>
      <article v-for="row in column.rows" :key="row.key" class="kip-row" :data-stage="row.group">
        <header class="kip-row-head">
          <span class="kip-key">{{ row.key }}</span>
          <span class="kip-title">{{ proposalTitle(row, digest.threads) }}</span>
          <span class="kip-badges">
            <span v-for="stage in row.stages" :key="stage" class="stage-badge" :class="`stage-${stage}`">{{ t(`proposal.${kind}.stage.${stage}`) }}</span>
          </span>
        </header>
        <DigestSentence v-if="row.line !== null" :sentence="row.line" :digest="digest" :feed-ids="feedIds" />
        <p v-else class="digest-sentence fallback">
          <span class="sentence-text">{{ digest.threads[newest(row.cites) ?? ""]?.title ?? row.key }}</span>
          <CiteChips :cites="row.cites" :digest="digest" :feed-ids="feedIds" />
        </p>
        <a
          v-if="voteThread(row, digest.threads)"
          class="vote-link"
          :href="citeTarget(voteThread(row, digest.threads)!, digest, feedIds).href"
        >{{ t("digest.voteThread") }}</a>
      </article>
      <RouterLink v-if="column.more > 0" class="stage-more" :to="`/${profile.projectKey}/proposals`">
        {{ t("digest.more", { n: column.more }) }}
      </RouterLink>
    </section>
  </div>
</template>
