/**
 * server/uat-tc-retarget.ts
 *
 * 「把腳本改綁到另一張 Lark TC 表」的**伺服器端**部分：備份 ＋ 套用前的驗證。
 *
 * 配對與套用的規則本體在 `shared/uat-tc-retarget.ts`——**前端、H5／PC、後台三邊
 * import 同一份**。這裡只做兩件前端不能做的事：
 *   ① **備份**（前端存的東西使用者自己刪得掉，救不回來）
 *   ② **驗證選中的 recordId 真的屬於目標表**——不能只信前端傳來的決定，
 *      傳錯的話回寫會寫到別張表上，而且不會報錯
 */
import { randomUUID } from 'node:crypto'
import { db } from './shared.js'
import {
  applyTcRetarget, retargetBlockers, snapshotOf, restoreFromSnapshot,
  type RetargetBinding, type RetargetTc, type RetargetSnapshot,
} from '../shared/uat-tc-retarget.js'

// ⚠️ 這兩支是純函式，實作放在 `shared/` 才測得到（這個檔案 import 了 `shared.js`，
//    測試一 import 就會把整個 server 模組叫起來）。這裡只 re-export 給既有呼叫端。
export { snapshotOf, restoreFromSnapshot }
export type { RetargetSnapshot }

db.exec(`
  CREATE TABLE IF NOT EXISTS uat_tc_retarget_backups (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,          -- 'backend' | 'frontend'
    script_id   TEXT NOT NULL,
    script_name TEXT NOT NULL DEFAULT '',
    snapshot    TEXT NOT NULL,          -- { larkUrl, tableId, bindings, stepOwners }
    actor       TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_uat_tc_retarget_backups
    ON uat_tc_retarget_backups(kind, script_id, created_at);
`)

export type RetargetKind = 'backend' | 'frontend'

export function saveRetargetBackup(args: {
  kind: RetargetKind; scriptId: string; scriptName: string
  snapshot: RetargetSnapshot; actor: string
}): string {
  const id = randomUUID()
  db.prepare(`INSERT INTO uat_tc_retarget_backups (id, kind, script_id, script_name, snapshot, actor, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, args.kind, args.scriptId, args.scriptName, JSON.stringify(args.snapshot), args.actor, Date.now())
  return id
}

export function listRetargetBackups(kind: RetargetKind, scriptId: string) {
  const rows = db.prepare(`SELECT id, script_name, snapshot, actor, created_at
                           FROM uat_tc_retarget_backups WHERE kind = ? AND script_id = ?
                           ORDER BY created_at DESC LIMIT 20`)
    .all(kind, scriptId) as Array<{ id: string; script_name: string; snapshot: string; actor: string; created_at: number }>
  return rows.map(r => {
    const snap = JSON.parse(r.snapshot) as RetargetSnapshot
    return {
      id: r.id, actor: r.actor, createdAt: r.created_at,
      tableId: snap.tableId, larkUrl: snap.larkUrl,
      bindingCount: snap.bindings.length,
    }
  })
}

export function getRetargetBackup(id: string): { kind: RetargetKind; scriptId: string; snapshot: RetargetSnapshot } | null {
  const row = db.prepare('SELECT kind, script_id, snapshot FROM uat_tc_retarget_backups WHERE id = ?')
    .get(id) as { kind: RetargetKind; script_id: string; snapshot: string } | undefined
  if (!row) return null
  return { kind: row.kind, scriptId: row.script_id, snapshot: JSON.parse(row.snapshot) as RetargetSnapshot }
}

export interface RetargetRequest {
  kind: RetargetKind
  scriptId: string
  scriptName: string
  actor: string
  newLarkUrl: string
  newTableId: string
  /** 目標表的完整 TC 清單（由呼叫端從 Lark 撈好傳進來） */
  newTcs: RetargetTc[]
  oldLarkUrl: string
  oldTableId: string
  oldBindings: RetargetBinding[]
}

/**
 * 執行一次改綁。**備份一定在套用之前寫**——反過來的話中途失敗就沒東西可以還原。
 *
 * ⚠️ `decisions` 裡的每個新 recordId 都會用 `newTcs` 驗過（`applyTcRetarget` 內部做）。
 *    前端傳一個不存在的 id 進來不會被寫進 bindings，而是落到 `invalidDecisions` 回報出去。
 */
export function performRetarget<S extends { tcId?: string | null }>(
  req: RetargetRequest, steps: S[], decisions: Record<string, string>,
) {
  const backupId = saveRetargetBackup({
    kind: req.kind, scriptId: req.scriptId, scriptName: req.scriptName, actor: req.actor,
    snapshot: snapshotOf({ larkUrl: req.oldLarkUrl, tableId: req.oldTableId, bindings: req.oldBindings, steps }),
  })

  const applied = applyTcRetarget<S>({
    newTableId: req.newTableId,
    newLarkUrl: req.newLarkUrl,
    oldBindings: req.oldBindings,
    steps,
    decisions,
    newTcs: req.newTcs,
  })

  const blockers = retargetBlockers({
    bindings: applied.bindings, steps: applied.steps, tableId: req.newTableId,
  })

  return { backupId, ...applied, blockers }
}
