# SRE agent

在 Dev 上，一個排程 job 讀取發布器自己的健康訊號。規則觸發時，語言模型從固定的證據包診斷原因。程式接著逐一檢查每個引用，通過後才儲存結果。agent 從不負責偵測，也從不修改系統（[Spec 027](docs/specs/027-sre-agent/spec.md)）。

## 一次診斷怎麼跑 {#loop}

1. **偵測（程式）。** Spec 028 的規則判斷 `/health` 欄位與 Workers Analytics Engine（WAE）資料點。每條規則的狀態是 `ok`、`warn`、`firing` 或 `unknown`（[Spec 028](docs/specs/028-observability-signals/spec.md)）。成本守門員跳脫、release CI 失敗也算 firing。沒有 firing 時，job 不呼叫模型。
2. **收集（程式）。** `sre-agent` job 為每個 job 建一個證據包。項目 `E1`…`En` 包含規則條目、該 job 的 `/health` 欄位、固定 WAE 查詢（`Q-run`、`Q-history`、`Q-window`）的結果，以及 playbook。項目會先遮蔽機密，總量上限 24 KB，並在 prompt 中標為不可信（[bundle.ts](packages/sre-agent/src/bundle.ts)）。
3. **診斷（模型）。** 一個 AI SDK 迴圈在 Workers AI 上執行 Qwen3 30B（`@cf/qwen/qwen3-30b-a3b-fp8`）。最多 12 步，每步最多輸出 4,096 tokens。工具都是唯讀：`/health` 區段、固定查詢、playbook 與 runbook（[loop.ts](packages/sre-agent/src/loop.ts)）。
4. **檢查（程式）。** 證據檢查決定接受或拒絕答案（見[下方](#evidence)）。
5. **儲存。** run 紀錄、完整軌跡與當日狀態寫入 R2 的 `internal/sre/v1/<env>/`。`/health` 的 `sreAgent` 欄位顯示上一次 run。負責人自己讀，不推播。

這個 job 在 Dev 每天跑兩次，UTC 00:30 與 11:00（[wrangler.development.jsonc](apps/data-publisher-worker/wrangler.development.jsonc)）。Prod 的 `SRE_AGENT` 是 `off`。

## 模型回答什麼 {#output}

**playbook** 是某條規則的 runbook 頁面，依檢查順序列出可能原因（[job.failures.md](docs/runbooks/sre/job.failures.md)）。模型回答六個欄位：

| 欄位 | 意義 |
| --- | --- |
| `cause` | playbook 表格中第一個有證據支持的 cause id，否則為 `unknown` |
| `verdict` | `explained`：cause 是一個 cause id。`inconclusive`：cause 是 `unknown`，且證據包缺少能判斷的證據。`unexplained`：cause 是 `unknown`，且引用的證據排除了所有原因 |
| `confidence` | `low`、`medium` 或 `high`；不會改變 verdict |
| `evidence` | 每個引用欄位一筆：項目 id 加上 path 或 quote |
| `runbook` | playbook 中的一個錨點，或 null |
| `ownerAction` | 負責人的下一步，任何工具都做不到的事 |

## 怎麼抓出捏造 {#evidence}

模型只能引用證據包裡的內容。[evidence.ts](packages/sre-agent/src/evidence.ts) 的 `checkEvidence` 只用程式，不用模型：

- JSON 項目用 `path` 引用，例如 `kipPages.lastRun.error`。path 必須能在該項目解析後的 JSON 中找到。
- 文字項目用 `quote` 引用。quote 必須出現在該項目中，或符合其中某個物件的鍵值對。空白不計；省略號會失敗。
- 不存在的項目 id 會失敗。playbook 沒有的 cause 會失敗。playbook 沒列出的 runbook 錨點會失敗。

檢查失敗時，verdict 改為 `unverified`。答案其餘部分保留給負責人閱讀。

## 預算 {#budget}

每次呼叫模型前，帳本先預留 neurons。預設上限是每個 UTC 日 3 次診斷、1,500 neurons。開發期間 Dev 提高到 10 次診斷、3,000 neurons（`SRE_AGENT_MAX_DIAGNOSES`、`SRE_AGENT_DAILY_NEURONS`）。無效的值會回到預設，絕不變成無上限。Qwen3 30B 最壞情況一次診斷用 576 neurons，所以 3,000 neurons 約 5 次診斷：若每個 neuron 都計費，每天 $0.033。加上週報、向量化與查詢的上限，Dev 的上限合計 11,500 neurons，最多超過每天內含的 10,000 達 1,500（[流程與成本](process.html#budgets)）。

## 故障注入演練 {#drill}

評估重播固定的證據包；演練則在 Dev 上測試真實路徑。負責人為 `kip-pages` job 設定 `throw` 或 `skip` 故障。job 接著失敗或沒有執行，寫入真實的 WAE 資料點，Spec 028 規則觸發，下一次 tick 進行診斷。程式依照只存在程式中的預期答案評分（[drill.ts](packages/sre-agent/src/drill.ts)）。`throw` 演練要通過，必須是 cause `upstream-unavailable`、引用 `kipPages.lastRun.error` 與 `Q-window` 資料列、預期的 runbook 錨點，以及 verdict `explained`。2026-10-26，Dev 演練 `throw-20261026T0929Z` 評為 `pass`（[Spec 033](docs/specs/033-system-map/spec.md)）。

## 用簡化技術英文寫 prompt {#prompt}

system prompt 遵循 ASD-STE100（Simplified Technical English，簡化技術英文）：一個概念一個詞、一句一個指示、祈使語氣、每句最多約 20 個字。它以 System context 區段開頭（[system.md](docs/runbooks/sre/system.md)），說明發布器、它的 jobs、`/health`、WAE，以及規則與 firing 是什麼。每個輸出欄位的區段與該欄位的 schema 說明是同一段文字，模型只讀到一種說法。測試 SRE99 與 SRE100 會在以下情況失敗：句子超過 20 個字、出現禁用詞（例如 "bundle item" 或 "verbatim"），或區段與 schema 不一致（[tick.cases.ts](packages/sre-agent/test/tick.cases.ts)）。

## 評估 {#eval}

`bun run --cwd packages/sre-agent eval` 以真實的 Workers AI 呼叫重播 7 個案例，每個 5 次。五個案例需要診斷，多半是過去的事件，例如 2026-10-13 的 R2 Class A 暴增。兩個案例必須不呼叫模型。加上 `--stub` 時由模擬模型給出預期答案：不連網，$0。評分全用程式，不用模型當評審。cause、每個必要的證據項目與 runbook 錨點都對，診斷才算通過。**捏造率**是被證據檢查拒絕的答案比例。

| Qwen3 30B | 2026-10-25 第三次 | 2026-10-27 |
| --- | --- | --- |
| 通過的診斷 | 24 次中 2 次 | 25 次中 7 次 |
| cause 正確 | 63% | 72% |
| 證據正確 | 25% | 40% |
| 捏造率 | 63% | 36% |
| 每次診斷的 neurons | 62.3 | 58.3 |

2026-10-27 這次共用 1,458 neurons，$0.016（[scoreboard-2026-10-25c](docs/specs/027-sre-agent/eval/scoreboard-2026-10-25c.md)、[scoreboard-2026-10-27](docs/specs/027-sre-agent/eval/scoreboard-2026-10-27.md)）。兩次之間，prompt 改用 STE，證據檢查也改變了：JSON 項目改用 path 引用，quote 不計空白。所以進步不只來自 prompt。

## 追蹤 {#tracing}

在 Dev 上，Cloudflare Agent tracing 記錄每一次 tick。Workers Observability 的 Agents 分頁可重播 prompt 與其證據包、每個模型步驟與最終診斷，並顯示 token 用量。trace 保留 7 天。R2 軌跡仍是 run 的正式紀錄。Prod 沒有 trace。

## 已知限制 {#limits}

- 最常見的失敗（25 次診斷中 8 次）是把字串 `"null"` 當成 `runbook`，而不是 JSON null。檢查會拒絕它，程式也不會轉換它。
- 五個需要診斷的案例中，有三個從未通過：`dev-stall-2026-10-02`、`kip-pages-two-failures` 與 `tag-ci-failure-v0.3.0`。
- agent 只在 Dev 執行。Prod 的 `SRE_AGENT` 是 `off`，也沒有設定配額或模型。
