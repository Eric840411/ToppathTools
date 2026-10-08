/**
 * fill／type／pc_click_node 的 `{{變數}}`（1008 PC 使用者「不固定入口或機台」，CodeX 方案 e）。
 *   npx tsx scripts/ui-checks/step-vars.test.ts
 *
 * 守：展開用共用的 expandVars；缺變數、空值 → 報錯、什麼都不做；展開後的值寫進日誌；
 *     **危險動作的判斷拿展開後的值**（btn_cashout 包在變數裡也認得出來）。
 */
import { chromium } from 'playwright'
import { runFrontendStep } from '../../server/uat-runner/frontend-engine.js'
import { pcEngineCapabilities } from '../../server/lib/pc-cocos.js'

let fail = 0
const ok = (c: boolean, label: string, got?: unknown) => { if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${!c && got !== undefined ? `：${JSON.stringify(got)}` : ''}`) }

const PC = `<!doctype html><body style="margin:0"><input id="q"><canvas style="position:absolute;left:0;top:100px;width:1366px;height:668px"></canvas><script>
var mk = function (name, wx, wy) { var n = { name: name, active: true, worldPosition: { x: wx, y: wy }, worldScale: { x: 1, y: 1 }, components: [{ width: 60, height: 60, anchorX: 0.5, anchorY: 0.5 }], children: [], parent: null };
  Object.defineProperty(n, 'activeInHierarchy', { get: function () { return this.active && (!this.parent || this.parent.activeInHierarchy) } }); return n }
var add = function (p, c) { c.parent = p; p.children.push(c); return c }
var scene = mk('scene', 683, 334); scene.components = []
var canvasN = add(scene, mk('Canvas', 683, 334))
add(canvasN, mk('dfdcgrand', 300, 300)); add(canvasN, mk('btn_cashout', 600, 300))
window.__clicked = []
document.querySelector('canvas').addEventListener('click', function (e) { window.__clicked.push(e.clientX + ',' + e.clientY) })
window.cc = { director: { getScene: function () { return scene } }, view: { getVisibleSize: function () { return { width: 1366, height: 668 } } }, js: { getClassName: function () { return '' } } }
</script></body>`

const browser = await chromium.launch({ headless: true })
try {
  const run = async (step: Record<string, unknown>, vars: Record<string, unknown>) => {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } })
    await page.setContent(PC)
    const logs: string[] = []
    let err = ''
    try {
      await runFrontendStep({ name: String(step.action), ...step }, {
        page, pc: pcEngineCapabilities, log: async (m: string) => { logs.push(m) }, idx: '1', screenshotDir: '',
        startUrl: 'https://uat-h5.osmslot.org/', state: { vars },
        recordedLocator: async (sel: string) => page.locator(sel),
      } as never)
    } catch (e) { err = e instanceof Error ? e.message : String(e) }
    const typed = await page.inputValue('#q')
    const clicked = await page.evaluate(() => (window as unknown as { __clicked: string[] }).__clicked)
    await page.close()
    return { err, logs, typed, clicked }
  }
  const t = await run({ action: 'type', selector: '#q', value: '{{machineNo}}' }, { machineNo: '144' })
  ok(t.err === '' && t.typed === '144', 'type：{{machineNo}} → 144', t)
  ok(t.logs.some(l => /\{\{machineNo\}\} → 144/.test(l)), '展開結果寫進日誌', t.logs)
  const f = await run({ action: 'fill', selector: '#q', value: 'No.{{m.no}}-x' }, { m: { no: 7 } })
  ok(f.err === '' && f.typed === 'No.7-x', 'fill（舊錄製器）：前後文字保留、支援 a.b', f)
  const miss = await run({ action: 'type', selector: '#q', value: '{{nope}}' }, {})
  ok(/變數「nope」不存在/.test(miss.err) && miss.typed === '', '缺變數 → 報錯、什麼都沒填', miss)
  const empty = await run({ action: 'type', selector: '#q', value: '{{blank}}' }, { blank: '' })
  ok(/變數「blank」/.test(empty.err) && empty.typed === '', '空值 → 報錯（不會變成空字串）', empty)
  const pc = await run({ action: 'pc_click_node', value: '{{game}}' }, { game: 'dfdcgrand' })
  ok(pc.err === '' && pc.clicked.length === 1, 'pc_click_node：{{game}} → 點到 dfdcgrand', pc)
  const danger = await run({ action: 'pc_click_node', value: '{{target}}' }, { target: 'btn_cashout' })
  ok(/把機台裡的錢收回/.test(danger.err) && danger.clicked.length === 0, '危險判斷用展開後的值：{{target}}=btn_cashout → 擋下、沒點', danger)
} finally { await browser.close() }

console.log(fail ? `\n❌ ${fail} 條失敗` : '\n✅ 全過')
process.exit(fail ? 1 : 0)
