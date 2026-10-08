/**
 * Builds the web fixture digests (Spec 014 slice 3) from the captured Kafka week:
 * `apps/web/test/fixtures/digest/apache-kafka.{en,zh-Hant}.json`.
 *
 * The English object comes from `runDigest` (dry run) with a recorded model that replays the
 * hand-authored responses of slice 1 (`topic-digest-recorded.hand-2026-10-08.json`); no hosted
 * model is called. The zh-Hant object applies hand translations below to that English object and
 * checks each with the Behavior 25 protected-span rule; an item without a valid translation is
 * marked "Not translated", as the runtime would.
 *
 *   bun apps/data-publisher-worker/scripts/build-digest-fixture.ts
 */
import { join } from "node:path";

import {
  KAFKA_DIGEST_PROFILE, PROTECTED_PATTERNS,
  type DigestFixture, type DigestV1, type PricedModel, type RecordedResponses, type Sentence,
} from "@oss-knowledge-base/reference-pipeline";
import { detailPoolKey, FEED_DETAIL_POOL, MANIFEST_KEY, sha256Digest } from "@oss-knowledge-base/serving-contract";
import { runDigest } from "../src/digest/run";
import type { DigestModel } from "../src/digest/model";
import type { DigestBucket } from "../src/digest/store";

const root = join(import.meta.dir, "..", "..", "..");
const fixtures = join(root, "packages", "reference-pipeline", "test", "fixtures");
const out = join(root, "apps", "web", "test", "fixtures", "digest");
const fixture = JSON.parse(await Bun.file(join(fixtures, "topic-digest-kafka-2026-10-06.json")).text()) as DigestFixture;
const recorded = JSON.parse(await Bun.file(join(fixtures, "topic-digest-recorded.hand-2026-10-08.json")).text()) as RecordedResponses;

class Memory implements DigestBucket {
  readonly objects = new Map<string, string>();
  async getJson(key: string) { const body = this.objects.get(key); return body === undefined ? undefined : JSON.parse(body); }
  async list(prefix: string) { return [...this.objects.keys()].filter((key) => key.startsWith(prefix)); }
  async putIfAbsent(): Promise<boolean> { throw new Error("dry run writes nothing"); }
  async putPointer(): Promise<void> { throw new Error("dry run writes nothing"); }
}

const bucket = new Memory();
const details: Record<string, string> = {};
for (const entry of fixture.entries) {
  const detail = fixture.details[entry.displayId];
  if (detail === undefined) continue;
  const body = JSON.stringify({ entry: { id: entry.id, title: detail.title }, records: detail.records });
  const digest = await sha256Digest(body);
  details[entry.id] = digest;
  bucket.objects.set(detailPoolKey(FEED_DETAIL_POOL, digest), body);
}
const prefix = `public/v2/releases/${fixture.release.releaseId}/feed/`;
bucket.objects.set(`${prefix}index.json`, JSON.stringify({ entries: fixture.entries.map((entry) => ({
  displayId: entry.displayId, projectKey: entry.projectKey, status: entry.status, lastActivityAt: entry.lastActivityAt,
  sourceCounts: entry.sourceCounts, links: entry.links ?? null, entry: { id: entry.id, title: entry.title },
})) }));
bucket.objects.set(`${prefix}details.json`, JSON.stringify({ schema: "osskb.feed-detail-map.v1", releaseId: fixture.release.releaseId, details }));
bucket.objects.set(MANIFEST_KEY, JSON.stringify({
  schema: "osskb.feed-manifest.v3", releaseId: fixture.release.releaseId, generatedAt: fixture.release.generatedAt,
  feedIndexKey: `${prefix}index.json`, detailMapKey: `${prefix}details.json`, entryCount: fixture.entries.length,
}));

const overlap = (cites: readonly string[], ids: ReadonlySet<string>) => cites.filter((cite) => ids.has(cite)).length;

