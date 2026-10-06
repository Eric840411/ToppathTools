/**
 * server/live-ledger-notify.ts — 把 `recon_finding` 送到 Lark（v5.13.0 前是 Discord）。
 *
 * 🚨 **這是整個對帳工具在 2026-09-17 體檢時唯一的真空。**
 *    `recon_finding.notifiedAt` 這個欄位當時只存在於 `shared.ts` 的建表語句裡——
 *    整個 `server/` 底下沒有任何一行程式寫它。不是「通知失敗」，是**從來沒接**。
 *    庫裡躺著 3,491 筆 findings（missing 2,936／l1_amount 263／ambiguous 171／
 *    unobserved 121），一則都沒有人被通知過。
 *
 *    對帳工具算出差異卻不叫人，等於要人天天自己去點開看——那跟沒有對帳一樣。
 *
 * ── 四道防護，每一道都是為了避免這個功能一上線就被關掉 ──────────────────
 *
 * ① **水位線（watermark）**：第一次啟用時記下當下時間，只通知之後才偵測到的 finding。
 *    沒有這道，開關一打開就會把 3,491 筆歷史告警一次灌進頻道。
 *
 * ② **靜置期（grace）**：finding 要活過 `notifyGraceSec` 才送。
 *    實測 missing 2,936 筆裡有 **2,807 筆後來自己解決了**（晚到的紀錄回綁）——
 *    不等就送，96% 是假警報，人很快就會把通知靜音，然後真的掉單也看不到了。
 *
 * ③ **合批**：一次一則訊息帶整批，不是一筆一則。
 *
 * ④ **送不出去要留下紀錄，不能靜默 return。**沒設定 Lark 通知、被關掉、送失敗，
 *    都寫進 `recon_source_health` 的 `notify` 那一列，健康燈看得見。
 *    ⚠️ `if (!configured) return` 這種寫法就是這份規格一直在防的免除條款：
 *       「沒有告警」與「告警送不出去」在畫面上長得一模一樣。
 */
import { db } from './shared.js'
import { type ReconEnv, noteSourceHealth, reconSetting } from './live-ledger.js'
import { deliverNotice, flushNotifyRetries, notifyConfigured, type DiscordEmbed } from './notify-outlet.js'

/** 一則訊息最多列幾筆明細（其餘只給總數）。單一欄位控制在 1024 字元內（卡片太長在 Lark 上很難讀）。 */
const MAX_EXAMPLES_PER_GROUP = 4
/** 一輪最多處理幾筆，避免累積太多時一次組出超長訊息。剩下的下一輪繼續。 */
const MAX_PER_BATCH = 60

interface PendingFinding {
  id: number; line: string; severity: string; refId: string
  /** spin（refId 是 recon_spin.id）或 round（refId 是後台局號） */
  refType: string
  amountDelta: number | null; detectedAt: number; note: string; userLabel: string
  machineType: string | null; spinSeq: number | null
  /** spin 型 finding 綁到的後台局號；還沒綁上（例如掉單）時是 null */
  spinOrderId: string | null
  /** 這一局實際發生的時間（後台下注時間優先，沒有才退回觀測時間） */
  eventAt: number | null
}

const LINE_LABEL: Record<string, string> = {
  missing: '掉單（等待入帳逾時）',
  l1_amount: 'L1 單局金額不符',
  l2_balance: 'L2 餘額不符',
  ambiguous: '無法判定（候選不唯一）',
  unobserved: '後台有局、前端未觀測',
  // ⚠️ 這一類原本沒有中文名稱，畫面上直接印出代號 begin_signal_suspect
  late_arrival: '晚到（後台紀錄遲到才回綁）',
  begin_signal_suspect: 'begin 訊號可能失效',
}

/**
 * 每一類是什麼意思、看到了要做什麼。
 *
 * 🚨 **沒有這一句，收到告警的人只會看到一個代號。**（2026-09-21 使用者回報「不夠直覺」）
 *    告警的用途是讓人能決定下一步，只給分類名稱等於把判讀成本丟回給讀的人。
 */
