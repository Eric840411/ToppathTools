// 1007 iDeck 時間學習：學習值存在獨立表 machine_test_ideck_timing（CodeX 定案：不放 profiles——
// ARUZE 沒有 profile 列、新建一列會改掉 bonusAction 預設；profiles 的 PUT 是整列 upsert，畫面一存就會蓋掉學習值）。
// 三款初始值（osm-qa-agent knowledge/games/{ARUZE,BZZF,JJBXGRAND}/automation/ideck-timing.json，主使用者 10/07 確認）
// **只在該列不存在時補種一次**，之後的撤銷紀錄不會被種子蓋回去。
import type Database from 'better-sqlite3'
import type { IdeckTimingCfg } from './verdicts.js'

const SEED_CONFIRMED = { status: 'confirmed' as const, confirmedAt: '2026-10-07', confirmedBy: '主使用者（Lark：相信自己的測試結果）', beginWaitMs: 1500 }
export const IDECK_TIMING_SEEDS: Record<string, IdeckTimingCfg> = {
  ARUZE: { schemaVersion: 1, ...SEED_CONFIRMED, samples: 15, buttons: Object.fromEntries(['PLAY11Credits', 'PLAY33Credits', 'PLAY55Credits', 'PLAY66Credits', 'PLAY88Credits'].map(n => [n, { noRound: true }])) },
  BZZF: { schemaVersion: 1, ...SEED_CONFIRMED, samples: 37, buttons: Object.fromEntries(['18Credits', '38Credits', '68Credits'].map(n => [n, { noRound: true }])) },
  JJBXGRAND: { schemaVersion: 1, ...SEED_CONFIRMED, confirmedBy: '主使用者（Lark：jjbxgrand遊戲就是這樣的 相信自己的測試結果）', samples: 8, buttons: Object.fromEntries(['BETx1', 'BETx2', 'BETx4', 'BETx6', 'BETx10', 'PLAY18Credits', 'PLAY28Credits', 'PLAY38Credits', 'PLAY68Credits', 'PLAY88Credits'].map(n => [n, { noRound: true }])) },
}

export function initIdeckTimingTable(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS machine_test_ideck_timing (
    machineType TEXT PRIMARY KEY,
    data        TEXT NOT NULL,
    updatedAt   TEXT NOT NULL
  )`)
  const ins = db.prepare('INSERT OR IGNORE INTO machine_test_ideck_timing (machineType, data, updatedAt) VALUES (?, ?, ?)')
  for (const [t, cfg] of Object.entries(IDECK_TIMING_SEEDS)) {
    if (ins.run(t, JSON.stringify(cfg), new Date().toISOString()).changes) console.log(`[DB] machine_test_ideck_timing 補種：${t}`)
  }
}

export function readIdeckTimings(db: Database.Database): Record<string, IdeckTimingCfg> {
  const out: Record<string, IdeckTimingCfg> = {}
  for (const r of db.prepare('SELECT machineType, data FROM machine_test_ideck_timing').all() as { machineType: string; data: string }[]) {
    try { out[r.machineType.toUpperCase()] = JSON.parse(r.data) as IdeckTimingCfg } catch { /* 壞掉的列不套用（＝保守） */ }
  }
  return out
}

/**
 * 撤銷（原子）：status → learning、記原因與時間；清單保留（之後重學用）。沒有這一列回 false。
 * 已經不是 confirmed 的不重複改時間（同一批多台撤銷同一機種）
 */
export function revokeIdeckTiming(db: Database.Database, machineType: string, reason: string): { ok: boolean; changed: boolean } {
  return db.transaction(() => {
    const row = db.prepare('SELECT data FROM machine_test_ideck_timing WHERE machineType = ?').get(machineType.toUpperCase()) as { data: string } | undefined
    if (!row) return { ok: false, changed: false }
    const cfg = JSON.parse(row.data) as IdeckTimingCfg
    if (cfg.status !== 'confirmed') return { ok: true, changed: false }
    const next: IdeckTimingCfg = { ...cfg, status: 'learning', revokedAt: new Date().toISOString(), revokeReason: reason.slice(0, 300) }
    db.prepare('UPDATE machine_test_ideck_timing SET data = ?, updatedAt = ? WHERE machineType = ?').run(JSON.stringify(next), new Date().toISOString(), machineType.toUpperCase())
    return { ok: true, changed: true }
  })()
}
