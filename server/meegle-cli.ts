/**
 * Meegle（飛書項目）CLI 的呼叫層。伺服器代表某個使用者操作 Meegle 時一律走這裡。
 *
 * ⚠️ 三條不能鬆的規則（2026-09-30 實測出來的，不是推論）：
 *
 * 1. **沒有 token 就不准呼叫。**不帶 token 時，CLI 會自己去作業系統的憑證庫
 *    （Windows 憑證管理員／macOS keychain）找之前 `meegle auth login` 留下的登入——
 *    實測把 HOME/APPDATA 全換成空目錄照樣找得到，**開出去的單會掛在那台主機登入者的名下**。
 *    所以 token 是必填參數，空字串直接丟錯，連子程序都不起。
 *    帶了 `MEEGLE_USER_ACCESS_TOKEN` 時 CLI 不碰憑證庫（README 寫的，也實測過：假 token
 *    得到的是「token rejected」而不是沿用主機登入）。
 *
 * 2. **不能看結束碼判斷成敗。**業務指令失敗時結束碼常常仍是 0，錯誤在輸出的 JSON 裡；
 *    假 token 打 `user me` 甚至只會印 `unknown command "user"`（命令清單是用 token 從伺服器
 *    動態抓的，抓不到就沒有這個指令）。所以驗證身分先跑 `auth status`——它的結束碼是有契約的：
 *    0＝有效、1＝token 被拒、2＝連不上伺服器。
 *
 * 3. **連不上 ≠ token 失效。**逾時、斷網、5xx 一律歸成 `unavailable`，
 *    呼叫端不能因此把綁定標成失效（CodeX review）。
 *
 * 環境隔離：子程序只拿到這裡組出來的環境變數（不繼承 process.env），HOME 指到獨立的暫存目錄，
 * 避免讀到主機使用者的 `~/.meegle/config.json`；host 固定，不讓設定檔或環境改走別的站台。
 */
import { spawn } from 'child_process'
import { mkdirSync } from 'fs'
import { createRequire } from 'module'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

export const MEEGLE_HOST = 'project.larksuite.com'
const TOKEN_HEADER = 'X-Mcp-Token'
const DEFAULT_TIMEOUT_MS = 30_000

export type MeegleErrorCode =
  | 'NO_TOKEN'        // 呼叫端沒給 token（程式錯誤，不該發生）
  | 'TOKEN_INVALID'   // 伺服器明確拒絕這組 token
  | 'UNAVAILABLE'     // 連不上／逾時／伺服器錯誤——暫時性，不代表 token 壞掉
  | 'CLI_MISSING'     // 這台主機沒有 CLI 執行檔
  | 'UNEXPECTED'      // 輸出看不懂

export class MeegleCliError extends Error {
  constructor(public code: MeegleErrorCode, message: string) { super(message) }
}

export type CliResult = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }

/** 找這個平台的 CLI 執行檔。直接跑執行檔，不經 bin/meegle.js（那支會做更新檢查、互動提示）。 */
export function resolveMeegleBinary(): string {
  const require = createRequire(import.meta.url)
  let pkgDir: string
  try {
    pkgDir = dirname(require.resolve('@lark-project/meegle/package.json'))
  } catch {
    throw new MeegleCliError('CLI_MISSING', '伺服器沒有安裝 Meegle CLI（@lark-project/meegle）')
  }
  const ext = process.platform === 'win32' ? '.exe' : ''
  return join(pkgDir, 'bin', `meegle-${process.platform}-${process.arch}${ext}`)
}

/** 把輸出裡出現的 token 遮掉——CLI 的錯誤訊息理論上不會回顯 token，但日誌遮罩不能靠「理論上」。 */
export function scrubToken(text: string, token: string): string {
  if (!token) return text
  return text.split(token).join('***')
}

function isolatedHome(): string {
  const dir = join(tmpdir(), 'toppath-meegle-home')
  mkdirSync(dir, { recursive: true })
  return dir
}

function buildEnv(token: string): NodeJS.ProcessEnv {
  const home = isolatedHome()
  const env: NodeJS.ProcessEnv = {
    MEEGLE_HOST,
    MEEGLE_ACCESS_TOKEN_HEADER: TOKEN_HEADER,
    MEEGLE_USER_ACCESS_TOKEN: token,
    MEEGLE_NO_UPDATE_CHECK: '1',
    MEEGLE_AI_HANDOFF: 'disabled',
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home,
    TMPDIR: tmpdir(),
    TEMP: tmpdir(),
    TMP: tmpdir(),
  }
  // 子程序要能解析 DNS／載入系統 DLL，這幾個不含任何身分資訊
  for (const k of ['PATH', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']) {
    if (process.env[k]) env[k] = process.env[k]
  }
  return env
}

function killTree(pid: number) {
  if (process.platform === 'win32') {
    // Windows 上 child.kill() 殺不掉孫程序，逾時會卡住（見 memory：Windows subprocess 逾時會卡死）
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try { process.kill(pid, 'SIGKILL') } catch { /* 已經結束 */ }
  }
}

/** 用某個使用者的 token 跑一次 CLI。token 為空一律拒絕，不起子程序。 */
export function runMeegle(args: string[], token: string, opts: { timeoutMs?: number; binary?: string } = {}): Promise<CliResult> {
  if (!token || !token.trim()) {
    return Promise.reject(new MeegleCliError('NO_TOKEN', '沒有 Meegle token，拒絕呼叫（否則 CLI 會沿用主機上的登入）'))
  }
  const binary = opts.binary ?? resolveMeegleBinary()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    // 找不到執行檔等啟動錯誤會從 'error' 事件出來，不是同步丟例外
    const child = spawn(binary, args, { env: buildEnv(token.trim()), windowsHide: true })
    let stdout = '', stderr = '', timedOut = false, settled = false
    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid) killTree(child.pid)
    }, timeoutMs)
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new MeegleCliError(e.code === 'ENOENT' ? 'CLI_MISSING' : 'UNAVAILABLE', `Meegle CLI 執行失敗：${e.message}`))
    })
    child.on('close', (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode: code, stdout: scrubToken(stdout, token), stderr: scrubToken(stderr, token), timedOut })
    })
  })
}

