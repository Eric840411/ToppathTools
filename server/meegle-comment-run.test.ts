/**
 * Meegle 批量評論：送出一列的流程。跑法：npx tsx server/meegle-comment-run.test.ts
 * Meegle／Sheet 全部用假的；重點是順序、遇錯停在哪、何時不能重送、何時才回填。
 */
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { runCommentRow, writebackComment, type RowPayload, type RunDeps } from './meegle-comment-run.js'
import { descHash } from './meegle-comment-ops.js'
import { getSnapshot, initMeegleCommentSchema, resolveUnknownStep, setSnapshot } from './meegle-comment-store.js'
import type { CallOutcome } from './meegle-workitem.js'

let pass = 0, fail = 0
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : ` | got: ${JSON.stringify(got)} | want: ${JSON.stringify(want)}`}`)
  ok ? pass++ : fail++
}

type Fake = {
  remote: string
  calls: string[]
  sheet: Record<string, string>
  failOn?: Partial<Record<string, CallOutcome<never>['kind']>>
  /** 讀回時 Meegle 改寫內容（模擬實測：空行縮掉、圖片加 uuid） */
  rewrite?: (s: string) => string
  /** 寫入之後、讀回之前有人同時改 */
  raceAfterWrite?: string
}

function makeDeps(f: Fake): RunDeps {
  const db = new Database(':memory:'); initMeegleCommentSchema(db)
  const res = <T>(op: string, v: T): CallOutcome<T> => {
    const k = f.failOn?.[op]
    if (k === 'rejected') return { kind: 'rejected', message: `${op} 被拒` }
    if (k === 'unknown') return { kind: 'unknown', message: `${op} 逾時` }
    return { kind: 'ok', value: v }
  }
  let reads = 0
  return {
    db,
    getDescription: async () => { f.calls.push('get'); reads++; return res(reads === 1 ? 'get1' : 'get2', f.remote) },
    setDescription: async (_id, md) => {
      f.calls.push('set'); const r = res('set', true as const)
      if (r.kind === 'ok' || f.failOn?.set === 'unknown') f.remote = f.raceAfterWrite ?? (f.rewrite ? f.rewrite(md) : md)
      return r
    },
    uploadFile: async (_id, _p, name, kind) => { f.calls.push(`up:${kind}:${name}`); return res(`up:${kind}:${name}`, { fileToken: `tok-${name}`, fileUrl: `https://m/${name}` }) },
    addComment: async (_id, content, tok) => { f.calls.push(tok ? `comment+${tok}` : `comment:${content.slice(0, 12)}`); return res(tok ? `comment+${tok}` : content.startsWith('AI') ? 'review' : 'comment', true as const) },
    readRowCells: async () => { f.calls.push('read-sheet'); return { 'Meegle 單號': f.sheet.id ?? '' } },
    writeRow: async (_k, _r, cols) => { f.calls.push(`write:${Object.values(cols).join('|')}`); return f.failOn?.write ? { ok: false, error: '寫入失敗' } : { ok: true } },
    fmtTime: () => 'T',
    now: () => 1_000_000,
  }
}

const TEMPLATE = '【功能目的】\n1. 目的\n【驗證結果】'
const payload = (o: Partial<RowPayload> = {}): RowPayload => ({
  batchId: 'b1', workItemId: '15194994', sourceKey: 'lark:T:S', sheetUrl: 'u', sheetRow: 5, summary: '登入', space: 'test' as const, ownerEmail: 'me@x', asEmail: '',
  withReview: false,
  description: '【驗證結果】\n- 通過', images: [{ name: 'a.png', path: 'p/a' }], commentText: 'QA 已填寫測試頁',
  videos: [{ name: 'v1.mp4', path: 'p/v1', key: 'a1' }, { name: 'v2.mp4', path: 'p/v2', key: 'b2' }], reviewText: '涵蓋完整',
  expectedRemoteHash: descHash(TEMPLATE), confirmedRemoteHash: null, ...o,
})
const ph = (steps: Array<{ step: string; phase: string }>) => Object.fromEntries(steps.map(s => [s.step, s.phase]))

