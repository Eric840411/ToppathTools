/**
 * pc_click_node 點彈窗裡的按鈕（1008，claude-osm-2 PC T-A-002 回歸）。
 *   npx tsx scripts/ui-checks/pc-click-popup.test.ts
 *
 * 守：點之前的關彈窗不能把「目標所在的那一塊」關掉（advertView>ad_bg>box_close）；
 *     其他彈窗（jackpot）照樣關；目標不在彈窗裡時照舊全關。
 */
import { chromium } from 'playwright'
import { runFrontendStep } from '../../server/uat-runner/frontend-engine.js'
import { pcEngineCapabilities } from '../../server/lib/pc-cocos.js'

let fail = 0
const ok = (c: boolean, label: string, got?: unknown) => { if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${!c && got !== undefined ? `：${JSON.stringify(got)}` : ''}`) }

// activeInHierarchy 照真的 Cocos 算（自己 active 且祖先都 active）——關掉 advertView 後底下的 box_close 要跟著不見
const PAGE = `<!doctype html><body style="margin:0"><canvas style="position:absolute;left:0;top:0;width:1366px;height:768px"></canvas><script>
var mk = function (name, wx, wy, w, h) { var n = { name: name, active: true, worldPosition: { x: wx, y: wy }, worldScale: { x: 1, y: 1 },
  components: [{ width: w, height: h, anchorX: 0.5, anchorY: 0.5 }], children: [], parent: null };
  Object.defineProperty(n, 'activeInHierarchy', { get: function () { return this.active && (!this.parent || this.parent.activeInHierarchy) } }); return n }
var add = function (p, c) { c.parent = p; p.children.push(c); return c }
var scene = mk('scene', 683, 384, 1366, 768); scene.components = []
var canvasN = add(scene, mk('Canvas', 683, 384, 1366, 768))
var parentN = add(canvasN, mk('parent', 683, 384, 1366, 768))
var adv = add(parentN, mk('advertView', 683, 384, 1366, 768)); var adbg = add(adv, mk('ad_bg', 683, 384, 900, 600)); var bc = add(adbg, mk('box_close', 840, 768 - 192, 60, 60))
var jp = add(parentN, mk('jackpotboard', 683, 384, 800, 500))
var btn = add(canvasN, mk('btn_top', 1300, 68, 60, 60))
window.__clicked = []
document.querySelector('canvas').addEventListener('click', function (e) { window.__clicked.push(e.clientX + ',' + e.clientY) })
window.cc = { director: { getScene: function () { return scene } }, view: { getVisibleSize: function () { return { width: 1366, height: 768 } } }, js: { getClassName: function () { return '' } } }
window.__state = function () { return { adv: adv.active, adbg: adbg.active, jp: jp.active } }
</script></body>`

const browser = await chromium.launch({ headless: true })
try {
  const run = async (value: string, extra: Record<string, unknown> = {}, html = PAGE) => {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } })
    await page.setContent(html)
    const logs: string[] = []
    let err = ''
    let out: { skipped?: string } | undefined
    try { out = await runFrontendStep({ name: 'click', action: 'pc_click_node', value, ...extra }, { page, pc: pcEngineCapabilities, log: async (m: string) => { logs.push(m) }, idx: '1', screenshotDir: '', startUrl: 'http://x/', } as never) }
    catch (e) { err = e instanceof Error ? e.message : String(e) }
    const state = await page.evaluate(() => (window as unknown as { __state?: () => unknown }).__state?.() ?? {}) as { adv: boolean; adbg: boolean; jp: boolean }
    const clicked = await page.evaluate(() => (window as unknown as { __clicked?: string[] }).__clicked ?? [])
    await page.close()
    return { err, state, clicked, logs, out }
  }
  for (const id of ['advertView>ad_bg>box_close', 'Canvas>parent>advertView>ad_bg>box_close', 'box_close']) {
    const r = await run(id)
    ok(r.err === '' && r.clicked.length === 1, `點「${id}」：找得到、點得到`, r.err || r.clicked)
    ok(r.state.adv && r.state.adbg, `點「${id}」：目標所在的 advertView／ad_bg 沒被關`, r.state)
    ok(!r.state.jp, `點「${id}」：其他彈窗（jackpotboard）照樣關`, r.state)
  }
  const other = await run('btn_top')
  ok(other.err === '' && !other.state.adv && !other.state.jp, '目標不在彈窗裡 → 照舊全關', other)
  // ── 找不到就跳過（CodeX 方案 g）──
  const miss = await run('no_such_close', { skipIfMissing: true })
  ok(miss.err === '' && /no_such_close/.test(miss.out?.skipped ?? '') && miss.clicked.length === 0, '勾了、場景讀得到、節點不存在 → 回 skipped、沒點', miss)
  const missNo = await run('no_such_close')
  ok(/場景樹裡找不到/.test(missNo.err), '沒勾 → 照舊失敗', missNo.err)
  const blind = await run('box_close', { skipIfMissing: true }, '<!doctype html><body><canvas></canvas></body>')
  ok(/讀不到場景樹/.test(blind.err) && !blind.out?.skipped, '勾了但場景讀不到 → 失敗（讀不到不等於沒有）', blind)
  const hit = await run('box_close', { skipIfMissing: true })
  ok(hit.err === '' && !hit.out?.skipped && hit.clicked.length === 1, '勾了、節點在 → 照常點、不算跳過', hit)
} finally { await browser.close() }

console.log(fail ? `\n❌ ${fail} 條失敗` : '\n✅ 全過')
process.exit(fail ? 1 : 0)
