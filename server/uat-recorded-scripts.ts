import type { Router } from 'express'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { db, writeLimiter } from './shared.js'
import { getAuthAccount } from './auth-session.js'
import { validateMultiTcScript, reviewMultiTcScript } from './uat-runner/multi-tc.js'

export { tcBindingSchema } from '../shared/uat-recording-schema.js'
import { scriptSchema, recordingSaveErrors } from '../shared/uat-recording-schema.js'
export type RecordedScript = z.infer<typeof scriptSchema> & { id: string }

db.exec(`
  CREATE TABLE IF NOT EXISTS uat_recorded_scripts (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, document TEXT NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS uat_recorded_script_runs (
    id TEXT PRIMARY KEY, script_id TEXT NOT NULL, owner TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_uat_recorded_script_runs ON uat_recorded_script_runs(script_id, created_at);
`)

export function getRecordedScript(id: string, owner: string): RecordedScript | null {
  const row = db.prepare('SELECT document FROM uat_recorded_scripts WHERE id = ? AND owner = ?').get(id, owner) as { document: string } | undefined
  return row ? JSON.parse(row.document) as RecordedScript : null
}

export function captureRecordedScriptResult(runId: string, line: string) {
  const prefix = '@@UAT_MULTI_RESULTS@@'
  if (!line.startsWith(prefix)) return false
  try {
    const payload = JSON.parse(line.slice(prefix.length)) as { script: RecordedScript }
    const row = db.prepare('SELECT owner FROM uat_recorded_scripts WHERE id = ?').get(payload.script.id) as { owner: string } | undefined
    if (row) db.prepare('INSERT OR REPLACE INTO uat_recorded_script_runs(id, script_id, owner, payload, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(runId, payload.script.id, row.owner, JSON.stringify(payload), Date.now())
  } catch (error) { console.error('[UAT] 多 TC 結果保存失敗', error) }
  return true
}

export function registerRecordedScriptRoutes(router: Router) {
  router.get('/api/osm-uat/recorded-scripts', (req, res) => {
    const account = getAuthAccount(req)
    if (!account) return res.status(401).json({ ok: false, message: '請先登入' })
    const rows = db.prepare('SELECT document, updated_at FROM uat_recorded_scripts WHERE owner = ? ORDER BY updated_at DESC').all(account.email) as { document: string; updated_at: number }[]
    res.json({ ok: true, scripts: rows.map(r => ({ ...JSON.parse(r.document), updatedAt: r.updated_at })) })
  })
  router.put('/api/osm-uat/recorded-scripts', writeLimiter, (req, res) => {
    const account = getAuthAccount(req)
    if (!account) return res.status(401).json({ ok: false, message: '請先登入' })
    const parsed = scriptSchema.safeParse(req.body)
    const fieldErrors = recordingSaveErrors(req.body)
    if (fieldErrors.length || !parsed.success) return res.status(400).json({ ok: false, message: fieldErrors.join('；') || '腳本格式不正確', fieldErrors })
    const value = parsed.data
    if (JSON.stringify(value).length > 8_000_000) return res.status(400).json({ ok: false, message: '腳本含基準圖最多 8 MB，請縮小區域或拆分腳本' })
    const url = new URL(value.larkUrl)
    if (!/\/base\/[^/]+/.test(url.pathname) || url.searchParams.get('table') !== value.tableId) return res.status(400).json({ ok: false, message: 'Lark 網址與綁定表格不一致' })
    const errors = validateMultiTcScript(value)
    if (errors.length) return res.status(400).json({ ok: false, message: errors.join('；') })
    if (value.id && !getRecordedScript(value.id, account.email)) return res.status(404).json({ ok: false, message: '找不到你的腳本' })
    const script = { ...value, id: value.id || randomUUID() }
    db.prepare('INSERT INTO uat_recorded_scripts(id, owner, title, document, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, document=excluded.document, updated_at=excluded.updated_at')
      .run(script.id, account.email, script.title, JSON.stringify(script), Date.now())
    res.json({ ok: true, script, review: reviewMultiTcScript(script) })
  })
  router.get('/api/osm-uat/recorded-scripts/:id/results', (req, res) => {
    const account = getAuthAccount(req)
    if (!account) return res.status(401).json({ ok: false, message: '請先登入' })
    const rows = db.prepare('SELECT id, payload, created_at FROM uat_recorded_script_runs WHERE script_id = ? AND owner = ? ORDER BY created_at DESC LIMIT 10')
      .all(String(req.params.id), account.email) as { id: string; payload: string; created_at: number }[]
    res.json({ ok: true, runs: rows.map(r => ({ ...JSON.parse(r.payload), runId: r.id, createdAt: r.created_at })) })
  })
}
