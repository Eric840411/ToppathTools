// learnIndicators 合成測試：node scripts/ui-checks/ideck-indicator-learn.test.mjs
// 合成畫面：一塊一直在動的「動畫區」（雜訊）、一塊「面額標記」（按面額鍵會變）、一塊「BET」（按注額鍵會變）
import { learnIndicators } from '../machine-test/ideck-indicator-learn.mjs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { PNG } = require('pngjs')

let fail = 0, n = 0
const ok = (c, label, got) => { n++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${!c && got !== undefined ? `：${JSON.stringify(got).slice(0, 300)}` : ''}`) }

const W = 120, H = 200
let frameNo = 0
/** state: { marker, bet }；每一張動畫區都不同（模擬跑馬燈） */
function frame(state, { animate = true } = {}) {
  const p = new PNG({ width: W, height: H })
  for (let i = 0; i < p.data.length; i += 4) { p.data[i] = 20; p.data[i + 1] = 20; p.data[i + 2] = 40; p.data[i + 3] = 255 }
  const fill = (x0, y0, w, h, c) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const i = (y * W + x) * 4; p.data[i] = c[0]; p.data[i + 1] = c[1]; p.data[i + 2] = c[2] } }
  if (animate) { frameNo++; fill(0, 0, W, 60, [(frameNo * 53) % 255, (frameNo * 97) % 255, 120]) }   // 動畫區
  fill(80, 160, 30, 20, [state.marker * 60, 200, 60])   // 面額標記
  fill(10, 160, 40, 20, [200, state.bet * 70, 60])       // BET
  return p
}
const store = new Map()
const put = (img) => { const k = `f${store.size}`; store.set(k, img); return k }
const decode = k => { if (!store.has(k)) throw new Error('missing'); return store.get(k) }
function learnRun(seq, opts = {}) {
  let st = { marker: 0, bet: 1 }
  const idle = [put(frame(st)), put(frame(st)), put(frame(st))]
  const buttons = seq.map(([key, change]) => {
    const pre = put(frame(st))
    st = { ...st, ...change }
    return { key, name: key, pre, post1: put(frame(st)), post2: put(frame(st)) }
  })
  return learnIndicators({ idle, buttons, decode, ...opts })
}
const SEQ = [['Denom0', { marker: 0 }], ['Denom1', { marker: 1 }], ['Denom2', { marker: 2 }], ['Bet1', { bet: 2 }], ['Bet2', { bet: 3 }]]
const r = learnRun(SEQ)
ok(r.ok, 'learn 成功', r)
if (r.ok) {
  ok(r.regions.length === 2, '找到兩個反應區（面額標記、BET），動畫區被雜訊遮罩排除', r.regions)
  const markerR = r.regions.find(x => x.rect.x > 0.6)?.id, betR = r.regions.find(x => x.rect.x < 0.4)?.id
  ok(!r.regions.some(x => x.rect.y < 0.3), '動畫區沒有被學成反應區', r.regions)
  const ch = Object.fromEntries(r.buttons.map(b => [b.key, b.changes]))
  ok(JSON.stringify(ch.Denom1) === JSON.stringify([markerR]) && JSON.stringify(ch.Bet1) === JSON.stringify([betR]), '面額鍵動面額標記、注額鍵動 BET', ch)
  ok(ch.Denom0.length === 0, '按到已選中的那顆（Denom0）→ changes 是空的（不是「沒反應」）', ch.Denom0)
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
