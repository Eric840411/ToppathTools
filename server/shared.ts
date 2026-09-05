/**
 * server/shared.ts
 * Shared utilities, DB instance, helpers, and types used across all route files.
 */
import Bottleneck from 'bottleneck'
import { createHash, createSign, randomBytes, timingSafeEqual, randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import dotenv from 'dotenv'
import express from 'express'
import rateLimit from 'express-rate-limit'
import { existsSync, readFileSync, renameSync } from 'fs'
import multer from 'multer'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { z } from 'zod'
import { getAuthEmailFromContext, getOperatorFromContext, type OperatorInfo } from './request-context.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const SERVER_ROOT = join(process.cwd(), 'server')

dotenv.config()

// ─── SQLite DB ────────────────────────────────────────────────────────────────
export const db = new Database(join(SERVER_ROOT, 'data.db'))
// WAL mode allows concurrent reads/writes from multiple processes (main + worker)
// without SQLITE_BUSY errors.
db.pragma('journal_mode = WAL')
db.exec(`
  CREATE TABLE IF NOT EXISTS jira_accounts (
    email TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    label TEXT NOT NULL,
    role  TEXT NOT NULL DEFAULT 'qa'
  );
  CREATE TABLE IF NOT EXISTS gemini_keys (
    label TEXT PRIMARY KEY,
    key   TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS gemini_prompts (
    id       TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    template TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS machine_type_targets (
    machineType   TEXT NOT NULL,
    category      TEXT NOT NULL,
    targetVersion TEXT NOT NULL,
    PRIMARY KEY (machineType, category)
  );
  CREATE TABLE IF NOT EXISTS alert_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS machine_test_profiles (
    machineType      TEXT PRIMARY KEY,
    bonusAction      TEXT NOT NULL DEFAULT 'auto_wait',
    touchPoints      TEXT,
    clickTake        INTEGER NOT NULL DEFAULT 0,
    gmid             TEXT,
    spinSelector     TEXT,
    balanceSelector  TEXT,
    exitSelector     TEXT,
    notes            TEXT,
    ideck_xpaths     TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS operation_history (
    id         TEXT PRIMARY KEY,
    feature    TEXT NOT NULL,
    title      TEXT NOT NULL,
    summary    TEXT NOT NULL,
    detail     TEXT NOT NULL,
    operator_key  TEXT NOT NULL DEFAULT '',
    operator_name TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS account_cultivation (
    operator_key    TEXT PRIMARY KEY,
    active_days     INTEGER NOT NULL DEFAULT 0,
    last_login_date TEXT,
    -- 修為：有留下操作歷史才算一次（見 recordCultivationAction 的說明）
    total_actions   INTEGER NOT NULL DEFAULT 0,
    -- 今日功課。刻意不從 operation_history 回算：那張表的 operator_key 來自
    -- ctx.user（吃得到 header），跟修為記在誰身上的依據不一致，而且它 7 天會被清。
    today_actions   INTEGER NOT NULL DEFAULT 0,
    today_date      TEXT
  );
  CREATE TABLE IF NOT EXISTS heavy_tasks (
    id          TEXT PRIMARY KEY,
    user_key    TEXT NOT NULL,
    user_label  TEXT NOT NULL,
    type        TEXT NOT NULL,
    label       TEXT NOT NULL,
    status      TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    started_at  INTEGER,
    finished_at INTEGER,
    error       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_heavy_tasks_user_status ON heavy_tasks (user_key, status, created_at);
  CREATE TABLE IF NOT EXISTS local_agent_tokens (
    id          TEXT PRIMARY KEY,
    token_hash  TEXT NOT NULL UNIQUE,
    owner_key   TEXT NOT NULL,
    owner_name  TEXT NOT NULL DEFAULT '',
    label       TEXT NOT NULL DEFAULT '',
    revoked     INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    last_seen_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_local_agent_tokens_owner ON local_agent_tokens (owner_key, revoked, created_at);
  CREATE TABLE IF NOT EXISTS gemini_key_stats (
    label          TEXT PRIMARY KEY,
    calls_today    INTEGER NOT NULL DEFAULT 0,
    calls_total    INTEGER NOT NULL DEFAULT 0,
    last_used_at   INTEGER,
    last_error     TEXT,
    last_error_at  INTEGER,
    stats_date     TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS config_templates (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    version    TEXT NOT NULL DEFAULT '',
    template   TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS autospin_configs (
    machineType            TEXT PRIMARY KEY,
    gameUrl                TEXT NOT NULL DEFAULT '',
    rtmpName               TEXT NOT NULL DEFAULT '',
    rtmpUrl                TEXT NOT NULL DEFAULT '',
    gameTitleCode          TEXT NOT NULL DEFAULT '',
    templateType           TEXT NOT NULL DEFAULT '',
    errorTemplateType      TEXT NOT NULL DEFAULT '',
    enabled                INTEGER NOT NULL DEFAULT 1,
    enableRecording        INTEGER NOT NULL DEFAULT 1,
    enableTemplateDetection INTEGER NOT NULL DEFAULT 1,
    notes                  TEXT NOT NULL DEFAULT ''
  );
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS machine_test_sessions (
    id          TEXT PRIMARY KEY,
    account     TEXT NOT NULL,
    label       TEXT NOT NULL DEFAULT '',
    started_at  INTEGER NOT NULL,
    results     TEXT NOT NULL
  );
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS machine_test_results (
    id           TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL DEFAULT '',
    machine_code TEXT NOT NULL,
    tested_at    INTEGER NOT NULL,
    account      TEXT NOT NULL DEFAULT '',
    overall      TEXT NOT NULL,
    steps        TEXT NOT NULL,
    duration_ms  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_mtr_machine ON machine_test_results (machine_code, tested_at);
  CREATE INDEX IF NOT EXISTS idx_mtr_account  ON machine_test_results (account, tested_at);
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS osm_machine_status (
    machine_id  TEXT PRIMARY KEY,
    status      INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL
  );
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS xianxia_quotes (
    id              TEXT PRIMARY KEY,
    text            TEXT NOT NULL,
    source          TEXT NOT NULL DEFAULT '',
    created_at      INTEGER NOT NULL,
    last_used_cycle INTEGER NOT NULL DEFAULT 0
  );
`)
// 若 server/xianxia-quotes-seed.json 存在，補齊缺少的每日仙語（不覆蓋 DB 已有資料，含使用者自己編輯過的）
{
  const quotesSeedPath = join(SERVER_ROOT, 'xianxia-quotes-seed.json')
  if (existsSync(quotesSeedPath)) {
    try {
      const rows = JSON.parse(readFileSync(quotesSeedPath, 'utf-8')) as Array<{
        id: string
        text: string
        source?: string
        created_at: number
      }>
      const ins = db.prepare('INSERT OR IGNORE INTO xianxia_quotes (id, text, source, created_at, last_used_cycle) VALUES (?, ?, ?, ?, 0)')
      for (const r of rows) {
        ins.run(r.id, r.text, r.source ?? '', r.created_at)
      }
      console.log(`[DB] 已從 xianxia-quotes-seed.json 補齊缺少的每日仙語（來源 ${rows.length} 筆）`)
    } catch { /* 忽略 */ }
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS jira_pending_writebacks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at    INTEGER NOT NULL,
    sheet_url     TEXT NOT NULL,
    row_index     INTEGER NOT NULL,
    jira_key      TEXT NOT NULL,
    jira_url      TEXT NOT NULL,
    summary       TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'pending',
    error         TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    updated_at    INTEGER NOT NULL,
    UNIQUE (sheet_url, row_index, jira_key)
  );
  CREATE INDEX IF NOT EXISTS idx_jpw_sheet_status ON jira_pending_writebacks (sheet_url, status, created_at);
`)
// Migrate existing tables that may lack attempt_count (safe no-op if column exists)
try { db.exec(`ALTER TABLE jira_pending_writebacks ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0`) } catch { /* already exists */ }
// Ensure UNIQUE index exists on old DBs that were created before v3.54.24 (CREATE TABLE IF NOT EXISTS won't add it)
try {
  // Remove duplicates first (keep lowest id per unique key)
  db.exec(`DELETE FROM jira_pending_writebacks WHERE id NOT IN (SELECT MIN(id) FROM jira_pending_writebacks GROUP BY sheet_url, row_index, jira_key)`)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_jpw_unique ON jira_pending_writebacks (sheet_url, row_index, jira_key)`)
} catch { /* already exists or no duplicates */ }

/**
 * 待補回填紀錄的保留期。
 *
 * 這張表原本**完全沒有清理**，只會一直長大（使用者 2026-09-03 看到 248 筆，
 * 而且那是從功能上線累積至今的）。連 `done` 的也不刪，只是被畫面上的
 * `status=pending,failed` 條件濾掉看不見而已。
 *
 * ⚠️ **只清 `done`，`pending`／`failed` 一律不自動刪**（跟 CodeX 討論定案）。
 *    那兩種狀態的意思是「這筆還沒補進 Sheet」——自動清掉就真的救不回來了，
 *    而且不會有人發現。舊的未處理紀錄改成在畫面上標示逾期，由人決定要不要處理。
 */
// 一次補回填算一個 run，方便事後把同一批撈出來看。舊資料是 NULL。
try { db.exec(`ALTER TABLE jira_pending_writebacks ADD COLUMN apply_run_id TEXT`) } catch { /* already exists */ }

export const PENDING_WRITEBACK_DONE_RETENTION_DAYS = 30

/**
 * 清掉過期的 `done` 紀錄，回傳刪了幾筆。
 *
 * ⚠️ **`status='done'` 這個條件是這支唯一的安全保證，不要放寬。**
 *    抽成函式就是為了讓檢查腳本能跑「同一份程式碼」——在測試裡複製一份 SQL
 *    的話，之後有人放寬條件，測試照樣是綠的。
 */
export function cleanupDoneWritebacks(now = Date.now()): number {
  const cutoff = now - PENDING_WRITEBACK_DONE_RETENTION_DAYS * 86400_000
  return db.prepare(`DELETE FROM jira_pending_writebacks WHERE status='done' AND updated_at < ?`).run(cutoff).changes
}

try {
  const n = cleanupDoneWritebacks()
  if (n > 0) console.log(`[DB] 已清理 ${n} 筆超過 ${PENDING_WRITEBACK_DONE_RETENTION_DAYS} 天的 done 補回填紀錄`)
} catch (e) { console.error('[DB] 清理補回填紀錄失敗：', e) }

db.exec(`
  CREATE TABLE IF NOT EXISTS role_permissions (
    role     TEXT NOT NULL,
    page_key TEXT NOT NULL,
    allowed  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (role, page_key)
  );
`)

// Per-user AI keys — isolated per account, keyed by (user_email, provider)
db.exec(`
  CREATE TABLE IF NOT EXISTS user_ai_keys (
    user_email  TEXT NOT NULL,
    provider    TEXT NOT NULL,
    api_key     TEXT NOT NULL,
    label       TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (user_email, provider)
  );
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS generation_jobs (
    id             TEXT PRIMARY KEY,
    source_hash    TEXT NOT NULL,
    prompt_version TEXT NOT NULL DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'pending',
    params_json    TEXT NOT NULL DEFAULT '{}',
    error_message  TEXT,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS generated_test_cases (
    id                TEXT PRIMARY KEY,
    job_id            TEXT NOT NULL,
    seq_in_job        INTEGER NOT NULL,
    idempotency_key   TEXT NOT NULL UNIQUE,
    gen_status        TEXT NOT NULL DEFAULT 'pending',
    commit_status     TEXT NOT NULL DEFAULT 'pending',
    commit_lease_token TEXT,
    content_json      TEXT,
    bitable_record_id TEXT,
    error_message     TEXT,
    gen_started_at    INTEGER,
    commit_started_at INTEGER,
    FOREIGN KEY (job_id) REFERENCES generation_jobs(id)
  );
  CREATE INDEX IF NOT EXISTS idx_gen_test_cases_job ON generated_test_cases(job_id, seq_in_job);
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS ui_screenshot_runs (
    id                TEXT PRIMARY KEY,
    status            TEXT NOT NULL DEFAULT 'pending',
    wiki_url          TEXT NOT NULL DEFAULT '',
    game_url_template TEXT NOT NULL DEFAULT '',
    gmids             TEXT NOT NULL DEFAULT '[]',
    resolutions       TEXT NOT NULL DEFAULT '[]',
    concurrency       INTEGER NOT NULL DEFAULT 3,
    options           TEXT NOT NULL DEFAULT '{}',
    agent_id          TEXT,
    created_at        INTEGER NOT NULL,
    started_at        INTEGER,
    finished_at       INTEGER
  );
  CREATE TABLE IF NOT EXISTS ui_screenshot_tasks (
    id          TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL,
    gmid        TEXT NOT NULL,
    resolution  TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    server_path TEXT,
    error_msg   TEXT,
    started_at  INTEGER,
    finished_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_ui_ss_tasks_run ON ui_screenshot_tasks (run_id, status);
`)

{
  const cols = db.prepare('PRAGMA table_info(operation_history)').all() as { name: string }[]
  if (!cols.find(c => c.name === 'operator_key')) {
    db.exec(`ALTER TABLE operation_history ADD COLUMN operator_key TEXT NOT NULL DEFAULT ''`)
  }
  if (!cols.find(c => c.name === 'operator_name')) {
    db.exec(`ALTER TABLE operation_history ADD COLUMN operator_name TEXT NOT NULL DEFAULT ''`)
  }
}

// account_cultivation：從「累計操作次數」改成「累計登入天數」，欄位跟著改名
{
  const cols = db.prepare('PRAGMA table_info(account_cultivation)').all() as { name: string }[]
  if (!cols.find(c => c.name === 'active_days')) {
    db.exec(`ALTER TABLE account_cultivation ADD COLUMN active_days INTEGER NOT NULL DEFAULT 0`)
  }
  if (!cols.find(c => c.name === 'last_login_date')) {
    db.exec(`ALTER TABLE account_cultivation ADD COLUMN last_login_date TEXT`)
  }
  if (!cols.find(c => c.name === 'total_actions')) {
    db.exec(`ALTER TABLE account_cultivation ADD COLUMN total_actions INTEGER NOT NULL DEFAULT 0`)
  }
  if (!cols.find(c => c.name === 'today_actions')) {
    db.exec(`ALTER TABLE account_cultivation ADD COLUMN today_actions INTEGER NOT NULL DEFAULT 0`)
  }
  if (!cols.find(c => c.name === 'today_date')) {
    db.exec(`ALTER TABLE account_cultivation ADD COLUMN today_date TEXT`)
  }
}

