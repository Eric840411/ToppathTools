/**
 * OSM 版本更新紀錄的測試。跑法：npx tsx server/osm-releases.test.ts
 * 守的是：三態不能混（x＝未異動、空白＝未提供）、前後端共用的欄位規則、樂觀鎖不覆蓋別人的修改、
 * 用過的元件不能刪、匯入冪等（重跑不重複）。
 * fixture 全是合成的——repo 是公開的，不放真實 Lark 表內容。
 */
import Database from 'better-sqlite3'
import { validateRelease, extractTickets, serialToDate, type ReleaseInput } from '../shared/osm-release-rules.js'
import {
  initOsmReleaseSchema, upsertTab, addComponent, updateComponent, deleteComponent, listComponents, listStatuses, updateStatus,
  createRelease, updateRelease, deleteRelease, getRelease, listReleases, listRevisions,
} from './osm-release-store.js'
import { parseReleaseSheet, applyParsedSheet } from './osm-release-import.js'

let pass = 0
const fails: string[] = []
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) }
  else { fails.push(`${name} | got: ${g} | want: ${w}`); console.log(`❌ ${name} | got: ${g} | want: ${w}`) }
}

// ─── 共用規則 ──────────────────────────────────────────────────────────────────
{
  const ctx = {
    tabs: [{ id: 'osm', showComponents: true, active: true }, { id: 'om', showComponents: false, active: true }, { id: 'old', showComponents: true, active: false }],
    components: [{ id: 1, tabId: 'osm', name: 'H5', active: true }, { id: 2, tabId: 'osm', name: 'PC', active: true }, { id: 3, tabId: 'osm', name: '舊元件', active: false }, { id: 9, tabId: 'om', name: 'X', active: true }],
    statuses: [{ id: 1, active: true }, { id: 2, active: false }],
  }
  const base: ReleaseInput = { tabId: 'osm', statusId: 1, testDate: '2026-10-13', releaseDate: '2026-10-15', content: '', sqlText: '', resultText: '', values: [{ componentId: 1, state: 'updated', version: '1.5.90.7' }, { componentId: 2, state: 'unchanged', version: '' }] }
  const v = (p: Partial<ReleaseInput>, extra: Parameters<typeof validateRelease>[1] = ctx) => Object.keys(validateRelease({ ...base, ...p }, extra))

  eq('正常一筆通過', v({}), [])
  eq('有更新沒填版號 → 擋', v({ values: [{ componentId: 1, state: 'updated', version: '  ' }] }), ['component:1'])
  eq('未異動卻填版號 → 擋（不能把 x 當成版號存）', v({ values: [{ componentId: 1, state: 'unchanged', version: '1.0' }] }), ['component:1', 'content'])
  eq('未提供卻填版號 → 擋', v({ values: [{ componentId: 2, state: 'na', version: '1.0' }, { componentId: 1, state: 'updated', version: '2' }] }), ['component:2'])
  eq('兩個日期都沒填 → 擋', v({ testDate: '', releaseDate: '' }), ['releaseDate'])
  eq('只填測試日期可以', v({ releaseDate: '' }), [])
  eq('上線早於測試 → 擋', v({ releaseDate: '2026-10-01' }), ['releaseDate'])
  eq('不存在的日期 → 擋', v({ testDate: '2026-02-30' }), ['testDate'])
  eq('沒選狀態 → 擋', v({ statusId: null }), ['statusId'])
  eq('新紀錄不能選停用的狀態', v({ statusId: 2 }), ['statusId'])
  eq('舊紀錄原本就是停用狀態可以保留', v({ statusId: 2 }, { ...ctx, keepIds: { statusId: 2 } }), [])
  eq('停用的元件不能新標有更新', v({ values: [{ componentId: 3, state: 'updated', version: '1' }] }), ['component:3'])
  eq('停用的元件舊紀錄原本有值可以保留', v({ values: [{ componentId: 3, state: 'updated', version: '1' }] }, { ...ctx, keepIds: { componentIds: [3] } }), [])
  eq('別的分頁的元件 → 擋', v({ values: [{ componentId: 9, state: 'updated', version: '1' }] }), ['component:9'])
  eq('同一元件重複 → 擋', v({ values: [{ componentId: 1, state: 'updated', version: '1' }, { componentId: 1, state: 'unchanged', version: '' }] }), ['component:1'])
  eq('全部未異動又沒寫內容 → 擋', v({ values: [{ componentId: 1, state: 'unchanged', version: '' }] }), ['content'])
  eq('全部未異動但有寫內容 → 可以', v({ values: [{ componentId: 1, state: 'unchanged', version: '' }], content: '只改設定' }), [])
  eq('沒有元件欄的分頁一定要內容', v({ tabId: 'om', values: [] }), ['content'])
  eq('停用的分頁 → 擋', v({ tabId: 'old' }), ['tabId', 'component:1', 'component:2'])

  eq('抓單號（去重、不抓小寫或沒數字的）', extractTickets('[P5MA-3060] 修正；P5BU-1530、P5MA-3060 again, abc-12, CGFB-x'), ['P5MA-3060', 'P5BU-1530'])
  eq('日期序號 45658 → 2025-01-01', serialToDate(45658), '2025-01-01')
  eq('日期序號字串也可以', serialToDate('46023'), '2026-01-01')
  eq('不是日期的數字 → 空字串（版號 1.5 不能被當日期）', [serialToDate(1.5), serialToDate('x'), serialToDate('')], ['', '', ''])
}

