// 機台自動化測試：整批一鍵流程（Discord `/machine-test` 背後的腳本）
//
//   node machine-test-batch.mjs --sheet "<Lark 試算表網址（含 ?sheet=）>" [--machines 0069-0078|0069,0071|892-X-0001,...]
//        [--steps all|entry,spin,exit] [--dry-run] [--no-trial] [--no-writeback] [--no-report] [--learn]
//   --learn：限單台，跑完整八項（iDeck 真下注），學到的寫進機種 profile、不回寫 Lark；規則見 learnProfile()
//   node machine-test-batch.mjs --retry-writeback <summary.json>     只重試 Lark 回寫，不重跑機台
//
// 流程（2026-09-24 DragonLaw 十台實戰後收斂；規則細節見 skill osm-machine-test、knowledge/h5-client-interaction.md）：
//   1. 讀 Lark：E 欄 gmid（機台代碼）＝主鍵，用它對回列號，不用順序推
//   2. 開跑前檢查：機台配置、OSMWatcher 監控清單、agent 在線且閒置、帳號在大廳
//      （--dry-run 到這裡為止，而且**完全唯讀**：不起 agent、不退座位、不回寫）
//   3. 清殘留座位：只有在中控沒有 session、agent 閒置時才做；要看到本次 leaveGMNtc errcode=0 且回到大廳才算清掉
//   4. 單台試跑「進入＋退出」，通過才跑整批（--no-trial 可略過）
//   5. 整批一個 session（工具會確認回到大廳才換下一台），**先 start 再接事件串流**
//   6. 每台一完成就回寫 Lark F～J，進度即時落地到 summary.json（中斷後可 --retry-writeback）
//   7. 產 HTML 報告
//
// J 欄（QA確認狀態）三分法——不確定就不填，並把舊值清掉，避免留下上一輪的判定：
//   驗證未過：任一硬性 FAIL（進入／推流／Spin／音頻／iDeck／觸屏／CCTV／退出）或退出受阻停批
//   驗證通過：全部八項都有跑、每項 PASS 或 WARN（WARN＝只記錄）；觸屏若因機種沒設定 touchPoints 而未驗，
//            不列入必驗項（在 F 欄註明），其餘不得有未驗
//   不填：只跑部分測項、有「待確認」（CCTV 編號不符、退出未確認）、「已在遊戲內」（結果不可信）、沒收到結果
//
// 輸出：reports/machine-test-<sessionId>/{summary.json, report.html}，最後一行印 `SUMMARY <path>`

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import WebSocket from 'ws'
import { chromium } from 'playwright'

// ── 設定 ──────────────────────────────────────────────────────────────────────
// fileURLToPath：路徑有空白（Toppath tools）時 URL.pathname 會變成 %20
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
// 1005 搬進 Toppath Tools repo：程式在 scripts/machine-test/，資料（config／knowledge／reports／data）留在 osm-qa-agent、不進 git
const ROOT = process.env.MT_HOME ?? path.resolve(SCRIPT_DIR, '..', '..', '..', 'osm-qa-agent')
// 密碼／金鑰不進 git：環境變數優先，否則讀 <MT_HOME>/config/machine-test-secrets.json
const SECRETS = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'machine-test-secrets.json'), 'utf8')) } catch { return {} } })()
const secret = (env, key) => process.env[env] ?? SECRETS[key] ?? ''
const CFG = {
  central: process.env.MT_CENTRAL ?? 'https://eric.osmslot.org',
  email: process.env.MT_EMAIL ?? 'eric.wu@toppath.tw',
  loginPin: secret('MT_LOGIN_PIN', 'loginPin'),
  adminPin: secret('MT_ADMIN_PIN', 'adminPin'),
  agentDir: process.env.MT_AGENT_DIR ?? 'C:\\machine-test-agent-claude',
  agentLabel: process.env.MT_AGENT_LABEL ?? 'CLAUDE-LOCAL',
  lobbyFile: process.env.MT_LOBBY_FILE ?? path.join(ROOT, 'config', 'machine-test-lobby-url.txt'),
  osmEnv: process.env.MT_OSM_ENV ?? 'prod',
  larkApp: secret('MT_LARK_APP_ID', 'larkApp'), larkSecret: secret('MT_LARK_APP_SECRET', 'larkSecret'),
  larkApi: process.env.MT_LARK_API ?? 'https://open.larksuite.com/open-apis', larkHost: 'https://casinoplus.sg.larksuite.com',
}
const SAVES = path.join(CFG.agentDir, 'server', 'machine-test')
const ALL_STEPS = ['entry', 'stream', 'spin', 'audio', 'ideck', 'touchscreen', 'cctv', 'exit']
export const STEP_ZH = { '進入機台': '進入', '推流檢測': '推流', 'Spin 測試': 'Spin', '音頻檢測': '音頻', 'iDeck 測試': 'iDeck', '觸屏測試': '觸屏', 'CCTV 號碼比對': 'CCTV', '退出測試': '退出' }

