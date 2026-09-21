/**
 * 偵查：**canvas 上的一個座標，要怎麼反查出是哪個 Cocos 節點**。
 *
 *   H5_URL='<PC 網址>' OUT=<目錄> npx tsx scripts/ui-checks/pc-node-hittest-recon.ts
 *
 * 為什麼要先偵查而不是直接寫錄製器：`pcFindNode` 是「拿名字找節點」，
 * 錄製要的是**反過來**——「拿座標找名字」。反查需要節點的**大小**（不只是中心點），
 * 而大小放在哪個 component、欄位叫什麼，Cocos 2.x／3.x 不一樣，猜錯的症狀是
 * 「每次都反查到最外層的 Canvas」——看起來有在動，錄出來的腳本全是同一顆節點。
 *
 * 這支只讀不點（唯一的動作是關彈窗），跑完把結論印出來：
 *   ① 節點物件與 component 上**實際存在**的欄位名（才知道尺寸怎麼拿）
 *   ② 用推出來的規則對幾個取樣點做反查，看命中的是不是合理的按鈕
 *   ③ 命中節點的名稱在**整棵可見樹裡唯一嗎**——不唯一就不能錄名字（會點到隔壁那顆）
 */
import { chromium } from 'playwright'
import { pcWaitLobby, pcClosePopups } from '../../server/lib/pc-cocos.js'

