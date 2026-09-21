/**
 * 驗 UI 截圖的彈窗處理：`server/uat-runner/ui-popup.js`。
 *
 * ⚠️ **跑的是產品那一份**（`dismissUiPopups`），不是在這裡再寫一份判斷。
 *    抄一份的話，測試驗的是抄的那份、上線跑的是另一份——這個專案被咬過好幾次。
 *
 * CodeX 2026-09-21 指定要涵蓋的四件事，加上幾個「不該點」的反例：
 *   ① 延遲出現   —— 彈窗是等一下才冒出來的，看門狗要抓得到
 *   ② 連續兩層   —— 面額選單關掉之後還會再跳一層
 *   ③ 未知 Confirm 不點 —— strict 模式只點已確認用途的，其他只回報
 *   ④ 關閉設定生效 —— 這條在 `agent-runner.ts` 那層，另外用讀原始碼的方式守
 *
 * 用法：node scripts/ui-checks/ui-popup-dismiss.mjs
 */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { dismissUiPopups } from '../../server/uat-runner/ui-popup.js'

const failures = []
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  →  ${JSON.stringify(actual)}${ok ? '' : ` (預期 ${JSON.stringify(expected)})`}`)
  if (!ok) failures.push(name)
}

/** 安靜版的 log，免得 fixture 的訊息把結果洗掉 */
const quiet = () => {}

const STYLE = `<style>
  body { margin:0; font-family: sans-serif; }
  .layer { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex;
           align-items: center; justify-content: center; }
  .bg-img { background: #fff; padding: 20px; width: 320px; }
  .box-btn { width: 120px; height: 40px; }
  .select-bg { position: fixed; inset: 0; background: #222; }
  .select-row { display: flex; }
  .van-col { width: 80px; height: 40px; background: #555; color: #fff; }
</style>`

/** Tips 錯誤框（2026-09-18 實測那個 error 39 的結構：容器 bg-img、按鈕 box-btn） */
const TIPS_ERROR = `
<div class="layer" id="L1"><div class="bg-img">
  <div class="box-title">Tips</div>
  <div class="box-content"><div class="text-msg">Game exception, please contact customer service.(39)</div></div>
  <div class="box-end"><button class="van-button box-btn"><div>Confirm</div></button></div>
</div></div>`

/** 面額選單（第一層）＋ 關掉後才出現的第二層 YES/NO */
const DENOM_TWO_LAYER = `
<div class="select-bg" id="denom">
  <div class="select-row"><div class="van-col">0.01</div><div class="van-col">0.05</div></div>
</div>
<script>
  document.querySelector('.van-col').addEventListener('click', () => {
    document.getElementById('denom').remove()
    const d = document.createElement('div')
    d.className = 'layer'
    d.innerHTML = '<div class="bg-img"><div class="box-title">Tips</div>' +
      '<div class="box-content">SELECT A DENOMINATION</div>' +
      '<div class="box-end"><button class="van-button box-btn"><div>YES</div></button></div></div>'
    d.querySelector('button').addEventListener('click', () => d.remove())
    document.body.appendChild(d)
  })
</script>`

/** 未知的 Confirm 彈窗：長得像彈窗、按鈕也叫 Confirm，但內容沒見過 */
const UNKNOWN_CONFIRM = `
<div class="layer" id="U1"><div class="bg-img">
  <div class="box-title">Daily Bonus</div>
  <div class="box-content">You have unclaimed rewards waiting in your account.</div>
  <div class="box-end"><button class="van-button box-btn"><div>Confirm</div></button></div>
</div></div>
<script>
  document.querySelector('#U1 button').addEventListener('click', () => document.getElementById('U1').remove())
</script>`

/** 遊戲畫面裡剛好有「Confirm」字樣，但**不在彈窗裡**——不能點 */
const BARE_CONFIRM = `<div style="padding:40px"><span>Confirm</span></div>`

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } })
const page = await ctx.newPage()
const load = html => page.setContent(`${STYLE}${html}`)

try {
  // ── ① 延遲出現：載入當下畫面是乾淨的，1 秒後才冒出錯誤框 ────────────────────
  await load(`<script>
    setTimeout(() => {
      const d = document.createElement('div')
      d.innerHTML = ${JSON.stringify(TIPS_ERROR)}
      d.querySelector('button').addEventListener('click', () => d.remove())
      document.body.appendChild(d)
    }, 1000)
  </script>`)
  const immediate = await dismissUiPopups(page, 'delayed', { strict: true, log: quiet })
  check('① 彈窗還沒出現時：不該關到任何東西', immediate.dismissed, 0)
  await page.waitForTimeout(1400)
  const delayed = await dismissUiPopups(page, 'delayed', { strict: true, log: quiet })
  check('① 延遲 1 秒才出現的錯誤框：關得掉', delayed.dismissed, 1)
  check('① 而且錯誤內容有被記下來（不能當沒發生）', delayed.errors.length, 1)
  check('① 畫面上已經沒有彈窗了', await page.locator('.bg-img').count(), 0)

  // ── ② 連續兩層：面額選單 → 關掉後才跳 YES/NO ──────────────────────────────
  await load(DENOM_TWO_LAYER)
  const twoLayer = await dismissUiPopups(page, 'two-layer', { strict: true, log: quiet })
  check('② 連續兩層：兩層都關掉', twoLayer.dismissed, 2)
  check('② 第二層也不見了', await page.locator('.bg-img').count(), 0)

  // ── ③ 未知 Confirm：strict 不點、只回報；非 strict 才會點 ──────────────────
  await load(UNKNOWN_CONFIRM)
  const strictUnknown = await dismissUiPopups(page, 'unknown', { strict: true, log: quiet })
  check('③ strict：未知 Confirm **不點**', strictUnknown.dismissed, 0)
  check('③ strict：但要回報出來（1 筆）', strictUnknown.blocked.length, 1)
  check('③ strict：彈窗還在畫面上（證明真的沒點）', await page.locator('#U1').count(), 1)
  const looseUnknown = await dismissUiPopups(page, 'unknown', { strict: false, log: quiet })
  check('③ 非 strict：同一個彈窗會被點掉（一次性的舊行為不變）', looseUnknown.dismissed, 1)
  check('③ 非 strict：不該回報成 blocked', looseUnknown.blocked.length, 0)

  // ── 反例：不在彈窗裡的「Confirm」字樣，兩種模式都不能點 ────────────────────
  await load(BARE_CONFIRM)
  const bareStrict = await dismissUiPopups(page, 'bare', { strict: true, log: quiet })
  const bareLoose = await dismissUiPopups(page, 'bare', { strict: false, log: quiet })
  check('反例：畫面上的裸 Confirm 字樣，strict 不點', bareStrict.dismissed, 0)
  check('反例：畫面上的裸 Confirm 字樣，非 strict 也不點', bareLoose.dismissed, 0)

  // ── 反例：大廳中獎彈窗只能點 ✕，不能點 PLAY NOW ───────────────────────────
  await load(`<div class="layer" id="JP">
    <div><button class="closeBtn" style="width:24px;height:24px">X</button>
         <button class="playBtn" style="width:160px;height:48px">PLAY NOW</button></div>
  </div>
  <script>
    document.querySelector('.closeBtn').addEventListener('click', () => document.getElementById('JP').remove())
    document.querySelector('.playBtn').addEventListener('click', () => { window.__ENTERED__ = true })
  </script>`)
  const jackpot = await dismissUiPopups(page, 'jackpot', { strict: true, log: quiet })
  check('反例：大廳中獎彈窗用 ✕ 關掉', jackpot.dismissed, 1)
  check('反例：**沒有**點到 PLAY NOW（沒被帶進機台）', await page.evaluate(() => window.__ENTERED__ === true), false)

  // ── ④ 「自動關閉面額彈窗」關掉時，ensureUiScreenshotLobby 不可以偷關 ───────
  //    這條在 agent-runner 那一層，沒有真環境驗不到行為，改成守「呼叫點有帶條件」。
  //    ⚠️ 這是**結構檢查不是行為檢查**，所以特別標出來，不要當成行為驗過。
  const runnerSrc = readFileSync('server/agent-runner.ts', 'utf8')
  const lobbyFn = runnerSrc.slice(runnerSrc.indexOf('async function ensureUiScreenshotLobby'))
    .slice(0, 900)
  check('④ ensureUiScreenshotLobby 關彈窗前有判斷 dismissPopup',
    /if \(dismissPopup\) await dismissUiScreenshotPopups/.test(lobbyFn), true)
  check('④ 沒有殘留無條件呼叫的版本',
    /\n    await dismissUiScreenshotPopups\(page, label\)/.test(lobbyFn), false)
} catch (err) {
  console.log(`FAIL  執行中斷：${err.message}`)
  failures.push(`執行中斷：${err.message}`)
} finally {
  await browser.close()
}

console.log('')
if (failures.length) {
  console.log(`不通過——${failures.length} 條沒過：`)
  for (const f of failures) console.log(`  · ${f}`)
  process.exit(1)
}
console.log('通過——彈窗處理的四類情況都照規則走')
console.log('⚠️ 第 ④ 條是讀原始碼的結構檢查，不是行為檢查；真環境的行為仍需實機跑')
