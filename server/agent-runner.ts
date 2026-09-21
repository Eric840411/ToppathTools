/**
 * server/agent-runner.ts
 * Standalone worker agent — connects to central server via WebSocket,
 * joins a session, then claims machines one at a time (work-stealing),
 * runs each locally, and reports events back.
 *
 * Usage (on worker machine, from project root):
 *   CENTRAL_URL=ws://192.168.1.100:3000 node dist/server/agent-runner.js
 *
 * Optional env vars:
 *   CENTRAL_URL    WebSocket URL of the central server (default: ws://localhost:3000)
 *   AGENT_LABEL    Display name for this agent (default: machine hostname)
 *   AGENT_OWNER_KEY   Operator key this agent belongs to
 *   AGENT_OWNER_NAME  Operator display name
 *   AGENT_TOKEN       Local Agent registration token
 *   AGENT_CAPABILITIES Comma-separated capability list (default: machine-test,scripted-bet)
 *   GEMINI_API_KEY Gemini API key for CCTV vision test (optional)
 */
import WebSocket from 'ws'
import { hostname, tmpdir } from 'os'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { createInterface } from 'node:readline'
// UAT 網路量測與 pinus 攔截：共用模組放在 server/uat-runner/ 底下，
// 因為那是唯一一份 Backend runner（純 node）、agent（tsx）、server（編譯後）
// 三邊都載得到的位置，詳見 net-capture.js 檔頭
import { hashSources, hashOne, RESTART_REQUIRED_SOURCES } from './agent-source-hash.js'
import { attachNetworkCapture, DEFAULT_THRESHOLDS } from './uat-runner/net-capture.js'
import { attachPinusProbe } from './uat-runner/pinus-probe.js'
import { attachCdpCapture } from './uat-runner/cdp-capture.js'
import { evaluateApiAssertion } from './uat-runner/api-assert.js'
import { compileFrontendSteps, runFrontendStep } from './uat-runner/frontend-engine.js'
// 綁了 TC 的腳本：聚合判定走**跟伺服器端同一支**（`multi-tc.js`）。
// ⚠️ 回寫不在這裡——Lark 憑證不下放到 agent，結果送回 server 由它寫。
import { runMultiTcSteps } from './uat-runner/multi-tc.js'
import { createFrontendTcEngine, toMultiTcSteps } from './uat-runner/frontend-tc-engine.js'
// 基準圖比對：跟伺服器端同一份。以前只有伺服器端有，這顆積木在 agent 上被靜默跳過。
import { decodePng, findTemplateInPng } from './uat-runner/template-match.js'
import { waitForDebugPort, clearStaleDebugPort, DEBUG_PORT_ARG } from './uat-runner/chrome-debug-port.js'
import { pcWaitLobby, pcClosePopups, pcScanLobby, pcCollectMachines, pcSeekMachine, pcEnterMachine, pcSceneName, describePcLobby, pcInstallEvalShim, pcBackToLobby, pcLobbyRecoveryPlan, pcEngineCapabilities } from './lib/pc-cocos.js'
import type { PcMachine } from './lib/pc-cocos.js'
import { startLobbyPopupWatcher } from './uat-runner/lobby-popup.js'
import { dismissUiPopups } from './uat-runner/ui-popup.js'
import { h5BackToLobby, h5InGame } from './uat-runner/h5-seat.js'
import { verifyRecordedSelectorLive, createRecordedLocators } from './uat-runner/recorded-selector.js'
import { frontendRecorderScript, flagShadowCompleteness, syncRecorderPanel, setRecorderPanelVisible, FRONTEND_RECORDER_CONTROL_MARKER } from './uat-runner/frontend-recorder.js'
import { MachineTestRunner } from './machine-test/runner.js'
import type { MachineTestSession, MachineProfile, TestEvent } from './machine-test/types.js'
import { ScriptedBetRunner } from './scripted-bet/runner.js'
import type { ScriptedBetAccount, ScriptedBetConfig, ScriptedBetEvent } from './scripted-bet/types.js'
import type { Page } from 'playwright'
// 錄製期間回報網路請求時，用同一套規則把網址收斂成可比對的樣式——
// 規則只能有一份，兩邊各寫一份遲早漂移
import { toUrlPattern } from './uat-runner/net-capture.js'

const CENTRAL_URL = (process.env.CENTRAL_URL ?? 'ws://localhost:3000').trim().replace(/\/$/, '')
const AGENT_LABEL = process.env.AGENT_LABEL ?? hostname()
const AGENT_ID = `${AGENT_LABEL}_${process.pid}`
const AGENT_OWNER_KEY = (process.env.AGENT_OWNER_KEY ?? '').trim()
const AGENT_OWNER_NAME = (process.env.AGENT_OWNER_NAME ?? AGENT_OWNER_KEY).trim()
const AGENT_TOKEN = (process.env.AGENT_TOKEN ?? '').trim()
const AGENT_CAPABILITIES = (process.env.AGENT_CAPABILITIES ?? 'machine-test,scripted-bet,uat-record,uat-run,uat-run-tc,autospin,backend-uat')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean)
/**
 * ⚠️ **這個字串不能拿來判斷版本新舊。**它從 2026-05 起就沒動過，而 agent 的原始碼
 *    這期間改了很多次——手動維護的版號一定會漂，這就是活證據。
 *    真正的新舊判斷走下面的原始碼指紋（`computeSourceHashes`）。
 *    這裡留著只是給人看的協定標記。
 */
const AGENT_VERSION = '2026-05-agent-owner-v1'

/**
 * 算「我手上這批白名單檔案」的指紋，跟 server 對。
 *
 * 兩個指紋分開回傳，因為它們對應到**不同的下一步**：
 *   all          → 跟 server 不一致 = 檔案落後，按「更新程式碼」
 *   restartScoped → 檔案已是最新、但**啟動當下**這個值是舊的 = 重開 agent
 *
 * ⚠️ 演算法用 `agent-source-hash.ts` 這支共用模組（它自己也在白名單裡），
 *    不在這邊另寫一份——兩邊各寫一份必然漂掉，而漂掉的症狀是「永遠顯示需要更新」。
 */
async function computeSourceHashes(): Promise<{ all: string; restartScoped: string; diff: string[] } | null> {
  try {
    const baseUrl = CENTRAL_URL.replace(/^wss?/, (m) => m.includes('wss') ? 'https' : 'http')
    const resp = await fetch(`${baseUrl}/api/machine-test/agent/source-manifest`)
    if (!resp.ok) return null
    const manifest = await resp.json() as { files?: string[]; serverVersion?: string | null; perFile?: Record<string, string> }
    const files = manifest.files ?? []
    if (!files.length) return null
    const all: Record<string, string> = {}
    const restart: Record<string, string> = {}
    const diff: string[] = []
    for (const rel of files) {
      const target = join(process.cwd(), 'server', ...rel.split('/'))
      // 檔案不存在就當成空字串——那本身就是一種「跟 server 不一樣」，
      // 不要跳過（跳過會讓「少了一個檔案」跟「完全一致」算出同樣的指紋）
      let content = ''
      try { content = readFileSync(target, 'utf8') } catch { content = '' }
      all[rel] = content
      if (RESTART_REQUIRED_SOURCES.has(rel)) restart[rel] = content
      // 逐檔比對：總指紋只說得出「有東西不一樣」，說不出是哪個檔——
      // 那等於使用者除了反覆按更新之外沒事可做。manifest 本來就有 perFile，
      // 在這裡比一次，把差異清單一起回報上去。
      const want = manifest.perFile?.[rel]
      if (want && hashOne(content) !== want) diff.push(rel)
    }
    return { all: hashSources(all), restartScoped: hashSources(restart), diff }
  } catch {
    return null   // 算不出來就回報 undefined，server 會顯示「版本未知」而不是假裝最新
  }
}

/** 啟動當下那批「要重啟才生效」的檔案指紋。之後就算檔案被換掉，這個值也不變
 *  ——那正是「檔案新了但跑的是舊的」的判斷依據。 */
let bootRestartHash: string | undefined

/** 記住「這份原始碼是更新到哪一版拿到的」，純粹給人看。
 *  ⚠️ 這是**宣稱**不是事實——檔案被手動改過的話它會說謊，
 *     所以判斷新舊一律以指紋為準，這個只負責讓畫面上有個數字可看。 */
const SOURCE_VERSION_FILE = join(process.cwd(), 'server', '.source-version')
function readSourceVersion(): string | undefined {
  try { return readFileSync(SOURCE_VERSION_FILE, 'utf8').trim() || undefined } catch { return undefined }
}
function writeSourceVersion(v: string | null | undefined) {
  if (!v) return
  try { writeFileSync(SOURCE_VERSION_FILE, v, 'utf8') } catch { /* 寫不進去就算了，不影響功能 */ }
}

let currentRunner: { stop: () => void } | null = null
/** 後台錄製用的瀏覽器。錄製只會有一個 session，多開沒有意義而且會佔滿螢幕 */
let backendRecordBrowser: import('playwright').Browser | null = null
let backendRecordSessionId: string | null = null

/**
 * 收掉這一輪 Backend 錄製：先把還停在輸入框、沒離開焦點的內容 flush 成積木，
 * 再關瀏覽器並回報 `backend_record_done`。
 *
 * ⚠️ **這是主畫面的「停止錄製」（`backend_record_stop`）與頁面裡那顆停止按鈕
 *    共用的唯一實作。** 兩邊各寫一份的話遲早漂移，而最先漂掉的一定是那個 flush
 *    ——症狀是「從其中一邊停，最後打的那個欄位不見了」，兩邊都不會報錯。
 */
async function stopBackendRecording(ws: WebSocket, sessionId: string) {
  if (backendRecordSessionId && backendRecordSessionId !== sessionId) return
  // 先把狀態清掉再 await，免得 flush 還沒跑完就有第二條路徑進來重跑一次
  const browser = backendRecordBrowser
  backendRecordBrowser = null
  backendRecordSessionId = null
  for (const context of browser?.contexts() ?? []) {
    for (const page of context.pages()) {
      await page.evaluate(() => (window as unknown as { __toppathFlushRecorder?: () => void }).__toppathFlushRecorder?.()).catch(() => {})
    }
  }
  try { await browser?.close() } catch { /* ignore */ }
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type: 'backend_record_done', sessionId, error: null }))
  }
}

function backendRecordKind(resourceType: string) {
  if (resourceType === 'xhr' || resourceType === 'fetch') return 'api'
  if (resourceType === 'image') return 'image'
  return 'other'
}

/** WebSocket payload 可能含 token／密碼。只保留排錯需要的前段，常見敏感欄位先遮罩。 */
function redactRecordedPayload(payload: string | Buffer) {
  const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload)
  return text.slice(0, 1500)
    .replace(/([?&](?:token|access_token|authorization|password|secret)=)[^&\s]+/gi, '$1***')
    .replace(/("(?:token|accessToken|authorization|password|passwd|secret)"\s*:\s*)"[^"]*"/gi, '$1"***"')
}

interface SessionJoinMessage {
  type: 'session_join'
  sessionId: string
  /** Base session config — machineCodes is empty; agent claims codes via claim_job */
  session: MachineTestSession
  profiles: MachineProfile[]
  betRandomConfig: Record<string, string[]>
  osmMachineStatus: [string, number][]
  geminiKey?: string
  ollamaBaseUrl?: string
  ollamaModel?: string
}

interface ScriptedBetStartMessage {
  type: 'scripted_bet_start'
  sessionId: string
  accounts: ScriptedBetAccount[]
  config: ScriptedBetConfig
}

interface UatRecordStartMessage {
  type: 'uat_record_start'
  sessionId: string
  url: string
  resolution: string
  platform?: 'h5' | 'pc'
  /** 只決定頁面內控制面板的配色與用詞，不影響錄到什麼 */
  theme?: 'normal' | 'xianxia'
}

interface UatRecordCropMessage {
  type: 'uat_record_crop'
  sessionId: string
  scriptId: string
  platform: string
  name: string
  threshold: number
  createdBy: string
}

interface UatRecordStopMessage {
  type: 'uat_record_stop'
  sessionId: string
}

interface UatRecordPauseMessage {
  type: 'uat_record_pause'
  sessionId: string
  paused: boolean
}

interface UatScriptRunMessage {
  type: 'uat_script_run'
  /** 綁了 Lark TC 時才有：要判定／回寫哪幾筆 */
  tcBindings?: { recordId: string; number?: string; text?: string }[]
  /** 截圖往哪送（伺服器的取證端點）。⚠️ agent 不直接碰 Lark */
  evidenceUrl?: string
  evidenceToken?: string
  /**
   * 後台設定片段要用的登入資訊。
   * ⚠️ **只有腳本真的有後台積木時 server 才會帶**——沒用到的腳本不該帶著憑證跑。
   */
  backend?: { backendUrl: string; username: string; password: string }
  runId: string
  steps: string
  url: string
  platform: 'h5' | 'pc'
  resolution: string
  failureMode: string
  headed: boolean
  /** 網路量測門檻（毫秒）；沒帶就用 net-capture.js 的共用預設 */
  netThresholds?: { api?: number; image?: number; other?: number }
}

interface UiScreenshotStartMessage {
  type: 'ui_screenshot_start'
  sessionId: string
  run: {
    id: string
    gameUrlTemplate: string
    tasks: Array<{ id: string; gmid: string; resolution: string }>
    options: Record<string, boolean | number>
    concurrency: number
    /** 使用者在畫面上選的客戶端 */
    clientType?: 'h5' | 'pc'
  }
}

/** 掃大廳：把目前有哪些 model、各有幾台可用回報給伺服器，給前端勾選 */
interface UiScreenshotScanMessage {
  type: 'ui_screenshot_scan'
  scanId: string
  gameUrlTemplate: string
  /** 掃描也要能用有視窗的模式跑——PC 版在 headless 下可能沒有 WebGL */
  headed?: boolean
  /** 使用者在畫面上選的客戶端。舊版 server 不會帶，那時才退回 `isPcClientUrl` */
  clientType?: 'h5' | 'pc'
}

interface BackendUatStartMessage {
  type: 'backend_uat_start'
  sessionId: string
  larkAppToken: string
  larkTableId: string
  filter?: string
  dashGameType?: string
  dashClientVersion?: string
  /** UAT_CP_USERNAME / UAT_CP_PASSWORD / UAT_NCH_* — 原封不動注入 spawn 的 env */
  credEnv?: Record<string, string>
}

/**
 * 後台錄製派工。
 *
 * 為什麼一定要在 agent 端開瀏覽器：錄製的重點是「互動的瀏覽器要出現在操作者眼前」。
 * 原本這段是在 server 的 worker process 裡 chromium.launch({headless:false})——
 * 瀏覽器開在伺服器那台的桌面上，使用者從自己的機器連進來什麼都看不到，
 * 但 session 有起來、按鈕也變成「停止錄製」，看起來像成功。實際回報過這個問題。
 */
interface BackendRecordStartMessage {
  type: 'backend_record_start'
  sessionId: string
  /** 後台網址（含 protocol），由 server 決定，agent 不自己猜 */
  backendUrl: string
  /** 注入頁面的錄製腳本原始碼。由 server 提供，agent 端不留檔 */
  recorderScript: string
  /** 頁面把錄到的積木用 console.log 印出來時的前綴 */
  marker: string
  /**
   * 頁面裡那顆「停止錄製」按下去時印的前綴。
   *
   * ⚠️ 舊版 server 不會送這個欄位，收到 undefined 時**不能**退回用 `marker` 比對
   *    ——那會讓每一顆正常的積木都被當成停止訊號，錄一步就關掉瀏覽器。
   *    沒有值就是「這個 server 還沒有這個功能」，不掛監聽即可。
   */
  stopMarker?: string
  /** 自動登入用。只留在記憶體，不寫檔 */
  username: string
  password: string
}

interface AutoSpinStartMessage {
  type: 'autospin_start'
  sessionId: string
  userLabel: string
}

type IncomingMessage =
  | SessionJoinMessage
  | ScriptedBetStartMessage
  | UatRecordStartMessage
  | UatRecordCropMessage
  | UatRecordStopMessage
  | UatScriptRunMessage
  | UiScreenshotStartMessage
  | AutoSpinStartMessage
  | BackendUatStartMessage
  | { type: 'backend_uat_stop'; sessionId: string }
  | BackendRecordStartMessage
  | { type: 'backend_record_stop'; sessionId: string }
  | { type: 'job_assigned'; machineCode: string }
  | { type: 'no_more_jobs' }
  | { type: 'stop' }
  | { type: string }

// ── AutoSpin (Python engine spawned locally by this agent) ───────────────────
const PYTHON_EXE = process.env.AUTOSPIN_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
let autospinChild: ChildProcess | null = null
// luckylinkPollerChild 已於 2026-09-08 移除（LuckyLink JP 比對改由對帳台 L4/L5 負責）

// ── Backend UAT (Playwright script spawned locally by this agent) ────────────
// Server 只負責建 session 跟轉 log；真正的 Chromium 跑在這裡。
let backendUatChild: ChildProcess | null = null
let backendUatSessionId: string | null = null
/** 這次執行的密碼，只留在記憶體，用來把 log 行裡的密碼遮掉 */
let backendUatSecrets: string[] = []

/**
 * 送回 server 之前先遮一次密碼。server 端還會再遮一次——兩邊都做是因為
 * Playwright 的例外堆疊或腳本自己 print env 都可能把密碼帶出來，
 * 漏一次就會永久寫進 server 的 session.logs 並經 SSE 推給所有訂閱者。
 */
function redactBackendUatLine(line: string): string {
  let out = line
  for (const secret of backendUatSecrets) {
    if (secret.length < 4) continue // 太短的字串到處都會誤中
    out = out.split(secret).join('***')
  }
  return out
}

// ── UAT Recording (Chrome CDP) ───────────────────────────────────────────────

type CdpMessage = { id?: number; result?: Record<string, unknown>; error?: { message?: string } }
type CdpSend = (method: string, params?: object) => Promise<CdpMessage>

interface UatRecSession {
  sessionId: string
  proc: ReturnType<typeof spawn>
  profileDir: string
  done: boolean
  steps: object[]
  width: number
  height: number
  platform: 'h5' | 'pc'
  /** 要錄的目標網址。Chrome 先開 about:blank，注入完才導頁（見下面的說明） */
  startUrl: string
  /** 只導頁一次——CDP 斷線會重連，重連時再導一次就是無限重載 */
  navigated?: boolean
  ws?: WebSocket
  cdpSend?: CdpSend
  cropRequest?: { scriptId: string; platform: string; name: string; threshold: number; createdBy: string }
  /** console／network／pinus 攔截。錄製時掛上，停止時一起收掉 */
  capture?: Awaited<ReturnType<typeof attachCdpCapture>>
  captureTimer?: ReturnType<typeof setInterval>
  /** 已經回報給 server 的 console 筆數——只送新增的那幾筆，不每次整包重送 */
  consoleSent?: number
  /**
   * 暫停中。**這裡是這一輪錄製的權威狀態**——頁面每次導頁都會重新注入、
   * 面板整個重建，狀態放頁面就會在導頁後安靜消失。
   */
  paused?: boolean
  /** 控制面板的配色。跟著開始錄製時的畫面模式走 */
  theme?: 'normal' | 'xianxia'
  /**
   * server 那一側自己加進清單的積木數（目前只有框選截圖）。
   * agent 的 `steps` 看不到它們，面板的步數要把這個加回去才跟主畫面一致。
   */
  extraSteps?: number
}

