/**
 * OSM 機台 → Machine Model（egmList 的 machineType）對照，落在 DB。
 *
 * 為什麼不直接用 routes/osm.ts 的 `osmChannelCache`（CodeX review 2026-10-02）：
 * OSM 同步跑在主程序（index.ts），UI 截圖的路由跑在 worker（worker.ts），記憶體不共用——
 * worker import 到的永遠是空陣列。所以同步成功時寫 DB，worker 從 DB 讀。
 *
 * gmid（大廳卡片的 title，例如 `4182-WLZBHELIX-2136`）＝ egmList 的 machineName，開頭的數字就是渠道 id，
 * 不同渠道不會撞名。
 */
import type Database from 'better-sqlite3'

type DB = Database.Database

export function initOsmMachineTypes(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS osm_machine_types (
      machine_name TEXT PRIMARY KEY,   -- 大寫，等於大廳的 gmid
      machine_type TEXT NOT NULL,      -- Machine Model，例如 wlzbhelix9
      channel      TEXT NOT NULL,      -- 同步時的渠道名稱（CP、NP…）
      synced_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_osm_machine_types_channel ON osm_machine_types(channel);
  `)
}

/**
 * 一個渠道同步成功後整批換掉該渠道的資料（機台被移除的也會消失）。
 * 同步失敗不要呼叫——失敗時保留上一次的資料，比清成空的好（清空會讓整個渠道變成「未同步」）。
 */
export function saveChannelMachineTypes(db: DB, channel: string, machines: Array<{ machineName: string; machineType: string }>, now = Date.now()) {
  const del = db.prepare('DELETE FROM osm_machine_types WHERE channel = ?')
  const ins = db.prepare('INSERT OR REPLACE INTO osm_machine_types (machine_name, machine_type, channel, synced_at) VALUES (?, ?, ?, ?)')
  db.transaction(() => {
    del.run(channel)
    for (const m of machines) {
      const name = m.machineName.trim().toUpperCase()
      const type = m.machineType.trim()
      if (name && type) ins.run(name, type, channel, now)
    }
  })()
}

export type MachineTypeLookup = { types: Map<string, string>; syncedAt: number | null }

/** 查一批 gmid 的 Machine Model。查不到的不放進 map（呼叫端歸成「未同步」，不猜）。 */
export function lookupMachineTypes(db: DB, gmids: string[]): MachineTypeLookup {
  const types = new Map<string, string>()
  const stmt = db.prepare('SELECT machine_type FROM osm_machine_types WHERE machine_name = ?')
  for (const g of new Set(gmids.map(x => x.trim().toUpperCase()).filter(Boolean))) {
    const row = stmt.get(g) as { machine_type: string } | undefined
    if (row) types.set(g, row.machine_type)
  }
  const last = db.prepare('SELECT MAX(synced_at) AS t FROM osm_machine_types').get() as { t: number | null }
  return { types, syncedAt: last?.t ?? null }
}
