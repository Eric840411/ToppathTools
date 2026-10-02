/**
 * Meegle 批量評論：送出**一列**（一張單）。步驟與順序跟 CodeX 對過（2026-10-02）：
 *
 *   認領 → ① 覆寫測試說明（含圖片）→ ② 評論 → ③ 每支影片各一則 → ④ AI 完整性分析 → ⑤ Sheet 回填
 *
 * - 每一步只從 none／failed 開始；done 的不重做，creating／unknown 一律不碰（防重送）
 * - 前一步沒成功就停在那一列，後面的不做（沒寫進測試說明就先貼評論，會留下半套）
 * - ① 覆寫前先讀現況：跟預覽時看到的不一樣 → 停（預覽後又被改過）；被人改過（changed）而使用者沒確認 → 停
 *   寫入後讀回，**讀回值與送出值的文字內容一致**（textFingerprint：不比 Markdown 格式，Meegle 會重排）才更新基準；
 *   不一致或讀不回來 → 待確認、保留舊基準（CodeX）
 *   ⚠️ 讀完到寫入之間被人改的空窗擋不住——Meegle 沒有條件式更新（記在 docs/decisions.md）
 * - 送出**不跑 AI**：內容是使用者在預覽最後看到、手改過的版本（AI 在預覽就跑完了）
 * - 遠端呼叫全部從 deps 傳進來，測試用假的
 */
import type Database from 'better-sqlite3'
import { COMMENT_STAGE_DONE, MEEGLE_ID_COLUMN, parseMeegleIdCell } from '../shared/meegle-comment-rules.js'
import { buildDescription, classifyRemote, descHash, textFingerprint, type Uploaded } from './meegle-comment-ops.js'
import {
  beginStep, claimCommentRow, finishStep, getCommentRow, getSnapshot, getSteps, readyForWriteback, setSnapshot,
  type ClaimInput, type ClaimResult, type StepRow,
} from './meegle-comment-store.js'
import type { CallOutcome } from './meegle-workitem.js'
import type { SheetCell } from './meegle-sheet-writeback.js'

type DB = Database.Database

export type RunDeps = {
  db: DB
  getDescription: (workItemId: string) => Promise<CallOutcome<string>>
  setDescription: (workItemId: string, markdown: string) => Promise<CallOutcome<true>>
  uploadFile: (workItemId: string, path: string, filename: string, kind: 'image' | 'comment') => Promise<CallOutcome<Uploaded>>
  addComment: (workItemId: string, content: string, fileToken?: string) => Promise<CallOutcome<true>>
  readRowCells: (sheetKey: string, rowIndex: number, names: string[]) => Promise<Record<string, string> | null>
  writeRow: (sheetKey: string, rowIndex: number, columns: Record<string, SheetCell>) => Promise<{ ok: boolean; error?: string }>
  fmtTime: (ms: number) => string
  now?: () => number
}

export type RowPayload = Omit<ClaimInput, 'videos'> & {
  description: string
  images: Array<{ name: string; path: string }>
  commentText: string
  /** key＝檔案內容 hash（後端算）：步驟用它識別，不用排序位置（CodeX review 64f53aa [P1]） */
  videos: Array<{ name: string; path: string; key: string }>
  reviewText: string | null
  /** 預覽時看到的遠端測試說明 hash（descHash）；送出前會再讀一次比對 */
  expectedRemoteHash: string
  /** 使用者在預覽確認過「被改過也要覆寫」的那個遠端版本 hash（只在 changed 時需要） */
  confirmedRemoteHash: string | null
}

export type RunResult = { claim: ClaimResult; steps: StepRow[] }

const msgOf = (r: { kind: string; message?: string }) => ('message' in r && r.message) || '未知錯誤'

