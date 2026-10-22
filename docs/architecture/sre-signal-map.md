# SRE 訊號地圖

狀態：討論用（2026-10-22）。這份文件不做決定，只把三件事放在一起看：系統今天發出哪些訊號、規則怎麼判斷、SRE agent 在規則 `firing` 之後看什麼、產出什麼。
規格出處：Spec 028 觀測訊號（PR #108，未合併，`docs/specs/028-observability-signals/spec.md`）、Spec 027 SRE agent 與 Amendment (1)（PR #106，未合併，`docs/specs/027-sre-agent/spec.md`）、Spec 026 cost guard、Spec 029 R2 retention。
Spec 027 與 028 還不在 `main`，下文以「§ 小節（行號）」引用 PR 分支上的版本（028 為 `114b5f4`，027 為 `283f131`）。程式碼行號以 `origin/main` `1de3898` 為準。

## 一句話

每個排程工作（job）把自己的結果寫進 `/health`（今天已有），Spec 028 再讓每次執行多寫一筆 Workers Analytics Engine（WAE）資料點並在 Worker 內用固定門檻判斷，結果放在 `/health.signals`（提案中）。SRE agent 只在某條規則為 `firing`（或 cost guard `tripped`、CI 失敗）時才啟動，讀固定範圍的資料，寫一筆診斷到本機 `diagnoses.jsonl`；它不偵測、不寫入、不暫停任何東西。

## 狀態標記

| 標記 | 意思 |
| --- | --- |
| **今天已有** | 在 `origin/main` 的程式碼裡，且 2026-10-22 12:05 UTC 讀 Dev／Prod `/health` 看得到 |
| **028 提案** | Spec 028（PR #108）描述，未實作；需要 slice 0（Wrangler ≥ 4.145.0）與 slice 1 |
| **027 提案** | Spec 027 Amendment (1)（PR #106）描述，未實作 |
| **規劃中** | 規格已合併但未實作（Spec 029 retention），或排程尚未設定 |

名詞：
- **state 規則**：讀 `/health` 時，用 Durable Object（DO）或 `last-run.json` 裡的「目前狀態」直接判斷，不查歷史。
- **analytics 規則（trend 規則）**：每個 job 執行結束時，用 Analytics SQL binding 查自己過去 ≤ 7 筆 WAE 資料點，結果存進該 job 原本就會寫的狀態紀錄。`/health` 本身從不查 WAE（028 Behavior 18，行 350）。
- **`runId`**：`<job>-<startedAt>`（例：`publication-2026-10-20T22-07-00-000Z`），同一次執行的資料點、log、（日後）span 都帶它（028 Behavior 2，行 228）。今天程式碼裡沒有這個欄位（Dev `/health` `lastRun.runId` 不存在）。

## A. 訊號清單

今天 `/health` 由 [`mergeHealth`](../../apps/data-publisher-worker/src/index.ts)（`index.ts:257`）把 DO 狀態與各 job 的 `last-run.json` 合成一份 JSON；`costGuard` 只在 `COST_GUARD` 設定時出現（`index.ts:212`、`:281`），`identityLinks`／`kipPages` 只在各自旗標設定時出現（`index.ts:422–426`）。Workers Logs 在 Dev 與 Prod 都開著，traces 關著（`wrangler.development.jsonc:11–14`、`wrangler.production.jsonc:11`）。log 今天是樣板字串，沒有 `runId`（例：`pipeline.ts:208`、`index.ts:167`、`index.ts:590`）。

