/**
 * 週報「依時間撈單」改撈 Meegle（移除 Jira 第 2 步，使用者 2026-10-02 選 A＝改撈 Meegle、專案用標題第一個中括號）。
 * 規則跟 CodeX 對過：
 *  - 用**登入者自己的 Meegle 綁定**查；目標人的 user_key 只當篩選條件（不借別人的 token）
 *  - 人員對應要唯一：綁定 → 人員對照（email 唯一）→ user search；找不到或多個都明示，不猜
 *  - 條件：回報者／受托人／QA 驗證人員 含此人，且「建立」或「更新」落在週期內；MQL 完整翻頁（queryAll）
 *  - 「更新時間」是最後一次更新：補查舊週會漏掉之後又更新的單，不能當完整歷史（畫面要講）
 *
 * Meegle 實測（2026-10-02）：
 *  - MQL 人員只認 `'名字<id:user_key>'`（名字不比對，只看 id）；只給名字遇到同名（兩個 Eric）回 3012
 *  - 日期條件只收 'YYYY-MM-DD'（帶時間回 2001）；回來的 updated_at 是 UTC 'YYYY-MM-DD HH:mm:ss'、start_time 只有 UTC 日期
 *  → 查詢放寬一天，再用台北時間精準過濾；只有建立日落在邊界、又沒有被「更新」條件收進來的單，才用 workitem get 讀精確建立時間
 */
import type Database from 'better-sqlite3'
import { call, defaultRunner, meegleTarget, queryAll, resolveUsersByEmail, MEEGLE_ROLES, type CallOutcome, type Runner } from './meegle-workitem.js'
import { spaceEnv } from './meegle-space.js'

const TZ = 8 * 3600_000
const DAY = 86400_000

/** 週期 [startDate, endDate]（台北日曆日，含頭含尾）→ 精準範圍（UTC 毫秒，結束不含）與放寬後的查詢日期 */
export function weekBounds(startDate: string, endDate: string) {
  const fromMs = Date.parse(`${startDate}T00:00:00Z`) - TZ
  const toMs = Date.parse(`${endDate}T00:00:00Z`) - TZ + DAY
  const d = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  // UTC 日期比台北日期最多早一天 → 查詢起點往前一天、終點往後一天（結束不含）
  return { fromMs, toMs, qStart: d(Date.parse(`${startDate}T00:00:00Z`) - DAY), qEnd: d(Date.parse(`${endDate}T00:00:00Z`) + 2 * DAY) }
}

/** Meegle MQL 回的 UTC 'YYYY-MM-DD HH:mm:ss' → 毫秒 */
export function parseMqlUtc(s: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(s.trim())
  return m ? Date.parse(`${m[1]}T${m[2]}Z`) : null
}

/**
 * 建立日（UTC 日期 D）能不能直接判斷落不落在週期內：
 * 台北日期是 D 或 D+1。D ∈ [start, end-1] → 一定在；D = start-1 或 D = end → 不一定（要讀精確時間）；其他 → 一定不在
 */
export function createdDayVerdict(utcDay: string, startDate: string, endDate: string): 'in' | 'out' | 'maybe' {
  const t = Date.parse(`${utcDay}T00:00:00Z`)
  const s = Date.parse(`${startDate}T00:00:00Z`), e = Date.parse(`${endDate}T00:00:00Z`)
  if (Number.isNaN(t)) return 'out'
  if (t >= s && t <= e - DAY) return 'in'
  if (t === s - DAY || t === e) return 'maybe'
  return 'out'
}

/** 專案：標題第一個中括號（「[OSM][OSM後台]…」→ OSM）。沒有就空字串（使用者 10/02 選 A） */
export function projectFromTitle(title: string): string {
  return /^\s*\[([^\]]+)\]/.exec(title)?.[1]?.trim() ?? ''
}

/**
 * 定時提醒的授權人每次執行都要重查：帳號還在、沒停權、還有「週報彙整」權限（CodeX review [P1]：
 * 原本只看 Meegle 綁定，停權後只要 token 還有效背景仍會撈單）。有問題回原因，呼叫端整段跳過、不呼叫 Meegle、不換人
 */
export function cronActorProblem(actor: { email: string; status?: string | null } | undefined, hasWeeklyReportPermission: boolean): string | null {
  if (!actor) return '授權人帳號不存在（可能已刪除）'
  if ((actor.status ?? 'active') !== 'active') return '授權人帳號已停權'
  if (!hasWeeklyReportPermission) return '授權人沒有「週報彙整」權限'
  return null
}

