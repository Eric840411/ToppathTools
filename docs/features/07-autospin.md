# AutoSpin

> 這份是 `CLAUDE.md` 的 Product Features 章節拆出來的。維護規則不變：功能有新增或修改，要同步更新這裡。

---

## 7. OSM Tools — AutoSpin（AutoSpinPage）

**路由**：`/api/autospin/*`｜**歷史紀錄 feature key**：`autospin`

### 功能說明
管理 AutoSpin 自動旋轉。執行採 **agent-hub 派工模式（A2）**：在「執行監控」選擇線上 agent（與機測/腳本化投注同一批 agent-runner，含 macOS），agent 端在本機 spawn 既有的 Python 引擎（`server/python/toppath-agent.py`，cv2 模板比對引擎不變），log/截圖/狀態透過既有 REST/SSE 回報。公網（Spug）上 server 不需跑瀏覽器/OpenCV，重活都在 agent 端。伺服器端 `spawn` 模式保留為 fallback。

**多機台改成多進程（每台機台一個獨立 process），不再是單一迴圈輪流跑（2026-07-30）**：Playwright **sync API** 官方明文只支援單執行緒操作，原本一支 agent process 裡所有機台共用同一個 browser/context，靠 `while True: for mp in machine_pages: ...` 單一迴圈輪流服務每台機台——`do_spin()` 內的 Playwright 呼叫是阻塞式的，機台越多，每台實際被輪到 Spin 的頻率越低，且任一台卡住/逾時（最長到 8 秒）會拖慢所有其他台，完全不是平行執行，只是瀏覽器視窗都開著、看起來「活著」而已。改成 `machine_worker(session_id, server_url, user_label, cfg, keyword_actions, machine_actions)`：每台機台在自己獨立的 process 裡跑一份完整的 `sync_playwright()` + browser + context + page + Spin 迴圈，一台掛掉/卡住不會影響其他台。`main()`（parent process）只負責向伺服器登錄一次拿到共用的 `session_id`，然後對每台啟用的機台各自 `multiprocessing.Process(target=machine_worker, ...)`，最後 `.join()` 等全部結束才呼叫 `send_stopped()`（session 層級動作，絕不能讓某一台提前結束就誤觸發，會連帶把還在跑的其他台一起標記成已停止並結束 Discord 通知）。**每台間隔 2 秒分批啟動**（`STAGGER_START_SEC`），不是全部 `.start()` 一次全開——同時開好幾個 Chromium 是資源尖峰，容易讓效能較弱的裝置卡住。

**停止/暫停完全不需要跨 process 通訊**：每個 child process 各自獨立的 `poll_stop()` 執行緒輪詢同一個 `session_id` 的 `/should-stop` 端點，伺服器端一聲令下、所有 process 各自在下一次心跳（≤3 秒）內收斂，不需要 parent 特地轉發訊號給 child——`parent` 只在收到 SIGINT/SIGTERM（例如 agent-runner.ts 直接砍掉 parent process）時，才需要主動呼叫每個 `multiprocessing.Process.terminate()`（送出 SIGTERM），觸發各 child 自己的訊號處理常式優雅關閉瀏覽器，避免留下孤兒瀏覽器行程。

**module-level 全域變數改成「parent 登錄一次、child 各自賦值」的模式**：`session_id`/`server_url`/`user_label`/`keyword_actions`/`machine_actions` 這幾個原本在整份 script 頂層執行一次就固定的變數，改成在 `machine_worker()` 一開始用 `global` 賦值——因為 multiprocessing 在 Windows／macOS 預設都是 `spawn` 模式（不是 `fork`），child process 是重新 import 整份模組、不是複製記憶體，所以頂層一次性的註冊/登錄 HTTP 呼叫必須包在 `if __name__ == "__main__":` 底下的 `main()`，否則每個 child 重新 import 時會各自再打一次 `/agent/start`、各自建立新 session，互相蓋掉。`button_health`/`osm_status_cache`/`spin_interval_override` 等其餘 module-level 狀態不用特別處理，`spawn` 重新 import 本來就會讓每個 child 拿到全新、互相獨立的一份，天然達到隔離效果。

**已修正（2026-07-30）：`poll_stop()` 的「session 遺失後自動重新登錄」fallback 在多進程架構下會卡死**——伺服器重啟後所有 child process 各自獨立偵測、各自獨立打 `/api/autospin/agent/start` 重連，第一個成功的會拿到新 session、佔走這個操作者（`taskUser(req)`，Agent 端固定是 IP-based 的 `guest`）的 heavy-task 名額，緊接著幾乎同時打進來的其他 child 只會看到「已被佔用」而失敗——Python 端 `new_data['sessionId']` 因為衝突回應沒有這個欄位而拋出 `KeyError: 'sessionId'`，永遠卡在「重連失敗，將在下次輪詢重試」（每 3 秒重試一次，但每次都撞同一個衝突，跟原本單一 process 架構下不會發生的邊界案例不同，這裡是每次伺服器重啟都會真的發生）。修法：`/api/autospin/agent/start` 偵測到 heavy-task 衝突時，先檢查衝突對象是不是同一種 `autospin-agent` 任務、而且已經有一個屬於同一個 `userLabel` 的 running session（就是剛剛搶到名額的那個 child 建立的）——如果是，直接讓這個 child 加入既有 session（回傳同一個 `sessionId`），不再擋下來；同時這個「加入既有 session」的路徑不會重新對每台機台發送「排隊中」Discord 通知（`isNewSession` 旗標控制），避免把已經在跑的機台狀態誤蓋回排隊中。

**再修正（2026-07-31）：`taskUser(req)` 的 IP fallback 會讓不同帳號的 Local Agent 互相誤判成同一個操作者**——上面 v3.79.3 那版修的是「同一個帳號、同一個 session 底下多個 child process 重連」的衝突；但 `server/heavy-task-guard.ts` 的 `taskUser(req)` 本身對 Python agent 這種無 cookie/無 `x-jira-email` 的請求，先前只認 `req.body.account`/`req.body.jiraEmail`（AutoSpin agent 實際送的 body 是 `{userLabel}`，兩者都對不上），最終一定 fallback 到 `req.ip`。真實案例：使用者 A 的 Local Agent 啟動裝置 A 順利執行，使用者 B 的 Local Agent 要啟動裝置 B 卻連線失敗——因為 A、B 兩台 Local Agent 剛好在同一個辦公室網路後面（對外是同一個 IP），heavy-task-guard 把兩個不同帳號當成同一個操作者，B 的註冊被 A 的重任務鎖擋下（`heavyTask.ok=false`），且衝突對象的 `userLabel` 是 A 不是 B，v3.79.3 的「加入既有 session」判斷也對不上，一樣落入 429 衝突分支。修法：`taskUser(req)` 的 fallback chain 補上 `req.body.userLabel` 與 `x-user-label` header（IP 之前），AutoSpin agent 本來就會送 `userLabel`，直接用它辨識帳號，不會再跟其他帳號的 IP 衝突。**同時修正 Python 引擎的錯誤處理**：`main()` 收到伺服器回應後先檢查 `data.get('ok')`，衝突時印出伺服器實際給的 `message`（例如「你目前已有重任務正在執行：...」），不再是無助於除錯的 `KeyError: 'sessionId'`。

**每台機台心跳機制 + 斷線自動重連（2026-08-03，v3.81.0）**：多進程架構下，一台機台的 process 卡死（例如瀏覽器已無回應但 process 本身沒死）或直接終止（真的 crash），先前完全沒有偵測/復原機制——長時間執行下，一旦某台掛掉，剩下的機台繼續正常跑，但那台的紀錄從此不再更新，且不會自動恢復，只能整個 Agent 重啟才會重新拉起全部機台。新增機制：
- `machine_worker()` 新增 `heartbeats` 參數（`multiprocessing.Manager().dict()`，parent 建立後傳給每個 child）——主 Spin 迴圈**每次迭代開頭**（含暫停中）都寫入 `heartbeats[machineType] = time.time()`。一般 dict/全域變數在不同 process 之間不會同步，必須透過 Manager 的 proxy 物件。
- **`wait_for_normal_osm_status()` 內部也要持續寫入心跳**：這個函式處理特殊遊戲（FG/JP）時內部有自己的 while 迴圈，最長可以合法跑到 15 分鐘（+ cooldown 10 秒），比外層迴圈一次迭代正常耗時長非常多——如果只在外層迴圈開頭寫心跳，機台正常等待特殊遊戲結束時會被誤判成「心跳過期＝卡死」而被錯誤重啟，所以這個函式也接收 `heartbeats` 參數，兩個內部 while 迴圈的每次 `time.sleep(1.0)` 之後都補寫一次。
- `main()`（parent）新增監控迴圈：每 20 秒（`MONITOR_INTERVAL_SEC`）巡一次所有機台，判斷 `proc.is_alive()` 是否為 False（process 已終止）或心跳是否超過 120 秒（`HEARTBEAT_STALE_SEC`）沒更新（process 活著但卡死）——符合任一條件就 `terminate()` 舊 process（如果還活著）、重置該台心跳、`spawn_machine(mt)` 重新啟動一份全新的獨立 process，沿用同一個 `session_id`。**心跳從未寫入過（`hb == 0`）的機台不會被重啟**——這代表機台在進入主迴圈前就結束了（沒設定 Game URL、或無法進入遊戲），是設定問題不是斷線，重啟也沒用。每台機台**最多自動重啟 5 次**（`MAX_RESTARTS_PER_MACHINE`），超過上限就不再嘗試、印警告訊息，避免真的壞掉的機台無限重啟造成資源浪費。
- **parent 自己也獨立輪詢 `/should-stop`**（跟每個 child 各自的 `poll_stop()` 是分開的兩份輪詢），讓 parent 能自行判斷「整個 session 該停了」——監控迴圈只在 `global_stop` 未設定時才會嘗試重啟，避免使用者按下「停止」、機台正常結束關閉的過程中，被監控迴圈誤判成異常又重新拉起來。

