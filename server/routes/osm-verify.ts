/**
 * 版本驗證表 `/api/osm-verify/*` 的正式接線（docs/features/35-osm-verify.md）。
 * 路由本體在 server/osm-verify-router.ts（工廠，測試用記憶體 DB 直接打 HTTP）。
 */
import { db, addHistory, getEffectivePermissions, getLarkToken, writeLimiter } from '../shared.js'
import { getAuthAccount } from '../auth-session.js'
import { getAccountRow } from '../meegle-account-service.js'
import { decryptMeegleToken } from '../meegle-token-crypto.js'
import { canUseSpace } from '../meegle-space.js'
import { defaultRunner } from '../meegle-workitem.js'
import { buildOsmVerifyRouter } from '../osm-verify-router.js'

export const router = buildOsmVerifyRouter({
  db,
  auth: req => {
    const a = getAuthAccount(req)
    return a ? { email: a.email, label: a.label, role: a.role } : null
  },
  permissions: (email, role) => getEffectivePermissions(email, role),
  history: (title, summary, detail) => addHistory('osm-verify', title, summary, detail),
  writeLimiter,
  meegle: {
    // token 只在這裡解密、只交給 CLI；不回傳、不記 log
    binding: email => {
      const row = getAccountRow(db, email)
      if (!row) return { ok: false, code: 'NOT_BOUND', message: '還沒綁定 Meegle，請先到側欄「個人帳號」綁定' }
      if (row.status !== 'valid') return { ok: false, code: 'BINDING_INVALID', message: 'Meegle 綁定已失效，請到側欄「個人帳號」重新綁定' }
      try { return { ok: true, token: decryptMeegleToken(row.token_enc), bindingRev: row.rev } } catch {
        return { ok: false, code: 'DECRYPT_FAILED', message: 'Meegle token 解不開（伺服器金鑰可能換過），請重新綁定' }
      }
    },
    canUseSpace: (role, space) => canUseSpace(role, space),
    runner: defaultRunner,
    baseEnv: process.env,
  },
  lark: {
    // 只讀：一次匯入時讀「驗證表單_v2」，不寫回 Lark
    readSheet: async (sheetToken, sheetId) => {
      const token = await getLarkToken()
      const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'
      const r = await fetch(`${base}/open-apis/sheets/v2/spreadsheets/${sheetToken}/values/${sheetId}!A1:Z3000?valueRenderOption=ToString`, { headers: { Authorization: `Bearer ${token}` } })
      const j = await r.json() as { code: number; msg?: string; data?: { valueRange?: { values?: unknown[][] } } }
      if (j.code !== 0) throw new Error(`讀不到驗證表（code ${j.code}），請確認機器人有權限`)
      return j.data?.valueRange?.values ?? []
    },
  },
})
