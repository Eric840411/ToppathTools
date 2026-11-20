## 35. 版本驗證表（v5.92.0）

> Eric 2026-11-20 定案方案 B：取代 Lark「驗證表單_v2」（`JjLosMhsShlrfatriEBlX3d7gLd` / `1Xp7sf`），**工具就是主檔**，Lark 表只在第一次匯入時讀（同 33）。
> 規格 v2：osm-qa-agent `reports/spec-verify-form-1120.md`（CodeX r1 四點已併入）。版面 CodeX 出圖、Eric 同意。
> 流程：填驗證項目 → 綁版本紀錄 → 標記已上正式 → 使用者按按鈕開 Meegle 單（用自己綁定的帳號）→ OSM QA agent 拉事件學習。

### 位置
OSM Tools → **版本驗證表**（修仙版：驗證卷錄）。頁面 key `osm-verify`。

### 資料模型（`server/osm-verify-store.ts`，前綴 `osm_verify_`）
| 表 | 內容 |
|---|---|
| `osm_verify_batches` | id＝UUID；顯示名稱＝年份＋批次（`2026-1120`，帶年份避免跨年覆寫，沒刪的批次名稱唯一）；**發布狀態**（填寫中／驗證完成／已上正式）與**學習狀態**（未開始／學習中／已完成／失敗）分開；正式版本快照；rev；軟刪除；`source_key`（匯入冪等） |
| `osm_verify_batch_releases` | 批次 ↔ `osm_releases`，存綁定當下的 release rev（標上正式時刷成當下的） |
| `osm_verify_items` | 平台、類型、描述、驗證環境、結果、OK 數量、驗證人、附件、備註、rev、deleted |
| `osm_verify_tickets` | item、`idempotency_key`（**DB 唯一**）、狀態 pending／created／unknown／failed、空間、類型、單名、Meegle 單號、開單人、開單時的 Meegle 綁定 rev |
| `osm_verify_revisions` | 完整快照履歷（批次與項目的新增／修改／刪除、綁定、上正式、上正式後修訂、匯入） |
| `osm_verify_events` | 持久事件佇列：遞增 seq（游標）、event id（UUID）、batch_id、type、事件當下的 batch rev、payload 快照、送出／ack 時間 |

`settings` 表另外兩個 key：`osm_verify_platform_map`（平台對應）、`osm_verify_event_key_hash`（事件 API 金鑰的 sha256）。

### 規則（`shared/osm-verify-rules.ts`，前後端共用一份）
- **上正式檢查**（`releaseCheck`）：至少一筆有效（沒被刪）的綁定版本紀錄、至少一個項目、每個項目都填了平台、每個平台都有綁定的版本紀錄涵蓋。
  涵蓋＝管理設定的「平台對應」（`H5 = osm/H5 Client`：分頁 id，或「分頁/元件」且該元件有更新）；沒設對應時**只認完全同名**（分頁 id／名稱、有更新的元件名稱），不做模糊比對——寬鬆比對會把沒涵蓋的平台當成有
- 後端 `markReleased` 再驗一次（按鈕停用不算防護）；已上正式不能退回、不能刪批次；至少要留一筆有效綁定
- **被綁定的版本紀錄不能刪**：osm-releases 刪除路由先問 `releaseDeleteBlocker`（409 列出批次），DB 另有 trigger `trg_osm_verify_release_ref` 擋住任何把它標成刪除的寫入
- 已上正式的批次再改（批次、項目、綁定）→ 批次 rev +1、記 `batch.revised` 事件

### 開單（按下即送出、不確認；勾選多列逐列獨立回報）
- 空間：非管理員固定正式、不顯示切換；測試空間只給管理員（沿用 `canUseSpace`）
- **類型可選**：`workitem meta-types` 列出空間的工作項類型；選了之後讀該類型的 `meta-create-fields` 重新判斷必填（`server/osm-verify-meegle.ts`）。
  支援的必填：文字／數字（text）、單選（select，選項逐欄讀）、關聯需求（`field_eab776`，選項＝空間的需求）、其他關聯單（填單號）。
  角色、人員、日期等必填 → 列為「不支援」、這個類型不能從這裡開，不猜預設值
