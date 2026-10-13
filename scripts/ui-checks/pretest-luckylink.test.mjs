// scripts/ui-checks/pretest-luckylink.test.mjs — 測前檢查接線：LuckyLink 無法確認不能變成「清單沒有」（mock fetch，不打真 API）
// 跑法：node scripts/ui-checks/pretest-luckylink.test.mjs
import { preTestCheck, preTestLines, judgeMachineInfo } from '../machine-test/machine-test-batch.mjs'
import { buildReport } from '../machine-test/machine-test-report.mjs'

let pass = 0, fail = 0
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && extra ? ' — ' + extra : ''}`) }

const BOX = { machineName: '873-LIONLINK-0231', version: '1.18.15', machineType: 'lionlink', onlineState: 'online', machineStatus: 'idle' }
const LL = { gmid: '873-LIONLINK-0231', sasversion: '602', clientversion: '1.1.6', isactive: 1, state: 1, groupName: 'G1' }
const json = (o) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } })
/** 假 fetch：盒子後台正常；LuckyLink 依 mode */
function install(mode) {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u.includes('backendservertest') && u.includes('/auth/login')) return json({ code: 20000, data: { token: 't' } })
    if (u.includes('/egm/floor/egmList')) return json({ code: 20000, data: { items: [BOX, { ...BOX, machineName: '873-LIONLINK-0232' }] } })
    if (u.includes('luckylink') && u.includes('/auth/login')) return mode === 'login-fail' ? json({ code: 50000 }) : json({ code: 20000, data: { token: 't' } })
    if (u.includes('/slot/egmList')) {
      const b = JSON.parse(init.body)
      if (!b.machineNumber) return json({ code: 40000, message: 'Operation timed out' })   // 全表一律逾時（實況）
      if (mode === 'single-timeout') { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e }
      return json({ code: 20000, data: { items: b.machineNumber === '0231' ? [LL] : [] } })
    }
    throw new Error('unexpected ' + u)
  }
}
const expectLL = { luckylink: 'yes', llProtocol: 'SAS', llVer: '1.1.6' }
const codes = ['873-LIONLINK-0231', '873-LIONLINK-0232']

// ① 全表逾時 → 逐台查：0231 有接、0232 確定沒有
install('ok')
let p = await preTestCheck(codes, expectLL)
let lines = preTestLines(p)
check('① 0231 逐台查到 → 有接，沒有不符', p.rows[0].row.llLinked === true && p.rows[0].issues.length === 0, JSON.stringify(p.rows[0]))
check('① 0232 API 成功沒這台 → 仍是「Egm list 沒有這台」＋預期有接', /Egm list 沒有這台/.test(lines[1]) && p.rows[1].issues.some(i => /預期有接/.test(i)), lines[1])
check('① errs 說明全表失敗、改逐台查', p.errs.some(e => /全表讀取失敗.*改逐台查/.test(e)), p.errs.join('|'))

// ② LuckyLink 登入失敗 → 全部「無法確認」，不說沒有這台、不比對 LL 預期值
install('login-fail')
p = await preTestCheck(codes, expectLL)
lines = preTestLines(p)
check('② 登入失敗 → 每台「LuckyLink 無法確認」', lines.every(l => /LuckyLink 無法確認（LuckyLink QAT 登入失敗）/.test(l)), lines.join('\n'))
check('② ⚠️ 不出現「沒有這台」', !lines.some(l => /沒有這台/.test(l)), lines.join('\n'))
check('② 不比對協議／版本／有接，只留一條「無法確認」', p.rows.every(r => r.issues.length === 1 && /無法確認.*預期值沒有比對/.test(r.issues[0])), JSON.stringify(p.rows.map(r => r.issues)))
check('② 盒子檢查照常（版號不符照樣報）', (await (async () => { install('login-fail'); const q = await preTestCheck(codes, { ...expectLL, machineVer: '9.9.9' }); return q.rows.every(r => r.issues.some(i => /盒子版號/.test(i))) })()))

// ③ 單台逾時 → 無法確認（逾時），沒給預期值時不算不符
install('single-timeout')
p = await preTestCheck(codes, {})
lines = preTestLines(p)
check('③ 單台逾時 → 無法確認（逾時）', lines.every(l => /LuckyLink 無法確認（逾時）/.test(l)), lines.join('\n'))
check('③ 沒給 LL 預期值 → 不列不符（但 errs 有記）', p.rows.every(r => r.issues.length === 0) && p.errs.some(e => /2 台無法確認/.test(e)), JSON.stringify(p.errs))

// ④ 報告 HTML：無法確認顯示原因，不顯示「清單沒有」
install('login-fail')
p = await preTestCheck(codes, expectLL)
// 拿真的 summary.json 當底（假的太小會缺欄位），只換掉 preTest；沒有那份檔就跳過這條
const SUMMARY = process.env.MT_SUMMARY_FIXTURE || 'C:/Users/user/Desktop/osm-qa-agent/reports/machine-test-ARUZE-final-1005/summary.json'
const fs = await import('node:fs')
const html = fs.existsSync(SUMMARY) ? await buildReport({ ...JSON.parse(fs.readFileSync(SUMMARY, 'utf8')), preTest: p }).catch(e => 'ERR ' + e.message) : null
if (html == null) console.log('SKIP ④ 找不到 summary.json fixture')
else { const sec = html.slice(html.indexOf('Pre-test check')); check('④ 報告寫「無法確認」、不寫「清單沒有」', /無法確認/.test(sec) && !/清單沒有/.test(sec), html.slice(0, 120)) }

// ⑤ 舊的 4 個參數呼叫行為不變（osm-qa-agent 的 pretest-probe 用這個）
const r = judgeMachineInfo('892-X-0001', null, null, { luckylink: 'yes' })
check('⑤ 4 參數、ll=null → 照舊「沒有這台，預期有接」', r.row.llListed === false && r.issues.some(i => /Egm list 沒有這台，預期有接/.test(i)), JSON.stringify(r))

console.log(`\n${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