**AutoSpin agent session 持久化到 DB（2026-08-03，v3.82.0）**：`agentSessions`（`server/routes/autospin.ts`）先前完全只存在 worker process 的記憶體裡，worker 一重啟（部署新代碼的日常操作，光是這一天就重啟了 6 次）就整批消失，正在跑的 session 每次都得依賴 Python 端「偵測 session 遺失 → 重連」這條有風險的路徑才能恢復。新增 `autospin_agent_sessions` 表（`server/shared.ts`），每 5 秒把目前所有 session 的快照（`id`/`status`/`startedAt`/`lastHeartbeat`/`stopRequested`/`pauseRequested`/`userLabel`/`spinIntervalOverride`/`heavyTask`/LuckyLink 相關欄位——**不含** `logs`/`screenshots`，那兩個純粹是即時檢視用的記憶體 buffer，重啟遺失也沒差，真正重要的歷史/截圖資料本來就各自獨立寫進 DB/磁碟）寫進這張表；`autospin.ts` 模組載入時（也就是 worker 每次啟動時）優先從這張表復原進 `agentSessions`，不再需要仰賴重連。復原後沿用既有的 `/agent/status` 30 秒心跳逾時自動過期邏輯判斷是真的還在跑還是已經死了，不需要重複一套 staleness 判斷。快照寫入時同時 diff 掉記憶體裡已經不存在（被既有 2 小時 SESSION_GC 清掉）的 session，DB 裡不會累積殭屍資料。**這個修法有直接用假資料驗證過**：停掉 worker、手動塞一筆 `autospin_agent_sessions` row、重啟 worker，`/api/autospin/agent/status`（帶對應 `x-user-label`）正確回報 `running: true` 且拿到同一個 `sessionId`。

**重任務鎖（`activeTasks`）同步復原（同一批 v3.82.0）**：`server/heavy-task-guard.ts` 的 `activeTasks` Map 也是純記憶體，如果只修 `agentSessions` 持久化，會出現「session 復原了、但保護它的重任務鎖卻在 worker 重啟時消失」的縫隙，讓同一個操作者理論上能在 session 復原的同時又啟動第二個衝突的重任務。修法：`heavy-task-guard.ts` 模組載入時，從既有的 `heavy_tasks` 表（本來就會持續寫入，只是先前只當成稽核記錄用，`tryStartHeavyTask()` 的實際衝突判斷完全只看記憶體）讀出 `status = 'running'` 的 row 回填進 `activeTasks`。超過 24 小時還是 `'running'` 的 row 視為真的異常結束（process 死掉、從沒機會呼叫 `finishHeavyTask()`），標記成 `error` 收尾，不永久佔住操作者的名額——長時間任務（AutoSpin/Machine Test/OSM UAT）本來就可能跑好幾小時，24 小時是留足夠寬裕的容錯空間。

**斷線重連訊息改寫本機檔案（同一批 v3.82.0）**：`poll_stop()`（child 用）偵測到 `sessionNotFound` 時的「嘗試重新連線」/「重連失敗」訊息，先前只用 `print()` 印終端機——這類訊息發生當下 `session_id` 本來就是無效的（連線問題本身就是原因），用 `log()` 送到伺服器一定被 404 吞掉，網頁「執行日誌」面板永遠看不到失敗訊息；終端機視窗又常被多台機台持續產生的日誌洗版蓋過去，長時間跑下來肉眼很難在終端機裡找到特定一次的重連事件（實際案例：使用者反應偵測到重連訊息但找不到後續是成功還是失敗）。新增 `local_log(msg)`：印 console 的同時額外寫進固定檔案 `server/python/agent-reconnect.log`（跟 `toppath-agent.py` 同目錄），不受終端機捲動緩衝區限制，之後可以直接開檔案搜尋確認。「重新連線成功」那行原本就有額外呼叫 `log()`（因為那個當下 `session_id` 已經是新的有效值），這個維持不變，只是額外也寫進本機檔案方便一次搜尋到完整前後脈絡。

進入機台流程（entryTouchPoints/entryTouchPoints2 兩階段進入觸屏 + enterGMNtc 確認）與 Spin 點擊/餘額讀取（pinus WebSocket 攔截，非 DOM selector）皆與 `server/machine-test/runner.ts` 同步；`entryTouchPoints`/`entryTouchPoints2`/`spinSelector`/`balanceSelector`/`bonusAction`/`touchPoints`/`clickTake`/`ideckXpaths` 讀取自 `machine_test_profiles` 表（`ideckXpaths` 對應 DB 欄位是 snake_case 的 `ideck_xpaths`），由 `/api/autospin/agent/start` 合併進 configs 回傳給 Python 引擎。**對應 key 不是用 AutoSpin 自己的 `machineType`**（使用者手打、格式不受控，容易對不上）**，而是取 `gameTitleCode` 的中段**（例如 `"873-DFDC-0003"` 取 `"DFDC"`，跟 `machine_test_profiles.machineType` 的命名慣例一致），`gameTitleCode` 格式不對時才 fallback 回 `machineType`（`profileKeyFor()` 函式）。元素比對的是疊在畫面上、看不到的 `<span>` 觸控層文字（不是視覺上看到的按鈕文字），格式為「數字,數字」。Spin 按鈕若被上層元素（選面額面板、宣傳彈窗等）攔截點擊，改用 JS `el.click()` 直接觸發下層按鈕，不用真實滑鼠座標硬點。另有 pinus 訊息監控（攔截 `window.pinus.request`/`.on` 所有 request/response/push，非僅 coin 欄位）與瀏覽器 console.warn/console.error 攔截（WebSocket 斷線、遊戲端原生報錯），每台機每 2 秒批次轉發到執行日誌，前綴分別為 `[pinus:xxx]`/`[console:warn]`/`[console:error]`；所有回報用的網路呼叫（進度回報/截圖上傳/Lark 推播/日誌上傳）皆為背景執行緒非同步，不會卡住主 Spin 迴圈。

**pinus 監控補丁改成打在 prototype 上，不再跟遊戲賽時機（2026-08-07，v3.90.14）**：center update（熱更新切換 connector）或斷線重連時，遊戲會建立一個全新的 `window.pinus` 物件（`Object.create(EventEmitter.prototype)`，已用使用者 DevTools 截圖證實），舊物件上打的補丁對新物件完全無效。早期版本（v3.90.1→v3.90.12）一路嘗試「補丁生效前就註冊好的監聽器永遠不會被追溯包裝」這個問題，手法從固定輪詢（200ms）逐步收緊成 WS open 事件觸發＋30ms 輪詢，本質上都是在跟遊戲的同步初始化程式碼賽跑（如果遊戲是「建立新 pinus 物件 → 同一個 tick 內就同步呼叫 `.on('moneyNtc', ...)`」，任何非同步的事件驅動/輪詢天生就贏不了），實測已確認 v3.90.12 版本仍會在熱更新那一刻起永久漏接 `moneyNtc`（`do_spin()` 的訊號②完成判定連帶失效，RISINGROCKETS 這類天生用不上訊號①的機種會固定卡滿 8 秒 `timeout_8s`）。**v3.90.14 改用 `patchMethod()`**：沿 prototype chain 往上找到「實際定義 `.on()`/`.request()` 這個方法的物件」，直接補在那裡而不是補在 instance 上——`.on()` 幾乎必然定義在 `EventEmitter.prototype` 上（EventEmitter 模式通例，不會每個 instance 各自覆寫一份），只要成功補丁過一次就永久生效，之後所有共用同一個 prototype 的新 instance（包含尚未發生的下一次重連）自動繼承補丁版本，徹底消除時機賽跑，不需要再猜「哪個事件點更早」。`.request()` 若在這個遊戲是 instance-level 方法（跟 reqId 計數器等狀態綁在一起，每次 connect() 重新賦值），`patchMethod()` 會 fallback 補在 instance 上，維持原本「靠輪詢/WS事件每次重連後重新補一次」的行為——風險較低，因為 `request()` 是「發送後等回應」，沒有 `.on()` 這種「先註冊、可能永遠不會再呼叫第二次」的一次性視窗問題。

**特殊遊戲偵測（OSMWatcher + bonusAction）**：只讀取 Machine Test 現成維護的 `osmMachineStatus` map（`server/routes/machine-test.ts` export，未修改該檔案本身），透過 `/api/autospin/agent/:id/should-stop` 心跳（每 3 秒）把整個狀態 map 一起帶給 Python 引擎快取。行為對齊 Machine Test 的 `checkOsm`/`waitForNormalStatus`：偵測到特殊狀態（FG/JP，status 1/2/3/4/5/8）時執行機種設定檔的 `bonusAction`（spin/takewin/touchscreen/auto_wait，讀自 `machine_test_profiles`，由 `/agent/start` 合併進 configs）一次，之後持續 Spin 直到狀態恢復（或 15 分鐘逾時），恢復後再 10 秒 cooldown spin；status=9（Handpay）只記錄不處理，需人工介入。**相容 fallback**：完全沒有 OSMWatcher 資料時（該機台從未出現在 `osmMachineStatus` 裡），改用連續 10 次 Spin 前後餘額都相同來推測進入特殊遊戲，觸發時執行一次 `bonusAction`（不做等待迴圈，執行完就重置計數繼續正常 Spin）。

**Spin 前後餘額記錄**：`do_spin()` 現在回傳 `(balance_before, balance_after, rejected)`（失敗回傳 `None`），每次有變化或每 10 次 Spin 會記錄一行輸贏差額到執行日誌；目前只寫日誌，未存進 `autospin_history` 資料庫欄位（該表目前只有單一 `balance` 欄位，沒有 before/after 配對欄位）。`rejected` 代表這次 Spin 的 pinus `dealGMActionReq` 請求被遊戲伺服器直接拒絕（例如 errcode:100「請求超時或未確認錯誤」）——這種情況下 spin 動作根本沒在伺服器端執行，按鈕 disabled 切換／coin 更新兩個完成訊號都不會觸發，`do_spin()` 靠監控腳本追蹤 `window.__lastSpinErr`（`dealGMActionReq` 回應 errcode≠0 時寫入）立即中斷等待並記錄真正原因，不會再傻等滿 8 秒被誤標成 `timeout_8s`；main loop 也不會把這種「餘額沒變」計入連續無變化次數，避免誤判成特殊遊戲亂觸發 `bonusAction`。

**選面額遮罩（`.select-main`）攔截 Spin 點擊**：這種遮罩點擊時不會拋例外（跟「上層元素攔截點擊拋 intercepts pointer events」不同），遊戲只是完全收不到 Spin 動作，靠例外處理的 JS 強制點擊 fallback不會被觸發，會固定卡滿 8 秒判定 timeout_8s。`dismiss_denom_overlay(page, mt)` 完整移植自 `machine-test/runner.ts` 的 `dismissDenomOverlay()`：偵測 `.select-main .select-btn, .select-main .my-button`，找到就點第一個選項（JS 強制 click）。`do_spin()` 一開始就會呼叫，不只在剛進場時才處理——Bet Change/Cashout 等操作之後這個遮罩也可能重新彈出蓋住 Spin。

