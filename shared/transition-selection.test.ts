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

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) { console.log(fails.join('\n')); process.exit(1) }
