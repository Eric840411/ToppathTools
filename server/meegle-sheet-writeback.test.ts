/**
 * Meegle 開單回填 Sheet 的測試。跑法：npx tsx server/meegle-sheet-writeback.test.ts
 * Lark 讀寫用假的；守的是「不寫到別列」「舊回填不蓋新狀態」「只有推成功才寫已推到」。
 */
import Database from 'better-sqlite3'
import { claimRow, finishCreate, finishState, getBatchRow, initMeegleBatchSchema, writebackStageText } from './meegle-batch-store.js'
import { MAX_COL_IDX, normName, planColumns, writebackRow, type SheetCell, type WritebackDeps } from './meegle-sheet-writeback.js'

let pass = 0
const fails: string[] = []
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) }
  else { fails.push(`${name} | got: ${g} | want: ${w}`); console.log(`❌ ${name} | got: ${g} | want: ${w}`) }
}

const SHEET = 'lark:TOK:S1'
function setup(name = '修正登入驗證失敗', target = '', targetName = '') {
  const db = new Database(':memory:'); initMeegleBatchSchema(db)
  claimRow(db, { batchId: 'B', rowKey: '5', ownerEmail: 'a@x.tw', sheetUrl: SHEET, name, requirementId: '1', targetState: target, targetStateName: targetName }, 1000)
  finishCreate(db, 'B', '5', { phase: 'created', workItemId: '15191459', url: 'https://meegle/x/15191459' }, 2000)
  return db
}
function fakeDeps(rowOnSheet: { summary: string; title: string; pasted?: string } | null, writeResult = { ok: true } as { ok: boolean; error?: string }) {
  const writes: Array<{ rowIndex: number; columns: Record<string, SheetCell> }> = []
  const deps: WritebackDeps = {
    readRowNames: async () => rowOnSheet,
    writeRow: async (_k, rowIndex, columns) => { writes.push({ rowIndex, columns }); return writeResult },
    now: () => Date.UTC(2026, 9, 2, 2, 0, 0),
  }
  return { deps, writes }
}

// ── 處理階段文字 ──
eq('沒有目標狀態', writebackStageText({ target_state: '', target_state_name: '', state_phase: 'none' }), '已開單（Meegle）')
eq('推成功才寫「已推到」', writebackStageText({ target_state: 'K', target_state_name: '可本機測試', state_phase: 'done' }), '已開單（Meegle）・已推到可本機測試')
eq('推失敗不能寫成已推到', writebackStageText({ target_state: 'K', target_state_name: '可本機測試', state_phase: 'failed' }), '已開單（Meegle）・推到可本機測試未完成')
eq('名稱缺時用 key', writebackStageText({ target_state: 'BAOjDk8Pv', target_state_name: '', state_phase: 'done' }), '已開單（Meegle）・已推到BAOjDk8Pv')

