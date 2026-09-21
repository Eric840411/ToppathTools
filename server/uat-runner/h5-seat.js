/**
 * H5：從機台裡退出來，**把位子放掉**。
 *
 * 🚨 為什麼一定要有這支（跟 PC 的 `pcBackToLobby` 同一類問題，H5 這邊一直沒補）：
 *    一輪測試跑完沒有退出，那個帳號的位子還坐著。下一輪重新載入同一個 URL 會
 *    **直接掉回 /game**，於是所有大廳積木全部命中 0——而錯誤訊息長得像選擇器寫錯。
 *    實測證據：某一輪大廳的 3/4/6/9 四步全掛，而機台內的 12～19 全過。
 *
 * 選擇器都是 2026-09-19 在真站台量出來的（`scripts/ui-checks/h5-spin-quit-recon.mjs`），
 * 不是猜的：
 *   `.btn_cashout`      Cash Out
 *   `.box-btn_text2`    Tips 框右邊那顆 **Confirm**（`.box-btn_text1` 是 Cancel）
 *                       ⚠️ 之前用 `:text-is("Confirm")` **命中 0**，整件事卡在這裡很久
 *   `.header_btn_item`  header 三顆（CCTV／Sound／**Quit**），Quit 是**最後一顆**
 *
 * ⚠️ Cash Out 跳出來的框**會留著**。不按掉的話它會擋住整個畫面，
 *    下一輪一開始連面額跟 header 都點不動（症狀又是一片 timeout）。
 */

/**
 * 現在人在機台裡嗎。⚠️ 只認 H5 client 的網址——PC 版有自己的 `pcBackToLobby`。
 *
 * ⚠️ **讀不到網址一律當成「不在機台裡」。** 這顆會被放在收尾與 `goto` 之後，
 *    那兩個位置的 page 有可能已經關掉、或根本是測試用的假 page（沒有 `url()`）。
 *    讓它在那裡拋錯的話，會把「收尾做不成」變成「那一步失敗」，判定跟著歪掉——
 *    實測：TC 合約測試有 9 項從 `fail` 變成 `blocked`，而錯誤訊息完全指不到這裡。
 */
export function h5InGame(page) {
  let u = ''
  try { u = page?.url?.() ?? '' } catch { return false }
  return /osm-h5[.\w-]*\.osmslot\.org/.test(u) && u.includes('/game')
}

/**
 * ⚠️ 這個畫面的按鈕常常被發光托盤／彈窗蓋住，一般 click 會 timeout，
 *    而訊息完全看不出是被蓋住。所以退到 `el.click()`（事件照樣冒泡到 Vue handler）。
 *    **不退到座標**——座標會真的在那個位置按下去，把「不知道該點哪」變成看不見的誤點。
 */
async function tap(locator) {
  try { await locator.click({ timeout: 6000 }); return 'click' }
  catch {
    try { await locator.evaluate(el => el.click()); return 'js' }
    catch { return null }
  }
}

/**
 * 退回大廳。會依序處理：殘留的 Tips 框 → Cash Out → Tips 框 Confirm → Quit → Tips 框 Confirm。
 *
 * ⚠️ **順序是「最上層的確認框優先」**，跟 PC 那支同樣的理由：Tips 框蓋在其他按鈕上，
 *    先去點 Quit 的話只會一直點到被蓋住的按鈕，log 看起來像「點了十幾次都沒反應」。
 *
 * @returns {Promise<{ ok: boolean, steps: string[] }>} ok = 真的離開機台了
 */
