/**
 * 「上傳檔案」積木的素材選擇器有沒有真的長出來。
 *
 *   npx vite --port 5199 --strictPort      （另開一個視窗）
 *   node scripts/ui-checks/uat-asset-picker-render.mjs
 *
 * 為什麼要有這支（2026-09-16 使用者回報）：積木本身出現了、參數標籤與說明也對，
 * 但「要上傳的素材」那格是一個**普通的文字輸入框**——因為參數表單沒有處理
 * `type: 'asset'`，就會靜靜地落到最後那個 `<input type="text">` 分支。
 *
 * ⚠️ 這種壞法沒有任何錯誤訊息：標籤、說明文字都是從 API 來的，看起來完全正常，
 *    只有「輸入框長得不對」這一個徵兆。單純檢查「積木存在」或「參數有宣告」
 *    都抓不到——一定要真的渲染出來看 DOM。
 */
import { chromium } from 'playwright'
import { BLOCK_DEFS } from '../../server/uat-runner/block-engine.js'
const b = await chromium.launch()
const page = await b.newPage({ viewport: { width: 1280, height: 900 } })
const errs = []; page.on('pageerror', e => errs.push(e.message))
await page.route('**/api/**', async route => {
  const u = new URL(route.request().url())
  let d = { ok: true }
  if (u.pathname.endsWith('/scan')) d = { ok: true, tcs: [{ recordId: 'rec0', storageKey: 'tblFixture:rec0', number: 'T-A-001', text: '測試', sub: 'Dashboard', source: 'live' }] }
  else if (u.pathname.endsWith('/blocks')) d.blockDefs = BLOCK_DEFS
  else if (u.pathname.endsWith('/upload-assets')) d = { ok: true, assets: [{ id: 'a1', name: 'demo.mp4', mime: 'video/mp4', size: 1024, sha256: 'x', createdBy: null, createdAt: Date.now() }], maxBytes: 20971520 }
  else if (u.pathname.endsWith('/recorded-scripts')) d.scripts = []
  else if (u.pathname.endsWith('/results')) d.runs = []
  await route.fulfill({ json: d })
})
await page.goto('http://127.0.0.1:5199/scripts/ui-checks/multi-tc-fixture.html')
await page.waitForTimeout(600)
await page.locator('.uat-multi-candidates input').first().check()
await page.getByLabel('新增積木種類').selectOption('upload_file')
await page.getByRole('button', { name: '加入步驟', exact: true }).click()
await page.waitForTimeout(400)
const hasPicker = await page.locator('.uat-asset-picker').count()
const assetSelect = await page.getByLabel('要上傳的素材').count()
const kindFilter = await page.getByLabel('素材類型篩選').count()
const fileInput = await page.getByLabel('上傳新素材').count()
const optionText = hasPicker ? await page.getByLabel('要上傳的素材').innerText().catch(() => '') : ''
// ⚠️ 刻意不寫 accept：限制副檔名就測不了「上傳錯誤格式應該被拒絕」
const accept = hasPicker ? await page.getByLabel('上傳新素材').getAttribute('accept') : 'n/a'
await b.close()

let pass = 0
const fails = []
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('✅ ' + name) }
  else { fails.push(name); console.log('❌ ' + name + (detail ? ' | ' + detail : '')) }
}
ok('素材選擇器有渲染出來（不是退回普通文字框）', hasPicker === 1, 'count=' + hasPicker)
ok('有「要上傳的素材」下拉', assetSelect === 1)
ok('有類型篩選', kindFilter === 1)
ok('有上傳新素材的檔案欄位', fileInput === 1)
ok('清單會標出類型與大小', /\[影片\].*demo\.mp4/.test(optionText), optionText)
ok('檔案欄位沒有限制副檔名（限制了就測不了「錯誤格式應被拒絕」）', accept === null, 'accept=' + accept)
ok('過程中沒有 pageerror', errs.length === 0, errs.join('; '))

console.log(`
通過 ${pass}｜失敗 ${fails.length}`)
if (fails.length) process.exit(1)
