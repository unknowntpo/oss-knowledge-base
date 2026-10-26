# 系統地圖

在 Dev 或 Prod 上線的每個元件，依系統流程圖排列，附上該環境 `/health` 的即時狀態、它跑在哪，以及 Prod release tag 之後的變更。點選元件可看細節，以及它在 Cloudflare 或 GitHub 的連結。

{{map:system}}

## 怎麼讀 {#reading}

- **只畫已上線的元件。** 元件只有在所選環境上線時才會畫出。是否上線取決於它在 [docs/site/flows/system.json](docs/site/flows/system.json) 的 `gate`：也就是 [docs/feature-map.md](docs/feature-map.md#deployed-configuration) 中 Deployed configuration 打開它的那幾列。欄位以 `unset`、`none`、`off` 或 `no` 開頭就是關；`dry-run` 與 `monitor` 算開，並以標籤顯示。
- **狀態。** 綁定 `/health` 元件的節點會顯示狀態：ok、warn、stale、failed 或 unknown；其他節點顯示 n/a。讀不到 `/health` 時，所有元件都是 unknown，頁首會寫出嘗試的時間。
- **跑在哪。** 除非標為 **GitHub Actions** 或 **手動**，元件都跑在 Cloudflare。手動步驟需要人與 token，沒有排程，這是風險。
- **連結。** 指標與日誌留在 Cloudflare 與 GitHub；每個元件連到它的 Worker 日誌、AI Gateway 日誌或 R2 bucket，以及原始的 `/health`。

## 資料從哪來 {#sources}

這一頁在建置時由 `system.json`、Deployed configuration 與 git（建置 commit 可達的最新 `v*` tag，以及之後合併的 pull request）產生，並在瀏覽器讀取 `/health`（[Spec 033](docs/specs/033-system-map/spec.md)）。在 publisher 回報各元件狀態之前，所有狀態都是 n/a 或 unknown。