const uatRecSessions = new Map<string, UatRecSession>()

// ── UAT Script Run Sessions ──────────────────────────────────────────────────
const uatScriptRuns = new Map<string, { active: boolean }>()

// ── UI Screenshot Run Sessions ────────────────────────────────────────────────
const uiScreenshotRuns = new Map<string, { stopped: boolean }>()

interface UiScreenshotRunConfig {
  id: string
  gameUrlTemplate: string
  tasks: Array<{ id: string; gmid: string; resolution: string }>
  options: Record<string, boolean | number>
  concurrency: number
  /** 使用者在畫面上選的客戶端。舊版 server 不會帶，那時才退回 `isPcClientUrl` */
  clientType?: 'h5' | 'pc'
}

function normalizeMachineCode(value: string): string {
  return value.trim().toUpperCase().replace(/[–—−]/g, '-')
}

function machineTextHasExactCode(text: string | null | undefined, machineCode: string): boolean {
  if (!text) return false
  const expected = normalizeMachineCode(machineCode)
  const normalized = normalizeMachineCode(text)
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`).test(normalized)
}

/**
 * PC 版（Cocos）要 WebGL 才畫得出來。
 *
 * ⚠️ **headless 在某些機器拿不到 GPU，WebGL 直接不存在，Cocos 就不會初始化**
 *    （症狀是 `window.cc` 永遠不存在，看起來像「頁面沒載完」）。實測回報來自 macOS 的 agent。
 *    所以 PC 版一律補上軟體渲染的啟動參數；H5 不需要，不要順手加給它增加變數。
 */
const PC_BROWSER_ARGS = [
  // ⚠️ 只加最保守的兩個。`--use-gl=angle --use-angle=swiftshader` 在某些機器會讓
  //    GPU process 直接掛掉，症狀是「連 evaluate 都問不到」——比沒有 WebGL 還難查
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
]

/**
 * **舊版相容用的退路**：只有中控沒傳 `clientType` 時才會走到（舊版 server 配新版 agent）。
 * 正常情況下客戶端是使用者在畫面上選的，這支不會被呼叫。
 *
 * ⚠️ **只看 hostname，不看 query。**原本是拿 `osm-pc` 或 `platform=pc` 打整條網址，
 *    但 H5 的正式網址本身就帶 `&platform=pc&device=mobile`——於是每一次 H5 都被判成 PC，
 *    跑去讀根本不存在的 Cocos 場景樹，然後在 `pcWaitLobby` 空等 60 秒，
 *    錯誤訊息卻長得像「大廳載不出來 / 瀏覽器被關掉」，看不出是判錯分支。
 * ⚠️ 同樣不用「DOM 找不到卡片」來推——找不到卡片的原因很多（還沒載完、在機台裡、被彈窗蓋住），
 *    用那個來判平台會在該報錯的時候安靜走錯分支。
 */
function isPcClientUrl(url: string): boolean {
  try {
    return /^osm-pc[-.]/i.test(new URL(url).hostname)
  } catch {
    return false
  }
}

/**
 * 這一輪要跑哪一套客戶端。
 * 中控有給就用中控給的（使用者在畫面上選的）；沒給才退回看主機名，而且會印出來。
 * ⚠️ 不要把「沒給」默默當成 H5 或 PC——那就是這個 bug 原本的樣子：安靜地跑錯分支。
 */
function resolveIsPc(clientType: 'h5' | 'pc' | undefined, url: string, where: string): boolean {
  if (clientType === 'pc') return true
  if (clientType === 'h5') return false
  const guessed = isPcClientUrl(url)
  let host = ''
  try { host = new URL(url).hostname } catch { host = '(網址解析不了)' }
  // ⚠️ 未知主機在這條退路下會被當成 H5——**這是相容限制，不是判斷出來的結論**（CodeX 指出）。
  //    所以訊息要說「當成」而不是「判定為」，並且把主機名印出來，讓人看得出是猜的。
  const known = /^osm-(pc|h5)[-.]/i.test(host)
  console.warn(
    `[UI-SS] ${where}：中控沒傳 clientType（舊版 server？），退回看主機名 ${host} → ` +
    (known ? `${guessed ? 'PC' : 'H5'}` : 'H5（主機不在已知清單內，這是退路的預設值，不是判斷結果——請在畫面上直接指定客戶端）')
  )
  return guessed
}

/** 大廳上的一張機台卡片。`occupied` 直接讀 DOM，不用點進去才知道。 */
interface LobbyCard {
  gmid: string; game: string; model: string; occupied: boolean
  /** 卡片上有「預約資訊」。實測 3 張有、而且同時都是 occupied——留著當獨立訊號，不混進 occupied */
  reserved: boolean
}

/**
 * 掃大廳所有機台卡片。
 *
 * ⚠️ `occupied` 只能當**候選**，不能當「一定進得去」：等我們點下去可能已經被別人搶先。
 *    所以挑完仍然要用「真的進到機台＋推流就緒」來確認（CodeX review）。
 */
async function scanUiScreenshotLobby(page: Page): Promise<LobbyCard[]> {
  await page.waitForSelector('#grid_gm_item', { timeout: 15000 }).catch(() => null)
  const raw = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('#grid_gm_item'))
    return items.map(el => {
      const gmid = (el.getAttribute('title') || '').trim()
      const m = /^\d+-([A-Z0-9]+)-/.exec(gmid.toUpperCase())
      // ⚠️ 名稱只讀 `.grid-item-name`，**不要用整張卡的 innerText**：
      //    有些卡片多一格「預約資訊」（`.grid-item-reserved-info-static`，內容是遮罩過的號碼
      //    像 `10*****48`），用 innerText 會把它一起吃進來，model 變成「10*****48 Emperor」。
      //    實測 697 張卡片**全部**都有 `.grid-item-name`，這個選擇器是可靠的。
      const nameEl = el.querySelector('.grid-item-name')
      return {
        gmid,
        game: m ? m[1] : '',
        text: ((nameEl?.textContent ?? '') || (el as HTMLElement).innerText).replace(/\s+/g, ' ').trim(),
        reserved: !!el.querySelector('.grid-item-reserved-info-static'),
        occupied: /\boccupied\b/.test(el.innerHTML),
      }
    }).filter(c => c.gmid)
  })
  // model 的解析放在 node 這端做，跟掃描用同一份規則（瀏覽器端再寫一份遲早會漂掉）
  return raw.map(c => ({
    gmid: c.gmid, game: c.game, model: parseUiScreenshotModel(c.text),
    occupied: c.occupied, reserved: c.reserved,
  }))
}

/**
 * 讀「機台內」畫面上的機台名稱（例如 `Hyper Horse-TBR2052`）。
 *
 * 用途：重新載入後常常會**自動回到剛才那台機台**——這時候不需要再繞一次大廳，
 * 但要先確認「回到的是同一款」，不然會拿別台的畫面當這個 model 的截圖。
 * 讀不到就回空字串，由呼叫端決定要不要保守地走大廳流程。
 */
async function readInGameMachineName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const pattern = /^[A-Za-z0-9'’&. ]{2,40}-[A-Za-z]{2,5}\d{2,6}$/
    const nodes = Array.from(document.querySelectorAll('div, span, p, h1, h2, h3'))
    for (const el of nodes) {
      if (el.children.length) continue
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim()
      if (!pattern.test(t)) continue
      const r = el.getBoundingClientRect()
      if (r.width < 20 || r.height < 6) continue
      return t
    }
    return ''
  }).catch(() => '')
}

/**
 * 確保現在人在大廳（而且卡片真的讀得到）。
 *
 * ⚠️ 實測（使用者 2026-09-18 回報）：重新載入之後**不一定會落在大廳**——
 *    可能自動回到剛才那台機台裡，也可能面額彈窗直接蓋在畫面上。這兩種情況下掃卡片都會掃到 0 張，
 *    症狀是「`Lobby has no machine matching: COINCOMBO / Hyper Horse`」——
 *    **看起來像那個 model 不存在，其實是根本沒站在大廳**。
 *
 * ⚠️ 這裡的「退出機台」跟截圖後不再做的那個 Quit 是兩回事：這是**為了回到大廳**，不是收尾。
 */
async function ensureUiScreenshotLobby(page: Page, label: string, dismissPopup: boolean): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    // 彈窗可能蓋在大廳上，先關掉再判斷在不在大廳
    // ⚠️ 這裡原本**無條件**呼叫，等於繞過畫面上的「自動關閉面額彈窗」開關（CodeX 2026-09-21 指出）。
    //    使用者把開關關掉是想看到彈窗長什麼樣，結果這條路照樣幫他關掉——關的人還不知道自己關了。
    if (dismissPopup) await dismissUiScreenshotPopups(page, label)
    const count = await page.locator('#grid_gm_item').count().catch(() => 0)
    if (count > 0) return
    console.log(`[UI-SS] ${label} — 沒看到大廳卡片（第 ${attempt} 次），嘗試退出機台再回大廳`)
    await exitUiScreenshotMachine(page, label).catch(() => {})
    await page.waitForSelector('#grid_gm_item', { timeout: 20_000 }).catch(() => null)
    await page.waitForTimeout(1500)
  }
  const count = await page.locator('#grid_gm_item').count().catch(() => 0)
  if (count === 0) throw new Error(`回不到大廳（可能仍在機台內或頁面沒載完）: ${label}`)
}

/**
 * 從大廳挑一台這款遊戲、目前沒被佔用的機台。
 *
 * @param preferred 上一張截圖用的那台——優先回同一台，被佔走才換（使用者 2026-09-18 選「可以換台」，
 *                  但每張圖都要記錄實際用的是哪一台）
 * @param exclude   這一輪已經試過且失敗的機台
 */
async function pickUiScreenshotMachine(
  page: Page, target: string, preferred?: string, exclude: Set<string> = new Set(),
): Promise<{ gmid: string; totalOfTarget: number; freeOfTarget: number }> {
  let cards = await scanUiScreenshotLobby(page)
  let matches = cards.filter(c => uiScreenshotTargetMatches(target, c))
  // ⚠️ 卡片元素出現不代表名稱已經渲染好（`.grid-item-name` 會晚一點）。
  //    掃到 0 筆先等一下重掃一次，不要馬上下「查無此 model」的結論
  if (matches.length === 0) {
    await page.waitForTimeout(2500)
    cards = await scanUiScreenshotLobby(page)
    matches = cards.filter(c => uiScreenshotTargetMatches(target, c))
  }
  const free = matches.filter(c => !c.occupied && !exclude.has(c.gmid))
  if (matches.length === 0) {
    throw new Error(`Lobby has no machine matching: ${target}（大廳共 ${cards.length} 張卡片、其中 ${cards.filter(c => c.model).length} 張讀得到名稱）`)
  }
  if (free.length === 0) throw new Error(`No free machine for: ${target} (${matches.length} total, all occupied or already tried)`)
  const chosen = (preferred && free.find(c => c.gmid === preferred)) ? preferred : free[0].gmid
  return { gmid: chosen, totalOfTarget: matches.length, freeOfTarget: free.length }
}

/**
 * 一個「目標」怎麼對到大廳的機台卡片。同一個輸入框吃三種精度：
 *   `JJBX / Endless Treasure`  → 該遊戲的那個 model（**預設用這個**，因為一個遊戲代號底下有多個 model）
 *   `4182-WLZBHELIX`           → 前綴比對（某場館的某款）
 *   `4175-BULLBLITZ-0056`      → 就是那一台
 */
function uiScreenshotTargetMatches(target: string, card: LobbyCard): boolean {
  const t = target.trim()
  if (t.includes('/')) {
    const [g, m] = t.split('/').map(x => x.trim())
    return card.game === g.toUpperCase() && card.model === m
  }
  return card.gmid.toUpperCase().startsWith(t.toUpperCase())
}

/**
 * 卡片顯示名稱 → model。
 *
 * ⚠️ **同一個遊戲代號底下有多個 model**（實測 WLZBHELIX 39 台有 14 種、WLZBLINK 95 台有 5 種）。
 *    只用遊戲代號分組的話，一款只會拍到其中一個 model，其餘的**永遠不會被拍到，而畫面上看起來有拍**。
 *
 * ⚠️ 名稱格式大致是 `<Model>-<場館><編號>`，但實測有解析不乾淨的案例
 *    （`10*****48 Emperor` 這種帶遮罩數字的、`Fortune-0289`）。解析不出來的**不要硬塞進某一組**，
 *    回空字串讓上層單獨列出。
 */
function parseUiScreenshotModel(cardText: string): string {
  const t = (cardText || '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  // 尾巴有兩種寫法：`-<場館><編號>`（Leprechaun-NCH1505）與 `-<編號>`（Fortune-0289）
  // ⚠️ 只認這兩種；第一版漏了後者，結果 39 台被判成「無法判斷 model」而整批消失在清單外
  const stripped = t.replace(/-(?:[A-Za-z]{2,5})?\d+$/, '').trim()
  if (!stripped || /\d{3,}$/.test(stripped)) return ''
  return stripped
}

/** 掃大廳並依 model 分組（給前端勾選用） */
async function scanUiScreenshotModels(page: Page) {
  const cards = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('#grid_gm_item'))
    return items.map(el => {
      const nameEl = el.querySelector('.grid-item-name')
      return {
        gmid: (el.getAttribute('title') || '').trim(),
        // 同上：只取名稱那一格，避免把「預約資訊」的遮罩號碼當成 model 的一部分
        text: ((nameEl?.textContent ?? '') || (el as HTMLElement).innerText).replace(/\s+/g, ' ').trim(),
        occupied: /\boccupied\b/.test(el.innerHTML),
      }
    }).filter(c => c.gmid)
  })
  const groups = new Map<string, { game: string; model: string; total: number; free: number; sample: string }>()
  const unparsed: Array<{ gmid: string; text: string }> = []
  for (const c of cards) {
    const m = /^\d+-([A-Z0-9]+)-/.exec(c.gmid.toUpperCase())
    const game = m ? m[1] : ''
    const model = parseUiScreenshotModel(c.text)
    if (!game || !model) { unparsed.push({ gmid: c.gmid, text: c.text }); continue }
    const key = `${game} / ${model}`
    const g = groups.get(key) ?? { game, model, total: 0, free: 0, sample: '' }
    g.total++
    if (!c.occupied) { g.free++; if (!g.sample) g.sample = c.gmid }
    groups.set(key, g)
  }
  return {
    scannedAt: Date.now(),
    cardCount: cards.length,
    models: [...groups.entries()].map(([key, g]) => ({ key, ...g })).sort((a, b) => b.total - a.total),
    unparsed,
  }
}

async function enterUiScreenshotMachine(page: Page, machineCode: string): Promise<'entered' | 'already-in-game'> {
  const lobbyItem = await page.waitForSelector('#grid_gm_item', { timeout: 15000 }).catch(() => null)
  if (!lobbyItem) return 'already-in-game'

  let foundMachine = false
  for (let attempt = 1; attempt <= 3; attempt++) {
    const items = await page.$$('#grid_gm_item')
    for (const item of items) {
      const title = await item.getAttribute('title')
      const cardText = await item.innerText().catch(() => '')
      if (!machineTextHasExactCode(`${title ?? ''} ${cardText}`, machineCode)) continue
      foundMachine = true

      await item.scrollIntoViewIfNeeded().catch(() => {})
      await item.evaluate(el => (el as HTMLElement).click())
      console.log(`[UI-SS] ${machineCode} selected lobby item: ${title ?? cardText.slice(0, 80)} (attempt ${attempt})`)
      await page.waitForTimeout(1500)

      const joinClicked = await clickFirstVisible(page, [
        "//div[contains(@class,'gm-info-box')]//span[normalize-space(text())='Join']",
        "//div[contains(@class,'gm-info-box')]//*[normalize-space(text())='Join']",
        "//*[normalize-space(text())='Join']",
        "//*[contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'join')]",
        ".gm-info-box [class*='join']",
        "[class*='join']",
      ])
      if (joinClicked) {
        console.log(`[UI-SS] ${machineCode} clicked Join`)
        await page.waitForTimeout(3000)
        return 'entered'
      }

      const panelText = await page.locator('.gm-info-box').first().innerText({ timeout: 1000 }).catch(() => '')
      console.log(`[UI-SS] ${machineCode} Join not found (attempt ${attempt}) panel="${panelText.replace(/\s+/g, ' ').slice(0, 160)}"`)
      await page.keyboard.press('Escape').catch(() => {})
      await page.waitForTimeout(1000)
      break
    }

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    await page.waitForSelector('#grid_gm_item', { timeout: 15000 }).catch(() => null)
    await page.waitForTimeout(1500)
  }

  if (foundMachine) throw new Error(`Join button not found after selecting machine: ${machineCode}`)
  throw new Error(`Lobby machine not found: ${machineCode}`)
}

async function isUiScreenshotLobbyVisible(page: Page): Promise<boolean> {
  const items = await page.locator('#grid_gm_item').all().catch(() => [])
  for (const item of items) {
    if (await item.isVisible().catch(() => false)) return true
  }
  return false
}

async function waitForUiScreenshotReady(page: Page, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isUiScreenshotLobbyVisible(page)) {
      await page.waitForTimeout(500)
      continue
    }

    const ready = await page.evaluate(() => {
      const gameSelectors = ['.my-button.btn_spin', '.balance-bg.hand_balance', '.h-balance.hand_balance']
      const hasGameUi = gameSelectors.some(sel =>
        Array.from(document.querySelectorAll(sel)).some(el => (el as HTMLElement).offsetParent !== null),
      )
      const videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[]
      const hasVideo = videos.some(v => !v.paused && v.readyState >= 2 && v.videoWidth > 0)
      const canvases = Array.from(document.querySelectorAll('canvas')) as HTMLCanvasElement[]
      const hasCanvas = canvases.some(c => c.width > 100 && c.height > 100)

      return hasGameUi || hasVideo || hasCanvas
    }).catch(() => false)

    if (ready) return true
    await page.waitForTimeout(500)
  }
  return false
}

async function isUiScreenshotPopupVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const selectors = ['.select-bg', '.select-main', '.van-popup', '.van-overlay']
    return selectors.some(sel =>
      Array.from(document.querySelectorAll(sel)).some(el => {
        const node = el as HTMLElement
        const rect = node.getBoundingClientRect()
        const style = window.getComputedStyle(node)
        return rect.width > 20 && rect.height > 20 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
      }),
    )
  }).catch(() => false)
}

/**
 * 關掉進場後的彈窗。**實作在 `uat-runner/ui-popup.js`**——驗證腳本跟這裡跑同一份。
 *
 * ⚠️ 原本整段寫在這個檔案裡，驗證腳本碰不到，要驗就只能在測試裡再寫一份同樣的判斷，
 *    那等於**測試在驗自己**。抽出去之後兩邊 import 同一支。
 *
 * @param opts.strict 只點**已確認用途**的彈窗，沒見過的不點、只回報（給「一直盯著」的看門狗用）
 */
async function dismissUiScreenshotPopups(
  page: Page,
  label: string,
  opts: { strict?: boolean } = {},
): Promise<{ dismissed: number; errors: string[]; blocked: string[] }> {
  return dismissUiPopups(page, label, { strict: opts.strict === true })
}

/**
 * **在一段等待期間一直盯著彈窗。**
 *
 * 為什麼需要：原本只在「進機台前」「推流就緒後」各關一次——中間那幾段完全沒人看：
 * 點卡片進場的那一下、等推流的迴圈、截圖前等的那幾秒。彈窗在這三段冒出來的話，
 * 症狀分別是「點了但還停在大廳」「Game surface not ready」「拍到被蓋住的畫面」，
 * **三種訊息都不會提到彈窗**（使用者 2026-09-21 回報）。
 *
 * ⚠️ **只處理已確認用途的彈窗**（`strict`）。理由見 `dismissUiScreenshotPopups` 裡的 KNOWN。
 * ⚠️ **一次只跑一輪、輪與輪之間序列化**，而且 `stop()` 會等進行中的那輪跑完——
 *    不這樣的話會跟主流程同時點，變成「兩隻手搶同一顆按鈕」。
 * ⚠️ 有次數上限。沒有上限的話，遇到關不掉的彈窗會變成無聲的無限點擊。
 */
function startUiScreenshotPopupGuard(page: Page, label: string, enabled: boolean) {
  const result = { dismissed: 0, errors: [] as string[], blocked: [] as string[] }
  if (!enabled) return { stop: async () => result }

  let active = true
  let passes = 0
  const MAX_PASSES = 40
  let inFlight: Promise<void> = Promise.resolve()

  const loop = (async () => {
    while (active && passes < MAX_PASSES) {
      await new Promise(r => setTimeout(r, 700))
      if (!active) break
      passes++
      inFlight = (async () => {
        const r = await dismissUiScreenshotPopups(page, label, { strict: true }).catch(() => null)
        if (!r) return
        result.dismissed += r.dismissed
        result.errors.push(...r.errors)
        // 同一個關不掉的彈窗每輪都會回報一次，去重之後才看得出到底有幾種
        for (const b of r.blocked) if (!result.blocked.includes(b)) result.blocked.push(b)
      })()
      await inFlight
    }
  })()

  return {
    /** 停止並等進行中的那一輪跑完。⚠️ 截圖前一定要先 stop，否則會拍到「正在被點掉」的畫面 */
    async stop() {
      active = false
      await loop.catch(() => {})
      await inFlight.catch(() => {})
      return result
    },
  }
}

async function clickFirstVisible(page: Page, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    const locator = selector.startsWith('//') ? page.locator(`xpath=${selector}`) : page.locator(selector)
    const count = await locator.count().catch(() => 0)
    for (let i = 0; i < count; i++) {
      const target = locator.nth(i)
      if (!await target.isVisible().catch(() => false)) continue
      await target.evaluate(el => (el as HTMLElement).click()).catch(async () => {
        await target.click({ force: true, timeout: 1000 })
      })
      return true
    }
  }
  return false
}

async function waitForUiScreenshotLobby(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isUiScreenshotLobbyVisible(page)) return true
    await page.waitForTimeout(500)
  }
  return false
}

async function exitUiScreenshotMachine(page: Page, machineCode: string): Promise<void> {
  const cashoutSelectors = [
    '.handle-main .my-button.btn_cashout',
    '.my-button.btn_cashout',
    '.btn_cashout',
    '[class*="btn_cashout"]',
    '[class*="cashout"]',
  ]
  const exitSelectors = [
    '.function-btn .reserve-btn-gray',
    '.reserve-btn-gray',
    '[class*="exit"]',
    '[class*="back"]',
    "//button[normalize-space(text())='Exit']",
    "//button[normalize-space(text())='Exit To Lobby']",
    "//*[contains(concat(' ', normalize-space(@class), ' '), ' reserve-btn-gray ') and normalize-space(.)='Exit']",
    "//*[contains(concat(' ', normalize-space(@class), ' '), ' reserve-btn-gray ') and normalize-space(.)='Exit To Lobby']",
  ]
  const confirmSelectors = [
    "//button[.//div[normalize-space(text())='Confirm']]",
    "//button[normalize-space(text())='Confirm']",
    "//button[normalize-space(text())='確認']",
    "//*[normalize-space(text())='Confirm']",
    "//*[normalize-space(text())='確認']",
  ]

  const cashoutClicked = await clickFirstVisible(page, cashoutSelectors)
  if (cashoutClicked) {
    console.log(`[UI-SS] ${machineCode} clicked cashout`)
    await page.waitForTimeout(3000)
    if (await waitForUiScreenshotLobby(page, 1500)) {
      console.log(`[UI-SS] ${machineCode} returned to lobby after cashout`)
      return
    }
  }

  if (!cashoutClicked) {
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(1000)
    if (await isUiScreenshotLobbyVisible(page)) {
      console.log(`[UI-SS] ${machineCode} returned to lobby after Escape`)
      return
    }
  }

  console.log(`[UI-SS] ${machineCode} checking second-step exit/confirm`)
  await page.waitForTimeout(1000)
  const exitClicked = await clickFirstVisible(page, exitSelectors).catch(() => false)
  if (exitClicked) {
    console.log(`[UI-SS] ${machineCode} clicked second-step Exit`)
    await page.waitForTimeout(1000)
  }

  const confirmClicked = await clickFirstVisible(page, confirmSelectors).catch(() => false)
  if (confirmClicked) {
    console.log(`[UI-SS] ${machineCode} clicked Confirm`)
    await page.waitForTimeout(1000)
  }

  if (await waitForUiScreenshotLobby(page, 12_000)) {
    console.log(`[UI-SS] ${machineCode} returned to lobby`)
    return
  }

  throw new Error(`Exit machine failed before closing page: ${machineCode} (cashout=${cashoutClicked}, exit=${exitClicked}, confirm=${confirmClicked})`)
}

/**
 * 掃一次大廳、把 model 清單回報給伺服器（給前端勾選要拍哪些）。
 *
 * ⚠️ **只看不點**：不進任何機台。掃描本身不該佔用任何機器。
 */
async function runUiScreenshotScan(msg: UiScreenshotScanMessage, serverBaseUrl: string) {
  const { chromium } = await import('playwright')
  const url = msg.gameUrlTemplate.replace('{gmid}', '')
  let browser: import('playwright').Browser | null = null
  const post = (body: object) =>
    fetch(`${serverBaseUrl}/api/ui-screenshot/scan-result/${msg.scanId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).catch(() => {})
  try {
    const pc = resolveIsPc(msg.clientType, url, '掃大廳')
    console.log(`[UI-SS] 掃大廳客戶端＝${pc ? 'PC' : 'H5'}（${msg.clientType ? '使用者指定' : '主機名推定'}）`)
    // ⚠️ PC 版掃描也要能用 Headed：headless 拿不到 GPU 時 Cocos 根本不會初始化，
    //    而掃描原本寫死 headless，導致使用者把畫面上的「Headed 模式」打開也沒有任何效果
    const headless = !msg.headed
    browser = await chromium.launch({ headless, args: pc ? PC_BROWSER_ARGS : [] })
    // PC 版是 canvas，視窗開小會讓大廳只渲染很少的東西，掃描用桌面尺寸
    const ctx = await browser.newContext({ viewport: pc ? { width: 1440, height: 900 } : { width: 390, height: 844 } })
    const page = await ctx.newPage()
    // ⚠️ 要在 goto 之前補：addInitScript 只對「之後載入的文件」生效
    if (pc) await pcInstallEvalShim(page)
    await page.goto(url, { timeout: 40000 })
    let result
    if (pc) {
      const diag = await pcWaitLobby(page)
      if (!diag.ready) throw new Error(`PC 版大廳沒載出來：${describePcLobby(diag)}`)
      console.log(`[UI-SS] PC 大廳診斷：${describePcLobby(diag)}`)
      await pcClosePopups(page)
      // 用 ScrollView 位移一格一格捲：一開始只讀得到幾台，捲過之後文字標籤才會生出來
      const collected = await pcCollectMachines(page)
      const machines = collected.machines
      console.log(`[UI-SS] PC 掃描：捲了 ${collected.scrolls} 次、收到 ${machines.length} 台${collected.partial ? '（未掃完）' : ''}`)
      // ⚠️ 不是每台都讀得到名稱（實測 695/699）。數字照實回報，不要說成「PC 版就這麼多台」
      const groups = new Map<string, { game: string; model: string; total: number; free: number; sample: string }>()
      for (const m of machines) {
        const model = parseUiScreenshotModel(m.name) || m.name
        const key = `PC / ${model}`
        const g = groups.get(key) ?? { game: 'PC', model, total: 0, free: 0, sample: '' }
        g.total++
        if (!m.occupied) { g.free++; if (!g.sample) g.sample = m.name }
        groups.set(key, g)
      }
      result = {
        scannedAt: Date.now(),
        cardCount: machines.length,
        models: [...groups.entries()].map(([key, g]) => ({ key, ...g })).sort((a, b) => b.total - a.total),
        unparsed: [] as Array<{ gmid: string; text: string }>,
        partial: true,
        partialNote: `PC 版的機台名稱是捲到才生出來的，這次捲了 ${collected.scrolls} 次收到 ${machines.length} 台；橫向排列的部分還沒捲，清單可能仍不完整`,
      }
    } else {
      await page.waitForSelector('#grid_gm_item', { timeout: 30000 })
      await page.waitForTimeout(2000)
      result = await scanUiScreenshotModels(page)
    }
    console.log(`[UI-SS] 掃描完成：${result.cardCount} 台、${result.models.length} 個 model、無法解析 ${result.unparsed.length}`)
    await post({ ok: true, ...result })
  } catch (err) {
    const m = err instanceof Error ? err.message.split('\n')[0] : String(err)
    console.error(`[UI-SS] 掃描失敗：${m}`)
    await post({ ok: false, message: m })
  } finally {
    await browser?.close().catch(() => {})
  }
}