**Jackpot 中獎通知彈窗（`.notification-close`）自動關閉（2026-08-07）**：跟選面額遮罩同一類問題——「WIN THE JACKPOT」中獎通知彈窗（顯示中獎機台/帳號資訊）會蓋住畫面含 Spin 按鈕，且不是只在特定時機出現，任何時候都可能彈出。`dismiss_jackpot_notification(page, mt)` 偵測 `.notification-close` 關閉鈕，找到就點擊（JS 強制 click）。`do_spin()` 每次呼叫都會執行，跟 `dismiss_denom_overlay()` 呼叫順序相鄰。目前只加在 AutoSpin，Machine Test 的 Spin 測試步驟較短暫（一次只點 3 下）未同步加入，之後若真的遇到才補。

**觸屏點擊 `wait_for_span_text()` 不檢查可見性**：觸屏測試用的 `.screen-touch` 疊加層 `<span>` 是完全透明的，Playwright 的 `is_visible()` 對這種 span 一律回傳 `False`——`machine-test/runner.ts` 的 `waitForSpanText()` 早就針對這點只檢查元素存在（`count() > 0`），AutoSpin 的 Python 版本需要保持同步做法，不能加可見性檢查，否則 entryTouchPoints/entryTouchPoints2/bonusAction=touchscreen 的座標點會全部誤判成「找不到元素」。

**QAT/PROD 日誌 API（daily-analysis）同步**：機台設定新增 `logApiEnv`（`'qat'`/`'prod'`，預設 `qat`）欄位，AutoSpin 執行中每台機每 5 秒背景輪詢一次 `https://{qat|prod}-osmtrace.osmslot.org/api/machine/daily-analysis?gmid=<gameTitleCode>&date=YYYY-MM-DD`（跟 Machine Test 的 `pollMachineLog()` 同一支 API），把「上次輪詢之後」新出現的 timeline 紀錄印到執行日誌（`[machineType][daily-analysis] 時間 type 內容`）。第一次輪詢只記錄基準時間、不印歷史紀錄，避免整批倒灌洗版；跨日時基準時間自動重置。輪詢本身用 `async_call()` 丟到背景執行緒，不會卡住主 Spin 迴圈。查詢失敗（網路不通/逾時/非 200）不會整個吞掉不出聲，每 60 秒印一次警告。

**按鈕健康度追蹤（`track_button_health()`）**：daily-analysis 的 `success_json` 事件是「按鈕指令有沒有被硬體/遊戲端正確處理」的確認事件（跟 Machine Test iDeck 測試步驟用的 `getIdeckTimes()` 判斷邏輯同一套語意），關鍵欄位：`error`（0=正常，非 0=真的異常）、`cmd`（十六進位字串=iDeck 按鈕，座標字串如 `"19,38"`=觸屏）、`is_ideck`/`is_touch`（分類）。不逐行印每個 success_json（會洗版），改成維護滾動計數：`error != 0` 立即印一行醒目警告（附 `cmd` 方便定位是哪顆按鈕），每累積 `BUTTON_SUMMARY_EVERY`（20）次按鈕確認事件印一次摘要（`iDeck X/Y 正常，觸屏 X/Y 正常`）。純資料來自既有的 daily-analysis 輪詢，沒有額外打 API。

> `SPECIAL_GAMES = {'BULLBLITZ', 'ALLABOARD'}` 與 `machine_actions`（`toppath-agent.py`）目前仍是未串接的殘留變數——按鈕尋找已經靠 `SPIN_SELECTORS_DEFAULT` 的 fallback chain（含 `.btn_spin .my-button` 這個專門給這類特殊按鈕結構用的 selector）涵蓋，`machine_actions`（machine-test 風格座標點擊）尚未實作，待後續確認範圍。

**隨機下注（BetRandom）XPath 改成完全共用 machine_test_profiles.ideck_xpaths（2026-07-30）**：`machine_test_profiles.ideck_xpaths` 這個欄位當初設計就是要取代獨立的隨機下注機制（`machine-test/types.ts` 型別註解直接寫「replaces ideckRowClass + betRandomConfig」），但先前從未真的接上 AutoSpin——AutoSpin 派工（`/api/autospin/agent/start`）過去是讀完全獨立的 `bet_random.json` 檔案（配有專屬「隨機下注」頁面管理），跟 Machine Test 的 iDeck XPath 設定是兩份互不相關的資料。已完成整合：AutoSpin 的 SQL 查詢加入 `ideck_xpaths`，跟 spinSelector/touchPoints 等欄位一樣用 `profileKeyFor()` 合併進每台機台的 config（`cfg.ideckXpaths`），`toppath-agent.py` 的 `execute_bet_random()` 改成直接吃這個已合併好的清單，不再需要自己比對 game_title_code。獨立的 `bet_random.json`、對應的 `GET/PUT /api/autospin/bet-random` 端點、以及 AutoSpin 頁面的「隨機下注」Tab 已全部移除；機台設定表格上的「隨機下注」欄位保留（純開關），滑鼠移上去有提示文字說明 XPath 改到「機台自動化測試」的機種設定檔配置。**遷移時已將舊 `bet_random.json` 裡的資料一次性搬進 `machine_test_profiles.ideck_xpaths`**（沒有對應機種的新建、已有資料但是空的補齊、已有資料且不同的保留原樣不覆蓋），確認沒有 XPath 因此遺失。

**定時彙總報告（長時間穩定性統計，v3.74.0）**：跟按鈕健康度追蹤同一批被動資料源，不主動點按鈕、不影響主 Spin 迴圈節奏。追蹤五類指標：
- **errcode 次數**：`dealGMActionReq` pinus 回應的 `errcode` 滾動計數（`window.__spinErrCounts`），可對照 err5/err29 等錯誤碼表判斷是否異常。
- **RECOVER（斷線重連）次數**：`PatchedWS` 監聽 WebSocket open/close 事件累計（`window.__wsRecoverCount`）。
- **kickout 次數**：既有的低餘額自動離機→重進機台流程，新增計數器（`mp['kickout_count']`）。
- **CR checks / 無回應**：沿用 `track_button_health()` 的被動事件，新增 `no_response` 判定——`CR_NO_RESPONSE_TIMEOUT`（60 秒）內沒有任何 daily-analysis 按鈕確認事件即視為異常（`check_cr_gap()`），沒有 response 也算問題。
- **Spin/中獎/總贏分**：`mp['ok_spin_count']`/`win_count`/`total_win`，跟既有 Spin 結果判斷邏輯同步累計。

`maybe_send_status_report(mp, page)`（main-thread，會 `page.evaluate()` 讀計數器）依設定的間隔（分鐘）判斷是否該送出，算出「本次區間內」與「累計」兩種數字（`report_period_start` 存週期起始快照），組好 payload 後交給 `post_status_report()`（背景執行緒，純網路 POST，不觸碰 Playwright page）非同步送到 `POST /api/autospin/agent/:id/status-report`。間隔與啟用開關透過既有的 `should-stop` 3 秒心跳即時下發（`statusReportEnabled`/`statusReportIntervalMin`），不用重啟 Agent。

**errcode 發生時間點（2026-07-30）**：`window.__spinErrTimes`（`{ "1016": [ts1, ts2, ...] }`，每個 errcode 最多留最近 5 次，epoch ms）跟 `__spinErrCounts` 同一個地方累加，`read_errcode_times(page)` 讀取。只放進 `cumulative`（累計），不像次數一樣切出「本期間」版本——時間點列表沒辦法用相減算出區間差，直接呈現最近幾次的絕對時間即可。

**AI 分析區塊（2026-07-30）**：`generateStatusReportAiAnalysis()`（`server/routes/autospin.ts`）把累計統計（含 errcode 明細與時間點）組成 prompt 丟給 Gemini（`resolveGeminiKeyEntries()` 拿第一組可用 key，不做多 key 輪替重試——這是背景 best-effort 附加功能，不是使用者主動觸發等待結果的前景操作），請它用繁中判斷「是否異常」+「哪個時間段可能機器異常導致中斷」。找不到可用 key、呼叫失敗、逾時（20 秒）一律回傳 `null`，報告照常送出、只是不含 AI 分析區塊，不會拖累整個定時彙總報告功能。**開關預設關閉**（`autospin_status_report_ai_enabled`，Discord 通知設定頁「啟用 AI 分析區塊」）——關閉時完全不呼叫 `generateStatusReportAiAnalysis()`，零額外開銷，考量正式環境長時間跑多台機台會持續累積 AI 費用；真實回報（`/agent/:id/status-report`）與試發送（`/api/autospin/status-report-test`）都跟隨同一個開關。判斷「規則式（不燒 token）vs AI」該選哪個時，優先問使用者，不要預設都開 AI——這類數字型異常判斷（errcode 次數/RECOVER/CR 無回應是否超標）本質是門檻邏輯，訓練專屬模型是不必要的過度工程，比呼叫 Gemini 成本更高、更難維護。

**errcode 現場快照 → 回答「對玩家有什麼影響」（2026-08-31，v4.82.0）**

定時彙總報告原本的 errcode 區塊只有「代碼 + 次數 + 最近幾次時間」。開發問「具體影響是什麼、對玩家有什麼影響」時完全答不出來——因為報告只證明「發生過」。

**影響資料其實一直都抓得到，只是沒被綁在一起**：`get_last_spin_err()` 早就存了 `errcodedes`（伺服器自己給的錯誤描述）、`do_spin()` 早就回傳 `(balance_before, balance_after, rejected)`，但報告只留了一個計數器，其餘全丟掉。

**`record_err_snapshot()`（`toppath-agent.py`）** 在 spin 被拒絕時記一筆現場快照：errcode、errcodedes、餘額前後、是否需要查帳、以及（下次成功後回填的）恢復秒數。

**餘額前後是關鍵**——它把錯誤分成三種嚴重度完全不同的情況，而原本的計數器分不出來：

| 情況 | 意義 | 該做什麼 |
|---|---|---|
| 扣了、沒轉成 | **玩家真的損失** | 升級查帳，這是要報的 bug |
| 沒扣、沒轉成 | 按了沒反應，重按就好 | 嚴重度低 |
| 扣了、也轉成 | 那個 errcode 其實無害 | 是雜訊 |

**查帳採「異常升級」不是每筆都查**（跟 CodeX 討論定案）：只有扣款疑慮、餘額讀不到、或超過 `RECONCILE_GAP_SEC`（30 秒）沒有成功 spin，才標記 `needsReconcile`。**熱更新期間本來就會有一堆預期內的錯誤，全部打成查帳事件等於沒有訊號**，報告也會變慢。

