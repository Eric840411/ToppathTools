import type { Router } from 'express'
import { randomUUID } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { db, writeLimiter } from './shared.js'
import { getAuthAccount } from './auth-session.js'
import { validateMultiTcScript, reviewMultiTcScript } from './uat-runner/multi-tc.js'

export { tcBindingSchema } from '../shared/uat-recording-schema.js'
import { scriptSchema, recordingSaveErrors } from '../shared/uat-recording-schema.js'
export type RecordedScript = z.infer<typeof scriptSchema> & { id: string }

/* ── 錄製腳本：團隊共用（2026-09-16）────────────────────────────────────────
   原本是完全依帳號隔離（列表／開啟／儲存／結果全部 `WHERE owner = email`）。
   使用者要求「大家一起維護同一份」，所以讀寫改成整個團隊共用。
   ⚠️ `owner` **不是只剩顯示用**——它仍然是刪除授權的依據（建立者＋管理員），
      所以不能當成純裝飾欄位處理（CodeX review 特別更正過這句）。

   ⚠️ 共用之後有三件事不做就會出事，都不是「之後再說」等級的：

   1. **並行編輯會靜默覆蓋**：儲存是整份 document 覆蓋，兩個人先後存檔，
      後存的直接蓋掉前一個，而且**不會有任何提示**。用整數 `revision` 樂觀鎖擋。
      ⚠️ 不用 `updated_at` 當版本——同一毫秒內兩次存檔會碰撞（CodeX review）。
   2. **並行執行會同時回寫同一批 Lark TC**：加同腳本互斥。
   3. **執行結果原本記在「腳本建立者」頭上**（`SELECT owner FROM uat_recorded_scripts`
      再拿去當 run 的 owner）。共用前兩者永遠相同所以看不出來，共用後
      會變成「你跑的結果掛在別人名下」。改記真正的 `executed_by`。

   ⚠️ **仍有一個既有缺口沒補**：不同腳本也可能綁到同一批 TC，兩個人同時跑
      還是會撞寫。那在共用之前就存在（重任務鎖是依操作者，不是依 TC），
      共用只是把機率拉高。要真的擋住得對 `base/table/record` 整批上鎖、
      而且所有回寫入口共用同一把——範圍比這版大得多，排下一版。
      **同腳本互斥只是降低機率，不是解決那個洞。** */

db.exec(`
  CREATE TABLE IF NOT EXISTS uat_recorded_scripts (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, document TEXT NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS uat_recorded_script_runs (
    id TEXT PRIMARY KEY, script_id TEXT NOT NULL, owner TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_uat_recorded_script_runs ON uat_recorded_script_runs(script_id, created_at);
`)

/** 既有安裝補欄位。新欄位一律給預設值，不能讓既有列變成 NULL 再到處判空 */
for (const [table, col, ddl] of [
  ['uat_recorded_scripts', 'revision', 'ALTER TABLE uat_recorded_scripts ADD COLUMN revision INTEGER NOT NULL DEFAULT 1'],
  ['uat_recorded_scripts', 'updated_by', 'ALTER TABLE uat_recorded_scripts ADD COLUMN updated_by TEXT'],
  ['uat_recorded_scripts', 'deleted_at', 'ALTER TABLE uat_recorded_scripts ADD COLUMN deleted_at INTEGER'],
  ['uat_recorded_scripts', 'deleted_by', 'ALTER TABLE uat_recorded_scripts ADD COLUMN deleted_by TEXT'],
  ['uat_recorded_script_runs', 'executed_by', 'ALTER TABLE uat_recorded_script_runs ADD COLUMN executed_by TEXT'],
  ['uat_recorded_script_runs', 'script_revision', 'ALTER TABLE uat_recorded_script_runs ADD COLUMN script_revision INTEGER'],
] as const) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!cols.some(c => c.name === col)) db.exec(ddl)
}

