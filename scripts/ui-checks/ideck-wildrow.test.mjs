/**
 * ARUZE（Fu Lai Cai Lai）iDeck：PLAY 鍵看 WILD 數、BET 鍵逐顆要有開局（1007 主使用者確認、CodeX 定案）。
 *
 *   node scripts/ui-checks/ideck-wildrow.test.mjs
 *
 * 用合成圖（4 格塗兩種顏色當銅錢／WILD），不靠本機的報告資料夾。守 CodeX 列的邊界：
 *   遊戲名不符／讀不到 → PLAY 未驗；格子認不出來（大廳、彈窗）→ 未驗，不硬分成 0～4；PLAY11 的 0 個也要四格都認得出是銅錢；
 *   WILD 數不符 → 第一期未驗（可能動畫中）；BET 逐顆要有開局、沒開局 FAIL、舊資料沒記 → 未驗；PLAY 未驗不能被 BET 通過蓋掉
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { evaluateWildRow, countWilds } from '../machine-test/ideck-screen-check.mjs'
const require = createRequire(import.meta.url)
const { PNG } = require('pngjs')

let fail = 0, n = 0
const ok = (c, label, got) => { n++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${!c && got !== undefined ? `：${JSON.stringify(got)}` : ''}`) }

const W = 100, H = 100
const COIN = [120, 80, 20], WILD = [230, 60, 40], OTHER = [255, 255, 255]
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wildrow-'))
const cfg = {
  gameName: 'Fu Lai Cai Lai', y0: 0.4, y1: 0.5,
  cells: [{ cx: 0.2, w: 0.1 }, { cx: 0.4, w: 0.1 }, { cx: 0.6, w: 0.1 }, { cx: 0.8, w: 0.1 }],
  maxDist: 40, minMargin: 20,
  expected: { PLAY11Credits: 0, PLAY33Credits: 1, PLAY55Credits: 2, PLAY66Credits: 3, PLAY88Credits: 4 },
  roundButtons: '^BETx\\d+$',
}
/** 畫一張：每格一種顏色（cells 陣列，從左到右） */
function img(name, colors) {
  const p = new PNG({ width: W, height: H })
  for (let i = 0; i < p.data.length; i += 4) { p.data[i] = 40; p.data[i + 1] = 0; p.data[i + 2] = 80; p.data[i + 3] = 255 }
  colors.forEach((col, k) => {
    const c = cfg.cells[k]
    for (let y = Math.round(cfg.y0 * H); y < Math.round(cfg.y1 * H); y++) for (let x = Math.round((c.cx - c.w / 2) * W); x < Math.round((c.cx + c.w / 2) * W); x++) {
      const i = (y * W + x) * 4; p.data[i] = col[0]; p.data[i + 1] = col[1]; p.data[i + 2] = col[2]
    }
  })
  const f = path.join(dir, `${name}.png`); fs.writeFileSync(f, PNG.sync.write(p)); return f
}
cfg.refPaths = { coin: img('ref-coin', [COIN, COIN, COIN, COIN]), wild: img('ref-wild', [WILD, WILD, WILD, WILD]) }
const row = k => [...Array(4 - k).fill(COIN), ...Array(k).fill(WILD)]   // 從右往左亮
const plays = [['PLAY11Credits', 'Bet11', 0], ['PLAY33Credits', 'Bet33', 1], ['PLAY55Credits', 'Bet55', 2], ['PLAY66Credits', 'Bet66', 3], ['PLAY88Credits', 'Bet88', 4]]
const goodShots = plays.map(([, name, k]) => ({ name, path: img(`good-${name}`, row(k)) }))
const bets = [1, 2, 3].map(x => ({ key: `BETx${x}`, name: `BetMultiple${x}`, round: true }))
const buttons = [...plays.map(([key, name]) => ({ key, name })), ...bets]
const ev = o => evaluateWildRow({ gameName: 'Fu Lai Cai Lai', buttons, shots: goodShots, cfg, ...o })

let r = ev({})
ok(r.kind === 'ok' && /PLAY11Credits=0/.test(r.why), '全部正確 → ok（PLAY11 的 0 個是四格都認出銅錢）', r)
ok(ev({ gameName: 'Triple Festival' }).kind === 'unverified', '遊戲是 Triple Festival → PLAY 未驗（不套 WILD 規則、不判 FAIL）')
ok(ev({ gameName: '' }).kind === 'unverified', '讀不到遊戲名 → 未驗')
ok(ev({ gameName: '  Fu  Lai Cai Lai ' }).kind === 'ok', '遊戲名比對前正規化空白')
// 大廳／彈窗：格子是別的東西 → 認不出來 → 未驗（不能把「找不到 WILD」當成 0 個）
const lobby = goodShots.map(s => s.name === 'Bet11' ? { name: 'Bet11', path: img('lobby-Bet11', [OTHER, OTHER, OTHER, OTHER]) } : s)
r = ev({ shots: lobby })
ok(r.kind === 'unverified' && /認不出來/.test(r.why), 'PLAY11 的截圖是大廳（四格都不是銅錢）→ 未驗，不算 0 個 WILD', r)
// 0332：PLAY11 按完還是 4 個 WILD → 第一期未驗（可能動畫中）
const missed = goodShots.map(s => s.name === 'Bet11' ? { name: 'Bet11', path: img('missed-Bet11', row(4)) } : s)
r = ev({ shots: missed })
ok(r.kind === 'unverified' && /WILD 4 個（預期 0）/.test(r.why), 'PLAY11 仍 4 個 WILD → 未驗（第一期不判 FAIL）', r)
// 缺圖
ok(ev({ shots: goodShots.filter(s => s.name !== 'Bet55') }).kind === 'unverified', 'PLAY 缺圖 → 未驗')
// BET 逐顆
r = ev({ buttons: [...plays.map(([key, name]) => ({ key, name })), { key: 'BETx1', name: 'BetMultiple1', round: true }, { key: 'BETx2', name: 'BetMultiple2', round: false }] })
ok(r.kind === 'fail' && /BETx2 沒開局/.test(r.why), 'BET 有一顆沒開局 → FAIL（不能拿總數背書）', r)
ok(ev({ buttons: [...plays.map(([key, name]) => ({ key, name })), { key: 'BETx1', name: 'BetMultiple1' }] }).kind === 'unverified', '舊資料沒記每顆有沒有開局 → 未驗')
// PLAY 未驗不能被 BET 通過蓋掉
ok(ev({ gameName: 'Triple Festival' }).kind === 'unverified', 'BET 全部有開局、PLAY 未驗 → 整體仍未驗')
// 沒設定 → na
ok(evaluateWildRow({ gameName: 'x', buttons, shots: goodShots, cfg: null }).kind === 'na', '機種沒有 WILD 設定 → na')
// countWilds 尺寸不一致 → 認不出來
const small = new PNG({ width: 50, height: 50 })
ok(countWilds(small, PNG.sync.read(fs.readFileSync(cfg.refPaths.coin)), PNG.sync.read(fs.readFileSync(cfg.refPaths.wild)), cfg).count === null, '截圖尺寸跟參考圖不同 → 認不出來')

fs.rmSync(dir, { recursive: true, force: true })
console.log(fail ? `❌ ${fail}/${n} 失敗` : `✅ ${n}/${n} 通過`)
process.exit(fail ? 1 : 0)