- **模板**：Meegle 的 `template`（任務流程）。預設任務項類型沿用「已驗證可省略」（實開會自動帶一般流程），不出下拉；其他類型只有模板是建立必填時才出下拉（選項來自 meta-fields）。⚠️ 非任務項類型送模板 option_id 的格式**沒有實開驗證過**
- 開單設定（空間／類型／欄位值）記在瀏覽器 localStorage（個人上次選擇）；送出時後端用**最新的**欄位設定再驗一次（`resolveCreateValues` 前後端同一份）
- 單名＝`[類型][平台]描述第一行`（跟 Lark 表摘要公式一樣）；描述帶項目內容，**最後一行是 `[osm-verify-key] OSMV-…`**
- **冪等**：送出前在 IMMEDIATE transaction 原子搶占（`claimTicket`），key＝`OSMV-<批次 id 前 8 碼>-<項目 id>-<第幾張>`，DB 唯一約束擋同一把 key 的第二個請求
  - 逾時／503／看不懂／成功但沒單號 → `unknown`；pending 超過 5 分鐘（伺服器中途重啟）也轉 unknown
  - unknown 的列下方展開提示列：**到遠端查**（同空間同類型同名、描述含這把 key 的單；唯一一張 → 已開單，查無／多張 → 仍 unknown，**不自動重送**）、**確認重送**（沿用同一把 key）、**再開一張**（新 key）
  - 開單失敗（`retriable=false`）的列按「重試」也沿用同一把 key
  - 沿用同一把 key 的重送**只能由原開單人、而且 Meegle 綁定沒換過**（綁定 rev 相同），空間／類型也要跟第一次一樣；不然用「再開一張」
- token：只在 `routes/osm-verify.ts` 的 `binding()` 解密、只交給 CLI；回應不帶 token、綁定 rev、開單人 email

### 學習事件（首版只 pull）
- `GET /api/osm-verify/events?cursor=&limit=`、`POST /api/osm-verify/events/:id/ack { batchRev }`
- **只收服務憑證** `Authorization: Bearer <金鑰>`，登入 session 不算；列在 `server/public-routes.ts`（osm-qa-agent 的 `scripts/verify-form/pull-events.cjs` 在打）
- 金鑰：管理設定「產生／重新產生」，明文只在那次回應出現，DB 只存 sha256；重新產生後舊金鑰立即失效
- 回應：`{ ok, events:[{ id, type, batchId, batchRev, createdAt, payload }], nextCursor }`；沒有更多時 `nextCursor` 回原游標
- 事件：`batch.released`／`batch.revised` payload `{ batchName, prodVersion, releases:[{id,rev}], items:[{ id, platform, type, description, env, result, okCount, verifier, tickets:[單號] }] }`；
  `batch.ticket_created`（上正式後才開的單）payload `{ itemId, ticket }`
- ack：`batchRev` 要等於**事件產生當下**的 batch rev（不是批次現在的——agent 依序 ack 舊事件，比現在的會永遠卡在第一個）；不符 409、重複 ack 冪等 ok、找不到 404
- 學習狀態由事件推：有沒 ack 的事件 → 未開始（還沒被拉）／學習中（拉過）；全部 ack → 已完成；**舊事件 ack 了、新修訂還沒 → 不會變成已完成**。「失敗」目前沒有來源（agent 契約沒有回報失敗），保留給之後

### 權限（三層，後端每支 API 都驗；權限不足的按鈕直接不渲染）
| key | 能做什麼 |
|---|---|
| `osm-verify` | 查看 |
| `osm-verify-edit` | 新增／編輯批次與項目、綁定／解除版本紀錄、開單（到遠端查／確認重送／再開一張） |
| `osm-verify-manage` | 標記已上正式、刪除批次與項目、從 Lark 匯入、管理設定（平台對應、事件 API 金鑰） |

編輯／管理都隱含查看（側欄 `canAccess` 與後端 `need()` 同一個判斷）。管理員一律全開。