const log = (...a) => console.log(`[${new Date().toTimeString().slice(0, 8)}]`, ...a)
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── Lark ─────────────────────────────────────────────────────────────────────
// ⚠️ 0930：原本 token 抓一次用到底 → 整批跑 1.5 小時，中途過期，0266 之後每台回寫都 99991663。
//    Lark 回的是「目前這把 token＋剩餘秒數」（不一定是全新 2 小時），所以要記到期時間、快到期就換；
//    收到 token 無效的錯誤碼也強制換一次再重送。
let larkTok = null, larkTokExp = 0
async function larkRefresh() {
  const t = await (await fetch(`${CFG.larkApi}/auth/v3/tenant_access_token/internal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: CFG.larkApp, app_secret: CFG.larkSecret }),
  })).json()
  // 換到的東西要驗：code 非 0、沒 token、expire 不是正數 → 直接丟錯，不要帶著壞 token 繼續寫
  if (t?.code !== 0 || !t.tenant_access_token || !(t.expire > 0)) throw new Error(`取得 Lark tenant token 失敗：code=${t?.code} msg=${t?.msg}`)
  larkTok = t.tenant_access_token
  larkTokExp = Date.now() + t.expire * 1000
}
// 只有 tenant token 相關的碼才換（99991663＝tenant token 無效、99991661＝沒帶 token）；99991668 是 user token，跟我們無關
const LARK_BAD_TOKEN = new Set([99991661, 99991663])
async function lark(pathname, opts = {}) {
  if (!larkTok || Date.now() > larkTokExp - 10 * 60 * 1000) await larkRefresh()
  let refreshed = false   // 跟網路重試分開記：第一次網路失敗、第二次才遇到過期，也要能換
  for (let k = 1; k <= 4; k++) {
    try {
      const r = await fetch(`${CFG.larkApi}${pathname}`, { ...opts, headers: { Authorization: `Bearer ${larkTok}`, ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers ?? {}) } })
      const j = await r.json()
      if (LARK_BAD_TOKEN.has(j?.code) && !refreshed) { refreshed = true; await larkRefresh(); continue }
      return j   // 換過還是失敗 → 原樣回傳，呼叫端看得到原始錯誤
    } catch (e) { if (k === 4) throw e; await sleep(1500 * k) }
  }
  throw new Error(`Lark 請求重試用盡（換過 token 後沒有機會再送）：${pathname}`)
}
function parseSheetUrl(u) {
  const token = u.match(/\/sheets\/([A-Za-z0-9]+)/)?.[1]
  const sid = new URL(u).searchParams.get('sheet')
  if (!token || !sid) throw new Error('Lark 網址要包含 /sheets/<token>?sheet=<分頁ID>')
  return { token, sid }
}
async function readSheet({ token, sid }) {
  const r = await lark(`/sheets/v2/spreadsheets/${token}/values/${sid}!A1:P400?valueRenderOption=ToString`)
  if (r.code !== 0) throw new Error(`讀取 Lark 失敗：${r.msg}`)
  const vals = r.data.valueRange.values
  const header = (vals[0] ?? []).map(v => String(v ?? '').trim())
  const find = re => header.findIndex(h => re.test(h))
  const cols = { gmid: find(/^gmid$/i), F: find(/QA問題回報/), G: find(/推流截圖/), H: find(/CCTV.*(截圖|圖)|(截圖|圖).*CCTV/), I: find(/音檔/), J: find(/QA確認狀態/) }
  // 1003：只有 gmid 是必要的；不同分頁欄位不一樣（vcvvJd 沒有推流截圖／CCTV／音檔欄），沒有的欄位回寫時跳過（n/a）
  if (cols.gmid < 0) throw new Error(`Lark 表頭找不到 gmid 欄（表頭：${header.join(' | ')}）`)
  const L = i => String.fromCharCode(65 + i)
  const letters = Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, v >= 0 ? L(v) : null]))
  const missing = Object.entries(cols).filter(([, v]) => v < 0).map(([k]) => k)
  if (missing.length) console.log(`（這個分頁沒有 ${missing.join('、')} 欄，回寫時跳過）`)
  const rows = []
  vals.forEach((row, i) => {
    const code = String(row?.[cols.gmid] ?? '').trim()
    // 渠道號可能是 3 或 4 位（UAT CP 是 4186），2026-09-24 SquidGame 表因此一列都讀不到
    if (/^\d{3,4}-[A-Z0-9 ]+-\d{3,5}$/i.test(code)) rows.push({ row: i + 1, code, F: cols.F >= 0 ? row[cols.F] : null, I: cols.I >= 0 ? row[cols.I] : null, J: cols.J >= 0 ? row[cols.J] : null })
  })
  return { letters, rows }
}
function pickMachines(rows, spec) {
  if (!spec || /^(full|all)$/i.test(spec.trim())) return rows   // 0929 使用者用 machines=full 表示整張表
  // 0930 使用者：machines=failed 只重跑沒通過的——J＝驗證未過或 J 空白（沒填的也要）；
  // F 是 spin no response（實體按鈕壞）預設跳過，現場修好後用 failed+spin 才一起跑（避免再下注、又卡在 feature 把帳號卡住）
  const fm = spec.trim().match(/^failed(\+spin)?$/i)
  if (fm) return rows.filter(r => {
    const J = String(r.J ?? '').replace(/^null$/, '').trim(), F = String(r.F ?? '').replace(/^null$/, '').trim()
    if (J === '驗證通過') return false
    if (!fm[1] && /spin no response/i.test(F)) return false
    return true
  })
  const want = new Set()
  for (const part of spec.split(',').map(s => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)-(\d+)$/)
    if (m) { for (let n = +m[1]; n <= +m[2]; n++) want.add(String(n).padStart(m[1].length, '0')) }
    else want.add(part)
  }
  return rows.filter(r => want.has(r.code) || want.has(r.code.split('-').pop()))
}
async function putCell({ token, sid }, cell, value) {
  const r = await lark(`/sheets/v2/spreadsheets/${token}/values`, { method: 'PUT', body: JSON.stringify({ valueRange: { range: `${sid}!${cell}:${cell}`, values: [[value]] } }) })
  if (r.code !== 0) throw new Error(`寫 ${cell} 失敗：${r.msg}`)
  return 0
}
async function putImage({ token, sid }, cell, file) {
  const buf = fs.readFileSync(file)
  const r = await lark(`/sheets/v2/spreadsheets/${token}/values_image`, { method: 'POST', body: JSON.stringify({ range: `${sid}!${cell}:${cell}`, image: Array.from(buf), name: path.basename(file) }) })
  if (r.code !== 0) throw new Error(`貼圖 ${cell} 失敗：${r.msg}`)
  return 0
}
/** 上傳到 Lark Drive 並開 tenant_readable；> 20MB 走分片（upload_all 會 5xx） */
async function uploadDrive(file) {
  const buf = fs.readFileSync(file), name = path.basename(file)
  let ft
  if (buf.length <= 20 * 1024 * 1024) {
    const fd = new FormData()
    fd.append('file_name', name); fd.append('parent_type', 'explorer'); fd.append('parent_node', ''); fd.append('size', String(buf.length))
    fd.append('file', new Blob([buf]), name)
    const r = await lark('/drive/v1/files/upload_all', { method: 'POST', body: fd })
    if (r.code !== 0) throw new Error('upload_all ' + JSON.stringify(r).slice(0, 120))
    ft = r.data.file_token
  } else {
    const prep = await lark('/drive/v1/files/upload_prepare', { method: 'POST', body: JSON.stringify({ file_name: name, parent_type: 'explorer', parent_node: '', size: buf.length }) })
    if (prep.code !== 0) throw new Error('upload_prepare ' + JSON.stringify(prep).slice(0, 120))
    const { upload_id, block_size, block_num } = prep.data
    for (let i = 0; i < block_num; i++) {
      const chunk = buf.subarray(i * block_size, Math.min((i + 1) * block_size, buf.length))
      const fd = new FormData()
      fd.append('upload_id', upload_id); fd.append('seq', String(i)); fd.append('size', String(chunk.length)); fd.append('file', new Blob([chunk]), 'part')
      const r = await lark('/drive/v1/files/upload_part', { method: 'POST', body: fd })
      if (r.code !== 0) throw new Error(`upload_part ${i} ` + JSON.stringify(r).slice(0, 120))
    }
    const fin = await lark('/drive/v1/files/upload_finish', { method: 'POST', body: JSON.stringify({ upload_id, block_num }) })
    if (fin.code !== 0) throw new Error('upload_finish ' + JSON.stringify(fin).slice(0, 120))
    ft = fin.data.file_token
  }
  await lark(`/drive/v1/permissions/${ft}/public?type=file`, { method: 'PATCH', body: JSON.stringify({ link_share_entity: 'tenant_readable' }) })
  return { url: `${CFG.larkHost}/file/${ft}`, mb: buf.length / 1048576 }
}

// ── 中控 ──────────────────────────────────────────────────────────────────────
let cookie = ''
async function central(p, opts = {}) {
  const r = await fetch(`${CFG.central}${p}`, { ...opts, headers: { cookie, ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers ?? {}) } })
  const txt = await r.text()
  try { return { status: r.status, json: JSON.parse(txt), txt } } catch { return { status: r.status, json: null, txt } }
}
// 1005 使用者：每次跑都重新登入 → 中控每次多一個 7 天的 session（Dashboard「登入 Session」累積到 274 組）。
// 改成沿用上次的 cookie（存在 data/，/api/auth/me 驗過還有效就不登入），失效才重新登入並覆寫。
const SESSION_FILE = path.join(ROOT, 'data', 'toppath-central-session.txt')
export async function login() {
  try {
    const saved = fs.readFileSync(SESSION_FILE, 'utf8').trim()
    if (saved) {
      const me = await fetch(`${CFG.central}/api/auth/me`, { headers: { cookie: saved } })
      const j = me.ok ? await me.json().catch(() => null) : null
      if (j?.authenticated && j.account?.email === CFG.email) { cookie = saved; return }
    }
  } catch { /* 沒有存檔或讀不到 → 重新登入 */ }
  const r = await fetch(`${CFG.central}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: CFG.email, pin: CFG.loginPin }) })
  if (!r.ok) throw new Error(`中控登入失敗 ${r.status}`)
  cookie = (r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie')]).map(c => c.split(';')[0]).join('; ')
  try { fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true }); fs.writeFileSync(SESSION_FILE, cookie) } catch { /* 存不了就下次再登入 */ }
}
const status = async () => (await central('/api/machine-test/status')).json
const myAgent = st => (st?.agents ?? []).find(a => String(a.agentId).startsWith(CFG.agentLabel + '_')) ?? null
// 1005 使用者：每次啟動都重新下載 install.bat → 每次都發一把新的 Local Agent token（10/03 一天累積 25 把）。
// 改成沿用存下來的 token；連不上（例如被撤銷）才換新的並覆寫。
const AGENT_TOKEN_FILE = path.join(ROOT, 'data', 'machine-test-agent-token.txt')
function spawnAgent(token) {
  const out = fs.openSync(path.join(CFG.agentDir, 'agent-claude.out.log'), 'w')
  const child = spawn('cmd.exe', ['/c', 'npx tsx server/agent-runner.ts'], {
    cwd: CFG.agentDir, detached: true, stdio: ['ignore', out, out], windowsHide: true,
    env: { ...process.env, CENTRAL_URL: CFG.central, AGENT_TOKEN: token, AGENT_OWNER_KEY: CFG.email, AGENT_LABEL: CFG.agentLabel },
  })
  child.unref()
  return child
}
async function waitAgent(tries) {
  for (let i = 0; i < tries; i++) { await sleep(3000); const a = myAgent(await status()); if (a) return a }
  return null
}
export async function startAgent() {
  log('本機 agent 不在線，啟動中...')
  let saved = ''
  try { saved = fs.readFileSync(AGENT_TOKEN_FILE, 'utf8').trim() } catch { /* 沒存過 */ }
  if (saved) {
    const child = spawnAgent(saved)
    const a = await waitAgent(15)
    if (a) return a
    // 存的 token 連不上（多半是被撤銷）：收掉這個程序再換新 token
    log('存的 agent token 連不上，改領新的')
    try { execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' }) } catch { /* 已經結束 */ }
  }
  const bat = (await central('/api/machine-test/agent/install.bat')).txt
  const token = bat.match(/AGENT_TOKEN=([^\s\r]+)/)?.[1]
  if (!token) throw new Error('拿不到 agent token（install.bat 內沒有 AGENT_TOKEN）')
  try { fs.mkdirSync(path.dirname(AGENT_TOKEN_FILE), { recursive: true }); fs.writeFileSync(AGENT_TOKEN_FILE, token) } catch { /* 存不了就下次再領 */ }
  spawnAgent(token)
  const a = await waitAgent(30)
  if (a) return a
  throw new Error('本機 agent 啟動後 90 秒仍未上線，請看 agent-claude.out.log')
}

// ── 帳號是否坐在機台上 ─────────────────────────────────────────────────────────
// readOnly：只看不動（dry-run）。清座位要看到本次 leaveGMNtc errcode=0 且回到大廳。
async function checkLobby(lobbyUrl, readOnly) {
  const browser = await chromium.launch({ headless: false, args: ['--window-position=-32000,-32000'] })
  try {
    const page = await browser.newPage({ viewport: { width: 430, height: 900 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' })
    const leaves = []
    page.on('websocket', ws => ws.on('framereceived', f => {
      const s = typeof f.payload === 'string' ? f.payload : Buffer.from(f.payload).toString('latin1')
      const m = s.match(/leaveGMNtc[\s\S]{0,300}?errcode"?\s*:\s*(\d+)/)
      if (m) leaves.push({ errcode: Number(m[1]), at: Date.now() })
    }))
    await page.goto(lobbyUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(15000)
    const inGame = () => page.frames().some(f => /\/game\b/.test(f.url()))
    if (!inGame()) return { ok: true, seated: false, note: '帳號在大廳' }
    if (readOnly) return { ok: false, seated: true, note: '帳號目前坐在機台上（dry-run 不處理；正式執行時會先自動退出）' }
    for (let k = 0; k < 3 && inGame(); k++) {
      const t0 = Date.now()
      await page.mouse.click(404, 30)                       // 右上 Quit
      await page.waitForTimeout(2500)
      const ex = page.getByText('Exit To Lobby', { exact: true })
      if (await ex.count()) await ex.first().click().catch(() => {})
      await page.waitForTimeout(3000)
      const cf = page.getByText('Confirm', { exact: true })  // Cash out credit／cannot be quit／other device
      if (await cf.count() && await cf.first().isVisible()) await cf.first().click().catch(() => {})
      await page.waitForTimeout(8000)
      const leave = leaves.filter(l => l.at >= t0).at(-1)
      if (leave && leave.errcode !== 0 && leave.errcode !== 10002) {
        return { ok: false, seated: true, note: `清殘留座位時 leaveGMNtc errcode=${leave.errcode}（可能 AFT／Handpay），停止，請人工處理` }
      }
      if (!inGame() && leave?.errcode === 0) return { ok: true, seated: false, note: '帳號原本坐在機台上，已退回大廳（leaveGMNtc errcode=0）' }
    }
    return { ok: false, seated: true, note: inGame() ? '帳號坐在機台上，自動退出三次仍未離開（可能遊戲進行中），請人工處理' : '畫面回到大廳但沒收到 leaveGMNtc errcode=0，無法確認已離機，請人工確認' }
  } finally { await browser.close() }
}

// ── 判讀 ──────────────────────────────────────────────────────────────────────
// 狀態：pass／warn／fail／na（未驗）／check（待人工確認）
// runner stepSpin 的訊息：「3 次 Spin 已點擊，但餘額未變化（…）」
const SPIN_NO_ROUND = /Spin 已點擊，但餘額未變化/
// 音頻關鍵字只看「｜問題:」後面那段：0930 runner 在訊息中段加了「Media：… 未靜音: 0」，整句比對會把「未靜音」當成「靜音」→ 0337 誤判 no sound
// 舊訊息沒有「問題:」段就退回整句（相容 0930 之前的結果，當時沒有 Media 段）
const audioIssues = m => { const s = String(m ?? ''); const i = s.indexOf('問題:'); return i >= 0 ? s.slice(i) : s.replace(/Media：[^｜]*/g, '') }
// Spin 沒開局 → 音頻錄到的不是 Spin 的聲音（0266：上一輪錄到靜音被判 no sound，重跑錄到 -17.7 dB），音頻結果不採用
// CodeX 0930：「沒開局」要有兩個證據——餘額沒變，且（有記錄的話）moneyNtc begin 0 次；runner 註記「選單狀態未知」時不能排除選單干擾
// → 這兩種例外都改判 Spin 未驗（classify 'na'），不寫 spin no response。舊訊息沒有「開局訊號」段 → 只靠餘額（相容 0930 前的結果）
const spinBegins = m => { const x = String(m ?? '').match(/開局訊號 moneyNtc begin (\d+) 次/); return x ? Number(x[1]) : null }
const spinDoubtful = m => (spinBegins(m) ?? 0) > 0 || /選單狀態未知/.test(String(m ?? ''))
const isNoRoundStep = s => s.step === 'Spin 測試' && s.status === 'warn' && SPIN_NO_ROUND.test(String(s.message ?? '')) && !spinDoubtful(s.message)
const spinNoRound = steps => (steps ?? []).some(isNoRoundStep)
// 0930：runner 的 Spin 前選單閘門——機台停在選面額選單、點觸屏也關不掉 → Spin 沒按（skip），觸屏判 no response。
// 這時 Spin 錄音一樣沒東西，音頻跟「沒開局」同樣改看整段錄音。
const spinGateSkipped = steps => (steps ?? []).some(s => s.step === 'Spin 測試' && s.status === 'skip' && /選面額選單/.test(String(s.message ?? '')))
// 音頻改看整段錄音的條件：只要 Spin 沒開局（不論是確定的 spin no response，還是「選單狀態未知／有 begin 但餘額沒變」這種存疑的）
// 或被閘門擋下沒按——Spin 那段錄音都不是 Spin 的聲音。0930 JJBXGRAND 0338：選單一直沒關、Spin 判未驗，但音頻還拿 Spin 錄音寫了 low sound
// 10-01 0342：Spin 訊息也可能是「無法讀取餘額」（額度還在轉入），但開局訊號 0 次＝一樣沒轉 → 一樣改看整段錄音
const spinDidNotRound = steps => (steps ?? []).some(s => s.step === 'Spin 測試' && s.status === 'warn' && (SPIN_NO_ROUND.test(String(s.message ?? '')) || spinBegins(s.message) === 0))
const audioFromSession = steps => spinDidNotRound(steps) || spinGateSkipped(steps)
// 整段錄音判「沒聲音」的前提：這段期間真的有局在跑（Spin 的開局訊號 > 0，或 iDeck 開局顆數 > 0）。
// 0338：機台選單一直沒關、Spin 和 iDeck 一局都沒開，整段安靜只代表「沒在玩」，不能寫 no sound。舊結果沒有這兩個數字 → 不判（保守）
const ideckRounds = steps => { const m = String((steps ?? []).find(s => s.step === 'iDeck 測試')?.message ?? '').match(/iDeck 開局 (\d+) 顆/); return m ? Number(m[1]) : null }
const sessionSaysNoSound = result => {
  if (result?.sessionAudio?.silent !== true) return false
  const sp = (result.steps ?? []).find(s => s.step === 'Spin 測試')
  return (spinBegins(sp?.message) ?? 0) > 0 || (ideckRounds(result.steps) ?? 0) > 0
}
// 0930 使用者：Spin 沒開局時，改看「整段錄音」（進機台→退出，含 iDeck 下注開局的聲音）判有沒有聲音。
// 只判 no sound、不判 low sound（整段錄音的音量門檻沒校準）。實測分佈是兩群、中間沒有灰色地帶：
//   有聲 30~50 秒 > -50 dB（0250/0262/0264/0266/0267/0268）；靜音整段 RMS -96.7、0 秒 > -50 dB（0243/0261/0275）。
// 判定：錄音 ≥ 30 秒且沒有任何 1 秒窗 > -50 dB → 靜音。檔案沒有／太短 → null（不判）。
export function sessionAudioStats(file) {
  try {
    if (!file || !fs.existsSync(file)) return null
    const b = fs.readFileSync(file)
    let p = 12, fmt = null, data = null
    while (p + 8 <= b.length) {
      const id = b.toString('ascii', p, p + 4), sz = b.readUInt32LE(p + 4)
      if (id === 'fmt ') fmt = { ch: b.readUInt16LE(p + 10), rate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) }
      if (id === 'data') { data = b.subarray(p + 8, p + 8 + sz); break }
      p += 8 + sz + (sz & 1)
    }
    if (!fmt || !data || fmt.bits !== 16) return null
    const win = fmt.rate * fmt.ch, n = Math.floor(data.length / 2)
    let ws = 0, wn = 0, secs = 0, loudSec = 0
    for (let i = 0; i < n; i++) {
      const v = data.readInt16LE(i * 2) / 32768
      ws += v * v; wn++
      if (wn === win) { secs++; if (10 * Math.log10(ws / wn || 1e-12) > -50) loudSec++; ws = 0; wn = 0 }
    }
    return secs >= 30 ? { secs, loudSec, silent: loudSec === 0 } : null
  } catch { return null }
}
export function classify(step) {
  const m = String(step.message ?? '')
  if (step.status === 'skip') return 'na'
  if (step.step === '觸屏測試' && step.status === 'fail' && /未設定 touchPoints/.test(m)) return 'na'
  if (step.step === 'CCTV 號碼比對' && /影像編號不符/.test(m)) return 'check'
  // 1004：CCTV 構圖兩次判讀不一致 → 待人工確認（Claude 看 cctv-saves 原圖後用 --set-cctv 之類的方式補判），J 不填
  if (step.step === 'CCTV 號碼比對' && /構圖待人工確認/.test(m)) return 'check'
  // 0929 使用者：沒有 CCTV 畫面（容器在但沒 video）也算驗證未過，不能只是 WARN（F 欄寫 no cctv）
  if (step.step === 'CCTV 號碼比對' && step.status === 'warn' && /找不到 video/.test(m)) return 'fail'
  // 0929 使用者：no sound（靜音）、low sound（音量偏低／偏小）都判未過；音色偏亮這類仍只記錄
  if (step.step === '音頻檢測' && step.status === 'warn' && /靜音|音量偏低|音量偏小/.test(audioIssues(m))) return 'fail'
  // 0930 使用者（0266）：按了 SPIN、盒子也收到，但沒開局（餘額沒變）＝spin no response，驗證未過（原本只是 WARN，J 會判通過）
  if (step.step === 'Spin 測試' && step.status === 'warn' && SPIN_NO_ROUND.test(m)) return spinDoubtful(m) ? 'na' : 'fail'
  // 10-01 0342：「無法讀取餘額，無法確認是否執行」＝Spin 沒驗到（原本只是 WARN，整台可能被判通過）
  if (step.step === 'Spin 測試' && step.status === 'warn' && /無法讀取餘額/.test(m)) return 'na'
  // runner 的兩種說法：「無法確認已轉出／離機」（大廳可見但沒收到 leaveGMNtc）、「未確認已離機」（使用者中止）
  if (step.step === '退出測試' && /未確認|無法確認/.test(m) && !/🛑/.test(m)) return 'check'
  return step.status
}
// ── 機種專屬判定規則（1005 使用者：「這是這個遊戲的特殊處理，不放共同規則」）───────────────
// 來源 knowledge/games/<機種>/automation/batch-rules.json（只給 batch 判定用，不同步到 agent）。
// 目前規則：ideckNoRoundIsNoResponse —— iDeck 每顆伺服器都有回應、但「iDeck 開局 0 顆」→ 改判 ideck no response。
//   ARUZE（FLCL）：PLAY xx Credits 本身就是開局鍵，0323 現場確認按了都不轉；其他機種的 iDeck 多半只是調面額／倍數，沒開局是正常的。
const gameRulesCache = new Map()
export function gameRules(type) {
  if (!type) return {}
  if (!gameRulesCache.has(type)) {
    let r = {}
    try { r = JSON.parse(fs.readFileSync(path.join(gameDir(type), 'batch-rules.json'), 'utf8')) } catch { /* 沒有就是沒有規則 */ }
    gameRulesCache.set(type, r)
  }
  return gameRulesCache.get(type)
}
export function applyGameRules(result) {
  const type = String(result?.machineCode ?? '').split('-')[1]?.toUpperCase()
  const rules = gameRules(type)
  if (!Array.isArray(result?.steps) || !(rules.ideckNoRoundIsNoResponse || rules.noMenuGate)) return result
  return {
    ...result,
    steps: result.steps.map(s => {
      const m = String(s.message ?? '')
      if (rules.ideckNoRoundIsNoResponse && s.step === 'iDeck 測試' && (s.status === 'pass' || s.status === 'warn') && /iDeck 開局 0 顆/.test(m))
        return { ...s, status: 'fail', message: `${m}｜判定：no response（${type} 機種規則：會開局的鍵都沒開局）` }
      // noMenuGate：這個機種沒有選面額選單 → runner 的「選單狀態未知」不構成懷疑理由，
      // 按了 SPIN、餘額沒變、moneyNtc begin 0 次就是 spin no response（有 begin 的照舊不算）
      if (rules.noMenuGate && s.step === 'Spin 測試' && /選單狀態未知/.test(m))
        return { ...s, message: m.replace(/｜?選單狀態未知：[^｜]*/g, `｜（${type} 沒有選面額選單，不視為選單干擾）`) }
      return s
    }),
  }
}
export function judge(rawResult, stepsRun) {
  const result = applyGameRules(rawResult)
  if (result.unboundSession) return { verdict: '結果沒帶 sessionId（舊版 agent），無法證明屬於本批，待確認', J: null }
  const st = (result.steps ?? []).filter(s => STEP_ZH[s.step])
  const entry = st.find(s => s.step === '進入機台')
  if (entry && /已在遊戲內/.test(entry.message ?? '')) return { verdict: '結果不可信（載入時已在遊戲內），需重測', J: null }
  const noRound = audioFromSession(st)   // Spin 沒開局或被選單閘門擋下：音頻都改看整段錄音
  const sessionSilent = sessionSaysNoSound(result)
  const cls = st.map(s => ({ name: STEP_ZH[s.step], c: noRound && s.step === '音頻檢測' ? (sessionSilent ? 'fail' : 'na') : classify(s), touchNoCfg: s.step === '觸屏測試' && /未設定 touchPoints/.test(s.message ?? '') }))
  const fails = cls.filter(x => x.c === 'fail').map(x => x.name)
  if (fails.length) return { verdict: `驗證未過：${fails.join('、')}`, J: '驗證未過' }
  const checks = cls.filter(x => x.c === 'check').map(x => x.name)
  if (checks.length) return { verdict: `待人工確認：${checks.join('、')}`, J: null }
  if (stepsRun.length < ALL_STEPS.length) return { verdict: `只跑部分測項（${stepsRun.join(',')}），不判定整台`, J: null }
  const naRequired = cls.filter(x => x.c === 'na' && !x.touchNoCfg).map(x => x.name)
  if (naRequired.length) return { verdict: `有必驗項目未驗：${naRequired.join('、')}`, J: null }
  const done = new Set(cls.map(x => x.name))
  const missing = Object.values(STEP_ZH).filter(n => !done.has(n))
  if (missing.length) return { verdict: `沒收到這幾項的結果：${missing.join('、')}`, J: null }
  const touchNote = cls.some(x => x.touchNoCfg) ? '（觸屏因機種未設定 touchPoints 未驗，不列入必驗）' : ''
  return { verdict: `已驗項目通過${touchNote}`, J: '驗證通過' }
}
// ── F 欄精簡格式（使用者 2026-09-29 指定，整格覆蓋、不再往下接；細節看 report.html）────────
// 8 項都過＝ok；其餘用關鍵字、逗號串：offline／mainstream no show／poolstream no show／no sound／low sound／
// ideck no response／touchscreen no response／no cctv；規則外的失敗寫 <項目> fail，沒驗到寫 <項目> not verified。
// ⚠️ 關鍵字靠 runner 訊息字串判斷（跟 classify 一樣耦合），runner 改訊息要同步改這裡並跑 scripts/machine-test-shortline-probe.mjs
const STEP_EN = { entry: '進入機台', stream: '推流檢測', spin: 'Spin 測試', audio: '音頻檢測', ideck: 'iDeck 測試', touchscreen: '觸屏測試', cctv: 'CCTV 號碼比對', exit: '退出測試' }
export function shortLine(rawResult, j, orientation, stepsRun = ALL_STEPS) {
  const result = applyGameRules(rawResult)
  const steps = (result?.steps ?? []).filter(s => STEP_ZH[s.step])
  const get = n => steps.find(s => s.step === n)
  const msg = s => String(s?.message ?? '')
  const learnOf = s => { try { return JSON.parse(s?.extraData?.learn ?? 'null') } catch { return null } }
  const out = []
  const entry = get('進入機台')
  if (entry && classify(entry) === 'fail') {
    // 使用者：大廳找不到機台、或 enterGMNtc 回錯誤碼，兩者都算 offline
    // 0929：Preview 顯示 Occupied（runner detectOccupied）→ AUDIT MODE 寫 audit mode（使用者指定），一般佔用寫 occupied
    // 1003：進場時 AFT 轉入失敗（盒子 log aft_in_end success=false），enterGMNtc 照樣回 0——batch 事後查盒子 log 補進訊息。
    // 排在 occupied 前面：AFT 失敗後盒子會一直掛著我們的帳號 → 下一次進場看到的是 Occupied，真正原因是 AFT（使用者 1003：0208/0209）
    // 使用者 1003：F 只寫「AFT error」（state 碼留在報告／訊息裡，不寫進 F）
    if (/AFT error state=/.test(msg(entry))) return 'AFT error'
    if (/Occupied（AUDIT MODE/.test(msg(entry))) return 'audit mode'
    if (/機台 Occupied/.test(msg(entry))) return 'occupied'
    return /大廳找不到機台代碼|enterGMNtc errcode=(?!0\b)/.test(msg(entry)) ? 'offline' : 'entry fail'
  }
  const st = get('推流檢測')
  if (st) {
    const ld = learnOf(st)
    const roles = ld?.videoRoles
    // runner 有帶 noShow（含「整個畫面不見」的角色，0243）就直接用；舊資料只有 videoRoles，只能看沒在播的
    const bad = Array.isArray(ld?.noShow) ? [...ld.noShow]
      : Array.isArray(roles) && roles.length ? [...new Set(roles.filter(v => !v.playing).map(v => `${v.role}stream no show`))] : []
    // 使用者 0929：main 推流沒畫面時只寫 mainstream no show（聲音／觸屏沒有意義），但 CCTV 是獨立的，沒畫面照樣寫 no cctv
    // 1005：NO SIGNAL 測試卡（batch 事後偵測寫進訊息）。main 沒訊號等同主畫面沒了，照 main no show 的規則只寫它＋CCTV
    const noSig = [...new Set(msg(st).match(/(?:main|pool)?stream no signal/g) ?? [])]
    if (noSig.includes('mainstream no signal')) {
      const cc = get('CCTV 號碼比對')
      const noCctv = cc && ['fail', 'warn'].includes(classify(cc)) && /video|找不到|沒有|無畫面|未播放/.test(msg(cc))
      return noCctv ? 'mainstream no signal, no cctv' : 'mainstream no signal'
    }
    out.push(...noSig)
    if (bad.includes('mainstream no show') || /mainstream no show/.test(msg(st))) {
      const cc = get('CCTV 號碼比對')
      const noCctv = cc && ['fail', 'warn'].includes(classify(cc)) && /video|找不到|沒有|無畫面|未播放/.test(msg(cc))
      return noCctv ? 'mainstream no show, no cctv' : 'mainstream no show'
    }
    if (bad.length) out.push(...bad.sort((a, b) => a.startsWith('main') ? -1 : b.startsWith('main') ? 1 : 0))
    else if (classify(st) === 'fail' && !noSig.length) out.push(/no show/.test(msg(st)) ? msg(st).match(/(?:main|pool)stream no show/g).join(', ') : 'stream fail')
    else if (classify(st) === 'na') out.push('stream not verified')
  }
  const sp = get('Spin 測試')
  const noRound = spinNoRound(steps)
  // 使用者 0930：按了沒開局＝spin no response；此時 Spin 錄音不採用，改看整段錄音——整段都靜音才寫 no sound
  const fromSession = audioFromSession(steps)
  if (noRound) out.push('spin no response')
  else if (sp && classify(sp) === 'fail') out.push('spin fail')
  else if (sp && classify(sp) === 'na') out.push('spin not verified')   // 含 Spin 前選單閘門沒放行（觸屏那項會另外寫 no response）
  if (fromSession && sessionSaysNoSound(result)) out.push('no sound')
  const au = fromSession ? null : get('音頻檢測')
  if (au && /靜音/.test(audioIssues(msg(au)))) out.push('no sound')
  else if (au && /音量偏低|音量偏小/.test(audioIssues(msg(au)))) out.push('low sound')
  else if (au && classify(au) === 'fail') out.push('audio fail')
  else if (au && classify(au) === 'na') out.push('audio not verified')
  for (const [n, k] of [['iDeck 測試', 'ideck'], ['觸屏測試', 'touchscreen']]) {
    const s = get(n)
    if (!s) continue
    if (n === '觸屏測試' && /未設定 touchPoints/.test(msg(s))) continue   // 機種沒設定觸屏：不列入必驗，不寫
    const c = classify(s)
    // no response 只給「真的送了沒回應」：iDeck 看 runner 的「判定：」標記（verdicts.ts），觸屏的例外算流程失敗
    // 觸屏畫面判定（0929）訊息也帶「判定：」；舊的盒子 log 判定沒有標記，照舊：非例外的 FAIL＝no response
    const tagged = msg(s).match(/判定：(no response|flow fail)/)?.[1]
    const noResp = tagged ? tagged === 'no response' : n === 'iDeck 測試' ? false : !/^例外/.test(msg(s))
    // 1005 使用者：iDeck fail 要寫出是哪一顆按鈕有問題 → 取 runner「未通過：」段落裡的「按鈕名」
    const badKeys = n === 'iDeck 測試' ? [...new Set([...(msg(s).match(/未通過：([^｜]*)/)?.[1] ?? '').matchAll(/「([^」]+)」/g)].map(x => x[1]))] : []
    if (c === 'fail') out.push(noResp ? `${k} no response` : badKeys.length ? `${k} fail (${badKeys.join(' / ')})` : `${k} fail`)
    else if (c === 'na') out.push(`${k} not verified`)
  }
  const cc = get('CCTV 號碼比對')
  if (cc) {
    const c = classify(cc)
    if (c === 'check' && /構圖待人工確認/.test(msg(cc))) out.push('cctv framing to check')
    else if (c === 'check') out.push('cctv number mismatch')
    // 1003 使用者：CCTV 模糊／浮水印沒有機台編號都算 FAIL（先判這兩個，不然「沒有機台編號」會被下一行的「沒有」吃成 no cctv）
    else if (c === 'fail' && /判定：CCTV 畫面模糊/.test(msg(cc))) out.push('cctv blurry')
    else if (c === 'fail' && /判定：CCTV 浮水印沒有機台編號/.test(msg(cc))) out.push('cctv no id')
    // 1004 使用者：沒拍到完整機台（只拍到局部）也算 FAIL
    else if (c === 'fail' && /判定：CCTV 沒拍到完整機台/.test(msg(cc))) out.push('cctv not full')
    else if ((c === 'fail' || c === 'warn') && /video|找不到|沒有|無畫面|未播放/.test(msg(cc))) out.push('no cctv')
    else if (c === 'fail') out.push('cctv fail')
    else if (c === 'na') out.push('cctv not verified')
  }
  const ex = get('退出測試')
  if (ex && classify(ex) === 'fail') out.push('exit fail')
  else if (ex && classify(ex) === 'check') out.push('exit not confirmed')
  else if (ex && classify(ex) === 'na') out.push('exit not verified')
  // 有跑卻沒收到結果的項目 → <項目> not verified
  for (const k of stepsRun) if (STEP_EN[k] && !get(STEP_EN[k])) out.push(`${k} not verified`)
  // 方向是影子模式、不影響 J，但確認倒轉（CodeX 也確認過才會是 fail）還是要讓人看到
  if (orientation?.status === 'fail') out.push('stream orientation wrong')
  if (out.length) return out.join(', ')
  if (j?.J === '驗證通過') return 'ok'
  // 沒有具體問題但也沒判通過（只跑部分測項、舊 agent、缺項）→ 不能寫 ok
  return /只跑部分測項/.test(j?.verdict ?? '') ? 'partial test' : 'not verified'
}

export function larkLine(result, j, date) {
  const s = (result.steps ?? []).filter(x => STEP_ZH[x.step]).map(x => `${STEP_ZH[x.step]} ${classify(x).toUpperCase()}`).join(' / ')
  const detail = (result.steps ?? []).filter(x => STEP_ZH[x.step] && ['fail', 'check', 'warn'].includes(classify(x))).map(x => `${STEP_ZH[x.step]}: ${String(x.message).slice(0, 90)}`).join('; ')
  // 觸屏 PASS 也要寫出驗了哪幾個座標（FAIL/WARN 已在 detail 裡）
  const touch = (result.steps ?? []).find(x => x.step === '觸屏測試' && classify(x) === 'pass')
  const touchNote = touch ? ` | 觸屏: ${String(touch.message).slice(0, 120)}` : ''
  return `[${date} auto] ${j.verdict} | ${s}${detail ? ' | ' + detail : ''}${touchNote} | not verified: stream picture content, cctv orientation`
}
const evidence = (sid, code) => ({
  stream: path.join(SAVES, 'stream-saves', `${sid}-${code}.png`),
  cctv: path.join(SAVES, 'cctv-saves', `${sid}-${code}.png`),
  audio: path.join(SAVES, 'audio-saves', `${sid}-${code}-session.wav`),
})

// ── learn 模式：從單台結果學機種 profile（2026-09-29，設計跟 CodeX 對過）─────────────
// profile 是「機種」共用的，所以只做保守的事：
//   - 會影響之後判定的只有 touchPoints，而且**只增不減**：盒子收到「我點的那格」＋10 秒內有 usb_coordinate 才收
//   - 畫面數、iDeck 按鈕、CCTV、音頻只寫進 notes 的 [learn] 區塊當紀錄，不改規則
//     （當下亮幾個≠應該有幾個；iDeck 盒子驗證只有總數、對不到哪一顆，且 SQUIDGAME 刻意用自動偵測，不能蓋成 XPath）
//   - runner 的 learn 資料版本對不上、或結果沒綁本次 session → 整台不寫
export const LEARN_VER = 1
const LEARN_BEGIN = '[learn]', LEARN_END = '[/learn]'
export const machineTypeOf = code => code.split('-').slice(1, -1).join('-').toUpperCase()
const stepLearn = (result, name) => {
  const s = (result.steps ?? []).find(x => x.step === name)
  if (!s?.extraData?.learn) return { step: s, data: null }
  try { return { step: s, data: JSON.parse(s.extraData.learn) } } catch { return { step: s, data: null } }
}
// 回傳 { ok, reason?, next, changes[], warnings[], block }；純函式，探針直接測
export function learnProfile(result, old, meta) {
  if (result.unboundSession || result.sessionId !== meta.sessionId) return { ok: false, reason: '結果沒綁本次 session，不寫 profile' }
  const stream = stepLearn(result, '推流檢測'), ideck = stepLearn(result, 'iDeck 測試'), touch = stepLearn(result, '觸屏測試')
  const bad = [['推流', stream], ['iDeck', ideck], ['觸屏', touch]].filter(([, x]) => !x.data || x.data.v !== LEARN_VER).map(([n]) => n)
  if (bad.length) return { ok: false, reason: `runner 沒帶 learn 資料或版本不符（${bad.join('、')}；需 v${LEARN_VER}），agent 可能是舊版，不寫 profile` }

  const type = machineTypeOf(meta.code)
  const next = old ? { ...old } : { machineType: type, bonusAction: 'spin' }   // 1003 使用者：新機種預設按 SPIN
  const changes = [], warnings = []

  // 相容性（跟 session／版本檢查是不同層，CodeX 0929）：進場 enterGMNtc 回的 machineType 要有，
  // 且 profile 有設 enterMachineType 時必須相同；不相容就不動會影響判定的欄位（notes 照寫，方便人工比對）
  const entryMT = (result.steps ?? []).find(x => x.step === '進入機台')?.extraData?.machineType ?? null
  const compatible = !!entryMT && (!old?.enterMachineType || String(old.enterMachineType).toUpperCase() === String(entryMT).toUpperCase())
  if (!entryMT) warnings.push('進場沒拿到 machineType，無法確認跟機種 profile 相容 → touchPoints 不動')
  else if (!compatible) warnings.push(`進場 machineType=${entryMT} 跟 profile 的 enterMachineType=${old.enterMachineType} 不同 → 可能不同配置，touchPoints 不動`)

  // touchPoints：只增不減；每一格都要同一套證據（盒子收到該格＋緊接著的 usb_coordinate）
  const oldTp = (old?.touchPoints ?? []).filter(Boolean)
  const reacted = touch.data.reacted ?? []
  const addTp = compatible ? reacted.filter(p => !oldTp.includes(p)) : []
  if (addTp.length) { next.touchPoints = [...oldTp, ...addTp]; changes.push(`touchPoints 新增 ${addTp.join('、')}（盒子收到且有動作）`) }
  if (touch.data.apiErr) warnings.push(`觸屏：機台 log API 查不到（${touch.data.apiErr}），touchPoints 不動`)

  // notes 的 [learn] 區塊：整塊換新，人寫的其他內容保留
  const st = name => { const s = (result.steps ?? []).find(x => x.step === name); return s ? s.status.toUpperCase() : '沒跑' }
  const sd = stream.data, id = ideck.data, td = touch.data
  const btns = (id.buttons ?? []).map(b => b.text || b.label).join(' / ')
  const block = [
    `${LEARN_BEGIN} ${meta.date.slice(0, 10)} ${meta.code} session ${meta.sessionId} 進場machineType=${entryMT ?? "?"}`,
    `畫面：video ${sd.totalVideos}（播放 ${sd.playingVideos}）／canvas ${sd.totalCanvases}（活躍 ${sd.activeCanvases}）— 觀察值，不是規格`,
    `iDeck：${(id.buttons ?? []).length} 顆（${id.source}）${btns ? `：${btns}` : ''}；盒子回應 ${id.boxAccepted ?? '未驗'}${id.apiErr ? `（${id.apiErr}）` : ''}`,
    `觸屏：${td.autoPicked ? `自動挑點，可選 ${td.candidates ?? '?'} 格` : '用 profile 設定點'}；點 ${td.clicked.join('、') || '-'}；盒子收到 ${td.boxAccepted ? td.boxAccepted.join('、') || '0' : '未驗'}；有動作 ${td.reacted ? td.reacted.join('、') || '0' : '未驗'}`,
    `其他：進入 ${st('進入機台')}／Spin ${st('Spin 測試')}／音頻 ${st('音頻檢測')}／CCTV ${st('CCTV 號碼比對')}／退出 ${st('退出測試')}`,
    LEARN_END,
  ].join('\n')
  const oldNotes = String(old?.notes ?? '')
  const re = new RegExp(`\\[learn\\][\\s\\S]*?\\[/learn\\]`)
  const prevBlock = oldNotes.match(re)?.[0] ?? null
  next.notes = prevBlock ? oldNotes.replace(re, block) : (oldNotes ? `${oldNotes}\n${block}` : block)
  changes.push(prevBlock ? 'notes 的 [learn] 區塊更新' : 'notes 新增 [learn] 區塊')

  // 同機種相容性：跟上一次學習紀錄比，觀察值不同就提醒（不擋、不改規則）
  if (prevBlock) {
    const pick = (s, re2) => s.match(re2)?.[1]
    for (const [label, re2] of [['畫面', /畫面：(.*?)—/], ['iDeck 顆數', /iDeck：(\d+) 顆/], ['觸屏可選格數', /可選 (\S+) 格/]]) {
      const a = pick(prevBlock, re2), b = pick(block, re2)
      if (a && b && a.trim() !== b.trim()) warnings.push(`同機種觀察不一致（${label}）：上次 ${a.trim()}，這次 ${b.trim()}——可能機台配置不同，請人工確認`)
    }
    const prevSrc = prevBlock.split('\n')[0]
    if (!prevSrc.includes(meta.code)) warnings.push(`上次學習來源是別台（${prevSrc.replace(LEARN_BEGIN, '').trim()}），這次覆蓋了 [learn] 區塊`)
  }
  if (!old) changes.unshift(`機種 ${type} 原本沒有 profile，新建（bonusAction=spin＝新機種預設；FG/JP 卡住時工具會 OCR 判斷再學）`)
  return { ok: true, next, changes, warnings, block }
}
// PUT 的欄位（GET 會多帶 hasAudioRef、ideck_xpaths 等，送回去前濾掉）
const PROFILE_FIELDS = ['machineType', 'bonusAction', 'touchPoints', 'clickTake', 'gmid', 'enterMachineType', 'spinSelector', 'balanceSelector', 'exitSelector', 'notes', 'entryTouchPoints', 'entryTouchPoints2', 'ideckXpaths', 'audioConfig', 'expectedScreens']
// 比對用正規化：[] 與 null 同義、false 與 null 同義（GET/PUT 來回會互換）
export const normProfile = p => p ? JSON.stringify(Object.fromEntries(PROFILE_FIELDS.map(k => {
  let v = p[k] ?? null
  if (Array.isArray(v) && v.length === 0) v = null
  if (v === false) v = null
  if (k === 'machineType' && v) v = String(v).toUpperCase()
  return [k, v]
}))) : null
// 讀取失敗一定要丟錯，不能當「沒有 profile」：快照是 null 時，GET 失敗也是 null → 比對照樣通過 → 蓋掉既有 profile（CodeX 1001）
async function listProfiles() {
  const r = await central('/api/machine-test/profiles')
  if (r.status !== 200 || !r.json?.ok || !Array.isArray(r.json.profiles)) throw new Error(`讀 profile 清單失敗 ${r.status} ${r.txt.slice(0, 120)}`)
  return r.json.profiles
}
const getProfile = async type => (await listProfiles()).find(x => x.machineType.toUpperCase() === type) ?? null
// 寫入保護：PUT 前再讀一次跟開跑快照比（有人改過就中止）→ 備份 → PUT → 讀回核對（不符只標衝突，不回滾）
async function applyLearn(type, snapshot, plan, backupDir, meta) {
  let now
  try { now = await getProfile(type) } catch (e) { return { applied: false, conflict: false, note: `寫入前${e.message}，不寫（讀不到現況就無法確認有沒有人改過）` } }
  if (normProfile(now) !== normProfile(snapshot)) return { applied: false, conflict: true, note: '開跑後 profile 已被別人改過，中止寫入（避免蓋掉對方的修改）', now }
  fs.mkdirSync(backupDir, { recursive: true })
  const backupFile = path.join(backupDir, `profile-backup-${type}-${Date.now()}.json`)
  saveSummary(backupFile, { type, machine: meta.code, sessionId: meta.sessionId, at: new Date().toISOString(), before: snapshot, after: plan.next, changes: plan.changes, warnings: plan.warnings })
  // 缺的欄位要送 null：中控 INSERT 用具名參數，少一個就 500「Missing named parameter "gmid"」（新建 profile 時踩到，1001 0141）
  const body = Object.fromEntries(PROFILE_FIELDS.map(k => [k, plan.next[k] ?? null]))
  const r = await central('/api/machine-test/profiles', { method: 'PUT', body: JSON.stringify(body) })
  if (r.status !== 200 || !r.json?.ok) return { applied: false, conflict: false, note: `PUT 失敗 ${r.status} ${r.txt.slice(0, 200)}`, backupFile }
  let back
  try { back = await getProfile(type) } catch (e) { return { applied: true, conflict: true, note: `已寫入但讀回失敗（${e.message}），無法核對，請人工確認`, backupFile } }
  if (normProfile(back) !== normProfile(plan.next)) return { applied: true, conflict: true, note: '寫入後讀回不一致（期間可能有人同時修改），已保留備份與差異，未回滾，請人工確認', backupFile, back }
  return { applied: true, conflict: false, note: '已寫入並讀回核對一致', backupFile }
}

// 畫面方向（影子模式，2026-09-29）：使用者決定**不接 Gemini、由 Claude 看圖判讀**。
// 腳本只負責把推流區逐塊裁切存檔、標「待人工判讀」；Claude 讀圖後用 --set-orientation 補寫 F 欄與報告。
// 判讀標準與流程：knowledge/h5-client-interaction.md §9。不影響 J。
// ── 推流 NO SIGNAL 偵測（1005 使用者：0325／0326 上螢幕是 NO SIGNAL 測試卡，video 照樣「在播」，工具判 PASS 是漏洞）──
// 做法：把每塊 video 裁切縮成 32×18 RGB，跟參考圖（MT_HOME/knowledge/machine-test/no-signal-ref.png，取自 0325 上螢幕）
// 算每像素平均絕對差。實測 ARUZE 0321～0326：NO SIGNAL 0.0～0.3，正常遊戲畫面 75～93 → 門檻 20。
// F 欄關鍵字照使用者指定寫「<role>stream no signal」（不寫 no show）。
const NO_SIGNAL_REF = path.join(ROOT, 'knowledge', 'machine-test', 'no-signal-ref.png')
const NO_SIGNAL_MAX_DIFF = 20
export async function noSignalCheck(orientation) {
  const videos = orientation?.videos ?? []
  if (!videos.length || !fs.existsSync(NO_SIGNAL_REF)) return []
  const { createRequire } = await import('node:module')
  const sharp = createRequire(path.join(ROOT, 'package.json'))('sharp')
  const thumb = f => sharp(f).removeAlpha().resize(32, 18, { fit: 'fill' }).raw().toBuffer()
  const ref = await thumb(NO_SIGNAL_REF)
  const hits = []
  for (const v of videos) {
    try {
      const t = await thumb(v.file)
      let d = 0
      for (let i = 0; i < t.length; i++) d += Math.abs(t[i] - ref[i])
      const diff = d / t.length
      if (diff <= NO_SIGNAL_MAX_DIFF) hits.push({ role: v.role ?? 'unknown', diff: Number(diff.toFixed(1)) })
    } catch { /* 單塊讀不到就跳過，不影響其他塊 */ }
  }
  return hits
}

export async function orientationFor(result, pngPath, code, outDir) {
  if (!pngPath || !fs.existsSync(pngPath)) return { status: 'na', shadow: true, note: '沒有推流截圖，方向未驗', crops: [] }
  try {
    // sharp 裝在資料根目錄（osm-qa-agent）的 node_modules，不在 Toppath repo 裡 → 從 MT_HOME 解析
    // （1005 搬進 repo 後直接 import('sharp') 會 Cannot find package，方向裁切整個失效）
    const { createRequire } = await import('node:module')
    const sharp = createRequire(path.join(ROOT, 'package.json'))('sharp')
    const s = stepLearn(result, '推流檢測').data
    const meta = await sharp(pngPath).metadata()
    const scale = s?.viewportW ? meta.width / s.viewportW : 1
    const rects = (s?.screens?.length ? s.screens : [{ x: 0, y: 0, w: meta.width / scale, h: meta.height / scale }]).slice().sort((p, q) => p.y - q.y)
    const dir = path.join(outDir, 'orientation'); fs.mkdirSync(dir, { recursive: true })
    const crops = []
    const videos = []   // 1005：哪一塊是 video、是 main 還是 pool（給 NO SIGNAL 偵測用）
    for (const [i, r] of rects.entries()) {
      const left = Math.max(0, Math.round(r.x * scale)), top = Math.max(0, Math.round(r.y * scale))
      const width = Math.min(meta.width - left, Math.round(r.w * scale)), height = Math.min(meta.height - top, Math.round(r.h * scale))
      if (width < 20 || height < 20) continue
      const f = path.join(dir, `${code}-screen${i + 1}.png`)
      await sharp(pngPath).extract({ left, top, width, height }).png().toFile(f)
      crops.push(f)
      if (r.kind === 'video') videos.push({ file: f, role: (s?.videoRoles ?? []).find(v => Math.abs(v.y - r.y) < 3)?.role ?? null })
    }
    return { status: 'pending', shadow: true, note: `待人工判讀（${crops.length} 塊${s?.screens ? '' : '，舊 agent 沒帶畫面位置，整張'}）`, crops, videos }
  } catch (e) { return { status: 'na', shadow: true, note: `裁切失敗：${String(e.message ?? e).slice(0, 120)}`, crops: [] } }
}

// ── 回寫（每一欄各自記錄成敗，重試時只補沒成功的欄）─────────────────────────
async function writeBack(sheet, letters, m, date) {
  const wb = m.writeback ??= {}
  const L = letters, row = m.row
  const step = async (key, fn) => {
    if (wb[key] === 'ok' || wb[key] === 'n/a') return
    if (!L[key]) { wb[key] = 'n/a'; return }   // 1003：這個分頁沒有這欄
    try { wb[key] = (await fn()) ?? 'ok' } catch (e) { wb[key] = 'err: ' + String(e.message ?? e).slice(0, 120) }
  }
  await step('F', async () => { await putCell(sheet, `${L.F}${row}`, m.larkLine); return 'ok' })   // 0929 使用者要求整格覆蓋、只寫精簡關鍵字
  if (!m.result) { for (const k of ['G', 'H', 'I']) wb[k] ??= 'n/a' }
  await step('G', async () => fs.existsSync(m.evidence.stream) ? (await putImage(sheet, `${L.G}${row}`, m.evidence.stream), 'ok') : 'n/a')
  await step('H', async () => fs.existsSync(m.evidence.cctv) ? (await putImage(sheet, `${L.H}${row}`, m.evidence.cctv), 'ok') : 'n/a')
  await step('I', async () => {
    if (!fs.existsSync(m.evidence.audio)) return 'n/a'
    const up = await uploadDrive(m.evidence.audio)
    // 0929 使用者要求只留最新一份（跟 F 欄一樣整格覆蓋，不再往下接）
    await putCell(sheet, `${L.I}${row}`, `${m.code.split('-').pop()} ${date} full session (${up.mb.toFixed(1)}MB): ${up.url}`)
    return 'ok'
  })
  // 判定不出來就清掉舊值，避免留下上一輪的 J。
  // ⚠️ 要寫 null 不能寫 ''：J 是下拉欄，寫 '' Lark 會標「資料無效／請選擇下拉式清單中的選項」（紅角，畫面看起來是空的）；
  //    values:[[null]] 才是真的清空（1006 osm-qa-agent 實測 J6/J9/J11 讀回 null）
  await step('J', async () => { await putCell(sheet, `${L.J}${row}`, m.J ?? null); return 'ok' })
}
const wbDone = m => m.writeback && ['F', 'G', 'H', 'I', 'J'].every(k => m.writeback[k] === 'ok' || m.writeback[k] === 'n/a')
const saveSummary = (f, s) => fs.writeFileSync(f, JSON.stringify(s, null, 1))

// ── 事件串流：只收「本次 session」的 machine_done（先 start 再接；15 分鐘一斷就重接）──
// 伺服器轉播 agent 事件時不帶 sessionId，所以：
//   - runner（2026-09-24 起）會在 result 裡帶 sessionId → 必須等於本次 session
//   - 舊版 agent 沒帶 → 當下中控上這個帳號的進行中 session 是本次才收，**但標 unboundSession**：
//     「中控目前是本批」不能證明這筆延遲到的結果屬於本批（CodeX 0924），所以 judge() 一律判待確認、J 不填。
// 兩者都對不上就丟掉，避免混進試跑或別的批次的結果。
// strict（續跑輪）：CodeX 0930——沒帶 sessionId 的延遲結果可能是舊 session 的，不能拿來結束新一輪
// runner 停批（前一台需人工處理）後，剩下的台只回一個 skip 步驟「未執行：…」；任何一步有真的跑過就不算
export const notExecuted = result => Array.isArray(result?.steps) && result.steps.length > 0
  && result.steps.every(s => s.status === 'skip') && result.steps.some(s => /^未執行/.test(String(s.message ?? '')))
export function acceptResult(ev, { codes, sessionId, currentSid, seen, strict = false }) {
  if (ev?.type !== 'machine_done' || !ev.result || !codes.includes(ev.machineCode) || seen.has(ev.machineCode)) return false
  if (ev.result.sessionId) return ev.result.sessionId === sessionId
  if (strict) return false
  return currentSid === sessionId
}
async function collect(codes, sessionId, onDone, { strict = false } = {}) {
  const results = new Map(), errors = []
  let currentSid = null
  const pollSid = async () => { try { currentSid = (await central('/api/machine-test/queue-status')).json?.sessionId ?? currentSid } catch { /* keep last */ } }
  await pollSid()
  const poller = setInterval(pollSid, 5000)
  try {
    while (true) {
      await new Promise(resolve => {
        const ws = new WebSocket(`${CFG.central.replace(/^http/, 'ws')}/ws/machine-test/events`, { headers: { cookie } })
        const timer = setTimeout(() => ws.close(), 15 * 60 * 1000)
        ws.on('message', raw => {
          let ev; try { ev = JSON.parse(raw.toString()) } catch { return }
          if (ev.type === 'machine_done') {
            if (!acceptResult(ev, { codes, sessionId, currentSid, seen: results, strict })) return
            if (!ev.result.sessionId) ev.result.unboundSession = true
            results.set(ev.machineCode, ev.result)
            log(`■ ${ev.machineCode} => ${ev.result.overall}（${results.size}/${codes.length}）`)
            onDone?.(ev.machineCode, ev.result)
          } else if (ev.type === 'error') {
            // 10-01 0342：agent WS 斷線時中控常常已經把 session 清掉（currentSid 變 null），斷線訊息因此沒記進 errors，
            // 自動續跑就誤以為是手動停止。**自己這台 agent 的斷線**不看 currentSid 一律記下（別人的 agent 斷線照舊不管）
            const ownDisconnect = /已斷線/.test(ev.message ?? '') && String(ev.message).includes(CFG.agentLabel)
            if (currentSid === sessionId || ownDisconnect) { errors.push(String(ev.message ?? '').slice(0, 200)); log('!!', ev.message) }
          } else if (ev.type === 'log' && /CCTV 構圖|🛑|偵測到特殊狀態|特殊狀態結束|退出未完成|已在遊戲內|點擊 Join|iDeck 自動偵測對照|iDeck DOM|找不到元素，跳過|iDeck 按鈕|還原倍數|iDeck 診斷|🛑 iDeck|退出紀錄|推流等了|📘|🆘|Spin 前|Spin 沒開局|量座標|📚|🧩/.test(ev.message ?? '')) {
            log(`  ${ev.machineCode ?? '-'} | ${String(ev.message).slice(0, /iDeck DOM/.test(ev.message) ? 1500 : 160)}`)
            // CodeX 0930：🛑 有時只出現在 log、沒有 error 事件 → 也要記進 errors，續跑判斷才看得到「本批已停批」
            if (/🛑/.test(ev.message ?? '') && currentSid === sessionId) errors.push(String(ev.message).slice(0, 200))
          } else if (ev.type === 'session_done' && results.size > 0) ws.close()
        })
        ws.on('close', () => { clearTimeout(timer); resolve() })
        ws.on('error', () => { clearTimeout(timer); resolve() })
      })
      if (results.size >= codes.length) break
      if (!(await status())?.active) break
      await sleep(2000)
    }
  } finally { clearInterval(poller) }
  return { results, errors }
}
async function startSession(lobbyUrl, codes, stepList, agentId) {
  const start = () => central('/api/machine-test/start', {
    method: 'POST', headers: { 'x-admin-pin': CFG.adminPin },
    body: JSON.stringify({ lobbyUrls: [lobbyUrl], machineCodes: codes, steps: Object.fromEntries(ALL_STEPS.map(s => [s, stepList.includes(s)])), account: CFG.email, headedMode: true, osmEnv: CFG.osmEnv, aiAudio: false, agentId }),
  })
  let r = await start()
  // 1004、1005 各發生一次：中控在測試途中重啟（部署）→ session 沒了但鎖還在 → 之後每次都 429，要等 6 小時自癒。
  // 只在「鎖是自己帳號的 machine-test、而且中控回報目前沒有進行中的 session」時才清，清完重送一次；
  // 有 active session 代表真的有人在跑，絕不清。
  if (r.status === 429 && r.json?.code === 'HEAVY_TASK_RUNNING' && r.json?.task?.type === 'machine-test' && r.json.task.id) {
    const st = await status()
    if (st && !st.active) {
      const c = await central(`/api/heavy-tasks/${r.json.task.id}/force-clear`, { method: 'POST' })
      log(`中控留著孤兒鎖 ${r.json.task.id}（沒有進行中的 session）→ 清除${c.status === 200 ? '成功' : `失敗 ${c.status}`}，重新發動`)
      if (c.status === 200) r = await start()
    }
  }
  if (r.status !== 200 || !r.json?.sessionId) throw new Error(`發動失敗 ${r.status} ${r.txt.slice(0, 200)}`)
  return r.json.sessionId
}
// ── 機種知識：設定同步＋注意事項（1003，使用者：「依 gmid 取用機種知識」「需要做到」）────────────────
// 單一來源＝knowledge/games/<機種>/automation/machine-test.json（menuGate／touchVisual／bonusSequence／layout＋參考圖）。
// 開跑前同步到 agent 的 menu-gate.json／touch-visual.json／bonus-sequence.json／machine-layout.json／feature-taps.json／menu-refs／touch-refs
// （runner 每次用到才讀檔，不用重啟 agent）。有 machine-test.json 的機種以它為準：檔裡沒有的區塊，agent 那邊也刪掉。
const GAME_SECTIONS = { menuGate: ['menu-gate.json', 'menu-refs'], touchVisual: ['touch-visual.json', 'touch-refs'], bonusSequence: ['bonus-sequence.json'], layout: ['machine-layout.json'], featureTaps: ['feature-taps.json'] }
export const gameDir = type => path.join(ROOT, 'knowledge', 'games', type, 'automation')
export function syncGameConfigs(types, agentMtDir = path.join(CFG.agentDir, 'server', 'machine-test')) {
  const out = []
  for (const t of types) {
    const f = path.join(gameDir(t), 'machine-test.json')
    if (!fs.existsSync(f)) { out.push(`${t}：沒有本機機種知識檔 machine-test.json（選單閘門／觸屏視覺走自動偵測；中控 profile 另計）`); continue }
    const cfg = JSON.parse(fs.readFileSync(f, 'utf8'))
    const did = []
    for (const [sec, [file, refDir]] of Object.entries(GAME_SECTIONS)) {
      const af = path.join(agentMtDir, file)
      let obj = {}; try { obj = JSON.parse(fs.readFileSync(af, 'utf8')) } catch { /* 沒有就新建 */ }
      const before = JSON.stringify(obj[t] ?? null)
      if (cfg[sec]) {
        const { refImage, refs, ...rest } = cfg[sec]
        // 多參考圖（1003）：knowledge 的 refs[{image,region}] → agent 的 refs[{file:'<機種>-<n>.png',region}]
        obj[t] = Array.isArray(refs) && refs.length ? { ...rest, refs: refs.map((r, i) => ({ file: `${t}-${i + 2}.png`, region: r.region })) } : rest
      } else delete obj[t]
      if (JSON.stringify(obj[t] ?? null) !== before) { fs.writeFileSync(af, JSON.stringify(obj, null, 2) + '\n'); did.push(cfg[sec] ? sec : `${sec}（刪除）`) }
      if (cfg[sec]?.refImage && refDir) {
        const src = path.join(gameDir(t), cfg[sec].refImage), dst = path.join(agentMtDir, refDir, `${t}.png`)
        if (fs.existsSync(src) && (!fs.existsSync(dst) || !fs.readFileSync(src).equals(fs.readFileSync(dst)))) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); did.push(`${refDir}/${t}.png`) }
      }
      for (const [i, r] of (refDir && Array.isArray(cfg[sec]?.refs) ? cfg[sec].refs : []).entries()) {
        const src = path.join(gameDir(t), r.image), dst = path.join(agentMtDir, refDir, `${t}-${i + 2}.png`)
        if (fs.existsSync(src) && (!fs.existsSync(dst) || !fs.readFileSync(src).equals(fs.readFileSync(dst)))) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); did.push(`${refDir}/${t}-${i + 2}.png`) }
      }
    }
    out.push(`${t}：機種設定 ${Object.keys(GAME_SECTIONS).filter(k => cfg[k]).join('、') || '（空）'}${did.length ? `｜已同步 ${did.join('、')}` : '｜agent 已是最新'}`)
  }
  return out
}
// runner 自動學到的選單（1003）→ 寫回機種設定檔（單一來源）。只補「還沒有的」：已經有 menuGate 就不蓋參考圖；已經有 taps 就不蓋座標。
// 回傳這次實際寫了什麼（空陣列＝沒寫）。寫完由呼叫端立刻 syncGameConfigs，同一批後面的台就用得到。
export function persistMenuLearn(type, learn, meta, dir = gameDir(type)) {
  if (!learn || typeof learn !== 'object') return []
  const f = path.join(dir, 'machine-test.json')
  let cfg = { type, updated: '', note: '機台自動化測試的機種設定（單一來源）。/machine-test 開跑前會同步到 agent。' }
  try { cfg = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { /* 新機種：建新檔 */ }
  const did = []
  const stamp = { at: new Date().toISOString(), from: meta?.code ?? null, session: meta?.sessionId ?? null }
  // 點開型（1003 COINCOMBO）：menuGate 先只有 openAt、還沒有參考圖 → 一樣算「還沒有」，學到就補上（保留 openAt）
  if (Array.isArray(learn.region) && learn.region.length === 4 && learn.refPng && !cfg.menuGate?.refRegion && fs.existsSync(learn.refPng)) {
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(learn.refPng, path.join(dir, 'menu-ref.png'))
    cfg.menuGate = { ...(cfg.menuGate ?? {}), refRegion: learn.region, taps: cfg.menuGate?.taps ?? [], refImage: 'menu-ref.png', autoLearned: { ...stamp, what: 'region', note: learn.note } }
    if (learn.openTap) cfg.menuGate.openTap = learn.openTap
    did.push(`選單參考圖＋比對區 [${learn.region.join(',')}]`)
  }
  // 新外觀（1003 多參考圖）：已經有 menuGate、這台一張都沒對上 → 加一張 refs（最多 4 張，含主圖）
  if (learn.variant && Array.isArray(learn.region) && learn.region.length === 4 && learn.refPng && cfg.menuGate && fs.existsSync(learn.refPng) && 1 + (cfg.menuGate.refs ?? []).length < 4) {
    const n = 2 + (cfg.menuGate.refs ?? []).length
    fs.copyFileSync(learn.refPng, path.join(dir, `menu-ref-${n}.png`))
    ;(cfg.menuGate.refs ??= []).push({ image: `menu-ref-${n}.png`, region: learn.region, autoLearned: { ...stamp, note: learn.note } })
    did.push(`選單第 ${n} 張參考圖（新外觀）[${learn.region.join(',')}]`)
  }
  if (Array.isArray(learn.taps) && learn.taps.length && cfg.menuGate && !(cfg.menuGate.taps ?? []).length) {
    cfg.menuGate.taps = learn.taps
    cfg.menuGate.autoLearnedTaps = { ...stamp, note: learn.note }
    did.push(`關選單觸屏格 ${learn.taps.join('、')}`)
  }
  if (did.length) { cfg.updated = stamp.at.slice(0, 10); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n') }
  return did
}
// runner 特殊遊戲卡住救援學到的推進方式（1003）→ 寫回中控機台配置（bonusAction＋touchPoints），先備份、PUT 後讀回核對；
// 同時在機種設定檔記一筆 bonusLearned（來源、OCR 文字、截圖），之後同機種直接用。只在跟現況不同時才寫。
export function bonusProfilePatch(old, learn) {
  if (!learn?.action || !['spin', 'touchscreen'].includes(learn.action)) return null
  const oldTp = Array.isArray(old?.touchPoints) ? old.touchPoints : []
  const addTp = (learn.touchPoints ?? []).filter(p => !oldTp.includes(p))
  if ((old?.bonusAction ?? 'auto_wait') === learn.action && !addTp.length) return null
  return { bonusAction: learn.action, touchPoints: [...oldTp, ...addTp], addTp }
}
async function persistBonusLearn(type, learn, meta, outDir) {
  const prof = await getProfile(type).catch(() => null)
  const patch = bonusProfilePatch(prof, learn)
  if (!patch) return '跟現在的機台配置一樣，不用改'
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, `profile-backup-${type}-${Date.now()}.json`), JSON.stringify({ before: prof, learn, meta }, null, 2))
  const next = { ...(prof ?? { machineType: type }), bonusAction: patch.bonusAction, touchPoints: patch.touchPoints,
    notes: `${prof?.notes ?? ''}\n[auto ${new Date().toISOString().slice(0, 10)}] 特殊遊戲卡住 → OCR 判斷學到 bonusAction=${patch.bonusAction}${patch.addTp.length ? `、觸屏 ${patch.addTp.join('、')}` : ''}（${meta.code}）` }
  const body = Object.fromEntries(PROFILE_FIELDS.map(k => [k, next[k] ?? null]))
  const r = await central('/api/machine-test/profiles', { method: 'PUT', body: JSON.stringify(body) })
  if (r.status !== 200 || !r.json?.ok) return `寫機台配置失敗 ${r.status}`
  const back = await getProfile(type).catch(() => null)
  // 機種設定檔留紀錄（單一來源那份；不參與同步，只是歷史）
  try {
    const f = path.join(gameDir(type), 'machine-test.json')
    let cfg = { type }; try { cfg = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { /* 新檔 */ }
    ;(cfg.bonusLearned ??= []).push({ at: new Date().toISOString(), from: meta.code, session: meta.sessionId, action: learn.action, touchPoints: learn.touchPoints ?? [], ocr: String(learn.ocr ?? '').slice(0, 300), note: learn.note, shots: learn.shots })
    fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n')
  } catch { /* 紀錄失敗不影響 */ }
  return back?.bonusAction === patch.bonusAction ? `已寫入機台配置並讀回核對：bonusAction=${patch.bonusAction}${patch.addTp.length ? `、新增觸屏 ${patch.addTp.join('、')}` : ''}` : '已寫入但讀回不一致，請人工確認'
}
// 退出處理手冊（1003 搬進知識庫，單一來源）：knowledge/machine-test/exit-playbook.json 的 entries → agent server/machine-test/exit-playbook.json（runner 讀陣列）
export const EXIT_PLAYBOOK_SRC = path.join(ROOT, 'knowledge', 'machine-test', 'exit-playbook.json')
// CCTV 構圖 few-shot 範例（1004，使用者：沒拍到完整機台不能算過）：knowledge/machine-test/cctv-framing/good|bad.png → agent cctv-refs/_framing-*.png
export function syncCctvFraming(agentMtDir = path.join(CFG.agentDir, 'server', 'machine-test')) {
  const did = []
  for (const k of ['good', 'bad']) {
    const src = path.join(ROOT, 'knowledge', 'machine-test', 'cctv-framing', `${k}.png`), dst = path.join(agentMtDir, 'cctv-refs', `_framing-${k}.png`)
    if (!fs.existsSync(src)) return `CCTV 構圖範例：缺 ${k}.png，構圖不判`
    if (!fs.existsSync(dst) || !fs.readFileSync(src).equals(fs.readFileSync(dst))) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); did.push(k) }
  }
  return `CCTV 構圖範例：${did.length ? `已同步 ${did.join('、')}` : 'agent 已是最新'}`
}
export function syncExitPlaybook(src = EXIT_PLAYBOOK_SRC, agentMtDir = path.join(CFG.agentDir, 'server', 'machine-test')) {
  let entries
  try { entries = JSON.parse(fs.readFileSync(src, 'utf8')).entries } catch (e) { return `退出處理手冊：讀不到 ${path.basename(src)}（${String(e).slice(0, 60)}），agent 那份不動` }
  if (!Array.isArray(entries)) return '退出處理手冊：格式不對（沒有 entries 陣列），agent 那份不動'
  const dst = path.join(agentMtDir, 'exit-playbook.json')
  const next = JSON.stringify(entries, null, 2) + '\n'
  let cur = null; try { cur = fs.readFileSync(dst, 'utf8') } catch { /* 沒有 */ }
  if (cur === next) return `退出處理手冊：${entries.length} 條，agent 已是最新`
  fs.mkdirSync(agentMtDir, { recursive: true }); fs.writeFileSync(dst, next)
  return `退出處理手冊：${entries.length} 條，已同步到 agent`
}
// 知識庫裡標 ⚠️ 的注意事項：開跑時印出來、放進報告——判讀的人不用自己記得去翻
export function gameNotes(type, max = 8) {
  const f = path.join(gameDir(type), 'interaction-model.md')
  if (!fs.existsSync(f)) return []
  return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(l => /⚠️/.test(l) && /^\s*[-*|]|^\s*⚠️/.test(l))
    .map(l => l.replace(/^\s*[-*]\s*/, '').replace(/\*\*/g, '').trim()).filter(Boolean).slice(0, max)
}

