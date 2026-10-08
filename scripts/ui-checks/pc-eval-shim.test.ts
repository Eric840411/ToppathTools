/**
 * 每顆 PC 積木都要自己補 `__name` shim（1008，claude-osm-2 PC T-A-002）。
 *   npx tsx scripts/ui-checks/pc-eval-shim.test.ts
 *
 * 守：腳本**沒有先跑** pc_enter_machine／assert_pc_scene 時，
 *     pc_scroll 不能炸 `__name is not defined`、assert_pc_node 不能把同一個錯吞成「找不到」。
 * ⚠️ 一定要用 tsx 跑——shim 要解的就是 tsx（esbuild keepNames）包出來的 __name。
 */
import { chromium } from 'playwright'
import { runFrontendStep } from '../../server/uat-runner/frontend-engine.js'
import { pcEngineCapabilities } from '../../server/lib/pc-cocos.js'

let fail = 0
const ok = (c: boolean, label: string, got?: unknown) => { if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${!c && got !== undefined ? `：${String(got)}` : ''}`) }

// 假場景：ScrollView-gms > view > content > dfdcgrand > content > machine_item > name「144-DFDCGRAND」
const PAGE = `<!doctype html><body style="margin:0"><canvas style="position:absolute;left:0;top:0;width:1366px;height:768px"></canvas><script>
var mk = function (name, wx, wy, w, h, comps) { return { name: name, activeInHierarchy: true, active: true, worldPosition: { x: wx, y: wy }, worldScale: { x: 1, y: 1 },
  components: [{ width: w, height: h, anchorX: 0.5, anchorY: 0.5 }].concat(comps || []), children: [], parent: null } }
var add = function (p, c) { c.parent = p; p.children.push(c); return c }
var scene = mk('scene', 683, 384, 1366, 768); scene.components = []
var canvasN = add(scene, mk('Canvas', 683, 384, 1366, 768))
var gm = add(canvasN, mk('ScrollView-gms', 683, 418, 1366, 500))
var view = add(gm, mk('view', 683, 418, 1366, 500))
var content = add(view, mk('content', 683, 418, 1366, 2000))
var off = 0
gm.components.push({ vertical: true, content: content, scrollToOffset: function (p) { off = p.y }, getScrollOffset: function () { return { x: 0, y: off } }, getMaxScrollOffset: function () { return { x: 0, y: 1500 } } })
var row = add(content, mk('dfdcgrand', 683, 400, 1300, 200)); var rc = add(row, mk('content', 683, 400, 1300, 200))
var item = add(rc, mk('machine_item', 300, 400, 200, 180)); add(item, mk('name', 300, 330, 180, 30, [{ string: '144-DFDCGRAND' }]))
window.cc = { director: { getScene: function () { return scene } }, view: { getVisibleSize: function () { return { width: 1366, height: 768 } } }, js: { getClassName: function (c) { return c.__cls || '' } } }
</script></body>`

const browser = await chromium.launch({ headless: true })
try {
  const run = async (step: Record<string, unknown>) => {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } })
    await page.setContent(PAGE)
    const logs: string[] = []
    try {
      await runFrontendStep({ name: String(step.action), ...step }, { page, pc: pcEngineCapabilities, log: async (m: string) => { logs.push(m) }, idx: '1', screenshotDir: '' } as never)
      return { err: '', logs }
    } catch (e) { return { err: e instanceof Error ? e.message : String(e), logs } }
    finally { await page.close() }
  }

  const scroll = await run({ action: 'pc_scroll', value: 'bottom' })
  ok(!/__name/.test(scroll.err), '第一顆就是 pc_scroll：不炸 __name', scroll.err)
  ok(scroll.err === '', 'pc_scroll bottom 成功', scroll.err)

  const byLabel = await run({ action: 'assert_pc_node', value: '144-DFDCGRAND' })
  ok(byLabel.err === '', '第一顆就是 assert_pc_node：用標籤找得到機台名稱', byLabel.err)

  const missing = await run({ action: 'assert_pc_node', value: 'NO-SUCH-ZZZ' })
  ok(/找不到/.test(missing.err), '反例：不存在的節點照樣紅', missing.err || '(通過了)')
} finally { await browser.close() }

console.log(fail ? `\n❌ ${fail} 條失敗` : '\n✅ 全過')
process.exit(fail ? 1 : 0)
