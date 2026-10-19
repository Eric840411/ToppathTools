/**
 * 「步驟存進去、讀回來、送去執行，欄位一個都不能少」。
 *
 *   npx tsx scripts/ui-checks/step-model-roundtrip.test.ts
 *
 * 🚨 1007 claude-osm-2 回報：step-model 的 normalizeOne／cleanStep 原本是白名單，沒列到的欄位一律默默丟掉——
 *    從畫面按「執行」的步驟少了 from（assert_row_match 失敗）、reason（require_precondition 失敗）、
 *    settleMs（goto 的 0 變回 3 秒，載入畫面截不到）…；畫面上一存檔也會把 API 寫進去的欄位清掉。
 *
 * 守的是：每一種 action、AutoStep 的**每一個**欄位都填上，經過
 *   ① parseSteps（讀）② serializeSteps → parseSteps（存再讀）③ compileExecutableSteps（送去執行）
 * 都原封不動。另外放一個型別沒有的欄位（未來新增的），也要原封不動——白名單擋不住的就是這種。
 */
import { deepStrictEqual } from 'node:assert'
import { STEP_LIBRARY, parseSteps, serializeSteps, compileExecutableSteps } from '../../src/features/uat/step-model.ts'
import type { AutoStep } from '../../src/features/uat/types.ts'
import { runFrontendStep } from '../../server/uat-runner/frontend-engine.js'

let fail = 0, n = 0
const ok = (c: boolean, label: string, got?: unknown) => { n++; if (!c) fail++; if (!c) console.log(`❌ ${label}${got !== undefined ? `：${JSON.stringify(got).slice(0, 400)}` : ''}`) }
const eq = (a: unknown, b: unknown) => { try { deepStrictEqual(a, b); return true } catch { return false } }

// AutoStep 的每一個欄位（collapsed 是畫面狀態，刻意不存；children 只給容器）
const FULL: Omit<AutoStep, 'id' | 'name' | 'action' | 'children' | 'collapsed'> & Record<string, unknown> = {
  value: 'v', selector: '#a', x: 1, y: 2, baselineId: 'b1', threshold: 0.9, scrollStep: 300, maxScrolls: 5, retryCount: 2, failureMode: 'continue',
  tcId: 'rec1', snippetId: 'sn1', urlPattern: '/api/*', expectStatus: 'exact', statusCode: 201, minCount: 2,
  from: 'jp.rows', minAdvanceSec: 2, settleMs: 0, as: 'amount', overwrite: true, pattern: 'less than (\\d+)', expect: 'after - bet',
  tolerancePct: 1, absoluteTolerance: 0.5, until: 'text', timeoutMs: 15000, nodeName: 'lbl-coin', matchMode: 'number',
  allowDangerous: true, reason: '要先開活動（找營運）', selectorStrategy: 'testid', selectorCheck: 'ok', selectorCheckReason: 'shadow',
  key: 'Space', futureField: { a: [1, 2] },
  // 1015 長按／拖動
  fromSelector: '.chest', toSelector: '.slot', fromX: 10, fromY: 20, toX: 30, toY: 40, holdMs: 800, durationMs: 600, moveSteps: 12,
  // 1019 read_value 數個數、scroll 對齊頂端
  readMode: 'count', align: 'start',
}
for (const def of STEP_LIBRARY) {
  const isContainer = def.action === 'group' || def.action === 'repeat'
  const child: AutoStep = { id: `c-${def.action}`, name: '子步驟', action: 'click', ...FULL } as AutoStep
  const step = { id: `s-${def.action}`, name: def.label, action: def.action, ...FULL, ...(isContainer ? { children: [child] } : {}) } as AutoStep
  const steps = [step]
  const read = parseSteps(JSON.stringify(steps))
  ok(eq(read, steps), `${def.action}：讀進來欄位不變`, read)
  const again = parseSteps(serializeSteps(read))
  ok(eq(again, steps), `${def.action}：存檔再讀回欄位不變`, again)
  if (!isContainer) {
    const exec = compileExecutableSteps(read)
    ok(eq(exec, [{ ...step, children: undefined }]), `${def.action}：送去執行的欄位不變`, exec)
  }
}

