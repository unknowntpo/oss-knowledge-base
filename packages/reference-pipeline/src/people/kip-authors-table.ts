/**
 * Spec 019 amendment (7), KIP authors revision: the `osskb.kip-authors.v1` table's key and shape,
 * shared by the `kip-pages` job that writes it and the profile that reads it at request time.
 * Browser-safe: no import, so the profile reader does not pull in the job's upstream code.
 */
export const KIP_AUTHORS_SCHEMA = "osskb.kip-authors.v1";
export const kipAuthorsKey = (projectId: string) => `internal/kips/v1/${projectId}/authors.json`;

export type KipAuthorStatus = "listed" | "no-list" | "unparsed";
export type KipJiraField = "one" | "several" | "empty" | "query" | "none";

export interface KipAuthorV1 { readonly name: string; readonly nameKey: string }
export interface KipIssueV1 {
  readonly key: string;
  readonly assignee: { readonly key: string; readonly display: string } | null;
  readonly readAt: string;
}
export interface KipPageV1 {
  readonly kip: number;
  readonly pageId: string;
  readonly version: number;
  readonly title: string;
  readonly url: string;
  readonly status: KipAuthorStatus;
  readonly authors: readonly KipAuthorV1[];
  readonly jira: KipJiraField;
  readonly issues: readonly KipIssueV1[];
}
export interface KipAuthorsTableV1 {
  readonly schema: typeof KIP_AUTHORS_SCHEMA;
  /** The start of the run that last changed the table's content. */
  readonly generatedAt: string;
  /** Pages modified since this time are covered (the first run's `since`). */
  readonly coverageFrom: string;
  readonly pages: readonly KipPageV1[];
}