/** 週報 API 的請求關卡（登入 → 未停權 → 有週報權限，逐關短路；停權判斷跟排程授權人同一條：不是 active 就算停權） */
export function weeklyGateProblem(account: { email: string; role: string; status?: string | null } | null | undefined, hasPermission: () => boolean): { status: number; message: string } | null {
  if (!account) return { status: 401, message: '請先登入' }
  if ((account.status ?? 'active') !== 'active') return { status: 403, message: '帳號已停權' }
  if (!hasPermission()) return { status: 403, message: '沒有「週報彙整」權限' }
  return null
}

/**
 * 排程的授權人關卡（帳號 → 權限 → Meegle 綁定，依序；前面不過就不往下，**不會碰到 Meegle**）。
 * 拆成可注入的函式，測試才驗得到「失效時沒有呼叫 Meegle、沒有換人」（CodeX review [P1]）
 */
export function resolveCronActor(
  actor: string,
  deps: { findAccount: (email: string) => { email: string; status?: string | null; role?: string | null } | undefined; hasPermission: (email: string, role: string) => boolean; tokenOf: (email: string) => { token: string } | { reason: string } },
): { token: string } | { reason: string } {
  const acc = deps.findAccount(actor)
  // 嚴格逐關短路：帳號不在或停權就不查權限（CodeX）
  const active = !!acc && (acc.status ?? 'active') === 'active'
  const problem = cronActorProblem(acc, active && deps.hasPermission(acc!.email, acc!.role ?? 'qa'))
  if (problem) return { reason: `${problem}（${actor}）` }
  const t = deps.tokenOf(actor)
  return 'reason' in t ? { reason: `授權人 ${actor} ${t.reason}` } : t
}

export type MeeglePerson = { userKey: string; name: string }
export type PersonResolution = { ok: true; person: MeeglePerson; via: 'binding' | 'map' | 'search' } | { ok: false; reason: string }

/** 登入帳號 email → Meegle 使用者。唯一才算數 */
export async function resolveMeeglePerson(db: Database.Database, token: string, email: string, runner: Runner = defaultRunner): Promise<PersonResolution> {
  const e = email.trim().toLowerCase()
  const bound = db.prepare("SELECT meegle_user_key, meegle_name FROM meegle_accounts WHERE email = ? AND status = 'valid' AND meegle_user_key IS NOT NULL").get(e) as { meegle_user_key: string; meegle_name: string | null } | undefined
  if (bound?.meegle_user_key) return { ok: true, person: { userKey: bound.meegle_user_key, name: bound.meegle_name || e }, via: 'binding' }
  const mapped = db.prepare('SELECT DISTINCT meegle_user_key, meegle_name FROM meegle_person_map WHERE lower(meegle_email) = ?').all(e) as Array<{ meegle_user_key: string; meegle_name: string }>
  if (mapped.length > 1) return { ok: false, reason: `${e} 在人員對照裡對到 ${mapped.length} 個 Meegle 帳號` }
  if (mapped.length === 1) return { ok: true, person: { userKey: mapped[0].meegle_user_key, name: mapped[0].meegle_name || e }, via: 'map' }
  const s = await resolveUsersByEmail(token, [e], runner)
  if (s.kind !== 'ok') return { ok: false, reason: `查 Meegle 使用者失敗：${s.message}` }
  const m = s.value[e]
  if (!m || 'reason' in m) return { ok: false, reason: `Meegle 查不到 ${e}（請本人綁定 Meegle，或到開單分頁建人員對照）` }
  return { ok: true, person: { userKey: m.userKey, name: m.name || e }, via: 'search' }
}

export type WeekItem = { key: string; workItemId: string; summary: string; status: string; created: string; updated: string; role: 'reporter' | 'assignee' | 'verifier' | 'both'; projectName: string; /** 關聯需求名稱（v5.27.0；專案改看它） */ requirementName: string }

type Flat = Record<string, Record<string, unknown>>
const str = (f: Flat, k: string) => String((f[k] as { string_value?: unknown } | undefined)?.string_value ?? '')

/**
 * 撈這個人在週期內的任務項（建立或更新落在週期內）。查詢用呼叫者自己的 token。
 * **固定撈正式空間**（v5.27.0，使用者 2026-10-06）：原本用 process.env 的 MEEGLE_PROJECT_KEY，沒設就是**測試空間**——
 * 本機實測同一週測試空間 37 筆（多是「[工具測試請忽略]」）、正式 22 筆。單號兩個空間共用流水號，事後分不出來，只能在查詢時就指定
 */
