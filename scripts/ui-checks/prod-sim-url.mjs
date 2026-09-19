/**
 * scripts/ui-checks/prod-sim-url.mjs
 *
 * 驗「模擬正式」分頁的轉換 `toProdSimUrls()`（`src/data/prodSimUrl.ts`）。
 *
 * ⚠️ **這條線要守的不是「會不會轉」，是「轉出來的東西有沒有悄悄變質」。**
 *    產不出連結是看得見的失敗；真正危險的是產得出來、看起來完全正常，
 *    但少了一個參數或換了編碼——開進去是另一種模式，而畫面上什麼都不會說。
 *
 * 所以最硬的那幾條斷言是：
 *   ① 實際 URL 帶**兩個 `mode`**（`mode=live` 與 `mode=mobile`），兩個都要活著
 *   ② query 逐字元等於原字串（順序、編碼、`+`、`%2F` 都不准動）
 *   ③ 只貼 token（沒有 `?`）**不准**生出連結——猜出來的 gameid/studioid 會得到一條錯的連結
 *
 * 跑法：npx tsx scripts/ui-checks/prod-sim-url.mjs
 */
import path from 'path'
import { pathToFileURL, fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const { toProdSimUrls } = await import(
  pathToFileURL(path.join(root, 'src/data/prodSimUrl.ts')).href)

const PROD = 'https://osm-redirect.osmplay.com/?token=047bcc1526b980bf5509b4393a801d3f-111724089&platform=50&mode=live&language=en_us&studioid=cp&lang=en_us&username=cposmtest4&device=mobile&gameid=osmwlzbhelix&mode=mobile&isPwaClaimed=1'
const RAW_QUERY = PROD.slice(PROD.indexOf('?') + 1)
const H5 = 'https://osm-h5-prod.osmslot.org/'
const PC = 'https://osm-pc-prod.osmslot.org/'

/**
 * 斷言清單寫成「吃一個轉換函式」，同一套就能拿去打突變體。
 * 每條回傳 true/false，失敗訊息由 name 本身表達。
 */
const ASSERTS = [
  ['H5 換成模擬正式網域', f => f(PROD).urls.h5.startsWith(H5)],
  ['PC 換成模擬正式網域', f => f(PROD).urls.pc.startsWith(PC)],
  // ① 重複的 mode 兩個都要在
  ['兩個 mode 都保留（live + mobile）', f => {
    const q = f(PROD).urls.h5.split('?')[1] ?? ''
    return (q.match(/(^|&)mode=/g) ?? []).length === 2 && q.includes('mode=live') && q.includes('mode=mobile')
  }],
  // ② query 逐字元相同
  ['query 逐字元等於原字串', f => f(PROD).urls.h5 === `${H5}?${RAW_QUERY}`],
  ['PC 與 H5 只差網域（PC 不改任何參數）', f => {
    const r = f(PROD)
    return r.urls.pc.slice(PC.length) === r.urls.h5.slice(H5.length)
  }],
  ['device=mobile 不准被改掉', f => f(PROD).urls.pc.includes('device=mobile')],
  // 編碼不准被正規化：URLSearchParams 重新序列化會把 %2F → %2F（可能）但會把 + 變 %2B、
  // 也會重排／改寫某些字元。用一條刻意難看的 query 釘住。
  ['特殊編碼原樣保留（+ 與 %2F 不被改寫）', f => {
    const u = f('https://osm-redirect.osmplay.com/?token=a+b%2Fc-1&gameid=g&empty=&flag').urls.h5
    return u.endsWith('?token=a+b%2Fc-1&gameid=g&empty=&flag')
  }],
  // ③ 只有 token 不准生連結
  ['只貼 token 不產出連結', f => {
    const r = f('047bcc1526b980bf5509b4393a801d3f-111724089')
    return r.ok === false && !r.urls.h5 && !r.urls.pc && !!r.error
  }],
  ['空輸入：ok=false、連結為空、不報錯', f => {
    const r = f('   ')
    return r.ok === false && !r.urls.h5 && !r.urls.pc && !r.error
  }],
  ['測試環境 token 要警告（產得出來但會登不進去）', f => {
    const r = f('https://osm-redirect.osmslot.org/?token=x-1&gameid=g')
    return r.ok === true && r.warnings.some(w => w.includes('測試環境'))
  }],
  ['正式網域不該有環境警告', f => {
    const r = f(PROD)
    return r.ok === true && !r.warnings.some(w => w.includes('測試環境'))
  }],
  ['沒有 token 參數要警告', f => {
    const r = f('https://osm-redirect.osmplay.com/?gameid=g&platform=50')
    return r.ok === true && r.warnings.some(w => w.includes('token'))
  }],
  ['hash 一起帶過去', f => f(`${PROD}#frag`).urls.h5.endsWith('#frag')],
  ['前後空白與引號包住仍可解析', f => f(`  "${PROD}"  `).urls.h5 === `${H5}?${RAW_QUERY}`],
  ['解析出欄位給畫面顯示', f => {
    const r = f(PROD)
    return r.fields.username === 'cposmtest4' && r.fields.gameid === 'osmwlzbhelix'
        && r.fields.studioid === 'cp' && r.sourceHost === 'osm-redirect.osmplay.com'
  }],
]

let pass = 0, fail = 0
console.log('— 本體 —')
for (const [name, run] of ASSERTS) {
  let ok = false
  try { ok = run(toProdSimUrls) === true } catch (e) { ok = false; name.length && console.log(`    (throw) ${e.message}`) }
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
  ok ? pass++ : fail++
}

/**
 * 突變體：**每一個都是真的可能被寫出來的版本**，而且都「看起來會動」——
 * 貼一條普通 URL 進去照樣產出連結，肉眼分不出差別。
 *
 * ⚠️ 第三欄是**預期抓到它的那條斷言**。只看「有沒有被殺」不夠：
 *    隨便一條無關的斷言碰巧失敗也算殺掉，那條真正該守的防線其實是空的。
 */
const MUTANTS = [
  ['M1 用 URLSearchParams 重新序列化（最常見的「順手整理」）', input => {
    const i = input.indexOf('?')
    if (i < 0) return { ok: false, error: 'x', warnings: [], urls: { h5: '', pc: '' }, fields: {}, sourceHost: '' }
    const sp = new URLSearchParams(input.slice(i + 1))
    const q = Object.entries(Object.fromEntries(sp)).map(([k, v]) => `${k}=${v}`).join('&')
    return { ok: true, warnings: [], urls: { h5: `${H5}?${q}`, pc: `${PC}?${q}` }, fields: {}, sourceHost: '' }
  }, '兩個 mode 都保留（live + mobile）'],
  ['M2 PC 版順手把 device 改成 desktop', input => {
    const i = input.indexOf('?')
    const q = input.slice(i + 1)
    return { ok: true, warnings: [], urls: { h5: `${H5}?${q}`, pc: `${PC}?${q.replace('device=mobile', 'device=desktop')}` }, fields: {}, sourceHost: '' }
  }, 'PC 與 H5 只差網域（PC 不改任何參數）'],
  ['M3 只有 token 時自動補預設參數', input => {
    const has = input.includes('?')
    const q = has ? input.slice(input.indexOf('?') + 1) : `token=${input.trim()}&platform=50&studioid=cp`
    return { ok: true, warnings: [], urls: { h5: `${H5}?${q}`, pc: `${PC}?${q}` }, fields: {}, sourceHost: '' }
  }, '只貼 token 不產出連結'],
  ['M4 用字串 replace 換網域（測試環境 token 會被默默接受）', input => {
    const h5 = input.replace(/https?:\/\/[^/]+\//i, H5)
    return { ok: true, warnings: [], urls: { h5, pc: input.replace(/https?:\/\/[^/]+\//i, PC) }, fields: {}, sourceHost: '' }
  }, '測試環境 token 要警告（產得出來但會登不進去）'],
  ['M5 空輸入也回 ok（畫面上複製鈕不會停用）', input => {
    const i = input.indexOf('?')
    const q = i < 0 ? '' : input.slice(i + 1)
    return { ok: true, warnings: [], urls: { h5: `${H5}?${q}`, pc: `${PC}?${q}` }, fields: {}, sourceHost: '' }
  }, '空輸入：ok=false、連結為空、不報錯'],
]

console.log('\n— 突變體（每個都必須被殺）—')
let killed = 0
for (const [name, mutant, expected] of MUTANTS) {
  const caught = []
  for (const [aName, run] of ASSERTS) {
    let ok = false
    try { ok = run(mutant) === true } catch { ok = false }
    if (!ok) caught.push(aName)
  }
  // 「被殺」要求**預期的那條**有抓到，不是隨便一條失敗就算
  const dead = caught.includes(expected)
  console.log(`  ${dead ? 'KILLED' : 'SURVIVED'}  ${name}`)
  console.log(`            ↳ 預期防線：${expected}${dead ? '（抓到）' : '（沒抓到！）'}`)
  if (dead) killed++
  else fail++
}

console.log(`\n本體 ${pass} PASS / ${fail} FAIL｜突變體 ${killed}/${MUTANTS.length} 被殺`)
process.exit(fail === 0 && killed === MUTANTS.length ? 0 : 1)