{
  const db = setup()
  eq('開單成功時同一筆 UPDATE 就標 pending', getBatchRow(db, 'B', '5')?.writeback_phase, 'pending')
  const { deps, writes } = fakeDeps({ summary: '修正登入驗證失敗', title: '' })
  const r = await writebackRow(db, 'B', '5', deps)
  eq('名稱對得上 → 寫入、標 done', [r.phase, getBatchRow(db, 'B', '5')?.writeback_phase], ['done', 'done'])
  eq('寫在開單時的那一列', writes[0].rowIndex, 5)
  eq('單號是超連結（richtext segments；url 型別會被 Lark 拒絕）', writes[0].columns['Meegle 單號'], { type: 'richtext', segments: [{ text: '#15191459', link: 'https://meegle/x/15191459' }] })
  eq('處理階段', writes[0].columns['處理階段'], '已開單（Meegle）')
  eq('單子標題貼這：跟 Jira 同格式（單號超連結＋換行＋任務名稱）', writes[0].columns['單子標題貼這'], { type: 'richtext', segments: [{ text: '#15191459', link: 'https://meegle/x/15191459' }, { text: '\n修正登入驗證失敗' }] })
  eq('已經 done 再呼叫 → 跳過不重寫', (await writebackRow(db, 'B', '5', deps)).phase, 'skipped')
  eq('補寫回（force）會再寫一次', [(await writebackRow(db, 'B', '5', deps, { force: true })).phase, writes.length], ['done', 2])
}
{
  const db = setup()
  const { deps, writes } = fakeDeps({ summary: '別的單', title: '' })
  const r = await writebackRow(db, 'B', '5', deps)
  eq('有人插列，這一列變成別筆 → 不寫、標 failed', [r.phase, writes.length, getBatchRow(db, 'B', '5')?.writeback_phase], ['failed', 0, 'failed'])
  eq('失敗原因寫明列已變動', getBatchRow(db, 'B', '5')?.writeback_msg?.startsWith('列已變動'), true)
}
{
  const db = setup('第一行 第二行')
  const { deps, writes } = fakeDeps({ summary: '', title: '第一行\n第二行' })
  eq('摘要空白用標題、換行視同空白（跟開單取名同一套）', [(await writebackRow(db, 'B', '5', deps)).phase, writes.length], ['done', 1])
}
{
  const db = setup()
  const { deps, writes } = fakeDeps(null)
  eq('讀不到摘要／標題欄 → 不寫', [(await writebackRow(db, 'B', '5', deps)).phase, writes.length], ['failed', 0])
}
{
  const db = setup()
  const { deps } = fakeDeps({ summary: '修正登入驗證失敗', title: '' }, { ok: false, error: 'Lark API code 90001' })
  const r = await writebackRow(db, 'B', '5', deps)
  eq('Lark 寫入失敗 → failed 並留下原因', [r.phase, getBatchRow(db, 'B', '5')?.writeback_msg], ['failed', '寫入 Sheet 失敗：Lark API code 90001'])
  eq('開單結果不受影響', getBatchRow(db, 'B', '5')?.create_phase, 'created')
}
// ── 舊回填不能蓋掉新狀態 ──
{
  const db = setup('A', 'K', '可本機測試')
  const { deps, writes } = fakeDeps({ summary: 'A', title: '' })
  // 寫的途中狀態推成功了（例如另一個請求重推）
  deps.writeRow = async (_k, rowIndex, columns) => { writes.push({ rowIndex, columns }); finishState(db, 'B', '5', 'done', null, 5000); return { ok: true } }
  await writebackRow(db, 'B', '5', deps)
  eq('寫的途中狀態變了 → 不標 done，維持 pending 等下一次', getBatchRow(db, 'B', '5')?.writeback_phase, 'pending')
  eq('那次寫的是舊內容（未完成）', writes[0].columns['處理階段'], '已開單（Meegle）・推到可本機測試未完成')
  deps.writeRow = async (_k, rowIndex, columns) => { writes.push({ rowIndex, columns }); return { ok: true } }
  await writebackRow(db, 'B', '5', deps)
  eq('下一次寫的是最新內容（已推到）', writes[1].columns['處理階段'], '已開單（Meegle）・已推到可本機測試')
}
// ── 同一份 Sheet 排隊 ──
{
  const db = new Database(':memory:'); initMeegleBatchSchema(db)
  for (const k of ['5', '6', '7']) {
    claimRow(db, { batchId: 'B', rowKey: k, ownerEmail: 'a@x.tw', sheetUrl: SHEET, name: `n${k}`, requirementId: '1', targetState: '' }, 1000)
    finishCreate(db, 'B', k, { phase: 'created', workItemId: k, url: '' }, 2000)
  }
  let active = 0, maxActive = 0
  const deps: WritebackDeps = {
    readRowNames: async (_k, i) => ({ summary: `n${i}`, title: '' }),
    writeRow: async () => { active++; maxActive = Math.max(maxActive, active); await new Promise(r => setTimeout(r, 20)); active--; return { ok: true } },
  }
  await Promise.all(['5', '6', '7'].map(k => writebackRow(db, 'B', k, deps)))
  eq('同一份 Sheet 的回填一次只跑一個', maxActive, 1)
  eq('三列都寫完', ['5', '6', '7'].map(k => getBatchRow(db, 'B', k)?.writeback_phase), ['done', 'done', 'done'])
}
{
  const db = new Database(':memory:'); initMeegleBatchSchema(db)
  claimRow(db, { batchId: 'B', rowKey: '5', ownerEmail: 'a@x.tw', sheetUrl: SHEET, name: 'x', requirementId: '1', targetState: '' })
  eq('還沒開單成功 → 跳過', (await writebackRow(db, 'B', '5', fakeDeps({ summary: 'x', title: '' }).deps)).phase, 'skipped')
}
eq('名稱正規化', normName('  a\r\nb   c '), 'a b c')

