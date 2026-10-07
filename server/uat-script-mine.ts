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
//
// 1007 H5／PC 也要「我的」（使用者：H5／PC 一份、後台一份，各自分開）——同一套規則換表名，不另寫一份
// （規則寫兩份只會修好一份）。H5／PC 依平台分頁顯示，所以有 scope：看得到的清單只算這個平台的，
// 排序也只重排這個平台那幾列原本佔的位置；清單版本整個人共用（另一個平台改過也算衝突，前端重取就好）。
import type Database from 'better-sqlite3'

export type MineTables = { mine: string; rev: string; meta: string; scripts: string; scopeCol?: string }
type Db = Database.Database

export function createMineStore(t: MineTables) {
  const scopeSql = t.scopeCol ? ` AND s.${t.scopeCol} = ?` : ''
  const sargs = (scope?: string) => (t.scopeCol ? [scope ?? ''] : [])
  const bump = (db: Db, owner: string) => {
    db.prepare(`INSERT INTO ${t.rev} (owner, revision) VALUES (?, 1) ON CONFLICT(owner) DO UPDATE SET revision = revision + 1`).run(owner)
  }
  const mineRevision = (db: Db, owner: string): number =>
    (db.prepare(`SELECT revision FROM ${t.rev} WHERE owner = ?`).get(owner) as { revision: number } | undefined)?.revision ?? 0
  /** 看得到的清單（腳本沒被刪；有 scope 時只算這個 scope），依 position */
  const mineVisibleIds = (db: Db, owner: string, scope?: string): string[] =>
    (db.prepare(`SELECT m.script_id FROM ${t.mine} m JOIN ${t.scripts} s ON s.id = m.script_id
      WHERE m.owner = ? AND s.deleted_at IS NULL${scopeSql} ORDER BY m.position ASC, m.added_at ASC`).all(owner, ...sargs(scope)) as { script_id: string }[]).map(r => r.script_id)
  const readMine = (db: Db, owner: string, scope?: string) => ({ ids: mineVisibleIds(db, owner, scope), revision: mineRevision(db, owner) })

  /** 加到最後（冪等：已經在清單裡的不動位置）。只收存在且沒被刪的腳本。呼叫端負責 transaction */
  function addToMineTx(db: Db, owner: string, ids: string[]): string[] {
    const added: string[] = []
    const exists = db.prepare(`SELECT 1 FROM ${t.scripts} WHERE id = ? AND deleted_at IS NULL`)
    const maxPos = db.prepare(`SELECT COALESCE(MAX(position), 0) AS p FROM ${t.mine} WHERE owner = ?`)   // 含看不到的列
    const ins = db.prepare(`INSERT OR IGNORE INTO ${t.mine} (owner, script_id, position, added_at) VALUES (?, ?, ?, ?)`)
    for (const id of [...new Set(ids)]) {
      if (!exists.get(id)) continue
      const p = (maxPos.get(owner) as { p: number }).p + 1
      if (ins.run(owner, id, p, Date.now()).changes) added.push(id)
    }
    if (added.length) bump(db, owner)
    return added
  }

  return {
    init(db: Db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ${t.mine} (
          owner TEXT NOT NULL, script_id TEXT NOT NULL, position INTEGER NOT NULL, added_at INTEGER NOT NULL,
          PRIMARY KEY (owner, script_id)
        );
        CREATE INDEX IF NOT EXISTS idx_${t.mine}_pos ON ${t.mine}(owner, position);
        CREATE TABLE IF NOT EXISTS ${t.rev} (owner TEXT PRIMARY KEY, revision INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS ${t.meta} (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `)
    },
    /** 補種（只做一次；持久標記跟補種同一個 transaction）。rows＝要依建立者加進各人清單的腳本 */
    backfillOnce(db: Db, key: string, rows: () => { id: string; owner: string }[]): number {
      return db.transaction(() => {
        if (db.prepare(`SELECT 1 FROM ${t.meta} WHERE key = ?`).get(key)) return 0
        const list = rows()
        for (const r of list) addToMineTx(db, r.owner, [r.id])
        db.prepare(`INSERT INTO ${t.meta} (key, value) VALUES (?, ?)`).run(key, new Date().toISOString())
        return list.length
      })()
    },
    mineRevision, mineVisibleIds, readMine,
    addToMine(db: Db, owner: string, ids: string[], scope?: string) {
      return db.transaction(() => ({ added: addToMineTx(db, owner, ids), ...readMine(db, owner, scope) }))()
    },
    removeFromMine(db: Db, owner: string, ids: string[], scope?: string) {
      return db.transaction(() => {
        const del = db.prepare(`DELETE FROM ${t.mine} WHERE owner = ? AND script_id = ?`)
        let removed = 0
        for (const id of [...new Set(ids)]) removed += del.run(owner, id).changes
        if (removed) bump(db, owner)
        return { removed, ...readMine(db, owner, scope) }
      })()
    },
    /**
     * 拖曳排序。ids＝新的「看得到的清單」順序。
     * 回 { ok:false, code:'revision_conflict' }（版本不符）或 { ok:false, code:'mismatch' }（id 跟目前清單不一致）
     */
    reorderMine(db: Db, owner: string, ids: string[], expectedRevision: number, scope?: string):
      { ok: true; ids: string[]; revision: number } | { ok: false; code: 'revision_conflict' | 'mismatch'; ids: string[]; revision: number } {
      return db.transaction(() => {
        const rev = mineRevision(db, owner)
        const visible = mineVisibleIds(db, owner, scope)
        if (rev !== expectedRevision) return { ok: false as const, code: 'revision_conflict' as const, ids: visible, revision: rev }
        const same = ids.length === visible.length && new Set(ids).size === ids.length && ids.every(id => visible.includes(id))
        if (!same) return { ok: false as const, code: 'mismatch' as const, ids: visible, revision: rev }
        // 看得到的列原本佔的位置（由小到大）依新順序重新分配；看不到的列（含別的 scope）不動
        const slots = (db.prepare(`SELECT m.position FROM ${t.mine} m JOIN ${t.scripts} s ON s.id = m.script_id
          WHERE m.owner = ? AND s.deleted_at IS NULL${scopeSql} ORDER BY m.position ASC, m.added_at ASC`).all(owner, ...sargs(scope)) as { position: number }[]).map(r => r.position)
        // 位置可能重複（舊資料），重新分配時保證嚴格遞增
        const fixed: number[] = []
        for (const p of slots) fixed.push(fixed.length && p <= fixed[fixed.length - 1] ? fixed[fixed.length - 1] + 1 : p)
        const upd = db.prepare(`UPDATE ${t.mine} SET position = ? WHERE owner = ? AND script_id = ?`)
        ids.forEach((id, i) => upd.run(fixed[i], owner, id))
        bump(db, owner)
        return { ok: true as const, ids, revision: mineRevision(db, owner) }
      })()
    },
    /** 腳本被軟刪除／還原：清單資料列保留（還原後回到原位），但有它的每個人的清單版本都要遞增 */
    bumpOwnersHolding(db: Db, scriptId: string) {
      const owners = (db.prepare(`SELECT owner FROM ${t.mine} WHERE script_id = ?`).all(scriptId) as { owner: string }[]).map(r => r.owner)
      for (const o of owners) bump(db, o)
    },
    /** 新建腳本：跟建立同一個 transaction 呼叫（呼叫端包） */
    addNewScriptToMineTx(db: Db, owner: string, scriptId: string) { addToMineTx(db, owner, [scriptId]) },
  }
}

// ── 後台錄製腳本（v5.31.0 原本的匯出，照舊可用）──
const backend = createMineStore({ mine: 'uat_recorded_script_mine', rev: 'uat_recorded_script_mine_rev', meta: 'uat_recorded_script_mine_meta', scripts: 'uat_recorded_scripts' })
export function initScriptMine(db: Db) {
  backend.init(db)
  const n = backend.backfillOnce(db, 'backfill_v1', () => db.prepare('SELECT id, owner FROM uat_recorded_scripts WHERE deleted_at IS NULL ORDER BY updated_at ASC').all() as { id: string; owner: string }[])
  if (n) console.log(`[DB] 「我的」腳本清單補種：${n} 份依建立者加入`)
}
export const mineRevision = backend.mineRevision
export const mineVisibleIds = (db: Db, owner: string) => backend.mineVisibleIds(db, owner)
export const readMine = (db: Db, owner: string) => backend.readMine(db, owner)
export const addToMine = (db: Db, owner: string, ids: string[]) => backend.addToMine(db, owner, ids)
export const removeFromMine = (db: Db, owner: string, ids: string[]) => backend.removeFromMine(db, owner, ids)
export const reorderMine = (db: Db, owner: string, ids: string[], expectedRevision: number) => backend.reorderMine(db, owner, ids, expectedRevision)
export const bumpOwnersHolding = backend.bumpOwnersHolding
export const addNewScriptToMineTx = backend.addNewScriptToMineTx

// ── H5／PC 腳本（1007）：依平台分頁。舊腳本沒有登入帳號，不補種（使用者同意：要用的人自己從「全部」加）──
export const frontendMine = createMineStore({ mine: 'frontend_auto_script_mine', rev: 'frontend_auto_script_mine_rev', meta: 'frontend_auto_script_mine_meta', scripts: 'frontend_auto_scripts', scopeCol: 'platform' })
/** 刪除權限（純函式，測試共用）：管理員都可以；否則只有 owner_email 等於登入帳號的。舊腳本（owner_email 空）只有管理員 */
export function canDeleteFrontendScript(p: { ownerEmail: string; me: string; isAdmin: boolean }): { ok: true } | { ok: false; why: string } {
  if (p.isAdmin) return { ok: true }
  if (!p.ownerEmail) return { ok: false, why: '這是舊腳本（沒有記錄登入帳號），只有管理員能刪' }
  if (p.ownerEmail.toLowerCase() !== p.me.toLowerCase()) return { ok: false, why: `只有建立者（${p.ownerEmail}）或管理員能刪` }
  return { ok: true }
}
