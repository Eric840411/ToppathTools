/**
 * API 參數紀錄：彙整／時間校正／比對／Excel／後台分頁。跑法：npx tsx server/api-capture/core.test.ts
 *
 * fixture：server/__fixtures__/api-capture/（1113 QAT 9421000006 機台 144 實跑，osm-qa-agent 錄的；已遮罩）
 * 「拿掉比對邏輯會紅」：diff 那幾條斷言是具體的路徑與種類，diffSignatures 回空、或型別／值不分，都會紅。
 */
import { readFileSync } from 'fs'
import * as XLSX from 'xlsx'
import { maskText, clip } from './mask.js'
import { parseMachineInput, cardMatches, parseMoneyNtc, machineKey } from './parse.js'
import {
  normalizeBackendItem, calibrate, buildTimeline, splitByWindow, buildSignature, diffSignatures, parseLooseObject, parsePinusConsole,
  type BackendItem, type Signature,
} from './core.js'
import { buildExcel } from './excel.js'
import { fetchBackendLogs, fmtBackendTime } from './backend-client.js'
import type { FrontEvent, SpinRecord } from './types.js'

let pass = 0
const fails: string[] = []
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) } else { fails.push(name); console.log(`❌ ${name} | got: ${g} | want: ${w}`) }
}
const ok = (name: string, cond: boolean, detail = '') => eq(name + (cond ? '' : ` ${detail}`), cond, true)

const FX = 'server/__fixtures__/api-capture/'
const frontFx = JSON.parse(readFileSync(FX + 'front-1113.json', 'utf8')) as { startedAt: number; finishedAt: number; spins: SpinRecord[]; front: FrontEvent[] }
const beFx = JSON.parse(readFileSync(FX + 'backend-1113.json', 'utf8')) as Record<'logThirdHttpReq' | 'logThirdHttpBetReq', Record<string, unknown>[]>
const backend: BackendItem[] = [
  ...beFx.logThirdHttpReq.map(x => normalizeBackendItem(x, 'logThirdHttpReq')),
  ...beFx.logThirdHttpBetReq.map(x => normalizeBackendItem(x, 'logThirdHttpBetReq')),
]

console.log('\n1) 遮罩')
const tok = '624520217ba5e4d016975f900b417a07-350612'
eq('JSON token', maskText(`{"providerId":"w","token":"${tok}","hash":"abc"}`), '{"providerId":"w","token":"***","hash":"abc"}')
eq('網址 token', maskText(`https://osm-h5.osmslot.org/?token=${tok}&username=9421`), 'https://osm-h5.osmslot.org/?token=***&username=9421')
ok('網址編碼後的 token（GA 的 dl= 參數）', !maskText(`dl=https%3A%2F%2Fx%2Flobby%3Ftoken%3D${tok}%26platform`).includes('350612'))
eq('console 鬆散物件', maskText('response status/getprivatekey {privateMapKey: eJw1abc, error: 0}'), 'response status/getprivatekey {privateMapKey: ***, error: 0}')
ok('後台登入 token', !maskText('{"data":{"token":"0000873_1-e0d5830e80b3e86b1537c1ea4a4994cdae323506309c8760e8eb05bb211c9c99"}}').includes('e0d5830e'))
ok('password', !maskText('{"username":"admin","password":"hunter2"}').includes('hunter2'))
ok('clip 截斷有標記', clip('x'.repeat(50), 10).includes('截斷'))
ok('fixture 裡沒有玩家 token', !/[0-9a-f]{32}-\d+/i.test(readFileSync(FX + 'front-1113.json', 'utf8') + readFileSync(FX + 'backend-1113.json', 'utf8')))

console.log('\n2) 機台輸入與 moneyNtc')
eq('144', parseMachineInput('144'), { num: '144', type: null, raw: '144' })
eq('873-DFDCGRAND-0144 → 號碼 144（873 是渠道）', parseMachineInput('873-DFDCGRAND-0144'), { num: '144', type: 'DFDCGRAND', raw: '873-DFDCGRAND-0144' })
ok('卡片 144-DFDCGRAND 對 144', cardMatches('144-DFDCGRAND', parseMachineInput('144')))
ok('卡片 1144-DFDCGRAND 不對 144', !cardMatches('1144-DFDCGRAND', parseMachineInput('144')))
ok('卡片 144-DFDC 不對 DFDCGRAND-0144', !cardMatches('144-DFDC', parseMachineInput('DFDCGRAND-0144')))
eq('machineKey 一致', [machineKey('873-DFDCGRAND-0144'), machineKey('dfdcgrand-144')], ['DFDCGRAND-144', 'DFDCGRAND-144'])
eq('moneyNtc', parseMoneyNtc('ON: 0 moneyNtc {event: moneyNtc, coin: 999982, reason: begin}'), { coin: 999982, reason: 'begin' })

