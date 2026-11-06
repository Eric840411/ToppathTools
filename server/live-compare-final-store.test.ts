/**
 * 停止後結算＋總表通知的整合回歸（記憶體 DB、假比對、假發送、控制時間）。跑法：npx tsx server/live-compare-final-store.test.ts
 * 驗 CodeX aa55b01 點名的情境：短 session 沒開頁面也要結算、零筆不能停止當下凍結、終點不用 agent 時鐘、
 * 發送失敗退避重送、發過不重發、沒有機台不發、很久以前停的不補登記。
 */
import Database from 'better-sqlite3'
import { createFinalizer, ensureRunTable, type FinalDeps, type LiveSessionInfo } from './live-compare-final-store.js'
import type { LiveCompareRow } from './live-compare.js'

let pass = 0
const fails: string[] = []
const eq = (n: string, got: unknown, want: unknown) => { if (JSON.stringify(got) === JSON.stringify(want)) pass++; else fails.push(`${n}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }

const MIN = 60_000
const T0 = 1_793_900_000_000
const G = '892-DRAGONLAW-0025'

function setup() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE recon_spin (id INTEGER PRIMARY KEY AUTOINCREMENT, env TEXT, sessionId TEXT, observedAt INTEGER);
    CREATE TABLE live_compare_snap (sessionId TEXT, gmid TEXT, upTime INTEGER, gamesPlayed REAL, coinIn REAL, denom REAL, readAt INTEGER);
  `)
  ensureRunTable(db)
  db.prepare("INSERT INTO settings VALUES ('autospin_final_report_chat_id', 'oc_test')").run()
  let clock = T0
  /** 假比對：每次呼叫記一筆 Meter 快照（upTime 比讀取時間早 5 秒，模擬 Meter 自己的時鐘），窗口狀態由測試控制 */
  const state = {
    win: null as LiveCompareRow['win'], noRows: false,
    /** 本帳號 Game Record（後台時鐘的最後一局）；預設：3 局、最後一局在 T0 */
    gr: { count: 3, amount: 3, readAt: T0, lastBetAt: T0 } as LiveCompareRow['gr'],
    /** 本帳號 handpay（只有 withEvidence 時才併進 gr，模擬 liveCompare） */
    handpay: { count: 0, lastBetAt: null as number | null, error: '' },
    /** Meter 快照的 upTime 比讀取時間早多少（模擬 Meter 停更就調大） */
    snapLag: 5000,
    /** 比對途中又進來幾局（模擬網路等待期間的晚到資料） */
    spinDuringCompare: 0,
  }
  const sends: Array<{ chatId: string; uuid?: string }> = []
  let sendFail = 0
  const deps: FinalDeps = {
    now: () => clock,
    compare: async (_env, sessions, opts) => {
      if (state.noRows) return { rows: [] }
      for (const s of sessions) db.prepare('INSERT INTO live_compare_snap VALUES (?, ?, ?, 0, 0, 1, ?)').run(s.id, G, clock - state.snapLag, clock)
      for (const s of sessions) for (let i = 0; i < state.spinDuringCompare; i++) db.prepare("INSERT INTO recon_spin (env, sessionId, observedAt) VALUES ('qat', ?, ?)").run(s.id, clock)
      state.spinDuringCompare = 0
      const hp = state.handpay
      const gr = state.gr && opts?.withEvidence
        ? (hp.error ? { ...state.gr, lastBetAt: null, evidenceError: hp.error } : { ...state.gr, handpayCount: hp.count, lastBetAt: Math.max(state.gr.lastBetAt ?? 0, hp.lastBetAt ?? 0) || null })
        : state.gr
      return { rows: sessions.map(s => ({ sessionId: s.id, gmid: G, clientMachineName: 'Fortune Pots - NCH 25', t0: T0 - 60 * MIN, status: 'pending', reason: '', as: { count: 3 }, gr, win: state.win } as unknown as LiveCompareRow)) }
    },
    send: async (chatId, _card, opts) => {
      if (sendFail > 0) { sendFail--; return { ok: false, code: 'NET', message: 'timeout' } }
      sends.push({ chatId, uuid: opts.uuid }); return { ok: true, value: `om_${sends.length}` }
    },
  }
  const f = createFinalizer(db, deps)
  const run = (id: string) => db.prepare('SELECT state, notifyState, notifyAttempts, spinCount, chatId FROM live_compare_run WHERE sessionId=?').get(id) as { state: string; notifyState: string; notifyAttempts: number; spinCount: number; chatId: string } | undefined
  const spins = (id: string, n: number, observedAt: number) => { for (let i = 0; i < n; i++) db.prepare("INSERT INTO recon_spin (env, sessionId, observedAt) VALUES ('qat', ?, ?)").run(id, observedAt) }
  return { db, f, state, sends, run, spins, setClock: (t: number) => { clock = t }, failSends: (n: number) => { sendFail = n } }
}
const win = (o: Record<string, unknown>) => ({ tStart: T0 - 60 * MIN, t1: null, status: 'pending', fails: 0, meter: { count: 3, amount: 3 }, backend: null, boundary: false, t0Absorbed: 0, conflicts: 0, latestUp: null, diff: null, okCount: 0, okAmount: 0, checkedAt: null, ...o }) as LiveCompareRow['win']

