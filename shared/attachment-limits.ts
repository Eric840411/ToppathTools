/**
 * Jira 附件大小上限——前後端共用這一份（批量開單／評論／修改的手動上傳，以及從 Sheet 預先抓附件）。
 *
 * ⚠️ 這是**工具自己的限制**，不是 Jira 的。原本寫 10MB、註解說「Jira Cloud 預設」——那是錯的：
 *    2026-10-01 實際打 `/rest/api/3/attachment/meta` 得到 `uploadLimit: 1073741824`（1 GiB）。
 *    使用者有 57MB 的影片被我們自己擋掉。
 *
 * 單位：bytes，`100 * 1024 * 1024` 精確是 100 MiB（≈104.9 百萬位元組）。畫面寫「100MB」，跟 Windows 檔案總管
 * 顯示的 MB（其實也是 MiB）是同一個意思——57,397 KB 的檔案在這裡是 56 MiB，不會被誤擋。
 *
 * ⚠️ Spug 前面若有反向代理（nginx `client_max_body_size` 之類），它的上限要比這裡大一點——
 *    multipart 表單有邊界與標頭，實際請求比檔案本身大幾 KB。被代理擋下時前端拿到的是 HTTP 413。
 */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024

/** 畫面上顯示用 */
export const MAX_ATTACHMENT_LABEL = '100MB'

export function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

export function attachmentTooLargeMessage(sizeBytes?: number): string {
  return sizeBytes
    ? `檔案 ${formatMiB(sizeBytes)} 超過單檔上限 ${MAX_ATTACHMENT_LABEL}`
    : `檔案超過單檔上限 ${MAX_ATTACHMENT_LABEL}`
}