// 型別檢查仍然有效：已知欄位型別不對就丟掉，failureMode 不認得就退回 inherit
const bad = parseSteps(JSON.stringify([{ id: 'x', name: 'n', action: 'goto', settleMs: '0', from: 5, failureMode: 'weird', until: 'later', overwrite: 'yes' }]))[0] as unknown as Record<string, unknown>
ok(!('settleMs' in bad) && !('from' in bad) && !('until' in bad) && !('overwrite' in bad) && bad.failureMode === 'inherit', '型別不對的已知欄位 → 丟掉', bad)
// 1015 長按／拖動的範圍：超出範圍原樣保留（執行器會擋）；邊界值留著；型別不對照舊丟掉
const g = parseSteps(JSON.stringify([
  { id: 'g1', name: 'n', action: 'drag', holdMs: -1, durationMs: 10001, moveSteps: 0 },
  { id: 'g2', name: 'n', action: 'drag', holdMs: 0, durationMs: 10000, moveSteps: 60, fromX: '5' },
  { id: 'g3', name: 'n', action: 'long_press', selector: '.spin' },
])) as unknown as Record<string, unknown>[]
ok(g[0].holdMs === -1 && g[0].durationMs === 10001 && g[0].moveSteps === 0, '手勢欄位超出範圍 → 原樣保留（交給執行器報錯，不在載入時換成預設）', g[0])
ok(g[1].holdMs === 0 && g[1].durationMs === 10000 && g[1].moveSteps === 60 && !('fromX' in g[1]), '手勢欄位邊界值保留、座標型別不對丟掉', g[1])
ok(g[2].holdMs === 1500, '長按沒填按住毫秒 → 預設 1500', g[2])
// 原本的整理行為不變：字串去頭尾空白、空的不存、collapsed 不存
const tidy = JSON.parse(serializeSteps([{ id: 'y', name: ' n ', action: 'click', selector: '  #a  ', value: '   ', collapsed: true, failureMode: 'inherit' }]))[0]
ok(tidy.selector === '#a' && !('value' in tidy) && !('collapsed' in tidy) && !('failureMode' in tidy) && tidy.name === 'n', '整理：去空白、空值不存、collapsed 不存', tidy)
// fill → type、title → name（舊格式）
const legacy = parseSteps(JSON.stringify([{ action: 'fill', title: '舊標題', value: 'x' }]))[0]
ok(legacy.action === 'type' && legacy.name === '舊標題', '舊格式 fill／title 照舊轉換', legacy)

// 編輯器載入 → 送去執行：超範圍的 holdMs 不能在載入時被換成預設 1500，執行器要真的擋下來（CodeX review 011f6fe [P2]）
// 欄位驗證在碰頁面之前，所以給一個空的 page 就夠（真的碰到頁面會丟別的錯，這條就會紅）
for (const bad of [{ action: 'long_press', selector: '#spin', holdMs: 20000 }, { action: 'drag', fromX: 1, fromY: 1, toX: 9, toY: 9, moveSteps: 0 }]) {
  const [loaded] = compileExecutableSteps(parseSteps(JSON.stringify([{ id: 'l1', name: 'n', ...bad }]))) as unknown as Record<string, unknown>[]
  let msg = ''
  try { await runFrontendStep(loaded, { idx: '', label: '', log: () => {}, page: {}, startUrl: 'http://qat/' }) } catch (e) { msg = e instanceof Error ? e.message : String(e) }
  const key = 'holdMs' in bad ? 'holdMs' : 'moveSteps'
  ok(loaded[key] === (bad as Record<string, unknown>)[key] && msg.includes(key), `${bad.action}：載入→執行，${key} 超範圍照樣擋（沒被載入改掉）`, { loaded: loaded[key], msg })
}