export async function runCommentRow(deps: RunDeps, p: RowPayload): Promise<RunResult> {
  const { db } = deps
  const now = () => deps.now?.() ?? Date.now()
  const B = p.batchId, R = p.workItemId
  // 同一支影片放兩次（內容相同）只貼一次
  const videos = p.videos.filter((v, i) => p.videos.findIndex(x => x.key === v.key) === i)
  const claim = claimCommentRow(db, { ...p, videos: videos.map(v => ({ key: v.key, name: v.name })), withReview: p.reviewText != null }, now())
  if (claim.kind !== 'claimed') return { claim, steps: getSteps(db, B, R) }
  const phase = (step: string) => getSteps(db, B, R).find(s => s.step === step)?.phase
  const doneOrSkipped = (step: string) => ['done', 'skipped'].includes(phase(step) ?? '')

  // ① 覆寫測試說明
  if (!doneOrSkipped('desc') && beginStep(db, B, R, 'desc', now())) {
    const ok = await (async (): Promise<boolean> => {
      const cur = await deps.getDescription(R)
      // 還沒寫任何東西：讀取失敗都算 failed（可安全重送）
      if (cur.kind !== 'ok') { finishStep(db, B, R, 'desc', 'failed', `讀不到目前的測試說明：${msgOf(cur)}`, undefined, now()); return false }
      if (descHash(cur.value) !== p.expectedRemoteHash) {
        finishStep(db, B, R, 'desc', 'failed', '預覽之後測試說明又被改過，請重新預覽這一列再送', undefined, now()); return false
      }
      const state = classifyRemote(cur.value, getSnapshot(db, R))
      if (state === 'changed' && p.confirmedRemoteHash !== descHash(cur.value)) {
        finishStep(db, B, R, 'desc', 'failed', '測試說明被人改過，需要在預覽確認覆寫', undefined, now()); return false
      }
      const urls: Array<{ name: string; url: string }> = []
      for (const img of p.images) {
        const up = await deps.uploadFile(R, img.path, img.name, 'image')
        // 上傳失敗：測試說明還沒動，標 failed 可重送（多傳的圖只是孤兒檔，不會出現在單上）
        if (up.kind !== 'ok' || !up.value.fileUrl) { finishStep(db, B, R, 'desc', 'failed', `圖片 ${img.name} 上傳失敗：${up.kind === 'ok' ? '沒有網址' : msgOf(up)}`, undefined, now()); return false }
        urls.push({ name: img.name, url: up.value.fileUrl })
      }
      const md = buildDescription(p.description, urls)
      const w = await deps.setDescription(R, md)
      if (w.kind === 'rejected') { finishStep(db, B, R, 'desc', 'failed', `Meegle 拒絕寫入：${w.message}`, undefined, now()); return false }
      if (w.kind === 'unknown') { finishStep(db, B, R, 'desc', 'unknown', `寫入結果不明：${w.message}`, undefined, now()); return false }
      const back = await deps.getDescription(R)
      if (back.kind !== 'ok') { finishStep(db, B, R, 'desc', 'unknown', `已送出但讀不回來確認：${msgOf(back)}`, undefined, now()); return false }
      // 只比看得到的文字：Meegle 存檔會重排 Markdown（2026-10-02 使用者真送兩張全被誤判，fixture 在 server/__fixtures__/meegle-md-*）
      if (textFingerprint(back.value) !== textFingerprint(md)) {
        finishStep(db, B, R, 'desc', 'unknown', '讀回的內容跟送出的不一樣（可能剛好有人同時在改），請到 Meegle 確認', undefined, now()); return false
      }
      setSnapshot(db, R, descHash(back.value), p.asEmail || p.ownerEmail, now())
      finishStep(db, B, R, 'desc', 'done', null, { images: urls.length }, now())
      return true
    })()
    if (!ok) return { claim, steps: getSteps(db, B, R) }
  }
  if (!doneOrSkipped('desc')) return { claim, steps: getSteps(db, B, R) }

  // ② 評論、③ 影片、④ AI 分析：都是「新增一則評論」，結果不明一律 unknown、不重送
  const post = async (step: string, content: string, file?: { name: string; path: string; key?: string }): Promise<boolean> => {
    if (doneOrSkipped(step)) return true
    // 送出的內容存進這一步：結果不明時後端用它找候選評論（不靠前端草稿）
    if (!beginStep(db, B, R, step, now(), file ? { name: file.name, key: file.key } : { content })) return false
    let token: string | undefined
    if (file) {
      const up = await deps.uploadFile(R, file.path, file.name, 'comment')
      if (up.kind !== 'ok') { finishStep(db, B, R, step, 'failed', `${file.name} 上傳失敗：${msgOf(up)}`, undefined, now()); return false }
      token = up.value.fileToken
    }
    const c = await deps.addComment(R, content, token)
    if (c.kind === 'ok') { finishStep(db, B, R, step, 'done', null, undefined, now()); return true }
    finishStep(db, B, R, step, c.kind === 'rejected' ? 'failed' : 'unknown', c.kind === 'rejected' ? `Meegle 拒絕：${c.message}` : `送出結果不明：${c.message}（不會自動重送）`, undefined, now())
    return false
  }
  if (!(await post('comment', p.commentText))) return { claim, steps: getSteps(db, B, R) }
  // 影片：評論帶附件時 Meegle 會拆成「文字一則＋附件一則」，所以影片那則不帶文字（實測）
  for (const v of videos) {
    if (!(await post(`video:${v.key}`, '', v))) return { claim, steps: getSteps(db, B, R) }
  }
  if (p.reviewText != null && !(await post('review', `AI 完整性分析\n\n${p.reviewText.trim()}`))) return { claim, steps: getSteps(db, B, R) }

  await writebackComment(deps, B, R)
  return { claim, steps: getSteps(db, B, R) }
}