/** Replays the hand-authored responses for whichever call the prompt is. */
const recordedModel: DigestModel = {
  async run(_model: PricedModel, prompt: string): Promise<string> {
    const body = prompt.slice(prompt.indexOf("\n<"));
    const ids = new Set([...body.matchAll(/^\[([A-Z]+-[A-Za-z0-9-]+)\]/gmu)].map((match) => match[1]!));
    if (prompt.startsWith("You label")) {
      return JSON.stringify([...ids].map((id) => ({ id, ...recorded.classify[id] })));
    }
    if (prompt.startsWith("Summarize")) {
      if (/at most 1 sentences/u.test(prompt)) {
        const best = Object.values(recorded.proposals).sort((a, b) => overlap(b.cites, ids) - overlap(a.cites, ids))[0]!;
        return JSON.stringify({ sentences: overlap(best.cites, ids) > 0 ? [best] : [] });
      }
      const best = Object.values(recorded.cards).sort((a, b) =>
        b.reduce((sum, item) => sum + overlap(item.cites, ids), 0) - a.reduce((sum, item) => sum + overlap(item.cites, ids), 0))[0]!;
      return JSON.stringify({ sentences: best });
    }
    if (prompt.startsWith("From the validated")) return JSON.stringify({ headline: recorded.headline, highlights: recorded.highlights });
    return "translation is built below, not by this run";
  },
};

const result = await runDigest({
  bucket, profile: KAFKA_DIGEST_PROFILE, model: recordedModel, now: () => new Date("2026-10-07T01:37:00.000Z"),
  delay: async () => {}, spentToday: 0, cap: 1_000_000, dryRun: true,
});
if (!result.ok || result.objects === undefined) throw new Error(`digest run failed: ${result.error}`);
const en = result.objects.en;

