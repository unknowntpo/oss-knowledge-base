/**
 * Spec 019 slice 3: person results above the thread results of Search (W7). One request per
 * project with profiles, only where `/api/people` answers 200 and the query can be a login.
 */
import { PEOPLE_PROJECTS, peopleProject } from "@oss-knowledge-base/reference-pipeline/people";
import { PERSON_RESULTS_CAP, type PeopleSearchV1, type PersonMatchV1 } from "@oss-knowledge-base/reference-pipeline/people/search";

export { personQueryKey } from "@oss-knowledge-base/reference-pipeline/people/search";

export interface PersonResult extends PersonMatchV1 {
  readonly projectKey: string;
  readonly projectLabel: string;
  /** The profile route, `/<project>/people/<encoded id>`. */
  readonly route: string;
}

/** The projects to ask: the filtered one when it has profiles, otherwise every project with profiles. */
export function personSearchProjects(selectedProjectKey: string): readonly string[] {
  if (selectedProjectKey === "") return PEOPLE_PROJECTS.map((project) => project.projectKey);
  return peopleProject(selectedProjectKey) === undefined ? [] : [selectedProjectKey];
}

/** W7: exact matches first (in project order), then prefix matches by login, then project order; at most 3. */
export function mergePersonResults(responses: readonly PeopleSearchV1[]): readonly PersonResult[] {
  const order = (projectKey: string) => PEOPLE_PROJECTS.findIndex((project) => project.projectKey === projectKey);
  const results = responses.flatMap((response) => response.people.map((person): PersonResult => ({
    ...person,
    projectKey: response.project,
    projectLabel: peopleProject(response.project)?.label ?? response.project,
    route: `/${response.project}/people/${encodeURIComponent(person.id)}`,
  })));
  const key = (result: PersonResult) => result.display.toLowerCase();
  return results.sort((a, b) => {
    if (a.match !== b.match) return a.match === "exact" ? -1 : 1;
    if (a.match === "prefix" && key(a) !== key(b)) return key(a) < key(b) ? -1 : 1;
    return order(a.projectKey) - order(b.projectKey);
  }).slice(0, PERSON_RESULTS_CAP);
}