async function runUiScreenshot(runConfig: UiScreenshotRunConfig, serverBaseUrl: string) {
  const { id: runId, gameUrlTemplate, tasks, options } = runConfig
  /**
   * ⚠️ **整個 run 只判定一次**，下面三個地方共用。
   *    原本三處各自呼叫 `isPcClientUrl()`，其中一處還是拿 `page.url()`（導頁後的網址）去判，
   *    等於同一個 run 可能有三個不同答案。
   */
  const isPc = resolveIsPc(runConfig.clientType, gameUrlTemplate, `run ${runId}`)
  console.log(`[UI-SS] run ${runId} 客戶端＝${isPc ? 'PC' : 'H5'}（${runConfig.clientType ? '使用者指定' : '主機名推定'}）`)
  uiScreenshotRuns.set(runId, { stopped: false })

  const { chromium } = await import('playwright')

  // Group tasks by gmid — one browser session per gmid
  const tasksByGmid = new Map<string, typeof tasks>()
  for (const task of tasks) {
    if (!tasksByGmid.has(task.gmid)) tasksByGmid.set(task.gmid, [])
    tasksByGmid.get(task.gmid)!.push(task)
  }

  const postStatus = (taskId: string, status: string, errorMsg?: string) =>
    fetch(`${serverBaseUrl}/api/ui-screenshot/task/${taskId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, errorMsg }),
    }).catch(() => {})

  for (const [gmid, gmidTasks] of tasksByGmid) {
    const ctrl = uiScreenshotRuns.get(runId)
    if (ctrl?.stopped) break

    const url = gameUrlTemplate.replace('{gmid}', gmid)
    console.log(`[UI-SS] gmid=${gmid} url=${url} resolutions=${gmidTasks.map(t => t.resolution).join(',')}`)

    let browser: import('playwright').Browser | null = null
    /**
     * ⚠️ **每個解析度重新載入**（預設開）。使用者 2026-09-18 確認：
     * 這些遊戲的版型是**載入當下**依視窗大小決定的。只改 viewport 再截圖，拍到的是
     * 「用 A 尺寸載入、硬撐成 B 尺寸」的畫面——看起來有拍到，但那不是該解析度真正會長的樣子，
     * 而且**正是這個功能要抓的那種 bug 永遠不會出現**。
     * 舊的快速模式（一次進場、只改 viewport）保留成選項，代價是每個解析度都要重進一次機台。
     */
    const reloadPerResolution = options.reloadPerResolution !== false
    const screenshotDelaySeconds = typeof options.screenshotDelaySeconds === 'number'
      ? Math.max(0, Math.min(60, options.screenshotDelaySeconds))
      : 5

    /**
     * 自動選機：`gmid` 這一欄放的是**遊戲代號**，實際要進哪一台由大廳當下的狀態決定。
     * ⚠️ 每張截圖都要重新載入，所以**每一張都可能被別人搶台**——優先回原台，被佔走才換，
     *    而且每張圖都會回報實際用的機台號（使用者 2026-09-18 選「可以換台」）。
     */
    const autoPick = options.autoPickByGame === true
    const isLobbyTarget = gmid === '__LOBBY__'
    let lastUsedMachine: string | undefined
    /**
     * 這一張截圖在準備過程中被關掉的錯誤提示（例如 `CODE: ERR_NETWORK`）。
     * ⚠️ 關掉彈窗**不等於**那張圖是乾淨的——錯誤發生過就要跟著這張圖一起回報，
     *    否則畫面上看起來只是一張普通截圖，沒人知道它是在出過網路錯誤的狀態下拍的。
     */
    let popupErrorNote = ''
    /**
     * 出過「遊戲異常 / error 39」這種錯誤提示的機台。
     * ⚠️ 不記起來的話，下一個解析度會因為 `lastUsedMachine` 又挑同一台，然後同樣的錯再來一次——
     *    一整批解析度全毀，而且每一張的錯誤訊息看起來都像新問題。
     */
    const brokenMachines = new Set<string>()

    /** 進場：導頁 → （自動選機）→ 進機台 → 等推流 → 關面額彈窗 → 等指定秒數。回傳實際機台號 */
    const prepare = async (page: Page): Promise<string> => {
      popupErrorNote = ''
      const noteBlocked = (blocked: string[]) => {
        if (!blocked.length) return
        // ⚠️ 這是**擋住流程但我們不敢點**的彈窗。一定要跟著這張圖回報——
        //    不講的話，畫面上只會看到一張被蓋住的截圖，沒人知道是彈窗造成的
        const note = `有彈窗未處理（不在已確認清單內，沒有自動點）：${blocked.join('；').slice(0, 300)}`
        popupErrorNote = popupErrorNote ? `${popupErrorNote}｜${note}` : note
        console.warn(`[UI-SS] ${gmid} — ${note}`)
      }
      const noteErrors = (r: { errors: string[]; blocked?: string[] }, machine?: string) => {
        if (r.blocked?.length) noteBlocked(r.blocked)
        if (!r.errors.length) return
        popupErrorNote = `進場時出現提示：${r.errors[0]}`
        // 遊戲本身壞掉（不是網路瞬斷）就把這台排除，下一張換一台試
        if (machine && /exception|異常|异常|customer service|\(\d{1,3}\)/i.test(r.errors[0])) {
          brokenMachines.add(machine)
          if (lastUsedMachine === machine) lastUsedMachine = undefined
        }
      }
      await page.goto(url, { timeout: 30000 })

      // ── PC 版（Cocos canvas）：DOM 裡沒有任何機台元素，改讀場景樹 ──────────
      if (isPc) {
        // 🚨 **上一個 task 的位子還佔著的話，重新載入會直接掉回那台機台。**
        //    這時候大廳清單不會建出來，掃到 0 台，錯誤訊息看起來像解析度問題。
        //    所以先確認在不在大廳，不在就退回去。
        await pcInstallEvalShim(page)
        // ⚠️ **不能在 goto 之後馬上判斷場景。**剛載入時場景還是 `lobby`，客戶端要再過幾秒
        //    才會自動把你送回上一輪還佔著位子的那台機台。太早判斷永遠是 false，
        //    然後就在那邊空等 60 秒直到 timeout（實測：退回大廳那行 log 一次都沒印出來）。
        //    所以改成「先短等一次 → 沒好就看是不是被送進機台了 → 退回大廳 → 再等一次」。
        let diag = await pcWaitLobby(page, 25_000)
        /**
         * ⚠️ **決策拆在 `pcLobbyRecoveryPlan`**（純函式、有測試）。
         *    這裡只負責「照著做」——原本整串 if 寫在這裡，其中 reload 那條
         *    **從來沒被實際觸發過**，等於沒人知道它會不會做對的事。
         */
        let reloadTried = false, leaveTried = false
        while (!diag.ready) {
          const scene = await pcSceneName(page)
          const plan = pcLobbyRecoveryPlan({ ready: diag.ready, scene, reloadTried, leaveTried })
          if (plan === 'give-up' || plan === 'ready') break

          if (plan === 'reload') {
            // 場景是大廳但清單建不出來（上一輪被 /stop 砍掉之後實測到的狀態）
            reloadTried = true
            console.log(`[UI-SS] PC 大廳建不出來（場景=${scene || '未知'}、機台卡片 ${diag.machineItems}）→ 重新載入再等一次`)
            await page.goto(url, { timeout: 30000 }).catch(() => {})
            diag = await pcWaitLobby(page, 40_000)
            continue
          }

          // plan === 'leave-machine'：被送回上一輪還佔著位子的那台
          leaveTried = true
          // ⚠️ **退出確認框（`box_sure`）是對齊畫布中心的，窄視窗下那一點在視窗外，點不到。**
          //    實測 log：`menu_back@19,43 → box_sure:找不到或在視窗外` 重複八次然後放棄。
          //    所以退出這段**暫時把視窗放大到 1024x768** 再做，做完改回目標尺寸——
          //    截圖是後面才拍的，這裡臨時改大小不影響最後的圖。
          const want = page.viewportSize()
          const needResize = !want || want.width < 1024 || want.height < 768
          // ⚠️ 改完視窗要等 Cocos 重新排版。不等的話第一下會用舊座標點下去——
          //    實測 log 裡第一步是 `menu_back@19,43`（放大前的位置），等於白點一下。
          if (needResize) {
            await page.setViewportSize({ width: 1024, height: 768 }).catch(() => {})
            await page.waitForTimeout(2000)
          }
          const back = await pcBackToLobby(page)
          if (needResize && want) await page.setViewportSize(want).catch(() => {})
          console.log(`[UI-SS] PC 一載入就被送回機台（上一輪的位子還佔著）→ 退回大廳${back.ok ? '成功' : '失敗'}`
            + `${needResize ? '（退出時暫時放大到 1024x768，確認鈕在窄視窗點不到）' : ''}：${back.steps.join(' → ') || '(沒點到任何按鈕)'}`)
          diag = await pcWaitLobby(page, 45_000)
        }
        if (!diag.ready) throw new Error(`PC 版大廳沒載出來：${describePcLobby(diag)}（場景=${await pcSceneName(page) || '未知'}）`)
        // JACKPOT／廣告彈窗是畫在 canvas 上的節點，DOM 關不掉，要把節點 active 設成 false
        const closed = await pcClosePopups(page)
        const machines = await pcScanLobby(page)
        console.log(`[UI-SS] PC 大廳就緒：可視 ${machines.length} 台（空機 ${machines.filter(m => !m.occupied).length}）、關掉 ${closed} 個彈窗節點`)
        if (!isLobbyTarget) {
          // ⚠️ 目標可能還沒捲到（名稱還沒生出來），所以邊捲邊找——**找到就停**，
          //    不要為了進一台機台把 695 台全掃完（掃完要 40 秒，找到通常只要幾秒）
          const want = gmid.includes('/') ? gmid.split('/')[1].trim() : gmid

          // 🚨 **一台不夠，要能換下一台。**同款機台通常有好幾台空的，而「挑的時候空著、
          //    捲回去已經有人」是常態（實測 Dancing Drums 12 台空機，仍然連續失敗 12 次，
          //    因為每次都挑同一台、失敗就直接放棄）。所以失敗要記起來、換一台再試。
          const tried = new Set<string>()
          let res: Awaited<ReturnType<typeof pcEnterMachine>> | null = null
          let picked: PcMachine | undefined
          let lastErr = ''
          let seekCensus = { total: 0, free: 0 }
          // ⚠️ 3 次不夠。正式站同款機台被別人（以及我們自己上一個解析度）搶走是常態，
          //    「挑的時候空著、點下去已經有人」每次都可能發生——實測 3 次還是會漏掉一個解析度。
          for (let attempt = 0; attempt < 5; attempt++) {
            picked = machines.find(m => (m.name === want || m.name.startsWith(want)) && !m.occupied && !tried.has(m.name))
            if (!picked) {
              const seek = await pcSeekMachine(page, want, { skip: tried })
              if (seek.picked) console.log(`[UI-SS] PC 找到 ${seek.picked.name}（捲 ${seek.steps} 格、途中看過 ${seek.scanned} 台）`)
              if (seek.matched.total > seekCensus.total) seekCensus = seek.matched
              picked = seek.picked ?? undefined
            }
            if (!picked) break
            tried.add(picked.name)
            res = await pcEnterMachine(page, picked.name)
            if (res.entered) break
            lastErr = `${picked.name}——${res.reason ?? `場景=${res.scene || '未知'}`}`
            console.warn(`[UI-SS] PC 進機台失敗（第 ${attempt + 1} 次）：${lastErr}`)
          }
          if (!picked) {
            // ⚠️ 「找不到」有三種完全不同的原因，訊息裡要分得出來，否則一律被當成程式壞掉：
            //    (a) 這款機台全被佔用 (b) 有空機但在視窗外點不到（窄解析度）(c) 根本沒掃到這款
            // ⚠️ 這個數字要用 **seek 途中**累積的，不能事後再掃一次——那時候清單已經捲到最底，
            //    目標機型早就不在畫面上，事後掃一律回 0 台，訊息會變成「掃到 0 台」誤導人。
            const reachable = (await pcScanLobby(page, { onScreenOnly: true })).length
            const vp = page.viewportSize()
            const census = `捲的途中看清楚 ${seekCensus.total} 台／其中空機 ${seekCensus.free} 台；`
              + `這個視窗（${vp?.width}x${vp?.height}）一次只看得到 ${reachable} 張卡片`
            throw new Error(`PC 大廳找不到可用的目標：${want}——${census}${tried.size ? `（已試過 ${tried.size} 台：${[...tried].join('、')}）` : ''}`)
          }
          if (!res?.entered) {
            // 錯誤訊息要講得出卡在哪一步：捲不到、點了沒進、還是進了但讀不到名稱
            throw new Error(`PC 進機台失敗（試過 ${tried.size} 台）：${lastErr}`)
          }
          // 🚨 **實測會點到隔壁台**（目標 Ingot-NWR2017、實際進到 Ingot-NWR2024），
          //    所以這裡照實回報「實際進到的那一台」，不要拿目標名稱充數
          if (res.actual !== picked.name) {
            console.warn(`[UI-SS] PC 點到的不是目標：想進 ${picked.name}、實際是 ${res.actual}——照實記錄`)
          }
          lastUsedMachine = res.actual || picked.name
          if (options.dismissPopup !== false) await pcClosePopups(page)
          if (screenshotDelaySeconds > 0) await page.waitForTimeout(screenshotDelaySeconds * 1000)
          return lastUsedMachine
        }
        if (screenshotDelaySeconds > 0) await page.waitForTimeout(screenshotDelaySeconds * 1000)
        return '__LOBBY__'
      }

      // 大廳本身就是拍攝目標：不進任何機台（一樣要先把蓋住畫面的彈窗關掉）
      if (isLobbyTarget) {
        await ensureUiScreenshotLobby(page, '__LOBBY__', options.dismissPopup !== false)
        if (screenshotDelaySeconds > 0) await page.waitForTimeout(screenshotDelaySeconds * 1000)
        return '__LOBBY__'
      }

      // ⚠️ 彈窗可能蓋在大廳、也可能蓋在機台畫面上，所以先關掉再判斷自己在哪
      if (options.dismissPopup !== false) noteErrors(await dismissUiScreenshotPopups(page, gmid), lastUsedMachine)

      /**
       * **重新載入之後常常會自動回到剛才那台機台**——這時候不必再繞一次大廳
       * （使用者 2026-09-18：「沒辦法直接重新刷新截圖對吧？」——可以，就是這條路徑）。
       *
       * ⚠️ 但要先確認回到的是**同一款**：讀機台內的名稱跟目標 model 比對。
       *    比不上（或讀不到而且我們根本還沒選過機台）就保守地走大廳流程，
       *    不然會拿別台的畫面當這個 model 的截圖，而畫面上完全看不出來。
       */
      const inLobby = (await page.locator('#grid_gm_item').count().catch(() => 0)) > 0
      if (!inLobby && lastUsedMachine) {
        const ready = await waitForUiScreenshotReady(page)
        const wantModel = gmid.includes('/') ? gmid.split('/')[1].trim().toUpperCase() : ''
        const seen = (await readInGameMachineName(page)).toUpperCase()
        const sameModel = !wantModel || !seen || seen.startsWith(wantModel)
        if (ready && sameModel) {
          console.log(`[UI-SS] ${gmid} — 重新載入後已在機台內（${seen || '名稱讀不到'}），直接截圖，不繞大廳`)
          if (options.dismissPopup !== false) noteErrors(await dismissUiScreenshotPopups(page, lastUsedMachine), lastUsedMachine)
          if (screenshotDelaySeconds > 0) await page.waitForTimeout(screenshotDelaySeconds * 1000)
          return lastUsedMachine
        }
        console.log(`[UI-SS] ${gmid} — 載入後在機台內但不是要的那款（看到「${seen || '讀不到'}」），退回大廳重選`)
      }

      // 走到這裡表示要從大廳挑機台：先確定真的站得到大廳
      await ensureUiScreenshotLobby(page, gmid, options.dismissPopup !== false)

      let target = gmid
      if (autoPick) {
        const picked = await pickUiScreenshotMachine(page, gmid, lastUsedMachine, brokenMachines)
        target = picked.gmid
        console.log(`[UI-SS] ${gmid} auto-picked ${target} (${picked.freeOfTarget}/${picked.totalOfTarget} free)`)
      }
      /**
       * 🚨 **從這裡開始到截圖前，全程盯著彈窗**（使用者 2026-09-21 回報：進機台時跳 Confirm
       * 沒被點掉，整個流程卡住）。原本只在「進機台前」「推流就緒後」各關一次，
       * 中間這三段沒人看——而彈窗正是在這三段冒出來的：
       *   ① 點卡片進場的那一下 → 被蓋住的話 click 直接 timeout，訊息只寫「點了但還停在大廳」
       *   ② 等推流的迴圈       → 變成 `Game surface not ready`
       *   ③ 截圖前等的那幾秒   → 直接拍到被蓋住的畫面
       * ⚠️ 看門狗只點**已確認用途**的彈窗；沒見過的不點、只記下來回報（CodeX 2026-09-21）。
       */
      const guard = startUiScreenshotPopupGuard(page, target, options.dismissPopup !== false)
      let ready = false
      try {
        const entryState = await enterUiScreenshotMachine(page, target)
        lastUsedMachine = target
        console.log(`[UI-SS] ${target} entry=${entryState}`)
        ready = await waitForUiScreenshotReady(page)
        if (ready) console.log(`[UI-SS] ${gmid} — stream ready`)
        if (options.dismissPopup !== false) {
          noteErrors(await dismissUiScreenshotPopups(page, target), target)
        }
        if (screenshotDelaySeconds > 0) {
          console.log(`[UI-SS] ${gmid} waiting ${screenshotDelaySeconds}s before screenshot`)
          await page.waitForTimeout(screenshotDelaySeconds * 1000)
        }
      } finally {
        // ⚠️ **一定要在截圖之前 stop 並等它跑完**，否則會拍到「正在被點掉」的那一瞬間
        const g = await guard.stop()
        if (g.dismissed) console.log(`[UI-SS] ${gmid} — 等待期間自動關掉 ${g.dismissed} 個彈窗`)
        noteErrors({ errors: g.errors, blocked: g.blocked }, target)
      }
      /**
       * ⚠️ **關掉錯誤框不等於這一台是好的**（CodeX 2026-09-21）。等待期間關過錯誤框、
       *    或推流本來就沒就緒的話，要重新確認一次再往下走——直接算成功會拍到黑畫面，
       *    而狀態欄寫的是 ok。
       */
      if (!ready) {
        ready = await waitForUiScreenshotReady(page)
        if (!ready) throw new Error(`Game surface not ready after entering machine: ${gmid}`)
        console.log(`[UI-SS] ${gmid} — 關掉彈窗後推流才就緒`)
      }
      return target
    }

    /** 拍一張 + 上傳。`actualGmid` 是這張圖實際用的機台（自動選機時每張可能不同） */
    const shootAndUpload = async (page: Page, task: { id: string; resolution: string }, actualGmid: string) => {
      // 大廳本來就該看得到卡片；只有「要進機台卻還停在大廳」才是錯
      if (!isLobbyTarget && await isUiScreenshotLobbyVisible(page)) {
        throw new Error(`Still in lobby before screenshot: ${gmid}`)
      }
      const screenshotBuf = await page.screenshot({ type: 'png', fullPage: false })
      const taskStatus = !isLobbyTarget && await isUiScreenshotPopupVisible(page) ? 'popup' : 'ok'
      console.log(`[UI-SS] ${gmid} ${task.resolution} → ${taskStatus} (machine=${actualGmid})`)

      const form = new FormData()
      form.append('screenshot', new Blob([new Uint8Array(screenshotBuf)], { type: 'image/png' }), `${task.resolution}.png`)
      form.append('status', taskStatus)
      form.append('actualGmid', actualGmid)
      if (popupErrorNote) form.append('errorMsg', popupErrorNote)
      const uploadRes = await fetch(`${serverBaseUrl}/api/ui-screenshot/task/${task.id}/upload`, {
        method: 'POST', body: form,
      })
      if (!uploadRes.ok) {
        const uploadError = `upload failed: HTTP ${uploadRes.status}`
        console.warn(`[UI-SS] ${gmid} ${task.resolution} ${uploadError}`)
        await postStatus(task.id, 'err', uploadError)
        return false
      }

      // 🚨 **拍完就要把位子讓出來。**帳號同時只能坐一台機台——還佔著上一台的話，
      //    下一個解析度在大廳點任何一張卡片都會被伺服器擋掉，而畫面上完全看不出被擋，
      //    錯誤訊息只會寫「點了 (x, y) 但還停在大廳」，看起來像座標算錯。
      //    實測：連續試 5 台全部失敗，其實 5 台都是空的，problem 在我們自己還坐在別台上。
      //    ⚠️ 退出是三步：`menu_back` →「Exit To Lobby」→ 下分框的 `Confirm`。
      if (!isLobbyTarget && isPc && await pcSceneName(page) === 'game') {
        const vp = page.viewportSize()
        const needResize = !vp || vp.width < 1024 || vp.height < 768
        if (needResize) { await page.setViewportSize({ width: 1024, height: 768 }).catch(() => {}); await page.waitForTimeout(2000) }
        const left = await pcBackToLobby(page)
        if (needResize && vp) await page.setViewportSize(vp).catch(() => {})
        console.log(`[UI-SS] ${gmid} ${task.resolution} 拍完退出機台：${left.ok ? '成功' : `失敗（場景=${left.scene}）`}`)
      }
      return true
    }

    try {
      browser = await chromium.launch({
        headless: !options.headedMode,
        args: isPc ? PC_BROWSER_ARGS : [],
      })

      if (reloadPerResolution) {
        // ── 每個解析度各自開一個 context、以該尺寸重新載入 ──────────────────
        for (const task of gmidTasks) {
          if (uiScreenshotRuns.get(runId)?.stopped) break
          const [w, h] = task.resolution.split('x').map(Number)
          // ⚠️ context 也要建在 try 裡。建在外面的話它一失敗就會掉進外層 catch，
          //    而外層 catch 會把**這台機器的每一張**都標成失敗——包含前面已經拍好的那幾張
          let ctx: import('playwright').BrowserContext | null = null
          try {
            ctx = await browser.newContext({ viewport: { width: w || 390, height: h || 844 } })
            const page = await ctx.newPage()
            await postStatus(task.id, 'running')
            const actual = await prepare(page)
            await shootAndUpload(page, task, actual)
            // ⚠️ 重新載入模式**不走離開機台的流程**（使用者 2026-09-18 指定）：
            //    反正下一張會關掉整個 context 重開，走一次 Quit 只是多花時間、多一個會卡住的地方。
            //    副作用：機台釋放如果有延遲，下一張可能會被迫換台——那時會自動挑同 model 的另一台，
            //    每張圖都有記錄實際機台號，所以看得出來。
          } catch (err) {
            // ⚠️ 單一解析度失敗**只標這一張**。整批一起標失敗的話，
            //    畫面看起來像「這台機器完全拍不到」，但其實只是某個尺寸進不去
            const m = err instanceof Error ? err.message.split('\n')[0] : String(err)
            console.error(`[UI-SS] ${gmid} ${task.resolution} error: ${m}`)
            await postStatus(task.id, /timeout/i.test(m) ? 'timeout' : 'err', m)
          } finally {
            await ctx?.close().catch(() => {})
          }
        }
        console.log(`[UI-SS] ${gmid} — done (reload per resolution), closing browser`)
      } else {
        // ── 快速模式：進場一次，之後只改 viewport（不重新載入）──────────────
        const firstTask = gmidTasks[0]
        const [w0, h0] = firstTask.resolution.split('x').map(Number)
        const ctx = await browser.newContext({ viewport: { width: w0 || 390, height: h0 || 844 } })
        const page = await ctx.newPage()

        await postStatus(firstTask.id, 'running')
        const actual = await prepare(page)

        for (const task of gmidTasks) {
          if (uiScreenshotRuns.get(runId)?.stopped) break
          if (task.id !== firstTask.id) await postStatus(task.id, 'running')
          const [w, h] = task.resolution.split('x').map(Number)
          await page.setViewportSize({ width: w || 390, height: h || 844 })
          await page.waitForTimeout(400) // let layout settle after resize
          await shootAndUpload(page, task, actual)
        }

        if (!isLobbyTarget) await exitUiScreenshotMachine(page, actual)
        console.log(`[UI-SS] ${gmid} — done (fast mode), closing browser`)
      }

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message.split('\n')[0] : String(err)
      const isTimeout = errorMsg.includes('timeout') || errorMsg.includes('Timeout')
      const status = isTimeout ? 'timeout' : 'err'
      console.error(`[UI-SS] ${gmid} error: ${errorMsg}`)
      for (const task of gmidTasks) {
        await postStatus(task.id, status, errorMsg)
      }
    } finally {
      await browser?.close().catch(() => {})
    }
  }

  uiScreenshotRuns.delete(runId)
}

async function runUatScript(msg: UatScriptRunMessage, serverWs: WebSocket) {
  const { runId, steps: stepsRaw, url: startUrl, platform, resolution, failureMode, headed } = msg
  const sendEvent = (event: Record<string, unknown>) => {
    if (serverWs.readyState === serverWs.OPEN) {
      serverWs.send(JSON.stringify({ type: 'uat_run_event', runId, event }))
    }
  }
  const log = (line: string) => sendEvent({ kind: 'log', line })

  type StepObj = { name?: string; action: string; value?: string; selector?: string; x?: number; y?: number; baselineId?: string; threshold?: number; scrollStep?: number; maxScrolls?: number; failureMode?: 'inherit' | 'continue' | 'stop' | 'retry'; retryCount?: number; urlPattern?: string; expectStatus?: '2xx' | 'any' | 'exact'; statusCode?: number; minCount?: number }
  let steps: StepObj[]
  try {
    // ⚠️ 步驟整理走共用那支（丟掉座標點擊後面重複的 selector 點擊）。
    //    原本**只有伺服器端做**，所以同一份腳本在 agent 上會多點一次——
    //    這是合併引擎時發現的第二處漂移。
    steps = compileFrontendSteps(JSON.parse(stepsRaw) as StepObj[]).steps as StepObj[]
  } catch {
    await log('❌ 步驟 JSON 解析失敗')
    sendEvent({ kind: 'error', message: '步驟 JSON 解析失敗' })
    uatScriptRuns.delete(runId)
    return
  }

  const [rawW, rawH] = resolution.split('x').map(Number)
  const w = rawW || 390
  const h = rawH || 844
  await log(`🔧 準備啟動瀏覽器：${headed ? 'Headed' : 'Headless'}，viewport ${w}x${h}`)

  const pw = await import('playwright')
  let browser: import('playwright').Browser | null = null
  let netCapture: ReturnType<typeof attachNetworkCapture> | null = null
  // assert_api_called 只看「這一步之後」打的 API。每次 goto 之後往前推——
  // 問的是「開了這頁、做了這些操作之後有沒有打到它」，不是整輪跑下來有沒有出現過。
  // ⚠️ 不推的話，第一次 goto 之前的請求會永遠留在集合裡，斷言變成幾乎不可能失敗。
  const netState = { netMark: Date.now() }
  let pinusProbe: Awaited<ReturnType<typeof attachPinusProbe>> | null = null
  let pinusDrainTimer: ReturnType<typeof setInterval> | null = null
  let statsTimer: ReturnType<typeof setInterval> | null = null
  // 彈窗看門狗的停止函式——在 try 裡面建立、finally 要停掉，所以宣告在外面
  let stopPopupWatcher: (() => string[]) | null = null
  // 門檻走 server 派工時帶下來的值，沒帶就用共用預設
  const netThresholds = {
    api: msg.netThresholds?.api ?? DEFAULT_THRESHOLDS.api,
    image: msg.netThresholds?.image ?? DEFAULT_THRESHOLDS.image,
    other: msg.netThresholds?.other ?? DEFAULT_THRESHOLDS.other,
  }
  let chromeProc: ReturnType<typeof spawn> | null = null
  let chromeProfileDir: string | null = null
  let passed = 0; let failed = 0; let skipped = 0

  try {
    if (headed) {
      const profileDir = join(tmpdir(), `toppath-run-${runId}`)
      chromeProfileDir = profileDir
      // ⚠️ port 讓 Chrome 自己挑（見 chrome-debug-port.js）。用亂數挑的話撞號時
      //    不會失敗，而是**接到別人的瀏覽器**——兩個 session 交叉污染且無錯誤訊息。
      clearStaleDebugPort(profileDir)
      const args = [
        DEBUG_PORT_ARG,
        `--user-data-dir=${profileDir}`,
        '--no-first-run', '--no-default-browser-check', '--new-window',
        `--window-size=${w + 20},${h + 140}`,
        'about:blank',
      ]
      chromeProc = spawn(chromeExecutable(), args, { stdio: 'ignore', shell: false, windowsHide: false })
      const port = await waitForDebugPort(profileDir, { isAlive: () => chromeProc?.exitCode === null })
      await waitForJson(`http://127.0.0.1:${port}/json/version`)
      browser = await pw.chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    } else {
      browser = await pw.chromium.launch({ headless: true, args: ['--force-device-scale-factor=1'] })
    }
    await log('✅ 瀏覽器已啟動')

    const ctx = headed
      ? (browser.contexts()[0] ?? await browser.newContext())
      : await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: platform === 'h5', hasTouch: platform === 'h5' })
    const page = headed
      ? (ctx.pages()[0] ?? await ctx.newPage())
      : await ctx.newPage()
    if (headed) {
      await page.setViewportSize({ width: w, height: h }).catch(() => {})
    }

    // 每 2 秒把一份快照送回 server 給面板即時更新。走既有的 uat_run_event
    // 結構化通道加一個 kind，不用像 Backend 那樣在 stdout 夾標記行
    statsTimer = setInterval(() => {
      if (!netCapture) return
      try {
        sendEvent({
          kind: 'stats',
          scope: 'frontend',
          net: netCapture.summary(),
          pinus: pinusProbe ? pinusProbe.summary() : undefined,
        })
      } catch { /* 快照失敗不能影響測試本身 */ }
    }, 2000)

    // ── 網路量測：每支 API 與每張圖的載入時間，超標的當下就回報 ──────────
    // 逐筆回報會直接洗版（一個遊戲頁動輒幾百張圖），所以平常只累積、
    // 只有超過門檻的才即時吐出來，收工時再出一次 summary
    netCapture = attachNetworkCapture(page, {
      thresholds: netThresholds,
      onSlow: (r) => { void log(`🐢 [網路] ${Math.round(r.durationMs!)}ms（門檻 ${r.thresholdMs}ms）${r.kind} ${r.url.slice(0, 120)}`) },
    })
    // ── pinus 攔截：只有 H5/PC 的遊戲頁有；後台管理站沒有 pinus，
    //    掛上去也只是 status().present = false，不會壞事
    try {
      pinusProbe = await attachPinusProbe(page)
      // 定期把頁面端 buffer 搬回來——頁面 buffer 滿了就會開始丟訊息
      pinusDrainTimer = setInterval(() => { void pinusProbe?.drain() }, 3000)
    } catch (err) {
      await log(`⚠️ pinus 攔截掛載失敗（不影響其他步驟）：${err instanceof Error ? err.message : String(err)}`)
    }

    // ⚠️ 選擇器解析要走跟 Backend 同一支。錄製器現在會產出 `text=`／`label=`／
    //    `:text-is()` 這些**不是原生 CSS**的寫法；直接 `page.locator(selector)` 的話
    //    `label=` 會被當成未知引擎而拋錯，`text=` 的語意也跟重播不一樣。
    //    requireUnique：命中多筆一律失敗，不要安靜取第一個——安靜點錯比找不到更糟。
    const { recordedLocator } = createRecordedLocators(page, { requireUnique: true, resolveTimeoutMs: 10000 })

    await log('✅ 執行頁面已準備完成')

    /**
     * 引擎要的那一包。兩條路徑（有綁 TC／沒綁）共用，不然會變成兩份設定。
     */
    const engineHost = {
      log, page, browser,
      recordedLocator, netCapture,
      startUrl,
      viewportHeight: h,
      backend: msg.backend ?? null,
      // PC（Cocos）積木的能力。⚠️ 引擎是純 JS，不能自己 import 這支 TS——見 pc-cocos.ts 的說明
      pc: pcEngineCapabilities,
      // WS(pinus)斷言要用的擷取器。⚠️ OSM 的業務幾乎全走 WS，HTTP 那邊只有遙測——
      //    沒帶這個的話 `assert_ws_called` 會明確失敗（不會靜默跳過）
      pinus: pinusProbe,
      /**
       * 基準圖：**server 派工時已經把圖的網址與門檻附在積木上**（跟後台設定片段同一個
       * 做法——agent 拿不到 DB，不能讓它自己查）。這裡只負責把圖抓下來。
       *
       * ⚠️ 抓不到要**明確失敗**。以前這顆積木在 agent 上是被跳過的，
       *    腳本照樣 PASS 而比對根本沒跑——那是修掉的東西，不能換個形式回來。
       */
      loadBaseline: async (target: Record<string, unknown>) => {
        const url = String(target.baselineUrl ?? '')
        if (!url) throw new Error('這顆基準圖積木沒有附帶圖片網址（伺服器端可能還沒更新）')
        const response = await fetch(url)
        if (!response.ok) throw new Error(`取不到基準圖（HTTP ${response.status}）：${url}`)
        const bytes = Buffer.from(await response.arrayBuffer())
        return {
          name: String(target.baselineName ?? '基準圖'),
          template: decodePng(bytes),
          threshold: Number(target.baselineThreshold) || 0.08,
        }
      },
      compareTemplate: (shot: ReturnType<typeof decodePng>, template: ReturnType<typeof decodePng>, threshold: number) =>
        findTemplateInPng(shot, template, threshold),
      decodePng: (buffer: Buffer) => decodePng(buffer),
    }

    /**
     * 🚨 **跑第一顆積木之前先把彈窗關掉。**
     *
     * H5 大廳一進去就可能蓋一張整頁的 JACKPOT 中獎彈窗（2026-09-19 實測 osmel002 就中了），
     * 蓋住之後**每一個 click 都會 timeout**，而錯誤訊息只寫
     * `locator.click: Timeout 10000ms exceeded`——看起來像選擇器寫錯或網站很慢，
     * 完全看不出是被一張圖蓋住。實測就是這樣連三次判斷錯方向。
     *
     * ⚠️ 這段原本**只有 UI 截圖那條路有**（`dismissUiScreenshotPopups`），
     *    H5/PC 的 UAT 執行路徑完全沒有——同一支 agent、同一個瀏覽器，兩條路行為不一致。
     *
     * ⚠️ 彈窗是隨機出現的（別人中獎就會跳），所以**不能靠錄製時錄到的關閉動作**——
     *    錄的時候有、重播的時候沒有，那一步就會失敗；反過來更慘。
     *
     * ⚠️ 關掉的數量一定要 log。默默關掉的話，萬一哪天有 TC 就是要驗「彈窗會出現」，
     *    症狀會變成「這個 TC 永遠失敗而且看不出為什麼」。
     */
    const popupResult = await dismissUiScreenshotPopups(page, `UAT ${platform}`)
    if (popupResult.dismissed > 0 || popupResult.errors.length) {
      await log(`🧹 執行前關掉 ${popupResult.dismissed} 個彈窗${popupResult.errors.length ? `（訊息：${popupResult.errors.join('；')}）` : ''}`)
    }
    /**
     * 🚨 **關一次不夠——大廳的中獎彈窗整段測試期間都會冒出來。**
     *
     * 只要有人中獎就播一張整頁的，實測十幾秒就來一次。蓋著的時候每個 click 都 timeout，
     * 而且是**隨機時間點**——這種 flaky 最難查（同一份腳本這次過、下次掛，看起來像網站不穩）。
     * 所以整段執行期間掛一個看門狗盯著關，關掉的每一張都寫進 log。
     *
     * ⚠️ 只關白名單內的關閉鍵（見 `uat-runner/lobby-popup.js`），不碰任何會進機台的按鈕。
     */
    stopPopupWatcher = startLobbyPopupWatcher(page, {
      onClose: (cls: string) => { void log(`🧹 測試進行中關掉彈窗（.${cls}）`) },
    })

    if (Array.isArray(msg.tcBindings) && msg.tcBindings.length) {
      // ── 綁了 TC：判定走共用聚合器，結果送回 server 回寫 ──────────────────
      //
      // ⚠️ **這條路徑沒有自己的迴圈**：重試、failureMode、失敗隔離全在共用的
      //    聚合器與 adapter 裡。外層再做一次的話同一顆積木會被跑兩次。
      const progress = { idx: '' }
      const tcCtx = {
        ...engineHost,
        progress,
        engine: createFrontendTcEngine({ ...engineHost, progress }),
        onStep: ({ index }: { index: number }) => { progress.idx = `[${index + 1}/${steps.length}]` },
        /**
         * 截圖：送回 server 存檔，拿回**伺服器本機的路徑**。
         *
         * ⚠️ 存在 agent 本機是沒用的——回寫是 server 做的，它讀不到那台機器的硬碟。
         * ⚠️ 送不回去回 null 不 throw（截圖是證據不是斷言），但**要講出來**：
         *    安靜掉一張圖的話，那一筆 TC 看起來只是「沒截圖」。
         */
        takeScreenshot: async (name: string) => {
          if (!msg.evidenceUrl || !msg.evidenceToken) return null
          try {
            const png = await page.screenshot({ fullPage: false })
            const response = await fetch(msg.evidenceUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: msg.evidenceToken, name, data: png.toString('base64') }),
            })
            const data = await response.json().catch(() => ({})) as { ok?: boolean; path?: string; message?: string }
            if (!response.ok || !data.path) throw new Error(data.message ?? `HTTP ${response.status}`)
            return data.path
          } catch (err) {
            await log(`⚠️ 截圖「${name}」沒能送回伺服器（這一筆 TC 會少一張證據）：${err instanceof Error ? err.message : String(err)}`)
            return null
          }
        },
      }
      const tcSteps = toMultiTcSteps(steps, failureMode === 'continue' ? 'continue' : 'stop')
      const { results, sharedFailure } = await runMultiTcSteps(tcSteps, tcCtx, msg.tcBindings)
      if (sharedFailure) await log(`🛑 共用步驟失敗：${sharedFailure}`)
      for (const row of results) {
        const mark = row.outcome === 'pass' ? '✅' : row.outcome === 'fail' ? '❌' : '⚠️'
        await log(`${mark} TC ${row.task}：${row.outcome}${row.error ? ` —— ${row.error}` : ''}`)
      }
      passed = results.filter((r: { outcome: string }) => r.outcome === 'pass').length
      failed = results.filter((r: { outcome: string }) => r.outcome === 'fail' || r.outcome === 'blocked').length
      skipped = results.filter((r: { outcome: string }) => r.outcome === 'unverified').length
      // ⚠️ **只送回寫用得到的欄位。** 完整的 results 帶著每一步的 trace 與
      //    base64 預覽，整包塞進 ws 訊息會大到離譜（而且沒有人要用）。
      sendEvent({
        kind: 'tc_results',
        results: results.map((row: Record<string, unknown>) => ({
          recordId: row.recordId, task: row.task, outcome: row.outcome,
          error: row.error, allShotPaths: row.allShotPaths,
        })),
      })
    } else {
    for (const [i, step] of steps.entries()) {
      if (!uatScriptRuns.get(runId)?.active) { await log('🛑 執行已中止'); break }
      const label = step.name ?? `步驟 ${i + 1}`
      const idx = `[${i + 1}/${steps.length}]`
      let stepAttempt = 0
      while (true) {
      try {
        // ⚠️ **積木的行為只有一份**（`uat-runner/frontend-engine.js`），伺服器端跑同一支。
        //    以前這裡跟伺服器各有一份對照表，然後就漂了——`find_baseline_scroll`
        //    只有伺服器端有，在這裡被靜默跳過，腳本照樣 PASS。
        await runFrontendStep(step, { ...engineHost, idx, label, state: netState })
        sendEvent({ kind: 'step_result', index: i, status: 'pass', message: label })
        passed++
        break
      } catch (err) {
        const errMsg = err instanceof Error ? err.message.split('\n')[0] : String(err)
        const retryLimit = Math.min(10, Math.max(0, Number(step.retryCount) || 1))
        if (step.failureMode === 'retry' && stepAttempt < retryLimit && !errMsg.includes('closed') && !errMsg.includes('Target crashed')) {
          stepAttempt++
          await log(`↻ ${idx} ${label}：第 ${stepAttempt}/${retryLimit} 次重試`)
          continue
        }
        await log(`❌ ${idx} ${label}：${errMsg}`)
        sendEvent({ kind: 'step_result', index: i, status: 'fail', message: errMsg })
        failed++
        const browserClosed = errMsg.includes('closed') || errMsg.includes('Target crashed')
        const effectiveFailureMode = step.failureMode === 'stop' || step.failureMode === 'continue' ? step.failureMode : failureMode
        if (effectiveFailureMode === 'stop' || browserClosed) {
          await log(browserClosed ? '🛑 瀏覽器已關閉，中止執行' : '🛑 失敗後停止')
          const active = uatScriptRuns.get(runId)
          if (active) active.active = false
        }
        break
      }
      }
      if (!uatScriptRuns.get(runId)?.active) break
    }
    }

    /**
     * 🚨 **跑完要把位子讓出來**（跟 PC 的 `pcBackToLobby` 同一件事，H5 一直沒做）。
     *
     * 一個帳號同時只能坐一台機台。停在 /game 就結束的話，下一輪重新載入會**直接掉回機台**，
     * 大廳積木全部命中 0——症狀長得像選擇器壞了，查起來完全不會想到是上一輪沒退出。
     * `goto` 積木那邊也有一道同樣的防線（給「上一輪直接被殺掉」的情況兜底），
     * 但**正常跑完就該自己收乾淨**，不要依賴下一輪來補。
     *
     * ⚠️ 退出失敗不改判定：這是收尾，不是被測的行為。但**一定要寫進 log**——
     *    默默失敗的話，下一輪那串莫名其妙的失敗就沒有線索可查。
     */
    if (h5InGame(page)) {
      const back = await h5BackToLobby(page, { log })
      await log(`${back.ok ? '🚪' : '⚠️'} 收尾：${back.ok ? '已退出機台、位子放掉' : '退出失敗，位子可能還佔著（下一輪可能會直接掉回機台）'}：${back.steps.join(' → ') || '(沒點到任何按鈕)'}`)
    }
    // 🚨 PC 同理（`h5InGame()` 只認 H5 的網址）——沒退出的話下一輪一載入就在 game 場景，
    //    「驗大廳」會當場 FAIL 並把那筆 TC 寫成失敗。實測踩過一次。
    if (platform === 'pc' && await pcSceneName(page).catch(() => '') === 'game') {
      const back = await pcBackToLobby(page)
      await log(`${back.ok ? '🚪' : '⚠️'} PC 收尾：${back.ok ? '已退出機台、位子放掉' : `退出失敗（場景=${back.scene}）`}：${back.steps.join(' → ') || '(沒點到任何按鈕)'}`)
    }

    const result = failed > 0 ? 'fail' : 'pass'
    await log(`─── 完成 ─── 通過 ${passed} ／ 失敗 ${failed} ／ 跳過 ${skipped}`)

    // 量測摘要在關瀏覽器之前產出：pinus 的最後一批訊息還在頁面端 buffer 裡，
    // 等到 finally 才 drain 的話 page 已經沒了，那批會整批遺失
    let netSummary: ReturnType<NonNullable<typeof netCapture>['summary']> | undefined
    let pinusSummary: ReturnType<NonNullable<typeof pinusProbe>['summary']> | undefined
    if (netCapture) {
      try { netSummary = netCapture.summary(); await log('\n' + netCapture.formatSummary()) } catch { /* 摘要失敗不影響判定 */ }
    }
    if (pinusProbe) {
      try {
        await pinusProbe.drain()
        const st = await pinusProbe.status()
        pinusSummary = pinusProbe.summary()
        if (st.present) await log('\n' + pinusProbe.formatSummary())
      } catch { /* 同上 */ }
    }
    if (statsTimer) { clearInterval(statsTimer); statsTimer = null }
    // 最後一份一定要送，否則面板停在倒數第二筆、跟日誌摘要對不起來
    sendEvent({ kind: 'stats', scope: 'frontend', net: netSummary, pinus: pinusSummary, final: true })
    sendEvent({ kind: 'done', passed, failed, skipped, result, netSummary, pinusSummary })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message.split('\n')[0] : String(err)
    await log(`❌ 執行器初始化失敗：${errMsg}`)
    sendEvent({ kind: 'done', passed, failed, skipped, result: 'fail' })
  } finally {
    if (pinusDrainTimer) clearInterval(pinusDrainTimer)
    if (statsTimer) clearInterval(statsTimer)
    // 看門狗要停掉——它抓著 page，不停的話瀏覽器關了還在戳一個死掉的 page
    try { stopPopupWatcher?.() } catch { /* 停不掉也不能影響收尾 */ }
    netCapture?.detach()
    await browser?.close().catch(() => {})
    if (chromeProc) {
      try {
        if (process.platform === 'win32' && chromeProc.pid) {
          spawn('taskkill', ['/F', '/T', '/PID', String(chromeProc.pid)], { stdio: 'ignore', shell: false })
        } else {
          chromeProc.kill('SIGTERM')
        }
      } catch {}
    }
    if (chromeProfileDir) { try { rmSync(chromeProfileDir, { recursive: true, force: true }) } catch {} }
    uatScriptRuns.delete(runId)
    console.log(`[Agent:${AGENT_LABEL}] UAT script run finished: ${runId}`)
  }
}

