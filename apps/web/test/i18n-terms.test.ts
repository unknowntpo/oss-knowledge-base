/**
 * Interface principles §4 (owner decision 2026-10-14): in zh-Hant a thread is 「討論」.
 * 「主題」 stays only for the Spec 014 digest topic (a taxonomy group of threads).
 */
import { expect, test } from "bun:test";
import { join } from "node:path";

import { loadTranslations } from "./i18n-harness";

/** Keys whose 「主題」 is the Spec 014 digest topic, not a thread. */
const digestTopicKeys = ["digest.anchor.topics", "digest.topics", "topic.breadcrumb"];

const source = await Bun.file(join(import.meta.dir, "..", "i18n.js")).text();
const zhHant = source.slice(source.indexOf('"zh-Hant": {'), source.indexOf("\n    en: {"));
const entries = [...zhHant.matchAll(/^\s*"([^"]+)": "(.*)",?$/gmu)].map((match) => ({ key: match[1]!, text: match[2]! }));

test("TERM1 zh-Hant calls a thread 討論: 主題 appears only in the digest-topic keys", () => {
  // Positive control: the parser reads the catalogue, including the keys that keep the word.
  expect(entries.length).toBeGreaterThan(150);
  expect(entries.filter((entry) => entry.text.includes("主題")).map((entry) => entry.key).sort()).toEqual([...digestTopicKeys].sort());
});

test("TERM1 the thread labels a reader sees say 討論", async () => {
  const zh = (await loadTranslations())("zh-Hant");
  expect(zh("card.open")).toBe("查看討論 →");
  expect(zh("rail.related")).toBe("相關討論");
  expect(zh("timeline.title")).toBe("討論時間線");
  expect(zh("stats.feed", { topics: 3, records: 9 })).toBe("3 個討論 · 9 筆紀錄");
  expect(zh("digest.topics")).toBe("開發主題");
});
