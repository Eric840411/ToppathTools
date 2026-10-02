/**
 * Meegle 批量更新狀態：送出**一列**（一張單）。步驟與日期規則跟 CodeX 對過（2026-10-02）：
 *
 *   認領 → 讀原日期（要保留／指定時）→ ① 轉狀態 → ② 日期 → ③ Sheet 回填
 *
 * 日期為什麼要這麼繞（#15190441 實測）：轉到 C服／完成 後 **1～5 秒**，Meegle 自動化才把日期欄改成今天，
 * 會蓋掉手填值；轉完立刻寫回會被它再蓋一次，等它跑完再寫才留得住。所以：
 *  - 轉之前先讀原值，存進 date 步驟（之後重試一律用這個，不重讀——那時已經被蓋掉了）
 *  - 轉完要**看到自動化真的改了**（值跟原值不同）才寫；20 秒內看不到 → 「日期待確認」，**不覆寫**
 *    （原值本來就是今天時根本看不出有沒有跑，不能把逾時當成跑完——CodeX）
 *  - 寫完延遲再讀回，台北日期一致才算成功
 *  - 想要的值就是今天：自動化寫的就是對的，等讀到今天即可，不用寫
 * 遠端呼叫全部從 deps 傳進來，測試用假的。
 */
import type Database from 'better-sqlite3'
import { MEEGLE_ID_COLUMN, parseMeegleIdCell } from '../shared/meegle-comment-rules.js'
import { AUTO_DATE_FIELDS, desiredDate, STATUS_STAGE_DONE, taipeiDay, type DateMode } from '../shared/meegle-status-rules.js'
import {
  beginStatusStep, claimStatusRow, dateDataOf, finishStatusStep, getStatusRow, getStatusSteps,
  type DateData, type StatusClaimInput, type StatusClaimResult, type StatusStepRow,
} from './meegle-status-store.js'
import type { CallOutcome } from './meegle-workitem.js'
import type { SheetCell } from './meegle-sheet-writeback.js'

type DB = Database.Database

export type StatusDeps = {
  db: DB
  readDate: (workItemId: string, field: string) => Promise<CallOutcome<number | null>>
  readState: (workItemId: string) => Promise<CallOutcome<{ key: string; name: string }>>
  transition: (workItemId: string, targetKey: string) => Promise<CallOutcome<{ from: string; changed: boolean }>>
  writeDate: (workItemId: string, field: string, ms: number) => Promise<CallOutcome<true>>
  readRowCells: (sheetKey: string, rowIndex: number, names: string[]) => Promise<Record<string, string> | null>
  writeRow: (sheetKey: string, rowIndex: number, columns: Record<string, SheetCell>) => Promise<{ ok: boolean; error?: string }>
  fmtTime: (ms: number) => string
  sleep: (ms: number) => Promise<void>
  now?: () => number
}

/** 等自動化的上限、輪詢間隔、寫完到讀回的延遲；轉完超過 SETTLED_MS 視為自動化早就跑完（重試時） */
export const AUTOMATION_WAIT_MS = 20_000
export const POLL_MS = 1_000
export const VERIFY_DELAY_MS = 3_000
export const SETTLED_MS = 30_000

export type StatusPayload = StatusClaimInput
export type StatusRunResult = { claim: StatusClaimResult; steps: StatusStepRow[] }

const msgOf = (r: { kind: string; message?: string }) => ('message' in r && r.message) || '未知錯誤'
const fmtDay = (ms: number | null) => (ms == null ? '（空白）' : taipeiDay(ms))

export async function runStatusRow(deps: StatusDeps, p: StatusPayload): Promise<StatusRunResult> {
  const { db } = deps
  const now = () => deps.now?.() ?? Date.now()
  const B = p.batchId, R = p.workItemId
  const claim = claimStatusRow(db, p, now())
  if (claim.kind !== 'claimed') return { claim, steps: getStatusSteps(db, B, R) }
  await continueStatusRow(deps, B, R)
  return { claim, steps: getStatusSteps(db, B, R) }
}

