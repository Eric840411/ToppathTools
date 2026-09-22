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
import { dismissUiPopups, startUiPopupGuard, evaluateReadyGate } from '../../server/uat-runner/ui-popup.js'

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

/** n 個只有 ✕ 的中獎通知——用來塞滿輪數上限 */
const nCloses = n => `
  ${Array.from({ length: n }, (_, i) => `<div class="layer" id="N${i}" style="inset:${i * 5}px">
    <button class="notification-close" style="width:24px;height:24px">X</button></div>`).join('')}
  <script>
    for (const b of document.querySelectorAll('.notification-close'))
      b.addEventListener('click', () => b.parentElement.remove())
  </script>`

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

  // ── ⑧ 前面的種類不可以把後面的輪數吃光 ────────────────────────────────────
  //    🚨 來源是 2026-09-21 使用者給網址實測到的**真實現場**：大廳同時有 1 個 closeBtn
  //    ＋ 4 個 notification-close ＋ 1 個 `Tips: Game exception...(39)` 的 Confirm 框（共 6 個）。
  //    ⚠️ **下面是縮減重現（4 個 ✕ ＋ 1 個 Confirm），不是現場的原樣。**
  //    縮減版一樣能重現（上限 4 → 紅），現場的原始紀錄在 docs/features/17-ui-screenshot.md。
  //    ⚠️ 也就是說**這題不是「只有真環境才驗得到」，是我原本的 fixture 沒涵蓋到**
  //    （CodeX 指正過我這個說法）——差別在於有沒有「同時擺多個、多到吃光輪數」。
  //    上限原本是 4 輪，**四輪全花在 ✕ 上，Confirm 那一步一次都沒跑到**——
  //    而回報寫的是「關掉 4 個彈窗」，看起來完全正常。這就是使用者說的
  //    「不會自動點掉 Confirm」的真正原因。
  await load(`
    ${[0, 1, 2, 3].map(i => `<div class="layer" id="N${i}" style="inset:${i * 5}px">
      <button class="notification-close" style="width:24px;height:24px">X</button></div>`).join('')}
    ${TIPS_ERROR}
    <script>
      for (const b of document.querySelectorAll('.notification-close'))
        b.addEventListener('click', () => b.parentElement.remove())
      document.querySelector('#L1 button').addEventListener('click', () => document.getElementById('L1').remove())
    </script>`)
  {
    const starve = await dismissUiPopups(page, 'starve', { strict: true, log: quiet })
    check('⑧ 4 個 ✕ ＋ 1 個 Confirm：全部關掉（5 個）', starve.dismissed, 5)
    check('⑧ **Confirm 框真的被點到了**（沒被 ✕ 吃光輪數）', await page.locator('#L1').count(), 0)
    check('⑧ 而且錯誤內容有記下來', starve.errors.length, 1)
  }

  // ── ⑧b 真的關不完時要講出來，不能安靜收工 ──────────────────────────────────
  await load(`
    ${[0, 1, 2].map(i => `<div class="layer" id="N${i}" style="inset:${i * 5}px">
      <button class="notification-close" style="width:24px;height:24px">X</button></div>`).join('')}
    <script>
      for (const b of document.querySelectorAll('.notification-close'))
        b.addEventListener('click', () => b.parentElement.remove())
    </script>`)
  {
    // 故意把上限壓到 2：三個彈窗關不完
    const capped = await dismissUiPopups(page, 'cap', { strict: true, rounds: 2, log: quiet })
    check('⑧b 上限用完仍有彈窗：要回報出來', capped.blocked.length, 1)
    check('⑧b 畫面上確實還有沒關掉的', await page.locator('.notification-close').count() > 0, true)
    check('⑧b 回報措辭是「尚未確認」而不是斷定', /尚未確認/.test(capped.blocked[0]), true)
  }

  // ── ⑩ 面額選單被上層蓋住時，不可以「點失敗還算成關掉」而卡死 ─────────────────
  //    🚨 2026-09-22 端到端實測抓到的真正死結：`.select-bg` 在最底下、`Tips(39)` 蓋在上面。
  //    原本 ① 的寫法是 `click().catch(() => {})` 然後無條件 `dismissed++; continue`——
  //    點不下去被吞掉、還算成進度，而且每一輪都從 ① 開始又每次 continue，
  //    於是 ③ Confirm **一次都輪不到**，兩層互相卡死到輪數用光。
  //    實測 log：「關掉面額選單（第 1 輪）…（第 5 輪）」而選單一直都在。
  await load(`
    <div class="select-bg" id="denom" style="position:fixed;inset:0;background:#222">
      <div class="select-row"><div class="van-col">0.01</div></div>
    </div>
    <div class="layer" id="TOP" style="z-index:99"><div class="bg-img">
      <div class="box-title">Tips</div>
      <div class="box-content"><div class="text-msg">Game exception, please contact customer service.(39)</div></div>
      <div class="box-end"><button class="van-button box-btn"><div>Confirm</div></button></div>
    </div></div>
    <script>
      // 面額只有在上層關掉之後才點得到（就是真實環境的樣子）
      document.querySelector('.van-col').addEventListener('click', () => document.getElementById('denom').remove())
      document.querySelector('#TOP button').addEventListener('click', () => document.getElementById('TOP').remove())
    </script>`)
  {
    const stuck = await dismissUiPopups(page, 'stuck', { strict: true, log: quiet })
    check('⑩ 上層的 Tips 有被點掉', await page.locator('#TOP').count(), 0)
    check('⑩ 底下的面額選單也跟著關掉', await page.locator('#denom').count(), 0)
    check('⑩ 兩個都算數（不多不少）', stuck.dismissed, 2)
    check('⑩ 錯誤提示有被記下來', stuck.errors.length, 1)
  }

  // ── ⑩b 面額確認框整段文字只有「YESNO」，要靠容器 class 認出來 ────────────────
  //    實測回報：`YESNO（容器 .select-main）`。只比對文字的話 strict 會判成「沒見過」
  //    → 不點 → 卡在那裡。容器 `.select-main` 跟第一層面額選單同一家族。
  await load(`
    <div class="layer"><div class="select-main">
      <button class="van-button"><div>YES</div></button>
      <button class="van-button"><div>NO</div></button>
    </div></div>
    <script>
      document.querySelector('.select-main button').addEventListener('click',
        () => document.querySelector('.select-main').remove())
    </script>`)
  {
    const yesno = await dismissUiPopups(page, 'yesno', { strict: true, log: quiet })
    check('⑩b 沒有文字線索的面額確認框：strict 也認得出來', yesno.dismissed, 1)
    check('⑩b 不該被當成未知彈窗擋下來', yesno.blocked.length, 0)
    check('⑩b 畫面上已經關掉了', await page.locator('.select-main').count(), 0)
  }

  // ── ⑩c 未知彈窗的回報要帶容器 class，否則看不出那是什麼 ─────────────────────
  await load(UNKNOWN_CONFIRM)
  {
    const unknown = await dismissUiPopups(page, 'unknown-cls', { strict: true, log: quiet })
    check('⑩c 未知彈窗的回報有帶容器 class', /容器 \./.test(unknown.blocked[0] ?? ''), true)
  }

  // ── ⑨ 巢狀開看門狗不可以變成「兩隻手搶同一顆按鈕」──────────────────────────
  //    使用者 2026-09-22 要求把看門狗涵蓋範圍拉到「整段 prepare」之後，
  //    裡面原本那兩個小看門狗就得拿掉。⚠️ 但**不能只靠「記得不要巢狀呼叫」**——
  //    這個專案已經證明紀律守不住（同一條規則寫兩處，三次都只修好一處）。
  //    所以改成：巢狀呼叫回傳一個共用結果、`stop()` 不做事的把手。
  await load(nCloses(2))
  {
    const outer = startUiPopupGuard(page, 'outer', { intervalMs: 200, log: quiet })
    const inner = startUiPopupGuard(page, 'inner', { intervalMs: 200, log: quiet })
    const innerStopped = await inner.stop()
    // 內層 stop 之後外層必須還活著——不然覆蓋範圍會被提早砍掉
    await page.waitForTimeout(900)
    const outerResult = await outer.stop()
    check('⑨ 內層 stop 不會把外層關掉（外層仍關完了彈窗）', outerResult.dismissed, 2)
    check('⑨ 內外層看到的是同一份結果', innerStopped === outerResult, true)
    check('⑨ 畫面上確實關乾淨了', await page.locator('.notification-close').count(), 0)
  }

  // ── ⑨b 看門狗必須從「頁面載入之後」就開始，不是挑完機台才開始 ────────────────
  //    這是使用者 2026-09-22 指的兩個時機點：進入機器時、每次重新載入新頁面時。
  //    ⚠️ 結構檢查——真流程要有大廳才跑得起來。
  {
    const src = readFileSync('server/agent-runner.ts', 'utf8')
    const prep = src.slice(src.indexOf('const prepare = async (page: Page)'))
      .slice(0, src.slice(src.indexOf('const prepare = async (page: Page)')).indexOf('const shootAndUpload'))
    check('⑨b prepare 裡只開一個看門狗', (prep.match(/startUiPopupGuard\(/g) || []).length, 1)
    check('⑨b 而且是在 goto 之後、挑機台之前就開',
      prep.indexOf('startUiPopupGuard(') > prep.indexOf('await page.goto(')
      && prep.indexOf('startUiPopupGuard(') < prep.indexOf('pickUiScreenshotMachine('), true)
    check('⑨b 開完立刻掃一次，不等第一個輪詢間隔', /await guard\.runOnce\(\)/.test(prep), true)
    check('⑨b 進場流程整段包在 try 裡、finally 才 stop',
      /try \{\s*outcome = await prepareH5\(\)\s*\} finally \{[\s\S]{0,200}?await guard\.stop\(\)/.test(prep), true)
  }

  // ── ⑧c 撞到上限時，措辭只能說「尚未確認」，不能說「仍有彈窗」──────────────
  //    CodeX 2026-09-21：最後一輪剛好關掉最後一個的話，畫面其實是乾淨的——
  //    我們只是少跑了那一輪確認。回報講成「仍有彈窗」就是講了自己不知道的事。
  await load(nCloses(3))
  {
    // 剛好 3 個、上限 3：最後一輪把最後一個關掉了，畫面其實是乾淨的
    const exact = await dismissUiPopups(page, 'exact', { strict: true, rounds: 3, log: quiet })
    check('⑧c 剛好用完上限：三個都關掉了', exact.dismissed, 3)
    check('⑧c 而且畫面**其實是乾淨的**', await page.locator('.notification-close').count(), 0)
    check('⑧c 仍然要回報（我們沒確認過）', exact.blocked.length, 1)
    check('⑧c **但不可以說「仍有彈窗」**', /仍有彈窗/.test(exact.blocked[0]), false)
    check('⑧c 要說的是「尚未確認」', /尚未確認/.test(exact.blocked[0]), true)
  }

  await load(nCloses(4))
  {
    // 4 個、上限 3：這次是真的還有剩
    const over = await dismissUiPopups(page, 'over', { strict: true, rounds: 3, log: quiet })
    check('⑧c 超過上限：只關掉 3 個', over.dismissed, 3)
    check('⑧c 這次畫面**真的還有剩**', await page.locator('.notification-close').count(), 1)
    check('⑧c 同樣回報一筆', over.blocked.length, 1)
  }

  // ── ⑤ 看門狗在跑的時候，主流程**另外**呼叫關窗也不能點掉未知彈窗 ──────────
  //    CodeX 2026-09-21 [P1]：原本主流程在 guard 運作中另呼叫了一次非 strict 的關窗，
  //    於是 guard 刻意不點的未知彈窗被主流程點掉了，strict 等於白設。
  //    ⚠️ 修法是「讓它做不到」——所以這條驗的是：**用最容易犯錯的寫法去呼叫，也點不掉**。
  await load(UNKNOWN_CONFIRM)
  {
    const guard = startUiPopupGuard(page, 'p1', { intervalMs: 200, log: quiet })
    // 故意用非 strict 呼叫（就是原本那個 bug 的寫法）
    const sneaky = await dismissUiPopups(page, 'p1', { strict: false, log: quiet })
    const g = await guard.stop()
    check('⑤ 看門狗運作中的非 strict 呼叫：未知彈窗**還是沒被點**', await page.locator('#U1').count(), 1)
    check('⑤ 那次呼叫也不該回報成「關掉了」', sneaky.dismissed, 0)
    check('⑤ 看門狗有把它記成 blocked', g.blocked.length >= 1, true)
  }

  // ── ⑥ 已經 ready 之後才冒出來的錯誤框，也要被記成 error ────────────────────
  //    CodeX 2026-09-21 [P2]：原本只在「一直沒 ready」時重驗推流，
  //    「先就緒、延遲期間才出錯」那種會直接往下拍——拍到黑畫面而狀態寫 ok。
  //    這條驗的是**看門狗有沒有把延遲期間的錯誤回報出來**（上層才有東西可以據以重驗）。
  await load(`<script>
    setTimeout(() => {
      const d = document.createElement('div')
      d.innerHTML = ${JSON.stringify(TIPS_ERROR)}
      d.querySelector('button').addEventListener('click', () => d.remove())
      document.body.appendChild(d)
    }, 600)
  </script>`)
  {
    const guard = startUiPopupGuard(page, 'p2', { intervalMs: 200, log: quiet })
    await page.waitForTimeout(1600)   // 模擬「已經 ready、正在等截圖延遲」
    const g = await guard.stop()
    check('⑥ ready 之後才出現的錯誤框：有被關掉', g.dismissed, 1)
    check('⑥ 而且有記成 error（上層要據此重驗推流）', g.errors.length, 1)
  }

  // ── ⑦ 「錯誤後確實重驗、重驗失敗不報 ok」——這是行為，不是結構 ──────────────
  //    CodeX 2026-09-21：⑥ 只驗到 guard 有回報錯誤、⑥b 只是讀原始碼，
  //    都沒有驗到「重驗這件事本身」。決策抽成純函式之後才驗得到。
  check('⑦ 一切正常：直接過，不必重驗',
    evaluateReadyGate({ ready: true, sawErrorPopup: false }), { action: 'pass', why: '' })
  check('⑦ 推流一直沒就緒：要重驗',
    evaluateReadyGate({ ready: false, sawErrorPopup: false }).action, 'recheck')
  check('⑦ **先就緒、期間才出錯：也要重驗**（P2 原本漏的就是這格）',
    evaluateReadyGate({ ready: true, sawErrorPopup: true }).action, 'recheck')
  check('⑦ 重驗成功：過',
    evaluateReadyGate({ ready: true, sawErrorPopup: true, recheckedReady: true }).action, 'pass')
  check('⑦ **重驗失敗：不准報 ok**',
    evaluateReadyGate({ ready: true, sawErrorPopup: true, recheckedReady: false }).action, 'fail')
  check('⑦ 重驗失敗時要講得出原因',
    evaluateReadyGate({ ready: true, sawErrorPopup: true, recheckedReady: false }).why,
    '等待期間出現過錯誤提示')
  check('⑦ 沒就緒且重驗仍失敗：也是 fail',
    evaluateReadyGate({ ready: false, sawErrorPopup: false, recheckedReady: false }).action, 'fail')

  // ── ⑦c 關卡失敗之後會被回報成哪一種狀態 ────────────────────────────────────
  //    上層是 `/timeout/i.test(m) ? 'timeout' : 'err'`——所以 gate 的失敗訊息
  //    **不能含 timeout 字樣**，否則這種「畫面沒就緒」會被標成逾時，查的人會去查網路。
  //    ⚠️ 原因字串要**從產品那支拿**，不是在這裡再打一次——打一次就變成在驗我自己打的字。
  const failWhys = [
    evaluateReadyGate({ ready: false, sawErrorPopup: false, recheckedReady: false }).why,
    evaluateReadyGate({ ready: true, sawErrorPopup: true, recheckedReady: false }).why,
  ]
  check('⑦c 兩種失敗原因都講得出話（不是空字串）', failWhys.every(w => w.length > 0), true)
  for (const why of failWhys) {
    check(`⑦c 失敗原因「${why}」不含 timeout 字樣（不然會被誤標成逾時）`,
      /timeout/i.test(why), false)
  }

  // ── ⑦b 兩條路都要真的用這道關卡（結構檢查）──────────────────────────────────
  {
    const src = readFileSync('server/agent-runner.ts', 'utf8')
    // ⚠️ 這條 2026-09-22 改過。原本是「兩條路各套一次」（count === 2）——
    //    現在整段進場流程包進 `prepareH5()`，關卡改成**在 try/finally 之後套一次**，
    //    所有 return 路徑共用。這比兩處各套一次更嚴：**新增一條路也躲不掉**。
    const prepBody = src.slice(src.indexOf('const prepare = async (page: Page)'))
    const prepOnly = prepBody.slice(0, prepBody.indexOf('const shootAndUpload'))
    const calls = (prepOnly.match(/await applyReadyGate\(/g) || []).length
    check('⑦b prepare 只套一次關卡（所有 return 路徑共用）', calls, 1)
    check('⑦b 而且套在 finally 之後（不是某一條路自己套）',
      prepOnly.indexOf('await applyReadyGate(') > prepOnly.indexOf('} finally {'), true)
    check('⑦b 關卡判定 fail 時會丟錯（不會默默回報成功）',
      /verdict\.action === 'fail'[\s\S]{0,120}throw new Error/.test(src), true)
    check('⑦b 快速路徑不再自己記錯誤（改由外層那個唯一的看門狗記）',
      /fastSawError/.test(src), false)
    // 丟出去之後真的會變成 err／timeout，不是被吞掉
    check('⑦b prepare 丟錯會落到 postStatus(err|timeout)',
      /const actual = await prepare\(page\)[\s\S]{0,600}?postStatus\(task\.id, \/timeout\/i\.test\(m\) \? 'timeout' : 'err', m\)/.test(src), true)
  }

  // ── ⑥b 上層真的有用那個訊號重驗（結構檢查）────────────────────────────────
  {
    const src = readFileSync('server/agent-runner.ts', 'utf8')
    check('⑥b 有把「期間關過錯誤框」記下來', /sawErrorPopup = g\.errors\.length > 0/.test(src), true)
    check('⑥b guard 運作中沒有殘留另一條非 strict 呼叫',
      /ready = await waitForUiScreenshotReady\(page\)[\s\S]{0,400}?await dismissUiScreenshotPopups/.test(src), false)
  }

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
console.log('通過——彈窗處理的各類情況都照規則走')
console.log('⚠️ 第 ④ 條是讀原始碼的結構檢查，不是行為檢查；真環境的行為仍需實機跑')
