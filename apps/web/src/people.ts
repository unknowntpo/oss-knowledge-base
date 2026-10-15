/** Spec 019 slices 2a and 2b: whether author names link to profiles (W25, W28), asked once per page load. */
import { ref, type Ref } from "vue";

import { activityPersonId, isBotLogin, parsePersonId, peopleProject } from "@oss-knowledge-base/reference-pipeline/people";

import { fetchPeopleConfig } from "./api";

const enabled = ref(false);
const recorded = ref<Readonly<Record<string, readonly string[]>>>({});
let asked = false;

function ask() {
  if (asked) return;
  asked = true;
  fetchPeopleConfig().then((value) => {
    enabled.value = value.enabled;
    recorded.value = value.recorded;
  }, () => undefined);
}

export function usePeopleEnabled(): Ref<boolean> {
  ask();
  return enabled;
}

/** Slice 2b: the sources each community records, by project key (empty until the answer arrives). */
export function usePeopleRecorded(): Ref<Readonly<Record<string, readonly string[]>>> {
  ask();
  return recorded;
}

/**
 * W28: the profile route of a record's author, or undefined when it has none: profiles off, a
 * Jira or dev@ name while its source is not recorded (`recorded` lacks it), a bot, or a name that
 * is no identity.
 */
export function personRoute(peopleEnabled: boolean, projectKey: string, source: string, author: string, recordedSources: readonly string[] = []): string | undefined {
  if (!peopleEnabled) return undefined;
  const project = peopleProject(projectKey);
  if (project === undefined) return undefined;
  if (source === "github") {
    const id = `github:${author}`;
    if (parsePersonId(id)?.kind !== "github" || isBotLogin(author, project)) return undefined;
    return `/${projectKey}/people/${encodeURIComponent(id)}`;
  }
  if ((source === "jira" || source === "mail") && recordedSources.includes(source) && project.sources.includes(source)) {
    // The Jira connector's bot rule, so a bot's name does not link (W12).
    if (source === "jira" && /bot/iu.test(author)) return undefined;
    const id = activityPersonId(source, author);
    return id === undefined ? undefined : `/${projectKey}/people/${encodeURIComponent(id)}`;
  }
  return undefined;
}
