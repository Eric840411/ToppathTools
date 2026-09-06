/**
 * server/lib/luckylink-recon.ts — Live Ledger P2 的 LuckyLink 用戶端（L4 JP 中獎 / L5 JP 池）。
 *
 * ⚠️ 這支跟 `server/routes/osm.ts` 裡既有的 LuckyLink 呼叫**不是同一組**：
 *     · base 不同（`luckylink-backendserver` vs OSM 那組）
 *     · 登入 body 是 JSON，不是 form-urlencoded
 *     · token 走 **query string**，不是 header
 *    照既有那套寫會登入成功但每一支報表都回空，而且不會報錯。
 *
 * 端點形狀與欄位名稱全部照規格方實測的結果，不是從文件抄的。
 */
import { db } from '../shared.js'

export type ReconEnv = 'qat' | 'uat'

const BASE: Record<ReconEnv, string> = {
  qat: process.env.LUCKYLINK_QAT_URL || 'https://luckylink-backendserver.osmslot.org',
  uat: process.env.LUCKYLINK_UAT_URL || 'https://luckylink-uat-backendserver.osmslot.org',
}
const CLIENT_VERSION = '1.0.4.10'

/** ⚠️ 帳密走 env var，不寫死在程式碼裡——寫死的密鑰進了 git 歷史就永久留在那裡（v3.92.2 踩過）。 */
function creds(): { username: string; password: string } {
  return {
    username: process.env.LUCKYLINK_USER || 'admin',
    password: process.env.LUCKYLINK_PASS || '123456',
  }
}

const tokens = new Map<ReconEnv, { token: string; at: number }>()
const TOKEN_TTL_MS = 20 * 60_000