const LINE_HINT: Record<string, string> = {
  missing: '前端按了、後台到現在還查不到這一局',
  l1_amount: '同一局的下注／派彩，前端與後台對不起來',
  l2_balance: '餘額變化 ≠（派彩 − 下注）',
  ambiguous: '時間窗內有兩局以上可選，不硬配',
  unobserved: '後台有這一局，但前端沒觀測到（agent 漏看、機台自己跑，或同帳號有別人在玩）',
  late_arrival: '先前判成掉單，後台紀錄晚到之後又對上了',
  begin_signal_suspect: '判成「沒起注」的 spin，後台其實找得到那一局 → 檢查 pinus 攔截',
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, warn: 1, info: 2 }
/** 卡片顏色（轉成 Lark 卡片標題色）。critical 紅、warn 琥珀、其餘灰。 */
const SEVERITY_COLOR: Record<string, number> = { critical: 0xA32A35, warn: 0xB07A1E, info: 0x6F7D79 }

function settingOf(env: ReconEnv, key: string, dflt: number): number {
  try {
    const row = db.prepare('SELECT value FROM recon_settings WHERE env=? AND key=?').get(env, key) as { value: string } | undefined
    if (row === undefined) return dflt
    const n = Number(row.value)
    return Number.isFinite(n) ? n : dflt
  } catch { return dflt }
}

function putSetting(env: ReconEnv, key: string, value: number): void {
  db.prepare(`INSERT INTO recon_settings (env, key, value) VALUES (?, ?, ?)
    ON CONFLICT(env, key) DO UPDATE SET value=excluded.value`).run(env, key, String(value))
}

/**
 * 取得（必要時建立）這個 env 的通知水位線。
 *
 * ⚠️ 建立的時機是**第一次呼叫**，不是第一次成功送出——否則 webhook 沒設好的那幾天
 *    累積的 finding，會在設定好的那一刻整批倒出來。
 */
export function notifyWatermark(env: ReconEnv, now = Date.now()): number {
  const cur = settingOf(env, 'notifyWatermarkTs', 0)
  if (cur > 0) return cur
  putSetting(env, 'notifyWatermarkTs', now)
  console.log(`[live-ledger] ${env} 告警水位線建立於 ${new Date(now).toISOString()}——`
    + '在此之前偵測到的 finding 不會補送（避免歷史告警一次灌進頻道）')
  return now
}

/** 這一輪可以送的 finding。已解決的不送、太新的不送、水位線之前的不送。 */
export function pendingFindings(env: ReconEnv, now = Date.now()): PendingFinding[] {
  const graceMs = Math.max(settingOf(env, 'notifyGraceSec', 120), 0) * 1000
  const watermark = notifyWatermark(env, now)
  return db.prepare(`
    SELECT f.id, f.line, f.severity, f.refId, f.refType, f.amountDelta, f.detectedAt, f.note, f.userLabel,
           -- 🚨 只有 refType='spin' 才能拿 refId 當 recon_spin.id。
           --    unobserved 的 refId 是後台局號（例如 897-BIGFULINK-2065|6AB02E83089），
           --    原本無條件 CAST(f.refId AS INTEGER) 會把它變成 897，然後 join 到
           --    id=897 那一筆毫不相干的 spin——於是四筆不同的局全部顯示成
           --    同一個「第 N 局」，機台名稱也是那筆無關 spin 的。
           --    使用者看到的「為什麼有包含其他的機器」就是這樣來的（2026-09-21）。
           -- ⚠️ 這段註解裡不要用反引號：它在 JS 樣板字串裡，反引號會把字串提前結束。
           -- ⚠️ 兩邊的機台名稱要**統一**：spin 那側是 machineType（BIGFULINK），
           --    後台那側是 gmid（897-BIGFULINK-2065）。不統一的話同一台會被算成兩台，
           --    標題就會寫「2 台」——使用者問「為什麼有包含其他的機器」有一半是這個。
           --    先用 gmid 反查我們自己對這台的叫法，查不到才退回 gmid。
           COALESCE(s.machineType,
                    (SELECT x.machineType FROM recon_spin x
                      WHERE x.env = f.env AND x.gmid = b.gmid AND x.machineType <> '' LIMIT 1),
                    b.gmid) AS machineType,
           COALESCE(s.spinSeq, b.spinIndex) AS spinSeq,
           -- finding 自己記的局號優先；沒有才退回該 spin 綁到的局號
           NULLIF(COALESCE(NULLIF(f.orderId, ''), s.orderId, ''), '') AS spinOrderId,
           -- 事件本身的時間（後台下注時間優先）。⚠️ 不要拿 detectedAt 當事件時間——
           --    那是「我們什麼時候發現的」，跟這一局什麼時候打的可以差很多。
           COALESCE(b.betTimePrecise, b.dateTime, s.observedAt) AS eventAt
    FROM recon_finding f
    LEFT JOIN recon_spin s
      ON f.refType = 'spin' AND s.id = CAST(f.refId AS INTEGER) AND s.env = f.env
    LEFT JOIN recon_backend_record b
      ON f.refType = 'round' AND b.orderId = f.refId AND b.env = f.env
    WHERE f.env = ?
      AND f.notifiedAt IS NULL
      AND f.resolvedAt IS NULL
      AND f.detectedAt > ?
      AND f.detectedAt <= ?
    ORDER BY f.detectedAt ASC
    LIMIT ?
  `).all(env, watermark, now - graceMs, MAX_PER_BATCH) as PendingFinding[]
}