console.log('\n3) 時間校正（1113 實跑：本機比後台慢約 183.7 秒）')
const rbPoint = (b: BackendItem) => ({ reqtime: b.reqtime, payout: (JSON.parse(b.postData) as { payout?: number }).payout ?? null })
const recordBets = backend.filter(b => b.event === 'recordBet').map(rbPoint)
eq('fixture 有 4 局、4 筆 recordBet', [frontFx.spins.length, recordBets.length], [4, 4])
const cal = calibrate(frontFx.spins, recordBets, 0)
eq('方法＝recordBet、4 組', [cal.method, cal.pairs], ['recordBet', 4])
ok('offset ≈ 183.7 秒（±1 秒）', Math.abs(cal.offsetMs - 183_700) < 1000, String(cal.offsetMs))
ok('誤差 < 1 秒', (cal.spreadMs ?? 99999) < 1000, String(cal.spreadMs))
// 位移對齊：前台多錄一局沒有 recordBet，仍要對到正確那 4 筆
const extra = [...frontFx.spins, { n: 5, tClick: 0, tEnd: frontFx.spins[3].tEnd! + 4000, coinBegin: null, coinEnd: null, win: null }]
ok('多一局也對得齊', Math.abs(calibrate(extra, recordBets, 0).offsetMs - 183_700) < 1000)
eq('沒有 recordBet → 退回伺服器時差', calibrate(frontFx.spins, [], 1234).method, 'server-clock')
eq('都沒有 → none', calibrate([], [], null).method, 'none')
// CodeX 1118 重現：局距均勻（60 秒）、前面多一筆 recordBet → 位移 0 與位移 1 一樣集中；實際時差 0
{
  const sp = (n: number, t: number, win: number | null): SpinRecord => ({ n, tClick: t - 3000, tEnd: t, coinBegin: null, coinEnd: null, win })
  const even = [sp(1, 1_000, 0), sp(2, 61_000, 0), sp(3, 121_000, 0)]
  const rbsEven = [-59_000, 1_000, 61_000, 121_000].map(t => ({ reqtime: t, payout: 0 }))
  eq('均勻局距＋派彩分不出來＋沒有伺服器時差 → 不校正', calibrate(even, rbsEven, null).method, 'none')
  const withPrior = calibrate(even, rbsEven, 200)
  eq('均勻局距＋有伺服器時差 → 挑最接近的（0 秒，不是 −60 秒）', [withPrior.method, withPrior.offsetMs], ['recordBet', 0])
  const rbsPayout = [-59_000, 1_000, 61_000, 121_000].map((t, i) => ({ reqtime: t, payout: i === 3 ? 8 : 0 }))
  const evenWin = [sp(1, 1_000, 0), sp(2, 61_000, 0), sp(3, 121_000, 8)]
  eq('派彩對得上的位移勝出（不需要伺服器時差）', [calibrate(evenWin, rbsPayout, null).method, calibrate(evenWin, rbsPayout, null).offsetMs], ['recordBet', 0])
  eq('伺服器時差剛好在兩者中間 → 分不出來就退回伺服器時差', calibrate(even, rbsEven, -30_000).method, 'server-clock')
}

console.log('\n4) 時間軸')
const steps = frontFx.front.filter((e): e is Extract<FrontEvent, { kind: 'step' }> => e.kind === 'step')
const win = splitByWindow(backend, frontFx.startedAt + cal.offsetMs, frontFx.finishedAt + cal.offsetMs, 10_000)
// 1113 有 4 次 authenticate＋1 次 balance：只有最後那次開大廳是這一輪的，前面是腳本找不到機台的重試
eq('時間窗只留這一輪的 authenticate', win.inside.filter(b => b.event === 'authenticate').length, 1)
eq('時間窗外：3 次較早的 authenticate＋1 次 balance', win.outside.map(b => b.event).sort(), ['authenticate', 'authenticate', 'authenticate', 'balance'])
const tl = buildTimeline(steps, win.inside, cal.offsetMs)
const rb = tl.filter(r => r.api === 'recordBet')
eq('recordBet 依序標第 1～4 局', rb.map(r => /第 (\d+) 局/.exec(r.action)?.[1]), ['1', '2', '3', '4'])
ok('第 4 局派彩 8', rb[3].action.includes('派彩 8'))
const spin4 = tl.find(r => r.kind === 'step' && r.action.startsWith('第 4 局'))!
ok('校正後前台第 4 局與 recordBet 第 4 筆相差 < 3 秒', Math.abs(spin4.t - rb[3].t) < 3000, String(spin4.t - rb[3].t))
ok('時間軸有排序', tl.every((r, i) => i === 0 || tl[i - 1].t <= r.t))
ok('進機台 recharge 是負數', tl.some(r => r.api === 'recharge' && r.action.startsWith('進機台')))

