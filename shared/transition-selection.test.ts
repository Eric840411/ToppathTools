/**
 * shared/transition-selection 的測試。跑法：npx tsx shared/transition-selection.test.ts
 * 守的是「畫面上看不到的目標不能送」（CodeX review a9d923c）。
 */
import { submitBlockReason, targetAfterReload } from './transition-selection.js'

let pass = 0
const fails: string[] = []
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) }
  else { fails.push(`${name} | got: ${g} | want: ${w}`); console.log(`❌ ${name} | got: ${g} | want: ${w}`) }
}

const P5MA = [{ toId: '10252' }, { toId: '10207' }]

// ── 重讀之後的目標 ──
eq('重讀成功、目標還在 → 保留', targetAfterReload('10252', { ok: true, transitions: P5MA }), '10252')
eq('重讀成功、目標不在新選項裡（換了專案）→ 不切換', targetAfterReload('15896', { ok: true, transitions: P5MA }), '')
eq('🔒 重讀失敗 → 不切換（不能留著畫面看不到的舊目標）', targetAfterReload('10252', { ok: false }), '')
eq('本來就不切換 → 還是不切換', targetAfterReload('', { ok: true, transitions: P5MA }), '')

// ── 能不能送 ──
eq('不切換永遠可以送', submitBlockReason({ target: '', firstSelectedKey: 'P5MA-1', sourceKey: 'CGFB-1', loading: true }), null)
eq('選了目標、選項依目前首張讀完 → 可以送', submitBlockReason({ target: '10252', firstSelectedKey: 'P5MA-1', sourceKey: 'P5MA-1', loading: false }), null)
eq('🔒 重讀中 → 擋', submitBlockReason({ target: '10252', firstSelectedKey: 'P5MA-1', sourceKey: 'P5MA-1', loading: true }) !== null, true)
eq('🔒 首張換了、選項還是舊的那張讀的 → 擋', submitBlockReason({ target: '15896', firstSelectedKey: 'P5MA-1', sourceKey: 'CGFB-1', loading: false }) !== null, true)
eq('🔒 重讀失敗（來源被清空）但目標還在 → 擋', submitBlockReason({ target: '10252', firstSelectedKey: 'P5MA-1', sourceKey: '', loading: false }) !== null, true)

// ── effect 生命週期（CodeX review 8ec8730：A→B→A 讓 loading 卡在 true）──
// 迷你版 React：狀態放物件裡，每次 render 依依賴判斷要不要「先跑上一輪 cleanup、再跑新的 effect」
{
  const { startTransitionReload } = await import('./transition-selection.js')
  type Opt = { id: string; name: string; toId?: string; toName?: string }
  const state = { transitions: [] as Opt[], sourceKey: '', target: '', loading: false }
  const pending = new Map<string, (v: { ok: boolean; transitions?: Opt[] }) => void>()
  const fetchTransitions = (key: string) => new Promise<{ ok: boolean; transitions?: Opt[] }>(resolve => { pending.set(key, resolve) })
  let cleanup: (() => void) | null = null
  let lastDeps = ''
  const render = (firstKey: string) => {
    const deps = `${firstKey}|me@x|${state.sourceKey}`
    if (deps === lastDeps) return
    lastDeps = deps
    cleanup?.()
    cleanup = startTransitionReload({ firstKey, email: 'me@x', sourceKey: state.sourceKey }, fetchTransitions, {
      transitions: l => { state.transitions = l }, sourceKey: k => { state.sourceKey = k },
      target: f => { state.target = f(state.target) }, loading: b => { state.loading = b },
    })
  }
  const settle = () => new Promise(r => setTimeout(r, 0))
  const A = [{ id: '7', name: '本機測試完成', toId: '10252', toName: '本機測試完成' }]
  const B = [{ id: '4', name: '本機測試完成', toId: '15896', toName: '本機測試完成' }]

  render('P5MA-1'); pending.get('P5MA-1')!({ ok: true, transitions: A }); await settle(); render('P5MA-1')
  state.target = '10252'
  eq('生命週期：A 讀好、選了目標', [state.sourceKey, state.target, state.loading], ['P5MA-1', '10252', false])
  render('CGFB-1')                                   // 切到 B，開始讀
  eq('生命週期：切到 B → 讀取中、擋送出', [state.loading, submitBlockReason({ target: state.target, firstSelectedKey: 'CGFB-1', sourceKey: state.sourceKey, loading: state.loading }) !== null], [true, true])
  render('P5MA-1')                                   // B 回來前切回 A
  pending.get('CGFB-1')!({ ok: true, transitions: B }); await settle(); render('P5MA-1')   // B 遲到的回應
  eq('🔒 生命週期：A→B→A 之後 loading 不能卡在 true', state.loading, false)
  eq('生命週期：B 遲到的回應被丟掉，選項與目標仍是 A 的', [state.sourceKey, state.target, state.transitions[0]?.toId], ['P5MA-1', '10252', '10252'])
  eq('生命週期：回到 A 後可以送出', submitBlockReason({ target: state.target, firstSelectedKey: 'P5MA-1', sourceKey: state.sourceKey, loading: state.loading }), null)
}

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) { console.log(fails.join('\n')); process.exit(1) }
