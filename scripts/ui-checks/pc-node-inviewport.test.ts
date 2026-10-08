/**
 * assert_pc_node「必須在畫面內」（1008，claude-osm-2 PC T-A-002；CodeX 定案）。真瀏覽器＋假 Cocos 場景樹。
 *   npx tsx scripts/ui-checks/pc-node-inviewport.test.ts
 *
 * 守：視窗內＋所有祖先遮罩內才算；在 ScrollView 可視區外（例如捲到上排選單後面）但仍在視窗內 → 不算；
 *     有遮罩量不到範圍 → FAIL 不退回只看視窗；名稱與路徑兩種寫法都適用；
 *     捲動途經畫面不算（要位置穩定）；沒勾照舊只要存在就過。
 */
import { chromium, type Page } from 'playwright'
import { runFrontendStep } from '../../server/uat-runner/frontend-engine.js'
import { pcNodeVisibility } from '../../server/uat-runner/pc-node-hittest.js'

let fail = 0, n = 0
const ok = (c: boolean, label: string, got?: unknown) => { n++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${!c && got !== undefined ? `：${JSON.stringify(got)}` : ''}`) }

// 假場景：視窗 1366×768、canvas 滿版（世界座標 y 往上，畫面 y＝768−wy）。
// gmList（ScrollView）> view（Mask，畫面 y 100～600）> content > {gameid} > game-name
const PAGE = `<!doctype html><body style="margin:0"><canvas style="position:absolute;left:0;top:0;width:1366px;height:768px"></canvas><script>
const mk = (name, wx, wy, w, h, comps) => ({ name, activeInHierarchy: true, worldPosition: { x: wx, y: wy }, worldScale: { x: 1, y: 1 },
  components: [{ width: w, height: h, anchorX: 0.5, anchorY: 0.5 }, ...(comps || [])], children: [], parent: null })
const add = (p, c) => { c.parent = p; p.children.push(c); return c }
const scene = mk('scene', 683, 384, 1366, 768); scene.components = []
const canvasN = add(scene, mk('Canvas', 683, 384, 1366, 768))
const gm = add(canvasN, mk('gmList', 683, 418, 1366, 500))
const view = add(gm, mk('view', 683, 418, 1366, 500, [{ __cls: 'cc.Mask' }]))   // 畫面 y 100～600
const content = add(view, mk('content', 683, 418, 1366, 2000))
gm.components.push({ scrollToOffset() {}, getMaxScrollOffset() { return { x: 0, y: 0 } }, content })
const rowA = add(content, mk('luckylooter', 683, 768 - 322, 1300, 80)); const nameA = add(rowA, mk('game-name', 200, 768 - 322, 200, 30))
const rowB = add(content, mk('wlzbhelix', 683, 768 - 60, 1300, 80)); const nameB = add(rowB, mk('game-name', 200, 768 - 60, 200, 30))   // 畫面 y=60：視窗內、遮罩外（上排選單後面）
const rowC = add(content, mk('dragontrio', 683, 768 - 900, 1300, 80)); const nameC = add(rowC, mk('game-name', 200, 768 - 900, 200, 30)) // 視窗外
const unique = add(canvasN, mk('btn_top', 1300, 768 - 700, 60, 60))                                         // 不在任何遮罩裡、視窗內
window.__moving = add(content, mk('movingRow', 683, 768 - 900, 1300, 80)); add(window.__moving, mk('game-name', 200, 768 - 900, 200, 30))
window.__badMask = add(canvasN, mk('badView', 683, 384, 0, 0, [{ __cls: 'cc.Mask' }])); window.__badMask.components[0] = { __cls: 'cc.Mask' }
add(window.__badMask, mk('inBad', 683, 384, 50, 50))
window.cc = { director: { getScene: () => scene }, view: { getVisibleSize: () => ({ width: 1366, height: 768 }) }, js: { getClassName: c => c.__cls || '' } }
</script></body>`

const browser = await chromium.launch({ headless: true })
// findNode 用反查器代替：pc-cocos 的 pcFindNode 是 TS，在 tsx 底下 evaluate 會被包 __name（正式環境是 tsc 編譯，沒這問題）
const pc = { sceneName: async () => 'lobby', installEvalShim: async () => {},
  findNode: async (page: Page, want: string) => { const v = await pcNodeVisibility(page, want); return v?.found ? { found: true, name: v.name ?? want, label: '', x: v.cx ?? 0, y: v.cy ?? 0, inViewport: !!v.inWindow } : null } }
const runAssert = async (page: Page, value: string, inViewport?: boolean) => {
  const logs: string[] = []
  try {
    await runFrontendStep({ action: 'assert_pc_node', name: '驗節點', value, ...(inViewport === undefined ? {} : { inViewport }) },
      { idx: '1', label: '驗節點', log: async (l: string) => { logs.push(l) }, page, pc, startUrl: 'http://x/', recordedLocator: () => null })
    return { ok: true, logs }
  } catch (e) { return { ok: false, err: (e as Error).message, logs } }
}
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } })
  await page.setContent(PAGE)
  const vA = await pcNodeVisibility(page, 'luckylooter>game-name')
  ok(vA?.visible === true && vA.clips === 2, '路徑寫法：在遮罩內、視窗內 → visible（Mask＋ScrollView 可視區兩層都比）', vA)
  const vB = await pcNodeVisibility(page, 'wlzbhelix>game-name')
  ok(vB?.visible === false && vB.inWindow === true && vB.outside.length === 2, '在視窗內但在清單可視區外（捲到上排選單後面）→ 不算在畫面內', vB)
  const vC = await pcNodeVisibility(page, 'dragontrio>game-name')
  ok(vC?.visible === false && vC.inWindow === false, '視窗外 → 不算', vC)
  const vU = await pcNodeVisibility(page, 'btn_top')
  ok(vU?.visible === true && vU.clips === 0, '名稱寫法也適用（沒有遮罩的節點只看視窗）', vU)
  const vBad = await pcNodeVisibility(page, 'inBad')
  ok(vBad?.measurable === false && /遮罩/.test(vBad.why), '有遮罩但量不到範圍 → measurable:false（不退回只看視窗）', vBad)

  // 積木層
  ok((await runAssert(page, 'luckylooter>game-name', true)).ok, '積木：勾選、在畫面內且位置穩定 → 通過')
  const rB = await runAssert(page, 'wlzbhelix>game-name', true)
  ok(!rB.ok && /遮罩外/.test(rB.err ?? ''), '積木：勾選、在遮罩外 → 失敗，寫出原因', rB)
  const rBad = await runAssert(page, 'inBad', true)
  ok(!rBad.ok && /量不到遮罩範圍/.test(rBad.err ?? ''), '積木：遮罩量不到 → 失敗', rBad)
  const rOld = await runAssert(page, 'wlzbhelix>game-name')
  ok(rOld.ok, '積木：沒勾 → 照舊只要存在就通過（相容）', rOld)

  // 捲動途經畫面：從視窗外一路移到另一頭的視窗外，中途經過可視區 → 不能算通過
  await page.evaluate(() => { const w = window as any; let y = 768 - 900; w.__t = setInterval(() => { y += 60; w.__moving.worldPosition.y = y; w.__moving.children[0].worldPosition.y = y; if (y > 1200) clearInterval(w.__t) }, 100) })
  const rMove = await runAssert(page, 'movingRow>game-name', true)
  ok(!rMove.ok, '積木：捲動途經畫面（一直在動、最後停在畫面外）→ 失敗', rMove)
  // 動一下之後停在畫面內 → 等穩定後通過
  await page.evaluate(() => { const w = window as any; let y = 768 - 900; w.__t2 = setInterval(() => { y = Math.min(y + 100, 768 - 400); w.__moving.worldPosition.y = y; w.__moving.children[0].worldPosition.y = y; if (y >= 768 - 400) clearInterval(w.__t2) }, 100) })
  const rStop = await runAssert(page, 'movingRow>game-name', true)
  ok(rStop.ok, '積木：捲動停在畫面內 → 等穩定後通過', rStop)

  // CodeX e0bb3f3 [P2]：ScrollView 認得出來、可視區取不到 → 量不到（不能當沒有遮罩）
  await page.evaluate(() => { const w = window as any; const s = w.cc.director.getScene(); const c = s.children[0]
    const sv = { name: 'svNoContent', activeInHierarchy: true, worldPosition: { x: 683, y: 384 }, worldScale: { x: 1, y: 1 }, components: [{ width: 500, height: 300, anchorX: .5, anchorY: .5 }, { scrollToOffset() {}, getMaxScrollOffset() { return { x: 0, y: 0 } } }], children: [] as any[], parent: c }
    c.children.push(sv); sv.children.push({ name: 'inSv', activeInHierarchy: true, worldPosition: { x: 683, y: 768 - 700 }, worldScale: { x: 1, y: 1 }, components: [{ width: 40, height: 40, anchorX: .5, anchorY: .5 }], children: [], parent: sv }) })
  const vSv = await pcNodeVisibility(page, 'inSv')
  ok(vSv?.measurable === false && /ScrollView/.test(vSv.why), 'ScrollView 取不到可視區 → measurable:false（不能回 clips:0、visible:true）', vSv)
  // 慢速越界：每 400ms 只動 0.2px（取整後看起來不動），從遮罩內慢慢移出去 → 不能算穩定
  await page.evaluate(() => { const w = window as any; let y = 768 - 599.6; w.__moving.worldPosition.y = y; w.__moving.children[0].worldPosition.y = y
    w.__t3 = setInterval(() => { y -= 0.2; w.__moving.worldPosition.y = y; w.__moving.children[0].worldPosition.y = y }, 400) })
  const rSlow = await runAssert(page, 'movingRow>game-name', true)
  await page.evaluate(() => clearInterval((window as any).__t3))
  ok(!rSlow.ok, '慢速移動（0.2px／400ms）越過遮罩邊界 → 不算穩定、不能通過', rSlow)
  // 共用期限：節點第 10 秒才出現、但不在畫面內 → 總共不超過 15 秒多一點就失敗
  await page.evaluate(() => { const w = window as any; setTimeout(() => { const c = w.cc.director.getScene().children[0]
    c.children.push({ name: 'lateNode', activeInHierarchy: true, worldPosition: { x: 683, y: 768 - 900 }, worldScale: { x: 1, y: 1 }, components: [{ width: 40, height: 40, anchorX: .5, anchorY: .5 }], children: [], parent: c }) }, 10000) })
  const t0 = Date.now()
  const rLate = await runAssert(page, 'lateNode', true)
  const took = Date.now() - t0
  ok(!rLate.ok && took < 17000, '節點晚出現 → 跟找節點共用 15 秒期限（不是重給 15 秒）', { ok: rLate.ok, took })
} finally { await browser.close() }
console.log(fail ? `❌ ${fail}/${n} 失敗` : `✅ ${n}/${n} 通過`)
process.exit(fail ? 1 : 0)
