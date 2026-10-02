/** 通知出口：Discord embed → Lark 卡片、出口選擇、只重試失敗那一邊。跑法：npx tsx server/notify-outlet.test.ts
 *  ⚠️ 全程走測試縫，不寫 data.db 的 settings（正在跑的 server／worker 會讀到） */
import { __notifyTestSeam, deliverNotice, embedToLarkCard, flushNotifyRetries, larkTemplateFor, queueFailedSides, type Outlet, type RetryItem, type SideResult } from './notify-outlet.js'

let pass = 0, fail = 0
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : ` | got: ${JSON.stringify(got)} | want: ${JSON.stringify(want)}`}`)
  ok ? pass++ : fail++
}

const d = __notifyTestSeam.deps
let queue: RetryItem[] = []
let outlet: Outlet = 'discord'
let larkOk = true, larkCode = 'X'
const larkSent: object[] = [], larkUpdated: string[] = [], discordSent: Array<{ body: object; update?: string }> = []
let discordOk = true
d.outlets = () => ({ autospin: outlet, 'live-ledger': outlet, 'weekly-reminder': outlet })
d.chatId = () => 'oc_test'
d.mention = async labels => ({ line: labels.map(l => `@${l}`).join(' '), unmapped: labels, noPermission: true })
d.sendLark = async (_c, card) => { larkSent.push(card); return larkOk ? { ok: true, value: `om_${larkSent.length}` } : { ok: false, code: larkCode, message: 'lark down' } }
d.updateLark = async id => { larkUpdated.push(id); return larkOk ? { ok: true, value: true } : { ok: false, code: larkCode, message: 'lark down' } }
d.readQueue = () => queue
d.writeQueue = q => { queue = q }
d.tx = fn => fn()
const sendDiscord = async (body: object, update?: string): Promise<SideResult> => { discordSent.push({ body, update }); return discordOk ? { ok: true, messageId: update ?? 'd1' } : { ok: false, message: 'discord 500' } }
d.discordSender = () => sendDiscord
const reset = () => { larkSent.length = 0; larkUpdated.length = 0; discordSent.length = 0; queue = []; larkOk = true; discordOk = true; larkCode = 'X' }

// ── 卡片轉換 ──
const card = embedToLarkCard({
  title: '✅ AutoSpin — <@123>BIGFU', color: 0x22c55e, description: '跑完了 <t:1700000000:t>',
  fields: [{ name: '狀態', value: '完成', inline: true }, { name: 'Spin 數', value: '42', inline: true }, { name: '錯誤', value: '無', inline: true }, { name: 'URL', value: 'http://x' }],
  footer: { text: 'foot' },
}, '@Eric') as { header: { template: string; title: { content: string } }; elements: Array<{ tag: string; content?: string; fields?: unknown[] }> }
eq('標題的 Discord mention 被拿掉', card.header.title.content, '✅ AutoSpin — BIGFU')
eq('綠色 → green', card.header.template, 'green')
eq('描述第一行是 @人、Discord 時間戳轉成文字', [card.elements[0].tag, card.elements[0].content!.startsWith('@Eric\n跑完了 '), /<t:/.test(card.elements[0].content!)], ['markdown', true, false])
eq('inline 欄位兩兩一列、非 inline 自己一列', card.elements.filter(e => e.tag === 'div').map(e => e.fields!.length), [2, 1, 1])
eq('頁尾變 note', card.elements[card.elements.length - 1].tag, 'note')
eq('顏色：紅 / 灰 / 藍', [larkTemplateFor(0xef4444), larkTemplateFor(0x6b7280), larkTemplateFor(0x3b82f6)], ['red', 'grey', 'blue'])

// ── 出口選擇 ──
const input = { feature: 'autospin' as const, embed: { title: 't' }, discordContent: '<@1>', mentionLabels: ['Eric'] }
reset(); outlet = 'discord'; await deliverNotice(input, sendDiscord)
eq('出口 discord：只發 Discord', [discordSent.length, larkSent.length], [1, 0])
reset(); outlet = 'lark'; await deliverNotice(input, sendDiscord)
eq('出口 lark：只發 Lark', [discordSent.length, larkSent.length], [0, 1])
reset(); outlet = 'both'; const r1 = await deliverNotice(input, sendDiscord)
eq('出口 both：兩邊各一則、各自回 message id', [discordSent.length, larkSent.length, r1.discord?.messageId, r1.lark?.messageId], [1, 1, 'd1', 'om_1'])
reset(); outlet = 'both'; await deliverNotice({ ...input, update: { discordMessageId: 'd9', larkMessageId: 'om_9' } }, sendDiscord)
eq('更新：兩邊各改自己那則，不發新的', [discordSent[0].update, larkUpdated, larkSent.length], ['d9', ['om_9'], 0])

// ── 只重試失敗那一邊 ──
reset(); outlet = 'both'; larkOk = false
const r2 = await deliverNotice(input, sendDiscord); queueFailedSides(input, r2)
eq('Lark 失敗、Discord 成功 → 只排 Lark', queue.map(q => q.side), ['lark'])
discordSent.length = 0; larkOk = true
const f1 = await flushNotifyRetries(() => 'http://hook')
eq('補送：只送 Lark、Discord 不重發', [f1.sent, discordSent.length, larkSent.length, queue.length], [1, 0, 2, 0])

reset(); outlet = 'both'; larkOk = false; larkCode = 'NOT_CONFIGURED'
const r3 = await deliverNotice(input, sendDiscord); queueFailedSides(input, r3)
eq('Lark 沒設定（skipped）→ 不排補送（排了也不會好）', [r3.lark?.ok, r3.lark?.skipped, queue.length], [false, true, 0])

reset(); outlet = 'both'; larkOk = false
const r4 = await deliverNotice(input, sendDiscord); queueFailedSides(input, r4)
await flushNotifyRetries(() => 'http://hook')
eq('補送仍失敗 → 留在佇列、次數 +1', [queue.length, queue[0]?.tries], [1, 1])
queue[0].tries = 9
await flushNotifyRetries(() => 'http://hook')
eq('第 10 次仍失敗 → 放棄，不無限重試', queue.length, 0)

reset(); outlet = 'discord'; larkOk = false
const r5 = await deliverNotice(input, sendDiscord); queueFailedSides(input, r5)
eq('補送不看目前出口設定（設定改回 discord 後，原本排的 Lark 仍補送）', [r5.lark, queue.length], [undefined, 0])
queue = [{ feature: 'autospin', side: 'lark', embed: { title: 'old' }, firstAt: Date.now(), tries: 0 }]; larkOk = true
await flushNotifyRetries(() => 'http://hook')
eq('…佇列裡的 Lark 項目照樣送出', [larkSent.length, queue.length], [1, 0])

Object.assign(d, __notifyTestSeam.original)
console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
