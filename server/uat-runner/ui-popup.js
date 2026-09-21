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
  // 面額選單第二層：「SELECT A DENOMINATION → YES / NO」（2026-09-18 實測）
  { kind: 'denom', re: 'denomination|面額|面额' },
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
  const KNOWN = known.map(k => ({ kind: k.kind, re: new RegExp(k.re, 'i') }))
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
    const hit = KNOWN.find(k => k.re.test(boxText))
    // strict 模式：對不上已知類別就**不要點**，把它回報出去
    if (isStrict && !hit) return JSON.stringify({ btn: t, boxText, skipped: true })
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
 * @param {import('playwright').Page} page
 * @param {string} label 只用在 log
 * @param {{ strict?: boolean, rounds?: number, settleMs?: number, log?: (msg: string) => void }} [opts]
 * @returns {Promise<{ dismissed: number, errors: string[], blocked: string[] }>}
 */
export async function dismissUiPopups(page, label, opts = {}) {
  const strict = opts.strict === true
  const rounds = opts.rounds ?? 4
  const settleMs = opts.settleMs ?? 800
  const log = opts.log ?? (msg => console.log(msg))

  let dismissed = 0
  const errors = []
  /** 看到了但**沒有點**的彈窗（strict 模式下的未知彈窗）。要回報出去，不能默默略過 */
  const blocked = []

  for (let round = 1; round <= rounds; round++) {
    // ── ① 面額選單 ──────────────────────────────────────────────────────────
    const denom = await page.$('.select-bg')
    if (denom) {
      const firstBtn = await page.$('.select-row .van-col')
      if (firstBtn) {
        await firstBtn.click().catch(() => {})
        await page.waitForTimeout(settleMs)
        dismissed++
        log(`[UI-SS] ${label} — 關掉面額選單（第 ${round} 輪）`)
        continue
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
      boxText = o.boxText
      skipped = o.skipped === true
    } catch { /* 理論上不會走到，保守處理 */ }

    // 看到但沒點：記下來就停手，不要再轉下一輪（畫面沒變，轉下去只是原地打轉）
    if (skipped) {
      blocked.push(boxText || btn)
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
  }

  return { dismissed, errors, blocked }
}
