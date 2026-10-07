/**
 * iDeck 機台反應證據（1007；osm-qa-agent 實測＋CodeX 定案）。用合成 PNG，不靠本機的報告資料夾。
 *
 *   node scripts/ui-checks/ideck-screen-check.test.mjs
 *
 * 守：兩組分開判（一組有動不能掩蓋另一組失效）、缺圖／讀圖失敗＝未驗、超標不等於通過、
 *     開局 0 顆沒有反應證據＝未驗、既有 FAIL 不會被未驗蓋掉。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { evaluateIdeckScreens, regionDiff } from '../machine-test/ideck-screen-check.mjs'
import { applyGameRules, ideckAllConfirmed, ideckButtonKey, larkLine } from '../machine-test/machine-test-batch.mjs'
const require = createRequire(import.meta.url)
const { PNG } = require('pngjs')

let fail = 0, n = 0
const ok = (c, label, got) => { n++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${!c && got !== undefined ? `：${JSON.stringify(got)}` : ''}`) }

const W = 100, H = 100
const crop = { credit: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 }, marker: { x: 0.5, y: 0.1, w: 0.1, h: 0.1 }, bet: { x: 0.7, y: 0.1, w: 0.2, h: 0.1 }, thresholds: { denom: 0.08, bet: 0.05 } }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ideck-chk-'))
/** 畫一張圖：region 裡塗 fill 的比例（0～1）成白色，其他黑色 */
function img(name, paint = {}) {
  const p = new PNG({ width: W, height: H })
  for (let i = 0; i < p.data.length; i += 4) { p.data[i] = p.data[i + 1] = p.data[i + 2] = 0; p.data[i + 3] = 255 }
  for (const [rk, frac] of Object.entries(paint)) {
    const r = crop[rk]
    const x0 = Math.round(r.x * W), y0 = Math.round(r.y * H), w = Math.round(r.w * W), h = Math.round(r.h * H)
    let left = Math.round(w * h * frac)
    for (let y = y0; y < y0 + h && left > 0; y++) for (let x = x0; x < x0 + w && left > 0; x++, left--) { const i = (y * W + x) * 4; p.data[i] = p.data[i + 1] = p.data[i + 2] = 255 }
  }
  const f = path.join(dir, `${name}.png`)
  fs.writeFileSync(f, PNG.sync.write(p))
  return f
}
const denoms = ['Denom0', 'Denom1', 'Denom2', 'Denom3'], bets = ['Bet0', 'Bet1', 'Bet2']
const shotsOf = (paints) => Object.entries(paints).map(([name, paint]) => ({ name, path: img(`${Object.keys(paints).join('')}-${name}`, paint) }))
const expected = [...denoms, ...bets]

ok(Math.abs(regionDiff(PNG.sync.read(fs.readFileSync(img('a', {}))), PNG.sync.read(fs.readFileSync(img('b', { credit: 0.5 }))), crop.credit) - 0.5) < 0.01, 'regionDiff：塗一半＝50%')

// 有反應：面額 credit 變 20%、注額 bet 變 20%
const reacted = shotsOf({ Denom0: {}, Denom1: { credit: 0.2 }, Denom2: { credit: 0.2 }, Denom3: { credit: 0.2 }, Bet0: {}, Bet1: { bet: 0.2 }, Bet2: { bet: 0.2 } })
let r = evaluateIdeckScreens({ expected, shots: reacted, crop })
ok(r.kind === 'reacted', '兩組都超過門檻 → reacted（只代表沒觸發攔截）', r)

// 都沒反應
const dead = shotsOf({ Denom0: {}, Denom1: { credit: 0.02 }, Denom2: {}, Denom3: { marker: 0.03 }, Bet0: {}, Bet1: { bet: 0.01 }, Bet2: {} })
r = evaluateIdeckScreens({ expected, shots: dead, crop })
ok(r.kind === 'no-response', '兩組都低於門檻 → no-response', r)