function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter(Boolean) as string[]
  return candidates.find(p => existsSync(p)) ?? (process.platform === 'win32' ? 'chrome.exe' : 'google-chrome')
}

async function waitForJson<T>(url: string, timeoutMs = 20_000): Promise<T> {
  const started = Date.now()
  let lastError: unknown
  while (Date.now() - started < timeoutMs) {
    // Try both localhost and 127.0.0.1 — Windows Chrome may bind to either
    for (const candidate of [url, url.replace('127.0.0.1', 'localhost')]) {
      try {
        const r = await fetch(candidate, { signal: AbortSignal.timeout(2000) })
        if (r.ok) return await r.json() as T
      } catch (error) { lastError = error }
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`Chrome DevTools not ready after ${timeoutMs}ms: ${lastError instanceof Error ? lastError.message : String(lastError ?? '')}`)
}

/**
 * H5/PC 錄製器。**跟伺服器模式共用同一份**（`uat-runner/frontend-recorder.js`）——
 * 兩邊各帶一份的時候已經漂掉了：這邊錄 `click`/`fill`、那邊錄 `click_viewport`/`type`，
 * 而 `fill` 在伺服器模式的執行引擎裡是「不支援的動作」，會被**跳過**而不是失敗。
 */
function recorderScript(sess?: UatRecSession) {
  return frontendRecorderScript({ theme: sess?.theme })
}

/**
 * 把 host 的權威狀態推給頁面內的控制面板。
 *
 * ⚠️ **每次注入之後都要呼叫一次。** 頁面端的新文件一律從「尚未同步」開始，
 *    不推的話面板會停在「同步中」而且**完全不收錄**——那是刻意的：
 *    預設成「在錄」的話，暫停之後導頁就會安靜地恢復錄製。
 */
function syncUatPanel(sess: UatRecSession) {
  if (!sess.cdpSend) return
  void syncRecorderPanel(sess.cdpSend, {
    paused: !!sess.paused,
    // ⚠️ 要加上 server 那側自己加的積木（截圖），否則面板的數字會比主畫面少
    steps: sess.steps.length + (sess.extraSteps ?? 0),
  })
}

/**
 * 結束這一輪錄製。**主畫面那顆停止與面板上那顆走同一支**——兩份實作一定會漂，
 * 而漂掉的症狀是「其中一邊停了但 session 沒收乾淨」。
 */
async function stopUatRecording(sess: UatRecSession, serverWs: WebSocket) {
  if (sess.done) return
  const steps = sess.steps
  // 最後一次回報要在 done 之前——flushUatCapture 看到 done 就直接 return，
  // 順序顛倒的話最後那幾秒（往往正是使用者關心的那段）會整段消失。
  await flushUatCapture(sess, serverWs)
  sess.done = true  // Set before kill so CDP WS-close handler won't trigger reconnect
  killUatSession(sess)
  uatRecSessions.delete(sess.sessionId)
  if (serverWs.readyState === serverWs.OPEN) {
    serverWs.send(JSON.stringify({ type: 'uat_record_event', sessionId: sess.sessionId, event: { kind: 'done', steps } }))
  }
}

/** 設暫停狀態，並把結果同時推給面板（回執）與 server（讓主畫面看到同一個狀態） */
function setUatPaused(sess: UatRecSession, paused: boolean, serverWs: WebSocket) {
  sess.paused = paused
  // ⚠️ 面板要收到這個回執才會顯示完成。先推回執再通知 server——
  //    按下去的人在瀏覽器那邊，他等的是這一則。
  syncUatPanel(sess)
  if (serverWs.readyState === serverWs.OPEN) {
    serverWs.send(JSON.stringify({ type: 'uat_record_event', sessionId: sess.sessionId, event: { kind: 'paused', paused } }))
  }
}

/** 頁面內控制面板送上來的指令 */
function handleUatPanelControl(sess: UatRecSession, msg: { cmd?: string }, serverWs: WebSocket) {
  if (msg?.cmd === 'stop') { void stopUatRecording(sess, serverWs); return }
  if (msg?.cmd === 'pause' || msg?.cmd === 'resume') setUatPaused(sess, msg.cmd === 'pause', serverWs)
}

function cropScript() {
  return `
(() => {
  if (window.__toppathCropInstalled) return;
  window.__toppathCropInstalled = true;
  window.__toppathStartCropMode = () => {
    const layer = document.createElement('div');
    layer.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,0.25);';
    document.body.appendChild(layer);
    let drawing = false, sx = 0, sy = 0;
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483648;border:2px solid #f59e0b;background:rgba(245,158,11,0.15);';
    document.body.appendChild(overlay);
    const draw = (e) => {
      const ex = e.clientX, ey = e.clientY;
      const x = Math.min(sx, ex), y = Math.min(sy, ey), w = Math.abs(ex - sx), h = Math.abs(ey - sy);
      overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483648;border:2px solid #f59e0b;background:rgba(245,158,11,0.15);left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px;';
      return { x, y, w, h };
    };
    const close = () => { layer.remove(); overlay.remove(); window.__toppathCropInstalled = false; delete window.__toppathStartCropMode; };
    layer.addEventListener('mousedown', event => { event.preventDefault(); event.stopPropagation(); drawing = true; sx = event.clientX; sy = event.clientY; }, true);
    layer.addEventListener('mousemove', event => { if (!drawing) return; event.preventDefault(); event.stopPropagation(); draw(event); }, true);
    layer.addEventListener('mouseup', event => {
      if (!drawing) return; event.preventDefault(); event.stopPropagation(); drawing = false;
      const box = draw(event); close();
      if (box.w >= 5 && box.h >= 5) console.info('__TOPPATH_CROP__', JSON.stringify(box));
    }, true);
  };
})();
`
}

function recordableWindowSize(width: number, height: number) {
  return {
    width: width + (process.platform === 'win32' ? 16 : 0),
    height: height + (process.platform === 'win32' ? 96 : 90),
  }
}

async function syncUatViewport(sess: UatRecSession) {
  if (!sess.cdpSend) return
  await sess.cdpSend('Emulation.setDeviceMetricsOverride', {
    width: sess.width,
    height: sess.height,
    deviceScaleFactor: 1,
    mobile: sess.platform === 'h5',
  })
  const size = await sess.cdpSend('Runtime.evaluate', {
    expression: '({ dw: Math.max(0, window.outerWidth - window.innerWidth), dh: Math.max(0, window.outerHeight - window.innerHeight) })',
    returnByValue: true,
  })
  const delta = size.result?.result as { value?: { dw?: number; dh?: number } } | undefined
  const bounds = await sess.cdpSend('Browser.getWindowForTarget')
  const windowId = (bounds.result as { windowId?: number } | undefined)?.windowId
  if (typeof windowId === 'number') {
    await sess.cdpSend('Browser.setWindowBounds', {
      windowId,
      bounds: {
        width: sess.width + Math.round(delta?.value?.dw ?? 0),
        height: sess.height + Math.round(delta?.value?.dh ?? 0),
      },
    })
  }
}

function killUatSession(sess: UatRecSession) {
  // ⚠️ 計時器一定要先收。不收的話錄製結束後它每 3 秒還會醒來一次，
  //    對著已經關掉的 CDP 連線送 Runtime.evaluate——而且 session 被 delete 之後
  //    沒有人再持有它，這個 interval 會**永遠跑下去**（agent 不重啟就不會停）。
  if (sess.captureTimer) { clearInterval(sess.captureTimer); sess.captureTimer = undefined }
  try { sess.ws?.close() } catch {}
  try {
    if (process.platform === 'win32' && sess.proc.pid) {
      spawn('taskkill', ['/F', '/T', '/PID', String(sess.proc.pid)], { stdio: 'ignore', shell: false })
    } else {
      sess.proc.kill('SIGTERM')
    }
  } catch {}
  try { rmSync(sess.profileDir, { recursive: true, force: true }) } catch {}
}

/**
 * 把攔截到的東西回報給 server。
 *
 * ⚠️ console **只送新增的那幾筆**（靠 consoleSent 記位置），不要每次整包重送——
 *    上限 500 筆、每 3 秒一次，整包重送等於每 3 秒把同一批資料再傳一遍。
 *    net／pinus 走 snapshot（本來就是統計過的固定大小），整包送沒問題。
 */
async function flushUatCapture(sess: UatRecSession, serverWs: WebSocket) {
  const capture = sess.capture
  if (!capture || sess.done) return
  try {
    await capture.drainPinus()
    const logs = capture.consoleLogs()
    const sentCount = sess.consoleSent ?? 0
    const appended = logs.slice(sentCount)
    sess.consoleSent = logs.length
    if (serverWs.readyState !== serverWs.OPEN) return
    serverWs.send(JSON.stringify({
      type: 'uat_record_event',
      sessionId: sess.sessionId,
      event: {
        kind: 'capture',
        stats: capture.snapshot(),
        consoleAppend: appended,
        consoleDropped: capture.consoleDropped(),
        pinusPatched: capture.pinusPatched(),
      },
    }))
  } catch { /* 量測回報失敗絕對不能影響錄製本身 */ }
}

function connectUatRecorder(sess: UatRecSession, port: number, serverWs: WebSocket) {
  // Try both 127.0.0.1 and localhost for Windows CDP binding differences
  const cdpBase = `http://127.0.0.1:${port}`

  void (async () => {
    let attempt = 0
    while (!sess.done && attempt < 3) {
      attempt++
      try {
        const targets = await waitForJson<Array<{ type: string; webSocketDebuggerUrl?: string }>>(`${cdpBase}/json/list`)
        const target = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl)
        if (!target?.webSocketDebuggerUrl) throw new Error('No Chrome page target found')

        const cdpUrl = target.webSocketDebuggerUrl.replace('127.0.0.1', 'localhost')
        const ws = new WebSocket(cdpUrl)
        sess.ws = ws
        let msgId = 0
        const pending = new Map<number, (v: CdpMessage) => void>()
        const send = (method: string, params?: object) => new Promise<CdpMessage>(resolve => {
          const reqId = ++msgId
          pending.set(reqId, resolve)
          ws.send(JSON.stringify({ id: reqId, method, params }))
        })
        sess.cdpSend = send

        await new Promise<void>((resolveConn, rejectConn) => {
          ws.on('open', async () => {
            console.log(`[Agent:${AGENT_LABEL}] CDP connected (attempt ${attempt})`)
            try {
              await send('Runtime.enable')
              await send('Page.enable')
              await syncUatViewport(sess)
              // ⚠️ **這兩行一定要帶 sess**（CodeX 2026-09-18 覆核指出）。漏傳的話注入的是
              //    預設主題，而且 `__toppathRecorderInstalled` 那道防重複會讓後面帶 sess 的
              //    重注入變成 no-op——修仙版的面板**永遠不會出現**，也不會有任何錯誤。
              await send('Page.addScriptToEvaluateOnNewDocument', { source: recorderScript(sess) + '\n' + cropScript() })
              await send('Runtime.evaluate', { expression: recorderScript(sess) + '\n' + cropScript() })
              syncUatPanel(sess)
              // console／network／pinus 攔截。⚠️ 掛不起來不能讓錄製失敗——
              // 使用者要的是錄操作，量測是附加價值，為了它整場錄不成是本末倒置。
              try {
                sess.capture = await attachCdpCapture(send, {
                  consoleMarkers: ['__TOPPATH_RECORDER__', '__TOPPATH_CROP__', FRONTEND_RECORDER_CONTROL_MARKER],
                })
                sess.captureTimer = setInterval(() => { void flushUatCapture(sess, serverWs) }, 3000)
              } catch (err) {
                console.error(`[Agent:${AGENT_LABEL}] CDP 攔截掛載失敗（錄製照常）:`, err instanceof Error ? err.message : err)
              }
              // 錄製器與攔截都掛好了才導頁。⚠️ 只導一次——下面的 close handler 會
              // 重連，重連時再導一次就變成無限重載。
              if (!sess.navigated && sess.startUrl) {
                sess.navigated = true
                await send('Page.navigate', { url: sess.startUrl })
              }
              resolveConn()
            } catch (e) { rejectConn(e) }
          })
          ws.on('error', rejectConn)
          ws.on('close', () => {
            // CDP WS closed (page reload or Chrome closed)
            if (!sess.done) {
              // Try to reconnect
              void connectUatRecorder(sess, port, serverWs)
            }
          })
          ws.on('message', raw => {
            try {
              const msg = JSON.parse(String(raw)) as { id?: number; method?: string; params?: { type?: string; args?: Array<{ value?: unknown }> } }
              if (msg.id && pending.has(msg.id)) { pending.get(msg.id)?.({ id: msg.id, result: (msg as Record<string, unknown>).result as Record<string, unknown> }); pending.delete(msg.id); return }
              if (msg.method === 'Runtime.consoleAPICalled') {
                const args = msg.params?.args ?? []
                // ⚠️ **暫停要在收事件的入口擋，不能只靠頁面自己不送。**
                //    頁面每次導頁都重新注入、而且新文件要等我們推狀態過去才知道自己
                //    是暫停的——那段空窗期的操作只有這裡擋得住。兩道都要有。
                if (args[0]?.value === '__TOPPATH_RECORDER__' && typeof args[1]?.value === 'string' && !sess.paused) {
                  try {
                    const step = JSON.parse(args[1].value as string)
                    sess.steps.push(step)
                    // 面板上的步數要跟 host 的清單一致（清單開頭有一顆 goto，
                    // 頁面自己數的話一定少一步）。
                    syncUatPanel(sess)
                    if (serverWs.readyState === serverWs.OPEN) {
                      serverWs.send(JSON.stringify({ type: 'uat_record_event', sessionId: sess.sessionId, event: { kind: 'step', step } }))
                    }
                  } catch {}
                }
                if (args[0]?.value === FRONTEND_RECORDER_CONTROL_MARKER && typeof args[1]?.value === 'string') {
                  try { handleUatPanelControl(sess, JSON.parse(args[1].value as string), serverWs) } catch {}
                }
                if (args[0]?.value === '__TOPPATH_CROP__' && typeof args[1]?.value === 'string') {
                  try { void handleAgentCrop(sess, JSON.parse(args[1].value as string), serverWs) } catch {}
                }
              }
              // ⚠️ 要在 DOMContentLoaded 就查一次，不能只等 load。
              //    load 跟「頁面已經可以點」在規範上是不同階段；只等 load 的話，
              //    使用者在那個窗口點下去的步驟會停在「尚未確認」（不會錯標，
              //    但白白少掉驗證）。宣告式 root 在解析完就都在了，這時查得到。
              if (msg.method === 'Page.domContentEventFired') {
                void flagShadowCompleteness(send)
                // 面板是在 DOMContentLoaded 才掛得上去的（注入時 document.body 還是 null），
                // 所以這裡也推一次——不然要等 load，慢圖的頁面會空等好幾秒。
                syncUatPanel(sess)
              }
              if (msg.method === 'Page.loadEventFired') {
                void syncUatViewport(sess)
                // 宣告式 closed shadow root 只有 CDP 看得到，所以每次載入完成查一次。
                // 查到就叫頁面停止宣稱「選擇器驗過」——理由見 frontend-recorder.js。
                void flagShadowCompleteness(send)
                void send('Runtime.evaluate', { expression: recorderScript(sess) })
                void send('Runtime.evaluate', { expression: cropScript() })
                // ⚠️ 重注入之後一定要再推一次狀態，否則導頁後面板永遠停在「同步中」
                //    而且什麼都不收——暫停跨導頁就是靠這一行才成立的。
                syncUatPanel(sess)
                // 換頁之後頁面端的 pinus 探針跟著新 document 重來，補打一次。
                // addScriptToEvaluateOnNewDocument 理論上已經涵蓋，但遊戲的
                // 熱更新不一定換 document，多打一次是冪等的（探針自己會擋重複）。
                void sess.capture?.reinject()
              }
              // ⚠️ 一定要放在上面那些之後：錄製器自己的標記訊息由 host 處理，
              //    capture 只負責「使用者的 console」與 network／pinus。
              //    順序反過來的話標記會先被當成一般 console 收走。
              sess.capture?.handle(msg as Record<string, unknown>)
            } catch {}
          })
        })

        // Connected successfully — stay connected (loop ends naturally when sess.done)
        return

      } catch (err) {
        console.error(`[Agent:${AGENT_LABEL}] UAT CDP connect attempt ${attempt} failed:`, err)
        if (attempt < 3 && !sess.done) {
          await new Promise(resolve => setTimeout(resolve, 3000))
        }
      }
    }

    // All attempts failed — notify server but DO NOT mark session done
    // Chrome is still running; user may need to manually stop/restart recording
    console.error(`[Agent:${AGENT_LABEL}] CDP connection failed after ${attempt} attempts — Chrome is open but recorder script unavailable`)
    if (serverWs.readyState === serverWs.OPEN) {
      serverWs.send(JSON.stringify({
        type: 'uat_record_event',
        sessionId: sess.sessionId,
        event: { kind: 'cdp_warn', message: `Chrome 已開啟但 CDP 連線失敗（嘗試 ${attempt} 次），步驟錄製無法使用，但可以手動截圖。` },
      }))
    }
  })()
}

