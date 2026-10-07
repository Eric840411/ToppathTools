// 1007 後台錄製腳本清單改版：每個人的「我的」清單（使用者經 claude-osm-2 提出、mockup 確認；做法 CodeX 定案，見 docs/decisions.md）
//
// 「我的」＝個人清單：自己建立／新錄的自動加入、可以從「全部」手動加入別人的（不重複）、可以拖曳排序。
// 在「我的」只能「移除」（不刪腳本）；刪除在「全部」做（建立者或管理員、軟刪除）。
//
// CodeX 定案的幾條（不要拿掉）：
//   - 清單有自己的 revision（跟腳本 revision 分開）。排序帶 expectedRevision，在 transaction 裡比對→重排→遞增；
//     加入／移除／腳本被刪除或還原，影響到的清單也遞增。衝突回 409，前端重取
//   - 排序送來的 id 必須**恰好等於**目前看得到的清單（不重複、不多不少），不能只驗「都存在」
//   - 看不到的列（腳本已軟刪除）保留原本的 position，只重排看得到的位置——還原時才不會撞位；
//     追加到最後時的位置要把看不到的列算進去
//   - 補種（既有腳本依 owner 加進各人清單）用持久標記、跟標記同一個 transaction，只做一次；
//     不能用「清單是空的」判斷（使用者把自己的全部移除後會被補回去）
//   - 範本種子每次開機都跑 INSERT OR IGNORE：只有**真的新增**的那幾份才加進建立者的清單，已存在的不加回
import type Database from 'better-sqlite3'