/* ── 範本腳本的種子（2026-09-21）─────────────────────────────────────────────
   🚨 **錄好的腳本存在各環境自己的 DB，不會跟著 git 走。**`server/data.db` 在
      `.gitignore` 裡（本來就該如此——那裡面有執行紀錄與帳號資料），所以
      「在這台錄好的腳本」對其他環境來說根本不存在。使用者回報的就是這件事。

   做法跟 `uat-tc-steps-seed.json` 同一套：把**範本**匯出成種子檔進版控，
   開機時用 `INSERT OR IGNORE` 補齊「這個環境還沒有的那幾筆」。
   ⚠️ 用 `INSERT OR IGNORE` 而不是 upsert：**已經在這個環境裡的一律不動**，
      否則會把別人在那台改過的內容蓋掉（而且悄無聲息）。

   ⚠️ 種子只收**範本**（標題以「範本：」開頭），不是全部錄製腳本。
      個人的錄製屬於那台機器的工作現場，整包同步過去只是噪音。
      要改範圍請用 `node scripts/export-uat-recorded-seed.mjs --all`。 */
{
  // ⚠️ 路徑基準跟 shared.ts 一致：`process.cwd()/server`，不是這支檔案的位置
  //    （編譯後會跑在 dist-server/ 底下，用 __dirname 會指到沒有種子檔的地方）
  const seedPath = join(process.cwd(), 'server', 'uat-recorded-scripts-seed.json')
  if (existsSync(seedPath)) {
    try {
      const seed = JSON.parse(readFileSync(seedPath, 'utf-8')) as {
        scripts?: { id: string; owner: string; title: string; document: unknown }[]
      }
      const ins = db.prepare(`INSERT OR IGNORE INTO uat_recorded_scripts
        (id, owner, title, document, updated_at, revision, updated_by) VALUES (?, ?, ?, ?, ?, 1, 'seed')`)
      let added = 0
      for (const s of seed.scripts ?? []) {
        if (!s?.id || !s?.title || !s?.document) continue
        added += ins.run(s.id, s.owner || 'seed', s.title, JSON.stringify(s.document), Date.now()).changes
      }
      if (added > 0) console.log(`[DB] 已從 uat-recorded-scripts-seed.json 補上 ${added} 份範本腳本`)
    } catch (e) { console.error('[DB] 範本腳本種子讀取失敗：', e) }
  }
}

export type RecordedScriptMeta = {
  owner: string; revision: number; updatedAt: number; updatedBy: string | null
}

/**
 * 讀一份腳本。**不再依帳號過濾**——團隊共用。
 * 已軟刪除的一律讀不到（還原是另一支）。
 */
export function getRecordedScript(id: string): RecordedScript | null {
  const row = db.prepare('SELECT document FROM uat_recorded_scripts WHERE id = ? AND deleted_at IS NULL')
    .get(id) as { document: string } | undefined
  return row ? JSON.parse(row.document) as RecordedScript : null
}

export function getRecordedScriptMeta(id: string): RecordedScriptMeta | null {
  const r = db.prepare('SELECT owner, revision, updated_at, updated_by FROM uat_recorded_scripts WHERE id = ? AND deleted_at IS NULL')
    .get(id) as { owner: string; revision: number; updated_at: number; updated_by: string | null } | undefined
  return r ? { owner: r.owner, revision: r.revision, updatedAt: r.updated_at, updatedBy: r.updated_by } : null
}

/* ── 同腳本執行互斥 ────────────────────────────────────────────────────────
   ⚠️ 取得執行資格與「執行中禁止刪除」必須**原子協調**，不可以先查再各自動作
   （CodeX review）：先查再動作的話，兩個請求可以同時查到「沒人在跑」。
   所以兩者都走同一張表、同一個 SQL 條件。

   ⚠️ **Agent 斷線不等於已經停止**——腳本可能還在對方機器上跑、還在回寫 Lark。
   所以不靠「連線還在不在」判斷，改成執行結束時明確釋放，
   另外給一個夠長的保險上限避免永久卡死。 */
db.exec(`
  CREATE TABLE IF NOT EXISTS uat_recorded_script_locks (
    script_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, holder TEXT NOT NULL, acquired_at INTEGER NOT NULL
  )
`)
/*
 * ⚠️ **刻意沒有自動過期。**
 *
 * 第一版設了六小時上限，但那等於「六小時之後就當作對方停了」——
 * 而時間到了**不是停止的證明**（CodeX review）。斷線之後保留鎖，卻又讓它
 * 六小時後自己消失，等於把同一個洞延後六小時再打開：那時仍然可以重跑、可以刪除。
 *
 * 現在只有兩條路會解鎖：**正常收尾**（確認真的停了），或**人工解除**。
 * 卡住不會自己好，但那是刻意的——會卡住代表真的有人需要去確認那台機器。
 */

