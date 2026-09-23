/**
 * server/lib/lark-schedule.ts — Lark 排程提醒（時辰法旨）核心邏輯。
 *
 * 多維表格當行程表（日曆視圖排程）→ 到點推卡片到 Lark 群 →
 * 使用者點卡片上的「✅ 完成」→ 回調寫回狀態／完成者／完成時間。
 *
 * ⚠️ 這裡用的 Lark app 是**公司共用**的（同一隻也在發線上故障通知）。因此：
 *   · 推播一律點名發送（帶 chat_id），且必須先過 `chatAllowlist`。
 *     自定義機器人 webhook 看不出指向哪個群，事前無法驗證——2026-09-23 已因此誤發過。
 *   · **不碰 app 的「事件配置」**。長連線是叢集模式隨機單播，同一隻 app 多個客戶端時
 *     每則訊息只隨機送給其中一個，佔用等於默默搶走別人的事件，兩邊都不報錯。
 *     互動按鈕改走「回調配置」的 webhook，跟事件那條完全分開。
 *
 * ⚠️ 卡片回調是**同步**操作，沒有事件那套補推機制——寫回失敗就是失敗了，
 *    不會有第二次機會，必須當場回 toast 叫使用者重按，不能指望平台重試。
 */
import { db, getLarkToken } from '../shared.js'
import { fText, fDate, fPeople, occurrenceKeyOf, type BitableRecord } from '../../shared/lark-schedule-rules.js'

const LARK_BASE = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'

// ─── 設定（存在共用的 settings 表，前端配置頁可改） ──────────────────────────

export type LarkScheduleSettings = {
  enabled: boolean
  chatId: string
  /** 白名單硬鎖：不在名單上的 chat_id 一律拒發。共用 app 的第一道防線。 */
  chatAllowlist: string[]
  baseToken: string
  schedTable: string
  ruleTable: string
  schedView: string
  baseHost: string
  tz: string
  /** 展開未來幾天的週期行程 */
  expandDays: number
  /**
   * 開始時間已經過去這麼久就不推了，只標記逾期。
   * 防的是服務停機幾天後重啟，把一整批過期行程一次全噴進群裡洗版。
   */
  staleHours: number
  /** 卡片上要不要放互動按鈕（回調還沒設好時關掉，只留「開啟記錄」連結） */
  interactiveButton: boolean
}

const DEFAULTS: LarkScheduleSettings = {
  enabled: false,
  chatId: '',
  chatAllowlist: [],
  baseToken: '',
  schedTable: '',
  ruleTable: '',
  schedView: '',
  baseHost: 'https://casinoplus.sg.larksuite.com',
  tz: 'Asia/Taipei',
  expandDays: 14,
  staleHours: 6,
  interactiveButton: false,
}

const SETTINGS_KEY = 'lark_schedule_settings'

