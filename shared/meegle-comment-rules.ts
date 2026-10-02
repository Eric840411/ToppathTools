/**
 * Meegle 批量評論前後端共用的規則（同一份，不在兩邊各寫——CLAUDE.md 跨功能踩坑 #3）。
 */

/** 認單用的欄位：Meegle 開單回填的「Meegle 單號」（內容是 `#15194994`，可能是超連結文字） */
export const MEEGLE_ID_COLUMN = 'Meegle 單號'

/**
 * 從「Meegle 單號」儲存格取出單號。只認**第一個字**完全是 `#數字`——
 * 用 includes／startsWith 的話 `#151914590` 會被當成 `#15191459`（開單回填踩過）。
 */
export function parseMeegleIdCell(text: string): string | null {
  const first = String(text ?? '').trim().split(/\s+/)[0] ?? ''
  const m = /^#(\d{5,})$/.exec(first)
  return m ? m[1] : null
}

/** 評論送出後回填的處理階段：跟 Jira 批量評論同一個字，Sheet 不用改（使用者：無痛轉移） */
export const COMMENT_STAGE_DONE = '添加評論'

/** 處理階段是空白或「已開單…」才預設勾選（跟 Jira 批量評論的白名單同一個意思） */
export function isCommentPendingStage(stage: string): boolean {
  const s = String(stage ?? '').trim()
  return !s || s.startsWith('已開單')
}
