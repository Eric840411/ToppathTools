import { AsyncLocalStorage } from 'async_hooks'

export interface RequestContext {
  /** 顯示用的操作者。可能來自 header（例如 x-jira-email），**不保證是登入者本人** */
  user: string
  /**
   * 真正登入這個 request 的帳號（來自 cookie session），沒登入就是 undefined。
   * 修為累計這種「記在誰頭上」的事一律用這個，不要用 user——
   * user 吃得到 header，等於讓人可以把修為記到別人身上（跟 v4.10.0 收緊
   * Jira 身分邊界是同一類問題）。
   */
  authEmail?: string
  userDisplay: string
  ip: string
  path: string
  method: string
  operation: string
  geminiApiKey?: string
}

export interface OperatorInfo {
  key: string
  name: string
}

const requestContextStore = new AsyncLocalStorage<RequestContext>()

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return requestContextStore.run(ctx, fn)
}

export function getRequestContext(): RequestContext | undefined {
  return requestContextStore.getStore()
}

/** 取這個 request 真正登入的帳號（cookie 來源，header 影響不了） */
export function getAuthEmailFromContext(): string | undefined {
  return requestContextStore.getStore()?.authEmail
}

export function getOperatorFromContext(): OperatorInfo | undefined {
  const ctx = requestContextStore.getStore()
  if (!ctx) return undefined
  const key = ctx.user && ctx.user !== '—' ? ctx.user : ''
  const name = ctx.userDisplay && ctx.userDisplay !== '未登入使用者' ? ctx.userDisplay : ''
  if (!key && !name) return undefined
  return { key, name }
}

export async function withRequestOperation<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  const ctx = requestContextStore.getStore()
  if (!ctx) return fn()
  const previous = ctx.operation
  ctx.operation = operation
  try {
    return await fn()
  } finally {
    ctx.operation = previous
  }
}