// Seed default permissions if table is empty
{
  const count = (db.prepare('SELECT COUNT(*) as c FROM role_permissions').get() as { c: number }).c
  if (count === 0) {
    const qaPages = ['jira-qa','osm','machinetest','imagecheck','osm-config','autospin','url-pool','jackpot','osm-uat','gs-imgcompare','gs-logchecker','gs-bonusv2','history']
    const pmPages = ['jira-pm','lark','osm','osm-config','history']
    const insert = db.prepare('INSERT INTO role_permissions (role, page_key, allowed) VALUES (?, ?, ?)')
    const allPages = ['jira-qa','jira-pm','lark','osm','machinetest','imagecheck','osm-config','autospin','url-pool','jackpot','osm-uat','gs-imgcompare','gs-logchecker','gs-bonusv2','history']
    db.transaction(() => {
      for (const p of allPages) {
        insert.run('qa', p, qaPages.includes(p) ? 1 : 0)
        insert.run('pm', p, pmPages.includes(p) ? 1 : 0)
        insert.run('other', p, 0)
      }
    })()
  }
}

// Bootstrap: ensure at least one admin account exists
{
  const adminCount = (db.prepare("SELECT COUNT(*) as c FROM jira_accounts WHERE role = 'admin'").get() as { c: number }).c
  if (adminCount === 0) {
    const firstAccount = db.prepare("SELECT email FROM jira_accounts ORDER BY rowid LIMIT 1").get() as { email: string } | undefined
    if (firstAccount) {
      db.prepare("UPDATE jira_accounts SET role = 'admin' WHERE email = ?").run(firstAccount.email)
      console.log(`[DB] 已將第一個帳號 ${firstAccount.email} 升級為管理員`)
    }
  }
}

// Migration: jira-qa / jira-pm / jira-update 合併回單一的 'jira'（2026-08-31）
//
// 背景：權限頁列了三筆 Jira 權限，但 App.tsx 的判斷是三者 **OR**、而且都指向
// 同一個頁面。也就是說管理員關掉其中一個開關，使用者照樣進得去——
// 畫面看起來是三個獨立開關，實際上是一個。這比顆粒度不夠細危險，
// 因為它製造假的安全感（跟 CodeX 討論定案收成一筆）。
//
// ⚠️ **這裡原本有一段反方向的 migration**（把 'jira' 拆成 'jira-qa' + 'jira-pm'），
//    是 PM 模式還在的時代寫的。PM 模式早就整個移除了，那段留著會跟這段打架：
//    我插入的 'jira' 列會在下一次啟動被它拆回去，而且不會有任何錯誤訊息。
//    所以是**刪掉它**，不是兩段並存。
//
// ⚠️ 合併規則一定要是 OR，不能挑其中一個當 canonical：實際資料裡
//    jira-update 對 pm 是 0，單留它會**當場撤掉 PM 的存取權**，
//    而且沒人會發現是這次改動造成的。OR 才能保證每個 role 改動前後
//    的實際存取結果完全一樣。
{
  const LEGACY = ['jira-qa', 'jira-pm', 'jira-update']
  const legacyRows = db.prepare(
    `SELECT role, page_key, allowed FROM role_permissions WHERE page_key IN (${LEGACY.map(() => '?').join(',')})`,
  ).all(...LEGACY) as { role: string; page_key: string; allowed: number }[]

  if (legacyRows.length) {
    const merged = new Map<string, number>()
    for (const row of legacyRows) merged.set(row.role, (merged.get(row.role) ?? 0) || (row.allowed ? 1 : 0))

    db.transaction(() => {
      for (const [role, allowed] of merged) {
        // idempotent：已經有 'jira' 的 role 不覆蓋——那可能是管理員後來手動調過的
        db.prepare("INSERT OR IGNORE INTO role_permissions (role, page_key, allowed) VALUES (?, 'jira', ?)")
          .run(role, allowed)
      }
      // 舊 key 的資料留著不刪（CodeX 建議）：真的有問題時還能對照，
      // 但它們已經從 ALL_PAGE_KEYS / PAGE_META / canAccess 移除，不再參與任何判斷。
    })()
    console.log(`[DB] role_permissions: jira-qa/jira-pm/jira-update → jira 已合併（${merged.size} 個角色）`)
  }
}

// Migration: rename 'testcase' page_key to 'lark' in role_permissions
{
  const testcaseRows = db.prepare("SELECT COUNT(*) as c FROM role_permissions WHERE page_key = 'testcase'").get() as { c: number }
  if (testcaseRows.c > 0) {
    db.exec("DELETE FROM role_permissions WHERE page_key = 'lark'")
    db.exec("UPDATE role_permissions SET page_key = 'lark' WHERE page_key = 'testcase'")
    console.log('[DB] role_permissions: testcase → lark 頁面 key 已遷移')
  }
}

// Auto-purge history older than 7 days
db.prepare('DELETE FROM operation_history WHERE created_at < ?').run(Date.now() - 7 * 24 * 60 * 60 * 1000)
db.prepare("UPDATE heavy_tasks SET status = 'abandoned', finished_at = ? WHERE status IN ('queued', 'running') AND created_at < ?")
  .run(Date.now(), Date.now() - 24 * 60 * 60 * 1000)
db.prepare('DELETE FROM heavy_tasks WHERE created_at < ?').run(Date.now() - 7 * 24 * 60 * 60 * 1000)
db.prepare('DELETE FROM local_agent_tokens WHERE created_at < ? AND revoked = 1').run(Date.now() - 30 * 24 * 60 * 60 * 1000)
// Auto-purge machine test sessions older than 30 days
db.prepare('DELETE FROM machine_test_sessions WHERE started_at < ?').run(Date.now() - 30 * 24 * 60 * 60 * 1000)
// Auto-purge per-machine results older than 90 days
db.prepare('DELETE FROM machine_test_results WHERE tested_at < ?').run(Date.now() - 90 * 24 * 60 * 60 * 1000)
// Migration: add commit_lease_token column if missing
{
  const cols = db.prepare('PRAGMA table_info(generated_test_cases)').all() as { name: string }[]
  if (cols.length > 0 && !cols.find(c => c.name === 'commit_lease_token')) {
    db.exec(`ALTER TABLE generated_test_cases ADD COLUMN commit_lease_token TEXT`)
  }
}

// Migration: add bitable coord columns to generation_jobs if missing
for (const col of ['bitable_url', 'bitable_app_token', 'bitable_table_id']) {
  try { db.exec(`ALTER TABLE generation_jobs ADD COLUMN ${col} TEXT`) } catch { /* already exists */ }
}

// Auto-purge generation jobs older than 30 days
db.prepare("DELETE FROM generated_test_cases WHERE job_id IN (SELECT id FROM generation_jobs WHERE created_at < ?)")
  .run(Date.now() - 30 * 24 * 60 * 60 * 1000)
db.prepare('DELETE FROM generation_jobs WHERE created_at < ?').run(Date.now() - 30 * 24 * 60 * 60 * 1000)

// ─── Generation Job helpers ───────────────────────────────────────────────────

export function hashSources(sources: { type: string; url?: string }[]): string {
  return createHash('sha256').update(JSON.stringify(sources)).digest('hex').slice(0, 16)
}

export interface GenerationJobRow {
  id: string
  source_hash: string
  prompt_version: string
  status: string
  params_json: string
  error_message: string | null
  created_at: number
  updated_at: number
  bitable_url: string | null
  bitable_app_token: string | null
  bitable_table_id: string | null
}

export function createGenerationJob(jobId: string, sourceHash: string, promptVersion: string, paramsJson: string): void {
  const now = Date.now()
  db.prepare(
    `INSERT INTO generation_jobs (id, source_hash, prompt_version, status, params_json, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?)`
  ).run(jobId, sourceHash, promptVersion, paramsJson, now, now)
}

export function updateJobStatus(jobId: string, status: string, errorMessage?: string): void {
  db.prepare(`UPDATE generation_jobs SET status = ?, error_message = ?, updated_at = ? WHERE id = ?`)
    .run(status, errorMessage ?? null, Date.now(), jobId)
}

export function updateJobBitableCoords(jobId: string, url: string, appToken: string, tableId: string): void {
  db.prepare(`UPDATE generation_jobs SET bitable_url = ?, bitable_app_token = ?, bitable_table_id = ?, updated_at = ? WHERE id = ?`)
    .run(url, appToken, tableId, Date.now(), jobId)
}

export function getJob(jobId: string): GenerationJobRow | undefined {
  return db.prepare(`SELECT * FROM generation_jobs WHERE id = ?`).get(jobId) as GenerationJobRow | undefined
}

export function getResumableJobs(userKey: string): GenerationJobRow[] {
  // Returns jobs in generated/failed/committing status within last 7 days that have some done test cases
  return db.prepare(
    `SELECT j.* FROM generation_jobs j
     WHERE j.status IN ('generated', 'committing', 'failed')
       AND j.created_at > ?
       AND json_extract(j.params_json, '$.userKey') = ?
       AND EXISTS (SELECT 1 FROM generated_test_cases tc WHERE tc.job_id = j.id AND tc.gen_status = 'done')
     ORDER BY j.created_at DESC LIMIT 10`
  ).all(Date.now() - 7 * 24 * 60 * 60 * 1000, userKey) as GenerationJobRow[]
}

export function saveGeneratedTestCases(jobId: string, cases: object[]): void {
  const now = Date.now()
  const insert = db.prepare(
    `INSERT OR IGNORE INTO generated_test_cases
      (id, job_id, seq_in_job, idempotency_key, gen_status, commit_status, content_json, gen_started_at)
     VALUES (?, ?, ?, ?, 'done', 'pending', ?, ?)`
  )
  db.transaction(() => {
    for (let i = 0; i < cases.length; i++) {
      const id = `${jobId}-${i}`
      const key = createHash('sha256').update(`${jobId}:${i}`).digest('hex').slice(0, 32)
      insert.run(id, jobId, i, key, JSON.stringify(cases[i]), now)
    }
  })()
}

export function getUncommittedTestCases(jobId: string): Array<{
  id: string; seq_in_job: number; idempotency_key: string; content_json: string
}> {
  const TTL_SECONDS = 30
  return db.prepare(
    `SELECT id, seq_in_job, idempotency_key, content_json FROM generated_test_cases
     WHERE job_id = ?
       AND gen_status = 'done'
       AND (commit_status = 'pending'
            OR commit_status = 'commit_failed'
            OR (commit_status = 'in_progress' AND commit_started_at < ?))
       AND commit_status != 'committed'
     ORDER BY seq_in_job`
  ).all(jobId, Date.now() / 1000 - TTL_SECONDS) as Array<{
    id: string; seq_in_job: number; idempotency_key: string; content_json: string
  }>
}

/** Atomically claim a test case for committing. Returns lease token if claimed, null if not. */
export function claimTestCaseForCommit(id: string): string | null {
  const TTL_SECONDS = 60  // increased to 60s to handle slow Bitable API
  const now = Math.floor(Date.now() / 1000)
  const leaseToken = randomUUID()
  const result = db.prepare(
    `UPDATE generated_test_cases
     SET commit_status = 'in_progress', commit_started_at = ?, commit_lease_token = ?
     WHERE id = ?
       AND (commit_status = 'pending'
            OR (commit_status = 'in_progress' AND commit_started_at < ?))`
  ).run(now, leaseToken, id, now - TTL_SECONDS)
  return result.changes > 0 ? leaseToken : null
}

/** Mark committed only if lease token matches (prevents stale worker overwrite). */
export function markTestCaseCommitted(id: string, bitableRecordId: string, leaseToken: string): void {
  const result = db.prepare(
    `UPDATE generated_test_cases
     SET commit_status = 'committed', bitable_record_id = ?, commit_lease_token = NULL
     WHERE id = ? AND commit_lease_token = ?`
  ).run(bitableRecordId, id, leaseToken)
  if (result.changes === 0) {
    // Another worker claimed the lease — this is expected, not an error
    throw new Error(`lease expired or overridden for test case ${id}`)
  }
}

export function markTestCaseCommitFailed(id: string, errorMessage: string): void {
  db.prepare(
    `UPDATE generated_test_cases SET commit_status = 'commit_failed', error_message = ?, commit_lease_token = NULL WHERE id = ?`
  ).run(errorMessage, id)
}

export function countJobTestCases(jobId: string): { total: number; committed: number } {
  const total = (db.prepare(`SELECT COUNT(*) as c FROM generated_test_cases WHERE job_id = ? AND gen_status = 'done'`).get(jobId) as { c: number }).c
  const committed = (db.prepare(`SELECT COUNT(*) as c FROM generated_test_cases WHERE job_id = ? AND commit_status = 'committed'`).get(jobId) as { c: number }).c
  return { total, committed }
}

export function addHistory(
  feature: string,
  title: string,
  summary: string,
  detail: unknown,
  options?: { operator?: OperatorInfo },
) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const operator = options?.operator ?? getOperatorFromContext()
  const operatorKey = operator?.key ?? ''
  const operatorName = operator?.name ?? ''
  db.prepare('INSERT INTO operation_history (id, feature, title, summary, detail, operator_key, operator_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, feature, title, summary, JSON.stringify(detail), operatorKey, operatorName, Date.now())
  recordCultivationAction()
}

/**
 * 修為累計。掛在 addHistory 是刻意的選擇（跟 CodeX 討論定案）：
 *
 * ❌ **不要掛在全站 middleware**（`index.ts` 的 recordLoginDay 那裡）。那裡每一支
 *    已登入的 API 都會過，包含 Dashboard 每 30 秒的輪詢與 heartbeat——光開著網頁
 *    不做事，一天就 ~2880 次，修為會變成「開著網頁的時間」，跟「有做事被看見」
 *    剛好相反。
 * ✅ 掛在這裡，定義剛好是「有留下操作歷史，才算一次修為」，語意乾淨也好解釋，
 *    而且 40 個呼叫端都不用動。
 *
 * ⚠️ 記在**登入帳號**上，不是 addHistory 的 operatorKey——後者來自 ctx.user，
 *    吃得到 header，等於讓人可以把修為記到別人頭上。背景工作（cron、agent 回報）
 *    沒有登入身分，authEmail 是 undefined，自然不會被計入，這正是我們要的。
 */
function recordCultivationAction() {
  const email = getAuthEmailFromContext()
  if (!email) return
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' })
  db.prepare(`
    INSERT INTO account_cultivation (operator_key, total_actions, active_days, last_login_date, today_actions, today_date)
    VALUES (?, 1, 0, ?, 1, ?)
    ON CONFLICT(operator_key) DO UPDATE SET
      total_actions = total_actions + 1,
      -- 跨日就從 1 重新起算，不是累加。用 CASE 而不是先查再寫，避免兩次呼叫之間跨日
      today_actions = CASE WHEN account_cultivation.today_date = excluded.today_date
                           THEN account_cultivation.today_actions + 1 ELSE 1 END,
      today_date    = excluded.today_date
  `).run(email, today, today)
}

