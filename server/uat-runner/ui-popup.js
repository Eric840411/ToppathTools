/**
 * 機台內／大廳彈窗的關閉邏輯（Confirm 類）。
 *
 * **為什麼單獨一支**：原本整段寫在 `agent-runner.ts` 裡，驗證腳本碰不到——
 * 要驗就只能在測試裡再寫一份同樣的判斷，那等於**測試在驗自己**。
 * 這個專案已經被「兩個地方各寫一份規則」咬過好幾次，所以抽到共用模組，
 * `agent-runner` 與驗證腳本跑的是**同一份**。
 *
 * 跟 `lobby-popup.js` 的分工：
 *   - `lobby-popup.js` → 大廳整頁 JACKPOT 中獎彈窗，**只認 ✕ 關閉鍵**
 *   - 這一支           → 機台內的面額選單與 Tips 提示框，**按 Confirm／YES**
 */
import { LOBBY_CLOSE_IN_PAGE, LOBBY_CLOSE_ALLOW } from './lobby-popup.js'

/**
 * **已確認用途的彈窗。**只有這些能在 `strict`（一直盯著）模式下自動按下去。
 *
 * 🚨 為什麼要分已知／未知：一次性關一下，跟**每 0.7 秒關一次**，風險完全不是同一件事
 *    （CodeX 2026-09-21）。連續點「文字剛好是 Confirm 的按鈕」，總有一天會在遊戲畫面裡
 *    點到不該點的東西——而症狀是「流程從一個沒人預期的狀態繼續跑」，比卡住更難查。
 *    所以 strict 模式只點**已經實際觀察過、知道按下去會發生什麼**的那幾種；
 *    沒見過的一律不點，把文字回報出去讓人決定要不要加進來。
 *
 * ⚠️ 要新增一種，條件是「實際在環境上看過，而且知道按下去的後果」，不是「看起來應該沒差」。
 */
export const UI_POPUP_KNOWN = [
  /**
   * 面額選單第二層：「SELECT A DENOMINATION → YES / NO」（2026-09-18 實測）
   *
   * 🚨 **只比對文字會漏掉它。**2026-09-22 端到端實測：那個框的 DOM 裡
   *    **一個字都沒有 DENOMINATION**，整段文字就是 `YESNO`（兩顆按鈕而已），
   *    所以 strict 模式判成「沒見過」→ 不點 → 卡死在那裡。
   *    它的容器是 `.select-main`，跟第一層面額選單的 `.select-bg` 同一家族——
   *    這是產品自己一直在用的錨點，所以改成**文字或容器 class 命中都算**。
   */
  { kind: 'denom', re: 'denomination|面額|面额', cls: 'select-main|select-bg' },
  // Tips 錯誤框：`CODE: ERR_NETWORK`、`Game exception, please contact customer service.(39)`
  { kind: 'tips-error', re: 'ERR_|exception|異常|异常|customer service|錯誤|错误|失敗|失败|\\(\\d{1,3}\\)' },
  // 純提示框（標題就是 Tips／提示／Notice），內容不是錯誤
  { kind: 'tips', re: '^\\s*(tips|提示|notice)\\b' },
]

/** 內容看起來是「錯誤」而不只是提示——關掉它不代表這一張圖是乾淨的 */
export const UI_POPUP_ERROR_RE = /ERR_|error|錯誤|错误|失败|失敗|exception|異常|异常|customer service/i

/**
 * 在頁面裡找一顆 Confirm／YES 並按下去。**一次只處理一個**，由外面的迴圈轉。
 *
 * ⚠️ **從按鈕往上找彈窗，不要從容器往下找按鈕。** 第一版只掃 class 含
 *    select/popup/overlay/dialog/confirm 的容器，結果實際卡住流程的那個彈窗長這樣
 *    （2026-09-18 使用者回報的 error 39）：
 *      <div class="bg-img"><div class="box-title">Tips</div>
 *        <div class="box-content"><div class="text-msg">Game exception...(39)</div></div>
 *        <div class="box-end"><button class="van-button box-btn"><div>Confirm</div></button></div>
 *    容器叫 `bg-img`、按鈕叫 `box-btn`——一個關鍵字都沒中，所以整晚都關不掉。
 *
 * @returns `''` 代表沒找到；否則是 JSON 字串 `{ btn, boxText, kind }`（`skipped: true` = 看到了但沒點）
 */
