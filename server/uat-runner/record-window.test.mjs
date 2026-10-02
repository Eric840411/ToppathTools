// 跑法：node server/uat-runner/record-window.test.mjs
import { recordingScale } from './record-window.js'

let pass = 0, fail = 0
const eq = (name, got, want) => { const ok = got === want; console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : ` | got ${got} want ${want}`}`); ok ? pass++ : fail++ }

// 使用者的情況：MacBook 可用高度約 875（扣掉選單列），視窗外框約 88
const mac = { availWidth: 1440, availHeight: 875, chromeWidth: 0, chromeHeight: 88 }
const s877 = recordingScale({ ...mac, width: 500, height: 877 })
eq('500x877 在 875 高的螢幕要縮小', s877 < 1, true)
eq('縮完整個視窗放得下（頁面高×比例＋外框 ≤ 可用高度）', Math.round(877 * s877) + 88 <= 875, true)
eq('390x844 也要縮', recordingScale({ ...mac, width: 390, height: 844 }) < 1, true)
eq('螢幕夠大（1080p）不縮', recordingScale({ availWidth: 1920, availHeight: 1040, chromeWidth: 16, chromeHeight: 96, width: 500, height: 877 }), 1)
eq('PC 1920x1080 在 1440x875 螢幕：寬也要考慮', recordingScale({ ...mac, width: 1920, height: 1080 }) <= (1440 - 12) / 1920, true)
eq('量不到螢幕（0）→ 不縮', recordingScale({ availWidth: 0, availHeight: 0, chromeWidth: 0, chromeHeight: 0, width: 500, height: 877 }), 1)
eq('極小螢幕最多縮到 0.5', recordingScale({ availWidth: 300, availHeight: 300, chromeWidth: 0, chromeHeight: 88, width: 500, height: 877 }), 0.5)

console.log(`\n${pass} 通過，${fail} 失敗`)
process.exit(fail ? 1 : 0)