console.log('\n5) 參數簽名')
eq('鬆散物件', parseLooseObject('{uid: 350612, gmid: 873-X-0144, road: Array(2), gmInfo: Object, ok: true}'), { uid: 350612, gmid: '873-X-0144', road: [], gmInfo: {}, ok: true })
eq('pinus console', parsePinusConsole('SEND: 18 hall.hallHandler.watchGMReq {uid: 350612}')?.route, 'hall.hallHandler.watchGMReq')
const sig = buildSignature({ backend: win.inside, front: frontFx.front })
const keys = Object.keys(sig.apis)
for (const k of ['backend:authenticate', 'backend:recharge', 'backend:recordBet', 'ws:moneyNtc', 'ws:hall.hallHandler.enterGMReq']) ok(`有 ${k}`, keys.includes(k))
ok('前台 HTTP getprivatekey 有進比對', keys.some(k => k.startsWith('http:POST') && k.includes('/status/getprivatekey')))
ok('GA／xtrace 不進比對', !keys.some(k => /google-analytics|xtrace|aliyuncs/.test(k)))
ok('靜態 json 不進比對', !keys.some(k => k.includes('lucky_hours')))
// CodeX 1118 重現：GET 參數 ?old=1 → ?new=2 原本回 same
{
  const mk = (url: string): FrontEvent => ({ kind: 'http', t: 1, method: 'GET', url, status: 200, resourceType: 'xhr', req: '', res: '{"ok":1}', noise: false })
  const qa = buildSignature({ backend: [], front: [mk('https://osm-h5.osmslot.org/api/x?old=1')] })
  const qb = buildSignature({ backend: [], front: [mk('https://osm-h5.osmslot.org/api/x?new=2')] })
  const dq = diffSignatures(qb, qa, { ignoreVolatile: true })
  eq('HTTP query 參數變更被標出', dq.apis[0].items.map(i => `${i.kind}:${i.part}.${i.path}`).sort(), ['added:request.query.new', 'missing:request.query.old'])
}
eq('簽名帶目前格式版本', sig.version, 2)
eq('authenticate 回傳 playerLevel 是 number', sig.apis['backend:authenticate'].response['playerLevel']?.types, ['number'])
ok('timestamp 標成 volatile', !!sig.apis['backend:recharge'].request['timestamp']?.volatile)
ok('amount 不是 volatile', !sig.apis['backend:recharge'].request['amount']?.volatile)