export function initScriptMine(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS uat_recorded_script_mine (
      owner TEXT NOT NULL, script_id TEXT NOT NULL, position INTEGER NOT NULL, added_at INTEGER NOT NULL,
      PRIMARY KEY (owner, script_id)
    );
    CREATE INDEX IF NOT EXISTS idx_uat_recorded_script_mine_pos ON uat_recorded_script_mine(owner, position);
    CREATE TABLE IF NOT EXISTS uat_recorded_script_mine_rev (owner TEXT PRIMARY KEY, revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS uat_recorded_script_mine_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `)
  db.transaction(() => {
    if (db.prepare("SELECT 1 FROM uat_recorded_script_mine_meta WHERE key = 'backfill_v1'").get()) return
    const rows = db.prepare('SELECT id, owner FROM uat_recorded_scripts WHERE deleted_at IS NULL ORDER BY updated_at ASC').all() as { id: string; owner: string }[]
    for (const r of rows) addToMineTx(db, r.owner, [r.id])
    db.prepare("INSERT INTO uat_recorded_script_mine_meta (key, value) VALUES ('backfill_v1', ?)").run(new Date().toISOString())
    if (rows.length) console.log(`[DB] 「我的」腳本清單補種：${rows.length} 份依建立者加入`)
  })()
}

const bump = (db: Database.Database, owner: string) => {
  db.prepare('INSERT INTO uat_recorded_script_mine_rev (owner, revision) VALUES (?, 1) ON CONFLICT(owner) DO UPDATE SET revision = revision + 1').run(owner)
}
export function mineRevision(db: Database.Database, owner: string): number {
  return (db.prepare('SELECT revision FROM uat_recorded_script_mine_rev WHERE owner = ?').get(owner) as { revision: number } | undefined)?.revision ?? 0
}
/** 看得到的清單（腳本沒被刪），依 position */
export function mineVisibleIds(db: Database.Database, owner: string): string[] {
  return (db.prepare(`SELECT m.script_id FROM uat_recorded_script_mine m JOIN uat_recorded_scripts s ON s.id = m.script_id
    WHERE m.owner = ? AND s.deleted_at IS NULL ORDER BY m.position ASC, m.added_at ASC`).all(owner) as { script_id: string }[]).map(r => r.script_id)
}
export function readMine(db: Database.Database, owner: string) {
  return { ids: mineVisibleIds(db, owner), revision: mineRevision(db, owner) }
}

/** 加到最後（冪等：已經在清單裡的不動位置）。只收存在且沒被刪的腳本。呼叫端負責 transaction */
function addToMineTx(db: Database.Database, owner: string, ids: string[]): string[] {
  const added: string[] = []
  const exists = db.prepare('SELECT 1 FROM uat_recorded_scripts WHERE id = ? AND deleted_at IS NULL')
  const maxPos = db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM uat_recorded_script_mine WHERE owner = ?')   // 含看不到的列
  const ins = db.prepare('INSERT OR IGNORE INTO uat_recorded_script_mine (owner, script_id, position, added_at) VALUES (?, ?, ?, ?)')
  for (const id of [...new Set(ids)]) {
    if (!exists.get(id)) continue
    const p = (maxPos.get(owner) as { p: number }).p + 1
    if (ins.run(owner, id, p, Date.now()).changes) added.push(id)
  }
  if (added.length) bump(db, owner)
  return added
}
export function addToMine(db: Database.Database, owner: string, ids: string[]) {
  return db.transaction(() => ({ added: addToMineTx(db, owner, ids), ...readMine(db, owner) }))()
}
export function removeFromMine(db: Database.Database, owner: string, ids: string[]) {
  return db.transaction(() => {
    const del = db.prepare('DELETE FROM uat_recorded_script_mine WHERE owner = ? AND script_id = ?')
    let removed = 0
    for (const id of [...new Set(ids)]) removed += del.run(owner, id).changes
    if (removed) bump(db, owner)
    return { removed, ...readMine(db, owner) }
  })()
}
/**
 * 拖曳排序。ids＝新的「看得到的清單」順序。
 * 回 { ok:false, code:'revision_conflict' }（版本不符）或 { ok:false, code:'mismatch' }（id 跟目前清單不一致）
 */
export function reorderMine(db: Database.Database, owner: string, ids: string[], expectedRevision: number):
  { ok: true; ids: string[]; revision: number } | { ok: false; code: 'revision_conflict' | 'mismatch'; ids: string[]; revision: number } {
  return db.transaction(() => {
    const rev = mineRevision(db, owner)
    const visible = mineVisibleIds(db, owner)
    if (rev !== expectedRevision) return { ok: false as const, code: 'revision_conflict' as const, ids: visible, revision: rev }
    const same = ids.length === visible.length && new Set(ids).size === ids.length && ids.every(id => visible.includes(id))
    if (!same) return { ok: false as const, code: 'mismatch' as const, ids: visible, revision: rev }
    // 看得到的列原本佔的位置（由小到大）依新順序重新分配；看不到的列不動
    const slots = (db.prepare(`SELECT m.position FROM uat_recorded_script_mine m JOIN uat_recorded_scripts s ON s.id = m.script_id
      WHERE m.owner = ? AND s.deleted_at IS NULL ORDER BY m.position ASC, m.added_at ASC`).all(owner) as { position: number }[]).map(r => r.position)
    // 位置可能重複（舊資料），重新分配時保證嚴格遞增
    const fixed: number[] = []
    for (const p of slots) fixed.push(fixed.length && p <= fixed[fixed.length - 1] ? fixed[fixed.length - 1] + 1 : p)
    const upd = db.prepare('UPDATE uat_recorded_script_mine SET position = ? WHERE owner = ? AND script_id = ?')
    ids.forEach((id, i) => upd.run(fixed[i], owner, id))
    bump(db, owner)
    return { ok: true as const, ids, revision: mineRevision(db, owner) }
  })()
}
/** 腳本被軟刪除／還原：清單資料列保留（還原後回到原位），但有它的每個人的清單版本都要遞增 */
export function bumpOwnersHolding(db: Database.Database, scriptId: string) {
  const owners = (db.prepare('SELECT owner FROM uat_recorded_script_mine WHERE script_id = ?').all(scriptId) as { owner: string }[]).map(r => r.owner)
  for (const o of owners) bump(db, o)
}
/** 新建腳本：跟建立同一個 transaction 呼叫（呼叫端包） */
export function addNewScriptToMineTx(db: Database.Database, owner: string, scriptId: string) { addToMineTx(db, owner, [scriptId]) }
