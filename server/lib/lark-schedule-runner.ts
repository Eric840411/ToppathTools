/**
 * server/lib/lark-schedule-runner.ts — Lark 排程提醒的執行面：推播、週期展開、回寫。
 *
 * tick 跑在 toppath-server（不是 worker）——回調端點本來就必須在 server，
 * 放同一個 process 可以省掉跨 process 寫同一張表的併發。
 *
 * ⚠️ 但同 process 不等於沒併發，三處會撞，全部靠 withRecordLock + 鎖內重讀處理：
 *   · tick 重入（上一輪沒跑完下一輪就進來）→ tickRunning 旗標
 *   · 「標記逾期」寫狀態 ↔ 完成回調寫狀態
 *   · 兩人同時點按鈕（先讀後寫中間的空窗）
 */
import {
  getSettings, listAllRecords, getRecord, updateRecord, createRecords,
  fDate, fText, fNum, fPeople, fmtTime,
  scheduleCard, resultCard, sendCard, withRecordLock,
  claimOccurrence, settleClaim, occurrenceKeyOf, resolveName,
  classifySchedule, needsAnnounce, idempotencyKey, occurrencesFor,
  type BitableRecord,
} from './lark-schedule.js'

const log = (...a: unknown[]) => console.log('[lark-schedule]', ...a)

// ─── 推播 ────────────────────────────────────────────────────────────────────

async function pushOne(rec: BitableRecord): Promise<boolean> {
  const s = getSettings()
  return withRecordLock(rec.record_id, async () => {
    // 鎖內重讀：拿鎖之前讀到的可能已經被回調改掉了
    const fresh = await getRecord(s.schedTable, rec.record_id)
    if (!fresh) return false
    if (classifySchedule(fresh, Date.now(), s.staleHours * 3_600_000) !== 'due') return false

    const name = fText(fresh, '行程名稱') || '(未命名)'
    const { messageId } = await sendCard(scheduleCard(fresh))
    // 先發送再寫回：寫回失敗最多下一輪重推一次（看得出來），
    // 反過來先寫回的話發送失敗就永遠不會再推，使用者完全不知道漏了。
    // ⚠️ 推播只碰推播欄位，不碰「狀態」——狀態是回調那條線的地盤。
    await updateRecord(s.schedTable, fresh.record_id, { 推播時間: Date.now(), 推播訊息ID: messageId })
    log(`✅ 已推播「${name}」@ ${fmtTime(fDate(fresh, '開始時間'))} (${messageId})`)
    return true
  })
}

async function markStaleOne(rec: BitableRecord): Promise<boolean> {
  const s = getSettings()
  return withRecordLock(rec.record_id, async () => {
    const fresh = await getRecord(s.schedTable, rec.record_id)
    if (!fresh) return false
    if (classifySchedule(fresh, Date.now(), s.staleHours * 3_600_000) !== 'stale') return false
    await updateRecord(s.schedTable, fresh.record_id, { 狀態: '已逾期' })
    log(`⏭️  已逾期未推播「${fText(fresh, '行程名稱')}」（開始時間超過 ${s.staleHours} 小時）`)
    return true
  })
}

// ─── 表格狀態變更 → 群裡回報 ────────────────────────────────────────────────

/**
 * 使用者是在表格裡直接改狀態（不是點互動按鈕）時，補一則群通知。
 * 互動按鈕那條線會自己把卡片就地換掉並填 `完成通知時間`，所以不會走到這裡。
 */
async function announceOne(rec: BitableRecord): Promise<boolean> {
  const s = getSettings()
  return withRecordLock(rec.record_id, async () => {
    const fresh = await getRecord(s.schedTable, rec.record_id)
    if (!fresh) return false
    const status = fText(fresh, '狀態')
    if (status !== '已完成' && status !== '已取消') return false
    if (fDate(fresh, '完成通知時間') != null) return false   // 已宣告過
    if (fDate(fresh, '推播時間') == null) return false       // 沒推播過的不用回報

    const name = fText(fresh, '行程名稱') || '(未命名)'
    const editor = fPeople(fresh, '修改人')[0]
    const who = editor?.name || fText(fresh, '完成者') || '(未知)'
    const now = Date.now()

    await sendCard(resultCard(name, status, who, now))
    await updateRecord(s.schedTable, fresh.record_id, {
      完成通知時間: now,
      ...(fText(fresh, '完成者') ? {} : { 完成者: who }),
      ...(fDate(fresh, '完成時間') == null ? { 完成時間: now } : {}),
    })
    log(`📣 已回報「${name}」→ ${status}（${who}）`)
    return true
  })
}