export const UI_POPUP_CONFIRM_IN_PAGE = ({ isStrict, known }) => {
  const CONFIRM = new Set(['YES', 'CONFIRM', '確定', '确定', 'OK', '確認', '确认', '我知道了', 'GOT IT'])
  const KNOWN = known.map(k => ({
    kind: k.kind,
    re: new RegExp(k.re, 'i'),
    cls: k.cls ? new RegExp(k.cls, 'i') : null,
  }))
  const POPUPISH = /select|popup|overlay|dialog|confirm|modal|mask|alert|toast|tips|bg-img|box-/i
  const TITLEISH = /^(tips|提示|notice|warning|error|錯誤|错误|系統提示|系统提示)$/i
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    const st = getComputedStyle(el)
    return r.width > 10 && r.height > 10 && st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0'
  }
  // 彈窗的根：往上最多爬 8 層，取「最外層」有彈窗特徵的那個（這樣記到的文字才含標題與內文）
  const dialogRootOf = (el) => {
    let cur = el.parentElement
    let root = null
    for (let i = 0; i < 8 && cur; i++, cur = cur.parentElement) {
      const cls = cur.getAttribute('class') || ''
      const hasTitle = Array.from(cur.children).some(c => TITLEISH.test((c.textContent || '').trim()))
      if (POPUPISH.test(cls) || hasTitle) root = cur
    }
    return root
  }
  // ⚠️ **先找真的按鈕，找不到才退而求其次掃 div/span。**
  //    不分層的話會踩到這個坑：彈窗的標題或內文剛好也是「Confirm」，而它在 DOM 順序上排在
  //    按鈕前面，結果每一輪都點在那段文字上（點了等於沒點），彈窗一直在，流程照樣卡住。
  const TIERS = ['button, .van-button, [role="button"], [class*="btn"], [class*="Btn"]', 'div, span']
  const cands = TIERS.flatMap(sel => Array.from(document.querySelectorAll(sel)))
  for (const b of cands) {
    const t = (b.textContent || '').replace(/\s+/g, ' ').trim().toUpperCase()
    if (!CONFIRM.has(t) || !visible(b)) continue
    const r = b.getBoundingClientRect()
    // 版面上剛好只有這串字的大區塊不算按鈕——點下去會誤觸背後的東西
    if (r.width > 520 || r.height > 200) continue
    const root = dialogRootOf(b)
    if (!root) continue
    const boxText = (root.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200)
    const rootCls = root.getAttribute('class') || ''
    // 文字或容器 class 命中都算——有些彈窗的 DOM 裡根本沒有可辨識的字
    const hit = KNOWN.find(k => k.re.test(boxText) || (k.cls && k.cls.test(rootCls)))
    // strict 模式：對不上已知類別就**不要點**，把它回報出去
    // ⚠️ 回報要帶**容器的 class**。2026-09-22 實測回報過一筆內容只有 `YESNO` 的——
    //    六個字看不出那是什麼彈窗，也就無從判斷能不能加進白名單，等於白回報。
    if (isStrict && !hit) {
      return JSON.stringify({ btn: t, boxText, cls: rootCls.slice(0, 60), skipped: true })
    }
    b.click()
    return JSON.stringify({ btn: t, boxText, kind: hit ? hit.kind : 'loose' })
  }
  return ''
}