// ── 全部成功 ──
{
  const f: Fake = { remote: TEMPLATE, calls: [], sheet: { id: '#15194994' } }
  const d = makeDeps(f)
  const r = await runCommentRow(d, payload())
  eq('全部成功：每一步 done', ph(r.steps), { desc: 'done', comment: 'done', 'video:a1': 'done', 'video:b2': 'done', review: 'done', writeback: 'done' })
  eq('順序：讀→傳圖→傳影片（測試頁連結）→寫→讀回→評論→影片×2→分析→核對 Sheet→回填', f.calls, [
    'get', 'up:image:a.png', 'up:image:v1.mp4', 'up:image:v2.mp4', 'set', 'get', 'comment:QA 已填寫測試頁', 'up:comment:v1.mp4', 'comment+tok-v1.mp4', 'up:comment:v2.mp4', 'comment+tok-v2.mp4', 'comment:AI 完整性分析\n\n涵蓋', 'read-sheet', 'write:添加評論|T'])
  eq('寫入的測試說明帶圖片＋影片連結（2026-10-06：影片也要在測試頁）', f.remote, '【驗證結果】\n- 通過\n\n![a.png](https://m/a.png)\n\n影片：[v1.mp4](https://m/v1.mp4)\n\n影片：[v2.mp4](https://m/v2.mp4)')
  eq('基準＝讀回值的 hash', getSnapshot(d.db, '15194994'), descHash(f.remote))
  const again = await runCommentRow(d, payload())
  eq('同批次再送：已全部 done，不會再呼叫 Meegle', f.calls.filter(c => c.startsWith('comment')).length, 4)
  eq('同批次再送仍是 claimed、步驟不變', again.claim.kind, 'claimed')
}

// ── Meegle 改寫格式不算「讀回不一致」──
{
  const f: Fake = { remote: TEMPLATE, calls: [], sheet: { id: '#15194994' }, rewrite: s => s.replace(/\n\n/g, '\n').replace(/!\[[^\]]*\]\(([^)]+)\)/g, '![]($1)<!-- image:{"uuid":"X"} -->') }
  const d = makeDeps(f)
  const r = await runCommentRow(d, payload({ videos: [], reviewText: null }))
  eq('Meegle 改寫空行／圖片 → 仍 done', ph(r.steps).desc, 'done')
  eq('review 沒開 → skipped，仍會回填', ph(r.steps), { desc: 'done', comment: 'done', review: 'skipped', writeback: 'done' })
}

// ── 覆寫保護 ──
{
  const f: Fake = { remote: '【驗證結果】\n- RD 補充', calls: [], sheet: { id: '#15194994' } }
  const d = makeDeps(f)
  setSnapshot(d.db, '15194994', descHash('【驗證結果】\n- 舊版'), 'me@x')
  const r = await runCommentRow(d, payload({ expectedRemoteHash: descHash(f.remote) }))
  eq('被人改過＋沒確認 → desc failed、沒寫', [ph(r.steps).desc, f.calls.includes('set')], ['failed', false])
  eq('desc 沒成功 → 不貼評論', f.calls.some(c => c.startsWith('comment')), false)
  const r2 = await runCommentRow(d, payload({ expectedRemoteHash: descHash(f.remote), confirmedRemoteHash: descHash(f.remote) }))
  eq('確認過這個版本 → 覆寫成功', ph(r2.steps).desc, 'done')
}
{
  const f: Fake = { remote: '【驗證結果】\n- 有人寫的', calls: [], sheet: { id: '#15194994' } }
  const d = makeDeps(f)
  setSnapshot(d.db, '15194994', descHash('舊'), 'me@x')
  const r = await runCommentRow(d, payload({ expectedRemoteHash: descHash(f.remote), confirmedRemoteHash: descHash('確認的是更早的版本') }))
  eq('確認的是別的版本 → 仍擋（確認綁定遠端版本）', ph(r.steps).desc, 'failed')
}
{
  const f: Fake = { remote: '【驗證結果】\n- 有人寫的（沒有基準）', calls: [], sheet: { id: '#15194994' } }
  const r = await runCommentRow(makeDeps(f), payload({ expectedRemoteHash: descHash(f.remote) }))
  eq('沒有基準的「已有內容」→ 不需確認、直接覆寫（使用者選 B）', ph(r.steps).desc, 'done')
}
{
  const f: Fake = { remote: '預覽後又被改', calls: [], sheet: { id: '#15194994' } }
  const r = await runCommentRow(makeDeps(f), payload())
  eq('跟預覽看到的不一樣 → failed、沒寫', [ph(r.steps).desc, f.calls.includes('set')], ['failed', false])
}

