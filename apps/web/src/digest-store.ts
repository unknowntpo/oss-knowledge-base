import { ref, watch, type Ref } from "vue";

import { useI18n } from "./i18n";
import { projectByKey, type ServedDigest, type WebProject } from "./digest-view";

export type DigestState =
  | { readonly kind: "loading" }
  | { readonly kind: "unknown-project" }
  | { readonly kind: "none"; readonly project: WebProject }
  | { readonly kind: "error"; readonly project: WebProject }
  | { readonly kind: "ok"; readonly project: WebProject; readonly digest: ServedDigest };

/** Loads `/api/digest` for the route's project and the current locale (Behavior 13, 27, 29). */
export function useDigest(projectKey: Ref<string>): Ref<DigestState> {
  const { locale } = useI18n();
  const state = ref<DigestState>({ kind: "loading" });
  let request = 0;
  async function load() {
    const project = projectByKey(projectKey.value);
    if (project === undefined) {
      state.value = { kind: "unknown-project" };
      return;
    }
    if (!project.profile.digest) {
      state.value = { kind: "none", project };
      return;
    }
    const current = ++request;
    state.value = { kind: "loading" };
    try {
      const params = new URLSearchParams({ projectId: project.profile.projectId, locale: locale.value });
      const response = await fetch(`/api/digest?${params}`, { headers: { accept: "application/json" } });
      if (current !== request) return;
      if (response.status === 404) state.value = { kind: "none", project };
      else if (!response.ok) state.value = { kind: "error", project };
      else state.value = { kind: "ok", project, digest: await response.json() as ServedDigest };
    } catch {
      if (current === request) state.value = { kind: "error", project };
    }
  }
  watch([projectKey, locale], () => { void load(); }, { immediate: true });
  return state as Ref<DigestState>;
}
