/** Spec 019 slice 2a: whether author names link to profiles (W25, W28), asked once per page load. */
import { ref, type Ref } from "vue";

import { isBotLogin, parsePersonId, peopleProject } from "@oss-knowledge-base/reference-pipeline/people";

import { fetchPeopleEnabled } from "./api";

const enabled = ref(false);
let asked = false;

export function usePeopleEnabled(): Ref<boolean> {
  if (!asked) {
    asked = true;
    fetchPeopleEnabled().then((value) => { enabled.value = value; }, () => undefined);
  }
  return enabled;
}

/**
 * W28: the profile route of a record's author, or undefined when it has none: profiles off, a
 * source without profiles yet (Jira, dev@ in 2a), a bot, or a name that is not a GitHub login.
 */
export function personRoute(peopleEnabled: boolean, projectKey: string, source: string, author: string): string | undefined {
  if (!peopleEnabled || source !== "github") return undefined;
  const project = peopleProject(projectKey);
  const id = `github:${author}`;
  if (project === undefined || parsePersonId(id)?.kind !== "github" || isBotLogin(author, project)) return undefined;
  return `/${projectKey}/people/${encodeURIComponent(id)}`;
}
