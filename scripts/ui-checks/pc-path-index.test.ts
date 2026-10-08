/**
 * PC 節點路徑的同名兄弟序號 name[N]（1008，claude-osm-2 T-A-002；CodeX 定案）。真瀏覽器＋假 Cocos 場景樹。
 *   npx tsx scripts/ui-checks/pc-path-index.test.ts
 * 守：不寫 [N] 照舊要唯一；[N] 只算 visible 的同名兄弟；越界／負數／小數／空的 FAIL；第一段不准 [N]；
 *     多層索引；名字含 [ 用 [[ 跳脫；錄製（at）產出的識別字反解回同一顆。
 */
import { chromium } from 'playwright'
import { installPcHitTest, pcNodeVisibility } from '../../server/uat-runner/pc-node-hittest.js'
import { pcFindNode, pcInstallEvalShim } from '../../server/lib/pc-cocos.js'
import { runFrontendStep } from '../../server/uat-runner/frontend-engine.js'

let fail = 0, n = 0
const ok = (c: boolean, label: string, got?: unknown) => { n++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${!c && got !== undefined ? `：${JSON.stringify(got)}` : ''}`) }

const PAGE = `<!doctype html><body style="margin:0"><canvas style="position:absolute;left:0;top:0;width:1366px;height:768px"></canvas><script>
const mk = (name, sx, sy, active) => ({ name, activeInHierarchy: active !== false, worldPosition: { x: sx, y: 768 - sy }, worldScale: { x: 1, y: 1 },
  components: [{ width: 60, height: 40, anchorX: 0.5, anchorY: 0.5 }], children: [], parent: null })
const add = (p, c) => { c.parent = p; p.children.push(c); return c }
const scene = mk('scene', 683, 384); scene.components = []
const canvasN = add(scene, mk('Canvas', 683, 384)); canvasN.components[0] = { width: 1366, height: 768, anchorX: .5, anchorY: .5 }
const sv = add(canvasN, mk('more_ScrollView', 300, 400)); sv.components[0] = { width: 500, height: 500, anchorX: .5, anchorY: .5 }
const view = add(sv, mk('view', 300, 400)); view.components[0] = { width: 500, height: 500, anchorX: .5, anchorY: .5 }
const content = add(view, mk('content', 300, 400)); content.components[0] = { width: 500, height: 500, anchorX: .5, anchorY: .5 }
add(content, mk('item1', 100, 200)); add(content, mk('item1', 100, 300, false)); add(content, mk('item1', 100, 400))   // 中間那個隱藏
// 多層：grid > row(×2) > cell(×2)
const grid = add(canvasN, mk('grid', 900, 400)); grid.components[0] = { width: 400, height: 400, anchorX: .5, anchorY: .5 }
for (let r = 0; r < 2; r++) { const row = add(grid, mk('row', 900, 300 + r * 100)); row.components[0] = { width: 300, height: 50, anchorX: .5, anchorY: .5 }
  for (let c = 0; c < 2; c++) add(row, mk('cell', 800 + c * 150, 300 + r * 100)) }
add(canvasN, mk('x[0]', 1200, 700))   // 名字本身含 [
const tails = add(canvasN, mk('tails', 600, 650)); tails.components[0] = { width: 400, height: 60, anchorX: .5, anchorY: .5 }
add(tails, mk('tail[', 500, 650)); add(tails, mk('tail[', 700, 650))   // 同名、而且名字以 [ 結尾
window.cc = { director: { getScene: () => scene }, view: { getVisibleSize: () => ({ width: 1366, height: 768 }) } }
</script></body>`

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } })
  await page.setContent(PAGE)
  await installPcHitTest(page)
  const find = (id: string) => page.evaluate((x) => (window as any).__uatPcHit.find(x), id)
  const at = (x: number, y: number) => page.evaluate(([a, b]) => (window as any).__uatPcHit.at(a, b), [x, y])
  const base = 'more_ScrollView>view>content>'
  ok(await find(base + 'item1') === null, '同名兄弟不寫 [N] → 照舊解析不到（不偷偷取第一個）')
  const i0 = await find(base + 'item1[0]'), i1 = await find(base + 'item1[1]')
  ok(i0?.y === 200 && i1?.y === 400, 'item1[0]／[1] 只算可見的同名兄弟（跳過隱藏的那個）', { i0, i1 })
  ok(await find(base + 'item1[2]') === null, '越界（只有 2 個可見）→ 解析不到')
  for (const bad of ['item1[-1]', 'item1[1.5]', 'item1[]', 'item1[a]']) ok(await find(base + bad) === null, `不合法的序號 ${bad} → 解析不到`)
  ok(await find('item1[0]') === null, '第一段不准帶 [N]')
  ok(await find('grid[0]') === null && (await find('grid')) !== null, '第一段就算唯一也不准帶 [N]（grid[0] 解析不到、grid 可以）')
  const g = await find('grid>row[1]>cell[0]')
  ok(g?.x === 800 && g?.y === 400, '多層索引 grid>row[1]>cell[0]', g)
  ok(await find('grid>row[1]>cell') === null, '多層：最後一層同名卻沒寫 [N] → 解析不到')
  const esc = await find('x[[0]')
  ok(esc?.x === 1200 && (await find('x[0]')) === null, '名字含 [ 要寫成 [[（x[[0]）；寫 x[0] 會被當成序號、第一段不准 → 解析不到', esc)
  // 錄製往返：點在第 2 個可見的 item1 → 錄成 item1[1]，再解析回同一個位置
  const hit = await at(100, 400)
  // 假場景裡 content 只有一個（全域唯一），所以最短路徑是 content>item1[1]；真的大廳 content 有 22 個，會再往上接
ok(hit?.id === 'content>item1[1]', '錄製（at）在同名兄弟上錄成 …>item1[1]（往上接到第一個唯一的祖先）', hit)
  const back = hit?.id ? await find(hit.id) : null
  ok(back?.x === 100 && back?.y === 400, '錄出來的識別字反解回同一顆', back)
  const hitCell = await at(950, 300)
  ok(hitCell?.id === 'grid>row[0]>cell[1]', '多層同名：錄成 grid>row[0]>cell[1]', hitCell)
  const hitEsc = await at(1200, 700)
  ok(hitEsc?.id === 'x[[0]', '名字含 [ 的錄製會自動跳脫成 [[', hitEsc)
  // CodeX 96797d3 [P2] ①：名字叫 tail[ 又重名 → 錄成 tails>tail[[[1]（[[ 是跳脫、最後的 [1] 是序號），要解得回去
  const hitTail = await at(700, 650)
  ok(hitTail?.id === 'tails>tail[[[1]', '名字以 [ 結尾又重名 → 錄成 tails>tail[[[1]', hitTail)
  const backTail = hitTail?.id ? await find(hitTail.id) : null
  ok(backTail?.x === 700, '連續 [ 依奇偶判斷：tail[[[1] 解回第 2 個 tail[', backTail)
  ok((await find('tails>tail[[[0]'))?.x === 500 && (await find('tails>tail[[')) === null, 'tail[[[0] 是第 1 個；tail[[（純名稱）重名 → 解析不到', null)
  // CodeX 96797d3 [P2] ②：唯一名字 x[0] 錄成 x[[0]（沒有 >）→ 積木層（pcFindNode／可見判定）也要找得到
  await pcInstallEvalShim(page)
  const fn = await pcFindNode(page, 'x[[0]')
  ok(fn?.found === true && fn.x === 1200, 'pcFindNode 收到 x[[0]（沒有 >）也走路徑解析', fn)
  const vis = await pcNodeVisibility(page, 'x[[0]')
  ok(vis?.found === true && vis.cx === 1200, '可見判定（resolveAny）收到 x[[0] 也找得到', vis)
  ok((await pcFindNode(page, 'x[0]'))?.x === 1200, '使用者照字面打 x[0]：路徑解析不到 → 退回名稱比對，仍找得到', null)
  const logs: string[] = []
  const pc = { sceneName: async () => 'lobby', installEvalShim: async () => {}, findNode: pcFindNode }
  let blockOk = true
  try { await runFrontendStep({ action: 'assert_pc_node', name: '驗 x[0]', value: 'x[[0]' }, { idx: '1', label: '驗 x[0]', log: async (l: string) => { logs.push(l) }, page, pc, startUrl: 'http://x/', recordedLocator: () => null }) } catch { blockOk = false }
  ok(blockOk, '積木 assert_pc_node 用錄出來的 x[[0] 通過（積木層往返）', logs)
} finally { await browser.close() }
console.log(fail ? `❌ ${fail}/${n} 失敗` : `✅ ${n}/${n} 通過`)
process.exit(fail ? 1 : 0)