/**
 * 關掉畫面上的彈窗，**關到偵測不到為止**（最多 `rounds` 輪）。
 *
 * 每一輪依序試三種：
 *   ① 面額選單（`.select-bg` → 點第一個面額）
 *   ② 大廳中獎彈窗的 ✕（白名單，`lobby-popup.js`）
 *   ③ Confirm／YES 類（上面那支）
 *
 * ⚠️ 實測不只一層：面額選單關掉之後有些機台還會再跳「SELECT A DENOMINATION → YES / NO」。
 *    只處理第一層的話，第二層會留在畫面上把下半部蓋住——**截圖照樣拍得到，只是拍到被蓋住的畫面**。
 *
 * 🚨 **上限不能設得跟「畫面上有幾個彈窗」一樣小——會被前面的種類吃光。**
 *    2026-09-21 使用者給網址實測：大廳同時有 1 個 `closeBtn` ＋ 3 個 `notification-close`
 *    ＋ 1 個 `Tips: Game exception...(39)` 的 Confirm 框。上限原本是 4，
 *    **四輪全部花在 ✕ 上，③ 一次都沒跑到**——於是那個 Confirm 框留在畫面上，
 *    而回報寫的是「關掉 4 個彈窗」，看起來完全正常。這就是使用者回報的
 *    「不會自動點掉 Confirm」的真正原因。
 *    現在上限是安全網（預設 12），真正的結束條件是「這一輪什麼都沒關到」。
 *    ⚠️ 撞到上限時**一定要 log**，否則又會變成無聲地少做事。
 *
 * @param {import('playwright').Page} page
 * @param {string} label 只用在 log
 * @param {{ strict?: boolean, rounds?: number, settleMs?: number, log?: (msg: string) => void }} [opts]
 * @returns {Promise<{ dismissed: number, errors: string[], blocked: string[] }>}
 */
