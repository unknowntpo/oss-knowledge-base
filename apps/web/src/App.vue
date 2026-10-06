<script setup lang="ts">
import { computed, onMounted, onUnmounted, provide, ref } from "vue";

import { fetchFeed } from "./api";
import { feedFreshness, freshnessText } from "./freshness";
import { useI18n } from "./i18n";
import { feedStoreKey } from "./store";
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

provide(feedStoreKey, { payload, loading, error, refresh });
// Freshness is relative to the browser clock, so an open page re-evaluates it every minute (Spec 010).
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void refresh();
  clock = setInterval(() => { now.value = Date.now(); }, 60_000);
});
onUnmounted(() => clearInterval(clock));
const freshness = computed(() => {
  const manifest = payload.value?.metadata.manifest;
  // feedFreshness validates the value, so an unexpected shape only hides the label.
  const generatedAt = typeof manifest === "object" && manifest !== null ? (manifest as { generatedAt?: unknown }).generatedAt : undefined;
  return feedFreshness(generatedAt, now.value);
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
    <RouterLink class="brand" to="/" :aria-label="t('a11y.home')">
      <span class="brand-mark" aria-hidden="true">K</span>
      <span class="brand-name">{{ t("brand.name") }}</span>
      <span class="brand-scope">{{ t("brand.scope") }}</span>
    </RouterLink>
    <span class="demo-pill" :class="payload?.metadata.stale === true || freshness?.stale ? 'is-stale' : 'is-live'">
      {{ syncLabel }}
    </span>
    <div class="topbar-right">
      <label class="locale-control">
        <span class="visually-hidden">{{ t("locale.label") }}</span>
        <select :value="locale" :aria-label="t('locale.label')" @change="setLocale(($event.target as HTMLSelectElement).value)">
          <option value="zh-Hant">中文</option>
          <option value="en">English</option>
        </select>
      </label>
      <span class="topbar-stat">
        {{ payload ? t("stats.feed", { topics: payload.entries.length, records: recordCount }) : "—" }}
      </span>
    </div>
  </header>

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