// 1019 read_value 數個數：0 個是合法值、存成字串可以進算式；不認得的 readMode 載入時**原樣保留**、交給執行器擋
//    （CodeX review 7d71596 [P2]：原本載入時刪掉，'Count' 就退回讀文字、繞過執行器的擋）
const rm = parseSteps(JSON.stringify([{ id: 'r1', name: 'n', action: 'read_value', selector: '.a', as: 'x', readMode: 'Count' }]))[0] as unknown as Record<string, unknown>
ok(rm.readMode === 'Count', 'readMode 不認得的值 → 載入時原樣保留', rm)
const rmBadType = parseSteps(JSON.stringify([{ id: 'r2', name: 'n', action: 'read_value', selector: '.a', as: 'x', readMode: 1 }]))[0] as unknown as Record<string, unknown>
ok(!('readMode' in rmBadType), 'readMode 型別不對 → 丟掉', rmBadType)
const countPage = (counts: Record<string, number>) => ({ locator: (sel: string) => ({ count: async () => counts[sel] ?? 0 }) })
const runRead = async (step: Record<string, unknown>, page: unknown, state: { vars?: Record<string, unknown> } = {}) => {
  let msg = ''
  try { await runFrontendStep({ id: 'r', name: 'n', action: 'read_value', ...step }, { idx: '', label: '', log: () => {}, page, state, startUrl: 'http://qat/' }) } catch (e) { msg = e instanceof Error ? e.message : String(e) }
  return { msg, vars: state.vars ?? {} }
}
{
  const r0 = await runRead({ selector: '.fav.active', as: 'before', readMode: 'count' }, countPage({}))
  ok(r0.msg === '' && r0.vars.before === '0', '數個數：0 個不失敗、存 "0"', r0)
  const r1 = await runRead({ selector: '.fav.active', as: 'after', readMode: 'count' }, countPage({ '.fav.active': 1 }))
  ok(r1.msg === '' && r1.vars.after === '1', '數個數：1 個存 "1"', r1)
  const bad1 = await runRead({ nodeName: 'lb', as: 'x', readMode: 'count' }, countPage({}))
  ok(bad1.msg.includes('只支援 DOM'), '數個數：填 Cocos 節點名 → 擋', bad1.msg)
  const bad2 = await runRead({ selector: '.a', pattern: '(\\d+)', as: 'x', readMode: 'count' }, countPage({ '.a': 2 }))
  ok(bad2.msg.includes('只取一段'), '數個數：搭配只取一段 → 擋', bad2.msg)
  const bad3 = await runRead({ selector: '.a', as: 'x', readMode: 'Count' }, countPage({ '.a': 2 }))
  ok(bad3.msg.includes('readMode'), '執行器：readMode 打錯 → 擋，不當成讀文字', bad3.msg)
  // 編輯器載入 → 送去執行 → 執行器擋（換回「載入時刪掉」的寫法，這條會因為退回讀文字而紅）
  const [loadedRm] = compileExecutableSteps(parseSteps(JSON.stringify([{ id: 'r3', name: 'n', action: 'read_value', selector: '.a', as: 'x', readMode: 'Count' }]))) as unknown as Record<string, unknown>[]
  const bad4 = await runRead(loadedRm, countPage({ '.a': 2 }))
  ok(bad4.msg.includes('readMode'), 'readMode 打錯：載入→執行，照樣被執行器擋', bad4.msg)
  const dup = await runRead({ selector: '.a', as: 'x', readMode: 'count' }, countPage({ '.a': 2 }), { vars: { x: '1' } })
  ok(dup.msg.includes('重複'), '數個數：同名變數沒勾覆寫 → 擋（沿用讀文字的規則）', dup.msg)
}