export async function dismissUiPopups(page, label, opts = {}) {
  /**
   * 🚨 **有看門狗在跑的時候，所有呼叫都得走它的佇列，而且一律降級成 strict。**
   *
   * CodeX 2026-09-21 [P1]：主流程原本在看門狗運作中另外呼叫了一次「非 strict」的關窗，
   * 造成兩件事——① 看門狗刻意**不點**的未知彈窗，被主流程點掉了，strict 等於白設；
   * ② 兩條路同時點同一顆按鈕。
   *
   * ⚠️ 修法不是「記得不要那樣呼叫」，而是**讓它做不到**：呼叫端不必知道有沒有看門狗，
   *    這裡自己查。靠紀律維持的不變量，遲早會有人（包括我）在別的地方再寫一次。
   */
  const guard = ACTIVE_GUARDS.get(page)
  if (guard && !opts.__fromGuard) return guard.runOnce()

  const strict = opts.strict === true || !!opts.__fromGuard
  const rounds = opts.rounds ?? 12
  const settleMs = opts.settleMs ?? 800
  const log = opts.log ?? (msg => console.log(msg))

  let dismissed = 0
  const errors = []
  /** 看到了但**沒有點**的彈窗（strict 模式下的未知彈窗）。要回報出去，不能默默略過 */
  const blocked = []
  /**
   * **暫時性**的阻塞：面額選單在、但裡面的按鈕還沒渲染出來。
   * ⚠️ 跟 `blocked` 分開放（CodeX 2026-09-24）：按鈕可能只是晚一點才出現，下一輪就關掉了。
   *    混進 `blocked` 的話，它只累積不清除，**乾淨的截圖也會被標成有彈窗沒處理**。
   *    看門狗只保留「最後一輪」的暫時阻塞——後來關掉了就自然消失。
   */
  const transient = []
  /** 用光輪數時還在關——代表沒關完，一定要講出來 */
  let hitCap = false

  for (let round = 1; round <= rounds; round++) {
    // ── ① 面額選單 ──────────────────────────────────────────────────────────
    //
    // 🚨 **點完一定要確認它真的不見了。**（2026-09-22 端到端實測抓到）
    //    原本寫成 `await firstBtn.click().catch(() => {})` 然後無條件 `dismissed++; continue`——
    //    **點失敗被吞掉，還算成「關掉了」**。實測 log 長這樣：
    //      關掉面額選單（第 1 輪）… 第 2 輪 … 第 3 輪 … 第 4 輪 … 第 5 輪
    //    面額選單一直都在，因為它**被上面那層 `Tips(39)` 蓋住**，Playwright 的
    //    actionability 檢查點不下去。而每一輪都從 ① 開始、又每次都 `continue`，
    //    於是 ② ✕ 跟 ③ Confirm **一次都輪不到**——上面那層永遠不會被處理，
    //    兩邊互相卡死，輪數用光為止。
    //    ⚠️ 這就是使用者回報「還是不會自動點掉 Confirm」的真正原因。
    //
    // 所以：點了但沒消失就**不算進度、也不 continue**，讓 ② ③ 有機會先處理上層。
    const denom = await page.$('.select-bg')
    if (denom) {
      const firstBtn = await page.$('.select-row .van-col')
      if (firstBtn) {
        const clicked = await firstBtn.click({ timeout: 2000 }).then(() => true).catch(() => false)
        await page.waitForTimeout(settleMs)
        const gone = (await page.$('.select-bg')) === null
        if (gone) {
          dismissed++
          log(`[UI-SS] ${label} — 關掉面額選單（第 ${round} 輪）`)
          if (round === rounds) hitCap = true
          continue
        }
        log(`[UI-SS] ${label} — 面額選單${clicked ? '點了但沒關掉' : '點不下去（多半被別的彈窗蓋住）'}，改先處理上層`)
      } else {
        // 🚨 原本這個分支**什麼都不印**——面額選單明明在，卻一點紀錄都沒有（2026-09-24 查 log 時卡在這裡）
        const note = '面額選單在，但找不到可點的面額按鈕（.select-row .van-col）'
        if (!transient.includes(note)) transient.push(note)
        log(`[UI-SS] ${label} — ${note}，下一輪再試`)
      }
    }

    // ── ② 大廳整頁中獎彈窗的 ✕ ─────────────────────────────────────────────
    // 🚨 這張只能點 ✕、不能點 PLAY NOW——點下去會直接進機台，
    //    把「關掉彈窗」變成一個有副作用的動作。白名單在 `lobby-popup.js`。
    const closeResult = await page.evaluate(LOBBY_CLOSE_IN_PAGE, LOBBY_CLOSE_ALLOW)
      .catch(() => ({ closed: '', skipped: [] }))
    if (closeResult.closed) {
      await page.waitForTimeout(settleMs)
      dismissed++
      log(`[UI-SS] ${label} — 關掉彈窗（✕ .${closeResult.closed}，第 ${round} 輪）`)
      if (round === rounds) hitCap = true
      continue
    }

    // ── ③ Confirm／YES 類 ───────────────────────────────────────────────────
    const clicked = await page
      .evaluate(UI_POPUP_CONFIRM_IN_PAGE, { isStrict: strict, known: UI_POPUP_KNOWN })
      .catch(() => '')
    if (!clicked) break

    let btn = clicked
    let boxText = ''
    let skipped = false
    try {
      const o = JSON.parse(clicked)
      btn = o.btn
      boxText = o.cls ? `${o.boxText}（容器 .${o.cls}）` : o.boxText
      skipped = o.skipped === true
    } catch { /* 理論上不會走到，保守處理 */ }

    // 看到但沒點：記下來就停手，不要再轉下一輪（畫面沒變，轉下去只是原地打轉）
    if (skipped) {
      blocked.push(`未知彈窗（不在已確認清單，沒有自動點）：${boxText || btn}`)
      log(`[UI-SS] ${label} — ⚠️ 有彈窗但不在已確認清單裡，**沒有點**：${boxText || btn}`)
      break
    }

    await page.waitForTimeout(settleMs)
    dismissed++
    // 內容看起來是錯誤提示就記下來——關掉它不代表那張圖是乾淨的
    if (UI_POPUP_ERROR_RE.test(boxText)) {
      errors.push(boxText)
      log(`[UI-SS] ${label} — 關掉錯誤提示（${btn}）：${boxText}`)
    } else {
      log(`[UI-SS] ${label} — 關掉彈窗（按 ${btn}，第 ${round} 輪）`)
    }
    if (round === rounds) hitCap = true
  }

  // ⚠️ 撞到上限代表「還在關但被喊停」——畫面上很可能還有東西蓋著。
  //    不講的話，回報看起來就只是「關掉了 N 個」，跟正常收工長得一模一樣。
  if (hitCap) {
    // ⚠️ **措辭只能說「尚未確認」，不能說「仍有彈窗」**（CodeX 2026-09-21）。
    //    最後一輪剛好把最後一個關掉時，畫面其實是乾淨的——只是我們沒有多跑一輪去確認。
    //    正常收工是「跑了一輪什麼都沒關到」才 break，那一輪就是確認；撞上限少的正是那一輪。
    blocked.push(`關到上限 ${rounds} 輪（尚未確認畫面是否清空）`)
    log(`[UI-SS] ${label} — ⚠️ 關到上限 ${rounds} 輪就停了，沒有多跑一輪確認畫面是否清空`)
  }

  return { dismissed, errors, blocked, transient }
}

