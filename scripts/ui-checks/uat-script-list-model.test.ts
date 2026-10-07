/**
 * 後台錄製腳本清單的畫面邏輯（1007；CodeX a26744e 的三個 P2）。
 *
 *   npx tsx scripts/ui-checks/uat-script-list-model.test.ts
 */
import { readFileSync } from 'node:fs'
import { buildScriptRows, lastRunText, sortScriptsByNumber } from '../../src/features/uat/script-sort.ts'

let fail = 0, n = 0
const ok = (c: boolean, label: string, got?: unknown) => { n++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${!c && got !== undefined ? `：${JSON.stringify(got)}` : ''}`) }

// 排序（使用者確認：編號 → 範本 → 純數字）
const titles = ['12', 'T-A-001', 'T-A-004', 'T-A-002', 'T-A-005', '範本：跨頁面三方比對', 'T-007', '範本：匯出檔與畫面數據比對', 'T-A-009']
const sorted = sortScriptsByNumber(titles.map((title, i) => ({ title, id: String(i) }))).map(s => s.title)
ok(JSON.stringify(sorted) === JSON.stringify(['T-007', 'T-A-001', 'T-A-002', 'T-A-004', 'T-A-005', 'T-A-009', '範本：匯出檔與畫面數據比對', '範本：跨頁面三方比對', '12']), '全部：編號 → 範本 → 純數字', sorted)

// [P2] 上次結果：只有每一筆都 pass 才是通過
const at = Date.UTC(2026, 9, 7, 3, 0)
const base = { at, pass: 0, fail: 0, blocked: 0, total: 1, dryRun: false, stopped: false }
ok(lastRunText({ ...base, unverified: 1 }).cls === 'is-warn' && /未驗/.test(lastRunText({ ...base, unverified: 1 }).text), '全部未驗 → 顯示「未驗」不是通過', lastRunText({ ...base, unverified: 1 }))
ok(/未驗/.test(lastRunText({ ...base, total: 3, pass: 2, unverified: 1 }).text), '部分未驗 → 未驗')
ok(/未驗/.test(lastRunText({ ...base, total: 0 }).text), '沒有任何結果 → 未驗')
ok(lastRunText({ ...base, total: 2, pass: 2 }).cls === 'is-ok', '全部 pass → 通過')
ok(lastRunText({ ...base, total: 2, pass: 1, fail: 1 }).cls === 'is-bad', '有失敗 → 失敗')
ok(/停止/.test(lastRunText({ ...base, total: 2, pass: 2, stopped: true }).text), '停止 → 已停止（即使結果都 pass）')

// [P2]「別人的」用登入帳號判斷：Alice 加入 Bob 的之後，Alice 自己的不能被標成別人的
const scripts = [
  { id: 'b1', title: 'T-B-001', createdBy: 'bob@x' },
  { id: 'a1', title: 'T-A-001', createdBy: 'alice@x' },
  { id: 'a2', title: 'T-A-002', createdBy: 'alice@x' },
]
const rows = buildScriptRows({ scripts, mineIds: ['b1', 'a1', 'a2'], me: 'alice@x', tab: 'mine', match: () => true })
ok(JSON.stringify(rows.map(r => [r.script.id, r.others])) === '[["b1",true],["a1",false],["a2",false]]', '我的：Bob 的標「別人的」、Alice 自己的不標（第一列是 Bob 的也一樣）', rows.map(r => [r.script.id, r.others]))
ok(buildScriptRows({ scripts, mineIds: ['a1'], me: '', tab: 'mine', match: () => true }).every(r => !r.others), '還不知道登入帳號 → 不亂標')
const all = buildScriptRows({ scripts, mineIds: ['a1'], me: 'alice@x', tab: 'all', match: () => true })
ok(all.find(r => r.script.id === 'a1')?.inMine === true && all.find(r => r.script.id === 'b1')?.inMine === false && all.every(r => !r.others), '全部：標「已在我的」、不標「別人的」')
ok(buildScriptRows({ scripts, mineIds: ['a1', 'gone'], me: 'alice@x', tab: 'mine', match: () => true }).length === 1, '我的清單裡有已不存在的 id → 不顯示')

// [P2] 409 → 重新載入整份清單（腳本＋mine），不是只換 mine
const src = readFileSync('src/features/uat/RecordedScriptLibrary.tsx', 'utf8')
const saveOrder = src.slice(src.indexOf('async function saveOrder'), src.indexOf('async function forceUnlock'))
ok(/status === 409\) setRefresh\(/.test(saveOrder) && !/setMine\(status === 409/.test(saveOrder), '排序 409 → 重新載入整份清單（不是只換 mine）')
ok(/data\.me/.test(src) && /me:\s*account\.email/.test(readFileSync('server/uat-recorded-scripts.ts', 'utf8')), '登入帳號由 server 回傳、畫面使用')

console.log(fail ? `❌ ${fail}/${n} 失敗` : `✅ ${n}/${n} 通過`)
process.exit(fail ? 1 : 0)
