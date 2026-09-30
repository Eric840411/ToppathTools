/**
 * Meegle 綁定的測試。跑法：npx tsx server/meegle.test.ts
 *
 * 前半是純函式（分類／身分判斷／加密），後半打**真的 CLI**：
 * - 假 token 必須被判成 TOKEN_INVALID——**不能**沿用這台主機上 `meegle auth login` 的登入
 *   （實測：不帶 token 時 CLI 會自己去憑證庫拿主機登入，開出去的單會掛別人名下）
 * - 連不上時必須是 UNAVAILABLE，不能是 TOKEN_INVALID
 * 真 CLI 那段需要網路；沒有 CLI 執行檔的機器會標 SKIP，不會假裝通過。
 */
import { classifyAuthStatus, parseUserMe, runMeegle, scrubToken, verifyMeegleToken, MeegleCliError, type CliResult } from './meegle-cli.js'
import { decideIdentity, nextStatusAfterVerify } from './meegle-binding-rules.js'
import { decryptMeegleToken, encryptMeegleToken, isMeegleKeyConfigured } from './meegle-token-crypto.js'

let pass = 0
const fails: string[] = []
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) }
  else { fails.push(`${name} | got: ${g} | want: ${w}`); console.log(`❌ ${name} | got: ${g} | want: ${w}`) }
}
const cli = (exitCode: number | null, stdout: string, timedOut = false): CliResult => ({ exitCode, stdout, stderr: '', timedOut })

// ── auth status 分類（輸出取自 2026-09-30 實測）──
eq('有效', classifyAuthStatus(cli(0, '{"authenticated":true,"expires_in_minutes":119,"host":"project.larksuite.com"}')), { ok: true })
eq('token 被拒 → TOKEN_INVALID', classifyAuthStatus(cli(1, '{"authenticated":false,"host":"project.larksuite.com","reason":"token rejected by server"}')).ok === false
  && (classifyAuthStatus(cli(1, '{"authenticated":false,"reason":"token rejected by server"}')) as { code: string }).code, 'TOKEN_INVALID')
eq('連不上 → UNAVAILABLE（不能當成失效）', (classifyAuthStatus(cli(2, '{"authenticated":false,"reason":"server unreachable: dial tcp: no such host"}')) as { code: string }).code, 'UNAVAILABLE')
eq('逾時 → UNAVAILABLE', (classifyAuthStatus(cli(null, '', true)) as { code: string }).code, 'UNAVAILABLE')
eq('結束碼 1 但不是被拒（no local token）→ 不能標成使用者 token 失效', (classifyAuthStatus(cli(1, '{"authenticated":false,"reason":"no local token"}')) as { code: string }).code, 'UNEXPECTED')
eq('結束碼 0 但 authenticated 不是 true → 不算有效', classifyAuthStatus(cli(0, '{"authenticated":false}')).ok, false)
eq('看不懂的輸出 → 不算有效', classifyAuthStatus(cli(0, 'garbage')).ok, false)

// ── user me ──
const meOk = '{"data":{"email":"eric.wu@toppath.tw","name_cn":"Eric","name_en":"Eric","user_key":"7399589791446188037"},"error":null,"meta":{}}'
eq('user me 解析', parseUserMe(cli(0, meOk)), { ok: true, identity: { userKey: '7399589791446188037', email: 'eric.wu@toppath.tw', name: 'Eric' } })
eq('user me 結束碼 0 但 error 有值 → 不算成功', parseUserMe(cli(0, '{"data":null,"error":{"code":"UNKNOWN","message":"x","retryable":false}}')).ok, false)
eq('可重試錯誤 → UNAVAILABLE', (parseUserMe(cli(0, '{"data":null,"error":{"code":"X","message":"x","retryable":true}}')) as { code: string }).code, 'UNAVAILABLE')
eq('假 token 時 CLI 印 unknown command → 看不懂，不是成功', parseUserMe(cli(0, 'unknown command "user" for "meegle"')).ok, false)
eq('沒有 user_key → 不猜', parseUserMe(cli(0, '{"data":{"email":"a@b"},"error":null}')).ok, false)

// ── 遮罩 ──
eq('輸出裡的 token 被遮掉', scrubToken('bad token abc123xyz here abc123xyz', 'abc123xyz'), 'bad token *** here ***')