// ── 寫入結果不明／讀回不一致 ──
{
  const f: Fake = { remote: TEMPLATE, calls: [], sheet: { id: '#15194994' }, failOn: { set: 'unknown' } }
  const d = makeDeps(f)
  const r = await runCommentRow(d, payload())
  eq('寫入逾時 → unknown、不貼評論、不更新基準', [ph(r.steps).desc, f.calls.some(c => c.startsWith('comment')), getSnapshot(d.db, '15194994')], ['unknown', false, null])
  eq('unknown 之後再送 → 擋下', (await runCommentRow(d, payload())).claim.kind, 'unknown')
}
{
  const f: Fake = { remote: TEMPLATE, calls: [], sheet: { id: '#15194994' }, raceAfterWrite: '別人同時寫的' }
  const d = makeDeps(f)
  const r = await runCommentRow(d, payload())
  eq('讀回值不是送出的 → unknown、保留舊基準（不把別人的內容當自己的）', [ph(r.steps).desc, getSnapshot(d.db, '15194994')], ['unknown', null])
}
{
  const f: Fake = { remote: TEMPLATE, calls: [], sheet: { id: '#15194994' }, failOn: { get2: 'unknown' } }
  const d = makeDeps(f)
  const r = await runCommentRow(d, payload())
  eq('讀回失敗 → unknown、不更新基準', [ph(r.steps).desc, getSnapshot(d.db, '15194994')], ['unknown', null])
}
{
  const f: Fake = { remote: TEMPLATE, calls: [], sheet: { id: '#15194994' }, failOn: { 'up:image:a.png': 'rejected' } }
  const r = await runCommentRow(makeDeps(f), payload())
  eq('圖片上傳失敗 → failed、測試說明沒動（可重送）', [ph(r.steps).desc, f.calls.includes('set')], ['failed', false])
}