export function getSettings(): LarkScheduleSettings {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY) as { value: string } | undefined
  if (!row?.value) return { ...DEFAULTS }
  try {
    return { ...DEFAULTS, ...(JSON.parse(row.value) as Partial<LarkScheduleSettings>) }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveSettings(patch: Partial<LarkScheduleSettings>): LarkScheduleSettings {
  const next = { ...getSettings(), ...patch }
  // chatId 一定要在白名單裡，否則存進去也發不出去，不如存檔時就補上
  if (next.chatId && !next.chatAllowlist.includes(next.chatId)) {
    next.chatAllowlist = [...next.chatAllowlist, next.chatId]
  }
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(SETTINGS_KEY, JSON.stringify(next))
  return next
}

export const isAllowedChat = (chatId: string): boolean => getSettings().chatAllowlist.includes(chatId)

// ─── Lark API ────────────────────────────────────────────────────────────────

async function larkApi<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await getLarkToken()
  const res = await fetch(`${LARK_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json() as { code: number; msg: string; data: T }
  if (json.code !== 0) throw new Error(`${method} ${path} → ${json.code} ${json.msg}`)
  return json.data
}

export type { BitableRecord } from '../../shared/lark-schedule-rules.js'

export async function listAllRecords(table: string): Promise<BitableRecord[]> {
  const { baseToken } = getSettings()
  const out: BitableRecord[] = []
  let pageToken = ''
  do {
    const qs = new URLSearchParams({ page_size: '500' })
    if (pageToken) qs.set('page_token', pageToken)
    const d = await larkApi<{ items?: BitableRecord[]; has_more?: boolean; page_token?: string }>(
      'GET', `/open-apis/bitable/v1/apps/${baseToken}/tables/${table}/records?${qs}`)
    out.push(...(d.items ?? []))
    pageToken = d.has_more ? (d.page_token ?? '') : ''
  } while (pageToken)
  return out
}

export const getRecord = async (table: string, recordId: string): Promise<BitableRecord | null> => {
  const { baseToken } = getSettings()
  try {
    const d = await larkApi<{ record: BitableRecord }>(
      'GET', `/open-apis/bitable/v1/apps/${baseToken}/tables/${table}/records/${recordId}`)
    return d.record ?? null
  } catch {
    return null
  }
}

export const updateRecord = (table: string, recordId: string, fields: Record<string, unknown>) => {
  const { baseToken } = getSettings()
  return larkApi('PUT', `/open-apis/bitable/v1/apps/${baseToken}/tables/${table}/records/${recordId}`, { fields })
}

export const createRecords = (table: string, records: { fields: Record<string, unknown> }[]) => {
  const { baseToken } = getSettings()
  return larkApi<{ records: BitableRecord[] }>(
    'POST', `/open-apis/bitable/v1/apps/${baseToken}/tables/${table}/records/batch_create`, { records })
}

// ─── 純規則（欄位轉型／時區／判斷）一律走 shared，不在這裡複製一份 ──────────
// 為什麼分開：這支一載入就開 SQLite，純邏輯留在這裡就沒辦法單獨測。
export {
  fNum, fDate, fText, fPeople, partsInTz, tzDateToMs, parseHHMM,
  classifySchedule, needsAnnounce, occurrencesFor, idempotencyKey, occurrenceKeyOf,
  WEEKDAYS, TERMINAL_STATUS,
  type LarkPerson, type RuleSpec,
} from '../../shared/lark-schedule-rules.js'

export function fmtTime(ms: number | null, tz = getSettings().tz): string {
  if (ms == null) return '—'
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: tz, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ms))
}

// ─── 認領（冪等的真正邊界） ──────────────────────────────────────────────────

/**
 * ⚠️ 單純用 message_id + record_id 當冪等 key 不夠：
 *   · 分不出動作（完成 vs 取消）
 *   · 擋不住「不同卡片操作同一筆行程」（重推過就會有兩張卡片同時存在）
 * 所以改成用資料庫唯一鍵**原子認領**「表＋本次排程」，一次只有一個人搶得到。
 * 完成者與完成時間只由搶到的那次寫入，失敗留下紀錄可續做。
 */
export function ensureClaimTable(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lark_schedule_claims (
      table_id       TEXT NOT NULL,
      occurrence_key TEXT NOT NULL,
      record_id      TEXT NOT NULL,
      action         TEXT NOT NULL,
      status         TEXT NOT NULL,
      actor          TEXT,
      actor_name     TEXT,
      message_id     TEXT,
      error          TEXT,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      PRIMARY KEY (table_id, occurrence_key)
    )
  `)
}

export type ClaimExisting = { status: string; action: string; actorName: string | null; updatedAt: number }

/**
 * ⚠️ 刻意**不**寫成可辨識聯合（`{claimed:true} | {claimed:false, existing:...}`）。
 * server 端走的是 `tsconfig.server.json`，那份 `strict: false` → 沒有 strictNullChecks
 * → 字面量 boolean 不會被當成判別式，`if (!r.claimed)` 收窄不了，存取 `existing` 會報
 * TS2339。用「一個形狀 + optional 欄位」在兩種設定下都成立。
 */
export type ClaimResult = { claimed: boolean; existing?: ClaimExisting }

/**
 * 原子認領。搶到回 claimed:true；已經有人搶走（且不是失敗狀態）回 taken。
 * 前一次是 failed 的話允許重新認領——失敗可續做。
 */
export function claimOccurrence(args: {
  tableId: string; occurrenceKey: string; recordId: string
  action: string; actor: string; actorName: string; messageId?: string
}): ClaimResult {
  ensureClaimTable()
  const now = Date.now()
  const tx = db.transaction((): ClaimResult => {
    const existing = db.prepare(
      'SELECT status, action, actor_name, updated_at FROM lark_schedule_claims WHERE table_id = ? AND occurrence_key = ?',
    ).get(args.tableId, args.occurrenceKey) as
      { status: string; action: string; actor_name: string | null; updated_at: number } | undefined

    if (existing && existing.status !== 'failed') {
      return {
        claimed: false,
        existing: {
          status: existing.status, action: existing.action,
          actorName: existing.actor_name, updatedAt: existing.updated_at,
        },
      }
    }

    db.prepare(`
      INSERT OR REPLACE INTO lark_schedule_claims
        (table_id, occurrence_key, record_id, action, status, actor, actor_name, message_id, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, NULL, ?, ?)
    `).run(
      args.tableId, args.occurrenceKey, args.recordId, args.action,
      args.actor, args.actorName, args.messageId ?? null, now, now,
    )
    return { claimed: true }
  })
  return tx()
}

export function settleClaim(tableId: string, occurrenceKey: string, status: 'success' | 'failed', error?: string): void {
  db.prepare(
    'UPDATE lark_schedule_claims SET status = ?, error = ?, updated_at = ? WHERE table_id = ? AND occurrence_key = ?',
  ).run(status, error ?? null, Date.now(), tableId, occurrenceKey)
}


