/**
 * 資料庫裡機密欄位的加密存放（AES-256-GCM，格式 `v1:iv:tag:ct`，跟 meegle-token-crypto 同一套）。
 *
 * 資安審查 2026-10-19：OpenAI／SLS key、後台帳密、對帳 token、webhook 等原本都是明文存在 data.db，
 * 拿到一份 DB（備份、主機、路徑穿越）就等於拿到全部憑證。
 *
 * 金鑰：`SECRETS_KEY`，沒設就用 `MEEGLE_TOKEN_KEY`（兩者都是 32 bytes base64／hex、只放環境變數、不進 DB）。
 * 沿用 MEEGLE_TOKEN_KEY 是為了部署時不用先補新的環境變數——它在 Spug 上本來就有。
 * ⚠️ 換金鑰＝已加密的值全部解不開（要重新輸入）。要換請先寫重新加密的遷移。
 *
 * 讀取規則：
 * - `v1:` 開頭 → 解密；解不開（金鑰換過／資料壞掉）一律丟錯，不回空字串
 *   （空字串會被當成「沒設定」往下走，看不出是壞掉）
 * - 其他 → 視為舊的明文原樣回傳（遷移前的資料、或沒設金鑰時寫進去的）
 *
 * 寫入規則：有金鑰就加密；**沒金鑰（或格式不對）一律拒絕寫入**，丟錯讓畫面看得到原因。
 * 原本是「寫明文＋啟動時警告」，CodeX 審 e621df1 不接受用在正式環境：退路一旦生效就沒人會發現
 * DB 又變回明文。讀取仍相容舊明文（遷移前的資料）。
 * 啟動時 `secretKeyStatus()` 會印出目前是哪一種，部署後看 log 就知道有沒有生效。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const PREFIX = 'v1'

function parseKey(raw: string | undefined): Buffer | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  const buf = /^[0-9a-fA-F]{64}$/.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64')
  return buf.length === 32 ? buf : null
}

function currentKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  return parseKey(env.SECRETS_KEY) ?? parseKey(env.MEEGLE_TOKEN_KEY)
}

export function secretKeyStatus(env: NodeJS.ProcessEnv = process.env): 'SECRETS_KEY' | 'MEEGLE_TOKEN_KEY' | 'missing' {
  if (parseKey(env.SECRETS_KEY)) return 'SECRETS_KEY'
  if (parseKey(env.MEEGLE_TOKEN_KEY)) return 'MEEGLE_TOKEN_KEY'
  return 'missing'
}

export function isEncryptedSecret(stored: unknown): boolean {
  return typeof stored === 'string' && stored.startsWith(`${PREFIX}:`) && stored.split(':').length === 4
}

/** 空字串／null 原樣回傳（代表「沒設定」）；沒金鑰時丟錯（不寫明文）。 */
export function encryptSecret(plain: string, env?: NodeJS.ProcessEnv): string
export function encryptSecret(plain: string | null | undefined, env?: NodeJS.ProcessEnv): string | null | undefined
export function encryptSecret(plain: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | null | undefined {
  if (plain === null || plain === undefined || plain === '') return plain
  if (isEncryptedSecret(plain)) return plain // 不重複加密
  const key = currentKey(env)
  if (!key) throw new Error('伺服器沒有設定 SECRETS_KEY／MEEGLE_TOKEN_KEY（或格式錯誤），為了不以明文存放，拒絕儲存這筆機密')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [PREFIX, iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':')
}

export function decryptSecret(stored: string, env?: NodeJS.ProcessEnv): string
export function decryptSecret(stored: string | null | undefined, env?: NodeJS.ProcessEnv): string | null | undefined
export function decryptSecret(stored: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | null | undefined {
  if (stored === null || stored === undefined || stored === '') return stored
  if (!isEncryptedSecret(stored)) return stored
  const key = currentKey(env)
  if (!key) throw new Error('資料庫裡的機密已加密，但伺服器沒有設定 SECRETS_KEY／MEEGLE_TOKEN_KEY，無法解密')
  const [, ivB64, tagB64, encB64] = stored.split(':')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  try {
    return Buffer.concat([decipher.update(Buffer.from(encB64, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('機密解密失敗（金鑰可能換過，或資料已損壞）')
  }
}

/** key/value 設定表（reconcile_config、meter_reconcile_config）裡哪些 key 是機密：token、password 結尾的 */
export function isSecretConfigKey(key: string): boolean {
  return /(^|_)(token|password)$/i.test(key)
}
