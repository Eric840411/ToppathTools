// iDeck 時間學習第一期（1007）探針：npx tsx scripts/ideck-timing-probe.ts
// 純函式＋**真的 stepIdeck**（真瀏覽器、假遊戲頁）：假頁面的按鈕照正式環境的格式印 dealGMActionReq／SEND／ON／moneyNtc，
// 並寫 window.__moneyLog（runner 的 gate 只認它）。每個情境看「按鈕實際被按的時間」與 iDeck 結果。
// ⚠️ 每個情境都會跑 stepIdeck 裡固定的 15 秒盒子 log 等待，整支約 3～4 分鐘
import { chromium, type Page } from 'playwright'
import { ideckRoundState, ideckBeginWait, ideckQuietWaitMs, attributeBegin, IDECK_CONSERVATIVE_BEGIN_MS, type IdeckTimingCfg } from '../server/machine-test/verdicts.js'
import { stepIdeck } from '../server/machine-test/runner.js'

let fail = 0, n = 0
const ok = (c: boolean, label: string, got?: unknown) => { n++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${got !== undefined ? `：${typeof got === 'string' ? got : JSON.stringify(got)}` : ''}`) }

// ── 純函式 ──
const cfg: IdeckTimingCfg = { schemaVersion: 1, status: 'confirmed', confirmedAt: '2026-10-07', beginWaitMs: 1500, buttons: { PLAY11Credits: { noRound: true }, PLAY33Credits: { noRound: true } } }
ok(ideckRoundState([]) === 'unknown', '沒有任何事件 → unknown（無法證明空閒）')
ok(ideckRoundState([{ seq: 1, reason: 'begin', ts: 1 }, { seq: 2, reason: 'end', ts: 2 }]) === 'idle', 'begin→end → idle')
ok(ideckRoundState([{ seq: 3, reason: 'begin', ts: 3 }, { seq: 2, reason: 'end', ts: 9 }]) === 'open', '依 seq 不依讀到的順序：舊 end 不能蓋過新 begin')
const bw = (o: Partial<Parameters<typeof ideckBeginWait>[0]>) => ideckBeginWait({ cfg, key: 'PLAY11Credits', ackOk: true, gate: 'idle', degraded: null, ...o }).ms
ok(bw({}) === 1500, '條件都符合 → 1500ms')
ok(bw({ key: 'BETx1' }) === null && bw({ key: null }) === null, '不在清單／沒有 name → 保守')
ok(bw({ ackOk: false }) === null, 'ack 沒對上 → 保守')
ok(bw({ gate: 'unknown' }) === null, '無法證明空閒 → 保守')
ok(bw({ degraded: '晚到' }) === null, '本台已降級 → 保守')
ok(bw({ cfg: { ...cfg, status: 'learning' } }) === null && bw({ cfg: { ...cfg, status: 'learned-unconfirmed' } }) === null, '不是 confirmed → 保守')
ok(bw({ cfg: { ...cfg, schemaVersion: 2 as 1 } }) === null, '版本不符 → 保守')
ok(bw({ cfg: { ...cfg, beginWaitMs: 99999 } }) === IDECK_CONSERVATIVE_BEGIN_MS, '學習值不會比保守還長')
ok(ideckQuietWaitMs({ clickTs: 1000, fast: true }, 3000) === 4000 && ideckQuietWaitMs({ clickTs: 1000, fast: false }, 3000) === 0, '靜默窗：短等待之後要等滿 6 秒')
ok(attributeBegin({ beginTs: 4000, prev: { clickTs: 1000, fast: true }, nextClickTs: 5000 }) === 'prev', 'begin 在下一顆之前 → 上一顆')
ok(attributeBegin({ beginTs: 5500, prev: { clickTs: 1000, fast: true }, nextClickTs: 5000 }) === 'ambiguous', 'begin 在下一顆之後、仍在上一顆（短等待）窗口內 → 歸屬不明')
ok(attributeBegin({ beginTs: 7500, prev: { clickTs: 1000, fast: true }, nextClickTs: 7100 }) === 'next', '上一顆窗口已過 → 下一顆')
ok(attributeBegin({ beginTs: 5500, prev: { clickTs: 1000, fast: false }, nextClickTs: 5000 }) === 'next', '上一顆是保守 → 下一顆（跟原本一樣）')

// ── 真的 stepIdeck ──
// 1008：按鈕上的字跟 SEND 的 action name 照正式環境分開（PLAY 11 Credits ↔ Bet11、BETx1 ↔ BetMultiple1）——
//   原本兩個寫成一樣，runner 拿 action name 查按鈕字的清單這個 bug 測不出來
type Btn = { name: string; text?: string; jp?: boolean; aid: number; ack?: boolean; beginAfter?: number; roundMs?: number }
const page_ = (btns: Btn[], pre: string) => `<!doctype html><script>
window.__moneyLog = []; window.__clicks = []; let mseq = 0, rseq = 100;
function money(reason){ window.__moneyLog.push({ seq: ++mseq, coin: 1000, reason, ts: Date.now() }); console.log('moneyNtc', { reason, coin: 1000 }) }
function press(i){ const b = BTNS[i]; window.__clicks.push({ name: b.name, ts: Date.now() }); const s = ++rseq;
  if (b.jp) document.body.insertAdjacentHTML('beforeend', '<div class="content"><div class="view">View</div><div class="notification-close" style="width:24px;height:24px;background:#c00" onclick="window.__jpClosed=(window.__jpClosed||0)+1">x</div></div>')
  console.log('dealGMActionReq: ' + s + ' ' + b.name + ' ' + b.aid)
  console.log('SEND: ' + s + ' hall.hallHandler.dealGMActionReq', { actionid: b.aid, isspin: 1 })
  if (b.ack !== false) setTimeout(() => console.log('ON: ' + s + ' hall.hallHandler.dealGMActionReq', { actionid: b.aid }), 80)
  if (b.beginAfter !== undefined) setTimeout(() => { money('begin'); setTimeout(() => money('end'), b.roundMs ?? 800) }, b.beginAfter)
}
const BTNS = ${JSON.stringify(btns)};
${pre}
</script>${btns.map((b, i) => `<div class="btn_bet" style="width:80px;height:40px;margin:4px" onclick="press(${i})">${b.text ?? b.name}</div>`).join('')}`
let html = ''
async function run(page: Page, btns: Btn[], o: { cfg?: IdeckTimingCfg | null; revoked?: string | null; pre?: string; noQuiet?: boolean; code?: string } = {}) {
  html = page_(btns, o.pre ?? "money('begin'); money('end')")
  await page.goto(`http://probe.local/game/${Date.now()}`)
  const revokes: string[] = []
  const t0 = Date.now()
  const r = await stepIdeck(page, () => {}, o.code ?? '', undefined, undefined, undefined, () => false, undefined, 'probe-', undefined,
    { cfg: o.cfg === undefined ? cfg : o.cfg, revoked: o.revoked ?? null, onRevoke: why => revokes.push(why), _probeNoQuietWindow: o.noQuiet })
  const clicks = await page.evaluate(() => (window as any).__clicks as { name: string; ts: number }[])
  const log = await page.evaluate(() => (window as any).__moneyLog as { seq: number; reason: string; ts: number }[])
  const t = JSON.parse(r.extraData?.ideckTiming ?? '{}')
  const jpClosed = await page.evaluate(() => (window as any).__jpClosed ?? 0) as number
  return { r, clicks, log, revokes, t, ms: Date.now() - t0, jpClosed }
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
await page.route('http://probe.local/**', r => r.fulfill({ contentType: 'text/html', body: html }))
try {
  const NR: Btn[] = [{ name: 'Bet11', text: 'PLAY 11 Credits', aid: 11 }, { name: 'Bet33', text: 'PLAY 33 Credits', aid: 33 }, { name: 'BetMultiple1', text: 'BETx1', aid: 1, beginAfter: 700, roundMs: 800 }]
  // 1. 套用學習值：清單裡的兩顆短等待、BET 保守；結果跟保守模式一樣
  const fast = await run(page, NR)
  const slow = await run(page, NR, { cfg: null })
  const modes = fast.t.buttons?.map((b: { mode: string }) => b.mode)
  // 1008 別下大注：BETx1 會開局（倍數族群是開局鍵）→ 不再按 x1 還原；最後按的 Credits 是 33 → 按回最小的 PLAY 11
  ok(JSON.stringify(modes) === '["fast","fast","conservative"]' && JSON.stringify(fast.clicks.map(c => c.name)) === '["Bet11","Bet33","BetMultiple1","Bet11"]', '清單裡的兩顆（PLAY 11／33 Credits）短等待、BET 保守；收尾按回最小 Credits、倍數是開局鍵不再還原', { modes, clicks: fast.clicks.map(c => c.name) })
  ok(fast.r.status === slow.r.status && fast.clicks.length === slow.clicks.length, '結果跟保守模式一致', { fast: fast.r.status, slow: slow.r.status })
  const gaps = (c: { ts: number }[]) => c.slice(1).map((x, i) => x.ts - c[i].ts)
  ok(gaps(fast.clicks).every((g, i) => modes[i] !== 'fast' || g >= IDECK_CONSERVATIVE_BEGIN_MS - 50) && gaps(fast.clicks).filter((_, i) => modes[i] === 'fast').length === 2, '短等待之後，下一顆仍等滿 6 秒靜默窗', gaps(fast.clicks))
  ok(fast.ms < slow.ms, 'iDeck 時間變短', { fast: fast.ms, slow: slow.ms })
  ok(/時間模式：學習值/.test(fast.r.message) && /時間模式：保守/.test(slow.r.message), '訊息寫明時間模式')
  ok(fast.t.buttons?.[2]?.t_round !== null && fast.t.buttons?.[0]?.t_begin === null && fast.t.buttons?.[0]?.t_ready === null, '時間欄位：沒觀測到記 null、t_ready 不填固定等待', fast.t.buttons?.[0])

  // 2. 晚到的 begin（短等待 1.5 秒之後、下一顆之前）→ 記在那一顆「有開局」、撤銷、後面改保守
  // 第二顆用不屬於任何族群的鍵（AUTO），不然「最小那顆有開局 → 同族群不按」會先擋下來（那條另有測試）
  const late = await run(page, [{ name: 'Bet11', text: 'PLAY 11 Credits', aid: 11, beginAfter: 2500, roundMs: 600 }, { name: 'Auto', text: 'AUTO', aid: 33 }])
  ok(late.revokes.length === 1 && /晚到|才開局/.test(late.revokes[0]), '晚到的 begin → 撤銷機種學習值', late.revokes)
  ok(late.t.buttons?.[0]?.lateBeginMs > 1500 && /iDeck 開局 1 顆/.test(late.r.message) && late.t.buttons?.[1]?.mode === 'conservative', '那一顆記「有開局」、下一顆改保守', late.t.buttons?.map((b: { mode: string }) => b.mode))
  const endTs = late.log.filter(e => e.reason === 'end').at(-1)!.ts
  ok(late.clicks[1].ts >= endTs, '晚到的局結束之後才按下一顆', { end: endTs, next: late.clicks[1].ts })

  // 3. begin 在 5 秒（下一顆若沒有靜默窗就會先按下去）→ 有靜默窗：仍歸給前一顆、不會跟下一顆混
  const mid = await run(page, [{ name: 'Bet11', text: 'PLAY 11 Credits', aid: 11, beginAfter: 5000, roundMs: 600 }, { name: 'Auto', text: 'AUTO', aid: 33 }])
  ok(mid.t.buttons?.[0]?.lateBeginMs >= 4900 && !mid.t.ambiguous && mid.clicks[1].ts > mid.log.find(e => e.reason === 'begin' && e.seq > 2)!.ts, '5 秒才開局 → 歸前一顆、下一顆在之後才按', mid.r.message.slice(0, 160))

  // 4. 雙來源亂序：流水（__moneyLog）顯示局還開著、console 卻先印了一個 end → gate 只認流水，等真的 end 才按
  const dis = await run(page, [{ name: 'Bet11', text: 'PLAY 11 Credits', aid: 11 }], { pre: "money('begin'); money('end'); window.__moneyLog.push({ seq: ++mseq, coin: 1, reason: 'begin', ts: Date.now() }); console.log('moneyNtc', { reason: 'end', coin: 1 }); setTimeout(() => money('end'), 3000)" })
  const realEnd = dis.log.filter(e => e.reason === 'end').at(-1)!.ts
  ok(dis.clicks.length === 1 && dis.clicks[0].ts >= realEnd, '流水說局還開著 → 等流水的 end 才按（console 的 end 不算）', { end: realEnd, click: dis.clicks[0]?.ts })

  // 5. noAck、只剩點擊前的舊 end → 不重按、6 秒沒事件＝不明 → 停本台 iDeck（後面零點擊）
  const na = await run(page, [{ name: 'Bet11', text: 'PLAY 11 Credits', aid: 11, ack: false }, { name: 'Bet33', text: 'PLAY 33 Credits', aid: 33 }])
  ok(na.clicks.length === 1, 'noAck → 不重按、後面的按鈕也不按', na.clicks.map(c => c.name))
  ok(na.r.status === 'fail' && /no response/.test(na.r.message) && /無法確認/.test(na.r.message), 'noAck 照判 no response，並寫明停手原因', na.r.message.slice(-160))

  // 6. 最後一顆晚到的 begin（沒有下一顆的關卡）→ 收尾時抓到、撤銷
  const last = await run(page, [{ name: 'Bet11', text: 'PLAY 11 Credits', aid: 11 }, { name: 'Bet33', text: 'PLAY 33 Credits', aid: 33, beginAfter: 3000, roundMs: 500 }])
  ok(last.revokes.length === 1 && /PLAY33Credits/.test(last.revokes[0]), '最後一顆晚到的 begin → 撤銷', last.revokes)
  ok(last.t.buttons?.[1]?.lateBeginMs >= 2900 && /iDeck 開局 1 顆/.test(last.r.message), '最後一顆記「有開局」', last.t.buttons?.[1])

  // 7. 撤銷沒寫進中控（runner 收到 revoked／ideckNoFast）→ 全部保守
  const rv = await run(page, NR, { revoked: '撤銷沒寫進中控' })
  ok(rv.t.buttons?.every((b: { mode: string }) => b.mode === 'conservative'), '已撤銷 → 全部保守', rv.t.buttons?.map((b: { mode: string }) => b.mode))

  // 8. 沒有任何 money 事件（無法證明空閒）→ 保守
  const unk = await run(page, [{ name: 'Bet11', text: 'PLAY 11 Credits', aid: 11 }], { pre: '' })
  ok(unk.t.buttons?.[0]?.mode === 'conservative', '沒看過任何 money 事件 → 保守', unk.t.buttons?.[0]?.why)

  // 9. 歸屬不明（關掉靜默窗才走得到）：begin 在下一顆送出之後、又在上一顆短等待的窗口內 →
  //    本台 iDeck 中止（後面零點擊）、記 not verified、不判 fail、撤銷；stepIdeck 正常回傳（之後交回 stepGate 接觸屏／CCTV／退出）
  const amb = await run(page, [{ name: 'Bet11', text: 'PLAY 11 Credits', aid: 11, beginAfter: 5500, roundMs: 600 }, { name: 'Auto', text: 'AUTO', aid: 33 }, { name: 'BetMultiple1', text: 'BETx1', aid: 1, beginAfter: 700 }], { noQuiet: true })
  ok(amb.r.status === 'skip' && /ideck not verified \(timing ambiguous\)/.test(amb.r.message), '歸屬不明 → not verified（不是 fail、也不是 pass）', amb.r.status)
  ok(amb.clicks.length === 2 && !amb.clicks.some(c => c.name === 'BetMultiple1'), '歸屬不明之後 iDeck 零點擊', amb.clicks.map(c => c.name))
  ok(amb.revokes.length === 1 && /歸屬不明/.test(amb.revokes[0]), '歸屬不明也撤銷', amb.revokes)

  // 1008 別下大注：最小那顆（PLAY 11）晚到開局 → 同族群的 PLAY 33 不按
  const fam = await run(page, [{ name: 'Bet11', text: 'PLAY 11 Credits', aid: 11, beginAfter: 2500, roundMs: 600 }, { name: 'Bet33', text: 'PLAY 33 Credits', aid: 33 }])
  ok(fam.clicks.length === 1 && /略過 1 顆（PLAY 33 Credits：/.test(fam.r.message), '最小那顆晚到開局 → 同族群比它大的不按、寫出略過原因', { clicks: fam.clicks.map(c => c.name), msg: fam.r.message.slice(0, 200) })
  // CodeX 139aa8d [P1]：最後一顆（沒有倍數鍵、不會還原）短等待後才晚開局、45 秒都沒結束 → 不能 PASS
  const tail = await run(page, [{ name: 'Bet11', text: 'PLAY 11 Credits', aid: 11, beginAfter: 2500, roundMs: 120000 }])
  ok(tail.r.status === 'fail' && tail.t.buttons?.[0]?.result === 'spinTimeout', '末顆晚開局 45 秒沒結束 → 記開轉逾時，不是 PASS', { status: tail.r.status, result: tail.t.buttons?.[0]?.result })
  // CodeX 139aa8d [P2]：中止（noAck 停手）時畫面上有 JP 廣播卡 → 收尾截圖照原樣截，不點卡片的 X
  const jp = await run(page, [{ name: 'Bet11', text: 'PLAY 11 Credits', aid: 11, ack: false, jp: true }, { name: 'Bet33', text: 'PLAY 33 Credits', aid: 33 }], { code: '873-ZZPROBE-0001' })
  ok(jp.clicks.length === 1 && jp.jpClosed === 0, '中止時有 JP 卡 → 零後續點擊（連 JP 卡的 X 都不點）', { clicks: jp.clicks.map(c => c.name), jpClosed: jp.jpClosed, status: jp.r.status })
} finally {
  await browser.close()
}
console.log(fail ? `❌ ${fail}/${n} 失敗` : `✅ ${n}/${n} 通過`)
process.exit(fail ? 1 : 0)
