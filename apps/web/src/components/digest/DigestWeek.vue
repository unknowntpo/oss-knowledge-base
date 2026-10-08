<script setup lang="ts">
import { computed } from "vue";
import type { DigestProfile } from "@oss-knowledge-base/reference-pipeline/digest";

import { useI18n } from "../../i18n";
import {
  aiLabel, digestCounts, digestFreshness, lagNotes, windowLabel, type ServedDigest,
} from "../../digest-view";
import CiteChips from "./CiteChips.vue";
import DigestSentence from "./DigestSentence.vue";
import ProposalColumns from "./ProposalColumns.vue";

const props = defineProps<{
  readonly digest: ServedDigest;
  readonly profile: DigestProfile;
  readonly projectName: string;
  readonly feedIds?: ReadonlySet<string>;
  readonly now: number;
}>();
const { t, locale } = useI18n();
const counts = computed(() => digestCounts(props.digest));
const hasProposals = computed(() => props.profile.proposal.kind !== null);
const label = computed(() => windowLabel(t("digest.windowPrefix"), locale.value, props.digest.window.start, props.digest.window.end));
const freshness = computed(() => digestFreshness(props.digest.generatedAt, props.now));
const lags = computed(() => lagNotes(props.digest, locale.value, t));
const generated = computed(() => props.digest.cards.some((card) => card.status === "generated")
  || props.digest.proposals.some((row) => row.line !== null) || props.digest.headline !== null);
const topicLabel = (topic: string) => t(`taxonomy.${props.profile.projectId}.${topic}`);
const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
</script>

<template>
  <article id="digest" class="digest">
    <header class="digest-head">
      <p class="digest-window">
        <span class="digest-window-range">{{ label }}</span>
        <span v-if="freshness" class="digest-freshness" :class="freshness.stale ? 'is-stale' : 'is-live'">
          {{ t(freshness.key, { n: freshness.n }) }}
        </span>
      </p>
      <h1 class="digest-headline">
        <template v-if="digest.headline !== null">
          <DigestSentence :sentence="digest.headline" :digest="digest" :feed-ids="feedIds" tag="span" />
        </template>
        <template v-else>{{ projectName }} · {{ t("nav.week") }}</template>
      </h1>
      <ul class="digest-stats">
        <li><strong>{{ counts.threads }}</strong> {{ t("digest.stat.threads") }}</li>
        <li><strong>{{ counts.mailThreads }}</strong> {{ t("digest.stat.mail") }}</li>
        <li v-if="hasProposals"><strong>{{ counts.proposals }}</strong> {{ t("digest.stat.proposals") }}</li>
        <li><strong>{{ counts.routine }}</strong> {{ t("digest.stat.routine") }}</li>
      </ul>
      <p v-for="lag in lags" :key="lag" class="digest-lag">{{ lag }}</p>
      <p class="ai-label">{{ generated ? aiLabel(digest, t) : t("digest.aiUnavailable") }}</p>
    </header>

    <p v-if="digest.empty" class="digest-empty">{{ t("digest.empty") }}</p>

    <template v-else>
      <section v-if="digest.highlights.length > 0" class="digest-highlights" :aria-label="t('digest.highlights')">
        <h2 class="digest-section-title">{{ t("digest.highlights") }}</h2>
        <ol class="highlight-list">
          <li v-for="(highlight, index) in digest.highlights" :key="index" class="digest-highlight">
            <h3 class="highlight-title">
              {{ highlight.title }}
              <span v-if="highlight.titleNotTranslated" class="not-translated">{{ t("digest.notTranslated") }}</span>
            </h3>
            <DigestSentence :sentence="highlight.body" :digest="digest" :feed-ids="feedIds" />
          </li>
        </ol>
      </section>

      <nav class="digest-anchors" :aria-label="t('digest.sections')">
        <button v-if="hasProposals" type="button" class="anchor" @click="scrollTo('digest-proposals')">{{ t("digest.anchor.proposals", { n: counts.proposals }) }}</button>
        <button type="button" class="anchor" @click="scrollTo('digest-topics')">{{ t("digest.anchor.topics", { n: counts.topics }) }}</button>
        <button type="button" class="anchor" @click="scrollTo('digest-routine')">{{ t("digest.anchor.routine", { n: counts.routine }) }}</button>
      </nav>

      <section v-if="hasProposals" id="digest-proposals" class="digest-kips">
        <h2 class="digest-section-title">{{ t("digest.proposals") }} <span class="kind">{{ profile.proposal.kind }}</span></h2>
        <p v-if="profile.proposal.quorumNote" class="quorum-note">{{ t(profile.proposal.quorumNote) }}</p>
        <ProposalColumns :digest="digest" :profile="profile" :feed-ids="feedIds" :limit="6" />
      </section>

      <section id="digest-topics" class="digest-topics">
        <h2 class="digest-section-title">{{ t("digest.topics") }}</h2>
        <p class="section-note">{{ t("digest.topicsSort") }}</p>
        <div class="topic-grid">
          <article v-for="card in digest.cards" :key="card.topic" class="topic-card" :data-topic="card.topic">
            <h3 class="topic-card-title">
              <RouterLink :to="`/${profile.projectKey}/topic/${card.topic}`">{{ topicLabel(card.topic) }}</RouterLink>
              <span class="topic-count">{{ card.threads.length }}</span>
            </h3>
            <div v-if="card.status === 'generated'" class="topic-summary">
              <DigestSentence v-for="(sentence, index) in card.sentences" :key="index" :sentence="sentence" :digest="digest" :feed-ids="feedIds" />
            </div>
            <div v-else class="topic-summary fallback">
              <p class="ai-unavailable">{{ t("digest.aiUnavailable") }}</p>
              <CiteChips :cites="card.threads.slice(0, 5)" :digest="digest" :feed-ids="feedIds" />
            </div>
            <ul class="keywords">
              <li v-for="keyword in card.keywords" :key="keyword" class="keyword">{{ keyword }}</li>
            </ul>
            <RouterLink v-if="card.threads.length > 5" class="topic-more" :to="`/${profile.projectKey}/topic/${card.topic}`">
              {{ t("digest.moreThreads", { n: card.threads.length - 5 }) }}
            </RouterLink>
          </article>
        </div>
      </section>

      <section id="digest-routine" class="digest-routine-section">
        <h2 class="digest-section-title">{{ t("digest.routine") }}</h2>
        <details class="digest-routine">
          <summary>{{ t("digest.routineShow", { n: counts.routine }) }}</summary>
          <CiteChips :cites="digest.routine.threads" :digest="digest" :feed-ids="feedIds" />
        </details>
      </section>
    </template>

    <footer class="digest-foot">
      <p>{{ t("digest.sources") }}</p>
      <p>{{ t("digest.disclaimer") }}</p>
    </footer>
  </article>
</template>
