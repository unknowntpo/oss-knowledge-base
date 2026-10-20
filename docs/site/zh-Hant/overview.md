# 系統與資料流

每天一次，排程 Worker 收集社群動態、整理成 thread，並把不可變的快照發布到 R2；靜態網站再透過小型唯讀 API 讀取這份快照。點選任一步驟，可以看到它做什麼、上次執行的數字，以及實作它的檔案。

## 流程圖 {#flow}

{{flow:system}}

## 四個階段 {#stages}

1. **收集。** 各環境的 cron 觸發發布器。它從 Durable Object 裡保存的各來源游標讀取 GitHub、Jira 與 Kafka dev@ 郵件列表；一個來源失敗不會擋住其他來源，程式中途掛掉也會從停下的地方續跑（[ADR-0014](docs/architecture/decisions/0014-publish-per-source-with-independent-cursors.md)）。
2. **處理。** [apps/data-publisher-worker/src/pipeline.ts](apps/data-publisher-worker/src/pipeline.ts) 的 `runDataPublication` 用確定性的規則整理 thread（發布流程中不使用語言模型），寫出 Feed release，並建立搜尋索引。
3. **儲存。** R2 存放不可變的 release 與內容定址的詳細物件；只有小小的 `current.json` 指標會變，而且最後才寫。所以讀者看到的一定是一份完整的 release，回復也只要改指標（[Spec 006](docs/specs/006-environment-isolated-r2-publication/spec.md)、[Spec 008](docs/specs/008-content-addressed-details/spec.md)）。
4. **應用。** Pages Functions 讀 R2、回傳快取 30 秒的 JSON，由 Vue 網站呈現。部署程式碼不會發布資料：資料只來自 Worker（[docs/operations/release.md](docs/operations/release.md)）。

## Dev 與 Prod {#environments}

兩個環境完全隔離：Worker、Durable Object、R2 bucket 與 Pages 專案各自獨立，也不共用任何寫入憑證（[ADR-0012](docs/architecture/decisions/0012-run-independent-cloudflare-data-crons.md)）。

| 項目 | Dev | Prod |
| --- | --- | --- |
| 網站 | [oss-knowledge-base-dev.pages.dev](https://oss-knowledge-base-dev.pages.dev/) | [oss-knowledge-base.pages.dev](https://oss-knowledge-base.pages.dev/) |
| 部署方式 | 每次 push 到 `main`、所有 CI 工作通過後部署，接著對已部署的網站跑端對端測試 | 從 `main` 可達的 `v*` tag（目前 `v0.3.1`，2026-10-19） |
| 發布 cron | 22:07 UTC | 22:37 UTC |
| 關鍵字搜尋 `bm25-reference@3` | 開 | 開 |
| 每週週報 | 開（22:47 UTC） | 關 |
| 語意混合搜尋 | 開（`SEARCH_SEMANTIC=rrf-group@2`） | 關 |
| 貢獻者頁面、review 收集 | 開 | 關 |

每個只在 Dev 的功能都是一個在 Prod 未設定的開關，列在 [docs/feature-map.md](docs/feature-map.md#deployed-configuration)。新行為合併時開關是關的，再用另一個小變更逐一環境開啟；要回復時改設定即可，不必 revert（[docs/process/workflow.md](docs/process/workflow.md)）。

## 為什麼這樣設計 {#why}

- **快照，而不是即時資料庫。** 每天一份不可變的 release，從物件儲存提供既便宜又容易重現，也讓每句摘要都能引用固定的紀錄。目標的串流架構（Fluss、Flink、Iceberg）已在 [ADR-0001](docs/architecture/decisions/0001-use-fluss-for-events-and-current-state.md) 決定但尚未實作，目前只有相容性驗證（[Spec 007](docs/specs/007-fluss-flink-compatibility-spike/spec.md)）。
- **先規則，後模型。** thread 整理與編號抽取都是確定性的 TypeScript（[ADR-0006](docs/architecture/decisions/0006-use-typescript-reference-materializer-before-flink.md)）；語言模型只在發布之後用於週報與語意搜尋，而且各有每日預算。
- **資料過期要看得見。** Dev 曾經約 49 小時沒有發布卻沒人發現（[Spec 011](docs/specs/011-stall-visibility/spec.md)）。現在每個畫面都顯示資料多舊：超過 24 小時 30 分標為逾時，超過 27 小時標為過期（[apps/web/src/freshness.ts](apps/web/src/freshness.ts)）。

> 截至 2026-10-20。流程圖中的執行數字來自公開的 `/health` 端點；設定值來自各步驟連結的 wrangler 檔案。
