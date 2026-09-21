/**
 * 把「已經存進去的那份腳本」用**真正的引擎**跑一次，證明它不是裝飾用的。
 *
 * ⚠️ 刻意不走 `/api/frontend-auto/runs`：那條路徑會把判定**回寫進使用者的 Lark 表**。
 *    驗腳本能不能跑，不應該在人家的 TC 表上留下紀錄。所以這裡自己兜 host，
 *    跑的是同一支 `runFrontendStep` ＋ 同一份 steps（從 API 讀回來的）。
 */
import { chromium } from 'playwright'
import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import { runFrontendStep } from '../../server/uat-runner/frontend-engine.js'
import { createRecordedLocators } from '../../server/uat-runner/recorded-selector.js'
import { dismissLobbyPopups, startLobbyPopupWatcher } from '../../server/uat-runner/lobby-popup.js'
import { h5BackToLobby, h5InGame } from '../../server/uat-runner/h5-seat.js'
// ⚠️ WS 斷言（`assert_ws_called`）要有這個，否則會明確失敗——正式路徑兩個 host 都有帶
import { attachPinusProbe } from '../../server/uat-runner/pinus-probe.js'
// PC（Cocos）積木要的能力——跟正式路徑注入的是同一個物件
import { pcEngineCapabilities } from '../../server/lib/pc-cocos.js'

const NAME = process.env.SCRIPT_NAME ?? ''
const PLATFORM = process.env.PLATFORM ?? 'h5'
const START = process.env.H5_URL ?? ''
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const db = new Database(path.join(root, 'server/data.db'))
const sess = db.prepare('SELECT sid FROM auth_sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 1').get(Date.now())
const scripts = await fetch(`http://localhost:3000/api/frontend-auto/scripts?platform=${PLATFORM}`, { headers: { cookie: `toppath_auth=${sess.sid}` } })
  .then(r => r.json()).then(r => r.scripts ?? [])
const row = scripts.find(s => s.name === NAME)
if (!row) { console.log('找不到腳本：' + NAME); process.exit(1) }
const steps = JSON.parse(row.steps)
console.log(`▶ ${row.name}｜${steps.length} 顆`)

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
let stop = null, passed = 0, failed = 0
try {
  // PC 是桌面版面（Cocos 畫布 1280x720），H5 是手機版面——兩者不能共用同一組設定
  const ctx = PLATFORM === 'pc'
    ? await browser.newContext({ viewport: { width: 1280, height: 800 } })
    : await browser.newContext({ viewport: { width: 500, height: 877 }, userAgent: UA, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  const log = async (l) => console.log('   ' + l)
  const { recordedLocator } = createRecordedLocators(page, { requireUnique: true, resolveTimeoutMs: 10000 })
  const pinus = await attachPinusProbe(page)
  const pinusTimer = setInterval(() => { void pinus.drain() }, 3000)
  const host = { log, page, browser, recordedLocator, netCapture: null, pinus, startUrl: START, viewportHeight: PLATFORM === 'pc' ? 800 : 877, backend: null, pc: pcEngineCapabilities, state: { netMark: Date.now() } }

  for (const [i, step] of steps.entries()) {
    const idx = `[${i + 1}/${steps.length}]`
    try {
      await runFrontendStep(step, { ...host, idx, label: step.name })
      passed++
      // 大廳彈窗看門狗要在第一次 goto 之後才掛得上
      if (step.action === 'goto' && !stop) { await dismissLobbyPopups(page); stop = startLobbyPopupWatcher(page, { onClose: c => console.log(`   🧹 關掉彈窗 .${c}`) }) }
    } catch (e) {
      failed++
      console.log(`   ❌ ${idx} ${step.name}：${String(e.message ?? e).split('\n')[0].slice(0, 120)}`)
    }
  }
  // 收尾（跟正式執行路徑同一支）
  if (h5InGame(page)) {
    const back = await h5BackToLobby(page, { log })
    console.log(`   🚪 收尾：${back.ok ? '已退出、位子放掉' : '退出失敗'}：${back.steps.join(' → ')}`)
  }
  console.log(`\n${failed ? '❌' : '✅'} 通過 ${passed} ／ 失敗 ${failed}`)
  if (failed) process.exitCode = 1
} finally {
  try { clearInterval(pinusTimer) } catch { /* ignore */ }
  try { stop?.() } catch { /* ignore */ }
  await browser.close()
}
