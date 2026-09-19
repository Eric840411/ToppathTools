/**
 * scripts/ui-checks/ui-screenshot-report.mjs
 *
 * 驗解析度驗收報告的資料整理（`server/lib/ui-screenshot-report.ts`）。
 *
 * ⚠️ **這裡守的是「報告有沒有把東西藏起來」。**報告最危險的壞法不是排版跑掉，
 *    而是**某一格悄悄消失**或**被歸到錯的桶子**——畫面上看起來一切正常，
 *    但你以為拍過的那個尺寸其實沒拍到。
 *
 * 跑法：npx tsx scripts/ui-checks/ui-screenshot-report.mjs
 */
import path from 'path'
import { pathToFileURL, fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const { buildReportModel, renderReportHtml, toneOf } = await import(
  pathToFileURL(path.join(root, 'server/lib/ui-screenshot-report.ts')).href)

const RES = ['375x667', '390x844', '412x915']
const RUN = { id: 'run-1234abcd', agent_id: 'PC-1', started_at: 1_700_000_000_000, finished_at: 1_700_000_600_000, options: { autoPickByGame: true } }

const TASKS = [
  { gmid: '__LOBBY__', resolution: '375x667', status: 'ok', actual_gmid: '__LOBBY__' },
  { gmid: '__LOBBY__', resolution: '390x844', status: 'ok', actual_gmid: '__LOBBY__' },
  { gmid: '__FEATURE__/會員卡', resolution: '375x667', status: 'ok', actual_gmid: '' },
  { gmid: 'JJBX / Endless Treasure', resolution: '375x667', status: 'ok', actual_gmid: '4175-JJBX-0001' },
  { gmid: 'JJBX / Endless Treasure', resolution: '390x844', status: 'popup', actual_gmid: '4175-JJBX-0001', error_msg: '進場時出現提示：ERR_NETWORK' },
  // 412x915 這一格**沒有任務**：報告必須自己補成「未拍」，不可以讓它消失
  { gmid: 'BZZF / Red Festival', resolution: '375x667', status: 'ok', actual_gmid: '4175-BZZF-0001' },
  { gmid: 'BZZF / Red Festival', resolution: '390x844', status: 'ok', actual_gmid: '4175-BZZF-0002' },
  { gmid: 'BZZF / Red Festival', resolution: '412x915', status: 'ok', actual_gmid: '4175-BZZF-0002' },
]

const ASSERTS = [
  ['狀態對到色調：popup 是 warn，不是 ok 也不是 err', f => {
    const m = f(RUN, TASKS, RES)
    const g = m.groups.find(x => x.name === 'Endless Treasure')
    return toneOf('popup') === 'warn' && g.counts.warn === 1 && g.counts.ok === 1
  }],
  ['缺的解析度要補成「未拍」，不可以整格消失', f => {
    const g = f(RUN, TASKS, RES).groups.find(x => x.name === 'Endless Treasure')
    const cell = g.cells.find(c => c.resolution === '412x915')
    return g.cells.length === RES.length && cell && cell.tone === 'skip'
  }],
  ['每一列的格子順序跟解析度清單一致', f => {
    const g = f(RUN, TASKS, RES).groups.find(x => x.name === 'Red Festival')
    return g.cells.map(c => c.resolution).join(',') === RES.join(',')
  }],
  // ⚠️ 這條原本只驗「第一個是 lobby」，字母排序時 `__LOBBY__` 剛好也排第一，
  //    所以「改成字母排序」那個突變體活了下來。改成驗整串順序才守得住。
  ['分段順序必須是 lobby → feature → model', f => {
    const kinds = f(RUN, TASKS, RES).groups.map(g => g.kind)
    return kinds.join(',') === ['lobby', 'feature', 'model', 'model'].join(',')
  }],
  ['有問題的組排在乾淨的組前面', f => {
    const models = f(RUN, TASKS, RES).groups.filter(g => g.kind === 'model')
    return models[0].name === 'Endless Treasure' && models[0].flagged === true
  }],
  ['換過台要收集所有實際機台且去重', f => {
    const g = f(RUN, TASKS, RES).groups.find(x => x.name === 'Red Festival')
    return g.machines.length === 2 && g.machines[0] === '4175-BZZF-0001' && g.machines[1] === '4175-BZZF-0002'
  }],
  ['大廳不把 __LOBBY__ 當成機台號', f => {
    const g = f(RUN, TASKS, RES).groups.find(x => x.kind === 'lobby')
    return g.machines.length === 0
  }],
  ['總計＝各桶相加，而且等於格子總數', f => {
    const m = f(RUN, TASKS, RES)
    const cells = m.groups.reduce((n, g) => n + g.cells.length, 0)
    return m.totals.shots === m.totals.ok + m.totals.warn + m.totals.err + m.totals.skip
      && m.totals.shots === cells
  }],
  ['錯誤提示要帶進報告（不能只留狀態）', f => {
    const g = f(RUN, TASKS, RES).groups.find(x => x.name === 'Endless Treasure')
    return g.cells.some(c => c.note.includes('ERR_NETWORK'))
  }],
  ['HTML 有跳脫：帶引號或標籤的名稱不會破版', f => {
    const evil = [{ gmid: 'X / "><script>alert(1)</script>', resolution: '375x667', status: 'ok', actual_gmid: 'a' }]
    const html = renderReportHtml(f(RUN, evil, ['375x667']), { imgUrl: () => 'x.png', generatedAt: Date.now() })
    return !html.includes('<script>alert(1)</script>') && html.includes('&lt;script&gt;')
  }],
  ['未拍的格子不產生圖片連結', f => {
    const html = renderReportHtml(f(RUN, TASKS, RES), { imgUrl: () => 'shot.png', generatedAt: Date.now() })
    // 4 組 × 3 格 = 12 格；大廳缺 1、功能頁缺 2、Endless 缺 1 → 8 張圖
    return (html.match(/<img /g) ?? []).length === 8
  }],
]

let pass = 0, fail = 0
console.log('— 本體 —')
for (const [name, run] of ASSERTS) {
  let ok = false
  try { ok = run(buildReportModel) === true } catch (e) { ok = false; console.log(`    (throw) ${e.message}`) }
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
  ok ? pass++ : fail++
}

const MUTANTS = [
  ['M1 popup 併進 ok（「有東西蓋住」被當成乾淨）', (run, tasks, res) =>
    buildReportModel(run, tasks.map(t => ({ ...t, status: t.status === 'popup' ? 'ok' : t.status })), res),
  '狀態對到色調：popup 是 warn，不是 ok 也不是 err'],
  ['M2 缺的解析度不補（那一格直接消失）', (run, tasks, res) => {
    const m = buildReportModel(run, tasks, res)
    for (const g of m.groups) g.cells = g.cells.filter(c => c.status !== 'skipped' || tasks.some(t => t.gmid === g.key && t.resolution === c.resolution))
    return m
  }, '缺的解析度要補成「未拍」，不可以整格消失'],
  ['M3 分段順序改成字母排序（大廳被埋進機台裡）', (run, tasks, res) => {
    const m = buildReportModel(run, tasks, res)
    m.groups.sort((a, b) => a.key.localeCompare(b.key))
    return m
  }, '分段順序必須是 lobby → feature → model'],
  ['M4 換台紀錄只留最後一台', (run, tasks, res) => {
    const m = buildReportModel(run, tasks, res)
    for (const g of m.groups) g.machines = g.machines.slice(-1)
    return m
  }, '換過台要收集所有實際機台且去重'],
  ['M5 乾淨的組排前面（要處理的沉到最底下）', (run, tasks, res) => {
    const m = buildReportModel(run, tasks, res)
    m.groups.sort((a, b) => Number(a.flagged) - Number(b.flagged))
    return m
  }, '有問題的組排在乾淨的組前面'],
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
