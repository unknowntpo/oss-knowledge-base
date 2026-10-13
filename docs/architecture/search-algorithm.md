# 搜尋演算法筆記

狀態：討論中（2026-10-13 更新）。這份文件記錄搜尋的現況、概念與下一步，隨討論更新。
規格出處：[Spec 005](../specs/005-evidence-search/spec.md)、[Spec 013](../specs/013-search-streaming/spec.md)、[Spec 016](../specs/016-semantic-search/spec.md)、[Spec 017](../specs/017-lexical-ranking/spec.md)。

## 一句話

搜尋分兩步：先用便宜的方法從全部資料抓出幾十筆候選（檢索），再用比較貴但比較準的方法把候選排好（重排）。線上目前只有第一步（BM25）。語意檢索與 RRF 合併已實作（Spec 016 slice 3），以開關控制。Dev 自 2026-10-13 起啟用（Worker 端的 shard root 與查詢 gate，以及 Pages 端的開關與 binding），文字查詢會合併語意候選；Prod 沒有任何設定；重排排在混合檢索之後，量測顯示需要才加。

## 使用情境（2026-10-08 決定）

- 編號查詢與概念查詢都會用：`KIP-939`、`KAFKA-12345`，以及「transaction 的 timeout 問題」。
- 可接受重排增加約 0.1–0.3 秒延遲。

兩種查詢都要顧，所以最後的形態是「字面檢索 + 語意檢索 + 重排」。順序依 Spec 005 的階段：語意檢索（Phase 2）→ RRF 合併（Phase 3）→ 重排（Phase 4）。

## 現況（Spec 005 Phase 1 + Spec 013）

```text
查詢 → 讀 terms.json → 只讀含查詢字的 shard → BM25 計分 → 依 thread 合併 → 結果
```

| 項目 | 做法 |
|---|---|
| 切塊 | 每筆紀錄切成最多 180 字的 chunk，相鄰重疊 30 字 |
| 欄位權重 | 標題 ×4、標籤 ×2、內文與作者 ×1 |
| 計分 | BM25（k1 = 1.2、b = 0.75），統計值在發布時預先算好 |
| 精確比對 | 結構化查詢（如 `KAFKA-1234`）命中時加 1000 分 |
| thread 分數 | `@1`、`@2`：最佳 chunk + 其他命中 chunk × 0.25。`@3`：chunk 依分數由高到低排列，第 i 個（從 0 起算）乘 0.25^i，所以 thread 分數低於最佳 chunk 的 4/3 |
| 詞組加分 | 只有 `@3`：查詢中相鄰的兩個字，若在 chunk 的標題或內文中也相鄰且順序相同，加上兩字 IDF 的平均；出現在標題時再乘 4。`HeartbeatRequestManager` 與 `heartbeat request manager` 視為相同的三個字 |
| 版本 | `bm25-reference@1`（Prod）、`@2`（camelCase 拆字、編號正規化）、`@3`（Spec 017：索引與 `@2` 相同，只改排序；Dev 自 Spec 017 N17 起發布 `@3`） |
| 儲存 | v3 release：每專案多個 shard（每個 ≤ 1,000 chunk）+ `terms.json` |
| 延遲 | Dev 中位數約 1.04 秒（Spec 013 前約 4 秒） |

## 核心概念

### 兩階段：檢索與重排

| | 檢索（retrieval） | 重排（reranking） |
|---|---|---|
| 目標 | 不漏（recall） | 排準（precision） |
| 處理量 | 全部資料（7,000+ 筆） | 前 20–50 筆 |
| 成本 | 必須很便宜 | 可以貴 |
| 例子 | BM25、embedding 檢索 | Clef、cross-encoder |

為什麼不直接用模型看全部資料：每次查詢跑 7,000 次模型太慢也太貴。

### BM25（字面檢索）

查詢的字出現在文件裡就加分；字越罕見，加分越多（IDF）；同一個字出現多次會加分，但有上限（k1）；長文件會被扣一點（b）。

- 強項：編號、類別名稱、設定名稱這類「字面要對」的查詢。
- 弱項：詞彙落差。查「consumer 重新分配很慢」，文件寫的是 `rebalance`，字面沒重疊就找不到。

### Embedding（語意檢索）

用模型把文字轉成向量，意思接近的文字向量也接近；查詢時找最近的向量。Cloudflare 有 embedding 模型（bge 系列）與 Vectorize。

- 強項：同義詞、換句話說、跨語言。
- 弱項：精確編號（`KIP-939` 和 `KIP-938` 向量很接近）。

### 混合檢索與 RRF