/** 每日功課的階段。門檻刻意訂得低——這是「今天有在修行」的鼓勵，不是 KPI */
export const DAILY_QUEST_TIERS = [
  { at: 3,  name: '吐納' },
  { at: 5,  name: '小周天' },
  { at: 10, name: '大周天' },
] as const

/** 副稱號。依累計修為顯示，**不影響境界**（境界仍只看 active_days） */
export const CULTIVATION_EPITHETS = [
  { at: 0,   name: '閉關中' },
  { at: 50,  name: '勤修' },
  { at: 200, name: '破境在即' },
] as const

/** 境界稱號（自動依「登入天數」推進，靈感來自《凡人修仙傳》）——門檻可視情況調整（單位：天）*/
export const CULTIVATION_LEVELS = [
  { name: '練氣期', threshold: 0 },
  { name: '築基期', threshold: 7 },
  { name: '金丹期', threshold: 30 },
  { name: '元嬰期', threshold: 90 },
  { name: '化神期', threshold: 180 },
  { name: '煉虛期', threshold: 365 },
  { name: '合體期', threshold: 730 },
  { name: '大乘期', threshold: 1460 },
  { name: '渡劫期', threshold: 2555 },
] as const

/** 每次登入成功時呼叫——同一天內重複登入只算一天，累計的是「不同天登入過幾天」，不是登入次數 */
export function recordLoginDay(operatorKey: string) {
  if (!operatorKey) return
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }) // YYYY-MM-DD
  const row = db.prepare('SELECT last_login_date FROM account_cultivation WHERE operator_key = ?').get(operatorKey) as { last_login_date: string | null } | undefined
  if (row && row.last_login_date === today) return
  db.prepare(`
    INSERT INTO account_cultivation (operator_key, active_days, last_login_date) VALUES (?, 1, ?)
    ON CONFLICT(operator_key) DO UPDATE SET active_days = active_days + 1, last_login_date = excluded.last_login_date
  `).run(operatorKey, today)
}

function levelForDays(activeDays: number) {
  let levelIndex = 0
  for (let i = CULTIVATION_LEVELS.length - 1; i >= 0; i--) {
    if (activeDays >= CULTIVATION_LEVELS[i].threshold) { levelIndex = i; break }
  }
  const next = CULTIVATION_LEVELS[levelIndex + 1]
  return {
    level: CULTIVATION_LEVELS[levelIndex].name,
    levelIndex,
    activeDays,
    nextLevel: next?.name ?? null,
    nextThreshold: next?.threshold ?? null,
  }
}

export function getCultivationInfo(operatorKey: string) {
  const row = db.prepare(
    'SELECT active_days, total_actions, today_actions, today_date FROM account_cultivation WHERE operator_key = ?',
  ).get(operatorKey) as
    { active_days: number; total_actions: number; today_actions: number; today_date: string | null } | undefined

  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' })
  // today_date 不是今天就代表今天還沒動過——不能直接信 today_actions，
  // 那是「上次有動作的那天」留下來的數字
  const todayActions = row && row.today_date === today ? row.today_actions : 0
  const totalActions = row?.total_actions ?? 0

  let quest: { name: string; at: number } | null = null
  for (const t of DAILY_QUEST_TIERS) if (todayActions >= t.at) quest = { name: t.name, at: t.at }
  const nextQuest = DAILY_QUEST_TIERS.find(t => todayActions < t.at) ?? null

  let epithet: string = CULTIVATION_EPITHETS[0].name
  for (const e of CULTIVATION_EPITHETS) if (totalActions >= e.at) epithet = e.name

  return {
    ...levelForDays(row?.active_days ?? 0),
    totalActions,
    todayActions,
    epithet,
    questDone: quest?.name ?? null,
    nextQuest: nextQuest ? { name: nextQuest.name, at: nextQuest.at } : null,
  }
}

/** 管理員手動調整某帳號的累計登入天數（等同直接調整境界）——只改 active_days，
 *  不動 last_login_date，之後該帳號正常登入仍會從這個新天數繼續往上累計。 */
export function setCultivationDays(operatorKey: string, activeDays: number) {
  db.prepare(`
    INSERT INTO account_cultivation (operator_key, active_days, last_login_date) VALUES (?, ?, NULL)
    ON CONFLICT(operator_key) DO UPDATE SET active_days = excluded.active_days
  `).run(operatorKey, activeDays)
}

/** 排行榜：全部帳號依累計登入天數排序（不含 token，避免外洩） */
export function getCultivationLeaderboard() {
  const accounts = readAccounts().filter(a => a.status !== 'disabled')
  const rows = db.prepare('SELECT operator_key, active_days FROM account_cultivation').all() as { operator_key: string; active_days: number }[]
  const daysByKey = new Map(rows.map(r => [r.operator_key, r.active_days]))
  return accounts
    .map(a => ({ email: a.email, label: a.label, role: a.role, ...levelForDays(daysByKey.get(a.email) ?? 0) }))
    .sort((a, b) => b.activeDays - a.activeDays)
}

// 若 machine_type_targets 是舊 schema（無 category 欄），重建為新 schema
// Migrate machine_test_profiles: add missing columns
{
  const cols = db.prepare('PRAGMA table_info(machine_test_profiles)').all() as { name: string }[]
  if (!cols.find(c => c.name === 'touchPoints')) {
    db.exec('ALTER TABLE machine_test_profiles ADD COLUMN touchPoints TEXT')
    console.log('[DB] machine_test_profiles 已新增欄位：touchPoints')
  }
  if (!cols.find(c => c.name === 'clickTake')) {
    db.exec('ALTER TABLE machine_test_profiles ADD COLUMN clickTake INTEGER NOT NULL DEFAULT 0')
    console.log('[DB] machine_test_profiles 已新增欄位：clickTake')
  }
  if (!cols.find(c => c.name === 'gmid')) {
    db.exec('ALTER TABLE machine_test_profiles ADD COLUMN gmid TEXT')
    console.log('[DB] machine_test_profiles 已新增欄位：gmid')
  }
  if (!cols.find(c => c.name === 'entryTouchPoints')) {
    db.exec('ALTER TABLE machine_test_profiles ADD COLUMN entryTouchPoints TEXT')
    console.log('[DB] machine_test_profiles 已新增欄位：entryTouchPoints')
  }
  if (!cols.find(c => c.name === 'entryTouchPoints2')) {
    db.exec('ALTER TABLE machine_test_profiles ADD COLUMN entryTouchPoints2 TEXT')
    console.log('[DB] machine_test_profiles 已新增欄位：entryTouchPoints2')
  }
  if (!cols.find(c => c.name === 'ideck_xpaths')) {
    db.exec(`ALTER TABLE machine_test_profiles ADD COLUMN ideck_xpaths TEXT NOT NULL DEFAULT '[]'`)
    console.log('[DB] machine_test_profiles 已新增欄位：ideck_xpaths')
  }
  if (!cols.find(c => c.name === 'audioConfig')) {
    db.exec('ALTER TABLE machine_test_profiles ADD COLUMN audioConfig TEXT')
    console.log('[DB] machine_test_profiles 已新增欄位：audioConfig')
  }
  if (!cols.find(c => c.name === 'enterMachineType')) {
    db.exec('ALTER TABLE machine_test_profiles ADD COLUMN enterMachineType TEXT')
    console.log('[DB] machine_test_profiles 已新增欄位：enterMachineType')
  }
  if (!cols.find(c => c.name === 'expectedScreens')) {
    db.exec('ALTER TABLE machine_test_profiles ADD COLUMN expectedScreens INTEGER')
    console.log('[DB] machine_test_profiles 已新增欄位：expectedScreens')
  }
}

// 反向遷移：v4.7.0（e5ce7d8）曾把 machine_test_profiles 的 PRIMARY KEY 重建成複合鍵
// (machineType, enterMachineType)，但 f39d37a 退回 v4.5.0 時只退得回程式碼——資料表結構
// 是單向遷移，退版退不回來。結果 route 的 upsert 寫的是 ON CONFLICT(machineType)，實際的表
// 卻只有複合鍵，SQLite 直接拒絕（ON CONFLICT clause does not match any PRIMARY KEY or
// UNIQUE constraint），儲存機台配置一律 500（2026-08-19 正式環境真實案例）。這裡把表降回
// 單一主鍵，讓 DB 跟退版後的程式碼一致（跟 CodeX 討論定案選 A：讓 DB 對齊程式碼，而不是讓
// 程式碼去遷就殘留 schema——後者會讓全新安裝的環境反過來壞掉，因為新建的表是單一主鍵）。
{
  const pkCols = db.prepare('PRAGMA table_info(machine_test_profiles)').all() as { name: string; pk: number }[]
  const enterCol = pkCols.find(c => c.name === 'enterMachineType')
  if (enterCol && enterCol.pk > 0) {
    // 複合鍵時代可能存在「同一個 machineType、不同 enterMachineType」的多筆設定檔，降回單一主鍵
    // 一定要挑一筆留下。規則寫死避免不確定行為：優先留 enterMachineType 空白那筆（v4.7.0 自己
    // 在 AutoSpin/ScriptedBet 挑設定檔時也是這個偏好），沒有空白的才取 rowid 最小那筆。被丟掉的
    // 一律印出來，不靜默覆蓋（CodeX review 建議）。
    const dups = db.prepare(`
      SELECT machineType, COUNT(*) AS c FROM machine_test_profiles GROUP BY machineType HAVING c > 1
    `).all() as { machineType: string; c: number }[]
    for (const d of dups) {
      const kept = db.prepare(`
        SELECT rowid, enterMachineType FROM machine_test_profiles WHERE machineType = ?
        ORDER BY (CASE WHEN COALESCE(enterMachineType, '') = '' THEN 0 ELSE 1 END), rowid LIMIT 1
      `).get(d.machineType) as { rowid: number; enterMachineType: string | null } | undefined
      const dropped = db.prepare(`
        SELECT enterMachineType FROM machine_test_profiles WHERE machineType = ? AND rowid != ?
      `).all(d.machineType, kept?.rowid ?? -1) as { enterMachineType: string | null }[]
      console.warn(`[DB] machine_test_profiles 降回單一主鍵：${d.machineType} 有 ${d.c} 筆，` +
        `保留 enterMachineType=${JSON.stringify(kept?.enterMachineType ?? '')}，` +
        `丟棄 ${JSON.stringify(dropped.map(x => x.enterMachineType ?? ''))}`)
    }
    // 整段重建包在 transaction 裡，任一步失敗會整個回滾，不會留下半成品；另外開頭先 DROP 一次
    // 暫表，萬一上一次真的在極端情況下留下同名殘骸（例如 process 被硬砍），下次啟動能自己收拾
    // 乾淨，不會卡在「table machine_test_profiles_single already exists」永遠起不來（CodeX review）。
    db.exec(`
      BEGIN;
      DROP TABLE IF EXISTS machine_test_profiles_single;
      CREATE TABLE machine_test_profiles_single (
        machineType       TEXT PRIMARY KEY,
        bonusAction       TEXT NOT NULL DEFAULT 'auto_wait',
        touchPoints       TEXT,
        clickTake         INTEGER NOT NULL DEFAULT 0,
        gmid              TEXT,
        enterMachineType  TEXT,
        spinSelector      TEXT,
        balanceSelector   TEXT,
        exitSelector      TEXT,
        notes             TEXT,
        entryTouchPoints  TEXT,
        entryTouchPoints2 TEXT,
        ideck_xpaths      TEXT NOT NULL DEFAULT '[]',
        audioConfig       TEXT,
        expectedScreens   INTEGER
      );
      INSERT INTO machine_test_profiles_single
        (machineType, bonusAction, touchPoints, clickTake, gmid, enterMachineType, spinSelector, balanceSelector, exitSelector, notes, entryTouchPoints, entryTouchPoints2, ideck_xpaths, audioConfig, expectedScreens)
      SELECT machineType, bonusAction, touchPoints, clickTake, gmid, enterMachineType, spinSelector, balanceSelector, exitSelector, notes, entryTouchPoints, entryTouchPoints2, ideck_xpaths, audioConfig, expectedScreens
      FROM machine_test_profiles p
      WHERE p.rowid = (
        SELECT q.rowid FROM machine_test_profiles q WHERE q.machineType = p.machineType
        ORDER BY (CASE WHEN COALESCE(q.enterMachineType, '') = '' THEN 0 ELSE 1 END), q.rowid LIMIT 1
      );
      DROP TABLE machine_test_profiles;
      ALTER TABLE machine_test_profiles_single RENAME TO machine_test_profiles;
      COMMIT;
    `)
    console.log('[DB] machine_test_profiles PRIMARY KEY 已降回單一 machineType（對齊退版後的程式碼）')
  }
}

{
  // migration: add role column to jira_accounts
  const acCols = db.prepare('PRAGMA table_info(jira_accounts)').all() as { name: string }[]
  if (!acCols.find(c => c.name === 'role')) {
    db.exec(`ALTER TABLE jira_accounts ADD COLUMN role TEXT NOT NULL DEFAULT 'qa'`)
    console.log('[DB] jira_accounts 已新增 role 欄位')
  }
  if (!acCols.find(c => c.name === 'pin_hash')) {
    db.exec(`ALTER TABLE jira_accounts ADD COLUMN pin_hash TEXT`)
    console.log('[DB] jira_accounts 已新增 pin_hash 欄位')
  }
  if (!acCols.find(c => c.name === 'status')) {
    db.exec(`ALTER TABLE jira_accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`)
    console.log('[DB] jira_accounts 已新增 status 欄位')
  }
}
{
  const cols = db.prepare('PRAGMA table_info(machine_type_targets)').all() as { name: string }[]
  if (!cols.find(c => c.name === 'category')) {
    db.exec(`DROP TABLE machine_type_targets;
      CREATE TABLE machine_type_targets (
        machineType   TEXT NOT NULL,
        category      TEXT NOT NULL,
        targetVersion TEXT NOT NULL,
        PRIMARY KEY (machineType, category)
      );`)
    console.log('[DB] machine_type_targets schema 已升級（支援多 category）')
  }
}

