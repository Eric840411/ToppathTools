/**
 * 即時對照 recon_spin 窗口的 SQL 回歸（記憶體 DB）。跑法：npx tsx server/live-compare-spins.test.ts
 * 涵蓋 CodeX 42f906e 要求的三個位置：剛好在 t0、剛好在上界、上界之後。
 */
import Database from 'better-sqlite3'
import { countSpins } from './live-compare-spins.js'

let pass = 0
const fails: string[] = []
const eq = (n: string, got: unknown, want: unknown) => { if (JSON.stringify(got) === JSON.stringify(want)) pass++; else fails.push(`${n}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }

const db = new Database(':memory:')
db.exec(`CREATE TABLE recon_spin (env TEXT, sessionId TEXT, gmid TEXT, observedAt INTEGER, betAmount REAL, betSource TEXT, outcome TEXT)`)
const ins = db.prepare(`INSERT INTO recon_spin VALUES ('qat','s1','g1',?,?,?,?)`)
const T0 = 1000, UP = 2000
ins.run(500, 1, 'moneylog_adjacent', '')    // 起點前
ins.run(T0, 1, 'moneylog_adjacent', '')     // 剛好在 t0：已含在起點累計
ins.run(1500, 1, 'moneylog_adjacent', '')   // 窗口內
ins.run(UP, 1, 'moneylog_adjacent', '')     // 剛好在上界：Meter 已反映
ins.run(2500, 1, 'moneylog_adjacent', '')   // 上界之後：Meter 還沒反映
ins.run(1600, 0, '', 'not_started')          // 不算一局

const meter = countSpins(db, 'qat', 's1', 'g1', T0, UP, true)
eq('Meter 窗口 (t0, upTime]：不含 t0、含上界、不含上界後', meter.count, 2)
eq('Meter 窗口金額', meter.amount, 2)
const whole = countSpins(db, 'qat', 's1', 'g1', 500, Number.MAX_SAFE_INTEGER, false)
eq('整段含起點那一局', whole.count, 5)
eq('not_started 不算', countSpins(db, 'qat', 's1', 'g1', 1599, 1601, false).count, 0)
ins.run(1700, 0, '', '')                      // 注額未知的一局
eq('有一局注額未知→總額 null', countSpins(db, 'qat', 's1', 'g1', T0, UP, true).amount, null)
eq('沒有局→金額 0 不是 null', countSpins(db, 'qat', 's1', 'g1', 3000, 4000, true).amount, 0)

if (fails.length) { console.error(`FAIL ${fails.length}/${pass + fails.length}\n` + fails.join('\n')); process.exit(1) }
console.log(`PASS ${pass}`)
