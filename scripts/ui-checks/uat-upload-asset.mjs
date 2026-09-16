/**
 * 「上傳檔案」素材：端點行為 ＋ 積木執行語意。
 *
 *   node scripts/ui-checks/uat-upload-asset.mjs        （需要本機 server 在跑）
 *
 * 為什麼這樣設計，見 shared.ts 的 uat_upload_assets 那段註解。這支釘住的是
 * 幾個「做錯了也不會報錯」的點：
 *   - 取檔票不對要回 403，**而且不存在的 id 也要回 403**——回 404 等於讓沒有票
 *     的人可以拿來探測哪些 id 存在。
 *   - 積木取不到素材一定要失敗，**不可以跳過**：跳過的話「檔案沒上傳」跟
 *     「上傳成功」在後面那顆斷言之前長得一模一樣。
 *   - 分類只用來顯示，**不可以擋上傳**——擋了就測不了「上傳錯誤格式應被拒絕」。
 *
 * ⚠️ 會在 DB 留下測試素材，跑完自己刪掉。
 */
import { runSteps, BLOCK_DEFS } from '../../server/uat-runner/block-engine.js'

const BASE = process.env.UAT_BASE || 'http://127.0.0.1:3000'
let pass = 0
const fails = []
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) }
  else { fails.push(name); console.log('❌ ' + name + ' | got: ' + g + ' | want: ' + w) }
}
const ok = (name, cond, detail) => eq(name + (detail ? ' (' + detail + ')' : ''), !!cond, true)

const j = async (url, init) => {
  const r = await fetch(BASE + url, init)
  let body = null
  try { body = await r.json() } catch { /* 二進位或空回應 */ }
  return { status: r.status, body }
}

let assetId = null
try {
  // ── 上傳 ──
  const csv = Buffer.from('Account,Amount\nA001,100\n').toString('base64')
  const up = await j('/api/osm-uat/upload-assets', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    // ⚠️ 故意用 Excel 存過的 CSV 那種 MIME，確認不會因此被擋
    body: JSON.stringify({ name: '__uat_check__.csv', mime: 'application/vnd.ms-excel', dataBase64: csv }),
  })
  ok('上傳成功', up.status === 200 && up.body?.ok, 'HTTP ' + up.status)
  assetId = up.body?.asset?.id ?? null
  ok('回傳 sha256（腳本記 id，內容可驗）', typeof up.body?.asset?.sha256 === 'string')

  // ── 同內容同檔名不重複長一筆 ──
  const again = await j('/api/osm-uat/upload-assets', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '__uat_check__.csv', mime: 'text/csv', dataBase64: csv }),
  })
  eq('同內容重複上傳回同一個 id（用內容認，不是用檔名）', again.body?.asset?.id, assetId)

  // ── 大小上限 ──
  const big = Buffer.alloc(21 * 1024 * 1024, 1).toString('base64')
  const tooBig = await j('/api/osm-uat/upload-assets', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '__uat_check_big__.bin', mime: '', dataBase64: big }),
  })
  eq('超過 20MB 回 413', tooBig.status, 413)

  // ── 取檔票 ──
  const noToken = await fetch(`${BASE}/api/osm-uat/upload-assets/${assetId}/raw`)
  eq('沒有票 → 403', noToken.status, 403)
  const badToken = await fetch(`${BASE}/api/osm-uat/upload-assets/${assetId}/raw?token=bogus`)
  eq('票不對 → 403', badToken.status, 403)
  const ghost = await fetch(`${BASE}/api/osm-uat/upload-assets/does-not-exist/raw?token=bogus`)
  eq('不存在的 id 也是 403，不是 404（不讓人拿來探測）', ghost.status, 403)

  // ── 清單 ──
  const list = await j('/api/osm-uat/upload-assets')
  ok('清單查得到剛上傳的那筆', (list.body?.assets ?? []).some(a => a.id === assetId))
  ok('清單不回檔案內容（只回 metadata）',
    (list.body?.assets ?? []).every(a => !('data' in a) && !('dataBase64' in a)))

  // ── 積木宣告 ──
  const def = BLOCK_DEFS.upload_file
  ok('有「上傳檔案」這顆積木', !!def)
  eq('素材參數是 asset 型別（前端才會長出選擇器）',
    def.params.find(p => p.key === 'assetId')?.type, 'asset')
  ok('沒有任何副檔名/型別限制的參數（限制了就測不了「錯誤格式應被拒絕」）',
    !def.params.some(p => /accept|mime|ext|type/i.test(p.key)),
    def.params.map(p => p.key).join(','))

  // ── 執行語意：用假 ctx，不開瀏覽器 ──
  const mkCtx = uploadFile => ({
    page: { async evaluate() { return null }, async waitForTimeout() {}, locator() { return { first: () => ({ click: async () => {} }) } } },
    async openPath() {}, resolveSubtypePath() { return null },
    async takeScreenshot(n) { return `/tmp/${n}.png` },
    ...(uploadFile ? { uploadFile } : {}),
  })

  const good = await runSteps([{ action: 'upload_file', selector: 'input[type=file]', assetId: 'x' }],
    mkCtx(async () => ({ ok: true, name: 'a.csv', size: 24 })))
  ok('上傳成功 → 這一步不擋', good.criticalFails.length === 0, good.notes)

  const gone = await runSteps([{ action: 'upload_file', selector: 'input[type=file]', assetId: 'x' }],
    mkCtx(async () => ({ ok: false, error: '取不到素材（HTTP 404）' })))
  ok('取不到素材 → FAIL，不可以跳過', gone.pass === false, gone.notes)

  const noAsset = await runSteps([{ action: 'upload_file', selector: 'input[type=file]' }],
    mkCtx(async () => ({ ok: true, name: 'a', size: 1 })))
  ok('沒指定素材 → FAIL（設定錯誤，不是執行期狀況）', noAsset.pass === false, noAsset.notes)

  const oldRunner = await runSteps([{ action: 'upload_file', selector: 'input[type=file]', assetId: 'x' }], mkCtx(null))
  ok('runner 太舊沒有上傳能力 → FAIL 並說要更新程式碼',
    oldRunner.pass === false && /更新程式碼/.test(oldRunner.notes), oldRunner.notes)
} finally {
  if (assetId) {
    const del = await fetch(`${BASE}/api/osm-uat/upload-assets/${assetId}`, { method: 'DELETE' })
    console.log('\n測試素材已刪除：HTTP ' + del.status)
  }
}

console.log(`\n通過 ${pass}｜失敗 ${fails.length}`)
if (fails.length) { fails.forEach(f => console.log('  ❌ ' + f)); process.exit(1) }
