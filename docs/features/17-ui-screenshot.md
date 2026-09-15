# UI 解析度截圖

> 這份是 `CLAUDE.md` 的 Product Features 章節拆出來的。維護規則不變：功能有新增或修改，要同步更新這裡。

---

## 17. OSM Tools — UI 解析度截圖（UiScreenshotPage）

**路由**：`/api/ui-screenshot/*`

### 功能說明
從 Lark Wiki 讀取 gmid 清單，使用 Local Agent（Playwright）對 H5 遊戲進行多解析度批量截圖，結果可回寫至 Lark Wiki TABLE。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 設定 Lark Wiki URL | 指定含 gmid 清單的 Wiki 文件 URL |
| 設定遊戲 URL Template | 填入含 `{gmid}` 佔位符的遊戲 URL |
| 選擇解析度 | 11 種 H5 解析度：Mobile Portrait / Landscape / Tablet，可分組全選 |
| 設定選項 | 自動關閉面額彈窗、等待推流就緒、Headed 模式、並發數 |
| 選擇 Agent | 從已連線的 Local Agent 中選擇執行裝置 |
| 開始截圖 | Agent 以 Playwright 批量執行，SSE 即時回報任務進度 |
| 停止 | 中止當前 Run，未執行任務標為 skipped |
| 查看截圖熱圖 | gmid × 解析度 Grid，截圖縮圖即時顯示，點擊放大預覽 |
| 查看清單模式 | 以表格呈現每個任務的狀態與錯誤訊息 |
| 回寫至 Lark Wiki | 將截圖結果回寫為 Wiki TABLE（每欄一種解析度）|

---