// migration: autospin_configs — add userLabel column and migrate to composite PK
{
  const cols = db.prepare('PRAGMA table_info(autospin_configs)').all() as { name: string }[]
  if (!cols.find(c => c.name === 'userLabel')) {
    db.exec(`
      CREATE TABLE autospin_configs_v2 (
        userLabel              TEXT NOT NULL DEFAULT '',
        machineType            TEXT NOT NULL,
        gameUrl                TEXT NOT NULL DEFAULT '',
        rtmpName               TEXT NOT NULL DEFAULT '',
        rtmpUrl                TEXT NOT NULL DEFAULT '',
        gameTitleCode          TEXT NOT NULL DEFAULT '',
        templateType           TEXT NOT NULL DEFAULT '',
        errorTemplateType      TEXT NOT NULL DEFAULT '',
        enabled                INTEGER NOT NULL DEFAULT 1,
        enableRecording        INTEGER NOT NULL DEFAULT 1,
        enableTemplateDetection INTEGER NOT NULL DEFAULT 1,
        notes                  TEXT NOT NULL DEFAULT '',
        spinInterval           REAL NOT NULL DEFAULT 1.0,
        randomExitEnabled      INTEGER NOT NULL DEFAULT 0,
        randomExitChance       REAL NOT NULL DEFAULT 0.02,
        randomExitMinSpins     INTEGER NOT NULL DEFAULT 50,
        betRandomEnabled       INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (userLabel, machineType)
      );
      INSERT INTO autospin_configs_v2 SELECT '', machineType, gameUrl, rtmpName, rtmpUrl,
        gameTitleCode, templateType, errorTemplateType, enabled, enableRecording,
        enableTemplateDetection, notes, 1.0, 0, 0.02, 50, 0 FROM autospin_configs;
      DROP TABLE autospin_configs;
      ALTER TABLE autospin_configs_v2 RENAME TO autospin_configs;
    `)
    console.log('[DB] autospin_configs 已升級：加入 userLabel + 頻率/隨機離開/隨機下注欄位')
  } else {
    // add new columns if missing (for existing v2 tables)
    const newCols = ['spinInterval REAL NOT NULL DEFAULT 1.0', 'randomExitEnabled INTEGER NOT NULL DEFAULT 0',
      'randomExitChance REAL NOT NULL DEFAULT 0.02', 'randomExitMinSpins INTEGER NOT NULL DEFAULT 50',
      'betRandomEnabled INTEGER NOT NULL DEFAULT 0', 'lowBalanceThreshold REAL NOT NULL DEFAULT 0',
      "larkWebhook TEXT NOT NULL DEFAULT ''", "machineNo TEXT NOT NULL DEFAULT ''",
      "logApiEnv TEXT NOT NULL DEFAULT 'qat'"]
    for (const col of newCols) {
      const colName = col.split(' ')[0]
      if (!cols.find(c => c.name === colName)) {
        db.exec(`ALTER TABLE autospin_configs ADD COLUMN ${col}`)
        console.log(`[DB] autospin_configs 已新增欄位：${colName}`)
      }
    }
  }
}

// reconcile_config table (key-value for backend auth config)
db.exec(`
  CREATE TABLE IF NOT EXISTS reconcile_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  )
`)

// meter_reconcile_config — key-value config for Performance Meter 對帳（OSM/GCP 兩組後台憑證，key 前綴 osm_/gcp_ 區分）
db.exec(`
  CREATE TABLE IF NOT EXISTS meter_reconcile_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  )
`)

/* ─── Live Ledger（AutoSpin 即時對帳，規格 v2 / 2026-09-05）─────────────────
 *
 * ⚠️ **全部新開表，不動現有的 `reconcile_*` 與 `autospin_compare_*`。**
 *    那些是舊工具的歷史紀錄，混寫會讓兩邊都不可信（規格書明訂）。
 *    舊表保留，只下架入口與排程。
 *
 * 為什麼重做（實查 server/data.db 的數字，不是從程式碼推論）：
 *   - `/reconcile/*` 的 30 份報告，`frontCount>0` 的有 **0** 份——從沒完成過雙向比對
 *   - `/compare/*` 的 1,860 筆：match 只有 17%、unmatched 52%、**mismatch 永遠是 0**
 *     ——「抓不抓得到差異」從未被證實
 *   - 根因：Pinus `historyListReq` 沒有 order id，只能靠 ±1 秒時間窗猜；
 *     而且只比 `sls.requestJSON.amount ↔ pinus.bet` 一個欄位，那還是我們自己設的常數
 *
 * 核心機制是**三段式綁定**：觀測落庫（0 秒）→ 回填 orderId（15~90 秒）→ 之後所有
 * 比對都以 orderId 為鍵。**時間只在回填時用一次，關係建立後永不重算**——
 * 現況是每一輪都用時間重新猜，所以每一輪都有猜錯的機會而且不會收斂。
 *
 * ⚠️ 所有時間一律存 **epoch ms (UTC)**，只在查詢邊界與顯示時轉換。
 *    三個資料源三種格式：LuckyLink 是 epoch ms、OSM 後台吃 UTC+8 字串、
 *    Pinus 是本地時間字串。不統一的話對帳會在時區上先錯一次。
 *
 * ⚠️ `env`（qat/uat）在每張表裡，而且進主鍵／唯一鍵。兩個環境的資料不可混在
 *    同一張表比——orderId 在不同環境可能重號。
 */

// recon_spin — 證人側的事實（agent 即時寫，worker 回填 orderId）
db.exec(`
  CREATE TABLE IF NOT EXISTS recon_spin (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    env            TEXT NOT NULL,
    sessionId      TEXT NOT NULL,
    machineType    TEXT NOT NULL DEFAULT '',
    gmid           TEXT NOT NULL DEFAULT '',
    spinSeq        INTEGER NOT NULL DEFAULT 0,
    betAmount      REAL NOT NULL DEFAULT 0,
    balanceBefore  REAL,
    balanceAfter   REAL,
    winObserved    REAL,
    orderId        TEXT,
    -- PENDING / MATCH / MISSING / AMBIGUOUS（命名以規格書那張表為準，不另生別名）
    status         TEXT NOT NULL DEFAULT 'PENDING',
    -- resolved / ambiguous / not_found —— 不允許「勉強配一個」
    bindResult     TEXT,
    -- ⚠️ 這三個時間戳是用來**實測校準 90 秒門檻**的。沒有它們，90 秒只是猜。
    observedAt     INTEGER NOT NULL,
    firstQueriedAt INTEGER,
    boundAt        INTEGER,
    latencyMs      INTEGER,
    note           TEXT,
    UNIQUE (env, sessionId, machineType, spinSeq)
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_recon_spin_status ON recon_spin (env, status, observedAt)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_recon_spin_bind ON recon_spin (env, gmid, observedAt)`)
// ⚠️ 一筆後台局號只能被綁定一次。靠唯一索引擋，不靠程式碼記得檢查。
//    partial index：orderId 還沒回填（NULL）的不參與唯一性。
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_recon_spin_order ON recon_spin (env, orderId) WHERE orderId IS NOT NULL`)

// recon_backend_record — 主帳本快照（worker 15s 增量）
db.exec(`
  CREATE TABLE IF NOT EXISTS recon_backend_record (
    env           TEXT NOT NULL,
    orderId       TEXT NOT NULL,
    gmid          TEXT NOT NULL DEFAULT '',
    playerId      TEXT NOT NULL DEFAULT '',
    bet           REAL NOT NULL DEFAULT 0,
    win           REAL NOT NULL DEFAULT 0,
    balanceBefore REAL,
    balanceAfter  REAL,
    dateTime      INTEGER NOT NULL,
    fetchedAt     INTEGER NOT NULL,
    -- ⚠️ raw 一定要留。後台欄位語意會變，留原始 JSON 才能事後重算而不用重跑壓測。
    raw           TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (env, orderId)
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_recon_backend_lookup ON recon_backend_record (env, gmid, dateTime)`)

/**
 * recon_watermark — 每個資料源已經拉到哪裡。
 *
 * ⚠️ PM2 重啟、部署、當機都會發生。沒有游標就會**重抓或漏抓**，
 *    而漏抓的症狀是「莫名其妙多了幾筆 MISSING」，查起來像掉單但其實是我們沒拉到。
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS recon_watermark (
    env       TEXT NOT NULL,
    source    TEXT NOT NULL,
    scope     TEXT NOT NULL DEFAULT '',
    cursorTs  INTEGER NOT NULL DEFAULT 0,
    cursorId  TEXT NOT NULL DEFAULT '',
    updatedAt INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (env, source, scope)
  )
`)

// recon_source_health — 健康列與 DEGRADED 判定的依據
db.exec(`
  CREATE TABLE IF NOT EXISTS recon_source_health (
    env          TEXT NOT NULL,
    source       TEXT NOT NULL,
    lastOkAt     INTEGER,
    lastErrAt    INTEGER,
    failCount    INTEGER NOT NULL DEFAULT 0,
    backoffUntil INTEGER,
    errKind      TEXT,
    message      TEXT,
    PRIMARY KEY (env, source)
  )
`)

/**
 * recon_finding — 所有異常的**單一出口**。
 *
 * ⚠️ 畫面、Discord 告警、事後報表全部讀這張表，不各自從原始資料重算。
 *    各自重算必然出現「畫面 12 筆、通知 15 筆」那種對不起來的落差
 *    （AutoSpin 的日誌篩選規則就是為了這個才做成前後端共用一份）。
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS recon_finding (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    env         TEXT NOT NULL,
    line        TEXT NOT NULL,
    severity    TEXT NOT NULL DEFAULT 'warn',
    refType     TEXT NOT NULL DEFAULT '',
    refId       TEXT NOT NULL DEFAULT '',
    amountDelta REAL,
    detectedAt  INTEGER NOT NULL,
    notifiedAt  INTEGER,
    resolvedAt  INTEGER,
    note        TEXT NOT NULL DEFAULT ''
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_recon_finding_open ON recon_finding (env, resolvedAt, detectedAt)`)

/**
 * 門檻參數存 DB 不寫死（規格書明訂）。
 *
 * ⚠️ 不同環境的後台報表延遲可能差很多，90 秒這個值必須能被實測校準——
 *    `recon_spin` 的三個時間戳就是為了算出真正的延遲分布。
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS recon_settings (
    env   TEXT NOT NULL,
    key   TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (env, key)
  )
`)
{
  const ins = db.prepare(`INSERT OR IGNORE INTO recon_settings (env, key, value) VALUES (?, ?, ?)`)
  for (const env of ['qat', 'uat']) {
    ins.run(env, 'pendingTimeoutSec', '90')      // PENDING 超過幾秒升級 MISSING
    ins.run(env, 'bindWindowBeforeSec', '2')     // 綁定時間窗下界（spin 之前）
    ins.run(env, 'bindWindowAfterSec', '30')     // 綁定時間窗上界（spin 之後）
    ins.run(env, 'fetchIntervalSec', '15')       // gameRecordList 增量週期
    ins.run(env, 'sessionGraceSec', '300')       // session 結束後的收尾窗
  }
}

// reconcile_front_records — game records posted from agent (pinus JS)
db.exec(`
  CREATE TABLE IF NOT EXISTS reconcile_front_records (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    sessionId  TEXT NOT NULL,
    machineType TEXT NOT NULL,
    gmid       TEXT NOT NULL DEFAULT '',
    gameid     TEXT NOT NULL DEFAULT '',
    orderId    TEXT NOT NULL DEFAULT '',
    bet        REAL NOT NULL DEFAULT 0,
    win        REAL NOT NULL DEFAULT 0,
    recordTime TEXT NOT NULL DEFAULT '',
    createdAt  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  )
`)

/**
 * ⚠️ 這張表原本**完全沒有索引，也就沒有 UNIQUE**，但寫入端用的是
 * `INSERT OR IGNORE`——沒有衝突對象，`OR IGNORE` 等於什麼都沒擋。
 *
 * `historyListReq` 每次回傳「最近 15 筆」，跟上一次輪詢重疊的部分就會再存一份。
 * 實測（BULLBLITZ，2026-09-03）：120 列裡只有 92 個不重複時間點，
 * 而三路對帳那 16 筆 `ambiguous_match` **全部**都是「同一輪被存兩次」造成的
 * ——不是相鄰輪次。配對時看到 2 個候選就拒絕，於是明明對得上的輪次被判成無法判定。
 *
 * ⚠️ **這也是「提高撈取頻率會讓情況更糟」的原因**：撈越頻繁 → 重疊越多 →
 *    重複越多 → 更多輪次被誤判。要先修這個才能談提高覆蓋率。
 *
 * UNIQUE 鍵用 `(sessionId, machineType, gmid, recordTime)`（跟 CodeX 討論定案）。
 *
 * ⚠️ **`gmid` 一定要在鍵裡面。**只用 `(session, machineType, recordTime)` 是個 workaround，
 *    它假設「同一台同一秒只會有一筆有意義的資料」。但 `historyListReq` 回的是
 *    **玩家帳號**的歷史不是機台的——多台共用同一遊戲帳號時，A 台撈回來的 15 筆
 *    會混著 B 台的輪次。那時 `recordTime` 單獨就不夠精準：A 台自己某輪跟撈到的
 *    B 台某輪剛好同一秒，就會互相擠掉一筆。加了 gmid 反而更保守——
 *    同一輪重複回來照樣被擋，不同輪就算同秒也不互擠。
 *
 * ⚠️ **但加 gmid 不能解決共用帳號造成的覆蓋率稀釋**（CodeX 提醒）：那是
 *    「每次只回 15 筆、被多台瓜分」的問題，真正的解法是加大 `pagecount`
 *    或確保每台獨立帳號。不要把這個索引當成多機台的完整修復。
 */