**快照分兩層存**：Discord 只出統計結論（每個 errcode 一行：次數／扣款疑慮／最長恢復／伺服器描述），本機保留最近 `ERR_SNAPSHOT_KEEP`（300）筆完整快照。全塞進 Discord 訊息會爆。

**恢復秒數是往回填的**：錯誤發生當下不知道要多久才好，要等下一次成功 spin 才算得出來（`mark_spin_recovered()`）。這個數字本身就是熱更新測試要回報的指標——**不是「錯了幾次」，而是「服務多久才恢復」**。

⚠️ **errcode 來源有已知誤差**：從 `window.__lastSpinErr` 讀的是「最近一次」而不是「這一次」。緊接在拒絕後讀通常是對的，但同一輪內連續多次拒絕可能拿到後面那個。要精準對應得改 `do_spin()` 的簽章與四個呼叫點，這版沒做。

⚠️ **這個改動補不回已經跑過的資料**——過去那些 errcode 當下的餘額沒被記下來，只能重跑一次測試才拿得到。

⚠️ **agent 端要按「更新程式碼」**才會拿到新的 `toppath-agent.py`（它在 `AGENT_SOURCE_WHITELIST` 裡，但不會自動更新）。

> 已驗證 19 項（`server/python/test_err_snapshot.py`，用假 page 不開瀏覽器）：三種嚴重度分得開｜長時間沒恢復會升級｜恢復秒數正確回填且不會被二次覆蓋｜統計取最大恢復秒數與最後一筆非空描述｜快照有上限不會無限長大。

**後台對帳的失敗不能再偽裝成「0 筆」（2026-09-01，v4.89.0）**

使用者在正式環境回報「怎麼查不到資料」——**六筆歷史紀錄橫跨不同日期，前端後台全是 0**。

`fetchBackendRecords()` 原本**任何失敗都是 `break` 回空陣列**，於是：

| 症狀 | 為什麼嚴重 |
|---|---|
| 執行對帳顯示「後台 0 筆」 | 跟「這段時間真的沒資料」畫面上**完全一樣**，查不出壞在哪 |
| **測試連線回「連線成功，測試查詢回傳 0 筆」** | 拿到空陣列還是報成功——token 沒有／登入失敗／權限不足通通會被說成連線成功。**這不只是沒幫助，是主動把排查引到錯的方向** |

**根因很可能是設定沒建**：v4.85.x 起後台對帳的連線設定改成沿用「Performance Meter 對帳」那頁的
`meter_reconcile_config`（`osm_*` / `gcp_*` 前綴），而**每個環境的 DB 是分開的**——
本機有設定所以查得到，正式環境沒在那頁設定過就是空的。

修法（跟 CodeX 討論定案）：`fetchBackendRecords()` 改回傳 `{ records, error? }`，
error 是結構化的 `{ type, message, userMessage, backendCode?, page?, partial }`，
type 為 `missing_config` / `auth_failed` / `api_error` / `network_error`。

- **`partial`（抓到一部分才失敗）照常比對但一定要標示**：已抓到的資料仍有診斷價值，
  整個當失敗等於丟掉它；但不標示的話使用者會拿不完整的資料下結論，那比沒有結果更危險。
- **後台原始 `message` 只進 server log，前端只拿受控的 `userMessage`**——外部系統的訊息
  可能含內部欄位、路徑或帳號資訊。前端另外收 `backendCode` / `page` 方便定位。
- **警告橫幅放在摘要「上面」**：查詢根本沒成功時，摘要那排 0 是沒有意義的數字，
  先看到 0 再看到警告，結論已經下完了。`partial` 用黃、`failed` 用紅——兩種嚴重度不同，
  共用一個顏色會讓人分不出還能不能參考。

**⚠️ 順手修掉一個不一致**：`auto_login` 這個 key **在兩張設定表裡都不存在**，永遠是 undefined，
而兩處對它的解讀剛好相反——`fetchBackendRecords` 是 `!== 'false'`（預設**開**）、
`/reconcile/test` 是 `=== 'true'`（預設**關**）。也就是同一組設定下執行對帳會自動重登、
測試連線不會，**測試比實際查詢還弱**。統一成 `autoLoginEnabled()`，預設開。

**⚠️ 之後若真的要讓 `auto_login` 變成可設定項，一定要寫進設定初始化／migration，
不能再讓它以 undefined 存在、靠各處程式碼自己猜語意**（CodeX 提醒）——
這次的 bug 本身就是這樣長出來的：沒有人「決定」過預設值是什麼，
兩個地方各自寫了一個看起來都合理的判斷式，結果剛好相反，而且**兩邊都不會報錯**。

**「完全沒設定過」要跟「帳密不對」分開講**：兩者的下一步完全不同（去建設定 vs 改帳密）。
先前兩種都回「自動登入失敗，請確認帳密」，在全新環境上等於把人導去檢查一組還不存在的帳密。

**歷史紀錄也要記狀態（v4.90.0）**：畫面上有紅色警告，但**失敗那次照樣被存進「歷代勘帳錄」**，
之後回看只剩「後台 0」——跟修好的那個問題一模一樣，只是晚一步才發生。
（CodeX review 提到「結果被誤用」的實際發生位置：這個工具**沒有匯出功能**，歷史紀錄就是那條路。）
`reconcile_reports` 新增 `backendStatus` 欄，畫面多一欄顯示「正常／不完整／查詢失敗」。

**⚠️ 既有列一律留空字串顯示「—」，不是預設成 `ok`。**那些列是加這欄之前跑的，
我們根本不知道當時成不成功；標成正常等於幫過去的資料做出沒有根據的宣稱——
而使用者手上那六筆全 0 的紀錄，很可能正好都是失敗的。

> 已驗證 11 項（`scripts/ui-checks/reconcile-error-surface.mjs`）：正常情況 `backendStatus: 'ok'`｜
> 拿掉 token 與帳密後**測試連線改回失敗**（原本會謊報成功）｜`backendStatus: 'failed'`＋
> `type: 'missing_config'`｜訊息是受控文字不夾帶後台原始內容｜**跑完自動還原設定並驗證恢復正常**。

**SPIN 次數 ≠ 局數（2026-08-31，v4.88.0）**

實體機台上按 SPIN 不保證起局——可能落在動畫中、FG/JP 進行中。原本兩者混在同一個
`spin_count` 裡，「spins 90、ok 100%」會被誤讀成「跑了 90 局全部成功」。

`do_spin()` 依**結束訊號**把每一下分類（訊號在 8 秒內先到者為準，每 0.3 秒輪詢）：

| outcome | 訊號 | 報告文字 |
|---|---|---|
| `completed` | pinus `moneyNtc` 結算 | **完成局數** |
| `completed_late` | 逾時後、下一次 spin 前才見到 coin 更新 | 延遲推定完成 |
| `suspected` | 按鈕 `disabled → enabled` | 疑似完成（無結算證據）|
| `unknown` | 8 秒內三個訊號都沒到 | 不確定 |
| `not_started` | 伺服器回 errcode 明確拒絕 | 未起局 |

**⚠️ 四類不能互相合併。**`suspected` 有「局跑過了」的狀態轉換證據、`not_started` 是根本沒起，
併起來會低估局數；`suspected` 變多本身就是訊號——代表 `moneyNtc` 收不到，
正是熱更新後 pinus 補丁失效的典型症狀（v3.90.x 那批問題）。

**`completed_late` 的補判規則（跟 CodeX 討論定案）**：

- **一定要在按下這次 spin「之前」補判**上一筆。這次的結算會把 `__coinUpdatedAt` 往前推，
  之後就分不出是上一局晚到還是這一局剛結算。這個時機同時讓
  `coinUpdatedAt <= nextSpinStartAt` 自動成立。
- **只補上一筆，不做待判佇列。**`__coinUpdatedAt` 是「任何一則帶 `coin` 欄位的 pinus 訊息」
  都會更新（route 與 reason **都沒過濾**），所以一次 coin 更新**無法歸屬到特定某一局**；
  連續多筆 unknown 時拿一次更新去分配只會做出更精緻的錯覺。
  **也不會因此漏判**——每次 spin 前檢查上一筆，A、B 連續 unknown 時 B 之前查 A、C 之前查 B。
- **距離點擊超過 `RECLASSIFY_MAX_GAP_SEC`（30 秒）就不補**；卡過 FG/JP 等待（`osm_handled`）
  或觸發過 fallback bonus 時直接清掉 pending。那段一定有派彩造成的 coin 更新，
  拿它補判會把**派彩誤記成上一局的結算**。
- **⚠️ 刻意不併進 `completed`。**它的證據等級低於 8 秒內收到的結算——只證明「這段期間曾經有
  coin 更新」。併進去會讓「完成局數」從確定訊號變成混合訊號，而且改版前後不可比。
  用詞是「延遲**推定**完成」不是「延遲完成」（CodeX 要求，不要過度承諾）。
- 這個比例本身是健康指標：變多代表結算訊號常常晚到或漏接。

**⚠️ 有些機台的 Spin 按鈕全程不切換 disabled**（實測 BULLBLITZ 累計 553 次 `suspected` 全是 0，
RISINGROCKETS 也是）。那種機台**只剩 `moneyNtc` 一個完成訊號、沒有第二道保險**，
`unknown` 落在「訊號丟失」而非「動畫太久」的機率比有按鈕訊號的機台高。

> 已驗證 15 項（`server/python/test_late_reclassify.py`，用假 page 不開瀏覽器）：
> 該補的有補｜coin 沒更新／時間戳倒退／超過 30 秒／沒有待判紀錄／計數器已是 0／讀不到時間戳
> 一律不補｜一筆只補一次｜**補判前後 outcome 總數守恆**（只能搬動分類，不能憑空生出局數）。
> 報告渲染另以本機攔截伺服器捕捉真實 embed 確認（webhook 設定測完已還原）。

**帳號 → Discord Tag 對照表（2026-07-30）**：`mentionForUserLabel(userLabel)` 依 session 派工時的帳號（`agentSessions.get(sessionId).userLabel`）查 `autospin_discord_user_map`（`settings` 表 JSON 陣列），找到就回傳 `<@discordUserId> ` 字串。**這個 mention 一定要寫進 Discord webhook payload 的 `content` 欄位，不能塞在 `embed` 裡**——embed 的 title/description/fields 就算文字寫 `<@id>` 也不會觸發 Discord 通知/ping，只有訊息本體的 `content` 才會。套用範圍：即時彙報通知（`notifyDiscord()`，含新建訊息與 PATCH 編輯兩種情境，但 Discord 對「編輯訊息新增 mention」通常不會重新推播通知，只有第一次建立訊息時的 ping 保證有效）與定時彙總報告（每次都是全新訊息，一定會 ping）。