BM25 和 embedding 各給一份排名，用 Reciprocal Rank Fusion 合併：

```text
RRF(文件) = Σ 1 / (60 + 該文件在各排名中的名次)
```

只看名次、不看原始分數，所以兩種分數不需要換算到同一個尺度。

#### 單純的 RRF 在這裡失效的原因（2026-10-13 量測）

Dev 啟用 `rrf-group@1`（k = 60）後，以 `bun run measure:search-hybrid` 量測 48 題：字面檢索原本答對的 Spec 017 題目由 20 題降為 13 題，中文題由 1 題升為 3 題，詞彙落差題由 2 題升為 4 題。例如 `transaction manager` 的兩個預期 thread 由第 1、2 名降到第 20、21 名。

原因在於兩份排名的性質不同，而 RRF 把它們的名次視為等值：

- 語意排名的長度固定。每個專案向 Vectorize 取 50 個段落，共 100 個，不論相似度高低。字面排名的前 50 個 thread 中，平均有 35% 同時出現在語意排名。
- k = 60 時，只出現在一份排名的 thread 最高得 1/61 = 0.0164；同時出現在兩份排名的 thread 最低也有 1/110 + 1/160 = 0.0153，字面第 30 名加語意第 30 名則是 2/90 = 0.0222。兩份排名都只排在中段的 thread，因此排在字面第 1 名之前。
- 語意名次不代表相似。`transaction manager` 的語意第 9 名是 DataFusion 的 `Push down topk through join`。
- 在字面排名滿 50 筆的 31 題中，有 6 題的字面第 1 名不在語意候選內，合併後落到第 7 至 20 名。

`rrf-group@2`（Spec 016 Behavior 38）加入一條規則，其餘不變：

```text
查詢的字   = 查詢正規化後的相異字（RequestManager → request、manager）
完整命中   = 字面檢索回傳的某一個段落含有查詢的每一個字
保留的 thread = 字面排名從第 1 名起連續的完整命中，到第一個不是完整命中的 thread 為止
排序       = 精確編號命中 → 保留的 thread（依字面名次）→ 其餘 thread（依 RRF 分數）
```

- 沒有語意候選時，結果就是字面排名，因此各種退回情形的結果不變。
- 字面第 1 名不是完整命中，或查詢的字沒有任何段落命中（例如中文查詢）時，結果與 `rrf-group@1` 相同，所以中文題與詞彙落差題的改善全部保留。
- 以 2026-10-13 的錄製資料重放（`bun run eval:search-fusion`）：57 題中，比字面檢索差的題數由 10 題降為 0 題；43 題原始標註的答對數為字面 26、`@1` 22、`@2` 30。
- 放棄的部分：`manager request`、`storage tiered` 這類字序相反的查詢。`@1` 靠語意名次把預期 thread 往前排，`@2` 因為前幾名都含有兩個字而維持字面名次。
- 未解決：owner 的查詢 `consumer network thread request manager` 沒有任何段落同時含五個字，結果與 `@1` 相同（字面 2、21、9 名，合併後 3、39、24 名）。

加權 RRF、減少語意候選數、固定保留前 3 名、語意結果一律排在字面之後，都在同一份資料上比較過，各自仍有變差的題目或失去原有的改善（Spec 016 Results 的 ablation 表）。相似度門檻尚未比較：錄製當時回應沒有相似度，本次新增 `signals.semanticScore` 供下次錄製使用。

### 重排與 Clef

尚未採用（見「決定」）；以下是日後評估時的筆記。

Clef 是 decision model：給定「狀態」與「選項」，回傳每個選項的機率。拿來重排有兩種問法：

| | 逐筆（pointwise） | 一次比較（listwise） |
|---|---|---|
| 問法 | 每筆候選問一次：「和查詢相關嗎？很相關／部分相關／不相關」 | 一次列出 20 筆候選，問「哪一筆最能回答查詢？」 |
| 呼叫數 | 20 次（可並行） | 1 次 |
| 分數 | 各自獨立，可快取（查詢 × thread 內容） | 只有相對名次，換候選要重算 |
| 風險 | 呼叫數多 | 受輸入長度限制；可能偏好排前面的選項 |

暫定：先用逐筆，相關度分數 = P(很相關) + 0.5 × P(部分相關)。

Clef-flash 的限制：在 Workers AI 上，長輸入會被截斷（約 2K tokens），所以每筆候選只送標題與一小段摘錄。

## 混合檢索的查詢流程（Spec 016 slice 3，Dev 已啟用）

