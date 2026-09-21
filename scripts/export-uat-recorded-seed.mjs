/**
 * scripts/export-uat-recorded-seed.mjs
 *
 * 把錄製好的**範本腳本**匯出成 `server/uat-recorded-scripts-seed.json` 進版控。
 *
 *   node scripts/export-uat-recorded-seed.mjs          # 只匯出範本（標題以「範本：」開頭）
 *   node scripts/export-uat-recorded-seed.mjs --all    # 全部（含個人錄製）
 *
 * 🚨 **為什麼需要這支**：錄好的腳本存在各環境自己的 `server/data.db`，
 *    而那個檔案在 `.gitignore` 裡（裡面有執行紀錄與帳號資料，本來就不該進版控）。
 *    所以「在這台錄好的腳本」對其他環境來說根本不存在——
 *    不是沒推上去，是它從來就不走 git。
 *
 * 匯出後 review 再 commit。其他環境開機時 `uat-recorded-scripts.ts` 會用
 * `INSERT OR IGNORE` 補上缺的那幾份（已存在的一律不動，不會蓋掉當地的修改）。
 */
import Database from 'better-sqlite3'
import { writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'server')
const all = process.argv.includes('--all')

const db = new Database(join(SERVER_ROOT, 'data.db'), { readonly: true })
const rows = db.prepare(`
  SELECT id, owner, title, document, updated_at FROM uat_recorded_scripts
  WHERE deleted_at IS NULL ORDER BY updated_at
`).all()

const picked = rows.filter(r => all || r.title.startsWith('範本'))
const scripts = []
for (const r of picked) {
  let document
  try { document = JSON.parse(r.document) } catch {
    console.warn(`跳過「${r.title}」：document 不是合法 JSON`)
    continue
  }
  scripts.push({ id: r.id, owner: r.owner, title: r.title, document })
}

const out = join(SERVER_ROOT, 'uat-recorded-scripts-seed.json')
writeFileSync(out, JSON.stringify({ scripts }, null, 2) + '\n', 'utf-8')

console.log(`DB 共 ${rows.length} 份腳本，匯出 ${scripts.length} 份${all ? '（全部）' : '（只取範本）'}`)
for (const s of scripts) console.log(`  · ${s.title}  (${s.document.steps?.length ?? 0} 步, owner ${s.owner})`)
console.log(`→ ${out}`)