**標題附帶 gmid（2026-07-31）**：`maybe_send_status_report()` 從 `mp['config'].get('gameTitleCode')` 取值，經 `post_status_report()` 一併 POST 給伺服器，`buildStatusReportEmbed()` 標題變成 `— {machineType}（{gameTitleCode}）`——單純顯示 `machineType` 在名稱相近時（如 RISINGROCKET / RISINGROCKETS）無法分辨是哪一台機器發的報告，加上 gmid 才能唯一對應。

**執行監控畫面依帳號隔離（2026-07-31 修復）**：`GET /api/autospin/agent/status`（前端輪詢偵測「目前在跑的 session」並自動接上 SSE 日誌/截圖）與 `POST /api/autospin/agent/stop-all`（前端「停止」按鈕）先前都是「不管是誰派工的，抓第一個/全部在跑的 session」，導致不同帳號登入時會看到彼此的執行日誌與截圖，「停止」甚至會連別人正在跑的機台一起停掉——`AgentSession` 本身早就有 `userLabel`（`hub-dispatch` 派工時就會記錄是哪個帳號），只是這兩個端點沒有用上。修法：兩個端點都改成讀取 `x-user-label` header，只回傳/只操作 `s.userLabel` 對得上的 session；前端對應的 4 處 `fetch('/api/autospin/agent/status'/'stop-all')` 補上該 header（用既有的 `getGlobalUserLabel()`，跟 hub-dispatch/hub-agents 等其他呼叫同一套帳號來源）。

**帶 sessionId 的其餘端點也補齊帳號檢查（2026-07-31，Codex review 後補）**：上面那版只擋住「自動偵測」這個發現別人 sessionId 的入口，但 `pause`/`resume`/`spin-interval`/`stream/:id`（SSE）/`screenshot(s)/:id` 這些端點本身仍然「只認 sessionId、不驗證是不是同一個帳號」——正常 UI 流程確實不會再拿到別人的 sessionId，但只要 sessionId 洩漏（舊頁面殘留分享的截圖連結、瀏覽器歷史記錄等），仍能直接操作/讀取別人的 session。新增 `requestUserLabel(req)` 共用 helper（讀 `x-user-label` header，或 `?userLabel=` query——`EventSource`/`<img src>` 無法自訂 header，只能靠 query），套用在這 5 個「前端呼叫」端點，`userLabel` 不對就回 403。**注意分辨呼叫方**：`/agent/:id/log`、`/agent/:id/screenshot`（上傳）、`/agent/:id/stop`、`/agent/:id/should-stop` 這幾個是 **Python agent 自己上報用的**，不是前端指令，不需要（也不能，agent 沒有 x-user-label 概念）加這個檢查。**已知範圍限制**：「伺服器端 (fallback)」模式的 `SessionState`（`/api/autospin/status`）完全沒有 `userLabel` 概念，仍是全域共用，未修——目前使用的主要模式是「遠端 Agent」（agent-hub），fallback 模式較少人同時用，之後若有人真的在 fallback 模式遇到同樣問題再補。

**截圖監控依帳號開關（2026-08-17，v4.6.0）**：AutoSpin 原本固定每 `screenshot_interval`（20 次 Spin）就 `page.screenshot()` 一次並上傳存進「截圖監控」畫廊；機台一多，畫廊持續累積會把旁邊的 LuckyLink JP／SLS 錯誤日誌兩個面板往上推出可視範圍（見下方版面修正），使用者要求乾脆讓這個功能可以整個關掉。跟三路對帳的 `compareEnabled` 完全同一套「依帳號分開設定」模式（`autospin_notify_prefs` 表新增 `screenshotEnabled INTEGER NOT NULL DEFAULT 1` 欄位＋ALTER TABLE 補齊既有安裝、`isScreenshotEnabled(userLabel)` helper、`GET/PUT /api/autospin/screenshot-prefs`）：
- `/api/autospin/agent/start` 回應頂層多帶 `screenshotEnabled`（帳號層級偏好，不是逐機台設定，所以不塞進每台 machine config）
- `toppath-agent.py`：`main()` 從註冊回應讀出 `screenshot_enabled_data`，透過 `spawn_machine()` 的 `multiprocessing.Process` args 傳給每個 `machine_worker()` child process（沿用既有 `session_id`/`server_url`/`user_label` 那套「parent 讀一次、經參數傳給 child、child 內用 `global` 賦值」模式，因為 Windows/macOS 的 `spawn` 模式下 child 是重新 import 整份模組，不會自動繼承 parent 的全域變數）
- **關掉的範圍刻意只有「上傳存進截圖監控畫廊」這一步**（`async_call(send_screenshot, ...)` 那行），`page.screenshot()` 本身仍然要執行——因為同一個區塊下面的模板偵測（Bonus/Error）需要這張截圖才能運作，戰績紀錄/對帳資料（`post_history`/`fetch_and_post_pinus_records`）也共用同一個觸發點；只關閉上傳，不影響這些其他功能
- **只在下次啟動 AutoSpin session 時生效，不是即時的**（跟 CodeX 討論定案：要做成執行中即時生效需要多一條 agent polling 或 server push 機制，範圍變大，這版先做成本低的版本）——前端 checkbox 下方直接寫提示文字，避免使用者以為切換當下就會立即改變行為
- 前端 checkbox 位置：AutoSpin「執行監控」分頁的派工選項區，緊接在「啟用 LuckyLink JP 比對」下方；掛載時 `GET` 讀目前偏好、切換時 `PUT` 立即寫回（這裡「立即寫回」是指「偏好值」立即持久化，不是指「行為」立即生效，兩者不要混淆）
- 已直接對本機在跑的 server 驗證過 `GET/PUT /api/autospin/screenshot-prefs` 端到端行為（預設 true → PUT false → GET 回 false → PUT true 還原），`npx tsc --noEmit`／`npm run build`／`python -m py_compile` 皆乾淨

**執行監控右側欄版面修正（2026-08-17，v4.5.1，同一天稍早發現的相關問題）**：LuckyLink JP／SLS 錯誤日誌／截圖監控三個面板原本共用同一個 `overflow: 'auto'` 捲動欄位，截圖越疊越多會把上面兩個面板往上推出可視範圍，要滑很久才找得到。改成「截圖監控」單獨限制最高 420px、自己捲動，其他兩個面板留在外層一般排版流裡不受影響，永遠可見不用捲——這個修正跟上面的「截圖監控依帳號開關」是同一輪對話裡使用者連續回報的兩個相關但獨立的問題，一起記錄在這裡方便之後查閱前後脈絡。

**三路對帳（2026-08-10，v3.91.0）**：AutoSpin 底下新分頁「三路對帳」，跟執行同步、伺服器背景持續跑的即時比對工具，比對三個資料來源：SLS recordBet log（`lib/sls.ts` 的 `fetchRecordBet()`，官方 `@alicloud/sls20201230` SDK）、機台盒子硬體日誌（`fresh_current_credits`，**目前尚未串接來源**）、前端 Pinus history（沿用既有的 `reconcile_front_records` 表，Python agent 本來就會呼叫 `fetch_and_post_pinus_records()` 上傳）。跟 CLAUDE.md 上面的「後台對帳」（`reconcile/*`）是不同工具——後台對帳是使用者手動選時間範圍事後跑一次、比對後台 `gameRecordList`；三路對帳是不需要使用者觸發，AutoSpin 一開始跑，`setInterval` 每 20 秒自動掃描所有執行中 session 的每台機台各跑一次。

**SLS 憑證只從 env var 讀，不提供前端設定（2026-08-10 起，v3.91.1 / v3.92.2 兩次修正）**：v3.91.0 原本做了一個「SLS recordBet 憑證設定」面板讓使用者自己填 AccessKey/Region/Project/Logstore（存 `settings` 表 `sls_*` 前綴），使用者當天立刻回饋不需要這個——`getSlsCreds()`（`server/lib/sls.ts`）改成從 env var 讀。**v3.92.2 又修正一次**：中間版本一度把 AccessKey ID/Secret 直接寫死成程式碼常數（fallback 值），這組真實憑證被 GitHub push protection 擋下（偵測到 commit 裡有 Alibaba Cloud AccessKey），才發現這個做法本身有風險——即使程式碼倉庫是私有的，寫死的密鑰只要進了 git 歷史紀錄就永久留在那裡，之後改掉程式碼也救不回來。最終版本：AccessKey ID/Secret 兩個敏感值完全沒有預設值（讀不到就是空字串，`fetchRecordBet()` 會丟出「SLS 憑證尚未設定」錯誤），只有非敏感的 Region/Project/Logstore 三個保留合理預設值方便本機開發。**部署到新環境（例如正式環境 Spug）時，必須在該環境自己的 `.env` 補上這 5 個變數**（`SLS_RECORDBET_KEY_ID`/`SLS_RECORDBET_KEY_SECRET`/`SLS_RECORDBET_REGION`/`SLS_RECORDBET_PROJECT`/`SLS_RECORDBET_LOGSTORE`），改完要重啟該環境的 server process 才會生效（env var 只在啟動時讀一次）；`.env` 本身不會隨 git push 過去，每個環境要各自維護一份，這是設計上本來就如此。`GET/PUT /api/autospin/compare/sls-config` 兩支端點與前端整個憑證設定面板都已移除；只留 `POST /api/autospin/compare/sls-test` 給後端自己診斷用（curl 確認連線），不接前端畫面。

比對欄位刻意不寫死，使用者在畫面上自訂「比對群組」（例如群組「下注金額」= SLS `requestJSON.amount` + Pinus `bet`），存在新表 `autospin_compare_groups`（全域共用，PUT 整批覆蓋儲存，跟 `reconcile_config` 一樣的定位——比對定義是團隊共同量測標準，不是個人偏好）。比對結果存 `autospin_compare_results`（一列＝一台機器一次 spin，`roundKey` 唯一索引 `(sessionId, machineType, roundKey)`，用 `INSERT ... ON CONFLICT DO UPDATE` 而非單純 insert-or-ignore——因為 SLS 跟 Pinus 兩邊資料到達時間不同步，同一輪可能先被記成 `missing_data`，晚一點另一邊資料補齊時要能更新回同一列，不是變成兩筆重複紀錄）。

