/**
 * H5 提示框／彈窗的**辨識規則**（1007，機台測試提示窗處理；CodeX 定案）。
 *
 * - 只負責「這是哪一種框」（穩定 id），**不決定要怎麼處理**——機台測試與 UAT 各自依流程設定 category／action
 *   （例：UAT 目前連 Game exception 都按 Confirm，機台測試要判本台異常；cashout-credit 只有退出時才 ack）
 * - 兩邊跑的是同一套 H5 前端，辨識規則只寫這一份，新框出現時兩邊一起補
 * - 規格：osm-qa-agent/reports/spec-mt-popup-handling-1007.md
 *
 * 純資料＋純函式；頁面內抓框的腳本（POPUP_SNAPSHOT_IN_PAGE）也在這裡，runner 與探針用同一份。
 */

/** text：比對框內文字；selector：框本身（或框內）有這個元素就算 */
export const POPUP_CATALOG = [
  { id: 'bonus-15min', text: /complete the bonus game within 15 minutes/i },
  { id: 'cannot-quit', text: /game is running and cannot be quit/i },
  { id: 'reserve-panel', text: /want to reserve this machine|number of reservations remaining/i },
  { id: 'quit-wait', text: /quit game,? please wait/i },
  { id: 'cashout-credit', text: /cash\s*-?\s*out\s+credit/i },
  { id: 'game-exception', text: /game exception|contact (the )?customer service/i },
  { id: 'other-device', text: /logged in (from|on|at) another device|account (is )?(already )?logged in elsewhere/i },
  { id: 'conn-timeout', text: /machine connection timeout/i },
  { id: 'lhb-transfer', text: /bonus has been transferred/i },
  { id: 'no-machine', text: /no machines? (is |are )?available/i },
  { id: 'no-permission', text: /do not have permission to use this feature/i },
  // 進機台錯誤碼（knowledge/h5-client-interaction.md §8.5）
  // 只認「錯誤／代碼」字樣後面跟著的數字，避免把餘額、機台號裡剛好有 1044 的框認錯
  { id: 'entry-1044', text: /(error|code|錯誤|错误)\D{0,12}\b1044\b/i },
  { id: 'entry-10006', text: /(error|code|錯誤|错误)\D{0,12}\b10006\b/i },
  // 以元素認的
  { id: 'denom', selector: '.select-main' },
  { id: 'play-game-char', selector: '.closeBtn' },
  { id: 'recommend', selector: '.recommend' },
]

/** 一律不可點（任何點擊路徑都要擋）。selector 只在「提示框裡」才算——大廳別處的 .view 不歸這裡管 */
export const NEVER_CLICK = [
  { id: 'reserve-now', text: /^\s*reserve now\s*$/i },
  { id: 'jp-view', selector: '.view' },
  { id: 'play-now', text: /^\s*play now\s*$/i },
  { id: 'join-in-game', text: /^\s*join\s*$/i, inMachineOnly: true },   // 大廳選機台要按 Join，只有進機台之後才禁
  { id: 'header-return', selector: '.header_btn_item_return' },
  { id: 'recharge-confirm', boxText: /recharge|top[\s-]?up|deposit|充值|儲值/i, text: /^\s*confirm\s*$/i },
]

/**
 * 框 → 命中的目錄 id（純函式）。box：{ text, classes: string[], hasSelector: (sel) => boolean }
 * 一個框可能同時命中多條：回傳全部（依目錄順序），由呼叫端的 policy 依優先序選
 */
export function matchPopup(box) {
  const out = []
  for (const r of POPUP_CATALOG) {
    if (r.text && r.text.test(box.text ?? '')) out.push(r.id)
    else if (r.selector && box.selectors?.includes(r.selector)) out.push(r.id)
  }
  return out
}

/** 這顆按鈕（在這個框裡）是不是禁點。btn：{ text, selectors: string[] }，boxText：所在框的文字 */
export function isNeverClick(btn, boxText = '', opts = {}) {
  for (const r of NEVER_CLICK) {
    if (r.inMachineOnly && !opts.inMachine) continue
    if (r.boxText && !r.boxText.test(boxText)) continue
    if (r.text && r.text.test(btn.text ?? '')) return r.id
    if (r.selector && !r.text && btn.selectors?.includes(r.selector)) return r.id
  }
  return null
}

/** 頁面裡用來找「框」的選擇器與門檻（規格 §3）；給頁面內腳本用 */
// .notification-close（全站 JP 廣播卡）不在這裡：它很小、由 closeJackpotNotification 另外處理
export const POPUP_BOX_SELECTORS = ['.box-title', '.box-content', '.van-dialog', '.my-dialog', '.el-dialog', '[class*=popup]', '[class*=dialog]', '.select-main', '.recommend']
export const POPUP_MIN_AREA = 0.10
/** 目錄裡用到的選擇器（頁面內要回報「框裡有沒有這些」） */
export const POPUP_PROBE_SELECTORS = [...new Set([...POPUP_CATALOG.filter(r => r.selector).map(r => r.selector), ...NEVER_CLICK.filter(r => r.selector).map(r => r.selector), '.box-btn_text1', '.box-btn_text2', '.btn-close', '.recommend-close'])]

/**
 * 頁面內抓「可見的框」（給 frame.evaluate 用，所以不能用到外面的變數——參數從 arg 傳進來）。
 * 每個框標上 data-mt-popup＝序號、框裡的按鈕標 data-mt-btn＝「框序號-按鈕序號」，之後點擊用這個屬性指回同一顆，
 * **Confirm 一定限定在命中的那個框裡**（CodeX：不能點畫面上任何一顆 Confirm）。
 * 框的判斷（規格 §3）：符合 boxSelectors 之一、可見、面積 ≥ 畫面 minArea，或裡面有 .box-btn_text1／2。
 * 只回最外層的框（巢狀的不重複算）。
 */