// ── 身分判斷 ──
eq('email 相同（大小寫不同）→ 本人', decideIdentity('Eric.Wu@toppath.tw', { email: 'eric.wu@toppath.tw', userKey: '1' }, null), { ok: true, via: 'email' })
eq('email 不同、沒有對照 → 拒絕', decideIdentity('a@toppath.tw', { email: 'b@toppath.tw', userKey: '1' }, null).ok, false)
eq('email 不同、有對照且 user_key 相符 → 通過', decideIdentity('a@toppath.tw', { email: 'b@x.com', userKey: '42' }, '42'), { ok: true, via: 'override' })
eq('email 不同、對照的 user_key 不符 → 拒絕', decideIdentity('a@toppath.tw', { email: 'b@x.com', userKey: '42' }, '43').ok, false)
eq('Meegle 沒回 email、沒有對照 → 拒絕（不把第一次貼的當本人）', decideIdentity('a@toppath.tw', { email: '', userKey: '42' }, null).ok, false)
eq('兩邊都空 email 不能算相同', decideIdentity('', { email: '', userKey: '42' }, null).ok, false)

// ── 重新驗證後的狀態 ──
eq('驗證成功 → valid', nextStatusAfterVerify('invalid', { ok: true, userKey: '1' }, '1'), { status: 'valid', code: null })
eq('token 被拒 → invalid', nextStatusAfterVerify('valid', { ok: false, code: 'TOKEN_INVALID' }, '1'), { status: 'invalid', code: 'TOKEN_INVALID' })
eq('連不上 → 維持 valid（不能把大家登出）', nextStatusAfterVerify('valid', { ok: false, code: 'UNAVAILABLE' }, '1'), { status: 'valid', code: 'UNAVAILABLE' })
eq('看不懂 → 維持原狀', nextStatusAfterVerify('valid', { ok: false, code: 'UNEXPECTED' }, '1'), { status: 'valid', code: 'UNEXPECTED' })
eq('token 變成別人 → invalid', nextStatusAfterVerify('valid', { ok: true, userKey: '2' }, '1'), { status: 'invalid', code: 'IDENTITY_CHANGED' })

// ── 加密 ──
const env = { MEEGLE_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64') } as NodeJS.ProcessEnv
const env2 = { MEEGLE_TOKEN_KEY: Buffer.alloc(32, 8).toString('base64') } as NodeJS.ProcessEnv
const enc = encryptMeegleToken('secret-token-123', env)
eq('密文不含明文', enc.includes('secret-token-123'), false)
eq('加解密來回', decryptMeegleToken(enc, env), 'secret-token-123')
eq('同一明文兩次加密結果不同（隨機 IV）', encryptMeegleToken('x', env) !== encryptMeegleToken('x', env), true)
const throws = (f: () => unknown) => { try { f(); return false } catch { return true } }
eq('換金鑰解不開 → 丟錯（不能回空字串）', throws(() => decryptMeegleToken(enc, env2)), true)
eq('密文被竄改 → 丟錯', throws(() => decryptMeegleToken(enc.slice(0, -4) + 'AAAA', env)), true)
eq('沒設金鑰 → 不准加密（不退回明文）', throws(() => encryptMeegleToken('x', {} as NodeJS.ProcessEnv)), true)
eq('金鑰長度不對 → 視為未設定', isMeegleKeyConfigured({ MEEGLE_TOKEN_KEY: 'c2hvcnQ=' } as NodeJS.ProcessEnv), false)
eq('hex 金鑰可用', isMeegleKeyConfigured({ MEEGLE_TOKEN_KEY: 'ab'.repeat(32) } as NodeJS.ProcessEnv), true)

// ── 空 token：連子程序都不能起 ──
const noToken = await runMeegle(['auth', 'status'], '   ', { binary: 'Z:/definitely/not/here.exe' }).then(() => 'resolved', (e: unknown) => (e as MeegleCliError).code)
eq('空 token → NO_TOKEN，不起子程序', noToken, 'NO_TOKEN')

// ── 真的 CLI ──
let binaryOk = true
try { (await import('./meegle-cli.js')).resolveMeegleBinary() } catch { binaryOk = false }
if (!binaryOk) {
  console.log('⏭️  SKIP 真 CLI 測試：這台機器沒有 @lark-project/meegle')
} else {
  const bogus = await verifyMeegleToken('bogus-token-for-test')
  eq('🔒 真 CLI：假 token → TOKEN_INVALID（沒有沿用主機登入）', bogus.ok ? `ok:${bogus.identity.email}` : bogus.code, 'TOKEN_INVALID')
  const prevProxy = process.env.HTTPS_PROXY
  process.env.HTTPS_PROXY = 'http://127.0.0.1:9'   // 沒人聽的 port，模擬斷網
  const offline = await verifyMeegleToken('bogus-token-for-test', { timeoutMs: 20_000 })
  if (prevProxy === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = prevProxy
  eq('真 CLI：連不上 → UNAVAILABLE（不能判成 token 失效）', offline.ok ? 'ok' : offline.code, 'UNAVAILABLE')
  const missing = await verifyMeegleToken('x', { binary: 'Z:/definitely/not/here.exe' })
  eq('執行檔不存在 → CLI_MISSING', missing.ok ? 'ok' : missing.code, 'CLI_MISSING')
}

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) { console.log(fails.join('\n')); process.exit(1) }