// ─── 資料層 ────────────────────────────────────────────────────────────────────
const fresh = () => { const db = new Database(':memory:'); initOsmReleaseSchema(db); return db }
{
  const db = fresh()
  eq('預設三個狀態', listStatuses(db).map(s => s.name), ['測試服', '維護上正式', '熱更上正式'])
  upsertTab(db, { id: 'osm', name: 'OSM', showComponents: true, showSql: true, showResult: false })
  const h5 = addComponent(db, { tabId: 'osm', name: 'H5', groupName: '組件' })
  const pc = addComponent(db, { tabId: 'osm', name: 'PC', groupName: '組件' })
  const ll = addComponent(db, { tabId: 'osm', name: 'LL服務', groupName: 'LuckyLink組件' })
  const input: ReleaseInput = { tabId: 'osm', statusId: 2, testDate: '2026-10-13', releaseDate: '2026-10-15', content: 'a', sqlText: '', resultText: '',
    values: [{ componentId: h5, state: 'updated', version: ' 1.0 ' }, { componentId: pc, state: 'unchanged', version: '' }, { componentId: ll, state: 'na', version: '' }] }
  const id = createRelease(db, input, 'A', { now: 1000 })
  const r = getRelease(db, id)!
  eq('三態原樣存回來（版號去頭尾空白）', r.values.map(v => [v.state, v.version]), [['updated', '1.0'], ['unchanged', ''], ['na', '']])
  eq('被引用數不算「未提供」', listComponents(db).map(c => c.usage), [1, 1, 0])

  eq('拿舊 rev 改 → 衝突，不覆蓋', (() => { const x = updateRelease(db, id, 0, { ...input, content: 'B 的' }, 'B'); return [x.ok, 'reason' in x && x.reason] })(), [false, 'conflict'])
  eq('衝突後內容沒被改', getRelease(db, id)!.content, 'a')
  const u = updateRelease(db, id, 1, { ...input, content: 'b' }, 'B', 2000)
  eq('正確 rev 改 → rev+1', u, { ok: true, rev: 2 })
  eq('另一個人拿 rev 1 再改 → 衝突（回最新那筆讓畫面顯示是誰改的）', (() => { const x = updateRelease(db, id, 1, input, 'C'); return 'current' in x ? x.current.updatedBy : null })(), 'B')

  eq('用過的元件不能刪', deleteComponent(db, h5).ok, false)
  eq('只有「未提供」的元件可以刪（跟被引用數同一個定義）', deleteComponent(db, ll).ok, true)
  eq('刪掉後不留孤兒值列', getRelease(db, id)!.values.some(v => v.componentId === ll), false)
  updateComponent(db, pc, { active: false })
  eq('停用元件後舊紀錄還讀得到它的值', getRelease(db, id)!.values.some(v => v.componentId === pc), true)
  updateStatus(db, 2, { active: false })
  eq('停用狀態後舊紀錄的狀態不變', getRelease(db, id)!.statusId, 2)

  eq('刪除拿舊 rev → 衝突', deleteRelease(db, id, 1, 'A').ok, false)
  eq('刪除正確 rev → 成功', deleteRelease(db, id, 2, 'A').ok, true)
  eq('軟刪除後列表看不到', listReleases(db).length, 0)
  eq('修改履歷留著（新增／修改／刪除）', listRevisions(db, id).map(x => x.action), ['delete', 'update', 'create'])
  eq('刪除後元件就不算被引用，可以刪', deleteComponent(db, h5).ok, true)
}
{
  const db = fresh()
  upsertTab(db, { id: 't', name: 'T', showComponents: false, showSql: false, showResult: false })
  const mk = (testDate: string, releaseDate: string) => createRelease(db, { tabId: 't', statusId: 1, testDate, releaseDate, content: 'x', sqlText: '', resultText: '', values: [] }, 'A')
  const a = mk('2026-09-01', ''), b = mk('2026-08-01', '2026-10-01'), c = mk('2026-09-15', '2026-09-20')
  eq('排序用上線日期，沒有才用測試日期，新的在前', listReleases(db).map(r => r.id), [b, c, a])
}