// 一組有動、另一組失效 → no-response（不能被掩蓋）
const half = shotsOf({ Denom0: {}, Denom1: { credit: 0.3 }, Denom2: { credit: 0.3 }, Denom3: { credit: 0.3 }, Bet0: {}, Bet1: { bet: 0.01 }, Bet2: { bet: 0.01 } })
r = evaluateIdeckScreens({ expected, shots: half, crop })
ok(r.kind === 'no-response' && r.groups.find(g => g.key === 'bet').kind === 'no-response', '面額有動、注額沒動 → 仍判 no-response', r)

// 面額只有 marker 小字變化（CREDIT 沒動）也要被看到：各區塊各算比例，不合併稀釋
const markerOnly = shotsOf({ Denom0: {}, Denom1: { marker: 0.4 }, Denom2: {}, Denom3: {}, Bet0: {}, Bet1: { bet: 0.3 }, Bet2: {} })
r = evaluateIdeckScreens({ expected, shots: markerOnly, crop })
ok(r.groups.find(g => g.key === 'denom').kind === 'reacted', '只有面額標記變 → 面額組算有反應（各區塊各算）', r.groups)

// 缺圖 → 未驗（不能判沒反應、也不能當有反應）
r = evaluateIdeckScreens({ expected, shots: reacted.filter(s => s.name !== 'Denom2'), crop })
ok(r.kind === 'unverified' && /缺圖/.test(r.why), '預期的按鈕缺圖 → 未驗', r)
r = evaluateIdeckScreens({ expected, shots: [...reacted.filter(s => s.name !== 'Bet1'), { name: 'Bet1', path: path.join(dir, 'nope.png') }], crop })
ok(r.kind === 'unverified', '圖檔不存在 → 未驗', r)
const corrupt = path.join(dir, 'corrupt.png'); fs.writeFileSync(corrupt, 'not a png')
r = evaluateIdeckScreens({ expected, shots: [...reacted.filter(s => s.name !== 'Bet2'), { name: 'Bet2', path: corrupt }], crop })
ok(r.kind === 'unverified' && /讀圖失敗/.test(r.why), '圖檔壞掉 → 未驗', r)
// 沒有子區塊（沒校準）→ na；預期按鈕只有一顆 → 那組未驗
ok(evaluateIdeckScreens({ expected, shots: reacted, crop: { thresholds: crop.thresholds } }).kind === 'na', '沒校準的機種 → na')
ok(evaluateIdeckScreens({ expected: ['Denom0', ...bets], shots: reacted, crop }).kind === 'unverified', '面額鍵只有一顆 → 未驗')

// ── batch 判定（applyGameRules）：用一個沒有 ideck-crop.json 的機種名，只驗「開局 0 顆」與既有 FAIL ──
const step = (status, msg, names) => ({ step: 'iDeck 測試', status, message: msg, extraData: { learn: JSON.stringify({ actions: names.map(n => ({ name: n })) }), ideckShots: '[]' } })
const res = (s) => applyGameRules({ machineCode: '873-ZZNOCFG-0001', steps: [s] }).steps[0]
ok(res(step('pass', 'server 回應 3/3｜iDeck 開局 0 顆', ['A', 'B', 'C'])).status === 'skip', '開局 0 顆、沒有反應證據 → 未驗（不能 PASS）')
ok(res(step('pass', 'server 回應 3/3｜iDeck 開局 2 顆', ['A', 'B', 'C'])).status === 'pass', '有開局 → 照原判')
ok(res(step('fail', 'server 回應 2/3｜判定：no response｜iDeck 開局 0 顆', ['A', 'B', 'C'])).status === 'fail', '既有 FAIL 不會被未驗蓋掉')