console.log('\n6) 比對（注入差異）')
// 比對用全部後台日誌（含時間窗外那筆 balance），才測得到「未觀測」
const sigAll = buildSignature({ backend, front: frontFx.front })
const same = diffSignatures(sigAll, sigAll, { ignoreVolatile: true })
eq('跟自己比：全部 0', same.counts, { added: 0, missing: 0, type: 0, value: 0, volatileIgnored: 0, newApi: 0, unobserved: 0 })
eq('沒有基準', diffSignatures(sig, null, { ignoreVolatile: true }).hasBaseline, false)
// 基準＝原始；本次＝注入：authenticate 多 newField、balance 改成字串、recordBet 少 roundId、recharge timestamp 值變、多一個 API、少一個 API
const mutBackend = backend.map(b => {
  const pd = JSON.parse(b.postData), rs = JSON.parse(b.result)
  if (b.event === 'authenticate') rs.newField = 'x'
  if (b.event === 'authenticate') rs.balance = String(rs.balance)
  if (b.event === 'recordBet') delete pd.roundId
  if (b.event === 'recharge') pd.timestamp = 1
  return { ...b, postData: JSON.stringify(pd), result: JSON.stringify(rs) }
})
mutBackend.push({ ...mutBackend[0], event: 'getPlayerLevel', postData: '{"a":1}', result: '{"level":2}' })
const mutSig = buildSignature({ backend: mutBackend.filter(b => b.event !== 'balance'), front: frontFx.front })
const d = diffSignatures(mutSig, sigAll, { ignoreVolatile: true })
const find = (api: string, path: string) => d.apis.find(a => a.key === api)?.items.find(i => i.path === path)
eq('authenticate response.newField＝新增', find('backend:authenticate', 'newField')?.kind, 'added')
eq('authenticate response.balance＝型別變更 number→string', [find('backend:authenticate', 'balance')?.kind, find('backend:authenticate', 'balance')?.before, find('backend:authenticate', 'balance')?.after], ['type', 'number', 'string'])
eq('recordBet request.roundId＝缺少', [find('backend:recordBet', 'roundId')?.kind, find('backend:recordBet', 'roundId')?.part], ['missing', 'request'])
ok('recharge timestamp 值變被忽略（勾選忽略時）', !find('backend:recharge', 'timestamp') && d.counts.volatileIgnored >= 1)
eq('不勾忽略：timestamp 列為值變更', diffSignatures(mutSig, sigAll, { ignoreVolatile: false }).apis.find(a => a.key === 'backend:recharge')?.items.find(i => i.path === 'timestamp')?.kind, 'value')
eq('多出來的 API＝新 API', d.apis.find(a => a.key === 'backend:getPlayerLevel')?.status, 'new-api')
eq('這次沒錄到 balance＝未觀測（不算缺少）', d.apis.find(a => a.key === 'backend:balance')?.status, 'unobserved')
ok('未觀測的 API 沒有任何「缺少」項目', (d.apis.find(a => a.key === 'backend:balance')?.items.length ?? -1) === 0)
eq('計數', { added: d.counts.added, missing: d.counts.missing, type: d.counts.type, newApi: d.counts.newApi, unobserved: d.counts.unobserved }, { added: 1, missing: 1, type: 1, newApi: 1, unobserved: 1 })
ok('有差異的 API 排前面', d.apis[0].status === 'changed')
// 型別不變、存在不變的金額：值變更
const sigB: Signature = JSON.parse(JSON.stringify(sig))
sigB.apis['backend:recordBet'].request['amount'].values = ['999']
eq('非時間戳的值變更不會被忽略', diffSignatures(sig, sigB, { ignoreVolatile: true }).apis.find(a => a.key === 'backend:recordBet')?.items.find(i => i.path === 'amount')?.kind, 'value')

console.log('\n7) Excel')
const buf = buildExcel({ title: 't', infoLines: ['a', `token=${tok}`], timeline: tl, front: frontFx.front, offsetMs: cal.offsetMs, includeNoise: false, diff: d, baselineLabel: 'base' })
const wb = XLSX.read(buf, { type: 'buffer' })
eq('四個分頁', wb.SheetNames, ['時間軸', '前台WS', '前台HTTP', '說明'])
const rows = (n: string) => XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[n], { header: 1 })
eq('時間軸筆數＝表頭＋時間軸', rows('時間軸').length, tl.length + 1)
ok('前台HTTP 預設不含 GA', !JSON.stringify(rows('前台HTTP')).includes('google-analytics'))
ok('前台WS 有解碼的 console 與原始幀', JSON.stringify(rows('前台WS')).includes('遊戲 console') && JSON.stringify(rows('前台WS')).includes('WebSocket 原始幀'))
const infoText = JSON.stringify(rows('說明'))
ok('說明頁有比對摘要（型別變更、未觀測）', infoText.includes('型別變更') && infoText.includes('未觀測'))
ok('說明頁有注入的 roundId 缺少', infoText.includes('roundId') && infoText.includes('缺少'))
ok('匯出內容沒有 token', !/[0-9a-f]{32}-\d+/i.test(wb.SheetNames.map(n => JSON.stringify(rows(n))).join('')))
const withNoise = XLSX.read(buildExcel({ title: 't', infoLines: [], timeline: tl, front: frontFx.front, offsetMs: 0, includeNoise: true, diff: null, baselineLabel: '無基準' }), { type: 'buffer' })
ok('勾選含雜訊時才有 GA', JSON.stringify(XLSX.utils.sheet_to_json(withNoise.Sheets['前台HTTP'], { header: 1 })).includes('google-analytics'))

