/**
 * pc_enter_machine 改讀卡片 _data（1008，CodeX 方案 a～d；claude-osm-2 UAT 實測）。
 *   npx tsx scripts/ui-checks/pc-enter-machine-data.test.ts
 *
 * 假大廳照 UAT 結構：ScrollView-gms>view>content>{gameid}>{game-name, content>machine_item}，
 * machine_item 上有 MachinePlusItem（_data／nOffline／nOccupied），標籤是 `0140` 這種（舊格式對不上）。
 */
import { chromium } from 'playwright'
import { runFrontendStep } from '../../server/uat-runner/frontend-engine.js'
import { pcEngineCapabilities } from '../../server/lib/pc-cocos.js'
import { attachPinusProbe } from '../../server/uat-runner/pinus-probe.js'

let fail = 0
const ok = (c: boolean, label: string, got?: unknown) => { if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${!c && got !== undefined ? `：${JSON.stringify(got).slice(0, 400)}` : ''}`) }

type Opts = { freeAfterMs?: number; enterAs?: string; noConsole?: boolean; throwOnData?: boolean; enterScene?: string; requestOnly?: boolean; listResp?: 'good' | 'extra' | 'code500' | 'null' | 'throw' }
const PAGE = (o: Opts) => `<!doctype html><body style="margin:0"><canvas style="position:absolute;left:0;top:0;width:1366px;height:768px"></canvas><script>
var O = ${JSON.stringify(o)};
var mk = function (name, wx, wy, w, h, comps) { var n = { name: name, active: true, worldPosition: { x: wx, y: wy }, worldScale: { x: 1, y: 1 },
  components: [{ width: w, height: h, anchorX: 0.5, anchorY: 0.5 }].concat(comps || []), children: [], parent: null };
  Object.defineProperty(n, 'activeInHierarchy', { get: function () { return this.active && (!this.parent || this.parent.activeInHierarchy) } }); return n }
var add = function (p, c) { c.parent = p; p.children.push(c); return c }
var lobby = mk('lobby', 683, 384, 1366, 768); lobby.components = []
var canvasN = add(lobby, mk('Canvas', 683, 384, 1366, 768))
var sv = add(add(add(add(canvasN, mk('lobby-rect', 683, 384, 1366, 768)), mk('hall', 683, 384, 1366, 768)), mk('gm-list', 683, 384, 1366, 768)), mk('ScrollView-gms', 683, 384, 1366, 768))
var view = add(sv, mk('view', 683, 384, 1366, 768)); var content = add(view, mk('content', 683, 384, 1366, 768))
sv.components.push({ scrollToOffset: function () {}, getScrollOffset: function () { return { x: 0, y: 0 } }, getMaxScrollOffset: function () { return { x: 0, y: 0 } }, content: content })
var cards = []
var row = function (gameid, title, y, list) {
  var r = add(content, mk(gameid, 683, y, 1300, 150)); add(r, mk('game-name', 200, y + 60, 200, 30, [{ string: title }]))
  var rc = add(r, mk('content', 683, y, 1300, 120))
  list.forEach(function (m, i) {
    var item = mk('machine_item', 300 + i * 200, y, 150, 100)
    var off = mk('offline', 0, 0, 1, 1); off.active = !!m.offline
    var occ = mk('occupied', 0, 0, 1, 1); occ.active = false
    var comp = { nOffline: off, nOccupied: occ }
    var data = { gmid: m.gmid, gameid: gameid, name: m.name, gamealias: 'X', state: m.state, lockType: m.lock || 0 }
    if (O.throwOnData) Object.defineProperty(comp, '_data', { get: function () { throw new Error('boom') } }); else comp._data = data
    item.components.push(comp); add(item, off); add(item, occ); add(item, mk('name', 300 + i * 200, y - 40, 100, 20, [{ string: m.name }]))
    add(rc, item); cards.push({ item: item, data: data })
  })
}
row('coincombo', 'Coin Combo', 600, [{ gmid: '4186-COINCOMBO-0138', name: '0138', state: 1 }, { gmid: '4186-COINCOMBO-0140', name: '0140', state: O.freeAfterMs ? 1 : 0 }])
row('dfdcgrand', 'Dancing Drums', 400, [{ gmid: '4186-DFDCGRAND-0144', name: '0144', state: 0, lock: 1 }])
row('bwjl', 'Leprechaun', 200, [{ gmid: '4186-BWJL-1008', name: '1008', state: 0, offline: true }])
for (var i = 0; i < 24; i++) { var ph = add(content, mk('machine_item', 10, 10, 1, 1)); ph.active = false }
if (O.freeAfterMs) setTimeout(function () { cards[1].data.state = 0 }, O.freeAfterMs)
var scene = lobby; lobby.name = 'lobby'
window.__entered = []
document.querySelector('canvas').addEventListener('click', function (e) {
  for (var k = 0; k < cards.length; k++) { var it = cards[k].item, d = cards[k].data
    if (!it.activeInHierarchy) continue
    var x = it.worldPosition.x, y = 768 - it.worldPosition.y
    if (Math.abs(e.clientX - x) <= 75 && Math.abs(e.clientY - y) <= 50) {
      window.__entered.push(d.gmid)
      if (d.state !== 0 || d.lockType !== 0) return
      var gmid = O.enterAs || d.gmid
      // 照 UAT 實測的順序與格式：先來一則別人機台的廣播（帶 gmid，不能被拿去核對），再來 enterGMNtc
      console.log('ON: 13 status.statusHandler.broadcastReq', { gameid: 'morepuff', gmid: '4186-MOREPUFF-0134' })
      if (O.requestOnly) console.log('SEND: 9 hall.hallHandler.enterGMReq', { gmid: gmid })
      else if (!O.noConsole) console.log('ON: 0 enterGMNtc', { event: 'enterGMNtc', roundstate: 2, gameid: d.gameid, gmid: gmid, coin: 1000000 })
      var g = mk('game', 683, 384, 1366, 768); g.components = []; g.name = O.enterScene !== undefined ? O.enterScene : 'game'
      // 機台場景裡的陷阱：NoticeView 的 data.gmid／_data.gmid 是別人的機台
      add(g, mk('notice_view', 0, 0, 1, 1, [{ data: { gmid: '4186-MOREPUFF-0134' }, _data: { gmid: '4186-MOREPUFF-0134' } }]))
      scene = g; return }
  }
})
window.cc = { director: { getScene: function () { return scene } }, view: { getVisibleSize: function () { return { width: 1366, height: 768 } } }, js: { getClassName: function () { return '' } } }
// 假的 pinus（方法掛在 prototype 上，跟真的一樣，攔截器才補得到）——大廳一載入就要一次機台總表
if (O.listResp) {
  function P () {}
  P.prototype.request = function (route, msg, cb) {
    var good = { code: 200, list: { coincombo: [{ gmid: '4186-COINCOMBO-0138' }, { gmid: '4186-COINCOMBO-0140' }], dfdcgrand: [{ gmid: '4186-DFDCGRAND-0144' }], bwjl: [{ gmid: '4186-BWJL-1008' }] } }
    var r = O.listResp === 'good' ? good
      : O.listResp === 'extra' ? { code: 200, list: { coincombo: good.list.coincombo, nosuch: [{ gmid: '4186-NOSUCH-0001' }] } }
      : O.listResp === 'code500' ? { code: 500 }
      : O.listResp === 'null' ? null
      : (function () { var o = { code: 200 }; Object.defineProperty(o, 'list', { enumerable: true, get: function () { throw new Error('boom') } }); return o })()
    setTimeout(function () { cb(r) }, 10)
  }
  window.pinus = new P()
  setTimeout(function () { window.pinus.request('hall.hallHandler.getAllGMListReq', {}, function () {}) }, 700)
}
</script></body>`

const browser = await chromium.launch({ headless: true })
try {
  const run = async (value: string, o: Opts = {}, listed?: string[]) => {
    // host 一開頁就掛的 pinus 攔截器（agent-runner 的 attachPinusProbe）——只模擬它的 drain／messages
    const pinus = listed ? { drain: async () => {}, messages: () => [{ direction: 'response', route: 'hall.hallHandler.getAllGMListReq', gmids: listed, complete: true }] } : undefined
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } })
    await page.setContent(PAGE(o))
    const logs: string[] = []
    let err = ''
    const t0 = Date.now()
    try { await runFrontendStep({ name: 'enter', action: 'pc_enter_machine', value }, { page, pc: pcEngineCapabilities, pinus, log: async (m: string) => { logs.push(m) }, idx: '1', screenshotDir: '', startUrl: 'https://uat-h5.osmslot.org/', state: { vars: {} } } as never) }
    catch (e) { err = e instanceof Error ? e.message : String(e) }
    const entered = await page.evaluate(() => (window as unknown as { __entered: string[] }).__entered)
    await page.close()
    return { err, logs, entered, ms: Date.now() - t0 }
  }
  const a = await run('Coin Combo')
  ok(a.err === '' && JSON.stringify(a.entered) === '["4186-COINCOMBO-0140"]', '遊戲名「Coin Combo」→ 只挑空機 0140（0138 有人）', a)
  ok(a.logs.some(l => /挑中 4186-COINCOMBO-0140/.test(l)) && a.logs.some(l => /進到 4186-COINCOMBO-0140/.test(l)), '日誌寫出候選、挑中與實際進入的 gmid', a.logs)
  const r = await run('')
  ok(r.err === '' && JSON.stringify(r.entered) === '["4186-COINCOMBO-0140"]', '留空＝隨機：鎖定（0144）、離線（1008）都不挑', r)
  const star = await run('*')
  ok(star.err === '' && star.entered.length === 1, '「*」也是隨機', star)
  const exact = await run('4186-COINCOMBO-0140')
  ok(exact.err === '' && JSON.stringify(exact.entered) === '["4186-COINCOMBO-0140"]', '填完整 gmid → 指定那一台', exact)
  const none = await run('No Such Game', {}, ['4186-COINCOMBO-0138', '4186-COINCOMBO-0140', '4186-DFDCGRAND-0144', '4186-BWJL-1008'])
  ok(/環境裡沒有「No Such Game」.*總表共 4 台.*同款 0 台/.test(none.err) && none.entered.length === 0, '沒有這款（總表 4 台都已套到卡片）→ 明確「環境沒有」、不捲不點', none.err)
  // CodeX 審 6a534be [P2]：穩定的部分清單不能判「沒有」
  const partial = await run('No Such Game', {}, [...['4186-COINCOMBO-0138', '4186-COINCOMBO-0140', '4186-DFDCGRAND-0144', '4186-BWJL-1008'], '4186-NOSUCH-0001'])
  ok(/總表有 1 台還沒套到卡片.*不判「環境沒有」/.test(partial.err), '總表還有沒套到的 → 說「還沒載完」，不說「沒有」', partial.err)
  const noProof = await run('No Such Game')
  ok(/無法確認清單已經載完/.test(noProof.err) && !/環境裡沒有/.test(noProof.err), '拿不到總表回應 → 說「無法確認」，不說「沒有」', noProof.err)
  const busy = await run('Dancing Drums')
  ok(/沒有空機.*鎖定 1/.test(busy.err) && busy.entered.length === 0 && busy.ms >= 15000, '同款都不能進 → 等滿 15 秒後失敗、寫出原因（鎖定）', { err: busy.err, ms: busy.ms })
  const lag = await run('Coin Combo', { freeAfterMs: 4000 })
  ok(lag.err === '' && JSON.stringify(lag.entered) === '["4186-COINCOMBO-0140"]', '剛有人離開（4 秒後才釋放）→ 等到變空機再進', lag)
  const broken = await run('Coin Combo', { throwOnData: true })
  ok(/讀不到大廳的機台資料/.test(broken.err) && broken.entered.length === 0, '_data 讀取失敗 → 失敗（不能當成 0 台）', broken.err)
  const wrong = await run('Coin Combo', { enterAs: '4186-COINCOMBO-0138' })
  ok(/實際進到 4186-COINCOMBO-0138.*進錯台/.test(wrong.err), '進到別台 → 失敗', wrong.err)
  ok(a.logs.some(l => /以 enterGMNtc 核對/.test(l)), '用 enterGMNtc 核對（前面那則別人機台的廣播沒有被拿去用）', a.logs.slice(-1))
  // CodeX 審 6a534be [P1]：送出請求、場景沒換成 game 都不算進場
  const reqOnly = await run('Coin Combo', { requestOnly: true })
  ok(/15 秒內沒收到 enterGMNtc/.test(reqOnly.err), '只有 enterGMReq（送出請求）→ 失敗', reqOnly.err)
  const loading = await run('Coin Combo', { enterScene: 'loading' })
  ok(/場景還是 loading.*不是機台場景/.test(loading.err), '有 enterGMNtc 但場景停在 loading → 失敗', loading.err)
  const emptyScene = await run('Coin Combo', { enterScene: '' })
  ok(/場景還是 讀不到/.test(emptyScene.err), '有 enterGMNtc 但場景名稱是空的 → 失敗', emptyScene.err)
  const blind = await run('Coin Combo', { noConsole: true })
  ok(/不能確認進了哪一台/.test(blind.err), '沒有 enterGMNtc（只有別人機台的廣播、場景裡 NoticeView 是別人的）→ 失敗，不能當成通過', blind.err)
  // ── CodeX 審 809fb13 [P2]：串**真的** probe（attachPinusProbe），不直接餵整理好的 gmids ──
  const viaProbe = async (value: string, listResp: Opts['listResp']) => {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } })
    const html = PAGE({ listResp })
    await page.route('http://probe.local/**', r => r.fulfill({ contentType: 'text/html', body: html }))
    const probe = await attachPinusProbe(page)
    await page.goto('http://probe.local/lobby')
    await page.waitForTimeout(1500)
    let err = ''
    try { await runFrontendStep({ name: 'enter', action: 'pc_enter_machine', value }, { page, pc: pcEngineCapabilities, pinus: probe, log: async () => {}, idx: '1', screenshotDir: '', startUrl: 'https://uat-h5.osmslot.org/', state: { vars: {} } } as never) }
    catch (e) { err = e instanceof Error ? e.message : String(e) }
    await page.close()
    return err
  }
  const pGood = await viaProbe('No Such Game', 'good')
  ok(/環境裡沒有「No Such Game」.*總表共 4 台/.test(pGood), '真 probe：總表成功、4 台都套上 → 「環境沒有」', pGood)
  const pExtra = await viaProbe('No Such Game', 'extra')
  ok(/總表有 1 台還沒套到卡片/.test(pExtra), '真 probe：總表有卡片上沒有的 → 「還沒載完」', pExtra)
  for (const bad of ['code500', 'null', 'throw'] as const) {
    const e = await viaProbe('No Such Game', bad)
    ok(/無法確認清單已經載完/.test(e) && !/環境裡沒有/.test(e), `真 probe：總表回應 ${bad} → 「無法確認」，不能判「環境沒有」`, e)
  }
} finally { await browser.close() }

console.log(fail ? `\n❌ ${fail} 條失敗` : '\n✅ 全過')
process.exit(fail ? 1 : 0)
