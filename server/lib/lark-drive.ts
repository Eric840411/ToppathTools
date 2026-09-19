/**
 * 上傳檔案到 Lark 雲端資料夾（Drive）。
 *
 * ⚠️ 跟表格（Sheets）／知識庫（Wiki）是**三套不同的 API**。
 *    2026-09-18 使用者把 wiki 連結貼進「回寫至 Lark Wiki」，那支是照 Sheets 的格式解析 token，
 *    結果拿到 HTML 錯誤頁、前端 `r.json()` 直接炸成
 *    `SyntaxError: Unexpected non-whitespace character after JSON`——**看起來像前端壞掉，其實是打錯 API**。
 */
import { getLarkToken } from '../shared.js'

const LARK_BASE = () => process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'

/** 單次上傳上限（Lark `upload_all` 的限制）。超過要走分片上傳，這裡先明確擋住並講清楚 */
export const LARK_UPLOAD_ALL_LIMIT = 20 * 1024 * 1024

export interface LarkUploadResult {
  ok: boolean
  fileToken?: string
  message?: string
}

/**
 * 從使用者貼的資料夾網址取出 folder token。
 * 例：`https://xxx.larksuite.com/drive/folder/CRnYfDbMYlaJBKdi9TYlslaJgLe?from=...`
 */
export function parseLarkFolderToken(input: string): string {
  const raw = (input || '').trim()
  if (!raw) return ''
  const m = /\/drive\/folder\/([A-Za-z0-9]+)/.exec(raw)
  if (m) return m[1]
  // 已經是 token 的情況
  return /^[A-Za-z0-9]{10,}$/.test(raw) ? raw : ''
}

export async function uploadFileToLarkFolder(
  folderToken: string, fileName: string, data: Buffer,
): Promise<LarkUploadResult> {
  if (!folderToken) return { ok: false, message: '沒有 Lark 資料夾 token' }
  if (data.length > LARK_UPLOAD_ALL_LIMIT) {
    return {
      ok: false,
      message: `檔案 ${(data.length / 1048576).toFixed(1)} MB 超過單次上傳上限 20 MB（需要分片上傳，目前未實作）`,
    }
  }
  try {
    const token = await getLarkToken()
    const form = new FormData()
    form.append('file_name', fileName)
    form.append('parent_type', 'explorer')
    form.append('parent_node', folderToken)
    form.append('size', String(data.length))
    form.append('file', new Blob([new Uint8Array(data)]), fileName)

    const resp = await fetch(`${LARK_BASE()}/open-apis/drive/v1/files/upload_all`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    })
    const text = await resp.text()
    // ⚠️ 不要直接 .json()：失敗時 Lark 也可能回非 JSON，那時錯誤訊息會變成 JSON 解析錯誤，
    //    把真正的原因蓋掉（這正是 Wiki 回寫那支踩過的坑）
    let data2: { code?: number; msg?: string; data?: { file_token?: string } }
    try { data2 = JSON.parse(text) as typeof data2 } catch {
      return { ok: false, message: `Lark 回應不是 JSON（HTTP ${resp.status}）：${text.slice(0, 120)}` }
    }
    if (data2.code !== 0) return { ok: false, message: `Lark 上傳失敗 code=${data2.code} ${data2.msg ?? ''}` }
    return { ok: true, fileToken: data2.data?.file_token }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