**欄位新增改成下拉選單，不讓使用者手打路徑（2026-08-10，v3.91.1 修正）**：v3.91.0 原本用 `window.prompt()` 讓使用者自己打欄位路徑（例如要自己記得打 `requestJSON.amount`），使用者回饋這樣容易打錯、也不知道有哪些欄位可選。改成前端內建 `FIELD_CATALOG`（`AutoSpinPage.tsx`）——SLS 欄位取自 recordBet log 真實的 `requestJSON`/`responseJSON` 結構（跟 `SlsBetRecord.raw` 同一份資料）、Pinus 欄位取自 `reconcile_front_records` 正規化後的欄位（bet/win/orderId/recordTime/gmid/gameid）、盒子欄位目前只先預留使用者原本提過的 `fresh_current_credits` 一個選項（尚未串接，選了也固定顯示缺資料）。每個來源一顆 `<select>`，選了就直接加入群組，不用自己打字也不會選到不存在的欄位。

**依帳號的啟用開關（2026-08-10，v3.91.2）**：跟 Codex 討論後的結論——比對「規則」（群組欄位定義）維持全域共用（團隊量測標準，不應該每人一套，不然結果難以互相解釋），但要不要「執行」比對這件事依帳號各自決定（有人只是想跑 AutoSpin 穩定性測試，不需要額外打 SLS API/寫 DB）。`autospin_notify_prefs` 新增 `compareEnabled` 欄位（沿用既有的每帳號設定表，預設 1／開啟，既有安裝用 `ALTER TABLE` 補齊），`GET/PUT /api/autospin/compare/prefs` 讀寫。`runCompareCycle()` 背景每 20 秒掃描時，逐一 session 先檢查該 session 擁有者（`session.userLabel`）的 `isCompareEnabled()`，關閉的帳號直接 `continue` 跳過（完全不打 SLS/Pinus 查詢也不寫入 `autospin_compare_results`）。畫面上開關放在分頁頂部，關閉時顯示明確提示文字，不是靜默失效。手動「試算目前資料」（`/compare/run-now`）目前沒有跟著這個開關特別處理——它呼叫的是同一個 `runCompareCycle()`，關閉開關的帳號手動點擊也不會產生結果，這是刻意不特別繞過的簡化（真的想再測就先把開關打開）。

**配對邏輯**：SLS `recordBet` 的 `roundId` 欄位（例如 `"900-BZZF-0003|6A79AD7F003"`）與 AutoSpin 機台設定的 `gameTitleCode`（例如 `"900-BZZF-0003"`）前半段格式相同，用來把 SLS log 過濾到正確機台；`roundId` 再跟 Pinus `historyListReq` 回傳的 `order_id` 做精確字串比對配對同一筆下注（沒有做時間相近度 fallback——不像上面「後台對帳」2 路比對那樣有 bet/win/time 容錯配對，3 路對帳目前只信任明確的 ID 對應，避免配錯筆數字反而誤判成不符）。「機台有沒有在跑」的偵測是看 `autospin_history` 最近 5 分鐘內有沒有寫入紀錄（agent 本來就持續在寫），不是自己維護一份派工機台清單（`hub-dispatch` 當下沒有記錄實際派了哪些機台到 session 物件上，這樣判斷更準）。

**Pinus 側的 uid 一定要從登入回應拿（2026-09-03，v4.102.0）**：`fetch_and_post_pinus_records()` 原本用 `window._uid || window.pinus.uid` 取 uid，**這個遊戲兩個都沒有**，所以送出去永遠是空字串，伺服器每次回 `errcode 15 參數錯誤`。實測某個 session 打了 10 次全失敗、`reconcile_front_records` 一筆都沒有，三路對帳因此 111 筆全部顯示「缺資料」。

**⚠️ 它拖這麼久沒被發現，是因為錯誤被靜默吞掉**：錯誤回應沒有 `list` 欄位，程式直接落到 `if not records: return`，一行日誌都不印（成功會印、拋例外會印，唯獨「拿到 0 筆」什麼都不印）。現在非 0 errcode 一定印出來，含 route／uid／errcode／描述。

**⚠️ uid 只認 `gate.gateHandler.loginReq` 的回應**，刻意不做「看到任何帶 uid 的封包就記」（跟 CodeX 討論定案）——`broadcastReq` 那類廣播裡的 uid 可能是**別的玩家**（真實日誌同時出現過 `325599` 與 `328980`）。泛抓會把「撈不到資料」這個 bug 變成更危險的「撈到別人的戰績」，而且看起來完全正常。取不到 uid 時直接跳過查詢並印一行節流過的說明，不要照送空字串。

> 已驗證：`server/python/test_pinus_history.py`（18 項，假 page）＋ `scripts/ui-checks/pinus-uid-capture.mjs`（11 項，**直接從 `toppath-agent.py` 抽出那段 JS 來跑**，不是複製一份）。後者已注入違規確認會變紅——把條件放寬成「任何封包都認」時 3 項紅，包含「登入後再收到別人的 broadcast 不會被蓋掉」。
>
> ⚠️ **agent 端要按「更新程式碼」再重開 AutoSpin 才會生效**（`toppath-agent.py` 在白名單裡但不會自動更新）。

**SLS ↔ Pinus 的配對改用「同機台 + 時間相近」（2026-09-03，v4.103.0）**：Pinus 的 `historyListReq` **根本沒有 order id**——實測回傳欄位只有 `time / gameid / gmid / bet / win / gmname`，所以 `orderId` 一律是空字串，原本的 `pinusByOrderId.get(sls.roundId)` 精確比對**永遠不可能命中**（SLS 那側是 `873-BULLBLITZ-0136|6A99241E062`）。

**⚠️ 規則一律保守：寧可 unmatched，不要假相符**（跟 CodeX 討論定案）。配錯會產生「看起來相符、其實是別輪」的結果——缺資料只是沒有結論，假相符是**錯誤的結論而且沒有任何徵兆**。

- 配對鍵只有「同 `gmid` + 時間窗內唯一候選」
- **`bet`/`win` 只當配對後的驗證，不當配對鍵**：連續同注額的輪次 bet 完全一樣、win 常常都是 0，拿來縮候選只會製造「看似精準」的錯覺
- **還要反向檢查**：spin 間隔 3~4 秒時，相鄰兩輪很可能各自「唯一」對到同一筆 Pinus。只看「一輪對到幾筆」抓不到這種，所以同一筆被搶兩次時**兩輪都判成無法判定**
- 狀態拆成 `unmatched`（找不到）／`ambiguous_match`（多筆候選，拒絕猜）／`missing_data`（配到了但某一路缺欄位）——三者的下一步完全不同

**⚠️ 時間窗 ±1000ms 是用實測分布定的，不是憑感覺**。285 輪真實資料重算：

| 窗寬 | 可配對 | 配不到 | 多筆拒絕 |
|------|-------|-------|---------|
| ±500ms | 57 | 213 | 15 |
| **±1000ms** | **101** | 152 | 32 |
| ±2000ms | 94 | 151 | 40 |
| ±3000ms | 49 | 148 | 88 |

**放寬反而更糟**——第一版設 ±3000ms 只配得到 49 筆。兩邊時間都是秒級、實際觀察到的真實時間差只有 `0` 與 `-1000ms`，±1000ms 剛好涵蓋「同一秒或相鄰一秒」。**要再調先用實際資料重算這張表**，每筆都留了 `candidateCount`／`timeDeltaMs` 診斷欄位就是為了這個。

> 已驗證 24 項（`scripts/ui-checks/pinus-sls-matching.mjs`，fixture 相對窗寬表達所以調窗不用重寫），已注入違規確認會變紅——把「多筆候選取第一筆」放回去時 3 項紅。上線後實測 ambiguous 從 21 筆降到 0。

**⚠️ 這個值目前只對 BULLBLITZ 成立，還不是全系統通用常數**（2026-09-03 跟 CodeX 定案）。46 筆成功配對全部落在 `0` / `-1000ms`、沒有長尾，代表不是巧合；但樣本只有一台機台。**要收斂成全域規則之前只需再看兩類樣本**：① 另一台機台是否也只落在 `0`／`-1000ms` ② spin 間隔更短或更不穩時，`ambiguous` 會不會明顯上升。這兩個都沒打破分布，就把 `gmid + ±1000ms + 唯一候選` 寫成正式規則，**之後不要再反覆調窗**。

**⚠️ 比對範圍一定要被 session 邊界約束（2026-09-03，v4.103.1）**：SLS 是依**機台**抓最近 600 秒（`fetchRecordBet(from, now, gameTitleCode)`），而 Pinus 只查 `sessionId = 這一次`——兩邊不對稱。session 剛啟動時那 10 分鐘會撈到**上一個 session** 打的輪次，那些這次的 agent 根本沒觀測過，於是全部被標成 `unmatched`。

真實案例：164 筆裡 **147 筆是 session 開始前的**，使用者看到「148 筆配不到」以為配對壞了；範圍內的 17 筆其實是 match 10 / ambiguous 7 / **unmatched 0**。修法是 SLS 下界改成 `max(now-600s, sessionStartedAt)`，統計與逐筆明細也都加 `spinTime >= sessionStartedAt`。

**⚠️ 刻意不放寬 Pinus 去掉 sessionId 限制**（CodeX review）：那樣覆蓋率會變好看，但會把上一個 session 的歷史資料混進這次的覆蓋率，之後分不出是「即時撈取成功」還是「剛好被歷史補到」。

**⚠️ 已寫進 DB 的範圍外紀錄不刪**——那是當時規則下真實產生的結果，刪掉會讓排查紀錄斷掉。改的是報表口徑，不是竄改歷史。**統計跟逐筆明細一定要同口徑**，否則數字沒了、展開卻還是一整排 unmatched，反而更難解釋。

**⚠️ 已知限制**：Pinus 每次只回最近 15 筆、每 20 次 spin 才撈一次，所以覆蓋不到所有輪次（285 輪 vs 165 筆），`unmatched` 偏高是預期的，不是配對規則有問題。

**盒子日誌尚未串接**：`resolveFieldValue()` 對 `source: 'box'` 的欄位固定回傳 `undefined`，任何包含盒子欄位的比對群組會固定停在 `missing_data` 狀態，前端畫面在有此類群組時會明確顯示黃色提示「盒子硬體日誌尚未串接資料來源」，不會假裝已經比對過。之後真的串接時只需要在 `resolveFieldValue()` 補上 `ctx.box` 的實際資料來源，比對群組設定本身不用重新設定。