// ─── 逐筆鎖 ──────────────────────────────────────────────────────────────────

/**
 * ⚠️ tick 跑在 server 同一個 process 不代表沒有併發：
 *   · 上一輪 tick 還沒跑完，下一輪就進來了
 *   · 「標記逾期」也會寫「狀態」，會跟完成回調對撞
 *   · 兩個人同時點按鈕，「先讀後寫」中間有空窗
 * 所以每一筆行程都要拿鎖，而且**鎖內要重讀再判斷**，不能拿鎖外讀到的舊值去寫。
 */
const recordLocks = new Map<string, Promise<unknown>>()

export function withRecordLock<T>(recordId: string, fn: () => Promise<T>): Promise<T> {
  const prev = recordLocks.get(recordId) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  recordLocks.set(recordId, next.catch(() => undefined))
  return next.finally(() => {
    if (recordLocks.get(recordId) === next) recordLocks.delete(recordId)
  }) as Promise<T>
}

// ─── 卡片 ────────────────────────────────────────────────────────────────────

export function recordUrl(recordId: string): string {
  const s = getSettings()
  return `${s.baseHost}/base/${s.baseToken}?table=${s.schedTable}&view=${s.schedView}&record=${recordId}`
}

export function scheduleCard(rec: BitableRecord): Record<string, unknown> {
  const s = getSettings()
  const name = fText(rec, '行程名稱') || '(未命名行程)'
  const start = fDate(rec, '開始時間')
  const end = fDate(rec, '結束時間')
  const note = fText(rec, '備註')
  const people = fPeople(rec, '負責人')

  const when = end ? `${fmtTime(start, s.tz)} – ${fmtTime(end, s.tz)}` : fmtTime(start, s.tz)
  const who = people.length
    ? people.map(p => (p.id ? `<at id=${p.id}></at>` : p.name ?? '')).join(' ')
    : '_未指定_'

  const elements: Record<string, unknown>[] = [
    {
      tag: 'div',
      fields: [
        { is_short: true, text: { tag: 'lark_md', content: `**🕐 時間**\n${when}` } },
        { is_short: true, text: { tag: 'lark_md', content: `**👤 負責人**\n${who}` } },
      ],
    },
  ]
  if (note) elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**📝 備註**\n${note}` } })
  elements.push({ tag: 'hr' })

  const actions: Record<string, unknown>[] = []
  if (s.interactiveButton) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '✅ 完成' },
      type: 'primary',
      value: { action: 'done', record: rec.record_id, occ: occurrenceKeyOf(rec) },
    })
  }
  actions.push({
    tag: 'button',
    text: { tag: 'plain_text', content: s.interactiveButton ? '📋 開啟記錄' : '✅ 點我回報完成' },
    type: s.interactiveButton ? 'default' : 'primary',
    url: recordUrl(rec.record_id),
  })
  elements.push({ tag: 'action', actions })

  if (!s.interactiveButton) {
    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: '點按鈕會開啟這筆行程，把「狀態」改成「已完成」即可。' }],
    })
  }
  // 卡片回調萬一拿不到 value 時的備援定位錨點
  elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `ref:${rec.record_id}` }] })

  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: `📅 行程提醒｜${name}` }, template: 'blue' },
    elements,
  }
}

export function resultCard(name: string, status: string, who: string, whenMs: number): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `${status === '已完成' ? '✅ 已完成' : '🚫 已取消'}｜${name}` },
      template: status === '已完成' ? 'green' : 'grey',
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `由 **${who}** 於 ${fmtTime(whenMs)} 回報` } },
    ],
  }
}

/** 點名發送。白名單是硬鎖，設定被改錯也發不出去。 */
export async function sendCard(card: Record<string, unknown>, chatId?: string): Promise<{ messageId: string }> {
  const s = getSettings()
  const target = chatId ?? s.chatId
  if (!target) throw new Error('尚未設定 chat_id')
  if (!s.chatAllowlist.includes(target)) throw new Error(`chat_id 不在白名單內，拒絕發送: ${target}`)
  const d = await larkApi<{ message_id: string }>('POST', '/open-apis/im/v1/messages?receive_id_type=chat_id', {
    receive_id: target,
    msg_type: 'interactive',
    content: JSON.stringify(card),
  })
  return { messageId: d.message_id }
}

// ─── 使用者名稱 ──────────────────────────────────────────────────────────────

const nameCache = new Map<string, string>()

export async function resolveName(openId: string | undefined): Promise<string> {
  if (!openId) return '(未知)'
  const hit = nameCache.get(openId)
  if (hit) return hit
  let name = openId
  try {
    const d = await larkApi<{ user?: { name?: string } }>('GET', `/open-apis/contact/v3/users/${openId}?user_id_type=open_id`)
    name = d.user?.name ?? openId
  } catch {
    // 缺 contact 權限很正常，退回 open_id，不讓整個回寫因此失敗
  }
  nameCache.set(openId, name)
  return name
}
