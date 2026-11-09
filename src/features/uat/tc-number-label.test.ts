/** 跑法：npx tsx src/features/uat/tc-number-label.test.ts */
import { tcNumbersLabel } from './tc-number-label'

const fails: string[] = []
let pass = 0
const eq = (n: string, got: unknown, want: unknown) => { if (got === want) pass++; else fails.push(`${n}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
const n = (...xs: string[]) => xs.map(number => ({ number }))

eq('同前綴只寫第一個', tcNumbersLabel(n('T-049', 'T-050', 'T-061', 'T-062')), '綁 T-049/050/061/062')
eq('只有一筆', tcNumbersLabel(n('T-049')), '綁 T-049')
eq('不同前綴寫全', tcNumbersLabel(n('T-049', 'C-003')), '綁 T-049/C-003')
eq('有一筆沒編號 → 照筆數', tcNumbersLabel(n('T-049', '')), '綁 2 TC')
eq('沒綁', tcNumbersLabel([]), '綁 0 TC')
eq('編號前後空白', tcNumbersLabel(n(' T-049 ', 'T-050')), '綁 T-049/050')

console.log(`tc-number-label: ${pass} pass, ${fails.length} fail`)
if (fails.length) { for (const f of fails) console.log('  ✗ ' + f); throw new Error(`tc-number-label: ${fails.length} fail`) }
