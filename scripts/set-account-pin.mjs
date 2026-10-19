/**
 * 在伺服器主機上直接設定帳號 PIN（救援用）。
 *
 * v5.66.0 起沒設 PIN 的帳號不能登入（資安審查 2026-10-19）。平常由管理員在「權限管理」幫人設；
 * 但如果**管理員自己也沒有 PIN**，就沒有人登得進去設——這時在主機上跑這支。
 *
 * 跑法（在專案根目錄）：
 *   node scripts/set-account-pin.mjs <email>            # 會提示輸入 PIN（不回顯）
 *   node scripts/set-account-pin.mjs --list-no-pin      # 列出還沒設 PIN 的帳號
 *
 * 雜湊格式跟 server/pin-hash.ts 同一份（直接 import，不另抄規則）。
 * ⚠️ 只能在主機上跑：要能直接寫 server/data.db。不經過 API，所以不受登入限制。
 */
import Database from 'better-sqlite3'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { createInterface } from 'readline'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { hashPin } = await import('../server/pin-hash.ts')
const db = new Database(join(root, 'server', 'data.db'))

const arg = process.argv[2]
if (!arg) {
  console.error('用法：node scripts/set-account-pin.mjs <email> | --list-no-pin')
  process.exit(1)
}

if (arg === '--list-no-pin') {
  const rows = db.prepare("SELECT email, label, role FROM jira_accounts WHERE (pin_hash IS NULL OR pin_hash = '') AND COALESCE(status, 'active') <> 'disabled'").all()
  if (!rows.length) console.log('所有啟用中的帳號都有 PIN')
  for (const r of rows) console.log(`${r.email}\t${r.label}\t${r.role}`)
  process.exit(0)
}

const account = db.prepare('SELECT email, label, role FROM jira_accounts WHERE email = ?').get(arg)
if (!account) {
  console.error(`找不到帳號：${arg}`)
  process.exit(1)
}

// 終端機：逐題問、不回顯。管線（非 TTY）：整包讀 stdin，前兩行當 PIN 與確認
async function readTwo(prompt) {
  if (!process.stdin.isTTY) {
    let buf = ''
    for await (const chunk of process.stdin) buf += chunk
    const [a = '', b = ''] = buf.split(/\r?\n/)
    return [a, b]
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  let prompting = ''
  const rawWrite = rl._writeToOutput?.bind(rl)
  rl._writeToOutput = s => rawWrite?.(s.includes(prompting) ? s : '')
  const ask = p => new Promise(resolve => { prompting = p; rl.question(p, a => { process.stdout.write('\n'); resolve(a) }) })
  const a = await ask(prompt)
  const b = await ask('再輸入一次：')
  rl.close()
  return [a, b]
}

const [pinRaw, againRaw] = await readTwo(`設定 ${account.label}（${account.role}）的 PIN：`)
const pin = pinRaw.trim()
const again = againRaw.trim()
if (!pin || pin.length < 4) { console.error('PIN 至少 4 碼'); process.exit(1) }
if (pin !== again) { console.error('兩次輸入不一致'); process.exit(1) }

db.prepare('UPDATE jira_accounts SET pin_hash = ? WHERE email = ?').run(hashPin(pin), account.email)
console.log(`已設定 ${account.email} 的 PIN`)