| Job（WAE `job`） | 排程（UTC） | 訊號來源 → 存放處 | 欄位 | 狀態 |
| --- | --- | --- | --- | --- |
| `publication`（Dev） | `7 22 * * *`（`wrangler.development.jsonc:44`） | `PipelineState` DO → `/health` `lastRun`、`sources`、`running`、`scheduled`、`followUp`、`phase` | `ok`、`completedAt`、`copiedObjectCount`、`reusedObjectCount`、`pollTruncated`、`r2 {classA, classB}`、`sources[*] {ok, lastSuccessAt}` | **今天已有**（Dev 2026-10-21 22:07 `ok`，`classA` 1,092 = 1,089 + 3） |
| | | WAE 資料點 `osskb_signals_dev`：`indexes [runId]`、`blobs [job, env, status, sourceRunId]`、`doubles [ok, durationMs, r2ClassA, r2ClassB, r2Counted, completedAtMs, c1..c6]`；c1–c6 = github／mail／jira ok、`pollTruncated`、copied、reused（028 Behavior 13，行 289） | 同左 | **028 提案** |
| | | Workers Logs：`publication ${name} at …ms {…}`（`pipeline.ts:208`） | 自由文字 | **今天已有**；改成 `{message, runId, job}` 物件是 **028 提案**（Behavior 8，行 276） |
| `publication`（Prod） | `37 22 * * *`（`wrangler.production.jsonc:21`） | 同 Dev，`osskb_signals_prod` | 同上 | DO／`/health`／Logs **今天已有**（Prod 2026-10-21 22:37 `ok`）；WAE **028 提案**（Prod 在 Dev 一週 OB20 之後） |
| `digest`（Dev） | `47 22 * * *`（`DIGEST_CRON`） | `DigestRun` DO → `/health` `digest {enabled, running, scheduled, today, lastRun}` | `lastRun {ok, completedAt, durationMs, candidates, rejections}` | **今天已有**（Dev 2026-10-21 22:49 `ok`，86 s）；Prod 沒有 digest |
| | | WAE：c1 `candidates`、c2 rejections 合計，`sourceRunId` = 當晚 publication，`r2Counted` 0（D8） | 同左 | **028 提案** |
| `cost-guard`（Dev） | 跟 publication 同一個 tick（22:07），`COST_GUARD=monitor` | `COST_GUARD_STATE` → `/health` `costGuard {mode, status, reason, checkedAt, metrics, breaker}` | `status` `ok`/`warn`/`tripped`/`unconfigured`/`pending`、`breaker {tripped, metric, value, threshold, trippedAt}` | **今天已有**（Dev `monitor`，`tripped` since 2026-10-21 22:07:14，`r2ClassA` 月累計）；Prod 未設定（`costGuard` 不出現） |
| | | WAE：自己的 `cost-guard-…` 點，c1 breaker、c2–c3 `budget` 金額、c4 Class A 24 h spike | 金額欄位等 Spec 026 修正案（CG21–CG37）落地前為 0 | **028 提案** |
| `identity-links`（Dev） | `17 2 * * *`（`IDENTITY_LINKS_CRON`） | R2 `last-run.json` → `/health` `identityLinks {lastRun, lastGoodAt}` | `lastRun {ok, status, at, durationMs, links, rejected, people, bytesWritten, r2}` | **今天已有**（Dev 2026-10-22 02:17 `ok`，4.7 s）；Prod 未設定 |
| | | WAE：c1–c4 links／rejected／people／bytes，`r2Counted` 1 | 同左 | **028 提案** |
| `kip-pages`（Dev） | `43 3 * * *`（`KIP_PAGES_CRON`） | R2 `last-run.json` → `/health` `kipPages {revision, lastRun, lastGoodAt}` | `lastRun {ok, status (ok/unchanged/failed/over-budget), at, durationMs, requests, jiraRequests, pagesRead, pagesChanged, r2, error}` | **今天已有**（Dev 2026-10-22 03:43 `ok`，5.9 s）；Prod 未設定 |
| | | WAE：c1–c5 pagesRead／pagesChanged／issuesRead／requests／bytes，`r2Counted` 1 | 同左 | **028 提案** |
| `embedding`（Dev） | 每次 publication 成功後；仍有待處理 chunk 時每小時一次（`SEARCH_EMBEDDING=bge-m3@1`） | `SearchEmbeddingRun` DO → `/health` `searchEmbedding {lastRun, lastError, today, …}` | `lastRun {ok, durationMs, embeddedThisRun, pending, quarantined, deletedThisRun, …}` | **今天已有**（Dev）；Prod 未啟用 |
| | | WAE：c1–c4 embedded／pending／quarantined／deleted，`r2Counted` 0（D8） | 同左 | **028 提案** |
| `retention` | `17 10 * * *`（`RETENTION_CRON`，未設定） | `/health` `retention {mode, status, reason, lastRun {runId, deleted, remaining, elapsedMs, r2, failureKind}}` | 同左 | **規劃中**（Spec 029 已合併、未實作；`origin/main` 沒有 retention 程式碼，Dev `/health` 沒有 `retention`） |
| | | WAE：c1–c5 deleted objects／bytes、remaining、candidates、dry run | 同左 | **028 提案**（隨 Spec 029 落地） |
| CI release | push 到 `main`、推 `v*` tag（`.github/workflows/ci.yml:5–7`） | GitHub Actions run：`deploy-development`（`ci.yml:132`）、`deploy-production`（只在 `v*` tag，`ci.yml:252–254`） | `conclusion`、`headSha`、失敗 job 的最後 60 行 | run 本身 **今天已有**；harness 規則 `ci.release` 是 **027 提案**（A1，行 88） |