```text
查詢 → 讀 pointer、manifest
     ├→ 詢問 gate（Durable Object）：查詢 embedding（有快取）→ 每個專案向 Vectorize 取 50 筆
     └→ 讀 terms.json 與含查詢字的 shard（與上一行同時進行）
   → 每個 shard 只讀一次：BM25 計分，並把語意候選對回 release 裡的 chunk
   → 再讀只含語意候選的 shard → 合併（`rrf-group@1` 或 `rrf-group@2`）→ 結果
```

| 項目 | 做法 |
|---|---|
| 開關 | Pages 變數 `SEARCH_SEMANTIC` 加上 Durable Object binding `SEARCH_QUERY_GATE`。變數的值就是合併規則的版本：`rrf-group@1` 或 `rrf-group@2`，其他值一律回 BM25 結果並標示 `failed`。Dev 目前是 `rrf-group@1`。未設定時，回應與 slice 3 之前逐位元組相同 |
| gate | data Worker 的 `SearchQueryGate`：唯一可以呼叫 embedding 模型與 Vectorize 的地方，內含每日帳本與快取；沒有公開路由 |
| 找 chunk | manifest 的每個 shard 記錄第一個 group root（發布端 `SEARCH_SHARD_ROOTS=true`）。向量帶有 group root，可直接算出所在 shard，不需額外讀取 |
| 一致性 | 向量可變、release 不可變。候選必須在目前的 release 找到相同專案、紀錄、序號的 chunk，且指紋相同；結果的欄位一律取自 release |
| 候選數 | 每個專案最多 50 個段落；BM25 固定取前 50 個 thread 的名次，與 `limit` 無關 |
| 不算 embedding 的查詢 | 可精確比對的查詢（編號、純數字、符號）與少於兩個字母或數字的查詢 |
| 快取 | key 是語意版本與正規化後的查詢（NFKC、空白合併，保留大小寫），不含合併規則的版本，因此切換 `rrf-group@1` 與 `rrf-group@2` 不產生模型呼叫或 Vectorize 查詢。embedding 保留至少 7 天，各專案的候選保留 1 小時 |
| 預算 | 每個 UTC 日：查詢 embedding 1,000 neurons（每次 1）、Vectorize 查詢 1,000 次；每小時 100 次模型呼叫。超過時回 BM25 結果，`retrieval.semantic.status` 為 `over-budget` |
| 退回 | gate 失敗、逾時（1,000 ms）、超過預算、release 沒有 shard root：一律回 BM25 結果，HTTP 200，狀態寫在 `retrieval.semantic.status` |
| 畫面 | 只由語意檢索找到的結果多一個「意思相近」標記 |

費用估算（`bun run measure:search-query-budget`）：摘要的上限 4,500 是它自己的估算值，依 2026-10-08 的量測（估算 4,507、gateway 計為 5,733 neurons）實際約為 1.28 倍，即 5,760；加上 embedding 發布 2,500 與查詢 1,000，合計 9,260 neurons，低於方案內含的每日 10,000，餘裕 740。embedding 發布的估算值自 slice 3 起乘上 1.8：2026-10-12 的回填估計 $0.0088，gateway 實際計為 $0.0157。Vectorize 以（儲存向量數 + 查詢數）× 維度計費，每月上限 31,000 次查詢加上 8,780 個向量約 4,070 萬維，低於內含的 5,000 萬維。

延遲尚未實測（啟用後以 `bun run measure:search-hybrid` 量測，一次執行最多 48 次模型呼叫與 96 次 Vectorize 查詢，並另外記錄 owner 指定的縮寫查詢 `RM`、`ISR`、`HW`、`EOS`、`LSO` 的結果）。gate 的詢問與 shard 讀取同時進行，預期字面有命中的查詢多 0–0.3 秒，快取命中時幾乎不增加；字面沒有命中的查詢（例如中文）要多讀候選所在的 shard，預期由 0.7 秒增加到 1.2–2.5 秒。啟用後以 `bun run measure:search-hybrid` 量測。

## 怎麼知道變好了

用固定的標準查詢（golden queries）重跑，比較改動前後。

| 指標 | 白話 |
|---|---|
| Recall@20 | 正確答案有沒有進前 20 名（檢索有沒有漏） |
| MRR | 第一個正確答案排第幾，名次越前分數越高 |
| nDCG@10 | 前 10 名整體排得好不好，越前面的位置權重越高 |

