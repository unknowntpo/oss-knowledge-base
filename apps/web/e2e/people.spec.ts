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
  await expect(page.locator(".person-coverage li")).toHaveText([/^Reviews: \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}$/u, /^Comments, pull requests, Jira, dev@: \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}$/u]);
  await expect(page.locator('[data-count="received"]')).toContainText("2 reviews on 1 pull request from 2 reviewers");
  await expect(page.locator('[data-relation="reviewedBy"] li')).toHaveText([/^alice\s*shared PRs: 1$/u, /^carol\s*shared PRs: 1$/u]);
  await expect(page.locator("[data-section]")).toHaveCount(8);
});

test("W5: the profile of a reviewer: counts, threads newest first, 90 days narrows the period", async ({ page }) => {
  await open(page, aliceRoute);
  await expect(page.locator('[data-count="given"]')).toContainText("3 reviews on 3 pull requests");
  await expect(page.locator('[data-count="given"]')).toContainText("approved 1, changes requested 1, commented 1 · 3 inline comments");
  await expect(page.locator(".person-thread-pr")).toHaveText(["#43", "#41", "#40", "#39"]);
  // Slice 2b: the activity log's counts, areas without process labels, and threads beside the reviews.
  await expect(page.locator('[data-count="pull-requests"]')).toContainText("2 (1 merged)");
  await expect(page.locator('[data-count="comments"]')).toContainText("2 on 1 thread (0 on their own)");
  await expect(page.locator('[data-area="label"]')).toHaveText([/^clients\s*2 threads$/u, /^streams\s*1 thread$/u]);
  await expect(page.locator('[data-relation="wroteInThreadsBy"] li')).toHaveText([/^bob\s*shared threads: 1$/u]);
  await expect(page.locator('[data-thread-source="github"]')).toHaveCount(3);
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

const danaRoute = `/#/kafka/people/${encodeURIComponent("mail:dana mailer")}`;

test("W1 (2b): a dev@ identity has its own page, linked from nowhere else, with only dev@ counts", async ({ page }) => {
  await open(page, danaRoute);
  await expect(page.locator(".person-name")).toHaveText("Dana Mailer");
  await expect(page.locator('[data-count="mail"]')).toContainText("2 in 2 threads · [DISCUSS] 1, [VOTE] 1");
  await expect(page.locator('[data-count="given"]')).toHaveCount(0);
  await expect(page.locator('[data-area="kip"]')).toHaveText([/^KIP-1368\s*1 thread$/u]);
  await expect(page.locator('[data-section="areas"]')).toContainText("No area data from dev@");
  await expect(page.locator("[data-section]")).toHaveCount(8);
  await screenshot(page, "profile-kafka-dana-mail");
});

for (const width of [320, 375]) {
  test(`W5 (2b): at ${width} px a profile with activity has no horizontal overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 812 });
    await open(page, aliceRoute);
    await expect(page.locator('[data-count="pull-requests"]')).toBeVisible();
    await noHorizontalOverflow(page);
    await screenshot(page, `profile-kafka-alice-activity-${width}`);
    await open(page, danaRoute);
    await expect(page.locator('[data-count="mail"]')).toBeVisible();
    await noHorizontalOverflow(page);
    await screenshot(page, `profile-kafka-dana-mail-${width}`);
  });
}

test("W11: an identity with no recorded activity says so and names what is recorded", async ({ page }) => {
  await open(page, `/#/kafka/people/${encodeURIComponent("github:nobody-here")}`);
  await expect(page.locator(".person-missing")).toContainText("No recorded activity for this identity in Apache Kafka.");
  await expect(page.locator(".person-missing .person-coverage li").last()).toHaveText(/^Comments, pull requests, Jira, dev@: \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}$/u);
});

test("W24: the profile API answers noindex", async ({ request }) => {
  for (const id of ["github:alice", "github:nobody-here"]) {
    const response = await request.get(`/api/people/kafka/${encodeURIComponent(id)}`);
    expect(response.headers()["x-robots-tag"]).toBe("noindex");
  }
});