/** Hand translations of the recorded English sentences (identifiers kept verbatim). */
const ZH: Readonly<Record<string, string>> = {
  "4.4.0 RC3 will be replaced by RC4 after David Jacot found a Maven signature problem.": "David Jacot 發現 Maven 簽章問題後，4.4.0 RC3 將由 RC4 取代。",
  "The 4.3.2 RC0 vote is still open; Jakub Scholz voted +1 (non-binding), and Bill Bejeck and Chia-Ping Tsai posted their verification steps.": "4.3.2 RC0 的投票仍在進行；Jakub Scholz 投下 +1 (non-binding)，Bill Bejeck 與 Chia-Ping Tsai 貼出驗證步驟。",
  "Apache Kafka 4.2.2 was announced, and Andrew Schofield posted the 4.5.0 release plan with KIP freeze on 2027-01-13.": "Apache Kafka 4.2.2 已宣布發布；Andrew Schofield 貼出 4.5.0 發布計畫，KIP freeze 訂於 2027-01-13。",
  "KAFKA-20292 merged parts 9–13 of assignor offloading; the open part 14 would run the consumer-group assignor on a coordinator background thread, with the new config defaulting to true.": "KAFKA-20292 合併了 assignor offloading 的第 9–13 部分；仍開啟的第 14 部分會讓 consumer group 的 assignor 在 coordinator 背景執行緒上執行，新設定預設為 true。",
  "David Jacot opened three PRs for a uniform2 consumer assignor (KAFKA-21214) and proposed KIP-1379.": "David Jacot 為 uniform2 consumer assignor（KAFKA-21214）開了三個 PR，並提出 KIP-1379。",
  "Two open PRs address members that stall when closing with REMAIN_IN_GROUP after a poll timeout, one for the Streams group protocol and one for the consumer group protocol.": "兩個開啟中的 PR 處理成員在 poll timeout 後以 REMAIN_IN_GROUP 關閉時卡住的問題，一個針對 Streams group protocol，一個針對 consumer group protocol。",
  "The KIP-1306 author asked on dev@ for reviews of six PRs; Andrew Schofield said he will review them and noted many PRs are waiting.": "KIP-1306 的作者在 dev@ 請大家 review 六個 PR；Andrew Schofield 表示會 review，並提到有許多 PR 在等待。",
  "KIP-1368 added `client.framework.id`, and on 10-05 Chris Egerton questioned using the instance ID to report connector type and version.": "KIP-1368 新增了 `client.framework.id`；10-05 Chris Egerton 質疑用 instance ID 回報 connector 類型與版本。",
  "Lianet Magrans asked for care on an open async-consumer fetch-buffer PR because recent busy-loop fixes touch the same path.": "Lianet Magrans 請大家謹慎處理一個開啟中的 async consumer fetch buffer PR，因為近期的 busy-loop 修正也動到同一路徑。",
  "KIP-1349 received a +1 (binding) and a +1 this week, and Chia-Ping Tsai asked whether a bytes-based trigger is better than a count.": "KIP-1349 本週收到一票 +1 (binding) 與一票 +1；Chia-Ping Tsai 詢問以 bytes 觸發是否優於以次數計算。",
  "A draft PR for KIP-1289 would let share-group acknowledgements join a producer transaction.": "KIP-1289 的草稿 PR 將讓 share group 的確認可以加入 producer 交易。",
  "An open PR would keep the original headers in share-group DLQ records.": "一個開啟中的 PR 會在 share group 的 DLQ 紀錄中保留原始 header。",
  "On the snappy-java CVE thread, Martin Andersson said lz4-java is the problem; the merged lz4-java 1.11.4 bump fixes three advisories, and a 1.12.0 bump is open.": "在 snappy-java CVE 討論串中，Martin Andersson 指出問題在 lz4-java；已合併的 lz4-java 1.11.4 升級修正三項安全公告，1.12.0 升級仍開啟中。",
  "An open PR adds a broker config to reject client writes that use chosen compression types.": "一個開啟中的 PR 新增 broker 設定，可拒絕使用指定壓縮格式的 client 寫入。",
  "KIP-1376 (TLS named groups) and KIP-1342 (deprecate `Authorizer#aclCount`) are under discussion.": "KIP-1376（TLS named groups）與 KIP-1342（棄用 `Authorizer#aclCount`）正在討論中。",
  "A dev@ question about KIP-1023 led to KAFKA-21190 and an open PR that skips the remote aux-state rebuild when the fetch offset equals the log start offset.": "dev@ 上關於 KIP-1023 的提問促成 KAFKA-21190，以及一個開啟中的 PR：當 fetch offset 等於 log start offset 時略過 remote aux state 重建。",
  "A reviewer said per-client-id remote fetch metrics need a KIP, and the author agreed to write one.": "一位 reviewer 表示每個 client-id 的 remote fetch 指標需要先提 KIP，作者同意撰寫。",
  "KIP-1165 was reopened with a fuller object-consolidation design.": "KIP-1165 重新開啟，提出更完整的 object consolidation 設計。",
  "An open PR adds rack-aware standby task assignment (KAFKA-20999) with fuzz-testbed and JMH results.": "一個開啟中的 PR 新增 rack-aware standby task 分配（KAFKA-20999），並附上 fuzz testbed 與 JMH 結果。",
  "The KAFKA-20224 iterator-adapter refactor was merged.": "KAFKA-20224 的 iterator adapter 重構已合併。",
  "Sushant Mahajan became a committer.": "Sushant Mahajan 成為 committer。",
  "Cruise Control moved to the Linux Foundation.": "Cruise Control 移交給 Linux Foundation。",
  "Contributors asked committers to approve CI runs, and two newcomers asked about pending Jira accounts.": "貢獻者請 committer 核准 CI 執行，兩位新成員詢問尚未核發的 Jira 帳號。",
  "Andrew Schofield voted +1 (binding) on 10-01 and Sushant Mahajan voted +1 on 10-05; Chia-Ping Tsai asked on 10-06 whether bytes beat a count.": "Andrew Schofield 於 10-01 投下 +1 (binding)，Sushant Mahajan 於 10-05 投下 +1；Chia-Ping Tsai 於 10-06 詢問 bytes 是否優於次數。",
  "On 10-05 Andrew Schofield added a third config, `client.framework.id`, after Lianet Magrans' feedback.": "10-05 Andrew Schofield 依 Lianet Magrans 的意見新增第三個設定 `client.framework.id`。",
  "Proposed by David Jacot on 10-02; Lucas Brutschy asked about upgrade and downgrade on 10-05.": "David Jacot 於 10-02 提出；Lucas Brutschy 於 10-05 詢問升降級相容性。",
  "Opened by Mickael Maison on 10-06.": "Mickael Maison 於 10-06 發起。",
  "Ming-Yen Chung updated it on 10-06 after Chia-Ping Tsai's review.": "Ming-Yen Chung 依 Chia-Ping Tsai 的 review 於 10-06 更新。",
  "Viktor Somogyi-Vass posted a fuller object-merging design on 10-05.": "Viktor Somogyi-Vass 於 10-05 貼出更完整的 object merging 設計。",
  "Six open PRs, [4/N]–[9/N], migrate to `RebalanceListener`; Andrew Schofield said he will review them.": "六個開啟中的 PR（[4/N]–[9/N]）遷移至 `RebalanceListener`；Andrew Schofield 表示會 review。",
  "An open PR adds compression support.": "一個開啟中的 PR 新增壓縮支援。",
  "A draft PR for transactional acknowledgements in share groups.": "share group 交易式確認的草稿 PR。",
  "An open docs follow-up PR.": "一個開啟中的文件後續 PR。",
  "A draft PR for the Streams DNS resolution config.": "Streams DNS 解析設定的草稿 PR。",
  "4.4.0 gets an RC4 after a signature problem in RC3, and KIP-1349 is being voted on.": "4.4.0 因 RC3 簽章問題將推出 RC4；KIP-1349 正在投票。",
  "4.4.0 RC3 will be replaced by RC4": "4.4.0 RC3 將由 RC4 取代",
  "David Jacot found a problem with the Maven artifact signatures, and Omnia Ibrahim said she will raise RC4.": "David Jacot 發現 Maven artifact 簽章有問題，Omnia Ibrahim 表示會推出 RC4。",
  "KIP-1349 is in its vote": "KIP-1349 投票中",
  "Andrew Schofield voted +1 (binding) and Sushant Mahajan voted +1 this week; Chia-Ping Tsai asked whether bytes are better than a count.": "本週 Andrew Schofield 投下 +1 (binding)，Sushant Mahajan 投下 +1；Chia-Ping Tsai 詢問 bytes 是否優於次數。",
  "KAFKA-20292 merged parts 9–13 of assignor offloading": "KAFKA-20292 合併 assignor offloading 第 9–13 部分",
  "Part 14, still open, would turn the new config on by default.": "仍開啟的第 14 部分會讓新設定預設開啟。",
};