不在 Spec 028 job 清單內、但今天在 `/health` 的欄位：`reviewQueue`、`githubReviews*`、`searchQuery`。Spec 027 A2（行 116）把 `review-queue` 列為可觸發 job，Spec 028 沒有它的資料點；兩份規格要對齊（見 E）。

## B. 規則

門檻是 Spec 028 D4 的暫定值（行 532），改動要開 PR；規則條目格式為 `{id, source, status: ok|warn|firing|unknown, value, threshold, since, runId}`，缺資料一律 `unknown`，從不 `firing`（Behavior 5，行 264）。`/health.signals.status` 取最差的一條（`unknown` 算 ok，Behavior 7，行 272）。

| 規則 id | 適用 job | 輸入訊號 | warn | firing | 在哪裡判斷 | 狀態 |
| --- | --- | --- | --- | --- | --- | --- |
| `job.missed` | 每個已啟用的日排程 job（publication、digest、cost-guard 以 `checkedAt`、retention、identity-links、kip-pages） | 上一次執行（任何結果）距今多久，讀 `/health` 原本就讀的紀錄 | > 24.5 h | > 27 h；啟用後還沒跑過：27 h 內 `unknown`，之後 `firing` | Worker，`/health` 讀取時（state） | **028 提案**（Behavior 15，行 318） |
| `job.missed`（embedding） | `embedding` | 同上，只在 `pending` > 0 時 | > 2 h | > 3 h | Worker，`/health` 讀取時（state） | **028 提案** |
| `job.failures` | 全部 | 本次與前幾次的 `ok`；`unchanged`、`no-input` 算成功 | 本次失敗 | 連續兩次失敗 | Worker，該 job 執行結束時（analytics） | **028 提案**（Behavior 16，行 328） |
| `job.duration` | 全部 | `durationMs` 與前 7 次中位數（至少 3 次） | > 2 × 中位數 | ≥ 自己宣告的牆鐘預算 80 %（只有 retention 10 min、kip-pages `KIP_PAGES_CRON_WALL_MS`） | Worker，執行結束時 | **028 提案** |
| `job.r2ClassA` | `r2Counted` = 1 的 job（publication、identity-links、kip-pages、retention） | `r2ClassA` 與前 7 次中位數 | > 3 × 中位數且 > 1,000 | > 10 × 中位數且 > 5,000 | Worker，執行結束時 | **028 提案** |
| `r2.classAInvariant` | publication | `lastRun.r2.classA` 與 `copiedObjectCount` | — | `classA > copiedObjectCount + 3` | Worker，state | **028 提案**；同一個比較今天在 runbook 與 027 原始 `get_health`（已撤回）裡，靠人看 |
| `publication.freshness` | publication | now − 最新的 `sources[*].lastSuccessAt` | > 24.5 h（Spec 021） | > 27 h（Spec 010） | Worker，state | **028 提案**；網站的過期提示（Spec 010／011／021）**今天已有**，但只看 publication |
| `source.success` | publication（github、mail、jira 各一條） | 每個 UTC 日最新一筆 | 本次失敗 | 連續兩個 UTC 日失敗 | Worker，analytics | **028 提案**（Behavior 5，行 252） |
| `publication.pollTruncated` | publication | `pollTruncated` 連續為真的時間 | 本次為真 | 持續 > 48 h | Worker，analytics | **028 提案** |
| `digest.freshness` | digest（啟用時） | now − 最新成功的 `completedAt` | — | > 48 h | Worker，state | **028 提案** |
| `digest.rejections`（rejection spike） | digest | 本次 rejections 與前 7 次中位數（至少 3 次） | — | ≥ 10 且 > 3 × 中位數 | Worker，analytics | **028 提案** |
| cost guard `tripped` | cost-guard | `costGuard.status`、`breaker.trippedAt` | （guard 自己的 `warn`） | `status: "tripped"` | Worker（Spec 026 自己判斷；028 只轉述，不重算，Behavior 16） | 判斷 **今天已有**（Dev `monitor`）；作為 agent 觸發條件是 **027 提案** |
| `ci.release` | CI | 最新 `v*` tag 或 `main` 的 CI run | — | `conclusion: failure` | agent harness（確定性程式碼，不是模型） | **027 提案**（A1、Decision 14） |