// 1019 scroll align：打錯字載入時保留、執行器在碰頁面之前就擋（不默默當成置中）；start 會傳進 scrollIntoView
{
  const [loadedAl] = compileExecutableSteps(parseSteps(JSON.stringify([{ id: 'a1', name: 'n', action: 'scroll', selector: '.sec', align: 'Start' }]))) as unknown as Record<string, unknown>[]
  ok(loadedAl.align === 'Start', 'align 不認得的值 → 載入時原樣保留', loadedAl)
  let msg = ''
  try { await runFrontendStep(loadedAl, { idx: '', label: '', log: () => {}, page: {}, startUrl: 'http://qat/' }) } catch (e) { msg = e instanceof Error ? e.message : String(e) }
  ok(msg.includes('align'), 'align 打錯：載入→執行，執行器擋', msg)
  // 頁面端：記下 scrollIntoView 收到的參數（evaluate 直接在 node 端跑那個函式，給假的 document）
  const calls: unknown[] = []
  const fakeDoc = { querySelector: () => ({ scrollIntoView: (o: unknown) => calls.push(o) }) }
  const fakePage = { evaluate: async (fn: (a: unknown) => unknown, arg: unknown) => { const g = globalThis as Record<string, unknown>; const prev = g.document; g.document = fakeDoc; try { return fn(arg) } finally { g.document = prev } }, waitForTimeout: async () => {} }
  for (const [align, want] of [['start', 'start'], [undefined, 'center']] as const) {
    calls.length = 0
    let err = ''
    try { await runFrontendStep({ id: 'a2', name: 'n', action: 'scroll', selector: '.sec', ...(align ? { align } : {}) }, { idx: '', label: '', log: () => {}, page: fakePage, startUrl: 'http://qat/' }) } catch (e) { err = e instanceof Error ? e.message : String(e) }
    ok(err === '' && eq(calls, [{ block: want }]), `scroll align=${align ?? '(預設)'} → scrollIntoView block:${want}`, { err, calls })
  }
  // 捲動量填 '0' 不是留空：走相對捲動，不能誤走「捲進畫面」（CodeX 審 5ce8df3 要的邊界）
  calls.length = 0
  let err0 = ''
  try { await runFrontendStep({ id: 'a3', name: 'n', action: 'scroll', selector: '.sec', value: '0', align: 'start' }, { idx: '', label: '', log: () => {}, page: fakePage, startUrl: 'http://qat/' }) } catch (e) { err0 = e instanceof Error ? e.message : String(e) }
  ok(err0 === '' && calls.length === 0, "scroll 捲動量 '0' → 相對捲動，不呼叫 scrollIntoView", { err0, calls })
}

// 1019 H5 click 找不到就跳過：0 個 → 回 skipped、不點；有 → 照常走點擊（這裡用假頁面，點擊路徑會丟別的錯，證明沒被跳過）
{
  const clicks: string[] = []
  const skipPage = (n: number) => ({
    url: () => 'http://qat/lobby',
    locator: () => ({ count: async () => n }),
    waitForTimeout: async () => {},
  })
  const run = async (n: number, extra: Record<string, unknown> = {}) => {
    let msg = ''; let out: unknown
    try { out = await runFrontendStep({ id: 'k', name: 'n', action: 'click', selector: '.box-btn_text2', skipIfMissing: true, ...extra }, { idx: '', label: '', log: () => {}, page: skipPage(n), startUrl: 'http://qat/', state: {}, recordedLocator: async () => { clicks.push('resolved'); throw new Error('reached-click') } }) } catch (e) { msg = e instanceof Error ? e.message : String(e) }
    return { msg, out: out as { skipped?: string } | undefined }
  }
  const r0 = await run(0)
  ok(r0.msg === '' && !!r0.out?.skipped && clicks.length === 0, 'H5 click 找不到就跳過：0 個 → skipped、沒有去點', r0)
  const r1 = await run(1)
  ok(r1.msg === 'reached-click', 'H5 click 找不到就跳過：有 1 個 → 照常走點擊路徑', r1.msg)
  const r2 = await run(0, { skipIfMissing: undefined })
  ok(r2.msg === 'reached-click', 'H5 click 沒勾跳過：0 個也照常走點擊（交給點擊報錯）', r2.msg)
}

console.log(fail ? `❌ ${fail}/${n} 失敗` : `✅ ${n}/${n} 通過`)
process.exit(fail ? 1 : 0)
