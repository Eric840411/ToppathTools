# Egm DayCount 對帳

> 這份是 `CLAUDE.md` 的 Product Features 章節拆出來的。維護規則不變：功能有新增或修改，要同步更新這裡。

---

## 19. OSM Tools — Egm DayCount 對帳（EgmDayCountPage）

**路由**：`POST /api/osm/meter-reconcile/egm-daycount`（目前只支援 OSM，沒有 GCP 對應版本）｜**歷史紀錄 feature key**：`egm-daycount`

### 功能說明
比對後台 `Egm DayCount`（`/egm/reports/gameCount`，一天一列彙總報表）與 `User Detail`（`/egm/reports/playerMachineCount`，player+machine 逐筆列）算出的值是否一致，Jackpot Amount 另外對照 `Jackpot Record`（`/egm/reports/jackpotRecordList`，逐筆中獎紀錄）。原本是 Performance Meter 對帳頁面內的第二個分頁，後來拆成獨立頁面。三支 API 皆已用真實 Network request 截圖確認（`backendservertest.osmslot.org`，跟 `meter_reconcile_config` 裡存的 OSM 帳密同一組，共用同一組後台設定，沒有自己的設定 UI）。

**欄位對應**（已用真實查詢驗證全部吻合，`allPass: true`）：
| 顯示欄位 | gameCount（Egm DayCount）| 對照來源 |
|---|---|---|
| Total Bet User | `betUsers` | playerMachineCount：逐筆列裡 `betTimes > 0` 的不重複 `playerId` 數（沒有現成的不重複計數欄位，自己從 items 算）|
| Total Bet Number | `betTimes` | playerMachineCount：`sumData.betTimes` |
| Total Bet Amount | `bet` | playerMachineCount：`sumData.bet` |
| Total Online Transfer In/Out Amount | `machineIn`/`machineOut` | playerMachineCount：`sumData.machineIn`/`machineOut` |
| Total Win Or Lose Amount | `platformWin` | playerMachineCount：`sumData.platformWin` |
| Total Win Lose Ratio | `platformWinPercent` | playerMachineCount：`sumData.platformWinPercent` |
| Jackpot Amount | `jackpotamount` | **jackpotRecordList**：`sumData.jackpotamount`（不是 playerMachineCount，那支沒有這個欄位）|

**`jackpotRecordList` 跟前兩支 API 的參數風格不一樣**（已用真實 Network request 截圖確認）：`dateTimeType=1`（不是 0），`dateTime[]` 是空白分隔的本地時間字串（例如 `"2026-07-28 00:00:00"`），不是 ISO UTC；其餘 `playerstudioid`/`channelId`/`isall` 參數規則跟前兩支一致。回應欄位是 `jackpotamount`（小寫，跟 `gameCount` 同一個命名慣例）、`userid`、`username`、`clientMachineName`、`payoutTime`。

**「有下注的帳號」彙整清單**：同一個 UserId 會在多台機台各出現一列 `playerMachineCount` 的紀錄，肉眼從逐筆明細裡自己抓「有下注的帳號」很麻煩，後端額外算了一份按 `playerId` 彙整（跨機台加總 Bet Number/Bet），前端顯示成獨立的表格區塊，不用使用者自己從 24 筆明細裡挑。

**⚠️ `gameCount` 的 `sumData` 跟 `items[]` 範圍不一致**（已用真實查詢驗證：查單一天 `total=1`，但 `sumData` 的數字是 `items[0]` 的好幾倍，`sumData` 看起來沒有正確套用日期篩選）——**只查單一天時要用 `items[0]`，不要用 `sumData`**；`playerMachineCount` 的 `sumData` 沒有這個問題，可以直接信任。

**`playerstudioid` 參數**：固定用 `cp,wf,tbr,tbp,ncl,bpo,mdr,dhs,cf,np,pf,igo,np2,ALL` 這組清單（已驗證精準對上後台「Player Channel: np +11」那個預設範圍），`channelId` 平常固定 `873`。**「All」全渠道模式**：已用真實 Network request 截圖確認正確做法是 `channelId=0` + `isall=true`（`playerstudioid` 參數維持不變，不是拿掉）——之前誤以為拿掉 `playerstudioid` 可以模擬「不篩選」，結果 API 直接回空資料，是錯的；現在前端有「All」勾選框，會同時切換 `channelId`/`isall` 兩個參數。

**Game Type 篩選**：下拉選單資料來自 `GET /public/gameNameAlias?channelId=873`（公開端點，不需要登入 token，`server/routes/meter-reconcile.ts` 的 `/api/osm/meter-reconcile/game-types` 直接代理），回應 `{ name, gameTag, id }[]`；查詢時傳的是 `name`（小寫，例如 `risingrockets`），下拉選項顯示的是 `gameTag`（例如 `RISINGROCKETS`）。三支報表 API 都吃同一個 `gameType` 參數。

**已知限制**：三張報表不是同一次登入 session 依序拉的，若查詢時有機台正在被 AutoSpin 持續 Spin，API 呼叫之間的時間差可能導致數字有微小落差，不代表算錯。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 查詢對帳 | 輸入日期 + 查詢範圍（Gaming Day／自然日）+ Game Type 篩選 + All（全渠道）勾選，一鍵拉三支報表比對 |
| 查看判定結果 | 頂部橫幅顯示幾個欄位一致，逐欄位表格標示 ✓/✗ 與差值（含 Jackpot Amount）|
| 查看有下注的帳號 | 按 UserId 彙整（跨機台加總），不用自己從逐筆明細裡挑 |
| 查看 User Detail 逐筆明細 | 可展開查看每一筆 player+machine 紀錄，標示哪些被排除在 Total Bet User 計數外 |

---
