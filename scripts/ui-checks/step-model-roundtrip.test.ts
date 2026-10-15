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

console.log(fail ? `❌ ${fail}/${n} 失敗` : `✅ ${n}/${n} 通過`)
process.exit(fail ? 1 : 0)
