/**
 * UAT 錄製視窗：螢幕放不下設定的解析度時，**縮小顯示、不改頁面尺寸**。
 *
 * 2026-10-02 使用者回報：H5 用 390x844／500x877 錄影都看不到完整版面（最下面的 Me／Live Slots／Quick Join 被切掉）。
 * 實測頁面本身在這兩個尺寸都是完整的；是錄製視窗＝頁面高度＋瀏覽器標題列／網址列，超過筆電螢幕可用高度（約 900），
 * 作業系統把視窗夾短，頁面還是 877 高，底部就被裁掉。
 *
 * 不能直接改小解析度：錄下來的步驟是**照座標點擊**，用 500x877 錄的腳本換尺寸重播會點錯位置。
 * 所以頁面維持原尺寸（CSS 座標不變），只用 CDP Emulation.setDeviceMetricsOverride 的 `scale` 把畫面縮小到放得下。
 *
 * @param {{ width: number, height: number, availWidth: number, availHeight: number, chromeWidth: number, chromeHeight: number }} m
 *   width/height＝設定的頁面尺寸；availWidth/availHeight＝screen.avail*；chrome*＝視窗外框（outer − inner）
 * @returns {number} 0.5～1，取到小數點後兩位（往下取，寧可多留一點邊）
 */
export function recordingScale(m) {
  const margin = 12
  const fitH = (m.availHeight - m.chromeHeight - margin) / m.height
  const fitW = (m.availWidth - m.chromeWidth - margin) / m.width
  const s = Math.min(1, fitH, fitW)
  if (!Number.isFinite(s) || s <= 0) return 1 // 量不到螢幕就照原尺寸，不要亂縮
  return Math.max(0.5, Math.floor(s * 100) / 100)
}