// ── 評論／影片 ──
{
  const f: Fake = { remote: TEMPLATE, calls: [], sheet: { id: '#15194994' }, failOn: { comment: 'unknown' } }
  const d = makeDeps(f)
  const r = await runCommentRow(d, payload())
  eq('評論逾時 → unknown、影片與分析不做、不回填', ph(r.steps), { desc: 'done', comment: 'unknown', 'video:a1': 'none', 'video:b2': 'none', review: 'none', writeback: 'none' })
  eq('使用者確認「有送出」後再送 → 只做剩下的', (() => { resolveUnknownStep(d.db, 'b1', '15194994', 'comment', 'done', '確認'); f.failOn = {}; return true })(), true)
  const r2 = await runCommentRow(d, payload())
  eq('接著做影片、分析、回填；測試說明不重寫', [ph(r2.steps).writeback, f.calls.filter(c => c === 'set').length], ['done', 1])
}
{
  const f: Fake = { remote: TEMPLATE, calls: [], sheet: { id: '#15194994' }, failOn: { 'comment+tok-v2.mp4': 'unknown' } }
  const r = await runCommentRow(makeDeps(f), payload())
  eq('第二支影片逾時 → 只有它 unknown，文字與第一支成功不代表全成功、不回填', ph(r.steps), { desc: 'done', comment: 'done', 'video:a1': 'done', 'video:b2': 'unknown', review: 'none', writeback: 'none' })
}
{
  // 「補寫回」按鈕直接打 writebackComment——不能因為走的是另一個入口就跳過「全部成功才回填」
  const f: Fake = { remote: TEMPLATE, calls: [], sheet: { id: '#15194994' }, failOn: { 'comment+tok-v1.mp4': 'unknown' } }
  const d = makeDeps(f)
  await runCommentRow(d, payload({ reviewText: null, videos: [{ name: 'v1.mp4', path: 'p/v1', key: 'a1' }] }))
  const before = f.calls.length
  const steps = await writebackComment(d, 'b1', '15194994')
  eq('影片還是 unknown 時按補寫回 → 不回填、不讀 Sheet', [ph(steps).writeback, f.calls.slice(before)], ['none', []])
}
{
  const f: Fake = { remote: TEMPLATE, calls: [], sheet: { id: '#15194994' }, failOn: { 'up:comment:v1.mp4': 'rejected' } }
  const r = await runCommentRow(makeDeps(f), payload())
  eq('影片上傳失敗 → failed（沒貼出去，可重送）', ph(r.steps)['video:a1'], 'failed')
}
{
  // 影片上傳到測試頁失敗：測試說明還沒寫 → desc failed、後面都不做（不會貼了評論卻沒有測試頁）
  const f: Fake = { remote: TEMPLATE, calls: [], sheet: { id: '#15194994' }, failOn: { 'up:image:v2.mp4': 'rejected' } }
  const r = await runCommentRow(makeDeps(f), payload())
  eq('影片上傳到測試頁失敗 → desc failed、沒寫入、沒評論', [ph(r.steps).desc, f.calls.includes('set'), f.calls.some(c => c.startsWith('comment'))], ['failed', false, false])
}
// ── 「覆寫測試頁」開關（2026-10-06 使用者要）────────────────────────────
{
  const f: Fake = { remote: TEMPLATE, calls: [], sheet: { id: '#15194994' } }
  const d = makeDeps(f)
  const r = await runCommentRow(d, { ...payload(), overwriteDesc: false })
  eq('關掉覆寫 → desc skipped、測試頁不讀不寫、不傳圖', [ph(r.steps).desc, f.calls.filter(c => c === 'get' || c === 'set' || c.startsWith('up:image')).length, f.remote], ['skipped', 0, TEMPLATE])
  eq('關掉覆寫 → 評論、影片評論、分析、回填照做', [ph(r.steps).comment, ph(r.steps)['video:a1'], ph(r.steps).review, ph(r.steps).writeback], ['done', 'done', 'done', 'done'])
}
{
  // 同一批：先關掉送、評論失敗；這次打開再送 → 測試頁要真的寫（skipped 不能卡住）
  const f: Fake = { remote: TEMPLATE, calls: [], sheet: { id: '#15194994' }, failOn: { comment: 'rejected' } }
  const d = makeDeps(f)
  await runCommentRow(d, { ...payload(), overwriteDesc: false })
  f.failOn = {}
  const r = await runCommentRow(d, payload())
  eq('上次不覆寫、這次打開 → 測試頁照樣寫入', [ph(r.steps).desc, f.calls.includes('set')], ['done', true])
}
{
  // 已經寫過的不會因為這次關掉而變 skipped（寫過就是寫過）
  const f: Fake = { remote: TEMPLATE, calls: [], sheet: { id: '#15194994' }, failOn: { comment: 'rejected' } }
  const d = makeDeps(f)
  await runCommentRow(d, payload())
  f.failOn = {}
  const r = await runCommentRow(d, { ...payload(), overwriteDesc: false })
  eq('已寫入的測試說明，這次關掉 → 仍是 done', ph(r.steps).desc, 'done')
}
{
  const f: Fake = { remote: TEMPLATE, calls: [], sheet: { id: '#15194994' }, failOn: { comment: 'rejected' } }
  const r = await runCommentRow(makeDeps(f), payload())
  eq('評論被拒 → failed（確定沒貼，可重送）', ph(r.steps).comment, 'failed')
}