try {
  // ⚠️ 先按新鍵清重複再建索引。順序反過來的話 CREATE UNIQUE INDEX 會直接失敗，
  //    而失敗被 catch 吞掉之後，表面上沒事、實際上索引根本沒建立。
  const dropped = db.prepare(`
    DELETE FROM reconcile_front_records WHERE id NOT IN (
      SELECT MIN(id) FROM reconcile_front_records GROUP BY sessionId, machineType, gmid, recordTime
    )
  `).run().changes
  if (dropped > 0) console.log(`[DB] 已清除 ${dropped} 筆重複的前台戰績紀錄（同 session/機台/gmid/時間）`)
  // 舊索引（沒有 gmid）要先移除，不然兩個 UNIQUE 並存時舊的那個仍會擋掉合法資料
  db.exec(`DROP INDEX IF EXISTS idx_rfr_unique`)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_rfr_unique_v2 ON reconcile_front_records (sessionId, machineType, gmid, recordTime)`)
} catch (e) { console.error('[DB] 前台戰績紀錄去重失敗：', e) }

// reconcile_reports — saved reconciliation run results
db.exec(`
  CREATE TABLE IF NOT EXISTS reconcile_reports (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    runAt        INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    rangeStart   TEXT NOT NULL,
    rangeEnd     TEXT NOT NULL,
    machineType  TEXT NOT NULL DEFAULT '',
    frontCount   INTEGER NOT NULL DEFAULT 0,
    backendCount INTEGER NOT NULL DEFAULT 0,
    matchedCount INTEGER NOT NULL DEFAULT 0,
    unmatchedCount INTEGER NOT NULL DEFAULT 0,
    anomalyCount INTEGER NOT NULL DEFAULT 0,
    summary      TEXT NOT NULL DEFAULT '',
    details      TEXT NOT NULL DEFAULT '[]'
  )
`)

// backendStatus（2026-09-01，v4.89.1）——這次查詢的後台資料完不完整。
//
// ⚠️ 沒有這一欄的話，**失敗的那次會被存成看起來正常的一列**：畫面上有紅色警告，
//    但歷史表只留下「後台 0」，之後回看完全分不出是「查詢失敗」還是「真的沒資料」
//    ——跟修好的那個問題一模一樣，只是晚了一步才發生（CodeX review 提到「結果被
//    誤用」的實際發生位置；這個工具沒有匯出功能，歷史紀錄就是那條路）。
//
// ⚠️ 既有列一律留空字串代表「不知道」，**不是預設成 'ok'**。
//    那些列是加這一欄之前跑的，我們根本不知道當時成不成功；標成 ok 等於
//    幫過去的資料做出沒有根據的宣稱，而使用者手上那六筆全 0 的紀錄
//    很可能正好都是失敗的。
try {
  const cols = db.prepare(`PRAGMA table_info(reconcile_reports)`).all() as { name: string }[]
  if (!cols.some(c => c.name === 'backendStatus')) {
    db.exec(`ALTER TABLE reconcile_reports ADD COLUMN backendStatus TEXT NOT NULL DEFAULT ''`)
  }
} catch (e) {
  console.warn('[reconcile_reports] backendStatus 欄位新增失敗:', e)
}

// autospin_compare_groups — 三路對帳（SLS recordBet / 盒子日誌 / Pinus history）使用者自訂比對群組
// 一組 = 一個比較單位（例如「下注金額」），fields 是 JSON 陣列 [{source: 'sls'|'box'|'pinus', path, label?}]
// 全域共用（不分帳號）——比對定義是團隊共同的量測標準，不是個人偏好，跟 reconcile_config 一樣的定位。
db.exec(`
  CREATE TABLE IF NOT EXISTS autospin_compare_groups (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    fields     TEXT NOT NULL DEFAULT '[]',
    tolerance  REAL NOT NULL DEFAULT 0.01,
    sortOrder  INTEGER NOT NULL DEFAULT 0,
    createdAt  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    updatedAt  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  )
`)

// autospin_compare_results — 每筆 spin 的三路比對結果（一列＝一台機器一次 spin，跨所有群組彙整）
// groups 欄位是 JSON：[{groupId, groupName, values: [{source, path, value}], status, note}]
// status：match（全部群組都相符）/ mismatch（至少一組數字對不上）/ missing_data（至少一組有來源缺資料，含「盒子」尚未串接的固定情況）
db.exec(`
  CREATE TABLE IF NOT EXISTS autospin_compare_results (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sessionId   TEXT NOT NULL,
    machineType TEXT NOT NULL,
    roundKey    TEXT NOT NULL DEFAULT '',
    spinIndex   INTEGER NOT NULL DEFAULT 0,
    spinTime    TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'missing_data',
    groups      TEXT NOT NULL DEFAULT '[]',
    createdAt   INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_compare_results_session_machine ON autospin_compare_results (sessionId, machineType, createdAt)`)
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_compare_results_dedup ON autospin_compare_results (sessionId, machineType, roundKey)`)

// autospin_history table
db.exec(`
  CREATE TABLE IF NOT EXISTS autospin_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sessionId   TEXT NOT NULL,
    machineType TEXT NOT NULL,
    userLabel   TEXT NOT NULL DEFAULT '',
    balance     REAL,
    spinCount   INTEGER NOT NULL DEFAULT 0,
    event       TEXT NOT NULL DEFAULT 'balance',
    note        TEXT NOT NULL DEFAULT '',
    isAnomaly   INTEGER NOT NULL DEFAULT 0,
    createdAt   INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  )
`)

// autospin_notify_prefs — 每個帳號各自的 Discord 通知開關/顯示欄位/定時彙總報告設定
// （Webhook URL、標題模板、頁尾文字仍是全域共用，存在 settings 表）
db.exec(`
  CREATE TABLE IF NOT EXISTS autospin_notify_prefs (
    userLabel         TEXT PRIMARY KEY,
    notifyEnabled     INTEGER NOT NULL DEFAULT 1,
    notifyFields      TEXT NOT NULL DEFAULT '',
    reportEnabled     INTEGER NOT NULL DEFAULT 0,
    reportIntervalMin INTEGER NOT NULL DEFAULT 20,
    reportFields      TEXT NOT NULL DEFAULT '',
    reportCustomNote  TEXT NOT NULL DEFAULT '',
    reportAiEnabled   INTEGER NOT NULL DEFAULT 0,
    compareEnabled    INTEGER NOT NULL DEFAULT 1,
    screenshotEnabled INTEGER NOT NULL DEFAULT 1
  )
`)
{
  // compareEnabled（三路對帳依帳號開關，2026-08-10）/ screenshotEnabled（截圖監控依帳號開關，
  // 2026-08-17）補齊到既有資料庫——CREATE TABLE IF NOT EXISTS 對已經存在的舊表不會生效，
  // 既有安裝需要額外 ALTER TABLE 才會有這個欄位
  const cols = db.prepare(`PRAGMA table_info(autospin_notify_prefs)`).all() as { name: string }[]
  if (!cols.find(c => c.name === 'compareEnabled')) {
    db.exec(`ALTER TABLE autospin_notify_prefs ADD COLUMN compareEnabled INTEGER NOT NULL DEFAULT 1`)
    console.log('[DB] autospin_notify_prefs 已新增欄位：compareEnabled')
  }
  if (!cols.find(c => c.name === 'screenshotEnabled')) {
    db.exec(`ALTER TABLE autospin_notify_prefs ADD COLUMN screenshotEnabled INTEGER NOT NULL DEFAULT 1`)
    console.log('[DB] autospin_notify_prefs 已新增欄位：screenshotEnabled')
  }
}

// autospin_agent_sessions — AgentSession 的週期性快照（不含 logs/screenshots，那兩個純粹是
// 即時檢視用的記憶體 buffer，遺失也沒關係）。worker process 本來 agentSessions 完全只存在
// 記憶體裡，一重啟就整批消失，導致還在正常執行的 AutoSpin session 必須依賴 Python 端的斷線
// 重連機制才能恢復；worker 啟動時改成優先從這張表復原，重啟不再弄丟正在跑的 session。
db.exec(`
  CREATE TABLE IF NOT EXISTS autospin_agent_sessions (
    id        TEXT PRIMARY KEY,
    data      TEXT NOT NULL,
    updatedAt INTEGER NOT NULL
  )
`)

// jira_comment_jobs — Jira 批量評論背景 job 的快照，worker 重啟時用來判斷「上次還沒跑完就被
// 砍掉的 job」，標記成中斷並附上目前為止的實際進度，取代含糊的 job not found。
db.exec(`
  CREATE TABLE IF NOT EXISTS jira_comment_jobs (
    requestId TEXT PRIMARY KEY,
    data      TEXT NOT NULL,
    updatedAt INTEGER NOT NULL
  )
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS jackpot_settings (
    gameid  TEXT NOT NULL,
    level   TEXT NOT NULL,
    min_val INTEGER NOT NULL,
    max_val INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (gameid, level)
  )
`)

// migration: add enabled column if missing
{
  const cols = db.prepare('PRAGMA table_info(jackpot_settings)').all() as { name: string }[]
  if (!cols.find(c => c.name === 'enabled')) {
    db.exec('ALTER TABLE jackpot_settings ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1')
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS jackpot_alert_settings (
    gameid  TEXT NOT NULL,
    level   TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (gameid, level)
  )
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS frontend_auto_scripts (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    platform    TEXT NOT NULL,
    steps       TEXT NOT NULL DEFAULT '[]',
    created_by  TEXT NOT NULL DEFAULT 'unknown',
    is_public   INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  )
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS frontend_auto_baselines (
    id          TEXT PRIMARY KEY,
    script_id   TEXT NOT NULL,
    crop_id     TEXT NOT NULL,
    name        TEXT NOT NULL,
    platform    TEXT NOT NULL,
    crop_x      REAL NOT NULL DEFAULT 0,
    crop_y      REAL NOT NULL DEFAULT 0,
    crop_w      REAL NOT NULL DEFAULT 0,
    crop_h      REAL NOT NULL DEFAULT 0,
    image_path  TEXT NOT NULL,
    threshold   REAL NOT NULL DEFAULT 0.05,
    created_by  TEXT NOT NULL DEFAULT 'unknown',
    updated_at  INTEGER NOT NULL
  )
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS frontend_auto_templates (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    filename         TEXT NOT NULL,
    image_path       TEXT NOT NULL,
    width            REAL NOT NULL DEFAULT 0,
    height           REAL NOT NULL DEFAULT 0,
    purpose          TEXT NOT NULL DEFAULT '',
    last_confidence  REAL,
    created_by       TEXT NOT NULL DEFAULT 'unknown',
    created_at       INTEGER NOT NULL
  )
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS frontend_auto_ocr_regions (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    label     TEXT NOT NULL DEFAULT '',
    crop_x    REAL NOT NULL DEFAULT 0,
    crop_y    REAL NOT NULL DEFAULT 0,
    crop_w    REAL NOT NULL DEFAULT 100,
    crop_h    REAL NOT NULL DEFAULT 40,
    accuracy  REAL,
    updated_at INTEGER NOT NULL
  )
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS frontend_auto_runs (
    id          TEXT PRIMARY KEY,
    script_id   TEXT NOT NULL,
    script_name TEXT NOT NULL DEFAULT '',
    platform    TEXT NOT NULL,
    ran_by      TEXT NOT NULL DEFAULT 'unknown',
    total_steps INTEGER NOT NULL DEFAULT 0,
    passed      INTEGER NOT NULL DEFAULT 0,
    failed      INTEGER NOT NULL DEFAULT 0,
    skipped     INTEGER NOT NULL DEFAULT 0,
    result      TEXT NOT NULL DEFAULT 'unknown',
    started_at  INTEGER NOT NULL,
    finished_at INTEGER
  )
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS knowledge_folders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    color      TEXT NOT NULL DEFAULT 'blue',
    created_at INTEGER NOT NULL
  )
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS knowledge_docs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL,
    type           TEXT NOT NULL,
    source_url     TEXT,
    content_cache  TEXT,
    tags           TEXT NOT NULL DEFAULT '[]',
    cached_at      INTEGER,
    created_at     INTEGER NOT NULL
  )
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS auth_sessions (
    sid        TEXT PRIMARY KEY,
    email      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )
`)

// 代理授權（delegation）：「哪個登入者可以用哪個 Jira 帳號的身分打 Jira API」。
// 背景：登入帳號跟 Jira 帳號是同一張 jira_accounts 表，而 userJiraAuth() 先前直接信任前端送的
// x-jira-email、完全沒有跟登入 session 比對，等於任何人都能用任一個帳號的 token 操作 Jira。這張表
// 是把那個「已經存在但沒人管的能力」變成受控、可稽核、可撤銷的授權（2026-08-20，跟 CodeX 討論定案）。
// 撤銷用狀態欄位（enabled / revoked_at / expires_at）而不是刪資料，才留得下稽核軌跡。
db.exec(`
  CREATE TABLE IF NOT EXISTS jira_account_delegates (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_email  TEXT NOT NULL,
    target_email TEXT NOT NULL,
    scope        TEXT NOT NULL,
    enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_by   TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER,
    revoked_at   INTEGER,
    UNIQUE (actor_email, target_email, scope)
  )
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS jp_groups (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    code             TEXT NOT NULL UNIQUE,
    display_name     TEXT NOT NULL,
    environment      TEXT NOT NULL DEFAULT 'QAT',
    luckylink_url    TEXT NOT NULL DEFAULT '',
    luckylink_group_name TEXT NOT NULL DEFAULT '',
    game_codes       TEXT NOT NULL DEFAULT '[]',
    enabled          INTEGER NOT NULL DEFAULT 1,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)

// migration: add login_user and login_pass to jp_groups
{
  const jpCols = db.prepare('PRAGMA table_info(jp_groups)').all() as { name: string }[]
  if (!jpCols.find(c => c.name === 'login_user')) {
    db.exec(`ALTER TABLE jp_groups ADD COLUMN login_user TEXT NOT NULL DEFAULT 'admin'`)
    console.log('[DB] jp_groups 已新增 login_user 欄位')
  }
  if (!jpCols.find(c => c.name === 'login_pass')) {
    db.exec(`ALTER TABLE jp_groups ADD COLUMN login_pass TEXT NOT NULL DEFAULT '123456'`)
    console.log('[DB] jp_groups 已新增 login_pass 欄位')
  }
}

// migration: add folder_id to knowledge_docs
{
  const kbCols = db.prepare('PRAGMA table_info(knowledge_docs)').all() as { name: string }[]
  if (!kbCols.find(c => c.name === 'folder_id')) {
    db.exec(`ALTER TABLE knowledge_docs ADD COLUMN folder_id INTEGER REFERENCES knowledge_folders(id) ON DELETE SET NULL`)
    console.log('[DB] knowledge_docs 已新增 folder_id 欄位')
  }
}

// migration: add category column to gemini_prompts
{
  const cols = db.prepare('PRAGMA table_info(gemini_prompts)').all() as { name: string }[]
  if (!cols.find(c => c.name === 'category')) {
    db.exec(`ALTER TABLE gemini_prompts ADD COLUMN category TEXT NOT NULL DEFAULT ''`)
    console.log('[DB] gemini_prompts 已新增 category 欄位')
  }
}

// 一次性遷移：若舊 JSON 檔存在，匯入後保留原檔（不刪除）
{
  const accountsPath = join(SERVER_ROOT, 'accounts.json')
  if (existsSync(accountsPath)) {
    try {
      const rows = JSON.parse(readFileSync(accountsPath, 'utf-8')) as { email: string; token: string; label: string }[]
      const ins = db.prepare('INSERT OR IGNORE INTO jira_accounts (email, token, label) VALUES (?, ?, ?)')
      rows.forEach(r => ins.run(r.email, r.token, r.label))
      console.log(`[DB] 已從 accounts.json 遷移 ${rows.length} 筆帳號`)
    } catch { /* 忽略解析錯誤 */ }
  }
  const keysPath = join(SERVER_ROOT, 'gemini-keys.json')
  if (existsSync(keysPath)) {
    try {
      const rows = JSON.parse(readFileSync(keysPath, 'utf-8')) as { label: string; key: string }[]
      const ins = db.prepare('INSERT OR IGNORE INTO gemini_keys (label, key) VALUES (?, ?)')
      rows.forEach(r => ins.run(r.label, r.key))
      console.log(`[DB] 已從 gemini-keys.json 遷移 ${rows.length} 筆 Key`)
      renameSync(keysPath, keysPath + '.migrated')  // prevent re-import on next restart
    } catch { /* 忽略 */ }
  }
  const promptsPath = join(SERVER_ROOT, 'prompts.json')
  if (existsSync(promptsPath)) {
    try {
      const rows = JSON.parse(readFileSync(promptsPath, 'utf-8')) as Array<{
        id: string
        name: string
        template: string
        category?: string
      }>
      // Only seed missing prompts from file.
      // Never overwrite DB-edited prompts on restart.
      const ins = db.prepare('INSERT OR IGNORE INTO gemini_prompts (id, name, template, category) VALUES (?, ?, ?, ?)')
      rows.forEach(r => ins.run(r.id, r.name, r.template, r.category ?? ''))
      console.log(`[DB] 已從 prompts.json 補齊缺少的 Prompt（來源 ${rows.length} 筆）`)
    } catch { /* 忽略 */ }
  }

  // 預設新增 Jira 整合 TestCase 模板
  const jiraPromptTemplate = `# 角色
你是一位資深 QA Test Architect，負責根據需求文件拆解功能並設計 QA 測試案例。
你的任務是將需求轉換為可執行、可追溯的測試案例清單。

# 任務
請根據提供的需求資料生成 QA 測試案例。

# 輸入資料
你會收到兩種資料：
1. 規格書 (Spec)
2. JIRA Issues

兩者可能存在以下三種情況：
情境 A：Spec + JIRA 同時存在
情境 B：只有 Spec
情境 C：只有 JIRA

規格書可能為空字串 ""
JIRA Issues 可能為空陣列 []

# 情境判定
Spec 為空字串 且 JIRA Issues 不為空 → 僅使用 JIRA
Spec 不為空 且 JIRA Issues 為空 → 僅使用 Spec
Spec 與 JIRA 同時存在 → 同時使用兩者

# 測試案例生成順序（強制）
必須依照以下順序產生測試案例：
1. 先逐張分析 JIRA Issues
2. 為每張 JIRA 的功能改動生成測試案例
3. 再根據 Spec 補齊 JIRA 未涵蓋的需求
4. 最後整理與去除重複測項

禁止：
- 直接只根據 Spec 生成全部測項
- 忽略 JIRA 中的改動點
- 生成無需求來源的測試案例

# JIRA 覆蓋規則
1. 必須逐張分析 JIRA Issues
2. 每張有明確功能改動描述的 JIRA，至少生成 1 筆測試案例
3. 若 JIRA 描述多個改動點，可生成多筆測試案例
4. 若 JIRA 只是備註或資訊不足，可不生成測試案例
5. 若測項來自 JIRA，必須填入 jira_reference
6. 若 Spec 同時存在，可以同時引用 Spec 與 JIRA

# 測試案例設計原則
每個測試案例應：
1. 聚焦單一功能點
2. 測試標題簡潔
3. 預期結果可驗證
4. 能追溯需求來源

避免：
- 重複測試案例
- 模糊測項
- 未提及需求的推測
- 依照經驗自行補充需求

# 欄位定義

## test_type（測試類型）
只能使用：正向測試 / 反向測試 / 邊界測試 / 異常測試

## category_type（類型）
只能使用：房間列表 / 房內 / 後台 / DB / 下注 / 派彩 / 異常處理 / 荷官端 / 資訊端 / 驗證端 / LED / 未明確分類

## function_module（功能模組）
不超過 12 字，相同概念不可拆成不同名稱

## test_title（測試標題）
40字以內，一句話描述測試內容

## expected_result（預期結果）
可驗證，不使用模糊詞

## category_reason（類型判定依據）
30字內，說明為何判定此類型

## source_reference（來源依據）
格式：Spec 5.2.i / JIRA CGSG-220 / Spec 6.4.ii + JIRA CGSG-220

## jira_reference（JIRA對應單號）
若來自 JIRA：CGSG-220 或 CGSG-220,CGSG-221
若僅來自 Spec：填空字串 ""

# 測試案例數量
建議生成 20 ~ 60 筆

# 輸出格式（只能輸出 JSON）
{
  "feature_name": "",
  "test_cases": [
    {
      "test_type": "",
      "category_type": "",
      "category_reason": "",
      "function_module": "",
      "test_title": "",
      "expected_result": "",
      "source_reference": "",
      "jira_reference": ""
    }
  ]
}

# 規格書
{{rawText}}

# JIRA Issues
{{jira_issues}}`

  db.prepare('INSERT OR IGNORE INTO gemini_prompts (id, name, template) VALUES (?, ?, ?)').run(
    'testcase-jira',
    'TestCase 生成（Jira 整合版）',
    jiraPromptTemplate,
)
}

function hashLocalAgentToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

export function createLocalAgentToken(operator: OperatorInfo | undefined, label = 'Toppath Local Agent') {
  if (!operator?.key) return null
  const token = `tla_${randomBytes(32).toString('base64url')}`
  const id = `${Date.now().toString(36)}_${randomBytes(6).toString('hex')}`
  db.prepare(`
    INSERT INTO local_agent_tokens (id, token_hash, owner_key, owner_name, label, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, hashLocalAgentToken(token), operator.key, operator.name ?? operator.key, label, Date.now())
  return { id, token }
}

export function verifyLocalAgentToken(token: string, ownerKey: string) {
  const cleanToken = token.trim()
  const cleanOwner = ownerKey.trim()
  if (!cleanToken || !cleanOwner) return null
  const tokenHash = hashLocalAgentToken(cleanToken)
  const row = db.prepare(`
    SELECT id, token_hash, owner_key, owner_name, label
    FROM local_agent_tokens
    WHERE token_hash = ? AND owner_key = ? AND revoked = 0
  `).get(tokenHash, cleanOwner) as { id: string; token_hash: string; owner_key: string; owner_name: string; label: string } | undefined
  if (!row) return null
  const expected = Buffer.from(row.token_hash, 'hex')
  const actual = Buffer.from(tokenHash, 'hex')
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
  db.prepare('UPDATE local_agent_tokens SET last_seen_at = ? WHERE id = ?').run(Date.now(), row.id)
  return {
    id: row.id,
    ownerKey: row.owner_key,
    ownerName: row.owner_name,
    label: row.label,
  }
}

export function listLocalAgentTokens(operator: OperatorInfo | undefined) {
  if (!operator?.key) return []
  return db.prepare(`
    SELECT id, owner_key, owner_name, label, revoked, created_at, last_seen_at
    FROM local_agent_tokens
    WHERE owner_key = ?
    ORDER BY created_at DESC
    LIMIT 50
  `).all(operator.key) as {
    id: string
    owner_key: string
    owner_name: string
    label: string
    revoked: number
    created_at: number
    last_seen_at: number | null
  }[]
}

export function revokeLocalAgentToken(operator: OperatorInfo | undefined, id: string) {
  if (!operator?.key || !id.trim()) return false
  const result = db.prepare(`
    UPDATE local_agent_tokens
    SET revoked = 1
    WHERE id = ? AND owner_key = ?
  `).run(id.trim(), operator.key)
  return result.changes > 0
}

// ─── Machine Profiles Seed ────────────────────────────────────────────────────
// 若 server/machine-profiles.json 存在，補齊缺少的機種設定檔（不覆蓋 DB 已有資料）
{
  const profilesSeedPath = join(SERVER_ROOT, 'machine-profiles.json')
  if (existsSync(profilesSeedPath)) {
    try {
      const rows = JSON.parse(readFileSync(profilesSeedPath, 'utf-8')) as Array<{
        machineType: string
        bonusAction?: string
        touchPoints?: unknown[]
        clickTake?: boolean
        gmid?: string
        spinSelector?: string
        balanceSelector?: string
        exitSelector?: string
        notes?: string
        entryTouchPoints?: unknown[]
        entryTouchPoints2?: unknown[]
        ideckXpaths?: unknown[]
        audioConfig?: unknown
      }>
      const ins = db.prepare(`
        INSERT OR IGNORE INTO machine_test_profiles
          (machineType, bonusAction, touchPoints, clickTake, gmid, spinSelector, balanceSelector, exitSelector, notes, entryTouchPoints, entryTouchPoints2, ideck_xpaths, audioConfig)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const r of rows) {
        ins.run(
          r.machineType,
          r.bonusAction ?? 'auto_wait',
          r.touchPoints?.length ? JSON.stringify(r.touchPoints) : null,
          r.clickTake ? 1 : 0,
          r.gmid ?? null,
          r.spinSelector ?? null,
          r.balanceSelector ?? null,
          r.exitSelector ?? null,
          r.notes ?? null,
          r.entryTouchPoints?.length ? JSON.stringify(r.entryTouchPoints) : null,
          r.entryTouchPoints2?.length ? JSON.stringify(r.entryTouchPoints2) : null,
          JSON.stringify(r.ideckXpaths ?? []),
          r.audioConfig ? JSON.stringify(r.audioConfig) : null,
        )
      }
      console.log(`[DB] 已從 machine-profiles.json 補齊缺少的機種設定（來源 ${rows.length} 筆）`)
    } catch { /* 忽略 */ }
  }
}

