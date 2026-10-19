/**
 * PIN 雜湊／升級／鎖定的回歸。跑法：npx tsx server/pin-hash.test.ts
 */
import Database from 'better-sqlite3'
import { createHash } from 'crypto'
import {
  hashPin, verifyPin, isLegacyPinHash, upgradeLegacyPinHashes, safeEqualString,
  pinLockRemaining, recordPinFailure, recordPinSuccess, _resetPinFailures,
} from './pin-hash.js'

let pass = 0
const fails: string[] = []
function ok(name: string, cond: boolean, detail = '') {
  if (cond) pass++
  else fails.push(`${name}${detail ? ': ' + detail : ''}`)
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

const h = hashPin('1234')
ok('新格式', h.startsWith('scrypt$'))
ok('不是舊格式', !isLegacyPinHash(h))
ok('同 PIN 兩次雜湊不同（有鹽）', hashPin('1234') !== h)
ok('對的 PIN', verifyPin(h, '1234'))
ok('錯的 PIN', !verifyPin(h, '1235'))
ok('空雜湊', !verifyPin('', '1234') && !verifyPin(null, '1234'))
ok('壞格式', !verifyPin('scrypt$xx', '1234') && !verifyPin('md5$a$b', '1234'))
ok('舊 sha256 仍能驗', verifyPin(sha('9999'), '9999') && !verifyPin(sha('9999'), '9998'))

const db = new Database(':memory:')
db.exec(`CREATE TABLE jira_accounts (email TEXT PRIMARY KEY, pin_hash TEXT)`)
db.prepare('INSERT INTO jira_accounts VALUES (?, ?)').run('a@x', sha('1111'))
db.prepare('INSERT INTO jira_accounts VALUES (?, ?)').run('b@x', null)
db.prepare('INSERT INTO jira_accounts VALUES (?, ?)').run('c@x', hashPin('3333'))
const n = upgradeLegacyPinHashes(db)
const get = (e: string) => (db.prepare('SELECT pin_hash p FROM jira_accounts WHERE email=?').get(e) as { p: string | null }).p
ok('只升級舊的那筆', n === 1, String(n))
ok('升級後是 scrypt', String(get('a@x')).startsWith('scrypt$'))
ok('升級後原 PIN 照樣能登入', verifyPin(get('a@x'), '1111'))
ok('升級後錯 PIN 不行', !verifyPin(get('a@x'), '1112'))
ok('沒 PIN 的沒動', get('b@x') === null)
ok('再跑一次不動', upgradeLegacyPinHashes(db) === 0)

ok('safeEqual 相同', safeEqualString('abc', 'abc'))
ok('safeEqual 不同', !safeEqualString('abc', 'abd') && !safeEqualString('abc', 'abcd'))

_resetPinFailures()
const t0 = 1_000_000
for (let i = 0; i < 4; i++) recordPinFailure('A@x', t0)
ok('4 次還沒鎖', pinLockRemaining('a@x', t0) === 0)
recordPinFailure('a@x', t0)
ok('第 5 次鎖住', pinLockRemaining('a@x', t0) > 0)
ok('鎖 5 分鐘後解開', pinLockRemaining('a@x', t0 + 5 * 60_000 + 1) === 0)
ok('別的帳號不受影響', pinLockRemaining('b@x', t0) === 0)
recordPinFailure('c@x', t0); recordPinSuccess('c@x')
for (let i = 0; i < 4; i++) recordPinFailure('c@x', t0)
ok('成功後計數歸零', pinLockRemaining('c@x', t0) === 0)

console.log(`pin-hash: ${pass} pass, ${fails.length} fail`)
if (fails.length) { for (const f of fails) console.log('  FAIL', f); process.exit(1) }
