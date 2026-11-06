/**
 * AutoSpin 即時對照判定規則的回歸。跑法：npx tsx server/live-compare-core.test.ts
 */
import { parseMeterItem, baselineInvalidReason, evaluateSides, decideStatus, meterWindowEnd, dedupeByOrderId, meterStale, METER_STALE_MS, guardOwnRounds, siteLoginCandidates, ownHandpayFromRows, inOwnRange, nearCutNote, MISMATCH_ROUNDS, type EvalInput } from './live-compare-core.js'

let pass = 0
const fails: string[] = []
const eq = (n: string, got: unknown, want: unknown) => { if (JSON.stringify(got) === JSON.stringify(want)) pass++; else fails.push(`${n}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }

// 真實回應形狀（2026-11-04 QAT 實測，數字取自 873-JJBX-0004）
const cachedItem = { machineName: '873-JJBX-0004', meterData: { error: 0, data: { '05': 4008, '00': 903818600, Denom: 0.01 }, upTime: 1790128802, useCache: true, cacheHourStr: '2026-09-23 10:00:02' } }
const liveItem = { machineName: '873-RISINGROCKETS-0140', meterData: { error: 0, data: { '05': 1009616, '00': 270731971089, Denom: 0.01 }, upTime: 1793786166, isValidMeter: true } }

const c = parseMeterItem(cachedItem)!
eq('快取旗標', c.useCache, true)
eq('快取時間', c.cacheHourStr, '2026-09-23 10:00:02')
const l = parseMeterItem(liveItem)!
eq('即時沒有快取旗標', l.useCache, false)
eq('upTime 秒轉毫秒', l.upTime, 1793786166000)
eq('缺 Denom 不猜', parseMeterItem({ meterData: { data: { '05': 1, '00': 1 } } }), null)

const base = { t0: 0, gamesPlayed: 100, coinIn: 5000, denom: 0.01 }
eq('Denom 改變要重設', baselineInvalidReason(base, { ...l, gamesPlayed: 110, coinIn: 6000, denom: 0.05 }) !== null, true)
eq('累計回退要重設', baselineInvalidReason(base, { ...l, gamesPlayed: 90, coinIn: 6000, denom: 0.01 }) !== null, true)
eq('正常累加不重設', baselineInvalidReason(base, { ...l, gamesPlayed: 110, coinIn: 6000, denom: 0.01 }), null)

const s = (count: number | null, amount: number | null) => ({ count, amount })
const ok: EvalInput = { as: s(10, 100), asSinceT0: s(8, 80), gr: s(10, 100), meter: s(8, 80), meterCached: false }
const st = (x: EvalInput, streak: number) => decideStatus(x, evaluateSides(x), streak)

eq('三邊一致', st(ok, 0), 'match')
eq('Meter 跟起點後的 AutoSpin 比，不是跟整段比', evaluateSides(ok).meterMinusAs, s(0, 0))
eq('第一輪對不上＝等待入帳', st({ ...ok, gr: s(9, 90) }, 1), 'pending')
eq(`連續 ${MISMATCH_ROUNDS} 輪＝不一致`, st({ ...ok, gr: s(9, 90) }, MISMATCH_ROUNDS), 'mismatch')
eq('Meter 快取＋GR 一致＝快取不可比', st({ ...ok, meter: null, meterCached: true }, 0), 'cache')
eq('Meter 快取時 Meter 差值不算', evaluateSides({ ...ok, meter: s(0, 0), meterCached: true }).meterMinusAs, s(null, null))
// 快取不能把 Game Record 真的對不上蓋掉
eq('Meter 快取＋GR 對不上＝不一致', st({ ...ok, meterCached: true, meter: null, gr: s(7, 70) }, MISMATCH_ROUNDS), 'mismatch')
eq('GR 讀不到', st({ ...ok, gr: null }, 0), 'unreadable')
eq('Meter 讀不到', st({ ...ok, meter: null }, 0), 'unreadable')
// 注額未知（null）只比次數，不能當 0 去比金額
eq('AutoSpin 注額未知只比次數', st({ ...ok, as: s(10, null), asSinceT0: s(8, null) }, 0), 'match')
eq('金額對不上也算', st({ ...ok, gr: s(10, 120) }, MISMATCH_ROUNDS), 'mismatch')

// CodeX cd8a8b0 的三項
eq('05 為 null 不建起點', parseMeterItem({ meterData: { data: { '05': null, '00': 100, Denom: 0.01 } } }), null)
eq('00 為空字串不建起點', parseMeterItem({ meterData: { data: { '05': 1, '00': '', Denom: 0.01 } } }), null)
eq('字串數字照收', parseMeterItem({ meterData: { data: { '05': '3', '00': '10', Denom: '0.01' }, upTime: 1 } })?.gamesPlayed, 3)
eq('Meter 窗口終點＝upTime', meterWindowEnd({ upTime: 1000 }, 5000), 1000)
eq('upTime 缺就用讀取時間', meterWindowEnd({ upTime: 0 }, 5000), 5000)
eq('跨頁重複的局只算一次', dedupeByOrderId([{ orderId: 'a' }, { orderId: 'b' }, { orderId: 'a' }]).length, 2)


// ── Meter 停更不能假綠（CodeX 2ac32e6 P2）：upTime 停在起點、之後 AutoSpin 已跑 10 局、GR 對上 ──
const up = 1_000_000
eq('停更＋後面有局＋落後超過門檻 → 停更', meterStale(up, up + METER_STALE_MS + 1, 10), true)
eq('剛更新不算停更', meterStale(up, up + 30_000, 10), false)
eq('後面沒局不算停更（只是沒人玩）', meterStale(up, up + 3_600_000, 0), false)
eq('upTime 缺不判停更', meterStale(0, up, 10), false)
{
  const staleIn: EvalInput = { as: s(10, 100), asSinceT0: s(0, 0), gr: s(10, 100), meter: s(0, 0), meterCached: false }
  eq('舊寫法：停更時 0 對 0 會顯示一致（重現）', st(staleIn, 0), 'match')
  eq('停更當成不可比 → 不顯示一致', st({ ...staleIn, meter: null, meterCached: true }, 0), 'cache')
}
// ── v5.79.3：GCP 機台的 Game Record 沒有 spin_index，不能因此整批讀不到 ──
{
  // 欄位取自 QAT 892-DRAGONLAW-0025（GCP）真實回傳，去識別化
  const gcp = (o: string, t: number) => ({ order_id: o, uid: '892-DRAGONLAW-0025', username: 'fixture01', bgtype: 'gsa', spinid: 'x', bet: 200, bet_time_precise: t })
  const ok = guardOwnRounds([gcp('a', 1793932000.5), gcp('b', 1793932003.25)], 'fixture01')
  eq('GCP 列沒有 spin_index 也能讀', ok.ok, true)
  eq('下注時間換成毫秒', ok.ok ? ok.rows.map(r => r.betTimePrecise) : null, [1793932000500, 1793932003250])
  eq('別的帳號 → 整批不用', guardOwnRounds([gcp('a', 1), { ...gcp('b', 2), username: 'other' }], 'fixture01').ok, false)
  eq('缺下注時間 → 整批不用（不能丟掉那筆）', guardOwnRounds([gcp('a', 1), { ...gcp('b', 2), bet_time_precise: null }], 'fixture01').ok, false)
  eq('缺單號 → 整批不用', guardOwnRounds([gcp('a', 1), { ...gcp('', 2) }], 'fixture01').ok, false)
  eq('注額空字串 → 整批不用', guardOwnRounds([{ ...gcp('a', 1), bet: '' }], 'fixture01').ok, false)

  eq('注額空白字串 → 整批不用', guardOwnRounds([gcp('a', 1), { ...gcp('b', 2), bet: ' ' }], 'fixture01').ok, false)
  eq('下注時間空白 → 整批不用', guardOwnRounds([gcp('a', 1), { ...gcp('b', 2), bet_time_precise: '  ' }], 'fixture01').ok, false)
  eq('缺機台 uid → 整批不用', guardOwnRounds([gcp('a', 1), { ...gcp('b', 2), uid: '' }], 'fixture01').ok, false)
  eq('數字字串照常讀', guardOwnRounds([{ ...gcp('a', 1), bet: '200', bet_time_precise: '1793932000.5' }], 'fixture01').ok, true)
}
// ── 渠道後台登入：逐一試帳號，不能一組套全部渠道 ──
{
  const c = siteLoginCandidates({ site_username: 'S', site_password: 'sp', login_username: 'M', login_password: 'mp' }, { login_username: 'G', login_password: 'gp' })
  eq('依序：渠道帳號 → 主帳號 → GCP', c.map(x => x.username), ['S', 'M', 'G'])
  eq('沒填渠道帳號時主帳號仍在（CP 才登得進）', siteLoginCandidates({ login_username: 'M' }, { login_username: 'G' }).map(x => x.username), ['M', 'G'])
  eq('同帳號同密碼只試一次', siteLoginCandidates({ site_username: 'M', site_password: 'p', login_username: 'M', login_password: 'p' }, { login_username: 'M', login_password: 'p' }).length, 1)
  eq('同帳號不同密碼兩組都要試（渠道帳號密碼過期時主帳號那組仍可用）', siteLoginCandidates({ site_username: 'M', site_password: 'old', login_username: 'M', login_password: 'new' }, {}).map(x => x.password), ['old', 'new'])
  eq('全空 → 沒有可試的', siteLoginCandidates({}, {}).length, 0)
}
// ── 本帳號 handpay：先驗欄位再篩帳號（CodeX b7f907e P1）──
{
  const G = '892-MOREPUFF-0134', F = 1_793_900_000_000, U = F + 3600_000
  const hp = (o: Record<string, unknown> = {}) => ({ uid: G, username: 'fixture01', bet_time_precise: (F + 60_000) / 1000, ...o })
  eq('本帳號、範圍內 → 算進來', ownHandpayFromRows([hp(), hp({ username: 'other' })], G, 'fixture01', F, U), { count: 1, lastBetAt: F + 60_000 })
  eq('範圍外（停止後再玩）不算', ownHandpayFromRows([hp({ bet_time_precise: (U + 1000) / 1000 })], G, 'fixture01', F, U), { count: 0, lastBetAt: null })
  eq('缺帳號 → 錯誤（不能當成別人的略過）', 'error' in ownHandpayFromRows([hp({ username: '' })], G, 'fixture01', F, U), true)
  eq('帳號空白 → 錯誤', 'error' in ownHandpayFromRows([hp({ username: '  ' })], G, 'fixture01', F, U), true)
  eq('下注時間空字串 → 錯誤（Number(\'\') 是 0）', 'error' in ownHandpayFromRows([hp({ bet_time_precise: '' })], G, 'fixture01', F, U), true)
  eq('下注時間缺 → 錯誤', 'error' in ownHandpayFromRows([hp({ bet_time_precise: null })], G, 'fixture01', F, U), true)
  eq('不是這台 → 錯誤', 'error' in ownHandpayFromRows([hp({ uid: 'x' })], G, 'fixture01', F, U), true)
  eq('數字字串照讀', ownHandpayFromRows([hp({ bet_time_precise: String((F + 60_000) / 1000) })], G, 'fixture01', F, U), { count: 1, lastBetAt: F + 60_000 })
}
// ── 切在下一輪開始：恰在切點的局歸下一輪、切點前幾秒的局只供參考（CodeX 610474f P2）──
{
  const G = '892-MOREPUFF-0134', F = 1_793_900_000_000, NEXT = F + 30 * 60_000
  const hp = (ms: number) => ({ uid: G, username: 'fixture01', bet_time_precise: ms / 1000 })
  eq('handpay 恰在下一輪開始 → 不算上一輪', ownHandpayFromRows([hp(NEXT)], G, 'fixture01', F, NEXT, true), { count: 0, lastBetAt: null })
  eq('handpay 恰在「停止＋1 分鐘」上界 → 照算（不是下一輪切點）', ownHandpayFromRows([hp(NEXT)], G, 'fixture01', F, NEXT, false), { count: 1, lastBetAt: NEXT })
  // 模擬 liveCompare 的 Game Record 篩選
  const gr = [F + 1000, NEXT - 1, NEXT, NEXT + 500]
  eq('Game Record 恰在切點 → 歸下一輪', gr.filter(t => inOwnRange(t, F, NEXT, true)).length, 2)
  eq('後台慢 2 秒：下一輪開始後 1 秒下的注落在切點前 1 秒 → 只供參考', nearCutNote(NEXT - 1000, NEXT, true) !== '', true)
  eq('最後一局離切點很遠 → 不標', nearCutNote(NEXT - 5 * 60_000, NEXT, true), '')
  eq('上界不是下一輪切點 → 不標', nearCutNote(NEXT - 1000, NEXT, false), '')
}
if (fails.length) { console.error(`FAIL ${fails.length}/${pass + fails.length}\n` + fails.join('\n')); process.exit(1) }
console.log(`PASS ${pass}`)