Spec 028 Example（行 125）用 Dev 2026-10-20 的真實值走過一遍：全部 `ok`；2026-10-13 的每小時執行（`classA` ≈ 8,190、`copiedObjectCount` ≈ 35）會讓 `r2.classAInvariant` 與 `job.r2ClassA` `firing`。

## C. SRE agent

**目標（2026-10-22 owner 更新）**：要的是「自動化的診斷能力」，在既有的 agent runtime 上做，不從零自建 agent loop。候選 runtime 有 headless Claude Code（launchd 排程）、Claude Agent SDK、雲端排程 routine 或 pi 內建 agent，**尚未決定**（見 E 的「Agent runtime」）。Spec 027 原本「在 pi toolkit 上自建 loop、對照 CS329Z HW1」的寫法不再是目標；反映這個改變的 Spec 027 修正案**尚待提出**。下面的觸發、輸入、輸出、預算與邊界沿用 Amendment (1)，與 runtime 無關。

### 觸發與去重（027 A1，行 86–115）

- 每次排程執行先 GET Dev 與 Prod `/health`（2 次，不呼叫模型），收集 **firing**：`signals.rules[]` 中 `status: "firing"` 的條目、`costGuard.status: "tripped"`、harness 的 `ci.release`。
- `warn`、`unknown` 什麼都不啟動（Decision 11）。沒有 firing：記 `{verdict: "healthy", firings: 0, modelCalls: 0}` 就結束。
- `/health` 沒有 `signals`（028 未啟用，今天 Dev 與 Prod 都是這樣）：記 `signals: "unavailable"`，不用自己的門檻補判斷。所以 **今天能觸發的只有 cost guard `tripped` 與 `ci.release`**。
- 指紋 `<env>:<job>:<ruleId>:<since>`；已在 `diagnoses.jsonl` 的指紋不重診，除非條目的 `runId` 變了，且每個 UTC 日最多一次；規則回到 `ok` 再 `firing` 會有新的 `since`，即新指紋（行 104）。
- 每個 UTC 日最多 3 筆診斷，其餘記 `notDiagnosed: "daily-cap"`（Decision 15）。

### 每個 job 的輸入包（027 A2，行 116–158）

harness 先組好輸入包，當作第一份「不可信的工具輸出」交給模型。每份都含觸發的規則條目與 `costGuard`（讓「因為 guard 暫停而錯過排程」被解釋，而不是重報）。

| Job | `/health` 欄位 | 額外輸入 |
| --- | --- | --- |
| `publication`（Dev 22:07、Prod 22:37） | `running`、`scheduled`、`followUp`、`phase`、`lastRun {ok, runId, completedAt, copied, reused, r2, pollTruncated}`、`sources` | Prod 部署可能過期時加 `get_ci_status` |
| `digest`（Dev 22:47） | `digest.lastRun {ok, runId, completedAt, durationMs, rejections}` | `sourceRunId` 指向的 publication 資料點 |
| `review-queue`（無 cron） | `reviewQueue` | 無 |
| `search-embedding` | `searchEmbedding {lastRun, lastError, today}` | 無 |
| `identity-links`（Dev 02:17） | `identityLinks {lastRun, lastGoodAt}` | 無 |
| `kip-pages`（Dev 03:43） | `kipPages {lastRun, lastGoodAt}` | 無 |
| `retention`（規劃 10:17） | `retention {mode, status, reason, lastRun}` | 無 |
| cost guard | `costGuard {mode, status, reason, checkedAt, metrics, breaker}`（CG27 後加 `budget`） | 觸發當天的 `Q-window` |
| `ci.release` | 無 | `get_ci_status`（失敗 job 的最後 60 行） |