async function handleAgentCrop(sess: UatRecSession, crop: { x: number; y: number; w: number; h: number }, serverWs: WebSocket) {
  const request = sess.cropRequest
  if (!request || !sess.cdpSend) return
  // ⚠️ **入口擋過還不夠**：使用者可能在框選途中才按暫停（框選是一段持續的操作）。
  //    完成回呼這裡再看一次，否則那張圖仍然會變成一顆積木。
  if (sess.paused) { sess.cropRequest = undefined; return }
  const cropX = Math.max(0, Math.round(crop.x))
  const cropY = Math.max(0, Math.round(crop.y))
  const cropW = Math.max(1, Math.round(crop.w))
  const cropH = Math.max(1, Math.round(crop.h))
  try {
    // ⚠️ 截圖前把面板藏起來。框選範圍剛好蓋到面板的話，面板會被拍進 baseline，
    //    而 baseline 是之後每次執行的比對基準——等於把一個只有錄製時才存在的
    //    東西寫進基準，之後永遠對不上，而且看起來像「畫面真的變了」。
    await setRecorderPanelVisible(sess.cdpSend, false)
    let shot
    // ⚠️ 一定要 finally 放回來。截圖失敗就把面板留在隱藏狀態的話，
    //    使用者會看到一個「沒有停止鈕」的錄製視窗——而且沒有任何錯誤訊息。
    try {
      shot = await sess.cdpSend('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        clip: { x: cropX, y: cropY, width: cropW, height: cropH, scale: 1 },
      })
    } finally {
      await setRecorderPanelVisible(sess.cdpSend, true)
    }
    // ⚠️ **截圖是一段 await，中途可能才被按暫停**（CodeX 2026-09-18 複驗指出）。
    //    前面那道只擋得住「按下去時已經是暫停」。判斷要貼著副作用（送出 crop_image），
    //    不是貼著入口——否則等截圖那幾百毫秒之間按暫停，積木照樣會長出來。
    if (sess.paused) { sess.cropRequest = undefined; return }
    const imageBase64 = shot.result?.data
    if (typeof imageBase64 !== 'string') return
    const id = randomUUID()
    if (serverWs.readyState === serverWs.OPEN) {
      serverWs.send(JSON.stringify({
        type: 'uat_record_event',
        sessionId: sess.sessionId,
        event: {
          kind: 'crop_image',
          id,
          imageBase64,
          name: request.name,
          x: cropX, y: cropY, w: cropW, h: cropH,
          threshold: request.threshold,
          platform: request.platform,
          scriptId: request.scriptId,
          createdBy: request.createdBy,
        },
      }))
    }
    sess.cropRequest = undefined
  } catch (err) {
    console.error(`[Agent:${AGENT_LABEL}] UAT crop error:`, err)
    sess.cropRequest = undefined
  }
}

