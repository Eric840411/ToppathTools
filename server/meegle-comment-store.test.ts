/**
 * Meegle 批量評論送出紀錄。跑法：npx tsx server/meegle-comment-store.test.ts
 */
import Database from 'better-sqlite3'
import {
  beginStep, claimCommentRow, expireStaleSteps, finishStep, getSnapshot, getSteps, initMeegleCommentSchema,
  listPreviousForSource, readyForWriteback, resolveUnknownStep, setSnapshot, type ClaimInput,
} from './meegle-comment-store.js'

let pass = 0, fail = 0
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : ` | got: ${JSON.stringify(got)} | want: ${JSON.stringify(want)}`}`)
  ok ? pass++ : fail++
}
const fresh = () => { const db = new Database(':memory:'); initMeegleCommentSchema(db); return db }
const base = (o: Partial<ClaimInput> = {}): ClaimInput => ({
  batchId: 'b1', workItemId: '100', sourceKey: 'lark:T:S', sheetUrl: 'https://x/sheets/T?sheet=S', sheetRow: 5, summary: '登入',
  ownerEmail: 'Eric@x.com', asEmail: '', videoCount: 2, withReview: true, ...o,
})
const phases = (db: Database.Database, b = 'b1', r = '100') => Object.fromEntries(getSteps(db, b, r).map(s => [s.step, s.phase]))

{
  const db = fresh()
  eq('第一次認領', claimCommentRow(db, base()), { kind: 'claimed' })
  eq('步驟：desc／comment／兩支影片／review／writeback', phases(db), { desc: 'none', comment: 'none', 'video:0': 'none', 'video:1': 'none', review: 'none', writeback: 'none' })
  eq('沒開 AI 分析 → review skipped', (() => { const d = fresh(); claimCommentRow(d, base({ withReview: false, videoCount: 0 })); return phases(d) })(),
    { desc: 'none', comment: 'none', review: 'skipped', writeback: 'none' })
}

{
  const db = fresh()
  claimCommentRow(db, base())
  eq('beginStep：none → creating', beginStep(db, 'b1', '100', 'comment'), true)
  eq('同一步驟不能再開一次（搶不到）', beginStep(db, 'b1', '100', 'comment'), false)
  eq('同批次重送時有 creating → busy', claimCommentRow(db, base()), { kind: 'busy', batchId: 'b1', step: 'comment' })
  eq('另一批次同單 creating → busy（兩個分頁同時送）', claimCommentRow(db, base({ batchId: 'b2' })), { kind: 'busy', batchId: 'b1', step: 'comment' })
  finishStep(db, 'b1', '100', 'comment', 'unknown', '逾時')
  eq('unknown → 同批次擋', claimCommentRow(db, base()), { kind: 'unknown', batchId: 'b1', step: 'comment' })
  eq('unknown → 跨批次也擋', claimCommentRow(db, base({ batchId: 'b2' })), { kind: 'unknown', batchId: 'b1', step: 'comment' })
  eq('unknown 不能被 beginStep 重新開始', beginStep(db, 'b1', '100', 'comment'), false)
  eq('人確認「確定有送出」→ done', resolveUnknownStep(db, 'b1', '100', 'comment', 'done', '使用者確認'), true)
  eq('done 之後跨批次 → 已評論', claimCommentRow(db, base({ batchId: 'b2' })), { kind: 'already-commented', batchId: 'b1' })
  eq('明確 allowRepeat 才能再送一輪', claimCommentRow(db, base({ batchId: 'b2', allowRepeat: true })), { kind: 'claimed' })
  eq('不同 Sheet 來源同單號不互擋', claimCommentRow(db, base({ batchId: 'b3', sourceKey: 'lark:T:OTHER' })), { kind: 'claimed' })
}

{
  const db = fresh()
  claimCommentRow(db, base())
  beginStep(db, 'b1', '100', 'desc'); finishStep(db, 'b1', '100', 'desc', 'done')
  beginStep(db, 'b1', '100', 'comment'); finishStep(db, 'b1', '100', 'comment', 'failed', 'Meegle 拒絕')
  eq('failed 可重送：重新認領成功', claimCommentRow(db, base()), { kind: 'claimed' })
  eq('重新認領不會把 done 的步驟洗掉', phases(db).desc, 'done')
  eq('failed 的步驟可以重新開始', beginStep(db, 'b1', '100', 'comment'), true)
  eq('較晚回來的舊結果（不是 creating）不能蓋掉', (() => { finishStep(db, 'b1', '100', 'comment', 'done'); return finishStep(db, 'b1', '100', 'comment', 'failed', '舊請求') })(), false)
  eq('別人不能接手這列', claimCommentRow(db, base({ ownerEmail: 'other@x.com' })), { kind: 'not-owner' })
  eq('同批次換 Sheet → 擋', claimCommentRow(db, base({ workItemId: '200', sourceKey: 'lark:T:S2' })), { kind: 'source-mismatch' })
}

{
  const db = fresh()
  claimCommentRow(db, base({ videoCount: 0 }))
  eq('重送時多一支影片 → 補上步驟', (() => { claimCommentRow(db, base({ videoCount: 1 })); return Object.keys(phases(db)) })(), ['desc', 'comment', 'review', 'writeback', 'video:0'])
}

{
  const db = fresh()
  claimCommentRow(db, base())
  beginStep(db, 'b1', '100', 'comment', 1000)
  eq('逾時的 creating → unknown', expireStaleSteps(db, 5000, 10_000), 1)
  eq('expire 後是 unknown', phases(db).comment, 'unknown')
}

// ── 回填前提 ──
eq('全部 done／skipped → 可回填', readyForWriteback([{ step: 'desc', phase: 'done' }, { step: 'comment', phase: 'done' }, { step: 'review', phase: 'skipped' }, { step: 'writeback', phase: 'none' }]), true)
eq('有一支影片 unknown → 不回填', readyForWriteback([{ step: 'desc', phase: 'done' }, { step: 'comment', phase: 'done' }, { step: 'video:0', phase: 'unknown' }, { step: 'writeback', phase: 'none' }]), false)
eq('文字成功、影片失敗 → 不回填（文字成功不代表附件成功）', readyForWriteback([{ step: 'desc', phase: 'done' }, { step: 'comment', phase: 'done' }, { step: 'video:0', phase: 'failed' }, { step: 'writeback', phase: 'none' }]), false)
eq('只有 writeback 一步 → 不回填', readyForWriteback([{ step: 'writeback', phase: 'none' }]), false)

// ── 基準 ──
{
  const db = fresh()
  eq('沒有基準 → null', getSnapshot(db, '100'), null)
  setSnapshot(db, '100', 'h1', 'Eric@x.com'); setSnapshot(db, '100', 'h2', 'eric@x.com')
  eq('基準覆蓋成最新', getSnapshot(db, '100'), 'h2')
}

// ── 接回之前的紀錄：同單只取最新一批 ──
{
  const db = fresh()
  claimCommentRow(db, base(), 1000)
  beginStep(db, 'b1', '100', 'comment'); finishStep(db, 'b1', '100', 'comment', 'done')
  claimCommentRow(db, base({ batchId: 'b2', allowRepeat: true }), 2000)
  const prev = listPreviousForSource(db, 'lark:T:S')
  eq('同單只回最新那批', prev.map(p => p.batch_id), ['b2'])
}

console.log(`\n${pass} 通過，${fail} 失敗`)
process.exit(fail ? 1 : 0)