### 唯讀工具

| 工具 | 讀什麼 | 備註 |
| --- | --- | --- |
| `get_health` | `GET <publisher>/health`（公開） | 原樣回傳，不加推導門檻（SRE34） |
| `query_signals` | Analytics SQL HTTP API，三個固定模板：`Q-history`（某 job 8 天內 ≤ 20 筆）、`Q-run`（以 `runId` 查）、`Q-window`（觸發時間 ± 12 h 的所有 job） | 模型只選模板與參數，不寫 SQL；需要唯讀 token（Decision 12，scope 未驗證） |
| `get_run_logs` | `logs.workersLogs` 以 `runId` 過濾，≤ 200 行 | 預設關閉（Decision 13）；需 028 OB21 證明 `runId` 欄位可讀，否則要 Write 權限 token |
| `get_ci_status` | GitHub Actions runs（Actions: Read） | |
| `search_runbook` | 本機 `docs/runbooks/*.md` | ≤ 5 段 |
| `report` | 不讀任何東西 | 結束診斷，產出紀錄 |

### 輸出：診斷紀錄（027 A3，行 159–177）

每個 firing 一筆，由 harness 附加到 `~/.osskb-sre/diagnoses.jsonl`：
`fingerprint`、`env`、`job`、`ruleId`、`since`、`runId`、`verdict`（`explained`／`unexplained`／`inconclusive`）、`cause`、`evidence [{callId, source: health|sql|logs|ci|runbook, quote}]`、`runbook | null`、`ownerAction | null`（給 owner 的文字，沒有工具能執行它）、`model`、`modelCalls`、`costUsd`、`at`。除了本機之外顯示在哪裡是 Decision 9（建議：v1 只放本機）。

### 排程與預算（027 A4，行 178–199）

- 每天 00:30 與 11:00 UTC 兩次（Decision 10）：第一次在 publication、digest、cost guard 之後，第二次在 identity-links、kip-pages、retention 之後。
- 健康的一次：2 次 `/health`、0 次模型、0 次 SQL。
- 每筆診斷：≤ 12 次模型呼叫、≤ 60,000 tokens、≤ 3 次 SQL、≤ 1 次 log 查詢、≤ 3 次 GitHub 讀取。每天 ≤ 3 筆。
- 最壞情況模型費用約 $0.90／月（027 以 `deepseek/deepseek-v4.1-flash` 估算；runtime 改變後模型與計價要重估），Cloudflare overage $0。

### 永遠不做（027 A3 22、Non-goals）

- 不寫 R2、不呼叫 `/run`、`/*/run`、`/cost-guard/*`，不跑 wrangler、不部署。
- 不偵測、不重算 Spec 026／028 的門檻；不決定、啟動或解除暫停，不重設 breaker（由 cost guard 自己決定）。
- 不直接讀 R2、不推播通知、不看 traces（需 028 D2 與另一份修正案）。
- firing 本身由產品 UI 與 `/health` 呈現；診斷紀錄只負責解釋。

### 規則 → 診斷內容