// ── CodeX review 64f53aa [P1]：A 成功、B 失敗後改成 [B, A] 重送 → A 不重貼、B 補送、之後才回填 ──
{
  const f: Fake = { remote: TEMPLATE, calls: [], sheet: { id: '#15194994' }, failOn: { 'comment+tok-v2.mp4': 'rejected' } }
  const d = makeDeps(f)
  await runCommentRow(d, payload({ reviewText: null }))
  f.failOn = {}
  const before = f.calls.length
  const r = await runCommentRow(d, payload({ reviewText: null, videos: [{ name: 'v2.mp4', path: 'p/v2', key: 'b2' }, { name: 'v1.mp4', path: 'p/v1', key: 'a1' }] }))
  const after = f.calls.slice(before)
  eq('重排後 A 沒有重貼、B 補送', [after.filter(c => c === 'comment+tok-v1.mp4').length, after.filter(c => c === 'comment+tok-v2.mp4').length], [0, 1])
  eq('兩支都 done 才回填', [ph(r.steps)['video:a1'], ph(r.steps)['video:b2'], ph(r.steps).writeback], ['done', 'done', 'done'])
}
{
  const f: Fake = { remote: TEMPLATE, calls: [], sheet: { id: '#15194994' } }
  const r = await runCommentRow(makeDeps(f), payload({ reviewText: null, videos: [{ name: 'v1.mp4', path: 'p/v1', key: 'a1' }, { name: 'v1 複本.mp4', path: 'p/v1b', key: 'a1' }] }))
  eq('同一支影片放兩次（內容相同）只貼一次', f.calls.filter(c => c.startsWith('comment+')).length, 1)
  eq('…而且仍會回填', ph(r.steps).writeback, 'done')
}
// ── Meegle 重排 Markdown（真實 fixture）不能被當成讀回不一致 ──
{
  const sent = readFileSync('server/__fixtures__/meegle-md-sent.txt', 'utf8')
  const back = readFileSync('server/__fixtures__/meegle-md-back.txt', 'utf8')
  const f: Fake = { remote: TEMPLATE, calls: [], sheet: { id: '#15194994' }, rewrite: () => back }
  const r = await runCommentRow(makeDeps(f), payload({ description: sent, images: [], videos: [], reviewText: null }))
  eq('實測：清單重編號／縮排／符號被 Meegle 改寫 → 仍判定寫入成功', ph(r.steps).desc, 'done')
}

// ── 回填 ──
{
  const f: Fake = { remote: TEMPLATE, calls: [], sheet: { id: '#15190441' } }
  const r = await runCommentRow(makeDeps(f), payload({ videos: [], reviewText: null }))
  eq('Sheet 那列的單號已不是這張 → 回填 failed、沒寫', [ph(r.steps).writeback, f.calls.some(c => c.startsWith('write:'))], ['failed', false])
}
{
  const f: Fake = { remote: TEMPLATE, calls: [], sheet: { id: '#151949940' } }
  const r = await runCommentRow(makeDeps(f), payload({ videos: [], reviewText: null }))
  eq('單號前綴相同（#151949940 vs #15194994）也不算同一張', ph(r.steps).writeback, 'failed')
}
{
  const f: Fake = { remote: TEMPLATE, calls: [], sheet: { id: '#15194994' }, failOn: { write: 'rejected' } }
  const d = makeDeps(f)
  const r = await runCommentRow(d, payload({ videos: [], reviewText: null }))
  eq('回填失敗 → 其他步驟仍 done', ph(r.steps), { desc: 'done', comment: 'done', review: 'skipped', writeback: 'failed' })
  f.failOn = {}
  const before = f.calls.length
  const steps = await writebackComment(d, 'b1', '15194994')
  eq('補寫回只跑回填，不碰 Meegle', [ph(steps).writeback, f.calls.slice(before)], ['done', ['read-sheet', 'write:添加評論|T']])
}

console.log(`\n${pass} 通過，${fail} 失敗`)
process.exit(fail ? 1 : 0)
