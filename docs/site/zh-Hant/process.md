# 流程與成本

這個專案由一個人指揮 AI agent 開發。信任不是來自多讀 AI 的輸出，而是來自：附有編號驗收項目的規格、先看到失敗的測試、獨立的 AI 驗證者、CI 中的機器檢查，以及執行期的檢查。同樣的紀律也讓雲端帳單維持在平台方案的內含額度內。

## 規格驅動開發 {#specs}

每個功能都從 [docs/specs](docs/specs) 裡的一份規格開始：意圖、以真實資料做的範例、精簡審查，以及編號的驗收項目。目前共有 {{value:specs}} 份規格，其中 {{value:enforcedSpecs}} 份標示 `Traceability: enforced`。完整流程寫在 [docs/process/workflow.md](docs/process/workflow.md)。

1. **意圖**（人）：一個看得到的結果。
2. **斷言：** `D34`、`DOC4` 這類編號項目，各自寫明前提、動作、可觀察的結果與證據。規格必須涵蓋正常路徑、失敗與重試（項目數至少一樣多）、預算（附量測值與版本庫中的量測指令），以及可觀測性。
3. **決策：** 選擇會影響多個功能時寫 ADR（[docs/architecture/decisions](docs/architecture/decisions)）。
4. **切片：** 最小的端到端變更，先寫測試。
5. **關卡：** 本機檢查 → CI → Dev → Prod。
6. **執行期：** health 欄位與資料新鮮度是最終裁判。

接受任何設計之前，先依序做**精簡審查**：質疑每個需求、刪除、簡化、縮短驗證週期、最後才自動化。

### 可追溯性 {#traceability}

驗收編號串起規格、測試、pull request 與執行期檢查。當 enforced 規格中有項目沒有任何測試名稱包含它的編號時，`bun run check:traceability` 會失敗（[check-spec-traceability.ts](scripts/check-spec-traceability.ts)）。規格裡的測試計畫表由測試實際迭代的同一份案例檔產生，兩者不一致時 `bun run check:test-plan` 會失敗（[render-test-plan.ts](scripts/render-test-plan.ts)），所以人審的表格就是測試跑的資料。

### 證據規則 {#evidence}

- 測試必須先在沒有變更時被看到失敗，才算證明了斷言。
- AI 說「完成」或「LGTM」不算證據。合併需要實作者逐行自我審查、所有關卡通過，以及**獨立驗證者**：另一個只拿到規格與 commit 的 agent，逐項重跑驗收項目並附證據記錄通過、失敗或無法驗證。任何新 commit 都會讓它的結論失效。
- 人只決定核心事項：意圖、契約、成本、憑證、正式版發布與對外公開的介面（例如本站）。
- 每個教訓都移到能承載它的最強層級：型別，其次是 CI 關卡、測試，最後才是書面規則。已知的權宜做法記在 [docs/gardening.md](docs/gardening.md)，避免 agent 照抄。

## CI/CD 與發版 {#cicd}

[.github/workflows/ci.yml](.github/workflows/ci.yml) 在每個 pull request 上執行型別檢查、可追溯性與測試計畫檢查、建置、單元、整合與端對端測試。

| 事件 | 結果 |
| --- | --- |
| Pull request | 只跑 CI，不部署 |
| Push 到 `main` | 所有工作通過後部署 Dev Pages 與 Dev 發布器，再對已部署的 Dev 網站跑端對端測試 |
| 從 `main` 可達的 tag `vX.Y.Z` | 用驗證過的同一份建置部署 Prod Pages 與 Prod 發布器 |

tag 不會移動或重用；回復就是重新部署較早的 tag（[docs/operations/release.md](docs/operations/release.md)）。`v0.3.0` 沒通過 CI，什麼都沒部署；`v0.3.1`（2026-10-19）是第一個有每日即時資料的 Prod 版本。每次 push 都會發布一份自動產生的規格狀態看板（[Spec 020](docs/specs/020-feature-map-site/spec.md)）。

