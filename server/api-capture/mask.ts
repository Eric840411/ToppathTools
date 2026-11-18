/**
 * API 參數紀錄（docs/features/35-api-capture.md）：機密遮罩。
 *
 * agent 端錄到東西「送出前」先遮一次，server 收到「落盤前」再遮一次，匯出 Excel 前也再過一次。
 * 三道都用這一支，不要各寫一份（規則寫兩份＝只會修好一份）。
 *
 * ⚠️ agent 會下載這支檔案（AGENT_SOURCE_WHITELIST），所以**只能 import 標準函式庫**。
 */

/** OSM 玩家 token：32 位十六進位＋「-」＋uid（例：624520...a07-350612） */
const OSM_PLAYER_TOKEN = /[0-9a-f]{32}-\d+/gi   // 不加 \b：網址編碼後前面是 %3D（D 也是十六進位字元）
/** 後台登入 token：0000873_1-<64 hex>／-ref- 版 */
const BACKEND_TOKEN = /\b\d{4,}_\d+-(?:ref-)?[0-9a-f]{40,}\b/gi
/** JSON 裡這些 key 的字串值一律遮 */
const SECRET_JSON_KEY = /("(?:token|accessToken|access_token|refreshToken|refresh_token|authorization|password|passwd|pwd|secret|privateMapKey|userSig|usersig|sign_key|apiKey|api_key)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi
/** 鬆散物件字面值（遊戲 console 的 `{token: xxx, ...}`） */
const SECRET_LOOSE_KEY = /(\b(?:token|accessToken|refreshToken|password|secret|privateMapKey|userSig)\s*:\s*)([^,}\s]+)/g
/** 網址參數 */
const SECRET_QUERY = /([?&](?:token|access_token|refresh_token|authorization|password|secret|key|sign)=|(?:%3F|%26)(?:token|password|secret)%3D)[^&#\s"%']+/gi
/** HTTP header 形式 */
const SECRET_HEADER = /(\b(?:authorization|cookie|set-cookie)\s*[:=]\s*)(?:Bearer\s+)?[^\s,;"']+/gi

export const MASK = '***'

/** 第三方統計／監控：預設當雜訊（仍保留、但內容截短、畫面預設不顯示、不進參數比對） */
export const HTTP_NOISE_HOST = /google-analytics|googletagmanager|doubleclick|xtrace|aliyuncs\.com|posthog|bi-sage|rtc-web|my-imcloud|sentry|hotjar|clarity\.ms/i

export function maskText(input: unknown): string {
  if (input === null || input === undefined) return ''
  let s = typeof input === 'string' ? input : JSON.stringify(input)
  s = s.replace(SECRET_JSON_KEY, `$1"${MASK}"`)
  s = s.replace(SECRET_QUERY, `$1${MASK}`)
  s = s.replace(SECRET_LOOSE_KEY, `$1${MASK}`)
  s = s.replace(SECRET_HEADER, `$1${MASK}`)
  s = s.replace(OSM_PLAYER_TOKEN, MASK)
  s = s.replace(BACKEND_TOKEN, MASK)
  return s
}

/** 網址遮罩（大廳連結等），保留 host 與非機密參數方便辨識 */
export function maskUrl(url: string): string {
  return maskText(url)
}

/** 截斷＋遮罩。Excel 單格上限 32767，前台 WS 一幀可能很大 */
export function clip(input: unknown, max = 8000): string {
  const s = maskText(input)
  return s.length > max ? `${s.slice(0, max)}…(截斷，原長 ${s.length})` : s
}
