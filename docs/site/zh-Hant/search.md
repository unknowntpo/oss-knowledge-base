# 搜尋

搜尋以關鍵字為主：BM25 排序針對社群紀錄調整過，`KIP-770` 這類編號必須精確命中，多則訊息的長 thread 也不能蓋過主題集中的 thread。Dev 另外融合語意檢索，補足用詞不同的情況。下面每個數字都連到產生它的量測。

## 一個查詢怎麼被回答 {#flow}

{{flow:search}}

點選步驟可看數字與來源；各階段在下面的段落說明。

## 兩個階段 {#shape}

先用便宜的方式在全部語料中檢索；只有在相關結果仍排得太後面時，才考慮加上較昂貴的重排序。目前 Prod 只跑 BM25；Dev 加上語意檢索與排名融合；重排序尚未實作（[docs/architecture/search-algorithm.md](docs/architecture/search-algorithm.md)、[Spec 005](docs/specs/005-evidence-search/spec.md)）。

**BM25** 是標準的關鍵字排序公式：一個詞在整個語料中越少見（逆文件頻率，IDF）、在短段落中出現越多次，分數越高，但增幅遞減。

## 關鍵字排序 bm25-reference@3 {#bm25}

| 參數 | 值 | 來源 |
| --- | --- | --- |
| 段落大小 | 最多 180 個詞，重疊 30 個詞 | [chunking.ts](packages/search/src/chunking.ts) |
| `k1`、`b` | 1.2、0.75 | [lexical-search.ts](packages/search/src/lexical-search.ts) |
| 欄位權重 | 標題 4、標籤 2、內文與作者 1 | [lexical-search.ts](packages/search/src/lexical-search.ts) |
| 編號精確命中加分 | +1000（一定排第一） | [lexical-search.ts](packages/search/src/lexical-search.ts) |
| thread 分數 | Σ 段落分數 × 0.25^i，最佳段落在前 | [Spec 017](docs/specs/017-lexical-ranking/spec.md) |
| 片語加分 | 查詢中相鄰且順序相同的詞對 | [Spec 017](docs/specs/017-lexical-ranking/spec.md) |

### 斷詞與編號 {#tokens}

- 有大小寫邊界的字，會同時以原字與小寫分段建立索引：`HTTPServer` 也能用 `http` 和 `server` 找到。索引與查詢使用同一個斷詞器。
- 社群編號在斷詞前由各社群的設定檔正規化，而不是寫死在核心搜尋裡：`KIP770`、`kip770`、`KIP-770` 是同一個查詢；單獨的 `770` 會命中該專案中所有這個號碼的編號（KIP、Jira issue、pull request）。中間不接受空白，所以 `Kafka 4.2.0` 不會被當成 `KAFKA-4`（[identifiers.ts](packages/search/src/identifiers.ts)、[profiles.ts](packages/reference-pipeline/src/search/profiles.ts)）。

### thread 分數與相鄰加分 {#adjacency}

舊版本把每個額外命中的段落都加上 0.25 倍，結果一個 19 則訊息的版本發布 thread 得到最佳段落 5.5 倍的分數，壓過主題集中的 thread。第 3 版改用等比級數，thread 分數永遠不超過最佳段落的 4/3。另外，查詢中兩個詞在文中相鄰且順序相同時會加分：出現在標題時乘上標題權重，出現在內文時以該詞對的平均 IDF 計算（[Spec 017](docs/specs/017-lexical-ranking/spec.md)）。

### 分片與 terms.json {#shards}

發布器一次算好語料統計（段落數、平均長度、文件頻率），寫出每片最多 1,000 段的分片；一個 thread 不會被拆開，一片也只放一個專案。`terms.json` 記錄每個詞的文件頻率與它出現在哪些分片。一次查詢只讀三個小檔案，加上查詢詞出現的分片，同時最多讀四片。改版前每次查詢都讀所有分片、重新斷詞約 8,600 段，要花 695 ms 的 CPU（[Spec 013](docs/specs/013-search-streaming/spec.md)、[ADR-0007](docs/architecture/decisions/0007-publish-independent-versioned-search-releases.md)）。

## 真實語料評估 {#eval}

