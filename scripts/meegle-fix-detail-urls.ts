/**
 * 一次性修復（v4.269.1）：v4.263～4.269.0 開的 Meegle 單，存的網址是 CLI 回的
 * `/{project_key}/{type_key}/detail/{id}`，點開不會跳到單。改成 `/{simple_name}/{api_name}/detail/{id}`：
 *   1 meegle_batch_rows.url
 *   2 operation_history 裡 Meegle 開單紀錄的 detail（字串替換前綴）
 *   3 已回填的 Sheet 列：force 重寫（單號欄、單子標題貼這是同一張單，覆寫規則允許；處理時間會更新成現在）
 *
 * 跑法：npx tsx scripts/meegle-fix-detail-urls.ts            （先看會改什麼）
 *       npx tsx scripts/meegle-fix-detail-urls.ts --apply    （真的改）
 */
import 'dotenv/config'
import Database from 'better-sqlite3'
import { decryptMeegleToken } from '../server/meegle-token-crypto.js'
import { meegleTarget, resolveDetailUrlBase } from '../server/meegle-workitem.js'
import { larkWritebackDeps, writebackRow } from '../server/meegle-sheet-writeback.js'

const apply = process.argv.includes('--apply')
const db = new Database('server/data.db')
const t = meegleTarget()
const bad = `https://project.larksuite.com/${t.projectKey}/${t.taskTypeKey}/detail/`

const acct = db.prepare("SELECT token_enc FROM meegle_accounts WHERE status = 'active' LIMIT 1").get() as { token_enc: string } | undefined
  ?? db.prepare('SELECT token_enc FROM meegle_accounts LIMIT 1').get() as { token_enc: string } | undefined
if (!acct) throw new Error('沒有任何 Meegle 綁定，查不到 simple_name／api_name')
const base = await resolveDetailUrlBase(decryptMeegleToken(acct.token_enc))
if (base.kind !== 'ok') throw new Error(`查網址失敗：${base.message}`)
if (base.value === bad) throw new Error('查到的網址跟壞網址一樣，不動')
console.log(`壞：${bad}\n好：${base.value}`)

const rows = db.prepare('SELECT batch_id, row_key, work_item_id, url, sheet_url, writeback_phase FROM meegle_batch_rows WHERE url LIKE ?').all(`${bad}%`) as
  Array<{ batch_id: string; row_key: string; work_item_id: string; url: string; sheet_url: string; writeback_phase: string }>
const hist = db.prepare('SELECT id FROM operation_history WHERE detail LIKE ?').all(`%${bad}%`) as { id: string }[]
console.log(`開單紀錄 ${rows.length} 列、操作紀錄 ${hist.length} 筆`)
for (const r of rows) console.log(`  #${r.work_item_id}  第 ${r.row_key} 列  回填=${r.writeback_phase}`)
if (!apply) { console.log('（加 --apply 才會改）'); process.exit(0) }

const fixRow = db.prepare('UPDATE meegle_batch_rows SET url = ? WHERE batch_id = ? AND row_key = ? AND url = ?')
for (const r of rows) fixRow.run(base.value + r.work_item_id, r.batch_id, r.row_key, r.url)
const fixHist = db.prepare('UPDATE operation_history SET detail = replace(detail, ?, ?) WHERE id = ?')
for (const h of hist) fixHist.run(bad, base.value, h.id)
console.log('DB 已更新')

for (const r of rows) {
  if (r.writeback_phase !== 'done' || !r.sheet_url.startsWith('lark:')) { console.log(`  #${r.work_item_id} 沒回填過，跳過 Sheet`); continue }
  const out = await writebackRow(db, r.batch_id, r.row_key, larkWritebackDeps(), { force: true })
  console.log(`  #${r.work_item_id} Sheet：${out.phase}${out.message ? `（${out.message}）` : ''}`)
}
const left = (db.prepare('SELECT count(*) c FROM meegle_batch_rows WHERE url LIKE ?').get(`${bad}%`) as { c: number }).c
const leftH = (db.prepare('SELECT count(*) c FROM operation_history WHERE detail LIKE ?').get(`%${bad}%`) as { c: number }).c
console.log(`剩下壞網址：開單紀錄 ${left}、操作紀錄 ${leftH}`)
