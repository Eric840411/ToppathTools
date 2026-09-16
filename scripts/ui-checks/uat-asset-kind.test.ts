/**
 * 上傳素材類型判斷。
 *
 *   npx tsx scripts/ui-checks/uat-asset-kind.test.ts
 *
 * 重點不是「分類分得對」，而是**分類不會把東西擋掉**，以及
 * **不會因為瀏覽器回報了怪 MIME 就把使用者的檔案標錯**。
 */
import { assetKind, UAT_ASSET_KIND_LABEL, formatBytes } from '../../shared/uat-asset-kind.js'

let pass = 0
const fails: string[] = []
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log('✅ ' + name) }
  else { fails.push(name); console.log(`❌ ${name} | got: ${JSON.stringify(got)} | want: ${JSON.stringify(want)}`) }
}

// ── 一般情況 ──
eq('mp4 是影片', assetKind('demo.mp4', 'video/mp4'), 'video')
eq('png 是圖檔', assetKind('shot.png', 'image/png'), 'image')
eq('csv 是 CSV', assetKind('report.csv', 'text/csv'), 'csv')
eq('pdf 是文件', assetKind('spec.pdf', 'application/pdf'), 'doc')

// ── ⚠️ 瀏覽器回報的 MIME 不可靠，這幾條是實際會遇到的 ──
eq('Excel 存過的 CSV（MIME 變成 ms-excel）仍然是 CSV',
  assetKind('report.csv', 'application/vnd.ms-excel'), 'csv')
eq('MIME 空字串時靠副檔名', assetKind('report.csv', ''), 'csv')
eq('MIME 空字串的 mp4 也認得出來', assetKind('clip.mp4', ''), 'video')
eq('副檔名大寫一樣認得', assetKind('SHOT.PNG', ''), 'image')
eq('MIME 說是 octet-stream，副檔名說是圖，聽副檔名',
  assetKind('shot.jpg', 'application/octet-stream'), 'image')

// ⚠️ 真正的 .xls 跟 Excel 存的 .csv 共用同一個 MIME，所以那個 MIME 不能拿來判 csv
eq('真正的 xls 不會被誤判成 CSV', assetKind('book.xls', 'application/vnd.ms-excel'), 'doc')

// ── 沒有副檔名時退回 MIME ──
eq('沒有副檔名但 MIME 說是影片', assetKind('noext', 'video/quicktime'), 'video')
eq('兩邊都沒結論才是其他', assetKind('noext', ''), 'other')
eq('沒看過的副檔名 + 沒看過的 MIME → 其他', assetKind('thing.zzz', 'application/x-zzz'), 'other')

// ── ⚠️ 分類不可以變成「擋下來」的依據 ──
// 這裡沒有任何 throw／null 的路徑：任何檔案都一定拿得到一個分類，
// 拿不到分類的東西才可能在上層被當成「不支援」擋掉。
for (const [name, mime] of [['weird.exe', ''], ['', ''], ['.gitignore', ''], ['a.b.c.tar.gz', '']] as const) {
  const k = assetKind(name, mime)
  eq(`任何檔案都有分類：${JSON.stringify(name)} → ${k}`, typeof k === 'string' && k.length > 0, true)
  eq(`  而且分類都有對應的中文標籤`, typeof UAT_ASSET_KIND_LABEL[k] === 'string', true)
}

// ── 檔案大小顯示 ──
eq('小檔用 B', formatBytes(512), '512 B')
eq('中檔用 KB', formatBytes(2048), '2.0 KB')
eq('大檔用 MB', formatBytes(5 * 1024 * 1024), '5.0 MB')

console.log(`\n通過 ${pass}｜失敗 ${fails.length}`)
if (fails.length) process.exit(1)