export async function h5BackToLobby(page, { timeoutMs = 45_000, log, reloadUrl } = {}) {
  const steps = []
  const say = (s) => { steps.push(s); if (log) void log(`🚪 H5 退出：${s}`) }
  const dialogOpen = () => page.locator('.box-btn_text2').count().then(n => n > 0).catch(() => false)

  let cashedOut = false
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (!h5InGame(page)) return { ok: true, steps }

    // ① 有確認框就先按掉（它蓋住底下所有東西）
    if (await dialogOpen()) {
      const credit = await page.locator('.text-msg').first().innerText().catch(() => '')
      const via = await tap(page.locator('.box-btn_text2').first())
      say(`Confirm${credit ? `（${credit.replace(/\s+/g, ' ').trim().slice(0, 30)}）` : ''}${via ? '' : ' 失敗'}`)
      await page.waitForTimeout(4000)
      continue
    }


    /**
     * ② **預約視窗：要按「Exit To Lobby」，不是按 ✕。**
     *
     * 🚨 帳號**有預約資格**時，按 Quit 跳出來的是預約視窗——TC 原文就寫
     *    「右上Quit、下方Cash Out 離開正常（**有預約資格會跳預約視窗**）」。
     *    那個視窗上有**兩顆**按鈕：左邊灰色的 **Exit To Lobby**、右邊黃色的 Reserve Now。
     *    （從控制列的 `.reserve` 入口打開時只有 Reserve Now 一顆，所以第一次量的時候沒看到。）
     *
     *    我一路在按 ✕（`.box-close`）＝**取消退出**，於是「Quit → 關面板 → Quit → 關面板」
     *    無限繞到逾時，位子一直卡著。
     *
     * ⚠️ **絕對不能點 Reserve Now**——那會把機台保留 24 小時，是收不回來的副作用。
     *    所以用**完全相等**的文字比對，不做模糊匹配（跟 PC 的 `pcBackToLobby` 同一個理由）。
     */
    const exited = await page.evaluate(() => {
      const wanted = ['exit to lobby', '返回大廳', '回到大廳', '返回大厅']
      for (const el of document.querySelectorAll('div, span, button')) {
        const txt = (el.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
        if (!wanted.includes(txt)) continue
        const r = el.getBoundingClientRect()
        if (r.width < 10 || r.height < 10) continue
        el.click()
        return true
      }
      return false
    }).catch(() => false)
    if (exited) {
      say('按「Exit To Lobby」（有預約資格時 Quit 會跳這個視窗）')
      await page.waitForTimeout(5000)
      continue
    }

    /**
     * ③ **再關掉蓋在畫面上的面板**（預約 Reserve 那種整頁面板）。
     *
     * 🚨 面板開著時 Cash Out 與 header 全都點不到，退出流程只會對著被蓋住的 Quit
     *    重複點到逾時——**位子就這樣卡住**。
     * ⚠️ 那顆關閉鍵是 **`.box-close`**（20×20、背景是 webp data URI、沒有文字）。
     *    找它花了好幾輪：`elementFromPoint`（單數）只會回最上層的 `.bg`，
     *    要用 **`elementsFromPoint`（複數）** 才看得到它疊在上面。
     *    Escape／再點一次入口／`.closeBtn`／Quit 四種都關不掉。
     *
     * 🚨 **順序一定要在「按 Confirm」之後。** `.box-close` 同時也是 Tips 確認框的
     *    關閉鍵（同一家族：`.box-title`／`.box-content`／`.box-end`／`.box-close`）——
     *    放在前面的話會**一直把要按 Confirm 的那個框關掉**，於是
     *    「關面板 → Quit → 又跳框 → 關面板」無限繞，log 看起來像面板一直重開。
     *    實測就是這樣繞完 40 秒逾時的。
     */
    if (await page.locator('.box-close').count().catch(() => 0)) {
      const via = await tap(page.locator('.box-close').first())
      say(`關掉蓋住畫面的面板（.box-close）${via ? '' : ' 失敗'}`)
      await page.waitForTimeout(2500)
      continue
    }

    // ④ 先把分下回去再退出。不下分的話額度留在機台上，下一輪還得先處理它
    if (!cashedOut && await page.locator('.btn_cashout').count().catch(() => 0)) {
      cashedOut = true
      const via = await tap(page.locator('.btn_cashout').first())
      say(`Cash Out${via ? '' : ' 失敗'}`)
      await page.waitForTimeout(4000)
      continue
    }

    // ⑤ Quit（header 最後一顆）
    const header = page.locator('.header_btn_item')
    const n = await header.count().catch(() => 0)
    if (!n) { say('找不到 header 按鈕'); break }
    const via = await tap(header.last())
    say(`Quit（header 第 ${n} 顆）${via ? '' : ' 失敗'}`)
    await page.waitForTimeout(5000)
  }

  /**
   * 🚨 **脫困用的最後一招：重新載入一次再退一次。**
   *
   * 實測 2026-09-19：機台內的「預約」面板開著的時候，Cash Out 與 header 都點不到
   *    （面板蓋住整個畫面），於是退出流程一直對著被蓋住的 Quit 重複點，最後逾時——
   *    **位子就這樣卡住**，下一輪一載入又掉回機台。面板的關閉鍵不在 `.my-dialog` 底下，
   *    一時找不到；但**重新載入之後面板就沒了**，正常的 Cash Out → Confirm 就走得完。
   *
   * ⚠️ 只做一次。做不成就照實回報失敗——無限重載只會把一個清楚的錯誤拖成十分鐘。
   */
  if (h5InGame(page)) {
    const url = reloadUrl || page.url();
    say('退不出去，重新載入一次再試（面板蓋住畫面時會這樣）');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(12_000);
    const started2 = Date.now();
    let cashedOut2 = false;
    while (Date.now() - started2 < 40_000) {
      if (!h5InGame(page)) break;
      if (await dialogOpen()) {
        const via = await tap(page.locator('.box-btn_text2').first());
        say(`重載後 Confirm${via ? '' : ' 失敗'}`);
        await page.waitForTimeout(4000);
        continue;
      }
      const exited2 = await page.evaluate(() => {
        const wanted = ['exit to lobby', '返回大廳', '回到大廳', '返回大厅']
        for (const el of document.querySelectorAll('div, span, button')) {
          const txt = (el.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
          if (!wanted.includes(txt)) continue
          const r = el.getBoundingClientRect()
          if (r.width < 10 || r.height < 10) continue
          el.click(); return true
        }
        return false
      }).catch(() => false);
      if (exited2) { say('重載後按「Exit To Lobby」'); await page.waitForTimeout(5000); continue; }
      // ⚠️ 關面板一定要在 Confirm 之後——`.box-close` 也是 Tips 框的關閉鍵
      if (await page.locator('.box-close').count().catch(() => 0)) {
        const via = await tap(page.locator('.box-close').first());
        say(`重載後關面板${via ? '' : ' 失敗'}`);
        await page.waitForTimeout(2500);
        continue;
      }
      if (!cashedOut2 && await page.locator('.btn_cashout').count().catch(() => 0)) {
        cashedOut2 = true;
        const via = await tap(page.locator('.btn_cashout').first());
        say(`重載後 Cash Out${via ? '' : ' 失敗'}`);
        await page.waitForTimeout(4000);
        continue;
      }
      const header2 = page.locator('.header_btn_item');
      if (!await header2.count().catch(() => 0)) break;
      const via = await tap(header2.last());
      say(`重載後 Quit${via ? '' : ' 失敗'}`);
      await page.waitForTimeout(5000);
    }
  }

  const ok = !h5InGame(page)
  if (!ok) say('逾時，還在機台裡（重新載入也沒退成功）')
  return { ok, steps }
}
