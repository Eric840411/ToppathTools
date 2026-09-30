/**
 * Meegle 個人 token 的加密存放（AES-256-GCM）。
 *
 * 金鑰只從環境變數 `MEEGLE_TOKEN_KEY` 讀（32 bytes，base64 或 64 字元 hex），**不進資料庫**——
 * 資料庫外流時 token 仍是密文（CodeX review）。沒設金鑰時一律 fail closed：
 * 不退回明文存放，綁定功能直接回「伺服器未設定金鑰」。
 *
 * 產生金鑰：`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
 * ⚠️ 換金鑰＝所有既有綁定都解不開，使用者要重新綁定。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const PREFIX = 'v1'

function parseKey(raw: string | undefined): Buffer | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  const buf = /^[0-9a-fA-F]{64}$/.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64')
  return buf.length === 32 ? buf : null
}

/** 環境變數有沒有設、而且格式對（長度不對也算沒設，不能默默用錯的金鑰）。 */
export function isMeegleKeyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseKey(env.MEEGLE_TOKEN_KEY) !== null
}

export function encryptMeegleToken(plain: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = parseKey(env.MEEGLE_TOKEN_KEY)
  if (!key) throw new Error('MEEGLE_TOKEN_KEY 未設定或格式錯誤（需要 32 bytes 的 base64 或 hex）')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [PREFIX, iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':')
}

/** 解不開（金鑰換過／資料壞掉）一律丟錯，不回空字串——空字串會被當成「沒 token」往下走。 */
export function decryptMeegleToken(stored: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = parseKey(env.MEEGLE_TOKEN_KEY)
  if (!key) throw new Error('MEEGLE_TOKEN_KEY 未設定或格式錯誤')
  const parts = stored.split(':')
  if (parts.length !== 4 || parts[0] !== PREFIX) throw new Error('token 密文格式不正確')
  const [, ivB64, tagB64, encB64] = parts
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(encB64, 'base64')), decipher.final()]).toString('utf8')
}
