export const APP_VERSION = '3.26.7'

export interface ChangelogEntry {
  version: string
  date: string
  changes: string[]
}

export const CHANGELOG: ChangelogEntry[] = [
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
      '[遊戲版] JiraAccountModal / GeminiSettingsModal / ChangelogModal：關閉按鈕在遊戲版顯示 DungeonIcon，一般版保留 ✕',
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
      '[遊戲版] 修正彈框 ✕ 位置：modal-header 補上 flex 佈局，關閉按鈕正確推到右側',
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
      '測試結果表格新增預覽：CCTV 欄直接顯示縮圖，點擊放大；音頻欄顯示 🔊 按鈕，點擊直接在瀏覽器播放錄音',
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
      '機台測試：大廳 URL 每個 Worker 列新增 📋 按鈕，點擊開啟帳號池選取 Modal，直接從帳號池選取帳號填入 URL，不需切換頁面（避免測試設定資料被清空）',
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
      'CCTV 基準圖庫：新增按機種管理基準圖功能。機台設定頁新增「📷 CCTV 基準圖庫」區塊，可上傳/更換/刪除各機種基準圖（存於 server/machine-test/cctv-refs/{機種}.png）',
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
      'UAT 測試工具：Lark TC 路徑新增「🔍 掃描」按鈕，顯示各大項 TC 名稱與子項目數量',
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
      'Jackpot 告警設定重設計：改用 gameid 欄位做 key，設定介面改為每遊戲×每等級的勾選開關，未勾選的等級異常仍在頁面標紅但不推 Lark；表格欄位顯示 🔕 提示告警已關閉',
    ],
  },
  {
    version: '3.7.28',
    date: '2026-04-16',
    changes: [
      'Jackpot 監控：新增管理員閾值設定（⚙️ 閾值設定按鈕），各遊戲可獨立設定每個獎池等級的 min/max 合理範圍，儲存至後端 DB，設定後立即生效',
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
      '測試頁新增 Agent 狀態列（已連線/執行中/待機）與「👁 觀看」按鈕（不發起測試，僅接收廣播進度）',
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
      'iDeck 步驟：每次按鈕點擊後同時等待 pinus WS 回應（cmd + error）並驗證，結果顯示 ✓/✗WS(cmd)',
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
      'Gemini 設定：新增 last_used_at 顯示欄位，⛔ 配額耗盡標記移至上次使用欄位下方',
      'OSM serverCfg.js：改為解析 HTML 頁面尋找正確路徑（修正 PC 版 /config/serverCfg.js 無法找到的問題）',
    ],
  },
  {
    version: '3.6.1',
    date: '2026-04-07',
    changes: [
      '新增「🔍 後台對帳」分頁：設定後台 API token/channelId，選時間範圍執行對帳',
      'Agent 每 20 次 Spin 自動從 window.pinus 取得前端戰績上傳至 server',
      '對帳比對：前端紀錄 vs 後台 gameRecordList，標記 MATCH/MISSING，偵測大獎/連發異常',
      '支援自動重登（token 失效時自動以帳密換新 token），歷史對帳報告可回顧',
    ],
  },
  {
    version: '3.6.0',
    date: '2026-04-06',
    changes: [
      'AutoSpin 新增「📊 歷史戰績」分頁：每 20 次 Spin 記錄餘額快照，追蹤 Bonus/低餘額/錯誤事件',
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
      '已存在帳號預設無 PIN（向下相容），帳號列表顯示 🔒 圖示區分',
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
      'Gemini 設定移至 Header 全域按鈕（⚙️ Gemini），任何頁面皆可開啟，不再分散在 Jira / Lark 頁面內',
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
      '新增「圖片刪除驗證」功能（I 頁）：貼上已刪除圖片路徑清單 + 前端 URL，Playwright 自動開啟頁面攔截請求，回報哪些圖片仍在載入（❌）/ 已確認刪除（✅）',
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
      '狀態列即時顯示目前回寫進度（回寫 N135...→ ✅ 已回寫 N 筆）',
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
      '歷史紀錄頁：TestCase 紀錄新增 📥 下載按鈕，可將生成的案例匯出為 JSON 檔案',
      '歷史紀錄頁：展開 TestCase 紀錄時顯示 🔗 前往 Lark Bitable 連結',
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
      '新增 Gemini API Key 用量統計與可用性探測（⚙️ Gemini 設定 → 🔍 測試所有 Key 可用性）',
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
      '新增「📢 版本告警」功能：任何版本不達標時發送 Lark 告警',
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
      '新增「🍀 LuckyLink 元件版本」區塊：Luckylink Server / Bg Client / BG Server',
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
      '中斷後回傳已成功筆數與中斷原因，前端顯示「⚠️ 已中斷」提示列',
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
      'Lark 頁加入 ⚙️ Gemini 管理入口（與 Jira 共用同一套 Keys / Prompt 管理）',
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