/** 幾筆被靜置期擋著、還在等的（只是還沒到時間，不是問題）。給健康列顯示用。 */
export function heldByGrace(env: ReconEnv, now = Date.now()): number {
  const graceMs = Math.max(settingOf(env, 'notifyGraceSec', 120), 0) * 1000
  const watermark = settingOf(env, 'notifyWatermarkTs', 0)
  const r = db.prepare(`
    SELECT COUNT(*) n FROM recon_finding
    WHERE env=? AND notifiedAt IS NULL AND resolvedAt IS NULL AND detectedAt > ? AND detectedAt > ?
  `).get(env, watermark, now - graceMs) as { n: number }
  return r?.n ?? 0
}

function ageText(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 90) return `${s} 秒`
  if (s < 5400) return `${Math.round(s / 60)} 分鐘`
  return `${(s / 3600).toFixed(1)} 小時`
}

/**
 * 絕對時間。⚠️ **時區釘死 Asia/Taipei**，跟 `shared.ts` 的日結同一個約定——
 *    這則訊息是伺服器產的，跟著機器的時區走的話，換一台部署就整批偏 8 小時，
 *    而畫面上完全看不出來。
 */
function clockText(ms: number): string {
  return new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).replace('T', ' ')
}

/**
 * 一筆 finding 怎麼寫成一行。
 *
 * 🚨 **給「完整局號 + 完整時間」，不給「第幾局」**（2026-09-21 使用者要求）。
 *    理由很實際：局號可以直接貼進後台查那一局，而「第 N 局」既不能查、
 *    兩邊的計數又不是同一個（前端數的是第幾次 spin，後台數的是 spin_index）。
 *    時間同理——「9 小時前」看不出是哪一局，絕對時間才對得上後台報表。
 */
function describe(f: PendingFinding, now: number): string {
  // ⚠️ 機台名稱取不到時**不要留空**——空著會讓人以為是同一台
  const who = f.machineType ? `\`${f.machineType}\`` : `spin #${f.refId}`
  const orderId = f.refType === 'round' ? f.refId : f.spinOrderId
  // 掉單的 finding 本來就還沒有局號——**要明講**，不要留一個空位讓人以為漏印了
  const oid = orderId ? ` · \`${orderId}\`` : ' · （尚無局號）'
  const when = f.eventAt ?? f.detectedAt
  const delta = f.amountDelta !== null && f.amountDelta !== undefined
    ? ` · ${f.line === 'unobserved' ? '下注' : '差額'} ${f.amountDelta > 0 && f.line !== 'unobserved' ? '+' : ''}${f.amountDelta}` : ''
  return `${who}${oid}${delta} · ${clockText(when)}（${ageText(now - f.detectedAt)}前）`
}

export interface NotifyBatch {
  embed: Record<string, unknown>
  ids: number[]
}