export const POPUP_SNAPSHOT_IN_PAGE = ({ boxSelectors, probeSelectors, minArea }) => {
  const vw = window.innerWidth || 1, vh = window.innerHeight || 1
  const shown = el => {
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    const s = getComputedStyle(el)
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05
  }
  const cands = []
  for (const sel of boxSelectors) for (const el of document.querySelectorAll(sel)) cands.push(el)
  const boxes = []
  for (const el of cands) {
    if (!shown(el)) continue
    const r = el.getBoundingClientRect()
    const big = (r.width * r.height) / (vw * vh) >= minArea
    if (!big && !el.querySelector('.box-btn_text1,.box-btn_text2')) continue
    // 常駐的空容器（class 剛好含 popup／dialog 的版面層）不算框：要有字或按鈕
    if (!(el.innerText || '').trim() && !el.querySelector('button,[class*=btn]')) continue
    if (boxes.some(b => b.contains(el))) continue
    for (let i = boxes.length - 1; i >= 0; i--) if (el.contains(boxes[i])) boxes.splice(i, 1)
    boxes.push(el)
  }
  document.querySelectorAll('[data-mt-popup]').forEach(e => e.removeAttribute('data-mt-popup'))
  document.querySelectorAll('[data-mt-btn]').forEach(e => e.removeAttribute('data-mt-btn'))
  return boxes.map((b, i) => {
    b.setAttribute('data-mt-popup', String(i))
    const has = sel => { try { return b.matches(sel) || !!b.querySelector(sel) } catch { return false } }
    const btnEls = [...b.querySelectorAll('button,.box-btn_text1,.box-btn_text2,.btn-close,.closeBtn,.recommend-close,.select-btn,.my-button,[class*=btn]')].filter(shown)
    const buttons = btnEls.slice(0, 12).map((e, j) => {
      e.setAttribute('data-mt-btn', `${i}-${j}`)
      return { ref: `${i}-${j}`, text: (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40), selectors: probeSelectors.filter(s => { try { return e.matches(s) || !!e.closest(s) } catch { return false } }), cls: String(e.className || '').slice(0, 80) }
    })
    const r = b.getBoundingClientRect()
    return {
      ref: String(i), text: (b.innerText || b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      cls: String(b.className || '').slice(0, 120), selectors: probeSelectors.filter(has), buttons,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    }
  })
}

/** NEVER_CLICK 的可序列化版本（RegExp 傳不進頁面，改傳 source／flags） */
export const NEVER_CLICK_SERIALIZED = NEVER_CLICK.map(r => ({
  id: r.id,
  text: r.text ? { source: r.text.source, flags: r.text.flags } : null,
  selector: r.selector ?? null,
  boxText: r.boxText ? { source: r.boxText.source, flags: r.boxText.flags } : null,
  inMachineOnly: !!r.inMachineOnly,
}))

/**
 * 頁面內第二層攔截（context.addInitScript(NEVER_BLOCK_IN_PAGE, NEVER_CLICK_SERIALIZED)，每個 frame 都會跑；
 * CodeX：只是第二層，不能取代 runner 的 uiAct；canvas 內畫出來的按鈕辨識不到）。
 * 在 window capture 階段攔 pointer／mouse／touch／click 全部階段（只擋 down 不等於擋住整個手勢），
 * 目標（composedPath 第一個元素往上找按鈕）命中禁點就 preventDefault＋stopImmediatePropagation，記到 window.__mtBlockedClicks。
 * 規則跟 isNeverClick 同一份（NEVER_CLICK_SERIALIZED）；inMachineOnly 的規則要 runner 進機台後設 window.__mtInMachine = true 才生效。
 */
export const NEVER_BLOCK_IN_PAGE = (rules) => {
  if (window.__mtNeverBlock) return
  window.__mtNeverBlock = true
  window.__mtBlockedClicks = []
  const RULES = rules.map(r => ({ ...r, text: r.text ? new RegExp(r.text.source, r.text.flags) : null, boxText: r.boxText ? new RegExp(r.boxText.source, r.boxText.flags) : null }))
  const BOX = '[data-mt-popup],.box-title,.box-content,.van-dialog,.my-dialog,.el-dialog,[class*=popup],[class*=dialog]'
  const judge = (ev) => {
    const path = typeof ev.composedPath === 'function' ? ev.composedPath() : []
    const t = (path[0] && path[0].nodeType === 1) ? path[0] : ev.target
    if (!t || !t.closest) return null
    const btn = t.closest('button,[class*=btn],a,[role=button]') || t
    const text = (btn.innerText || btn.textContent || '').replace(/\s+/g, ' ').trim()
    const box = t.closest(BOX)
    const boxText = box ? (box.innerText || '') : ''
    for (const r of RULES) {
      if (r.inMachineOnly && !window.__mtInMachine) continue
      if (r.boxText && !r.boxText.test(boxText)) continue
      if (r.text && r.text.test(text)) return r.id
      if (r.selector && !r.text && box && t.closest(r.selector)) return r.id
    }
    return null
  }
  const stop = (ev) => {
    const id = judge(ev)
    if (!id) return
    ev.preventDefault(); ev.stopImmediatePropagation()
    if (ev.type === 'click' || ev.type === 'touchend' || ev.type === 'pointerup') window.__mtBlockedClicks.push({ id, type: ev.type, at: Date.now() })
  }
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'touchstart', 'touchend']) window.addEventListener(type, stop, { capture: true, passive: false })
}