### 使用者操作
| 操作 | 說明 |
|------|------|
**暫停會自己解除／重任務鎖變孤兒（2026-09-07，v4.123.0）**

同一天使用者回報兩件事，查下去是**兩個獨立的洞**，共同點是「症狀出現在 A、根因在 B」。

**① 按了暫停還是繼續跑**

`pauseRequested` 只在記憶體，靠 5 秒一次的快照落 DB。worker 掛掉重啟時（日誌實際出現
`Worker websocket error`）從**暫停之前**那份快照復原 → 暫停沒了、機台自己 spin，
而畫面徽章讀的是另一個地方、還停在「已暫停」。

⚠️ **我第一次推論錯了**，說是「重連建了新 session 導致 pause 遺失」。回去比對 Python 日誌，
**沒有**「Session 已失效，嘗試重新連線」那行——那條路根本沒跑到。
**從症狀反推的因果不要當結論講**，會讓討論對象照著錯的前提給建議。

修法：暫停／繼續／停止／改間隔**當下就寫 DB**。

⚠️ **並且要防「舊快照蓋回新控制狀態」**（CodeX review 指出）：加 `controlUpdatedAt`，
定時快照發現 DB 那筆比記憶體新時，把控制欄位**讀回記憶體**再寫出去。
沒有這道的話即時寫入會被下一次快照無聲蓋掉，**症狀跟修好之前一模一樣、但更難查**。

**② 重任務鎖變孤兒，把帳號鎖 24 小時**

鎖的釋放原本**全部掛在「有人主動打 API」**——`hub-stop`、`/agent/status` 的心跳逾時掃描。
使用者直接關掉 agent 視窗（沒按停止）時一條都不會跑到；而重啟 worker 又會
**把鎖復原、session 不會回來**（兩者存在不同的表、各自獨立復原）。

症狀是「agent 顯示可派工，但 Python 一啟動就 `伺服器拒絕註冊` 然後 exit 1」。

⚠️ **而那個 429 完全不會出現在網頁上**——`hub-dispatch` 本身是成功的，
衝突發生在 agent 端 Python 去 `/agent/start` 註冊的時候。使用者在網頁上只看得到
派工按鈕轉一下就沒反應。這比鎖本身更該修，所以畫面上主動偵測並說明。

| 做法 | 說明 |
|---|---|
| `heavy_tasks.lock_key` 存 session id | 這欄以前**從沒被寫過**。沒有它就無法判斷「鎖在、session 不在」 |
| 每分鐘背景掃描 | **刻意不依賴任何請求**——聰明的判定會被繞過，笨的定時掃描不會（同 v4.118 絕對上限那條）|
| 開機復原時同樣判斷 | 否則重啟就把孤兒鎖帶回來 |
| 強制清除按鈕 | 救援工具，不是正常流程。會寫操作歷史 |

⚠️ **只套用在 `autospin-agent`**（跟 CodeX 討論定案）：其他型別可能沒有 session 的概念、
或鎖本身就是唯一真相，誤清比留著危險。

⚠️ **舊資料沒綁 session id 時不能直接判死**——升級當下所有既有的鎖 `lock_key` 都是 null，
一律判死會把那一刻正在跑的 session 保護整個拔掉。退回用 userLabel 比對，且要過 5 分鐘寬限期。

**③ 順帶修掉：Spin 失敗時是無延遲的死循環**

失敗分支**整條沒有任何等待**（只有成功路徑有 `time.sleep`），而 `page.reload()` 失敗時
`except: pass` 讓 `error_count` 永遠歸不了零 → 每次迭代又重載一次。
實測日誌 **400~405 次失敗全部落在同一秒**。

加指數退避（5s→120s），⚠️ **用 `stop_flag.wait()` 不用 `time.sleep()`**——
退避最長 120 秒，用 sleep 的話按下停止要卡兩分鐘，等於為了修「停不下來」製造另一個「停不下來」。

> 已驗證 23 項（`scripts/ui-checks/autospin-lock-orphan.mjs`，跑完還原 `heavy_tasks` 與
> `autospin_agent_sessions`）。**已注入違規確認會變紅**：把孤兒判斷改成永遠回「有主人」、
> 把暫停的即時寫入拿掉 → 對應 3 項轉紅。
>
> ⚠️ **agent 端要按「更新程式碼」**才會拿到新的 `toppath-agent.py`（重連旗標與退避在那裡）。

**沒起注的 Spin 不算一局（2026-09-07，v4.124.0）**

**每按一次 Spin 就送一筆對帳紀錄，但按鈕次數不等於局數。**特殊遊戲（FG/JP）期間
按 Spin 不會起新的一局，後台自然沒有紀錄 → 全部被標成「後台查無此局」。

實測 **51 段連續 ≥5 次、最長連續 56 次**；而且其中一筆 `not_started`
**還被綁到某張後台單**——一局根本沒起卻搶走別局的紀錄，真正的主人永遠配不到。

⚠️ **原本以為有保護，其實那個保護只在 OSMWatcher 連線時存在。**沒連線時完全不進
`wait_for_normal_osm_status()`，主迴圈一路 `do_spin()` 打下去；fallback 只在連續 10 次
餘額無變化時執行一次 `bonusAction` 就繼續，**沒有任何「這段期間不要記帳」的概念**。
而使用者的環境一直是未連線——是他反問「不開 OSMWatcher 的話你怎麼知道」才發現的。

**判準是 `moneyNtc.reason === 'begin'`**（真的起注扣款）。

⚠️ **不能用 `end`**：FG 派彩也會發 `end`。判定順序上 **`no_bet` 必須排在 `completed` 之前**，
否則 FG 期間每次按鈕都會被記成「完成一局」。

**三態，用意是 fail-open**（跟 CodeX 討論定案）——某款遊戲若根本不發 `begin`，
一律套用會讓整台機台的對帳**靜默歸零**，比誤報嚴重得多：

| 狀態 | 條件 | 行為 |
|---|---|---|
| `unknown` | 還沒看過任何 begin | **不套用規則**，維持現況 |
| `supported` | 看過至少一次 | 才開始信任、才會標 no_bet |
| `disabled` | 久久收不到 | 停用規則並告警，不繼續靜默排除 |

⚠️ **第三態用「次數 400 **且** 時間 20 分鐘」雙門檻，不用「有 end 卻沒 begin」**——
後者跟正常 FG **長得一模一樣**，會讓一場長 FG 把規則自己關掉；而 `begin` 真的壞掉時
症狀也相同，**agent 端分不出來**。單看次數會被長 FG 打爆，單看時間會在機台停住時誤觸發。

🚨 **真正能分辨的訊號在後台，不在 agent**（CodeX review 的關鍵貢獻）：

```
FG         → 沒 begin、有 end、後台也沒有新的一般局
begin 壞掉 → 沒 begin、有 end、後台仍然有新的一般局
```

所以伺服器端有一道 **shadow check**：判成 `no_bet` 的 spin 若在後台找得到一張
**還沒被認領**的單，就產生 `begin_signal_suspect` 告警。

⚠️ 三個實作前提缺一不可：① **在正式綁定之後才跑**（先跑會跟正主搶單）
② **只看還沒被認領的單**（否則 FG 前後相鄰的正常局會落在容忍窗內被誤報）
③ **只產生 finding、不改任何 spin 狀態**——真要恢復配對是人看到告警去修偵測，
不是讓它自己偷偷改判。

⚠️ **`unknown` 刻意不列入排除清單。**它是「沒收到訊號」不是「沒發生」——
目前有 **172 筆 unknown 已經配對成功**，排除等於一次丟掉那些真實資料。

**收拾既有誤報**：撤銷告警、解除錯誤綁定把單還給正主。
**不刪任何 spin 列、也不改它的 status**——那是當時真實的觀測。

> 已驗證 15 + 18 項（`server/python/test_begin_signal.py`、
> `scripts/ui-checks/live-ledger-no-bet.mjs`，後者跑完還原資料表）。
> **已注入違規確認會變紅**（把 `unknown` 加進排除清單 → 2 項轉紅）。
> 上線後實測：錯誤綁定 1 → 0、殘留誤報 0 筆。
>
> ⚠️ **測試抓到我一個真的 bug**：`last_begin_at = 0.0` 在 Python 裡是 **falsy**，
> `if last_begin_at` 會讓時間門檻永遠不成立。正式環境的 `time.time()` 不會是 0，
> **所以這個 bug 只會在測試裡現形**——沒寫測試就會帶著一個形同虛設的門檻上線。
>
> ⚠️ **agent 端要按「更新程式碼」**才會拿到新的 `toppath-agent.py`。

**🚨 v4.123.2：我加的那道防護反過來咬到使用者（同一天，2 小時內）**

孤兒鎖判定上線後，**把使用者正在使用的鎖清掉了**：鎖建立於 15:10:34、
**15:10:36 就被清除**——建立後 2 秒。

根因是**時間差**：session 建立時只在記憶體，最多要 5 秒才被快照寫進
`autospin_agent_sessions`，而判定讀的就是那張表。一個剛建立、完全正常的
session 在那個空窗裡看起來就像不存在。

清掉之後 Python 還在跑（spin 持續寫入），但伺服器已經不認得那個 session，
所以**網頁的日誌串流接不上**——使用者看到的症狀是「恢復繼續後日誌不更新」，
跟真正的原因隔了兩層。

**⚠️ 更該記住的是第二層：那段判定寫在 module-level 的 restore 區塊裡。**
那個區塊會在**任何 import 這支檔案的 process** 執行——包含 `npm run build`
（它會 import server 模組補種子資料）與檢查腳本。**也就是我跑一次 build，
就改動了正式環境的鎖狀態。**

**模組載入的副作用不可以動到別人的狀態。**修法不是加環境變數判斷 process 身分
（`pm2 restart` 不重讀 env，那條路本身不可靠），而是把破壞性的那段移進
60 秒的定時掃描——短命的 build／測試 process 根本活不到觸發的時候。

三道防護刻意都留、各自獨立：

| 防護 | 擋什麼 |
|---|---|
| session 一建立就立刻落 DB | 從源頭關掉那 5 秒空窗 |
| 剛建立 60 秒內的鎖不判死 | 上一道寫入失敗時仍擋得住 |
| 破壞性判定移出模組載入 | build／測試不再有能力改動正式狀態 |