// ─── Config Templates Seed ────────────────────────────────────────────────────
// 若 server/config-templates.json 存在，補齊缺少的 Config 比對模板（不覆蓋 DB 已有資料）
{
  const configTemplatesSeedPath = join(SERVER_ROOT, 'config-templates.json')
  if (existsSync(configTemplatesSeedPath)) {
    try {
      const rows = JSON.parse(readFileSync(configTemplatesSeedPath, 'utf-8')) as Array<{
        id: string
        name: string
        version?: string
        template: string
        created_at: number
      }>
      const ins = db.prepare('INSERT OR IGNORE INTO config_templates (id, name, version, template, created_at) VALUES (?, ?, ?, ?, ?)')
      for (const r of rows) {
        ins.run(r.id, r.name, r.version ?? '', r.template, r.created_at)
      }
      console.log(`[DB] 已從 config-templates.json 補齊缺少的 Config 模板（來源 ${rows.length} 筆）`)
    } catch { /* 忽略 */ }
  }
}

// ─── Gemini Rate Limiter ───────────────────────────────────────────────────────
// maxConcurrent: 1 → sequential, prevents multiple keys being hit simultaneously
// minTime: 500ms → 120 req/min total; with 10 keys = ~12 RPM per key (under free-tier 15 RPM limit)
export const geminiLimiter = new Bottleneck({ maxConcurrent: 1, minTime: 500 })

// ─── Playwright Browser Semaphore ─────────────────────────────────────────────
// 限制同時運行的 Chromium 數量，避免高並發時記憶體爆炸
// maxConcurrent: 4 → 最多同時 4 個 browser（約 1–2 GB RAM）
export const browserLimiter = new Bottleneck({ maxConcurrent: 4 })

// ─── API Rate Limiters ────────────────────────────────────────────────────────
// validate.xForwardedForHeader:false suppresses the express-rate-limit v8 validation error
// when running behind nginx/reverse proxy without trust proxy being detected early enough
export const heavyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { ok: false, message: '請求過於頻繁，請稍後再試（每分鐘上限 15 次）' },
})
export const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { ok: false, message: '請求過於頻繁，請稍後再試' },
})
export const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { ok: false, message: '登入嘗試過於頻繁，請 1 分鐘後再試' },
})

// ─── OSM Version History ──────────────────────────────────────────────────────

/** index → component name mapping (API keys start at 1; key 5 = 待確認, skipped) */
export const OSM_VERSION_COMPONENTS: Record<number, string> = {
  1: 'Center Server',
  2: 'Middle Server',
  3: 'Bg Client',
  4: 'BG Server',
  6: 'Game Client New',
  7: 'Game Client PC',
}

/** Desired display order */
export const OSM_VERSION_ORDER = ['Game Client New', 'Game Client PC', 'Center Server', 'Middle Server', 'Bg Client', 'BG Server']

// ─── LuckyLink Version History ────────────────────────────────────────────────

/** index → component name mapping */
export const LUCKYLINK_VERSION_COMPONENTS: Record<string, string> = {
  '1': 'Luckylink Server',
  '3': 'Bg Client',
  '4': 'BG Server',
}

/** Desired display order */
export const LUCKYLINK_VERSION_ORDER = ['Luckylink Server', 'Bg Client', 'BG Server']

// ─── Activity Logger ──────────────────────────────────────────────────────────

