import type { RouteRecordRaw } from "vue-router";

import { lastProjectKey, proposalsRedirect } from "./digest-view";
import FeedDetailView from "./views/FeedDetailView.vue";
import FeedView from "./views/FeedView.vue";
import ProposalsView from "./views/ProposalsView.vue";
import TopicView from "./views/TopicView.vue";
import WeekView from "./views/WeekView.vue";

/** Spec 014 Behavior 27: project-scoped routes; Detail and Search detail keep their URLs. */
export function createRoutes(storage: () => Pick<Storage, "getItem"> | undefined): RouteRecordRaw[] {
  return [
    { path: "/", name: "home", redirect: () => `/${lastProjectKey(storage())}/` },
    { path: "/feed/:id", name: "detail", component: FeedDetailView, props: true },
    { path: "/search/:detailRef", name: "search-detail", component: FeedDetailView, props: true },
    { path: "/:projectKey/", name: "week", component: WeekView, props: true },
    {
      path: "/:projectKey/proposals",
      name: "proposals",
      component: ProposalsView,
      props: true,
      beforeEnter: (to) => proposalsRedirect(String(to.params.projectKey)) ?? true,
    },
    { path: "/:projectKey/threads", name: "threads", component: FeedView, props: true },
    { path: "/:projectKey/topic/:topicKey", name: "topic", component: TopicView, props: true },
    { path: "/:pathMatch(.*)*", name: "not-found", component: WeekView, props: () => ({ projectKey: "" }) },
  ];
}