// ── 測試前準備：盒子版號／Machine model／LuckyLink（1003，使用者 hhenghheng 規格）──────────────────
// 機台以 QAT 為主（盒子是 PROD 不變）。gmid 前綴＝OSM 渠道號 → QAT 渠道後台（登入要帶 Origin＝該渠道網域，渠道由 Origin 決定）。
//   盒子：GET backendservertest /egm/floor/egmList?channelId=<渠道> → version（盒子版號）、machineType（＝Machine model，例 moneygong1；使用者 1003 更正，不是 modelName）、onlineState、machineStatus
//         （使用者 1003：只記需要的參數，機櫃廠牌／型號不記）
//   LuckyLink：QAT luckylink-backendserver POST /slot/egmList → sasversion（601/602＝SAS、g2s、mml、空＝沒接）、clientversion（＝畫面上的 Protocol Version）、
//              isactive（Authorize 狀態）、state（Login Status）、groupName（Progressive Group）
// 不回寫 Lark；結果印在開跑前檢查、放進 report，跟使用者給的預期值不符就提醒。
export const QAT_CHANNEL_HOST = { 873: 'qat-cp', 888: 'qat-wf', 890: 'qat-tbr', 891: 'qat-tbp', 892: 'qat-nc', 893: 'qat-bpo', 894: 'qat-mdr', 895: 'qat-dhs', 896: 'qat-cf', 897: 'qat-np', 898: 'qat-pf', 900: 'qat-dy', 920: 'qat-igo' }
export const llProtocol = sasv => { const v = String(sasv ?? '').toLowerCase(); return /^6\d\d$/.test(v) ? 'SAS' : v === 'g2s' ? 'G2S' : v === 'mml' ? 'MML' : v ? v.toUpperCase() : '' }
async function fetchBoxInfo(channel) {
  const host = QAT_CHANNEL_HOST[channel]
  if (!host) return { err: `渠道 ${channel} 不在 QAT 渠道表` }
  const B = 'https://backendservertest.osmslot.org', O = `https://${host}.osmslot.org`
  const h = { 'content-type': 'application/json', accept: 'application/json, text/plain, */*', origin: O, referer: O + '/' }
  const lj = await (await fetch(B + '/auth/login', { method: 'POST', headers: h, body: JSON.stringify({ username: 'admin', password: secret('MT_QAT_BACKEND_PASSWORD', 'qatBackendPassword') }) })).json().catch(() => null)
  if (!lj?.data?.token) return { err: `${host} 後台登入失敗（${lj?.code ?? '?'} ${lj?.message ?? ''}）` }
  const j = await (await fetch(`${B}/egm/floor/egmList?page=1&pageSize=3000&isShowClient=1&searchName=&gameNameId=0&bgType=0&channelId=${channel}`, { headers: { ...h, token: lj.data.token } })).json().catch(() => null)
  if (j?.code !== 20000) return { err: `${host} EGM List 讀取失敗（${j?.code ?? '?'} ${j?.message ?? ''}）` }
  return { host, map: new Map((j.data.items ?? []).map(x => [x.machineName, x])) }
}
async function fetchLuckyLinkInfo() {
  const B = 'https://luckylink-backendserver.osmslot.org', O = 'https://luckylink-backendtest.osmslot.org'
  const h = { 'content-type': 'application/json', origin: O, referer: O + '/' }
  const lj = await (await fetch(B + '/auth/login', { method: 'POST', headers: h, body: JSON.stringify({ username: 'admin', password: secret('MT_LUCKYLINK_BACKEND_PASSWORD', 'luckyLinkBackendPassword') }) })).json().catch(() => null)
  if (!lj?.data?.token) return { err: 'LuckyLink QAT 登入失敗' }
  const j = await (await fetch(`${B}/slot/egmList?token=${lj.data.token}&clientversion=1.0.6.6`, { method: 'POST', headers: h, body: JSON.stringify({ channelId: '', machineNumber: '', serialNumber: '', groupName: '', page: 1, pageSize: 10000 }) })).json().catch(() => null)
  const items = j?.data?.items
  if (!Array.isArray(items)) return { err: 'LuckyLink Egm list 讀取失敗' }
  return { map: new Map(items.map(x => [String(x.gmid).toUpperCase(), x])) }
}
// 純函式（探針測）：一台的資訊 → 列＋與預期值的差異
export function judgeMachineInfo(code, box, ll, expect = {}) {
  const proto = ll ? llProtocol(ll.sasversion) : ''
  const linked = !!(ll && proto && ll.isactive)
  const row = {
    code, boxVer: box?.version ?? null, model: box?.machineType ?? null,
    online: box?.onlineState ?? null, status: box?.machineStatus ?? null,
    llListed: !!ll, llLinked: linked, llProtocol: proto || null, llVer: ll?.clientversion || null,
    llAuthorized: ll ? !!ll.isactive : null, llOnline: ll ? !!ll.state : null, llGroup: ll?.groupName || null,
  }
  const issues = []
  const eq = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase()
  if (!box) issues.push('後台 EGM List 查不到這台')
  else if (box.onlineState !== 'online') issues.push(`盒子 ${box.onlineState ?? '狀態不明'}`)
  if (expect.machineVer && !eq(row.boxVer, expect.machineVer)) issues.push(`盒子版號 ${row.boxVer ?? '查不到'}，預期 ${expect.machineVer}`)
  if (expect.machineModel && !eq(row.model, expect.machineModel)) issues.push(`Machine model ${row.model ?? '查不到'}，預期 ${expect.machineModel}`)
  if (expect.luckylink === 'yes' && !linked) issues.push(ll ? `LuckyLink 沒接上（${proto || '沒有協議'}、${ll.isactive ? '已授權' : '未授權'}${row.llGroup ? '' : '、沒有群組'}），預期有接` : 'LuckyLink Egm list 沒有這台，預期有接')
  if (expect.luckylink === 'no' && linked) issues.push(`LuckyLink 有接（${proto}），預期沒接`)
  if (expect.llProtocol && !eq(proto, expect.llProtocol)) issues.push(`LuckyLink 協議 ${proto || '無'}，預期 ${expect.llProtocol}`)
  if (expect.llVer && !eq(row.llVer, expect.llVer)) issues.push(`LuckyLink 版本 ${row.llVer ?? '無'}，預期 ${expect.llVer}`)
  return { row, issues }
}
export async function preTestCheck(codes, expect = {}) {
  const chans = [...new Set(codes.map(c => c.split('-')[0]))]
  const boxes = Object.fromEntries(await Promise.all(chans.map(async ch => [ch, await fetchBoxInfo(ch)])))
  const ll = await fetchLuckyLinkInfo()
  const errs = [...Object.values(boxes).filter(b => b.err).map(b => b.err), ...(ll.err ? [ll.err] : [])]
  const rows = codes.map(c => judgeMachineInfo(c, boxes[c.split('-')[0]]?.map?.get(c) ?? null, ll.map?.get(c.toUpperCase()) ?? null, expect))
  // 同一批不一致也提醒（沒給預期值時特別有用）
  const distinct = k => [...new Set(rows.map(r => r.row[k]).filter(v => v != null && String(v).trim() !== ''))]   // 離線的台版號是空字串，不算「不一致」
  const batchWarn = [['boxVer', '盒子版號'], ['model', 'Machine model'], ['llProtocol', 'LuckyLink 協議'], ['llVer', 'LuckyLink 版本']]
    .filter(([k]) => distinct(k).length > 1).map(([k, n]) => `同一批${n}不一致：${distinct(k).join('／')}`)
  return { rows, errs, batchWarn, expect }
}
export function preTestLines(p) {
  const out = []
  for (const { row: r, issues } of p.rows) {
    out.push(`${r.code}｜盒子 ${r.boxVer ?? '—'}｜model ${r.model ?? '—'}｜${r.online ?? '—'}/${r.status ?? '—'}｜LuckyLink ${r.llLinked ? `有接 ${r.llProtocol} ${r.llVer ?? ''}`.trim() : r.llListed ? `沒接（${r.llProtocol ?? '無協議'}、${r.llAuthorized ? '已授權' : '未授權'}${r.llGroup ? `、群組 ${r.llGroup}` : '、無群組'}）` : 'Egm list 沒有這台'}${issues.length ? `｜⚠️ ${issues.join('；')}` : ''}`)
  }
  return out
}

