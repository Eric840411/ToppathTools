# 圖片刪除驗證

> 這份是 `CLAUDE.md` 的 Product Features 章節拆出來的。維護規則不變：功能有新增或修改，要同步更新這裡。

---

## 5. OSM Tools — 圖片刪除驗證（ImageCheckPage）

**路由**：`/api/image-check/*`

### 功能說明
在 Toppath 內嵌瀏覽器中操作遊戲，自動驗證已刪除的圖片是否仍被載入。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 貼上已刪除圖片清單 | 輸入 blob URL 或路徑列表 |
| 貼上前端 URL | 遊戲頁面 URL，供 Playwright 開啟 |
| 啟動驗證 | 後台啟動 Playwright，自動截圖並比對 |
| 截圖/點擊/捲動 | 互動操作瀏覽器 |

---