/**
 * ⑤ Sheet 回填「處理階段＝添加評論」＋處理時間。全部步驟成功才寫（CodeX）；只剩回填失敗時「補寫回」只跑這一步。
 * 寫之前讀那一列的「Meegle 單號」，第一個字不是這張單 → 不寫（列被移動過）。
 */
export async function writebackComment(deps: RunDeps, batchId: string, rowKey: string): Promise<StepRow[]> {
  const { db } = deps
  const now = () => deps.now?.() ?? Date.now()
  const row = getCommentRow(db, batchId, rowKey)
  const steps = getSteps(db, batchId, rowKey)
  if (!row || !readyForWriteback(steps)) return steps
  if (steps.find(s => s.step === 'writeback')?.phase === 'done') return steps
  if (!row.source_key.startsWith('lark:')) return steps
  if (!beginStep(db, batchId, rowKey, 'writeback', now())) return getSteps(db, batchId, rowKey)
  const fail = (m: string) => { finishStep(db, batchId, rowKey, 'writeback', 'failed', m, undefined, now()); return getSteps(db, batchId, rowKey) }
  let cells: Record<string, string> | null
  try { cells = await deps.readRowCells(row.source_key, row.sheet_row, [MEEGLE_ID_COLUMN]) } catch (e) { return fail(`讀不到 Sheet 第 ${row.sheet_row} 列：${(e as Error).message}`) }
  if (!cells) return fail(`Sheet 找不到「${MEEGLE_ID_COLUMN}」欄`)
  const onSheet = parseMeegleIdCell(cells[MEEGLE_ID_COLUMN] ?? '')
  if (onSheet !== row.work_item_id) {
    return fail(`列已變動：第 ${row.sheet_row} 列的 Meegle 單號現在是「${cells[MEEGLE_ID_COLUMN] || '（空白）'}」，不是 #${row.work_item_id}。為了不寫到別列，沒有回填`)
  }
  let r: { ok: boolean; error?: string }
  try { r = await deps.writeRow(row.source_key, row.sheet_row, { '處理階段': COMMENT_STAGE_DONE, '處理時間': deps.fmtTime(now()) }) } catch (e) { r = { ok: false, error: (e as Error).message } }
  if (!r.ok) return fail(`寫入 Sheet 失敗：${r.error ?? '未知錯誤'}`)
  finishStep(db, batchId, rowKey, 'writeback', 'done', null, undefined, now())
  return getSteps(db, batchId, rowKey)
}