const URL_PC = process.env.H5_URL ?? ''
const OUT = process.env.OUT ?? '.'
const log = (o: unknown) => console.log(typeof o === 'string' ? o : JSON.stringify(o))

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  await page.goto(URL_PC, { waitUntil: 'domcontentloaded', timeout: 60000 })
  // ⚠️ 第二個參數是**毫秒數字**，不是 options 物件。傳物件的話
  //    `Date.now() - started < {…}` 永遠是 false → 立刻回 not ready，
  //    而且不會丟錯：症狀是「場景樹只有 24 個節點」，看起來像站台沒載入。
  const lobby = await pcWaitLobby(page, 90000).catch(() => null)
  log({ 大廳就緒: lobby?.ready, 掃到機台卡: lobby?.machineItems, 等了幾秒: Math.round((lobby?.waitedMs ?? 0) / 1000) })
  await page.waitForTimeout(4000)
  log({ 關掉彈窗: await pcClosePopups(page).catch(() => -1) })
  await page.waitForTimeout(2000)
  await page.screenshot({ path: `${OUT}/hittest-0-lobby.png` })

  // ── ① 欄位偵查：節點與 component 上到底有什麼 ────────────────────────────
  const shape = await page.evaluate(() => {
    const cc = (window as unknown as { cc?: any }).cc
    if (!cc?.director?.getScene) return { error: 'no cc' }
    const all: any[] = []
    const walk = (n: any, d: number) => { if (!n || d > 18) return; all.push({ n, d }); for (const c of (n.children ?? [])) walk(c, d + 1) }
    walk(cc.director.getScene(), 0)
    const sample = all.filter(x => x.n?.worldPosition && x.n.activeInHierarchy !== false).slice(0, 6)
    return {
      total: all.length,
      nodeKeys: sample[0] ? Object.keys(sample[0].n).slice(0, 40) : [],
      // component 上的欄位——尺寸就在其中某一個裡面
      comps: sample.map(x => ({
        name: String(x.n.name ?? ''),
        comps: (x.n.components ?? []).map((c: any) => ({
          type: c?.constructor?.name ?? '?',
          keys: Object.keys(c ?? {}).filter(k => /width|height|size|anchor|string|contentSize/i.test(k)).slice(0, 12),
          w: c?.width, h: c?.height, ax: c?.anchorX, ay: c?.anchorY,
        })).slice(0, 6),
      })),
    }
  })
  log({ 場景樹: shape })

  // ── ② 反查規則：座標 → 節點 ─────────────────────────────────────────────
  /**
   * 規則：把每個可見節點換算成**畫面上的矩形**，取包含該點、而且**最深**的那個。
   * 最深＝最內層＝使用者真正點到的東西（最外層的 Canvas 也包含所有點，不能取它）。
   */
  const probe = await page.evaluate(() => {
    const cc = (window as unknown as { cc?: any }).cc
    const canvas = document.querySelector('canvas')
    if (!cc || !canvas) return { error: 'no cc/canvas' }
    const rect = canvas.getBoundingClientRect()
    const vis = cc.view?.getVisibleSize?.() ?? { width: rect.width, height: rect.height }
    const sx = rect.width / vis.width, sy = rect.height / vis.height

    const all: Array<{ n: any; d: number }> = []
    const walk = (n: any, d: number) => { if (!n || d > 18) return; all.push({ n, d }); for (const c of (n.children ?? [])) walk(c, d + 1) }
    walk(cc.director.getScene(), 0)

    /** 節點的畫面矩形；拿不到尺寸就回 null（寧可放棄，不要猜） */
    const rectOf = (n: any) => {
      const wp = n.worldPosition
      if (!wp) return null
      let w = 0, h = 0, ax = 0.5, ay = 0.5
      for (const c of (n.components ?? [])) {
        if (typeof c?.width === 'number' && typeof c?.height === 'number' && (c.width || c.height)) {
          w = c.width; h = c.height
          if (typeof c.anchorX === 'number') ax = c.anchorX
          if (typeof c.anchorY === 'number') ay = c.anchorY
          break
        }
      }
      if (!w && !h) return null
      const scale = n.worldScale ?? { x: 1, y: 1 }
      const ww = w * (scale.x ?? 1), hh = h * (scale.y ?? 1)
      // Cocos 的 y 往上，畫面的 y 往下
      const left = rect.left + (wp.x - ax * ww) * sx
      const right = rect.left + (wp.x + (1 - ax) * ww) * sx
      const bottom = rect.top + rect.height - (wp.y - ay * hh) * sy
      const top = rect.top + rect.height - (wp.y + (1 - ay) * hh) * sy
      return { left, right, top, bottom }
    }

    const labelOf = (n: any) => {
      for (const c of (n.components ?? [])) if (typeof c?.string === 'string' && c.string.trim()) return c.string.trim()
      return ''
    }
    const visible = (n: any) => n.activeInHierarchy !== false && !!n.worldPosition

    const hit = (x: number, y: number) => {
      const cands = all
        .filter(({ n }) => visible(n))
        .map(({ n, d }) => ({ n, d, r: rectOf(n) }))
        .filter(({ r }) => r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)
        .sort((a, b) => b.d - a.d)
      const names = all.filter(({ n }) => visible(n)).map(({ n }) => String(n.name ?? ''))
      return cands.slice(0, 4).map(({ n, d }) => ({
        name: String(n.name ?? ''), label: labelOf(n), depth: d,
        重名幾個: names.filter(x => x === String(n.name ?? '')).length,
      }))
    }

    const cx = Math.round(rect.left + rect.width / 2), cy = Math.round(rect.top + rect.height / 2)
    return {
      canvas: { w: Math.round(rect.width), h: Math.round(rect.height) },
      可量到尺寸的節點: all.filter(({ n }) => visible(n) && rectOf(n)).length,
      可見節點: all.filter(({ n }) => visible(n)).length,
      取樣: {
        中央: hit(cx, cy),
        左上: hit(Math.round(rect.left + rect.width * 0.12), Math.round(rect.top + rect.height * 0.1)),
        右下: hit(Math.round(rect.left + rect.width * 0.88), Math.round(rect.top + rect.height * 0.9)),
        底部中間: hit(cx, Math.round(rect.top + rect.height * 0.92)),
      },
    }
  })
  log({ 反查結果: probe })
} catch (e) {
  log({ FATAL: String(e).split('\n')[0].slice(0, 200) })
  process.exitCode = 1
} finally {
  await browser.close()
}
