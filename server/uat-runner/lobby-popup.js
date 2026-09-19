/**
 * H5 大廳那張整頁彈窗的關閉動作。
 *
 * **為什麼單獨一支**：`agent-runner.ts` 裡原本那套 `dismissUiScreenshotPopups`
 * 找的是「文字剛好等於 YES/CONFIRM/確定」的按鈕——那是**機台內**的面額選單與 Tips 錯誤框。
 * 大廳這張中獎彈窗上一個那種字都沒有，只有一顆 `.closeBtn`（24x24 的 ✕）跟一顆「PLAY NOW」，
 * 所以舊邏輯對它完全無效。2026-09-19 實測（osmel002）：彈窗蓋著的時候
 * **每一個 click 都 timeout**，而訊息只寫 `locator.click: Timeout 10000ms exceeded`，
 * 看起來像選擇器寫錯或網站很慢——連續三次判斷錯方向就是這樣來的。
 *
 * 🚨 **絕對不能點 PLAY NOW／JOIN／START 這類。** 那會直接進機台，
 *    把「關掉彈窗」變成一個有副作用的動作，而且測試會從一個沒人預期的狀態開始。
 *    所以這裡**只認關閉鍵**（class 含 close），而且再用文字擋一次。
 *
 * ⚠️ 放在共用模組而不是抄一份到 agent：抄一份的話，驗證腳本驗的是抄的那份，
 *    真正上線跑的是另一份——這個專案已經被「兩個 host 各寫一份」咬過好幾次。
 */

/**
 * 只認關閉鍵、不碰任何會進機台的按鈕。
 *
 * 🚨 **用白名單，不要用「class 含 close 就關」。**
 *    第一版是後者，結果它在進到遊戲分頁之後把一顆 `btn-close` 也關掉了——
 *    那顆是不是遊戲自己的 UI，我當下**無法證明它是無害的**。
 *    關錯東西的症狀是「測試在一個沒人預期的畫面上繼續跑」，比關不掉更難查。
 *    所以只認實際觀察到的中獎播報彈窗（2026-09-19 在 osm-h5 大廳量到的）：
 *      `closeBtn`            整頁 JACKPOT 中獎彈窗右上角的 ✕（24x24）
 *      `notification-close`  上方跑馬燈式的中獎通知
 *    其他長得像關閉鍵的**只記錄、不點**，回報給呼叫端決定要不要加白名單。
 */
export const LOBBY_CLOSE_ALLOW = ['closeBtn', 'notification-close']

export const LOBBY_CLOSE_IN_PAGE = (allow) => {
  const ENTERS = /play\s*now|join|start|enter|立即|進入|进入/i
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    const st = getComputedStyle(el)
    return r.width > 4 && r.height > 4 && r.width <= 80 && r.height <= 80
      && st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0'
  }
  const seen = []
  for (const el of Array.from(document.querySelectorAll('[class*="close"], [class*="Close"]'))) {
    if (!visible(el)) continue
    const txt = (el.textContent || '').trim()
    if (ENTERS.test(txt)) continue
    const cls = el.getAttribute('class') || ''
    const classes = cls.split(/\s+/).filter(Boolean)
    if (!classes.some(c => allow.includes(c))) { seen.push(cls.slice(0, 40)); continue }
    el.click()
    return { closed: cls.slice(0, 60), skipped: seen }
  }
  return { closed: '', skipped: seen }
}

/**
 * 關到關不掉為止（最多 `rounds` 輪）。回傳關掉的 class 清單，空陣列代表本來就沒有彈窗。
 *
 * @param {import('playwright').Page} page
 * @param {{ rounds?: number, settleMs?: number }} [opts]
 * @returns {Promise<string[]>}
 */
export async function dismissLobbyPopups(page, { rounds = 4, settleMs = 800, allow = LOBBY_CLOSE_ALLOW } = {}) {
  const closed = []
  const skipped = new Set()
  for (let i = 0; i < rounds; i++) {
    const r = await page.evaluate(LOBBY_CLOSE_IN_PAGE, allow).catch(() => ({ closed: '', skipped: [] }))
    for (const s of (r.skipped ?? [])) skipped.add(s)
    if (!r.closed) break
    closed.push(r.closed)
    await page.waitForTimeout(settleMs)
  }
  // 沒關的那些要講出來——白名單漏掉一個的症狀是「彈窗還在但沒人提」
  return { closed, skipped: [...skipped] }
}

/**
 * 🚨 **關一次是不夠的——大廳的中獎彈窗會一直冒出來。**
 *
 * 2026-09-19 實測：開場關掉一張 `closeBtn` ＋ 三張 `notification-close` 之後，
 * 十幾秒內又跳出**另一張**（同樣整頁，內容是別人中獎的播報）。只要有人中獎就會播，
 * 所以這不是「進場關一次」的問題，是**整段測試期間都要有人盯著關**。
 * 不盯的話，click 會在一個隨機的時間點 timeout，症狀完全無法重現——
 * 最難查的那種 flaky。
 *
 * ⚠️ 每一次關掉都要能被記錄下來。萬一哪天有 TC 就是要驗「彈窗會出現」，
 *    症狀會變成「這個 TC 永遠失敗而且看不出為什麼」——所以留 `onClose` 讓呼叫端寫 log，
 *    而且要能關掉這個看門狗（回傳 stop）。
 *
 * @param {import('playwright').Page} page
 * @param {{ intervalMs?: number, onClose?: (cls: string) => void }} [opts]
 * @returns {() => string[]} 停止並回傳這段期間關掉的清單
 */
export function startLobbyPopupWatcher(page, { intervalMs = 1500, onClose, allow = LOBBY_CLOSE_ALLOW } = {}) {
  const closed = []
  let stopped = false
  const tick = async () => {
    if (stopped) return
    const r = await page.evaluate(LOBBY_CLOSE_IN_PAGE, allow).catch(() => ({ closed: '' }))
    if (r.closed) {
      closed.push(r.closed)
      if (onClose) { try { onClose(r.closed) } catch { /* log 失敗不能影響測試 */ } }
    }
  }
  const timer = setInterval(() => { void tick() }, intervalMs)
  // ⚠️ unref：這顆 timer 不能讓 node 程序活著不肯結束
  if (typeof timer.unref === 'function') timer.unref()
  return () => { stopped = true; clearInterval(timer); return closed }
}