### 使用者可執行的操作
- 批次清單：顯示名稱、發布狀態、學習狀態、綁定版本紀錄數、驗證項目數、正式版本快照；點一列選批次
- 標題列：修改履歷（每一版誰、何時、做了什麼，可展開快照）／編輯批次（年份、批次、發布狀態、正式版本快照；管理者可刪除未上正式的批次）／標記已上正式（檢查沒過停用）
- 上正式檢查卡：列出缺的版本綁定、已被刪的綁定、沒填平台的項目、未涵蓋的平台；已綁的版本紀錄可解除、被改過會標「綁定後被改過」；「綁定版本紀錄」開清單搜尋綁定
- 驗證項目表：新增／編輯（別人先存了回 409 並重讀）／刪除（管理；開單中或結果不明的不能刪）；勾選列開單；逐列開單／重試／再開一張；單號可點開 Meegle
- 開單設定：在工具列下展開，選空間（管理員）、類型、該類型的必填欄位
- 頁首：新增批次（編輯）、匯入（管理）、管理設定（管理）

### Lark 匯入（`server/osm-verify-import.ts`，只讀）
- 表的形狀（1120 唯讀查看）：一張表好幾段，每段一列表頭（日期／類別／主題／版本／描述／圖／確認OK／進度／備註／Meegle 單號／環境）；
  「版本」表頭格第 2 行起是當時正式版本 → 正式版本快照；「LL版本」這種帶前綴的段落 → 批次名稱加 `-LL`；
  日期（Excel 序號）只寫在每組第一列；底下大量空列與公式殘留（`IF(…)`）略過
- 一段＝一個批次，名稱用該段第一個日期；沒有日期的段落略過並列出原因
- 欄位：類別→平台、主題→類型、確認 OK→OK 數量、進度→結果、填寫人→驗證人、環境→驗證環境；列上的「版本」放進備註第一行（項目沒有版本欄，不能丟）；
  圖：API 只給 `{id,type:'attachment'}` 拿不到檔案 → 附件寫「Lark 附件 N 個（未搬移檔案）」；Meegle 單號 `#16468199` → 匯成已開單
- 冪等：批次 `source_key`＝表:頁:h表頭列、項目＝表:頁:列號、單號 key＝`import:<項目 source_key>`；重跑只補沒匯過的
- 預設讀 `JjLosMhsShlrfatriEBlX3d7gLd` / `1Xp7sf`；**不寫回 Lark**

### 測試
`npx tsx server/osm-verify.test.ts`（89 條，記憶體 DB＋假 Meegle CLI＋真 HTTP，fixture 全是合成的）：規則、冪等 key 唯一搶占、unknown 不自動重送、別人／換過綁定不能沿用 key、上正式必須綁版本與涵蓋、被引用的版本紀錄不能刪（檢查＋trigger）、樂觀鎖 409、事件游標分頁、重複 ack 冪等、ack rev 不符 409、舊事件不會把新版標成已完成、事件 API 無／錯憑證／只有 session 都 401、重新產生金鑰舊的失效、token／綁定 rev／開單人 email 不出現在任何回應或操作紀錄、Lark 匯入冪等；
另外直接 require osm-qa-agent 的 `pull-events.cjs`（資料目錄指到暫存）對測試伺服器跑：逐頁拉完、全部 ack、產出草稿、再跑游標接著。

突變（`.scratch-verify/mutate.mjs`，不 commit）17 種都紅在斷言上：拿掉 key UNIQUE、unknown 當 failed 重送、查無就改回可重送、上正式不檢查、刪除前檢查放行、拿掉 trigger、游標改 `>=`、重複 ack 回衝突、ack 不比 rev、ack 改比批次現在的 rev、拿掉批次樂觀鎖、舊事件 ack 就標已完成、事件 API 不驗憑證、事件 API 改收 session、錯誤訊息夾帶 token、回應帶綁定 rev、別人可沿用 key 重送。

### 沒做／待確認
- Meegle 真空間沒有實開過（只用 fixture＋假 CLI）；非任務項類型的必填欄位判斷、模板 option_id 格式、MQL 讀 `description` 的回傳形狀都沒實測
- 版面只做了型別檢查與建置，沒有在瀏覽器實看
- 附件只存文字（連結），沒有上傳檔案
