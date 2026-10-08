<script setup lang="ts">
import { useI18n } from "../i18n";
import type { DigestState } from "../digest-store";

// No inline feed on This week when there is no digest (D23): a notice and a link.
defineProps<{ readonly state: DigestState; readonly projectKey: string }>();
const { t } = useI18n();
</script>

<template>
  <section v-if="state.kind === 'loading'" class="digest-notice is-loading"><p>{{ t("digest.loading") }}</p></section>
  <section v-else-if="state.kind === 'unknown-project'" class="digest-notice not-found">
    <p>{{ t("digest.notFound") }}</p>
  </section>
  <section v-else-if="state.kind === 'none'" class="digest-notice no-digest-notice">
    <p>{{ t("digest.noDigest") }}</p>
    <RouterLink :to="`/${projectKey}/threads`">{{ t("digest.viewThreads") }}</RouterLink>
  </section>
  <section v-else-if="state.kind === 'error'" class="digest-notice digest-unavailable">
    <p>{{ t("digest.unavailable") }}</p>
    <RouterLink :to="`/${projectKey}/threads`">{{ t("digest.viewThreads") }}</RouterLink>
  </section>
</template>
