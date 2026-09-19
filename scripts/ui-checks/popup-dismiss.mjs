/**
 * 驗證「Tips 彈窗自動關閉」的比對邏輯。
 *
 * ⚠️ 這支**不重寫一份邏輯來測**——那樣測的是抄本，不是真正會跑的程式。
 *    它直接把 server/agent-runner.ts 裡那段 page.evaluate 的原始碼切出來、用 esbuild 轉成 JS，
 *    丟進真的瀏覽器跑在真的 DOM 上。所以測到的就是出貨的那段。
 *
 * 執行：npx tsx scripts/ui-checks/popup-dismiss.mjs
 */
import { readFileSync } from 'node:fs'
import { transform } from 'esbuild'
import { chromium } from 'playwright'

const SRC = 'server/agent-runner.ts'
const BEGIN = 'const clicked = await page.evaluate('
const END = '\n    }).catch(() => \'\')'

function extractSource() {
  const file = readFileSync(SRC, 'utf8')
  const a = file.indexOf(BEGIN)
  if (a < 0) throw new Error('找不到 page.evaluate 起點，agent-runner.ts 可能被改過：' + BEGIN)
  const b = file.indexOf(END, a)
  if (b < 0) throw new Error('找不到 page.evaluate 結尾')
  return file.slice(a + BEGIN.length, b + '\n    }'.length)
}

// ── 測資：第一個是使用者 2026-09-18 實際被卡住的那個彈窗，HTML 照抄 ─────────────
const ERROR39 = [
  '<div class="bg-img" style="width:420px;height:260px">',
  '<div class="box-title">Tips</div>',
  '<div class="box-content"><div class="box-msg">',
  '<div class="text-msg">Game exception, please contact customer service.(39)</div>',
  '</div></div>',
  '<div class="box-end"><button type="button" class="van-button van-button--default box-btn" style="width:160px;height:48px">',
  '<div class="van-button__content"><span class="van-button__text"><div class="box-btn_text2">Confirm</div></span></div>',
  '</button></div></div>',
].join('')

const DENOM = [
  '<div class="select-bg" style="width:400px;height:300px"><div class="select-title">SELECT A DENOMINATION</div>',
  '<div class="select-row"><div class="van-col" style="width:120px;height:40px">YES</div></div></div>',
].join('')

// 沒有彈窗外框的按鈕：遊戲畫面自己的按鈕，不該被亂點
const BARE_BTN = '<div class="game-footer" style="width:900px;height:120px"><button style="width:120px;height:40px">Confirm</button></div>'
// 藏起來的彈窗：不該點
const HIDDEN = '<div class="bg-img" style="display:none"><div class="box-title">Tips</div>' +
  '<div class="box-end"><button class="box-btn" style="width:160px;height:48px">Confirm</button></div></div>'
// 沒有標題列、只靠 class 看得出是彈窗（POPUPISH 就是在守這種）
const NO_TITLE = '<div class="box-wrap" style="width:420px;height:200px"><div class="msg">Network unstable</div>' +
  '<button class="box-btn" style="width:160px;height:48px">Confirm</button></div>'
// 內文裡就帶「confirm」字樣，真正的按鈕是 OK：按鈕文字必須「完全相等」才不會點錯地方
const MSG_CONFIRM = '<div class="bg-img" style="width:420px;height:260px"><div class="box-title">Tips</div>' +
  '<div class="box-msg" style="width:380px;height:60px">CONFIRM</div>' +
  '<div class="box-end"><button class="box-btn" style="width:160px;height:48px">OK</button></div></div>'
// 彈窗裡有別的按鈕，而且它的字裡剛好包含 OK（BOOK）：只有「完全相等」才不會按錯顆
const OTHER_BTN = '<div class="bg-img" style="width:420px;height:260px"><div class="box-title">Tips</div>' +
  '<div class="box-end"><button class="box-btn" style="width:160px;height:48px">BOOK NOW</button>' +
  '<button class="box-btn" style="width:160px;height:48px">Confirm</button></div></div>'
// 整塊大區域剛好只有 Confirm 這個字：點下去等於點在背景上
const HUGE = '<div class="dialog-wrap" style="width:900px;height:600px"><div class="box-title">Tips</div>' +
  '<div class="box-body" style="width:800px;height:400px">Confirm</div></div>'