標準查詢：`packages/search/test/fixtures/golden-queries.v1.json` 共 8 題（評分規則見 [golden-query-rubric](../specs/005-evidence-search/golden-query-rubric.md)）。Spec 016 新增 `golden-queries.v2.json`：沿用 v1 的 8 題，再加 8 題（編號無連字號、純數字、類別名稱片段、縮寫、中文），共 16 題，每題有分級（2 = 預期、1 = 可接受）與 `requires`（`lexical` 或 `semantic`）。`bun run eval:search` 算出三個指標並寫出報告。16 題仍然太少，需要補真實查詢。Spec 016 slice 3 為 slice 4 的量測另備 16 題（8 題中文、8 題詞彙落差與縮寫），在看到任何混合檢索結果之前依標題標註，待 owner 確認；`bun run measure:search-hybrid` 對 Dev 的公開 API 各問一次純字面（`semantic=off`）與一次混合檢索，列出預期 thread 的名次。2026-10-12 的字面基準：16 題中 3 題達標。

Spec 017 另外加入真實語料的評估：`real-corpus-snapshot.v1.json` 取自 2026-10-12 的 Dev release（8,700 個 chunk 中的 1,134 個，並附上該 release 的全域統計值），共 21 題；其中 1 題由 owner 標註，其餘 20 題由實作者依標題標註，待 owner 確認。snapshot 中每題前 20 名的排序與完整 release 相同。`bun run eval:search` 同時寫出這份報告：`@2` 通過 7 題（MRR 0.5913、nDCG@10 0.6832），`@3` 通過 20 題（MRR 0.9762、nDCG@10 0.9531）。25 個 chunk 的 v2 標準查詢看不出這個差距。

判讀失敗的方法：

- 正確答案沒進前 20 名 → 檢索的問題 → 補語意檢索。
- 正確答案在前 20 名但排在後面 → 排序的問題 → 才考慮加入重排（2026-10-10 決定）。

## 決定（2026-10-08 至 10-10，細節見 Spec 016）

| 項目 | 決定 |
|---|---|
| 檢索 | BM25 + 語意檢索，用 RRF（k = 60）合併；合併規則有版本號。2026-10-13 新增 `rrf-group@2`：字面排名開頭的完整命中維持原名次 |
| 退回 | 語意檢索停用或失敗時，只回 BM25 結果 |
| embedding 單位 | chunk（與 BM25 同一批 chunk），結果依 thread 合併，可引用段落 |
| 模型 | 多語言 `@cf/baai/bge-m3`（1,024 維），發布與查詢用同一個模型；模型與版本隨向量記錄，換模型就全部重算 |
| 向量儲存 | Cloudflare Vectorize 是第一個實作，放在可替換的 `SemanticRetriever` 介面後面；每個專案一個 namespace |
| 重排（Clef） | 不在 Spec 016；量測顯示「正確答案進前 20 名但排在後面」才加 |
| 通用與社群規則 | camelCase 拆字屬於通用規則，放核心；`KIP-n`、`KAFKA-n` 這類編號規則放社群 profile |

### 沒有採用的做法：查詢改寫

用 LLM 在查詢時把 `txn` 改寫成 `transaction`、把「交易逾時」翻成英文，再交給 BM25。

- 好處：不需要向量儲存，也不必為每個 chunk 算 embedding。
- 不採用的原因：每次查詢多一次 LLM 呼叫（延遲、費用、失敗時要退回）；改寫結果不固定，同一個查詢可能得到不同結果；Spec 005 的 LLM 邊界把查詢改寫列為混合檢索之後的選項。多語言 embedding 可以同時處理縮寫與跨語言，不必改寫查詢。
- 重新評估的條件：混合檢索上線後，詞彙落差題的 Recall@20 仍然不夠。

## 下一步

