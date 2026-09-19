/**
 * PC 版（Cocos canvas）大廳操作。
 *
 * **為什麼要另一套**：PC 版整個畫面畫在 canvas 上，DOM 裡沒有任何機台元素——
 * 實測 `#grid_gm_item` 0 個、`document.body.innerText` 只有一個「.」。
 * H5 那套選擇器完全套不上，但 Cocos 的場景樹是可以讀的（`window.cc`，引擎 3.8.5）。
 *
 * ⚠️ **「被佔用」看 `occupied` 節點的 active，不是 `gm_occupied`。**（2026-09-18 更正）
 *    舊版用 `gm_occupied`，依據是「拿 H5 的 occupied class 當真值、兩邊各掃一次交叉比對」，
 *    當時的數字是 gm_occupied 20/2、occupied 19/8。**那個比法本身有問題**：兩邊快照差了
 *    十幾秒，機台會被佔走或放開，等於拿會動的東西當真值——而且那份樣本還混著跑馬燈
 *    造出來的假卡片（見 `pcScanLobby` 裡的註解）。
 *
 *    現在的依據是**同一個 client、同一瞬間的截圖逐張對**
 *    （`scripts/ui-checks/pc-occupancy-audit.mjs`，1024x768 可視 14 張卡片）：
 *      `occupied`     active 9 台 ↔ 畫面上 9 台有徽章（含 JACKPOT GAME / FREE GAME）── **14/14 吻合**
 *      `gm_occupied`  active 13 台 ↔ 把 2006/2009/2010/2011/2014 這 5 台空機全判成佔用
 *    `gm_occupied` 其實是裝紅色 OCCUPIED 徽章的**容器**，空機上照樣 active。
 *
 *    ⚠️ **這份證據的邊界**：14/14 只證明「同一瞬間旗標對得上畫面」，**沒有**證明旗標跨時間
 *       可靠（機台從空→被佔→放開時旗標會不會慢半拍、捲出去再捲回來會不會更新，都沒驗過）。
 *       真正的把關仍然是**進場之後有沒有真的進去**，跟 H5 同一套邏輯——狀態旗標只是用來
 *       挑候選，不是結論。
 *
 * ⚠️ 這裡的函式都跑在瀏覽器 context（`page.evaluate`），所以不能引用外面的變數。
 */
import type { Page } from 'playwright'

export interface PcMachine {
  /** 畫面上的名稱，例如 `Leprechaun-NCH1505`（跟 H5 的 `.grid-item-name` 同格式） */
  name: string
  occupied: boolean
}

/**
 * 🚨 **`ReferenceError: __name is not defined` 的解法。**
 *
 * agent 是用 **tsx** 跑 TypeScript 的，esbuild 的 `keepNames` 會把
 * `const walk = (...) => {}` 這種具名函式轉成 `__name(walk, "walk")`。
 * 這些函式被 `page.evaluate()` 丟進瀏覽器執行時，**瀏覽器裡沒有 `__name`**，
 * 於是整個 evaluate 直接炸掉。
 *
 * ⚠️ 症狀非常會騙人：evaluate 失敗 → 我們的 `.catch()` 回預設值 → 畫面顯示
 *    「沒有 Cocos、canvas 0 個、標題空白」，看起來像**頁面沒載出來**，
 *    但實際上那個視窗裡大廳好好的。2026-09-18 就是這樣被帶去查 WebGL 與顯卡，查錯方向。
 *
 * ⚠️ 只有「evaluate 裡面宣告了具名函式」的才會踩到——所以 H5 那幾支沒事、
 *    PC 這幾支全中，看起來像「PC 版特有的問題」，其實跟 PC 無關。
 */
export async function pcInstallEvalShim(page: Page): Promise<void> {
  // 用**字串**形式，不要用函式——函式會再被 tsx 轉一次，等於又把 __name 帶進去
  const shim = 'window.__name = window.__name || function (fn) { return fn }'
  await page.addInitScript(shim).catch(() => { /* 舊頁面照樣用下面那行補 */ })
  await page.evaluate(shim).catch(() => { /* 頁面還沒好就算了，下一輪會再補 */ })
}

/** 大廳到底載到什麼程度——失敗時要能講清楚，不能只說「讀不到機台」 */
export interface PcLobbyDiag {
  ready: boolean
  hasCc: boolean
  scene: string
  nodeCount: number
  /** 機台卡片節點數（名稱還沒渲染時它也存在——用它分辨「沒載到」與「只是還沒生名字」） */
  machineItems: number
  /** 大廳的機台清單（`ScrollView-gms`）建出來了沒——沒有它就等於整個大廳還沒好 */
  hasGrid: boolean
  /** 讀得到名稱的機台數 */
  labelled: number
  waitedMs: number
  /** WebGL 能不能用（`none` 代表這個瀏覽器根本畫不了 Cocos） */
  webgl: string
  title: string
  bodyText: string
  canvases: number
  /** 這一輪連問都問不到（分頁崩潰／導航中）時的錯誤訊息 */
  evalError?: string
}

/**
 * ⚠️ **PC 版是 WebGL（Cocos）——瀏覽器沒有 WebGL 的話，引擎根本不會初始化，
 *    `window.cc` 永遠不存在。**headless 在某些機器（實測回報：macOS 的 agent）
 *    拿不到 GPU，就會是這個結果。所以診斷一定要把「有沒有 WebGL」問出來，
 *    否則只會看到「window.cc 不存在」，然後往「是不是還沒載完」的方向追，追不到底。
 */
