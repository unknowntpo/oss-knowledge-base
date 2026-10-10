// Expected to fail: see leak.config.ts.
import { test } from "../deployed-e2e/fixtures";

test("a connection failure on the token-bearing request context", async ({ request }) => {
  await request.get("/api/feed");
});
