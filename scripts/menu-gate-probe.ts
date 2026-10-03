// runMenuGate 探針（2026-09-30）：npx tsx scripts/menu-gate-probe.ts
// 用假時鐘模擬「選單什麼時候關」，檢查：結果狀態、點了幾次觸屏、有沒有在不該按的時候放行 SPIN。
import { runMenuGate } from '../server/machine-test/verdicts.js'

// closeAt：第幾毫秒選單會關（Infinity＝永遠不關）；closeOnTap：點第幾個點位後就關（0-based）；first：一開始是否開著（null＝判斷不了）
// blindAt：第幾毫秒起畫面判斷不了（推流停格／沒在播 → isOpen 回 null）
async function sim(o: { first: boolean | null; closeAt?: number; closeOnTap?: number; nTaps?: number; stopAt?: number; blindAt?: number }) {
  let t = 0, open = o.first === true, taps = 0, front = 0
  const r = await runMenuGate({
    isOpen: async () => (o.first === null || (o.blindAt !== undefined && t >= o.blindAt) ? null : (open && !(o.closeAt !== undefined && t >= o.closeAt) ? true : (open = false))),
    selectFrontDenom: async () => { front++ },
    taps: Array.from({ length: o.nTaps ?? 2 }, (_, i) => ({ label: i === 0 ? '18,9' : `p${i}`, tap: async () => { taps++; if (o.closeOnTap === i) open = false } })),
    wait: async ms => { t += ms },
    stop: () => o.stopAt !== undefined && t >= o.stopAt,
    loadingMs: 10_000, afterTapMs: 8_000, pollMs: 2_000,
  })
  return `${r.state}/taps=${taps}/front=${front}`
}

const cases: Array<[string, () => Promise<string>, string]> = [
  ['選單本來就關著 → 直接放行、不選面額不點', () => sim({ first: false }), 'closed/taps=0/front=0'],
  ['判斷不了（沒參考圖／推流沒播）→ unknown、不動作', () => sim({ first: null }), 'unknown/taps=0/front=0'],
  ['開著、選面額後 4 秒關（使用者說 5 秒內）→ closed、不點觸屏', () => sim({ first: true, closeAt: 4_000 }), 'closed/taps=0/front=1'],
  ['開著、選面額後 10 秒內都沒關、點 18,9 就關 → closed、只點 1 次', () => sim({ first: true, closeOnTap: 0 }), 'closed/taps=1/front=1'],
  ['18,9 沒反應、第二個點位才關 → closed、點 2 次', () => sim({ first: true, closeOnTap: 1 }), 'closed/taps=2/front=1'],
  ['全部都沒反應 → touchNoResponse（不能放行 SPIN）', () => sim({ first: true }), 'touchNoResponse/taps=2/front=1'],
  // 0930 JJBXGRAND：沒設關選單的觸屏點＝沒點過，不能說觸屏沒反應 → 選單狀態未知
  ['沒有可點的點位、選單關不掉 → unknown（不判觸屏 no response）', () => sim({ first: true, nTaps: 0 }), 'unknown/taps=0/front=1'],
  ['沒有可點的點位、但選面額後自己關了 → closed', () => sim({ first: true, nTaps: 0, closeAt: 4_000 }), 'closed/taps=0/front=1'],
  ['收到停止 → 不再點觸屏', () => sim({ first: true, stopAt: 0 }), 'touchNoResponse/taps=0/front=1'],
  // CodeX 0930：操作後畫面判斷不了 → unknown，不能判 touchscreen no response
  ['選面額後推流停格 → unknown、不點觸屏', () => sim({ first: true, blindAt: 2_000 }), 'unknown/taps=0/front=1'],
  ['點 18,9 後推流停格 → unknown（只點了 1 次）', () => sim({ first: true, blindAt: 12_000 }), 'unknown/taps=1/front=1'],
]

let fail = 0
for (const [name, fn, want] of cases) {
  const got = await fn()
  const ok = got === want
  if (!ok) fail++
  console.log(`${ok ? '✅' : '❌'} ${name}：${got}${ok ? '' : `（預期 ${want}）`}`)
}
console.log(fail ? `❌ ${fail}/${cases.length} 失敗` : `✅ ${cases.length}/${cases.length} 通過`)
process.exit(fail ? 1 : 0)
