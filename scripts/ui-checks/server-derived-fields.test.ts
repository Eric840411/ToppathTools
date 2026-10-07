/**
 * UAT 執行入口：server 才能產生的欄位，不可以相信前端／API 帶進來的值（CodeX af25442 審查 P2）。
 *
 *   npx tsx scripts/ui-checks/server-derived-fields.test.ts
 *
 * 前端 step-model 改成保留所有欄位之後（v5.30.5），畫面路徑也能把 baselineUrl 帶進來——agent 會直接 fetch 那個網址；
 * snippetSteps 帶進來的話會照著跑。所以執行入口要先清掉，再從 DB 重建。
 * 這支驗：① 清理函式本身（含巢狀 children）② 執行入口真的有呼叫它，而且在 resolveBackendSnippets 之前
 */
import { readFileSync } from 'node:fs'
import { stripServerDerivedFields, SERVER_DERIVED_STEP_FIELDS } from '../../server/routes/frontend-step-sanitize.ts'

let fail = 0, n = 0
const ok = (c: boolean, label: string, got?: unknown) => { n++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${got !== undefined && !c ? `：${JSON.stringify(got)}` : ''}`) }

const evil = { baselineUrl: 'http://attacker.example/x.png', baselineName: 'x', baselineThreshold: 0.99, snippetSteps: [{ action: 'click', selector: '.danger' }], snippetTitle: 'fake' }
const steps = [
  { id: 'a', action: 'find_baseline_scroll', baselineId: 'b1', ...evil },
  { id: 'b', action: 'backend_snippet', snippetId: 's1', ...evil },
  { id: 'c', action: 'group', children: [{ id: 'c1', action: 'click', selector: '#ok', ...evil }] },
]
const out = stripServerDerivedFields(steps) as Array<Record<string, unknown>>
const has = (o: Record<string, unknown>) => SERVER_DERIVED_STEP_FIELDS.filter(k => k in o)
ok(out.every(s => has(s).length === 0), '每一顆的 server 衍生欄位都清掉', out.map(has))
ok(has((out[2].children as Array<Record<string, unknown>>)[0]).length === 0, '巢狀 children 也清掉')
ok(out[0].baselineId === 'b1' && out[1].snippetId === 's1' && (out[2].children as Array<Record<string, unknown>>)[0].selector === '#ok', '其他欄位（baselineId／snippetId／selector）保留')
ok('baselineUrl' in steps[0], '不改到原本的物件（回新的）')

// 執行入口真的有用，而且在 resolveBackendSnippets 之前（之後才清的話會把 server 剛補上的 snippetSteps 也清掉）
const src = readFileSync('server/routes/frontend-auto.ts', 'utf8')
ok(/resolveBackendSnippets\(stripServerDerivedFields\(/.test(src), '執行入口：先清再解析後台片段')

console.log(fail ? `❌ ${fail}/${n} 失敗` : `✅ ${n}/${n} 通過`)
process.exit(fail ? 1 : 0)