/** page → 正在跑的看門狗。用 WeakMap，頁面關掉就跟著回收 */
const ACTIVE_GUARDS = new WeakMap()

/**
 * **在一段等待期間一直盯著彈窗。**
 *
 * 為什麼需要：原本只在「進機台前」「推流就緒後」各關一次——中間那幾段完全沒人看：
 * 點卡片進場的那一下、等推流的迴圈、截圖前等的那幾秒。彈窗在這三段冒出來的話，
 * 症狀分別是「點了但還停在大廳」「Game surface not ready」「拍到被蓋住的畫面」，
 * **三種訊息都不會提到彈窗**（使用者 2026-09-21 回報）。
 *
 * ⚠️ **只處理已確認用途的彈窗**（`strict`）。理由見 `UI_POPUP_KNOWN`。
 * ⚠️ **所有動作都排在同一條佇列上**——包含外面直接呼叫 `dismissUiPopups` 的那些，
 *    它們會被導進 `runOnce()`。不這樣的話會變成「兩隻手搶同一顆按鈕」。
 * ⚠️ 有次數上限。沒有上限的話，遇到關不掉的彈窗會變成無聲的無限點擊。
 *
 * @param {import('playwright').Page} page
 * @param {string} label
 * @param {{ enabled?: boolean, intervalMs?: number, maxPasses?: number, log?: (m: string) => void }} [opts]
 */
