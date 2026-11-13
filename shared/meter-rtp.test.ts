/**
 * shared/meter-rtp 的單元測試。跑法：npx tsx shared/meter-rtp.test.ts
 * 守：真實值不得被進位（後台是捨去）、浮點誤差不得被多砍一位、夠大的 coinIn 也不能靠門檻猜。
 */
import { rtpTrunc2, winLossJackpotTerm } from './meter-rtp.js'

let pass = 0
const fails: string[] = []
function eq(name: string, got: number | null, want: number | null) {
  if (got === want) { pass++; console.log('✅ ' + name) }
  else { fails.push(name); console.log('❌ ' + name + ' | got: ' + got + ' | want: ' + want) }
}

// 同事實例：coinIn 1,871,480、WIN/LOSE 104,578 → 5.588% → 5.58
eq('同事實例 → 5.58', rtpTrunc2(1871480, 1871480 - 104578, 0), 5.58)
// 真實值 5.5899996%（coinIn 1e7、winLoss 558999.96）不得進位
eq('邊界 5.5899996 → 5.58', rtpTrunc2(10000000, 9441000.04, 0), 5.58)
// 夠大的 coinIn：5.58999999999%，任何「離整數 <1e-9 就取整」的門檻都會進位成 5.59
eq('大 coinIn 1e13、5.58999999999% → 5.58', rtpTrunc2(10000000000000, 10000000000000 - 558999999999, 0), 5.58)
// 浮點誤差：29 / 100 × 100 在浮點是 28.999…，不能砍成 28.99
eq('0.29 比例 → 29', rtpTrunc2(1, 0.71, 0), 29)
eq('小數 meter 100.3/94.7 → 5.58', rtpTrunc2(100.3, 94.7, 0), 5.58)
eq('jackpotWins 也扣：1000/900/50 → 5', rtpTrunc2(1000, 900, 50), 5)
eq('負值往零捨去 -5.588 → -5.58', rtpTrunc2(1000, 1055.88, 0), -5.58)
eq('負但不到 0.01 → 0', rtpTrunc2(1000, 1000.05, 0), 0)
eq('coinIn 0 → 0', rtpTrunc2(0, 5, 0), 0)
eq('剛好整數 → 不扣', rtpTrunc2(3, 2, 0), 33.33)
eq('指數表示法 → null（呼叫端退回）', rtpTrunc2(1e21, 1, 0), null)

// CP／NC 的 WIN/LOSE（Eric 11-13）：CP 扣 Jackpot Wins，NC 的 Coin Out 已含 Jackpot Wins 不再扣
eq('CP 扣 Jackpot Wins', winLossJackpotTerm('osm', 36432), 36432)
eq('NC 不扣 Jackpot Wins', winLossJackpotTerm('gcp', 36432), 0)
eq('CP 實例 moneygong-149 → -46.40', rtpTrunc2(30800, 8660, winLossJackpotTerm('osm', 36432)), -46.4)
eq('NC 1000/900/50 → 10（不扣 50）', rtpTrunc2(1000, 900, winLossJackpotTerm('gcp', 50)), 10)

console.log(`\n${pass} pass, ${fails.length} fail`)
if (fails.length) process.exit(1)