/** Behavior 25's rule, applied to a hand translation: the same protected spans, nothing added. */
function keepsSpans(english: string, zh: string): boolean {
  const spans = (text: string) => {
    const found: string[] = [];
    let rest = text;
    for (const pattern of PROTECTED_PATTERNS) rest = rest.replace(pattern, (match) => (found.push(match), " "));
    return found.sort();
  };
  return JSON.stringify(spans(english)) === JSON.stringify(spans(zh));
}

let notTranslated = 0;
const translations: Record<string, string> = {};
function tr(sentence: Sentence): Sentence {
  const zh = ZH[sentence.text];
  if (zh === undefined || !keepsSpans(sentence.text, zh)) {
    notTranslated += 1;
    return { ...sentence, notTranslated: true };
  }
  translations[handKey(sentence.text)] = zh;
  return { ...sentence, text: zh };
}
function handKey(text: string): string {
  return `hand:${text.length}:${text.slice(0, 24)}`;
}
const zh: DigestV1 = {
  ...en,
  locale: "zh-Hant",
  cards: en.cards.map((card) => ({ ...card, sentences: card.sentences.map(tr) })),
  proposals: en.proposals.map((row) => (row.line === null ? row : { ...row, line: tr(row.line) })),
  headline: en.headline === null ? null : tr(en.headline),
  highlights: en.highlightsProvenance === null ? en.highlights : en.highlights.map((highlight) => {
    const title = ZH[highlight.title];
    const titleOk = title !== undefined && keepsSpans(highlight.title, title);
    if (!titleOk) notTranslated += 1;
    return { ...(titleOk ? { title } : { title: highlight.title, titleNotTranslated: true as const }), body: tr(highlight.body) };
  }),
  revisions: { ...en.revisions, translator: { model: "hand-2026-10-08", prompt: "hand" } },
  coverage: { ...en.coverage, notTranslated },
  translations,
};

await Bun.write(join(out, "apache-kafka.en.json"), `${JSON.stringify(en, null, 1)}\n`);
await Bun.write(join(out, "apache-kafka.zh-Hant.json"), `${JSON.stringify(zh, null, 1)}\n`);
console.log(`cards ${en.cards.length}, generated ${en.cards.filter((card) => card.status === "generated").length}, proposals ${en.proposals.length}, highlights ${en.highlights.length}, zh notTranslated ${notTranslated}`);
