/**
 * PC 錄製→重播的**真站台驗證**：真的點一下，看錄到什麼，再用錄到的東西重播一次。
 *
 *   H5_URL='<PC 網址>' OUT=<目錄> npx tsx scripts/ui-checks/pc-record-replay-verify.ts
 *
 * 🚨 **為什麼不能只看來回驗證**：來回驗證（`pc-hittest-roundtrip.ts`）的兩個方向
 *    用的是**同一份換算**，換算整組偏掉時它照樣全綠——自己檢查自己。
 *    這支改用**外部事實**：點下去之後場景樹多了哪些節點，重播之後多的是不是同一批。
 *
 * 流程：
 *   ① 注入真正的錄製器（不是只注入反查器），點側邊欄的排行榜鈕 → 收 console 上錄到的積木
 *   ② 確認錄到的是 `pc_click_node`（不是座標）
 *   ③ 回大廳，用**引擎的那條路**（`pcClickNode`）重播那個識別字
 *   ④ 比對兩次「新出現的節點」——要有東西出現（證明真的點到了），而且兩次要是同一批
 *
 * ⚠️ 目標刻意挑側邊欄（`btn_rank`）而不是遊戲卡：大廳清單會自己捲、上排輪播也在動，
 *    「先算座標、再點下去」中間清單就換位置了，每一輪會點到不同的卡——
 *    那是**測試自己的競態**，會把真正的問題蓋掉（第一版就是這樣）。
 * ⚠️ 這支只開排行榜面板，**不進機台、不下注**。
 */
import { chromium, type Page } from 'playwright'
import { pcWaitLobby, pcClosePopups, pcClickNode, pcFindNode } from '../../server/lib/pc-cocos.js'
import { frontendRecorderScript, FRONTEND_RECORDER_MARKER } from '../../server/uat-runner/frontend-recorder.js'
import { installPcHitTest } from '../../server/uat-runner/pc-node-hittest.js'