/** 從目前紀錄接著做（送出與「重試／只補日期」共用）：done 的不重做。 */
export async function continueStatusRow(deps: StatusDeps, B: string, R: string): Promise<StatusStepRow[]> {
  const { db } = deps
  const now = () => deps.now?.() ?? Date.now()
  const row = getStatusRow(db, B, R)
  if (!row) return []
  const step = (s: string) => getStatusSteps(db, B, R).find(x => x.step === s)
  const auto = AUTO_DATE_FIELDS[row.target_key]
  const needsDate = !!auto && row.date_mode !== 'auto'

  // ① 轉狀態（前面先讀原日期：讀不到就不轉，否則保留原值會變成保留不了）
  if (step('state')?.phase !== 'done') {
    if (!beginStatusStep(db, B, R, 'state', now())) return getStatusSteps(db, B, R)
    // 每次轉之前都讀一次：baseline＝這次轉換前的值，用來判斷自動化有沒有跑（重試時中間可能被人改過，
    // 拿第一次的原值比會誤判「已經變了」而太早寫，結果又被自動化蓋掉——測試抓到的）。
    // 要寫回的原值（original）只在第一次存，之後一律沿用。
    let baseline: number | null = null
    if (needsDate) {
      const orig = await deps.readDate(R, auto.field)
      if (orig.kind !== 'ok') {
        finishStatusStep(db, B, R, 'state', 'failed', `讀不到原本的${auto.label}，為了不蓋掉它，沒有轉狀態：${msgOf(orig)}`, undefined, now())
        return getStatusSteps(db, B, R)
      }
      baseline = orig.value
      const data: DateData = { field: auto.field, label: auto.label, original: orig.value, desired: desiredDate(row.date_mode as DateMode, orig.value, row.sheet_date) }
      db.prepare(`UPDATE meegle_status_steps SET data = ? WHERE batch_id = ? AND row_key = ? AND step = 'date' AND data IS NULL`).run(JSON.stringify(data), B, R)
    }
    const t = await deps.transition(R, row.target_key)
    if (t.kind === 'ok') {
      finishStatusStep(db, B, R, 'state', 'done', null, { from: t.value.from, changed: t.value.changed, at: now(), baseline }, now())
    } else if (t.kind === 'rejected') {
      finishStatusStep(db, B, R, 'state', 'failed', `Meegle 拒絕：${t.message}`, undefined, now())
    } else {
      // 結果不明：重讀狀態就知道（轉狀態是冪等的，不會重複）
      const s = await deps.readState(R)
      if (s.kind === 'ok' && s.value.key === row.target_key) {
        finishStatusStep(db, B, R, 'state', 'done', '回應不明，重讀確認已是目標狀態', { from: '', changed: true, at: now(), baseline }, now())
      } else {
        finishStatusStep(db, B, R, 'state', 'failed', `轉換結果不明、重讀也${s.kind === 'ok' ? `還是「${s.value.name}」` : '讀不到'}：${t.message}，可重試`, undefined, now())
      }
    }
  }
  if (step('state')?.phase !== 'done') return getStatusSteps(db, B, R)

  // ② 日期
  const ds = step('date')
  if (ds && ds.phase !== 'done' && ds.phase !== 'skipped') {
    const dd = dateDataOf(ds)
    if (!needsDate || !dd || dd.desired == null) {
      if (beginStatusStep(db, B, R, 'date', now())) {
        const why = !auto ? '這個狀態沒有日期自動化' : row.date_mode === 'auto' ? '選了用自動帶入' : '原本沒有日期，用自動帶入'
        finishStatusStep(db, B, R, 'date', 'skipped', why, undefined, now())
      }
    } else if (beginStatusStep(db, B, R, 'date', now())) {
      await settleDate(deps, B, R, dd)
    }
  }
  const dateStep = step('date')
  if (dateStep?.phase !== 'done' && dateStep?.phase !== 'skipped') return getStatusSteps(db, B, R)

  return writebackStatus(deps, B, R)
}

