/**
 * Meegle 綁定的併發測試（CodeX review ff1fb71 的三個 [P2]）。跑法：npx tsx server/meegle-race.test.ts
 *
 * 用記憶體 DB ＋「手動放行」的假驗證，控制每個請求的回應順序，重現：
 *   ① 驗證途中解除再重綁 → 舊驗證結果不能把新綁定標失效（原本版本號會重用）
 *   ② 換 token 途中另一個分頁解除 → 舊請求回來不能把憑證寫回去（綁定復活）
 *   ③ 兩次驗證同時讀到 valid，先回 TOKEN_INVALID、後回 UNAVAILABLE → 不能被寫回 valid
 */
import Database from 'better-sqlite3'
import { bindAccount, getAccountRow, initMeegleSchema, unbindAccount, verifyAccount } from './meegle-account-service.js'
import type { VerifyTokenResult } from './meegle-cli.js'

let pass = 0
const fails: string[] = []
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) }
  else { fails.push(`${name} | got: ${g} | want: ${w}`); console.log(`❌ ${name} | got: ${g} | want: ${w}`) }
}

const EMAIL = 'dean@toppath.tw'
const ok = (userKey = '111'): VerifyTokenResult => ({ ok: true, identity: { userKey, email: EMAIL, name: 'Dean' } })
const invalid: VerifyTokenResult = { ok: false, code: 'TOKEN_INVALID', reason: 'rejected' }
const unavailable: VerifyTokenResult = { ok: false, code: 'UNAVAILABLE', reason: 'timeout' }

/** 每呼叫一次 verify 就排一個等待中的請求，測試用 release(i, 結果) 決定它何時、回什麼 */
function gatedVerifier() {
  const pending: { token: string; resolve: (r: VerifyTokenResult) => void }[] = []
  return {
    verify: (token: string) => new Promise<VerifyTokenResult>(resolve => { pending.push({ token, resolve }) }),
    release: (i: number, r: VerifyTokenResult) => pending[i].resolve(r),
    count: () => pending.length,
  }
}
const instant = (r: VerifyTokenResult) => ({ verify: async () => r })
const enc = (t: string) => `enc:${t}`
const dec = (s: string) => s.replace(/^enc:/, '')
const tick = () => new Promise(r => setImmediate(r))
const freshDb = () => { const db = new Database(':memory:'); initMeegleSchema(db); return db }

// ── ① 驗證途中解除再重綁 ──
{
  const db = freshDb()
  await bindAccount(db, EMAIL, 'token-A', { ...instant(ok()), encrypt: enc })
  const g = gatedVerifier()
  const pendingVerify = verifyAccount(db, EMAIL, { verify: g.verify, decrypt: dec })   // 用 token-A 驗證中…
  await tick()
  unbindAccount(db, EMAIL)
  await bindAccount(db, EMAIL, 'token-B', { ...instant(ok()), encrypt: enc })         // 重綁新 token
  g.release(0, invalid)                                                                 // 舊 token-A 的結果回來：被拒
  await pendingVerify
  const row = getAccountRow(db, EMAIL)!
  eq('① 舊驗證結果不能把重綁後的新綁定標失效', row.status, 'valid')
  eq('① 新綁定的 token 還在', dec(row.token_enc), 'token-B')
}

// ── ② 換 token 途中另一個分頁解除 ──
{
  const db = freshDb()
  await bindAccount(db, EMAIL, 'token-A', { ...instant(ok()), encrypt: enc })
  const g = gatedVerifier()
  const pendingBind = bindAccount(db, EMAIL, 'token-B', { verify: g.verify, encrypt: enc })   // 換 token，等 CLI…
  await tick()
  unbindAccount(db, EMAIL)                                                                     // 另一個分頁解除
  g.release(0, ok())
  const r = await pendingBind
  eq('② 解除後舊的換 token 請求被拒（CONFLICT）', 'code' in r ? r.code : 'ok', 'CONFLICT')
  eq('② 憑證沒有復活', getAccountRow(db, EMAIL) ?? null, null)
}

// ── ② 變形：第一次綁定途中，另一個分頁先綁好了 ──
{
  const db = freshDb()
  const g = gatedVerifier()
  const slow = bindAccount(db, EMAIL, 'token-A', { verify: g.verify, encrypt: enc })
  await tick()
  await bindAccount(db, EMAIL, 'token-B', { ...instant(ok()), encrypt: enc })
  g.release(0, ok())
  const r = await slow
  eq('②b 慢的那次不能蓋掉已經綁好的', 'code' in r ? r.code : 'ok', 'CONFLICT')
  eq('②b 留下的是先完成的 token-B', dec(getAccountRow(db, EMAIL)!.token_enc), 'token-B')
}

