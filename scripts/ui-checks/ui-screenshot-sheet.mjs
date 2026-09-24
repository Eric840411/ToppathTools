/**
 * scripts/ui-checks/ui-screenshot-sheet.mjs
 *
 * 驗「自動建 Lark Sheet」的版面（`server/lib/ui-screenshot-sheet.ts`）：哪張圖放哪一格。
 *
 * ⚠️ 這裡守的是**錯列**跟**說謊**：
 *    - 同一個 model 跨尺寸換台，圖必須跟著實際機台走，不能擠在同一列（gmid 會對不上圖）
 *    - 「失敗」「未拍」「未取得機台號」意思不同，不能互相冒充
 *    - 不能有任務默默消失
 *
 * 跑法：npx tsx scripts/ui-checks/ui-screenshot-sheet.mjs
 */
import path from 'path'
import { pathToFileURL, fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const { buildSheetLayout, SHEET_FAIL_TEXT, SHEET_NOT_SHOT_TEXT, NO_MACHINE_SUFFIX } = await import(
  pathToFileURL(path.join(root, 'server/lib/ui-screenshot-sheet.ts')).href)

const RES = ['375x667', '412x915']
let n = 0
const T = (gmid, resolution, status, actual_gmid = '') => ({ id: `t${++n}`, gmid, resolution, status, actual_gmid })

const TASKS = [
  T('__LOBBY__', '375x667', 'ok', '__LOBBY__'),
  T('__LOBBY__', '412x915', 'err', '__LOBBY__'),
  // 同一個 model 跨尺寸換台：375 拍在 0001、412 被搶台換到 0002
  T('BZZF / Red Festival', '375x667', 'ok', '4175-BZZF-0001'),
  T('BZZF / Red Festival', '412x915', 'popup', '4175-BZZF-0002'),
  // 拿到機台號之前就失敗
  T('JJBX / Endless', '375x667', 'err', ''),
  T('JJBX / Endless', '412x915', 'ok', '4175-JJBX-0009'),
  // 直接指定機台號，失敗了也知道是哪台
  T('4175-ABC-0001', '375x667', 'timeout', ''),
  T('4175-ABC-0001', '412x915', 'ok', '4175-ABC-0001'),
  // 同台同尺寸重拍過：失敗那筆不能蓋掉成功那筆（順序刻意放成成功在前）
  T('4175-DUP-0001', '375x667', 'ok', '4175-DUP-0001'),
  T('4175-DUP-0001', '375x667', 'err', '4175-DUP-0001'),
]

const L = buildSheetLayout(TASKS, RES)
const row = label => L.rows.find(r => r.label === label)
const cell = (label, res) => row(label)?.cells[RES.indexOf(res)]
const isImg = (c, id) => c?.kind === 'image' && (!id || c.taskId === id)
const isText = (c, text) => c?.kind === 'text' && c.text === text

const ASSERTS = [
  ['表頭是 gmid＋各尺寸', () => JSON.stringify(L.header) === JSON.stringify(['gmid', ...RES])],
  ['換台：兩台各自一列，圖跟著實際機台', () =>
    isImg(cell('4175-BZZF-0001', '375x667'), 't3') && isImg(cell('4175-BZZF-0002', '412x915'), 't4')],
  ['換台：沒安排拍的那格寫「未拍」不是「失敗」', () =>
    isText(cell('4175-BZZF-0001', '412x915'), SHEET_NOT_SHOT_TEXT) && isText(cell('4175-BZZF-0002', '375x667'), SHEET_NOT_SHOT_TEXT)],
  ['不能出現「遊戲 / model」當 gmid 的列（除了標示未取得機台號的）', () =>
    L.rows.every(r => !r.label.includes('/') || r.label.endsWith(NO_MACHINE_SUFFIX))],
  ['未取得機台號：保留原目標並標示，格子寫「失敗」', () =>
    isText(cell(`JJBX / Endless${NO_MACHINE_SUFFIX}`, '375x667'), SHEET_FAIL_TEXT) && L.noMachine === 1],
  ['未取得機台號：不能被塞進同 model 別台那列', () => !isText(cell('4175-JJBX-0009', '375x667'), SHEET_FAIL_TEXT)],
  ['指定機台號失敗：列名就是那台', () => isText(cell('4175-ABC-0001', '375x667'), SHEET_FAIL_TEXT) && isImg(cell('4175-ABC-0001', '412x915'))],
  ['popup 照放圖', () => isImg(cell('4175-BZZF-0002', '412x915'))],
  ['大廳：失敗寫「失敗」', () => isText(cell('大廳', '412x915'), SHEET_FAIL_TEXT) && isImg(cell('大廳', '375x667'))],
  ['重拍：失敗那筆不蓋掉成功的', () => isImg(cell('4175-DUP-0001', '375x667'), 't9')],
  ['沒有空格（空白看起來像漏傳）', () => L.rows.every(r => r.cells.length === RES.length && r.cells.every(Boolean))],
  ['每一筆有圖的任務都在表上，不會消失', () => {
    const placed = new Set(L.rows.flatMap(r => r.cells.filter(c => c.kind === 'image').map(c => c.taskId)))
    return TASKS.filter(t => t.status === 'ok' || t.status === 'popup').every(t => placed.has(t.id) || t.id === 't9' || t.id === 't10')
  }],
  ['每一筆沒圖的任務也都看得到（失敗格指回它）', () => {
    const shown = new Set(L.rows.flatMap(r => r.cells.map(c => c.taskId)))
    return TASKS.filter(t => !['ok', 'popup'].includes(t.status) && t.id !== 't10').every(t => shown.has(t.id))
  }],
  ['大廳排在最前面', () => L.rows[0].label === '大廳'],
]

let fail = 0
for (const [name, fn] of ASSERTS) {
  let ok = false
  try { ok = !!fn() } catch (e) { console.log(`  (例外) ${e.message}`) }
  console.log(`${ok ? '✅' : '❌'} ${name}`)
  if (!ok) fail++
}
console.log(`\n${ASSERTS.length - fail}/${ASSERTS.length} 通過`)
if (fail) { console.log(JSON.stringify(L, null, 1)); process.exit(1) }
