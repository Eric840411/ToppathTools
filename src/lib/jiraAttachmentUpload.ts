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

/**
 * 批量開單／修改是前端逐列送，伺服器看不到「整批」——所以由前端在迴圈前把整批附件登記成租約，
 * 迴圈中定期續約、結束後放掉。沒有租約的話，批次跑很久時排在後面的附件可能先被快取清理刪掉，
 * 送出時只剩一行 log、附件漏傳（CodeX review）。
 * 租約失敗不擋送出：最壞情況等於沒有這層保護（跟原本一樣），不該因此讓整批開單失敗。
 */
export async function acquireAttachmentLease(cacheIds: string[], headers: Record<string, string> = {}) {
  const ids = [...new Set(cacheIds.filter(Boolean))]
  let leaseId: string | null = null
  let lastRenew = Date.now()
  if (ids.length) {
    try {
      const r = await fetch('/api/jira/attachment-cache/lease', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ cacheIds: ids }),
      })
      const d = await r.json() as { ok?: boolean; leaseId?: string }
      if (d.ok && d.leaseId) leaseId = d.leaseId
    } catch { /* 沒租約就照舊 */ }
  }
  return {
    /** 每送一列呼叫一次；5 分鐘內只真的續一次（租約 30 分鐘到期） */
    renew() {
      if (!leaseId || Date.now() - lastRenew < 5 * 60 * 1000) return
      lastRenew = Date.now()
      fetch(`/api/jira/attachment-cache/lease/${leaseId}/renew`, { method: 'POST', headers }).catch(() => {})
    },
    release() {
      if (!leaseId) return
      fetch(`/api/jira/attachment-cache/lease/${leaseId}`, { method: 'DELETE', headers }).catch(() => {})
      leaseId = null
    },
  }
}