export async function pcLobbyDiag(page: Page): Promise<Omit<PcLobbyDiag, 'ready' | 'waitedMs'>> {
  return page.evaluate(() => {
    interface N { name?: string; children?: N[]; components?: Array<{ string?: string }> }
    const probeWebgl = () => {
      try {
        const c = document.createElement('canvas')
        const gl = c.getContext('webgl2') ?? c.getContext('webgl')
        if (!gl) return 'none'
        const dbg = (gl as WebGLRenderingContext).getExtension('WEBGL_debug_renderer_info')
        const renderer = dbg ? String((gl as WebGLRenderingContext).getParameter((dbg as { UNMASKED_RENDERER_WEBGL: number }).UNMASKED_RENDERER_WEBGL)) : 'ok'
        return renderer.slice(0, 60)
      } catch { return 'error' }
    }
    const pageInfo = {
      webgl: probeWebgl(),
      title: document.title,
      bodyText: (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 80),
      canvases: document.querySelectorAll('canvas').length,
    }
    const cc = (window as unknown as { cc?: { director?: { getScene?: () => N } } }).cc
    if (!cc?.director?.getScene) return { hasCc: false, scene: '', nodeCount: 0, machineItems: 0, hasGrid: false, labelled: 0, ...pageInfo }
    const scene = cc.director.getScene()
    const all: N[] = []
    const walk = (n: N | null | undefined, d: number) => { if (!n || d > 16) return; all.push(n); for (const c of (n.children ?? [])) walk(c, d + 1) }
    walk(scene, 0)
    const RE = /^[A-Za-z0-9'’&. ]{2,40}-(?:[A-Za-z]{2,5})?\d{2,6}$/
    let labelled = 0
    for (const n of all) {
      for (const comp of (n.components ?? [])) {
        const t = typeof comp.string === 'string' ? comp.string.trim() : ''
        if (RE.test(t)) { labelled++; break }
      }
    }
    return {
      hasCc: true,
      scene: String(scene?.name ?? ''),
      nodeCount: all.length,
      machineItems: all.filter(n => String(n.name ?? '') === 'machine_item').length,
      hasGrid: all.some(n => String(n.name ?? '') === 'ScrollView-gms'),
      labelled,
      ...pageInfo,
    }
  }).catch((err: unknown) => ({
    hasCc: false, scene: '', nodeCount: 0, machineItems: 0, hasGrid: false, labelled: 0,
    webgl: 'unknown', title: '', bodyText: '', canvases: 0,
    // ⚠️ evaluate 自己失敗（分頁崩潰、導航中、context 被銷毀）跟「頁面是空的」完全是兩件事。
    //    不分開的話，畫面上會顯示一排 0，看起來像「什麼都沒載到」，其實是**根本問不到**
    evalError: err instanceof Error ? err.message.split('\n')[0].slice(0, 120) : String(err).slice(0, 120),
  }))
}

/**
 * 等 Cocos 起來、場景進到 lobby、而且**真的讀得到機台名稱**。
 *
 * ⚠️ 失敗時要回報「載到哪一步」。只說「讀不到機台」的話，分不出是
 *    ①Cocos 還沒起來 ②場景不是 lobby ③卡片在但名稱還沒渲染 ④真的空的——
 *    這四種的下一步完全不同（實測踩過：H5 那邊就因為訊息含糊被帶偏過一次）。
 */
export async function pcWaitLobby(page: Page, timeoutMs = 60_000): Promise<PcLobbyDiag> {
  await pcInstallEvalShim(page)
  const started = Date.now()
  let last = await pcLobbyDiag(page)
  while (Date.now() - started < timeoutMs) {
    last = await pcLobbyDiag(page)
    // 🚨 **`labelled > 0` 一個條件不夠。**上面那排「最近玩過」的輪播卡片也有機台名稱，
    //    只要它先生出來就 labelled=2，於是宣告「大廳就緒」——但底下那個 695 台的清單
    //    （`ScrollView-gms`）還沒建出來。接下來掃到 0 台、捲動回 `no-sv`，
    //    錯誤訊息卻寫成「這個視窗一次只看得到 0 張卡片」，看起來像解析度的問題。
    //    2026-09-18 實測 844x390：`machineItems: 2`、`hasGrid: false`，而 ready 照樣是 true。
    //    症狀還會時好時壞（同一個尺寸這輪過、下輪掛），因為純粹是搶快——最難查的那種。
    if (last.hasCc && last.hasGrid && last.machineItems >= 20 && last.labelled > 0) {
      return { ...last, ready: true, waitedMs: Date.now() - started }
    }
    await page.waitForTimeout(1500)
  }
  return { ...last, ready: false, waitedMs: Date.now() - started }
}

/** 把診斷資訊寫成一句人看得懂的話，直接塞進錯誤訊息 */
export function describePcLobby(d: PcLobbyDiag): string {
  const waited = Math.round(d.waitedMs / 1000)
  if (d.webgl === 'none') {
    return `這個瀏覽器沒有 WebGL，Cocos 根本畫不起來（等了 ${waited} 秒）——headless 拿不到 GPU 時就會這樣，請改用 Headed 模式，或讓 agent 用 SwiftShader 啟動`
  }
  if (d.evalError) {
    return `連頁面都問不到（分頁可能崩潰或一直在導航）：${d.evalError}。等了 ${waited} 秒——這通常是瀏覽器啟動參數或顯示卡驅動的問題，不是網站的問題`
  }
  if (!d.hasCc) {
    return `頁面裡沒有 Cocos（window.cc 不存在）。WebGL=${d.webgl}、canvas ${d.canvases} 個、標題「${d.title}」、畫面文字「${d.bodyText}」。等了 ${waited} 秒`
  }
  if (!d.hasGrid || d.machineItems < 20) {
    return `大廳的機台清單還沒建出來（ScrollView-gms ${d.hasGrid ? '有' : '**沒有**'}、機台卡片只有 ${d.machineItems} 個、讀得到名稱 ${d.labelled} 個）。`
      + `⚠️ 上面那排「最近玩過」的輪播也有機台名稱，所以「讀得到名稱」不代表大廳好了。等了 ${Math.round(d.waitedMs / 1000)} 秒`
  }
  if (d.machineItems > 0 && d.labelled === 0) {
    return `大廳載到了（場景=${d.scene}、機台卡片 ${d.machineItems} 個），但機台名稱一個都還沒渲染出來。等了 ${Math.round(d.waitedMs / 1000)} 秒`
  }
  return `場景=${d.scene || '(空)'}、節點 ${d.nodeCount}、機台卡片 ${d.machineItems}、讀得到名稱 ${d.labelled}。等了 ${Math.round(d.waitedMs / 1000)} 秒`
}

/**
 * 關掉蓋在畫面上的彈窗（JACKPOT 中獎、廣告、公告）。
 *
 * ⚠️ PC 版一進站就會跳中獎彈窗，而它是**畫在 canvas 上的節點**，DOM 關不掉——
 *    不處理的話每張截圖都被它蓋住。做法是把節點 `active` 設成 false。
 */
export async function pcClosePopups(page: Page): Promise<number> {
  return page.evaluate(() => {
    const cc = (window as unknown as { cc?: { director?: { getScene?: () => unknown } } }).cc
    if (!cc?.director?.getScene) return 0
    const all: Array<{ name?: string; active?: boolean; children?: unknown[] }> = []
    const walk = (n: { name?: string; active?: boolean; children?: unknown[] } | null, d: number) => {
      if (!n || d > 16) return
      all.push(n)
      for (const c of (n.children ?? []) as typeof all) walk(c, d + 1)
    }
    walk(cc.director.getScene() as never, 0)
    let closed = 0
    for (const n of all) {
      const name = String(n.name ?? '')
      // ⚠️ 只關「整塊蓋住畫面」的那幾類。`btn_jackpot` 這種是大廳常駐按鈕，關掉會讓畫面缺東西
      if (!/^(jackpot|winner|advert|advertview|ad_bg|ad-sp|notice_view|notice_bg|jackpotboard|eff_jackpot)/i.test(name)) continue
      if (n.active) { n.active = false; closed++ }
    }
    return closed
  }).catch(() => 0)
}

/**
 * 邊捲邊收：往下捲，每捲一次就掃一次，把機台名稱做聯集，直到連續幾次都沒有新的為止。
 *
 * ⚠️ **更正一個我先前講錯的觀察**：PC 版不是「捲過去就被回收」。
 *    場景裡一開始就有 **699 個 `machine_item` 節點**（H5 大廳是 697 台），
 *    被延後生成的是**文字標籤**——所以沒捲到的機台「讀不到名字」，而不是「不存在」。
 *    實測：一開始讀得到 27 台，捲 20 次（約 14 秒）後累計 202 台。
 *
 * ⚠️ 因此這支回傳的清單**本質上就是部分的**，呼叫端要照實標示，
 *    不要讓人以為「PC 版只有這麼多台」。
 */
/**
 * 把大廳的直向 ScrollView 捲到某個比例位置（0 = 最上、1 = 最下）。
 *
 * ⚠️ **第二個參數不能傳 0。**`scrollToOffset(pos, 0)` 是瞬間跳過去，
 *    列表不會收到 scrolling 事件 → 卡片上的文字標籤不會生出來。
 *    實測：0 秒瞬跳整輪只撈到 29 台；改成 0.25 秒動畫，同樣的捲法撈到 695 台。
 *    看起來像「這個做法沒用」，其實只差這個參數。
 */
async function pcScrollToFraction(page: Page, frac: number): Promise<string> {
  return page.evaluate((f: number) => {
    interface N { name?: string; children?: N[]; components?: Array<Record<string, unknown>> }
    const cc = (window as unknown as { cc?: { director: { getScene: () => N } } }).cc
    if (!cc) return 'no-cc'
    const all: N[] = []
    const walk = (n: N | null | undefined, d: number) => { if (!n || d > 16) return; all.push(n); for (const c of (n.children ?? [])) walk(c, d + 1) }
    walk(cc.director.getScene(), 0)
    const svOf = (node: N) => {
      for (const c of (node.components ?? [])) {
        if (typeof c.scrollToOffset === 'function' && typeof c.getMaxScrollOffset === 'function') return c
      }
      return null
    }
    // 先照名字找；找不到才退而求其次找「捲得動的直向 ScrollView」——名字是會改的
    let sv = null as ReturnType<typeof svOf>
    const named = all.find(n => String(n.name ?? '') === 'ScrollView-gms')
    if (named) sv = svOf(named)
    if (!sv) {
      for (const n of all) {
        const c = svOf(n)
        if (!c || !c.vertical) continue
        const max = (c.getMaxScrollOffset as () => { x: number; y: number })()
        if (max && max.y > 1000) { sv = c; break }
      }
    }
    if (!sv) return 'no-sv'
    const max = (sv.getMaxScrollOffset as () => { x: number; y: number })()
    ;(sv.scrollToOffset as (p: { x: number; y: number }, t: number) => void)({ x: 0, y: max.y * f }, 0.25)
    return 'ok'
  }, frac).catch(() => 'err')
}

export async function pcCollectMachines(
  page: Page,
  opts: { steps?: number; settleMs?: number } = {},
): Promise<{ machines: PcMachine[]; scrolls: number; partial: boolean }> {
  const steps = opts.steps ?? 40
  const settleMs = opts.settleMs ?? 900

  const merged = new Map<string, PcMachine>()
  const collect = async () => {
    for (const m of await pcScanLobby(page)) merged.set(m.name, m)
  }

  /**
   * 把大廳的直向 ScrollView 捲到某個比例位置。
   *
   * ⚠️ **第二個參數不能傳 0。**`scrollToOffset(pos, 0)` 是瞬間跳過去，
   *    列表不會收到 scrolling 事件 → 卡片上的文字標籤不會生出來。
   *    實測：0 秒瞬跳整輪只撈到 29 台；改成 0.25 秒動畫，同樣的捲法撈到 695 台。
   *    看起來像「這個做法沒用」，其實只差這個參數。
   */
  const scrollTo = (frac: number) => pcScrollToFraction(page, frac)

  await collect()
  let scrolls = 0
  let sawScrollView = false
  for (let i = 0; i <= steps; i++) {
    const r = await scrollTo(i / steps)
    if (r === 'ok') { sawScrollView = true; scrolls++ }
    await page.waitForTimeout(settleMs)
    await collect()
  }

  // 連 ScrollView 都找不到（改版？還沒載完？）就退回滑鼠滾輪，至少撈得到一部分
  if (!sawScrollView) {
    const viewport = page.viewportSize() ?? { width: 1440, height: 900 }
    const cx = Math.round(viewport.width / 2)
    const cy = Math.round(viewport.height / 2)
    for (let i = 0; i < 12; i++) { await page.mouse.move(cx, cy); await page.mouse.wheel(0, -1200); await page.waitForTimeout(400) }
    for (let i = 0; i < 30; i++) { await page.mouse.move(cx, cy); await page.mouse.wheel(0, 700); await page.waitForTimeout(500); await collect(); scrolls++ }
  }

  // 大廳到底有幾台：拿場景裡的 machine_item 節點數當分母，才知道這次撈得完不完整
  const total = await page.evaluate(() => {
    interface N { name?: string; children?: N[] }
    const cc = (window as unknown as { cc?: { director: { getScene: () => N } } }).cc
    if (!cc) return 0
    let n = 0
    const walk = (x: N | null | undefined, d: number) => { if (!x || d > 16) return; if (String(x.name ?? '') === 'machine_item') n++; for (const c of (x.children ?? [])) walk(c, d + 1) }
    walk(cc.director.getScene(), 0)
    return n
  }).catch(() => 0)

  return {
    machines: [...merged.values()],
    scrolls,
    // ⚠️ 照實比對，不要自己宣稱「掃完了」。實測 695/699——差的那幾台要看得出來
    partial: total > 0 ? merged.size < total : true,
  }
}

/**
 * 找到目標就停，不要為了進一台機台把 695 台全掃完。
 *
 * ⚠️ 進場流程跟「盤點大廳」要的東西不一樣：盤點要完整，進場只要**一台能用的**。
 *    照 `pcCollectMachines` 掃完要 40 秒，而目標通常前幾格就出現了——實測多數情況 2~5 秒。
 *
 * @param want `Ingot-NWR2024`（指定那台）或 `Ingot`（同款挑一台沒人的）
 */
export async function pcSeekMachine(
  page: Page, want: string, opts: { steps?: number; settleMs?: number; skip?: Set<string> } = {},
): Promise<{ picked: PcMachine | null; scanned: number; steps: number; matched: { total: number; free: number } }> {
  const steps = opts.steps ?? 40
  const settleMs = opts.settleMs ?? 700
  const prefix = want.split('-')[0]
  const seen = new Map<string, PcMachine>()
  // 呼叫端試過而且失敗的機台（被佔走、點不進去）——不要再挑同一台，否則會原地重試到放棄
  const skip = opts.skip ?? new Set<string>()

  // ⚠️ 給呼叫端報告用：**seek 途中真的看清楚過幾台這款、其中幾台空著**。
  //    不要事後再掃一次去算——那時候清單已經捲到最底，目標機型早就不在畫面上，
  //    算出來一律是 0 台，訊息會變成「掃到 0 台」這種誤導人的數字。
  const census = () => {
    const mine = [...seen.values()].filter(m => m.name === want || m.name.startsWith(prefix))
    return { total: mine.length, free: mine.filter(m => !m.occupied).length }
  }

  const lookFor = () => {
    const exact = [...seen.values()].find(m => m.name === want)
    if (exact && !exact.occupied && !skip.has(exact.name)) return exact
    const byPrefix = [...seen.values()].filter(m => (m.name === want || m.name.startsWith(prefix)) && !skip.has(m.name))
    return byPrefix.find(m => !m.occupied) ?? null
  }
  // ⚠️ 只收「現在就在視窗裡」的卡片。畫面外的節點是 ScrollView 回收來的，
  //    狀態可能還是上一台的——照收的話會挑到已經有人的機台（見 pcScanLobby 的註解）。
  //    這也表示 `seen` 不再是「途中看過的全部」，而是「途中真的看清楚過的」。
  const sweep = async () => { for (const m of await pcScanLobby(page, { onScreenOnly: true })) seen.set(m.name, m) }

  await sweep()
  let hit = lookFor()
  if (hit) return { picked: hit, scanned: seen.size, steps: 0, matched: census() }

  for (let i = 0; i <= steps; i++) {
    await pcScrollToFraction(page, i / steps)
    // ⚠️ **一格要掃兩次。**卡片的文字標籤是捲動過程中才生出來的，捲完立刻掃有時還沒好；
    //    而且 `onScreenOnly` 之後每一格能看到的卡片本來就少，漏掉一次就整款機台錯過
    //    （實測 Emperor 只佔大廳前 4 列 = 40 格裡的 1~2 格，漏掉就變成「找不到可用的目標」）。
    await page.waitForTimeout(settleMs)
    await sweep()
    hit = lookFor()
    if (hit) return { picked: hit, scanned: seen.size, steps: i, matched: census() }
    await page.waitForTimeout(400)
    await sweep()
    hit = lookFor()
    if (hit) return { picked: hit, scanned: seen.size, steps: i, matched: census() }
  }
  return { picked: null, scanned: seen.size, steps, matched: census() }
}

/**
 * 算出某個機台卡片在畫面上的座標（CSS px）。讀不到名稱（還沒捲到）就回 null。
 *
 * 換算方式（**實測驗證過，不是抄來的**）：
 * ```
 * screen.x = canvas.left + (world.x / visibleSize.width)  * canvas.width
 * screen.y = canvas.top  + canvas.height - (world.y / visibleSize.height) * canvas.height
 * ```
 * 驗證做法：拿這個公式算出「機台名稱搜尋框」的位置去點，Cocos 會把隱藏的
 * `input.cocosEditBox` 叫出來並聚焦——實測點擊前 `visible:false, focused:false`、
 * 點擊後 `visible:true, focused:true`，所以公式是對的。這個驗證**不會進任何機台**。
 */
export async function pcMachineScreenPos(
  page: Page, name: string,
): Promise<{ x: number; y: number; onScreen: boolean; onCanvas?: boolean; inViewport?: boolean } | null> {
  return page.evaluate((target: string) => {
    interface N { name?: string; active?: boolean; activeInHierarchy?: boolean; children?: N[]; parent?: N | null; components?: Array<{ string?: string }>; worldPosition?: { x: number; y: number } }
    const cc = (window as unknown as { cc?: { director: { getScene: () => N }; view: { getVisibleSize?: () => { width: number; height: number } } } }).cc
    if (!cc) return null
    const all: N[] = []
    const walk = (n: N | null | undefined, d: number) => { if (!n || d > 16) return; all.push(n); for (const c of (n.children ?? [])) walk(c, d + 1) }
    walk(cc.director.getScene(), 0)

    const labelOf = (n: N) => {
      for (const comp of (n.components ?? [])) {
        if (typeof comp.string === 'string' && comp.string.trim()) return comp.string.trim()
      }
      return ''
    }
    // 🚨 **只認真正的卡片節點。**跑馬燈（notice_view）裡也有一模一樣的機台名稱，
    //    DFS 還比卡片早遇到它。舊版寫 `node = card ?? n`——找不到 machine_item 就拿
    //    走到一半的父節點頂替，於是 worldPosition 變成 lobby 的 (0,0) 或 Canvas 的
    //    (960, 540)，算出來剛好是畫布正中心。2026-09-18 一輪 15 個解析度全部
    //    「點了 (x, y) 但還停在大廳」，15 次的座標全是畫布正中心，就是這一行造成的。
    let node: N | null = null
    for (const n of all) {
      if (n.activeInHierarchy === false) continue
      if (labelOf(n) !== target) continue
      let card: N | null | undefined = n
      for (let i = 0; i < 6 && card; i++) { if (String(card.name) === 'machine_item') break; card = card.parent }
      if (!card || String(card.name) !== 'machine_item') continue
      node = card
      break
    }
    if (!node?.worldPosition) return null

    const canvas = document.querySelector('canvas')
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const vis = cc.view.getVisibleSize?.() ?? { width: rect.width, height: rect.height }
    const x = rect.left + (node.worldPosition.x / vis.width) * rect.width
    const y = rect.top + rect.height - (node.worldPosition.y / vis.height) * rect.height
    // ⚠️ 畫面外**不要回 null**：呼叫端需要知道它在上面還是下面，才知道要往哪個方向捲。
    //    回 null 的話只知道「不在畫面上」，就只能亂猜方向——實測就因此往錯的方向捲了 25 次。
    const onCanvas = x > rect.left && x < rect.left + rect.width && y > rect.top && y < rect.top + rect.height
    // ⚠️ **「在畫布上」不等於「點得到」。**窄的直式解析度下畫布比視窗寬
    //    （360x800 的畫布是 1422x800），畫布中央那一點在視窗外面，點下去等於沒點。
    //    舊版只比對 canvas rect，於是回報 onScreen=true、算出 x=711 這種座標。
    const inViewport = x >= 0 && x <= window.innerWidth && y >= 0 && y <= window.innerHeight
    return { x: Math.round(x), y: Math.round(y), onScreen: onCanvas && inViewport, onCanvas, inViewport }
  }, name).catch(() => null)
}

/**
 * 把指定機台捲進畫面。回傳最後的位置（捲不進去就回 null）。
 *
 * ⚠️ 方向要照**實際座標**決定，不能固定往上或往下。實測 `Emperor-NWR2001` 的 y 是 18453
 *    （畫面只有 900 高）＝ 在下面很遠的地方，往上捲 25 次當然永遠捲不到。
 */
export async function pcScrollIntoView(
  page: Page, name: string, maxSteps = 40,
): Promise<{ x: number; y: number } | null> {
  const viewport = page.viewportSize() ?? { width: 1440, height: 900 }
  const cx = Math.round(viewport.width / 2)
  const cy = Math.round(viewport.height / 2)

  // ── 先用 ScrollView 直接算位移 ───────────────────────────────────────────
  // 滑鼠滾輪要試很多次才靠近；ScrollView 是「算出來直接捲過去」，兩三次就到位。
  // ⚠️ 一樣**不能用 0 秒瞬跳**（見 pcCollectMachines 的註解）：不只標籤不會生成，
  //    這裡連目標卡片本身的名稱都可能還沒出現，等於自己把目標藏起來。
  for (let i = 0; i < 3; i++) {
    const pos = await pcMachineScreenPos(page, name)
    if (pos?.onScreen) return { x: pos.x, y: pos.y }
    const moved = await page.evaluate((target: string) => {
      interface N { name?: string; children?: N[]; parent?: N | null; components?: Array<Record<string, unknown>>; worldPosition?: { x: number; y: number } }
      const cc = (window as unknown as { cc?: { director: { getScene: () => N }; view: { getVisibleSize?: () => { width: number; height: number } } } }).cc
      if (!cc) return 'no-cc'
      const all: N[] = []
      const walk = (n: N | null | undefined, d: number) => { if (!n || d > 16) return; all.push(n); for (const c of (n.children ?? [])) walk(c, d + 1) }
      walk(cc.director.getScene(), 0)
      const svOf = (node: N) => {
        for (const c of (node.components ?? [])) {
          if (typeof c.scrollToOffset === 'function' && typeof c.getMaxScrollOffset === 'function') return c
        }
        return null
      }
      let sv = null as ReturnType<typeof svOf>
      const named = all.find(n => String(n.name ?? '') === 'ScrollView-gms')
      if (named) sv = svOf(named)
      if (!sv) {
        for (const n of all) {
          const c = svOf(n)
          if (!c || !c.vertical) continue
          const m = (c.getMaxScrollOffset as () => { x: number; y: number })()
          if (m && m.y > 1000) { sv = c; break }
        }
      }
      if (!sv) return 'no-sv'

      const labelOf = (n: N) => {
        for (const comp of (n.components ?? [])) {
          const v = comp.string
          if (typeof v === 'string' && v.trim()) return v.trim()
        }
        return ''
      }
      const node = all.find(n => labelOf(n) === target)
      if (!node?.worldPosition) return 'no-target'

      const vis = cc.view.getVisibleSize?.() ?? { width: 1440, height: 900 }
      const cur = typeof sv.getScrollOffset === 'function'
        ? (sv.getScrollOffset as () => { x: number; y: number })()
        : { x: 0, y: 0 }
      const max = (sv.getMaxScrollOffset as () => { x: number; y: number })()
      // Cocos 的 y 往上是正的，捲動位移往下是正的——目標在畫面中心下方就要「加」
      const delta = vis.height / 2 - node.worldPosition.y
      const want = Math.max(0, Math.min(max.y, cur.y + delta))
      ;(sv.scrollToOffset as (p: { x: number; y: number }, t: number) => void)({ x: 0, y: want }, 0.25)
      return 'ok:' + Math.round(want)
    }, name).catch(() => 'err')
    if (!String(moved).startsWith('ok')) break
    await page.waitForTimeout(700)
  }

  // ── 退路：ScrollView 找不到（改版）或目標名稱還沒生成，就用滾輪邊捲邊找 ──
  for (let i = 0; i < maxSteps; i++) {
    const pos = await pcMachineScreenPos(page, name)
    if (pos?.onScreen) return { x: pos.x, y: pos.y }

    if (!pos) {
      // 名稱還沒渲染出來：先往下找（大廳預設停在中間偏上，往下比較可能遇到）
      await page.mouse.move(cx, cy)
      await page.mouse.wheel(0, 700)
    } else {
      // 有座標但在畫面外：照距離決定方向與步幅，離得遠就捲大一點
      const delta = pos.y < cy ? -Math.min(1800, cy - pos.y + 200) : Math.min(1800, pos.y - cy + 200)
      await page.mouse.move(cx, cy)
      await page.mouse.wheel(0, delta)
    }
    await page.waitForTimeout(500)
  }
  const last = await pcMachineScreenPos(page, name)
  return last?.onScreen ? { x: last.x, y: last.y } : null
}

/** 進到機台之後，畫面上那台機器的名稱（例如 `Ingot-NWR2024`）。不在機台裡就回空字串 */
export async function pcInGameMachineName(page: Page): Promise<string> {
  return page.evaluate(() => {
    interface N { name?: string; children?: N[]; components?: Array<{ string?: string }> }
    const cc = (window as unknown as { cc?: { director: { getScene: () => N } } }).cc
    if (!cc) return ''
    const all: N[] = []
    const walk = (n: N | null | undefined, d: number) => { if (!n || d > 14) return; all.push(n); for (const c of (n.children ?? [])) walk(c, d + 1) }
    walk(cc.director.getScene(), 0)
    const RE = /^[A-Za-z0-9'’&. ]{2,40}-(?:[A-Za-z]{2,5})?\d{2,6}$/
    for (const n of all) {
      for (const comp of (n.components ?? [])) {
        const s = typeof comp.string === 'string' ? comp.string.trim() : ''
        if (RE.test(s)) return s
      }
    }
    return ''
  }).catch(() => '')
}

/**
 * 點進某一台機台，並**確認真的進到那一台**。
 *
 * 🚨 **一定要驗證進到哪一台。**實測點座標會點到隔壁：目標是 `Ingot-NWR2017`，
 *    進去之後畫面上寫的是 `Ingot-NWR2024`。如果不驗證，報告上就會寫著 A 機台、
 *    圖卻是 B 機台拍的——**而畫面上完全看不出來**。
 *
 * 所以這支回傳的是「**實際進到的那一台**」，由呼叫端決定要接受（照實記錄）還是退出重試。
 */
export async function pcEnterMachine(
  page: Page, name: string, opts: { waitMs?: number } = {},
): Promise<{ entered: boolean; actual: string; scene: string; reason?: string }> {
  const pos = await pcScrollIntoView(page, name)
  if (!pos) {
    // ⚠️ 「捲不進畫面」跟「點了沒進去」是兩種問題，下一步完全不同——訊息要分開
    const last = await pcMachineScreenPos(page, name)
    const vp = page.viewportSize()
    if (last?.onCanvas && last.inViewport === false) {
      // ⚠️ 這是**解析度本身的限制**，不是選錯機台、也不是被佔用：PC 客戶端的畫布不會
      //    跟著縮到這麼窄（360x800 的畫布仍是 1422 寬），卡片落在視窗外面點不到。
      //    這種情況要讓報告看得出來是環境限制，不要混進「進機台失敗」一起算。
      return {
        entered: false, actual: '', scene: await pcSceneName(page),
        reason: `這個解析度點不到：卡片在畫布上的位置是 (${last.x}, ${last.y})，但視窗只有 ${vp?.width}x${vp?.height}——PC 畫布比視窗寬，卡片在視窗外`,
      }
    }
    return { entered: false, actual: '', scene: await pcSceneName(page), reason: '捲不到這台機台（畫面上一直找不到它）' }
  }
  // 🚨 **點下去之前再確認一次還空著。**從 seek 看到它到捲回來點它，中間過了好幾秒，
  //    別人可能已經坐下了。不再確認的話，錯誤訊息只會說「點了但還停在大廳」，
  //    看起來像座標錯——實際上是機台被佔走，兩者的下一步完全不同。
  const stillFree = (await pcScanLobby(page, { onScreenOnly: true })).find(m => m.name === name)
  if (stillFree?.occupied) {
    return { entered: false, actual: '', scene: await pcSceneName(page), reason: '捲到畫面上之後發現它已經被佔用了（挑的時候還是空的）' }
  }

  await page.mouse.click(pos.x, pos.y)
  await page.waitForTimeout(opts.waitMs ?? 6000)
  const scene = await pcSceneName(page)
  const actual = await pcInGameMachineName(page)
  if (scene === 'lobby') {
    return { entered: false, actual, scene, reason: `點了 (${pos.x}, ${pos.y}) 但還停在大廳——可能點在卡片的空白處，或那台已經被佔用` }
  }
  return { entered: !!actual, actual, scene, reason: actual ? undefined : '場景換了但讀不到機台名稱' }
}

/**
 * 從機台裡退回大廳。
 *
 * 🚨 **為什麼一定要有這支**：一個 task 拍完照沒有離開機台，位子還是佔著的；
 *    下一個 task 重新載入同一個 URL 會**直接掉回那台機台**（`scene === 'game'`），
 *    大廳的 `ScrollView-gms` 根本不會建出來 → 掃到 0 台 → 錯誤訊息長得像解析度問題。
 *    2026-09-18 一整天的「同一個尺寸這輪過、下輪掛」就是這樣來的。
 *
 * ⚠️ **點 `menu_back` 不會直接離開**，會先跳一個 `confirm` 視窗，要再點 `box_sure`。
 *    只點第一下的話畫面完全沒變化，很容易誤判成「這顆按鈕沒作用」。
 */
export async function pcBackToLobby(page: Page, timeoutMs = 20_000): Promise<{ ok: boolean; scene: string; steps: string[] }> {
  const steps: string[] = []
  const clickNode = async (nodeName: string) => {
    const pos = await page.evaluate((target: string) => {
      interface N { name?: string; activeInHierarchy?: boolean; children?: N[]; worldPosition?: { x: number; y: number } }
      const cc = (window as unknown as { cc?: { director: { getScene: () => N }; view: { getVisibleSize?: () => { width: number; height: number } } } }).cc
      if (!cc) return null
      const all: N[] = []
      const walk = (n: N | null | undefined, d: number) => { if (!n || d > 16) return; all.push(n); for (const c of (n.children ?? [])) walk(c, d + 1) }
      walk(cc.director.getScene(), 0)
      const node = all.find(n => String(n.name ?? '') === target && n.activeInHierarchy !== false && n.worldPosition)
      if (!node?.worldPosition) return null
      const canvas = document.querySelector('canvas')
      if (!canvas) return null
      const rect = canvas.getBoundingClientRect()
      const vis = cc.view.getVisibleSize?.() ?? { width: rect.width, height: rect.height }
      const x = Math.round(rect.left + (node.worldPosition.x / vis.width) * rect.width)
      const y = Math.round(rect.top + rect.height - (node.worldPosition.y / vis.height) * rect.height)
      if (!(x >= 0 && x <= window.innerWidth && y >= 0 && y <= window.innerHeight)) return null
      return { x, y }
    }, nodeName).catch(() => null)
    if (!pos) { steps.push(`${nodeName}:找不到或在視窗外`); return false }
    await page.mouse.click(pos.x, pos.y)
    steps.push(`${nodeName}@${pos.x},${pos.y}`)
    return true
  }

  /**
   * 🚨 **退出確認框有兩種，不能只認節點名稱。**
   *
   * 實測 2026-09-18：點 `menu_back` 之後跳出來的是「**Want to reserve this machine?**」，
   * 兩顆按鈕是 `Exit To Lobby`（灰、左）與 `Reserve Now`（紫、右）——它的節點名稱完全
   * 沒有 box/confirm/sure 這些字，所以原本靠節點名找 `box_sure` 的寫法**整個框都看不到**，
   * log 只會寫「box_sure:找不到或在視窗外」，看起來像按鈕沒反應，其實框好好地開著。
   * （另一種情境跳的才是 `box_sure` 那個框，所以兩個都要認。）
   *
   * ⚠️ **絕對不能點到 `Reserve Now`**——那會把機台預約下去，是有副作用的動作。
   *    所以這裡用文字精準比對，不做模糊匹配。
   */
  const clickByLabel = async (patterns: string[]) => {
    const pos = await page.evaluate((pats: string[]) => {
      interface N { name?: string; activeInHierarchy?: boolean; children?: N[]; parent?: N | null; components?: Array<{ string?: string }>; worldPosition?: { x: number; y: number } }
      const cc = (window as unknown as { cc?: { director: { getScene: () => N }; view: { getVisibleSize?: () => { width: number; height: number } } } }).cc
      if (!cc) return null
      const all: N[] = []
      const walk = (n: N | null | undefined, d: number) => { if (!n || d > 16) return; all.push(n); for (const c of (n.children ?? [])) walk(c, d + 1) }
      walk(cc.director.getScene(), 0)
      const labelOf = (n: N) => {
        for (const c of (n.components ?? [])) if (typeof c.string === 'string' && c.string.trim()) return c.string.trim()
        return ''
      }
      const canvas = document.querySelector('canvas')
      if (!canvas) return null
      const rect = canvas.getBoundingClientRect()
      const vis = cc.view.getVisibleSize?.() ?? { width: rect.width, height: rect.height }
      for (const n of all) {
        if (n.activeInHierarchy === false || !n.worldPosition) continue
        const text = labelOf(n).toLowerCase()
        if (!text || !pats.some(p => text === p)) continue
        const x = Math.round(rect.left + (n.worldPosition.x / vis.width) * rect.width)
        const y = Math.round(rect.top + rect.height - (n.worldPosition.y / vis.height) * rect.height)
        if (!(x >= 0 && x <= window.innerWidth && y >= 0 && y <= window.innerHeight)) continue
        return { x, y, text }
      }
      return null
    }, patterns).catch(() => null)
    if (!pos) return false
    await page.mouse.click(pos.x, pos.y)
    steps.push(`「${pos.text}」@${pos.x},${pos.y}`)
    return true
  }
  const EXIT_LABELS = ['exit to lobby', '返回大廳', '回到大廳', '退出到大厅', '返回大厅']
  // 🚨 **退出是三步，不是兩步。**`menu_back` →「Exit To Lobby」→ 還會再跳一個
  //    「**Cash out credit: 2,036**」的下分確認框，要按 `Confirm` 才真的離開。
  //    漏掉第三步的話，程式會一直對著被新彈框蓋住的「Exit To Lobby」重複點，
  //    log 看起來是「點了十幾次都沒反應」，實際上第一次就點成功了、只是後面還有一關。
  //    ⚠️ 同一個框裡的 `Cancel` 千萬不能點；`Reserve Now` 更不能點（會把機台預約下去）。
  //    所以這裡用**完全相等**比對，不做模糊匹配。
  const CONFIRM_LABELS = ['confirm', '確認', '确认', '确定', '確定']

  // ⚠️ 另一種確認框的按鈕叫 `box_sure`，不叫 confirm/yes——名字猜不到，是實測倒出來的
  const sureVisible = () => page.evaluate(() => {
    interface N { name?: string; activeInHierarchy?: boolean; children?: N[] }
    const cc = (window as unknown as { cc?: { director: { getScene: () => N } } }).cc
    if (!cc) return false
    const all: N[] = []
    const walk = (n: N | null | undefined, d: number) => { if (!n || d > 16) return; all.push(n); for (const c of (n.children ?? [])) walk(c, d + 1) }
    walk(cc.director.getScene(), 0)
    return all.some(n => String(n.name ?? '') === 'box_sure' && n.activeInHierarchy !== false)
  }).catch(() => false)

  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await pcSceneName(page) === 'lobby') return { ok: true, scene: 'lobby', steps }

    // ⚠️ **順序很重要：先按最上層的下分確認框。**「Cash out credit」那個框是蓋在
    //    「Exit To Lobby」上面的，先找 Exit 的話會一直點到被蓋住的按鈕，永遠出不去。
    if (await clickByLabel(CONFIRM_LABELS)) {
      await page.waitForTimeout(3500)
      if (await pcSceneName(page) === 'lobby') return { ok: true, scene: 'lobby', steps }
      continue
    }

    // 框已經開著就直接按，不要再點一次 `menu_back`——再點是把它關掉，
    // 變成「開→關→開→關」永遠按不到。
    if (await clickByLabel(EXIT_LABELS)) {
      await page.waitForTimeout(3000)
      if (await pcSceneName(page) === 'lobby') return { ok: true, scene: 'lobby', steps }
      continue
    }
    if (await sureVisible()) {
      if (await clickNode('box_sure')) await page.waitForTimeout(3000)
      if (await pcSceneName(page) === 'lobby') return { ok: true, scene: 'lobby', steps }
      continue
    }

    if (await clickNode('menu_back')) {
      // 框不是立刻出現，要輪詢等它——單次 1.5 秒的等待有時來不及
      for (let i = 0; i < 12; i++) {
        await page.waitForTimeout(500)
        if (await sureVisible()) break
        if (await clickByLabel(EXIT_LABELS)) { await page.waitForTimeout(2500); break }
      }
      // 「Exit To Lobby」按完通常還會跳下分確認框，順手把它按掉
      for (let i = 0; i < 12; i++) {
        if (await pcSceneName(page) === 'lobby') break
        if (await clickByLabel(CONFIRM_LABELS)) { await page.waitForTimeout(3500); break }
        await page.waitForTimeout(500)
      }
    }
    if (await pcSceneName(page) === 'lobby') return { ok: true, scene: 'lobby', steps }
    await page.waitForTimeout(1000)
  }
  return { ok: false, scene: await pcSceneName(page), steps }
}

