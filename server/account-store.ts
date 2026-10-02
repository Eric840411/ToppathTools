/**
 * 登入帳號表（目前仍叫 jira_accounts，Jira 停用後最後才改名——CodeX 2026-10-02）的寫入。
 * 獨立成沒有副作用的模組，測試可以拿記憶體 DB 直接打同一支，不用另抄一份 SQL。
 */
import type Database from 'better-sqlite3'

export type AccountRow = { email: string; token?: string; label: string; role?: string; status?: string }

/**
 * 新增或更新帳號。⚠️ 不能用 INSERT OR REPLACE：那是「刪掉整列再插入」，沒帶到的欄位（pin_hash）會被清空——
 * 管理員改名／改角色就把那個人的 PIN 洗掉了（CodeX 2026-10-02 抓到）。改成衝突時只更新帶到的欄位。
 * token：Jira 停用後建帳號不再要（空字串）。
 */
export function upsertAccountIn(db: Database.Database, a: AccountRow) {
  db.prepare(`INSERT INTO jira_accounts (email, token, label, role, status) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET token = excluded.token, label = excluded.label, role = excluded.role, status = excluded.status`)
    .run(a.email, a.token ?? '', a.label, a.role ?? 'qa', a.status ?? 'active')
}