/**
 * 把一批 finding 組成一則通知（v5.13.0 起只發 Lark；@人 由 notify-outlet 用帳號 email 查 Lark open_id，
 * 查不到的只寫名字、不 @——那部分在送的時候處理，這裡不管）。
 */
export function buildBatch(env: ReconEnv, rows: PendingFinding[], now = Date.now()): NotifyBatch {
  const groups = new Map<string, PendingFinding[]>()
  for (const f of rows) {
    const key = `${f.severity}|${f.line}`
    const g = groups.get(key)
    if (g) g.push(f); else groups.set(key, [f])
  }
  const ordered = [...groups.entries()].sort((a, b) => {
    const [sa] = a[0].split('|'); const [sb] = b[0].split('|')
    const d = (SEVERITY_RANK[sa] ?? 9) - (SEVERITY_RANK[sb] ?? 9)
    return d !== 0 ? d : b[1].length - a[1].length
  })

  const worst = ordered.length ? ordered[0][0].split('|')[0] : 'info'
  const fields = ordered.map(([key, list]) => {
    const [severity, line] = key.split('|')
    const shown = list.slice(0, MAX_EXAMPLES_PER_GROUP).map(f => `• ${describe(f, now)}`)
    const more = list.length - shown.length
    if (more > 0) shown.push(`• …另外 ${more} 筆`)
    // 每一組先講「這是什麼意思」再列明細——只給分類代號的話，
    // 判讀成本整個丟回給讀的人（2026-09-21 使用者回報「不夠直覺」）
    const hint = LINE_HINT[line]
    const body = (hint ? `_${hint}_\n` : '') + shown.join('\n')
    return {
      name: `${severity === 'critical' ? '🔴' : severity === 'warn' ? '🟡' : '⚪'} `
        + `${LINE_LABEL[line] ?? line} · ${list.length} 筆`,
      value: body.slice(0, 1024),
      inline: false,
    }
  })

  const critical = rows.filter(r => r.severity === 'critical').length
  /**
   * 這一批涉及哪幾台。
   * 🚨 使用者問「為什麼有包含其他的機器」——一台以上時要**先讓人看到有幾台**，
   *    否則混在明細裡很容易以為全部都是自己正在測的那一台。
   */
  const machines = [...new Set(rows.map(r => r.machineType).filter((m): m is string => !!m))]

  return {
    embed: {
      title: `對帳告警 · ${env.toUpperCase()} · ${rows.length} 筆`
        + (machines.length ? ` · ${machines.length === 1 ? machines[0] : `${machines.length} 台`}` : ''),
      description: critical
        ? `其中 **${critical} 筆 critical**。已靜置 ${settingOf(env, 'notifyGraceSec', 120)} 秒仍未自行收斂。`
        : `已靜置 ${settingOf(env, 'notifyGraceSec', 120)} 秒仍未自行收斂。`,
      color: SEVERITY_COLOR[worst] ?? SEVERITY_COLOR.info,
      fields,
      footer: { text: 'Live Ledger 即時對帳' },
      timestamp: new Date(now).toISOString(),
    },
    ids: rows.map(r => r.id),
  }
}

export interface NotifyResult {
  sent: number
  skipped: 'disabled' | 'not_configured' | 'rate_limited' | 'nothing' | null
  failed?: string
}

/**
 * 跑一輪通知。由 `runLiveLedgerCycle()` 每輪呼叫。
 *
 * ⚠️ **只有真的送出去才寫 `notifiedAt`。**送失敗就讓它留著下一輪重試——
 *    先標記再送的話，webhook 掛掉那段時間的告警會被永久吃掉，而且沒有任何痕跡。
 */