export type AuthStatusVerdict =
  | { ok: true }
  | { ok: false; code: 'TOKEN_INVALID' | 'UNAVAILABLE' | 'UNEXPECTED'; reason: string }

/**
 * 解讀 `meegle auth status --format json`。純函式，分類規則在這裡、測試也打這裡。
 * 結束碼契約（README）：0 有效／1 本地沒 token 或 token 被拒／2 連不上伺服器。
 */
export function classifyAuthStatus(r: CliResult): AuthStatusVerdict {
  if (r.timedOut) return { ok: false, code: 'UNAVAILABLE', reason: '驗證逾時' }
  let reason = ''
  let authenticated: unknown
  try {
    const j = JSON.parse(r.stdout) as { authenticated?: unknown; reason?: unknown }
    authenticated = j.authenticated
    reason = typeof j.reason === 'string' ? j.reason : ''
  } catch { /* 下面按結束碼判斷 */ }
  if (r.exitCode === 0 && authenticated === true) return { ok: true }
  if (r.exitCode === 2 || /server unreachable/i.test(reason)) {
    return { ok: false, code: 'UNAVAILABLE', reason: reason || '連不上 Meegle 伺服器' }
  }
  if (r.exitCode === 1 && /token rejected/i.test(reason)) {
    return { ok: false, code: 'TOKEN_INVALID', reason: 'Meegle 拒絕了這組 token（無效、已重置或已過期）' }
  }
  // 結束碼 1 但原因不是「被拒」（例如 no local token）——對我們來說代表 token 沒帶到，不是使用者的 token 壞了
  return { ok: false, code: 'UNEXPECTED', reason: reason || `無法判讀驗證結果（結束碼 ${r.exitCode}）` }
}

export type MeegleIdentity = { userKey: string; email: string; name: string }

/** 解讀 `meegle user me --format json --envelope`。拿不到 user_key 就視為看不懂，不猜。 */
export function parseUserMe(r: CliResult): { ok: true; identity: MeegleIdentity } | { ok: false; code: 'UNAVAILABLE' | 'UNEXPECTED'; reason: string } {
  if (r.timedOut) return { ok: false, code: 'UNAVAILABLE', reason: '查詢身分逾時' }
  try {
    const j = JSON.parse(r.stdout) as {
      data?: { user_key?: unknown; email?: unknown; name_cn?: unknown; name_en?: unknown } | null
      error?: { code?: unknown; message?: unknown; retryable?: unknown } | null
    }
    if (j.error) {
      const retryable = j.error.retryable === true
      return { ok: false, code: retryable ? 'UNAVAILABLE' : 'UNEXPECTED', reason: String(j.error.message ?? j.error.code ?? '查詢身分失敗') }
    }
    const d = j.data
    if (d && typeof d.user_key === 'string' && d.user_key) {
      const name = [d.name_cn, d.name_en].find(v => typeof v === 'string' && v) as string | undefined
      return { ok: true, identity: { userKey: d.user_key, email: typeof d.email === 'string' ? d.email : '', name: name ?? '' } }
    }
  } catch { /* 落到下面 */ }
  return { ok: false, code: 'UNEXPECTED', reason: `無法判讀身分查詢結果：${(r.stdout || r.stderr).slice(0, 200)}` }
}

export type VerifyTokenResult =
  | { ok: true; identity: MeegleIdentity }
  | { ok: false; code: MeegleErrorCode; reason: string }

/** 驗證一組 token：先確認伺服器接受，再查它代表誰。 */
export async function verifyMeegleToken(token: string, opts: { binary?: string; timeoutMs?: number } = {}): Promise<VerifyTokenResult> {
  try {
    // 用 `in` 縮小型別：server 的 tsconfig 沒開 strictNullChecks，`x.ok` 判斷不會縮小聯集
    const auth = classifyAuthStatus(await runMeegle(['auth', 'status', '--format', 'json'], token, opts))
    if ('code' in auth) return { ok: false, code: auth.code, reason: auth.reason }
    const me = parseUserMe(await runMeegle(['user', 'me', '--format', 'json', '--envelope'], token, opts))
    if ('code' in me) return { ok: false, code: me.code, reason: me.reason }
    return { ok: true, identity: me.identity }
  } catch (e) {
    if (e instanceof MeegleCliError) return { ok: false, code: e.code, reason: e.message }
    return { ok: false, code: 'UNAVAILABLE', reason: (e as Error).message }
  }
}