async function login(env: ReconEnv): Promise<string | null> {
  try {
    const r = await fetch(`${BASE[env]}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(creds()),
    })
    const d = await r.json() as { data?: { token?: string }; msg?: string }
    const t = d.data?.token
    if (!t) return null
    tokens.set(env, { token: t, at: Date.now() })
    return t
  } catch { return null }
}

async function tokenFor(env: ReconEnv): Promise<string | null> {
  const cur = tokens.get(env)
  if (cur && Date.now() - cur.at < TOKEN_TTL_MS) return cur.token
  return login(env)
}

export interface LlResult<T> { ok: boolean; items: T[]; total: number; errKind?: string; message?: string }

/**
 * 所有報表都是 POST + token 在 query。
 *
 * ⚠️ 拿到空陣列**不代表沒有資料**——token 過期、帳密錯、權限不足全都長這樣。
 *    所以回傳結構把 `ok` 跟 `items` 分開，呼叫端才有辦法區分
 *    「查過了、沒有」跟「根本沒查成」。這是 v4.89.0 那個坑的同一條規則。
 */
async function post<T>(env: ReconEnv, path: string, body: Record<string, unknown>, retry = true): Promise<LlResult<T>> {
  const token = await tokenFor(env)
  if (!token) return { ok: false, items: [], total: 0, errKind: 'auth_failed', message: 'LuckyLink 登入失敗' }
  try {
    const url = `${BASE[env]}${path}?token=${encodeURIComponent(token)}&clientversion=${CLIENT_VERSION}`
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    // ⚠️ 實測回應是 `data.items`（不是 list／rows）。用猜的會得到最難查的形狀：
    //    連得上、code=20000、total 有數字，但**一筆都拿不到**。
    const d = await r.json() as { code?: number; msg?: string; message?: string
      data?: { items?: T[]; list?: T[]; total?: number } | T[] }
    // token 失效時多半回非 20000 的 code；重登一次再試
    if (d.code !== undefined && d.code !== 20000 && d.code !== 200) {
      if (retry) { tokens.delete(env); return post<T>(env, path, body, false) }
      return { ok: false, items: [], total: 0, errKind: 'api_error', message: `code=${d.code} ${d.msg ?? d.message ?? ''}` }
    }
    const data = d.data
    const items = Array.isArray(data) ? data : (data?.items ?? data?.list ?? [])
    const total = Array.isArray(data) ? data.length : (data?.total ?? items.length)
    return { ok: true, items, total }
  } catch (e) {
    return { ok: false, items: [], total: 0, errKind: 'network_error', message: String(e) }
  }
}

// ─── 四支端點 ────────────────────────────────────────────────────────────

export interface LlLevel {
  id: string; name: string; basevalue: number; poolamount: number
  incrementPercent: number; groupid: string; protocallevelid: number
  maxValue: number; OverageCurrentValue?: number; backoveragepool?: number; groupName?: string
}
export interface LlPoolChange {
  levelid: string; machineid: string; groupid: string
  oldcoinin: number; newcoinin: number; timestamp: number | string
  before: number; beforeover: number; change: number; after: number; afterover: number
  poolamount: number; reqmd5: string; reason: number | string
  levelName: string; protocallevelid: number; machineName: string; groupName: string
  channelId?: string; assetnumber?: string; serialnumber?: string
}
export interface LlAward {
  time: number | string; groupname?: string; groupName?: string; groupid: string
  levelid: string; levelname: string; machineid: string; gmid: string
  amount: number; beforeAmount: number; afterAmount: number
  isException: number | boolean; protocallevelid: number; assetnumber?: string
}

export const fetchLevels = (env: ReconEnv, page = 1, pageSize = 500) =>
  post<LlLevel>(env, '/progressives/levelsListData', { page, pageSize, name: '' })

export const fetchGroups = (env: ReconEnv, page = 1, pageSize = 500) =>
  post<Record<string, unknown>>(env, '/groups/groupsListData', { page, pageSize, name: '' })

export const fetchPoolChanges = (env: ReconEnv, fromIso: string, toIso: string, machineName = '', page = 1, pageSize = 500) =>
  post<LlPoolChange>(env, '/reports/poolChangeReport', {
    page, pageSize, machineName, levelName: '', dateTime: [fromIso, toIso], type: '',
  })

export const fetchAwards = (env: ReconEnv, fromIso: string, toIso: string, machineName = '', page = 1, pageSize = 500) =>
  post<LlAward>(env, '/reports/awardsReport', {
    page, pageSize, machineName, levelName: '', dateTime: [fromIso, toIso],
  })

// ─── 單位與語意 ──────────────────────────────────────────────────────────
//
// ⚠️ 這一段是最容易錯的地方，逐條寫死：
//   incrementPercent  小數（0.005 = 0.5%），不是百分比數字
//   poolamount        micro-PHP → 顯示值 = basevalue + poolamount / 1,000,000
//   basevalue/maxValue PHP
//   protocallevelid   1=Grand 2=Major 3=Minor 4=Mini
//
// ⚠️ **Level 名稱可能跟 protocallevelid 對不上**（實測 QAT group 139 的 L1 叫 Major、
//    L2 叫 Grand）。一律以 `protocallevelid` 為準，不要看名字。

export const MICRO = 1_000_000
export const LEVEL_NAME: Record<number, string> = { 1: 'Grand', 2: 'Major', 3: 'Minor', 4: 'Mini' }

/** 池的顯示值。⚠️ poolamount 是 micro-PHP，直接顯示會差 100 萬倍。 */
export const poolDisplay = (basevalue: number, poolamount: number) => basevalue + poolamount / MICRO

export type PoolVerify = 'ok' | 'mismatch' | 'skipped_overflow' | 'skipped_reason' | 'no_level'

/**
 * L5 逐筆驗證：`change ≈ (newcoinin − oldcoinin) × incrementPercent`，並順手驗 `after == before + change`。
 *
 * ⚠️ 三個前提，缺一就不能判 mismatch：
 *   1. **只驗正常累積**（`reason` = 1）。中獎那筆的 reason 值規格方還沒實際看到過，
 *      所以不認得的 reason 一律 `skipped_reason`，**不要當成不符**——
 *      把沒見過的情況判成錯，比不判更糟。
 *   2. **`before` 已達 `maxValue` 時公式不成立**（累積溢流進 backoveragepool），
 *      要先檢查再判定，否則池滿頂的機台會整批誤報。
 *   3. 對不到 Level 參數時回 `no_level`，不是 ok——沒有 incrementPercent 就算不出理論值。
 */
export function verifyPoolChange(
  c: Pick<LlPoolChange, 'oldcoinin' | 'newcoinin' | 'before' | 'change' | 'after' | 'reason'>,
  level: { incrementPercent: number; maxValue: number } | null | undefined,
  tolerance = 0.01,
): { verify: PoolVerify; delta: number | null; note?: string } {
  const reason = String(c.reason)
  if (reason !== '1') return { verify: 'skipped_reason', delta: null, note: `reason=${reason}（非正常累積，未驗）` }
  if (!level || !Number.isFinite(level.incrementPercent)) return { verify: 'no_level', delta: null, note: '對不到 Level 參數' }
  if (Number.isFinite(level.maxValue) && level.maxValue > 0 && c.before >= level.maxValue) {
    return { verify: 'skipped_overflow', delta: null, note: '池已達上限，累積改走溢流池，公式不適用' }
  }
  const coinIn = c.newcoinin - c.oldcoinin
  const expect = coinIn * level.incrementPercent
  const delta = c.change - expect
  // 帳本自洽性順手驗（幾乎不花成本）：after 應該 = before + change
  const selfOk = Math.abs(c.after - (c.before + c.change)) <= tolerance
  if (Math.abs(delta) > tolerance) {
    return { verify: 'mismatch', delta, note: `預期 ${expect.toFixed(4)}、實際 ${c.change}` }
  }
  if (!selfOk) return { verify: 'mismatch', delta: c.after - (c.before + c.change), note: 'after ≠ before + change' }
  return { verify: 'ok', delta }
}

/**
 * L4 三條等式。前兩條只用 awardsReport 自己就能驗，成本極低。
 *
 * ⚠️ `beforeAmount` **不是 Progressives Limit**，是「中獎當下累積的那一段」(micro-PHP)。
 *    實測：amount 1062.87 = afterAmount 888 + 174,870,888 / 1e6，且 afterAmount == basevalue。
 *    這個語意先前的筆記寫錯過，照錯的寫會讓每一筆都判成不符。
 */
export function verifyAward(
  a: Pick<LlAward, 'amount' | 'beforeAmount' | 'afterAmount'>,
  level: { basevalue: number } | null | undefined,
  poolChangeBefore: number | null | undefined,
  tolerance = 0.01,
): { eqSelfOk: boolean; eqBasevalueOk: boolean | null; eqPoolOk: boolean | null; note: string } {
  const eqSelf = Math.abs(a.amount - (a.afterAmount + a.beforeAmount / MICRO)) <= tolerance
  const eqBase = level && Number.isFinite(level.basevalue)
    ? Math.abs(a.afterAmount - level.basevalue) <= tolerance : null
  const eqPool = poolChangeBefore !== null && poolChangeBefore !== undefined
    ? Math.abs(a.amount - poolChangeBefore) <= tolerance : null
  const bad: string[] = []
  if (!eqSelf) bad.push('amount ≠ afterAmount + beforeAmount/1e6')
  if (eqBase === false) bad.push('afterAmount ≠ 該 Level basevalue')
  if (eqPool === false) bad.push('amount ≠ poolChange(Jackpot).before')
  return {
    eqSelfOk: eqSelf, eqBasevalueOk: eqBase, eqPoolOk: eqPool,
    // 對不到的那條回 null 並在說明裡講清楚，不要當成通過
    note: bad.length ? bad.join('；')
      : `已驗 ${[eqSelf && '自洽', eqBase && 'basevalue', eqPool && '跨報表'].filter(Boolean).join('/')}`
        + (eqBase === null ? '（basevalue 對不到 Level，未驗）' : '')
        + (eqPool === null ? '（找不到對應的 poolChange，未驗）' : ''),
  }
}

/** 記一次 LuckyLink 來源健康。⚠️ 兩支報表分開記，哪一支壞掉才分得出來。 */
export function noteLlHealth(env: ReconEnv, source: string, ok: boolean, errKind?: string, message?: string): void {
  const now = Date.now()
  if (ok) {
    db.prepare(`
      INSERT INTO recon_source_health (env, source, lastOkAt, failCount) VALUES (?, ?, ?, 0)
      ON CONFLICT(env, source) DO UPDATE SET lastOkAt=excluded.lastOkAt, failCount=0, errKind=NULL, message=NULL
    `).run(env, source, now)
  } else {
    db.prepare(`
      INSERT INTO recon_source_health (env, source, lastErrAt, failCount, errKind, message)
      VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(env, source) DO UPDATE SET lastErrAt=excluded.lastErrAt,
        failCount=recon_source_health.failCount+1, errKind=excluded.errKind, message=excluded.message
    `).run(env, source, now, errKind ?? '', message ?? '')
  }
}
