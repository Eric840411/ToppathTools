// learnIndicators 合成測試：node scripts/ui-checks/ideck-indicator-learn.test.mjs
// 合成畫面：一塊一直在動的「動畫區」（雜訊）、一塊「面額標記」（按面額鍵會變）、一塊「BET」（按注額鍵會變）
import { learnIndicators } from '../machine-test/ideck-indicator-learn.mjs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { PNG } = require('pngjs')

let fail = 0, n = 0
const ok = (c, label, got) => { n++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${!c && got !== undefined ? `：${JSON.stringify(got).slice(0, 900)}` : ''}`) }

const W = 120, H = 200
let frameNo = 0
/** state: { marker, bet, jp }；每一張動畫區都不同（模擬跑馬燈）；jp＝只在按鍵時跳的獎池數字（idle、空檔都不動，來回按也回不去） */
function frame(state, { animate = true } = {}) {
  const p = new PNG({ width: W, height: H })
  for (let i = 0; i < p.data.length; i += 4) { p.data[i] = 20; p.data[i + 1] = 20; p.data[i + 2] = 40; p.data[i + 3] = 255 }
  const fill = (x0, y0, w, h, c) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const i = (y * W + x) * 4; p.data[i] = c[0]; p.data[i + 1] = c[1]; p.data[i + 2] = c[2] } }
  if (animate) { frameNo++; fill(0, 0, W, 60, [(frameNo * 53) % 255, (frameNo * 97) % 255, 120]) }   // 動畫區
  // 換字是少數像素大變（1007 0345 實測），合成圖也用大的顏色差，不用整塊微調
  fill(80, 160, 30, 20, [state.marker * 80, 255 - state.marker * 80, 60])   // 面額標記
  fill(10, 160, 40, 20, [250 - state.bet * 60, state.bet * 60, state.bet * 30])       // BET
  if (state.win) fill(60, 120, 50, 20, [250, 250, 250])   // 上一局留下的 WIN（第一顆按下去才清掉）
  if (state.jp !== undefined) fill(10, 90, 40, 20, [(state.jp * 90) % 255, 255 - (state.jp * 90) % 255, 100])   // 獎池
  return p
}
const store = new Map()
const put = (img) => { const k = `f${store.size}`; store.set(k, img); return k }
const decode = k => { if (!store.has(k)) throw new Error('missing'); return store.get(k) }
/** seq：[key, change, extra]；extra.backOf＝這一下是「按回」某一顆（idx＝第幾顆，從 1 起）；extra.round＝有開局 */
function learnRun(seq, opts = {}, init = { marker: 0, bet: 1 }) {
  let st = init
  const idle = [put(frame(st)), put(frame(st)), put(frame(st))]
  let k = 0
  const buttons = seq.map(([key, change, extra = {}]) => {
    const pre = put(frame(st))
    st = { ...st, ...change }
    return { idx: extra.backOf ? `back-${extra.backOf}` : String(++k), key, name: key, pre, post1: put(frame(st)), post2: put(frame(st)), ...extra }
  })
  return learnIndicators({ idle, buttons, decode, ...opts })
}
const SEQ = [['Denom0', { marker: 0 }], ['Denom1', { marker: 1 }], ['Denom2', { marker: 2 }], ['Bet1', { bet: 2 }], ['Bet2', { bet: 3 }]]
const r = learnRun(SEQ)
ok(r.ok, 'learn 成功', r)
if (r.ok) {
  ok(r.regions.length === 2, '找到兩個反應區（面額標記、BET），動畫區被雜訊遮罩排除', r.regions)
  const markerR = r.regions.find(x => x.rect.x >= 0.55)?.id, betR = r.regions.find(x => x.rect.x < 0.4)?.id
  ok(!r.regions.some(x => x.rect.y < 0.3), '動畫區沒有被學成反應區', r.regions)
  const ch = Object.fromEntries(r.buttons.map(b => [b.key, b.changes]))
  ok(JSON.stringify(ch.Denom1) === JSON.stringify([markerR]) && JSON.stringify(ch.Bet1) === JSON.stringify([betR]), '面額鍵動面額標記、注額鍵動 BET', ch)
  ok(ch.Denom0.length === 0, '按到已選中的那顆（Denom0）→ changes 是空的（不是「沒反應」）', ch.Denom0)
}
// 來回按（1007 主使用者：「只抓對的」）：獎池每按一下就跳、按回也回不去 → 沒有來回按時會被學成面額鍵的指標；按回之後降級
{
  const jpSeq = (withBack) => [['Denom0', { marker: 0, jp: 1 }], ['Denom1', { marker: 1, jp: 2 }], ...(withBack ? [['Denom0', { marker: 0, jp: 3 }, { backOf: '1' }]] : []), ['Denom2', { marker: 2, jp: 4 }], ['Bet1', { bet: 2, jp: 5 }], ['Bet2', { bet: 3, jp: 6 }]]
  const jpOf = res => res.regions.find(x => x.rect.y > 0.4 && x.rect.y < 0.6)?.id
  const r0 = learnRun(jpSeq(false), {}, { marker: 0, bet: 1, jp: 0 })
  ok(r0.ok && !!jpOf(r0) && r0.buttons.find(b => b.key === 'Denom1').changes.includes(jpOf(r0)), '對照：沒有來回按 → 會跳的獎池被學成面額鍵的指標（證明下一條不是空轉）', r0)
  const r1 = learnRun(jpSeq(true), {}, { marker: 0, bet: 1, jp: 0 })
  const dn = r1.buttons.filter(b => /^Denom/.test(b.key))
  const mk = r1.regions.find(x => x.rect.x >= 0.55 && x.rect.y > 0.7)
  ok(r1.ok && r1.buttons.every(b => !b.changes.includes(jpOf(r1))), '按回 Denom0 獎池沒變回去 → 降級成雜訊，面額鍵、注額鍵都不再用獎池區', r1.buttons)
  ok(mk?.verified === true && dn.filter(b => b.key !== 'Denom0').every(b => b.changes.includes(mk.id)), '面額標記按回後變回原樣 → verified，面額鍵仍用它', r1.regions)
  ok(r1.roundTrip?.length === 1 && r1.roundTrip[0].of === 'Denom0' && r1.roundTrip[0].via === 'Denom1', 'roundTrip 記錄 A＝Denom0、B＝Denom1', r1.roundTrip)
  ok(!r1.buttons.some(b => b.key === 'Denom0' && r1.buttons.filter(x => x.key === 'Denom0').length > 1), '按回那一下不算成另一顆按鈕', r1.buttons.map(b => b.key))
  // B 開局 → 比不出來，不降級也不 verified
  const r2 = learnRun([['Denom0', { marker: 0 }], ['Denom1', { marker: 1 }, { round: true }], ['Denom0', { marker: 0 }, { backOf: '1' }], ['Denom2', { marker: 2 }]])
  ok(r2.ok && r2.roundTrip?.[0]?.skipped && !r2.regions.some(x => x.verified === false), '中間那顆有開局 → 來回按略過（不降級）', r2.roundTrip)
}
// 同組一致性：只有第一顆面額鍵動到的區（0345：pre 還停在上一局的 WIN）不算指標
{
  const r = learnRun([['Denom0', { marker: 0, win: 0 }], ['Denom1', { marker: 1 }], ['Denom2', { marker: 2 }]], {}, { marker: 0, bet: 1, win: 1 })
  const winR = r.regions.find(x => x.rect.y > 0.55 && x.rect.y < 0.7)
  ok(r.ok && !winR && r.buttons.find(b => b.key === 'Denom0').changes.length === 0, '只有一顆動到的區（上一局的 WIN 被清掉）→ 不算指標', r)
}
// 開局的按鈕照實記，不套同組一致性；每顆最多 maxPerButton 區
{
  const r = learnRun([['Denom0', { marker: 0 }], ['Denom1', { marker: 1 }], ['Bet0', { bet: 2, jp: 7 }, { round: true }]], {}, { marker: 0, bet: 1, jp: 0 })
  const b0 = r.buttons.find(b => b.key === 'Bet0')
  ok(r.ok && b0.round === true && b0.changes.length === 2, '開局鍵（只有一顆）照實記它動到的區（BET＋獎池）', b0)
  const r1 = learnRun([['Denom0', { marker: 0 }], ['Denom1', { marker: 1 }], ['Bet0', { bet: 2, jp: 7 }, { round: true }]], { maxPerButton: 1 }, { marker: 0, bet: 1, jp: 0 })
  ok(r1.buttons.every(b => b.changes.length <= 1), 'maxPerButton=1 → 每顆最多 1 區', r1.buttons)
}
// 作廢的情況
ok(learnRun(SEQ, { menuOpen: true }).ok === false, '選單沒關掉 → 這次 learn 作廢')
ok(learnIndicators({ idle: [put(frame({ marker: 0, bet: 1 }))], buttons: [], decode }).ok === false, 'idle 只有一張 → 作廢')
ok(learnRun([['Denom0', {}], ['Denom1', {}]]).ok === false, '一顆都沒反應（機台壞了）→ 作廢，不能學成規格')
ok(learnIndicators({ idle: ['f0', 'f1'], buttons: [{ key: 'X', pre: 'nope', post1: 'nope', post2: 'nope' }], decode }).ok === false, '缺圖 → 作廢')

// ── batch 端：persistIdeckIndicatorLearn（MT_HOME 指到暫存資料夾，不碰真的 knowledge）──
{
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-home-'))
  process.env.MT_HOME = home
  const { persistIdeckIndicatorLearn } = await import('../machine-test/machine-test-batch.mjs')
  const write = (img, name) => { const f = path.join(home, `${name}.png`); fs.writeFileSync(f, PNG.sync.write(img)); return f }
  let st = { marker: 0, bet: 1 }
  const idle = [write(frame(st), 'i1'), write(frame(st), 'i2'), write(frame(st), 'i3')]
  const caps = SEQ.map(([key, change], i) => { const pre = write(frame(st), `p${i}`); st = { ...st, ...change }; return { idx: String(i + 1), label: `auto[${i + 1}]`, text: key, name: key, pre, post1: write(frame(st), `a${i}`), post2: write(frame(st), `b${i}`) } })
  const result = (spinMsg) => ({ steps: [{ step: 'Spin 測試', message: spinMsg }, { step: 'iDeck 測試', extraData: { ideckLearn: JSON.stringify({ v: 1, idle, buttons: caps }), learn: '{}' } }] })
  const r1 = persistIdeckIndicatorLearn(result('Spin 通過'), '873-ZZLEARN-0001', home)
  const file = path.join(home, 'knowledge', 'games', 'ZZLEARN', 'automation', 'ideck-indicator.json')
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
  ok(r1?.ok && saved?.status === 'proposed' && saved.regions.length === 2, 'batch：寫出 proposed 的 ideck-indicator.json（兩個反應區）', r1)
  ok(fs.existsSync(path.join(home, 'knowledge', 'games', 'ZZLEARN', 'automation', 'ideck-indicator-873-ZZLEARN-0001.png')), 'batch：框線圖也寫了（給人確認）')
  // 已經 confirmed → 不蓋，另存 proposed-<台號>
  fs.writeFileSync(file, JSON.stringify({ ...saved, status: 'confirmed' }))
  persistIdeckIndicatorLearn(result('Spin 通過'), '873-ZZLEARN-0002', home)
  ok(JSON.parse(fs.readFileSync(file, 'utf8')).status === 'confirmed' && fs.existsSync(path.join(home, 'knowledge', 'games', 'ZZLEARN', 'automation', 'ideck-indicator.proposed-873-ZZLEARN-0002.json')), 'batch：已 confirmed 的不蓋，另存 proposed-<台號>')
  // 選單沒關掉 → 作廢、不寫
  const r3 = persistIdeckIndicatorLearn(result('Spin 沒開局｜選單狀態未知：前端選面額等 30 秒選單仍開著，此機種沒有設定關選單的觸屏點'), '873-ZZLEARN-0003', home)
  ok(r3?.ok === false && /選單/.test(r3.why) && !fs.existsSync(path.join(home, 'knowledge', 'games', 'ZZLEARN', 'automation', 'ideck-indicator.proposed-873-ZZLEARN-0003.json')), 'batch：選單沒關掉 → 作廢、不寫檔', r3)
  ok(persistIdeckIndicatorLearn({ steps: [{ step: 'iDeck 測試', extraData: {} }] }, '873-ZZLEARN-0004', home) === null, 'batch：一般批次（沒有拍攝資料）→ 不做事')
  fs.rmSync(home, { recursive: true, force: true })
  console.log(fail ? `❌ ${fail}/${n} 失敗` : `✅ ${n}/${n} 通過（含 batch）`)
  process.exit(fail ? 1 : 0)
}