// ── 進場失敗時查盒子 log 的 AFT 轉入結果（1003，使用者：「怎麼是寫 entry fail，而不是 AFT error？」）──────
// 1567 實例：enterGMNtc errcode=0、但 8 秒沒進遊戲；盒子 log 同時間有 aft_in_end success=false state=87（SAS 87h＝機台無法轉帳）。
// 盒子時間是 UTC+8 的 HH:MM:SS、時鐘比我們快約 2 分鐘 → 比對窗口放寬到進場前 1 分～結束後 6 分。
export const uidOfLobby = url => { try { return new URL(url).searchParams.get('token')?.split('-').at(-1) ?? null } catch { return null } }
export function findAftFailure(timeline, { uid, fromMs, toMs, date }) {
  for (const e of timeline ?? []) {
    if (e?.type !== 'aft_in_end' || String(e.userid) !== String(uid) || e.data?.success !== false) continue
    const t = Date.parse(`${date}T${e.time}+08:00`)
    if (t >= fromMs && t <= toMs) return { state: String(e.data?.state ?? '?'), time: e.time }
  }
  return null
}
export async function lookupAftFailure(code, uid, startedAt, finishedAt) {
  const fromMs = Date.parse(startedAt) - 60_000, toMs = Date.parse(finishedAt ?? startedAt) + 6 * 60_000
  const dates = [...new Set([fromMs, toMs].map(ms => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10)))]
  for (const date of dates) {
    try {
      const j = await (await fetch(`https://prod-osmtrace.osmslot.org/api/machine/daily-analysis?gmid=${encodeURIComponent(code)}&date=${date}`)).json()
      const hit = findAftFailure(j?.data?.timeline, { uid, fromMs, toMs, date })
      if (hit) return hit
    } catch { /* 查不到就不補，維持 entry fail */ }
  }
  return null
}

