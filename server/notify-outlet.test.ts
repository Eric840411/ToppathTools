/** 通知出口：通知內容 → Lark 卡片、Lark 發送與補送（v5.13.0 Discord 已移除）。跑法：npx tsx server/notify-outlet.test.ts
 *  ⚠️ 全程走測試縫，不寫 data.db 的 settings（正在跑的 server／worker 會讀到） */
import { __notifyTestSeam, deliverNotice, embedToLarkCard, flushNotifyRetries, larkTemplateFor, queueFailedSides, type RetryItem } from './notify-outlet.js'

let pass = 0, fail = 0
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : ` | got: ${JSON.stringify(got)} | want: ${JSON.stringify(want)}`}`)
  ok ? pass++ : fail++
}

const d = __notifyTestSeam.deps
let queue: RetryItem[] = []
let larkOk = true, larkCode = 'X'
const larkSent: object[] = [], larkUpdated: string[] = []
d.chatId = () => 'oc_test'
d.mention = async labels => ({ line: labels.map(l => `@${l}`).join(' '), unmapped: labels, noPermission: true })
d.sendLark = async (_c, card) => { larkSent.push(card); return larkOk ? { ok: true, value: `om_${larkSent.length}` } : { ok: false, code: larkCode, message: 'lark down' } }
d.updateLark = async id => { larkUpdated.push(id); return larkOk ? { ok: true, value: true } : { ok: false, code: larkCode, message: 'lark down' } }
d.readQueue = () => queue
d.writeQueue = q => { queue = q }
d.tx = fn => fn()
const reset = () => { larkSent.length = 0; larkUpdated.length = 0; queue = []; larkOk = true; larkCode = 'X' }

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

// ── Lark 專用卡片（v5.8.0：AutoSpin 定時彙總報告）──
{
  reset()
  let gotMention = ''
  await deliverNotice({ feature: 'autospin', embed: { title: 'embed 版' }, mentionLabels: ['Eric'], larkCard: m => { gotMention = m; return { custom: true } } })
  eq('有給 larkCard → Lark 送的是它，不是 embed 轉的', larkSent, [{ custom: true }])
  eq('larkCard 拿到 @人 那行', gotMention, '@Eric')
  reset()
  await deliverNotice({ feature: 'autospin', embed: { title: 'embed 版' } })
  eq('沒給 larkCard → 照舊從 embed 轉', (larkSent[0] as { header: { title: { content: string } } }).header.title.content, 'embed 版')
}

// ── 舊版本排進來的 Discord 補送：丟掉、不改送 Lark（CodeX：多半已經在 Lark 發過）──
{
  reset()
  queue = [{ id: 'd-old', feature: 'autospin', side: 'discord', embed: { title: '退場前排的' }, firstAt: Date.now(), tries: 0 }, { id: 'l-1', feature: 'autospin', side: 'lark', embed: { title: 'lark 的' }, firstAt: Date.now(), tries: 0 }]
  const r = await flushNotifyRetries()
  eq('Discord 補送從佇列移除、沒有改送 Lark；Lark 的照常補送', [queue.length, larkSent.length, (larkSent[0] as { header: { title: { content: string } } }).header.title.content, r.dropped], [0, 1, 'lark 的', 1])
}

// ── 發送 ──
const input = { feature: 'autospin' as const, embed: { title: 't' }, mentionLabels: ['Eric'] }
reset(); const r1 = await deliverNotice(input)
eq('發一則 Lark、回 message id', [larkSent.length, r1.lark.messageId], [1, 'om_1'])
reset(); await deliverNotice({ ...input, update: { larkMessageId: 'om_9' } })
eq('更新：改原本那則，不發新的', [larkUpdated, larkSent.length], [['om_9'], 0])

// ── 失敗排補送 ──
reset(); larkOk = false
const r2 = await deliverNotice(input); queueFailedSides(input, r2)
eq('Lark 失敗 → 排補送', queue.map(q => q.side), ['lark'])
larkOk = true
const f1 = await flushNotifyRetries()
eq('補送成功 → 移出佇列', [f1.sent, larkSent.length, queue.length], [1, 2, 0])

reset(); larkOk = false; larkCode = 'NOT_CONFIGURED'
const r3 = await deliverNotice(input); queueFailedSides(input, r3)
eq('Lark 沒設定（skipped）→ 不排補送（排了也不會好）', [r3.lark?.ok, r3.lark?.skipped, queue.length], [false, true, 0])

reset(); larkOk = false
const r4 = await deliverNotice(input); queueFailedSides(input, r4)
await flushNotifyRetries()
eq('補送仍失敗 → 留在佇列、次數 +1', [queue.length, queue[0]?.tries], [1, 1])
queue[0].tries = 9
await flushNotifyRetries()
eq('第 10 次失敗 → 次數到 10、先留著', queue[0]?.tries, 10)
larkSent.length = 0
await flushNotifyRetries()
eq('…下一輪領取時判定用完次數 → 移除且**沒有再送**', [queue.length, larkSent.length], [0, 0])


// ── CodeX review [P2]：期限在發送前檢查 ──
reset()
queue = [{ id: 'old', feature: 'autospin', side: 'lark', embed: { title: '25 小時前' }, firstAt: Date.now() - 25 * 3600_000, tries: 0 }]
const f2 = await flushNotifyRetries()
eq('排了 25 小時的項目 → 不送、直接移除', [larkSent.length, queue.length, f2.dropped], [0, 0, 1])

// ── CodeX review [P1]：領取是租約，送完才刪 ──
reset()
let release: () => void = () => {}
const realSend = d.sendLark
d.sendLark = async (c, card) => { await new Promise<void>(r => { release = r }); return realSend(c, card) }
queue = [{ id: 'a', feature: 'autospin', side: 'lark', embed: { title: 'a' }, firstAt: Date.now(), tries: 0 }]
const inflight = flushNotifyRetries()
await new Promise(r => setTimeout(r, 10))
eq('送到一半（process 這時死掉的話）→ 項目還在佇列、只是標了租約', [queue.length, queue[0]?.id, typeof queue[0]?.leaseUntil], [1, 'a', 'number'])
release(); await inflight
d.sendLark = realSend
eq('送成功後才刪', queue.length, 0)

reset()
const t0 = Date.now()
queue = [
  { id: 'dead-lease', feature: 'autospin', side: 'lark', embed: { title: '租約過期' }, firstAt: t0, tries: 0, leaseUntil: t0 - 1 },
  { id: 'live-lease', feature: 'autospin', side: 'lark', embed: { title: '別人正在送' }, firstAt: t0, tries: 0, leaseUntil: t0 + 60_000 },
]
await flushNotifyRetries()
eq('租約過期的（之前那個 process 死了）→ 重新領取送出；別人租約還在的 → 不碰', [larkSent.length, queue.map(q => q.id)], [1, ['live-lease']])

reset()
const realMention = d.mention
d.mention = async () => { throw new Error('boom') }
queue = [{ id: 'x', feature: 'autospin', side: 'lark', embed: { title: 'x' }, firstAt: Date.now(), tries: 0 }]
let threw = false
try { await flushNotifyRetries() } catch { threw = true }
d.mention = realMention
eq('送的時候拋例外 → flush 自己接住、不往外拋', threw, false)
eq('送的時候拋例外 → 不會整批消失，放回佇列、次數 +1、解除租約', [queue.length, queue[0]?.tries, queue[0]?.leaseUntil], [1, 1, undefined])

// ── CodeX review 7027e12 [P1]：v5.1.0 的舊項目沒有 id ──
reset()
let call = 0
const realSend2 = d.sendLark
d.sendLark = async (c, card) => { call++; larkOk = call === 1; return realSend2(c, card) }   // 第一筆成功、第二筆失敗
queue = [
  { feature: 'autospin', side: 'lark', embed: { title: '舊1' }, firstAt: Date.now(), tries: 0 },
  { feature: 'autospin', side: 'lark', embed: { title: '舊2' }, firstAt: Date.now(), tries: 0 },
] as unknown as RetryItem[]
await flushNotifyRetries()
d.sendLark = realSend2
eq('兩筆沒 id 的舊項目：第一筆成功只刪它、第二筆失敗放回（不整批誤刪）', [queue.length, queue[0]?.embed.title, queue[0]?.tries, !!queue[0]?.id], [1, '舊2', 1, true])

// ── CodeX review 7027e12 [P2]：批次途中過期 ──
reset()
let fake = Date.now()
const born = fake - 24 * 3600_000 + 1000   // 再 1 秒就滿 24 小時
const slow = d.sendLark
d.sendLark = async (c, card) => { fake += 2000; return slow(c, card) }   // 每筆送 2 秒
queue = [
  { id: 'p1', feature: 'autospin', side: 'lark', embed: { title: '先送' }, firstAt: fake, tries: 0 },
  { id: 'p2', feature: 'autospin', side: 'lark', embed: { title: '快過期' }, firstAt: born, tries: 0 },
]
const f3 = await flushNotifyRetries(() => fake)
d.sendLark = slow
eq('第二筆輪到時已過期 → 不送、移除', [larkSent.length, queue.length, f3.dropped], [1, 0, 1])

Object.assign(d, __notifyTestSeam.original)
console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
