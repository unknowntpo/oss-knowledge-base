# 週報

Dev 環境每天把過去七天的 Kafka 動態整理成一份簡短的雙語摘要：主題卡片、依階段排列的 KIP 提案，以及一個標題；每一句都引用它所根據的紀錄。文字由語言模型撰寫，能不能發布則由確定性的規則決定。

## 流程 {#flow}

{{flow:digest}}

模型透過 AI Gateway（加上速率與花費上限的代理）在 Cloudflare Workers AI 上執行。分工是刻意的：小而便宜的分類器對每個 thread 回答一題選擇題；大模型只根據交給它的 thread 寫作；第三個模型負責翻譯。排序、放置與驗證都是一般程式碼（[Spec 014](docs/specs/014-topic-digest/spec.md)）。

## 為什麼要用規則檢查模型 {#rules}

2026-10-08 檢視一週真實輸出時，發現有句子聲稱某個 PR 已合併，但它其實還開著；也有句子說某人反對，但沒有人這樣說過。光靠 prompt 擋不住，所以每句話在發布前都要對照來源紀錄檢查，不合格的句子直接丟掉，不嘗試修補（[validate.ts](packages/reference-pipeline/src/digest/validate.ts)）：

| 拒絕原因 | 擋下什麼 |
| --- | --- |
| `length` | 空白或超過 240 字元 |
| `no-cites`、`cite-outside-inputs` | 沒有引用，或引用了模型沒拿到的紀錄 |
| `status:<word>` | 沒有已合併的 PR 或已解決的 Jira 卻寫 merged、landed、fixed；沒有 [ANNOUNCE] 卻寫 released、shipped；沒有 [RESULT] 或 [ANNOUNCE] 卻寫 verified、accepted |
| `stance:<word>` | objected、rejected、pushed back 等誇大討論的立場詞 |
| `other-proposal` | 描述單一提案的那一行裡出現第二個 KIP |

尚在 [PR #101](https://github.com/unknowntpo/oss-knowledge-base/pull/101) 審查、還沒進 `main`：時態規則（項目尚未完成，卻用 is added、now supports 這類完成語氣），以及翻譯的狀態詞檢查（中文狀態詞必須與英文一致，否則保留英文）與一份小型 Kafka 術語表。

## 上 Prod 前的品質門檻 {#gate}

週報要先由人工標註一週真實輸出，評估達到門檻後才會上 Prod（[Spec 014](docs/specs/014-topic-digest/spec.md) Behavior 31）。

- **英文句子的錯誤類別：** `status-mismatch`、`misattribution`、`invented-claim`、`overbroad-stance`。
- **已定的門檻：** `status-mismatch` 為 0、`overbroad-stance` 為 0。另外兩類以及重要 thread 召回率的門檻由負責人決定（規格中的例子是召回率 ≥ 0.8）。
- **黃金資料集：** 版本庫中的一份標註檔；目前只有 2026-10-08 檢視時找到的 5 個反例，還沒有重要 thread 的標註（[topic-digest-labels.v0.json](packages/reference-pipeline/test/fixtures/topic-digest-labels.v0.json)）。
- **評估：** `bun run digest -- eval`（離線，不連網）依原因統計保留與丟棄的句子、每個已標註錯誤是否被擋下，以及召回率；`bun run digest -- measure` 在一次執行可能超過 neuron、呼叫數或讀取次數上限時失敗（[scripts/digest.ts](packages/reference-pipeline/scripts/digest.ts)、[eval.ts](packages/reference-pipeline/src/digest/eval.ts)）。

截至 2026-10-20：門檻尚未通過，所以週報只在 Dev 執行；Prod 沒有設定 `DIGEST_ENABLED`（[docs/feature-map.md](docs/feature-map.md#deployed-configuration)）。

## 成本 {#cost}

| 項目 | 值 | 來源 |
| --- | --- | --- |
| 每日上限 | 每個 UTC 日 5,000 估計 neurons（Dev 與 Prod 相同） | [estimate.ts](packages/reference-pipeline/src/digest/estimate.ts) |
| 估算方式 | 價目表 × 1.28，依 Workers AI 回報的 token 數校正 | [Spec 014](docs/specs/014-topic-digest/spec.md) |
| 最近一次 Dev 執行 | 29 次模型呼叫、1,637 估計 neurons、99 秒（2026-10-19 22:47 UTC） | Dev `/health` |
| Gateway | 每小時 60 次、每月 2 美元；被拒絕的呼叫會讓這次執行以 `limited` 結束 | [runbook](docs/runbooks/cloudflare-data-publisher.md) |

快取以輸入與版本為鍵，沒有變動的 thread 不會重新分類或摘要；修改 prompt 會讓快取失效，下一次執行的花費會接近從頭生成。