const CASES = [
  { name: 'error 39 彈窗 → 按 Confirm 並記下錯誤內容', html: ERROR39, expect: r => r && r.btn === 'CONFIRM' && /Game exception/.test(r.boxText) && /\(39\)/.test(r.boxText) },
  { name: '面額選單 → 按 YES', html: DENOM, expect: r => r && r.btn === 'YES' && /DENOMINATION/i.test(r.boxText) },
  { name: '彈窗沒有標題列、只有 class 特徵 → 照樣按掉', html: NO_TITLE, expect: r => r && r.btn === 'CONFIRM' && /Network unstable/.test(r.boxText) },
  { name: '內文有 CONFIRM 字樣時 → 按的是按鈕 OK，不是那段文字', html: MSG_CONFIRM, expect: r => r && r.btn === 'OK' },
  { name: '彈窗裡有 BOOK NOW 這種按鈕 → 按的是 Confirm', html: OTHER_BTN, expect: r => r && r.btn === 'CONFIRM' },
  { name: '沒有彈窗外框的按鈕 → 不點', html: BARE_BTN, expect: r => r === null },
  { name: '藏起來的彈窗 → 不點', html: HIDDEN, expect: r => r === null },
  { name: '整塊大區域只有 Confirm 字樣 → 不點', html: HUGE, expect: r => r === null },
]

// ── 突變：每一個都要被「指定的那一條」斷言抓到 ────────────────────────────────
const MUTANTS = [
  { name: 'POPUPISH 少了 bg-img / box-（回到只認 popup/dialog 的舊版）', kills: '彈窗沒有標題列、只有 class 特徵 → 照樣按掉',
    kills_note: 'error 39 那個彈窗有 box-title，光靠標題判斷就救得回來，所以要用「沒有標題列」的彈窗才測得到 class 清單',
    apply: s => s.replace('/select|popup|overlay|dialog|confirm|modal|mask|alert|toast|tips|bg-img|box-/i', '/select|popup|overlay|dialog|confirm/i') },
  { name: '拿掉尺寸上限（大區塊也當按鈕點）', kills: '整塊大區域只有 Confirm 字樣 → 不點',
    apply: s => s.replace('if (r.width > 520 || r.height > 200) continue', 'if (false) continue') },
  { name: '拿掉可見性判斷', kills: '藏起來的彈窗 → 不點',
    apply: s => s.replace('if (!CONFIRM.has(t) || !visible(b)) continue', 'if (!CONFIRM.has(t)) continue') },
  { name: '不要求要有彈窗外框', kills: '沒有彈窗外框的按鈕 → 不點',
    apply: s => s.replace('if (!root) continue', 'if (!root && false) continue').replace('(root.textContent || \'\')', '((root || document.body).textContent || \'\')') },
  { name: '按鈕文字改成「包含」而不是「完全相等」', kills: '彈窗裡有 BOOK NOW 這種按鈕 → 按的是 Confirm',
    apply: s => s.replace('if (!CONFIRM.has(t) || !visible(b)) continue', 'if (![...CONFIRM].some(x => t.includes(x)) || !visible(b)) continue') },
  { name: '不分層，按鈕跟 div/span 一起掃（回到會點在標題文字上的版本）', kills: '內文有 CONFIRM 字樣時 → 按的是按鈕 OK，不是那段文字',
    apply: s => s.replace("const TIERS = ['button, .van-button, [role=\"button\"], [class*=\"btn\"], [class*=\"Btn\"]', 'div, span']", "const TIERS = ['button, .van-button, [role=\"button\"], [class*=\"btn\"], [class*=\"Btn\"], div, span']") },
]

async function compile(ts) {
  const out = await transform(ts, { loader: 'ts', target: 'es2020' })
  return out.code.trim().replace(/;$/, '')
}

async function runAll(page, js) {
  const results = {}
  for (const c of CASES) {
    await page.setContent('<body style="margin:0">' + c.html + '</body>')
    const raw = await page.evaluate('(' + js + ')()')
    results[c.name] = raw ? JSON.parse(raw) : null
  }
  return results
}

const ts = extractSource()
const browser = await chromium.launch()
let pass = 0, fail = 0
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })

  const base = await runAll(page, await compile(ts))
  for (const c of CASES) {
    const ok = c.expect(base[c.name])
    console.log((ok ? '  PASS  ' : '  FAIL  ') + c.name + (ok ? '' : ' → ' + JSON.stringify(base[c.name])))
    ok ? pass++ : fail++
  }

  console.log('\n突變測試（每個突變都要被「指定的那條」斷言抓到）：')
  for (const m of MUTANTS) {
    const mutated = m.apply(ts)
    if (mutated === ts) { console.log('  FAIL  ' + m.name + ' → 突變沒套用（原始碼已改，測試要同步更新）'); fail++; continue }
    let res
    try { res = await runAll(page, await compile(mutated)) } catch (e) { res = { __err: String(e) } }
    const target = CASES.find(c => c.name === m.kills)
    const killed = res.__err ? false : !target.expect(res[m.kills])
    console.log((killed ? '  KILL  ' : '  LIVE  ') + m.name + ' → 由「' + m.kills + '」' + (killed ? '抓到' : '沒抓到（這條斷言其實沒在守這件事）'))
    killed ? pass++ : fail++
  }
} finally {
  await browser.close()
}
console.log('\n' + pass + ' 通過、' + fail + ' 失敗')
process.exit(fail ? 1 : 0)
