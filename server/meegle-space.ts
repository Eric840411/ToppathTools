/**
 * Meegle 雙空間的後端部分（v5.10.0，設計跟 CodeX 對過 2026-10-05）。
 *
 * - **空間跟著紀錄走**：新請求一定要帶 space（缺少或不認得 → 400，不默默當成測試）；
 *   重試、補推、查詢結果、補回填一律用紀錄上的 space，不讀畫面目前的切換值
 * - **一個批次只屬於一個空間**；開單時**同一列、同一個名稱已在另一個空間開過 → 擋下**（只靠「Sheet＋列＋空間」去重的話，
 *   誤切空間後會在另一邊再開一次）。v5.60.0 前是整份 Sheet 綁一個空間，見 spaceGuard
 * - **⚠️ Meegle 不驗 project key**：拿正式的 key 去 get 測試空間的單照樣回 200（2026-10-05 實測 #15194995），
 *   寫入大概也一樣。所以評論／狀態／修改動到既有單之前，要用 checkItemSpace 核對單子真正所屬的空間（owned_project）
 */
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { isAdminRole } from './role-store.js'
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

/**
 * **測試空間只給管理員**（使用者 2026-10-06：其他角色一律正式；CodeX 同意＋必補）。
 * - 新請求帶 space=test、或要動的紀錄（DB 上的 space）是 test → 非管理員回 403，不默默改成 prod
 * - 角色看登入 session 目前的帳號（getAuthAccount 每次查 DB，降權立刻生效）
 * - 舊資料沒有 space 的仍照 rowSpace() 當 test——不能為了讓非管理員看得到就改成 prod
 */
export function canUseSpace(role: string | null | undefined, space: MeegleSpace): boolean {
  return space !== 'test' || isAdminRole(role)
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
 * 認領前的批次檢查：這個批次已經有別的空間的列 → space-mismatch（一個批次只屬於一個空間）。
 * 要在認領的同一個 IMMEDIATE transaction 裡呼叫。table 是程式內固定字串，不是使用者輸入。
 *
 * v5.60.0 起**不再把整份 Sheet 綁在一個空間**（使用者 2026-10-15：同一份 Sheet 會一直換內容重開，
 * 測試送過一次就永遠不能送正式。CodeX 同意）：
 * - 開單：只擋「同一列＋同一個 Sheet 名稱」在另一個空間開過的（rowSpaceConflict）
 * - 評論／狀態／修改：動的是既有單，靠 checkItemSpace 核對單子真正所屬的空間；
 *   若仍看整份 Sheet，同一份 Sheet 測試開 A、正式開 B 之後兩邊都會被擋死（CodeX 2026-10-15）
 */
export function spaceGuard(db: DB, table: string, batchId: string, space: MeegleSpace): SpaceGuard | null {
  if (db.prepare(`SELECT 1 FROM ${table} WHERE batch_id = ? AND space != ? LIMIT 1`).get(batchId, space)) return { kind: 'space-mismatch' }
  return null
}

/**
 * 開單：同一份 Sheet、同一列、同一個 Sheet 名稱，已經在另一個空間開成功 → space-conflict（切錯空間會在另一邊再開一次）。
 * 名稱比 sheet_name，舊資料空字串退回 name（跟 claimRow 的「已開過」同一把鍵）。
 * 限制：名稱不是內容指紋——只改描述會被當成同一筆；改名或搬列會被當成新的一筆。
 * 開單中／待確認不在這裡判：claimRow 的 busy 本來就跨空間、不比名稱擋著。
 */
export function rowSpaceConflict(db: DB, sheetUrl: string, rowKey: string, sheetName: string, space: MeegleSpace): SpaceGuard | null {
  if (!sheetUrl || !sheetName) return null
  const r = db.prepare(`SELECT space FROM meegle_batch_rows WHERE sheet_url = ? AND row_key = ? AND space != ? AND create_phase = 'created'
    AND (CASE WHEN sheet_name != '' THEN sheet_name ELSE name END) = ? LIMIT 1`).get(sheetUrl, rowKey, space, sheetName) as { space: string } | undefined
  return r ? { kind: 'space-conflict', other: rowSpace(r.space) } : null
}

export const spaceGuardMessage = (g: SpaceGuard, space: MeegleSpace) => g.kind === 'space-mismatch'
  ? '這個批次是另一個空間的，請重新讀取 Sheet 後再送'
  : `這一列（同一個名稱）已經在「${meegleSpaceLabel(g.other)}」空間開過，不能再開到「${meegleSpaceLabel(space)}」。如果是要開新的一筆，請先改 Sheet 上的名稱`

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
