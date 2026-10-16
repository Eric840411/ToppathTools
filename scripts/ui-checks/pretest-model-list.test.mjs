// scripts/ui-checks/pretest-model-list.test.mjs — 測前檢查 machine_model 可以填多個（1016 使用者選 A、CodeX 同意）
// 跑法：node scripts/ui-checks/pretest-model-list.test.mjs
import { judgeMachineInfo, parseModelList, preTestBatchWarn } from '../machine-test/machine-test-batch.mjs'

let pass = 0, fail = 0
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && extra ? ' — ' + extra : ''}`) }

const box = model => ({ version: '1.18.15', machineType: model, onlineState: 'online', machineStatus: 'idle' })
const modelIssues = (model, machineModel) => judgeMachineInfo('X-WLZBHELIX-2209', model === undefined ? null : box(model), null, { machineModel }).issues.filter(i => /Machine model/.test(i))

// 解析
check('解析：半形＋全形逗號、trim、去空的', JSON.stringify(parseModelList(' wlzbhelix9 ，wlzbhelix10,, ').list) === '["wlzbhelix9","wlzbhelix10"]', JSON.stringify(parseModelList(' wlzbhelix9 ，wlzbhelix10,, ')))
check('解析：空白＝沒填（不比對、不報錯）', parseModelList('   ').list.length === 0 && parseModelList('   ').error === null)
check('解析：只有分隔符 → 設定錯誤（不能默默跳過比對）', !!parseModelList(',，').error && parseModelList(',，').list.length === 0)

// 比對
check('清單內（不分大小寫）→ 相符', modelIssues('WLZBHELIX10', 'wlzbhelix9,wlzbhelix10').length === 0, JSON.stringify(modelIssues('WLZBHELIX10', 'wlzbhelix9,wlzbhelix10')))
check('清單外 → 不符，訊息列出候選值', (() => { const i = modelIssues('wlzbhelix11', 'wlzbhelix9，wlzbhelix10'); return i.length === 1 && i[0].includes('wlzbhelix11') && i[0].includes('wlzbhelix9、wlzbhelix10 其中之一') })(), JSON.stringify(modelIssues('wlzbhelix11', 'wlzbhelix9，wlzbhelix10')))
check('完整相等，不是包含（wlzbhelix1 不算 wlzbhelix10）', modelIssues('wlzbhelix1', 'wlzbhelix10').length === 1)
check('有填預期但盒子沒回報 model → 不符', modelIssues(null, 'wlzbhelix9,wlzbhelix10').length === 1, JSON.stringify(modelIssues(null, 'wlzbhelix9,wlzbhelix10')))
check('單一值照舊（訊息不寫「其中之一」）', (() => { const i = modelIssues('lionlink', 'wlzbhelix9'); return i.length === 1 && !i[0].includes('其中之一') })())
check('沒填 → 不比對', modelIssues('anything', '').length === 0)
check('只有分隔符 → 每台都列出設定錯誤', (() => { const i = modelIssues('wlzbhelix9', ',，'); return i.length === 1 && i[0].includes('設定錯誤') })(), JSON.stringify(modelIssues('wlzbhelix9', ',，')))

// 同批不一致提醒
const rows = ms => ms.map(m => ({ row: { model: m, boxVer: '1.18.15', llProtocol: null, llVer: null } }))
const warns = (ms, machineModel) => preTestBatchWarn(rows(ms), { machineModel }).filter(w => /Machine model/.test(w))
check('混批但都在清單內 → 不提醒 model 不一致', warns(['wlzbhelix9', 'wlzbhelix10', 'WLZBHELIX9'], 'wlzbhelix9,wlzbhelix10').length === 0)
check('混批、有一台在清單外 → 照樣提醒', warns(['wlzbhelix9', 'wlzbhelix11'], 'wlzbhelix9,wlzbhelix10').length === 1)
check('沒給預期值的混批 → 照樣提醒（原本行為）', warns(['wlzbhelix9', 'wlzbhelix10'], '').length === 1)
check('其他欄位不一致照舊提醒', preTestBatchWarn([{ row: { model: 'a', boxVer: '1' } }, { row: { model: 'a', boxVer: '2' } }], { machineModel: 'a' }).some(w => /盒子版號/.test(w)))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