/** 目前在哪個場景（`lobby` 代表還在大廳）。進機台成功與否用這個判斷，不看畫面 */
export async function pcSceneName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const cc = (window as unknown as { cc?: { director: { getScene: () => { name?: string } } } }).cc
    return String(cc?.director?.getScene?.()?.name ?? '')
  }).catch(() => '')
}

/** 掃目前**讀得到名稱**的機台。⚠️ 沒捲到的機台雖然節點在，但標籤還沒生出來，這裡看不到 */
export async function pcScanLobby(page: Page, opts: { onScreenOnly?: boolean } = {}): Promise<PcMachine[]> {
  return page.evaluate((onScreenOnly: boolean) => {
    interface N { name?: string; active?: boolean; activeInHierarchy?: boolean; children?: N[]; parent?: N | null; components?: Array<{ string?: string }>; worldPosition?: { x: number; y: number; z: number } }
    const w = window as unknown as { cc?: { director?: { getScene?: () => N }; Camera?: unknown; view?: { getVisibleSize?: () => { width: number; height: number } } } }
    const cc = w.cc
    if (!cc?.director?.getScene) return []
    const all: N[] = []
    const walk = (n: N | null | undefined, d: number) => {
      if (!n || d > 16) return
      all.push(n)
      for (const c of (n.children ?? [])) walk(c, d + 1)
    }
    walk(cc.director.getScene(), 0)

    const labelOf = (n: N) => {
      for (const comp of (n.components ?? [])) {
        if (typeof comp.string === 'string' && comp.string.trim()) return comp.string.trim()
      }
      return ''
    }
    const NAME_RE = /^[A-Za-z0-9'’&. ]{2,40}-(?:[A-Za-z]{2,5})?\d{2,6}$/
    const out: Array<{ name: string; occupied: boolean }> = []
    for (const n of all) {
      const name = labelOf(n)
      if (!NAME_RE.test(name)) continue

      // 🚨 **大廳的跑馬燈（notice_view）裡面也有機台名稱。**只看「文字長得像機台名」會把
      //    公告文字當成一張卡片收進來——而且它沒有 gm_occupied，所以一律被判成「空機」。
      //    2026-09-18 實測：挑到的「空機」節點鏈是
      //    `RICHTEXT_CHILD < text < Mask < notice_view < lobby-rect < Canvas < lobby`，
      //    active=false，往上 6 層根本沒有 machine_item。接下來進場就必然失敗，
      //    而錯誤訊息只會寫「點了 (x, y) 但還停在大廳」，完全看不出是這裡收錯了。
      if (n.activeInHierarchy === false) continue

      // 往上找卡片節點（machine_item），狀態旗標掛在它底下
      let card: N | null | undefined = n
      for (let i = 0; i < 6 && card; i++) {
        if (String(card.name) === 'machine_item') break
        card = card.parent
      }
      // ⚠️ 找不到 machine_item 就**整筆丟掉**，不要拿走到一半的父節點頂替——
      //    頂替的話收到的是 lobby / Canvas，座標會變成 (0,0) 或畫布正中心。
      if (!card || String(card.name) !== 'machine_item') continue

      // 🚨 **佔用狀態看 `occupied`，不是 `gm_occupied`。**
      //    `gm_occupied` 是裝紅色 OCCUPIED 徽章的容器，**空機上它照樣是 active**
      //    （2026-09-18 實測 30 張卡片裡 29 張 active）；反而是機台進到 JACKPOT GAME
      //    這種特殊狀態時它會變 inactive。拿它當旗標的結果是幾乎每台都被判成佔用。
      //
      //    驗證方式是**拿同一時間的截圖逐張對**（scripts/ui-checks/pc-occupancy-audit.mjs）：
      //      占用：2001 2002 2003(JACKPOT) 2004 2005 2007 2008 2012(FREE GAME) 2013(FREE GAME)
      //      空機：2006 2009 2010 2011 2014
      //    `occupied` 的 active 狀態 **14/14 完全吻合**；`gm_occupied` 則把 2006/2009/2010/2011/2014
      //    這 5 台空機全判成佔用。
      //
      //    ⚠️ `gm_reserved` / `offline` / `gm_handpay` 是順手加的保守項（進不去的狀態），
      //       這次的樣本裡它們全都 inactive，所以**沒有被截圖驗證過**——只是寧可少報空機。
      const BUSY = ['occupied', 'gm_reserved', 'offline', 'gm_handpay']
      let occupied = false
      if (card) {
        const scan = (x: N, d: number) => {
          if (!x || d > 6) return
          if (BUSY.includes(String(x.name ?? '')) && x.active) occupied = true
          for (const c of (x.children ?? [])) scan(c, d + 1)
        }
        scan(card, 0)
      }

      // 🚨 **畫面外那些卡片的狀態不能信。**Cocos 的 ScrollView 會回收節點重複使用，
      //    捲過去之後留在外面的卡片可能還掛著上一台的狀態。實測就是這樣被坑的：
      //    seek 在途中看到 `Dancing Drums-WF8073` 是空機 → 捲回去點它 → 其實已經有人，
      //    錯誤訊息只寫「點了但還停在大廳」。所以要挑「等一下就要點下去」的目標時，
      //    傳 `onScreenOnly` 只認**現在就在視窗裡**的卡片。
      if (onScreenOnly) {
        if (!card.worldPosition) continue
        const rect = document.querySelector('canvas')?.getBoundingClientRect()
        if (!rect) continue
        const vis = cc.view?.getVisibleSize?.() ?? { width: rect.width, height: rect.height }
        const sx = rect.left + (card.worldPosition.x / vis.width) * rect.width
        const sy = rect.top + rect.height - (card.worldPosition.y / vis.height) * rect.height
        if (!(sx >= 0 && sx <= window.innerWidth && sy >= 0 && sy <= window.innerHeight)) continue
      }

      // ⚠️ v1 **不做點擊**：把世界座標換算成螢幕座標需要對 Cocos 的相機與縮放做假設，
      //    沒有實際點過一次驗證之前不寫進來——寫了但沒驗過的座標，出錯時只會點到別的地方
      out.push({ name, occupied })
    }
    return out
  }, opts.onScreenOnly ?? false).catch(() => [])
}
