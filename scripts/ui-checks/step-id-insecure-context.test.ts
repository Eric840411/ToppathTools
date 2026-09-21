/**
 * 「從區網 IP 開這個工具時，腳本的步驟會不會整份消失」。
 *
 *   npx tsx scripts/ui-checks/step-id-insecure-context.test.ts
 *
 * 🚨 **這支守的是一個會吃掉資料的 bug**（2026-09-19 使用者回報）：
 *    `crypto.randomUUID()` **只在安全情境（HTTPS 或 localhost）存在**。
 *    從 `http://192.168.x.x:3000` 開的時候它不存在 → `createStep()` 丟錯 →
 *    `parseSteps()` 的 try/catch 把整份步驟吃掉變成 `[]` →
 *    **每一份腳本都顯示「0 區塊」、編輯器說「還沒有步驟」**，
 *    而資料庫裡步驟好好的、TC 綁定也讀得出來（綁定沒走 `createStep`）。
 *
 *    🚨 更糟的是：在那個畫面按「儲存腳本」會把空陣列存回去，**真的把步驟清掉**。
 *
 * ⚠️ 所以這支**把 `crypto.randomUUID` 拿掉再測**——只在正常環境測的話，
 *    這條永遠是綠的，等於沒守到。
 */
import { parseSteps, serializeSteps, createStep, newStepId } from '../../src/features/uat/step-model'

let pass = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log('✅ ' + name) }
  else { fails.push(name); console.log(`❌ ${name}${extra ? ' | ' + extra : ''}`) }
}

const RAW = JSON.stringify([
  { id: 'a1', name: '前往頁面', action: 'goto' },
  { id: 'a2', name: '等待', action: 'wait', value: '13000' },
  { id: 'a3', name: '驗證可見', action: 'assert_visible', selector: '.grid-item', tcId: 'rec123' },
])

// ── 正常環境（有 randomUUID）──────────────────────────────────────────────────
ok('① 安全情境下讀得到 3 步', parseSteps(RAW).length === 3, `讀到 ${parseSteps(RAW).length}`)

// ── 🚨 模擬區網 HTTP：把 randomUUID 拿掉 ─────────────────────────────────────
const realCrypto = globalThis.crypto
const noUuid = { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) } as unknown as Crypto
Object.defineProperty(globalThis, 'crypto', { value: noUuid, configurable: true })
try {
  ok('② 沒有 randomUUID 時仍然產得出 id', typeof newStepId() === 'string' && newStepId().length > 8, newStepId())
  ok('③ 🚨 沒有 randomUUID 時步驟不會整份消失', parseSteps(RAW).length === 3, `讀到 ${parseSteps(RAW).length} 步（0 就是那個 bug）`)
  const steps = parseSteps(RAW)
  ok('④ 參數沒有掉（selector／value／tcId）',
    steps[1].value === '13000' && steps[2].selector === '.grid-item' && steps[2].tcId === 'rec123')
  ok('⑤ 存回去不會變成空的（這是會吃掉資料的那一條）',
    JSON.parse(serializeSteps(steps)).length === 3)
  ok('⑥ 新增步驟也還能用', !!createStep('click').id)

  // ── 連 getRandomValues 都沒有（更舊的環境）────────────────────────────────
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true })
  ok('⑦ 連 crypto 都沒有時也不會炸', parseSteps(RAW).length === 3 && typeof newStepId() === 'string')
} finally {
  Object.defineProperty(globalThis, 'crypto', { value: realCrypto, configurable: true })
}

// id 要夠獨特，否則清單的 key 會撞（React 會渲染錯行）
const ids = new Set(Array.from({ length: 500 }, () => newStepId()))
ok('⑧ 500 個 id 不重複', ids.size === 500, `只有 ${ids.size} 個相異`)

console.log(`\n${fails.length ? '❌' : '✅'} ${pass} 過 / ${fails.length} 失敗`)
if (fails.length) { fails.forEach(f => console.log('  - ' + f)); process.exit(1) }