export function startUiPopupGuard(page, label, opts = {}) {
  const result = { dismissed: 0, errors: [], blocked: [] }
  /** 最後一輪看到的暫時阻塞；stop() 時才併進 blocked（見 `transient` 的說明） */
  let lastTransient = []
  if (opts.enabled === false) return { stop: async () => result, runOnce: async () => result }

  /**
   * 🚨 **同一個 page 只能有一個看門狗。**再開一個會把 `ACTIVE_GUARDS` 裡的註冊蓋掉，
   *    變成兩隻手搶同一顆按鈕——而且外層那個從此再也收不到回報。
   *    所以巢狀呼叫回傳一個**共用結果、但 `stop()` 不做事**的把手：
   *    生命週期永遠由最外層那個擁有，內層提早 stop 不會把外層關掉。
   *    ⚠️ 用結構擋，不要靠「記得不要巢狀呼叫」——這個專案已經證明過紀律守不住。
   */
  const existing = ACTIVE_GUARDS.get(page)
  if (existing) {
    ;(opts.log ?? (m => console.log(m)))(`[UI-SS] ${label} — 已經有看門狗在跑了，沿用同一個（不另開）`)
    return { stop: async () => existing.result, runOnce: () => existing.runOnce() }
  }

  const intervalMs = opts.intervalMs ?? 700
  /**
   * 🚨 **原本是 40，而且用完就無聲停巡。**（2026-09-24 使用者給的 agent log 抓到）
   *    40 × 0.7 秒＋每輪處理時間，大約半分鐘就停了。第二台之後要先繞回大廳、退出上一台，
   *    進新機台時看門狗已經不在了——面額選單留在截圖上，log 一行都沒有。
   *    現在上限只當**安全網**：正常情況下是 `stop()` 叫停的，撞到上限一定留紀錄。
   */
  const maxPasses = opts.maxPasses ?? 600
  const startedAt = Date.now()
  let stopReason = ''
  let active = true
  let passes = 0
  /** 序列化用的尾巴：每個動作都接在前一個後面 */
  let tail = Promise.resolve()

  const enqueue = (fn) => {
    tail = tail.then(fn, fn)
    return tail
  }

  const onePass = async () => {
    const r = await dismissUiPopups(page, label, { __fromGuard: true, log: opts.log }).catch(() => null)
    if (!r) return
    result.dismissed += r.dismissed
    result.errors.push(...r.errors)
    lastTransient = r.transient ?? []
    // 同一個關不掉的彈窗每輪都會回報一次，去重之後才看得出到底有幾種
    for (const b of r.blocked) if (!result.blocked.includes(b)) result.blocked.push(b)
  }

  const guard = {
    /** 讓巢狀呼叫看得到同一份累計結果 */
    result,
    /** 外面在看門狗運作中呼叫 `dismissUiPopups` 時會被導到這裡——同一條佇列、同一套規則 */
    async runOnce() {
      await enqueue(onePass)
      return result
    },
    /** 停止並等佇列排空。⚠️ 截圖前一定要先 stop，否則會拍到「正在被點掉」的畫面 */
    async stop() {
      active = false
      await loop.catch(() => {})
      await tail.catch(() => {})
      ACTIVE_GUARDS.delete(page)
      for (const t of lastTransient) if (!result.blocked.includes(t)) result.blocked.push(t)
      lastTransient = []
      if (stopReason && !result.blocked.includes(stopReason)) result.blocked.push(stopReason)
      return result
    },
  }

  const loop = (async () => {
    while (active && passes < maxPasses) {
      await new Promise(r => setTimeout(r, intervalMs))
      if (!active) break
      passes++
      await enqueue(onePass)
    }
    // ⚠️ 撞到上限＝**巡檢提前結束**，之後冒出來的彈窗沒人管。措辭只能說「尚未確認」，
    //    不能說「仍有彈窗」——停巡當下畫面可能是乾淨的（CodeX 2026-09-24）
    if (active && passes >= maxPasses) {
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1)
      stopReason = `彈窗巡檢提前結束（達安全上限 ${maxPasses} 輪、已巡 ${secs} 秒），之後的畫面尚未確認`
      ;(opts.log ?? (m => console.log(m)))(`[UI-SS] ${label} — ⚠️ ${stopReason}`)
    }
  })()

  ACTIVE_GUARDS.set(page, guard)
  return guard
}

/**
 * **關掉彈窗之後，這一台到底算不算就緒？**
 *
 * 🚨 為什麼抽成純函式：這個判斷原本直接寫在 `agent-runner.ts` 的流程裡，而且
 *    **寫了兩次**（主路徑一次、「重新載入後已在機台內」的快速路徑一次）——
 *    結果主路徑修好了、快速路徑照樣拍黑畫面（CodeX 2026-09-21 連續抓到兩次）。
 *    兩份規則一定會漂移，所以收斂成一支，兩邊 import 同一個。
 *    也因為是純函式，**測試驗得到「重驗失敗不報 ok」本身**，不必只做結構檢查。
 *
 * 用法（兩階段）：
 *   1. `evaluateReadyGate({ ready, sawErrorPopup })` → `recheck` 就再驗一次推流
 *   2. `evaluateReadyGate({ ready, sawErrorPopup, recheckedReady })` → `fail` 就不准回報成功
 *
 * ⚠️ **`ready === true` 不代表可以直接過。**「推流先就緒、等截圖的那幾秒才跳錯誤框」
 *    這種也要重驗——不然關掉錯誤框就往下拍，拍到黑畫面而狀態欄寫 `ok`。
 *
 * @param {{ ready: boolean, sawErrorPopup: boolean, recheckedReady?: boolean }} input
 * @returns {{ action: 'pass' | 'recheck' | 'fail', why: string }}
 */