Spec 017 在一份 Dev release（2026-10-12）的快照上比較第 2 與第 3 版：343 個 thread、1,134 段、21 個已標註查詢；這份快照的前 20 名與完整 release 相同。指令：`bun run eval:search`，深度 20。

| 版本 | 通過的查詢 | Recall@20 | MRR | nDCG@10 |
| --- | --- | --- | --- | --- |
| @2 | 7 / 21 | 0.9397 | 0.5913 | 0.6832 |
| @3 | 20 / 21 | 0.9841 | 0.9762 | 0.9531 |

沒有任何查詢變差。拆解實驗：只用等比級數通過 15 個，只用片語加分通過 10 個，兩者一起通過 20 個。片語權重從 0.5 到 2 結果幾乎一樣，所以沒有特別調整。沒有採用：查詢詞覆蓋率因子（讓所有指標都下降）與 BM25F（要改儲存格式）。已知限制：詞序顛倒不會加分，也沒有詞幹還原。**MRR** 是第一個相關結果名次倒數的平均；**nDCG@10** 獎勵排在前十名前段的相關結果。

## Dev 上的語意混合搜尋 {#hybrid}

| 部分 | 選擇 | 原因 |
| --- | --- | --- |
| 向量模型 | `@cf/baai/bge-m3`，1,024 維，`bge-m3@1` | 支援多語（中文查詢），發布與查詢使用同一個模型 |
| 單位 | 與 BM25 相同的段落 | 只有一套切段規則，每段一個指紋 |
| 儲存 | Cloudflare Vectorize，cosine，每個專案一個 namespace，放在可替換的介面後面 | 託管的向量資料庫不能變成對外契約（[Spec 005](docs/specs/005-evidence-search/spec.md)） |
| 融合 | `rrf-group@2`：倒數排名融合，k = 60，以 thread 為單位 | 見下方 |
| 退回 | 任何失敗、逾時（1,000 ms）、預算拒絕或 release 尚未涵蓋，都回傳關鍵字結果與 HTTP 200 | 語意部分出問題時，搜尋照常運作 |

**倒數排名融合（RRF）** 把每份排名的 1 / (k + 名次) 相加。單純的 RRF（`rrf-group@1`）會傷害關鍵字的精確命中：只出現在一份清單的 thread 最多得到 1/61 ≈ 0.0164，同時出現在兩份清單的至少有 0.0153，所以弱的語意結果擠掉了正確的關鍵字結果（Dev 上「transaction manager」從第 1–2 名掉到第 20–21 名）。第 2 版讓段落包含所有查詢詞、排在前面的關鍵字 thread 保留原本的名次；順序是精確命中、這些 thread，其餘再依 RRF 排序（[Spec 016](docs/specs/016-semantic-search/spec.md)）。

重播 57 列已標註資料（`bun run eval:search-fusion`）：關鍵字達標 34 列；`rrf-group@1` 30 列，且有 10 列比關鍵字差；`rrf-group@2` 39 列，沒有任何一列變差。編號、數字與符號查詢完全不做向量化。`rrf-group@3` 在 15 個新查詢上與 @2 打平後就停止調整融合；下一個要改的是被向量化的文字，而不是融合方式。

### 查詢預算 {#budget}

公開的搜尋框不能讓人刷爆費用。每個語意查詢都要經過一個 Durable Object 帳本；選它是因為硬上限需要單一、強一致的計數器（最終一致的儲存可能超用）。每個 UTC 日上限：1,000 neurons、1,000 次索引查詢；每小時：100 次模型呼叫；查詢最長 500 字元；結果快取一小時（[query-gate.ts](packages/semantic-vectorize/src/query-gate.ts)）。**neuron** 是 Workers AI 的計費單位；帳號每天含 10,000，與週報、向量化工作共用（見[流程與成本](process.html#budgets)）。超過預算時，搜尋只回傳關鍵字結果。

> Prod 搜尋只有關鍵字（`v0.3.1` 起為 `bm25-reference@3`，2026-10-19；Prod 自 2026-10-24 起執行 `v0.3.2`）。Spec 016 與 017 有部分標註由實作者完成，尚待負責人確認；設計筆記目前仍標示為「討論中」。
