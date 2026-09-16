/**
 * 上傳素材的類型判斷（影片／圖檔／CSV／文件／其他）。
 *
 * ⚠️ 這個分類**只用來顯示與篩選，不用來擋上傳**。
 *    擋了就測不了「上傳錯誤格式應該被拒絕」——那本來就是要測的 TC。
 *    該擋的是受測的後台，不是我們的工具（CodeX review 定案）。
 *
 * ⚠️ 不能只信瀏覽器回報的 MIME。實際會遇到的：
 *      .csv  →  text/csv ／ application/vnd.ms-excel ／ 空字串
 *    （Excel 開過再存的 CSV 幾乎都會變成第二種。）
 *    所以副檔名與 MIME 任一對得上就算，兩邊都對不上才落到「其他」。
 *
 * 放在 shared/：前端的素材清單與後端的列表 API 要用同一份規則，
 * 各寫一份的話會出現「上傳完顯示圖檔、重新整理變成其他」這種不一致。
 * shared/ 只放純函式，不碰 fs／DB／env。
 */

export type UatAssetKind = 'video' | 'image' | 'csv' | 'doc' | 'other'

export const UAT_ASSET_KIND_LABEL: Record<UatAssetKind, string> = {
  video: '影片',
  image: '圖檔',
  csv: 'CSV',
  doc: '文件',
  other: '其他',
}

const EXT: Record<string, UatAssetKind> = {
  mp4: 'video', mov: 'video', avi: 'video', mkv: 'video', webm: 'video', m4v: 'video', wmv: 'video',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', svg: 'image',
  heic: 'image', heif: 'image', avif: 'image',
  csv: 'csv', tsv: 'csv',
  pdf: 'doc', doc: 'doc', docx: 'doc', xls: 'doc', xlsx: 'doc', ppt: 'doc', pptx: 'doc', txt: 'doc',
}

function fromMime(mime: string): UatAssetKind | null {
  const m = mime.trim().toLowerCase()
  if (!m) return null
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('image/')) return 'image'
  if (m === 'text/csv' || m === 'text/tab-separated-values') return 'csv'
  // ⚠️ application/vnd.ms-excel 不能直接判成 csv——真正的 .xls 也是這個 MIME。
  //    這種模稜兩可的一律交給副檔名決定，不要用 MIME 猜。
  if (m === 'application/pdf' || m.startsWith('text/')
    || m.includes('officedocument') || m.includes('msword')) return 'doc'
  return null
}

export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).trim().toLowerCase()
}

export function assetKind(name: string, mime: string): UatAssetKind {
  const byExt = EXT[extensionOf(name)] ?? null
  // 副檔名優先：它是使用者真正命名的東西，而 MIME 是系統猜的。
  // 兩邊都沒有結論才是 other。
  return byExt ?? fromMime(mime) ?? 'other'
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