export async function runNotifyCycle(
  env: ReconEnv, now = Date.now(),
): Promise<NotifyResult> {
  const source = 'notify'

  // 關掉是使用者的決定，但要留下紀錄——健康列上會顯示「已關閉」而不是綠燈。
  if (settingOf(env, 'notifyEnabled', 1) === 0) {
    noteSourceHealth(env, source, false, 'disabled', '告警已在設定中關閉——findings 仍在累積，只是不送出')
    return { sent: 0, skipped: 'disabled' }
  }

  if (!notifyConfigured()) {
    noteSourceHealth(env, source, false, 'not_configured',
      '尚未設定 Lark 通知（系統管理的「通知設定」頁），對帳告警無處可送')
    return { sent: 0, skipped: 'not_configured' }
  }

  // 之前送失敗排進補送佇列的，先補送
  await flushNotifyRetries().catch(e => console.warn('[live-ledger] 補送失敗', e))

  // 水位線要在這裡先建立：通知設好之前累積的 finding 不補送。
  notifyWatermark(env, now)

  const minIntervalMs = Math.max(settingOf(env, 'notifyIntervalSec', 180), 30) * 1000
  const lastSent = settingOf(env, 'notifyLastSentTs', 0)
  if (lastSent > 0 && now - lastSent < minIntervalMs) return { sent: 0, skipped: 'rate_limited' }

  const rows = pendingFindings(env, now)
  if (!rows.length) {
    // 沒東西可送是正常狀態，這時候才可以記成健康。
    noteSourceHealth(env, source, true)
    return { sent: 0, skipped: 'nothing' }
  }

  const batch = buildBatch(env, rows, now)
  try {
    const input = { feature: 'live-ledger' as const, embed: batch.embed as DiscordEmbed, mentionLabels: [...new Set(rows.map(r => r.userLabel).filter(Boolean))] }
    const r = await deliverNotice(input)
    // ⚠️ 一定要看 ok——送失敗時每一筆都被標成「已通知」的話，完全沒有徵兆。
    //    失敗＝這批不標記、下一輪整批重送（不排補送佇列，否則下一輪又會再送一次）
    if (!r.lark.ok) {
      const msg = `Lark：${r.lark.message ?? ''}`
      noteSourceHealth(env, source, false, 'send_failed', msg)
      return { sent: 0, skipped: null, failed: msg }
    }
  } catch (e) {
    const msg = `送出失敗：${String(e).slice(0, 200)}`
    noteSourceHealth(env, source, false, 'send_failed', msg)
    return { sent: 0, skipped: null, failed: msg }
  }

  const stamp = db.prepare('UPDATE recon_finding SET notifiedAt=? WHERE id=?')
  const markAll = db.transaction((ids: number[]) => { for (const id of ids) stamp.run(now, id) })
  markAll(batch.ids)
  putSetting(env, 'notifyLastSentTs', now)
  noteSourceHealth(env, source, true)
  console.log(`[live-ledger] ${env} 告警已送出 ${batch.ids.length} 筆`)
  return { sent: batch.ids.length, skipped: null }
}

/**
 * 試發一則。**不受啟用開關與節流限制**，也**不會**寫 `notifiedAt`——
 * 它的用途是確認 Lark 通知通不通，不是真的處理告警。
 *
 * 沒有待送的 finding 時送一則明講是測試的假訊息，這樣「設定對不對」永遠測得出來，
 * 不必等真的出事。
 */
