import { mkdir } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

// Spec 019 slice 2a in the browser, against the constructed review store that `bun run
// e2e:prepare` seeds (apps/web/scripts/people-e2e-fixture.ts) and the Feed fixture's authors.
// Set PEOPLE_SCREENSHOT_DIR to keep a screenshot of the profile per project (desktop, phone).

const aliceRoute = `/#/kafka/people/${encodeURIComponent("github:alice")}`;

async function open(page: Page, hash: string, locale = "en") {
  await page.addInitScript((value) => window.localStorage.setItem("community-kb-locale", value), locale);
  await page.goto(hash);
}

async function noHorizontalOverflow(page: Page) {
  const { scroll, width } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  expect(scroll).toBeLessThanOrEqual(width);
}

async function screenshot(page: Page, name: string) {
  const directory = process.env.PEOPLE_SCREENSHOT_DIR;
  if (directory === undefined || directory === "") return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/${name}-${test.info().project.name}.png`, fullPage: true });
}

test("W28: a GitHub author in Detail links to the profile, which shows coverage and every section", async ({ page }) => {
  await open(page, "/#/feed/KAFKA-PR-43");
  const author = page.locator("a.author-link", { hasText: "bob" }).first();
  await expect(author).toHaveAttribute("href", `#/kafka/people/${encodeURIComponent("github:bob")}`);
  await author.click();
  await expect(page).toHaveURL(new RegExp(`#/kafka/people/${encodeURIComponent("github:bob")}$`, "u"));
  await expect(page.locator(".person-name")).toHaveText("bob");
  await expect(page.locator(".person-community")).toHaveText("Activity in Apache Kafka");
  await expect(page.locator(".person-coverage li")).toHaveText([/^Reviews: \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}$/u, "Comments, pull requests, Jira, dev@: not recorded yet"]);
  await expect(page.locator('[data-count="received"]')).toContainText("2 reviews on 1 pull requests from 2 reviewers");
  await expect(page.locator('[data-relation="reviewedBy"] li')).toHaveText([/^alice\s*shared PRs: 1$/u, /^carol\s*shared PRs: 1$/u]);
  await expect(page.locator("[data-section]")).toHaveCount(8);
});

test("W5: the profile of a reviewer: counts, threads newest first, 90 days narrows the period", async ({ page }) => {
  await open(page, aliceRoute);
  await expect(page.locator('[data-count="given"]')).toContainText("3 reviews on 3 pull requests");
  await expect(page.locator('[data-count="given"]')).toContainText("approved 1, changes requested 1, commented 1 · 3 inline comments");
  await expect(page.locator(".person-thread-pr")).toHaveText(["#43", "#41", "#40", "#39"]);
  await screenshot(page, "profile-kafka-alice");
  await page.getByRole("button", { name: "90 days" }).click();
  await expect(page.locator('[data-count="given"]')).toContainText("2 reviews on 2 pull requests");
  await expect(page.locator(".person-thread-pr")).toHaveText(["#43", "#41"]);
});

for (const width of [320, 375]) {
  test(`W5: at ${width} px the profile has no horizontal overflow and keeps its order`, async ({ page }) => {
    await page.setViewportSize({ width, height: 812 });
    await open(page, aliceRoute, "zh-Hant");
    await expect(page.locator(".person-name")).toHaveText("alice");
    await expect(page.locator(".person-coverage li").first()).toContainText("審查：");
    await noHorizontalOverflow(page);
    if (width === 375) await screenshot(page, "profile-kafka-alice-375-zh");
  });
}

test("W11: an identity with no recorded activity says so and names what is recorded", async ({ page }) => {
  await open(page, `/#/kafka/people/${encodeURIComponent("github:nobody-here")}`);
  await expect(page.locator(".person-missing")).toContainText("No recorded activity for this identity in Apache Kafka.");
  await expect(page.locator(".person-missing .person-coverage li").last()).toHaveText("Comments, pull requests, Jira, dev@: not recorded yet");
});

test("W24: the profile API answers noindex", async ({ request }) => {
  for (const id of ["github:alice", "github:nobody-here"]) {
    const response = await request.get(`/api/people/kafka/${encodeURIComponent(id)}`);
    expect(response.headers()["x-robots-tag"]).toBe("noindex");
  }
});