export function evaluateReadyGate({ ready, sawErrorPopup, recheckedReady }) {
  const why = !ready ? '推流一直沒就緒' : (sawErrorPopup ? '等待期間出現過錯誤提示' : '')
  if (!why) return { action: 'pass', why: '' }
  // 還沒重驗 → 先去重驗
  if (recheckedReady === undefined) return { action: 'recheck', why }
  return recheckedReady ? { action: 'pass', why } : { action: 'fail', why }
}

// ─── 座位追蹤（一個 gmid 拍完要退出機台）──────────────────────────────────────
//
// ⚠️ 放在這支而不是 agent-runner：決策要能單獨測（`scripts/ui-checks/ui-popup-dismiss.mjs` ⑭），
//    寫在 agent-runner 裡測試碰不到，要驗只能再抄一份。

/**
 * 這一頁看完之後，這個 gmid 的座位狀態。
 *
 * 🚨 **只有正面證據才能改狀態**（CodeX 2026-09-24）：
 *    - 看到坐在機台裡 → `held`
 *    - 看到大廳 → `none`（確認沒坐著）
 *    - 其他（頁面載入失敗、看不出來、連頁面都沒建起來）→ **維持原狀**
 *    原本直接用「這頁有沒有坐著」覆寫——前一個尺寸已經入座、下一頁載入失敗時，
 *    會被清成「沒坐著」，收尾兜底就跳過了，位子一直佔著。
 *
 * @param {'none'|'held'} prev
 * @param {'seated'|'lobby'|'unknown'} seen
 * @returns {'none'|'held'}
 */
export function nextSeatState(prev, seen) {
  if (seen === 'seated') return 'held'
  if (seen === 'lobby') return 'none'
  return prev
}

/**
 * 把「收尾完成」回報給伺服器，重試到收下為止（或次數用完）。
 *
 * 🚨 **回報失敗不能印成功**（CodeX 2026-09-24 [P2]）：原本五次全失敗後照樣印「已回報釋放」，
 *    agent 視窗那行字就不能當驗收證據了。所以回傳要分三件事：
 *    - `reported`：伺服器有沒有收到（HTTP 成功）
 *    - `released`：伺服器有沒有真的解鎖（runId 對得上、座位也確定）
 *    - `held`：伺服器是不是把 agent 鎖著等人確認座位
 *
 * @param {{ send: () => Promise<{ ok: boolean, released?: boolean, held?: boolean }>,
 *           sleep?: (ms: number) => Promise<void>, maxAttempts?: number }} opts
 */
export async function reportAgentDone({ send, sleep = ms => new Promise(r => setTimeout(r, ms)), maxAttempts = 5 }) {
  let lastError = ''
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const r = await send()
      if (r && r.ok) return { reported: true, released: !!r.released, held: !!r.held, attempts: attempt, error: '' }
      lastError = 'server 回應不是 ok'
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
    }
    if (attempt < maxAttempts) await sleep(2000 * attempt)
  }
  return { reported: false, released: false, held: false, attempts: maxAttempts, error: lastError }
}

/** 回報結果 → agent 視窗要印的那一行。**只有真的解鎖才能說「已釋放」** */
export function describeAgentDone(r) {
  if (!r.reported) return `⚠️ 收尾回報送不出去（試了 ${r.attempts} 次：${r.error}）——伺服器仍當這台忙碌，會在背景繼續重送`
  if (r.held) return '⚠️ 收尾回報已送達，但座位不明，伺服器把 agent 鎖著等人確認'
  if (r.released) return '收尾完成，伺服器已釋放'
  return '收尾回報已送達，但伺服器沒有解鎖（它記的已經是別的 run）'
}
