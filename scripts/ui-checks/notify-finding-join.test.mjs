/**
 * 告警明細抓的是**哪一筆**。
 *
 *   node scripts/ui-checks/notify-finding-join.test.mjs
 *
 * 🚨 **這支守的是「告警指到別台機器」。**（2026-09-21 使用者回報）
 *    `recon_finding.refId` 有兩種意思：
 *      refType='spin'  → `recon_spin.id`（數字）
 *      refType='round' → **後台局號**，像 `897-BIGFULINK-2065|6AB02E83089`
 *    原本的查詢無條件 `CAST(f.refId AS INTEGER)`，SQLite 會把後者變成 `897`，
 *    然後 join 到 id=897 那一筆**毫不相干的 spin**。
 *
 *    結果：四筆不同的局全部顯示成「同一個第 N 局」，機台名稱是那筆無關 spin 的——
 *    使用者看到的是「JJBXGOLD 第 78 局」重複四次，而實際上那四筆都是他自己那台。
 *    **錯得很有說服力**：格式正常、數字看起來合理，只有「重複」是唯一的線索。
 *
 * ⚠️ SQL **直接從原始碼抽**，不另抄一份——抄一份的話改了程式測試還是綠的。
 */
import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'

let pass = 0, fail = 0
const check = (title, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${title}${ok || !extra ? '' : `  ← ${extra}`}`)
  ok ? pass++ : fail++
}

// ── 從 live-ledger-notify.ts 抽出 pendingFindings 用的那段 SQL ───────────────
const src = readFileSync(join(process.cwd(), 'server', 'live-ledger-notify.ts'), 'utf-8')
const marker = 'export function pendingFindings'
const body = src.slice(src.indexOf(marker))
const sql = body.slice(body.indexOf('db.prepare(`') + 'db.prepare(`'.length, body.indexOf('`).all(env, watermark'))
check('抽得到 SQL（抽不到的話下面全是空跑）', sql.includes('recon_finding') && sql.includes('LEFT JOIN'))

const tmp = join(tmpdir(), `notify-join-${Date.now()}.db`)
const db = new Database(tmp)
try {
  db.exec(`
    CREATE TABLE recon_finding (id INTEGER PRIMARY KEY, env TEXT, line TEXT, severity TEXT,
      refType TEXT, refId TEXT, amountDelta REAL, detectedAt INTEGER, resolvedAt INTEGER,
      notifiedAt INTEGER, note TEXT, userLabel TEXT);
    CREATE TABLE recon_spin (id INTEGER PRIMARY KEY, env TEXT, machineType TEXT, gmid TEXT, spinSeq INTEGER);
    CREATE TABLE recon_backend_record (env TEXT, orderId TEXT, gmid TEXT, spinIndex INTEGER);
  `)
  // 陷阱本身：id=897 是「別台」的 spin，而局號開頭剛好也是 897
  db.prepare('INSERT INTO recon_spin (id, env, machineType, gmid, spinSeq) VALUES (897, ?, ?, ?, ?)')
    .run('qat', 'JJBXGOLD', '873-JJBXGOLD-1001', 78)
  db.prepare('INSERT INTO recon_spin (id, env, machineType, gmid, spinSeq) VALUES (12, ?, ?, ?, ?)')
    .run('qat', 'BIGFULINK', '897-BIGFULINK-2065', 41)

  const ins = db.prepare(`INSERT INTO recon_finding
    (env, line, severity, refType, refId, amountDelta, detectedAt, resolvedAt, notifiedAt, note, userLabel)
    VALUES ('qat', ?, 'warn', ?, ?, ?, 1000, NULL, NULL, '', '')`)
  for (const [i, oid] of ['897-BIGFULINK-2065|AAA', '897-BIGFULINK-2065|BBB'].entries()) {
    ins.run('unobserved', 'round', oid, 88)
    db.prepare('INSERT INTO recon_backend_record (env, orderId, gmid, spinIndex) VALUES (?, ?, ?, ?)')
      .run('qat', oid, '897-BIGFULINK-2065', 352 + i)
  }
  ins.run('l2_balance', 'spin', '12', -43)

  const rows = db.prepare(sql).all('qat', 0, 9_999_999_999, 50)
  check('三筆都查得到', rows.length === 3, `${rows.length}`)

  const round = rows.filter(r => r.refType === 'round')
  // 🚨 名稱要跟 spin 那側**統一**：後台給的是 gmid（897-BIGFULINK-2065），
  //    我們自己叫 BIGFULINK。不統一的話同一台會被算成兩台，標題寫「2 台」，
  //    看的人就會問「為什麼有包含其他的機器」——而其實一台都沒多。
  check('局號型的 finding 指到自己那台，而且用的是跟 spin 那側一樣的名稱',
    round.every(r => r.machineType === 'BIGFULINK'),
    round.map(r => r.machineType).join('、'))
  check('局號型的局數各自不同（重複就是又撈到同一筆無關資料）',
    new Set(round.map(r => r.spinSeq)).size === round.length,
    round.map(r => r.spinSeq).join('、'))
  check('局數取自後台 spin_index（352／353）',
    round.map(r => r.spinSeq).sort().join(',') === '352,353',
    round.map(r => r.spinSeq).join(','))

  const spin = rows.find(r => r.refType === 'spin')
  check('spin 型的 finding 仍然正常 join（BIGFULINK 第 41 局）',
    spin?.machineType === 'BIGFULINK' && spin?.spinSeq === 41,
    `${spin?.machineType}/${spin?.spinSeq}`)

  // 🚨 反例：舊查詢（無條件 CAST）在同一份資料上會怎樣
  const oldSql = sql
    .replace(/LEFT JOIN recon_spin s[\s\S]*?AND s\.env = f\.env/,
      'LEFT JOIN recon_spin s ON s.id = CAST(f.refId AS INTEGER) AND s.env = f.env')
    .replace(/LEFT JOIN recon_backend_record b[\s\S]*?AND b\.env = f\.env/,
      'LEFT JOIN recon_backend_record b ON 0')
  const oldRows = db.prepare(oldSql).all('qat', 0, 9_999_999_999, 50).filter(r => r.refType === 'round')
  check('（反例）舊查詢會把兩筆都指到 JJBXGOLD 第 78 局',
    oldRows.every(r => r.machineType === 'JJBXGOLD' && r.spinSeq === 78),
    oldRows.map(r => `${r.machineType}/${r.spinSeq}`).join('、'))
} finally {
  db.close()
  rmSync(tmp, { force: true })
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} 過 / ${fail} 失敗`)
assert.equal(fail, 0, '告警 finding join 檢查有失敗項')