// ── ③ 暫時錯誤不能蓋掉失效 ──
{
  const db = freshDb()
  await bindAccount(db, EMAIL, 'token-A', { ...instant(ok()), encrypt: enc })
  const g = gatedVerifier()
  const v1 = verifyAccount(db, EMAIL, { verify: g.verify, decrypt: dec })
  const v2 = verifyAccount(db, EMAIL, { verify: g.verify, decrypt: dec })   // 兩個都讀到 valid
  await tick()
  g.release(0, invalid);     await v1
  eq('③ 先回的 TOKEN_INVALID 標成失效', getAccountRow(db, EMAIL)!.status, 'invalid')
  g.release(1, unavailable); await v2
  const row = getAccountRow(db, EMAIL)!
  eq('③ 後回的 UNAVAILABLE 不能寫回 valid', row.status, 'invalid')
  eq('③ 失效原因不能被「逾時」蓋掉', row.last_check_code, 'TOKEN_INVALID')
}

// ── 基本行為（確認重構沒有弄壞）──
{
  const db = freshDb()
  const r1 = await bindAccount(db, EMAIL, 'bad', { ...instant(invalid), encrypt: enc })
  eq('綁定失敗不寫入', getAccountRow(db, EMAIL) ?? null, null)
  eq('綁定失敗回 TOKEN_INVALID', 'code' in r1 ? r1.code : 'ok', 'TOKEN_INVALID')
  await bindAccount(db, EMAIL, 'token-A', { ...instant(ok()), encrypt: enc })
  await bindAccount(db, EMAIL, 'bad2', { ...instant(invalid), encrypt: enc })
  eq('換 token 失敗，舊綁定不動', dec(getAccountRow(db, EMAIL)!.token_enc), 'token-A')
  await verifyAccount(db, EMAIL, { ...instant(unavailable), decrypt: dec })
  const row = getAccountRow(db, EMAIL)!
  eq('連不上 → 維持 valid、記錄這次嘗試', [row.status, row.last_check_code], ['valid', 'UNAVAILABLE'])
  await verifyAccount(db, EMAIL, { ...instant(ok()), decrypt: dec })
  eq('之後驗證成功 → 清掉錯誤碼', getAccountRow(db, EMAIL)!.last_check_code, null)
  await verifyAccount(db, EMAIL, { verify: async () => ok(), decrypt: () => { throw new Error('bad key') } })
  eq('解不開 → 失效 DECRYPT_FAILED', [getAccountRow(db, EMAIL)!.status, getAccountRow(db, EMAIL)!.last_check_code], ['invalid', 'DECRYPT_FAILED'])
  const other = await bindAccount(db, 'other@toppath.tw', 'token-X', { ...instant(ok('111')), encrypt: enc })
  eq('同一個 Meegle 帳號不能綁兩個工具帳號（email 不同會先被身分檢查擋下）', 'code' in other ? other.code : 'ok', 'IDENTITY_MISMATCH')
  db.prepare('INSERT INTO meegle_identity_overrides (login_email, meegle_user_key, created_by, created_at) VALUES (?, ?, ?, ?)').run('other@toppath.tw', '111', 'admin', 0)
  const other2 = await bindAccount(db, 'other@toppath.tw', 'token-X', { ...instant(ok('111')), encrypt: enc })
  eq('就算有對照，已被別人綁的 Meegle 帳號也不能再綁', 'code' in other2 ? other2.code : 'ok', 'ALREADY_BOUND_ELSEWHERE')
}

// ── 舊表遷移（v4.262.0 的 token_version → rev）──
{
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE meegle_accounts (email TEXT PRIMARY KEY, token_enc TEXT NOT NULL, meegle_user_key TEXT NOT NULL, meegle_email TEXT NOT NULL DEFAULT '',
    meegle_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, token_version INTEGER NOT NULL, bound_at INTEGER NOT NULL,
    last_verified_at INTEGER, last_checked_at INTEGER, last_check_code TEXT, last_check_reason TEXT)`)
  db.prepare(`INSERT INTO meegle_accounts VALUES ('a@x', 'enc:t', '9', '', '', 'valid', 3, 1, 1, 1, NULL, NULL)`).run()
  initMeegleSchema(db)
  initMeegleSchema(db)   // 重跑兩次不能出事
  const cols = (db.prepare('PRAGMA table_info(meegle_accounts)').all() as { name: string }[]).map(c => c.name)
  eq('遷移：token_version 拿掉、rev 補上', [cols.includes('token_version'), cols.includes('rev')], [false, true])
  const row = db.prepare('SELECT rev FROM meegle_accounts').get() as { rev: string | null }
  const revRow = db.prepare('SELECT rev FROM meegle_account_revs WHERE email = ?').get('a@x') as { rev: string } | undefined
  eq('遷移：既有綁定拿到 rev，且跟 revs 表一致', !!row.rev && row.rev === revRow?.rev, true)
}

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) { console.log(fails.join('\n')); process.exit(1) }