export async function fetchMeegleWeek(token: string, person: MeeglePerson, startDate: string, endDate: string, runner: Runner = defaultRunner, env: NodeJS.ProcessEnv = spaceEnv('prod')): Promise<CallOutcome<WeekItem[]>> {
  const t = meegleTarget(env)
  const b = weekBounds(startDate, endDate)
  const who = `'${person.name.replace(/['\\<>]/g, '')}<id:${person.userKey}>'`
  const roleName = (k: string) => MEEGLE_ROLES.find(r => r.key === k)!.roleName
  const roles = ['reporter', 'assignee', 'qaVerifier'] as const
  const mql = `SELECT \`work_item_id\`, \`name\`, \`work_item_status\`, \`start_time\`, \`updated_at\`, \`${t.requirementFieldKey}\`, ${roles.map(r => `\`__${roleName(r)}\``).join(', ')} FROM \`${t.projectKey}\`.\`${t.taskTypeKey}\``
    + ` WHERE (${roles.map(r => `array_contains(\`__${roleName(r)}\`, ${who})`).join(' OR ')})`
    + ` AND ((\`start_time\` >= '${b.qStart}' AND \`start_time\` < '${b.qEnd}') OR (\`updated_at\` >= '${b.qStart}' AND \`updated_at\` < '${b.qEnd}'))`
  const rows = await queryAll(token, t.projectKey, mql, runner)
  if (rows.kind !== 'ok') return rows
  const out: WeekItem[] = []
  for (const f of rows.value) {
    const id = String((f.work_item_id as { long_value?: unknown } | undefined)?.long_value ?? '')
    if (!id) continue
    const updatedMs = parseMqlUtc(str(f, 'updated_at'))
    let createdIso = ''
    let inRange = updatedMs != null && updatedMs >= b.fromMs && updatedMs < b.toMs
    const verdict = createdDayVerdict(str(f, 'start_time'), startDate, endDate)
    if (!inRange && verdict === 'in') inRange = true
    if (!inRange && verdict === 'maybe') {
      // 邊界：讀精確建立時間（讀不到就整批失敗——默默少一張比失敗糟）
      const g = await call(runner, ['workitem', 'get', '--project-key', t.projectKey, '--work-item-id', id], token)
      if (g.kind !== 'ok') return { kind: g.kind, message: `讀不到 #${id} 的建立時間：${g.message}` }
      createdIso = String((g.value as { work_item_attribute?: { create_time?: unknown } })?.work_item_attribute?.create_time ?? '')
      const c = Date.parse(createdIso)
      // 讀成功卻沒有／看不懂建立時間：不能當成「不在週期內」默默排除（CodeX review [P2]）→ 整批停、講是哪張
      if (!createdIso || Number.isNaN(c)) return { kind: 'unknown', message: `#${id} 的建立時間讀不到或看不懂（「${createdIso || '空白'}」），為了不漏單整批停止` }
      inRange = c >= b.fromMs && c < b.toMs
    }
    if (!inRange) continue
    // 用 MQL 回的角色成員判斷這張單是因為哪個角色被撈出來
    const has = (r: typeof roles[number]) => Object.entries(f).some(([k, v]) => k.endsWith(roleIdSuffix(r)) && Array.isArray((v as { user_value_list?: unknown }).user_value_list)
      && ((v as { user_value_list: Array<{ user_key?: unknown }> }).user_value_list).some(u => String(u.user_key) === person.userKey))
    const isRep = has('reporter'), isAsg = has('assignee'), isQa = has('qaVerifier')
    const title = str(f, 'name')
    const statusList = (f.work_item_status as { key_label_value_list?: Array<{ label?: unknown }> } | undefined)?.key_label_value_list
    out.push({
      key: `#${id}`, workItemId: id, summary: title, status: String(statusList?.[0]?.label ?? ''),
      created: createdIso || str(f, 'start_time'), updated: updatedMs != null ? new Date(updatedMs).toISOString() : '',
      role: isRep && isQa ? 'both' : isQa ? 'verifier' : isRep ? 'reporter' : 'assignee',
      projectName: projectFromTitle(title),
      requirementName: String((f[t.requirementFieldKey] as { key_label_value?: { label?: unknown } } | undefined)?.key_label_value?.label ?? '').trim(),
    })
  }
  return { kind: 'ok', value: out.sort((a, b2) => b2.updated.localeCompare(a.updated)) }
}

/** MQL 角色欄回來的 key 是 `__role_<project>_<type>_<role_id>`（實測）；用 role_id 結尾判斷是哪個角色 */
const ROLE_IDS: Record<string, string> = { reporter: 'role_e18f13', assignee: 'role_b2bf14', qaVerifier: 'role_037ecd' }
function roleIdSuffix(r: string): string { return ROLE_IDS[r] }