// Spin：選單閘門確認機台停在選面額選單（SUPERBURSTLINK 0359）→ 未驗；其他「選單狀態未知」照舊；既有 FAIL 不動
const spin = (status, msg) => applyGameRules({ machineCode: '873-ZZNOCFG-0001', steps: [{ step: 'Spin 測試', status, message: msg }] }).steps[0]
ok(spin('warn', 'Spin 沒開局｜選單狀態未知：前端選面額等 30 秒選單仍開著，此機種沒有設定關選單的觸屏點，不判觸屏').status === 'skip', '選單確實開著 → Spin 未驗（不是 WARN 通過）')
ok(spin('warn', 'Spin 沒開局｜選單狀態未知：推流畫面判斷不了（停格或沒在播），照原流程').status === 'warn', '判斷不了的選單狀態未知 → 照舊')
ok(spin('fail', 'spin no response｜選單狀態未知：前端選面額等 30 秒選單仍開著').status === 'fail', 'Spin 既有 FAIL 不會被未驗蓋掉')

// CodeX ee40495 [P2]：confirmed 清單用按鈕字（去空白），runner 的 action name 是另一套——JJBXGRAND 真實資料的形狀
const jj = { step: 'iDeck 測試', status: 'pass', message: 'iDeck 開局 0 顆', extraData: { learn: JSON.stringify({
  buttons: [{ label: 'auto[1]', text: 'BETx1' }, { label: 'auto[2]', text: 'PLAY18 Credits' }],
  actions: [{ label: 'auto[1]', name: 'BetMultiple1' }, { label: 'auto[2]', name: 'Bet18' }] }) } }
ok(ideckButtonKey('PLAY18 Credits', 'Bet18') === 'PLAY18Credits' && ideckButtonKey('', 'Bet18') === 'Bet18', '按鈕識別鍵＝按鈕字去空白（沒字才用 name）')
ok(ideckAllConfirmed(jj, new Set(['BETx1', 'PLAY18Credits'])) === true, 'JJBXGRAND：action name 是 BetMultiple1／Bet18，仍對得上 confirmed 清單（BETx1／PLAY18Credits）')
ok(ideckAllConfirmed(jj, new Set(['BETx1'])) === false, '清單少一顆 → 不算全部 confirmed')
ok(ideckAllConfirmed(jj, new Set(['BetMultiple1', 'Bet18'])) === false, '拿 action name 寫的清單 → 對不上（識別只認按鈕字）')
// BetMultipleN 算注額組
const mult = shotsOf({ Denom0: {}, Denom1: { credit: 0.3 }, BetMultiple1: {}, BetMultiple2: { bet: 0.01 } })
r = evaluateIdeckScreens({ expected: ['Denom0', 'Denom1', 'BetMultiple1', 'BetMultiple2'], shots: mult, crop })
ok(r.groups.find(g => g.key === 'bet')?.kind === 'no-response', 'BetMultipleN 算注額組（沒反應一樣抓得到）', r.groups)
// 明細（larkLine）與報告要用套用規則後的結果
const raw = { machineCode: '873-ZZNOCFG-0001', steps: [{ step: 'iDeck 測試', status: 'pass', message: 'server 回應 3/3｜iDeck 開局 0 顆', extraData: { learn: JSON.stringify({ actions: [{ name: 'A' }] }), ideckShots: '[]' } }] }
ok(!/iDeck PASS/.test(larkLine(raw, { J: null, verdict: '' }, '10-07')), 'larkLine 明細不再寫 iDeck PASS（用套用規則後的結果）', larkLine(raw, { J: null, verdict: '' }, '10-07'))
const reportSrc = fs.readFileSync(new URL('../machine-test/machine-test-report.mjs', import.meta.url), 'utf8')
ok(/const stepMap = m => Object\.fromEntries\(\(ruledOf\(m\)/.test(reportSrc) && /applyGameRules\(m\.result\)/.test(reportSrc), '報告的統計與明細用套用規則後的結果')

fs.rmSync(dir, { recursive: true, force: true })
console.log(fail ? `❌ ${fail}/${n} 失敗` : `✅ ${n}/${n} 通過`)
process.exit(fail ? 1 : 0)