// ── 帳號卡住 → 換帳號續跑（2026-10-03，使用者 hhenghheng 要求：「不希望有停批的動作」）───────────
// runner 退出連續 3 次失敗且看不出遊戲進行中 → 回「退出異常（帳號卡在這台）」並停掉這個帳號後面的台。
// batch 這邊：把卡住的帳號留在原地（等使用者指示），從帳號池挑下一個「沒人宣告使用、沒被工具綁著、在大廳」的帳號跑剩下的台。
// 使用者 1003：帳號池裡的帳號都能用。仍跳過 claimed／assigned，避免撞到別人正在用的。
export const STUCK_RE = /退出異常（帳號卡在這台）/
export const stuckMachineOf = errors => (errors ?? []).map(e => String(e).match(/(\d{3}-[A-Z0-9-]+-\d{4}) 退出異常（帳號卡在這台）/)?.[1]).find(Boolean) ?? null
export function pickNextAccount(pool, { claims = {}, assigned = {}, exclude = [] } = {}) {
  return pool.find(p => !exclude.includes(p.username) && !claims[p.account] && !assigned[p.username]) ?? null
}
const CLAIM_BY = 'machine-test-batch (Claude)'
export function loadUrlPool() {
  const f = process.env.MT_URL_POOL_FILE ?? path.join(SCRIPT_DIR, '..', '..', 'src', 'data', 'urlPoolData.ts')
  const src = fs.readFileSync(f, 'utf8')
  return [...src.matchAll(/account:\s*'(\d+)',\s*username:\s*'([^']+)',[^}]*?url:\s*'([^']+)'/g)].map(m => ({ account: m[1], username: m[2], url: m[3] }))
}
// 換帳號：挑一個 → claim → 確認在大廳（唯讀，坐著的不幫人退）→ 不行就 release 換下一個
async function switchAccount(exclude) {
  const pool = loadUrlPool()
  const overrides = (await central('/api/url-pool/overrides')).json ?? {}
  const claims = (await central('/api/url-pool/status')).json ?? {}
  const assigned = (await central('/api/url-pool/assigned')).json?.assigned ?? {}
  const tried = [...exclude]
  for (let i = 0; i < 8; i++) {
    const acc = pickNextAccount(pool, { claims, assigned, exclude: tried })
    if (!acc) return null
    tried.push(acc.username)
    const url = overrides[acc.account] ?? acc.url
    // 1003 實測帳號池資料：osmel141 那筆的 URL 其實是 atestcppp06——登進去的是別人的帳號。URL 上的 username 跟欄位不符就跳過
    let urlUser = null
    try { urlUser = new URL(url).searchParams.get('username') } catch { /* 壞 URL */ }
    if (urlUser !== acc.username) { log(`換帳號：${acc.username} 的 URL 實際是 ${urlUser ?? '（解析不了）'}，跳過`); continue }
    const c = await central(`/api/url-pool/${acc.account}/claim`, { method: 'POST', body: JSON.stringify({ claimedBy: CLAIM_BY }) })
    if (c.status !== 200) { log(`換帳號：${acc.username} 借不到（${c.status}），換下一個`); continue }
    const lobby = await checkLobby(url, true)
    if (lobby.ok) { log(`換帳號：借到 ${acc.username}（帳號池 ${acc.account}，在大廳）`); return { ...acc, url } }
    log(`換帳號：${acc.username} ${lobby.note}，歸還換下一個`)
    await central(`/api/url-pool/${acc.account}/release`, { method: 'POST', body: JSON.stringify({ claimedBy: CLAIM_BY }) })
  }
  return null
}

