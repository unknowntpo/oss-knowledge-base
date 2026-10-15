<script setup lang="ts">
import { useI18n } from "../i18n";
import type { PersonResult } from "../person-search";

defineProps<{ readonly person: PersonResult }>();

const { t } = useI18n();
</script>

<template>
  <RouterLink
    class="card person-result"
    :to="person.route"
    :data-person-id="person.id"
    :data-match="person.match"
    :aria-label="t('a11y.openPerson', { name: person.display })"
  >
    <div class="card-head">
      <span class="person-result-kind">{{ t("search.person") }}</span>
      <span v-if="person.match === 'exact'" class="exact-match">{{ t("search.person.exact") }}</span>
      <span class="card-project">{{ person.projectLabel }}</span>
    </div>
    <h3 class="card-title person-result-name">{{ person.display }}</h3>
    <div class="card-foot">
      <span>{{ t(`people.identity.${person.source}`) }}</span>
      <span class="card-open">{{ t("search.person.open") }}</span>
    </div>
  </RouterLink>
</template>
