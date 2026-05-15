/**
 * server/shared.ts
 * Shared utilities, DB instance, helpers, and types used across all route files.
 */
import Bottleneck from 'bottleneck'
import { createHash, createSign, randomBytes, timingSafeEqual } from 'crypto'
import Database from 'better-sqlite3'
import dotenv from 'dotenv'
import express from 'express'
import rateLimit from 'express-rate-limit'
import { existsSync, readFileSync, renameSync } from 'fs'
import multer from 'multer'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { z } from 'zod'
import { getOperatorFromContext, type OperatorInfo } from './request-context.js'

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

{
  const cols = db.prepare('PRAGMA table_info(operation_history)').all() as { name: string }[]
  if (!cols.find(c => c.name === 'operator_key')) {
    db.exec(`ALTER TABLE operation_history ADD COLUMN operator_key TEXT NOT NULL DEFAULT ''`)
  }
  if (!cols.find(c => c.name === 'operator_name')) {
    db.exec(`ALTER TABLE operation_history ADD COLUMN operator_name TEXT NOT NULL DEFAULT ''`)
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

// Migration: split 'jira' into 'jira-qa' and 'jira-pm' in role_permissions
{
  const jiraRows = db.prepare("SELECT COUNT(*) as c FROM role_permissions WHERE page_key = 'jira'").get() as { c: number }
  if (jiraRows.c > 0) {
    db.transaction(() => {
      // copy jira → jira-pm, then rename jira → jira-qa
      const rows = db.prepare("SELECT role, allowed FROM role_permissions WHERE page_key = 'jira'").all() as { role: string; allowed: number }[]
      for (const row of rows) {
        db.prepare("INSERT OR IGNORE INTO role_permissions (role, page_key, allowed) VALUES (?, 'jira-pm', ?)").run(row.role, row.allowed)
      }
      db.exec("UPDATE role_permissions SET page_key = 'jira-qa' WHERE page_key = 'jira'")
    })()
    console.log('[DB] role_permissions: jira → jira-qa + jira-pm 已遷移')
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
      "larkWebhook TEXT NOT NULL DEFAULT ''", "machineNo TEXT NOT NULL DEFAULT ''"]
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

/** index → component name mapping (Bg Client index TBD — pending dev) */
export const LUCKYLINK_VERSION_COMPONENTS: Record<string, string> = {
  '1': 'Luckylink Server',
  '4': 'BG Server',
}

/** Desired display order (Bg Client will show as — until API returns it) */
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
  'jira-qa','jira-pm','lark','osm','machinetest','imagecheck','osm-config',
  'autospin','url-pool','jackpot','osm-uat',
  'gs-imgcompare','gs-logchecker','gs-bonusv2','history',
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

export const mustEnv = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(`Missing env: ${name}`)
  return value
}

/**
 * 從 request header 的 x-jira-email 找到後端儲存的 token，組成 Basic Auth。
 * 前端只傳 email，token 完全留在後端。
 */
export const userJiraAuth = (req: express.Request): { auth: string; email: string } | null => {
  const email = req.headers['x-jira-email'] as string | undefined
  if (!email) return null
  const accounts = readAccounts()
  const account = accounts.find((a) => a.email === email)
  if (!account) return null
  return {
    auth: `Basic ${Buffer.from(`${email}:${account.token}`).toString('base64')}`,
    email,
  }
}

/** 解析 Lark Sheet URL */
export const parseLarkSheetUrl = (url: string) => {
  const tokenMatch = url.match(/\/sheets\/([A-Za-z0-9]+)/)
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

export const toJiraDateTime = (val: string | undefined): string | null => {
  if (!val) return null
  const s = val.trim()
  if (s.length === 0) return null
  const dt = s.length === 10 ? `${s}T00:00:00.000+0800` : s.replace(' ', 'T') + ':00.000+0800'
  return dt
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

