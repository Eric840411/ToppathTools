/**
 * Meegle 雙空間的後端部分（v5.10.0，設計跟 CodeX 對過 2026-10-05）。
 *
 * - **空間跟著紀錄走**：新請求一定要帶 space（缺少或不認得 → 400，不默默當成測試）；
 *   重試、補推、查詢結果、補回填一律用紀錄上的 space，不讀畫面目前的切換值
 * - **一個批次只屬於一個空間**；**同一份 Sheet 已在另一個空間送過 → 擋下**（只靠「Sheet＋列＋空間」去重的話，
 *   誤切空間後會在另一邊再開一次）
 * - **⚠️ Meegle 不驗 project key**：拿正式的 key 去 get 測試空間的單照樣回 200（2026-10-05 實測 #15194995），
 *   寫入大概也一樣。所以評論／狀態／修改動到既有單之前，要用 checkItemSpace 核對單子真正所屬的空間（owned_project）
 */
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { isMeegleSpace, meegleSpaceLabel, type MeegleSpace } from '../shared/meegle-space.js'
import { call, defaultRunner, meegleTarget, type CallOutcome, type Runner } from './meegle-workitem.js'

type DB = Database.Database

export type { MeegleSpace }

const DEFAULT_KEYS: Record<MeegleSpace, string> = {
  test: '6abb348976c120f4f43c746a', // TP-項目管理-測試
  prod: '6ac081a48614642b450645c5', // 正式空間（任務項類型、欄位、角色 key 跟測試實測相同，只有 project key 不同）
}

export function spaceProjectKey(space: MeegleSpace, env: NodeJS.ProcessEnv = process.env): string {
  return space === 'prod' ? (env.MEEGLE_PROD_PROJECT_KEY || DEFAULT_KEYS.prod) : (env.MEEGLE_PROJECT_KEY || DEFAULT_KEYS.test)
}

/**
 * 給所有 Meegle 操作用的 env：project key 換成這個空間的。
 * 各操作函式本來就收 env（meegleTarget(env) 取 key），所以空間從這裡一路傳下去，不另外加參數。
 */
export function spaceEnv(space: MeegleSpace, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, MEEGLE_PROJECT_KEY: spaceProjectKey(space, base) }
}

/** 新請求的 space 欄位：必填、只認兩個值（沒有 default——缺了要報錯，不是當成測試） */
export const spaceSchema = z.enum(['test', 'prod'])

/** 讀舊紀錄的 space：舊資料（加欄位前）一律是測試 */
export const rowSpace = (v: unknown): MeegleSpace => (isMeegleSpace(v) ? v : 'test')

/** 紀錄表補 space 欄。舊資料全部是測試空間開的（雙空間之前只有測試） */
export function addSpaceColumn(db: DB, table: string) {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name)
  if (!cols.includes('space')) db.exec(`ALTER TABLE ${table} ADD COLUMN space TEXT NOT NULL DEFAULT 'test'`)
}

export type SpaceGuard = { kind: 'space-mismatch' } | { kind: 'space-conflict'; other: MeegleSpace }

/**
 * 認領前的空間檢查（要在認領的同一個 transaction 裡呼叫）：
 * - 這個批次已經有別的空間的列 → space-mismatch（一個批次只屬於一個空間）
 * - 這份 Sheet 已經在別的空間送過 → space-conflict（同一份 Sheet 不會兩邊都開，送過就代表切錯了）
 * table／sourceCol 是程式內固定字串，不是使用者輸入。
 */
export function spaceGuard(db: DB, table: string, sourceCol: string, batchId: string, sourceKey: string, space: MeegleSpace): SpaceGuard | null {
  if (db.prepare(`SELECT 1 FROM ${table} WHERE batch_id = ? AND space != ? LIMIT 1`).get(batchId, space)) return { kind: 'space-mismatch' }
  if (sourceKey) {
    const other = db.prepare(`SELECT space FROM ${table} WHERE ${sourceCol} = ? AND space != ? LIMIT 1`).get(sourceKey, space) as { space: string } | undefined
    if (other) return { kind: 'space-conflict', other: rowSpace(other.space) }
  }
  return null
}

/** 這份 Sheet 在別的空間送過嗎（「之前送過的列」用，讓畫面在讀 Sheet 時就提示，不用等到送出才被擋） */
export function otherSpaceOf(db: DB, table: string, sourceCol: string, sourceKey: string, space: MeegleSpace): MeegleSpace | null {
  if (!sourceKey) return null
  const r = db.prepare(`SELECT space FROM ${table} WHERE ${sourceCol} = ? AND space != ? LIMIT 1`).get(sourceKey, space) as { space: string } | undefined
  return r ? rowSpace(r.space) : null
}

export const spaceGuardMessage = (g: SpaceGuard, space: MeegleSpace) => g.kind === 'space-mismatch'
  ? '這個批次是另一個空間的，請重新讀取 Sheet 後再送'
  : `這份 Sheet 已經在「${meegleSpaceLabel(g.other)}」空間送過，不能再送到「${meegleSpaceLabel(space)}」。同一份 Sheet 只能用一個空間，請確認是不是切錯了`

/**
 * 核對一張既有的單真的在這個空間（Meegle 不驗 project key，見檔頭）。
 * 讀不到／看不懂 → 照原樣回傳（呼叫端當失敗處理，不能當成通過）。
 */
export async function checkItemSpace(token: string, workItemId: string, space: MeegleSpace, runner: Runner = defaultRunner, env: NodeJS.ProcessEnv = process.env): Promise<CallOutcome<true>> {
  const want = meegleTarget(spaceEnv(space, env)).projectKey
  const r = await call(runner, ['workitem', 'get', '--project-key', want, '--work-item-id', workItemId, '--fields', 'name'], token)
  if (r.kind !== 'ok') return r
  const owned = (r.value as { work_item_attribute?: { owned_project?: { key?: unknown } } })?.work_item_attribute?.owned_project?.key
  if (typeof owned !== 'string' || !owned) return { kind: 'unknown', message: `讀不到 #${workItemId} 所屬的空間` }
  if (owned === want) return { kind: 'ok', value: true }
  const actual = owned === spaceProjectKey('prod', env) ? '正式' : owned === spaceProjectKey('test', env) ? '測試' : `其他空間（${owned}）`
  return { kind: 'rejected', message: `#${workItemId} 是「${actual}」空間的單，不是目前選的「${meegleSpaceLabel(space)}」。請切換空間後重新讀取 Sheet` }
}