// ── agent 斷線自動續跑（2026-09-30，使用者 hhenghheng 要求）─────────────────────
// 0930 實況：agent 推 feature 時斷線幾秒又連回來，但整批 session 已經掉了，剩下 20 台直接「沒收到結果」收工，
// 當時手動做了四件事才能續跑：殺 agent 留下的孤兒瀏覽器（它還拿著帳號登入）→ 等 agent 回來 → 清中控殘留的重任務鎖（不然 429）→ 帳號退座位。
// 這裡把同一套做成自動。只有「因為 agent 斷線」才續跑；🛑 停批（盲推上限、Handpay、退出受阻…）與使用者手動停止都**不**續跑。
export function resumeDecision({ errors, missing, recoveries, max = 2 }) {
  if (!missing) return { resume: false, reason: '全部都有結果' }
  if ((errors ?? []).some(e => /🛑/.test(e))) return { resume: false, reason: '本批有 🛑 停批（需人工處理），不自動續跑' }
  if (!(errors ?? []).some(e => /已斷線/.test(e))) return { resume: false, reason: '不是 agent 斷線（可能是手動停止），不自動續跑' }
  if (recoveries >= max) return { resume: false, reason: `已自動續跑 ${recoveries} 次仍斷線，不再重試` }
  return { resume: true, reason: `agent 斷線、剩 ${missing} 台沒結果 → 自動續跑（第 ${recoveries + 1} 次）` }
}
// 續跑前的復原流程（CodeX 0930 第二輪補的五個缺口都在這裡守）。依賴全部注入 → scripts/machine-test-resume-probe.mjs 用假依賴模擬各種失敗。
// 任何一步不確定就**停**（回 ok:false），寧可交給人工，也不要在舊 runner 可能還在下注時再開一輪。
//   ① 停止請求（每一步前後都查）  ② 整個舊 agent 關掉並確認沒有殘留程序（斷線可能只是網路斷，舊 runner 還在跑）
//   ③ 只殺真正的孤兒瀏覽器（Playwright chrome 且 parent 已不存在）  ④ 鎖：查不到就停；是自己這批的才清；清完再查一次確認
//   ⑤ 對帳：先拿中控存下來的舊 session 結果，已有結果的台不重跑（避免漏傳造成重複下注）；對帳查不到就停
//   ⑥ 帳號退座位（要 leaveGMNtc errcode=0）  ⑦ 開全新的 agent
// CodeX 0930 第三輪：鎖歸屬不能靠時間戳猜——要中控明確回報 lockKey（v4.261.0 起 /api/machine-test/start 會把 session id 綁進鎖）
// 等於舊 session 才算本批的；沒有 lockKey（中控還沒更新）一律不認，交給人工
export function lockOwnedBy(task, sid) {
  return !!task?.lockKey && !!sid && task.lockKey === sid
}
export async function runRecovery(d) {
  const stop = note => ({ ok: false, note })
  if (d.stopRequested()) return stop('收到停止請求')
  const killed = await d.killAgentProcs()
  d.log(`續跑準備 ②關掉舊 agent：${killed} 個程序`)
  if ((await d.agentProcsAlive()) > 0) return stop('舊 agent 程序關不掉（可能還在下注），不續跑')
  d.log(`續跑準備 ③孤兒瀏覽器：關掉 ${await d.killOrphans()} 個`)
  const g = await d.getMyLock()
  if (!g.ok) return stop('查不到重任務鎖狀態，無法確認能不能開新一輪')
  if (g.task && g.task.status === 'running') {
    if (g.task.type !== 'machine-test' || !lockOwnedBy(g.task, d.oldSid)) return stop(g.task.lockKey ? `帳號上的重任務鎖屬於別的 session（${g.task.lockKey}），不清` : `殘留鎖 ${g.task.id} 沒有 session 歸屬（中控未回報 lockKey），無法確認是本批的，不清`)
    if (!(await d.forceClear(g.task.id))) return stop(`清殘留鎖 ${g.task.id} 失敗`)
    const g2 = await d.getMyLock()
    if (!g2.ok || (g2.task && g2.task.status === 'running')) return stop(`清完鎖再查仍在（或查不到）：${g.task.id}`)
    d.log(`續跑準備 ④清掉本批殘留鎖 ${g.task.id}`)
  } else d.log('續跑準備 ④沒有殘留鎖')
  const old = await d.fetchOldResults()
  if (!old.ok) return stop('查不到舊 session 在中控存的結果，無法對帳（可能重複下注），不續跑')
  d.log(`續跑準備 ⑤對帳：舊 session 中控已有 ${old.results.size} 台結果`)
  if (d.stopRequested()) return stop('收到停止請求')
  const seat = await d.clearSeat()
  d.log(`續跑準備 ⑥帳號座位：${seat.note}`)
  if (!seat.ok) return stop(seat.note)
  if (d.stopRequested()) return stop('收到停止請求')
  const agent = await d.startAgent()
  d.log(`續跑準備 ⑦新 agent：${agent.agentId}`)
  if (d.stopRequested()) return stop('收到停止請求')
  return { ok: true, agent, adopted: old.results }
}
// ── runRecovery 的實際依賴（Windows）──
// 查程序一律「遇錯就丟例外」：PowerShell 錯誤或輸出不是數字 → 不能當成 0（CodeX：查詢失敗不能當隔離成功）
const psRun = ps => execFileSync('powershell.exe', ['-NoProfile', '-Command', `$ErrorActionPreference = 'Stop'; ${ps}`], { encoding: 'utf8', timeout: 60000 }).trim()
const psCount = ps => { const o = psRun(ps); if (!/^\d+$/.test(o)) throw new Error(`PowerShell 回傳不是數字：${o.slice(0, 80)}`); return Number(o) }
const agentProcFilter = () => `? { $_.Name -eq 'node.exe' -and $_.CommandLine -match [regex]::Escape('${path.basename(CFG.agentDir).replace(/'/g, '')}') }`
// 停止請求：Discord 的停止按鈕／使用者說停 → 建立這個檔案；中控 stop API 在復原期間沒有 session 可停，所以另外用檔案
export const STOP_FILE = path.join(ROOT, 'reports', 'machine-test-STOP')
function realRecoveryDeps(lobbyUrl, oldSid) {
  return {
    oldSid, log,
    stopRequested: () => fs.existsSync(STOP_FILE),
    killAgentProcs: async () => { const n = psCount(`$p = @(Get-CimInstance Win32_Process | ${agentProcFilter()}); foreach ($x in $p) { try { taskkill /PID $x.ProcessId /T /F 2>&1 | Out-Null } catch {} }; $p.Count`); await sleep(3000); return n },
    agentProcsAlive: async () => psCount(`@(Get-CimInstance Win32_Process | ${agentProcFilter()}).Count`),
    // 孤兒＝Playwright 的 chrome 主程序、而它的 parent 程序已經不存在（使用者自己 agent 的 chrome parent 還活著，不會被殺）
    killOrphans: async () => psCount(`$all = @(Get-CimInstance Win32_Process); $ids = $all | % { $_.ProcessId }; ` +
      `$o = @($all | ? { $_.Name -eq 'chrome.exe' -and $_.CommandLine -match 'ms-playwright' -and $_.CommandLine -notmatch '--type=' -and $ids -notcontains $_.ParentProcessId }); ` +
      // taskkill /T 會連子程序一起殺，清單後面的子程序可能已經不在 → 找不到程序的錯誤要吞掉（1002 實測整個續跑因此中止）；有沒有殺乾淨由下一步 agentProcsAlive 驗
      `foreach ($x in $o) { try { taskkill /PID $x.ProcessId /T /F 2>&1 | Out-Null } catch {} }; $o.Count`),
    getMyLock: async () => { const r = await central('/api/heavy-tasks/me'); return r.status === 200 && r.json?.ok ? { ok: true, task: r.json.task ?? null } : { ok: false } },
    forceClear: async id => { const r = await central(`/api/heavy-tasks/${id}/force-clear`, { method: 'POST' }); return r.status === 200 && r.json?.ok === true },
    fetchOldResults: async () => {
      const r = await central(`/api/machine-test/machine-results?account=${encodeURIComponent(CFG.email)}&limit=200`)
      if (r.status !== 200 || !r.json?.ok) return { ok: false }
      // CodeX 0930：只拿最新 200 筆，要確認有涵蓋到舊 session 開始的時間，否則「沒看到結果」不代表沒跑完 → 停
      const rows = r.json.results ?? [], sidMs = Number(String(oldSid).split('_')[1])
      const ms = t => (Number(t) < 1e12 ? Number(t) * 1000 : Number(t))
      if (rows.length >= 200 && Math.min(...rows.map(x => ms(x.tested_at))) > sidMs) return { ok: false, note: '最新 200 筆沒有涵蓋到舊 session 開始的時間' }
      const results = new Map()
      for (const x of r.json.results ?? []) if (x.session_id === oldSid && !results.has(x.machine_code)) results.set(x.machine_code, { machineCode: x.machine_code, overall: x.overall, steps: x.steps, sessionId: oldSid, fromCentralHistory: true })
      return { ok: true, results }
    },
    clearSeat: () => checkLobby(lobbyUrl, false),
    startAgent,
  }
}

async function waitIdle() {
  for (let i = 0; i < 40; i++) { const st = await status(); const a = myAgent(st); if (!st?.active && a && !a.busy) return a; await sleep(3000) }
  throw new Error('等 agent 回到閒置逾時（2 分鐘）')
}

