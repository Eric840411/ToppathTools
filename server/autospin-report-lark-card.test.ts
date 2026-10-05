/**
 * AutoSpin 定時彙總報告 Lark 卡片。跑法：npx tsx server/autospin-report-lark-card.test.ts
 * 守：欄位開關決定區塊、試發送／正式的外觀分開、扣款疑慮顏色、沒 errcode 寫「無」、SLS 查不了不寫成正常、外來文字不能注入標籤。
 */
import { buildStatusReportLarkCard, type StatusReportOpts, type StatusReportStats } from './autospin-report-lark-card.js'

let pass = 0
const fails: string[] = []
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) } else { fails.push(`${name} | got: ${g} | want: ${w}`); console.log(`❌ ${name} | got: ${g} | want: ${w}`) }
}
const stats = (o: Partial<StatusReportStats> = {}): StatusReportStats => ({ spinCount: 42, okSpinCount: 41, winCount: 5, totalWin: 1234, lastCoin: null, errcodeCounts: {}, recoverCount: 0, kickoutCount: 0, crChecks: 8, crNoResponse: 0, ...o })
const ALL = { spins: true, winRate: true, errcodes: true, recover: true, kickouts: true, crChecks: true, uptime: true, sls: true }
const base = (o: Partial<StatusReportOpts> = {}): StatusReportOpts => ({ machineType: 'JJBX_01', gameTitleCode: '873-TEST-0001', periodMinutes: 20, cumulative: stats({ spinCount: 1234, lastCoin: 500000 }), period: stats(), uptimeMinutes: 192, fields: ALL, customNote: '', sls: null, ...o })
type Card = { header: { template: string; title: { content: string }; subtitle: { content: string }; text_tag_list?: unknown[] }; elements: unknown[] }
const card = (o: Partial<StatusReportOpts> = {}, m = '') => buildStatusReportLarkCard(base(o), m) as Card
const text = (c: Card) => JSON.stringify(c.elements)

{
  const c = card()
  eq('正式：藍色、沒有試發送標籤', [c.header.template, c.header.text_tag_list], ['blue', undefined])
  eq('標題＝AutoSpin 定時彙總｜機台', c.header.title.content, '📊 AutoSpin 定時彙總｜JJBX_01')
  eq('副標＝gmid · 本期間 · 已跑', c.header.subtitle.content, '873-TEST-0001 · 本期間 20.0 分鐘 · 已跑 ~3h12m')
  eq('沒有 errcode → 寫「無」', text(c).includes("<font color='green'>無</font>"), true)
  eq('不出現 ok%（CodeX 定的用詞）', /ok\s*%|OK 率/i.test(text(c)), false)
  eq('累計 lastCoin 放小字', text(c).includes('lastCoin ~500,000'), true)
}
{
  const c = card({ isTest: true }, '@Eric Wu')
  eq('試發送：橘色＋試發送標籤', [c.header.template, (c.header.text_tag_list as Array<{ text: { content: string } }>)[0].text.content], ['orange', '試發送'])
  eq('試發送：mention 行＋橘字警告', text(c).includes('@Eric Wu') && text(c).includes('這是試發送測試訊息'), true)
}
{
  const c = card({ fields: { ...ALL, uptime: false, errcodes: false, sls: false, recover: false, kickouts: false, crChecks: false } })
  eq('關掉已跑時間 → 副標沒有已跑', c.header.subtitle.content.includes('已跑'), false)
  eq('關掉 errcode → 沒有 errcode 區', text(c).includes('errcode'), false)
  eq('穩定性三項都關 → 沒有穩定性區', text(c).includes('穩定性'), false)
  const c2 = card({ fields: { ...ALL, spins: false, winRate: false } })
  eq('局數與輸贏兩項都關 → 沒有那區', text(c2).includes('局數與輸贏'), false)
}
{
  const period = stats({ errcodeCounts: { '5': 1 }, outcomeCounts: { completed: 30, completed_late: 5, suspected: 8, unknown: 4, not_started: 0 } })
  const cumulative = stats({ errcodeCounts: { '5': 3, '29': 1 }, errcodeTimes: { '29': [Date.UTC(2026, 9, 5, 6, 0, 0)] },
    errImpact: { '5': { count: 3, deducted: 0, unknown: 0, needsReconcile: 0, maxRecoverSec: 8.2, lastDes: 'service restarting' }, '29': { count: 1, deducted: 1, unknown: 2, needsReconcile: 1, maxRecoverSec: 31.5, lastDes: 'internal <at id=all></at> error' } },
    outcomeCounts: { completed: 980, completed_late: 96 } })
  const t = text(card({ period, cumulative }))
  eq('完成局數主數字＋延遲推定小字', t.includes('＋延遲推定 5 ＝ 35') && t.includes('＋延遲推定 96 ＝ 1,076'), true)
  eq('疑似完成／不確定縮成 note', t.includes('本期間：疑似完成 8（無結算證據）｜延遲推定 5｜不確定 4'), true)
  eq('errcode 依累計次數排序（err5 在 err29 前）', t.indexOf('`err5`') < t.indexOf('`err29`'), true)
  eq('err5 累計 3、本期間 1', t.includes('`err5` × 3　<font color=\'grey\'>本期間 1</font>'), true)
  eq('扣款疑慮 0 綠、>0 紅', t.includes("<font color='green'>0</font>") && t.includes("<font color='red'>1</font>"), true)
  eq('餘額不明／待查帳有值才出現', t.includes('餘額不明 2') && t.includes('待查帳 1') && (t.match(/餘額不明/g) ?? []).length === 1, true)
  eq('最近時間點放小字', t.includes('err29 最近 '), true)
  eq('伺服器描述裡的 <at> 被轉成全形，不會真的 @all', t.includes('<at id=all>') === false && t.includes('＜at id=all＞'), true)
}
{
  const t = text(card({ period: stats({ kickoutCount: 1 }) }))
  eq('kickouts >0 橘色', t.includes("<font color='orange'>1</font>"), true)
}
{
  const unmapped = text(card({ sls: { machineName: 'x', groupIds: [], logstores: [], events: [], unmapped: true, note: '找不到這台機台對應的 log' } }))
  eq('SLS 查不到對應 → ⚠️ 查不了、不寫服務正常', unmapped.includes('⚠️ 找不到這台機台對應的 log') && !unmapped.includes('服務正常'), true)
  const ok = text(card({ sls: { machineName: 'x', groupIds: ['12'], logstores: [], events: [], unmapped: false, note: '' } }))
  eq('SLS 沒事件 → 綠點服務正常', ok.includes("<font color='green'>● 服務正常</font>"), true)
  const ev = text(card({ sls: { machineName: 'x', groupIds: ['12'], logstores: [], unmapped: false, note: '', events: [{ kind: 'offline', label: 'G2S 斷線', times: [Date.now()], count: 2, logstore: 'test-liveslots-luckylinkg2s-abc-logs' }] as never } }))
  eq('SLS 有事件 → 逐列、logstore 縮短', ev.includes('G2S 斷線 × 2') && ev.includes('abc') && !ev.includes('test-liveslots'), true)
}
{
  const t = text(card({ customNote: '負責人 <b>Eric</b>', aiAnalysis: '**正常**' }))
  eq('自訂備註與 AI 分析各一區', t.includes('📝 備註') && t.includes('🤖 AI 分析') && t.includes('**正常**'), true)
  eq('自訂備註的標籤被轉掉', t.includes('<b>') === false, true)
}

console.log(`\n${pass} 通過，${fails.length} 失敗`)
if (fails.length) { console.log(fails.join('\n')); process.exit(1) }