export const C = {
  reset:  '\x1b[0m',
  gray:   '\x1b[90m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  blue:   '\x1b[34m',
  purple: '\x1b[35m',
  bold:   '\x1b[1m',
}

export function getClientIP(req: express.Request): string {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim()
  return req.socket?.remoteAddress ?? req.ip ?? 'unknown'
}

export function getUser(req: express.Request): string {
  const email = req.headers['x-jira-email']
  if (typeof email === 'string' && email) return email
  const token = req.headers['x-user-token']
  if (typeof token === 'string' && token) return `uid:${token.slice(0, 8)}`
  return '—'
}

function ts(): string {
  return new Date().toLocaleTimeString('zh-TW', { hour12: false })
}

type LogLevel = 'info' | 'ok' | 'warn' | 'error' | 'auth'

const LEVEL_COLOR: Record<LogLevel, string> = {
  info:  C.cyan,
  ok:    C.green,
  warn:  C.yellow,
  error: C.red,
  auth:  C.purple,
}
const LEVEL_ICON: Record<LogLevel, string> = {
  info:  '●',
  ok:    '✔',
  warn:  '⚠',
  error: '✖',
  auth:  '🔑',
}

export function log(level: LogLevel, ip: string, user: string, action: string, detail = '') {
  const color  = LEVEL_COLOR[level]
  const icon   = LEVEL_ICON[level]
  const ipPart = `${C.gray}[${ip}]${C.reset}`
  const uPart  = user !== '—'
    ? `${C.bold}${C.blue}${user}${C.reset}`
    : `${C.gray}guest${C.reset}`
  const actPart = `${color}${icon} ${action}${C.reset}`
  const detPart = detail ? `${C.gray} › ${detail}${C.reset}` : ''
  console.log(`${C.gray}${ts()}${C.reset} ${ipPart} ${uPart}  ${actPart}${detPart}`)
}

// ─── Jira accounts store ──────────────────────────────────────────────────────

export type AccountRole = 'qa' | 'pm' | 'admin' | 'other'

export interface JiraAccount {
  email: string
  token: string
  label: string
  role: AccountRole
  pin_hash?: string | null
  status?: 'active' | 'disabled'
}

export const pinHash = (pin: string) => createHash('sha256').update(pin).digest('hex')

export const readAccounts = (): JiraAccount[] =>
  db.prepare('SELECT email, token, label, role, pin_hash, status FROM jira_accounts').all() as JiraAccount[]

export const upsertAccount = (a: JiraAccount) =>
  db.prepare('INSERT OR REPLACE INTO jira_accounts (email, token, label, role, status) VALUES (?, ?, ?, ?, ?)')
    .run(a.email, a.token, a.label, a.role ?? 'qa', a.status ?? 'active')

export const deleteAccountByEmail = (email: string) =>
  db.prepare('DELETE FROM jira_accounts WHERE email = ?').run(email)

// ─── Permission helpers ───────────────────────────────────────────────────────

export const ALL_PAGE_KEYS = [
  // 'jira' 一個 key 對應整個 Jira 批量工具頁（開單／評論／更新狀態／修改）。
  // 舊的 jira-qa / jira-pm / jira-update 已移除——它們看起來是三個獨立開關，
  // 實際上是 OR 成同一個 gate；jira-pm 更是已移除功能（PM 模式）的殘留位。
  // DB 裡的舊資料留著沒刪，但不在這份清單裡就不會出現在權限頁、也擋不了任何東西。
  'jira','lark','osm','machinetest','imagecheck','osm-config',
  'autospin','url-pool','jackpot','osm-uat',
  'gs-imgcompare','gs-logchecker','gs-bonusv2','history','knowledge','local-agent',
  'ui-screenshot','discord-notify','meter-reconcile','egm-daycount','cultivation-board','xianxia-quotes','weekly-report',
  // 功能開關（不是頁面）：沿用同一套權限 key 機制，讓後台權限頁不用另外長出第二套 UI。
  // canAccess() 只查 tabId，多出來的 key 不會影響側邊欄。
  'jira-ai-format','jira-ai-review',
] as const

export type PageKey = typeof ALL_PAGE_KEYS[number]

/** Returns the set of page keys this role is allowed to access.
 *  Handles legacy comma-separated multi-role values (e.g. 'pm,qa'). */
export function getPermissionsForRole(role: AccountRole | string): string[] {
  // Admin always gets everything
  if (role === 'admin') return [...ALL_PAGE_KEYS, 'sysadmin']

  // Handle legacy comma-separated roles: union of each sub-role's permissions
  const parts = role.split(',').map(r => r.trim()).filter(Boolean)
  if (parts.length > 1) {
    const merged = new Set<string>()
    for (const part of parts) {
      for (const k of getPermissionsForRole(part as AccountRole)) merged.add(k)
    }
    return Array.from(merged)
  }

  // Unknown/unmapped roles get nothing
  if (!['qa', 'pm', 'other'].includes(role)) return []

  const rows = db.prepare('SELECT page_key FROM role_permissions WHERE role = ? AND allowed = 1').all(role) as { page_key: string }[]
  return rows.map(r => r.page_key)
}

// 個人權限覆寫層。現有權限是角色制（role × page_key），但「AI 排版／AI 完整性分析」這種功能
// 使用者要求開到「個人」——用角色開太粗（等於整個 QA 都有）。做法是不動 role_permissions，
// 另外疊一層帳號覆寫：allowed=1 加、allowed=0 減，沒有覆寫就沿用角色預設。這張表對任何 key
// 都適用，之後其他功能要做個人例外不用再開新機制（2026-08-20，跟 CodeX 討論定案）。
db.exec(`
  CREATE TABLE IF NOT EXISTS account_permissions (
    email      TEXT NOT NULL,
    perm_key   TEXT NOT NULL,
    allowed    INTEGER NOT NULL CHECK (allowed IN (0, 1)),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (email, perm_key)
  )
`)

/** 某個帳號的個人覆寫（key → 允許與否）。email 一律小寫比對，避免同一個人存成多筆。 */
export function getAccountPermissionOverrides(email: string): Record<string, boolean> {
  const rows = db.prepare('SELECT perm_key, allowed FROM account_permissions WHERE email = ?')
    .all(email.toLowerCase()) as { perm_key: string; allowed: number }[]
  const out: Record<string, boolean> = {}
  for (const r of rows) out[r.perm_key] = r.allowed === 1
  return out
}

/** 這個帳號實際有的權限＝角色預設 ∪ 個人覆寫。
 *  admin 一律全開，且**不套用個人 deny**——否則「admin 永遠全開」這條規則會變模糊，
 *  也可能把管理員自己鎖在系統外（CodeX review 指出）。 */
export function getEffectivePermissions(email: string, role: AccountRole | string): string[] {
  if (role === 'admin') return [...ALL_PAGE_KEYS, 'sysadmin']
  const base = new Set(getPermissionsForRole(role))
  for (const [key, allowed] of Object.entries(getAccountPermissionOverrides(email))) {
    if (allowed) base.add(key)
    else base.delete(key)
  }
  return Array.from(base)
}

/** 後端單點檢查用。前端把選項藏起來不算防護，寫入端點一律要自己再驗一次。 */
export function accountHasPermission(email: string, role: AccountRole | string, key: string): boolean {
  return getEffectivePermissions(email, role).includes(key)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export const mustEnv = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(`Missing env: ${name}`)
  return value
}

// UAT 後台測試帳密：依「登入帳號」各存一份，不是全站共用一組。
// 原本躺在 server/uat-runner/config/backend-test-params.json（真實帳密在 repo 裡，只差沒被 commit），
// 2026-08-21 改成存 DB＋設定頁自己填。用 email 當 key 是因為 jira_accounts 的 primary key 就是 email，
// 不用 display name（會被改、也不唯一）。密碼永遠不回傳給前端，只回「有沒有設過」。
db.exec(`
  CREATE TABLE IF NOT EXISTS uat_backend_credentials (
    email      TEXT NOT NULL,
    profile    TEXT NOT NULL,
    username   TEXT NOT NULL,
    password   TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (email, profile)
  )
`)

/**
 * 後台 TC 的積木步驟。
 *
 * ⚠️ **不能存回 tc-registry.json**：那個檔案在 runtime 是 `dist-server/` 底下的
 * 建置產物，而 `npm run build` 每次都會 `rmSync` 整個 dist——使用者辛苦編好的積木
 * 會在下一次部署時無聲消失。（第一版就是這樣寫的，測試時才發現。）
 *
 * 存 DB 之後：registry 檔案繼續當「出廠預設的路由表」（verifierName / 凍結文字），
 * 使用者編的積木疊在上面，執行時由 server 合併後透過環境變數傳給 runner。
 * 這樣 agent 派工也一併解決——積木跟著 backend_uat_start 的 payload 走，
 * 不需要 agent 端有那個檔案。
 *
 * 積木是團隊共用的測試定義（跟 registry 同一個定位），所以不按 email 分。
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS uat_tc_steps (
    record_id  TEXT PRIMARY KEY,
    steps      TEXT NOT NULL,
    updated_by TEXT,
    updated_at INTEGER NOT NULL
  )
`)

/**
 * 自訂 TC：錄製出來、但 Lark 上還沒有對應那一筆的測試。
 *
 * ## 為什麼需要這張表
 * 錄製原本只服務「Lark 已有 TC、幫它補自動化步驟」。但使用者最自然的用法是
 * 「錄一個全新流程」——那種 TC 在 Lark 上不存在，硬塞給既有 TC 會把那筆原本
 * 該驗的東西蓋掉。
 *
 * ## 為什麼不直接寫進 Lark
 * 寫入團隊共用表的風險是資料污染，而且錯了很難查來源（跟 CodeX 討論過）。
 * 這裡選擇存在工具裡，但用 link_keyword 讓它是**明確的暫態**而不是另一份
 * 平行的測試清單——自訂 TC 自帶「我以後要歸到哪」，掃到文字命中的 Lark TC
 * 就能把積木搬過去、這筆刪掉。
 *
 * ## 兩份清單的問題怎麼壓住
 * 關鍵不是「不要有兩份」，是**看得出來哪些是自訂的**：畫面分開標示、分開計數，
 * 執行結果明講「未回寫 Lark」。混在一起假裝同一種東西才會出事。
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS uat_custom_tcs (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    subtype       TEXT NOT NULL DEFAULT '',
    /** 選填。之後掃 Lark 時用它比對，命中就能把積木歸戶過去 */
    link_keyword  TEXT NOT NULL DEFAULT '',
    steps         TEXT NOT NULL,
    created_by    TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  )
`)

export interface UatCustomTc {
  id: string
  title: string
  subtype: string
  linkKeyword: string
  steps: unknown[]
  createdBy: string | null
  createdAt: number
  updatedAt: number
}

export function listUatCustomTcs(): UatCustomTc[] {
  const rows = db.prepare(`
    SELECT id, title, subtype, link_keyword, steps, created_by, created_at, updated_at
    FROM uat_custom_tcs ORDER BY created_at DESC
  `).all() as Record<string, string | number | null>[]
  return rows.map(row => ({
    id: String(row.id),
    title: String(row.title),
    subtype: String(row.subtype ?? ''),
    linkKeyword: String(row.link_keyword ?? ''),
    // 壞掉的一筆不要讓整份清單掛掉——回空陣列，畫面上看得出來它沒有積木
    steps: (() => { try { return JSON.parse(String(row.steps)) as unknown[] } catch { return [] } })(),
    createdBy: row.created_by == null ? null : String(row.created_by),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }))
}

export function saveUatCustomTc(input: {
  id?: string; title: string; subtype?: string; linkKeyword?: string; steps: unknown[]; createdBy?: string
}): string {
  const now = Date.now()
  const id = input.id || `custom_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  db.prepare(`
    INSERT INTO uat_custom_tcs (id, title, subtype, link_keyword, steps, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title, subtype = excluded.subtype,
      link_keyword = excluded.link_keyword, steps = excluded.steps, updated_at = excluded.updated_at
  `).run(id, input.title, input.subtype ?? '', input.linkKeyword ?? '',
    JSON.stringify(input.steps ?? []), input.createdBy ?? null, now, now)
  return id
}

