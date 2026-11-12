/**
 * shared/meter-rtp 的單元測試。跑法：npx tsx shared/meter-rtp.test.ts
 * 守兩件事：真實值不得被進位（後台是捨去）、浮點誤差不得被多砍一位。
 */
import { truncRtp2 } from './meter-rtp.js'

let pass = 0
const fails: string[] = []
function eq(name: string, got: number, want: number) {
  if (got === want) { pass++; console.log('✅ ' + name) }
  else { fails.push(name); console.log('❌ ' + name + ' | got: ' + got + ' | want: ' + want) }
}

eq('同事實例 104578/1871480 → 5.58', truncRtp2((104578 / 1871480) * 100), 5.58)
eq('邊界 5.5899996 不得進位成 5.59', truncRtp2(5.5899996), 5.58)
eq('邊界 5.58999999 不得進位成 5.59', truncRtp2(5.58999999), 5.58)
eq('浮點 0.29 不得砍成 0.28', truncRtp2(0.29), 0.29)
eq('浮點 29/100*100 → 29', truncRtp2((29 / 100) * 100), 29)
eq('浮點 1.1 → 1.1', truncRtp2(1.1), 1.1)
eq('整數比值 7/3*100 → 233.33', truncRtp2((7 / 3) * 100), 233.33)
eq('負值往零捨去 -5.588 → -5.58', truncRtp2(-5.588), -5.58)
eq('零 → 0', truncRtp2(0), 0)
// 大 coinIn：差一點點到 5.59 的真實比值（coinIn 1e8）仍要捨成 5.58
eq('大 coinIn 5589999/100000000*100 → 5.58', truncRtp2((5589999 / 100000000) * 100), 5.58)

console.log(`\n${pass} pass, ${fails.length} fail`)
if (fails.length) process.exit(1)