| 規則 | 診斷要說明什麼 | 證據（工具／欄位） | Runbook |
| --- | --- | --- | --- |
| cost guard `tripped` | 哪個指標、月累計多少、主要來自哪段事件；今天的 publication 是否守住 Class A 不變式；`monitor` 下沒有暫停任何東西。027 Example (1)（行 200）：Dev `r2ClassA` 2,064,777 > 800,000，主要是 10-02..13 conditional put 事件，今天 1,092 = 1,089 + 3；ownerAction「決定 Spec 026 Decision 1（11-01 前重設）」 | `costGuard.breaker`、`lastRun.r2`、`Q-window` | [R2 operations and cost](../runbooks/cloudflare-data-publisher.md#r2-operations-and-cost)、[Cost guard: Read `/health`](../runbooks/cloudflare-data-publisher.md#read-health)、[Reset the breaker](../runbooks/cloudflare-data-publisher.md#reset-the-breaker) |
| `job.missed`（publication）、`publication.freshness` | 是沒排上、還在跑、follow-up 等待中，還是被 cost guard 暫停；距今多久 | `running`、`scheduled`、`followUp`、`phase`、`lastRun.completedAt`、`costGuard.breaker` | [Health and manual run](../runbooks/cloudflare-data-publisher.md#health-and-manual-run)、[Follow-up runs](../runbooks/cloudflare-data-publisher.md#follow-up-runs-spec-018) |
| `job.missed`（digest）、`digest.freshness` | digest 是否因 publication 未完成而延後（最多 4 × 15 min）或被 guard 暫停 | `digest.lastRun`、`digest.scheduled`、`costGuard` | [Reading `/health` `digest`](../runbooks/cloudflare-data-publisher.md#reading-health-digest) |
| `job.missed`（identity-links、kip-pages、retention） | 排程是否存在、旗標是否開、上次狀態 | 各自的 `lastRun`、`lastGoodAt` | 無對應 runbook 小節（缺口，診斷應回報） |
| `job.missed`（embedding） | `pending` 還有多少、是否撞到每日上限（00:05 UTC 才繼續）或 `lastError` | `searchEmbedding.lastRun`、`today`、`lastError` | [Search embeddings](../runbooks/cloudflare-data-publisher.md#search-embeddings-spec-016-slice-2b) |
| `job.failures` | 兩次失敗的錯誤是否相同、同時段其他 job 是否也失敗（平台問題） | `lastRun.ok`／`error`、`Q-history`、`Q-window`、`get_run_logs`（若開） | 該 job 的小節；[Observability / logs](../runbooks/cloudflare-data-publisher.md#observability--logs) |
| `source.success` | 哪個來源連兩天失敗、錯誤型態（GitHub 422、Jira、mail） | `sources[*]`、`Q-history` | [Health and manual run](../runbooks/cloudflare-data-publisher.md#health-and-manual-run) |
| `publication.pollTruncated` | 每天都被截斷代表追不上進度，是否需要 catch-up | `lastRun.pollTruncated`、`followUp.catchUps` | [Follow-up runs](../runbooks/cloudflare-data-publisher.md#follow-up-runs-spec-018) |
| `job.duration` | 變慢是因為資料量（counter 變大）還是外部延遲；是否接近牆鐘預算 | `durationMs`、c1–c6、`Q-history` | 該 job 的小節 |
| `job.r2ClassA`、`r2.classAInvariant` | Class A 是否遠超新物件數（2026-10-07..13 事件型態：失敗的 conditional put）；是否每次執行都如此 | `lastRun.r2`、`copiedObjectCount`、`Q-history` | [R2 operations and cost](../runbooks/cloudflare-data-publisher.md#r2-operations-and-cost) |
| `digest.rejections` | rejection 種類（`unparsable`、`empty`）是否集中在某個模型或語系 | `digest.lastRun.rejections`、`Q-history` | [Reading `/health` `digest`](../runbooks/cloudflare-data-publisher.md#reading-health-digest) |
| `ci.release` | 哪個 job、哪一步失敗；Prod 是否因此沒部署（`v0.3.0` 事件） | `get_ci_status` 最後 60 行、Prod `/health` | [First Prod release](../runbooks/cloudflare-data-publisher.md#first-prod-release)、[Roll back](../runbooks/cloudflare-data-publisher.md#roll-back) |

## D. 資料流

虛線框為提案；實線為今天已有。

```mermaid
flowchart LR
  subgraph jobs["排程工作"]
    pub["publication<br/>Dev 22:07 / Prod 22:37"]
    cg["cost guard<br/>publication tick"]
    dig["digest Dev 22:47"]
    emb["embedding<br/>after publication, hourly"]
    il["identity-links 02:17"]
    kp["kip-pages 03:43"]
    ret["retention 10:17<br/>規劃中"]
    ci["CI release<br/>GitHub Actions"]
  end
  subgraph store["訊號儲存"]
    do["DO state / last-run.json"]
    wae["WAE osskb_signals_env<br/>028 提案"]
    logs["Workers Logs<br/>runId 欄位 028 提案"]
    gha["GitHub Actions runs"]
  end
  subgraph rules["規則判斷"]
    state["state 規則<br/>/health 讀取時<br/>028 提案"]
    trend["trend 規則<br/>job 結束時<br/>028 提案"]
    guard["cost guard 自己判斷 tripped"]
  end
  subgraph surface["呈現"]
    health["/health<br/>signals 為 028 提案"]
    ui["網站過期提示<br/>今天只看 publication<br/>其他 job 為 D10"]
    owner["owner"]
  end
  subgraph agent["SRE agent（MacBook）027 提案"]
    poll["00:30 / 11:00 UTC<br/>GET Dev + Prod /health"]
    fire["firings + ci.release<br/>指紋、每日上限"]
    bundle["輸入包<br/>Q-history / Q-run / Q-window<br/>logs by runId / runbooks"]
    loop["模型迴圈<br/>runtime 待定"]
    diag["diagnoses.jsonl"]
  end
  pub --> do
  cg --> do
  dig --> do
  emb --> do
  il --> do
  kp --> do
  ret -.-> do
  pub & cg & dig & emb & il & kp & ret -.-> wae
  pub & cg & dig & emb & il & kp --> logs
  ci --> gha
  wae -.-> trend
  trend -.-> do
  do --> state
  do --> guard
  state -.-> health
  guard --> health
  do --> health
  health --> ui
  health --> owner
  health --> poll
  gha --> fire
  poll --> fire
  fire -->|"firing only"| bundle
  wae -.->|"SQL HTTP API"| bundle
  logs -.->|"runId"| bundle
  bundle --> loop
  loop --> diag
  diag --> owner
  classDef proposed stroke-dasharray: 5 5
  class wae,state,trend,ret,poll,fire,bundle,loop,diag proposed
```

## E. 待決事項

以下只列題目與建議，不在此決定。

Spec 028（PR #108，行 518–578）：
- **D2 Traces**：建議現在關，slice 2 後 Dev 以 rate 1 量 7 天。
- **D3 Workers Issues**：建議 slice 2 後只在 Dev 開，不接任何自動化。
- **D4 門檻**：建議先用 B 節的暫定值，Dev 一週（OB20）後確認。
- **D5 喚醒 agent**：建議由 agent 排程讀 `/health`，只在 `firing` 時呼叫模型；不用 Monitors。
- **D6 log 對應到 run**：建議 owner 用 HTTP SQL API 手動查，Worker 程式不讀 log。
- **D7 Wrangler 升級**：建議獨立成 slice 0（4.125.0 → ≥ 4.145.0）。
- **D8 digest 與 embedding 計算 R2**：建議 slice 1 一起包上計數 wrapper，讓 `job.r2ClassA` 涵蓋它們。
- **D9 訊號成本是否納入 cost guard**：建議暫不納入（≤ 0.3 % 免費額度，WAE 尚未計費）。
- **D10 其他 job 的停滯是否顯示在網站**：建議 Dev 一週後，在現有過期提示加上「背景 job 停滯或失敗」。

Spec 027（PR #106，行 638–670）：
- **9 診斷顯示在哪**：建議 v1 只放本機 `diagnoses.jsonl`，兩週後再評估 GitHub issue。
- **10 排程**：建議每天 00:30 與 11:00 UTC 兩次。
- **11 觸發條件**：建議只有 `firing`。
- **12 從 MacBook 讀 Analytics SQL**：建議用獨立唯讀 token，scope 在 Dev 驗證後再定（SRE36）。
- **13 以 `runId` 讀 log**：建議 OB21 證明可讀才開 `get_run_logs`，否則維持關閉。
- **14 harness 的 CI 規則**：建議保留 `ci.release`。
- **15 上限**：建議每天 ≤ 3 筆、每筆 ≤ 12 次模型呼叫、$0.20／天、OpenRouter 每月 $2 上限（runtime 改變後計價要重估）。
- **Agent runtime（新增，2026-10-22）**：用哪個既有 runtime——launchd 排程的 headless Claude Code、Claude Agent SDK、雲端排程 routine，或 pi 內建 agent。建議先以 headless Claude Code 或 Agent SDK 在 MacBook 上跑 dry run，因為 027 的唯讀工具與 deny 規則可以直接對應到工具白名單與權限設定；正式決定隨 Spec 027 修正案提出。

另需對齊的不一致：Spec 027 A2 稱 `search-embedding`、Spec 028 稱 `embedding`；027 A2 列了 `review-queue`，028 沒有它的資料點。