export function acquireScriptLock(scriptId: string, sessionId: string, holder: string):
  { ok: true } | { ok: false; holder: string; since: number } {
  const now = Date.now()
  try {
    db.prepare('INSERT INTO uat_recorded_script_locks(script_id, session_id, holder, acquired_at) VALUES (?, ?, ?, ?)')
      .run(scriptId, sessionId, holder, now)
    return { ok: true }
  } catch {
    const cur = db.prepare('SELECT holder, acquired_at FROM uat_recorded_script_locks WHERE script_id = ?')
      .get(scriptId) as { holder: string; acquired_at: number } | undefined
    return { ok: false, holder: cur?.holder ?? '其他人', since: cur?.acquired_at ?? now }
  }
}

export function releaseScriptLock(sessionId: string) {
  db.prepare('DELETE FROM uat_recorded_script_locks WHERE session_id = ?').run(sessionId)
}

/**
 * 人工解除同腳本鎖。
 *
 * ⚠️ 為什麼一定要有這支：斷線之後鎖是**刻意保留**的（斷線不等於停止），
 *    而「六小時自動過期」不能當成停止證明（CodeX）。所以必須有一條讓人
 *    在確認過對方機器上沒在跑之後明確解除的路徑，否則會永遠卡住。
 *    這是救援工具，不是正常流程——正常結束會自己放。
 */
export function forceReleaseScriptLock(scriptId: string, expectedSessionId: string):
  { released: true; holder: string } | { released: false; reason: 'none' | 'session_mismatch'; holder?: string; sessionId?: string } {
  const cur = db.prepare('SELECT holder, session_id FROM uat_recorded_script_locks WHERE script_id = ?')
    .get(scriptId) as { holder: string; session_id: string } | undefined
  if (!cur) return { released: false, reason: 'none' }
  // ⚠️ 一定要帶「你看到的是哪一輪」：不然使用者按下去到送出之間，
  //    上一輪可能已經結束、新的一輪剛開始——那會解掉一個正在正常執行的鎖，
  //    而畫面上完全看不出解錯了（CodeX review）。
  if (cur.session_id !== expectedSessionId) {
    return { released: false, reason: 'session_mismatch', holder: cur.holder, sessionId: cur.session_id }
  }
  db.prepare('DELETE FROM uat_recorded_script_locks WHERE script_id = ?').run(scriptId)
  return { released: true, holder: cur.holder }
}

export function isScriptRunning(scriptId: string): boolean {
  const r = db.prepare('SELECT 1 FROM uat_recorded_script_locks WHERE script_id = ?').get(scriptId)
  return !!r
}

/** 派工當下記下「這一輪跑的是哪一份、第幾版、誰跑的」，結果回來時才對得上 */
const runContext = new Map<string, { scriptId: string; revision: number; executedBy: string }>()
export function rememberRunContext(sessionId: string, ctx: { scriptId: string; revision: number; executedBy: string }) {
  runContext.set(sessionId, ctx)
}
export function forgetRunContext(sessionId: string) { runContext.delete(sessionId) }

