# Game Show 四工具

> 這份是 `CLAUDE.md` 的 Product Features 章節拆出來的。維護規則不變：功能有新增或修改，要同步更新這裡。

---

## 11. Game Show — PDF TestCase 生成（GsPdfTestCasePage）

**路由**：`/api/gs/pdf-testcase`｜**歷史紀錄 feature key**：`gs-stats`（統計）

### 使用者操作
| 操作 | 說明 |
|------|------|
| 上傳 PDF | 選擇規格書 PDF 檔案 |
| 生成 TestCase | 送 Gemini 分析，輸出結構化 TestCase |
| 下載結果 | 下載 JSON / CSV 格式 |

---

## 12. Game Show — 圖片比對（GsImgComparePage）

**路由**：`/api/gs/img-compare/*`｜**歷史紀錄 feature key**：`gs-imgcompare`

### 使用者操作
| 操作 | 說明 |
|------|------|
| 建立比對 session | 上傳兩組截圖（before/after）|
| 執行比對 | AI 分析差異，標注不同區域 |
| 查看結果 | 並排顯示差異圖片 |

---

## 13. Game Show — 500x 機率統計（GsStatsPage）

**路由**：`/api/gs/stats/*`｜**歷史紀錄 feature key**：`gs-stats`

### 使用者操作
| 操作 | 說明 |
|------|------|
| 啟動統計 | 指定遊戲 URL 與樣本數，背景跑 500x 機率統計 |
| 查看進度 | 即時顯示已執行次數與目前統計結果 |
| 停止統計 | 中止當前統計 session |

---

## 14. Game Show — Log 攔截工具（GsLogCheckerPage）

**路由**：`/api/gs/log-checker-script`｜**歷史紀錄 feature key**：`gs-logchecker`

### 使用者操作
| 操作 | 說明 |
|------|------|
| 下載攔截腳本 | 取得瀏覽器注入用的 log 攔截 JS |
| 分析 Log | 貼入擷取的 log，AI 分析異常 |

---
