/**
 * 上傳一定要打到「指定的那個欄位」，打不準就要當場失敗。
 *
 *   node scripts/ui-checks/uat-upload-target.mjs
 *
 * 為什麼要有這支（2026-09-16 使用者實際踩到）：
 * Bonus Page Setting 同一頁有 H5 Icon 與 PC Icon 兩塊上傳區，**結構一模一樣**。
 *
 * ⚠️ 原本 runner 用 `.first().setInputFiles(...)`，所以選擇器只要不夠精確，
 *    就會**靜靜地傳到第一個**——上傳成功、綠燈、截圖都有，圖卻進了別的欄位，
 *    而報告上完全看不出來。只能回後台人工檢查圖到底進了哪一格。
 *
 * 實測到的陷阱：`div:has-text("PC Icon")` 只差 `.el-card` 一個字，就會打到 H5。
 *
 * 所以現在強制唯一命中：命中 0 個或 2 個以上一律失敗（CodeX review 指出）。
 * 這支就是釘住那條線，順便把「哪些寫法真的準」留成可執行的文件。
 */
import { chromium } from 'playwright'

let pass = 0
const fails = []
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) }
  else { fails.push(name); console.log('❌ ' + name + ' | got: ' + g + ' | want: ' + w) }
}

// 照使用者那一頁的結構：兩張卡，標題不同，其餘完全相同
const PAGE = (opts = {}) => `
<div class="wrap">
  <div class="el-card"><span class="title">H5 Icon</span>
    <div class="el-upload"><input type="file" class="el-upload__input" style="display:none"><i>+</i></div>
  </div>
  <div class="el-card"><span class="title">PC Icon</span>
    ${opts.pcMissingInput ? '<div class="el-upload"><i>+</i></div>'
      : `<div class="el-upload"><input type="file" class="el-upload__input" style="display:none">${
        opts.pcTwoInputs ? '<input type="file" class="el-upload__input" style="display:none">' : ''}<i>+</i></div>`}
  </div>
</div>
<script>
  document.querySelectorAll('input[type=file]').forEach(inp => inp.addEventListener('change', () => {
    document.title = inp.closest('.el-card').querySelector('.title').textContent
  }))
</scr` + `ipt>`

/** 重現 runner 的 uploadFile 取用邏輯：強制唯一命中，不可以有 .first() */
async function upload(page, selector) {
  const loc = page.locator(selector)
  const hits = await loc.count()
  if (hits === 0) return { ok: false, why: 'none' }
  if (hits > 1) return { ok: false, why: 'many', hits }
  await loc.setInputFiles({ name: 'a.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('x') })
  return { ok: true, landedOn: await page.title() }
}

const browser = await chromium.launch()
try {
  const page = await browser.newPage()

  // ── 正常情況：用標題文字圈住那張卡，兩個方向都要準 ──
  await page.setContent(PAGE())
  eq('用 .el-card:has-text("PC Icon") → 真的打到 PC Icon',
    await upload(page, '.el-card:has-text("PC Icon") input[type=file]'), { ok: true, landedOn: 'PC Icon' })

  // ⚠️ H5／PC 對調也要準——只認順序的寫法會在這裡現形
  await page.setContent(PAGE())
  eq('用 .el-card:has-text("H5 Icon") → 真的打到 H5 Icon',
    await upload(page, '.el-card:has-text("H5 Icon") input[type=file]'), { ok: true, landedOn: 'H5 Icon' })

  // ── 🚨 核心：選擇器不夠精確時**不可以**默默傳到第一個 ──
  await page.setContent(PAGE())
  const broad = await upload(page, 'div:has-text("PC Icon") input[type=file]')
  eq('外層寫太寬（div 而不是 .el-card）→ 失敗，不可以默默傳到 H5', broad, { ok: false, why: 'many', hits: 2 })

  await page.setContent(PAGE())
  const bare = await upload(page, 'input[type=file]')
  eq('只寫 input[type=file]（兩個都符合）→ 失敗，不可以取第一個', bare, { ok: false, why: 'many', hits: 2 })

  // ── PC 那塊根本沒有 input：要說找不到，不能退回去傳 H5 ──
  await page.setContent(PAGE({ pcMissingInput: true }))
  eq('指定的欄位沒有 input → 失敗，不可以退回別的欄位',
    await upload(page, '.el-card:has-text("PC Icon") input[type=file]'), { ok: false, why: 'none' })

  // ── 同一個容器裡有兩個 input：也要停下來 ──
  await page.setContent(PAGE({ pcTwoInputs: true }))
  eq('容器裡有兩個 input → 失敗，不可以猜一個',
    await upload(page, '.el-card:has-text("PC Icon") input[type=file]'), { ok: false, why: 'many', hits: 2 })

  // ── 隱藏的 input 也要塞得進去（Element UI 的上傳欄位一定是隱藏的）──
  await page.setContent(PAGE())
  eq('display:none 的 input 一樣塞得進去',
    (await upload(page, '.el-card:has-text("H5 Icon") .el-upload__input')).ok, true)
} finally {
  await browser.close()
}

// ── 接線：runner 裡不可以再出現 .first().setInputFiles ──
const { readFileSync } = await import('node:fs')
const runner = readFileSync('server/uat-runner/run-lark-tc-backend.js', 'utf8')
eq('runner 沒有用 .first() 塞檔案（那正是會靜默傳錯欄位的寫法）',
  /\.first\(\)\s*\.setInputFiles/.test(runner), false)
eq('runner 有先數命中數量再決定', /await locator\.count\(\)/.test(runner), true)

console.log(`\n通過 ${pass}｜失敗 ${fails.length}`)
if (fails.length) { fails.forEach(f => console.log('  ❌ ' + f)); process.exit(1) }