// ── 短 session：沒開頁面、在第一次掃描前就停了 ──
{
  const h = setup()
  const S: LiveSessionInfo = { id: 'short', startedAt: T0 - 2 * MIN, userLabel: 'Siara', running: false, lastHeartbeat: T0 - 10_000 }
  // agent 時鐘慢 164 秒：observedAt 比實際早——終點不能用它
  h.spins('short', 3, T0 - 164_000)
  await h.f.tick(() => [S])
  eq('短 session 會被登記並進結算', h.run('short')?.state, 'settling')
  eq('剛看到 spin 增加 → 還在等尾筆', h.run('short')?.spinCount, 3)

  // 窗口一致，但 t1 是收妥之前的快照（agent 時鐘＋30 秒會誤以為涵蓋了）
  h.state.win = win({ status: 'match', t1: T0 - 120_000 + 30_000 })
  h.setClock(T0 + MIN); await h.f.tick(() => [S])
  eq('窗口沒到「收妥後讀到的快照」→ 不能凍結', h.run('short')?.state, 'settling')

  // 窗口推進到收妥後那筆快照，但本帳號 Game Record 還沒到齊（收妥後未滿 4 分鐘）→ 不能定案
  h.state.win = win({ status: 'match', t1: T0 + MIN - 5000 })
  h.setClock(T0 + 2 * MIN); await h.f.tick(() => [S])
  eq('Game Record 還沒到齊 → 不能定案', h.run('short')?.state, 'settling')
  h.state.gr = { count: 4, amount: 4, readAt: T0, lastBetAt: T0 }
  h.setClock(T0 + 5 * MIN); await h.f.tick(() => [S])
  eq('本帳號局數還在變 → 不能定案', h.run('short')?.state, 'settling')
  h.setClock(T0 + 6 * MIN); await h.f.tick(() => [S])
  eq('涵蓋到終點而且一致、Game Record 局數穩定 → final', h.run('short')?.state, 'final')
  eq('凍結時記下群組、發出總表', [h.run('short')?.chatId, h.run('short')?.notifyState, h.sends.length], ['oc_test', 'sent', 1])
  eq('帶 uuid 去重', h.sends[0]?.uuid, 'lcfinal-short')
  h.setClock(T0 + 7 * MIN); await h.f.tick(() => [S])
  eq('發過不重發', h.sends.length, 1)
  eq('停止後頁面拿得到最近一輪', h.f.latestRunFor('qat', 'Siara', 24 * 3600_000, T0 + 7 * MIN)?.state, 'final')
}

// ── 零筆：停止當下第一筆還沒到，不能直接凍結 ──
{
  const h = setup()
  const S: LiveSessionInfo = { id: 'zero', startedAt: T0 - MIN, userLabel: 'Siara', running: false, lastHeartbeat: T0 }
  h.state.noRows = true
  await h.f.tick(() => [S])
  h.setClock(T0 + MIN); await h.f.tick(() => [S])
  eq('零筆、停止 1 分鐘 → 還在等', h.run('zero')?.state, 'settling')
  h.spins('zero', 2, T0)
  h.state.noRows = false
  h.state.win = win({ status: 'pending' })
  h.setClock(T0 + 2 * MIN); await h.f.tick(() => [S])
  eq('晚到的 spin 有被算進來', [h.run('zero')?.state, h.run('zero')?.spinCount], ['settling', 2])
}

