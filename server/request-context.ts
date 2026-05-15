import { AsyncLocalStorage } from 'async_hooks'

export interface RequestContext {
  user: string
  userDisplay: string
  ip: string
  path: string
  method: string
  operation: string
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