// ─── 匯入 ──────────────────────────────────────────────────────────────────────
{
  // 兩列表頭：第 1 列大類（組件、LuckyLink組件 是合併格），第 2 列元件名稱
  const osmSheet = [
    ['測試日期', '更新狀態', '上線日期', '組件', null, 'LuckyLink組件', '更新內容', 'SQL執行'],
    [null, null, null, 'H5新\n前端', 'Center服', 'LL服務', null, null],
    [46023, '維護上正式', 46025, '1.5.0', 'x', null, '[P5MA-1] 第一筆', 'UPDATE t'],
    [46030, '熱更上正式', null, 'X', '2.0', '1.1', '', ''],
    [null, null, null, null, null, null, null, null],
    [46040, '新狀態', 46041, null, null, null, '只有內容', ''],
  ]
  const p = parseReleaseSheet(osmSheet as never)
  eq('元件與群組（換行收成空白）', p.components.map(c => [c.name, c.group]), [['H5新 前端', '組件'], ['Center服', '組件'], ['LL服務', 'LuckyLink組件']])
  eq('有 SQL 欄、沒有更新結果欄', [p.showSql, p.showResult], [true, false])
  eq('空列略過', p.records.length, 3)
  eq('x／空白／版號 → 三態（大寫 X 也算未異動）', p.records.map(r => r.values.map(v => v.state)), [['updated', 'unchanged', 'na'], ['unchanged', 'updated', 'updated'], ['na', 'na', 'na']])
  eq('日期序號轉換、沒填就是空', p.records.map(r => [r.testDate, r.releaseDate]), [['2026-01-01', '2026-01-03'], ['2026-01-08', ''], ['2026-01-18', '2026-01-19']])

  const omSheet = [
    ['測試日期', '更新狀態', '上線日期', '更新內容', '更新結果'],
    [46023, '測試服', 46024, 'server 更新', '成功'],
  ]
  const om = parseReleaseSheet(omSheet as never)
  eq('沒有第二列表頭的分頁（OM）：沒有元件、第 2 列就是資料', [om.components.length, om.records.length, om.records[0].resultText], [0, 1, '成功'])
  eq('表頭不對 → 丟錯，不是靜默匯 0 筆', (() => { try { parseReleaseSheet([['a', 'b']] as never); return 'no-throw' } catch { return 'throw' } })(), 'throw')

  const db = fresh()
  const r1 = applyParsedSheet(db, { sheetKey: 'S:1', tabTitle: 'OSM', parsed: p, actor: '匯入' })
  eq('第一次匯入 3 筆', [r1.tabId, r1.added, r1.skipped], ['osm', 3, 0])
  eq('表上沒有的狀態自動建', listStatuses(db).some(s => s.name === '新狀態'), true)
  const r2 = applyParsedSheet(db, { sheetKey: 'S:1', tabTitle: 'OSM', parsed: p, actor: '匯入' })
  eq('重跑不重複', [r2.added, r2.skipped, listReleases(db).length], [0, 3, 3])
  eq('元件不重複建', listComponents(db).length, 3)
  eq('匯入的紀錄履歷標成 import', listRevisions(db, listReleases(db)[0].id)[0].action, 'import')
  const first = listReleases(db).find(r => r.content.includes('第一筆'))!
  eq('匯入的值寫對元件', first.values.map(v => [listComponents(db).find(c => c.id === v.componentId)!.name, v.state, v.version]),
    [['H5新 前端', 'updated', '1.5.0'], ['Center服', 'unchanged', ''], ['LL服務', 'na', '']])
}

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) { for (const f of fails) console.log('  ' + f); process.exit(1) }
