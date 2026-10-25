import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";

import App from "./App.vue";
import { legacyHashPath } from "./legacy-hash";
import { createRoutes } from "./routes";
import "../styles.css";

// Spec 031 Behavior 3: an old `#/…` link lands on its path form. The URL is rewritten before the
// router reads it, so the first navigation is already the path route and the hash URL leaves no
// history entry. (A `router.replace` here would race the router's own initial navigation.)
const legacy = legacyHashPath(window.location.hash);
if (legacy !== null) window.history.replaceState(null, "", legacy);

// Spec 031: path URLs (`/kafka/people/<id>`); Pages serves index.html for every page path.
const router = createRouter({
  history: createWebHistory(),
  routes: createRoutes(() => {
    try {
      return window.localStorage;
    } catch {
      return undefined;
    }
  }),
  scrollBehavior: () => ({ top: 0 }),
});

createApp(App).use(router).mount("#app");