// ── CodeX review d7d2d20 [P2]：同一毫秒的更新也要擋（版本改用整數 rev）──
{
  const db = setup('A', 'K', '可本機測試')
  const { deps, writes } = fakeDeps({ summary: 'A', title: '' })
  // 寫的途中狀態推成功，而且**跟開單成功同一毫秒**（updated_at 一樣）
  deps.writeRow = async (_k, rowIndex, columns) => { writes.push({ rowIndex, columns }); finishState(db, 'B', '5', 'done', null, 2000); return { ok: true } }
  await writebackRow(db, 'B', '5', deps)
  eq('同毫秒更新：updated_at 沒變但內容變了 → 仍維持 pending', getBatchRow(db, 'B', '5')?.writeback_phase, 'pending')
  deps.writeRow = async (_k, rowIndex, columns) => { writes.push({ rowIndex, columns }); return { ok: true } }
  eq('下一次不會被 skipped，會寫最新內容', [(await writebackRow(db, 'B', '5', deps)).phase, writes.at(-1)?.columns['處理階段']], ['done', '已開單（Meegle）・已推到可本機測試'])
}
// ── CodeX review d7d2d20 [P2]：欄位超過 ZZ 一律拒寫 ──
{
  const names = ['Meegle 單號', '處理階段', '處理時間']
  const full = Array.from({ length: MAX_COL_IDX + 1 }, (_, i) => [`c${i}`])
  const r = planColumns(full, MAX_COL_IDX + 1, names)
  eq('表頭滿到 ZZ、三欄都要新建 → 拒寫', r.ok, false)
  const near = Array.from({ length: MAX_COL_IDX - 1 }, (_, i) => [`c${i}`])
  eq('只剩兩格、要新建三欄 → 拒寫（第三欄會超過）', planColumns(near, MAX_COL_IDX - 1, names).ok, false)
  const withExisting = [...near.slice(0, 5), ['處理階段'], ['處理時間']]
  eq('已存在的欄位用原位置、只新建缺的', planColumns(withExisting, 7, names), { ok: true, idx: { 'Meegle 單號': 7, '處理階段': 5, '處理時間': 6 } })
  eq('欄名比對忽略空白與箭頭（跟 helper 一致）', (planColumns([['處理 階段↓']], 1, ['處理階段']) as { idx: Record<string, number> }).idx['處理階段'], 0)
}

// ── CodeX review 15ba814：「單子標題貼這」已有別張單時不覆蓋 ──
{
  const db = setup()
  const { deps, writes } = fakeDeps({ summary: '修正登入驗證失敗', title: '', pasted: 'CGFB-50\nFree Bet Record頁面內 缺少文字' })
  const r = await writebackRow(db, 'B', '5', deps)
  eq('已有 Jira 單 → 其他欄照寫、標 done', [r.phase, getBatchRow(db, 'B', '5')?.writeback_phase], ['done', 'done'])
  eq('單子標題貼這不寫（保留 Jira 原值）', 'Meegle 單號' in writes[0].columns && !('單子標題貼這' in writes[0].columns), true)
  eq('留下附註說明為什麼沒寫', getBatchRow(db, 'B', '5')?.writeback_msg?.includes('CGFB-50'), true)
}
{
  const db = setup()
  const { deps, writes } = fakeDeps({ summary: '修正登入驗證失敗', title: '', pasted: '#15191459\n修正登入驗證失敗' })
  await writebackRow(db, 'B', '5', deps)
  eq('本來就是同一張 Meegle 單（補寫回）→ 照寫', '單子標題貼這' in writes[0].columns, true)
}
{
  const db = setup()
  const { deps, writes } = fakeDeps({ summary: '修正登入驗證失敗', title: '', pasted: '   ' })
  await writebackRow(db, 'B', '5', deps)
  eq('空白 → 照寫', ['單子標題貼這' in writes[0].columns, getBatchRow(db, 'B', '5')?.writeback_msg], [true, null])
}
{
  const db = setup()
  const { deps, writes } = fakeDeps({ summary: '修正登入驗證失敗', title: '', pasted: '#15191458\n別的 Meegle 單' })
  await writebackRow(db, 'B', '5', deps)
  eq('別張 Meegle 單（號碼不同）→ 也不覆蓋', '單子標題貼這' in writes[0].columns, false)
}

{
  const db = setup()
  const { deps, writes } = fakeDeps({ summary: '修正登入驗證失敗', title: '', pasted: '#151914590\n更長的單號' })
  await writebackRow(db, 'B', '5', deps)
  eq('單號是前綴但不是同一張（#151914590）→ 不覆蓋', '單子標題貼這' in writes[0].columns, false)
}

console.log(`\n${pass} 通過，${fails.length} 失敗`)
if (fails.length) { console.log(fails.join('\n')); process.exit(1) }