1. Spec 016 slice 1（已實作）：評估工具（v2 標準查詢、Recall@20、MRR、nDCG@10）、字面檢索修正（`bm25-reference@2`：camelCase 拆字、編號正規化）、RRF 合併核心。
2. slice 2a（已實作）：編號樣式移到社群 profile（`packages/reference-pipeline/src/search/profiles.ts`，發布端與 Pages 讀取端共用）；讀取端依 manifest 的 `lexicalRevision` 同時支援 `@1` 與 `@2`，其他版本回 503；發布端在 Worker 變數 `SEARCH_LEXICAL_REVISION=bm25-reference@2` 時才寫 `@2`，slice 2a 合併時兩個環境都未設定。
3. 切換（已完成，Spec 016 H42）：Dev 的 Worker 設定已加上該變數，部署後的下一次發布起 Dev 為 `@2`；Prod 未設定，仍是 `@1`。移除變數即回到 `@1`。
4. slice 2b（已實作；Dev 自 2026-10-12 啟用）：發布時為每個 chunk 算 embedding 並寫入 Vectorize。Dev 目前 8,780 個 chunk 全部完成。
5. slice 3（已實作；Dev 已於 2026-10-13 啟用）：查詢時算 embedding，在 `/api/search` 以開關啟用混合檢索（見「混合檢索的查詢流程」）。啟用 Dev 需要兩個設定 PR：先 Worker（shard root、gate 的 class 與 binding），再 Pages（binding 與 `SEARCH_SEMANTIC`）。
6. slice 4：啟用後以 `bun run measure:search-hybrid` 比較 BM25 與混合檢索，再決定是否加入重排。2026-10-13 在 `rrf-group@1` 量測的結果是「不需要重排」（43 題中 9 題符合條件，21%），但其中 7 題是 `rrf-group@2` 修正的退步，因此以 Dev 切換到 `rrf-group@2`（Spec 016 rollout step 7）之後的量測為準。暫定規則（待 owner 確認）：有合併結果的查詢中，至少 30% 的預期 thread 全部進前 20 名但有一筆落在標註的名次之外，才考慮重排。
7. Spec 017（已實作；Dev 已切換，N17）：`bm25-reference@3`。thread 分數改為等比遞減，並加入詞組加分；儲存的 shard 與 `terms.json` 和 `@2` 相同，只有 manifest 的 `lexicalRevision` 不同。Dev 的 `SEARCH_LEXICAL_REVISION` 設為 `bm25-reference@3`，部署後的下一次發布起生效；改回 `bm25-reference@2` 即可復原。已知限制：查詢的字在標題中不相鄰或順序相反時沒有詞組加分，例如 `manager request` 仍由長 thread 排第一（Spec 017 Results 的 guard rows）。
8. 視需要做「問答」：用檢索結果讓模型附引用回答（RAG，另立規格）。檢索品質是它的上限。

## 營運限制

- 搜尋使用獨立的 AI Gateway `osskb-search-dev`（每小時 600 次），不共用摘要的 `osskb-digest-dev`（每小時 60 次）。查詢時的 embedding 是每個未快取的查詢 1 次呼叫，gate 限制每小時 100 次、每日 1,000 次；若日後加入逐筆重排，每次查詢約再多 20 次。
- Vectorize 儲存量：Dev 為 8,780 個 chunk × 1,024 維 ≈ 899 萬維（2026-10-12），Workers Paid 方案內含 1,000 萬維；約再增加 990 個 chunk 就會超過，超過的部分每月每 1 億維 $0.05。查詢維度另計，方案內含每月 5,000 萬維。
- 模型不可用時，直接回 BM25 結果，搜尋不能因模型失敗而中斷。
- 重排（若日後加入）：快取以（查詢正規化結果、thread 內容雜湊、模型版本）為 key；Clef-flash 每百萬 input token $0.09，output 不計費，一次查詢約 4K tokens，約 $0.0004。

## 待討論

- 標準查詢由誰提供、要多少題？
- 查詢的 embedding 在瀏覽器算還是在伺服器算？slice 3 在伺服器端計算（data Worker 的 gate），延遲待啟用後量測。
- 濫用防護：Dev 沒有訪客身分，無法依訪客限流。gate 的每日上限保證 Workers AI 與 Vectorize 不產生費用；上限用完後，當日其餘查詢只回 BM25 結果。是否另加 WAF 限流規則待決定。
- slice 3 的 16 題標註是否正確？owner 舉例的兩個中文查詢，語料中沒有標題直接提到「逾時」或「很慢」。
- 郵件 thread 的每封回覆都重複標題，長 thread 因此排在前面（Spec 016 Results）：由 Spec 017 的 `@3` 處理。owner 標註的查詢 `consumer network thread request manager` 在 `@3` 仍未達到「前 3 名」：KAFKA-20765 的內文沒有 `network` 與 `thread`，屬於詞彙落差，要靠語意檢索。
- Spec 017 的 20 題標註是否正確？`Pull Request` 這類標籤被當成一般文字索引，`request` 出現在 8,700 個 chunk 中的 6,962 個（gardening G44），要不要改？
- 若加入重排：「部分相關」的權重 0.5 是否合理？要不要考慮時間（新的 thread 加分）？

## 名詞

| 名詞 | 意思 |
|---|---|
| chunk | 紀錄切出的小段落，檢索的最小單位 |
| IDF | 字的稀有程度；越罕見越有鑑別力 |
| recall / precision | 有沒有漏 / 排出來的準不準 |
| embedding | 文字轉成的向量 |
| RRF | 依名次合併多份排名的方法 |
| reranker | 只對少數候選重新計分的模型 |
| golden queries | 人工標好正確答案的測試查詢 |
