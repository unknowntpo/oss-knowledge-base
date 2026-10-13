// Spec 005 S17–S18: how the search result list is presented. The order is the API's (exact
// identifier matches first); nothing here re-sorts.
import type { SearchResponseV1 } from "./types";

type Translate = (key: string, variables?: Readonly<Record<string, string | number>>) => string;
type Matches = { readonly matches: readonly { readonly signals: { readonly exactIdentifier: boolean } }[] };

export interface SearchCount {
  /** Results of this response that hold an exact identifier match. */
  readonly exact: number;
  /** Results of this response. */
  readonly shown: number;
  /** Matching threads under the current filters; absent when the response does not give it. */
  readonly total?: number;
}

export function isExactResult(result: Matches): boolean {
  return result.matches.some((match) => match.signals.exactIdentifier);
}

/** Index of the first result after the leading exact matches, when both groups exist. */
export function otherResultsStart(results: readonly Matches[]): number | undefined {
  const start = results.findIndex((result) => !isExactResult(result));
  return start > 0 ? start : undefined;
}

/**
 * `facets.projects[].count` is each project's matching threads before the project filter and the
 * limit, so the total is the selected project's count, or the sum when no project is selected.
 */
export function searchCount(
  response: { readonly results: readonly Matches[]; readonly facets: SearchResponseV1["facets"] },
  projectId: string | undefined,
): SearchCount {
  const facets = response.facets.projects;
  const total = projectId === undefined
    ? facets.reduce((sum, facet) => sum + facet.count, 0)
    : facets.find((facet) => facet.projectId === projectId)?.count;
  return {
    exact: response.results.filter(isExactResult).length,
    shown: response.results.length,
    ...(total === undefined ? {} : { total }),
  };
}

export function searchCountText({ exact, shown, total }: SearchCount, t: Translate): string {
  if (shown === 0) return t("results.search.none");
  // A total below what is shown cannot be this list's total; say only what is shown.
  const known = total !== undefined && total >= shown;
  const more = known && total > shown;
  if (exact === shown && !more && known) return t(exact === 1 ? "results.search.exactOne" : "results.search.exactMany", { count: exact });
  // Exact matches come first, so fewer exact matches than results means all of them are listed.
  const lead = exact > 0 && exact < shown
    ? t(exact === 1 ? "results.search.exactOne" : "results.search.exactMany", { count: exact })
    : undefined;
  const form = more ? "partial" : known ? (shown === 1 ? "one" : "all") : "shown";
  const variables = { count: shown, total: total ?? shown };
  return lead === undefined
    ? t(`results.search.${form}`, variables)
    : t(`results.search.exactThen.${form}`, { ...variables, exact: lead });
}