// ─── 互動按鈕的回寫（由回調端點呼叫） ───────────────────────────────────────

/**
 * ⚠️ 同 ClaimResult：不用可辨識聯合。`tsconfig.server.json` 是 `strict: false`，
 * 沒有 strictNullChecks 就不會用字面量 boolean 收窄，`if (!r.ok)` 之後存取
 * `r.toast` 會報 TS2339。改成單一形狀 + optional 欄位。
 */
export type ApplyResult = {
  ok: boolean
  /** ok:true 時有 */
  name?: string; status?: string; who?: string; at?: number
  /** ok:false 時有 */
  toast?: string; card?: Record<string, unknown>
}

/**
 * ⚠️ 卡片回調是同步的，沒有補推機制——這裡失敗就是失敗，
 *    一定要回可讀的 toast 叫使用者重按，不能靜默吞掉等平台重試。
 */
export async function applyCardAction(args: {
  recordId: string; action: 'done' | 'cancel'; openId: string; messageId?: string
}): Promise<ApplyResult> {
  const s = getSettings()
  const rec = await getRecord(s.schedTable, args.recordId)
  if (!rec) return { ok: false, toast: '找不到這筆行程，可能已被刪除' }

  const name = fText(rec, '行程名稱') || '(未命名)'
  const occ = occurrenceKeyOf(rec)
  const who = await resolveName(args.openId)

  // 原子認領：同一筆排程只有一個人搶得到，兩人同時點也只會寫一次
  const claim = claimOccurrence({
    tableId: s.schedTable, occurrenceKey: occ, recordId: args.recordId,
    action: args.action, actor: args.openId, actorName: who, messageId: args.messageId,
  })

  if (!claim.claimed) {
    const prev = claim.existing
    const prevStatus = prev?.action === 'cancel' ? '已取消' : '已完成'
    const prevWho = prev?.actorName ?? '(未知)'
    return {
      ok: false,
      toast: `已經由 ${prevWho} 回報過了`,
      card: resultCard(name, prevStatus, prevWho, prev?.updatedAt ?? Date.now()),
    }
  }

  const status = args.action === 'done' ? '已完成' : '已取消'
  const now = Date.now()
  try {
    await withRecordLock(args.recordId, async () => {
      const fresh = await getRecord(s.schedTable, args.recordId)
      if (!fresh) throw new Error('行程已不存在')
      // 完成者與完成時間只落一次
      await updateRecord(s.schedTable, args.recordId, {
        狀態: status,
        完成時間: fDate(fresh, '完成時間') ?? now,
        完成者: fText(fresh, '完成者') || who,
        完成通知時間: now,   // 卡片就地換掉了，不用 tick 再宣告一次
      })
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    settleClaim(s.schedTable, occ, 'failed', msg)
    log(`❌ 回寫失敗「${name}」— ${msg}`)
    return { ok: false, toast: '寫回表格失敗，請再按一次' }
  }

  settleClaim(s.schedTable, occ, 'success')
  log(`✅ ${who} 把「${name}」標記為 ${status}`)
  return { ok: true, name, status, who, at: now }
}

// ─── 週期規則展開 ────────────────────────────────────────────────────────────

/**
 * 冪等 key = 規則ID@原始排定時刻(UTC ISO)。三條保護，少一條就出事：
 *   · 用「原始排定時刻」而非實際開始時間 → 使用者在日曆上拖曳改期後 key 不變，
 *     下次展開不會把它當缺漏再補一筆（＝重複）
 *   · 帶完整時刻而非只有日期 → 同一天跑多場的規則不會互撞
 *   · 只要 key 已存在就跳過，不管現在是什麼狀態
 *     → 人工修改／取消／已完成的記錄永遠不會被重建覆蓋
 */
export async function expandRules(): Promise<number> {
  const s = getSettings()
  if (!s.ruleTable) return 0

  const [rules, sched] = await Promise.all([listAllRecords(s.ruleTable), listAllRecords(s.schedTable)])
  const existing = new Set(sched.map(r => fText(r, '冪等Key')).filter(Boolean))

  const now = Date.now()
  const until = now + s.expandDays * 86_400_000
  const toCreate: { fields: Record<string, unknown> }[] = []

  for (const rule of rules) {
    if (rule.fields['啟用'] !== true) continue
    const rname = fText(rule, '規則名稱') || '(未命名規則)'

    // 日期計算走 shared 的 occurrencesFor（有單元測試覆蓋），這裡不自己再算一次
    const { list, err } = occurrencesFor({
      ruleId: rule.record_id,
      type: fText(rule, '週期類型'),
      time: fText(rule, '開始時刻'),
      weekdays: rule.fields['週幾'] as string[] | undefined,
      dayOfMonth: fNum(rule, '每月幾號'),
    }, now, until, s.tz, s.expandDays)

    if (err) { log(`⚠️  規則「${rname}」跳過：${err}`); continue }

    const dur = (fNum(rule, '持續分鐘') ?? 60) * 60_000
    const lead = fNum(rule, '提前提醒分鐘') ?? 0
    const people = fPeople(rule, '負責人')
    const note = fText(rule, '備註')

    for (const ms of list) {
      const key = idempotencyKey(rule.record_id, ms)
      if (existing.has(key)) continue
      existing.add(key)

      const fields: Record<string, unknown> = {
        行程名稱: rname, 開始時間: ms, 結束時間: ms + dur,
        狀態: '待辦', 提前提醒分鐘: lead,
        來源規則ID: rule.record_id, 冪等Key: key,
      }
      if (people.length) fields['負責人'] = people.map(p => ({ id: p.id }))
      if (note) fields['備註'] = note
      toCreate.push({ fields })
    }
  }

  if (!toCreate.length) return 0
  for (let i = 0; i < toCreate.length; i += 400) {
    await createRecords(s.schedTable, toCreate.slice(i, i + 400))
  }
  log(`展開完成，新建 ${toCreate.length} 筆`)
  return toCreate.length
}

// ─── tick ────────────────────────────────────────────────────────────────────

export type TickSummary = { pushed: number; stale: number; announced: number; expanded: number; error?: string }

let tickRunning = false
let lastExpandDay = ''
let lastTick: (TickSummary & { at: number }) | null = null

export const getLastTick = () => lastTick

export async function runTick(): Promise<TickSummary> {
  const s = getSettings()
  if (!s.enabled) return { pushed: 0, stale: 0, announced: 0, expanded: 0 }
  if (!s.baseToken || !s.schedTable || !s.chatId) {
    return { pushed: 0, stale: 0, announced: 0, expanded: 0, error: '設定不完整（需要 baseToken / schedTable / chatId）' }
  }
  if (tickRunning) return { pushed: 0, stale: 0, announced: 0, expanded: 0, error: '上一輪還在跑，本輪跳過' }

  tickRunning = true
  const summary: TickSummary = { pushed: 0, stale: 0, announced: 0, expanded: 0 }
  try {
    // 每天展開一次未來 N 天（啟動後第一輪也會跑）
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: s.tz }).format(new Date())
    if (today !== lastExpandDay) {
      summary.expanded = await expandRules()
      lastExpandDay = today
    }

    const recs = await listAllRecords(s.schedTable)
    const now = Date.now()
    const staleMs = s.staleHours * 3_600_000

    for (const rec of recs) {
      const kind = classifySchedule(rec, now, staleMs)
      if (kind === 'due') {
        if (await pushOne(rec)) summary.pushed++
      } else if (kind === 'stale') {
        if (await markStaleOne(rec)) summary.stale++
      } else if (needsAnnounce(rec)) {
        // 先用列表裡的值粗篩，符合才進去拿鎖重讀——否則每輪會對每一筆都多打一次 API
        if (await announceOne(rec)) summary.announced++
      }
    }
  } catch (e) {
    summary.error = e instanceof Error ? e.message : String(e)
    log('❌ 本輪失敗:', summary.error)
  } finally {
    tickRunning = false
    lastTick = { ...summary, at: Date.now() }
  }
  return summary
}

let timer: NodeJS.Timeout | null = null

export function startScheduleTick(intervalMs = 60_000): void {
  if (timer) clearInterval(timer)
  timer = setInterval(() => { void runTick() }, intervalMs)
  log(`tick 已啟動，每 ${intervalMs / 1000} 秒一輪`)
}
