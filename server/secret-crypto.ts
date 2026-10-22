/**
 * 資料庫裡機密欄位的加密存放（AES-256-GCM）。
 *
 * 資安審查 2026-10-19：OpenAI／SLS key、後台帳密、對帳 token、webhook 等原本都是明文存在 data.db，
 * 拿到一份 DB（備份、主機、路徑穿越）就等於拿到全部憑證。
 *
 * 格式：
 *   - `v2:<kid>:<iv>:<tag>:<ct>`（v5.66.4 起）：kid＝金鑰指紋（sha256 前 8 碼），可以換金鑰
 *   - `v1:<iv>:<tag>:<ct>`（v5.66.0～5.66.3）：沒有 kid，解密時逐把試（GCM 驗證失敗就換下一把）
 *
 * 金鑰（都只放環境變數、32 bytes base64／hex、不進 DB）：
 *   - `SECRETS_KEY`：目前用來加密的那把（建議設，跟 Meegle 分開；一把外洩不會兩邊一起淪陷）
 *   - `SECRETS_KEYS_OLD`：換金鑰後的舊金鑰，逗號分隔，只拿來解密
 *   - `MEEGLE_TOKEN_KEY`：沒設 SECRETS_KEY 時沿用它加密（Spug 原本就有）；也一律拿來嘗試解密 v1
 * 換金鑰：把新的設成 SECRETS_KEY、舊的移到 SECRETS_KEYS_OLD → 重啟，啟動遷移會把所有密文重新加密成新金鑰，
 *        log 確認沒有舊金鑰的密文後才能拿掉 SECRETS_KEYS_OLD。
 *
 * 讀取：密文 → 解密（解不開一律丟錯，不回空字串）；其他 → 視為舊明文原樣回傳（遷移前的資料）
 * 寫入：沒金鑰（或格式不對）一律拒絕（CodeX 審 e621df1：不接受寫明文的退路）
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'

function parseKey(raw: string | undefined): Buffer | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  const buf = /^[0-9a-fA-F]{64}$/.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64')
  return buf.length === 32 ? buf : null
}

export const keyId = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 8)

function currentKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  return parseKey(env.SECRETS_KEY) ?? parseKey(env.MEEGLE_TOKEN_KEY)
}

/** 所有拿來解密的金鑰：目前那把＋舊金鑰＋MEEGLE_TOKEN_KEY（去重） */
function decryptKeys(env: NodeJS.ProcessEnv = process.env): Buffer[] {
  const list = [parseKey(env.SECRETS_KEY), ...String(env.SECRETS_KEYS_OLD ?? '').split(',').map(parseKey), parseKey(env.MEEGLE_TOKEN_KEY)]
  const seen = new Set<string>()
  const out: Buffer[] = []
  for (const k of list) if (k && !seen.has(keyId(k))) { seen.add(keyId(k)); out.push(k) }
  return out
}

export function secretKeyStatus(env: NodeJS.ProcessEnv = process.env): 'SECRETS_KEY' | 'MEEGLE_TOKEN_KEY' | 'missing' {
  if (parseKey(env.SECRETS_KEY)) return 'SECRETS_KEY'
  if (parseKey(env.MEEGLE_TOKEN_KEY)) return 'MEEGLE_TOKEN_KEY'
  return 'missing'
}

export function currentKeyId(env: NodeJS.ProcessEnv = process.env): string | null {
  const k = currentKey(env)
  return k ? keyId(k) : null
}

export function isEncryptedSecret(stored: unknown): boolean {
  if (typeof stored !== 'string') return false
  const parts = stored.split(':')
  return (parts[0] === 'v1' && parts.length === 4) || (parts[0] === 'v2' && parts.length === 5)
}

/** 已經是用「目前那把」加密的 v2 密文（遷移用來判斷要不要重新加密） */
export function isCurrentKeySecret(stored: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof stored !== 'string' || !isEncryptedSecret(stored)) return false
  const parts = stored.split(':')
  return parts[0] === 'v2' && parts[1] === currentKeyId(env)
}

/** 空字串／null 原樣回傳（代表「沒設定」）；已是目前金鑰的密文原樣回傳；沒金鑰時丟錯（不寫明文） */
export function encryptSecret(plain: string, env?: NodeJS.ProcessEnv): string
export function encryptSecret(plain: string | null | undefined, env?: NodeJS.ProcessEnv): string | null | undefined
export function encryptSecret(plain: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | null | undefined {
  if (plain === null || plain === undefined || plain === '') return plain
  if (isCurrentKeySecret(plain, env)) return plain
  const key = currentKey(env)
  if (!key) throw new Error('伺服器沒有設定 SECRETS_KEY／MEEGLE_TOKEN_KEY（或格式錯誤），為了不以明文存放，拒絕儲存這筆機密')
  // 舊格式或舊金鑰的密文：先解開再用目前金鑰重新加密（不重複包兩層）
  const value = isEncryptedSecret(plain) ? decryptSecret(plain, env) : plain
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return ['v2', keyId(key), iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':')
}

function tryDecrypt(key: Buffer, ivB64: string, tagB64: string, encB64: string): string | null {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(encB64, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

export function decryptSecret(stored: string, env?: NodeJS.ProcessEnv): string
export function decryptSecret(stored: string | null | undefined, env?: NodeJS.ProcessEnv): string | null | undefined
export function decryptSecret(stored: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | null | undefined {
  if (stored === null || stored === undefined || stored === '') return stored
  if (!isEncryptedSecret(stored)) return stored
  const keys = decryptKeys(env)
  if (!keys.length) throw new Error('資料庫裡的機密已加密，但伺服器沒有設定 SECRETS_KEY／MEEGLE_TOKEN_KEY，無法解密')
  const parts = stored.split(':')
  if (parts[0] === 'v2') {
    const [, kid, iv, tag, ct] = parts
    const key = keys.find(k => keyId(k) === kid)
    if (!key) throw new Error(`機密是用金鑰 ${kid} 加密的，但伺服器上沒有這把（換金鑰時要把舊的留在 SECRETS_KEYS_OLD）`)
    const out = tryDecrypt(key, iv, tag, ct)
    if (out === null) throw new Error('機密解密失敗（資料可能已損壞）')
    return out
  }
  const [, iv, tag, ct] = parts
  for (const key of keys) {
    const out = tryDecrypt(key, iv, tag, ct)
    if (out !== null) return out
  }
  throw new Error('機密解密失敗（金鑰可能換過，或資料已損壞）')
}

/** key/value 設定表（reconcile_config、meter_reconcile_config）裡哪些 key 是機密：token、password 結尾的 */
export function isSecretConfigKey(key: string): boolean {
  return /(^|_)(token|password)$/i.test(key)
}
