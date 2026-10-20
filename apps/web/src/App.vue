<script setup lang="ts">
import ThemeControl from "./components/ThemeControl.vue";
import { computed, onMounted, onUnmounted, provide, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import { fetchFeed } from "./api";
import { feedFreshness, freshnessText } from "./freshness";
import { useI18n } from "./i18n";
import { feedStoreKey } from "./store";
import { lastProjectKey, PROJECTS, projectByKey, rememberProject } from "./digest-view";
import type { FeedIndex } from "./types";

const payload = ref<FeedIndex>();
const loading = ref(true);
const error = ref<string>();
const { locale, setLocale, t } = useI18n();

async function refresh() {
  loading.value = payload.value === undefined;
  error.value = undefined;
  try {
    payload.value = await fetchFeed();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    loading.value = false;
  }
}

const searchQuery = ref("");
provide(feedStoreKey, { payload, loading, error, refresh, searchQuery });

// Spec 014 top bar: community switcher, tabs, search, locale (Behavior 27).
const route = useRoute();
const router = useRouter();
const storage = () => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};
const projectKey = computed(() => {
  const fromRoute = typeof route.params.projectKey === "string" ? route.params.projectKey : undefined;
  return projectByKey(fromRoute)?.profile.projectKey ?? lastProjectKey(storage());
});
watch(projectKey, (key) => rememberProject(storage(), key), { immediate: true });
const publishedProjects = computed(() => {
  const keys = new Set(payload.value?.projects.map((item) => item.key) ?? []);
  return PROJECTS.filter((project) => keys.size === 0 || keys.has(project.profile.projectKey));
});
const showProposals = computed(() => projectByKey(projectKey.value)?.profile.proposal.kind !== null);
const topQuery = ref("");
function switchProject(key: string) {
  void router.push(`/${key}/`);
}
function submitSearch() {
  searchQuery.value = topQuery.value;
  topQuery.value = "";
  void router.push(`/${projectKey.value}/threads`);
}
// Freshness is relative to the browser clock, so an open page re-evaluates it every minute (Spec 010).
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;
function generatedAtOf(feed: FeedIndex | undefined): unknown {
  const manifest = feed?.metadata.manifest;
  // feedFreshness validates the value, so an unexpected shape only hides the label.
  return typeof manifest === "object" && manifest !== null ? (manifest as { generatedAt?: unknown }).generatedAt : undefined;
}
const generatedAt = computed(() => generatedAtOf(payload.value));
const freshness = computed(() => feedFreshness(generatedAt.value, now.value));
let rereading = false;
/**
 * Spec 021: an open page holds the release it loaded. Before its pill starts or changes a
 * warning, it reads the Feed once more, so a tab left open over a normal run shows the new
 * release and not a false alarm. A failed read, or one that answers with an older release (a
 * cache behind), keeps the loaded Feed and lets the warning show.
 */
async function tick() {
  const next = feedFreshness(generatedAt.value, Date.now());
  if (next !== undefined && next.state !== "fresh" && next.state !== freshness.value?.state && !rereading) {
    rereading = true;
    try {
      const reread = await fetchFeed();
      const rereadAt = Date.parse(String(generatedAtOf(reread)));
      // NaN (unparsable) compares false, so only a release that is not older replaces the loaded one.
      if (rereadAt >= Date.parse(String(generatedAt.value))) payload.value = reread;
    } catch {
      // The Feed on screen is still the loaded one, and the warning is true for it.
    } finally {
      rereading = false;
    }
  }
  now.value = Date.now();
}
onMounted(() => {
  void refresh();
  clock = setInterval(() => { void tick(); }, 60_000);
});
onUnmounted(() => clearInterval(clock));
const pillClass = computed(() => {
  if (payload.value?.metadata.stale === true || freshness.value?.state === "stale") return "is-stale";
  return freshness.value?.state === "overdue" ? "is-overdue" : "is-live";
});