export async function sendNotifyTest(env: ReconEnv, now = Date.now()): Promise<{ ok: boolean; message: string }> {
  if (!notifyConfigured()) return { ok: false, message: '尚未設定 Lark 通知（系統管理的「通知設定」頁）' }

  // ⚠️ join 條件跟 `pendingFindings()` 必須一致——測試發送長得跟真的不一樣的話，
  //    測試通過只證明「通知通」，證明不了真正的告警長什麼樣（這裡就曾經兩邊不同）。
  const rows = db.prepare(`
    SELECT f.id, f.line, f.severity, f.refId, f.refType, f.amountDelta, f.detectedAt, f.note, f.userLabel,
           -- ⚠️ 兩邊的機台名稱要**統一**：spin 那側是 machineType（BIGFULINK），
           --    後台那側是 gmid（897-BIGFULINK-2065）。不統一的話同一台會被算成兩台，
           --    標題就會寫「2 台」——使用者問「為什麼有包含其他的機器」有一半是這個。
           --    先用 gmid 反查我們自己對這台的叫法，查不到才退回 gmid。
           COALESCE(s.machineType,
                    (SELECT x.machineType FROM recon_spin x
                      WHERE x.env = f.env AND x.gmid = b.gmid AND x.machineType <> '' LIMIT 1),
                    b.gmid) AS machineType,
           COALESCE(s.spinSeq, b.spinIndex) AS spinSeq,
           -- finding 自己記的局號優先；沒有才退回該 spin 綁到的局號
           NULLIF(COALESCE(NULLIF(f.orderId, ''), s.orderId, ''), '') AS spinOrderId,
           -- 事件本身的時間（後台下注時間優先）。⚠️ 不要拿 detectedAt 當事件時間——
           --    那是「我們什麼時候發現的」，跟這一局什麼時候打的可以差很多。
           COALESCE(b.betTimePrecise, b.dateTime, s.observedAt) AS eventAt
    FROM recon_finding f
    LEFT JOIN recon_spin s
      ON f.refType = 'spin' AND s.id = CAST(f.refId AS INTEGER) AND s.env = f.env
    LEFT JOIN recon_backend_record b
      ON f.refType = 'round' AND b.orderId = f.refId AND b.env = f.env
    WHERE f.env=? AND f.resolvedAt IS NULL ORDER BY f.detectedAt DESC LIMIT 3
  `).all(env) as PendingFinding[]

  const batch = rows.length
    ? buildBatch(env, rows, now)
    : {
      ids: [],
      embed: {
        title: `對帳告警 · ${env.toUpperCase()} · 測試`,
        description: '目前沒有未解決的告警，這是一則測試訊息——收得到就代表通知設定正確。',
        color: SEVERITY_COLOR.info,
        footer: { text: 'Live Ledger 即時對帳 · 測試發送' },
        timestamp: new Date(now).toISOString(),
      },
    }

  const embed = { ...(batch.embed as Record<string, unknown>) }
  embed.title = `${String(embed.title)}（測試發送，未標記為已通知）`
  try {
    // 測試不 @ 人（跟原本一樣）
    const r = await deliverNotice({ feature: 'live-ledger', embed: embed as DiscordEmbed })
    if (!r.lark.ok) return { ok: false, message: `Lark：${r.lark.message ?? ''}` }
    return { ok: true, message: rows.length ? `已送出（取最近 ${rows.length} 筆未解決告警當樣本）` : '已送出測試訊息' }
  } catch (e) {
    return { ok: false, message: `送出失敗：${String(e).slice(0, 200)}` }
  }
}

/** 給健康列與設定頁用的現況。 */
export function notifyStatus(env: ReconEnv, now = Date.now()): {
  enabled: boolean; configured: boolean; queued: number; held: number
  lastSentAt: number | null; watermarkTs: number | null; neverNotified: number
} {
  const queued = (db.prepare(`
    SELECT COUNT(*) n FROM recon_finding
    WHERE env=? AND notifiedAt IS NULL AND resolvedAt IS NULL AND detectedAt > ?
  `).get(env, settingOf(env, 'notifyWatermarkTs', 0)) as { n: number })?.n ?? 0
  const never = (db.prepare(`
    SELECT COUNT(*) n FROM recon_finding WHERE env=? AND notifiedAt IS NULL
  `).get(env) as { n: number })?.n ?? 0
  const last = settingOf(env, 'notifyLastSentTs', 0)
  const wm = settingOf(env, 'notifyWatermarkTs', 0)
  return {
    enabled: settingOf(env, 'notifyEnabled', 1) === 1,
    // 看 Lark 憑證與群組（v5.13.0 起只有 Lark）
    configured: notifyConfigured(),
    queued,
    held: heldByGrace(env, now),
    lastSentAt: last > 0 ? last : null,
    watermarkTs: wm > 0 ? wm : null,
    // ⚠️ 水位線之前那些「永遠不會被通知」的歷史 finding 要讓人看得到數字，
    //    不然「已通知 0 筆」會被誤讀成「系統沒在動」。
    neverNotified: never,
  }
}

/** `reconSetting` 只認得白名單裡的 key，這裡列出通知相關的預設值供設定頁顯示。 */
export const NOTIFY_SETTING_DEFAULTS = {
  notifyEnabled: 1,
  notifyGraceSec: 120,
  notifyIntervalSec: 180,
} as const

// 讓 lint 看得到 reconSetting 仍被引用（門檻語意跟 recon_settings 同一套）。
void reconSetting