> ⚠️ **加保護期時，既有測試會被它變成裝飾品**：原本那三條用 `age=0` 呼叫，
> 新的 60 秒保護期會讓它們一律通過、再也驗不到真正要驗的判斷。
> 已全部改成 `age=61秒`。**加寬限期時要回頭檢查哪些測試被它豁免掉了。**

**⚠️ v4.123.1 兩個 review 補洞（CodeX 提的，都不是理論風險）**

1. **快照的新舊判斷用單調遞增的版本號，不用時間戳。**`Date.now()` 遇到時鐘往回跳
   （NTP 校正）時，**剛寫入的暫停會拿到比 DB 更小的值** → 快照判定「DB 比較新」
   → 用舊值蓋掉使用者剛按的暫停。**這是 v4.123.0 要修的 bug 原樣復活**，
   而且只在時鐘飄動時發生。計數器隨快照一起復原，重啟不會歸零倒退。
2. **背景掃描防重疊，而且歸位寫在 `finally`。**放 try 尾端的話中途拋一次錯就
   永久停擺，完全沒有徵兆——跟 v4.98.7 那個 pending 清除同一個形狀。

### 使用者操作
| 操作 | 說明 |
|------|------|
| 清除卡住的重任務鎖 | 執行監控頁在偵測到「你沒在跑、但還留著一筆你的鎖」時，控制列上方出現警示，標明是孤兒鎖／無法確認／仍偵測得到 session，可按「強制清除」；正常情況下背景每分鐘會自己回收 |
| 選擇執行 Agent | 從線上、含 `autospin` capability 的 agent 清單挑一台 |
| 派工啟動 | 命令選定 agent spawn Python 引擎執行 AutoSpin（`/api/autospin/hub-dispatch`）|
| 停止 | 命令 agent 停止並結束 Python 程序（`/api/autospin/hub-stop`）|
| 伺服器端 fallback | 切到「伺服器端」可直接在 server 本機 spawn（舊模式）|
| 暫停 / 繼續 Agent | 暫停自動旋轉，保持連線 |
| 查看即時日誌 / 截圖 | SSE 串流 Agent 執行日誌與遊戲截圖；日誌框固定高度＋內部捲動，支援分類篩選（全部/系統/Spin/截圖/錯誤警告）+ 關鍵字搜尋 + 自動捲到底開關 + 清空；pinus 訊息預設收合，可依 7 類（Spin動作/餘額異動/狀態廣播/進入遊戲/連線登入/心跳列表/其他）分別展開；SSE 斷線（如伺服器重啟）會在 2 秒後自動重連。截圖監控為 2 欄縮圖網格獨立限高 420px 自己捲動，標示最新一張，不會把 LuckyLink JP／SLS 錯誤日誌面板擠出可視範圍 |
| 啟用/停用截圖監控（依帳號） | 派工選項區「啟用截圖監控」勾選框，預設開啟；關閉後不再上傳截圖到畫廊（模板偵測/戰績紀錄/對帳資料不受影響），只在下次啟動 AutoSpin session 生效，執行中切換不即時改變行為 |
| 三路對帳（獨立 Tab） | 跟執行同步即時比對 SLS recordBet／盒子日誌（尚未串接）／Pinus history，多機台並行、每台獨立統計已比對/相符/不符/缺資料，展開查看逐筆 Spin 明細；自訂比對群組（用下拉選單挑已知欄位，不用手打路徑）、手動「試算目前資料」立即跑一次。SLS 憑證後端寫死，畫面上不會出現、不用設定 |
| 啟用/停用三路對帳（依帳號） | 分頁頂部開關，預設開啟；關閉後自己執行中的機台不會再背景打 SLS/Pinus 查詢、不寫新比對紀錄，比對群組定義（全域共用）不受影響 |
| 查看歷史紀錄 | AutoSpin 各 session 的執行紀錄 |
| 設定 Spin 間隔 | 調整每次 Spin 的等待時間（執行中可即時覆蓋）|
| 管理模板圖片 | 上傳比對模板圖（模板管理 Tab）|
| 複製機台配置 | 機台設定列表「複製配置」按鈕，帶入既有機台的所有設定（模板/RTMP/隨機下注等）當新機台的起點，只需重新輸入機台類型（唯一主鍵，不可留空/重複），不用從頭重新填一次 |
| Agent 下載安裝 | 統一在「Local Agent」頁面下載安裝（Windows install.bat / macOS install-mac.command，含 token），安裝後的 agent 具備 autospin capability |
| 對賬功能 | 比對遊戲紀錄與帳戶餘額，生成對賬報告 |
| Discord 即時彙報通知 | 每台機台開始測試時發一則 Discord 訊息，之後同一則訊息隨狀態更新：`queued`（排隊中）→ `running`（執行中，每次餘額/事件回報時同步更新）→ `success`（完成，session 期間無異常）/ `failed`（完成，曾偵測到餘額異常 >30%）；手動停止或連線逾時另標記 `stopped`。訊息含機台、Game URL、Spin 數、錯誤摘要、截圖連結，不會洗版。Webhook URL 在「Discord 通知」設定頁配置，不寫死頻道 |
| Discord 定時彙總報告 | 長時間穩定性統計，跟上面即時彙報通知是獨立訊息（每次到間隔另發一則新訊息，不覆蓋前一則）——顯示 errcode 次數/RECOVER 斷線重連次數/kickout 次數/CR checks 與無回應次數/Spin 數/中獎數/總贏分，間隔（分鐘）與顯示欄位皆可在「Discord 通知」設定頁調整，預設關閉 |

### Discord 通知設定（DiscordNotifySettingsPage）

**路由**：`/api/autospin/discord-webhook`（GET/POST）、`/api/autospin/discord-webhook/test`（POST）、`/api/autospin/status-report-settings`（GET/POST，定時彙總報告設定）、`/api/autospin/agent/:id/status-report`（POST，Agent 送出彙總報告用）、`/api/autospin/status-report-test`（POST，用假資料試發送彙總報告）

#### 功能說明
獨立的後台設定頁（系統分區），管理 AutoSpin Discord 通知用的 Webhook URL，未來換頻道只需在此頁改網址，不用改代碼。

**依帳號分開設定（2026-07-31）**：通知啟用開關、即時彙報顯示欄位、定時彙總報告（啟用開關/間隔/顯示欄位/自訂備註/AI 分析開關）改成**依帳號分開**，存在新表 `autospin_notify_prefs`（PRIMARY KEY `userLabel`）——`getNotifyPrefsRow(userLabel)`/`upsertNotifyPrefs(userLabel, patch)`（`server/routes/autospin.ts`）。判斷邏輯：一個 session 是哪個帳號派工的（`AgentSession.userLabel`），發通知/報告時就查那個帳號自己的設定，不是查全域設定；前端所有相關 fetch 都要帶 `x-user-label` header（`DiscordNotifySettingsPage.tsx` 用 `loadGlobalAccount()?.label`）。**Webhook URL、標題模板、頁尾文字仍是全域共用**（存在 `settings` 表，全員同一個頻道/同一套品牌文字）。**相容 fallback**：帳號還沒存過自己的偏好時（`autospin_notify_prefs` 沒有該 `userLabel` 的資料列），getter 會 fallback 讀舊版全域 `settings` 值（`discord_notify_enabled`/`discord_notify_fields`/`autospin_status_report_*`），避免改版當下所有帳號的通知/報告設定突然被重置成程式內建預設值——這些舊的全域 key 仍保留在 DB 裡當作「尚未個人化帳號」的預設值來源，不會主動清除。

#### 使用者操作
| 操作 | 說明 |
|------|------|
| 設定 Webhook URL | 貼上 Discord Webhook 網址並儲存（存在 `settings` 表 `discord_webhook_url`，**全員共用**）|
| 啟用/暫停通知開關 | 關閉後即使 URL 有設定也不會發送，不用清空網址（**依帳號分開**，存在 `autospin_notify_prefs.notifyEnabled`）|
| 發送測試訊息 | 立即送一則測試 Embed 到目前設定的頻道，確認網址正確（不受啟用開關影響）|
| 自訂顯示欄位 | 勾選要顯示的欄位（Spin數/Game URL/錯誤摘要/截圖連結），狀態欄固定顯示（**依帳號分開**，存在 `autospin_notify_prefs.notifyFields`，JSON）|
| 自訂標題模板 | 訊息標題可用 `{machineType}` 佔位符自訂文字，例如加公司代號（存在 `settings` 表 `discord_notify_title_template`，**全員共用**）|
| 自訂頁尾文字 | 選填，顯示在卡片底部時間戳前（存在 `settings` 表 `discord_notify_footer`，**全員共用**）|
| 查看狀態生命週期 | 頁面上顯示 5 種狀態（排隊中/執行中/已完成/失敗/已停止）與同一則訊息更新的說明 |
| 查看訊息預覽 | 即時同步目前欄位/標題/頁尾設定的卡片樣式預覽 |
| 設定定時彙總報告 | 啟用開關 + 間隔（分鐘，預設 20）+ 顯示欄位勾選（errcode/RECOVER/kickout/CR checks/Spin 數/中獎數/總贏分）+ 自訂欄位（選填備註文字，原樣附加在每則報告最下方），**依帳號分開**，存在 `autospin_notify_prefs`（`reportEnabled`/`reportIntervalMin`/`reportFields`/`reportCustomNote`），與上面的即時彙報通知獨立開關、共用同一組 Webhook URL |
| 試發送定時彙總報告 | 「🧪 試發送」按鈕（`POST /api/autospin/status-report-test`）用假資料立即組一則報告送到 Discord，方便確認格式/效果，不受啟用開關影響、不會動到真實累計統計；一併示範 AI 分析區塊（跟隨目前帳號的 AI 開關，關閉不燒 token）+ tag（用目前登入操作者當發起人測試對照表） |
| 啟用 AI 分析區塊 | 定時彙總報告卡片內的獨立開關，**依帳號分開**，預設關閉；開啟才會呼叫 Gemini 判斷是否異常，關閉時零額外開銷（存在 `autospin_notify_prefs.reportAiEnabled`）|
| 設定帳號 Discord Tag 對照表 | Discord 通知設定頁「帳號 → Discord Tag 對照表」卡片，維護「帳號名稱 → Discord User ID」清單，AutoSpin 通知（即時彙報 + 定時彙總報告）依 session 是哪個帳號派工啟動的查表，找得到就在訊息開頭 @ 那個人；存在 `settings` 表 `autospin_discord_user_map`（JSON 陣列，這個本來就是每個帳號各自一條，維持不變），對應 `GET/POST /api/autospin/discord-user-map` |

---
