import { MAX_ATTACHMENT_BYTES, attachmentTooLargeMessage } from '../../shared/attachment-limits'

export type UploadedAttachment = {
  cacheId: string; filename: string; mimeType: string; size: number; isImage: boolean; isVideo: boolean
}

/**
 * 批量開單／評論／修改共用的附件上傳。原本三個地方各寫一份 fetch，錯誤處理也各不相同。
 *
 * - 送出前先檢查大小：超過上限不用真的傳上去才被拒（100MB 傳一次要不少時間）
 * - 伺服器前面的反向代理擋下時回的是 HTML 不是 JSON（HTTP 413），原本 `resp.json()` 直接丟例外，
 *   畫面只剩「上傳失敗」——看不出是代理的限制，會被當成工具壞掉
 */
export async function uploadJiraAttachment(file: File, headers: Record<string, string> = {}):
  Promise<{ ok: true; data: UploadedAttachment } | { ok: false; message: string }> {
  if (file.size > MAX_ATTACHMENT_BYTES) return { ok: false, message: attachmentTooLargeMessage(file.size) }
  const formData = new FormData()
  formData.append('file', file)
  let resp: Response
  try {
    resp = await fetch('/api/jira/attachment-upload', { method: 'POST', headers, body: formData })
  } catch {
    return { ok: false, message: '上傳中斷（網路錯誤），請重試' }
  }
  const data = await resp.json().catch(() => null) as (UploadedAttachment & { ok?: boolean; message?: string }) | null
  if (!data) {
    return {
      ok: false,
      message: resp.status === 413
        ? '伺服器前端（反向代理）擋下了這個檔案，大小超過它的限制。請聯絡管理員調高上傳上限'
        : `上傳失敗（HTTP ${resp.status}）`,
    }
  }
  if (!data.ok) return { ok: false, message: data.message ?? `上傳失敗（HTTP ${resp.status}）` }
  return { ok: true, data }
}