/** Promise resolve for the pending claim_job → job_assigned/no_more_jobs round-trip */
let pendingClaimResolve: ((code: string | null) => void) | null = null

/** Live OSM machine status — updated in real-time by server pushes */
const currentOsmMap = new Map<string, number>()

function connect() {
  const url = `${CENTRAL_URL}/ws/agent`
  console.log(`[Agent:${AGENT_LABEL}] Connecting to ${url} ...`)
  const ws = new WebSocket(url)

  ws.on('open', async () => {
    console.log(`[Agent:${AGENT_LABEL}] Connected — ready`)
    // 每次連線都重算：可能是重連，而這期間 server 端的程式碼可能已經更新
    const bootHashes = await computeSourceHashes()
    // ⚠️ 只在第一次記下來。之後檔案被換掉這個值也不變——那正是
    //    「檔案是新的、但跑的還是舊的」的判斷依據；每次重連都更新就永遠測不出來。
    if (bootRestartHash === undefined) bootRestartHash = bootHashes?.restartScoped
    ws.send(JSON.stringify({
      type: 'agent_ready',
      agentId: AGENT_ID,
      hostname: AGENT_LABEL,
      operatorKey: AGENT_OWNER_KEY,
      operatorName: AGENT_OWNER_NAME,
      agentToken: AGENT_TOKEN,
      capabilities: AGENT_CAPABILITIES,
      version: AGENT_VERSION,
      sourceHash: bootHashes?.all,
      bootRestartHash,
      sourceDiff: bootHashes?.diff,
      sourceVersion: readSourceVersion(),
    }))
  })

  ws.on('message', async (raw) => {
    let msg: IncomingMessage
    try { msg = JSON.parse(raw.toString()) } catch { return }

    // ── Server response: next machine to test ──────────────────────────────────
    // ── Live OSM status push from server ──────────────────────────────────────
    if (msg.type === 'osm_status_update') {
      const updates = (msg as { type: 'osm_status_update'; updates: { machineId: string; status: number }[] }).updates
      if (Array.isArray(updates)) {
        for (const { machineId, status } of updates) {
          currentOsmMap.set(machineId, status)
        }
      }
      return
    }

    if (msg.type === 'job_assigned') {
      pendingClaimResolve?.((msg as { type: 'job_assigned'; machineCode: string }).machineCode)
      pendingClaimResolve = null
      return
    }

    if (msg.type === 'no_more_jobs') {
      pendingClaimResolve?.(null)
      pendingClaimResolve = null
      return
    }

    // ── Stop: kill current runner immediately ─────────────────────────────────
    if (msg.type === 'stop') {
      console.log(`[Agent:${AGENT_LABEL}] Stop requested`)
      currentRunner?.stop()
      if (autospinChild) {
        try { autospinChild.kill('SIGTERM') } catch { /* ignore */ }
      }
      // Abort any pending claim
      pendingClaimResolve?.(null)
      pendingClaimResolve = null
      return
    }

    // ── AutoSpin: spawn the local Python engine (toppath-agent.py) ─────────────
    // 引擎不變，仍透過 REST(/api/autospin/agent/*) 與伺服器溝通；本 agent 只負責
    // 在被派工時啟動它、停止時關閉它，並在結束時回報 agent_done 釋放此 agent。
    if (msg.type === 'autospin_start') {
      const startMsg = msg as AutoSpinStartMessage
      const { sessionId, userLabel } = startMsg

      if (autospinChild) {
        try { autospinChild.kill('SIGTERM') } catch { /* ignore */ }
        autospinChild = null
      }

      const httpBase = CENTRAL_URL.replace(/^wss?/, (s) => (s.includes('wss') ? 'https' : 'http'))
      const scriptPath = join(process.cwd(), 'server', 'python', 'toppath-agent.py')
      if (!existsSync(scriptPath)) {
        console.error(`[Agent:${AGENT_LABEL}] AutoSpin script not found: ${scriptPath}`)
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'agent_done', sessionId }))
        return
      }
      const uriArg = `toppath-agent://?server=${encodeURIComponent(httpBase)}&user=${encodeURIComponent(userLabel ?? '')}`
      console.log(`[Agent:${AGENT_LABEL}] AutoSpin start → ${PYTHON_EXE} ${scriptPath} (server=${httpBase}, user=${userLabel || '(none)'})`)
      const child = spawn(PYTHON_EXE, [scriptPath, uriArg], {
        cwd: join(process.cwd(), 'server', 'python'),
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
      })
      autospinChild = child
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (c: string) => { for (const l of c.split('\n').filter(Boolean)) console.log(`[AutoSpin] ${l}`) })
      child.stderr?.on('data', (c: string) => { for (const l of c.split('\n').filter(Boolean)) console.error(`[AutoSpin][stderr] ${l}`) })
      child.on('close', (code) => {
        console.log(`[Agent:${AGENT_LABEL}] AutoSpin process exited (code ${code})`)
        if (autospinChild === child) autospinChild = null
        // Stop poller when AutoSpin ends
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'agent_done', sessionId }))
      })
      child.on('error', (err) => {
        console.error(`[Agent:${AGENT_LABEL}] AutoSpin spawn error:`, err)
        if (autospinChild === child) autospinChild = null
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'agent_done', sessionId }))
      })

      // ── Spawn LuckyLink poller if requested ──────────────────────────────────
      // LuckyLink JP 比對已於 2026-09-08 移除——獎池監控改由對帳台的 L4/L5 負責。
      // ⚠️ `jp_groups` 資料表與後端資料刻意保留：對帳台之後要擴到 UAT/PROD 時
      //    還需要那些網址與憑證，重建成本比留著高。

      return
    }

    // ── Update source files from server ──────────────────────────────────────
    // ── Backend UAT：在 agent 端 spawn Playwright 腳本，log 逐行轉回 server ──
    if (msg.type === 'backend_uat_start') {
      const startMsg = msg as BackendUatStartMessage
      const { sessionId, larkAppToken, larkTableId, filter, dashGameType, dashClientVersion, credEnv } = startMsg

      // 上一輪還沒收乾淨就先砍掉，避免兩個 Chromium 同時搶同一組帳號
      if (backendUatChild) {
        try { backendUatChild.kill('SIGTERM') } catch { /* ignore */ }
        backendUatChild = null
      }

      const scriptDir = join(process.cwd(), 'server', 'uat-runner')
      const scriptPath = join(scriptDir, 'run-lark-tc-backend.js')
      if (!existsSync(scriptPath)) {
        const message = `找不到 UAT 腳本：${scriptPath}（請在 Local Agent 頁面按「更新程式碼」重新下載）`
        console.error(`[Agent:${AGENT_LABEL}] ${message}`)
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'backend_uat_done', sessionId, exitCode: null, error: message }))
        }
        return
      }

      backendUatSessionId = sessionId
      // 密碼只留在記憶體給 redaction 用，不寫檔、不印 console
      backendUatSecrets = [credEnv?.UAT_CP_PASSWORD, credEnv?.UAT_NCH_PASSWORD]
        .filter((v): v is string => typeof v === 'string' && v.length > 0)

      const sendLog = (line: string, stream: 'stdout' | 'stderr') => {
        if (ws.readyState !== ws.OPEN) return
        ws.send(JSON.stringify({ type: 'backend_uat_log', sessionId, line: redactBackendUatLine(line), stream }))
      }

      console.log(`[Agent:${AGENT_LABEL}] Backend UAT session ${sessionId} start → ${scriptPath}`)
      const args = [scriptPath]
      if (filter) args.push(filter)

      const runnerEnv = { ...(credEnv ?? {}) }
      // 「上傳檔案」積木的素材存在 server，runner 用 id + 這一輪的票去 HTTP 取。
      // ⚠️ 素材**不隨派工訊息一起送**：單檔上限 20MB，塞進 env/WS 會把它撐爆，
      //    而且同一個素材被多個步驟引用時會被複製好幾份。
      runnerEnv.UAT_ASSET_BASE = CENTRAL_URL.replace(/^wss?/, (m) => (m.includes('wss') ? 'https' : 'http'))
      const multiPayload = runnerEnv.UAT_MULTI_SCRIPT
      if (multiPayload) { delete runnerEnv.UAT_MULTI_SCRIPT; runnerEnv.UAT_MULTI_SCRIPT_STDIN = '1' }
      const child = spawn(process.execPath, args, {
        cwd: scriptDir, // 腳本用相對路徑讀 ./tc-registry.json 與 ./config/*，cwd 一定要是它自己的目錄
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          LARK_APP_TOKEN: larkAppToken,
          LARK_TABLE_ID: larkTableId,
          ...(dashGameType ? { DASH_GAME_TYPE: dashGameType } : {}),
          ...(dashClientVersion ? { DASH_CLIENT_VERSION: dashClientVersion } : {}),
          ...runnerEnv,
        },
        windowsHide: true,
      })
      child.stdin?.on('error', () => { /* child may fail before reading */ })
      child.stdin?.end(multiPayload || '')
      backendUatChild = child

      if (child.stdout) createInterface({ input: child.stdout }).on('line', line => { if (line.trim()) sendLog(line, 'stdout') })
      if (child.stderr) createInterface({ input: child.stderr }).on('line', line => { if (line.trim()) sendLog(line, 'stderr') })
      child.on('close', (code) => {
        console.log(`[Agent:${AGENT_LABEL}] Backend UAT ${sessionId} exited (code ${code})`)
        if (backendUatChild === child) { backendUatChild = null; backendUatSessionId = null; backendUatSecrets = [] }
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'backend_uat_done', sessionId, exitCode: code }))
        }
      })
      child.on('error', (err) => {
        console.error(`[Agent:${AGENT_LABEL}] Backend UAT spawn error:`, err.message)
        if (backendUatChild === child) { backendUatChild = null; backendUatSessionId = null; backendUatSecrets = [] }
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'backend_uat_done', sessionId, exitCode: null, error: err.message }))
        }
      })
      return
    }

    if (msg.type === 'backend_record_start') {
      const m = msg as BackendRecordStartMessage
      // 上一輪沒收乾淨就先關掉，不然螢幕上會留一堆錄製視窗
      if (backendRecordBrowser) {
        try { await backendRecordBrowser.close() } catch { /* ignore */ }
        backendRecordBrowser = null
      }
      const finish = (error?: string) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'backend_record_done', sessionId: m.sessionId, error: error ?? null }))
        }
      }
      try {
        const pw = await import('playwright')
        // headless: false —— 錄製本來就是要讓人在畫面上操作
        const browser = await pw.chromium.launch({ headless: false, args: ['--start-maximized'] })
        backendRecordBrowser = browser
        backendRecordSessionId = m.sessionId
        const ctx = await browser.newContext({ viewport: null })
        const page = await ctx.newPage()
        // 錄製腳本要在頁面自己的程式碼之前跑，才不會漏掉早期事件
        await ctx.addInitScript(m.recorderScript)
        page.on('console', message => {
          const text = message.text()
          if (ws.readyState !== ws.OPEN) return
          // 頁面裡那顆「停止錄製」。要比 marker 先判：兩個前綴刻意設計成互不為前綴
          // （見 backend-recorder.js 的說明），但順序放前面才不會依賴那個約定。
          // ⚠️ m.stopMarker 沒有值時什麼都不做——絕不能退回用 m.marker 比對，
          //    那會讓每一顆正常積木都被當成停止訊號。
          if (m.stopMarker && text.startsWith(m.stopMarker)) {
            void stopBackendRecording(ws, m.sessionId)
            return
          }
          if (text.startsWith(m.marker)) {
            const payload = text.slice(m.marker.length).trim()
            ws.send(JSON.stringify({ type: 'backend_record_event', sessionId: m.sessionId, payload }))
            // 錄製當下就驗一次這條 selector 能不能命中（不擋錄製）。
            // 拿到結果的時間點可能已經換頁，那種情況會回 unknown、不下判斷。
            void (async () => {
              try {
                const check = await verifyRecordedSelectorLive(page, JSON.parse(payload))
                if (check && ws.readyState === ws.OPEN) {
                  ws.send(JSON.stringify({ type: 'backend_record_verify', sessionId: m.sessionId, check }))
                }
              } catch { /* 驗證失敗絕對不能影響錄製 */ }
            })()
            return
          }
          const loc = message.location()
          ws.send(JSON.stringify({
            type: 'backend_record_console',
            sessionId: m.sessionId,
            entry: {
              type: message.type(),
              text: text.slice(0, 800),
              location: loc?.url ? `${loc.url}:${loc.lineNumber ?? 0}` : '',
              ts: Date.now(),
            },
          }))
        })
        page.on('pageerror', error => {
          if (ws.readyState !== ws.OPEN) return
          ws.send(JSON.stringify({
            type: 'backend_record_console',
            sessionId: m.sessionId,
            entry: { type: 'pageerror', text: error.message.slice(0, 800), ts: Date.now() },
          }))
        })
        page.on('websocket', socket => {
          const sendFrame = (direction: 'sent' | 'received' | 'open' | 'close', payload?: string | Buffer) => {
            if (ws.readyState !== ws.OPEN) return
            ws.send(JSON.stringify({
              type: 'backend_record_ws',
              sessionId: m.sessionId,
              frame: {
                direction,
                url: socket.url(),
                payload: payload === undefined ? '' : redactRecordedPayload(payload),
                ts: Date.now(),
              },
            }))
          }
          sendFrame('open')
          socket.on('framesent', event => sendFrame('sent', event.payload))
          socket.on('framereceived', event => sendFrame('received', event.payload))
          socket.on('close', () => sendFrame('close'))
        })
        // 使用者自己把視窗關掉也要收尾，不然 server 會一直等
        page.on('close', () => { finish() })

        await page.goto(`${m.backendUrl}/login`, { waitUntil: 'networkidle', timeout: 30000 })
        await page.fill('input[type="text"], input[name*="user"], input[id*="user"]', m.username).catch(() => {})
        await page.fill('input[type="password"]', m.password).catch(() => {})
        await page.keyboard.press('Enter').catch(() => {})
        await page.waitForTimeout(2500)
        // Backend runner 會在登入後清掉站台層級的 Warning；錄製也必須從同一個畫面狀態開始。
        // 這類 dialog 若留著，使用者看到的是遮罩後的選單，錄下來的第一步卻可能是底下的
        // Game Setting；試跑時 Playwright 就會因 .el-dialog__wrapper 攔截點擊而逾時。
        await page.evaluate(() => {
          let found = false
          document.querySelectorAll<HTMLElement>('.el-dialog__wrapper').forEach(el => {
            if (/Warnning|Warning/i.test(el.textContent || '')) {
              el.style.display = 'none'
              found = true
            }
          })
          if (found) {
            const overlay = document.querySelector<HTMLElement>('.v-modal')
            if (overlay) overlay.style.display = 'none'
          }
        }).catch(() => {})
        // 登入完成之後才開始收。在這之前輸入的是我們自己打的帳密，
        // 錄進去等於把真實密碼寫成測試步驟（實測時真的錄到過）。
        await page.evaluate(() => (window as unknown as { __toppathArmRecorder?: () => void }).__toppathArmRecorder?.()).catch(() => {})
        page.on('domcontentloaded', () => {
          void page.evaluate(() => (window as unknown as { __toppathArmRecorder?: () => void }).__toppathArmRecorder?.()).catch(() => {})
        })
        // 回一個確認：沒有這個，server 分不出「agent 版本太舊沒接到」跟「正在錄但使用者還沒操作」
        // ——兩者在畫面上都是「停止錄製（0 顆）」，完全一樣
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'backend_record_ready', sessionId: m.sessionId }))
        }
        /**
         * 錄製期間把網路請求也回報上去。
         *
         * 錄製只錄得到 DOM 操作，但使用者要決定「這一步該下什麼 pass/fail」時，最需要
         * 知道的其實是它打了哪些後端。看不到 API 的話，錄出來的斷言只能停在「畫面上
         * 有這個字」那一層——而很多成功／失敗根本不在 DOM，在 API 有沒有送出、回什麼碼。
         *
         * API 明細供「一鍵變斷言」使用；圖檔與其他資源則供網速監控使用。
         * server 只保留最後一段，避免長時間錄製把 WS 與 status payload 洗爆。
         */
        page.on('requestfinished', request => {
          void (async () => {
            try {
              const type = request.resourceType()
              const response = await request.response().catch(() => null)
              const timing = request.timing()
              const durationMs = timing && timing.responseEnd > 0
                ? Math.round(timing.responseEnd - timing.startTime)
                : null
              if (ws.readyState !== ws.OPEN) return
              ws.send(JSON.stringify({
                type: 'backend_record_net',
                sessionId: m.sessionId,
                call: {
                  method: request.method(),
                  url: request.url(),
                  // 之後要「把這筆變成斷言」時是拿 pattern 去比對：錄下來的是當下那一次的
                  // 網址，裡面常有 id／token／時間戳，直接當條件的話換一筆資料就全紅。
                  // 原始網址一起留著，pattern 是額外欄位不是取代（CodeX review 要求）
                  urlPattern: toUrlPattern(request.url()),
                  status: response ? response.status() : null,
                  durationMs,
                  kind: backendRecordKind(type),
                  resourceType: type,
                  ts: Date.now(),
                },
              }))
            } catch { /* 單一筆抓不到不要影響錄製本身 */ }
          })()
        })
        page.on('requestfailed', request => {
          try {
            if (ws.readyState !== ws.OPEN) return
            const type = request.resourceType()
            ws.send(JSON.stringify({
              type: 'backend_record_net',
              sessionId: m.sessionId,
              call: {
                method: request.method(),
                url: request.url(),
                urlPattern: toUrlPattern(request.url()),
                status: null,
                durationMs: null,
                kind: backendRecordKind(type),
                resourceType: type,
                failure: request.failure()?.errorText ?? 'request failed',
                ts: Date.now(),
              },
            }))
          } catch { /* 單一筆抓不到不要影響錄製本身 */ }
        })

        console.log(`[Agent:${AGENT_LABEL}] 後台錄製 ${m.sessionId} 已開始（瀏覽器在這台機器上）`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[Agent:${AGENT_LABEL}] 後台錄製啟動失敗: ${message}`)
        backendRecordBrowser = null
        finish(message)
      }
      return
    }

    if (msg.type === 'backend_record_stop') {
      const { sessionId } = msg as { type: 'backend_record_stop'; sessionId: string }
      await stopBackendRecording(ws, sessionId)
      return
    }

    if (msg.type === 'backend_uat_stop') {
      const { sessionId } = msg as { type: 'backend_uat_stop'; sessionId: string }
      // sessionId 對不上代表是上一輪的殘留指令，不能拿來砍現在正在跑的那一輪
      if (backendUatChild && backendUatSessionId === sessionId) {
        console.log(`[Agent:${AGENT_LABEL}] Backend UAT ${sessionId} stop requested`)
        const dying = backendUatChild
        try { dying.kill('SIGTERM') } catch { /* ignore */ }
        // SIGTERM 之後一定要留一手：腳本可能正卡在某個長等待（單筆 TC 可以跑好幾
        // 分鐘），或訊號被某個函式庫攔走。沒有這個升級，「停止」就會變成「看起來
        // 停了但其實還在跑」——使用者實際踩過。
        setTimeout(() => {
          if (dying.exitCode === null && dying.signalCode === null) {
            console.log(`[Agent:${AGENT_LABEL}] Backend UAT ${sessionId} 沒有在 8 秒內結束，改用 SIGKILL`)
            try { dying.kill('SIGKILL') } catch { /* ignore */ }
          }
        }, 8000).unref?.()
        // 不在這裡送 done——child 的 close handler 會送，才拿得到真正的 exit code
      } else if (ws.readyState === ws.OPEN) {
        // 已經結束了，補一則 done 讓 server 不會卡在 running
        ws.send(JSON.stringify({ type: 'backend_uat_done', sessionId, exitCode: null }))
      }
      return
    }

    if (msg.type === 'update_sources') {
      const upd = msg as { type: 'update_sources'; files?: string[]; contents?: { file: string; content: string; hash: string }[] }
      const files = upd.files ?? []
      // 內容直接跟著這則 WS 訊息來，就不用再用 HTTP 回頭下載一次。
      // HTTP 那條路在正式站會把大檔截斷（HTTP 200、寫檔成功，但內容少一截），
      // 而這條 WS 連線傳同樣的內容一直是好的（錄製腳本就是這樣送的）。
      const pushed = new Map((upd.contents ?? []).map(c => [c.file, c]))
      console.log(`[Agent:${AGENT_LABEL}] Updating ${files.length} source files from server`)
      const baseUrl = CENTRAL_URL.replace(/^wss?/, (s) => s.includes('wss') ? 'https' : 'http')
      const results: { file: string; ok: boolean; error?: string }[] = []
      // ⚠️ 下載完一定要**先驗內容再寫檔**。
      //    2026-09-16 實際踩到：Spug 那邊送過來的檔案在傳輸途中變短了
      //    （run-lark-tc-backend.js 少 868 字、backend-recorder.js 少 4936 字），
      //    而 HTTP 是 200、寫檔也成功，所以一路顯示「更新成功」。
      //    **被寫進去的是一個被截斷的 runner**——那比更新失敗危險得多：
      //    它會在之後某次執行時以看不懂的方式壞掉，而沒有人會聯想到是更新造成的。
      let wantPerFile: Record<string, string> = {}
      try {
        const mf0 = await fetch(`${baseUrl}/api/machine-test/agent/source-manifest`).then(r => r.json()) as { perFile?: Record<string, string> }
        wantPerFile = mf0.perFile ?? {}
      } catch { wantPerFile = {} }
      for (const file of files) {
        try {
          let content: string
          const fromWs = pushed.get(file)
          if (fromWs) {
            content = fromWs.content
          } else {
            // 舊版 server 不會推內容，退回原本的 HTTP 下載
            const resp = await fetch(`${baseUrl}/api/machine-test/agent/source/${file}`)
            if (!resp.ok) { results.push({ file, ok: false, error: `HTTP ${resp.status}` }); continue }
            content = await resp.text()
          }          // 驗不過就不要寫。沒有期望值時（舊 server）才照舊寫進去——
          // 不能因為拿不到期望值就整個更新不動。
          const want = pushed.get(file)?.hash ?? wantPerFile[file]
          if (want && hashOne(content) !== want) {
            results.push({ file, ok: false, error: `下載到的內容跟伺服器對不上（收到 ${content.length} 字，指紋 ${hashOne(content).slice(0, 8)}，期望 ${want.slice(0, 8)}）——沒有寫入，避免留下被截斷的檔案` })
            console.error(`[Agent:${AGENT_LABEL}]   ✗ ${file}: 內容不完整，已略過寫入`)
            continue
          }
          const parts = file.split('/')
          const targetDir = join(process.cwd(), 'server', ...parts.slice(0, -1))
          const targetPath = join(process.cwd(), 'server', ...parts)
          mkdirSync(targetDir, { recursive: true })
          writeFileSync(targetPath, content, 'utf8')
          results.push({ file, ok: true })
          console.log(`[Agent:${AGENT_LABEL}]   ✓ ${file}`)
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err)
          results.push({ file, ok: false, error })
          console.error(`[Agent:${AGENT_LABEL}]   ✗ ${file}: ${error}`)
        }
      }
      const allOk = results.length > 0 && results.every(r => r.ok)
      // 更新完要回報新指紋，不然畫面上還是顯示落後，使用者會以為沒生效而重按。
      // ⚠️ bootRestartHash 刻意不更新——那個要重啟才會變，它正是「檔案新了但跑的是舊的」
      //    的判斷依據；在這裡跟著更新的話「需要重啟」就永遠不會被偵測到。
      const after = await computeSourceHashes()
      // 更新成功才記版本——部分失敗時記下去會宣稱自己是新版，實際上不是
      if (allOk) {
        try {
          const baseUrl2 = CENTRAL_URL.replace(/^wss?/, (m) => m.includes('wss') ? 'https' : 'http')
          const mf = await fetch(`${baseUrl2}/api/machine-test/agent/source-manifest`).then(r => r.json()) as { serverVersion?: string | null }
          writeSourceVersion(mf.serverVersion)
        } catch { /* 拿不到版本不影響更新本身 */ }
      }
      // ⚠️ 「每個檔案都寫成功」跟「寫完之後內容跟伺服器一致」是兩件事。
      //    只回報寫入結果的話，會出現「更新成功」但指紋照樣對不上，
      //    使用者只能反覆按更新——實際發生過。寫完立刻回報還差哪幾個。
      const stillDiff = after?.diff ?? []
      // ⚠️ 「寫完還是不一致」只講得出「有問題」，講不出是**哪一層**有問題。
      //    重新抓一次那個檔，湊出三個數字就能直接切開：
      //      磁碟 ≠ 重抓 ≠ 期望 → 伺服器每次送的內容都不一樣
      //      磁碟 = 重抓 ≠ 期望 → 伺服器「算指紋」跟「送檔案」讀到的東西不同
      //      磁碟 ≠ 重抓 = 期望 → 寫檔／讀檔這段把內容弄壞了
      //    不這樣做的話只能靠猜，而使用者已經反覆按了很多次更新（實際發生）。
      const probes: string[] = []
      for (const rel of stillDiff.slice(0, 5)) {
        try {
          const baseUrl3 = CENTRAL_URL.replace(/^wss?/, (m) => m.includes('wss') ? 'https' : 'http')
          const mf2 = await fetch(`${baseUrl3}/api/machine-test/agent/source-manifest`).then(r => r.json()) as { perFile?: Record<string, string> }
          const fresh = await fetch(`${baseUrl3}/api/machine-test/agent/source/${rel}`).then(r => r.text())
          let onDisk = ''
          try { onDisk = readFileSync(join(process.cwd(), 'server', ...rel.split('/')), 'utf8') } catch { onDisk = '' }
          probes.push(`${rel}｜磁碟 ${hashOne(onDisk).slice(0, 8)}｜重抓 ${hashOne(fresh).slice(0, 8)}｜期望 ${(mf2.perFile?.[rel] ?? '?').slice(0, 8)}｜長度 磁碟${onDisk.length}/重抓${fresh.length}`)
        } catch (e) {
          probes.push(`${rel}｜重抓失敗：${e instanceof Error ? e.message : String(e)}`)
        }
      }
      if (probes.length) console.error('[Agent:' + AGENT_LABEL + '] 不一致診斷：\n  ' + probes.join('\n  '))
      ws.send(JSON.stringify({ type: 'sources_updated', ok: allOk, results, stillDiff, probes, sourceHash: after?.all, sourceDiff: after?.diff, sourceVersion: readSourceVersion() }))
      const needRestart = after && bootRestartHash !== undefined && after.restartScoped !== bootRestartHash
      console.log(`[Agent:${AGENT_LABEL}] Source update ${allOk ? 'succeeded' : 'failed (partial)'}.`
        + (needRestart ? ' ⚠️ 有需要重啟才生效的檔案被更新，請重開 agent。' : ' 這批檔案下次執行就會生效，不用重啟。'))
      return
    }

    // ── Session join: start claim-loop for the given session ──────────────────
    if (msg.type === 'scripted_bet_start') {
      const { sessionId, accounts, config } = msg as ScriptedBetStartMessage
      console.log(`[Agent:${AGENT_LABEL}] Scripted Bet session ${sessionId} started (${accounts.length} accounts)`)
      const runner = new ScriptedBetRunner(sessionId, accounts, config)
      currentRunner = runner

      runner.on('event', (ev: ScriptedBetEvent) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'scripted_bet_event', sessionId, event: ev }))
        }
      })

      runner.run()
        .catch(err => {
          console.error(`[Agent:${AGENT_LABEL}] Scripted Bet ${sessionId} error:`, err)
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({
              type: 'scripted_bet_event',
              sessionId,
              event: {
                type: 'error',
                sessionId,
                status: 'stopped',
                message: String(err),
                ts: new Date().toISOString(),
              } satisfies ScriptedBetEvent,
            }))
          }
        })
        .finally(() => {
          if (currentRunner === runner) currentRunner = null
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'scripted_bet_done', sessionId }))
          }
        })
      return
    }

    // ── UAT Recording ────────────────────────────────────────────────────────────
    if (msg.type === 'uat_record_start') {
      const { sessionId, url, resolution, platform = 'h5', theme } = msg as UatRecordStartMessage
      const [w, h] = resolution.split('x')
      const width = Number(w) || 390
      const height = Number(h) || 844
      const initialWindow = recordableWindowSize(width, height)
      const profileDir = join(tmpdir(), `toppath-uat-${sessionId}`)
      clearStaleDebugPort(profileDir)
      const args = [
        DEBUG_PORT_ARG,
        `--user-data-dir=${profileDir}`,
        '--no-first-run', '--no-default-browser-check', '--new-window',
        `--window-size=${initialWindow.width},${initialWindow.height}`,
        // ⚠️ **先開 about:blank，不要直接開目標網址。** 直接開的話 Chrome 會一邊
        //    載入頁面、我們一邊才去連 CDP 注入錄製器——「注入一定早於頁面程式碼」
        //    這個前提不成立。後果不只漏錄早期事件：頁面在注入前建立的
        //    **closed shadow root** 我們永遠追蹤不到，那些元素會被錯標成「已驗證」。
        //    （CodeX 2026-09-18 複驗指出。）注入與攔截都掛好之後才 Page.navigate。
        'about:blank',
      ]
      const proc = spawn(chromeExecutable(), args, { stdio: 'ignore', shell: false, windowsHide: false })
      const sess: UatRecSession = {
        sessionId, proc, profileDir, done: false,
        width, height, platform, startUrl: url, paused: false, theme,
        steps: [{ name: '前往頁面', action: 'goto', value: url }],
      }
      uatRecSessions.set(sessionId, sess)
      // Chrome 自己挑的 port，從它的 profile 目錄讀回來——保證是這一顆
      const port = await waitForDebugPort(profileDir, { isAlive: () => proc.exitCode === null })
      proc.on('close', () => {
        // 使用者直接把錄製視窗關掉也走這裡。CDP 已經斷了，最後一次 flush 沒有意義，
        // 但計時器一定要收——否則它會對著死掉的連線永遠跑下去。
        if (sess.captureTimer) { clearInterval(sess.captureTimer); sess.captureTimer = undefined }
        sess.done = true
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'uat_record_event', sessionId, event: { kind: 'done', steps: sess.steps } }))
        }
        uatRecSessions.delete(sessionId)
      })
      connectUatRecorder(sess, port, ws)
      console.log(`[Agent:${AGENT_LABEL}] UAT record started: ${sessionId}`)
      return
    }

    if (msg.type === 'uat_record_crop') {
      const { sessionId, scriptId, platform, name, threshold, createdBy } = msg as UatRecordCropMessage
      const sess = uatRecSessions.get(sessionId)
      if (!sess || !sess.cdpSend) return
      // ⚠️ 暫停的定義是「不新增積木」，**截圖積木也算**（CodeX 定的語意）。
      //    不擋的話暫停中框一張圖照樣長出一顆 find_baseline_scroll。
      if (sess.paused) return
      sess.cropRequest = { scriptId, platform, name, threshold, createdBy }
      void sess.cdpSend('Runtime.evaluate', { expression: 'window.__toppathStartCropMode && window.__toppathStartCropMode()' })
      return
    }

    if (msg.type === 'uat_record_stop') {
      const { sessionId } = msg as UatRecordStopMessage
      const sess = uatRecSessions.get(sessionId)
      if (!sess) return
      await stopUatRecording(sess, ws)
      console.log(`[Agent:${AGENT_LABEL}] UAT record stopped: ${sessionId}`)
      return
    }

    if (msg.type === 'uat_record_extra_step') {
      const { sessionId } = msg as { type: string; sessionId: string }
      const sess = uatRecSessions.get(sessionId)
      if (!sess) return
      sess.extraSteps = (sess.extraSteps ?? 0) + 1
      syncUatPanel(sess)
      return
    }

    if (msg.type === 'uat_record_pause') {
      const { sessionId, paused } = msg as UatRecordPauseMessage
      const sess = uatRecSessions.get(sessionId)
      if (!sess) return
      setUatPaused(sess, !!paused, ws)
      return
    }

    if (msg.type === 'uat_script_run') {
      const scriptMsg = msg as UatScriptRunMessage
      uatScriptRuns.set(scriptMsg.runId, { active: true })
      void runUatScript(scriptMsg, ws)
      return
    }

    if (msg.type === 'uat_script_stop') {
      const { runId } = msg as { type: string; runId: string }
      const run = uatScriptRuns.get(runId)
      if (run) run.active = false
      return
    }

    if (msg.type === 'ui_screenshot_scan') {
      const scanMsg = msg as UiScreenshotScanMessage
      console.log(`[Agent:${AGENT_LABEL}] UI Screenshot 掃大廳 ${scanMsg.scanId}`)
      void runUiScreenshotScan(scanMsg, CENTRAL_URL.replace(/^ws/, 'http'))
      return
    }

    if (msg.type === 'ui_screenshot_start') {
      const { run: runConfig } = msg as UiScreenshotStartMessage
      console.log(`[Agent:${AGENT_LABEL}] UI Screenshot run ${runConfig.id} started (${runConfig.tasks.length} tasks)`)
      void runUiScreenshot(runConfig, CENTRAL_URL.replace(/^ws/, 'http'))
      return
    }

    if (msg.type === 'ui_screenshot_stop') {
      const { sessionId } = msg as { type: string; sessionId: string }
      const ctrl = uiScreenshotRuns.get(sessionId)
      if (ctrl) ctrl.stopped = true
      return
    }

    if (msg.type === 'session_join') {
      const { sessionId, session, profiles, betRandomConfig, osmMachineStatus, geminiKey, ollamaBaseUrl, ollamaModel } = msg as SessionJoinMessage

      // Configure AI/runtime env vars
      if (geminiKey) process.env.GEMINI_API_KEY = geminiKey
      if (ollamaBaseUrl) process.env.OLLAMA_BASE_URL = ollamaBaseUrl
      if (ollamaModel) process.env.OLLAMA_MODEL = ollamaModel
      if (session.cctvModelSpec) process.env.CCTV_MODEL_SPEC = session.cctvModelSpec
      else delete process.env.CCTV_MODEL_SPEC

      // Seed the module-level osmMap with the session snapshot; live updates will keep it current
      currentOsmMap.clear()
      for (const [k, v] of osmMachineStatus) currentOsmMap.set(k, v)
      const profileMap = new Map<string, MachineProfile>(profiles.map(p => [p.machineType, p]))

      console.log(`[Agent:${AGENT_LABEL}] Joined session ${sessionId} — starting claim-loop`)

      const runClaimLoop = async () => {
        while (true) {
          // Request the next available machine from the central queue
          const code = await new Promise<string | null>((resolve) => {
            pendingClaimResolve = resolve
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: 'claim_job', sessionId }))
            } else {
              resolve(null)
            }
          })

          if (!code) break  // no_more_jobs or WS closed

          console.log(`[Agent:${AGENT_LABEL}] Claimed machine: ${code}`)
          let failed = false

          try {
            // Create a fresh runner for each machine (avoids stale state)
            const runner = new MachineTestRunner(currentOsmMap, profileMap, betRandomConfig)
            currentRunner = runner

            runner.on('event', (ev: TestEvent) => {
              // Filter out session lifecycle events — central server manages these directly
              if (ev.type === 'session_done') return   // server emits unified session_done
              if (ev.type === 'session_start') return  // each machine run() sends one; would clear viewer results
              if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type: 'event', sessionId, event: ev }))
              }
            })

            // Agent always runs headless — ignore headedMode from main UI
            await runner.run({ ...session, sessionId, machineCodes: [code], headedMode: session.headedMode === true })
          } catch (err) {
            console.error(`[Agent:${AGENT_LABEL}] Machine ${code} error:`, err)
            failed = true
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({
                type: 'event',
                sessionId,
                event: {
                  type: 'error',
                  message: `機台 ${code} 執行錯誤：${String(err)}`,
                  ts: new Date().toISOString(),
                } as TestEvent,
              }))
            }
          } finally {
            currentRunner = null
          }

          // Report this machine's result to the central queue
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'job_done', sessionId, machineCode: code, failed }))
          }
        }

        // Claim-loop exhausted — signal done and release agent slot
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'agent_done', sessionId }))
        }
        console.log(`[Agent:${AGENT_LABEL}] No more jobs — session ${sessionId} complete`)
      }

      runClaimLoop().catch(err => {
        console.error(`[Agent:${AGENT_LABEL}] Claim loop error:`, err)
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'agent_done', sessionId }))
        }
      })
    }
  })

  ws.on('close', (code, reason) => {
    const detail = reason.toString().trim()
    console.log(`[Agent:${AGENT_LABEL}] Disconnected (code=${code}${detail ? `, reason=${detail}` : ''}), reconnecting in 5s ...`)
    currentRunner = null
    // Abort any in-flight claim
    pendingClaimResolve?.(null)
    pendingClaimResolve = null
    setTimeout(connect, 5000)
  })

  ws.on('error', (err) => {
    console.error(`[Agent:${AGENT_LABEL}] WS error:`, err.message)
  })
}

connect()
