/**
 * server/uat-backend-snippets.ts
 *
 * **後台設定片段**：一段「把後台改成某個狀態」的操作（例如把某個開關打開），
 * 給 H5／PC 腳本在中間引用。使用者情境：**後台設置開關，前端才有反應。**
 *
 * ## 為什麼不重用「後台錄製腳本」
 * 那個東西**一定綁 Lark TC**（schema 強制至少一筆），而且**跑完會回寫 Lark**
 * （上傳截圖、寫 pass/fail），還會佔同腳本互斥鎖。拿它當開關用的話：
 *   - 你得幫一個「開開關」的動作硬綁一筆 TC
 *   - 而且它會去改你 Lark 上那筆 TC 的結果
 * 也就是**把設定動作混進測試結果裡**——之後查「這筆 TC 為什麼變 fail」會查不出來。
 * 所以另開一個概念：片段只有步驟，沒有 TC、不回寫、不佔鎖。
 *
 * ## 團隊共用
 * 跟錄製腳本同一個慣例（2026-09-16 使用者要求「大家一起維護同一份」）：
 * 讀寫全隊共用，`owner` **仍然是刪除授權的依據**，不是純顯示欄位。
 */
import type { Router } from 'express'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { db, writeLimiter } from './shared.js'
import { getAuthAccount } from './auth-session.js'
import { BACKEND_OP_ACTIONS } from './uat-runner/backend-ops.js'

db.exec(`
  CREATE TABLE IF NOT EXISTS uat_backend_snippets (
    id         TEXT PRIMARY KEY,
    owner      TEXT NOT NULL,
    title      TEXT NOT NULL,
    steps      TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    revision   INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL,
    updated_by TEXT,
    deleted_at INTEGER
  );
`)

const stepSchema = z.object({ action: z.string().min(1).max(60) }).passthrough()

export const snippetSchema = z.object({
  id: z.string().min(1).max(80).optional(),
  title: z.string().trim().min(1).max(120),
  /** 作者自己寫的說明（例如「跑完記得用另一份關回去」） */
  note: z.string().max(500).default(''),
  steps: z.array(stepSchema).min(1).max(100),
  /** 樂觀鎖。⚠️ 不用 updated_at——同一毫秒內兩次存檔會碰撞（錄製腳本那邊踩過） */
  revision: z.number().int().nonnegative().optional(),
})

export type BackendSnippet = z.infer<typeof snippetSchema> & { id: string }

/**
 * 存檔前就把不支援的動作擋掉。
 *
 * ⚠️ **不要偷偷過濾掉**。過濾的話使用者會存下一份「看起來錄好了、跑起來少做事」的片段，
 *    而那正是這個功能最怕的：設定其實沒設到，前端驗證卻照樣跑。
 *    明確拒絕並指名是哪一個動作。
 */
export function snippetSaveErrors(input: unknown): string[] {
  const parsed = snippetSchema.safeParse(input)
  if (!parsed.success) {
    return [...new Set(parsed.error.issues.map(issue => {
      const [root] = issue.path
      if (root === 'title') return '請填寫片段名稱（1～120 字）'
      if (root === 'steps') return '片段至少要有 1 步、最多 100 步'
      if (root === 'note') return '說明最多 500 字'
      return `欄位 ${issue.path.join('.')} 格式不正確`
    }))]
  }
  const bad = [...new Set(parsed.data.steps
    .map(step => String(step.action))
    .filter(action => !BACKEND_OP_ACTIONS.includes(action as never)))]
  if (bad.length) {
    return [`這些動作不能放進設定片段：${bad.join('、')}。`
      + `片段只負責「把後台改成某個狀態」，驗證與回寫是測試腳本的事。`
      + `目前支援：${BACKEND_OP_ACTIONS.join('、')}。`]
  }
  return []
}

export function getBackendSnippet(id: string): BackendSnippet | null {
  const row = db.prepare('SELECT id, title, note, steps, revision FROM uat_backend_snippets WHERE id = ? AND deleted_at IS NULL')
    .get(id) as { id: string; title: string; note: string; steps: string; revision: number } | undefined
  if (!row) return null
  return { id: row.id, title: row.title, note: row.note, revision: row.revision, steps: JSON.parse(row.steps) }
}

