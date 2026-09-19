/**
 * scripts/ui-checks/jackpot-watch-compare.mjs
 *
 * 驗告警設定視窗裡「list.json 對照值」的狀態判定（`src/data/watchCompare.ts`）。
 *
 * ⚠️ **這裡要守的是「四種沒有數字的狀態不准被合併」。**
 *    `not_applicable`（這層本來就沒有）／`unmatched`（list.json 沒這台）／
 *    `missing`（有這台但沒設門檻）／`conflict`（多台辨識機不一致）——
 *    後續動作完全不同，合併成一句「未提供」的話，看到的人只會以為功能壞了，
 *    而且會去等一個永遠不會來的修復。**合併之後畫面照樣有東西顯示**，所以肉眼驗不出來。
 *
 * 跑法：npx tsx scripts/ui-checks/jackpot-watch-compare.mjs
 */
import path from 'path'
import { pathToFileURL, fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const { watchCompareState } = await import(pathToFileURL(path.join(root, 'src/data/watchCompare.ts')).href)

const row = (over = {}) => ({
  grand: { min: 1000000, max: 3000000 },
  major: { min: 100000, max: 10000000 },
  grandConflict: false, majorConflict: false, matched: true, servers: ['Image-Recon-CP-1'],
  ...over,
})

// ⚠️ 2026-09-18 起收的是 role（top／second／null）而不是等級名稱——
// 哪一層是「最大獎池」每款遊戲不同（有些是 Grand、有些是 Fortunate），寫死就錯。
const ASSERTS = [
  ['有值且與手動相同 → value 且 differs=false', f => {
    const s = f(row(), 'top', 'min', 1000000)
    return s.kind === 'value' && s.value === 1000000 && s.differs === false
  }],
  ['有值且與手動不同 → value 且 differs=true', f => {
    const s = f(row(), 'top', 'max', 2000000)
    return s.kind === 'value' && s.value === 3000000 && s.differs === true
  }],
  ['second 讀的是 mlow/mhigh 那一組，不是最大池那一組', f => {
    const s = f(row(), 'second', 'min', 0)
    return s.kind === 'value' && s.value === 100000
  }],
  // 四種「沒有數字」必須各自不同
  ['沒被指定為最大／第二大的等級 → not_applicable', f =>
    f(row(), null, 'min', 0).kind === 'not_applicable'],
  ['list.json 沒這台 → unmatched', f =>
    f(row({ matched: false, grand: null, major: null }), 'top', 'min', 0).kind === 'unmatched'],
  ['有這台但沒設門檻 → missing', f =>
    f(row({ grand: null }), 'top', 'min', 0).kind === 'missing'],
  // ⚠️ 這條原本只驗「grand 是 null」那一種形狀，結果 M3（衝突時照樣採用第一台的值）
  //    可以活著通過——因為沒有值可以採用。要連「還帶著值」的形狀一起驗才守得住。
  ['多台辨識機不一致 → conflict（而且不給值）', f => {
    const noRange = f(row({ grandConflict: true, grand: null }), 'top', 'min', 0)
    const withRange = f(row({ grandConflict: true }), 'top', 'min', 0)
    return noRange.kind === 'conflict' && noRange.value === undefined
        && withRange.kind === 'conflict' && withRange.value === undefined
  }],
  ['四種狀態互不相同', f => {
    const kinds = new Set([
      f(row(), null, 'min', 0).kind,
      f(row({ matched: false }), 'top', 'min', 0).kind,
      f(row({ grand: null }), 'top', 'min', 0).kind,
      f(row({ grandConflict: true }), 'top', 'min', 0).kind,
    ])
    return kinds.size === 4
  }],
  ['還沒回來 → loading，不可當成 unmatched', f =>
    f(undefined, 'top', 'min', 0).kind === 'loading'],
  ['只設單邊：有值那邊給 value、另一邊 missing', f => {
    const r = row({ grand: { max: 200000000 } })
    return f(r, 'top', 'max', 0).kind === 'value' && f(r, 'top', 'min', 0).kind === 'missing'
  }],
  ['衝突優先於「沒設門檻」——衝突時即使有值也不給', f => {
    const s = f(row({ grandConflict: true }), 'top', 'min', 0)
    return s.kind === 'conflict'
  }],
]

let pass = 0, fail = 0
console.log('— 本體 —')
for (const [name, run] of ASSERTS) {
  let ok = false
  try { ok = run(watchCompareState) === true } catch (e) { ok = false; console.log(`    (throw) ${e.message}`) }
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
  ok ? pass++ : fail++
}

const MUTANTS = [
  ['M1 把四種「沒有數字」全合併成 missing', (r, l, b, c) => {
    const s = watchCompareState(r, l, b, c)
    return s.kind === 'value' || s.kind === 'loading' ? s : { kind: 'missing' }
  }, '四種狀態互不相同'],
  ['M2 讀取中當成 unmatched', (r, l, b, c) =>
    r === undefined ? { kind: 'unmatched' } : watchCompareState(r, l, b, c),
  '還沒回來 → loading，不可當成 unmatched'],
  ['M3 衝突時照樣採用第一台的值', (r, l, b, c) => {
    const s = watchCompareState(r, l, b, c)
    if (s.kind !== 'conflict') return s
    const range = l === 'top' ? r.grand : r.major
    const v = range?.[b]
    return v === undefined ? s : { kind: 'value', value: v, differs: v !== c, servers: r.servers }
  }, '多台辨識機不一致 → conflict（而且不給值）'],
  ['M4 second 也去讀最大池的範圍', (r, l, b, c) =>
    l === 'second' ? watchCompareState(r, 'top', b, c) : watchCompareState(r, l, b, c),
  'second 讀的是 mlow/mhigh 那一組，不是最大池那一組'],
  ['M5 沒指定的等級也拿最大池的範圍來比', (r, l, b, c) =>
    l === null ? watchCompareState(r, 'top', b, c) : watchCompareState(r, l, b, c),
  '沒被指定為最大／第二大的等級 → not_applicable'],
]

console.log('\n— 突變體（每個都必須被預期的那條抓到）—')
let killed = 0
for (const [name, mutant, expected] of MUTANTS) {
  const caught = []
  for (const [aName, run] of ASSERTS) {
    let ok = false
    try { ok = run(mutant) === true } catch { ok = false }
    if (!ok) caught.push(aName)
  }
  const dead = caught.includes(expected)
  console.log(`  ${dead ? 'KILLED' : 'SURVIVED'}  ${name}`)
  console.log(`            ↳ 預期防線：${expected}${dead ? '（抓到）' : '（沒抓到！）'}`)
  if (dead) killed++
  else fail++
}

console.log(`\n本體 ${pass} PASS / ${fail} FAIL｜突變體 ${killed}/${MUTANTS.length} 被殺`)
process.exit(fail === 0 && killed === MUTANTS.length ? 0 : 1)