const URL_PC = process.env.H5_URL ?? ''
const OUT = process.env.OUT ?? '.'
const log = (o: unknown) => console.log(typeof o === 'string' ? o : JSON.stringify(o))
let pass = 0, fail = 0
const check = (title: string, ok: boolean, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${title}${ok || !extra ? '' : `  ← ${extra}`}`)
  ok ? pass++ : fail++
}

/** 目前可見節點的名字集合——「點下去之後多了什麼」就靠它比 */
const sceneNames = (page: Page) => page.evaluate(() => {
  const cc = (window as unknown as { cc?: any }).cc
  const out: string[] = []
  const walk = (n: any, d: number) => {
    if (!n || d > 18) return
    if (n.activeInHierarchy !== false) out.push(String(n.name ?? ''))
    for (const c of (n.children ?? [])) walk(c, d + 1)
  }
  walk(cc?.director?.getScene?.(), 0)
  return out
}).catch(() => [] as string[])

/** b 比 a 多出來的名字（去重） */
const appeared = (a: string[], b: string[]) => {
  const seen = new Set(a)
  return [...new Set(b.filter(n => n && !seen.has(n)))]
}

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()

  /** 錄到的積木（錄製器是用 console.info 送出來的） */
  const recorded: Array<Record<string, unknown>> = []
  page.on('console', (msg) => {
    const text = msg.text()
    if (!text.startsWith(FRONTEND_RECORDER_MARKER)) return
    try { recorded.push(JSON.parse(text.slice(FRONTEND_RECORDER_MARKER.length).trim())) } catch { /* 不是我們的格式就算了 */ }
  })

  await page.goto(URL_PC, { waitUntil: 'domcontentloaded', timeout: 60000 })
  const lobby = await pcWaitLobby(page, 90000).catch(() => null)
  log({ 大廳就緒: lobby?.ready, 機台卡: lobby?.machineItems })
  await pcClosePopups(page).catch(() => 0)
  await page.waitForTimeout(2500)

  // ── ① 裝錄製器並開錄 ─────────────────────────────────────────────────────
  await page.evaluate(frontendRecorderScript())
  // ⚠️ 錄製器預設是「尚未同步」＝不收錄，要 host 推狀態進去才會開始（這是它刻意的設計）
  const synced = await page.evaluate(() => (window as unknown as { __toppathRecSync?: (s: unknown) => boolean }).__toppathRecSync?.({ paused: false, steps: 0 }))
  check('① 錄製器已開錄', synced === true, String(synced))

  await installPcHitTest(page)
  const target = await pcFindNode(page, 'btn_rank')
  check('① 找得到側邊欄按鈕 btn_rank', !!target, JSON.stringify(target))
  if (!target) throw new Error('大廳裡找不到 btn_rank')

  const beforeRecord = await sceneNames(page)
  await page.mouse.click(target.x, target.y)   // 真的用滑鼠點（錄製器聽的是真實 click）
  await page.waitForTimeout(4500)
  await page.screenshot({ path: `${OUT}/replay-1-after-record-click.png` })
  const newAfterRecord = appeared(beforeRecord, await sceneNames(page))

  const clicks = recorded.filter(s => s.action === 'pc_click_node' || s.action === 'click_viewport')
  const step = clicks[clicks.length - 1]
  log({ 錄到的積木: step, 錄製後新出現的節點數: newAfterRecord.length, 例: newAfterRecord.slice(0, 6) })
  check('② 錄到的是節點不是座標', step?.action === 'pc_click_node', String(step?.action))
  check('② 識別字帶得出來', typeof step?.value === 'string' && (step.value as string).length > 0, String(step?.value))
  check('② 這一下真的有打開東西（不然後面比什麼都沒意義）', newAfterRecord.length > 0, `新節點 ${newAfterRecord.length} 個`)
  const id = String(step?.value ?? '')

  // ── ③ 回大廳，用引擎的路重播 ─────────────────────────────────────────────
  await page.goto(URL_PC, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await pcWaitLobby(page, 90000).catch(() => null)
  await pcClosePopups(page).catch(() => 0)
  await page.waitForTimeout(2500)
  const beforeReplay = await sceneNames(page)
  const replay = await pcClickNode(page, id)
  check('③ 重播點得下去', replay.ok, replay.reason ?? '')
  await page.waitForTimeout(4500)
  await page.screenshot({ path: `${OUT}/replay-2-after-replay-click.png` })
  const newAfterReplay = appeared(beforeReplay, await sceneNames(page))
  log({ 重播後新出現的節點數: newAfterReplay.length, 例: newAfterReplay.slice(0, 6), 有捲動: replay.scrolled })

  // ④ 兩次「新出現的節點」要是同一批
  const setA = new Set(newAfterRecord), setB = new Set(newAfterReplay)
  const both = [...setA].filter(x => setB.has(x))
  const ratio = both.length / Math.max(1, Math.min(setA.size, setB.size))
  check('④ 重播打開的跟錄製當下是同一個東西',
    setA.size > 0 && setB.size > 0 && ratio >= 0.6,
    `錄製新增 ${setA.size} 個、重播新增 ${setB.size} 個、重疊 ${both.length} 個（${Math.round(ratio * 100)}%）`)

  /**
   * 🚨 重播那一段有 `page.goto`，**注入的錄製器會被整個沖掉**。
   *    第一版沒重裝就直接測檢查模式，結果「沒錄到點擊」「面板沒打開」兩項都 PASS——
   *    因為**根本沒有錄製器在跑**。這種真空通過比失敗更糟，所以下面先確認它真的在。
   */
  await page.evaluate(frontendRecorderScript())
  await page.evaluate(() => (window as unknown as { __toppathRecSync?: (s: unknown) => boolean }).__toppathRecSync?.({ paused: false, steps: 0 }))
  await installPcHitTest(page)
  const alive = await page.evaluate(() => typeof (window as unknown as { __toppathRecSetCheck?: unknown }).__toppathRecSetCheck === 'function')
  check('⑤ 重播後錄製器有重新裝起來（不然下面全是真空通過）', alive === true, String(alive))

  // ── ⑤ 檢查模式：點一下＝加一顆斷言，而且**原本的操作不可以發生** ──────────
  {
    const mark = recorded.length
    const namesBefore = await sceneNames(page)
    const on = await page.evaluate(() => (window as unknown as { __toppathRecSetCheck?: (b: boolean) => boolean }).__toppathRecSetCheck?.(true))
    check('⑤ 檢查模式切得起來', on === true, String(on))
    await page.waitForTimeout(500)
    const t2 = await pcFindNode(page, 'btn_rank')
    if (t2) await page.mouse.click(t2.x, t2.y)
    await page.waitForTimeout(3000)
    const added = recorded.slice(mark)
    const opened = appeared(namesBefore, await sceneNames(page))
    log({ 檢查模式錄到: added.map(a => a.action), 畫面新增節點: opened.length })
    check('⑤ 檢查模式錄到的是斷言', added.some(a => String(a.action).startsWith('assert_')), JSON.stringify(added.map(a => a.action)))
    check('⑤ 檢查模式不可以同時錄一顆點擊', !added.some(a => a.action === 'pc_click_node' || a.action === 'click_viewport'), JSON.stringify(added.map(a => a.action)))
    check('⑤ 原本的操作沒有被觸發（面板沒打開）', opened.length === 0, `新增了 ${opened.length} 個節點`)
  }

  // ── ⑥ 危險守衛：擋下來的那一下，**不能被錄進腳本** ────────────────────────
  {
    // 關掉檢查模式，並臨時把 btn_rank 標成危險（規則表就是那個陣列，推一條進去即可）
    await page.evaluate(() => {
      (window as unknown as { __toppathRecSetCheck?: (b: boolean) => boolean }).__toppathRecSetCheck?.(false)
      const d = (window as unknown as { __uatDanger?: { rules: Array<Record<string, unknown>> } }).__uatDanger
      d?.rules.push({ id: 'test-only', why: '測試用：假裝這顆很危險', dom: [], node: ['btn_rank'], text: '', flags: '' })
    })
    await page.waitForTimeout(500)
    const mark = recorded.length
    const namesBefore = await sceneNames(page)
    const t3 = await pcFindNode(page, 'btn_rank')
    // ⚠️ 自動化環境會自動關掉 confirm＝等於使用者按了「取消」，所以這一下應該完全不發生
    if (t3) await page.mouse.click(t3.x, t3.y)
    await page.waitForTimeout(3000)
    const added = recorded.slice(mark)
    const opened = appeared(namesBefore, await sceneNames(page))
    log({ 危險守衛後錄到: added.map(a => a.action), 畫面新增節點: opened.length })
    check('⑥ 被擋下來的危險操作沒有被錄進腳本', added.length === 0, JSON.stringify(added.map(a => a.action)))
    check('⑥ 而且操作本身也沒有發生', opened.length === 0, `新增了 ${opened.length} 個節點`)
  }

  console.log(`\n${fail ? '❌' : '✅'} ${pass} 過 / ${fail} 失敗`)
  if (fail) process.exitCode = 1
} catch (e) {
  log({ FATAL: String(e).split('\n')[0].slice(0, 200) })
  process.exitCode = 1
} finally {
  await browser.close()
}