// ── 停止時沒有任何機台可比 → 定案但不發 ──
{
  const h = setup()
  const S: LiveSessionInfo = { id: 'none', startedAt: T0 - MIN, userLabel: 'Siara', running: false, lastHeartbeat: T0 }
  h.state.noRows = true
  await h.f.tick(() => [S])
  h.setClock(T0 + 4 * MIN); await h.f.tick(() => [S])
  eq('零筆等滿 → final、不發總表', [h.run('none')?.state, h.run('none')?.notifyState, h.sends.length], ['final', 'skipped', 0])
}

// ── 很久以前停的不補登記（上線當下不能替一堆舊 session 發總表）──
{
  const h = setup()
  await h.f.tick(() => [{ id: 'old', startedAt: T0 - 5 * 60 * MIN, userLabel: 'Siara', running: false, lastHeartbeat: T0 - 2 * 60 * MIN }])
  eq('2 小時前停的 → 不登記', h.run('old'), undefined)
}

// ── 正在跑 → 停止 → 結算；發送失敗退避重送 ──
{
  const h = setup()
  const S: LiveSessionInfo = { id: 'r', startedAt: T0 - 10 * MIN, userLabel: 'Siara', running: true }
  h.spins('r', 5, T0)
  h.state.win = win({ status: 'pending' })
  await h.f.tick(() => [S])
  eq('正在跑 → running，背景也比一次', h.run('r')?.state, 'running')
  S.running = false
  h.setClock(T0 + MIN); await h.f.tick(() => [S])
  eq('停止 → settling', h.run('r')?.state, 'settling')
  h.state.win = win({ status: 'match', t1: T0 + 10 * MIN })
  h.failSends(1)
  h.setClock(T0 + 6 * MIN); await h.f.tick(() => [S])
  h.setClock(T0 + 7 * MIN); await h.f.tick(() => [S])
  eq('發送失敗 → 留 pending、記次數', [h.run('r')?.state, h.run('r')?.notifyState, h.run('r')?.notifyAttempts], ['final', 'pending', 1])
  h.setClock(T0 + 7 * MIN + 30_000); await h.f.tick(() => [S])
  eq('退避時間還沒到 → 不重送', h.sends.length, 0)
  h.setClock(T0 + 10 * MIN); await h.f.tick(() => [S])
  eq('時間到 → 重送成功', [h.run('r')?.notifyState, h.sends.length], ['sent', 1])
}

// ── 逾時：15 分鐘還沒對到終點 → timeout、照發（標未收斂）──
{
  const h = setup()
  const S: LiveSessionInfo = { id: 'to', startedAt: T0 - 10 * MIN, userLabel: 'Siara', running: false, lastHeartbeat: T0 }
  h.spins('to', 5, T0)
  h.state.win = win({ status: 'pending' })
  await h.f.tick(() => [S])
  h.setClock(T0 + 16 * MIN); await h.f.tick(() => [S])
  eq('逾時 → timeout 並發出', [h.run('to')?.state, h.run('to')?.notifyState], ['timeout', 'sent'])
}

// ── CodeX 7a44528 P1：Meter 停更——停止後才讀到、但 upTime 是停止前的舊資料，不能定案 ──
{
  const h = setup()
  const S: LiveSessionInfo = { id: 'stale', startedAt: T0 - 10 * MIN, userLabel: 'Siara', running: false, lastHeartbeat: T0 }
  h.spins('stale', 3, T0)
  h.state.snapLag = 120_000 + 2 * 60_000   // 讀到的 upTime 一直停在停止前 120 秒左右
  h.state.win = win({ status: 'match', t1: T0 - 120_000 })
  for (let m = 0; m <= 8; m++) { h.setClock(T0 + m * MIN); h.state.snapLag = (m * MIN) + 120_000; await h.f.tick(() => [S]) }
  eq('Meter 停更、追不過本帳號最後一局 → 還不能定案', h.run('stale')?.state, 'settling')
  h.setClock(T0 + 16 * MIN); h.state.snapLag = 16 * MIN + 120_000; await h.f.tick(() => [S])
  eq('逾時 → 未收斂（不能當一致）', h.run('stale')?.state, 'timeout')
}

