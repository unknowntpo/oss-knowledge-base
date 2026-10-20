# OSS Knowledge Base

每天更新、以證據為本的開源社群閱讀器：Apache Kafka 與 Apache DataFusion 這週發生了什麼，並且可以一路搜尋到原始的 pull request、Jira issue 或郵件。這些頁面說明它怎麼做、為什麼這樣做，以及要花多少錢。

## 這是什麼 {#what}

產品每天收集一次公開的社群動態，整理成 thread，把不可變的快照發布到物件儲存，再由一個小型網站讀取。每一句摘要與每一筆搜尋結果都連回原始紀錄，讀者可以自己查證（見 [README.md](README.md) 與 [docs/feature-map.md](docs/feature-map.md)）。

| 項目 | 內容 |
| --- | --- |
| 社群 | Apache Kafka（GitHub、Jira、dev@ 郵件列表）與 Apache DataFusion（GitHub） |
| 線上網站 | Prod [oss-knowledge-base.pages.dev](https://oss-knowledge-base.pages.dev/)（版本 `v0.3.1`，2026-10-19）與 Dev [oss-knowledge-base-dev.pages.dev](https://oss-knowledge-base-dev.pages.dev/)（每次 push 到 `main`） |
| 執行環境 | Cloudflare：每個環境一個排程 Worker 寫入 R2 物件儲存；Pages 提供 Vue 網站與唯讀 API |
| 開發方式 | {{value:specs}} 份書面規格，其中 {{value:enforcedSpecs}} 份的驗收項目由機器檢查；每個變更都經過獨立的 AI 驗證 |

本站常用術語：**R2** 是 Cloudflare 的物件儲存（依請求類別計費，見[流程與成本](process.html#incident)）；**Worker** 是無伺服器函式；**Durable Object** 是自帶強一致狀態的 Worker；**Pages** 提供靜態網站與其 API 函式。

## 接著讀 {#pages}

| 頁面 | 你會看到 |
| --- | --- |
| [系統與資料流](overview.html) | 四個階段（收集 → 處理 → 儲存 → 應用）的可點選流程圖，以及 Dev 與 Prod 的差異 |
| [搜尋](search.html) | 帶編號正規化的 BM25 排序（`KIP770` = `KIP-770`）、真實語料評估，以及在 Dev 上的語意混合搜尋 |
| [週報](digest.html) | 一週動態如何變成雙語摘要：分類、摘要、驗證、翻譯，以及上 Prod 前的品質門檻 |
| [流程與成本](process.html) | 規格驅動開發、先失敗的測試、CI/CD 與發版、R2 成本事件、預算與可觀測性 |

## 現況速覽 {#status}

截至 2026-10-20（來源：[docs/feature-map.md](docs/feature-map.md#environments)、[docs/operations/release.md](docs/operations/release.md)）：

- **Prod 與 Dev 都有：** 每天從 GitHub、Jira、dev@ 發布；關鍵字搜尋 `bm25-reference@3`；thread 列表與詳細頁；資料新鮮度標示。
- **只在 Dev：** 每週主題週報、語意混合搜尋、貢獻者頁面與 review 收集。每項都有自己的開關，在 Prod 為關閉。
- **Prod 的下一步：** 週報要先在人工標註的一週資料上通過品質門檻，才會上 Prod（見[週報](digest.html#gate)）。

> 本站的數字來自頁尾所示 commit 的版本庫內容，或來自標明時間讀取的公開 `/health` 端點；每個數字都連到出處。
