/**
 * UI 截圖 Machine Model 選擇的測試。跑法：npx tsx shared/ui-ss-machine-model.test.ts
 * 資料取自需求方給的例子：WLZBHELIX 同一個 model 底下有 wlzbhelix9／10／11。
 */
import Database from 'better-sqlite3'
import { groupByMachineModel, poolTarget, validatePools } from './ui-ss-machine-model.js'
import { initOsmMachineTypes, lookupMachineTypes, saveChannelMachineTypes } from '../server/osm-machine-types.js'

let pass = 0
const fails: string[] = []
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) }
  else { fails.push(`${name} | got: ${g} | want: ${w}`); console.log(`❌ ${name} | got: ${g} | want: ${w}`) }
}

const m = (gmid: string, occupied = false) => ({ gmid, occupied })
const machines = [m('4182-WLZBHELIX-2136'), m('4182-WLZBHELIX-2133'), m('4182-WLZBHELIX-2135', true), m('4182-WLZBHELIX-2138', true), m('4182-WLZBHELIX-9999')]
const types = new Map([
  ['4182-WLZBHELIX-2133', 'wlzbhelix9'], ['4182-WLZBHELIX-2135', 'wlzbhelix9'],
  ['4182-WLZBHELIX-2136', 'wlzbhelix10'], ['4182-WLZBHELIX-2138', 'wlzbhelix11'],
])
const groups = groupByMachineModel(machines, types)
eq('依 Machine Model 分組，數字照數值排（9 在 10 前面），未同步排最後', groups.map(g => g.machineType), ['wlzbhelix9', 'wlzbhelix10', 'wlzbhelix11', null])
eq('wlzbhelix9 有 2 台、可用 1', [groups[0].total, groups[0].free], [2, 1])
eq('組內 gmid 排序', groups[0].machines.map(x => x.gmid), ['4182-WLZBHELIX-2133', '4182-WLZBHELIX-2135'])
eq('查不到的 gmid 歸「未同步」，不猜', groups[3].machines.map(x => x.gmid), ['4182-WLZBHELIX-9999'])
eq('gmid 大小寫不同也對得到', groupByMachineModel([m('4182-wlzbhelix-2133')], types)[0].machineType, 'wlzbhelix9')
eq('也吃一般物件當對照表（machine-types 端點回傳的格式）', groupByMachineModel([m('4182-WLZBHELIX-2133')], { '4182-WLZBHELIX-2133': 'wlzbhelix9' })[0].machineType, 'wlzbhelix9')

const t9 = poolTarget('WLZBHELIX', '5 Dragons Gold', 'wlzbhelix9')
eq('任務名稱三段', t9, 'WLZBHELIX / 5 Dragons Gold / wlzbhelix9')
eq('白名單正常 → 通過', validatePools([t9], { [t9]: ['4182-WLZBHELIX-2133'] }), [])
eq('沒有白名單 → 通過（舊行為）', validatePools(['JJBX / Endless Treasure'], undefined), [])
eq('空白名單 → 擋（不能變成不限 Machine Model）', validatePools([t9], { [t9]: [] }).length, 1)
eq('白名單對應的任務不在清單 → 擋', validatePools(['X'], { [t9]: ['4182-WLZBHELIX-2133'] }).length > 0, true)
eq('白名單裡有不是 gmid 的值 → 擋', validatePools([t9], { [t9]: ['WLZBHELIX / 5 Dragons Gold'] }).length, 1)
eq('任務名稱不是三段 → 擋', validatePools(['WLZBHELIX / 5 Dragons Gold'], { 'WLZBHELIX / 5 Dragons Gold': ['4182-WLZBHELIX-2133'] }).length, 1)

// ── DB 對照（OSM 同步在主程序寫，截圖路由在 worker 讀）──
{
  const db = new Database(':memory:'); initOsmMachineTypes(db)
  saveChannelMachineTypes(db, 'NP', [{ machineName: '4182-WLZBHELIX-2133', machineType: 'wlzbhelix9' }, { machineName: '4182-WLZBHELIX-2136', machineType: 'wlzbhelix10' }], 1000)
  saveChannelMachineTypes(db, 'CP', [{ machineName: '4171-JJBXGOLD-0077', machineType: 'jjbxgold1' }], 2000)
  const r = lookupMachineTypes(db, ['4182-wlzbhelix-2133', '4171-JJBXGOLD-0077', '9999-NOPE-0001'])
  eq('查得到的才放進對照，大小寫不拘', Object.fromEntries(r.types), { '4182-WLZBHELIX-2133': 'wlzbhelix9', '4171-JJBXGOLD-0077': 'jjbxgold1' })
  eq('最後同步時間取最新的', r.syncedAt, 2000)
  saveChannelMachineTypes(db, 'NP', [{ machineName: '4182-WLZBHELIX-2133', machineType: 'wlzbhelix12' }], 3000)
  const r2 = lookupMachineTypes(db, ['4182-WLZBHELIX-2133', '4182-WLZBHELIX-2136', '4171-JJBXGOLD-0077'])
  eq('同一渠道重新同步：整批換掉（被移除的機台消失、改型號的更新）', Object.fromEntries(r2.types), { '4182-WLZBHELIX-2133': 'wlzbhelix12', '4171-JJBXGOLD-0077': 'jjbxgold1' })
  eq('別的渠道不受影響', r2.types.get('4171-JJBXGOLD-0077'), 'jjbxgold1')
}

console.log(`\n${pass} 通過，${fails.length} 失敗`)
if (fails.length) { console.log(fails.join('\n')); process.exit(1) }
