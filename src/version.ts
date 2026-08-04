export const APP_VERSION = '3.85.0-xianxia.5'

export interface ChangelogEntry {
  version: string
  date: string
  changes: string[]
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '3.85.0-xianxia.5',
    date: '2026-08-04',
    changes: [
      'fix(design): [design/xianxia 分支] 修正境界稱號登入天數只在「重新登入」才會計算的問題——原本 recordLoginDay() 只掛在 /api/auth/login，但登入 session cookie 有效期 7 天，這期間內重新整理/重開瀏覽器不會再打登入 API（cookie 還有效），導致「有在用但沒重新登入」的天數沒被算到，變成不登出重登就不會累加。改成掛在 server/index.ts 的全站共用 middleware，只要當天打過任何一支已登入的 API（含 heartbeat）就算，才是「今天真的有在用」的正確訊號',
    ],
  },
  {
    version: '3.85.0-xianxia.4',
    date: '2026-08-04',
    changes: [
      'feat(design): [design/xianxia 分支] 新增「普通版／修仙版」切換——側邊欄底部新增版面模式開關，可即時切回原本 main 分支的樣子，選擇存在 localStorage。xianxia-complete.css 改放 public/ 由 App.tsx 動態插入/移除 <link>（不再靜態 import 打包進主 CSS，那樣永遠會生效無法整份關掉）。普通版下會隱藏：側邊欄雙標籤（只顯示原功能名）、境界稱號徽章、群英榜排行榜（含側邊欄入口）、背景境界切換、側邊欄品牌名稱改回 Toppath Tools。已知限制：目前只做全站共用外殼的切換，個別頁面更深層的修仙化改動（如 Dashboard Hero 橫幅結構）在普通版下會變成無樣式排版，不是逐頁精準復原成 main 分支原貌。同一批一併收錄 CodeX 產出的群英榜九境動態美術（realms-v1/animated-v1/v2、effects-v1/v2 等素材資料夾）',
    ],
  },
  {
    version: '3.85.0-xianxia.3',
    date: '2026-08-04',
    changes: [
      'feat(design): [design/xianxia 分支] 新增境界排行榜「群英榜」頁面——側邊欄「宗門維運」分區新增獨立頁面，列出所有帳號依累計登入天數排名（不含 token），目前登入的帳號那一列會高亮。新增 GET /api/account/cultivation/leaderboard 端點與 server/shared.ts 的 getCultivationLeaderboard()。跟其他系統頁面一樣走 ALL_PAGE_KEYS/SystemAdminPage 權限表控管可見性（新增 cultivation-board page key）。已本機驗證排行榜資料正確（依真實帳號資料排序）',
    ],
  },
  {
    version: '3.85.0-xianxia.2',
    date: '2026-08-04',
    changes: [
      'feat(design): [design/xianxia 分支] 帳號境界稱號改成依「累計登入天數」推進，不再是操作次數——同一天內重複登入只算一天。改成掛在 auth-session.ts 的 createAuthSession()（每次登入成功時）呼叫新的 recordLoginDay()，account_cultivation 表欄位改為 active_days/last_login_date（舊的 total_actions 欄位保留但不再使用）。9 階門檻改成天數：7/30/90/180/365/730/1460/2555 天。已跑過 ALTER TABLE 遷移確認舊資料庫升級不會壞',
    ],
  },
  {
    version: '3.85.0-xianxia.1',
    date: '2026-08-04',
    changes: [
      'feat(design): [design/xianxia 分支] 新增帳號境界稱號——側邊欄帳號區塊顯示一個小徽章，依累計操作次數自動晉升，靈感取自《凡人修仙傳》修煉境界（練氣期→築基期→金丹期→元嬰期→化神期→煉虛期→合體期→大乘期→渡劫期，共 9 階）。計數來自 addHistory() 每次呼叫時對新增的 account_cultivation 表做 upsert 遞增（operation_history 本身每 7 天會被清空，不能拿來算累計，這張新表永不清除）。新增 GET /api/account/cultivation 端點。純展示用途，不影響任何權限判斷',
    ],
  },
  {
    version: '3.84.0-xianxia.16',
    date: '2026-08-04',
    changes: [
      'fix(design): [design/xianxia 分支] 版面滿版適配 + 背景再調亮——.main-content 原本固定 max-width:1280px（.dashboard-page 想放寬到 1420px 也沒用，父層先卡住），寬螢幕下右側會留一大塊空白；放寬到 1800px，.dashboard-page 改成跟隨父層 100%，一般 1920 螢幕看起來接近滿版。背景圖再調亮一階（頂部不透明度 .16→.04，全黑位置 82%→88%），細節更明顯',
    ],
  },
  {
    version: '3.84.0-xianxia.15',
    date: '2026-08-04',
    changes: [
      'fix(design): [design/xianxia 分支] 兩個全站性樣式漏洞——① 原生 checkbox/radio 全站從未套用主題（系統管理權限表、機台設定測試項目、URL 帳號池彈窗、Jackpot 監控「發 LARK」等多處都還是瀏覽器原生藍色方塊/圓點），改用 accent-color 重新上色，風險低、涵蓋全站。② `.main-content button:not([class])` 這條「給完全沒有樣式的陽春按鈕一個預設外觀」的規則，background/color 用了 !important，蓋掉所有「用 inline style 依選取狀態切換底色」的分段選擇按鈕（Performance Meter 對帳的 OSM/GCP 來源、Gaming Day/自然日 查詢範圍等），變成不管有沒有選中看起來都一樣、只有滑鼠移過去那瞬間會變色。拿掉 background/color 的 !important，讓真的有自己背景色的按鈕保留原色，只有完全沒設定背景色的按鈕才會落到預設樣式',
    ],
  },
  {
    version: '3.84.0-xianxia.14',
    date: '2026-08-04',
    changes: [
      'fix(design): [design/xianxia 分支] 開關按鈕的圓形滑塊改回統一白色——上一版把 ON 狀態的滑塊改成深色（在亮色軌道上取對比），結果 OFF 狀態的滑塊反而是較亮的灰色，兩者一比看起來像顏色邏輯反了（較亮的滑塊卻是關閉狀態）。改成滑塊不分開關狀態一律白色，只靠軌道顏色（玄月青=開/深灰=關）判斷狀態，符合一般開關元件的慣例',
    ],
  },
  {
    version: '3.84.0-xianxia.13',
    date: '2026-08-04',
    changes: [
      'fix(design): [design/xianxia 分支] 修正登入後第一次進 Dashboard 顯示「監控資料載入失敗：unauthenticated」——App.tsx 原本頁面內容（含 Dashboard）不管有沒有登入都會掛載，AuthLoginModal 只是疊在最上層的浮層，所以 App 一啟動 DashboardPage 就會先發一次注定失敗的 /api/dashboard/summary（此時還沒登入），這次失敗的錯誤會留在畫面上，直到登入完成、下一次 30 秒輪詢才會自動清掉，中間這段時間使用者看到的就是這行過期的錯誤訊息。改成整個頁面內容區塊（main-content 與 Game Show 特例）都包在 globalAccount 判斷內，登入完成前不掛載，避免任何頁面提前打出一定會失敗的已登入限定 API',
    ],
  },
  {
    version: '3.84.0-xianxia.12',
    date: '2026-08-03',
    changes: [
      'fix(design): [design/xianxia 分支] 全站背景圖調亮、AutoSpin/Discord 通知設定的開關按鈕改為高對比——背景原本上到下黑色漸層太重（62% 就幾乎全黑），降低不透明度並把全黑的位置往下推到 82%，垂直取景位置從 18% 調到 28% 帶出更多雲霧樓閣細節；開關按鈕原本 ON/OFF 兩色（藍/深灰）在暗色底下不容易一眼分辨，改成 ON＝發光玄月青、OFF＝明顯深灰，兩者對比拉大，AutoSpinPage.tsx 與 DiscordNotifySettingsPage.tsx 各自獨立的 ToggleSwitch 元件都同步修正',
    ],
  },
  {
    version: '3.84.0-xianxia.11',
    date: '2026-08-03',
    changes: [
      'fix(design): [design/xianxia 分支] 移除重複圖示——.section-title 全站已透過 CSS ::before 自動加上小菱形符印，機台自動化測試「操作流程」與 TestCase 生成「Lark Bitable 欄位結構」兩處另外手動插入 XianxiaIcon，變成同一個標題前面出現兩個圖示。拿掉多餘的手動圖示，保留自動符印即可；MachineTestPage.tsx 移除不再使用的 XianxiaIcon import',
    ],
  },
  {
    version: '3.84.0-xianxia.10',
    date: '2026-08-03',
    changes: [
      'fix(design): [design/xianxia 分支] Dashboard hero 人物立繪淡出改用 mask-image，不再是色塊疊加——原本用一塊「深色→透明」漸層色塊蓋在圖片上，色塊實色跟圖片本身的藍色調疊加後變成看得出來的長方形色差，色塊左右邊界也都是硬邊界；改成直接用 CSS mask-image 淡出圖片本身的透明度，讓 .dashboard-intro 自己的背景直接透出來，才是真正的溶接，沒有額外色塊。已於 1039/1440/2560px 驗證',
    ],
  },
  {
    version: '3.84.0-xianxia.9',
    date: '2026-08-03',
    changes: [
      'feat(design): [design/xianxia 分支] CodeX 完成太玄道樞全站整合——真實 React 元件全面套用（Dashboard/Jira/TestCase/OSM 全工具群/Game Show/Local Agent/歷史/知識庫/Discord 通知/系統管理/登入等），新增 12 枚統一圖示取代單字圖示與 Emoji，移除舊遊戲模式入口。額外修正 Dashboard hero 人物立繪邊緣淡出在窄螢幕斷點沒有跟圖片寬度同步的問題（改用共用 CSS 變數），已於多種螢幕寬度驗證',
    ],
  },
  {
    version: '3.84.0-xianxia.8',
    date: '2026-08-03',
    changes: [
      'feat(design): [design/xianxia 分支] OSM Tools／Game Show 子分頁補齊雙標籤——OSM Tools 12 個子項（靈脈校準/試煉玉簡/幻影勘察/陣圖比對/傀儡監院/靈脈調度/傀儡演武/天財監守/總綱試煉/萬象顯影/天秤校帳/日冊校帳）與 Game Show 3 個子項（幻境勘影/密探竊訊/骰數天算）都加上修仙名稱＋原功能名副標，跟上一版頂層導覽同一套 SubTab.themeLabel 欄位、共用 sidebar-nav-label--dual 樣式（依巢狀層級微調字級）。至此側邊欄全部導覽項目（頂層＋子分頁）皆已套用雙標籤',
    ],
  },
  {
    version: '3.84.0-xianxia.7',
    date: '2026-08-03',
    changes: [
      'feat(design): [design/xianxia 分支] 側邊欄導覽改成雙標籤——主要顯示修仙主題名稱（卷宗管理/試煉手札/靈機巡檢/幻境試煉/傀儡召喚/行跡天錄/藏經閣/靈訊符籙/太玄樞機/天機總覽/陣法設定），下方保留原本功能名當副標（Jira 批量開單/TestCase 生成/OSM Tools/... 等），沉浸感與辨識度兩者兼顧，同事不用重新學一套對照表。新增 Group.themeLabel 欄位 + 共用 NavLabel 元件，7 處側邊欄按鈕統一改用。順手把「AI 模型和 Prompt 設定」按鈕的 陣 Emoji 換成手繪 SVG 齒輪圖示。此次僅涵蓋頂層導覽項目，OSM Tools/Game Show 底下的子分頁名稱尚未套用（子項目較多，留待下一批）',
    ],
  },
  {
    version: '3.84.0-xianxia.6',
    date: '2026-08-03',
    changes: [
      'feat(design): [design/xianxia 分支] 全站字體改用 xianxia-theme.css 同一套字型堆疊——src/index.css 的 body font-family 從 \'Segoe UI\' 領頭改成 \'Noto Sans TC\'/\'Microsoft JhengHei\'/\'PingFang TC\' 領頭（Segoe UI 退到 fallback），跟 CodeX 產出的主題文件一致，中文顯示質感更貼近設計稿，不影響可讀性（都是系統既有字型，沒有新增字型載入）。維持先前決定：動態背景影片先不用，只用靜態背景圖，省資源',
    ],
  },
  {
    version: '3.84.0-xianxia.5',
    date: '2026-08-03',
    changes: [
      'feat(design): [design/xianxia 分支] 全站背景改接 CodeX 生成的太玄道樞背景圖——之前只換了 token 顏色，版面骨架/卡片質感跟原本沒差，看不出修仙感；這次把 public/themes/xianxia/xianxia-dashboard-bg.png 實際接進 .main-content::before（暗色 vignette + 背景圖，取代原本純色空白），光暈疊在圖上面的 ::after。順手修正 dashboard-chip--good/warn 跟 dashboard-event-dot--success/warn 先前忘記接 token、還是硬編碼原生 Tailwind 綠/黃的問題。Dashboard 頁的卡片/面板背景從純色 slate-blue 改成半透明墨色（rgba ink），邊框從藍灰改成中性暖調，跟背景圖銜接更自然。全站生效（main-content 是共用 layout），卡片本身仍不透明（維持全站文字可讀性、不冒險改 section-card 等其他頁面共用的透明度）',
    ],
  },
  {
    version: '3.84.0-xianxia.4',
    date: '2026-08-03',
    changes: [
      'feat(design): [design/xianxia 分支] AutoSpin 執行監控頁套用太玄道樞視覺 + 移除 Emoji 圖示——Agent 選擇卡片改用 hover 浮起+選中青色光暈（.autospin-agent-card）、派工啟動/停止/暫停/繼續按鈕改用玄月青/赤霄紅/古金三色（.cr-btn 系列）、狀態指示全部改成會呼吸的狀態圓點（.cr-status-dot）取代 綠白橙、日誌篩選 pill 與截圖縮圖 hover 光暈（.cr-pill/.autospin-shot）、最新截圖角落加脈動指示。原本 ▶⏹⏸錄更新察刪警失敗通過 等 Emoji 字元全部移除，改成純文字或手繪 SVG 幾何線條圖示（重新整理/搜尋），純樣式改動不動任何資料邏輯/handler',
    ],
  },
  {
    version: '3.84.0-xianxia.3',
    date: '2026-08-03',
    changes: [
      'feat(design): [design/xianxia 分支，原 design/control-room 改名] 視覺方向改為太玄道樞（修仙風）——沿用既有的 token 架構（--cr-cyan/--cr-violet/--cr-emerald/--cr-amber/--cr-rose），把顏色值換成玄月青 #75d7cf / 古金 #c7a96b / 赤霄紅 #df765e，全站共用 class（badge/submit-btn/btn-ghost/step-dot/sidebar active/dashboard-* 等）不用逐一改就自動套用新色。CodeX 已在 public/themes/xianxia/ 產出完整素材（xianxia-theme.css/js、MP4 動態背景、Dashboard 背景圖）與設計文件 docs/xianxia-theme-design.md，後續逐頁整合會參照該文件的 token/動態/Emoji 規則（不用 Emoji 字元，圖示用幾何線條/文字印章/狀態圓點，缺的按鈕圖示交給 CodeX 生成）',
    ],
  },
  {
    version: '3.84.0-control-room.2',
    date: '2026-08-03',
    changes: [
      'feat(design): [design/control-room 分支] Dashboard 頁面套用 Control Room 視覺——KPI 卡片改用 mono 字體 + hover 浮起發光、面板 hover 有青色光暈邊框、進度條改成青紫漸層、事件列表加上依序滑入動畫（尊重 prefers-reduced-motion）、成功/警告事件圓點會呼吸、主標題改漸層文字。純 CSS 改動，JSX/資料邏輯完全沒動（DashboardPage.tsx 本身已經用共用 class 沒有 inline style，只需要改 App.css 的 .dashboard-* 規則）',
    ],
  },
  {
    version: '3.84.0-control-room.1',
    date: '2026-08-03',
    changes: [
      'feat(design): [design/control-room 分支] 新增 Control Room 視覺主題基礎層——青(#22d3ee)+紫(#a78bfa)雙色調 token、全域 keyframes（狀態燈呼吸、連接線填色動畫）、背景環境光暈，套用到既有共用 class（badge/submit-btn/btn-ghost/step-dot/sidebar active 狀態/brand-dot/version-badge），全站自動套用新色調不需逐頁修改。後續逐頁的卡片/KPI/log 面板等客製化樣式交給 Codex 分批處理，不在這次一次性完成',
    ],
  },
  {
    version: '3.83.0',
    date: '2026-08-03',
    changes: [
      'fix(jira): 批量更新狀態沒選目標狀態不再誤標成功——新增 skipped 狀態區分「跳過」與「真的切換成功」，Sheet 回填只算真的成功的列',
      'feat(jira): 批量修改新增處理階段追蹤，防止同一份 Sheet 重複執行造成附件/描述重複疊加',
      'feat(jira): 批量評論 background job 改成持久化到 DB，worker 重啟後能回報明確的中斷進度（已完成幾筆/剩餘幾筆），不再是含糊的 job not found',
      'fix(jira): 批次開單/批次轉換狀態的重任務鎖範圍從「每筆」修正為「整批」（新增 begin/end batch session），避免兩個分頁同時執行時交錯、重複開單；批次轉換狀態原本完全沒上鎖也一併補上',
      'feat(jira): 批量修改送出前重新確認 Issue 是否還存在/可存取，比照批量更新狀態既有的 pre-flight 驗證模式',
      'feat(jira): 批次開單/批次轉換狀態/批量修改補上 Jira API 節流，避免大批量時撞到 rate limit',
      'feat(jira): 批次開單/批量評論/批量修改/批次轉換狀態的歷史紀錄補上實際變更內容（摘要/留言預覽/欄位變更/新增轉換狀態紀錄），不再只有 ok/error',
    ],
  },
  {
    version: '3.82.0',
    date: '2026-08-03',
    changes: [
      'feat(autospin): AutoSpin agent session 改成每 5 秒快照持久化到 DB（新表 autospin_agent_sessions），worker 重啟時優先從 DB 復原，不再需要仰賴 Python 端斷線重連才能恢復——今天部署多次修復重啟 worker，正在跑的 session 每次都要走一次有風險的重連流程，改成直接復原後這個風險大幅降低',
      'feat(heavy-task-guard): 重任務鎖（activeTasks）同步改成開機時從 heavy_tasks 表復原未結束的 row，跟 agentSessions 持久化搭配，session 復原後對應的重任務鎖也一起恢復，不會出現「session 還在跑但鎖已經消失，可能被誤觸發第二個重任務」的縫隙',
      'fix(autospin): AutoSpin agent 斷線重連的成功/失敗訊息改寫進本機檔案 agent-reconnect.log（不只印終端機）——重連失敗當下沒有有效 session，訊息本來就送不到網頁「執行日誌」面板，終端機視窗又常被多台機台的日誌洗版蓋過去很難找，寫成固定檔案之後才能可靠地搜尋確認實際發生過什麼',
    ],
  },
  {
    version: '3.81.0',
    date: '2026-08-03',
    changes: [
      'feat(autospin): 多進程架構新增每台機台心跳機制 + 斷線自動重連——長時間執行下某台機台 process 卡死或終止時，parent 每 20 秒偵測心跳過期/process 已終止，自動重啟該台（最多 5 次），不會再讓一台掛掉後就少了那台的紀錄；wait_for_normal_osm_status() 內最長 15 分鐘的特殊遊戲等待迴圈也會持續更新心跳，不會被誤判成卡死',
    ],
  },
  {
    version: '3.80.1',
    date: '2026-07-31',
    changes: [
      'fix(heavy-task-guard): 重任務鎖 fallback key 改成優先看帳號（body.userLabel / x-user-label header），不再退回用來源 IP——兩個不同帳號的 Local Agent 若剛好在同一個辦公室網路後面（同一個對外 IP），先前會被誤判成同一個操作者，其中一個帳號的重任務鎖擋住另一個帳號，導致連線失敗（Python 端 KeyError: sessionId）；同時 AutoSpin 引擎遇到伺服器拒絕註冊時，改印出實際原因，不再是難懂的 KeyError',
    ],
  },
  {
    version: '3.80.0',
    date: '2026-07-31',
    changes: [
      'feat(autospin): Discord 通知啟用開關/顯示欄位、定時彙總報告啟用開關/間隔/顯示欄位/自訂備註/AI 分析開關，改成依帳號分開設定（新表 autospin_notify_prefs），不同帳號各自決定自己派工的 session 要不要通知、顯示哪些欄位；Webhook URL/標題模板/頁尾文字仍是全員共用',
    ],
  },
  {
    version: '3.79.8',
    date: '2026-07-31',
    changes: [
      'fix(machine-test): Spin 測試遇到面額選擇遮罩（.select-main）會卡滿逾時點不到——這種遮罩點擊不會拋「intercepts pointer events」例外，原本只在例外處理時才 force click 的邏輯完全不會被觸發；改成每次點 Spin 前主動檢查並關閉遮罩（同步 AutoSpin.py 既有作法），iDeck 測試原本局部的關閉遮罩邏輯也抽成共用函式',
    ],
  },
  {
    version: '3.79.7',
    date: '2026-07-31',
    changes: [
      'fix(autospin): 補齊 pause/resume/spin-interval/stream/screenshot 等帶 sessionId 的 agent API 帳號權限檢查，知道別人 sessionId 也無法直接操作/讀取其他操作者的 session（v3.79.6 只修了自動偵測/停止，這批是 Codex review 後補的完整版）',
    ],
  },
  {
    version: '3.79.6',
    date: '2026-07-31',
    changes: [
      'fix(autospin): 執行監控畫面依帳號隔離——「/api/autospin/agent/status」與「停止」改成只認自己帳號派工的 session，不會再自動接上/顯示其他操作者正在跑的機台日誌與截圖，「停止」也不會誤停別人的 session',
    ],
  },
  {
    version: '3.79.5',
    date: '2026-07-31',
    changes: [
      'fix(autospin): 定時彙總報告標題加上 gmid（gameTitleCode），避免機台類型名稱相近（如 RISINGROCKET / RISINGROCKETS）時無法分辨是哪一台機器的卡片',
    ],
  },
  {
    version: '3.79.4',
    date: '2026-07-30',
    changes: [
      'fix(autospin): 定時彙總報告 errcode 明細改成每個一行（Discord 引用格式），有發生時間點的話換行列在下面，不再擠成一長串分號分隔的文字',
    ],
  },
  {
    version: '3.79.3',
    date: '2026-07-30',
    changes: [
      'fix(autospin): 修正多進程架構下 session 遺失後重連會卡死的問題——伺服器重啟時所有機台 process 各自搶著重新登錄，只有第一個成功、其他都被同一個操作者的 heavy-task 鎖擋下（Python 端出現 KeyError: sessionId，永遠重連失敗）；改成偵測到「衝突對象也是 autospin-agent 且已有同 userLabel 的 running session」時直接讓該 process 加入既有 session，不再卡死；同時避免重連加入時把已經在跑的機台 Discord 通知誤蓋回「排隊中」',
    ],
  },
  {
    version: '3.79.2',
    date: '2026-07-30',
    changes: [
      'fix(sysadmin): 「啟用 AI 分析區塊」開關跟文字間距太擠，調整間距',
    ],
  },
  {
    version: '3.79.1',
    date: '2026-07-30',
    changes: [
      'feat(autospin): 定時彙總報告新增「啟用 AI 分析區塊」開關（預設關閉）——關閉時完全不呼叫 Gemini，零額外開銷，避免正式環境長時間跑多台機台時累積 AI 費用',
    ],
  },
  {
    version: '3.79.0',
    date: '2026-07-30',
    changes: [
      'feat(autospin): 定時彙總報告/即時彙報通知新增「帳號 → Discord Tag 對照表」（Discord 通知設定頁）——依 session 是哪個帳號派工啟動的，訊息開頭 @ 對應的人（寫進 content，會真的觸發 Discord 通知，不是塞在 embed 裡不會 ping 的那種）',
      'feat(autospin): errcode 明細新增最近 5 次發生時間點（window.__spinErrTimes），定時彙總報告一併顯示',
      'feat(autospin): 定時彙總報告新增 AI 分析區塊——把統計數字丟給 Gemini，判斷是否異常、哪個時間段可能機器異常導致中斷，best-effort（沒有可用 key/呼叫失敗不影響報告照常送出）',
    ],
  },
  {
    version: '3.78.1',
    date: '2026-07-30',
    changes: [
      'fix(autospin): 多進程啟動改成分批（每台間隔 2 秒），避免同時開多個 Chromium 造成資源尖峰、部分裝置卡住',
    ],
  },
  {
    version: '3.78.0',
    date: '2026-07-30',
    changes: [
      'refactor(autospin): 多機台執行架構改成多進程（每台機台一個獨立 process），取代原本單一 process 內用 for 迴圈輪流服務所有機台的做法——Playwright sync API 官方只支援單執行緒操作，原本機台越多、每台實際被輪到 Spin 的頻率越低，任一台卡住/逾時還會拖慢其他台；改成 machine_worker() 每台各自獨立 sync_playwright + browser + context + page，一台掛掉不影響其他台，停止/暫停透過既有 /should-stop 心跳各自獨立收斂不需跨 process 通訊',
    ],
  },
  {
    version: '3.77.1',
    date: '2026-07-30',
    changes: [
      'fix(autospin): execute_bet_random() 30% 機率命中但畫面上找不到可見元素、或點擊失敗時，新增執行日誌——原本這兩種情況完全不出聲，跟「機率沒中」看起來一樣，無法判斷隨機下注到底有沒有真的嘗試過',
    ],
  },
  {
    version: '3.77.0',
    date: '2026-07-30',
    changes: [
      'refactor(autospin): 隨機下注（BetRandom）XPath 改成完全共用 machine_test_profiles.ideck_xpaths，不再有獨立的 bet_random.json + 「隨機下注」頁面——該欄位當初設計就是要取代這個機制，只是先前一直沒真的接上；已將舊資料一次性遷移進 machine_test_profiles，確認沒有 XPath 遺失',
      'fix(autospin): 移除獨立的 GET/PUT /api/autospin/bet-random 端點與 AutoSpin 頁面的「隨機下注」Tab，機台設定表格的「隨機下注」開關保留，改為說明文字指向機台自動化測試的機種設定檔',
    ],
  },
  {
    version: '3.76.0',
    date: '2026-07-30',
    changes: [
      'feat(autospin): 機台設定列表新增「複製配置」按鈕——帶入既有機台的所有設定（模板/RTMP/隨機下注等）當新機台的起點，只需重新輸入機台類型，不用從頭重新填一次',
    ],
  },
  {
    version: '3.75.0',
    date: '2026-07-29',
    changes: [
      'feat(meter-reconcile): Coin Out 對帳新增「自訂起始時間」（選填 HH:mm）——機台當天有 meter reset 時，可手動輸入實際 reset 時間，只 narrow Game Record／Jackpot Abnormality 查詢起點，EGM Hourly Meter 邊界不受影響；已用 Cartin Gold-2002NCH 2026-07-29 真實案例驗證（15:00 起算後 pass=true, delta=0）',
      'fix(meter-reconcile): 更正先前「gameRecordList 的 dateTime[] 忽略時分秒」的錯誤結論——原本雙重驗證測的是格式差異而非真正縮小時間窗，這支 API 其實真的支援秒級篩選',
    ],
  },
  {
    version: '3.74.1',
    date: '2026-07-29',
    changes: [
      'feat(autospin): 定時彙總報告設定新增「自訂欄位」（選填備註文字，原樣附加在每則報告最下方）與「試 試發送」按鈕——用假資料立即送一則測試彙總報告到 Discord 確認格式與效果，不受啟用開關影響、不影響真實回報邏輯',
    ],
  },
  {
    version: '3.74.0',
    date: '2026-07-29',
    changes: [
      'feat(autospin): 新增定時彙總報告——被動追蹤 errcode 次數（dealGMActionReq 回應）、pinus WebSocket 斷線重連（RECOVER）次數、低餘額離機重進（kickout）次數、CR checks（daily-analysis 按鈕確認事件含「無回應」偵測，60 秒無事件視為異常，不主動點按鈕）、Spin/中獎/總贏分統計，每隔可調間隔（預設 20 分鐘，Agent 心跳即時生效不用重啟）發一則新的 Discord 彙總訊息，跟啟動/結束通知獨立開關；顯示欄位可自訂勾選（server/routes/autospin.ts status-report-settings、server/python/toppath-agent.py maybe_send_status_report）',
      'feat(sysadmin): Discord 通知設定頁新增「定時彙總報告」設定卡片——啟用開關、間隔（分鐘）輸入、欄位勾選、獨立儲存按鈕',
    ],
  },
  {
    version: '3.73.0',
    date: '2026-07-28',
    changes: [
      'feat(egm-daycount): 新增 Game Type 篩選下拉選單（資料來自 /public/gameNameAlias 公開端點），可依機種篩選 Egm DayCount 對帳，三支報表 API 都會套用同一個篩選',
    ],
  },
  {
    version: '3.72.0',
    date: '2026-07-28',
    changes: [
      'feat(egm-daycount): Jackpot Amount 改成真的比對 jackpotRecordList（Jackpot Record 報表）逐筆中獎紀錄加總，不再只是單純顯示；新增「有下注的帳號」彙整表格（按 UserId 跨機台加總 Bet Number/Bet），不用自己從逐筆明細裡挑不重複帳號',
    ],
  },
  {
    version: '3.71.0',
    date: '2026-07-28',
    changes: [
      'feat(egm-daycount): 「Egm DayCount 對帳」從 Performance Meter 對帳頁面內的分頁拆成獨立頁面（OSM Tools → Egm DayCount 對帳），新增「All」全渠道查詢勾選（已用真實 Network request 確認做法是 channelId=0 + isall=true，不是拿掉 playerstudioid 參數）',
    ],
  },
  {
    version: '3.70.1',
    date: '2026-07-28',
    changes: [
      'fix(meter-reconcile): Coin Out 對帳卡片標題改成「EGM Hourly Meter（差異值）」，不再誤標成「EGM Performance Meter」——資料其實是從 EGM Hourly Meter 算差值來的，EGM Performance Meter 那支日報表通常要等到約 15:15 才有當日數據，標題寫錯會誤導使用者',
    ],
  },
  {
    version: '3.70.0',
    date: '2026-07-28',
    changes: [
      'feat(meter-reconcile): 新增「Egm DayCount 對帳」分頁——比對後台 Egm DayCount 彙總報表（gameCount）與 User Detail 逐筆列（playerMachineCount）回推加總是否一致（Total Bet User/Bet Number/Bet Amount/Transfer In-Out/Win Or Lose/Win Lose Ratio），已用真實資料驗證 allPass=true；同時修正 gameCount 的 sumData 與 items[] 範圍不一致的問題（單日查詢改用 items[0]）',
    ],
  },
  {
    version: '3.69.0',
    date: '2026-07-28',
    changes: [
      'feat(autospin): daily-analysis 輪詢新增按鈕健康度追蹤——解析 success_json 事件（is_ideck/is_touch + error + cmd），error≠0 立即印警告（附 cmd 方便定位是哪顆按鈕），累積每 20 次按鈕確認事件印一次「iDeck X/Y 正常，觸屏 X/Y 正常」摘要，不用逐行看原始日誌判斷按鈕是否正常',
    ],
  },
  {
    version: '3.68.1',
    date: '2026-07-28',
    changes: [
      'fix(meter-reconcile): 修正 OSM 公式沒有正確處理「Jackpot Wins 有沒有被併入同一筆 Game Record」的情況——改成 預期 Coin Out = Game Record 總 Win + Attendant Paid JP − Jackpot Wins（兩者互補：沒被 Game Record 吃掉的 Jackpot Wins 會走 Attendant Paid JP），同時驗證 Triple Treasure Pot（Jackpot Wins 走 Attendant Paid JP）與 DFDC3 88 Fortunes（Jackpot Wins 併入 Game Record）兩個相反案例皆 pass',
    ],
  },
  {
    version: '3.68.0',
    date: '2026-07-28',
    changes: [
      'feat(meter-reconcile): 拿掉「查詢小時」輸入（會讓人誤以為 Coin Out 比對能做到小時級精準，但 Game Record 側永遠是整天，兩邊範圍本來就對不齊），改成「查詢範圍」二選一：Gaming Day（本地 06:00~隔天 06:00）／自然日（00:00~24:00），比照 OSM/GCP 後台 EGM Hourly Meter 頁面本身的選項；Coin Out 比對永遠用整天範圍最後一個 bucket，跟 Game Record 的整天加總完全對齊——已用 Dragons-NCH23 2026-07-27（Gaming Day 模式）真實案例驗證，pass=true, delta=0',
    ],
  },
  {
    version: '3.67.3',
    date: '2026-07-28',
    changes: [
      'fix(meter-reconcile): Game Record／Jackpot Abnormality 查詢改用真正的 ISO UTC 時間格式（例如 2026-07-26T22:00:00.000Z），對齊後台 Game Record 頁面實際送出的請求格式，並用正確的 gaming day 邊界（本地 06:00 到隔天 06:00）取代先前的日期字串邊界（先前用純日期字串在 gaming day 頭尾各有約 2 小時的邊界誤差空間）；已測試確認舊有驗證案例（Triple Treasure Pot）仍維持 pass',
    ],
  },
  {
    version: '3.67.2',
    date: '2026-07-28',
    changes: [
      'fix(meter-reconcile): 前端「公式攤開」文字沒有跟上 v3.67.1 的後端公式修正，還在顯示舊的「− Jackpot Wins − Attendant Paid JP」，跟實際算出來的數字對不上，肉眼核對會覺得公式錯誤；改成跟後端一致的「預期 Coin Out = Game Record 總 Win」',
    ],
  },
  {
    version: '3.67.1',
    date: '2026-07-28',
    changes: [
      'fix(meter-reconcile): 修正 OSM 公式誤扣 Jackpot Wins/Attendant Paid JP 的問題——預期 Coin Out 統一為 Game Record 總 Win，OSM/GCP 皆同，不再另外扣減；用 Triple Treasure Pot 2026-07-27 18:00（Jackpot Wins 非 0）真實案例驗證通過（delta=0）',
    ],
  },
  {
    version: '3.67.0',
    date: '2026-07-27',
    changes: [
      'feat(meter-reconcile): Game Record 加總卡片新增「Bet Reward Credits（泥碼下注額）」欄位，取自 gameRecordList sumData.bet_nima（已用真實 API 回應核對過欄位名稱）',
    ],
  },
  {
    version: '3.66.4',
    date: '2026-07-27',
    changes: [
      'fix(autospin): Spin 按鈕被「選面額遮罩」（.select-main，例如 SELECT A DENOMINATION）蓋住時完全沒反應的問題——這種遮罩點擊不會拋例外，只是遊戲收不到，原本的「native click 失敗才 JS 強制點擊」邏輯不會被觸發，等滿 8 秒仍判定 timeout_8s；完整移植 machine-test/runner.ts 的 dismissDenomOverlay() 邏輯，do_spin() 開頭先偵測並點掉這個遮罩（點第一個選項）再找 Spin 按鈕',
    ],
  },
  {
    version: '3.66.3',
    date: '2026-07-27',
    changes: [
      'ux(autospin): 執行監控（遠端 Agent 模式）控制區依 mockup 方向合併成一個緊湊區塊——原本 Agent 選擇/LuckyLink JP 比對/按鈕列/Spin 間隔各自獨立有外框的 4 個區塊，改成同一個容器內用細分隔線區分，Spin 間隔併進按鈕列同一行，整體堆疊高度變矮，日誌面板可以佔到更多空間',
    ],
  },
  {
    version: '3.66.2',
    date: '2026-07-27',
    changes: [
      'ux(autospin): 執行監控（run tab）改成固定視窗高度＋內部 flex 撐滿，不再讓整個頁面往下捲很長一段才看到執行日誌——根因是上層 .main-content/.app-main 只有 min-height（會隨內容長高），下面既有的 flex:1/overflow:hidden 一直沒有實際邊界可撐滿；只加高度邊界在 run tab 自己身上，不動全域版面，其他分頁不受影響',
    ],
  },
  {
    version: '3.66.1',
    date: '2026-07-27',
    changes: [
      'fix(autospin): daily-analysis 輪詢查詢失敗（網路連不到 API、逾時、非 200）先前會整個吞掉不出聲，導致「完全沒有效果」時很難排查是不是這台 Agent 的網路連不到 qat/prod-osmtrace.osmslot.org；現在失敗時每 60 秒印一次警告到執行日誌',
    ],
  },
  {
    version: '3.66.0',
    date: '2026-07-27',
    changes: [
      'feat(autospin): 新增 QAT/PROD 日誌 API（daily-analysis）同步——AutoSpin 遊玩期間會每 5 秒背景輪詢對應機台的 daily-analysis 時間軸，把新出現的日誌印到執行日誌（[machineType][daily-analysis] 時間 type 內容），跟 Machine Test 用同一支 API；機台設定表單新增「日誌 API 環境」QAT/PROD 選項（預設 QAT）',
    ],
  },
  {
    version: '3.65.4',
    date: '2026-07-24',
    changes: [
      'fix(autospin): 修正 wait_for_span_text() 誤判觸屏元素找不到的問題——觸屏測試用的 .screen-touch 疊加層 span 完全透明，Playwright 的 is_visible() 對這種 span 一律回傳 False（machine-test/runner.ts 的 waitForSpanText() 早已針對這點特別處理、只檢查元素是否存在），但 AutoSpin 這邊的 Python 版本先前多檢查了 is_visible()，導致 entryTouchPoints/bonusAction touchscreen 的座標點永遠找不到元素、全部略過，現在移除該檢查對齊 Machine Test 行為',
    ],
  },
  {
    version: '3.65.3',
    date: '2026-07-24',
    changes: [
      'fix(autospin): 偵測 Spin 請求被遊戲伺服器直接拒絕的情況（例如 errcode:100「請求超時或未確認錯誤」）——這種情況下按鈕 disabled 切換、餘額更新兩個完成訊號都不會觸發，先前會傻等滿 8 秒才逾時，現在偵測到拒絕會立即中斷並記錄真正原因；同時避免這種情況被誤判為「連續無變化→特殊遊戲」而亂執行 bonusAction',
    ],
  },
  {
    version: '3.65.2',
    date: '2026-07-24',
    changes: [
      'fix(autospin): 機種設定檔（spinSelector/balanceSelector/entryTouchPoints/bonusAction/touchPoints/clickTake）的對應改用 Game Title Code 中段（例如 "873-DFDC-0003" 取 "DFDC"），不再用使用者手打、格式不受控的機台類型欄位，避免拼字/大小寫不同導致對不到 Machine Test 那邊的機種設定',
    ],
  },
  {
    version: '3.65.1',
    date: '2026-07-24',
    changes: [
      'ux(autospin): 機台設定列表新增「隨機下注」「隨機離開」欄位，跟「錄影」「模板偵測」一起改成可直接點擊切換的開關按鈕（比照原本「啟用」的做法），不用點進編輯視窗；編輯表單移除這 4 個重複的勾選框',
    ],
  },
  {
    version: '3.65.0',
    date: '2026-07-24',
    changes: [
      'feat(autospin): 新增 Spin 前後餘額記錄，算出每次輸贏差額並記錄在執行日誌',
      'feat(autospin): 新增 OSMWatcher 特殊遊戲偵測 + bonusAction 執行（spin/takewin/touchscreen/auto_wait），行為對齊 Machine Test 的 checkOsm 機制，只讀取共用的 osmMachineStatus 資料源，未修改 Machine Test 程式碼',
      'feat(autospin): 新增相容 fallback ——沒有 OSMWatcher 資料時，連續 10 次 Spin 餘額都沒變化就自動判斷為特殊遊戲並執行 bonusAction',
    ],
  },
  {
    version: '3.64.2',
    date: '2026-07-24',
    changes: [
      'fix(local-agent): Windows install.bat 的 AutoSpin Python 依賴安裝結果改成明顯警告框 + 安裝完成摘要再提醒一次（原本只有一行灰字容易被洗掉），並改成實際驗證 python -c "import playwright" 是否成功，不是只檢查 pip 有沒有找到',
    ],
  },
  {
    version: '3.64.1',
    date: '2026-07-24',
    changes: [
      'fix(local-agent): Windows 安裝腳本改用 curl 下載 source files/agent.py，取代原本的 PowerShell Invoke-WebRequest —— 後者在部分環境會把含中文註解的 .py 檔用錯誤編碼寫入，導致 toppath-agent.py 出現 "Non-UTF-8 code" SyntaxError、AutoSpin 完全無法啟動。已受影響的機器可直接到「Local Agent」頁面點「更新 source files」修復（該路徑本來就是用 Node fetch，不受影響），不用重新安裝',
    ],
  },
  {
    version: '3.64.0',
    date: '2026-07-23',
    changes: [
      'feat(osm): 新增「Performance Meter 對帳」頁籤（OSM Tools）—— 比對 OSM/GCP EGM Metering 的 Coin Out 與 Game Record + Jackpot Abnormality 加總算出的預期值是否完全一致，一次性手動查詢（機台名稱 + 來源 + 日期/小時），三邊資料並排顯示、公式攤開、原始欄位除錯表；OSM/GCP 兩組後台憑證分開設定',
    ],
  },
  {
    version: '3.63.2',
    date: '2026-07-21',
    changes: [
      'perf(autospin): console.warn/error 攔截改用便宜的 String() 轉換取代 JSON.stringify（避免遊戲若印出大型物件時佔用遊戲本身主執行緒時間），並把 pinus 與 console 的日誌輪詢合併成單一 evaluate，取消原本各自掃一輪 frame 的作法，減少每 2 秒對 Playwright 的往返次數，降低 v3.63.0 新增 console 攔截後可能造成的 Spin 節奏變慢',
    ],
  },
  {
    version: '3.63.1',
    date: '2026-07-21',
    changes: [
      'feat(autospin): 每次 Spin 完成後新增診斷日誌，記錄實際耗時與判定訊號（button_disabled_toggle / coin_update / timeout_8s），方便分辨「還是偵測卡住等滿 8 秒」還是「這台機台本身動畫/結算就是這麼久」',
    ],
  },
  {
    version: '3.63.0',
    date: '2026-07-21',
    changes: [
      'fix(autospin): 執行日誌 SSE 連線斷線後（例如伺服器/worker 重啟）原本不會自動重連，畫面會停在最後一筆日誌不再更新；改成斷線 2 秒後自動重連並清空重新接收，不用整頁重新整理',
      'feat(autospin): 新增瀏覽器 console.warn/console.error 攔截（WebSocket 斷線、502、"Game exception" 等遊戲端原生報錯），導進執行日誌歸類為錯誤/警告，之前這類資訊完全沒被記錄',
    ],
  },
  {
    version: '3.62.3',
    date: '2026-07-21',
    changes: [
      'feat(autospin): 執行日誌的「隱藏 pinus」單一開關改成 7 類分別勾選（Spin 動作/餘額異動/狀態廣播/進入遊戲/連線登入/心跳列表/其他），可以只看想看的 pinus 訊息類型，不用全部展開或全部收合',
    ],
  },
  {
    version: '3.62.2',
    date: '2026-07-21',
    changes: [
      'fix(autospin): v3.61.4 新增的「每 10 秒回報進度」呼叫 post_history() 時是同步阻塞的網路請求，等於又把 Spin 迴圈跟網路 I/O 卡在一起，重現類似先前 pinus 日誌拖慢節奏的問題；連同 send_screenshot()/send_lark() 一起全部改成背景執行緒非同步呼叫，主 Spin 迴圈不再被任何回報用的網路請求卡住',
    ],
  },
  {
    version: '3.62.1',
    date: '2026-07-21',
    changes: [
      'fix(autospin): Spin 按鈕被上層元素（選面額面板、宣傳彈窗等）攔截時，改用 JS click() 直接觸發下層按鈕本身，取代原本用真實滑鼠座標硬點（force click）容易誤點到上層的問題',
    ],
  },
  {
    version: '3.62.0',
    date: '2026-07-21',
    changes: [
      'fix(autospin): 修正執行監控頁日誌框 CSS 少了 minHeight:0，flex 排版鏈斷掉導致框高失控、把整個頁面往下撐開；改好後日誌固定在面板高度內，只有框內捲動',
      'feat(autospin): 執行日誌新增分類篩選 chips（全部/系統/Spin/截圖/錯誤警告）+ 關鍵字搜尋 + 自動捲到底開關 + 清空按鈕；預設隱藏 pinus 監控雜訊（每次 Spin 平均 5~6 行 pinus 封包，佔日誌 9 成以上），可一鍵展開',
      'feat(autospin): 截圖監控改為 2 欄縮圖網格（原本每張獨占一列），最新一張標示「最新」，縮圖角落顯示 Spin 數與相對時間',
    ],
  },
  {
    version: '3.61.4',
    date: '2026-07-21',
    changes: [
      'fix(autospin): 修正部分機台（如 RISINGROCKETS）Spin 按鈕動畫全程不切換 disabled 屬性，導致每次 Spin 固定卡滿 8 秒才返回的問題 —— 改為按鈕 disabled→enabled 或 pinus coin 更新兩個訊號取先到者，大幅縮短實際 Spin 間隔（此為真正拖慢節奏的原因，先前 v3.61.3 的日誌背景佇列修正並未解決此問題）',
      'fix(autospin): Discord 通知的 Spin 數原本只跟著截圖週期（每 20 次）更新，短時間測試會一直卡在 0；改為獨立每 ~10 秒回報一次進度，不受截圖週期影響',
    ],
  },
  {
    version: '3.61.3',
    date: '2026-07-21',
    changes: [
      'fix(autospin): Local Agent 端日誌上傳（含 pinus 監控訊息）改成背景執行緒佇列批次非同步上傳，不再逐行同步 POST 卡住主 Spin 迴圈 —— 修正 pinus 日誌量大時拖慢機台操作節奏的問題',
    ],
  },
  {
    version: '3.61.2',
    date: '2026-07-21',
    changes: [
      'feat(autospin): Discord 通知設定頁新增「訊息格式」設定 —— 可勾選要顯示的欄位（Spin數/Game URL/錯誤摘要/截圖連結）、自訂訊息標題模板（支援 {machineType} 佔位符）、自訂頁尾文字，右側預覽即時同步',
    ],
  },
  {
    version: '3.61.1',
    date: '2026-07-21',
    changes: [
      'feat(autospin): Discord 通知設定頁新增「啟用通知」開關，關閉後即使 Webhook URL 有設定也不會發送，不用清空網址就能暫停/恢復',
    ],
  },
  {
    version: '3.61.0',
    date: '2026-07-20',
    changes: [
      'feat(autospin): 新增 Discord 即時彙報通知 —— AutoSpin 每台機台開始測試時發一則 Discord 訊息，之後同一則訊息隨狀態更新（排隊中/執行中/已完成/失敗/已停止），不會洗版；訊息含機台、Game URL、Spin 數、錯誤摘要、截圖連結',
      'feat(sysadmin): 新增「Discord 通知」設定頁（後台系統頁面），可設定/測試 Webhook URL，不寫死頻道，換頻道只需改 URL；已加入權限矩陣（discord-notify page key）',
    ],
  },
  {
    version: '3.60.8',
    date: '2026-07-20',
    changes: [
      'feat(autospin): 機台設定表單的 Game URL 欄位新增「冊 從帳號池選取」按鈕，跟 Machine Test 大廳 URL 同一套 UrlPoolPickerModal（已抽成共用元件 src/components/UrlPoolPickerModal.tsx），不用再手動複製貼上帶 token 的長網址',
    ],
  },
  {
    version: '3.60.7',
    date: '2026-07-20',
    changes: [
      'feat(autospin): 執行監控的截圖監控新增點擊放大預覽（沿用既有 lightbox），並修正遠端 Agent 模式截圖縮圖網址錯誤（原本打錯路徑導致一直是壞圖，改用正確的 /api/autospin/agent/screenshot/:id/:name）',
      'feat(autospin): 伺服器端 fallback 模式的截圖資料夾（stream_captures/screenshots）新增定時清理，超過 48 小時的檔案在讀取截圖清單時自動刪除，避免硬碟持續累積',
    ],
  },
  {
    version: '3.60.6',
    date: '2026-07-20',
    changes: [
      'ux(autospin): 移除編輯機台表單裡的「啟用」勾選框（已改用列表上的開關按鈕切換，表單裡留著是重複的）',
    ],
  },
  {
    version: '3.60.5',
    date: '2026-07-20',
    changes: [
      'ux(autospin): 機台設定列表「啟用」欄改為可直接點擊的開關按鈕（切換即送出，不用進編輯視窗），失敗會自動還原',
    ],
  },
  {
    version: '3.60.4',
    date: '2026-07-20',
    changes: [
      'fix(autospin): Join 按鈕點擊邏輯改為與 Machine Test 完全同步 — 原本用 Playwright :text() 子字串比對+DOM順序第一個+一般 click()，容易誤中其他含 Join 文字的按鈕、或點到不可見元素而卡住；改為文字須完全等於「Join」、逐一找第一個可見的、並用 JS evaluate click 繞過 pointer-events 攔截',
    ],
  },
  {
    version: '3.60.3',
    date: '2026-07-20',
    changes: [
      'fix(autospin): 進入機台時新增清除已知浮動彈窗步驟（Game Preview/Jackpot 宣傳面板等），完整移植自 machine-test/runner.ts CCTV 步驟的 overlay/close-btn selector（原本只在 CCTV 步驟用，範圍窄不會誤點遊戲 UI），解決部分機種（如 RISINGROCKETS）沒有 entryTouchPoints 設定時被宣傳面板卡住的問題',
    ],
  },
  {
    version: '3.60.2',
    date: '2026-07-20',
    changes: [
      'fix(autospin): enter_game() 每個子步驟都加上開始/結束與耗時 log（等待頁面穩定、大廳列表載入、找卡片、點擊、Join、進入觸屏、enterGMNtc 確認），方便追蹤整段進入流程實際花的時間與卡在哪一步',
    ],
  },
  {
    version: '3.60.1',
    date: '2026-07-20',
    changes: [
      'fix(autospin): 移除大廳廣告/公告彈框自動關閉邏輯（dismiss_popups），依需求不再需要',
    ],
  },
  {
    version: '3.60.0',
    date: '2026-07-20',
    changes: [
      'fix(autospin): 進入機台流程改為與 Machine Test 完全同步 — Python 引擎新增讀取機種設定檔的 entryTouchPoints/entryTouchPoints2 兩階段進入觸屏處理（原本沒有機種專屬彈框/選面額處理，需手動點掉），並加上 enterGMNtc WebSocket 事件確認進入成功',
      'fix(autospin): Spin 點擊與餘額讀取改為與 Machine Test 完全同步 — 改用 pinus WebSocket 攔截讀取餘額（window.__lastCoin），取代已停用的 DOM selector 邏輯；Spin 按鈕改用相同 selector fallback chain，點擊加上 overlay 攔截 force click 補救與動畫完成輪詢',
      'feat(autospin): 新增 pinus 訊息監控 — 攔截 window.pinus.request/on 的所有 request/response/push 訊息並定期轉發到執行日誌（每台機每 2 秒批次），不只讀 coin 欄位',
    ],
  },
  {
    version: '3.59.3',
    date: '2026-07-20',
    changes: [
      'fix(jira-comment): 批量評論刪除附件縮圖時，一併呼叫新增的 DELETE /api/jira/attachment-cache/:cacheId 立即刪除暫存檔案，不用等 2 小時 TTL 清理，避免磁碟容量持續增加',
    ],
  },
  {
    version: '3.59.2',
    date: '2026-07-20',
    changes: [
      'feat(jira-comment): 批量評論預覽表附件縮圖新增「×」刪除按鈕（圖片/影片/失敗附件皆可），誤上傳或誤帶入錯誤圖片時可直接移除，不需重新整理整批附件',
    ],
  },
  {
    version: '3.59.1',
    date: '2026-07-20',
    changes: [
      'fix(jira): 重新讀取 Sheet 按鈕從共用頂部步驟列改為各 Tab 各自獨立（含各自的 loading/成功訊息狀態），修正切換 Tab 後殘留其他 Tab「已重新讀取」訊息的問題',
      'ux(jira): 批量開單重新讀取 Sheet 按鈕移到 Step 3「從 Lark 帶入」同一列；重新讀取後（含 Step 2 首次進入 Step 3）自動套用 Lark 帶入，不需再手動點一次',
    ],
  },
  {
    version: '3.59.0',
    date: '2026-07-20',
    changes: [
      'feat(jira): 批量開單/批量評論/批量修改/批量更新狀態 新增「更新 重新讀取 Sheet」按鈕（顯示於 Step 2 以後，位於頂部步驟列），可在操作到一半時重新拉取最新 Sheet 資料，不會切換 step 或清空已選取/已填寫內容，僅同步新增/移除的列',
    ],
  },
  {
    version: '3.58.4',
    date: '2026-07-20',
    changes: [
      'fix(jira): 批量開單 Step 3 動態欄位表格，用搜尋選一位使用者後，同一欄位其他列（或其他人員欄位）全部顯示成 accountId 亂碼 — userOptionsForField 原本只要 field.options 有任何值就完全不 fallback 回 members 清單，改為 field.options 與 members 合併（去重），不再互斥',
    ],
  },
  {
    version: '3.58.3',
    date: '2026-07-17',
    changes: [
      'fix(jira): batch-fetch-fields 抓不到部分 Issue 欄位（如摘要/受託人/RD負責人 全部顯示空白）— JQL 搜尋（/rest/api/3/search/jql）預設不會回傳已封存（archived）Issue，但直接 GET 該單號可以；改為對 JQL 搜尋漏掉的單號，額外逐一用直接 GET 補查，兩邊結果合併',
    ],
  },
  {
    version: '3.58.2',
    date: '2026-07-17',
    changes: [
      'fix(jira): 操作說明卡片與下方功能按鈕貼太近 — StepGuide 補上 marginBottom + maxWidth/word-break，統一影響全部 14 個步驟，同時避免長文字內容爆版',
    ],
  },
  {
    version: '3.58.1',
    date: '2026-07-17',
    changes: [
      'ux(jira): 批量開單/批量評論/批量修改/批量更新狀態 四個功能共 14 個步驟，全部新增可摺疊的「操作說明」卡片（沿用既有 jira-sheet-guide 視覺風格）；批量開單 Step 2 的 Sheet 欄位說明表格內容更新為目前實際必填欄位（描述/受託人/RD負責人/回報人），並補上 Jira URL/處理時間/單子標題貼這 自動欄位',
    ],
  },
  {
    version: '3.58.0',
    date: '2026-07-17',
    changes: [
      'feat(jira): 批量評論、批量修改、批量更新狀態 三個 Tab 新增 Lark / Google Sheets 資料來源切換（與批量開單 Step 2 相同的版面與按鈕風格），Google Sheets 端一併補上 includeCreated 篩選邏輯以支援已開單資料的讀取',
    ],
  },
  {
    version: '3.57.19',
    date: '2026-07-16',
    changes: [
      'fix(jira): 批量開單進度條改為前端逐筆呼叫（每次 rows 陣列長度為 1），取代 POST+SSE inline stream — 與批量轉換狀態/批量修改/批量更新狀態同一套可靠模式，避免 Nginx 對 POST 回應緩衝導致進度不更新',
      'fix(jira): batch-create 移除 heavyLimiter（每分鐘 15 次上限），改為逐筆呼叫後大批次不會被卡住；欄位 metadata 改用既有 fieldMetaCache（10 分鐘快取）避免每筆重複查詢',
      'fix(jira): 批量更新狀態（QA子Tab）新增進度條 — 改為前端逐筆呼叫 /api/jira/bulk-update，每筆完成後更新 done/total 計數，與批量轉換狀態/批量修改一致',
    ],
  },
  {
    version: '3.57.17',
    date: '2026-07-16',
    changes: [
      'fix(jira): 批量開單進度條改為 SSE 即時更新 — server 每完成一筆 row 發 progress 事件，client 用 stream reader 解析；修正 wbWrites 作用域錯誤（宣告在 if block 內導致 fire-and-forget 無法存取）',
    ],
  },
  {
    version: '3.57.16',
    date: '2026-07-15',
    changes: [
      'fix(jira): 批量開單 Lark 回填改為非同步（fire-and-forget）— 原本 server 端在 HTTP 回應前同步跑完所有 row 的 Lark 寫入（N×5 API calls），大批次導致回應延遲數分鐘且 client 也重複呼叫；現在立即回傳結果讓 client 接手回填，server 端寫入改為背景執行',
    ],
  },
  {
    version: '3.57.15',
    date: '2026-07-15',
    changes: [
      'feat(jira): 批量更新狀態預覽表新增「察 偵測 RD 欄位」按鈕，掃描 Issue 所有 custom user fields 並顯示 fieldId / 欄位名稱 / 目前值',
    ],
  },
  {
    version: '3.57.14',
    date: '2026-07-15',
    changes: [
      'fix(jira): batch-fetch-fields 偵測所有同名 "RD負責人" custom field（Jira 可能有多個），依序 fallback 取有值的那個；確認 HTRL 專案實際用 customfield_13322',
    ],
  },
  {
    version: '3.57.13',
    date: '2026-07-15',
    changes: [
      'fix(jira): batch-fetch-fields 改為動態偵測 RD負責人欄位 ID（呼叫 /rest/api/3/field 查名稱），不再硬編 customfield ID，兼容所有 Jira 專案',
    ],
  },
  {
    version: '3.57.12',
    date: '2026-07-15',
    changes: [
      'fix(jira): AI 生成摘要 BATCH_DELAY_MS 從 1200 拉到 2500，減少 Gemini 429 機率',
      'fix(jira): AI 生成摘要完成後顯示失敗筆數（原本靜默跳過失敗行）',
    ],
  },
  {
    version: '3.57.11',
    date: '2026-07-15',
    changes: [
      'fix(jira): AI 生成摘要由 Promise.all 改為批次處理（每批 3 筆、間隔 1.2 秒），避免 Gemini 429 RESOURCE_EXHAUSTED',
    ],
  },
  {
    version: '3.57.10',
    date: '2026-07-15',
    changes: [
      'fix(osm): LuckyLink Bg Client 版本 API 已支援 — 新增 index 3 的對應，顯示實際版號取代「待 API 支援」',
    ],
  },
  {
    version: '3.57.9',
    date: '2026-07-09',
    changes: [
      'fix(jira): Lark 回填新欄位位置計算錯誤 — Lark API 回傳 A1:ZZ2 完整 702 欄，導致 headers.length=702 把新欄往第 703 欄塞；改為從最後一個有值的 header 往後一格開始新增，並以 nextAppendColIdx 遞增追蹤同批次多欄情況',
    ],
  },
  {
    version: '3.57.8',
    date: '2026-07-09',
    changes: [
      'fix(jira): Lark 回填 colIndexToLetter 修正 — 舊版只支援到 ZZ（702欄），第 703 欄產生非法字元「[A」導致 Lark API 90202 錯誤；改用正確的 base-26 轉換，支援 AAA、AAB… 無限欄位',
    ],
  },
  {
    version: '3.57.7',
    date: '2026-07-09',
    changes: [
      'fix(jira): 批量更新狀態 RD負責人始終空白 — batch-fetch-fields 修正兩個根本問題：(1) 搜尋 endpoint 從 /rest/api/2/search/jql（不存在）改為 /rest/api/3/search/jql；(2) RD負責人 custom field ID 從 customfield_10428 更正為 customfield_14103（CCRS 專案實際 ID）',
    ],
  },
  {
    version: '3.57.6',
    date: '2026-07-09',
    changes: [
      'fix(jira): 批量更新狀態 RD負責人再次誤判為空 — Jira API v2 回傳使用者物件為 name 而非 displayName，改為同時讀取 displayName → name fallback',
    ],
  },
  {
    version: '3.57.5',
    date: '2026-07-02',
    changes: [
      'feat(jira): 批量開單、批量更新狀態、批量修改 新增進度條 — 提交時顯示處理中 X/N 與動畫填充（與批量評論模式一致）',
    ],
  },
  {
    version: '3.57.4',
    date: '2026-07-01',
    changes: [
      'feat(autospin): JP Group 環境選擇改為三按鈕（QAT/UAT/PROD），選擇後自動填入對應 URL 與帳密預設值；新增 QAT Group（luckylink-backendserver.osmslot.org, admin/123456）',
    ],
  },
  {
    version: '3.57.3',
    date: '2026-07-01',
    changes: [
      'fix(autospin): luckylink-poller 修正 poolamount 單位 — rawValue（micro-PHP）÷ 1,000,000 + basevalue = 顯示金額（PHP）；新增 basevalue/maxValue/overageValue 欄位；前端 JP 面板改顯示 ₱ 格式金額',
    ],
  },
  {
    version: '3.57.2',
    date: '2026-07-01',
    changes: [
      'fix(autospin): luckylink-poller 改用 API 直連（取代 Playwright 截圖）— POST /auth/login + /auth/permissionInfo + /progressives/levelsListData，支援 Bearer token / Cookie / query token 三種驗證方式，自動 401 重登，DEBUG log 顯示首次 raw response 方便調整欄位名稱',
    ],
  },
  {
    version: '3.57.1',
    date: '2026-07-01',
    changes: [
      'fix(autospin): Phase 5 — LuckyLink SSE 重連補發；AgentSession 新增 luckylinkPoolSnapshot/luckylinkAlerts，broadcastLuckylinkEvent 同步更新；SSE stream 連線時自動 replay luckylink_start + 最新 pool + 告警，前端重整或斷線後面板不再空白',
    ],
  },
  {
    version: '3.57.0',
    date: '2026-07-01',
    changes: [
      'feat(autospin): Phase 4 — LuckyLink 實機閉環驗證 + UI 告警化；worker 同步發 structured SSE luckylink_event；AutoSpin 右側新增 JP 監控面板（pool 值、增減顏色、告警列表）；poller diff 附帶 matchedGameCodes，gameCodes 無匹配時發 warn alert',
    ],
  },
  {
    version: '3.56.1',
    date: '2026-07-01',
    changes: [
      'fix(autospin): Phase 3.1 — worker.ts 補上 luckylink_event 處理並轉發 broadcastAgentLog；agent-runner 將 gameCodes 以 LL_GAME_CODES 傳入 poller；luckylink-poller.mjs 在 start/pool 事件附帶 gameCodes',
    ],
  },
  {
    version: '3.56.0',
    date: '2026-07-01',
    changes: [
      'feat(autospin): Phase 3 — JP Group 新增 login_user/login_pass 欄位（DB migration + CRUD + UI）；新增 server/luckylink-poller.mjs（Playwright 輪詢 JP 獎池，結構化 JSON 事件印 stdout）；agent-runner 收到 luckylinkConfig.enabled 時 spawn poller，stop 時一併終止',
    ],
  },
  {
    version: '3.55.2',
    date: '2026-07-01',
    changes: [
      'fix(autospin): hub-dispatch luckylinkConfig 後端 validation — enabled=true 缺 jpGroupCode 回 400，pollIntervalSec 非數字回 400，合法值自動 clamp 至 10–3600s',
    ],
  },
  {
    version: '3.55.1',
    date: '2026-07-01',
    changes: [
      'feat(autospin): Phase 2 — hub-dispatch 帶入 luckylinkConfig（從 DB 解析 JP Group 完整資料），AutoSpin 執行監控新增 LuckyLink JP 比對開關＋JP Group 下拉＋輪詢間隔設定',
      'fix(autospin): fetchJpGroups / handleSaveJpGroup / handleDeleteJpGroup 加 try/catch 防網路錯誤',
    ],
  },
  {
    version: '3.55.0',
    date: '2026-07-01',
    changes: [
      'feat(autospin): 新增 JP Group 設定功能 — 管理 LuckyLink JP 群組（代碼/名稱/環境/URL/GroupName/GameCodes），供 AutoSpin LuckyLink 壓測使用；DB 新增 jp_groups 表；AutoSpin 頁面新增「JP Group」Tab',
    ],
  },
  {
    version: '3.54.29',
    date: '2026-06-29',
    changes: [
      'fix(jira): reconcile/preview 加入 Lark API 回應防護 — 非 2xx / 非 JSON（token 過期等）顯示明確錯誤，不再拋出 SyntaxError',
    ],
  },
  {
    version: '3.54.28',
    date: '2026-06-28',
    changes: [
      'ux(jira): 補回填工具改為預設折疊，批量開單時不干擾主流程；有 pending/failed 記錄時顯示警示；工具展開後才顯示內容',
    ],
  },
  {
    version: '3.54.27',
    date: '2026-06-28',
    changes: [
      'fix(jira): reconcile/apply 及 pending-writebacks/retry 補上 userJiraAuth 檢查，防止未登入觸發 Lark 回寫',
      'fix(jira): 全選 checkbox 只選高信心配對，不把低信心也帶進去',
    ],
  },
  {
    version: '3.54.26',
    date: '2026-06-28',
    changes: [
      'fix(jira): 對帳補回填低信心配對不預設勾選，避免寫錯 Jira Key',
      'fix(jira): reconcile/preview 改讀 A1:ZZ2（與 multiWritebackLark 一致），修正雙列表頭找不到欄位問題',
      'fix(jira): 舊版 DB 補建 UNIQUE INDEX + 刪除既有重複 pending_writebacks 記錄',
    ],
  },
  {
    version: '3.54.25',
    date: '2026-06-28',
    changes: [
      'feat(jira): 新增「回寫狀態 / 補回填」面板 — 查看 pending/failed 記錄、全部重試；新增對帳補回填工具（查詢 Jira + Sheet 空列位置比對，可勾選後寫回）',
    ],
  },
  {
    version: '3.54.24',
    date: '2026-06-28',
    changes: [
      'fix(jira): pending_writebacks 加入 UNIQUE(sheet_url,row_index,jira_key) 防止重複插入，新增 attempt_count 追蹤重試次數，ALTER TABLE 相容既有 DB',
    ],
  },
  {
    version: '3.54.23',
    date: '2026-06-28',
    changes: [
      'feat(jira): 批次開單加入 pending writeback queue — 開單成功後立即存 DB，斷線也不遺失；server 端嘗試即時回寫，失敗則保留 pending；Step 4 顯示「重試回寫」按鈕',
      'feat(jira): 新增 GET /api/jira/pending-writebacks 及 POST /api/jira/pending-writebacks/retry 端點，支援補回填失敗紀錄',
    ],
  },
  {
    version: '3.54.22',
    date: '2026-06-28',
    changes: [
      'fix(jira): Lark 回寫欄位新增時改為永遠 append 到最後，不再 reuse 中間空欄，避免覆蓋原本有資料的欄位',
    ],
  },
  {
    version: '3.54.21',
    date: '2026-06-26',
    changes: [
      'fix(machine-test): 移除設定檔 gmid fallback 比對，強制只用 machine-code（中段全大寫）或 enterMachineType 命中，避免誤選設定檔',
    ],
  },
  {
    version: '3.54.20',
    date: '2026-06-26',
    changes: [
      'fix(machine-test): CCTV overlay 清除改為最多重試 3 輪，優先點擊 close/OK 按鈕而非 overlay 本體，縮窄 selector 避免誤點遊戲 UI',
    ],
  },
  {
    version: '3.54.19',
    date: '2026-06-26',
    changes: [
      'fix(machine-test): CCTV 步驟截圖前自動清除浮動彈窗/動畫 overlay（div.bg / popup / dialog 等），再按 Escape fallback，確保比對畫面不被遮擋',
    ],
  },
  {
    version: '3.54.18',
    date: '2026-06-26',
    changes: [
      'fix(machine-test): Spin click 加 overlay 攔截 fallback — 遇到 intercepts pointer events 時自動改用 force click，避免 DFDC 等遊戲的動畫 overlay 卡死',
    ],
  },
  {
    version: '3.54.17',
    date: '2026-06-26',
    changes: [
      'fix(machine-test): Spin 按鈕點擊改用 Playwright 原生 elementHandle.click()（修正 DFDC 等用 pointer 事件的遊戲無法觸發 Spin）',
      'feat(machine-test): pinus tracker 新增 __coinUpdatedAt 時間戳，per-spin 記錄 coin 前後變化，post-spin 診斷同步輸出',
    ],
  },
  {
    version: '3.54.16',
    date: '2026-06-26',
    changes: [
      'feat(machine-test): Spin 測試改用 pinus WebSocket 攔截讀取餘額（window.__lastCoin），移除已失效的 DOM selector 邏輯',
    ],
  },
  {
    version: '3.54.15',
    date: '2026-06-25',
    changes: [
      'fix(jira): writeback-multi 加 fallback — URL/richtext 格式若被 P 欄型態拒絕（90204），自動改用純文字重試',
    ],
  },
  {
    version: '3.54.14',
    date: '2026-06-25',
    changes: [
      'fix(jira): 確認 Lark Sheets v2 API 不支援 richText，改回 URL cell（整格超連結）寫入 P 欄',
    ],
  },
  {
    version: '3.54.13',
    date: '2026-06-25',
    changes: [
      'feat(jira): 單子標題貼這改用 Lark Sheets v3 rich text API — Issue Key 超連結 + 摘要純文字，同一格分段顯示',
    ],
  },
  {
    version: '3.54.12',
    date: '2026-06-25',
    changes: [
      'fix(jira): Lark header 解析修正 — 物件類型 cell（URL cell）正確提取 text，避免 [object Object] 導致欄位名稱對應失敗',
      'fix(jira): 欄位名稱比對加 normalizeCol()，strip ↓/↑/→/←/換行，解決 P 欄「單子標題貼這」找不到問題',
    ],
  },
  {
    version: '3.54.11',
    date: '2026-06-25',
    changes: [
      'fix(jira): 單子標題貼這回填改用 richtext 格式，只有 Issue Key 為超連結，摘要為純文字 (同行第二段)',
      'fix(jira): Lark Sheet 欄位名稱比對加 trim() 修正帶空白的欄位無法對應問題',
    ],
  },
  {
    version: '3.54.10',
    date: '2026-06-25',
    changes: [
      'fix(jira): 批量修改 Step 3 預覽表移除 50 筆截斷限制，顯示全部選取筆數',
    ],
  },
  {
    version: '3.54.9',
    date: '2026-06-25',
    changes: [
      'fix(jira): 批量修改描述附件 — 重新上傳檔案後自動清除「警 需重新上傳」防呆警告',
    ],
  },
  {
    version: '3.54.8',
    date: '2026-06-25',
    changes: [
      'feat(jira): 批量更新狀態新增「回填單子標題」獨立按鈕 — 一鍵回填所選 Issue 的 Jira Key 超連結＋摘要到「單子標題貼這」欄位',
    ],
  },
  {
    version: '3.54.7',
    date: '2026-06-25',
    changes: [
      'feat(jira): 批量修改描述附件支援從 Sheet 欄位讀取圖片 — 選擇欄位後點「讀取附件」自動預快取，影片仍需手動上傳（附防呆提示）',
    ],
  },
  {
    version: '3.54.6',
    date: '2026-06-25',
    changes: [
      'fix(jira): 批量開單轉換狀態完成後，處理階段回填改為「已切換狀態」（原為「已完成」）',
    ],
  },
  {
    version: '3.54.5',
    date: '2026-06-25',
    changes: [
      'feat(jira): 批量開單完成後回填「單子標題貼這」欄位 — 寫入 Jira Key 超連結＋Issue 摘要兩行內容',
    ],
  },
  {
    version: '3.54.4',
    date: '2026-06-25',
    changes: [
      'feat(jira): 批量修改新增「描述附件」欄 — 每列可手動上傳圖片/影片，送出後自動上傳至 Jira 並以 wiki markup 嵌入描述',
    ],
  },
  {
    version: '3.54.3',
    date: '2026-06-25',
    changes: [
      'fix(jira): 批量更新狀態 RD負責人誤判為空 — customfield_10428 同時支援陣列與單一物件兩種 Jira 回傳格式',
      'fix(jira): 批量修改人員選擇器 autoCompleteUrl 移除 /user 路徑限制，groupuserpicker 等端點現可正確取得欄位允許人員清單',
    ],
  },
  {
    version: '3.54.2',
    date: '2026-06-25',
    changes: [
      'fix(jira): 批量開單 Step 3 附件欄中，Sheet 匯入影片改顯示「警 需重新上傳」警示，提示使用者手動補傳',
      'fix(jira): 批量開單送出前若有未上傳影片列，彈出確認對話框，與批量評論行為一致',
    ],
  },
  {
    version: '3.54.1',
    date: '2026-06-25',
    changes: [
      'fix(jira): 批量更新狀態描述欄位誤判為空 — batch-fetch-fields 改用 renderedFields 作 fallback，解決 ADF 解析無法取到描述文字的問題',
      'fix(jira): 批量開單附件流程加入詳細 log（快取檔存在與否、上傳成功/失敗、描述更新結果），方便排查描述嵌入失敗原因',
    ],
  },
  {
    version: '3.54.0',
    date: '2026-06-25',
    changes: [
      'feat(jira): 批量開單 Step 3 新增「描述圖片附件」面板 — 可從 Sheet 欄位預載（Lark/Google Drive）或逐列手動上傳；開單後自動上傳附件並以 !filename! markup 嵌入描述',
      'feat(jira): 批量修改 multiuser 欄位改為多選 chip picker（QA驗證人員等欄位可一次選多人）',
      'fix(jira): 批量修改預覽表格摘要欄顯示前綴組合後的最終結果',
      'fix(jira): 前綴面板類別選單容器加 overflow:hidden + minWidth:0，防止長欄位名稱溢出版面',
      'feat(jira): 批量更新狀態執行前驗證必填欄位（摘要/描述/受託人/RD負責人），缺漏時擋下並列出問題單',
      'refactor(jira): 描述圖片附件移入表格「附件」欄，移除獨立面板；自動偵測「圖」欄位並在「從 Lark 帶入」時自動預載',
      'fix(jira): 批量更新狀態執行前重新從 Jira fetch 最新資料再驗證，不使用快取',
      'fix(jira): 批量修改多人欄位選人後保持下拉開啟（不再需要清空才能繼續選）',
      'fix(jira): 批量修改多人欄位選完人後「確認修改」按鈕不再被誤 disabled',
      'fix(jira): 批量修改預覽表格欄位名稱改為顯示正式欄位名稱而非 customfield_XXXXX',
      'fix(jira): 批量開單附件下載失敗顯示帶檔名的 警 提示，影片類型顯示 啟 圖示',
      'fix(jira): 批量開單描述附件嵌入增加 v2 回應檢查及 v3 ADF fallback，方便排查失敗原因',
    ],
  },
  {
    version: '3.53.15',
    date: '2026-06-25',
    changes: [
      'feat(jira): 批量修改人員欄位改為可搜尋下拉選單（SearchablePicker），依 Issue 所屬專案自動載入完整可分配人員清單',
    ],
  },
  {
    version: '3.53.14',
    date: '2026-06-25',
    changes: [
      'feat(jira): 批量開單和批量修改新增共用「自動組合摘要前綴」功能，設定主題（手動輸入）+ 多個類別欄位（從 Sheet 選擇），組合成 [主題][類別1][類別2]...摘要格式',
    ],
  },
  {
    version: '3.53.13',
    date: '2026-06-25',
    changes: [
      'fix(jira): 批量修改全面修正各欄位類型格式 — labels 改為純字串陣列、multiuser 先解析 displayName→accountId 再送、number 無效值不填 0',
    ],
  },
  {
    version: '3.53.12',
    date: '2026-06-25',
    changes: [
      'fix(jira): 批量修改自訂人員欄位（如 RD負責人）改用 {accountId} 格式，修正 400「使用者不存在或不適用」錯誤',
    ],
  },
  {
    version: '3.53.11',
    date: '2026-06-24',
    changes: [
      'feat(jira): 批量修改欄位下拉改用 Jira editmeta 動態載入所有可編輯欄位；修正 description 400 錯誤（v2 API 用純字串）；select/multiselect/user 類型手動模式顯示對應選單',
    ],
  },
  {
    version: '3.53.10',
    date: '2026-06-24',
    changes: [
      'feat(jira): 批量修改欄位對應新增「手動設定」模式，受託人顯示 Jira 人員下拉、優先級顯示固定選單、其他欄位顯示文字輸入框，送出時自動組成正確 Jira API 格式（assignee 用 accountId，priority 用 name）',
    ],
  },
  {
    version: '3.53.9',
    date: '2026-06-24',
    changes: [
      'fix(jira): 批量更新狀態改用 Lark Sheet 讀取模式（與批量評論一致），以 <table> 重寫預覽表格，摘要/狀態/受託人改由 batch-fetch-fields 載入',
    ],
  },
  {
    version: '3.53.8',
    date: '2026-06-24',
    changes: [
      'fix(jira): 批量修改 Step 3 預覽表格一進頁面即顯示 Jira 現有資料，選欄位對應後即時追加舊值→新值欄',
    ],
  },
  {
    version: '3.53.7',
    date: '2026-06-24',
    changes: [
      'fix(jira): 切換至批量開單 Tab 時若 step >= 5 自動重置，避免殘留舊 Step 5/6 畫面',
      'fix(jira): 批量評論 writeback 改用批量評論自身的 Sheet URL（原本誤用批量開單 URL）',
      'feat(jira): 批量更新狀態執行成功後寫回 Lark Sheet 處理階段（已切換狀態）與處理時間',
    ],
  },
  {
    version: '3.53.6',
    date: '2026-06-24',
    changes: [
      'fix(jira): 批量修改 Step 3 預覽表格改用 <table> 元素，修正 header 與資料列欄位對不齊的問題',
    ],
  },
  {
    version: '3.53.5',
    date: '2026-06-24',
    changes: [
      'fix(jira): 批量修改/批量評論讀取 Sheet 時帶 includeCreated=true，正確回傳已開單列（原本被過濾掉）',
      'fix(jira): 批量修改/批量評論 Issue 選擇表格改用 <table> 元素，欄位 header 與資料列對齊',
      'fix(jira): Jira 資料載入失敗時顯示明確錯誤訊息，並提供「重新載入 Jira 資料」按鈕支援補選帳號後重試',
    ],
  },
  {
    version: '3.53.4',
    date: '2026-06-24',
    changes: [
      'feat(jira): 批量修改 Step 3 新增變更預覽表格 — 顯示各 Issue 現有 Jira 值 → Sheet 新值，有差異的欄位以綠色標示，最多顯示 50 筆',
      'feat(jira): 批量修改/批量評論以 __url 欄位優先偵測 Jira Key（超連結欄位），fallback 至文字開頭比對，解決顯示文字含標題時無法偵測的問題',
      'feat(jira): 批量修改 Step 2 讀取 Jira API 現有資料（摘要/受託人/狀態）並顯示於 Issue 選擇清單',
    ],
  },
  {
    version: '3.53.3',
    date: '2026-06-24',
    changes: [
      'feat(jira): 批量評論/批量修改 Issue 選擇步驟新增欄位篩選器 — 自動偵測 2–15 個唯一值的欄位顯示 dropdown 篩選，同時展示 Sheet 各欄內容，方便快速定位並勾選目標 Issue',
    ],
  },
  {
    version: '3.53.2',
    date: '2026-06-24',
    changes: [
      'feat(jira): 批量評論/批量修改/批量更新狀態三個 Tab 均新增 Issue 選擇步驟 — 讀取 Sheet 後先列出所有偵測到的 Issue Key 並提供全選/取消全選，使用者勾選後才進入評論/欄位設定步驟',
      'fix(jira): 批量修改欄位對應列 overflow 修正（minWidth: 0, flexShrink: 0）',
    ],
  },
  {
    version: '3.53.1',
    date: '2026-06-24',
    changes: [
      'fix(jira): 批量開單流程簡化為 4 步驟（移除 Step 5 評論和 Step 6 切換狀態），Step 4 完成後直接顯示「完成，重新開始」；評論和改狀態改由獨立 Tab 處理',
    ],
  },
  {
    version: '3.53.0',
    date: '2026-06-24',
    changes: [
      'feat(jira): QA 模式新增「批量評論」獨立 Tab — 貼入 Lark Sheet URL，自動偵測 Jira Issue Key 列，直接進入評論/附件流程，不需經過開單步驟',
      'feat(jira): QA 模式新增「批量修改」獨立 Tab — 貼入 Lark Sheet URL，設定 Jira 欄位與 Sheet 欄位對應，批量修改 Issue 摘要/描述/優先級等欄位',
      'feat(jira): 後端新增 POST /api/jira/batch-edit 端點（PUT /rest/api/2/issue/{key}），逐筆更新並回報結果',
    ],
  },
  {
    version: '3.52.9',
    date: '2026-06-24',
    changes: [
      'feat(jira): 批次評論預覽 - Lark 插入附件影片無法自動下載時，顯示「未上傳」黃色警示圖示與說明文字',
      'feat(jira): 批次評論送出前，若有未上傳影片則彈出確認提示，可選擇繼續送出（不含影片）或取消去手動上傳',
    ],
  },
  {
    version: '3.52.8',
    date: '2026-06-24',
    changes: [
      'fix(jira): 修正 Lark 附件超連結 cell 解析錯誤，extractCell 只取顯示文字導致 Drive API 404，現改為讀取 __url 欄位取得實際下載連結',
      'fix(jira): parseLarkFileToken 新增防護，filename 格式字串（含副檔名）不再被誤當 file_token 送 Drive API',
    ],
  },
  {
    version: '3.52.7',
    date: '2026-06-24',
    changes: [
      'fix(jira): Lark 帶入對 user/multiuser 欄位加入驗證，無效值不再送 Jira（先比對 accountId，再比對 displayName，找不到就跳過）',
    ],
  },
  {
    version: '3.52.6',
    date: '2026-06-24',
    changes: [
      'fix(jira): 修正 Lark rich-text array 格式欄位（URL 連結 cell）被解析為空字串，導致「單子標題貼這↓」過濾失效',
      'fix(jira): 同步修正摘要欄公式（IF/SPLIT/INDEX）因 Q 欄 array 格式而評估為空的問題',
      'fix(jira): Step 3 計畫執行改用 filteredRecords，已開單列不再進入 Jira 開單流程（防止重複建立）',
      'fix(jira): 「已勾選 X 筆」與「開始執行 X 筆」按鈕計數改為只統計過濾後的可見列',
    ],
  },
  {
    version: '3.52.5',
    date: '2026-06-24',
    changes: [
      'feat(jira): Step 2 新增「過濾已開單」選項，可指定欄位名稱，有值的列自動跳過',
      'fix(jira): 後端偵測 Lark 無法計算的複雜公式體（IF/IFERROR/SPLIT 等），自動清空不帶入欄位',
    ],
  },
  {
    version: '3.52.4',
    date: '2026-06-23',
    changes: [
      'feat(jira): 動態欄位必填驗證訊息列出具體列號，可點擊自動捲動到該列',
      'feat(jira): 有錯誤的列加深紅色底色 + 左側紅色邊框，更易識別',
    ],
  },
  {
    version: '3.52.3',
    date: '2026-06-23',
    changes: [
      'fix(autospin): agent 斷線重連 — 伺服器重啟後 session 失效時自動重新登錄，不中斷 Spin 循環',
    ],
  },
  {
    version: '3.52.2',
    date: '2026-06-22',
    changes: [
      'fix(jira): 批次評論格式驗證改為警告，不再擋下送出（前後端均移除強制驗證）',
      'fix(jira): 修正 handleSubmitFromPreview 內部仍有 errorCount 擋住送出的問題',
      'feat(jira): 批次評論送出進度條移至按鈕列上方獨立顯示，含百分比與動畫',
    ],
  },
  {
    version: '3.52.1',
    date: '2026-06-12',
    changes: [
      'fix(ai): Gemini Key 全部配額耗盡時，Ollama 自動 fallback 最多等待 20 秒，避免 TestCase 任務永久卡在執行中',
      'fix(testcase): AI 配額或 fallback 失敗後會正常結束 worker 任務，前端顯示明確錯誤訊息',
    ],
  },
  {
    version: '3.52.0',
    date: '2026-06-12',
    changes: [
      'feat(testcase): 自訂 Prompt 可依 AI JSON 回傳內容動態建立 TestCase 欄位，不再限制固定欄位',
      'feat(testcase): 動態欄位同步支援 Lark Bitable、CSV 匯出與前端結果預覽',
      'compat(testcase): 預設、差異比對、基線驗證與 Jira Prompt 維持原有固定格式流程',
    ],
  },
  {
    version: '3.51.0',
    date: '2026-06-12',
    changes: [
      'feat(lark): 文件上傳改為拖曳區塊（FileDropZone），支援拖曳 & 點擊上傳，拖入不合法格式顯示紅色提示 + 抖動動畫',
    ],
  },
  {
    version: '3.50.4',
    date: '2026-06-09',
    changes: [
      'fix(prompt): 新增分類儲存後自動切回下拉選單（不再卡在新增輸入狀態），新分類也即時出現在下拉中',
    ],
  },
  {
    version: '3.50.3',
    date: '2026-06-09',
    changes: [
      'fix(prompt): Prompt 模板分類下拉改用原生 select（明確下拉箭頭），選「＋ 新增分類…」切換為輸入框，比 datalist 直覺',
    ],
  },
  {
    version: '3.50.2',
    date: '2026-06-09',
    changes: [
      'feat(prompt): Prompt 模板「分類」欄位改為下拉（datalist）可選現有分類，仍可輸入新分類，免去手打對應名稱',
    ],
  },
  {
    version: '3.50.1',
    date: '2026-06-09',
    changes: [
      'fix(osm): ImageRecon 版本狀態統一顯示「通過 達標 / 警 未達標」（不再顯示 Match/Mismatch）',
    ],
  },
  {
    version: '3.50.0',
    date: '2026-06-09',
    changes: [
      'feat(osm): ImageRecon Server 版本改用 ImageRecon API（IMAGERECON_API_URL）取得各伺服器/服務版本，不再解析 Gmail 週報；最新版號取 API 多數版本，仍以 Lark Sheet 目標版本比對',
      'refactor(osm): 移除已停用的 Gmail 取信/解析程式（getGmailAccessToken/findPlainText/decodeQP/parseVersionReport）',
    ],
  },
  {
    version: '3.49.4',
    date: '2026-06-09',
    changes: [
      'fix(osm-uat): 錄製 URL「複製」按鈕加 http fallback（非 https 下 navigator.clipboard 不可用時改用 execCommand）',
    ],
  },
  {
    version: '3.49.3',
    date: '2026-06-09',
    changes: [
      'perf: 分頁隱藏時暫停全域輪詢（AI Agent 監控 health/monitor、AutoSpin 狀態），切回前景立即刷新，省電並減少 DevTools network 雜訊',
    ],
  },
  {
    version: '3.49.2',
    date: '2026-06-09',
    changes: [
      'fix(autospin): 修正遠端 Agent 狀態不同步（顯示未連線但仍在跑 / agent 卡在忙碌）',
      'fix(autospin): 狀態輪詢改為每 4 秒並同步刷新 agent 清單，偵測到新 session 會自動接上對應 SSE',
      'fix(autospin): hub-stop 立即釋放 agent；hub-dispatch 允許對指定 agent 重新派工（即使 busy 旗標殘留），agent 端會先關舊 Python 不會雙開',
    ],
  },
  {
    version: '3.49.1',
    date: '2026-06-09',
    changes: [
      'fix(autospin): 遠端 Agent「停止」改為輪詢實際狀態即時更新 UI（不再固定等 8 秒），按鈕顯示「停止中…」並停用，狀態列同步顯示',
    ],
  },
  {
    version: '3.49.0',
    date: '2026-06-09',
    changes: [
      'fix(autospin): agent 找不到 Python 引擎 — 將 toppath-agent.py 納入 agent installer 下載清單，安裝後即具備 AutoSpin 引擎',
      'fix(local-agent): 修正 macOS installer 的 bash 語法錯誤（下載指令引號），並自動 best-effort 安裝 Python 依賴（opencv/numpy/requests/playwright）',
      'feat(local-agent): 下載與安裝區塊重新設計 — OS 分頁（Windows/macOS）+ hero 下載卡 + 時間軸步驟 + 可複製指令框',
    ],
  },
  {
    version: '3.48.0',
    date: '2026-06-09',
    changes: [
      'feat(local-agent): Local Agent 頁面新增獨立的 macOS 安裝教學與 install-mac.command 安裝包（嵌入 token），與 Windows 並列',
      'feat(local-agent): Local Agent installer 加入 autospin capability，安裝後的 agent 可同時跑 MachineTest / Scripted Bet / AutoSpin',
      'refactor(autospin): 移除 AutoSpin 頁面的 agent 安裝說明區塊，統一改到 Local Agent 頁面管理',
    ],
  },
  {
    version: '3.47.0',
    date: '2026-06-09',
    changes: [
      'feat(autospin): 改用 agent-hub 派工執行（A2）— 在 UI 選擇線上 agent，agent 端 spawn 既有 Python 引擎，公網 Spug 上 server 不再需要跑瀏覽器/OpenCV',
      'feat(autospin): 執行監控頁面重新設計 — 遠端 Agent（hub）為主、伺服器端為 fallback，新增 agent 選擇器與步驟化版面',
      'feat(agent): 新增 macOS 啟動腳本 start-agent.sh / start-agent.command，agent-runner 加入 autospin capability',
    ],
  },
  {
    version: '3.46.0',
    date: '2026-06-08',
    changes: [
      'feat(jira-comment): 評論範本改為完整版，各區塊新增必填細項（功能目的/前置條件/測試步驟/說明與備註含子欄位）',
      'feat(jira-comment): 格式驗證升級，細項冒號後沒填內容會被偵測為「未完成」並擋下送出',
    ],
  },
  {
    version: '3.45.2',
    date: '2026-06-08',
    changes: [
      'fix(jira): 使用者搜尋移除 username 參數（Jira Cloud GDPR 嚴格模式會對受託人 user/assignable/search 回 400），修正受託人搜尋查無使用者',
    ],
  },
  {
    version: '3.45.1',
    date: '2026-06-08',
    changes: [
      'feat(jira): 使用者欄位即時搜尋也加到「每一列」單選/多選格子，下拉結果用 portal 浮層避免被表格裁切',
    ],
  },
  {
    version: '3.45.0',
    date: '2026-06-08',
    changes: [
      'feat(jira): 使用者欄位（回報者/受託人等）新增即時搜尋，向 Jira autocomplete 查名字，解決空查詢只回前 ~50 推薦人、其他人拉不到的問題',
      'feat(jira): 批量填入面板的使用者欄位下方加搜尋框，搜到並選取的人會併入所有下拉（含每列），可再「套用至全部列」',
    ],
  },
  {
    version: '3.44.0',
    date: '2026-06-08',
    changes: [
      'feat(jira): Step 3「新增選填欄位」下拉加入搜尋框，可依欄位名稱/key 即時過濾',
    ],
  },
  {
    version: '3.43.2',
    date: '2026-06-08',
    changes: [
      'fix(jira): Step 3 欄位篩選器的下拉選單加上最大寬度與標籤不換行，修正長文字欄位（摘要/描述）把篩選器撐爆、標籤直排的問題',
    ],
  },
  {
    version: '3.43.1',
    date: '2026-06-08',
    changes: [
      'fix(layout): .app-main 加上 min-width:0，動態欄位開單寬表格改為內部橫向捲動，修正整頁爆版',
    ],
  },
  {
    version: '3.43.0',
    date: '2026-06-08',
    changes: [
      'feat(jira): 動態欄位開單新增「回報人」欄位（解除後端 reporter 過濾，可指定回報人）',
      'feat(jira): 描述、受託人、RD負責人、回報人 改為強制必填並自動顯示，未填會擋下送出',
      'feat(jira): Lark 自動帶入支援上述強制必填欄位（內容/受託人/RD負責人/回報人 → 對應 Jira 欄位）',
    ],
  },
  {
    version: '3.42.2',
    date: '2026-06-08',
    changes: [
      'fix(jira-comment): 手動上傳錯誤改為顯示在上傳按鈕旁（per-row），並標示單檔上限 10MB',
    ],
  },
  {
    version: '3.42.1',
    date: '2026-06-08',
    changes: [
      'fix(jira-comment): 手動上傳超過 10MB 改回傳明確錯誤訊息（不再 500），前端顯示提示',
      'fix(jira-comment): 影片附件改用 [^filename] wiki markup，Jira 渲染為可點擊下載連結',
      'fix(jira-comment): 圖片嵌入改用 Jira 實際儲存的檔名（避免檔名被改而無法預覽）',
    ],
  },
  {
    version: '3.42.0',
    date: '2026-06-08',
    changes: [
      'feat(jira-comment): 預覽表格每筆評論可手動上傳圖片，上傳後即時顯示縮圖，送出時附加至 Jira',
      'feat(jira-comment): 新增評論模板區塊（含 5 區塊格式），支援複製與批量往下貼入所有評論',
    ],
  },
  {
    version: '3.41.2',
    date: '2026-06-08',
    changes: [
      'fix(jira-comment): 支援 Lark Sheet embed-image 內嵌圖片，正確使用 Lark media API 下載並上傳至 Jira',
      'fix(jira-comment): 圖片嵌入評論改為靠左對齊（!filename|align=left!）',
    ],
  },
  {
    version: '3.41.0',
    date: '2026-06-05',
    changes: [
      'feat(jira-comment): 新增評論預覽表格，送出前可 inline 編輯每筆評論並即時驗證格式',
      'feat(jira-comment): 附件預覽縮圖，Server 暫存 Lark/GDrive 圖片供預覽，送出後上傳至 Jira 附件區',
      'feat(jira-comment): 改用 Jira v2 wiki markup API，圖片以 !filename! 語法直接嵌入評論內文',
      'feat(jira-comment): 後端二次格式驗證（同五區塊規則），防止前端繞過格式檢查',
      'feat(jira-comment): 附件大小限制 10MB/檔（與 Jira Cloud 預設相同）',
    ],
  },
  {
    version: '3.40.11',
    date: '2026-06-05',
    changes: [
      'fix(lark-sheets): 改用 values_batch_get 批次解析跨 sheet 公式欄位（如 =\'填寫\'!H1），自動替換為計算結果',
    ],
  },
  {
    version: '3.40.8',
    date: '2026-06-05',
    changes: [
      'feat(jira): AI 優化評論功能鎖定為管理員限定，非管理員看不到 AI 優化選項',
    ],
  },
  {
    version: '3.40.7',
    date: '2026-06-05',
    changes: [
      'feat(jira): 批次評論改為兩步驟：格式驗證（五大區塊必填）+ AI 二次分析評論（完整性三點總結）',
      'fix(google-sheets): 加上 valueRenderOption=FORMATTED_VALUE，確保公式欄位顯示計算結果而非公式文字',
    ],
  },
  {
    version: '3.40.6',
    date: '2026-06-04',
    changes: [
      'feat(jira): 批次開單必填欄位驗證（摘要、描述、受託人、RD負責人），缺失時擋下並顯示錯誤',
      'feat(jira): 支援從 Lark Sheet「回報人」欄位設定 Jira reporter，回報者欄位不再重複',
      'fix(jira): 修正動態欄位「回報者」名稱導致 reporter 欄位重複出現的問題',
    ],
  },
  {
    version: '3.40.5',
    date: '2026-06-05',
    changes: [
      'fix(jira): PM 批次開單的 Jira 專案清單也改為分頁拉取，修復超過 100 個專案時專案 key 比對失敗',
    ],
  },
  {
    version: '3.40.4',
    date: '2026-06-05',
    changes: [
      'fix(jira): Jira 專案清單改為分頁拉取（每頁 100），解決超過 100 個專案顯示不完整',
    ],
  },
  {
    version: '3.40.3',
    date: '2026-06-05',
    changes: [
      'feat(jira): 批量更新狀態預覽表新增勾選功能（全選/單選），使用者可自定義要執行哪些單號',
      'feat(jira): 批量更新狀態預覽表「內容」欄改為從 Jira 抓取 Issue 摘要（背景載入）',
    ],
  },
  {
    version: '3.40.2',
    date: '2026-06-04',
    changes: [
      'fix(jira): SSE 改用 auto-reconnect 取代斷線即放棄，EventSource 斷線後自動重連並恢復 progress；30 分鐘無結果才 timeout 進 polling fallback，解決 100+ 筆 batch 中途斷線問題',
    ],
  },
  {
    version: '3.40.1',
    date: '2026-06-04',
    changes: [
      'fix(jira): 重新送出批次評論時清空舊結果，解決舊批次「警 已中斷」結果與新批次進度條同時顯示的問題',
      'fix(jira): 批次評論完成後立即釋放按鈕狀態，不再等待 Lark 回寫完成',
    ],
  },
  {
    version: '3.40.0',
    date: '2026-06-04',
    changes: [
      'feat(jira): Step 3 新增 AI 摘要生成功能，可選前綴欄位（[值1][值2]）+ 內容來源欄位，批量呼叫 Gemini 生成 Issue 標題，結果可手動修改單筆',
    ],
  },
  {
    version: '3.39.13',
    date: '2026-06-04',
    changes: [
      'fix(jira): description 欄位經由動態欄位對應時自動包裝成 ADF，解決「欄位值不是有效的 ADF 內容」錯誤',
    ],
  },
  {
    version: '3.39.12',
    date: '2026-06-04',
    changes: [
      'fix(jira): 專案人員名單改為分頁拉取（每頁 100），解決超過 100 人顯示不完整',
    ],
  },
  {
    version: '3.39.11',
    date: '2026-06-04',
    changes: [
      'feat(jira): Step 5 新增「重新讀取 Sheet」按鈕，過濾已評論完的單號，AI 中斷後可直接續跑',
    ],
  },
  {
    version: '3.39.10',
    date: '2026-06-04',
    changes: [
      'fix(jira): 回寫改為 Jira issue key 純文字 + 獨立 Jira URL 欄（完整網址），Lark 自動偵測 URL 為可點擊連結',
    ],
  },
  {
    version: '3.39.9',
    date: '2026-06-04',
    changes: [
      'feat(jira): 回寫 Jira issue key 改為 HYPERLINK 公式，Lark 欄位可直接點擊跳轉到對應 Jira 單',
    ],
  },
  {
    version: '3.39.8',
    date: '2026-06-04',
    changes: [
      'fix(jira): 修正 React duplicate key 警告 — sheetHeaders / columnUniqueValues 空字串 key 改用 index fallback',
    ],
  },
  {
    version: '3.39.7',
    date: '2026-06-04',
    changes: [
      'fix(jira): Lark 回寫空欄掃描跳過 column A（index 0），避免將 Jira issue key 寫入 Lark 勾選框/序號欄',
    ],
  },
  {
    version: '3.39.6',
    date: '2026-06-04',
    changes: [
      'feat(jira): Lark 回寫自動建立欄位優先填入空欄位 — 掃描 row 1 找第一個空欄位使用，避免塞在最末端；無空欄時才新增',
    ],
  },
  {
    version: '3.39.5',
    date: '2026-06-04',
    changes: [
      'fix(jira): Lark Sheet 讀取與回寫範圍從 AZ 擴展到 ZZ（702欄），修正超過 52 欄時 Jira issue key 被錯誤覆蓋且無法讀回的問題',
    ],
  },
  {
    version: '3.39.4',
    date: '2026-06-04',
    changes: [
      'fix(jira): datetime 欄位格式錯誤 — toJiraDateTime 修正 T 分隔符解析，動態欄位日期值自動轉換為 Jira 格式（+0800 timezone）',
    ],
  },
  {
    version: '3.39.3',
    date: '2026-06-04',
    changes: [
      'feat(jira): Step 3 UI 重設計 — 欄位管理 chips 區塊 + 批量填入收合面板，移出表格 header，不再需要橫向捲動才能新增欄位',
    ],
  },
  {
    version: '3.39.2',
    date: '2026-06-04',
    changes: [
      'feat(jira): Lark 回寫自動建立欄位 — 欄位不存在時自動往最後一欄延伸，寫入標題再寫入值',
    ],
  },
  {
    version: '3.39.1',
    date: '2026-06-04',
    changes: [
      'fix(jira): multiuser 欄位改為 chips + 下拉多選，可新增/移除多位成員',
      'fix(jira): datetime 欄位改用 datetime-local input，格式 2026-05-21 11:00',
      'feat(jira): Step 3 批量填入行 — 每欄有輸入框 + ⬇ 全套按鈕，一鍵套用至所有篩選列',
    ],
  },
  {
    version: '3.39.0',
    date: '2026-06-04',
    changes: [
      'feat(jira): Step 3 動態欄位 Grid — 從 Jira createmeta 取得所有可用欄位，逐列填寫取代硬編欄位對應',
      'feat(jira): 新增 GET /api/jira/fields 端點（10 分鐘 in-memory cache），後端 proxy Jira createmeta + normalize schema',
      'feat(jira): 支援欄位類型渲染：select / multi-select / user / date / text / string / number',
      'feat(jira): + 欄位 Picker — 選填欄位可按需加入 Grid 列',
      'feat(jira): Lark 預填按鈕 — 用 Lark 欄名對應 Jira field name，對不上的自動忽略',
      'feat(jira): Per-row 必填驗證 — 送出前逐列檢查必填欄位，inline 標紅提示',
      'feat(jira): batch-create 支援 dynamicFields per row，後端透明 merge 至 Jira fields payload',
    ],
  },
  {
    version: '3.38.5',
    date: '2026-06-03',
    changes: [
      'feat(gemini): 503 改用 exponential backoff + jitter（1s/2s/4s 最多 3 次）取代立即換 Key，避免打同一個過載節點；429 仍換 Key',
      'fix(ui): AI Agent 監控浮窗與 Dashboard 背景任務「執行中」改顯示為「running」',
    ],
  },
  {
    version: '3.38.4',
    date: '2026-06-03',
    changes: [
      'fix(gemini): 修正 503+429 混合錯誤時錯誤顯示「配額上限」的問題，改為各自獨立判斷並顯示正確原因；補上 503 完整 error message log',
    ],
  },
  {
    version: '3.38.3',
    date: '2026-06-03',
    changes: [
      'fix(dashboard): 伺服器負載改為只計算短請求（非 SSE），SSE 長連線獨立計數顯示於備註，避免 HIGH 常態亮著',
    ],
  },
  {
    version: '3.38.2',
    date: '2026-06-02',
    changes: [
      'fix(history): 修復 AutoSpin、TestCase 生成（Lark / 檔案）歷史紀錄「操作者：未記錄」問題，所有非同步回調均正確傳遞操作者資訊',
    ],
  },
  {
    version: '3.38.1',
    date: '2026-05-30',
    changes: [
      'fix(scripted-bet): entryTouchPoints 改為進房後偵測到 SPIN 按鈕後延遲 3 秒再執行，解決 SUPERBURSTLINK 等機種需在遊戲載入後才選面額的情況',
    ],
  },
  {
    version: '3.38.0',
    date: '2026-05-30',
    changes: [
      'feat(local-agent): 新增「更新 source files」按鈕，從 Local Agent 管理頁一鍵推送最新 runner.ts 至 Agent 機器，不需重新安裝',
    ],
  },
  {
    version: '3.37.9',
    date: '2026-05-30',
    changes: [
      'fix(scripted-bet): entryTouchPoints 改為在 card click 後、enterGMNtc 前執行（與 Machine Test 順序一致）',
      'fix(scripted-bet): clickConfiguredTouchPoints 改用輪詢等待（最多 10s），不再即時查詢找不到就跳過',
    ],
  },
  {
    version: '3.37.8',
    date: '2026-05-30',
    changes: [
      'feat(ai-monitor): AI 任務新增「排隊中」狀態，監控面板顯示排隊數量與各 provider 排隊分佈（黃色標籤）',
    ],
  },
  {
    version: '3.37.7',
    date: '2026-05-30',
    changes: [
      'fix(ollama): 允許空值儲存以清除設定，移除 confirm() 依賴，儲存/清除按鈕視覺改善',
      'fix(openai): 移除後 banner 不消失問題修正，移除 confirm() 依賴',
    ],
  },
  {
    version: '3.37.6',
    date: '2026-05-30',
    changes: [
      'fix(osm): 版本同步 Lark Sheet URL 改為唯讀，不允許手動修改',
      'fix(prompt): Prompt 模板分類名稱不分大小寫/空格，同名分類自動合併',
      'fix(url-pool): ADMIN 使用者可直接編輯 URL，不再需要 Jira PIN',
      'fix(scripted-bet): 移除帳號執行清單中的 URL 標籤欄',
      'feat(scripted-bet): 自動套用 Machine Test 機台配置（entryTouchPoints/退出補救/spinSelector）',
      'fix(gemini): 移除 round-robin 自動輪換，改名為 Gemini；出錯時仍 fallback 至下一個 Key',
      'fix(ollama): 儲存按鈕加入視覺 disabled 狀態',
      'fix(openai): 儲存按鈕加入視覺 disabled 狀態',
    ],
  },
  {
    version: '3.37.5',
    date: '2026-05-29',
    changes: [
      'fix(ui-screenshot): 修正截圖縮圖不顯示（SSE snapshot 補 run_id 欄位）',
      'fix(ui-screenshot): 修正 heatmap 11 欄版面溢出',
      'feat(ui-screenshot): 新增解析度 模擬A(414×730)、模擬B(376×636)、FOLD/Flip 折(344×882)、FOLD/Flip 展(884×1104)',
      'feat(osm-alert): 版本告警 Lark Webhook 可獨立設定，排程設定介面新增 Webhook URL 欄位',
    ],
  },
  {
    version: '3.37.4',
    date: '2026-05-29',
    changes: [
      'ui(ui-screenshot): 移除 gmid 清單手動確認按鈕與預覽區塊，保留文字框直接編輯與執行時解析',
    ],
  },
  {
    version: '3.37.3',
    date: '2026-05-29',
    changes: [
      'fix(ui-screenshot): UI 解析度截圖完成或停止時寫入主歷史紀錄，History 頁新增 UI 截圖篩選',
    ],
  },
  {
    version: '3.37.2',
    date: '2026-05-29',
    changes: [
      'fix(ui-screenshot): 修正進入機台與退出機台流程，精準比對 gmid、加入截圖前延遲，並確認回到大廳後才關閉頁面',
      'fix(ui-screenshot): 修正 Lark 回寫欄位從 B 欄開始，使用 Sheets image API 回貼圖片，並讓有截圖檔的 popup 結果也顯示與回寫圖片',
    ],
  },
  {
    version: '3.37.1',
    date: '2026-05-29',
    changes: [
      'fix(ui-screenshot): 修正截圖縮圖不顯示問題（SSE snapshot 缺少 run_id 欄位）',
      'fix(ui-screenshot): 修正 heatmap 版面橫向溢出問題',
      'feat(osm-alert): 版本告警 Webhook 獨立設定 — 可在排程設定中單獨配置 Lark Webhook URL',
    ],
  },
  {
    version: '3.37.0',
    date: '2026-05-29',
    changes: [
      'feat(ui-screenshot): 新增 UI 解析度截圖工具 — 從 Lark Wiki 讀取 gmid 清單，批量對 H5 遊戲進行 11 種解析度截圖（Mobile Portrait/Landscape + Tablet），Local Agent 運行 Playwright，支援面額彈窗自動關閉、推流偵測、結果熱圖 Grid、Lark Wiki TABLE 回寫',
    ],
  },
  {
    version: '3.36.0',
    date: '2026-05-28',
    changes: [
      'feat(jira): 批量更新狀態移入 QA 模式 — 頂部 tab 改為 QA / PM，QA 模式內新增子 tab「批量開單 / 批量更新狀態」，位置固定在 step indicator 上方',
    ],
  },
  {
    version: '3.35.0',
    date: '2026-05-28',
    changes: [
      'feat(jira): 新增「批次更新票」模式 — 讀取 Lark Bitable URL 欄取得單號，依填寫人自動對應 Jira 帳號，選擇 Transition 後批次更新狀態（3 步驟流程）',
    ],
  },
  {
    version: '3.34.5',
    date: '2026-05-28',
    changes: [
      'fix(ui): 機台版本 Dashboard 卡片字體修正 — 機種名稱從深藍 #1e40af 改為亮藍 #93c5fd（深色背景可見），缺少機台名稱從深紅 #7f1d1d 改為淺紅 #fca5a5，進度條 track 改為 #334155',
    ],
  },
  {
    version: '3.34.4',
    date: '2026-05-28',
    changes: [
      'fix(ui): 版本達標總覽改為深色主題 — 機台列/元件列改用 #1e293b 底色，文字改為高對比白/淺色，版本號紅綠更鮮明，section 標題改為琥珀色，台數 badge 改為半透明琥珀框',
    ],
  },
  {
    version: '3.34.3',
    date: '2026-05-28',
    changes: [
      'feat(alert): Lark 版本告警加入 ImageRecon Server 版本回報 — 查詢最近一筆 imagerecon 歷史紀錄，比對目標版本，顯示未達標伺服器清單及資料時效',
    ],
  },
  {
    version: '3.34.2',
    date: '2026-05-28',
    changes: [
      'fix(alert): Lark 版本告警機台清單改為聚合摘要 — 按 (渠道, 機種, 目前版本, 目標版本) 分組，台數 desc 排序，附落後/超前標示，移除 20 筆截斷限制',
    ],
  },
  {
    version: '3.34.1',
    date: '2026-05-28',
    changes: [
      'fix(testcase): 修正 Codex P1 — 部分 Bitable 寫入失敗仍標 completed、resume 建新表而非沿用原表、固定表缺少 idempotency 欄位、commit_failed 行不被 resume 重試',
      'fix(osm): VersionDashboard 加入 ImageRecon 資料後 hasAnyData 未更新，導致只有 ImageRecon 資料時仍顯示空畫面',
    ],
  },
  {
    version: '3.34.0',
    date: '2026-05-28',
    changes: [
      'feat(auth): 登入清單 — 上次登入帳號固定釘頂並顯示分割線，其餘帳號超過 5 筆自動分頁（每頁 5 筆，搜尋時重置頁碼）',
      'fix(auth): 登出後不再自動跳至 PIN 畫面（移除 auto-select effect），登出體驗恢復正常',
    ],
  },
  {
    version: '3.33.0',
    date: '2026-05-28',
    changes: [
      'feat(testcase): TestCase 生成新增斷點續跑機制 — 生成結果持久化至 DB，Bitable 寫入支援 per-case idempotency，中斷後可從上次進度繼續，不重跑 LLM。新增 GET /api/integrations/lark/generate-testcases/jobs 和 POST .../resume/:jobId 端點。',
    ],
  },
  {
    version: '3.32.2',
    date: '2026-05-27',
    changes: [
      'fix(auth): 調整帳號新增邏輯 — 允許自助新增新帳號，但覆蓋已存在帳號需要 admin 身份。',
    ],
  },
  {
    version: '3.32.1',
    date: '2026-05-27',
    changes: [
      'fix(auth): POST /api/jira/accounts 加入 admin 權限驗證；登入 rate limit 收緊至每分鐘 10 次；登出時清除 localStorage 上次登入紀錄。',
    ],
  },
  {
    version: '3.32.0',
    date: '2026-05-27',
    changes: [
      'feat(login): 登入頁面新增搜尋過濾 + 記住上次登入帳號（localStorage）。帳號多時可即時搜尋，有 PIN 的帳號下次自動跳至 PIN 輸入畫面。',
    ],
  },
  {
    version: '3.31.0',
    date: '2026-05-26',
    changes: [
      'feat(uat): UAT 腳本執行整合 Local Agent — 公網模式自動路由至已連線的 uat-run Agent 執行 Playwright，日誌即時串流回 SSE，無需在伺服器安裝 Playwright。',
    ],
  },
  {
    version: '3.30.6',
    date: '2026-05-26',
    changes: [
      'fix(uat): H5 錄製與執行解析度固定為 500x877，移除 H5 多尺寸選項並同步 server fallback。',
    ],
  },
  {
    version: '3.30.5',
    date: '2026-05-26',
    changes: [
      'fix(uat): 統一 H5/PC 錄製與 Headed 執行的瀏覽器啟動路徑，執行時改用與錄製相同的 Chrome/CDP viewport 同步，降低畫面框架差異。',
    ],
  },
  {
    version: '3.30.4',
    date: '2026-05-26',
    changes: [
      'fix(uat): 修正 H5/PC Headed 執行在瀏覽器初始化階段無日誌卡住，runner 會顯示啟動進度、捕捉初始化錯誤並釋放 RUNNING 狀態。',
    ],
  },
  {
    version: '3.30.3',
    date: '2026-05-26',
    changes: [
      'fix(uat): Headed 執行改用一般 Chrome 實際內容區，不再強制 390px mobile viewport，避免 Windows Chrome 最小寬度造成右側白邊。',
    ],
  },
  {
    version: '3.30.2',
    date: '2026-05-26',
    changes: [
      'fix(uat): H5/PC 執行腳本時也同步套用 platform viewport、mobile device metrics 與 headed Chrome 外框補償，讓執行畫面和錄製框選畫面一致。',
    ],
  },
  {
    version: '3.30.1',
    date: '2026-05-26',
    changes: [
      'fix(uat): 對齊 H5/PC 錄製與執行的 viewport 定義，錄製視窗自動補償 Chrome 外框並套用 device metrics，避免框選座標與執行畫面偏移。',
    ],
  },
  {
    version: '3.30.0',
    date: '2026-05-26',
    changes: [
      'feat(uat): UAT 錄製整合 Local Agent — 公網模式可選擇已連線的 uat-record Agent 執行 Chrome 錄製，步驟與框選截圖即時同步回 Server。沒有 Agent 且非本機時錄製按鈕完全停用。',
      'fix(uat): 修正錄製狀態因 AutoPanel 重建而重置 — 將錄製相關 state 提升至父元件，以 Record<AutoPlatform, ...> 索引，解決 recPolling 反覆歸零導致框選按鈕常態停用的問題。',
    ],
  },
  {
    version: '3.29.26',
    date: '2026-05-25',
    changes: [
      'fix(uat): 透過 LAN IP 存取時框選擷取按鈕可正常使用，改由 server 端 isLocalRecordRequest() 判斷錄製可用性。',
    ],
  },
  {
    version: '3.29.25',
    date: '2026-05-26',
    changes: [
      'feat(uat): H5/PC 基準圖擷取改為錄製視窗直接拖曳框選，自動截圖、回填座標大小並加入 find_baseline_scroll 步驟。',
    ],
  },
  {
    version: '3.29.24',
    date: '2026-05-26',
    changes: [
      'ui(uat): 將 H5/PC 錄製視窗局部截圖功能固定顯示在基準截圖管理區，未錄製時顯示停用狀態與原因，避免使用者找不到入口。',
    ],
  },
  {
    version: '3.29.23',
    date: '2026-05-26',
    changes: [
      'feat(uat): H5/PC 錄製中即時同步步驟到 Step Builder，新增錄製視窗局部截圖存基準圖，並支援 find_baseline_scroll 找圖不到就下滑直到頁底才失敗。',
    ],
  },
  {
    version: '3.29.22',
    date: '2026-05-26',
    changes: [
      'fix(uat): H5/PC 錄製只保留 viewport 座標點擊，runner 會略過舊腳本中緊跟座標點擊後的重複 selector 點擊，避免遊戲頁 strict mode selector 卡住流程。',
    ],
  },
  {
    version: '3.29.21',
    date: '2026-05-26',
    changes: [
      'fix(uat): H5/PC 錄製改以 viewport 座標產生 click_viewport 步驟，runner 以 page.mouse.click 執行並在 goto 後等待遊戲載入，降低遊戲 DOM selector 變動造成的無反應。',
    ],
  },
  {
    version: '3.29.20',
    date: '2026-05-26',
    changes: [
      'feat(uat): H5/PC 本機錄製改為自製 Chrome DevTools recorder，由 Node.js 啟動 Chrome、注入事件監聽並收集 click/type 步驟，不再依賴 Playwright codegen/Inspector。',
    ],
  },
  {
    version: '3.29.19',
    date: '2026-05-26',
    changes: [
      'fix(uat): H5/PC 本機 Playwright codegen 改用 npx.cmd/shell:false 啟動，避免 Windows shell 將含 & 的目標 URL 拆成多段導致 about:blank。',
    ],
  },
  {
    version: '3.29.18',
    date: '2026-05-26',
    changes: [
      'feat(uat): H5/PC 新增 Step Builder，可用表單建立 goto、click_xy、click、type、wait、screenshot、assert_visible 步驟，保留進階 JSON 編輯以相容既有腳本格式。',
    ],
  },
  {
    version: '3.29.17',
    date: '2026-05-26',
    changes: [
      'fix(uat): H5/PC 本機錄製改為直接以目標 URL 開啟 Playwright codegen，避免錄製視窗停在 about:blank；提示文案改為只有空白頁時才需手動貼 URL。',
    ],
  },
  {
    version: '3.29.16',
    date: '2026-05-26',
    changes: [
      'fix(uat): H5/PC 公網模式停用 server-side Playwright 錄製，避免 codegen 開在伺服器端導致未擷取步驟；/api/frontend-auto/record/start 新增非本機請求保護與清楚錯誤訊息。',
    ],
  },
  {
    version: '3.29.15',
    date: '2026-05-26',
    changes: [
      'fix(testcase): Jira 整合 TestCase 結果支援 test_cases、cases、testCases、測試案例清單等外層 alias 判斷，降低 prompt key 調整造成的 CSV/Bitable 輸出失敗',
    ],
  },
  {
    version: '3.29.14',
    date: '2026-05-25',
    changes: [
      'fix(imagerecon): ImageRecon 版本狀態不再顯示 Unknown，改依目標版本比對顯示「達標」或「未達標」',
    ],
  },
  {
    version: '3.29.13',
    date: '2026-05-25',
    changes: [
      'feat(dashboard): 新增登入後首頁監控儀表板，顯示在線使用者、有效登入、伺服器壓力、記憶體與背景任務佇列',
      'feat(dashboard): 新增 heartbeat 與 /api/dashboard/summary，整合 server/worker 狀態、request 壓力與最近系統事件',
      'ui(dashboard): Dashboard 成為登入後第一頁，使用者最多顯示 8 位、任務 5 筆、事件 6 筆，超過數量於區塊底部提示',
    ],
  },
  {
    version: '3.29.12',
    date: '2026-05-25',
    changes: [
      'style(testcase): 調整 TestCase 生成結果操作按鈕間距，Lark Bitable 與 CSV 備份按鈕不再貼齊',
    ],
  },
  {
    version: '3.29.11',
    date: '2026-05-25',
    changes: [
      'feat(testcase): TestCase 生成新增 CSV 備份輸出，Bitable 欄位不匹配或輸出空白時仍可從 AI JSON 保留資料',
      'feat(history): 歷史紀錄 TestCase 支援由 JSON 轉出 CSV，並支援 Jira 整合格式欄位 alias 對應',
      'fix(testcase): Jira 整合 TestCase 格式改以 test_cases JSON 結構判斷，降低 prompt 欄位命名調整造成的對應失敗',
    ],
  },
  {
    version: '3.29.10',
    date: '2026-05-25',
    changes: [
      'fix: 修正 gameshow.ts PDFParse import，消除最後一個 worker crash 來源',
    ],
  },
  {
    version: '3.29.9',
    date: '2026-05-25',
    changes: [
      'fix: 修正 integrations.ts 所有 PDFParse 舊寫法，worker 不再啟動 crash',
    ],
  },
  {
    version: '3.29.8',
    date: '2026-05-25',
    changes: [
      'fix(knowledge): 降級 pdf-parse 至 v1，修正 PDF 上傳「PDFParse cannot be invoked without new」錯誤',
    ],
  },
  {
    version: '3.29.6',
    date: '2026-05-25',
    changes: [
      'fix(auth): sessions 改為 SQLite 持久化，修正伺服器重啟後需重新登入的問題',
      'fix(knowledge): 操作欄標題明確 textAlign left',
    ],
  },
  {
    version: '3.29.5',
    date: '2026-05-25',
    changes: [
      'fix(knowledge): 操作欄標題與按鈕改為靠左對齊',
    ],
  },
  {
    version: '3.29.4',
    date: '2026-05-25',
    changes: [
      'fix(knowledge): 未分類計數改用 == null 判斷，修正伺服器未重啟時顯示 0 的問題',
      'fix(knowledge): 刪除按鈕加 whiteSpace nowrap 防止斷行',
    ],
  },
  {
    version: '3.29.3',
    date: '2026-05-25',
    changes: [
      'fix(knowledge): 調亮資料夾 tab、文件數、URL、標籤、快取狀態等文字顏色',
    ],
  },
  {
    version: '3.29.2',
    date: '2026-05-25',
    changes: [
      'fix(knowledge): 移除頁面重複標題，修正「新增文件」按鈕尺寸過大問題',
      'fix(knowledge): 資料夾 tab 計數改從 docs 陣列 fallback，避免伺服器未重啟時顯示 0',
      'fix(knowledge): 新增資料夾失敗時彈出錯誤提示',
      'fix(knowledge): 整體版面放大（maxWidth 1280、間距調整）',
    ],
  },
  {
    version: '3.29.1',
    date: '2026-05-25',
    changes: [
      'fix(knowledge): 知識庫頁面重新設計，改用 section-card + 橫向資料夾 tabs，符合 ToppathTools 排版風格',
    ],
  },
  {
    version: '3.29.0',
    date: '2026-05-25',
    changes: [
      'feat(knowledge): 知識庫改版為資料夾架構，左欄資料夾列表 + 右欄文件表格',
      'feat(knowledge): 新增/刪除資料夾，可選顏色標識，文件可分配至指定資料夾',
      'feat(knowledge): 文件列表改為表格格式，支援名稱搜尋 + 類型篩選',
      'feat(knowledge): 新增文件時可選目標資料夾，刪除資料夾後文件自動移至未分類',
    ],
  },
  {
    version: '3.28.5',
    date: '2026-05-25',
    changes: [
      'feat(knowledge): 知識庫新增「上傳文件」類型，支援 PDF / Word (.docx) / HTML 直接上傳並自動抽取純文字',
    ],
  },
  {
    version: '3.28.4',
    date: '2026-05-25',
    changes: [
      'fix(jira): 知識庫選擇器移回 Step 5 AI 優化區塊，Step 3 只保留人員設定',
    ],
  },
  {
    version: '3.28.3',
    date: '2026-05-25',
    changes: [
      'fix(jira): 人員設定優先順序改為 Step 3 picker > Lark 欄位 > Step 1 受託人',
    ],
  },
  {
    version: '3.28.2',
    date: '2026-05-25',
    changes: [
      'fix(jira): Lark 受託人/RD負責人/驗證人員欄位值先驗證是否為有效 accountId，避免 email/名稱直接送 Jira 報錯',
    ],
  },
  {
    version: '3.28.1',
    date: '2026-05-25',
    changes: [
      'feat(jira): Step 3 新增人員設定面板（受託人/RD負責人/驗證人員批次預設，Lark 欄位值優先）',
      'feat(jira): Step 3 新增知識庫選擇器，移出 Step 5 評論設定區',
    ],
  },
  {
    version: '3.28.0',
    date: '2026-05-25',
    changes: [
      'feat(knowledge): 新增知識庫頁面，可預存 Lark Wiki / PDF / Google Doc / 純文字文件供 AI 調用',
      'feat(knowledge): 文件儲存時自動抓取並快取純文字，支援手動重新抓取，7天以上顯示建議重抓提示',
      'feat(knowledge): 後端新增 /api/knowledge/* 路由（列出/新增/重抓/取內容/刪除）',
      'feat(knowledge): 側欄加入「典 知識庫」入口，系統管理頁加入知識庫權限管理',
    ],
  },
  {
    version: '3.27.13',
    date: '2026-05-22',
    changes: [
      'fix(autospin): 執行監控頁即時獎池 banner 改用 mt-osm-banner CSS class，與機台自動化測試頁風格一致；修正遊戲名稱文字顏色（原 #1e293b 深色不可見），Grand/Fortune 色調統一為黃/紫',
    ],
  },
  {
    version: '3.27.12',
    date: '2026-05-22',
    changes: [
      'fix(jira): 自動移除摘要中的換行字元（Lark 內容欄有 \\n 時 Jira 會拒絕），前後端同步處理',
      'fix(jira): 擴展 Lark Sheet 讀取範圍從 A:Z 至 A:AZ，支援欄位超過 26 欄（Actual end / 驗證人員 / 本機完成測試時間 / 上C服時間 / 上線日期 等位於 AA-AE 欄的欄位現在可正確讀取並回寫 Jira）',
      'fix(jira): 修正 multiWritebackLark 回寫 range 格式錯誤：Lark API 需要 `U2:U2` 格式而非 `U2`，Lark error code 90202 (wrong range)',
      'fix(jira): 正確處理 Lark Sheets v2 API 回傳的日期欄位格式：Excel OA 日期序號（如 `46092` = 2026-03-11），轉換為 Jira 格式 `2026-03-11T00:00:00.000+0800`，解決 Actual start/end 不合規格錯誤',
    ],
  },
  {
    version: '3.27.4',
    date: '2026-05-22',
    changes: [
      'fix(jira): 回退至 Lark Sheets v2 API，server 端自動解析 `"prefix"&G2` 型公式拼接，公式欄位顯示計算值',
    ],
  },
  {
    version: '3.27.3',
    date: '2026-05-22',
    changes: [
      'fix(jira): Lark Sheets v3 API range 改用 URL encoding，修復 JSON parse 錯誤',
    ],
  },
  {
    version: '3.27.2',
    date: '2026-05-22',
    changes: [
      'fix(jira): 改用 Lark Sheets v3 API + valueRenderOption=ToString，公式欄位正確顯示計算值而非公式字串',
    ],
  },
  {
    version: '3.27.1',
    date: '2026-05-22',
    changes: [
      'fix(jira): Lark Sheet 讀取加上 renderType=FORMATTED_VALUE，公式欄位（如摘要）顯示計算結果而非公式字串',
    ],
  },
  {
    version: '3.27.0',
    date: '2026-05-22',
    changes: [
      'feat(jira): Step 3 新增欄位篩選器 — 自動偵測下拉式選單欄位（2–15 個唯一值），可按嚴重度/類別/進度等篩選後再勾選',
    ],
  },
  {
    version: '3.26.19',
    date: '2026-05-21',
    changes: [
      'fix(jira): worker 加入 JSON 錯誤處理器，修復批次開單 500 回應導致「Row 0 網路錯誤」',
      'fix(jira): 批次開單允許空摘要欄位（略過並回報），不再整批失敗',
    ],
  },
  {
    version: '3.26.18',
    date: '2026-05-21',
    changes: [
      'feat(jira): 批次評論 platform 欄自動 fallback — 沒有「測試平台」欄時使用「類別」欄（H5/PC/後台）',
    ],
  },
  {
    version: '3.26.17',
    date: '2026-05-21',
    changes: [
      'fix(jira): Lark Sheet 讀取過濾空白列，修復物件格式 cell 解析（[object Object] 問題）',
    ],
  },
  {
    version: '3.26.16',
    date: '2026-05-21',
    changes: [
      'fix(lark): parseLarkSheetUrl 支援 /wiki/{token} 格式，Lark Wiki 頁面嵌入試算表的 URL 可直接使用',
    ],
  },
  {
    version: '3.26.15',
    date: '2026-05-21',
    changes: [
      'feat(jira): 批次評論新增規格書參考段落（specContext）輸入欄，支援 {{specContext}} 模板佔位符',
    ],
  },
  {
    version: '3.26.14',
    date: '2026-05-15',
    changes: [
      'fix(rate-limit): 在所有 rate limiter 加 validate.xForwardedForHeader:false，徹底防止 nginx 反向代理下的 X-Forwarded-For 驗證錯誤',
    ],
  },
  {
    version: '3.26.13',
    date: '2026-05-15',
    changes: [
      'fix(server): 新增 trust proxy 設定，修正公網 nginx 反向代理下 express-rate-limit X-Forwarded-For 錯誤',
    ],
  },
  {
    version: '3.26.12',
    date: '2026-05-15',
    changes: [
      'fix(ollama): 縮短 Ollama connect timeout 從 15s → 3s，防止內網 Ollama 不可達時 worker 長時間阻塞',
    ],
  },
  {
    version: '3.26.11',
    date: '2026-05-15',
    changes: [
      'fix(ocr-proxy): agent 呼叫 OCR proxy 時帶 x-jira-email header，AI 任務監控正確顯示使用者',
    ],
  },
  {
    version: '3.26.10',
    date: '2026-05-15',
    changes: [
      'fix(agent): OSMWatcher 狀態即時推送給 agent — 解決 FG/Jackpot 特殊狀態偵測失效問題',
    ],
  },
  {
    version: '3.26.9',
    date: '2026-05-15',
    changes: [
      'fix(agent): filter session_start events from agent runner，防止多台機器輪跑時清空前端結果',
    ],
  },
  {
    version: '3.26.8',
    date: '2026-05-15',
    changes: [
      'feat(gemini): callGeminiVision/Multi 支援 ownerEmail 參數，個人 key 優先，fallback 全域池',
      'fix(ocr-proxy): OCR proxy 驗證 agent token，使用 token owner 的個人 key 池，防止盜用他人配額',
      'ui(larkpage/machintest): 無個人 Gemini Key 時顯示警告 banner，提醒前往設定',
    ],
  },
  {
    version: '3.26.7',
    date: '2026-05-15',
    changes: [
      'feat(agent): OCR proxy — agent 的 CCTV/Audio AI 分析改走公網 server key 池，不再需要 agent 機器自備 GEMINI_API_KEY',
    ],
  },
  {
    version: '3.26.6',
    date: '2026-05-15',
    changes: [
      'fix(agent): runner.run() 傳入 sessionId，修正音頻檔名缺少 session prefix 問題',
    ],
  },
  {
    version: '3.26.5',
    date: '2026-05-15',
    changes: [
      'fix(audio-upload): Spin 路徑錄音存檔後未呼叫 uploadAudioToServer，補上上傳邏輯',
    ],
  },
  {
    version: '3.26.4',
    date: '2026-05-15',
    changes: [
      'ui(local-agent): Token 列表優化 — 顯示機台 hostname、截短 token ID、已撤銷預設隱藏可展開',
    ],
  },
  {
    version: '3.26.3',
    date: '2026-05-15',
    changes: [
      'fix(upload): audio/CCTV 上傳端點改用 type:*/* 避免 Content-Type 不匹配被拒；uploadToServer 增加 HTTP 狀態碼 log',
    ],
  },
  {
    version: '3.26.2',
    date: '2026-05-15',
    changes: [
      'refactor(local-agent): 移除 MachineTestPage 的安裝指南面板，改整合至 Local Agent 頁面',
      'feat(local-agent): 新增 Machine Test 額外安裝說明（VB-Cable / GEMINI_API_KEY / 版本更新）',
    ],
  },
  {
    version: '3.26.1',
    date: '2026-05-15',
    changes: [
      'fix(exit-test): leaveGMNtc errcode=0 後等 1.5s 再做 DOM 檢查，避免頁面過渡未完成誤判為 WARN',
      'fix(agent): Headed 模式現在正確讀取 session.headedMode，不再強制 headless',
    ],
  },
  {
    version: '3.26.0',
    date: '2026-05-12',
    changes: [
      'feat(scripted-bet): 新增腳本化投注頁面，多帳號依序進入指定機台 Spin 後退出',
      'feat(local-agent): 新增 Local Agent 管理頁面，查看已連線 Agent、管理 Token',
      'feat(agent-hub): AgentInfo 新增 ownerKey/ownerName/tokenId/capabilities，getAvailableAgents 支援過濾',
      'fix(audio/cctv): 本地執行時無 sessionId 也能找到音頻/截圖，改用目錄掃描找最新 *-{code} 檔案',
    ],
  },
  {
    version: '3.25.23',
    date: '2026-05-13',
    changes: [
      'feat(media-gc): cctv-saves / audio-saves 定時清除，預設保留 5 天，可用 MEDIA_RETENTION_DAYS env var 調整',
    ],
  },
  {
    version: '3.25.22',
    date: '2026-05-13',
    changes: [
      'feat(cctv): 分散式 Agent CCTV 截圖後自動 PUT 上傳至公網 server；新增 PUT /api/machine-test/cctv-upload 端點',
    ],
  },
  {
    version: '3.25.21',
    date: '2026-05-13',
    changes: [
      'feat(audio): 分散式 Agent 錄音後自動 PUT 上傳 WAV 至公網 server；新增 PUT /api/machine-test/audio-upload 接收端點',
    ],
  },
  {
    version: '3.25.20',
    date: '2026-05-13',
    changes: [
      'fix(lark-import): qaCol 偵測改用 includes("確認") 正確找 QA確認狀態（G欄），修正驗證通過機台未被排除的問題',
    ],
  },
  {
    version: '3.25.19',
    date: '2026-05-12',
    changes: [
      'fix(ui): AI Prompt 模板 / AI 模型下拉高度不一致 — ModelSelector 樣式對齊 .field select',
      'feat(log-compare): 移除 iframe，Log 結構比對內嵌於頁面，CSS 用 .lcw 隔離避免全域污染',
    ],
  },
  {
    version: '3.25.18',
    date: '2026-05-12',
    changes: [
      'fix(models/available): 個人 OpenAI Key 設定後 AI 模型下拉未顯示 OpenAI 選項 — 改用 resolveOpenAIKey(req) 識別個人 Key',
    ],
  },
  {
    version: '3.25.17',
    date: '2026-05-12',
    changes: [
      'fix(lark-writeback): 修正 QA 狀態欄位偵測錯誤 — msgColIdx/qaColIdx 使用不同關鍵字區分；qaStatus 改回中文符合 Lark 下拉選項；匯入篩選條件更新為驗證通過',
    ],
  },
  {
    version: '3.25.16',
    date: '2026-05-12',
    changes: [
      'fix(machine-test): expectedScreens 未存入 DB — 補 ALTER TABLE migration、profileSchema、INSERT/UPDATE 語句',
    ],
  },
  {
    version: '3.25.15',
    date: '2026-05-12',
    changes: [
      'fix(memory): autospin logs 陣列加 2000 行上限 + 舊 session 每 15 分鐘 GC；machine-test eventBuffer 加 5000 筆上限，修正 worker 記憶體持續增長至 800MB+',
    ],
  },
  {
    version: '3.25.14',
    date: '2026-05-12',
    changes: [
      'fix(personal-keys): 個人 Key 儲存無效 — 改用 cookie session (getAuthAccount) 識別使用者，修正 getUser 回傳 "—" 導致儲存失敗的問題',
    ],
  },
  {
    version: '3.25.13',
    date: '2026-05-12',
    changes: [
      'fix(ui): GeminiSettingsModal Ollama 清除後輸入框未清空 — 改為 DELETE 成功後直接清空本地 state，不再依賴 fetchOllamaConfig',
    ],
  },
  {
    version: '3.25.12',
    date: '2026-05-12',
    changes: [
      'feat(ai-keys): 個人 AI Key 管理 — 每帳號可設自己的 Gemini/OpenAI key，完全隔離互不干擾，未設定時 fallback 到全域 Key Pool',
    ],
  },
  {
    version: '3.25.11',
    date: '2026-05-12',
    changes: [
      'feat(machine-test): 機種設定檔新增「螢幕數量」欄位 — 雙屏機台設為 2 後，推流檢測僅偵測到 1 個 video 即判定 FAIL',
    ],
  },
  {
    version: '3.25.10',
    date: '2026-05-12',
    changes: [
      'feat(audio): 新增 POST /api/audio/analyze — WAV 檔案 RMS/Peak dBFS 分析工具，支援 8/16/24/32bit PCM 及 32bit Float',
    ],
  },
  {
    version: '3.25.9',
    date: '2026-05-12',
    changes: [
      'fix(ui): MachineTestPage OSMWatcher 監控面板 — 機台 ID 文字 #1e293b→#94a3b8，修正暗底看不見的問題',
    ],
  },
  {
    version: '3.25.8',
    date: '2026-05-12',
    changes: [
      'fix(ui): OsmUatPage H5/PC — 全面暗色化：tab、操作說明、Node.js 安裝列、腳本表格、步驟進度、warning box',
      'fix(ui): AutoSpinPage — 取消按鈕補上文字顏色 (#94a3b8)，修正暗底看不到字的問題',
    ],
  },
  {
    version: '3.25.7',
    date: '2026-05-12',
    changes: [
      'fix(ui): 全域暗色 scrollbar — 所有頁面 scrollbar 統一 #2d3f55 深色風格',
      'fix(ui): modal 表單元素暗色 — Portal modal 內 input/select/textarea 套用暗色底色',
      'fix(ui): GeminiSettingsModal — 全面暗色化：input、tab、table、badge、warning box',
      'fix(ui): GsLogCheckerPage — 標題、步驟、warning box 暗色化，tab 顏色統一',
      'fix(ui): SystemAdminPage — 帳號 email 文字、hover、標題、狀態 badge 暗色化',
      'fix(ui): MachineTestPage — Agent badge、warning box、OSM 機台狀態卡片暗色化',
    ],
  },
  {
    version: '3.25.6',
    date: '2026-05-12',
    changes: [
      'fix(ui): 更新日誌 modal — scrollbar 換暗色主題（track #0f172a、thumb #2d3f55），同步修正 modal 內文字與 badge 為暗色系',
    ],
  },
  {
    version: '3.25.5',
    date: '2026-05-12',
    changes: [
      'fix(ui): 移除 sidebar「更版日誌」nav 入口，統一由版本徽章（v3.x.x）點擊開啟 modal 查看',
    ],
  },
  {
    version: '3.25.4',
    date: '2026-05-12',
    changes: [
      'fix(ui): GsLogCheckerPage Log 結構比對面板（iframe log-compare.html）全面改暗色主題',
      'fix(ui): UrlPoolPage — 篩選按鈕 border 換暗色，警告/提示框改透明底色',
      'fix(ui): AI Agent 監控 widget — 整體改為暗色（#1e293b 底、#2d3f55 邊框），badge/狀態顏色統一',
    ],
  },
  {
    version: '3.25.3',
    date: '2026-05-12',
    changes: [
      'fix(ui): SystemAdminPage — 子分頁容器改為暗色（#162032），active tab 改為 #1e293b，表格分隔線換暗色',
      'fix(ui): HistoryPage — 天數/功能篩選按鈕 inactive 背景改為 #1e293b，文字調亮',
      'fix(ui): OsmConfigComparePage — 模板清單卡片改為暗色，diff 徽章改用透明色系',
      'fix(ui): ImageCheckPage — 截圖貼上區、error 提示、session 狀態改為暗色透明',
      'fix(ui): GsImgComparePage (iframe) — img-compare.html CSS 變數全部改為暗色主題',
      'fix(ui): GsBonusV2Page (iframe) — bonus-v2.html 全面改為暗色主題（body/card/table/btn/tabs）',
    ],
  },
  {
    version: '3.25.2',
    date: '2026-05-12',
    changes: [
      'fix(ui): 全站掃描並修正所有頁面殘留的淺色背景 — AutoSpin、MachineTest、History、JackpotPage、UrlPool、OsmPage、GsLogChecker、GsStats 等頁面',
      'fix(ui): 文字亮度提升 — .main-content base color: #cbd5e1，section-title、field labels、table cells 全部調亮',
      'fix(css): 全域 CSS 強制覆蓋 — .main-content 內所有 input/select/textarea 及 thead 一律套用暗色主題',
    ],
  },
  {
    version: '3.25.1',
    date: '2026-05-12',
    changes: [
      'fix(ui): 統一按鈕與表單設計 — LarkPage 所有 source cards、seg-control、diff/baseline panels、option cards 改用暗色 CSS 類別',
      'fix(ui): JiraPage QA/PM 模式切換、PM 確認表格、結果卡片、選擇器全部換為暗色主題',
      'style(css): 新增 seg-control、src-card、src-type-btn、diff-panel、baseline-panel、option-card、mode-toggle 等通用 CSS 類別',
    ],
  },
  {
    version: '3.25.0',
    date: '2026-05-12',
    changes: [
      'feat(ui): 全面暗黑主題 — main content 區域、卡片、表單、表格、按鈕、OSM/機台測試等所有頁面元件全部轉換為暗黑配色',
      'refactor(css): 統一設計語言：surface=#1e293b、bg=#0f172a、border=#2d3f55、accent=#3b82f6，移除所有白色/淺色背景殘留',
    ],
  },
  {
    version: '3.24.0',
    date: '2026-05-12',
    changes: [
      'feat(ui): 全面改版為側邊欄導覽佈局 — 固定左側 sidebar 取代原頂部 Tab Bar，含分組導覽、子頁展開、使用者區塊於底部',
      'refactor(layout): 移除 app-header / tab-bar / sub-tab-bar / tab-desc，新增 app-sidebar / app-main / app-topbar 架構',
    ],
  },
  {
    version: '3.23.0',
    date: '2026-05-12',
    changes: [
      'feat(auth): 權限管理系統 — 新增角色（admin/qa/pm/other），管理員可透過「系統管理」頁設定各角色可見功能頁；Other 為完全客製化角色',
      'feat(admin): 帳號管理 — 新增/編輯/刪除帳號，指派角色與 PIN，支援啟用/停用狀態',
      'feat(frontend): 依登入帳號角色動態過濾 Tab，無權限頁面自動隱藏',
    ],
  },
  {
    version: '3.22.0',
    date: '2026-05-10',
    changes: [
      'feat(uat): H5 / PC 前端自動化測試頁實作 — Script List、Run Config、Step Progress、Baseline 管理、PC Template Library、OCR Region Definitions',
      'feat(backend): frontend-auto API 路由 — scripts / baselines / templates / ocr-regions / runs / log-stream / setup 下載',
    ],
  },
  {
    version: '3.21.0',
    date: '2026-05-08',
    changes: [
      'feat(auth): 帳號自行設定 PIN — 申請帳號時改為使用者自行填入 PIN 作為登入密碼，不再需要管理員 PIN',
      'feat(seed): 機種設定檔 / Prompt 模板支援 Git 種子檔 — 新增 server/machine-profiles.json seed 載入，新增 scripts/export-db-seeds.mjs 匯出腳本',
    ],
  },
  {
    version: '3.20.0',
    date: '2026-05-08',
    changes: [
      'feat(settings): Ollama 設定 UI — AI 模型設定新增「Ollama」分頁，可設定 Base URL / 預設模型，支援偵測可用模型，設定值存 DB（不再依賴 .env）',
      'fix(jira): Step 2 按鈕版面 — submit-btn--step / btn-ghost--step 補充 App.css 定義，修正「上一步」折行、「讀取 Sheet」撐滿寬度的問題',
      'fix(ui): AI Agent 監控 widget 還原左下角預設位置',
      'chore: package.json name / version 對齊 app 版本',
    ],
  },
  {
    version: '3.19.0',
    date: '2026-05-08',
    changes: [
      'feat(autospin-agent): toppath-agent.py — AutoSpin.py 改用 Playwright + Chromium，移除 Selenium + Edge 依賴，新增 _PlaywrightDriver 相容層，所有機台操作流程程式碼不動',
    ],
  },
  {
    version: '3.18.0',
    date: '2026-05-08',
    changes: [
      'feat(autospin): SLS 錯誤日誌面板 — Run tab 右側新增 SLS Error Logs 區塊，可選機台查詢近 24h ERROR/WARN/Exception，每 60s 自動更新',
      'feat(autospin): machineNo 欄位 — 機台設定新增 Machine No. 欄位，用於 SLS 日誌查詢',
      'feat(backend): GET /api/autospin/sls-errors — 查詢阿里雲 SLS 4 個 project，自動列舉 logstore 並依機台編號篩選錯誤',
    ],
  },
  {
    version: '3.17.0',
    date: '2026-05-06',
    changes: [
      'feat(autospin): OSMWatcher 獎池面板 — Run tab 新增 Grand/Fortune 即時顯示，每 10 秒自動更新',
      'feat(osm): webhook 解析 gtype + jackpot.grand/fortunate，儲存於記憶體，GET /api/machine-test/osm-jackpot 供查詢',
      'feat(tunnel): generate-osm-api-key / build-and-tunnel 取得 Cloudflare URL 後自動 POST 到 /api/settings/tunnel-url 存入 DB',
      'fix(tunnel): cloudflared 改用 -WindowStyle Hidden 啟動，關閉腳本視窗不再中斷 tunnel',
    ],
  },
  {
    version: '3.16.0',
    date: '2026-05-06',
    changes: [
      'feat(gameshow): 圖片比對工具重寫 — 使用 GitHub app.js 原始碼，monkey-patch shim 對接 /api/gs/img-compare/* 端點',
      'feat(gameshow): 新增 SSE 串流擷取端點 POST /api/gs/img-compare/capture，即時推送 progress/done 事件',
      'feat(gameshow): GET /api/gs/img-compare/session 建立新 session，取代舊 POST 端點',
      'style(gameshow): 圖片比對 HTML 改為白底 app 風格（indigo 按鈕、border #e2e8f0 card）',
      'feat(ui): 圖片比對和 Bonus V2 頁面改為 iframe 全頁呈現，不套 main-content padding',
    ],
  },
  {
    version: '3.15.0',
    date: '2026-05-06',
    changes: [
      'feat(gameshow): 新增 Bonus V2 機率統計頁面 — Playwright WS 攔截，統計 m2/m3/任意 double/triple 骰型機率，Side Pool 觸發率，Detail 明細下載',
      'feat(gameshow): bonus-v2-app.js 保持原始代碼不變，monkey-patch shim 重定向 fetch/EventSource 路徑至 /api/gs/bonus-v2/*',
    ],
  },
  {
    version: '3.14.2',
    date: '2026-05-06',
    changes: [
      'fix(log-compare): 檔案上傳 grid 和外層欄位 grid 加上 compare-grid class，修正 app.js 啟動時 enableOuter.closest 找不到元素導致 TypeError crash，開始比對按鈕無法使用',
    ],
  },
  {
    version: '3.14.1',
    date: '2026-05-06',
    changes: [
      'fix(server): 完整 graceful shutdown — 關閉 WS clients、cron、Discord bot、active runners 再 exit，確保 port 3000 釋放',
      'fix(server): 移除 killPortSync，改由 dev:server script 在啟動前執行 dev:stop 一次性清 port',
      'fix(server): shutdown log 每步驟明確打印，方便診斷 tsx restart 卡住位置',
    ],
  },
  {
    version: '3.14.0',
    date: '2026-05-06',
    changes: [
      'feat(gameshow): Log 結構比對頁面重新設計，與 App 風格一致（白底 card、indigo 按鈕、統一 input 樣式）',
      'chore: app.js 同步原始 repo 最新版（773 行，零修改），改以獨立 /api/gs/log-compare-app.js 端點提供',
    ],
  },
  {
    version: '3.13.9',
    date: '2026-05-06',
    changes: [
      'feat(gameshow): Log Checker 前端全新設計 — Hero 功能標籤、步驟說明、複製＋下載按鈕、可折疊腳本預覽',
      'chore: intercept.js 同步原始 repo 最新版（646 行，零修改）',
    ],
  },
  {
    version: '3.13.8',
    date: '2026-05-06',
    changes: [
      'remove(gameshow): 移除 Game Show PDF TestCase 生成工具（含導覽入口）',
    ],
  },
  {
    version: '3.13.7',
    date: '2026-05-05',
    changes: [
      'feat(testcase): Second Pass 支援規格書來源（AI 依規格書判斷缺漏欄位）+ 待補填案例（JSON/Lark/CSV/XLSX）',
      'feat(testcase): Second Pass 支援 FormData 路徑（規格書為 PDF 時）',
    ],
  },
  {
    version: '3.13.6',
    date: '2026-05-05',
    changes: [
      'feat(testcase): AI 補填（Second Pass）從 checkbox 獨立為操作類型 tab，可單獨使用',
      'feat(testcase): Second Pass 模式支援規格書來源 + 待補填案例（JSON/Lark/CSV/XLSX）',
      'feat(testcase): 流程說明動態顯示 Second Pass 步驟說明',
    ],
  },
  {
    version: '3.13.5',
    date: '2026-05-05',
    changes: [
      'feat(testcase): AI 補填 Second Pass — 生成後自動偵測空白欄位，發第二次 Gemini 請求補完',
      'feat(testcase): 新增 testcase-second-pass Prompt（DB 自動更新）',
    ],
  },
  {
    version: '3.13.4',
    date: '2026-05-05',
    changes: [
      'fix(testcase): Diff 模式新規格書為 PDF 時，舊版規格書未傳送的 bug（FormData 路徑補傳 oldSources）',
      'fix(testcase): generate-testcases-file 端點支援 oldSources / existingCasesSource（Diff/Baseline 模式）',
      'fix(testcase): 全域上傳 PDF 上限從 20 MB 調整為 30 MB',
    ],
  },
  {
    version: '3.13.3',
    date: '2026-05-05',
    changes: [
      'feat(testcase): 基線驗證來源支援 JSON paste / Lark Bitable URL / CSV paste / XLSX 上傳',
      'feat(testcase): 安裝 xlsx (SheetJS)，後端解析 XLSX base64 轉 JSON；Lark Bitable 自動分頁讀取',
    ],
  },
  {
    version: '3.13.2',
    date: '2026-05-05',
    changes: [
      'fix(testcase): 差異比對 / 基線驗證 Prompt 改用 {{version_tag}} 模板變數，後端自動注入今日日期（格式 YYYYMMDD_v1）',
    ],
  },
  {
    version: '3.13.1',
    date: '2026-05-04',
    changes: [
      'fix(testcase): 更新差異比對 / 基線驗證 Prompt，輸出欄位新增 編號、規格來源、版本標籤',
      'fix(testcase): seedTestcasePrompts 改用 INSERT OR REPLACE，確保 DB 中舊版 Prompt 自動更新',
    ],
  },
  {
    version: '3.13.0',
    date: '2026-05-01',
    changes: [
      'feat(game): RPG 職業系統 — 5 職業（指揮官 / 駭客 / 守護者 / 遊俠 / 賢者）',
      'feat(game): 職業技能 — 每職業 3 個主動技能，含 XP 倍率 / 即時 XP / CD 縮短效果',
      'feat(game): 升級獎勵屬性點（statPoints），可手動分配 ATK / DEF / INT / SPD',
      'feat(game): 職業立繪動畫 — CSS sprite sheet steps() 動畫（Idle/Attack/Hit/Victory）',
      'feat(game): ClassSelectModal — 一次性職業選擇介面（5 張職業卡 + 屬性預覽）',
      'feat(game): SkillBar — 技能欄顯示冷卻計時、解鎖等級、技能效果',
      'feat(game): AWAKENED 成就 — 首次選擇職業觸發',
    ],
  },
  {
    version: '3.12.0',
    date: '2026-04-30',
    changes: [
      'feat(machine-test): 每機種音頻閾值設定（peakWarnDb / centroidWarnHz / rmsMinDb / rmsMaxDb）',
      'feat(machine-test): 音頻參考檔上傳 — 上傳 WAV 後取代現場第一次 Spin 錄音，直接以參考檔做閾值比對',
      'feat(machine-test): 新增 /api/machine-test/audio-refs GET/POST/DELETE 端點',
    ],
  },
  {
    version: '3.11.6',
    date: '2026-04-30',
    changes: [
      'revert(osm-status): remove API key auth from OSMWatcher webhook，恢復無需驗證',
    ],
  },
  {
    version: '3.11.5',
    date: '2026-04-30',
    changes: [
      'fix(ts): add jackpot to TabId, remove unused counts/useEffect/channelId to fix build errors',
    ],
  },
  {
    version: '3.11.4',
    date: '2026-04-30',
    changes: [
      'fix(osm-status)：OSMWatcher webhook 新增 API Key 驗證（OSM_WATCHER_API_KEY env），新增 generate-osm-api-key.bat 工具自動產生 key 並寫入 .env',
      '新增 build-and-tunnel.bat：自動 build 前端並啟動 Cloudflare Tunnel 外網版',
    ],
  },
  {
    version: '3.11.3',
    date: '2026-04-29',
    changes: [
      'fix(log-compare)：改用 CSS :has() 純 CSS 模式切換，修正雙檔比對切換後第二個上傳欄不顯示問題；移除 #cmp-new-file disabled 屬性使其可正常使用',
    ],
  },
  {
    version: '3.11.2',
    date: '2026-04-29',
    changes: [
      'fix(log-compare)：select onchange + body onload 直接掛 inline handler，修正 iframe 內 addEventListener 不觸發問題',
    ],
  },
  {
    version: '3.11.1',
    date: '2026-04-29',
    changes: [
      'fix(log-compare)：單檔驗證模式預設隱藏第二個上傳欄，改用 HTML class 直接控制避免 iframe JS 初始化時序問題',
    ],
  },
  {
    version: '3.11.0',
    date: '2026-04-29',
    changes: [
      '【新功能】Game Show 整合 bonus-v2：gs-stats 新增「ColorGame V2 電子骰」模式，解析 prepareBonusResult/d.v[10][143]，統計 Single 2同/3同、任意2同/3同，支援彩色分布圖與 CSV 匯出',
      '【新功能】Game Show 整合 front-log-compare：gs-logchecker 新增「Log 結構比對」分頁，內嵌 iframe 雙檔JSON比對/單檔欄位驗證工具（/api/gs/log-compare）',
      '更新 intercept.js 至最新 646 行版本，新增三層結構解析（root/data/jsondata）、排除噪音事件、自動推薦驗證欄位',
    ],
  },
  {
    version: '3.10.2',
    date: '2026-04-29',
    changes: [
      '音頻亮度改用 ZCR（零交叉率）替代 DFT，使用 4096-sample 窗格（93ms），完全避開暫態干擾',
      '判定門檻調整為 1500 Hz（ZCR-derived）；正常機台約 100~600 Hz，異常（清脆/金屬音）約 3000+ Hz',
      '靜音閾值調整：排除比最響窗格低超過 10 dB 的窗格，防止 decay 尾聲噪音拉高重心',
      '修正 stepAudio / stepCctv 參數傳遞錯誤（sessionPrefix undefined）',
      '修正 keepWav 固定為 true，確保音頻檔案必存、wavBase64 一定有值',
    ],
  },
  {
    version: '3.10.1',
    date: '2026-04-29',
    changes: [
      '特殊遊戲等待邏輯重構：一直等到 status=0（最長 15 分鐘），status=0 後再 Spin 10 秒 cooldown，全程標 PASS',
      'FG/JP 的真正問題判斷移至退出步驟（errcode 10002 退不出去才算異常）',
    ],
  },
  {
    version: '3.10.0',
    date: '2026-04-28',
    changes: [
      '【新功能】機台測試帳號級別鎖定：同帳號不可同時啟動多個測試，不同帳號可並行互不干擾',
      '【新功能】CCTV 截圖與音頻錄音改用 {sessionId}-{machineCode} 作為檔名，每次測試獨立一份不互蓋',
      'start 請求自動帶入 account email；前端 CCTV/音頻請求自動帶 ?sessionId= 參數，後端保留舊檔名 fallback',
    ],
  },
  {
    version: '3.9.69',
    date: '2026-04-29',
    changes: [
      '新增 machine_test_results 表，每台機器獨立一筆 DB 紀錄（含 overall/steps/duration）',
      'save-history 自動寫入 per-machine 紀錄，保留 90 天；新增 GET /api/machine-test/machine-results 查詢端點',
    ],
  },
  {
    version: '3.9.68',
    date: '2026-04-28',
    changes: [
      '[遊戲版] 新增 Jack 角色（牌師），SWITCH CLASS 改為三職業循環：Warrior → Mage → Jack',
    ],
  },
  {
    version: '3.9.67',
    date: '2026-04-28',
    changes: [
      '[遊戲版] 全域點擊音效 ui-click-arcane.wav，音量 35%，3 個 Audio 池支援快速連點',
    ],
  },
  {
    version: '3.9.66',
    date: '2026-04-28',
    changes: [
      '[遊戲版] 加入角色立繪系統：Warrior / Mage 4 幀 idle 動畫，升級/完成任務觸發動畫，點擊顯示台詞',
    ],
  },
  {
    version: '3.9.65',
    date: '2026-04-28',
    changes: [
      'Gemini API 所有 fetch 呼叫加入 30 秒 timeout，防止 CCTV OCR / 音頻分析卡住不動',
    ],
  },
  {
    version: '3.9.64',
    date: '2026-04-28',
    changes: [
      '音頻檢測：正常音量範圍改為 -60 ~ -20 dB，超出範圍判 WARN',
    ],
  },
  {
    version: '3.9.63',
    date: '2026-04-28',
    changes: [
      '音頻檢測：加入頻譜重心（Spectral Centroid）計算，> 1100 Hz 判定為音色偏亮/清脆 → WARN',
    ],
  },
  {
    version: '3.9.62',
    date: '2026-04-28',
    changes: [
      '音頻檢測：靜音閾值改為 RMS < -80 dB，AI 無法覆蓋靜音判定',
      '音頻檢測：AI prompt 加入 RMS/峰值/基準數值及正常範圍（-70~-30 dB）',
      '音頻檢測：錄音延長至 10 秒，改為第一次 Spin 前即開始錄製',
    ],
  },
  {
    version: '3.9.61',
    date: '2026-04-28',
    changes: [
      '[遊戲版] GameSidebar label-icons-18 圖示 margin-left 調整為 3px',
    ],
  },
  {
    version: '3.9.59',
    date: '2026-04-28',
    changes: [
      '[遊戲版] GameSidebar 導覽圖示全面換用 label-icons-18 像素圖示集（banner/castle/crystal/gear/mech 等 12 種）',
    ],
  },
  {
    version: '3.9.58',
    date: '2026-04-28',
    changes: [
      '[修復] LarkPage / JiraPage 還原 isGame 判斷：遊戲版顯示 DungeonIcon（plain），一般版保留原始 emoji，不互相影響',
    ],
  },
  {
    version: '3.9.57',
    date: '2026-04-28',
    changes: [
      '[遊戲版] GameSidebar 側邊欄導覽圖示、GameHeader 帳號圖示全部改為 plain 模式，移除所有剩餘 DungeonIcon 外框',
    ],
  },
  {
    version: '3.9.56',
    date: '2026-04-28',
    changes: [
      '[遊戲版] GameHeader CONFIG 按鈕、GameQuestPanel 浮動按鈕和任務標籤改用 plain 圖示，移除多餘外框',
    ],
  },
  {
    version: '3.9.55',
    date: '2026-04-28',
    changes: [
      '[DungeonIcon] 新增 plain 模式：直接顯示像素圖，不帶邊框/背景；LarkPage 和 JiraPage 所有內嵌圖示改用 plain 模式',
    ],
  },
  {
    version: '3.9.54',
    date: '2026-04-28',
    changes: [
      '[全版本] 將 LarkPage / JiraPage 的所有 emoji 改為 DungeonIcon，不再區分遊戲/一般模式，兩版本都顯示像素圖示',
      '[遊戲版] pixel.css 新增 .dng-icon 完整樣式，修正遊戲模式圖示無 CSS 問題（原本只在 App.css 定義）',
    ],
  },
  {
    version: '3.9.53',
    date: '2026-04-28',
    changes: [
      '[遊戲版] 全面替換 emoji → DungeonIcon：GameSidebar 導覽圖示、GameHeader CONFIG 按鈕、GameQuestPanel 任務/達成圖示',
      '[遊戲版] JiraPage：帳號按鈕、PM 開單成功/失敗圖示、成員搜尋圖示改用 DungeonIcon（一般版保留 emoji）',
      '[遊戲版] LarkPage：移除按鈕、選擇檔案、載入中、設定說明、執行結果摘要圖示全面改用 DungeonIcon',
    ],
  },
  {
    version: '3.9.52',
    date: '2026-04-27',
    changes: [
      '[遊戲版] LarkPage：修復來源類型選擇按鈕在遊戲版顯示 DungeonIcon 圖示（icon+emoji 雙模式）',
    ],
  },
  {
    version: '3.9.51',
    date: '2026-04-27',
    changes: [
      '[架構] 新增 GameModeContext：GameApp 包一層 Provider（value=true），共用元件用 useIsGameMode() 判斷是否在遊戲版',
      '[遊戲版] LarkPage：操作類型 tab 和來源類型 tab 在遊戲版顯示 DungeonIcon 像素圖示，一般版保留 emoji',
      '[遊戲版] JiraAccountModal / GeminiSettingsModal / ChangelogModal：關閉按鈕在遊戲版顯示 DungeonIcon，一般版保留 關閉',
    ],
  },
  {
    version: '3.9.50',
    date: '2026-04-27',
    changes: [
      '[修正] linter 誤將 DungeonIcon 加入共用元件（App.tsx、LarkPage.tsx、JiraAccountModal.tsx、GeminiSettingsModal.tsx、ChangelogModal.tsx），導致一般版本出現遊戲風格圖示 — 已還原這 5 個檔案至上一個 commit',
    ],
  },
  {
    version: '3.9.49',
    date: '2026-04-27',
    changes: [
      '[遊戲版] 修正頭像選擇後未即時同步：localStorage.setItem 在同 tab 不觸發 storage 事件，改用 CustomEvent toppath:avatar-changed 廣播，所有 useAvatar 實例即時更新',
    ],
  },
  {
    version: '3.9.48',
    date: '2026-04-27',
    changes: [
      '[遊戲版] 頭像庫升級：換用 20 款全新角色（Commander/Hacker/Medic/Pilot/Mechanic/Analyst/Scout/Security/Comms/Researcher，各兩性別）',
      '[遊戲版] 頭像選擇器改為 Modal（5×4 網格），適合 20 個選項，支援 Esc 關閉',
      '[遊戲版] Header 頭像改為獨立紫框按鈕，點擊開啟選擇 Modal；舊的 commander-vN 值自動 migrate 到預設',
    ],
  },
  {
    version: '3.9.47',
    date: '2026-04-27',
    changes: [
      '[遊戲版] 修正側邊欄大頭像未連動：GameSidebar 補上 useAvatar，選擇後左側與右側同步更新',
    ],
  },
  {
    version: '3.9.46',
    date: '2026-04-27',
    changes: [
      '[遊戲版] 新增自定義頭像功能：點擊 Header 的頭像圖示可切換 6 款像素風角色（commander ~ commander-v6）',
      '[遊戲版] 頭像選擇存於 localStorage（toppath.avatar），重整後保留，支援跨分頁同步',
      '[遊戲版] useAvatar hook：統一管理選擇邏輯、驗證存儲值、無效值自動 fallback 到 commander-v2',
    ],
  },
  {
    version: '3.9.45',
    date: '2026-04-27',
    changes: [
      '[遊戲版] 增加按鈕內距：px-btn padding 8→10/18→24px，submit-btn 12→14/28→36px，modal submit 8→10/28→32px',
      '[遊戲版] 修正按鈕文字與邊框線太貼近問題',
    ],
  },
  {
    version: '3.9.44',
    date: '2026-04-27',
    changes: [
      '[遊戲版] 修正步驟指示器 "123456" 和 "1234" 顯示為純文字：補上 .step-dot/.step-indicator/.step-label 的 CSS（App.css 未載入）',
      '[遊戲版] step-dot 改為 22px 圓形徽章，active=cyan 發光，done=green，視覺清晰',
      '[遊戲版] 整體間距改善：section-card padding 加大、form-stack gap 加寬、modal-body 子元素間距加大',
    ],
  },
  {
    version: '3.9.43',
    date: '2026-04-27',
    changes: [
      '[遊戲版] 修正選擇委託人頭像過大：補上 member-list/card/avatar 的 game-mode CSS（App.css 未載入時沒有尺寸限制導致頭像撐大）',
      '[遊戲版] 委託人頭像改為 36px 緊湊格，深色主題 + cyan 選中效果',
    ],
  },
  {
    version: '3.9.42',
    date: '2026-04-27',
    changes: [
      '[遊戲版] 彈窗內 submit-btn 改回純 CSS 樣式（PNG 框架在小尺寸下透明中心偏移，對齊不準）',
      '[遊戲版] 彈窗按鈕：綠色 border + glow，完美 flex 置中，無圖片偏移問題',
    ],
  },
  {
    version: '3.9.41',
    date: '2026-04-27',
    changes: [
      '[遊戲版] 修正按鈕文字未置中：改用 display:flex + align-items:center + justify-content:center',
      '[遊戲版] 彈窗移除多餘 CSS 邊框和發光效果（已有像素藝術框架，不需要 CSS border/glow）',
      '[遊戲版] 彈窗移除 ::before 頂部漸層線（PNG 框架本身已有頂部裝飾）',
    ],
  },
  {
    version: '3.9.40',
    date: '2026-04-27',
    changes: [
      '[遊戲版] 修正彈窗內 submit-btn hover 框架消失：移除 background: 簡寫（會覆蓋 background-image），改用 background-color',
      '[遊戲版] 修正彈窗內 submit-btn background-image: none 明確清除問題',
      '[遊戲版] submit-btn 字體加大至 10px，padding 加寬，視覺更清晰',
    ],
  },
  {
    version: '3.9.39',
    date: '2026-04-27',
    changes: [
      '[遊戲版] submit-btn 改為固定寬度（max 300px）並自動置中，避免像素框架被拉伸變形',
      '[遊戲版] submit-btn--wide 同步限制最大寬度（400px），不再全版面展開',
    ],
  },
  {
    version: '3.9.38',
    date: '2026-04-27',
    changes: [
      '[遊戲版] 整合所有像素藝術圖片：btn-green/red/gold、badge-pass/warn/fail/info、modal-frame、dashboard-bg',
      '[遊戲版] .px-btn--primary/danger/gold 改用實際 PNG 框架（背景透明 + drop-shadow hover）',
      '[遊戲版] .submit-btn 改用 btn-green.png（同 px-btn 方式）',
      '[遊戲版] .px-badge 全系列改用像素藝術框架圖片',
      '[遊戲版] 彈窗框架改用 modal-frame.png（border-image，1448×1086）',
      '[遊戲版] 主背景更新為新的 dashboard-bg.png',
    ],
  },
  {
    version: '3.9.37',
    date: '2026-04-27',
    changes: [
      '[遊戲版] .px-btn 改用 border-image 正確方式套用 btn-cyan.png 框架（border-image-slice: 175 340）',
      '[遊戲版] .px-btn--primary/--danger/--gold 改用 CSS 邊框 fallback（移除不存在的 PNG 引用，避免框架消失）',
      '[遊戲版] .submit-btn 同步改用 CSS border 綠色邊框 fallback',
    ],
  },
  {
    version: '3.9.36',
    date: '2026-04-27',
    changes: [
      '[遊戲版] 修正按鈕黑色邊框：改用 background-size: calc(100%+64px) 裁掉圖片外圍深色光暈，搭配 background-position: center',
      '[遊戲版] 修正 CONFIG 按鈕文字未置中：移除 inline padding 覆蓋，改用 minWidth 讓 flexbox 正確置中',
      '[遊戲版] 所有 px-btn 變體（primary/danger/gold）同步使用相同裁切技術',
    ],
  },
  {
    version: '3.9.35',
    date: '2026-04-27',
    changes: [
      '[遊戲版] .px-btn 改用像素藝術框架圖片 btn-cyan.png（background-image: 100% 100% 縮放，透明中心顯示暗色背景）',
      '[遊戲版] .px-btn--primary / --danger / --gold 改為等待各自 PNG 圖片（btn-green/red/gold.png），未到時保持 CSS 邊框',
      '[遊戲版] .submit-btn 同步改用 btn-green.png 框架圖片樣式',
      '[遊戲版] 按鈕 hover/active 改用 filter:brightness 和 box-shadow glow 做回饋',
    ],
  },
  {
    version: '3.9.34',
    date: '2026-04-27',
    changes: [
      '[遊戲版] 修正 section-card 沒有內距：game mode 不載入 App.css 導致 padding:20px 遺失，補回 padding: 20px',
      '[遊戲版] 修正 form-stack 沒有 gap/margin：補回 flex + gap: 12px + margin-bottom: 16px',
      '[遊戲版] 修正 field 沒有 flex 佈局：補回 display:flex + flex-direction:column + gap: 5px',
    ],
  },
  {
    version: '3.9.33',
    date: '2026-04-27',
    changes: [
      '[遊戲版] Layer A：彈窗統一化 — 所有彈窗統一 max-height: 86vh、flex 佈局、.modal 寬度固定 480px、modal-box 最大 820px',
      '[遊戲版] Layer A：modal-body 統一 padding: 20px、overflow-y: auto、flex: 1 可捲動',
      '[遊戲版] Layer A：所有彈窗開啟時有像素淡入動畫',
      '[遊戲版] Layer B：OSM 頁面完整暗色主題 — osm-btn / osm-badge / osm-card / osm-channel-row / osm-comp-ver-card / osm-alert / osm-table / stat-chip 等全部覆蓋',
      '[遊戲版] Layer C：AutoSpin、History 等 8 個使用 inline style 頁面的白色背景、淡色文字、圓角、分隔線全部替換為遊戲主題色',
      '[遊戲版] Layer D：版面節奏統一 — page-layout gap、section-title margin、inline border-radius 統一歸零',
    ],
  },
  {
    version: '3.9.32',
    date: '2026-04-27',
    changes: [
      '[遊戲版] Phase 2 互動效果：切換頁面時有像素淡入滑動動畫（steps transition）',
      '[遊戲版] 按鈕點擊時光掃效果（白光横掃 mix-blend-mode:screen）',
      '[遊戲版] 側邊欄子選單啟用項目改為綠色左邊框指示器',
      '[遊戲版] px-panel hover 時頂部掃描線動畫',
      '[遊戲版] .px-corners 工具類：左上青色 + 右下金色角落裝飾',
      '[遊戲版] .px-loading 動態點點動畫（LOADING...）',
      '[遊戲版] .px-title-glitch 色差閃爍效果',
      '[遊戲版] XP 進度條加上 25/50/75% 金色 checkpoint 刻度',
      '[遊戲版] 表格行點擊時位移反饋',
      '[遊戲版] 輸入框 focus 時左邊框加粗青色指示器',
    ],
  },
  {
    version: '3.9.31',
    date: '2026-04-27',
    changes: [
      '[遊戲版] 修正表格太擠：version-table / table-wrap 補上 padding: 8px 12px、vertical-align: top、word-break: break-word、line-height: 1.6，移除等寬字型覆蓋',
      '[遊戲版] 修正 tc-detail 展開列字型：移除 pixel font 和 monospace font，改為保持原字型只調整顏色與行高',
    ],
  },
  {
    version: '3.9.30',
    date: '2026-04-27',
    changes: [
      '[遊戲版] 修正中文文字破版：移除 section-title / action-tab / field 標籤的 pixel font 和 text-transform 設定，改為只調整顏色和尺寸，確保中文字正常顯示',
      '[遊戲版] 修正 CSS attribute selector：改用結構選擇器（.form-stack > div）代替 hex 顏色字串比對（瀏覽器會將 hex 轉成 rgb 導致無法匹配）',
    ],
  },
  {
    version: '3.9.29',
    date: '2026-04-27',
    changes: [
      '[遊戲版] 全頁排版美化：section-card 暗色底、section-title 像素字體、action-tab 像素按鈕、field 表單元素暗色主題',
      '[遊戲版] 內聯樣式強制覆蓋：LarkPage spec 卡片、來源選擇 pill、輸入框、文字顏色全部對應暗色系',
      '[遊戲版] summary-item / bitable-link-btn / tc-detail / version-table 全部套用像素風格',
    ],
  },
  {
    version: '3.9.28',
    date: '2026-04-27',
    changes: [
      '[遊戲版] 修正彈框 關閉 位置：modal-header 補上 flex 佈局，關閉按鈕正確推到右側',
      '[遊戲版] 全頁按鈕/UI 像素化：submit-btn（綠）/ btn-ghost（青框）/ source-btn / settings-btn / badge / alert-warn / alert-error / result-box / info-block 全部套用 pixel 風格',
      '[遊戲版] modal-tabs 修正間距與點擊區域，modal-tab 補上 cursor 與 pixel font',
    ],
  },
  {
    version: '3.9.27',
    date: '2026-04-27',
    changes: [
      '[遊戲版] Badge 全面重設計：依 badges_status.png 規格實作 GLOW（發光框線）/ SOLID（實心填色）/ OUTLINE（純框線）三種樣式，PASS/WARN/FAIL/SKIP/RUN/ONLINE/OFFLINE 各有對應色彩與 box-shadow 發光',
      '[遊戲版] Button 全面重設計：依 buttons_states.png 規格實作 SECONDARY（青）/ PRIMARY（綠）/ DANGER（紅）三種樣式，每種均有 Default / Hover（發光）/ Pressed（實心填色）/ Disabled（灰暗）四個狀態',
    ],
  },
  {
    version: '3.9.26',
    date: '2026-04-26',
    changes: [
      '[遊戲版] JiraAccountModal 像素風格套用：帳號卡片、角色徽章、動作按鈕（PIN/角色/刪除）、RoleToggle、管理員區塊全部改為暗色像素美術風格，submit 按鈕改為像素框線樣式',
    ],
  },
  {
    version: '3.9.25',
    date: '2026-04-24',
    changes: [
      '機台測試需要帳號登入：未選擇帳號時顯示警告橫幅且開始按鈕禁用，確保測試結果與帳號綁定',
      '新增「我的測試紀錄」面板：可查看目前帳號的歷史測試 session，展開後顯示每台機器各步驟結果，並內嵌 CCTV 截圖縮圖（點擊放大）與音頻播放按鈕',
      '測試結果自動儲存至 DB（machine_test_sessions 表），保留 30 天，每次測試後自動新增',
    ],
  },
  {
    version: '3.9.24',
    date: '2026-04-26',
    changes: [
      'CCTV 截圖與音頻錄音改存伺服器端：測試截圖存至 server/machine-test/cctv-saves/{機台代碼}.png，錄音存至 server/machine-test/audio-saves/{機台代碼}.wav，透過 API 提供給所有使用者',
      '測試結果表格新增預覽：CCTV 欄直接顯示縮圖，點擊放大；音頻欄顯示 聲 按鈕，點擊直接在瀏覽器播放錄音',
    ],
  },
  {
    version: '3.9.23',
    date: '2026-04-26',
    changes: [
      '音頻錄音本地存檔：每台機器音頻步驟完成後，將分析用的 WAV 錄音存一份到 C:\\Users\\user\\Desktop\\Audio-Recordings\\{機台代碼}.wav，方便事後人工聆聽確認判斷依據',
    ],
  },
  {
    version: '3.9.22',
    date: '2026-04-24',
    changes: [
      'Agent 強制 headless：agent 機器執行測試時忽略主機 UI 的 headedMode 設定，始終以無頭模式跑 Playwright，避免 agent 機器跳出可見瀏覽器視窗',
    ],
  },
  {
    version: '3.9.21',
    date: '2026-04-24',
    changes: [
      'Agent 安裝包修正：v3.9.18 新增 callGeminiVisionMulti 後，runner.ts 的 import 從單個變成兩個，但安裝包重寫 gemini import 的 regex 仍用舊格式，導致 agent 啟動時報 Cannot find module routes/gemini.js。修正 regex 改為匹配任意 import 內容，並在 gemini-agent.ts 中補上 callGeminiVisionMulti 實作',
    ],
  },
  {
    version: '3.9.20',
    date: '2026-04-24',
    changes: [
      '機台測試：大廳 URL 每個 Worker 列新增 冊 按鈕，點擊開啟帳號池選取 Modal，直接從帳號池選取帳號填入 URL，不需切換頁面（避免測試設定資料被清空）',
    ],
  },
  {
    version: '3.9.19',
    date: '2026-04-24',
    changes: [
      'CCTV OCR + 基準圖比對合併為單次 Gemini 呼叫：有基準圖時改用 callGeminiVisionMulti 一次送兩張圖（基準圖 + 當前截圖），同時取得 OCR 識別碼與鏡頭位置比對結果，避免兩次 Gemini 呼叫導致 API Key 配額耗盡',
      'CCTV 鏡頭比對 Prompt 強化：改為逐項比較左右位置、上下位置、傾斜角度、大小比例，任一項偏差超過 10% 即判為跑位（修正先前 Gemini 誤判「位置正常」的問題）',
      '退出步驟修正：點擊 btn_cashout 後第一個 leaveGMNtc 監聽器 10 秒逾時後進入 Exit/Confirm 流程，此時舊監聽器已清除；改為在 Exit/Confirm 點擊前重新建立監聽器（15 秒），確保確認對話框後觸發的 leaveGMNtc errcode 能被正確捕捉與判斷',
    ],
  },
  {
    version: '3.9.18',
    date: '2026-04-24',
    changes: [
      'CCTV 基準圖庫：新增按機種管理基準圖功能。機台設定頁新增「影 CCTV 基準圖庫」區塊，可上傳/更換/刪除各機種基準圖（存於 server/machine-test/cctv-refs/{機種}.png）',
      'CCTV 測試新增鏡頭位置比對：測試時自動查找對應機種的基準圖，找到後將基準圖 + 當前截圖一起送 Gemini 比對，判斷鏡頭是否跑位；不一致時步驟判為 WARN 並記錄偏差說明',
      '新增 callGeminiVisionMulti：Gemini Vision 多圖版本，支援一次送多張圖片',
    ],
  },
  {
    version: '3.9.17',
    date: '2026-04-24',
    changes: [
      'CCTV 截圖自動複製：每次 CCTV 步驟截圖時，同步存一份到 C:\\Users\\user\\Desktop\\CCTV-Screenshots\\{機台代碼}.png，資料夾不存在時自動建立',
    ],
  },
  {
    version: '3.9.16',
    date: '2026-04-24',
    changes: [
      '音頻 AI 分析優先：啟用 AI 音頻分析時，以 AI 判斷為主。AI 判定正常 → 清除 RMS 閾值觸發的問題，結果為 PASS；AI 判定有問題 → 僅保留 AI 判斷結果（清除 RMS 問題），結果為 WARN。AI 分析失敗時回退 RMS 判斷（不變）',
    ],
  },
  {
    version: '3.9.15',
    date: '2026-04-24',
    changes: [
      '音頻 Lark 回寫修正：靜音判斷從 msg.includes("靜音") 改為 msg.includes("靜音（")，避免 AI 回傳「音頻非靜音」中的「靜音」被誤判為靜音問題，導致同時出現 audio silent + audio loud',
    ],
  },
  {
    version: '3.9.14',
    date: '2026-04-24',
    changes: [
      '機台測試：修正「進入機台」步驟一直被判定為 WARN（未收到 enterGMNtc）的問題。根本原因：pinus 使用 route dictionary 壓縮時，WS 幀中不含 "enterGMNtc" 字串；新增 GM_EVENT_MONITOR_SCRIPT，在瀏覽器層 hook WebSocket 構造函式與 console.log，直接截取 enterGMNtc / leaveGMNtc 事件並以 console "__gm_event:" 前綴回報給 Playwright，console listener 同步更新以處理此前綴',
    ],
  },
  {
    version: '3.9.13',
    date: '2026-04-23',
    changes: [
      'UAT 測試工具：完成時自動停止並更新狀態為「完成」（從 log 偵測「完成！」字樣）',
      'UAT 測試工具：Lark TC 路徑新增「察 掃描」按鈕，顯示各大項 TC 名稱與子項目數量',
      'UAT 測試工具：結果狀態列改為長駐（永遠顯示 通過/需人工/跳過/失敗，預設為 0）',
    ],
  },
  {
    version: '3.9.12',
    date: '2026-04-23',
    changes: [
      'Jackpot API 根本修正：timestamp 改為 Date.now() - 1000（減 1 秒）。server 端會驗證 timestamp 不能太「新」，使用當下時間會被 reject（error 101）；減 1 秒後全程穩定，5 次 15s 輪詢全數成功',
    ],
  },
  {
    version: '3.9.11',
    date: '2026-04-23',
    changes: [
      'Jackpot 輪詢改回 15 秒；前端說明文字同步更新',
    ],
  },
  {
    version: '3.9.10',
    date: '2026-04-23',
    changes: [
      'Jackpot 輪詢修正：移除 OSM 登入 token 機制，改用 Cloudflare __cf_bm cookie jar。每次回應自動擷取 Set-Cookie 中的 __cf_bm，下次請求帶回；首次 error 101 後立即以新 cookie 重試一次，解決 Cloudflare bot 驗證問題',
    ],
  },
  {
    version: '3.9.9',
    date: '2026-04-23',
    changes: [
      'Jackpot 輪詢修正：API 需要帶 OSM token header，不能帶 Origin header（帶了反而 error 101）；現在輪詢前自動以 OSM_CHANNEL_CP_USERNAME/PASSWORD 登入取 token，token 過期後自動重新登入',
    ],
  },
  {
    version: '3.9.8',
    date: '2026-04-23',
    changes: [
      'Jackpot 後端輪詢由 15s 改為 60s：center-image-recon.osmplay.com 有 Cloudflare 保護，每 15s 連打會觸發 IP rate limit（error 101 参数错误），改為 60s 避免封鎖',
      'Jackpot 狀態列新增「最後嘗試」時間，與「上次成功」分開顯示，方便診斷 API 返回空資料的情況',
    ],
  },
  {
    version: '3.9.7',
    date: '2026-04-23',
    changes: [
      'Jackpot 輪詢修正：fetch 無 timeout 導致 server 掛住時 setInterval 持續疊加 hung call，lastUpdated 永遠不更新。改為 10 秒 AbortController timeout + jpPolling flag 防止重疊呼叫；Lark webhook 也加 8 秒 timeout',
    ],
  },
  {
    version: '3.9.6',
    date: '2026-04-19',
    changes: [
      'Jackpot 監控改為純後端驅動：Server 啟動後立即執行 15 秒輪詢，不再依賴前端頁面是否開啟',
      '異常偵測（位數異常/超出閾值/暴增50%）與 Lark 告警邏輯全部移至後端，前端僅做狀態顯示',
      '前端每 5 秒輪詢 /api/osm/jackpot/state 取得最新獎池資料與異常日誌',
      'Channel ID 變更後 800ms debounce → POST /api/osm/jackpot/channel，後端立即重置並以新 Channel 拉取',
    ],
  },
  {
    version: '3.9.5',
    date: '2026-04-20',
    changes: [
      'Lark 回寫音頻問題描述修正：修正 msg.includes("靜音") 誤匹配 "不靜音" 的 bug（會錯誤寫入 audio silent）；改為獨立條件判斷（不再 else-if），音量過大 + AI 爆音可同時出現在 Lark 欄位',
    ],
  },
  {
    version: '3.9.4',
    date: '2026-04-20',
    changes: [
      '退出重試邏輯修正：舊版只在 leaveGMNtc errcode=10002 時才觸發 checkOsm 重試；Jackpot 觸發時遊戲可能沉默拒絕退出（無 leaveGMNtc 回應），導致直接 FAIL 不重試。現改為只要退出失敗就檢查 OSMWatcher，有特殊遊戲狀態則等待結束後重試，最多 3 次',
    ],
  },
  {
    version: '3.9.3',
    date: '2026-04-20',
    changes: [
      'enterGMNtc / leaveGMNtc 偵測修正：同時支援兩種 pinus push 格式 — {"event":"enterGMNtc",...} 及 {"route":"enterGMNtc","body":{...}}，舊解析器只認第一種，使用新格式的機台會誤判「未收到」',
    ],
  },
  {
    version: '3.9.2',
    date: '2026-04-19',
    changes: [
      '音頻錄製時機修正：改為在 Spin 點擊後 300ms 同步啟動 5 秒錄音（捕捉轉軸動畫中的真實遊戲音效），不再等 Spin 結束後才錄製閒置狀態',
      '音頻步驟直接使用 Spin 期間錄製的資料；若 Spin 步驟未啟用才補錄一次閒置音頻',
      'AI 音頻分析的 WAV 現在也是 Spin 期間捕捉的錄音，分析結果更準確',
    ],
  },
  {
    version: '3.9.1',
    date: '2026-04-19',
    changes: [
      'Jackpot 監控改為自動常駐：頁面開啟即自動輪詢，移除手動開始/停止按鈕',
      'Channel ID 可邊跑邊改：修改後自動重置前次記錄並立即以新 Channel 重新拉取',
      '告警設定儲存後立即套用新閾值：清除已通知記錄，下一輪（15s）用新參數重新偵測',
    ],
  },
  {
    version: '3.9.0',
    date: '2026-04-19',
    changes: [
      '分散式 Work-Stealing 架構：分散式 Agent 改為動態搶工模式，Agent 每次完成一台機器後主動向 Server 領取下一台，先跑完的電腦自動接手更多任務，充分利用多機器並行效能',
      '新增 claim_job / job_done / session_join / job_assigned / no_more_jobs WebSocket 訊息協議',
      '新增 /api/machine-test/queue-status API：查詢目前工作佇列的機台分配狀態',
      'MachineTestPage 新增「分散式佇列狀態」面板：即時顯示每台機器的狀態（等待/執行中/完成/失敗）、執行 Agent 及耗時',
      '移除舊式 chunk-split 分發邏輯，Server 不再預先平均分配機台給 Agent',
    ],
  },
  {
    version: '3.8.1',
    date: '2026-04-19',
    changes: [
      'Gemini 改為 per-key Bottleneck 限速器：相同 API Key 的請求串行排隊，不同 Key 可平行執行，避免效能衝突',
      'LarkPage 狀態恢復：AI 生成 TestCase 任務的 requestId 儲存至 localStorage，切換頁面或重整後自動重連 SSE 恢復進度',
      'JiraPage 狀態恢復：批次評論任務 requestId 儲存至 localStorage，重整後自動輪詢結果並回復到 Step 5 顯示',
      'MachineTestPage 狀態恢復：頁面載入時自動查詢 /api/machine-test/status，若有進行中的測試則自動重連 WebSocket',
      '機台測試狀態 API 新增 sessionId 欄位，供前端恢復後可正常執行停止操作',
    ],
  },
  {
    version: '3.8.0',
    date: '2026-04-19',
    changes: [
      'OSMWatcher 連續監控：進入機台後每個步驟（推流/Spin/音頻/iDeck/觸屏/CCTV/退出）前均檢查狀態，偵測到特殊遊戲時先執行指定動作一次（spin/takewin/touchscreen），再持續 Spin 直到 status=0',
      'Spin 測試改為 3 次點擊：每次等待動畫完成後再點下一次，最後比對前後餘額差異',
      '退出重試：leaveGMNtc errcode=10002 時自動檢查 OSMWatcher，若仍在特殊遊戲中等待恢復後重試，最多 3 次',
      'AI 音頻分析（可選）：VB-Cable 錄音上傳至 Gemini，判斷靜音/音量/爆音/雜訊',
      '機台測試新增日誌 API 環境選擇（QAT / PROD）',
      '機台設定檔新增 iDeck XPath 列表、兩段式進入觸屏（entryTouchPoints2）',
      '新增 Headed 模式（瀏覽器視窗顯示在螢幕上）',
      '新增操作流程面板（展示步驟順序與設定檔資訊）',
      '修正 CCTV 步驟名稱不一致導致結果表格顯示「—」',
      '修正 enterGMNtc 在觸屏進入階段偶發漏接',
      'Lark 回寫補上 CCTV/Spin/觸屏各類異常狀況描述',
    ],
  },
  {
    version: '3.7.31',
    date: '2026-04-17',
    changes: [
      'TestCase 生成支援多份規格書：可新增多筆來源（Lark Wiki / PDF / Google 文檔，可混合），後端逐份讀取後合併內容送 Gemini 整合生成，避免重複案例',
    ],
  },
  {
    version: '3.7.30',
    date: '2026-04-16',
    changes: [
      'Jackpot 告警設定：合併閾值範圍（min/max）與 Lark 告警開關到同一介面，每個等級一行，包含最小值、最大值輸入框 + 發 Lark 勾選框',
    ],
  },
  {
    version: '3.7.29',
    date: '2026-04-16',
    changes: [
      'Jackpot 告警設定重設計：改用 gameid 欄位做 key，設定介面改為每遊戲×每等級的勾選開關，未勾選的等級異常仍在頁面標紅但不推 Lark；表格欄位顯示 靜 提示告警已關閉',
    ],
  },
  {
    version: '3.7.28',
    date: '2026-04-16',
    changes: [
      'Jackpot 監控：新增管理員閾值設定（陣 閾值設定按鈕），各遊戲可獨立設定每個獎池等級的 min/max 合理範圍，儲存至後端 DB，設定後立即生效',
    ],
  },
  {
    version: '3.7.27',
    date: '2026-04-16',
    changes: [
      'Jackpot 監控獨立為 OSM Tools 子頁面：從 OSM 版號同步頁抽出，異常時自動偵測（位數異常 ±2 位、數值超出合理範圍、單次暴增 >50%）並推送 Lark 告警',
    ],
  },
  {
    version: '3.7.26',
    date: '2026-04-16',
    changes: [
      'OSM Tools 新增「Jackpot 獎池監控」：背景每 15 秒自動拉取 center-image-recon API，顯示所有遊戲的 Grand/Major/Minor/Mini/Fortunate 獎池金額，支援自訂 Channel ID',
    ],
  },
  {
    version: '3.7.25',
    date: '2026-04-15',
    changes: [
      '修正服務重啟時 Port 3000 被佔用的問題：加入 SIGTERM/SIGINT graceful shutdown，確保 port 快速釋放',
      'tsx --watch 加入 --ignore 排除 DB 檔案，避免 SQLite 寫入觸發不必要的服務重啟',
    ],
  },
  {
    version: '3.7.24',
    date: '2026-04-15',
    changes: [
      '修正 TestCase 生成：Gemini 有時在 JSON 字串值內輸出真實換行字元導致解析失敗，加入自動修復後重試',
    ],
  },
  {
    version: '3.7.23',
    date: '2026-04-15',
    changes: [
      'QA 開單 Step 5：新增即時進度條，顯示「處理中 X/Y 筆」及當前 Issue Key，讓使用者感知後台執行狀態',
    ],
  },
  {
    version: '3.7.22',
    date: '2026-04-15',
    changes: [
      'QA 開單 Step 5 添加評論：改為 SSE 背景作業，解決批次執行中途斷線問題',
    ],
  },
  {
    version: '3.7.21',
    date: '2026-04-15',
    changes: [
      'AI 模型設定：Gemini Key 表格移除「今日用量」和「總呼叫」欄，只保留狀態和上次使用',
      '修正刪除按鈕文字斷行問題',
    ],
  },
  {
    version: '3.7.20',
    date: '2026-04-15',
    changes: [
      'OSM 版本追蹤：統一所有區塊為 card 樣式（白底 + 邊框 + 圓角），間距一致',
      '設定視窗 / 更新日誌：修正標題縮排，增加 header padding 不再靠邊',
    ],
  },
  {
    version: '3.7.19',
    date: '2026-04-15',
    changes: [
      '修正 Gemini Key 刪除後重啟服務會重新出現的問題（gemini-keys.json 遷移後改名，不再重複 import）',
      '上方按鈕改名為「AI 模型和 Prompt 設定」',
    ],
  },
  {
    version: '3.7.18',
    date: '2026-04-15',
    changes: [
      '新增 OpenAI API 整合，可在 AI 模型設定 → OpenAI Key 頁填入 Key，無需修改 .env，儲存後 Model Selector 自動出現 Codex Mini / GPT-5.3 / GPT-4o',
    ],
  },
  {
    version: '3.7.17',
    date: '2026-04-15',
    changes: [
      'LarkPage：改用 SSE 架構，後端背景執行完成後主動推送結果，前端只需等待，不做任何輪詢',
      'Ollama：修正 gemma4 等大模型因 headers timeout 導致請求失敗，改用 undici Agent 設定 10 分鐘 timeout',
    ],
  },
  {
    version: '3.7.8',
    date: '2026-04-11',
    changes: [
      '新增 Agent 安裝包下載：/api/machine-test/agent/install.bat 自動下載原始碼、npm install、playwright install',
      '新增 gemini-agent.ts：Agent 端獨立 Gemini Vision 輔助，不依賴 Express/DB',
      '機台測試頁新增「分散式 Agent 安裝指南」區塊（含步驟說明、下載按鈕、VB-Cable 注意事項）',
      'package.json 明確加入 ws 和 @types/ws 依賴',
    ],
  },
  {
    version: '3.7.7',
    date: '2026-04-10',
    changes: [
      '分散式測試架構：新增 Agent 機制，多台電腦各跑一批機台，任務自動分配、進度廣播給所有觀看者',
      '新增 agent-runner.ts：Worker 電腦執行 CENTRAL_URL=ws://... node dist/server/agent-runner.js 即可加入 Agent 池',
      '測試頁新增 Agent 狀態列（已連線/執行中/待機）與「視 觀看」按鈕（不發起測試，僅接收廣播進度）',
      'WebSocket 廣播頻道 /ws/machine-test/events：所有觀看者共用，新加入自動補播歷史進度',
    ],
  },
  {
    version: '3.7.6',
    date: '2026-04-10',
    changes: [
      '機台測試連線改用 WebSocket（取代 SSE）：雙向保持連線、原生協議層 ping/pong，多裝置監控不再斷線',
    ],
  },
  {
    version: '3.7.5',
    date: '2026-04-10',
    changes: [
      '機台設定檔：觸屏設定整合成一個區塊（touchPoints / 進入前第一/二階段），不再依賴 Bonus 啟動方式條件顯示',
      '音頻靜音判斷改用 Crest Factor 輔助：RMS < -60 但有動態（Crest ≥ 6）→ 改判為「音量偏小」而非靜音',
      '修復 Zod v4 z.record 單參數問題（bet-random、actions、manualTestCases）',
      'SSE 斷線自動重連（最多 8 次）：從其他裝置監控時不再因網路波動誤判測試結束',
    ],
  },
  {
    version: '3.7.4',
    date: '2026-04-10',
    changes: [
      '新增 Test 調適模式：開啟後可填入固定渠道號，iDeck/觸屏測試的盒子日誌 API gmid 將使用此值，方便跨機台調試',
    ],
  },
  {
    version: '3.7.3',
    date: '2026-04-10',
    changes: [
      'CCTV OCR 新增時間戳記擷取（time 欄位）及異常文字偵測（unexpected），出現異常文字時判定 warn',
    ],
  },
  {
    version: '3.7.2',
    date: '2026-04-10',
    changes: [
      'CCTV 測試新增畫面模糊偵測：Gemini Vision 同時回傳識別碼與 blur 狀態（clear/blurry），模糊時判定 warn',
      'Playwright viewport 改為 428×739，正確呈現手機版遊戲版面（修復 CCTV 截圖抓到遊戲 UI 的問題）',
    ],
  },
  {
    version: '3.7.1',
    date: '2026-04-10',
    changes: [
      '新增 CCTV 測試步驟（stepCctv）：點擊 .header_btn_item 切換 CCTV，驗證 video 播放狀態，截圖後用 Gemini Vision OCR 讀取機台號碼',
      'gemini.ts 新增 callGeminiVision 函數，支援圖片+文字多模態請求',
    ],
  },
  {
    version: '3.7.0',
    date: '2026-04-10',
    changes: [
      '新增觸屏測試步驟（stepTouchscreen）：點擊 profile 的 touchPoints 點位，API 確認 success_json is_touch=true，同樣使用基準線比對法',
      'UI：Phase 2 卡片更名為「iDeck / 觸屏測試」，顯示兩個步驟的說明',
    ],
  },
  {
    version: '3.6.9',
    date: '2026-04-10',
    changes: [
      'iDeck 步驟：改用基準線比對法（點擊前先記錄現有 entry，點完所有按鈕等 API 同步後計算新增筆數），解決本機時鐘與 API 時間差約 30 秒的問題',
      'iDeck 步驟：按鈕點擊間隔改為 5 秒',
    ],
  },
  {
    version: '3.6.8',
    date: '2026-04-09',
    changes: [
      'iDeck 步驟：優先使用「隨機下注」XPath 列表（bet_random.json），逐一點擊所有按鈕（非隨機），不再需要 ideckRowClass',
    ],
  },
  {
    version: '3.6.7',
    date: '2026-04-09',
    changes: [
      'iDeck 步驟：每次按鈕點擊後同時等待 pinus WS 回應（cmd + error）並驗證，結果顯示 通過/失敗WS(cmd)',
    ],
  },
  {
    version: '3.6.6',
    date: '2026-04-09',
    changes: [
      '機台測試：攔截 pinus WS 幀偵測 enterGMNtc / leaveGMNtc 錯誤，將 errcodedes 寫入步驟結果（進而回寫 Lark）',
      '音頻測試：修正 sampleSpinAudio catch block 未還原 media.muted，避免誤判 PASS',
      '機台測試 log 時間戳改為 UTC+8（Asia/Taipei）',
      '音頻測試：nircmd 路徑改為穩定位置 AppData/Local/nircmd/',
    ],
  },
  {
    version: '3.6.5',
    date: '2026-04-09',
    changes: [
      '機台類型卡片：有差異時可展開查看缺少的 gmid 清單（以後台 online 機台為基準）',
      '後端 frontend-machines-auto：回傳完整 gmids[] 陣列供前端比對',
    ],
  },
  {
    version: '3.6.4',
    date: '2026-04-08',
    changes: [
      'OSM 機台類型統計：改為只計算 online 機台數量（排除 offline）',
      '移除前端擷取腳本功能（複製腳本、push polling）',
      '版面整理：移除腳本提示區塊，簡化前端機台數輸入區',
    ],
  },
  {
    version: '3.6.3',
    date: '2026-04-08',
    changes: [
      '前端機台抓取：改用 Playwright WebSocket 幀攔截（hall.hallHandler.getAllGMListReq），移除 gameid 觸發 server push，latin1 解碼大型幀',
      '修正推送腳本與瀏覽器端 pinus 請求路由：lobby.lobbyHandler → hall.hallHandler',
    ],
  },
  {
    version: '3.6.2',
    date: '2026-04-08',
    changes: [
      'OSM 版本同步頁：新增機台類型數量統計卡片，對比 OSM 後台數量與前端實際在線機台數',
      '新增 pinus WebSocket 客戶端（server/lib/pinus-client.ts），透過 getAllGMListReq 取得前端機台清單',
      '新增 POST /api/osm/frontend-machines 端點，解析遊戲 URL 取得 gate 位址並連線查詢',
      'Gemini：修正 503 過載時未自動切換下一個 key 的問題',
      'Gemini：修正 probe 呼叫污染 calls_today 計數器的問題',
      'Gemini：調整 rate limiter 為 maxConcurrent:1 避免多 key 同時觸發 RPM 上限',
      'Gemini 設定：新增 last_used_at 顯示欄位，禁 配額耗盡標記移至上次使用欄位下方',
      'OSM serverCfg.js：改為解析 HTML 頁面尋找正確路徑（修正 PC 版 /config/serverCfg.js 無法找到的問題）',
    ],
  },
  {
    version: '3.6.1',
    date: '2026-04-07',
    changes: [
      '新增「察 後台對帳」分頁：設定後台 API token/channelId，選時間範圍執行對帳',
      'Agent 每 20 次 Spin 自動從 window.pinus 取得前端戰績上傳至 server',
      '對帳比對：前端紀錄 vs 後台 gameRecordList，標記 MATCH/MISSING，偵測大獎/連發異常',
      '支援自動重登（token 失效時自動以帳密換新 token），歷史對帳報告可回顧',
    ],
  },
  {
    version: '3.6.0',
    date: '2026-04-06',
    changes: [
      'AutoSpin 新增「圖 歷史戰績」分頁：每 20 次 Spin 記錄餘額快照，追蹤 Bonus/低餘額/錯誤事件',
      '異常偵測：餘額相比本次開局下降超過 30% 時自動標記黃色警告',
      '戰績紀錄可依機台類型篩選，支援清除',
    ],
  },
  {
    version: '3.5.9',
    date: '2026-04-06',
    changes: [
      'AutoSpin Agent 新增 Playwright 自動錄影（勾選「啟用錄影」即生效，存到 recordings/ 目錄）',
      'AutoSpin Agent 新增 OpenCV 模板比對（需 pip install opencv-python），偵測 Bonus/Error 狀態',
      'AutoSpin Agent 新增 Lark 推播通知（機台設定填 Webhook URL，低餘額/頁面錯誤/模板匹配時自動推播）',
    ],
  },
  {
    version: '3.5.8',
    date: '2026-04-06',
    changes: [
      'AutoSpin Agent 新增暫停/繼續功能（⏸ 按鈕，3 秒內生效）',
      'AutoSpin Agent 新增 404/錯誤頁面偵測，自動 reload 重進遊戲',
      'AutoSpin Agent 新增低餘額自動退出重進（機台設定可設閾值）',
    ],
  },
  {
    version: '3.5.7',
    date: '2026-04-06',
    changes: [
      'AutoSpin 新增「隨機下注」設定頁：管理各機台的 bet_random.json XPath 列表，支援新增/編輯/刪除',
    ],
  },
  {
    version: '3.5.6',
    date: '2026-04-06',
    changes: [
      'AutoSpin 執行監控新增即時 Spin 間隔調整（滑桿 0.1~10s + 套用按鈕），覆蓋所有機台，3 秒內生效',
    ],
  },
  {
    version: '3.5.5',
    date: '2026-04-06',
    changes: [
      'AutoSpin：新增頻率功能（Spin 間隔設定，每台機台可獨立設定秒數）',
      'AutoSpin：新增隨機下注（BetRandom，讀取 bet_random.json，Spin 後 30% 機率點擊）',
      'AutoSpin：新增隨機離開（RandomExit，設定機率與最少 Spin 次數，觸發後重新進入遊戲）',
      'AutoSpin Agent：popup 廣告自動關閉、scroll into view 再點擊遊戲卡片',
    ],
  },
  {
    version: '3.5.4',
    date: '2026-04-06',
    changes: [
      'AutoSpin 機台設定改為個人化儲存：設定綁定登入帳號，各人設定互不干擾',
      'AutoSpin 本機端啟動時自動帶入帳號資訊，Agent 只載入當前使用者的設定',
      'AutoSpin 頁面頂部顯示目前帳號，未選擇帳號時提示警告',
    ],
  },
  {
    version: '3.5.3',
    date: '2026-04-06',
    changes: [
      'URL 帳號池：改為「複製使用 URL」機制，產生中轉連結（/api/url-pool/go/:account），貼到 AutoSpin / 機台測試 Game URL 即可',
      'URL 帳號池：中轉連結開啟時自動認領帳號，無需手動點使用',
      'URL 帳號池：認領自動過期 8 小時，每 30 分鐘清一次過期資料',
    ],
  },
  {
    version: '3.5.2',
    date: '2026-04-05',
    changes: [
      'OSM Tools 新增「URL 帳號池」功能：190+ 組 Token URL 集中管理，即時查看使用狀態（SSE）',
      '帳號池支援使用 / 釋放按鈕，即時通知其他使用者（不可搶佔），支援搜尋與篩選',
      '帳號池 URL 支援本地編輯（無需上傳）',
      'App 頂部新增全域帳號選擇器，各功能頁面共用同一 Jira 帳號狀態',
    ],
  },
  {
    version: '3.5.1',
    date: '2026-04-04',
    changes: [
      'AutoSpin 執行監控新增「伺服器端 / 本機端（Agent）」模式切換',
      '本機端模式：提供「下載安裝包」與「啟動（本機）」按鈕，透過 toppath-agent:// URI 啟動本地 Playwright Agent',
      'Agent Log 與伺服器 Log 分開顯示，截圖欄位依模式切換對應來源',
    ],
  },
  {
    version: '3.5.0',
    date: '2026-04-04',
    changes: [
      'OSM Tools 新增「AutoSpin」功能：整合 project/AutoSpin.py，透過 Web UI 管理機台設定並監控執行',
      'AutoSpin 機台設定：新增 / 編輯 / 刪除各機台的 GameURL、RTMP、模板類型等設定，存入 DB（autospin_configs）',
      'AutoSpin 模板管理：直接上傳 / 刪除 project/templates/ 中的 OpenCV 比對模板圖片',
      'AutoSpin 執行監控：啟動 / 停止 Python 程序，即時 Log 串流（SSE），截圖自動更新顯示',
      '啟動時自動從 DB 生成 game_config.json 寫入 project 目錄，確保設定同步',
    ],
  },
  {
    version: '3.4.0',
    date: '2026-04-04',
    changes: [
      'OSM Tools 新增「Config 比對」功能：貼上線上 URL，自動 fetch serverCfg.js 並與儲存的模板深層比對',
      'Config 比對：支援多模板管理（存入 DB），可依名稱 / 版本識別',
      'Config 比對：深層遞迴比對，顯示值不一致、線上缺少、線上多出三種差異類型，支援篩選',
      'Config 比對：可選 Gemini AI 分析差異是否影響功能並給出建議',
      'Gemini 設定：每次開啟自動 probe 所有 Key，即時顯示可用狀態',
      'Gemini 設定：新增每日用量進度條（綠 / 橘 / 紅）與 Round-robin 下一個 Key 標示',
    ],
  },
  {
    version: '3.3.0',
    date: '2026-04-02',
    changes: [
      'Game Show 整合：新增四個子工具頁面（PDF TestCase 生成、圖片比對、500x 機率統計、Log 攔截工具）',
      'PDF TestCase：支援上傳 PDF / DOCX 規格書，Gemini AI 自動生成測試案例，支援差異比對模式與 CSV 匯出',
      '圖片比對：以 Playwright 攔截兩個遊戲 URL 的所有載入圖片，自動配對並顯示相似度與大小差異',
      '500x 機率統計：Playwright 攔截 Bonus V2 遊戲 WebSocket，即時統計各骰型分布',
      'Log 攔截工具：提供可注入瀏覽器 Console 的 XHR 攔截腳本，解析雙層 JSON 並顯示浮動面板',
      '導覽重構：改為兩層式分組導覽（群組列 + 子分頁列），新增 Game Show 群組',
      'Jira 批量開單：受託人成員欄位新增搜尋篩選',
      'Jira 批次評論：支援 Google Drive 連結附件（圖片自動上傳，影片寫入評論內文）',
    ],
  },
  {
    version: '3.2.0',
    date: '2026-04-01',
    changes: [
      'QA 批次評論支援附件上傳：Step 5 新增「附件欄位」選擇器，從 Lark Drive 下載檔案並自動上傳至 Jira Issue 附件',
      'PM 批次開單：修正 parentKeyMap 以純標題（title）為 key，解決「選擇主單並關聯」欄位無法正確關聯父單的問題',
      'PM 批次開單：單號連結改寫為 URL 格式（顯示文字為 Issue Key，超連結指向完整 Jira URL）',
      'PM 批次開單：新增難易度（customfield_10433）寫入，支援 簡單/低/中/高/困難',
      'PM 模式：Step 2 確認表新增「難易度」欄位顯示',
      'PM 模式：移除 Step 1 帳號選擇（改由頂部帳號列統一管理），流程縮短為 3 步',
      '帳號權限管理：新增 QA/PM 角色控制，管理員可編輯角色（支援雙角色並存），一般新增帳號僅可選單一角色',
      '帳號彈窗版面優化：操作按鈕整合至帳號卡片右側，修正溢出問題',
      '角色同步修正：管理員修改當前帳號角色後，JiraPage 立即同步 currentAccount.role',
    ],
  },
  {
    version: '3.1.0',
    date: '2026-04-01',
    changes: [
      '後端重構：server/index.ts 拆分為獨立路由模組（routes/jira.ts、gemini.ts、osm.ts、integrations.ts、machine-test.ts）',
      '新增 server/shared.ts 統一管理 DB、認證、工具函式、Zod Schema、Google 服務帳號認證',
      '錯誤處理改善：Error handler 新增 console.error 輸出堆疊資訊',
    ],
  },
  {
    version: '3.0.0',
    date: '2026-03-31',
    changes: [
      'OSM 頁面新增 Toppath 元件版本區塊（GM / API / GW / TG-API）',
      '後端新增 GET /api/toppath/version-history，從靜態 JSON 接口取得版本',
      '告警系統新增 Toppath 元件版本未達標偵測',
      '環境變數 TOPPATH_VERSION_BASE_URL 可切換 QAT / PROD 接口',
    ],
  },
  {
    version: '2.9.9',
    date: '2026-03-31',
    changes: [
      'PM 模式：修正多選欄位（遊戲/組件）讀取失敗的問題（Lark API 回傳純字串陣列）',
      'PM 模式：自動偵測「端點 = 主單」的列，優先建立主單並將其餘列自動連結為子單',
      '主單列在 Step 3 預覽表格中以紫色背景 + 主單徽章標示',
    ],
  },
  {
    version: '2.9.8',
    date: '2026-03-31',
    changes: [
      'PM 模式：新增 Lark Bitable 批次開單功能，貼上表格 URL 自動讀取待開單列',
      '標題自動組合 [端點][平台][遊戲][組件] 格式',
      '受託人/RD負責人從 Lark User 欄位自動對應 Jira accountId（email 比對）',
      'JIRA專案欄位直接決定每列開到哪個專案，每列可不同',
      '主單連結：填入主單號後，勾選「選擇主單並關聯」的列自動設為子單（支援 Epic + Sub-task / Parent-child）',
      '開單完成後自動將 Jira Key 回填至 Bitable JIRA索引鍵欄位',
    ],
  },
  {
    version: '2.9.7',
    date: '2026-03-31',
    changes: [
      'Jira 帳號新增 PIN 鎖定：每個帳號可設定 PIN，使用時需輸入才能切換，防止他人誤用',
      '已有 PIN 的帳號可輸入舊 PIN 修改或留空新 PIN 移除鎖定',
      '已存在帳號預設無 PIN（向下相容），帳號列表顯示 鎖 圖示區分',
    ],
  },
  {
    version: '2.9.6',
    date: '2026-03-31',
    changes: [
      'Jira 開單新增動態專案與 Issue 類型選擇：Step 1 從 Jira API 動態拉取帳號有權限的專案清單，選定專案後自動載入對應 Issue 類型，不再寫死 .env',
    ],
  },
  {
    version: '2.9.5',
    date: '2026-03-30',
    changes: [
      'Lark Bitable 欄位結構說明頁更新：新增 Jira 整合格式範例，與標準格式並排顯示',
    ],
  },
  {
    version: '2.9.4',
    date: '2026-03-30',
    changes: [
      'Lark TestCase 生成新增「整合 Jira 單號」功能：可選填 Jira 單號，AI 同時參考 Jira Issues 與規格書生成 TestCase',
      '新增「TestCase 生成（Jira 整合版）」Prompt 模板，輸出含 test_type / category_type / function_module / jira_reference 等欄位',
      'Jira 整合格式自動建立新 Bitable，欄位結構：測試標題 / 功能模組 / 測試類型 / 類型 / 預期結果 / 來源依據 / JIRA單號 / 類型判定依據',
      '同時支援 Spec Only / Jira Only / Spec + Jira 三種情境，AI 自動判定',
    ],
  },
  {
    version: '2.9.3',
    date: '2026-03-30',
    changes: [
      'Jira 頁新增 QA / PM 模式切換（頁面頂部），帳號選擇共用',
      '帳號新增 role 欄位（QA / PM），帳號清單顯示角色徽章，新增帳號時可選角色',
    ],
  },
  {
    version: '2.9.1',
    date: '2026-03-30',
    changes: [
      'Gemini 設定移至 Header 全域按鈕（陣 Gemini），任何頁面皆可開啟，不再分散在 Jira / Lark 頁面內',
    ],
  },
  {
    version: '2.9.0',
    date: '2026-03-30',
    changes: [
      '修正 Gemini API Key 輪替邏輯：stored keys 與 env key 現在同時加入輪替清單，不再互斥；stored keys 用盡後自動 fallback 到 env key',
    ],
  },
  {
    version: '2.8.9',
    date: '2026-03-30',
    changes: [
      '圖片刪除驗證：改為虛擬瀏覽器模式 — Playwright headless 在 server 運行，每 1.5s 截圖顯示在 Toppath UI，使用者可直接點擊畫面操作遊戲（滑鼠點擊/滾輪轉發給 Playwright），任何裝置皆可使用，完成後取得比對結果',
    ],
  },
  {
    version: '2.8.4',
    date: '2026-03-29',
    changes: [
      '圖片刪除驗證：headless 背景 session 模式（已更新為可視模式）',
    ],
  },
  {
    version: '2.8.3',
    date: '2026-03-29',
    changes: [
      '圖片刪除驗證：改為非無頭啟動器模式（已廢棄，遠端無法使用）',
    ],
  },
  {
    version: '2.8.2',
    date: '2026-03-29',
    changes: [
      '圖片刪除驗證：新增截圖 AI 識別功能 — 貼上或上傳 git diff 截圖，Gemini Vision 自動識別所有 deleted 路徑並填入清單，支援 Ctrl+V 直接貼上截圖',
    ],
  },
  {
    version: '2.8.1',
    date: '2026-03-29',
    changes: [
      '圖片刪除驗證：新增「貼上 git diff 自動解析」功能，支援 git diff --name-status / git status / GUI 客戶端格式，自動抽取圖片路徑填入清單，不需手動輸入',
    ],
  },
  {
    version: '2.8.0',
    date: '2026-03-29',
    changes: [
      '新增「圖片刪除驗證」功能（I 頁）：貼上已刪除圖片路徑清單 + 前端 URL，Playwright 自動開啟頁面攔截請求，回報哪些圖片仍在載入（失敗）/ 已確認刪除（通過）',
    ],
  },
  {
    version: '2.7.9',
    date: '2026-03-28',
    changes: [
      '修正 ImageRecon 歷史紀錄：status 根據 currentVersion vs Lark 目標版本重新比對（Match/Mismatch），符合/不符台數也一併重新計算',
    ],
  },
  {
    version: '2.7.8',
    date: '2026-03-28',
    changes: [
      '移除 ImageRecon 歷史紀錄中的 reportTargetVersion 欄位，只保留 Lark Sheet 設定的目標版本',
    ],
  },
  {
    version: '2.7.7',
    date: '2026-03-28',
    changes: [
      '修正 ImageRecon 歷史紀錄：records[] 每一筆的 targetVersion 也一併替換為 Lark Sheet 設定的目標版本',
    ],
  },
  {
    version: '2.7.6',
    date: '2026-03-28',
    changes: [
      'ImageRecon 週報歷史紀錄的目標版本改為優先使用 Lark Sheet 設定的目標版本，與頁面比對邏輯一致，週報本身的版本保留為 reportTargetVersion',
    ],
  },
  {
    version: '2.7.5',
    date: '2026-03-28',
    changes: [
      '歷史紀錄頁新增分頁功能：每頁顯示 10 筆，超過時顯示頁碼列，切換篩選條件時自動回到第 1 頁',
    ],
  },
  {
    version: '2.7.4',
    date: '2026-03-28',
    changes: [
      'Bonus 啟動方式選「點擊觸屏座標」時，未填任何座標點位即顯示紅色警示並擋下儲存',
    ],
  },
  {
    version: '2.7.3',
    date: '2026-03-28',
    changes: [
      '觸屏座標輸入格式驗證：輸入非「數字,數字」格式時即時顯示紅框提示，儲存時也會擋下並提示錯誤座標',
      '適用於 Bonus 觸屏、進入觸屏 S1/S2 三個輸入區',
    ],
  },
  {
    version: '2.7.2',
    date: '2026-03-28',
    changes: [
      '機台設定檔：新增機型時若代碼已存在，跳出提示窗告知並擋下儲存，防止誤覆蓋現有設定',
    ],
  },
  {
    version: '2.7.1',
    date: '2026-03-28',
    changes: [
      '機台設定檔儲存後自動記錄到歷史紀錄（機台測試類別），包含機型、Bonus 啟動方式、進入觸屏設定',
    ],
  },
  {
    version: '2.7.0',
    date: '2026-03-28',
    changes: [
      '機台設定檔新增兩階段進入觸屏設定：第一階段選擇 DENOM、第二階段 YES/NO 確認',
      '設定列表新增「進入觸屏」欄位，直接顯示已設定的 S1/S2 點位，方便後續編輯',
      'runner.ts 執行順序：進入機台 → Stage1 觸屏 → Stage2 觸屏 → 偵測遊戲內',
    ],
  },
  {
    version: '2.6.9',
    date: '2026-03-28',
    changes: [
      '機台測試改為每台完成時立即回寫 Lark Sheet，不再等全部跑完再批次寫入，避免漏寫或錯亂',
      '狀態列即時顯示目前回寫進度（回寫 N135...→ 通過 已回寫 N 筆）',
    ],
  },
  {
    version: '2.6.8',
    date: '2026-03-28',
    changes: [
      '修正 Lark Sheet header 合併邏輯：改用 Math.max(row1.length, row2.length) 遍歷，修正 QA確認狀態（Row2 欄位超出 Row1 長度）找不到欄位、無法回寫的問題',
    ],
  },
  {
    version: '2.6.7',
    date: '2026-03-28',
    changes: [
      '修正機台測試 Lark 回寫：改回使用 /api/machine-test/lark-writeback 端點（舊端點已擴充支援同時寫 QA確認狀態）',
      '回寫格式統一為 { rowIndex, message, qaStatus }，不再依賴不穩定的 writeback-multi 路由',
    ],
  },
  {
    version: '2.6.6',
    date: '2026-03-28',
    changes: [
      '機台測試退出失敗時自動分析原因：若偵測到特殊遊戲（Bonus/Jackpot）狀態，退出步驟從 FAIL 降級為 WARN，並加注說明',
      '偵測條件：1) 有「特殊遊戲等待」步驟 2) OSM 狀態碼在 bonus 範圍 3) 日誌含 game/bonus/jackpot 等關鍵字',
    ],
  },
  {
    version: '2.6.5',
    date: '2026-03-28',
    changes: [
      '修正機台測試歷史紀錄無法儲存的問題（Zod v4 z.record() 語法錯誤 + overall 大小寫不符）',
      '機台測試 Lark 回寫加上結果提示（成功/失敗/錯誤原因顯示在 URL 旁）',
    ],
  },
  {
    version: '2.6.4',
    date: '2026-03-28',
    changes: [
      '機台測試回寫 Lark Sheet 改為同時寫入兩欄：QA問題回報（PASS→OK / 否則填問題描述）、QA確認狀態（PASS→驗證通過 / 否則→驗證未過）',
      '修正多欄回寫找不到「QA確認狀態」的問題（該欄在 Row2，現已改讀 A1:Z2 並合併 header）',
    ],
  },
  {
    version: '2.6.3',
    date: '2026-03-28',
    changes: [
      '新增 ImageRecon 週報解析歷史紀錄（每次解析 Gmail 週報後自動記錄目標版本、伺服器數量與版本比對結果）',
      '歷史頁功能篩選新增「ImageRecon 週報」分類',
    ],
  },
  {
    version: '2.6.2',
    date: '2026-03-28',
    changes: [
      '新增 OSM 元件版本同步歷史紀錄（每次查詢自動記錄各元件版本快照）',
      '新增 LuckyLink 元件版本同步歷史紀錄',
      '新增版本告警歷史紀錄（手動觸發與排程定時告警均記錄，含達標狀態與告警內容）',
      '歷史頁功能篩選新增：OSM 元件版本、LuckyLink 元件、版本告警三個類別',
    ],
  },
  {
    version: '2.6.1',
    date: '2026-03-28',
    changes: [
      '歷史紀錄頁：TestCase 紀錄新增 載 下載按鈕，可將生成的案例匯出為 JSON 檔案',
      '歷史紀錄頁：展開 TestCase 紀錄時顯示 鏈 前往 Lark Bitable 連結',
    ],
  },
  {
    version: '2.6.0',
    date: '2026-03-28',
    changes: [
      '新增獨立「操作歷史紀錄」頁面（H），集中顯示所有功能操作紀錄',
      '歷史頁支援今日 / 3 天 / 7 天時間篩選，以及全部 / TestCase / 機台測試 / Jira 評論 / OSM 同步功能篩選',
      'Gemini API Keys 清單新增顯示 .env 預設 Key（附藍色徽章區分，不可刪除，可測試可用性）',
      '修正上傳 PDF/Word 時中文檔名亂碼問題（multer latin-1 → UTF-8 解碼）',
      '機台測試、Lark 頁面移除內嵌歷史面板，統一由歷史頁管理',
    ],
  },
  {
    version: '2.5.0',
    date: '2026-03-28',
    changes: [
      '新增全功能歷史紀錄：TestCase 生成、機台測試、Jira 批次評論、OSM 同步，每次操作自動保存，最多保留 7 天',
      '歷史紀錄以可折疊面板顯示於各頁面，點選任一筆可展開查看詳細 JSON',
      'TestCase 生成新增三種規格書來源：Lark Wiki（原有）、PDF/Word 檔案上傳（最大 20MB）、Google 文檔 URL',
      '修正切換 PDF 模式時頁面偏移問題（body overflow-y: scroll 防止 scrollbar 跳位）',
      '機台測試加入管理員 PIN 鎖定與單一執行階段限制（防止多人同步執行）',
      '新增 Gemini API Key 用量統計與可用性探測（陣 Gemini 設定 → 察 測試所有 Key 可用性）',
    ],
  },
  {
    version: '2.4.0',
    date: '2026-03-28',
    changes: [
      '機台測試：Lark Sheet 整合 — 讀取機台清單（QA確認狀態=驗證通過自動跳過）、測試完畢自動回寫 QA問題回報',
      '機台測試：修正音頻誤判 — 測試前錄製基準值，若基準 RMS > -55 dB 且差值 < 10 dB 標記為音頻干擾',
      '機台測試：新增 iDeck 測試（stepIdeck） — 逐一點擊按鈕，透過 daily-analysis API 確認 usb_coordinate 事件',
      '機台測試：新增 entryTouchPoints — 進入後需點觸屏選擇 denom 時自動點擊',
      'dev server 改為 tsx --watch 自動重啟，修改後端檔案後不再需要手動重啟',
      'Lark Sheet 結構修正：正確合併 Row1/Row2 為 header（QA確認狀態 在 Row 2）',
    ],
  },
  {
    version: '2.3.6',
    date: '2026-03-26',
    changes: [
      '新增「訊 版本告警」功能：任何版本不達標時發送 Lark 告警',
      '告警範圍涵蓋：OSM 元件版本、LuckyLink 元件版本、OSM 機台 Online 未達標',
      '手動「發送告警」按鈕，立即觸發一次檢查並推送到 Lark 群組機器人',
      '排程設定面板：可啟用定時告警並設定 Cron 表達式（時區 Asia/Taipei）',
      '排程設定持久化至 SQLite，重啟 server 後自動恢復',
    ],
  },
  {
    version: '2.3.5',
    date: '2026-03-26',
    changes: [
      '修正 server 啟動失敗：OSM/LuckyLink 版本路由被錯誤放在 const app = express() 之前，導致整個 server 無法啟動',
      '重新整理路由順序，所有 app.get/post 均移至 app 初始化之後',
    ],
  },
  {
    version: '2.3.4',
    date: '2026-03-26',
    changes: [
      '新增「運 LuckyLink 元件版本」區塊：Luckylink Server / Bg Client / BG Server',
      'LuckyLink API 回應格式為 { data: { "1": ..., "4": ... } }，index 1=Luckylink Server、index 4=BG Server',
      'Bg Client 目前 API 尚未支援，顯示「待 API 支援」與「開發中」標籤',
      'API 憑證設定：LUCKYLINK_BASE_URL / USERNAME / PASSWORD / ORIGIN（無帳密則略過登入）',
      '修正 OSM 元件版本端點回傳欄位名稱（versions → components）',
    ],
  },
  {
    version: '2.3.3',
    date: '2026-03-26',
    changes: [
      'ImageRecon Server 版本區塊改以 Lark Sheet ImageRecon 分頁目標版本為優先比對依據',
      '統計列改顯示「X/Y 達標」，目標版本來源標示（Lark）或（週報）',
      '每列目標版本欄顯示有效目標版本（Lark 優先，次選 Gmail 週報解析值）',
    ],
  },
  {
    version: '2.3.2',
    date: '2026-03-26',
    changes: [
      '新增「OSM 元件版本」區塊：從 OSM 後台取得 6 個元件目前版本',
      '顯示順序：Game Client New → Game Client PC → Center Server → Middle Server → Bg Client → BG Server',
      '與 Lark Sheet OSM 分頁目標版本比對，顯示達標 / 未達標徽章',
      '卡片顏色依達標狀態區分：綠色（達標）/ 橘色（未達標）/ 灰色（未設定目標）',
    ],
  },
  {
    version: '2.3.1',
    date: '2026-03-26',
    changes: [
      '渠道卡片移除「主要版本」顯示，避免造成誤解',
      '新增 Online 未達標警示區塊：顯示 Online 但版本未達目標的機台數量',
      '警示區依 machineType 分組顯示：機型名稱、幾台、→ 目標版本',
      '卡片邊框顏色改以目標版本達標狀態為準（有目標才顯示綠/橘）',
    ],
  },
  {
    version: '2.3.0',
    date: '2026-03-26',
    changes: [
      '從 Lark Sheet 同步目標版本：支援 MachineType / OSM / LuckyLink / Toppath / ImageRecon 五個分頁',
      '貼上 Lark Sheet URL → 一鍵同步，自動讀取各分頁（A 欄 machineType、B 欄目標版本）',
      '機台展開列表依 machineType 分組，每組顯示所有 category 的目標版本',
      '達標比對以 MachineType 分頁版本為基準，顯示 X/Y 達標',
      '目標版本持久化至 SQLite，重啟 server 不遺失',
    ],
  },
  {
    version: '2.2.0',
    date: '2026-03-26',
    changes: [
      'OSM 機台資料新增 machineType 欄位（從 API 擷取）',
      '機台展開表格依 machineType 分組顯示，每組有獨立標題列',
      'machineType 分組顯示達標率（目標版本設定後即時計算）',
      '新增目標版本設定面板，可手動為每個 machineType 設定目標版本',
    ],
  },
  {
    version: '2.1.0',
    date: '2026-03-26',
    changes: [
      '資料存儲全面升級為 SQLite，取代 JSON 檔案，解決多人並發 Race Condition',
      '首次啟動自動遷移舊 accounts.json / gemini-keys.json / prompts.json 資料至 DB',
      '新增 Gemini Rate Limiter（最多 5 個並發，間隔 300ms），防止 API 配額耗盡',
      '新增 API Rate Limiting：重操作每分鐘 15 次，一般寫入每分鐘 60 次',
      'OSM 全渠道/單渠道同步加入防重複觸發機制（同步中回傳 429）',
      '新增 x-user-token header 支援，後端 Log 可辨識不同使用者',
    ],
  },
  {
    version: '2.0.2',
    date: '2026-03-26',
    changes: [
      'OSM egmList：帶出 onlineState（online / offline），後端小寫正規化',
      '渠道卡片顯示 Online / Offline 數量、連線率進度條',
      '機台明細表新增「連線」欄與「版本」欄分開；Offline 列淺灰底、Offline 優先排序',
      'Dashboard 頂部統計新增全渠道 Online / Offline（及連線未知）彙總',
      '修正 onlineState 判斷：前端比較前先 trim、後端把 1/0 轉成 online/offline',
    ],
  },
  {
    version: '2.0.0',
    date: '2026-03-25',
    changes: [
      '全新「OSM 版號同步」頁面取代 Gmail 週報頁',
      '機台版本 Dashboard：一鍵全渠道同步，或單一渠道手動同步',
      '渠道卡片顯示：主要版本、機台總數、版本分布進度條、版本一致狀態',
      '展開卡片可查看該渠道所有機台名稱、版本及一致性 Badge',
      '摘要統計列：渠道數、機台總數、版本一致渠道數',
      '保留 ImageRecon Server 版本解析區塊（Gmail 週報），整合於同頁下方',
      '渠道設定存於 .env（OSM_CHANNELS + 各渠道帳密），不從前端管理',
      '後端新增 POST /api/osm/sync（全渠道）與 POST /api/osm/sync/:name（單渠道）',
    ],
  },
  {
    version: '1.9.3',
    date: '2026-03-25',
    changes: [
      'Jira 批次評論：Gemini API 用量耗盡時立即中斷，剩餘筆數不貼任何內容',
      '中斷後回傳已成功筆數與中斷原因，前端顯示「警 已中斷」提示列',
      'Jira API 自身錯誤（非 AI 問題）仍只標記該筆失敗，不影響其他筆繼續執行',
    ],
  },
  {
    version: '1.9.2',
    date: '2026-03-25',
    changes: [
      '建立 Bitable 時自動刪除 Lark 預設欄位（Single option、Date、Attachment）',
    ],
  },
  {
    version: '1.9.1',
    date: '2026-03-25',
    changes: [
      '修正 Bitable 從第 11 行開始顯示：建立後先清除預設空記錄，再寫入資料',
      '調整欄位順序為：測試標題、測試模組、測試維度、操作步驟、優先級、前置條件、預期結果',
      '測試模組改為「單選類型」（選項由使用者自行新增）',
      '測試維度改為「單選類型」，預設 6 個維度選項：正向邏輯、邊界分析、異常阻斷、版本變更、使用者體驗、搶登與裝置衝突',
    ],
  },
  {
    version: '1.9.0',
    date: '2026-03-25',
    changes: [
      'TestCase 生成改為動態建立 Bitable：每次生成在指定資料夾自動建立獨立表格',
      '新建的 Bitable 命名格式為 TestCase_YYYY-MM-DD_HHMM_docId',
      '自動建立七個欄位：測試模組、測試維度、測試標題、前置條件、操作步驟、預期結果、優先級',
      '生成完成後顯示「前往 Lark Bitable」連結，直接跳轉至本次新建的表格',
      '新增 LARK_TESTCASE_FOLDER_TOKEN 設定，舊版固定表格模式仍可向下相容',
    ],
  },
  {
    version: '1.8.0',
    date: '2026-03-25',
    changes: [
      'Gmail 週報解析完整實作：撈取完整 email 內容並解碼（base64 + quoted-printable）',
      'Regex 自動抽取 Target Version、Generated、Summary 統計、各伺服器記錄',
      'Gmail 頁新增摘要卡片（符合目標、版本不同、錯誤、總計、成功率）',
      '版本比對標色：實際版本與目標版本不符時以橘色標示',
      'TestCase 預設 Prompt 更新為 QA 架構師邏輯窮舉版本（含搶登與裝置衝突維度）',
    ],
  },
  {
    version: '1.7.0',
    date: '2026-03-25',
    changes: [
      'TestCase 生成支援多組 Gemini API Key 自動輪替',
      'TestCase 生成支援 Prompt 模板選擇，新增「TestCase 生成（標準）」預設模板',
      'Lark 頁加入 陣 Gemini 管理入口（與 Jira 共用同一套 Keys / Prompt 管理）',
      '修正 Gemini 回傳 Markdown 包裹 JSON 導致解析失敗的問題（三層 fallback 抽取）',
      '後端加入 Activity Log：記錄 IP、使用者、操作類型與結果',
      '新增 restart.bat 與 npm run dev:stop 快速重啟指令',
    ],
  },
  {
    version: '1.6.0',
    date: '2026-03-25',
    changes: [
      '新增管理員 PIN 機制：只有輸入正確 PIN 才能刪除 Jira 帳號',
      '管理員 PIN 存於後端 .env（ADMIN_PIN），刪除請求由後端二次驗證',
      '管理員狀態存於 sessionStorage，關閉分頁後自動失效',
      '未設定 ADMIN_PIN 時刪除功能對所有人關閉',
      '修正 Step 4 結果頁「已評論」badge 顯示錯誤為「待評論」的問題',
    ],
  },
  {
    version: '1.5.1',
    date: '2026-03-25',
    changes: [
      '修正 Modal 層級問題：改用 React Portal 直接掛載至 document.body，徹底解決 z-index stacking context 衝突',
      '修正 modal-box 無背景色導致透明顯示的問題（補上 .modal-box CSS 樣式）',
    ],
  },
  {
    version: '1.5.0',
    date: '2026-03-25',
    changes: [
      '新增 Gemini 設定面板：可在前端管理多組 API Key，配額用完自動輪替下一組',
      '新增 Prompt 模板管理：可新增/編輯/刪除多組 Prompt，支援 {{變數}} 語法',
      'Step 5 新增 Prompt 模板選擇下拉，可即時切換不同 AI 格式',
      '版號與更新日誌整合至前端 UI（Header 版號徽章點擊開啟）',
    ],
  },
  {
    version: '1.4.0',
    date: '2026-03-24',
    changes: [
      'Step 5 新增 AI 優化功能（Gemini），將驗證結果自動整理成標準 QA 報告',
      '【前置條件】嚴格格式：環境/版本/平台直接複製原始值，不加解釋',
      'AI 評論格式改用 Jira ADF（Atlassian Document Format），正確保留多行結構',
      '支援從 sheet 抓取測試環境、版本號、測試平台、機台編號、遊戲模式作為 AI 上下文',
    ],
  },
  {
    version: '1.3.0',
    date: '2026-03-23',
    changes: [
      '新增「處理階段」追蹤：開單後自動回寫「已開單」、評論後回寫「添加評論」、切換狀態後回寫「已完成」',
      '新增「處理時間」回寫：每個階段完成時記錄時間戳',
      '工作流擴展為 6 步驟：建立 Issues → 添加評論 → 切換狀態',
      '新增 Jira 批次評論功能（POST /api/jira/batch-comment）',
      '新增 Jira 批次切換狀態功能（POST /api/jira/batch-transition）',
      '智慧路由：根據「處理階段」判斷每列需執行哪個步驟，支援斷點續跑',
      'Step 3 新增操作計畫預覽（建立/評論/切換 各幾筆）',
    ],
  },
  {
    version: '1.2.0',
    date: '2026-03-22',
    changes: [
      '新增 Google Sheets 作為 Jira 資料來源（2 擇 1 切換）',
      'Google Sheets 回寫使用 Service Account JWT 驗證',
      '修正 Jira Issue Key 未回寫至 Google Sheets 的問題',
      '修正「Actual start / Actual end」日期欄位未填入 Jira 的問題',
      '多欄位回寫改用逐格 PUT 方式，解決 Lark batch API 回應不穩定的問題',
      '修正 Zod v4 z.record() API 相容性問題',
      'Step 3 預覽表格改為顯示所有欄位，Jira Account ID 轉換為顯示名稱',
    ],
  },
  {
    version: '1.1.0',
    date: '2026-03-21',
    changes: [
      'Jira 帳號改為後端集中管理（server/accounts.json），不再存放於瀏覽器',
      '新增帳號選擇 Modal：支援新增/選擇/刪除帳號',
      '選擇帳號後使用 sessionStorage 暫存，重整後需重新選擇',
      '取消選擇時，清空下游所有步驟的狀態',
      '新增 Lark Sheets 作為資料來源，可自訂試算表 URL',
      '受託人清單直接從 Jira API 取得（不再手動設定）',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-03-20',
    changes: [
      '初始版本：整合 Jira、Lark、Gmail 三個工作流',
      '三個功能拆分為獨立分頁切換',
      '新增 toggle.bat 一鍵開關 dev server',
      'Jira：從 Lark 試算表讀取資料批次開單',
      'Lark：TestCase 生成（Gemini AI + 寫回 Bitable）',
      'Gmail：週報同步',
    ],
  },
]
