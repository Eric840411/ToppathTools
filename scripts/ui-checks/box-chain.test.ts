/**
 * 盒子 log 三層配對（v5.51.0，osm-qa-agent spec #2，CodeX 定案）：success_json → usb_coordinate → hw_response。
 *   npx tsx scripts/ui-checks/box-chain.test.ts
 * 前半：真的盒子 log（fixtures/box-chain，1013 LIONLINK，同一台修好前後各一份）；後半：CodeX 要求的合成情境。
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { boxChains, successChains, touchChainVerdict, ideckBoxChain, ideckVerdict, type BoxLogEntry, type IdeckOutcome } from '../../server/machine-test/verdicts.ts'

let fail = 0, n = 0
const ok = (c: boolean, label: string, got?: unknown) => { n++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${!c && got !== undefined ? `：${typeof got === 'string' ? got : JSON.stringify(got)}` : ''}`) }

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'box-chain')
const tl = (name: string) => (JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8')) as { data: { timeline: BoxLogEntry[] } }).data.timeline
const cmdOf = (e: BoxLogEntry) => String(((typeof e.data === 'string' ? JSON.parse(e.data) : e.data) as { cmd?: unknown })?.cmd ?? '')
const coords = (t: BoxLogEntry[]) => [...new Set(t.filter(e => e.type === 'success_json').map(cmdOf).filter(c => /^\d+,\d+$/.test(c)))]
const touch = (name: string) => { const t = tl(name); return touchChainVerdict(boxChains(t, coords(t))) }
const ideck = (name: string) => ideckBoxChain(successChains(tl(name), e => !/^\d+,\d+$/.test(cmdOf(e))))

// ── 真的盒子 log ──
let v = touch('0231-box-1830')
ok(v.status === 'pass' && v.ok === v.total, '正常台 0231：三層都齊 → PASS', v)
v = touch('0237-box-1834')
ok(v.status === 'fail' && /no response（機台不回應/.test(v.tag), '⚠️ 0237（盒子送了 usb、機台 hw 0）→ FAIL no response（原本 PASS 3/3）', v)
ok(/18,9\?未驗\(log 還沒涵蓋完整 10 秒\)/.test(v.detail), '0237：log 在最後一下之後就結束 → 那一格未驗，不硬判', v.detail)
v = touch('0237-box-1855')
ok(v.status === 'fail' && /no response/.test(v.tag), '0237 第二次 → 一樣 FAIL no response', v)
v = touch('0245-box-1852')
ok(v.status === 'fail' && /flow fail（盒子沒送到機台/.test(v.tag), '⚠️ 0245（盒子連 usb 都沒送）→ FAIL flow fail「盒子沒送到機台」', v)
v = touch('0237-box-1922')
ok(v.status === 'pass', '同一台 0237 現場修好後 → PASS', v)
// iDeck 三層：0237 指令都有送到機台、一筆回應都沒有；正常台有回應
const i0237 = ideck('0237-box-1855')
ok(i0237.received > 0 && i0237.answered === 0, '0237 iDeck：盒子收到、機台回應 0', i0237)
const i0231 = ideck('0231-box-1830')
ok(!i0231.noResponse && i0231.answered > 0, '0231 iDeck：有回應 → 不會判零回應', i0231)

// ── 合成情境 ──
let clock = 0
const at = (s: number) => { const t = 18 * 3600 + 30 * 60 + s; return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}` }
const S = (s: number, cmd: string): BoxLogEntry => ({ time: at(s), type: 'success_json', data: { cmd, error: 0, is_ideck: true, is_touch: true } })
const U = (s: number, coord = '?'): BoxLogEntry => ({ time: at(s), type: 'usb_coordinate', data: { coord } })
const H = (s: number): BoxLogEntry => ({ time: at(s), type: 'hw_response', data: { raw: 'x' } })
const END = (s: number): BoxLogEntry => ({ time: at(s), type: 'recv_msg', data: {} })   // 讓 log 涵蓋到這個時間
void clock
const C = (t: BoxLogEntry[], labels: string[]) => boxChains(t, labels)

// 跨 success 晚回（0231 實際的順序）
let c = C([S(0, '6,4'), U(1, '6,4'), S(1, '8,4'), H(1), U(1, '8,4'), H(2), END(30)], ['6,4', '8,4'])
ok(c['6,4'].state === 'ok' && c['8,4'].state === 'ok', 'hw 晚到下一筆 success 之後 → 兩格都 ok（不能用「下一筆之前」的窗口）', c)
// 中間漏一筆（不重疊、離 A 逾時夠遠）：A 沒回、B 有回 → A 機台不回應、B ok
c = C([S(0, 'A'), U(0), S(25, 'B'), U(25), H(26), END(50)], ['A', 'B'])
ok(c.A.state === 'noHw' && c.B.state === 'ok', '不重疊時 A 沒回、B 有回（B 在 A 逾時 15 秒後）→ A noHw、B ok', c)
// 同樣漏一筆，但 B 在 A 逾時後 5 秒就開始 → B 收到的 hw 可能是 A 晚到的 → B 未驗
c = C([S(0, 'A'), U(0), S(15, 'B'), U(15), H(16), END(40)], ['A', 'B'])
ok(c.A.state === 'noHw' && c.B.state === 'unknown', 'B 在 A 逾時 5 秒後開始 → A noHw、B 未驗（不把可能是 A 晚到的 hw 算給 B）', c)
// 重疊時漏一筆：A、B 同時在等、只回一筆 → 兩格都未驗（FIFO 會把 B 的 hw 配給 A）
c = C([S(0, 'A'), U(0), S(1, 'B'), U(1), H(3), END(40)], ['A', 'B'])
ok(c.A.state === 'unknown' && c.B.state === 'unknown', '⚠️ 同時兩筆在等、只回一筆 → 兩格都未驗，不硬配', c)
ok(touchChainVerdict(c).status === 'skip', '只有未驗 → 步驟判 SKIP（未驗），不是 PASS', touchChainVerdict(c))
// 逾時晚回：A 的 hw 在 12 秒才到 → 不補給 A；B 在 A 逾時後 1 秒開組、收到 hw → 可能是 A 晚到的 → B 未驗
c = C([S(0, 'A'), U(0), S(11, 'B'), U(11), H(12), END(40)], ['A', 'B'])
ok(c.A.state === 'noHw', '逾時晚到的 hw 不補給原本那筆（A noHw）', c.A)
ok(c.B.state === 'unknown', '⚠️ 前一筆剛逾時、新組收到 hw → 可能是舊那筆晚到的，B 未驗', c.B)
// 晚回且沒有下一筆：hw 單獨在窗口外 → 不補給任何一筆
c = C([S(0, 'A'), U(0), H(15), END(40)], ['A'])
ok(c.A.state === 'noHw', '窗口外才到的 hw → A 仍是 noHw', c.A)
// 最後一筆要等滿 10 秒
c = C([S(0, 'A'), U(0), END(5)], ['A'])
ok(c.A.state === 'unknown', '最後一筆：log 只涵蓋 5 秒 → 未驗（不能說機台不回應）', c.A)
c = C([S(0, 'A'), U(0), END(11)], ['A'])
ok(c.A.state === 'noHw', '最後一筆：log 涵蓋滿 10 秒還沒回 → noHw', c.A)
// 盒子沒送 usb：窗口內沒有 usb、後面還有 log → noUsb；log 不夠長 → 未驗
c = C([S(0, 'A'), END(20)], ['A'])
ok(c.A.state === 'noUsb', '沒有 usb、log 涵蓋完 → noUsb', c.A)
c = C([S(0, 'A'), END(3)], ['A'])
ok(c.A.state === 'unknown', '沒有 usb、log 只到 3 秒 → 未驗', c.A)
// 重複的 success 不能補別格的缺
c = C([S(0, 'A'), U(0), H(1), S(5, 'A'), U(5), H(6), END(30)], ['A', 'B'])
v = touchChainVerdict(c)
ok(c.B.state === 'noBox' && v.ok === 1 && v.status === 'warn', '⚠️ A 重複兩次三層齊、B 沒有 → 只算 1/2（原本 matched.length＝2 會補成 2/2）', { c, v })
// 同一格一次確定沒回、一次未驗 → 取確定的失敗
c = C([S(0, 'A'), U(0), S(20, 'A'), U(20), END(25)], ['A'])
ok(c.A.state === 'noHw', '同一格一次確定沒回、一次 log 沒涵蓋完 → noHw（確定的失敗優先）', c.A)
// 非測試操作的 usb 也算進組（不能借到別筆的 hw）
c = C([U(0, 'other'), S(1, 'A'), U(1), H(2), END(30)], ['A'])
ok(c.A.state === 'unknown', '測試前一秒有別的 usb 在等、只回一筆 → A 未驗（不能把別筆的 hw 當成自己的）', c.A)

// ── iDeck 判定 ──
const O = (name: string, result: IdeckOutcome['result'] = 'ack'): IdeckOutcome => ({ label: name, text: '', name, result, note: '' })
const base = { outcomes: [O('Bet0'), O('Bet1')], restore: null, aborted: false, apiErr: null, boxCount: 5 }
const allNone = ideckBoxChain([{ state: 'noHw' }, { state: 'noHw' }])
let r = ideckVerdict({ ...base, boxChain: allNone })
ok(r.status === 'warn' && /server 已回應；盒子已送出 2 筆，觀察窗口內未見機台回應/.test(r.message), '⚠️ iDeck：server 都回應、盒子確定送了 2 筆、0 回應 → WARN（文案照 CodeX）', r)
r = ideckVerdict({ ...base, outcomes: [O('Bet0'), O('Bet1', 'noAck')], boxChain: allNone })
ok(r.status === 'fail', '既有 FAIL（noAck）不被三層 WARN 蓋掉', r.status)
r = ideckVerdict({ ...base, ambiguous: '晚到的 begin 歸屬不明', boxChain: allNone })
ok(r.status === 'skip', '既有 SKIP（歸屬不明）不被三層 WARN 蓋掉', r.status)
r = ideckVerdict({ ...base, boxChain: ideckBoxChain([{ state: 'noHw' }, { state: 'unknown' }]) })
ok(r.status === 'pass' && /未確認 1/.test(r.message), '有一筆未確認 → 不升 WARN，只寫未確認', r)
r = ideckVerdict({ ...base, boxChain: ideckBoxChain([{ state: 'noHw' }, { state: 'noUsb' }]) })
ok(r.status === 'pass' && /沒送到機台 1/.test(r.message), 'usb 沒送（不是每一筆都確定「有送沒回」）→ 不升 WARN', r)
r = ideckVerdict({ ...base, boxChain: ideckBoxChain([{ state: 'ok' }, { state: 'noHw' }]) })
ok(r.status === 'pass', '有回應的 → 不升 WARN', r.status)
r = ideckVerdict({ ...base, boxCount: 0, boxChain: ideckBoxChain([]) })
ok(r.status === 'pass' && /盒子 log 0 筆，未確認機台端/.test(r.message), '盒子 log 0 筆 → 只記未確認（原本 WARN，CodeX 要一起改）', r)
ok(ideckBoxChain([{ state: 'noHw' }]).noResponse && !ideckBoxChain([]).noResponse, 'received 0 不算零回應', ideckBoxChain([]))

console.log(`\n${n - fail}/${n} 通過`)
process.exit(fail ? 1 : 0)
