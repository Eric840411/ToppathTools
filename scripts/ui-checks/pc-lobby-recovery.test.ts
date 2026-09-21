/**
 * PC 大廳沒建出來時的補救決策。
 *
 *   npx tsx scripts/ui-checks/pc-lobby-recovery.test.ts
 *
 * 🚨 **這支存在的理由**：`reload 一次再等` 那條分支是照一次現場觀察補上的防禦性程式碼，
 *    從補上到現在**沒有任何一次執行走進去過**。沒走過的分支等於沒被驗證——
 *    它可能少一個條件、可能順序反了，而症狀只會在下次現場壞掉時才出現。
 *
 * ⚠️ **這支證明的是決策，不是療效**：證明「在這些狀態下會選 reload / 退出 / 放棄」，
 *    **不證明 reload 真的能把卡住的大廳救回來**。後者只能在真的客戶端上量，
 *    那是 `pc-lobby-reload.mjs` 的工作。兩件事不要混為一談。
 */
import { pcLobbyRecoveryPlan } from '../../server/lib/pc-cocos.js'

let pass = 0
const fails: string[] = []
const eq = (name: string, got: unknown, want: unknown) => {
  if (got === want) { pass++; console.log('✅ ' + name) }
  else { fails.push(name); console.log(`❌ ${name} | got: ${got} | want: ${want}`) }
}
const plan = (ready: boolean, scene: string, reloadTried = false, leaveTried = false) =>
  pcLobbyRecoveryPlan({ ready, scene, reloadTried, leaveTried })

// ── 正常 ──────────────────────────────────────────────────────────────────────
eq('大廳好了就什麼都不做', plan(true, 'lobby'), 'ready')
eq('大廳好了，就算場景讀成 game 也不動它（ready 最優先）', plan(true, 'game'), 'ready')

// ── 壞狀態 ①：被送回上一輪的機台 ──────────────────────────────────────────────
eq('場景是 game → 退出機台', plan(false, 'game'), 'leave-machine')
// ⚠️ 這條是順序的守門：被送回機台時 reload 是白做的（重載一樣會被送回去）
eq('場景是 game 時不可以選 reload', plan(false, 'game', /* reloadTried */ true), 'leave-machine')
eq('退出過一次還是不行 → 放棄（不要無限退出）', plan(false, 'game', false, /* leaveTried */ true), 'give-up')

// ── 壞狀態 ②：場景是大廳，但機台清單就是建不出來（從沒被觸發過的那條）──────────
eq('場景是 lobby 但沒就緒 → reload 一次', plan(false, 'lobby'), 'reload')
eq('場景讀不到（空字串）也走 reload', plan(false, ''), 'reload')
eq('場景是別的（例如 loading）也走 reload', plan(false, 'loading'), 'reload')
eq('reload 過一次還是不行 → 放棄', plan(false, 'lobby', true), 'give-up')

// ── 兩種壞狀態接續發生（reload 之後才發現被送進機台）──────────────────────────
eq('reload 之後場景變成 game → 改成退出機台', plan(false, 'game', true, false), 'leave-machine')
eq('reload 也做過、退出也做過 → 放棄', plan(false, 'game', true, true), 'give-up')

console.log(`\n${fails.length ? '❌' : '✅'} ${pass} 過 / ${fails.length} 失敗`)
if (fails.length) { fails.forEach(f => console.log('  - ' + f)); process.exit(1) }
