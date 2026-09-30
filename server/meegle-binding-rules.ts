/**
 * Meegle 綁定的判斷規則（純函式，不碰 DB／網路，測試直接打這裡）。
 */
import type { MeegleErrorCode } from './meegle-cli.js'

export const normEmail = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()

export type IdentityDecision =
  | { ok: true; via: 'email' | 'override' }
  | { ok: false; reason: string }

/**
 * 這組 token 代表的 Meegle 使用者，是不是「目前登入的這個人」。
 *
 * 規則（使用者 2026-09-30 確認：工具登入 email 跟 Lark／Meegle 的一樣）：
 * - email 相同（不分大小寫）→ 本人
 * - 否則只認管理員預先建立的對照（登入 email → Meegle user_key）
 * - **不能把第一次貼進來的身分直接認作本人**（CodeX review）——那等於誰拿到別人的 token 都能綁
 * - Meegle 沒回 email 時不猜，只能靠對照
 */
export function decideIdentity(
  loginEmail: string,
  meegle: { email: string; userKey: string },
  overrideUserKey: string | null,
): IdentityDecision {
  const login = normEmail(loginEmail)
  const me = normEmail(meegle.email)
  if (login && me && login === me) return { ok: true, via: 'email' }
  if (overrideUserKey && overrideUserKey === meegle.userKey) return { ok: true, via: 'override' }
  return {
    ok: false,
    reason: me
      ? `這組 token 屬於 Meegle 帳號 ${meegle.email}，跟你登入的 ${loginEmail} 不同`
      : `Meegle 沒有回傳這組 token 的 email，無法確認是不是你本人`,
  }
}

export type BindingStatus = 'valid' | 'invalid'

/**
 * 重新驗證之後，綁定狀態要變成什麼。
 * ⚠️ 只有「伺服器明確拒絕」或「身分變了」才標失效——連不上、逾時、看不懂的輸出都維持原狀
 *    （CodeX review：逾時／限流不能標成失效，不然 Meegle 一抖所有人都被登出）。
 */
export function nextStatusAfterVerify(
  current: BindingStatus,
  result: { ok: true; userKey: string } | { ok: false; code: MeegleErrorCode },
  boundUserKey: string,
): { status: BindingStatus; code: string | null } {
  // 用 `in` 縮小型別：server 的 tsconfig 沒開 strictNullChecks，`result.ok` 判斷不會縮小聯集
  if ('userKey' in result) {
    return result.userKey === boundUserKey
      ? { status: 'valid', code: null }
      : { status: 'invalid', code: 'IDENTITY_CHANGED' }
  }
  if (result.code === 'TOKEN_INVALID') return { status: 'invalid', code: 'TOKEN_INVALID' }
  return { status: current, code: result.code }
}

/** HTTP 狀態碼：使用者能修的 4xx，伺服器／外部問題 5xx。 */
export function httpStatusFor(code: string): number {
  switch (code) {
    case 'TOKEN_INVALID': return 400
    case 'IDENTITY_MISMATCH': return 403
    case 'ALREADY_BOUND_ELSEWHERE': return 409
    case 'NOT_BOUND': return 404
    case 'KEY_NOT_CONFIGURED': return 503
    case 'CLI_MISSING': return 503
    case 'UNAVAILABLE': return 503
    default: return 502
  }
}