/** date 步驟已經是 creating。等自動化 → 寫 → 讀回驗證。 */
async function settleDate(deps: StatusDeps, B: string, R: string, dd: DateData): Promise<void> {
  const { db } = deps
  const now = () => deps.now?.() ?? Date.now()
  const desired = dd.desired as number
  const st = getStatusSteps(db, B, R).find(x => x.step === 'state')
  const sd = (() => { try { return st?.data ? JSON.parse(st.data) as { changed?: boolean; at?: number; baseline?: number | null } : {} } catch { return {} } })()
  const baseline = sd.baseline === undefined ? dd.original : sd.baseline
  const fail = (m: string, extra: Partial<DateData> = {}) => finishStatusStep(db, B, R, 'date', 'failed', m, { ...dd, ...extra }, now())
  const read = async () => deps.readDate(R, dd.field)
  const sameDay = (a: number | null, b: number | null) => a != null && b != null && taipeiDay(a) === taipeiDay(b)

  // 自動化可能還沒跑：剛轉過、而且距離轉換還不到 SETTLED_MS
  const mayStillRun = sd.changed === true && now() - (sd.at ?? 0) < SETTLED_MS
  if (mayStillRun) {
    const today = now()
    const deadline = (sd.at ?? today) + AUTOMATION_WAIT_MS
    let observed: number | null | undefined
    for (;;) {
      const cur = await read()
      if (cur.kind === 'ok') {
        // 想要的就是今天：自動化寫的就是對的，讀到今天就收工
        if (sameDay(desired, today) && sameDay(cur.value, desired)) { finishStatusStep(db, B, R, 'date', 'done', null, { ...dd, observed: cur.value }, now()); return }
        // 看到自動化真的改了（跟這次轉換前的值不同）
        if (!sameDay(desired, today) && !sameDay(cur.value, baseline) && !(cur.value == null && baseline == null)) { observed = cur.value; break }
      }
      if (now() >= deadline) {
        fail(`日期待確認：轉換後 ${AUTOMATION_WAIT_MS / 1000} 秒內沒看到自動化改${dd.label}（原值可能本來就是今天），沒有覆寫。稍後按「只補日期」`, { pending: true })
        return
      }
      await deps.sleep(POLL_MS)
    }
    if (sameDay(observed ?? null, desired)) { finishStatusStep(db, B, R, 'date', 'done', null, { ...dd, observed }, now()); return }
  } else {
    // 自動化早就跑完（或根本沒轉）：值已經是想要的就不寫
    const cur = await read()
    if (cur.kind !== 'ok') { fail(`讀不到目前的${dd.label}：${msgOf(cur)}`); return }
    if (sameDay(cur.value, desired)) { finishStatusStep(db, B, R, 'date', 'done', null, { ...dd, pending: false }, now()); return }
  }

  const w = await deps.writeDate(R, dd.field, desired)
  if (w.kind !== 'ok') { fail(`寫入${dd.label}失敗：${msgOf(w)}`); return }
  await deps.sleep(VERIFY_DELAY_MS)
  const back = await read()
  if (back.kind !== 'ok') { fail(`寫入後讀不回來確認：${msgOf(back)}`); return }
  if (!sameDay(back.value, desired)) { fail(`寫入後讀回是 ${fmtDay(back.value)}，不是 ${fmtDay(desired)}（可能自動化又改了），可按「只補日期」`); return }
  finishStatusStep(db, B, R, 'date', 'done', null, { ...dd, pending: false }, now())
}

/** ③ Sheet 回填「處理階段＝已切換狀態」＋處理時間。轉狀態成功、日期 done／skipped 才寫；先確認那一列還是這張單。 */
export async function writebackStatus(deps: StatusDeps, B: string, R: string): Promise<StatusStepRow[]> {
  const { db } = deps
  const now = () => deps.now?.() ?? Date.now()
  const row = getStatusRow(db, B, R)
  const steps = getStatusSteps(db, B, R)
  if (!row) return steps
  const ph = (s: string) => steps.find(x => x.step === s)?.phase
  if (ph('state') !== 'done' || !['done', 'skipped'].includes(ph('date') ?? '') || ph('writeback') === 'done') return steps
  if (!row.source_key.startsWith('lark:')) return steps
  if (!beginStatusStep(db, B, R, 'writeback', now())) return getStatusSteps(db, B, R)
  const fail = (m: string) => { finishStatusStep(db, B, R, 'writeback', 'failed', m, undefined, now()); return getStatusSteps(db, B, R) }
  let cells: Record<string, string> | null
  try { cells = await deps.readRowCells(row.source_key, row.sheet_row, [MEEGLE_ID_COLUMN]) } catch (e) { return fail(`讀不到 Sheet 第 ${row.sheet_row} 列：${(e as Error).message}`) }
  if (!cells) return fail(`Sheet 找不到「${MEEGLE_ID_COLUMN}」欄`)
  if (parseMeegleIdCell(cells[MEEGLE_ID_COLUMN] ?? '') !== row.work_item_id) {
    return fail(`列已變動：第 ${row.sheet_row} 列的 Meegle 單號現在是「${cells[MEEGLE_ID_COLUMN] || '（空白）'}」，不是 #${row.work_item_id}。為了不寫到別列，沒有回填`)
  }
  let r: { ok: boolean; error?: string }
  try { r = await deps.writeRow(row.source_key, row.sheet_row, { '處理階段': STATUS_STAGE_DONE, '處理時間': deps.fmtTime(now()) }) } catch (e) { r = { ok: false, error: (e as Error).message } }
  if (!r.ok) return fail(`寫入 Sheet 失敗：${r.error ?? '未知錯誤'}`)
  finishStatusStep(db, B, R, 'writeback', 'done', null, undefined, now())
  return getStatusSteps(db, B, R)
}
