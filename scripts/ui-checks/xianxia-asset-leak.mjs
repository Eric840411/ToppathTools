/**
 * 修仙版素材不可以漏進普通版。
 *
 *   npm run build && node scripts/ui-checks/xianxia-asset-leak.mjs
 *
 * 為什麼要有這支（2026-09-16 正式站回報）：
 * 普通版的保護是「`App.tsx` 不載 `public/xianxia-complete.css`」。
 * 但 `src/App.css` 是**兩個模式共用**的——放在那裡的修仙版素材，普通版照樣吃到。
 *
 * 實際踩到兩個：
 *   1. `.main-content::before` 在 App.css 直接掛 `/themes/xianxia/xianxia-dashboard-bg.png`，
 *      而把它壓淡的 `opacity:.18` 只寫在 xianxia-complete.css 裡
 *      → 普通版看到的是**全不透明**的修仙版底圖。
 *   2. `<XianxiaIcon>` render 的是 `<img src="/themes/xianxia/icons-v3/...">`，
 *      側邊欄那批完全沒有 gate → 普通版的導覽圖示一直是修仙版的 PNG。
 *
 * 兩個洞都是「切版面模式」這個功能出現**之前**留下的：當時整個 app 就是修仙版，
 * 「全站生效」是對的；有了切換之後沒人回頭把它們搬走。
 *
 * ⚠️ 這支讀的是 build 產物（minify 後），所以選擇器是 `[data-theme-mode=xianxia]`
 *    **沒有引號**。第一版我用帶引號的字串比對，把兩條本來就有防護的規則誤報成漏洞。
 * ⚠️ 比對前要先剝掉註解。第一版沒剝，於是我自己寫在 CSS 註解裡的
 *    「不需要 data-theme-mode 前綴」這句話被當成真的有前綴 → 又一次誤報。
 *    量測工具自己先錯兩次，差點去改沒壞的東西。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const DIST = 'dist'
if (!existsSync(DIST)) { console.error('找不到 dist/，請先跑 npm run build'); process.exit(1) }
const cssFile = readdirSync(join(DIST, 'assets')).find(f => /^index-.*\.css$/.test(f))
if (!cssFile) { console.error('dist/assets 裡找不到 index-*.css'); process.exit(1) }

let pass = 0
const fails = []
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('✅ ' + name) }
  else { fails.push(name); console.log('❌ ' + name + (detail ? '\n     ' + detail : '')) }
}

// 修仙版限定的素材。放這些路徑的東西一律只能在修仙版出現。
const XIANXIA_ASSET = /\/themes\/xianxia\/|\/osm\/modeltag-(blade|rune)\./
// build 產物是 minify 過的，屬性選擇器沒有引號
const GUARD = /\[data-theme-mode\s*=\s*["']?xianxia/
const stripComments = t => t.replace(/\/\*[\s\S]*?\*\//g, '')

function srcFilesTsx() {
  const out = []
  const walk = d => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.tsx$/.test(e.name)) out.push(p)
    }
  }
  walk('src')
  return out
}

// ── 1. 共用的 bundled CSS 裡不可以有沒防護的修仙版素材 ──
const css = readFileSync(join(DIST, 'assets', cssFile), 'utf8')
const leaks = []
let guarded = 0
for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*url\([^)]*\)[^{}]*)\}/g)) {
  const imgs = [...body.matchAll(/url\((["']?)([^)"']+)\1\)/g)]
    .map(m => m[2])
    .filter(u => !u.startsWith('data:') && XIANXIA_ASSET.test(u))
  if (!imgs.length) continue
  if (GUARD.test(sel)) guarded++
  else leaks.push(sel.trim().slice(0, 100) + '  ->  ' + imgs.join(', '))
}
console.log('\n' + cssFile + '：引用修仙版素材的規則 ' + (guarded + leaks.length)
  + ' 條，有防護 ' + guarded + ' 條')
check('共用的 bundled CSS 裡，沒有未加防護的修仙版素材',
  leaks.length === 0, leaks.join('\n     '))

// ── 2. XianxiaIcon 的呼叫端要有 themeMode 判斷 ──
// 它 render 的是 <img>，CSS 掃不到、data-theme-mode 也用不上。
//
// 這裡用「數量上限」而不是「逐檔白名單」：白名單要為每個檔案寫一行理由，
// 而理由會過期（那個檔案後來被用在普通版也沒人會回來改）。數字只回答
// 一個問題——有沒有變多；要減少必須連同這個數字一起改，等於強迫改的人看到。
const GATED_LINE = /themeMode === 'xianxia' \?|themeMode === 'xianxia' &&|xianxia \?.*<XianxiaIcon/
let total = 0
let ungated = 0
const ungatedFiles = new Set()
for (const f of srcFilesTsx()) {
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const n = (line.match(/<XianxiaIcon/g) || []).length
    if (!n) continue
    total += n
    if (!GATED_LINE.test(line)) { ungated += n; ungatedFiles.add(f) }
  }
}
// 2026-09-16 當下：39 個呼叫點，18 個還沒 gate——側邊欄那 10 個已經改成
// 普通版走 group.icon（原本的 emoji）；剩下的是頁面內的裝飾用圖示，
// 普通版要顯示什麼還沒決定，所以先釘住數量不讓它變多。
const UNGATED_BUDGET = 18
console.log('\nXianxiaIcon 呼叫點 ' + total + ' 個，未 gate ' + ungated
  + ' 個（上限 ' + UNGATED_BUDGET + '）')
check('未 gate 的 XianxiaIcon 沒有變多（<= ' + UNGATED_BUDGET + '）',
  ungated <= UNGATED_BUDGET, [...ungatedFiles].join('\n     '))

// ── 3. 保護模型沒有被換掉 ──
// xianxia-complete.css 只在修仙版載入，本來就不需要選擇器前綴。
// 如果它開始出現前綴，代表有人以為前綴才是保護來源——之後把規則搬去 App.css
// 也不會有人攔，那正是這次那兩個洞的成因。
const xx = stripComments(readFileSync(join(DIST, 'xianxia-complete.css'), 'utf8'))
check('xianxia-complete.css 仍然靠「整份不載入」保護，不是靠選擇器前綴',
  !GUARD.test(xx), '出現了 data-theme-mode 前綴，代表有人把保護模型換了')

console.log('\n通過 ' + pass + '｜失敗 ' + fails.length)
if (fails.length) process.exit(1)
