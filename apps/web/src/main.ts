import { createApp } from "vue";
import { createRouter, createWebHashHistory } from "vue-router";

import App from "./App.vue";
import { createRoutes } from "./routes";
import "../styles.css";

const router = createRouter({
  history: createWebHashHistory(),
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
