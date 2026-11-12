/** node --experimental-strip-types --test src/features/uat/batch-retarget-http.test.ts */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { safePost } from './batch-retarget-http.ts'

const fake = (impl: () => Promise<Response>) => (() => impl()) as unknown as typeof fetch

test('斷線（fetch reject）→ 不 throw、回 ok:false network:true', async () => {
  const r = await safePost('/x', {}, fake(() => Promise.reject(new TypeError('Failed to fetch'))))
  assert.equal(r.ok, false); assert.equal(r.network, true)
})
test('讀回應到一半失敗 → 不 throw', async () => {
  const r = await safePost('/x', {}, fake(async () => ({ status: 200, text: () => Promise.reject(new Error('aborted')) }) as unknown as Response))
  assert.equal(r.ok, false); assert.equal(r.network, true)
})
test('SPA index.html → 沒有路由', async () => {
  const r = await safePost('/x', {}, fake(async () => new Response('<!doctype html>', { status: 200 })))
  assert.equal(r.ok, false); assert.match(r.message ?? '', /沒有這個路由/)
})
test('正常 JSON 照原樣回', async () => {
  const r = await safePost<{ ok: boolean; n: number }>('/x', {}, fake(async () => new Response('{"ok":true,"n":3}')))
  assert.equal(r.ok, true); assert.equal((r as { n: number }).n, 3)
})

import { readFileSync } from 'node:fs'
test('批次改綁：改勾選只能走 choose()（會一起清掉「我已確認」）', () => {
  const src = readFileSync(new URL('./BatchRetargetDialog.tsx', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '')
  const calls = src.match(/setChosen\(/g) ?? []
  assert.equal(calls.length, 1, `setChosen 只能出現在 choose() 裡，實際 ${calls.length} 處`)
  assert.match(src, /const choose = [^\n]*setChosen\(next\); setConfirmed\(false\)/)
})
test('批次改綁：請求一律走 safePost，不直接 fetch', () => {
  const src = readFileSync(new URL('./BatchRetargetDialog.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, ''), /\bfetch\(/)
})