// ── 主程式 ────────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2)
  const arg = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d }
  const flag = k => argv.includes(`--${k}`)

  // 只重試回寫
  const retryFile = arg('retry-writeback')
  if (retryFile) {
    const s = JSON.parse(fs.readFileSync(retryFile, 'utf8'))
    const sheet = parseSheetUrl(s.sheet)
    // 0930 CodeX：不能沿用 summary 裡的舊列號／欄位字母——有人插列、排序或搬欄就會寫錯列。補寫前重讀，用 gmid 對位；
    // F 已被人改成別的內容（不是開跑前的舊值、也不是本批要寫的值）→ 視為現場已接手，不覆蓋（0930 實例：0244 aft error、0264 spin no response.）
    const fresh = await readSheet(sheet)
    const byCode = new Map(fresh.rows.map(r => [r.code, r]))
    const norm = v => String(v ?? '').replace(/^null$/, '').trim()
    for (const m of s.machines.filter(x => x.larkLine && !wbDone(x))) {
      const cur = byCode.get(m.code)
      if (!cur) { log(`重試回寫 ${m.code}：表上找不到這台 gmid，跳過`); continue }
      if (cur.row !== m.row) { log(`重試回寫 ${m.code}：列號變了 ${m.row} → ${cur.row}，改寫到新位置`); m.row = cur.row }
      const curF = norm(cur.F)
      if (curF && curF !== norm(m.oldF) && curF !== m.larkLine) { log(`重試回寫 ${m.code}：F 已被改成「${curF.slice(0, 40)}」（非本批寫入），不覆蓋`); continue }
      await writeBack(sheet, fresh.letters, m, s.date.slice(5, 10))
      log(`重試回寫 ${m.code}：${JSON.stringify(m.writeback)}`); saveSummary(retryFile, s)
    }
    if (!flag('no-report')) { const { buildReport } = await import('./machine-test-report.mjs'); fs.writeFileSync(path.join(path.dirname(retryFile), 'report.html'), await buildReport(s)) }
    console.log(`SUMMARY ${retryFile}`)
    return 0
  }

  // 只重試 learn 的 profile 寫入（不重跑機台）：沿用 summary 裡的 plan，寫入保護照舊（開跑快照 ≠ 現況就中止）
  //   --retry-learn <summary.json>
  const learnFile = arg('retry-learn')
  if (learnFile) {
    const s = JSON.parse(fs.readFileSync(learnFile, 'utf8'))
    if (!s.learn?.plan?.ok) { console.log('ERROR summary 沒有可寫的 learn plan'); return 2 }
    if (flag('dry-run')) { console.log(`DRY-RUN 會寫入 ${s.learn.type}：${s.learn.plan.changes.join('；')}`); return 0 }
    // 只有「寫入且讀回一致」才算完成；寫了但讀回衝突 → 不重寫（避免蓋掉別人），回非 0 交人工
    if (s.learn.apply?.applied && !s.learn.apply.conflict) { console.log('learn 已寫入過，不重複寫'); return 0 }
    if (s.learn.apply?.applied) { console.log('ERROR 上次已寫入但讀回衝突，請人工確認 profile，不自動重寫'); return 1 }
    await login()
    s.learn.apply = await applyLearn(s.learn.type, s.learn.before, s.learn.plan, path.dirname(learnFile), { code: s.machines[0]?.code, sessionId: s.sessionId })
    log(`重試 learn ${s.learn.type}：${JSON.stringify(s.learn.apply).slice(0, 300)}`); saveSummary(learnFile, s)
    if (!flag('no-report')) { const { buildReport } = await import('./machine-test-report.mjs'); fs.writeFileSync(path.join(path.dirname(learnFile), 'report.html'), await buildReport(s)) }
    console.log(`SUMMARY ${learnFile}`)
    return s.learn.apply.applied && !s.learn.apply.conflict ? 0 : 1
  }

  // Claude 看完裁切圖後補寫方向判讀：只重寫 F 欄（整格重組，不會重複附加）、更新報告；不動 J
  //   --set-orientation <summary.json> --machine <代碼> --status pass|fail|check|na --note "<依據>" [--codex "<CodeX 判讀>"]
  const setFile = arg('set-orientation')
  if (setFile) {
    const s = JSON.parse(fs.readFileSync(setFile, 'utf8'))
    const m = s.machines.find(x => x.code === arg('machine') || x.code.endsWith('-' + arg('machine')))
    const st = arg('status')
    if (!m || !['pass', 'fail', 'check', 'na'].includes(st)) { console.log('ERROR 找不到機台或 status 不是 pass|fail|check|na'); return 2 }
    // FAIL 必須有 CodeX 獨立確認（兩個不同模型一致才算倒轉）
    if (st === 'fail' && !arg('codex')) { console.log('ERROR 判 FAIL 需要帶 --codex（CodeX 獨立判讀結果）；還沒確認就先用 check'); return 2 }
    m.orientation = { ...(m.orientation ?? {}), status: st, note: arg('note') ?? '', codex: arg('codex') ?? null, reviewedBy: 'claude', reviewedAt: new Date().toISOString(), shadow: true }
    if (m.larkLine) {
      const prevLine = m.larkLine
      if (m.result) m.larkLine = shortLine(m.result, { J: m.J, verdict: m.verdict }, m.orientation, s.steps)
      if (m.detailLine) m.detailLine = m.detailLine.replace(/ \| 方向\(影子[^)]*\): .*$/, '') + ` | 方向(影子，人工判讀): ${st.toUpperCase()} ${m.orientation.note.slice(0, 100)}`
      // 0930：原本直接用 summary 的舊列號整列重寫，沒重讀表——summary 若不是最新（之後又回填／現場手改）就會蓋回去。
      // 改成跟 --retry-writeback 同一套：重讀表、gmid 對位、F 不是本 summary 寫的值（也不是開跑前舊值）就不動；F 沒變就不寫。
      if (flag('no-writeback') || s.noWriteback || !m.writeback) log(`不回寫 Lark（${flag('no-writeback') ? '--no-writeback' : '本批不回寫'}）：${m.code}`)
      else if (m.larkLine === prevLine) log(`F 欄不變（方向 ${st} 不影響 F），不回寫：${m.code}`)
      else {
        const sheet = parseSheetUrl(s.sheet)
        const fresh = await readSheet(sheet)
        const cur = fresh.rows.find(r => r.code === m.code)
        const curF = String(cur?.F ?? '').replace(/^null$/, '').trim()
        if (!cur) log(`表上找不到 ${m.code}，不回寫`)
        else if (curF && curF !== prevLine && curF !== String(m.oldF ?? '').trim()) log(`F 已被改成「${curF.slice(0, 40)}」（不是這份 summary 寫的），不覆蓋：${m.code}`)
        else { m.row = cur.row; m.writeback.F = undefined; await writeBack(sheet, fresh.letters, m, s.date.slice(5, 10)); log(`F 欄重寫 ${m.code}：${m.writeback.F}`) }
      }
    }
    saveSummary(setFile, s)
    if (!flag('no-report')) { const { buildReport } = await import('./machine-test-report.mjs'); fs.writeFileSync(path.join(path.dirname(setFile), 'report.html'), await buildReport(s)) }
    console.log(`SUMMARY ${setFile}`)
    return 0
  }

  const sheetUrl = arg('sheet')
  if (!sheetUrl) { console.log('用法：node machine-test-batch.mjs --sheet "<Lark 網址>" [--machines 0069-0078] [--steps all] [--dry-run] [--no-trial]'); return 2 }
  const stepsArg = arg('steps', 'all')
  // --learn：單台跑完整八項，學到的寫進機種 profile；不回寫 Lark（學習不是驗收）
  const LEARN = flag('learn')
  const stepList = LEARN || stepsArg === 'all' ? ALL_STEPS : stepsArg.split(',').map(s => s.trim()).filter(s => ALL_STEPS.includes(s))
  const DRY = flag('dry-run'), NO_WB = LEARN || flag('no-writeback'), NO_TRIAL = flag('no-trial')

  const sheet = parseSheetUrl(sheetUrl)
  const { letters, rows } = await readSheet(sheet)
  const targets = pickMachines(rows, arg('machines'))
  if (!targets.length) { console.log(`ERROR 找不到要測的機台（Lark 有 gmid 的列：${rows.length}；--machines=${arg('machines') ?? '全部'}）`); return 1 }
  if (LEARN && targets.length !== 1) { console.log(`ERROR learn 模式只能指定一台機台（這次選到 ${targets.length} 台：${targets.map(t => t.code).join(', ')}）`); return 2 }
  const codes = targets.map(t => t.code)
  log(`Lark：${targets.length} 台（${codes[0]} … ${codes.at(-1)}），測項：${stepList.join(',')}${DRY ? '，dry-run（唯讀）' : ''}${LEARN ? '，learn（學習 → 寫機種 profile，不回寫 Lark）' : ''}`)

  await login()
  // --probe-switch：只實跑「換帳號」這一步（借 → 確認在大廳 → 歸還），不跑機台。驗證帳號池／claim／大廳檢查是通的
  if (flag('probe-switch')) {
    const cur = new URL(fs.readFileSync(CFG.lobbyFile, 'utf8').trim()).searchParams.get('username')
    const acc = await switchAccount([cur])
    if (acc) { await central(`/api/url-pool/${acc.account}/release`, { method: 'POST', body: JSON.stringify({ claimedBy: CLAIM_BY }) }); log(`probe-switch：借到 ${acc.username} 並已歸還`) }
    else log('probe-switch：沒借到帳號')
    return acc ? 0 : 1
  }
  const pre = { problems: [], notes: [] }
  // learn 要拿這份當寫入保護的快照 → 讀失敗就停；一般批次只拿來做開跑前提示，讀不到照舊放行
  const profiles = LEARN ? await listProfiles() : ((await central('/api/machine-test/profiles')).json?.profiles ?? [])
  // learn：開跑時的 profile 快照，寫入前拿來比對「期間有沒有人改過」
  const learnType = LEARN ? machineTypeOf(targets[0].code) : null
  const learnSnap = LEARN ? profiles.find(x => x.machineType.toUpperCase() === learnType) ?? null : null
  for (const t of [...new Set(codes.map(c => c.split('-').slice(1, -1).join('-').toUpperCase()))]) {
    const p = profiles.find(x => x.machineType.toUpperCase() === t)
    if (!p) { pre.problems.push(`機種 ${t} 沒有機台配置（FG/JP 啟動方式、iDeck、觸屏會用預設或跳過）`); continue }
    const tp = Array.isArray(p.touchPoints) ? p.touchPoints : (() => { try { return JSON.parse(p.touchPoints ?? '[]') } catch { return [] } })()
    pre.notes.push(`機種 ${t}：FG/JP 啟動方式 bonusAction=${p.bonusAction}；觸屏 ${tp.length ? tp.length + ' 格' : '未設定 → 觸屏步驟會自動偵測格子（找不到才算未驗）'}`)
  }
  // 機種知識（1003）：設定檔同步到 agent（dry-run 只讀不同步）＋ ⚠️ 注意事項印出來、放進報告
  const gameTypes = [...new Set(codes.map(machineTypeOf))]
  pre.notes.push(...(DRY
    ? gameTypes.map(t => fs.existsSync(path.join(gameDir(t), 'machine-test.json')) ? `${t}：有本機機種知識檔（dry-run 不同步）` : `${t}：沒有本機機種知識檔 machine-test.json（選單閘門／觸屏視覺走自動偵測；中控 profile 另計）`)
    : [...syncGameConfigs(gameTypes), syncExitPlaybook(), syncCctvFraming()]))
  const gameNoteMap = Object.fromEntries(gameTypes.map(t => [t, gameNotes(t)]))
  for (const [t, ns] of Object.entries(gameNoteMap)) if (ns.length) log(`機種知識 ${t}（⚠️ 注意事項 ${ns.length} 條）：\n  - ${ns.join('\n  - ')}`)
  // 測試前準備（1003）：盒子版號／model／LuckyLink，跟使用者給的預期值比；不擋開跑、不回寫 Lark，只提醒＋寫報告
  const expect = { machineVer: arg('machine-ver', ''), machineModel: arg('machine-model', ''), luckylink: String(arg('luckylink', '')).toLowerCase(), llVer: arg('ll-ver', ''), llProtocol: String(arg('ll-protocol', '')).toUpperCase() }
  const preTest = await preTestCheck(codes, expect).catch(e => ({ rows: [], errs: [`測試前準備查詢失敗：${String(e).slice(0, 120)}`], batchWarn: [], expect }))
  const ptIssues = preTest.rows.filter(r => r.issues.length).length
  log(`測試前準備（盒子／LuckyLink，${preTest.rows.length} 台${Object.values(expect).some(Boolean) ? `，預期 ${Object.entries(expect).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' ')}` : '，沒給預期值只列出'}）${ptIssues || preTest.batchWarn.length || preTest.errs.length ? ` ⚠️ ${ptIssues} 台不符` : ' ✅'}：\n  ${[...preTestLines(preTest), ...preTest.batchWarn.map(w => `⚠️ ${w}`), ...preTest.errs.map(e => `⚠️ ${e}`)].join('\n  ')}`)
  const osm = (await central('/api/machine-test/osm-status')).txt
  const unmon = codes.filter(c => !osm.includes(`"${c}"`))
  if (unmon.length) pre.problems.push(`不在影像辨識監控內（FG/JP 偵測不到）：${unmon.join(', ')}`)
  let st = await status()
  let agent = myAgent(st)
  if (st?.active) pre.problems.push('中控目前有進行中的測試 session')
  if (!agent) pre.notes.push(DRY ? '本機 agent 不在線（正式執行時會自動啟動）' : '本機 agent 不在線，將自動啟動')
  else if (agent.busy) pre.problems.push(`agent ${agent.agentId} 忙碌中`)
  else pre.notes.push(`agent ${agent.agentId} 在線、閒置`)
  // --env uat → 換成 UAT 帳號的大廳 URL（機台 log API UAT 也是用 prod，所以 osmEnv 不動）
  const env = String(arg('env', 'prod')).toLowerCase()
  const lobbyFile = process.env.MT_LOBBY_FILE ? CFG.lobbyFile : env === 'uat' ? path.join(ROOT, 'config', 'machine-test-lobby-url-uat.txt') : CFG.lobbyFile
  const lobbyUrl = fs.readFileSync(lobbyFile, 'utf8').trim()
  pre.notes.push(`帳號環境 ${env.toUpperCase()}（${new URL(lobbyUrl).host}，${new URL(lobbyUrl).searchParams.get('username')}）`)
  const busyElsewhere = st?.active || agent?.busy
  const lobby = busyElsewhere ? { ok: false, note: '有任務進行中，不檢查／不清理帳號座位' } : await checkLobby(lobbyUrl, DRY)
  ;(lobby.ok || (DRY && lobby.seated) ? pre.notes : pre.problems).push(lobby.note)
  log('開跑前檢查：', JSON.stringify(pre))

  const reportsDir = path.join(ROOT, 'reports')
  fs.mkdirSync(reportsDir, { recursive: true })
  const blocking = pre.problems.filter(p => /session|忙碌|請人工|座位/.test(p))
  if (DRY || blocking.length) {
    const f = path.join(reportsDir, `machine-test-preflight-${Date.now()}.json`)
    saveSummary(f, { dryRun: DRY, blocked: blocking, sheet: sheetUrl, codes, rows: targets.map(t => ({ code: t.code, row: t.row })), steps: stepList, preflight: pre, preTest })
    console.log(`SUMMARY ${f}`)
    return DRY ? 0 : 1
  }
  // 上一批留下的停止請求不能影響這一批——但一定要在**任何 session 發送之前**清（CodeX 0930：原本放在整批發動之後，
  // 發動後到清檔之間收到的新停止請求會被一起刪掉）。探針 machine-test-resume-probe 有檢查這個順序。
  try { fs.rmSync(STOP_FILE, { force: true }) } catch { /* 沒有就算了 */ }
  if (!agent) agent = await startAgent()

  // 單台試跑：進入＋退出
  if (!NO_TRIAL) {
    // 1003 COINCOMBO：第一台 0208 在 maintain／Occupied → 試跑失敗整批不跑。試跑是驗「帳號＋工具走得通」，
    // 所以挑盒子 online/normal、有在影像辨識監控的台；失敗原因是「這台本身進不去」（Occupied／offline／大廳找不到）就換下一台，最多 3 台
    const ptOf = Object.fromEntries((preTest.rows ?? []).map(x => [x.row?.code, x.row]))
    const healthy = codes.filter(c => ptOf[c]?.online === 'online' && ptOf[c]?.status === 'normal' && !unmon.includes(c))
    const trialCands = [...healthy, ...codes.filter(c => !healthy.includes(c))].slice(0, 3)
    let r = null, trialCode = trialCands[0], ok = false
    for (const c of trialCands) {
      trialCode = c
      log(`單台試跑（進入＋退出）：${c}`)
      const trialSid = await startSession(lobbyUrl, [c], ['entry', 'exit'], agent.agentId)
      const { results } = await collect([c], trialSid)
      r = results.get(c)
      ok = !!r && (r.steps ?? []).every(s => s.status === 'pass') && !/已在遊戲內/.test(JSON.stringify(r.steps))
      if (ok) break
      const entryMsg = (r?.steps ?? []).find(s => s.step === '進入機台')?.message ?? ''
      const machineSide = /Occupied|佔用|找不到機台|offline|maintain|沒有任何 frame 進到 \/game/i.test(entryMsg) && (r?.steps ?? []).every(s => s.step === '進入機台' || s.status === 'skip')
      if (!machineSide) break
      // 1003 0208/0209：試跑進場 errcode=0 但畫面沒載入＝多半是 AFT 轉入失敗，查盒子 log 印出來（要給現場看）
      if (/enterGMNtc errcode=0/.test(entryMsg) && r?.startedAt) {
        const hit = await lookupAftFailure(c, uidOfLobby(lobbyUrl), r.startedAt, r.finishedAt).catch(() => null)
        if (hit) { log(`🆘 試跑台 ${c}：AFT error state=${hit.state}（盒子 log ${hit.time} aft_in_end 失敗）→ 機台會一直掛著測試帳號（Occupied），要請現場／後台處理`); pre.problems.push(`試跑 ${c} AFT error state=${hit.state}`) }
      }
      log(`試跑台 ${c} 本身進不去（${entryMsg.slice(0, 60)}），換下一台試跑`)
      agent = await waitIdle()
    }
    if (!ok) {
      const f = path.join(reportsDir, `machine-test-trial-${Date.now()}.json`)
      saveSummary(f, { trialFailed: true, sheet: sheetUrl, code: trialCode, tried: trialCands, result: r ?? null, preflight: pre })
      log('單台試跑沒通過，不跑整批')
      console.log(`SUMMARY ${f}`)
      return 1
    }
    log('單台試跑通過')
    agent = await waitIdle()
  }

  // 整批
  const sessionId = await startSession(lobbyUrl, codes, stepList, agent.agentId)
  log(`整批 session ${sessionId} 已發動`)
  const outDir = path.join(reportsDir, `machine-test-${sessionId}`)
  fs.mkdirSync(outDir, { recursive: true })
  const summaryFile = path.join(outDir, 'summary.json')
  const date = new Date().toISOString()
  const summary = {
    sessionId, sheet: sheetUrl, letters, date, steps: stepList, preflight: pre, errors: [], noWriteback: NO_WB, gameNotes: gameNoteMap, preTest,
    machines: targets.map(t => ({ code: t.code, row: t.row, oldF: String(t.F ?? '').replace(/^null$/, '').trim(), oldI: String(t.I ?? '').replace(/^null$/, '').trim(), evidence: evidence(sessionId, t.code) })),
  }
  saveSummary(summaryFile, summary)
  let chain = Promise.resolve()
  let curUid = uidOfLobby(lobbyUrl)   // 目前在用的帳號 uid（換帳號時更新）——查盒子 log 的 AFT 紀錄用
  const onDone = (code, result) => {
    const m = summary.machines.find(x => x.code === code)
    // 停批後 runner 對剩下的台回一筆「未執行」——當成沒收到結果，不回寫（1002 實際發生：7 台被寫成一整串 not verified）
    if (notExecuted(result)) { log(`${code} 未執行（${result.steps[0]?.message?.slice(0, 80) ?? ''}）：當成沒收到結果，Lark 不回寫`); return }
    result.sessionAudio = sessionAudioStats(m.evidence?.audio)
    const j = judge(result, stepList)
    Object.assign(m, { result, verdict: j.verdict, J: j.J, larkLine: shortLine(result, j, null, stepList), detailLine: larkLine(result, j, date.slice(5, 10)) })
    // Occupied／audit mode 沒有推流截圖 → 用 Game Preview 截圖當 G 欄證據
    { const shot = String(result.steps?.find(s => s.step === '進入機台')?.message ?? '').match(/截圖 (\S+\.png)/)?.[1]
      if (shot && fs.existsSync(shot) && !fs.existsSync(m.evidence.stream)) { try { fs.copyFileSync(shot, m.evidence.stream) } catch { /* 證據複製失敗不影響回寫 */ } } }
    saveSummary(summaryFile, summary)
    // 1003 自動學選單：runner 在 Spin 步驟帶回 menuLearn → 寫回機種設定檔並立刻同步到 agent（同一批後面的台就用得到）
    { const sp = result.steps?.find(s => s.step === 'Spin 測試')
      let ml = null; try { ml = JSON.parse(sp?.extraData?.menuLearn ?? 'null') } catch { /* 沒有 */ }
      if (ml) {   // 學到的是機種知識不是 Lark，--no-writeback 也照寫
        const type = machineTypeOf(code)
        const did = persistMenuLearn(type, ml, { code, sessionId })
        if (did.length) { log(`📚 機種 ${type} 自動學到：${did.join('、')}（來源 ${code}）→ 已寫進 knowledge/games/${type}/automation/machine-test.json`); for (const x of syncGameConfigs([type])) log(`  ${x}`) }
        ;(summary.learned ??= []).push({ code, type, did, learn: ml })
      } }
    // 1003 特殊遊戲卡住救援學到的推進方式 → 寫回機台配置（排在回寫之前，同一批後面的台就用得到——agent 每次開跑讀 profile）
    { const ex = result.steps?.find(s => s.step === '退出測試')
      let bl = null; try { bl = JSON.parse(ex?.extraData?.bonusLearn ?? 'null') } catch { /* 沒有 */ }
      if (bl) chain = chain.then(async () => {
        const type = machineTypeOf(code)
        const note = await persistBonusLearn(type, bl, { code, sessionId }, outDir).catch(e => `寫入例外：${String(e).slice(0, 100)}`)
        log(`📚 機種 ${type} 特殊遊戲學到：${bl.note} → ${note}`)
        ;(summary.learned ??= []).push({ code, type, bonus: bl, result: note })
        saveSummary(summaryFile, summary)
      }) }
    // 1003 共通規則：Spin 沒開局、而這個機種沒有選單參考圖 → F 寫 spin not verified（不是 spin no response），
    // 畫面交給 Claude 判讀：停在選單＝touchscreen no response＋spin not verified，並把推流截圖裁成這個機種的參考圖（menu-gate.json＋menu-refs/）
    { const sp = result.steps?.find(s => s.step === 'Spin 測試')
      if (sp && /沒有選單參考圖/.test(sp.message ?? '') && spinDidNotRound(result.steps)) log(`Spin 沒開局 ${code}：這個機種沒有選單參考圖 → 待人工判讀畫面（是不是停在選單）→ ${m.evidence.stream}`) }
    // 1003：進場失敗但 enterGMNtc=0 → 查盒子 log 有沒有 AFT 轉入失敗，有就補進訊息（F 會寫 AFT error state=N）。排在回寫之前
    { const entry = result.steps?.find(s => s.step === '進入機台')
      // Occupied 也查（1003 0208/0209）：前一次進場（例如試跑）AFT 失敗 → 盒子掛著我們的帳號 → 這次看到 Occupied。往前查 60 分鐘
      const occ = /機台 Occupied/.test(entry?.message ?? '') && !/AUDIT MODE/.test(entry?.message ?? '')
      if (entry?.status === 'fail' && (/enterGMNtc errcode=0/.test(entry.message ?? '') || occ)) chain = chain.then(async () => {
        const from = occ ? new Date(Date.parse(result.startedAt) - 60 * 60_000).toISOString() : result.startedAt
        const hit = await lookupAftFailure(code, curUid, from, result.finishedAt)
        if (!hit) { log(`${code} 進場失敗：盒子 log 沒查到 AFT 轉入失敗`); return }
        entry.message += `｜AFT error state=${hit.state}（盒子 log ${hit.time} aft_in_end 失敗）`
        const j2 = judge(result, stepList)
        Object.assign(m, { verdict: j2.verdict, J: j2.J, larkLine: shortLine(result, j2, null, stepList), detailLine: larkLine(result, j2, date.slice(5, 10)) })
        log(`${code} 進場失敗＝AFT 轉入失敗 state=${hit.state}（盒子 log ${hit.time}）`)
        saveSummary(summaryFile, summary)
      })
      // 1006 ARUZE 0331：進場「成功」但前端馬上跳 Tips「Machine connection timeout」（點掉會回大廳）——runner 沒判讀到，
      // 後面每一步都對著那個彈窗跑、全部沒反應。盒子 log 同時間 aft_in_end success=false state=87。
      // 使用者：這是 AFT error，不是 offline。→ 進場 pass 但 Spin 完全沒開局時也查盒子 log，命中就把進場改判 fail（F 只寫 AFT error）
      else if (entry?.status === 'pass' && spinDidNotRound(result.steps)) chain = chain.then(async () => {
        const hit = await lookupAftFailure(code, curUid, result.startedAt, result.finishedAt)
        if (!hit) return
        entry.status = 'fail'
        entry.message += `｜AFT error state=${hit.state}（盒子 log ${hit.time} aft_in_end 失敗；進場後前端多半跳 Tips「Machine connection timeout」）`
        const j2 = judge(result, stepList)
        Object.assign(m, { verdict: j2.verdict, J: j2.J, larkLine: shortLine(result, j2, null, stepList), detailLine: larkLine(result, j2, date.slice(5, 10)) })
        log(`${code} 進場後 AFT 轉入失敗 state=${hit.state}（盒子 log ${hit.time}）→ 改判 AFT error`)
        saveSummary(summaryFile, summary)
      }) }
    // 畫面方向檢查（影子模式 2026-09-29）：只寫 summary／報告／F 欄，**不影響 J**；失敗也不擋回寫
    chain = chain.then(async () => {
      m.orientation = await orientationFor(result, m.evidence.stream, code, outDir)
      log(`方向 ${code}：${m.orientation.note}${m.orientation.crops.length ? ` → ${m.orientation.crops.join(', ')}` : ''}`)
      // NO SIGNAL 偵測：命中就把推流改判 FAIL，並在回寫前重算 J／F（跟 AFT 補查同一個做法）
      const ns = await noSignalCheck(m.orientation).catch(() => [])
      const st = result.steps?.find(s => s.step === '推流檢測')
      if (ns.length && st) {
        const tags = ns.map(h => `${h.role === 'main' ? 'mainstream' : h.role === 'pool' ? 'poolstream' : 'stream'} no signal`)
        st.status = 'fail'
        st.message = `${[...new Set(tags)].join('、')}：畫面是 NO SIGNAL 測試卡（與參考圖差 ${ns.map(h => h.diff).join('／')}）｜${st.message}`
        const j2 = judge(result, stepList)
        Object.assign(m, { verdict: j2.verdict, J: j2.J, larkLine: shortLine(result, j2, m.orientation, stepList), detailLine: larkLine(result, j2, date.slice(5, 10)) })
        log(`${code} 推流 NO SIGNAL：${tags.join('、')}`)
      }
      saveSummary(summaryFile, summary)
    })
    // iDeck 畫面證據（影子模式 2026-09-29）：每顆點完的推流截圖複製到報告資料夾，交給人判讀 BET 值，不影響 J
    {
      let shots = []
      try { shots = JSON.parse(result.steps?.find(s => s.step === 'iDeck 測試')?.extraData?.ideckShots ?? '[]') } catch { /* 舊版 agent 沒帶 */ }
      const dir = path.join(outDir, 'ideck')
      m.ideckScreens = shots.filter(s => fs.existsSync(s.path)).map(s => {
        fs.mkdirSync(dir, { recursive: true })
        const dest = path.join(dir, path.basename(s.path))
        fs.copyFileSync(s.path, dest)
        return { label: s.label, name: s.name, text: s.text, path: dest }
      })
      if (m.ideckScreens.length) log(`iDeck 畫面 ${code}：待人工判讀（${m.ideckScreens.length} 張）→ ${dir}`)
      // 觸屏畫面判定的截圖（base／opened／closed）：確認打開的真的是預期畫面（BZZF＝賠率表），影子模式
      let tshots = {}
      try { tshots = JSON.parse(result.steps?.find(s => s.step === '觸屏測試')?.extraData?.touchShots ?? '{}') } catch { /* 沒走畫面判定 */ }
      const tdir = path.join(outDir, 'touch')
      m.touchScreens = Object.entries(tshots).filter(([, p]) => fs.existsSync(p)).map(([tag, p]) => {
        fs.mkdirSync(tdir, { recursive: true })
        const dest = path.join(tdir, path.basename(p))
        fs.copyFileSync(p, dest)
        return { tag, path: dest }
      })
      if (m.touchScreens.length) log(`觸屏畫面 ${code}：待人工確認是否為預期畫面（${m.touchScreens.length} 張）→ ${tdir}`)
      // 退出紀錄截圖（1002）：每次退出的 before-quit／after-quit／after-exit-to-lobby／after-confirm／end
      let eshots = []
      try { eshots = JSON.parse(result.steps?.find(s => s.step === '退出測試')?.extraData?.exitShots ?? '[]') } catch { /* 舊版 agent 沒有 */ }
      const edir = path.join(outDir, 'exit')
      m.exitScreens = eshots.filter(p => fs.existsSync(p)).map(p => {
        fs.mkdirSync(edir, { recursive: true })
        const dest = path.join(edir, path.basename(p))
        fs.copyFileSync(p, dest)
        return dest
      })
      if (m.exitScreens.length) log(`退出畫面 ${code}：${m.exitScreens.length} 張 → ${edir}`)
      saveSummary(summaryFile, summary)
    }
    if (!NO_WB) chain = chain.then(async () => { await writeBack(sheet, letters, m, date.slice(5, 10)); log(`Lark 回寫 ${code}（第 ${m.row} 列）：${JSON.stringify(m.writeback)}`); saveSummary(summaryFile, summary) })
    if (LEARN) chain = chain.then(async () => {
      const meta = { code, sessionId, date }
      const plan = learnProfile(result, learnSnap, meta)
      summary.learn = { type: learnType, before: learnSnap, plan }
      if (plan.ok) summary.learn.apply = await applyLearn(learnType, learnSnap, plan, outDir, meta)
      log(`learn ${learnType}：${plan.ok ? `${plan.changes.join('；')} → ${summary.learn.apply.note}` : plan.reason}${plan.warnings?.length ? ` ｜⚠️ ${plan.warnings.join('；')}` : ''}`)
      saveSummary(summaryFile, summary)
    })
  }
  const errors = []
  let runSid = sessionId, runCodes = codes
  let curLobby = lobbyUrl, recoveries = 0, switches = 0
  const usedUsers = [new URL(lobbyUrl).searchParams.get('username')], borrowed = []
  for (let round = 0; ; round++) {
    const r = await collect(runCodes, runSid, onDone, { strict: round > 0 })
    errors.push(...r.errors)
    let missing = summary.machines.filter(x => !x.result).map(x => x.code)
    const d = resumeDecision({ errors: r.errors, missing: missing.length, recoveries })
    if (!d.resume) {
      // 帳號卡住（退出異常）→ 不停批：卡住的帳號留在原地等指示，換帳號池下一個帳號跑剩下的台
      const stuckAt = stuckMachineOf(r.errors)
      // 1003：卡住的是最後一台（後面沒有台要跑）也要記＋🆘，不然不會有人回報（1562 實例）
      if (stuckAt && !missing.length) {
        const user = new URL(curLobby).searchParams.get('username')
        const why = String(r.errors.find(e => STUCK_RE.test(e)) ?? '').replace(/^.*?退出異常（帳號卡在這台）：/, '').replace(/——本批次後面的機台不再測試$/, '')
        ;(summary.stuck ??= []).push({ username: user, machine: stuckAt, at: new Date().toISOString(), exitDir: path.join(outDir, 'exit'), why: why.slice(0, 300) })
        saveSummary(summaryFile, summary)
        log(`🆘 帳號卡住：${user} 卡在 ${stuckAt}（${why}）——帳號留在原地等人工指示；證據 ${path.join(outDir, 'exit')}（最後一台，不用換帳號）`)
      }
      if (stuckAt && missing.length && switches < 3) {
        switches++
        const user = new URL(curLobby).searchParams.get('username')
        ;(summary.stuck ??= []).push({ username: user, machine: stuckAt, at: new Date().toISOString(), exitDir: path.join(outDir, 'exit'), why: String(r.errors.find(e => STUCK_RE.test(e)) ?? '').slice(0, 300) })
        saveSummary(summaryFile, summary)
        const why = String(r.errors.find(e => STUCK_RE.test(e)) ?? '').replace(/^.*?退出異常（帳號卡在這台）：/, '').replace(/——本批次後面的機台不再測試$/, '')
        log(`🆘 帳號卡住：${user} 卡在 ${stuckAt}（${why}）——帳號留在原地等人工指示；證據 ${path.join(outDir, 'exit')}`)
        if (fs.existsSync(STOP_FILE)) { log('🛑 換帳號前收到停止請求，不續跑'); errors.push('🛑 換帳號中止：收到停止請求'); break }
        const acc = await switchAccount(usedUsers).catch(e => { log(`換帳號例外：${String(e).slice(0, 150)}`); return null })
        if (!acc) { log(`🛑 帳號池找不到可用的帳號，剩下 ${missing.length} 台不跑`); errors.push('🛑 換帳號失敗：帳號池沒有可用帳號'); break }
        usedUsers.push(acc.username); borrowed.push(acc)
        agent = await waitIdle()
        curLobby = acc.url
        curUid = uidOfLobby(acc.url)
        runSid = await startSession(curLobby, missing, stepList, agent.agentId)
        runCodes = missing
        ;(summary.resumedSessions ??= []).push(runSid)
        for (const m of summary.machines.filter(x => !x.result)) m.evidence = evidence(runSid, m.code)
        saveSummary(summaryFile, summary)
        log(`換帳號續跑：${acc.username}，session ${runSid}（${missing.length} 台）`)
        continue
      }
      if (missing.length) log(`不續跑：${d.reason}`)
      break
    }
    recoveries++
    log(`⚠️ ${d.reason}：${missing.join(', ')}`)
    const rec = await runRecovery(realRecoveryDeps(curLobby, runSid)).catch(e => ({ ok: false, note: `續跑準備例外：${String(e).slice(0, 150)}` }))
    if (!rec.ok) { log(`🛑 續跑準備沒過，停止：${rec.note}`); errors.push(`🛑 自動續跑中止：${rec.note}`); break }
    // 對帳：中控已存結果（WS 漏傳）的台直接採用，不重跑（避免重複下注）
    for (const [code, res] of rec.adopted) if (missing.includes(code)) { log(`對帳採用中控已存結果：${code}（${res.overall}）`); onDone(code, res) }
    missing = summary.machines.filter(x => !x.result).map(x => x.code)
    if (!missing.length) { log('對帳後全部都有結果，不用再開新一輪'); break }
    // CodeX 0930：停止要守到「發送端」——發新 session 的前一刻再查一次
    if (fs.existsSync(STOP_FILE)) { log('🛑 發新一輪前收到停止請求，不續跑'); errors.push('🛑 自動續跑中止：收到停止請求'); break }
    runSid = await startSession(curLobby, missing, stepList, rec.agent.agentId)
    runCodes = missing
    ;(summary.resumedSessions ??= []).push(runSid)
    for (const m of summary.machines.filter(x => !x.result)) m.evidence = evidence(runSid, m.code)   // 證據檔名綁 session
    saveSummary(summaryFile, summary)
    log(`續跑 session ${runSid} 已發動（${missing.length} 台）`)
  }
  summary.errors = errors
  // 借來的帳號：沒卡住的歸還；卡住的保持借用（帳號池顯示「使用中」，別人才不會拿去用）
  for (const acc of borrowed) {
    if ((summary.stuck ?? []).some(s => s.username === acc.username)) { log(`帳號 ${acc.username} 卡在機台上，保持借用中（處理完再歸還）`); continue }
    await central(`/api/url-pool/${acc.account}/release`, { method: 'POST', body: JSON.stringify({ claimedBy: CLAIM_BY }) }).catch(() => {})
    log(`歸還帳號 ${acc.username}`)
  }
  // 沒收到結果的台（被中止／沒跑到）：**完全不回寫**，Lark 保持原樣。
  // 0929 起 F 欄是整格覆蓋，原本「F 寫 no result＋J 清空」會把沒跑到的台的人工紀錄蓋掉（實際發生：手動停批後 44 列被寫成 no result、4 列人工值被蓋）。
  // 沒測就不動，比寫一個「沒結果」誠實；summary／報告照樣記「需重測」。
  for (const m of summary.machines.filter(x => !x.result)) {
    Object.assign(m, { verdict: '沒有收到結果（未執行或被中止），需重測；Lark 未回寫', J: null, larkLine: null, detailLine: `[${date.slice(5, 10)} auto] 沒有收到結果（未執行或被中止），需重測` })
  }
  const skipped = summary.machines.filter(x => !x.result).length
  if (skipped) log(`沒收到結果 ${skipped} 台：Lark 不回寫（保持原樣）`)
  await chain
  saveSummary(summaryFile, summary)
  if (!flag('no-report')) {
    const { buildReport } = await import('./machine-test-report.mjs')
    fs.writeFileSync(path.join(outDir, 'report.html'), await buildReport(summary))
  }
  console.log(`SUMMARY ${summaryFile}`)
  return 0
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  // 不直接 process.exit()：Windows 上 fetch 的 socket 還在關閉時硬退會觸發 libuv 斷言
  // （UV_HANDLE_CLOSING，exit code 0xC0000409），exit code 就不可信了。先設 exitCode 讓事件迴圈自己收，200ms 後還有東西撐著才強制退。
  const finish = code => { process.exitCode = code; setTimeout(() => process.exit(code), 200).unref() }
  main().then(code => finish(code ?? 0)).catch(e => { console.log('ERROR', e.message ?? e); finish(1) })
}
