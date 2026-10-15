import type {
  FeedDetail,
  FeedIndex,
  FeedIndexEntry,
  SearchResponseV1,
} from "./types";
import type { PeopleErrorV1, PersonProfileV1 } from "@oss-knowledge-base/reference-pipeline/people";

async function json<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  const body = await response.json() as T & { readonly error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

export function fetchFeed(): Promise<FeedIndex> {
  return json<FeedIndex>("/api/feed");
}

export function fetchFeedDetail(item: FeedIndexEntry): Promise<FeedDetail> {
  return json<FeedDetail>(`/api/detail/${encodeURIComponent(item.entry.id)}`);
}

export function fetchEvidenceSearch(input: {
  readonly query: string;
  readonly projectId?: string;
  readonly projectStatus?: string;
  readonly occurredAfter?: string;
  readonly occurredBefore?: string;
  readonly limit?: number;
}): Promise<SearchResponseV1> {
  const params = new URLSearchParams({ q: input.query, limit: String(input.limit ?? 20) });
  if (input.projectId !== undefined) params.append("projectId", input.projectId);
  if (input.projectStatus !== undefined) params.append("projectStatus", input.projectStatus);
  if (input.occurredAfter !== undefined) params.append("occurredAfter", input.occurredAfter);
  if (input.occurredBefore !== undefined) params.append("occurredBefore", input.occurredBefore);
  return json<SearchResponseV1>(`/api/search?${params}`);
}

export function fetchSearchFeedDetail(detailRef: string): Promise<FeedDetail> {
  return json<FeedDetail>(`/api/search-detail/${encodeURIComponent(detailRef)}`);
}

export type PersonProfileAnswer =
  | { readonly ok: true; readonly profile: PersonProfileV1 }
  | { readonly ok: false; readonly status: number; readonly error: PeopleErrorV1 };

/** Spec 019 slice 2a. A 404 carries what the community records (W11, W27), so it is not thrown. */
export async function fetchPersonProfile(projectKey: string, personId: string): Promise<PersonProfileAnswer> {
  const response = await fetch(`/api/people/${encodeURIComponent(projectKey)}/${encodeURIComponent(personId)}`, { headers: { accept: "application/json" } });
  const body = await response.json() as PersonProfileV1 | PeopleErrorV1;
  return response.ok ? { ok: true, profile: body as PersonProfileV1 } : { ok: false, status: response.status, error: body as PeopleErrorV1 };
}

/** W25: true only where `/api/people` answers 200 (Dev). */
export async function fetchPeopleEnabled(): Promise<boolean> {
  const response = await fetch("/api/people", { headers: { accept: "application/json" } });
  return response.ok && (await response.json() as { readonly enabled?: unknown }).enabled === true;
}