// ── CodeX 7a44528 P1：比對途中又進來新局 → 這輪不定案、重算靜默期 ──
{
  const h = setup()
  const S: LiveSessionInfo = { id: 'race', startedAt: T0 - 10 * MIN, userLabel: 'Siara', running: false, lastHeartbeat: T0 }
  h.spins('race', 1, T0)
  h.state.win = win({ status: 'match', t1: T0 + 10 * MIN })
  await h.f.tick(() => [S])
  h.setClock(T0 + 4 * MIN); await h.f.tick(() => [S])
  h.state.spinDuringCompare = 1
  h.setClock(T0 + 5 * MIN); await h.f.tick(() => [S])
  eq('比對途中進來新局 → 不凍結、筆數更新', [h.run('race')?.state, h.run('race')?.spinCount], ['settling', 2])
  eq('沒有發出總表', h.sends.length, 0)
}

// ── CodeX 862a4fa P1：最後一局是 handpay（不進 Game Record）——Meter 停在它之前就不能定案 ──
{
  const h = setup()
  const S: LiveSessionInfo = { id: 'hp', startedAt: T0 - 10 * MIN, userLabel: 'Siara', running: false, lastHeartbeat: T0 }
  h.spins('hp', 3, T0)
  h.state.gr = { count: 3, amount: 3, readAt: T0, lastBetAt: T0 - 200_000 }
  h.state.handpay = { count: 1, lastBetAt: T0 - 10_000, error: '' }
  h.state.snapLag = 0
  // 窗口 t1 停在停止前 120 秒（一般局之後、handpay 之前）
  h.state.win = win({ status: 'match', t1: T0 - 120_000 })
  for (let m = 0; m <= 8; m++) { h.setClock(T0 + m * MIN); h.state.snapLag = m * MIN + 120_000; await h.f.tick(() => [S]) }
  eq('最後一局是 handpay、Meter 沒涵蓋 → 不能定案', [h.run('hp')?.state, h.sends.length], ['settling', 0])
  h.state.win = win({ status: 'match', t1: T0 - 5_000 })
  h.state.snapLag = 0
  h.setClock(T0 + 9 * MIN); await h.f.tick(() => [S])
  h.setClock(T0 + 10 * MIN); await h.f.tick(() => [S])
  eq('窗口追過 handpay 那局 → final', h.run('hp')?.state, 'final')
}

// ── handpay 讀不到 → 沒有證據，最後未收斂 ──
{
  const h = setup()
  const S: LiveSessionInfo = { id: 'hperr', startedAt: T0 - 10 * MIN, userLabel: 'Siara', running: false, lastHeartbeat: T0 }
  h.spins('hperr', 3, T0)
  h.state.handpay = { count: 0, lastBetAt: null, error: 'Jackpot Abnormality 回 code=500' }
  h.state.win = win({ status: 'match', t1: T0 + 30 * MIN })
  for (let m = 0; m <= 16; m += 2) { h.setClock(T0 + m * MIN); await h.f.tick(() => [S]) }
  eq('handpay 讀不到 → 逾時未收斂', h.run('hperr')?.state, 'timeout')
}

// ── CodeX 862a4fa P2：過了 15 分鐘，比對途中一直進新局也要定案（未收斂），不能一直 settling ──
{
  const h = setup()
  const S: LiveSessionInfo = { id: 'late', startedAt: T0 - 10 * MIN, userLabel: 'Siara', running: false, lastHeartbeat: T0 }
  h.spins('late', 3, T0)
  h.state.win = win({ status: 'pending' })
  await h.f.tick(() => [S])
  for (const m of [16, 17, 18]) { h.state.spinDuringCompare = 1; h.setClock(T0 + m * MIN); await h.f.tick(() => [S]) }
  eq('超過上限還一直進新局 → timeout 並發出', [h.run('late')?.state, h.run('late')?.notifyState], ['timeout', 'sent'])
}

if (fails.length) { console.error(`FAIL ${fails.length}/${pass + fails.length}\n` + fails.join('\n')); process.exit(1) }
console.log(`PASS ${pass}`)