export function captureRecordedScriptResult(runId: string, line: string) {
  const prefix = '@@UAT_MULTI_RESULTS@@'
  if (!line.startsWith(prefix)) return false
  try {
    const payload = JSON.parse(line.slice(prefix.length)) as { script: RecordedScript }
    const ctx = runContext.get(runId)
    const row = db.prepare('SELECT owner FROM uat_recorded_scripts WHERE id = ?').get(payload.script.id) as { owner: string } | undefined
    if (row) {
      // ⚠️ `owner` 是建立者，**不是執行的人**。共用之前兩者永遠相同所以看不出來；
      //    共用之後不記 executed_by 的話，結果會掛在別人名下（CodeX review 指出）。
      db.prepare('INSERT OR REPLACE INTO uat_recorded_script_runs(id, script_id, owner, executed_by, script_revision, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(runId, payload.script.id, row.owner, ctx?.executedBy ?? null, ctx?.revision ?? null, JSON.stringify(payload), Date.now())
    }
  } catch (error) { console.error('[UAT] 多 TC 結果保存失敗', error) }
  return true
}

/**
 * 存一份腳本。**樂觀鎖的規則只有這一份**。
 *
 * ⚠️ 抽出來是因為測試需要驗它。先前測試在自己那邊另外寫了一段一模一樣的
 *    UPDATE 來驗——結果把 revision 條件從產品程式碼拿掉時**測試照樣全綠**，
 *    因為它驗的是自己那份 SQL（CodeX 早先就提醒過這個形狀，我又犯一次）。
 *
 * ⚠️ 檢查與遞增必須在**同一句 SQL**：先查再寫的話兩個請求會查到同一個版本，
 *    等於沒鎖。
 */
export function saveRecordedScriptDoc(
  script: RecordedScript, actor: string, expectedRevision: number,
): { ok: true; revision: number } | { ok: false } {
  const r = db.prepare('UPDATE uat_recorded_scripts SET title = ?, document = ?, updated_at = ?, updated_by = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND deleted_at IS NULL')
    .run(script.title, JSON.stringify(script), Date.now(), actor, script.id, expectedRevision)
  return r.changes === 0 ? { ok: false } : { ok: true, revision: expectedRevision + 1 }
}

export function registerRecordedScriptRoutes(router: Router) {
  router.get('/api/osm-uat/recorded-scripts', (req, res) => {
    const account = getAuthAccount(req)
    if (!account) return res.status(401).json({ ok: false, message: '請先登入' })
    // 團隊共用：不再依 owner 過濾。軟刪除的不列出。
    const rows = db.prepare('SELECT document, updated_at, revision, owner, updated_by FROM uat_recorded_scripts WHERE deleted_at IS NULL ORDER BY updated_at DESC')
      .all() as { document: string; updated_at: number; revision: number; owner: string; updated_by: string | null }[]
    res.json({
      ok: true,
      scripts: rows.map(r => ({
        ...JSON.parse(r.document),
        updatedAt: r.updated_at,
        revision: r.revision,
        createdBy: r.owner,
        updatedBy: r.updated_by,
        running: isScriptRunning((JSON.parse(r.document) as RecordedScript).id),
      })),
    })
  })

  router.put('/api/osm-uat/recorded-scripts', writeLimiter, (req, res) => {
    const account = getAuthAccount(req)
    if (!account) return res.status(401).json({ ok: false, message: '請先登入' })
    const parsed = scriptSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ ok: false, message: parsed.error.issues.map(i => i.message).join('；') })
    const value = parsed.data
    const saveErrors = recordingSaveErrors(value)
    if (saveErrors.length) return res.status(400).json({ ok: false, message: saveErrors.join('；') })
    let url: URL
    try { url = new URL(value.larkUrl) } catch { return res.status(400).json({ ok: false, message: 'Lark 網址格式不正確' }) }
    if (!/\/base\/[^/]+/.test(url.pathname) || url.searchParams.get('table') !== value.tableId) return res.status(400).json({ ok: false, message: 'Lark 網址與綁定表格不一致' })
    const errors = validateMultiTcScript(value)
    if (errors.length) return res.status(400).json({ ok: false, message: errors.join('；') })

    if (!value.id) {
      const script = { ...value, id: randomUUID() }
      db.prepare('INSERT INTO uat_recorded_scripts(id, owner, title, document, updated_at, revision, updated_by) VALUES (?, ?, ?, ?, ?, 1, ?)')
        .run(script.id, account.email, script.title, JSON.stringify(script), Date.now(), account.email)
      return res.json({ ok: true, script, revision: 1, review: reviewMultiTcScript(script) })
    }

    const meta = getRecordedScriptMeta(value.id)
    if (!meta) return res.status(404).json({ ok: false, message: '找不到這份腳本（可能已被刪除）' })
    // ⚠️ 樂觀鎖：用整數 revision，在**同一句 SQL** 裡檢查並遞增。
    //    先查再寫的話兩個請求會同時查到同一個版本，等於沒鎖。
    //    沒帶 expectedRevision 的舊前端一律當成衝突處理——**不可以放行**，
    //    放行就退回「後存的贏」，那正是要修的行為。
    const expected = Number((req.body as { expectedRevision?: unknown }).expectedRevision)
    if (!Number.isInteger(expected)) {
      return res.status(409).json({
        ok: false, code: 'revision_required', revision: meta.revision,
        message: '這個版本的畫面沒有帶版本號，請重新整理頁面後再儲存',
      })
    }
    const script = { ...value, id: value.id }
    const saved = saveRecordedScriptDoc(script, account.email, expected)
    if (saved.ok === false) {
      // ⚠️ 衝突時**不要叫前端重新載入**——那會把使用者正在編輯的內容洗掉。
      //    回目前版本與最後修改者，讓畫面自己決定怎麼呈現，草稿留在他手上。
      const now = getRecordedScriptMeta(script.id)
      return res.status(409).json({
        ok: false, code: 'revision_conflict',
        revision: now?.revision ?? meta.revision, updatedBy: now?.updatedBy ?? meta.updatedBy,
        message: `這份腳本在你編輯期間被${now?.updatedBy ?? '其他人'}改過了。你的修改還在畫面上，沒有被覆蓋。`,
      })
    }
    res.json({ ok: true, script, revision: saved.revision, review: reviewMultiTcScript(script) })
  })

  /**
   * 軟刪除。保留歷史結果與操作紀錄，執行中禁止刪除（CodeX review）。
   * ⚠️ 只有建立者與管理員可以刪——但管理員這條是必要的：
   *    只讓建立者刪的話，建立者離職就沒有人刪得掉。
   */
  router.delete('/api/osm-uat/recorded-scripts/:id', writeLimiter, (req, res) => {
    const account = getAuthAccount(req)
    if (!account) return res.status(401).json({ ok: false, message: '請先登入' })
    const id = String(req.params.id)
    const meta = getRecordedScriptMeta(id)
    if (!meta) return res.status(404).json({ ok: false, message: '找不到這份腳本' })
    const isAdmin = account.role === 'admin'
    if (meta.owner !== account.email && !isAdmin) {
      return res.status(403).json({ ok: false, message: `只有建立者（${meta.owner}）或管理員可以刪除` })
    }
    // 執行中禁刪：跟取得執行資格走同一張鎖表，不是另外查一份狀態
    if (isScriptRunning(id)) return res.status(409).json({ ok: false, message: '這份腳本正在執行，結束後才能刪除' })
    db.prepare('UPDATE uat_recorded_scripts SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL')
      .run(Date.now(), account.email, id)
    res.json({ ok: true })
  })

  router.post('/api/osm-uat/recorded-scripts/:id/force-unlock', writeLimiter, (req, res) => {
    const account = getAuthAccount(req)
    if (!account) return res.status(401).json({ ok: false, message: '請先登入' })
    // ⚠️ 只有管理員能解——這是救援，不是一般操作。
    //    開給所有登入者的話，任何人都能解掉別人**正在正常執行**的鎖，
    //    那比卡住危險（CodeX review）。
    if (account.role !== 'admin') return res.status(403).json({ ok: false, message: '只有管理員可以人工解除執行鎖' })
    const expected = String((req.body as { sessionId?: unknown })?.sessionId ?? '')
    if (!expected) return res.status(400).json({ ok: false, message: '請帶上要解除的那一輪 sessionId' })
    const r = forceReleaseScriptLock(String(req.params.id), expected)
    if (r.released === false) {
      if (r.reason === 'none') return res.status(404).json({ ok: false, message: '這份腳本目前沒有執行鎖' })
      return res.status(409).json({
        ok: false, code: 'session_mismatch',
        message: `你看到的那一輪已經結束了，現在鎖在另一輪（${r.holder}）手上——請重新整理再確認一次`,
      })
    }
    console.warn(`[UAT] ${account.email} 人工解除了腳本 ${req.params.id} 的執行鎖（原持有者 ${r.holder}）`)
    res.json({ ok: true, previousHolder: r.holder })
  })

  router.get('/api/osm-uat/recorded-scripts/:id/results', (req, res) => {
    const account = getAuthAccount(req)
    if (!account) return res.status(401).json({ ok: false, message: '請先登入' })
    // 腳本共用，結果也跟著共用——否則「一起維護」的人看不到彼此跑出來的結果，
    // 等於各做各的。讀取權限跟腳本一致（登入即可），不另外分層。
    const rows = db.prepare('SELECT id, payload, created_at, executed_by, script_revision FROM uat_recorded_script_runs WHERE script_id = ? ORDER BY created_at DESC LIMIT 10')
      .all(String(req.params.id)) as { id: string; payload: string; created_at: number; executed_by: string | null; script_revision: number | null }[]
    res.json({
      ok: true,
      runs: rows.map(r => ({
        ...JSON.parse(r.payload), runId: r.id, createdAt: r.created_at,
        executedBy: r.executed_by, scriptRevision: r.script_revision,
      })),
    })
  })
}
