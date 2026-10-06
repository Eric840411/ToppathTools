/**
 * 路由用的測試空間權限檢查（v5.12.6）。跟 meegle-space.ts 分開：這支要讀登入 session（會載入整個 server 的 DB），
 * meegle-space.ts 保持純邏輯、單元測試不碰真的 data.db。規則本體 canUseSpace 在 meegle-space.ts。
 */
import type { Request, Response } from 'express'
import { getAuthAccount } from './auth-session.js'
import { canUseSpace, type MeegleSpace } from './meegle-space.js'

/** 不准就回 403 並回 true（呼叫端直接 return） */
export function denyTestSpace(req: Request, res: Response, space: MeegleSpace): boolean {
  if (canUseSpace(getAuthAccount(req)?.role, space)) return false
  res.status(403).json({ ok: false, code: 'TEST_SPACE_ADMIN_ONLY', message: '測試空間只有管理員能用' })
  return true
}
