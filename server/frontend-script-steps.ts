/**
 * server/frontend-script-steps.ts — H5／PC 腳本的 steps 欄位怎麼收（v5.49.3，CodeX 1013 定案）
 *
 * 起因：PUT /api/frontend-auto/scripts/:id 沒帶 steps 時，原本的 jsonSteps(undefined) 回 '[]'，
 *       **整份腳本的步驟被靜默清光**；同一支 handler 對 larkUrl／tableId／bindings 卻是「沒帶就保留」。
 *       前端存檔每次都帶 steps，會踩到的是直接打 API 的人（osm-qa-agent 1013 改 27 支腳本時發現）。
 *
 * 規則：
 *   - undefined：PUT＝保留原值（SQL 直接不動 steps 欄）；POST＝新腳本，空陣列
 *   - 陣列：替換（[] 就是明確清空）
 *   - JSON 陣列字串：沿用舊支援，解析後必須是陣列
 *   - 其他（null、物件、數字、布林、壞掉的字串）：丟 StepsInputError → 400，整筆不更新
 */
import type Database from 'better-sqlite3'

export class StepsInputError extends Error {}

/** null＝保留原值（只有 PUT 會拿到）；否則是要寫進去的 JSON 字串 */
export function parseStepsInput(value: unknown, onMissing: 'keep' | 'empty'): string | null {
  if (value === undefined) return onMissing === 'keep' ? null : '[]'
  if (Array.isArray(value)) return JSON.stringify(value)
  if (typeof value === 'string') {
    let parsed: unknown
    try { parsed = JSON.parse(value) } catch { throw new StepsInputError('steps 不是合法的 JSON') }
    if (!Array.isArray(parsed)) throw new StepsInputError('steps must be a JSON array')
    return JSON.stringify(parsed)
  }
  throw new StepsInputError(`steps must be an array (got ${value === null ? 'null' : typeof value})`)
}

export type ScriptUpdate = { name: string; platform: string; steps: unknown; updatedAt: number; larkUrl: string; tableId: string; bindings: string }

/**
 * PUT 的 UPDATE。steps 先驗（不合法就丟錯，什麼都沒寫）；undefined 時 steps 欄位不動。
 * 綁定欄位的「沒帶就保留」由呼叫端決定好值再傳進來（沿用原本的 existingBinding）。
 */
export function updateFrontendScript(db: Database.Database, id: string, u: ScriptUpdate): void {
  const steps = parseStepsInput(u.steps, 'keep')
  db.prepare(`
    UPDATE frontend_auto_scripts
    SET name = ?, platform = ?, steps = COALESCE(?, steps), updated_at = ?, lark_url = ?, table_id = ?, bindings = ?
    WHERE id = ?
  `).run(u.name, u.platform, steps, u.updatedAt, u.larkUrl, u.tableId, u.bindings, id)
}