console.log('\n8) 後台查詢（假 fetch）')
eq('後台時間格式 UTC+8', fmtBackendTime(Date.UTC(2026, 10, 13, 8, 30, 5)), '2026-11-13 16:30:05')
const cfg = { baseUrl: 'https://backendservertest.osmslot.org', origin: 'https://qat-cp.osmslot.org', username: 'u', password: 'p', channelId: '873' }
const mkItem = (i: number, ev = 'balance') => ({ _id: { $oid: `id${i}` }, event: ev, wholeUrl: 'http://x/balance', postData: `{"token":"${tok}"}`, result: '{"balance":1}', reqtime: 1000 + i, username: '9421000006' })
function fakeFetch(opts: { loginCode?: number; pages?: Record<string, number>; total?: Record<string, number>; expireOnce?: boolean; failPage?: number }) {
  const calls: string[] = []
  let expired = !!opts.expireOnce
  const fn = async (url: string) => {
    calls.push(url)
    const json = async () => {
      if (url.endsWith('/auth/login')) return { code: opts.loginCode ?? 20000, data: { token: 'T', lastLoginTime: 1 } }
      const ep = /log\/(\w+)\?/.exec(url)![1]
      const page = Number(/page=(\d+)/.exec(url)![1])
      if (expired) { expired = false; return { code: 40200 } }
      if (opts.failPage === page && ep === 'logThirdHttpReq') throw new Error('socket hang up')
      const nPages = opts.pages?.[ep] ?? 1
      const n = page < nPages ? 100 : page === nPages ? 7 : 0
      return { code: 20000, data: { items: Array.from({ length: n }, (_, i) => mkItem(page * 1000 + i, ep === 'logThirdHttpBetReq' ? 'recordBet' : 'balance')), total: opts.total?.[ep] } }
    }
    return { ok: true, status: 200, json }
  }
  return { fn, calls }
}
{
  const f = fakeFetch({ pages: { logThirdHttpReq: 3, logThirdHttpBetReq: 1 }, total: { logThirdHttpReq: 207, logThirdHttpBetReq: 7 } })
  const r = await fetchBackendLogs(cfg, { userName: '9421000006', fromMs: 0, toMs: 1 }, f.fn as never)
  eq('分頁抓完：207＋7 筆、完整', [r.items.length, r.complete, r.pages], [214, true, { logThirdHttpReq: 3, logThirdHttpBetReq: 1 }])
  ok('查詢帶 userName 與 channelId', f.calls.some(c => c.includes('userName=9421000006') && c.includes('channelId=873')))
  ok('撈回來的內容已遮罩', !JSON.stringify(r.items).includes('350612'))
}
{
  const r = await fetchBackendLogs(cfg, { userName: '9421000006', fromMs: 0, toMs: 1 }, fakeFetch({ total: { logThirdHttpReq: 50, logThirdHttpBetReq: 7 } }).fn as never)
  eq('筆數跟 total 對不上 → 不完整', [r.complete, r.reasons.some(x => x.includes('共有 50'))], [false, true])
}
{
  const r = await fetchBackendLogs(cfg, { userName: '9421000006', fromMs: 0, toMs: 1 }, fakeFetch({ pages: { logThirdHttpReq: 2 }, failPage: 2 }).fn as never)
  eq('第 2 頁失敗 → 不完整、不是成功', [r.complete, r.reasons.some(x => x.includes('第 2 頁'))], [false, true])
}
{
  const r = await fetchBackendLogs(cfg, { userName: '9421000006', fromMs: 0, toMs: 1 }, fakeFetch({ loginCode: 50000 }).fn as never)
  eq('登入失敗 → 0 筆＋不完整', [r.items.length, r.complete], [0, false])
}
{
  const f = fakeFetch({ expireOnce: true })
  const r = await fetchBackendLogs(cfg, { userName: '9421000006', fromMs: 0, toMs: 1 }, f.fn as never)
  eq('token 過期（40200）重新登入一次後成功', [r.complete, f.calls.filter(c => c.endsWith('/auth/login')).length], [true, 2])
}
{
  const r = await fetchBackendLogs({ ...cfg, password: '' }, { userName: 'x', fromMs: 0, toMs: 1 })
  eq('沒設帳密 → 不連線、不完整', [r.complete, r.reasons[0].includes('還沒設定')], [false, true])
}

console.log(`\n${pass} 過、${fails.length} 失敗`)
if (fails.length) { console.log(fails.join('\n')); process.exit(1) }