## R2 Class A 事件 {#incident}

R2 依兩種請求類別計費：**Class A**（寫入與列出，每月 100 萬次以內免費，之後每百萬次 4.50 美元）與 **Class B**（讀取，每月 1,000 萬次以內免費，之後每百萬次 0.36 美元）。前提條件不成立而失敗的條件式寫入，仍然算 Class A（[Spec 008](docs/specs/008-content-addressed-details/spec.md)）。

- **原因。** 2026-09-30 的一個變更，把「先讀、不存在才寫」改成每個物件都送一次條件式寫入，連已經存在的幾千個物件也送。每小時一次的 Dev 執行因此送出約 8,190 次 Class A，一個月約 598 萬次。
- **發現。** 2026-10-13 帳單頁顯示自 2026-10-07 起已有 120 萬次 Class A，整月預估約 20 美元；同期 Class B 只有 6,230 次。
- **修正 1。** 先用便宜的讀取（`head`，Class B）確認是否存在，只寫新物件：每小時執行從約 8,190 次 Class A 降到約 38 次。不變式：Class A ≤ 新物件數 + 3。
- **修正 2。** 每次執行都在 `/health`（`lastRun.r2`）回報自己的 R2 請求數，成本可以逐次觀察。
- **修正 3。** 發布從每小時改為每天一次（[Spec 018](docs/specs/018-daily-publication/spec.md)）。
- **之後。** 第一次每日 Dev 執行送出 391 次 Class A 與 8,343 次 Class B；2026-10-19 的執行為 794 / 8,590（Dev）與 381 / 7,977（Prod）。Spec 018 對每月 Class A 的估計低了十倍，這點被記錄下來而不是隱藏。

## 預算 {#budgets}

帳號使用 Workers Paid 方案；設計讓每個計量都維持在方案內含的額度內，而且每個工作在花費之前先記帳（[runbook](docs/runbooks/cloudflare-data-publisher.md)）。

| 計量 | 內含額度 | 預算用量 |
| --- | --- | --- |
| Workers AI neurons | 每天 10,000 | 週報 5,000 + 向量化工作 2,500 + 搜尋查詢 1,000 = 8,500，保留 1,500 |
| R2 Class A | 每月 100 萬次 | Dev 與 Prod 合計每月約 1.9 萬次 |
| R2 Class B | 每月 1,000 萬次 | 每月約 26 萬次 |
| R2 儲存 | 10 GB | Dev 已超過（13.3 GB，2026-10-19），記在 [docs/gardening.md](docs/gardening.md) |
| Vectorize | 1,000 萬個儲存維度 | 截至 2026-10-20 約 1,000 萬（已向量化 9,764 段 × 1,024），接近內含額度 |

版本庫中的 `measure:*` 指令可以離線重現這些數字（見根目錄的 [package.json](package.json)）；例如 `bun run measure:daily-volume` 檢查一天的量是否在每次執行的來源上限內。

## 可觀測性 {#observability}

- **`/health`**（每個發布器）：上次執行中各來源的結果、寫入的物件數、R2 請求數、搜尋索引大小，以及今天的 AI 用量與上限。不會回傳任何憑證。
- **產品中的新鮮度：** 每個畫面都顯示資料多舊；超過 24 小時 30 分為逾時，超過 27 小時為過期（[Spec 021](docs/specs/021-publication-overdue/spec.md)）。發布卡住時每個讀者都看得到，不需要推播通知。
- **`bun run verify:health`** 以唯讀方式比對 `/health` 與網站實際提供的資料，可對 Dev 或 Prod 執行（[scripts/verify/health.ts](scripts/verify/health.ts)）。
- **Workers Logs**（錯誤訊息經過遮蔽）：Dev 資料 Worker 已開啟；Prod 要等下一個 tag（`v0.3.2`）。

> 截至 2026-10-20，以頁尾的 commit 為準。帳單數字來自 Spec 008 與 runbook；執行數字來自公開的 `/health` 端點。
