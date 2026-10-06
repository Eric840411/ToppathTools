/**
 * 操作歷史：server 有寫的 feature key，HistoryPage 的 FEATURE_LABELS 都要有（v5.27.2）。
 * 少了的話那種紀錄會顯示成原始代號、也沒有篩選按鈕（使用者 10/06 回報 meegle-batch-status／-edit／-backfill）。
 * 跑法：node scripts/ui-checks/history-feature-labels.mjs
 */
import fs from 'fs'
import path from 'path'

const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)])
const keys = new Set()
for (const f of walk('server').filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
  const src = fs.readFileSync(f, 'utf8')
  for (const m of src.matchAll(/addHistory\(\s*'([a-z0-9-]+)'/g)) keys.add(m[1])
  for (const m of src.matchAll(/feature:\s*'([a-z0-9-]+)'/g)) keys.add(m[1])
}
const page = fs.readFileSync('src/pages/HistoryPage.tsx', 'utf8')
const block = /const FEATURE_LABELS[^{]*\{([\s\S]*?)\n\}/.exec(page)?.[1] ?? ''
const labels = new Set([...block.matchAll(/'([a-z0-9-]+)':/g)].map(m => m[1]))
const missing = [...keys].filter(k => !labels.has(k)).sort()
console.log(`server 寫的 key ${keys.size} 個、頁面有名稱 ${labels.size} 個`)
if (missing.length) { console.log(`❌ 頁面沒有名稱：${missing.join('、')}`); process.exit(1) }
console.log('✅ 都有名稱')