export function registerBackendSnippetRoutes(router: Router) {
  router.get('/api/osm-uat/backend-snippets', (req, res) => {
    const account = getAuthAccount(req)
    if (!account) return res.status(401).json({ ok: false, message: '請先登入' })
    const rows = db.prepare(`
      SELECT id, title, note, steps, revision, owner, updated_at, updated_by
      FROM uat_backend_snippets WHERE deleted_at IS NULL ORDER BY updated_at DESC
    `).all() as { id: string; title: string; note: string; steps: string; revision: number; owner: string; updated_at: number; updated_by: string | null }[]
    res.json({
      ok: true,
      // 支援哪些動作要一起回——前端才講得出「為什麼這份存不起來」
      supportedActions: BACKEND_OP_ACTIONS,
      snippets: rows.map(r => ({
        id: r.id, title: r.title, note: r.note, revision: r.revision,
        stepCount: (JSON.parse(r.steps) as unknown[]).length,
        createdBy: r.owner, updatedAt: r.updated_at, updatedBy: r.updated_by,
      })),
    })
  })

  router.get('/api/osm-uat/backend-snippets/:id', (req, res) => {
    const account = getAuthAccount(req)
    if (!account) return res.status(401).json({ ok: false, message: '請先登入' })
    const snippet = getBackendSnippet(req.params.id)
    if (!snippet) return res.status(404).json({ ok: false, message: '找不到這份設定片段' })
    res.json({ ok: true, snippet })
  })

  router.put('/api/osm-uat/backend-snippets', writeLimiter, (req, res) => {
    const account = getAuthAccount(req)
    if (!account) return res.status(401).json({ ok: false, message: '請先登入' })
    const errors = snippetSaveErrors(req.body)
    if (errors.length) return res.status(400).json({ ok: false, message: errors.join('；') })
    const value = snippetSchema.parse(req.body)
    const now = Date.now()

    if (value.id) {
      const current = db.prepare('SELECT revision, deleted_at FROM uat_backend_snippets WHERE id = ?')
        .get(value.id) as { revision: number; deleted_at: number | null } | undefined
      if (!current || current.deleted_at) return res.status(404).json({ ok: false, message: '這份設定片段已被刪除' })
      // ⚠️ 樂觀鎖。沒有的話兩個人先後存檔，**後存的直接蓋掉前一個而且沒有任何提示**
      //    （錄製腳本那邊就是這樣踩到的）。
      if (typeof value.revision === 'number' && value.revision !== current.revision) {
        return res.status(409).json({
          ok: false,
          message: `這份片段已被別人改過（你的版本 ${value.revision}，目前 ${current.revision}）。請重新載入後再存，避免蓋掉對方的修改。`,
        })
      }
      db.prepare(`
        UPDATE uat_backend_snippets
        SET title = ?, note = ?, steps = ?, revision = revision + 1, updated_at = ?, updated_by = ?
        WHERE id = ?
      `).run(value.title, value.note ?? '', JSON.stringify(value.steps), now, account.email, value.id)
      return res.json({ ok: true, id: value.id, revision: current.revision + 1 })
    }

    const id = randomUUID()
    db.prepare(`
      INSERT INTO uat_backend_snippets (id, owner, title, note, steps, revision, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, account.email, value.title, value.note ?? '', JSON.stringify(value.steps), now, account.email)
    res.json({ ok: true, id, revision: 1 })
  })

  router.delete('/api/osm-uat/backend-snippets/:id', writeLimiter, (req, res) => {
    const account = getAuthAccount(req)
    if (!account) return res.status(401).json({ ok: false, message: '請先登入' })
    const row = db.prepare('SELECT owner, deleted_at FROM uat_backend_snippets WHERE id = ?')
      .get(req.params.id) as { owner: string; deleted_at: number | null } | undefined
    if (!row || row.deleted_at) return res.status(404).json({ ok: false, message: '找不到這份設定片段' })
    // ⚠️ 讀寫共用，但刪除仍然只有建立者（跟錄製腳本同一個規則——
    //    `owner` 不是純顯示欄位）。
    if (row.owner !== account.email) {
      return res.status(403).json({ ok: false, message: '只有建立者可以刪除這份設定片段' })
    }
    // 軟刪除：H5 腳本可能還引用著它，硬刪的話那顆積木會變成指向空氣
    db.prepare('UPDATE uat_backend_snippets SET deleted_at = ?, updated_by = ? WHERE id = ?')
      .run(Date.now(), account.email, req.params.id)
    res.json({ ok: true })
  })
}