const recordCount = computed(() => payload.value?.entries.reduce(
  (sum, item) => sum + item.entry.recordIds.length,
  0,
) ?? 0);

const syncLabel = computed(() => {
  if (loading.value) return locale.value === "en" ? "Loading" : "載入中";
  if (error.value !== undefined) return "Live error";
  const stale = payload.value?.metadata.stale === true;
  if (payload.value?.metadata.servingMode === "cloudflare-pages-function-r2") {
    // `t` reads the locale outside Vue, so touch the ref to re-render this label on a locale switch.
    void locale.value;
    if (freshness.value !== undefined) return freshnessText(freshness.value, t);
    return locale.value === "en" ? "Published snapshot" : "已發佈快照";
  }
  return stale ? "Cached" : "GitHub live";
});
</script>

<template>
  <a class="skip-link" href="#main">{{ t("a11y.skip") }}</a>
  <header class="topbar">
    <RouterLink class="brand" :to="`/${projectKey}/`" :aria-label="t('a11y.home')">
      <span class="brand-mark" aria-hidden="true">K</span>
      <span class="brand-name">{{ t("brand.name") }}</span>
      <span class="brand-scope">{{ t("brand.scope") }}</span>
    </RouterLink>
    <span class="demo-pill" :class="pillClass">
      {{ syncLabel }}
    </span>
    <label class="community-control">
      <span class="visually-hidden">{{ t("nav.community") }}</span>
      <select class="community-switcher" :value="projectKey" :aria-label="t('nav.community')" @change="switchProject(($event.target as HTMLSelectElement).value)">
        <option v-for="project in publishedProjects" :key="project.profile.projectKey" :value="project.profile.projectKey">{{ project.name }}</option>
      </select>
    </label>
    <div class="topbar-right">
      <ThemeControl />
      <label class="locale-control">
        <span class="visually-hidden">{{ t("locale.label") }}</span>
        <select :value="locale" :aria-label="t('locale.label')" @change="setLocale(($event.target as HTMLSelectElement).value)">
          <option value="zh-Hant">中文</option>
          <option value="en">English</option>
        </select>
        <span class="locale-short" aria-hidden="true">{{ locale === "en" ? "EN" : "中文" }}</span>
      </label>
      <span class="topbar-stat">
        {{ payload ? t("stats.feed", { topics: payload.entries.length, records: recordCount }) : "—" }}
      </span>
    </div>
  </header>
  <nav class="top-tabs" :aria-label="t('nav.main')">
    <RouterLink class="top-tab" :to="`/${projectKey}/`" exact-active-class="is-active">{{ t("nav.week") }}</RouterLink>
    <RouterLink v-if="showProposals" class="top-tab" :to="`/${projectKey}/proposals`" active-class="is-active">{{ t("nav.proposals") }}</RouterLink>
    <RouterLink class="top-tab" :to="`/${projectKey}/threads`" active-class="is-active">{{ t("nav.threads") }}</RouterLink>
    <form v-if="route.name !== 'threads'" class="topbar-search" role="search" @submit.prevent="submitSearch">
      <label class="visually-hidden" for="topbar-q">{{ t("nav.search") }}</label>
      <input id="topbar-q" v-model="topQuery" type="search" autocomplete="off" :placeholder="t('nav.searchPlaceholder')" />
    </form>
  </nav>

  <main id="main">
    <section v-if="loading" class="load-error"><p>{{ locale === "en" ? "Loading community activity…" : "正在載入社群動態…" }}</p></section>
    <section v-else-if="error && !payload" class="load-error">
      <p>{{ locale === "en" ? "Unable to load community activity." : "無法載入社群動態。" }}</p>
      <code>{{ error }}</code>
      <button type="button" @click="refresh()">{{ locale === "en" ? "Retry" : "重試" }}</button>
    </section>
    <RouterView v-else />
  </main>

  <footer class="site-footer">
    <p>{{ t("footer.prototype") }}</p>
  </footer>
</template>
