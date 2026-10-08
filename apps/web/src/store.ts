import { inject, type InjectionKey, type Ref } from "vue";

import type { FeedIndex } from "./types";

export interface FeedStore {
  readonly payload: Ref<FeedIndex | undefined>;
  readonly loading: Ref<boolean>;
  readonly error: Ref<string | undefined>;
  readonly refresh: () => Promise<void>;
  /** A query typed in the top bar, handed to All threads once (Spec 014 Behavior 27). */
  readonly searchQuery: Ref<string>;
}

export const feedStoreKey: InjectionKey<FeedStore> = Symbol("feed-store");

export function useFeedStore(): FeedStore {
  const store = inject(feedStoreKey);
  if (store === undefined) throw new Error("Feed store is not available");
  return store;
}