/**
 * 歸戶紀錄：某筆自訂 TC 的積木被搬到哪一筆 Lark TC。
 *
 * 自訂那筆搬完就刪掉了，但軌跡要留——不然之後有人問「這些積木哪來的」會查不到。
 * 這是 CodeX review 特別提的：可以刪資料，不能刪 audit trail。
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS uat_custom_tc_adoptions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    custom_tc_id   TEXT NOT NULL,
    custom_title   TEXT NOT NULL,
    lark_record_id TEXT NOT NULL,
    lark_text      TEXT NOT NULL DEFAULT '',
    mode           TEXT NOT NULL,
    step_count     INTEGER NOT NULL,
    actor          TEXT,
    created_at     INTEGER NOT NULL
  )
`)

export function recordCustomTcAdoption(input: {
  customTcId: string; customTitle: string; larkRecordId: string; larkText?: string;
  /** append = 接在既有積木後面；replace = 覆蓋（只有二次確認過才會是這個） */
  mode: 'append' | 'replace'; stepCount: number; actor?: string
}) {
  db.prepare(`
    INSERT INTO uat_custom_tc_adoptions
      (custom_tc_id, custom_title, lark_record_id, lark_text, mode, step_count, actor, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(input.customTcId, input.customTitle, input.larkRecordId, input.larkText ?? '',
    input.mode, input.stepCount, input.actor ?? null, Date.now())
}

export function listCustomTcAdoptions(limit = 100) {
  return db.prepare(`
    SELECT custom_tc_id, custom_title, lark_record_id, lark_text, mode, step_count, actor, created_at
    FROM uat_custom_tc_adoptions ORDER BY created_at DESC LIMIT ?
  `).all(limit)
}

export function deleteUatCustomTc(id: string) {
  return db.prepare('DELETE FROM uat_custom_tcs WHERE id = ?').run(id).changes
}

// 若 server/uat-tc-steps-seed.json 存在，補齊缺少的 TC 積木。
// 積木存在各環境自己的 DB，拆解成果不會自己跑到正式環境——沒有這個種子檔，
// 拆好的積木只活在拆的人那台機器上。用 INSERT OR IGNORE：已經在 DB 裡的
// （含使用者自己編輯過的）一律不動，種子只補「這個環境還沒有的那幾筆」。
{
  const stepsSeedPath = join(SERVER_ROOT, 'uat-tc-steps-seed.json')
  if (existsSync(stepsSeedPath)) {
    try {
      const seed = JSON.parse(readFileSync(stepsSeedPath, 'utf-8')) as { steps?: Record<string, unknown[]> }
      const entries = Object.entries(seed.steps ?? {})
      const ins = db.prepare('INSERT OR IGNORE INTO uat_tc_steps (record_id, steps, updated_by, updated_at) VALUES (?, ?, ?, ?)')
      const now = Date.now()
      for (const [recordId, steps] of entries) {
        if (Array.isArray(steps) && steps.length) ins.run(recordId, JSON.stringify(steps), 'seed', now)
      }
      console.log(`[DB] 已從 uat-tc-steps-seed.json 補齊缺少的 TC 積木（來源 ${entries.length} 筆）`)
    } catch { /* 忽略 */ }
  }
}

/** 全部 TC 的積木，recordId → steps。空陣列的不會出現在結果裡 */
export function listUatTcSteps(): Record<string, unknown[]> {
  const rows = db.prepare('SELECT record_id, steps FROM uat_tc_steps').all() as { record_id: string; steps: string }[]
  const out: Record<string, unknown[]> = {}
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.steps) as unknown[]
      if (Array.isArray(parsed) && parsed.length) out[row.record_id] = parsed
    } catch { /* 壞掉的一筆跳過，不要讓整份積木都讀不出來 */ }
  }
  return out
}

export function getUatTcSteps(recordId: string): unknown[] {
  const row = db.prepare('SELECT steps FROM uat_tc_steps WHERE record_id = ?').get(recordId) as { steps: string } | undefined
  if (!row) return []
  try {
    const parsed = JSON.parse(row.steps) as unknown[]
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

/** 存空陣列＝刪除，回到走 registry 的 verifierName 舊路徑，不要留一筆空紀錄 */
export function saveUatTcSteps(recordId: string, steps: unknown[], updatedBy: string) {
  if (!steps.length) {
    db.prepare('DELETE FROM uat_tc_steps WHERE record_id = ?').run(recordId)
    return
  }
  db.prepare(`
    INSERT INTO uat_tc_steps (record_id, steps, updated_by, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(record_id) DO UPDATE SET steps = excluded.steps, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `).run(recordId, JSON.stringify(steps), updatedBy, Date.now())
}

export type UatBackendProfile = 'cpBackend' | 'nchBackend'
export const UAT_BACKEND_PROFILES: UatBackendProfile[] = ['cpBackend', 'nchBackend']

/** 給設定頁看的：只回帳號與「有沒有設過密碼」，永遠不回密碼本身 */
export function listUatBackendCredentials(email: string) {
  const rows = db.prepare(
    'SELECT profile, username, password, updated_at FROM uat_backend_credentials WHERE email = ?',
  ).all(email.toLowerCase()) as { profile: string; username: string; password: string; updated_at: number }[]
  return UAT_BACKEND_PROFILES.map(profile => {
    const hit = rows.find(r => r.profile === profile)
    return { profile, username: hit?.username ?? '', hasPassword: !!hit?.password, updatedAt: hit?.updated_at ?? null }
  })
}

/** 實際要拿去跑腳本時才讀得到密碼；只在後端使用，不經過任何回應/日誌 */
export function getUatBackendCredentials(email: string) {
  const rows = db.prepare(
    'SELECT profile, username, password FROM uat_backend_credentials WHERE email = ?',
  ).all(email.toLowerCase()) as { profile: string; username: string; password: string }[]
  const out: Partial<Record<UatBackendProfile, { username: string; password: string }>> = {}
  for (const r of rows) {
    if ((UAT_BACKEND_PROFILES as string[]).includes(r.profile) && r.username && r.password) {
      out[r.profile as UatBackendProfile] = { username: r.username, password: r.password }
    }
  }
  return out
}

/** password 留空＝沿用舊密碼（設定頁不會顯示舊密碼，所以不能把空字串當成「清空」）*/
export function saveUatBackendCredential(email: string, profile: UatBackendProfile, username: string, password: string) {
  const key = email.toLowerCase()
  const existing = db.prepare(
    'SELECT password FROM uat_backend_credentials WHERE email = ? AND profile = ?',
  ).get(key, profile) as { password: string } | undefined
  const finalPassword = password || existing?.password || ''
  db.prepare(`
    INSERT INTO uat_backend_credentials (email, profile, username, password, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(email, profile) DO UPDATE SET
      username = excluded.username, password = excluded.password, updated_at = excluded.updated_at
  `).run(key, profile, username, finalPassword, Date.now())
}

const AUTH_COOKIE_NAME = 'toppath_auth'

/**
 * 這個請求「真正登入的是誰」——直接讀 cookie 對 auth_sessions 表，不是看前端送什麼。
 * 刻意不 import auth-session.ts 的 getAuthAccount()：那支檔案本身 import 了 shared.ts，反向 import
 * 會形成循環相依，而 shared.ts 在模組載入當下就要開 DB／建表，循環相依下初始化順序不確定。
 * 登入時 session 本來就會寫進 auth_sessions（不是只存在記憶體快取），直接查表結果一致。
 */
export function authEmailFromRequest(req: express.Request): string | null {
  const raw = req.headers.cookie
  if (!raw) return null
  const prefix = `${AUTH_COOKIE_NAME}=`
  const hit = raw.split(';').map(s => s.trim()).find(s => s.startsWith(prefix))
  if (!hit) return null
  const sid = decodeURIComponent(hit.slice(prefix.length))
  if (!sid) return null
  const row = db.prepare('SELECT email, expires_at FROM auth_sessions WHERE sid = ?').get(sid) as
    { email: string; expires_at: number } | undefined
  if (!row || row.expires_at <= Date.now()) return null
  return row.email
}

/** 代理授權的用途分類。寫入與讀取刻意分成兩個 scope——有人可以幫忙代發評論，不代表可以拿別人的
 *  token 讀他看得到的所有單子，反之亦然。 */
export type JiraDelegationScope = 'jira.comment.batch' | 'jira.read.asOther'

/** 代理關係是否「現在有效」。四個條件集中在這裡，不要散到各個 route 各判一次（CodeX review 建議）。 */
export function hasJiraDelegation(actorEmail: string, targetEmail: string, scope: JiraDelegationScope): boolean {
  if (!actorEmail || !targetEmail) return false
  const row = db.prepare(`
    SELECT 1 FROM jira_account_delegates
    WHERE actor_email = ? AND target_email = ? AND scope = ?
      AND enabled = 1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
    LIMIT 1
  `).get(actorEmail.toLowerCase(), targetEmail.toLowerCase(), scope, Date.now())
  return !!row
}

/** 直接用某個帳號的 token 組 Basic Auth（逐列代發用）。沒有這個帳號、或帳號還沒建 Jira
 *  API token 時回 null——後者是很常見的狀況，畫面上要能明確告訴使用者「去建 token」，
 *  不能跟「查無此人」混為一談。 */
export function jiraAuthForAccount(email: string): { auth: string; email: string; label: string } | null {
  const account = readAccounts().find(a => a.email.toLowerCase() === email.toLowerCase())
  if (!account || !account.token) return null
  return {
    auth: `Basic ${Buffer.from(`${account.email}:${account.token}`).toString('base64')}`,
    email: account.email,
    label: account.label || account.email,
  }
}

/** 表格上的填寫人名字 → 後台帳號。真實資料（使用者提供的驗證表單）的名字是「Eric」「Lusa」
 *  「Siara」，而後台 label 是「Eric Wu」「lusa」，所以需要三層比對：完全相等 → 大小寫/空白
 *  正規化後相等 → label 的**第一個單字**相等。刻意不用 substring 包含比對——那會讓「Jack」
 *  誤中「Jackson」（週報人名比對踩過同一個坑）。命中多筆時回全部，由呼叫端標成需要人工確認，
 *  絕不自動挑一個。 */
export function matchAccountsByPersonName(name: string): { email: string; label: string; hasToken: boolean }[] {
  const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, ' ')
  const target = norm(name)
  if (!target) return []
  const accounts = readAccounts()
  const shape = (a: { email: string; label: string; token?: string }) =>
    ({ email: a.email, label: a.label || a.email, hasToken: !!a.token })

  const exact = accounts.filter(a => norm(a.label || '') === target || norm(a.email.split('@')[0]) === target)
  if (exact.length > 0) return exact.map(shape)

  const byFirstWord = accounts.filter(a => norm(a.label || '').split(' ')[0] === target)
  return byFirstWord.map(shape)
}

export type UserJiraAuthOptions = {
  /** 這支端點允許「用別人的身分」時要求的 scope；不給就是一律只能用自己。 */
  allowDelegationScope?: JiraDelegationScope
  /** 過渡期用：查不到授權時仍放行，但印出可 grep 的警告。等既有關係都補進授權表後就拿掉。 */
  fallbackAllowUnauthorized?: boolean
}

/**
 * 從 request header 的 x-jira-email 找到後端儲存的 token，組成 Basic Auth。
 * 前端只傳 email，token 完全留在後端。
 *
 * 2026-08-20：加上身分邊界檢查。先前這支完全信任 x-jira-email，只要知道別人的 email 就能用他的
 * token 操作 Jira（`/api/jira/*` 沒有全域 auth gate，改一個 header 就成立）。現在預設「header 必須
 * 等於登入 session 的帳號」，只有端點明確傳 allowDelegationScope 才可能放寬，而且還要在授權表裡
 * 查得到有效關係。已確認前端沒有切換操作帳號的入口（JiraAccountModal 的 showAccountModal 從來沒被
 * 設成 true），所以這個預設不會擋掉任何既有的正常流程。
 */
export const userJiraAuth = (
  req: express.Request,
  opts: UserJiraAuthOptions = {},
): { auth: string; email: string; actorEmail: string | null } | null => {
  const email = req.headers['x-jira-email'] as string | undefined
  if (!email) return null
  const accounts = readAccounts()
  const account = accounts.find((a) => a.email === email)
  if (!account) return null

  const actorEmail = authEmailFromRequest(req)
  const isSelf = !!actorEmail && actorEmail.toLowerCase() === email.toLowerCase()
  if (!isSelf) {
    const scope = opts.allowDelegationScope
    const delegated = !!actorEmail && !!scope && hasJiraDelegation(actorEmail, email, scope)
    const where = `route=${req.method} ${req.originalUrl}`
    const who = `actor=${actorEmail ?? '(未登入)'} target=${email}`
    if (!delegated) {
      if (scope && opts.fallbackAllowUnauthorized) {
        // 固定字串方便日後 grep，確認關掉 fallback 前還有誰在靠它跑（CodeX review 建議）
        console.warn(`JIRA_DELEGATION_FALLBACK_ALLOW ${who} scope=${scope} ${where} at=${new Date().toISOString()}`)
      } else {
        console.warn(`JIRA_IDENTITY_MISMATCH_DENY ${who} ${where} at=${new Date().toISOString()}`)
        return null
      }
    }
  }

  return {
    auth: `Basic ${Buffer.from(`${email}:${account.token}`).toString('base64')}`,
    email,
    actorEmail,
  }
}

/** 解析 Lark Sheet URL（支援 /sheets/{token} 和 /wiki/{token} 兩種格式） */
export const parseLarkSheetUrl = (url: string) => {
  const tokenMatch = url.match(/\/sheets\/([A-Za-z0-9]+)/)
    ?? url.match(/\/wiki\/([A-Za-z0-9]+)/)
  const sheetMatch = url.match(/[?&]sheet=([A-Za-z0-9]+)/)
  return {
    spreadsheetToken: tokenMatch?.[1] ?? '',
    sheetId: sheetMatch?.[1] ?? '',
  }
}

/** 取得 Lark tenant_access_token */
export const getLarkToken = async (): Promise<string> => {
  const appId = mustEnv('LARK_APP_ID')
  const appSecret = mustEnv('LARK_APP_SECRET')
  const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'
  const resp = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  })
  const data = (await resp.json()) as { tenant_access_token?: string }
  if (!data.tenant_access_token) throw new Error('[getLarkToken] Failed to get Lark token')
  return data.tenant_access_token
}

const pad2 = (n: number) => String(n).padStart(2, '0')

export const toJiraDateTime = (val: string | undefined): string | null => {
  if (!val) return null
  const s = val.trim()
  if (s.length === 0) return null

  // Lark Sheets API returns date/datetime cells as Excel OA date serial numbers
  // (e.g. 46092 = 2026-03-11, or 46092.5 = 2026-03-11 noon).
  // OA epoch: Day 1 = Jan 1, 1900; Day 60 = phantom Feb 29, 1900 (Excel bug).
  // For days >= 60, subtract 1 to skip the phantom day.
  if (/^\d+(\.\d+)?$/.test(s) && !s.startsWith('20') && !s.startsWith('19')) {
    const serial = Number(s)
    const days = Math.floor(serial)
    const frac  = serial - days
    // Skip Excel's phantom Feb 29, 1900 (serial 60)
    const adjustedDays = days >= 60 ? days - 1 : days
    // Dec 31, 1899T00:00Z + adjustedDays → the calendar date (interpreted as local midnight)
    const epochMs = Date.UTC(1899, 11, 31) + adjustedDays * 86400000
    const d = new Date(epochMs)
    const year  = d.getUTCFullYear()
    const month = pad2(d.getUTCMonth() + 1)
    const day   = pad2(d.getUTCDate())
    const totalMins = Math.round(frac * 24 * 60)
    const hour  = pad2(Math.floor(totalMins / 60))
    const min   = pad2(totalMins % 60)
    return `${year}-${month}-${day}T${hour}:${min}:00.000+0800`
  }

  // Normalise: Lark display format uses slash separators with no zero-padding (e.g. 2026/3/11 00:00)
  // Support: YYYY/M/D HH:mm, YYYY-MM-DD HH:mm, YYYY-MM-DD, YYYY/M/D, YYYY-MM-DDTHH:mm
  const m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:[T\s](\d{1,2}):(\d{2}))?/)
  if (m) {
    const year  = m[1]
    const month = m[2].padStart(2, '0')
    const day   = m[3].padStart(2, '0')
    const hour  = (m[4] ?? '00').padStart(2, '0')
    const min   = (m[5] ?? '00').padStart(2, '0')
    return `${year}-${month}-${day}T${hour}:${min}:00.000+0800`
  }

  // Fallback: already full ISO (has seconds + timezone)
  return s
}

// ─── Multer Upload ────────────────────────────────────────────────────────────

export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } })

// ─── Schemas ──────────────────────────────────────────────────────────────────

export const writebackSchema = z.object({
  sheetUrl: z.string(),
  writes: z.array(z.object({ rowIndex: z.number(), issueKey: z.string() })),
  issueKeyColumn: z.string().default('Jira Issue Key'),
})

export const larkGenerateSchema = z.object({
  // Multi-source (new): array of {type, url} entries
  sources: z.array(z.object({
    type: z.enum(['lark', 'gdocs']),
    url: z.string(),
  })).optional(),
  // Single-source (legacy, backward compat)
  specSource: z.enum(['lark', 'gdocs']).default('lark').optional(),
  specUrl: z.string().optional(),
  googleDocsUrl: z.string().optional(),
  manualTestCases: z.array(z.record(z.string(), z.any())).default([]),
  promptId: z.string().optional(),
  jiraKeys: z.array(z.string()).default([]),
  jiraEmail: z.string().optional(),
  modelSpec: z.string().optional(),
  // Diff mode: old spec sources (fetched separately, passed as {{old_spec}})
  oldSources: z.array(z.object({
    type: z.enum(['lark', 'gdocs', 'pdf', 'csv']),
    url: z.string().optional(),
    content: z.string().optional(), // csv text or pdf base64
  })).optional(),
  // Baseline mode: existing test cases source (json paste / lark url / csv / xlsx base64)
  existingCasesSource: z.object({
    type: z.enum(['json', 'lark', 'csv', 'xlsx']),
    content: z.string().optional(), // json/csv text, or base64-encoded xlsx
    url: z.string().optional(),     // lark bitable url
  }).optional(),
  // Second Pass: auto-fill empty fields after first generation
  secondPass: z.boolean().optional(),
  secondPassModel: z.string().optional(),
  secondPassPromptId: z.string().optional(),
})

export const gmailLatestSchema = z.object({ query: z.string().optional() })

export const osmVersionSyncSchema = z.object({
  rows: z.array(
    z.object({ server: z.string(), ip: z.string(), version: z.string(), status: z.string().optional() }),
  ),
})

// ─── Google Sheets helpers ────────────────────────────────────────────────────

export const parseGoogleSheetUrl = (url: string) => {
  const idMatch = url.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/)
  const gidMatch = url.match(/[#&?]gid=(\d+)/)
  return {
    spreadsheetId: idMatch?.[1] ?? '',
    gid: gidMatch?.[1] ?? '0',
  }
}

export const getGoogleServiceAccountToken = async (): Promise<string> => {
  const email = mustEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL')
  const rawKey = mustEnv('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY').replace(/\\n/g, '\n')

  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url')

  const sign = createSign('RSA-SHA256')
  sign.update(`${header}.${payload}`)
  const signature = sign.sign(rawKey, 'base64url')
  const jwt = `${header}.${payload}.${signature}`

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  })
  const data = await resp.json() as { access_token?: string; error?: string; error_description?: string }
  if (!data.access_token) {
    throw new Error(`Google Service Account 認證失敗: ${data.error} - ${data.error_description}`)
  }
  return data.access_token
}

export const hasGoogleServiceAccount = () =>
  !!(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY)

