/**
 * server/routes/gemini.ts
 * All /api/gemini/* routes plus Gemini helper utilities used by other route files.
 */
import { Router } from 'express'
import { z } from 'zod'
import { Agent, fetch as undiciFetch } from 'undici'
import Bottleneck from 'bottleneck'
import {
  db,
  addHistory,
  getUser,
  heavyLimiter,
  writeLimiter,
} from '../shared.js'
import { getRequestContext } from '../request-context.js'
import { getAuthAccount } from '../auth-session.js'

// ─── Per-key Bottleneck limiters ──────────────────────────────────────────────
// Each Gemini API key gets its own rate limiter so concurrent requests that
// use different keys can run in parallel, while requests on the same key
// are serialized (maxConcurrent: 1, minTime: 500ms between calls).
const keyLimiters = new Map<string, Bottleneck>()
function getKeyLimiter(key: string): Bottleneck {
  let lim = keyLimiters.get(key)
  if (!lim) {
    lim = new Bottleneck({ maxConcurrent: 1, minTime: 500 })
    keyLimiters.set(key, lim)
  }
  return lim
}

// Long-timeout agent for Ollama — large models (e.g. gemma4:31b) can take >30s
const ollamaAgent = new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000, connectTimeout: 15_000 })

export const router = Router()

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GeminiKey { label: string; key: string }
export interface GeminiPrompt { id: string; name: string; template: string; category: string }

type AiProvider = 'gemini' | 'openai' | 'ollama'
type AiKind = 'text' | 'vision'
type AiTaskStatus = 'running' | 'done' | 'error'

interface AiTask {
  id: string
  provider: AiProvider
  kind: AiKind
  model: string
  operation: string
  user: string
  status: AiTaskStatus
  startedAt: number
  endedAt?: number
  durationMs?: number
  error?: string
}

const aiTaskStore = new Map<string, AiTask>()
const AI_TASK_TTL_MS = 30 * 60 * 1000
const AI_TASK_RUNNING_TIMEOUT_MS = 5 * 60 * 1000

function cleanupAiTasks() {
  const now = Date.now()
  for (const task of aiTaskStore.values()) {
    // Prevent stale "running" tasks from hanging forever in monitor UI.
    if (task.status === 'running' && now - task.startedAt > AI_TASK_RUNNING_TIMEOUT_MS) {
      task.status = 'error'
      task.error = task.error ?? '執行逾時（超過 5 分鐘未完成）'
      task.endedAt = now
      task.durationMs = now - task.startedAt
    }
  }
  for (const [id, task] of aiTaskStore.entries()) {
    if (task.status !== 'running' && now - (task.endedAt ?? task.startedAt) > AI_TASK_TTL_MS) {
      aiTaskStore.delete(id)
    }
  }
}

function startAiTask(provider: AiProvider, kind: AiKind, model: string): string {
  cleanupAiTasks()
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const ctx = getRequestContext()
  aiTaskStore.set(id, {
    id,
    provider,
    kind,
    model,
    operation: ctx?.operation ?? `${ctx?.method ?? '-'} ${ctx?.path ?? '-'}`,
    user: ctx?.userDisplay ?? ctx?.user ?? 'unknown',
    status: 'running',
    startedAt: Date.now(),
  })
  return id
}

function finishAiTask(id: string, error?: string) {
  const task = aiTaskStore.get(id)
  if (!task) return
  const endedAt = Date.now()
  task.endedAt = endedAt
  task.durationMs = endedAt - task.startedAt
  task.status = error ? 'error' : 'done'
  task.error = error
  cleanupAiTasks()
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

export const readGeminiKeys = (): GeminiKey[] =>
  db.prepare('SELECT label, key FROM gemini_keys').all() as GeminiKey[]

export const readGeminiPrompts = (): GeminiPrompt[] =>
  db.prepare('SELECT id, name, template, category FROM gemini_prompts').all() as GeminiPrompt[]

export const getActiveGeminiKeys = (): string[] => {
  const storedKeys = readGeminiKeys().map(k => k.key).filter(Boolean)
  const envKey = process.env.GEMINI_API_KEY ?? ''
  return [...storedKeys, ...(envKey ? [envKey] : [])]
}

// ─── Per-user AI key helpers ──────────────────────────────────────────────────

interface UserAiKey { user_email: string; provider: string; api_key: string; label: string }

export function getUserAiKey(userEmail: string, provider: string): string | null {
  const row = db.prepare('SELECT api_key FROM user_ai_keys WHERE user_email = ? AND provider = ?')
    .get(userEmail, provider) as { api_key: string } | undefined
  return row?.api_key ?? null
}

export function setUserAiKey(userEmail: string, provider: string, apiKey: string, label: string) {
  db.prepare(`
    INSERT INTO user_ai_keys (user_email, provider, api_key, label, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_email, provider) DO UPDATE SET api_key = excluded.api_key, label = excluded.label, created_at = excluded.created_at
  `).run(userEmail, provider, apiKey, label, Date.now())
}

export function deleteUserAiKey(userEmail: string, provider: string) {
  db.prepare('DELETE FROM user_ai_keys WHERE user_email = ? AND provider = ?').run(userEmail, provider)
}

export function listUserAiKeys(userEmail: string): { provider: string; label: string; hasKey: boolean }[] {
  const rows = db.prepare('SELECT provider, label FROM user_ai_keys WHERE user_email = ?')
    .all(userEmail) as { provider: string; label: string }[]
  return rows.map(r => ({ provider: r.provider, label: r.label, hasKey: true }))
}

/**
 * Resolve Gemini key entries for the current request.
 * If the current user (from request context) has a personal Gemini key,
 * ONLY that key is used — never mixed with other users' keys.
 * Falls back to the global pool if no personal key is set.
 * User identity is resolved via auth cookie (getAuthAccount) first,
 * then falls back to AsyncLocalStorage request context.
 */
export function resolveGeminiKeyEntries(req?: import('express').Request): { label: string; key: string }[] {
  // Try cookie-based auth first
  const cookieEmail = req ? getAuthAccount(req)?.email : null
  // Fallback to request context (set by middleware for all requests)
  const ctxEmail = getRequestContext()?.user
  const userEmail = cookieEmail ?? (ctxEmail && ctxEmail !== '—' ? ctxEmail : null)

  if (userEmail) {
    const personalKey = getUserAiKey(userEmail, 'gemini')
    if (personalKey) {
      return [{ label: `personal:${userEmail}`, key: personalKey }]
    }
  }
  // Global pool fallback
  const storedKeys = readGeminiKeys()
  const envKey = process.env.GEMINI_API_KEY ?? ''
  return [
    ...storedKeys,
    ...(envKey ? [{ label: 'env', key: envKey }] : []),
  ]
}

/**
 * Resolve OpenAI key for the current request.
 * Personal key takes priority; falls back to global setting / env.
 */
export function resolveOpenAIKey(req?: import('express').Request): string {
  const cookieEmail = req ? getAuthAccount(req)?.email : null
  const ctxEmail = getRequestContext()?.user
  const userEmail = cookieEmail ?? (ctxEmail && ctxEmail !== '—' ? ctxEmail : null)

  if (userEmail) {
    const personalKey = getUserAiKey(userEmail, 'openai')
    if (personalKey) return personalKey
  }
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('openai_api_key') as { value: string } | undefined
  return row?.value ?? process.env.OPENAI_API_KEY ?? ''
}

// ─── Key usage tracking ───────────────────────────────────────────────────────

export const today = () => new Date().toISOString().slice(0, 10)

export function recordGeminiSuccess(label: string) {
  const d = today()
  db.prepare(`
    INSERT INTO gemini_key_stats (label, calls_today, calls_total, last_used_at, stats_date)
    VALUES (?, 1, 1, ?, ?)
    ON CONFLICT(label) DO UPDATE SET
      calls_today  = CASE WHEN stats_date = excluded.stats_date THEN calls_today + 1 ELSE 1 END,
      calls_total  = calls_total + 1,
      last_used_at = excluded.last_used_at,
      stats_date   = excluded.stats_date
  `).run(label, Date.now(), d)
}

export function recordGeminiError(label: string, error: string) {
  const d = today()
  db.prepare(`
    INSERT INTO gemini_key_stats (label, calls_today, calls_total, last_error, last_error_at, stats_date)
    VALUES (?, 1, 1, ?, ?, ?)
    ON CONFLICT(label) DO UPDATE SET
      calls_today   = CASE WHEN stats_date = excluded.stats_date THEN calls_today + 1 ELSE 1 END,
      calls_total   = calls_total + 1,
      last_error    = excluded.last_error,
      last_error_at = excluded.last_error_at,
      stats_date    = excluded.stats_date
  `).run(label, error, Date.now(), d)
}

/** Probe-only status update — does NOT increment calls_today/calls_total */
function probeUpdateStatus(label: string, error: string | null) {
  if (error) {
    db.prepare(`
      INSERT INTO gemini_key_stats (label, calls_today, calls_total, last_error, last_error_at, stats_date)
      VALUES (?, 0, 0, ?, ?, ?)
      ON CONFLICT(label) DO UPDATE SET
        last_error    = excluded.last_error,
        last_error_at = excluded.last_error_at
    `).run(label, error, Date.now(), today())
  }
  // on probe success: no DB write needed (don't pollute calls_today)
}

// ─── Key rotation call ────────────────────────────────────────────────────────

// Round-robin 全域計數器：每次請求從不同 key 起點開始，分散負載
let rrIndex = 0

/** Dispatches a Gemini call through a per-key rate limiter with automatic key rotation.
 *  Requests assigned to the same API key are serialized; different keys run in parallel. */
export const callGeminiWithRotation = (prompt: string): Promise<string> => {
  const model = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash'
  const taskId = startAiTask('gemini', 'text', model)

  // Atomically claim an rrIndex slot to determine which key queue to enter.
  // _callGeminiWithRotation will start from this same index so the limiter
  // and the actual HTTP call are aligned to the same key.
  const keyEntries = resolveGeminiKeyEntries()
  if (keyEntries.length === 0) {
    finishAiTask(taskId, 'no keys')
    return Promise.reject(new Error('沒有可用的 Gemini API Key，請在設定中新增'))
  }
  const myStartIndex = rrIndex % keyEntries.length
  rrIndex = (rrIndex + 1) % Number.MAX_SAFE_INTEGER
  const primaryKey = keyEntries[myStartIndex].key

  return getKeyLimiter(primaryKey).schedule(async () => {
    try {
      const out = await _callGeminiWithRotation(prompt, myStartIndex)
      finishAiTask(taskId)
      return out
    } catch (e) {
      finishAiTask(taskId, e instanceof Error ? e.message : String(e))
      throw e
    }
  })
}

export const _callGeminiWithRotation = async (prompt: string, startIndex?: number): Promise<string> => {
  const keyEntries = resolveGeminiKeyEntries()

  if (keyEntries.length === 0) throw new Error('沒有可用的 Gemini API Key，請在設定中新增')
  const model = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash'

  // 若呼叫方已預先指定起始 index（透過 per-key limiter 分配），直接使用；
  // 否則以 round-robin 全域計數器自行決定起始 index。
  let _startIndex: number
  if (startIndex !== undefined) {
    _startIndex = startIndex % keyEntries.length
  } else {
    _startIndex = rrIndex % keyEntries.length
    rrIndex = (rrIndex + 1) % Number.MAX_SAFE_INTEGER
  }

  for (let offset = 0; offset < keyEntries.length; offset++) {
    const i = (_startIndex + offset) % keyEntries.length
    const { label, key } = keyEntries[i]
    console.log(`[Gemini] key ${i + 1}/${keyEntries.length} (${label}) [RR start=${_startIndex}], model: ${model}`)
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(300000), // 5 min — large TestCase / second-pass prompts can take >2min
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3 },
        }),
      },
    )
    const data = await resp.json() as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[]
      error?: { code?: number; message?: string; status?: string }
    }
    console.log(`[Gemini] key ${i + 1} HTTP:${resp.status} error:${data.error?.status ?? 'none'}`)

    if (
      data.error?.status === 'RESOURCE_EXHAUSTED' ||
      data.error?.status === 'INVALID_ARGUMENT' ||
      resp.status === 429 ||
      resp.status === 503  // model overloaded — try next key
    ) {
      const errMsg = data.error?.status ?? String(resp.status)
      console.warn(`[Gemini] key ${i + 1} (${label}) 不可用 (${errMsg})，嘗試下一個`)
      recordGeminiError(label, errMsg)
      continue
    }
    if (!resp.ok || data.error) {
      const errMsg = `HTTP ${resp.status}: ${data.error?.message ?? '未知錯誤'}`
      recordGeminiError(label, errMsg)
      throw new Error(`Gemini API 錯誤 (${resp.status}): ${data.error?.message ?? '未知錯誤'}`)
    }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) throw new Error(`Gemini 回傳空結果，finishReason: ${data.candidates?.[0]?.finishReason ?? 'unknown'}`)
    recordGeminiSuccess(label)
    return text
  }
  // Distinguish between quota exhaustion vs temporary overload
  const lastErrors = keyEntries.map((_, idx) => {
    const s = db.prepare('SELECT last_error FROM gemini_key_stats WHERE label = ?').get(keyEntries[idx].label) as { last_error?: string } | undefined
    return s?.last_error ?? ''
  })
  const allOverloaded = lastErrors.every(e => e.includes('503') || e === '503')
  if (allOverloaded) throw new Error('Gemini 服務暫時過載（503），請稍後再試')
  // All keys exhausted — try Ollama fallback
  try { return await callOllama(prompt) } catch (ollamaErr) {
    console.warn('[Ollama] fallback failed:', ollamaErr)
  }
  throw new Error('所有 Gemini API Key 均已達到配額上限，請新增其他 Key')
}

/** Prompt 模板渲染（將 {{variable}} 替換為實際值） */
export const renderPrompt = (template: string, vars: Record<string, string>): string => {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '')
}

// ─── Ollama Config ────────────────────────────────────────────────────────────

/** Read Ollama base URL + model from DB first, fall back to .env */
const readOllamaConfig = (): { baseUrl: string; model: string } => {
  const urlRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('ollama_base_url') as { value: string } | undefined
  const modelRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('ollama_model') as { value: string } | undefined
  return {
    baseUrl: urlRow?.value ?? process.env.OLLAMA_BASE_URL ?? '',
    model: modelRow?.value ?? process.env.OLLAMA_MODEL ?? '',
  }
}

// ─── Ollama Fallback ──────────────────────────────────────────────────────────

/** Call local Ollama API for text generation. */
export const callOllama = async (prompt: string, modelOverride?: string): Promise<string> => {
  const { baseUrl: base, model: defaultModel } = readOllamaConfig()
  const model = modelOverride ?? defaultModel
  if (!base || !model) throw new Error('Ollama 未設定（OLLAMA_BASE_URL / OLLAMA_MODEL）')
  const taskId = startAiTask('ollama', 'text', model)
  console.log(`[Ollama] fallback → ${model}`)
  try {
    const resp = await undiciFetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }),
      dispatcher: ollamaAgent,
    } as Parameters<typeof undiciFetch>[1])
    if (!resp.ok) throw new Error(`Ollama HTTP ${resp.status}`)
    const data = await resp.json() as { response?: string; error?: string }
    if (data.error) throw new Error(`Ollama 錯誤：${data.error}`)
    if (!data.response) throw new Error('Ollama 回傳空結果')
    finishAiTask(taskId)
    return data.response
  } catch (e) {
    finishAiTask(taskId, e instanceof Error ? e.message : String(e))
    throw e
  }
}

/** Call local Ollama API for vision (multimodal) generation. */
export const callOllamaVision = async (prompt: string, imageBase64: string, modelOverride?: string): Promise<string> => {
  const { baseUrl: base, model: defaultModel } = readOllamaConfig()
  const model = modelOverride ?? defaultModel
  if (!base || !model) throw new Error('Ollama 未設定（OLLAMA_BASE_URL / OLLAMA_MODEL）')
  const taskId = startAiTask('ollama', 'vision', model)
  console.log(`[Ollama] vision fallback → ${model}`)
  try {
    const resp = await undiciFetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, images: [imageBase64], stream: false }),
      dispatcher: ollamaAgent,
    } as Parameters<typeof undiciFetch>[1])
    if (!resp.ok) throw new Error(`Ollama Vision HTTP ${resp.status}`)
    const data = await resp.json() as { response?: string; error?: string }
    if (data.error) throw new Error(`Ollama Vision 錯誤：${data.error}`)
    if (!data.response) throw new Error('Ollama Vision 回傳空結果')
    finishAiTask(taskId)
    return data.response
  } catch (e) {
    finishAiTask(taskId, e instanceof Error ? e.message : String(e))
    throw e
  }
}

/**
 * Call Gemini Vision API with an inline image + text prompt.
 * Uses same key rotation as callGeminiWithRotation.
 */
export const callGeminiVision = async (prompt: string, imageBase64: string, mimeType = 'image/png'): Promise<string> => {
  const storedKeys = readGeminiKeys()
  const envKey = process.env.GEMINI_API_KEY ?? ''
  const keyEntries: { label: string; key: string }[] = [
    ...storedKeys,
    ...(envKey ? [{ label: 'env', key: envKey }] : []),
  ]
  if (keyEntries.length === 0) throw new Error('沒有可用的 Gemini API Key')
  const model = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash'
  const taskId = startAiTask('gemini', 'vision', model)
  try {
    const startIndex = rrIndex % keyEntries.length
    rrIndex = (rrIndex + 1) % Number.MAX_SAFE_INTEGER

    for (let offset = 0; offset < keyEntries.length; offset++) {
      const i = (startIndex + offset) % keyEntries.length
      const { label, key } = keyEntries[i]
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(300000),
          body: JSON.stringify({
            contents: [{
              parts: [
                { inlineData: { mimeType, data: imageBase64 } },
                { text: prompt },
              ],
            }],
            generationConfig: { temperature: 0.1 },
          }),
        },
      )
      const data = await resp.json() as {
        candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[]
        error?: { code?: number; message?: string; status?: string }
      }
      if (
        data.error?.status === 'RESOURCE_EXHAUSTED' ||
        data.error?.status === 'INVALID_ARGUMENT' ||
        resp.status === 429 ||
        resp.status === 503
      ) {
        recordGeminiError(label, data.error?.status ?? String(resp.status))
        continue
      }
      if (!resp.ok || data.error) {
        throw new Error(`Gemini Vision API 錯誤 (${resp.status}): ${data.error?.message ?? '未知錯誤'}`)
      }
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text
      if (!text) throw new Error(`Gemini Vision 回傳空結果`)
      recordGeminiSuccess(label)
      finishAiTask(taskId)
      return text
    }
    // All keys exhausted — try Ollama vision fallback
    try {
      const out = await callOllamaVision(prompt, imageBase64)
      finishAiTask(taskId)
      return out
    } catch (ollamaErr) {
      console.warn('[Ollama] vision fallback failed:', ollamaErr)
    }
    finishAiTask(taskId, '所有 Gemini API Key 均已達到配額上限')
    throw new Error('所有 Gemini API Key 均已達到配額上限')
  } catch (e) {
    finishAiTask(taskId, e instanceof Error ? e.message : String(e))
    throw e
  }
}

/** Multi-image variant of callGeminiVision — sends several images in one request. */
export const callGeminiVisionMulti = async (
  prompt: string,
  images: Array<{ base64: string; mimeType?: string }>,
): Promise<string> => {
  const storedKeys = readGeminiKeys()
  const envKey = process.env.GEMINI_API_KEY ?? ''
  const keyEntries: { label: string; key: string }[] = [
    ...storedKeys,
    ...(envKey ? [{ label: 'env', key: envKey }] : []),
  ]
  if (keyEntries.length === 0) throw new Error('沒有可用的 Gemini API Key')
  const model = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash'
  const taskId = startAiTask('gemini', 'vision-multi', model)
  try {
    const startIndex = rrIndex % keyEntries.length
    rrIndex = (rrIndex + 1) % Number.MAX_SAFE_INTEGER
    const parts: unknown[] = [
      ...images.map(img => ({ inlineData: { mimeType: img.mimeType ?? 'image/png', data: img.base64 } })),
      { text: prompt },
    ]
    for (let offset = 0; offset < keyEntries.length; offset++) {
      const i = (startIndex + offset) % keyEntries.length
      const { label, key } = keyEntries[i]
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(300000),
          body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0.1 } }),
        },
      )
      const data = await resp.json() as {
        candidates?: { content?: { parts?: { text?: string }[] } }[]
        error?: { code?: number; message?: string; status?: string }
      }
      if (
        data.error?.status === 'RESOURCE_EXHAUSTED' ||
        data.error?.status === 'INVALID_ARGUMENT' ||
        resp.status === 429 || resp.status === 503
      ) { recordGeminiError(label, data.error?.status ?? String(resp.status)); continue }
      if (!resp.ok || data.error) throw new Error(`Gemini Vision API 錯誤 (${resp.status}): ${data.error?.message ?? '未知'}`)
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text
      if (!text) throw new Error('Gemini Vision 回傳空結果')
      recordGeminiSuccess(label)
      finishAiTask(taskId)
      return text
    }
    finishAiTask(taskId, '所有 Gemini API Key 均已達到配額上限')
    throw new Error('所有 Gemini API Key 均已達到配額上限')
  } catch (e) {
    finishAiTask(taskId, e instanceof Error ? e.message : String(e))
    throw e
  }
}

// ─── OpenAI Integration ──────────────────────────────────────────────────────

// Alias for legacy internal use — now resolves personal key first
const readOpenAIKey = (): string => resolveOpenAIKey()

// Models that use legacy /v1/completions instead of /v1/chat/completions
const LEGACY_COMPLETIONS_MODELS = new Set(['gpt-5.3-codex', 'code-davinci-002'])

/** Call OpenAI API for text generation. Routes to chat or legacy completions based on model. */
export const callOpenAI = async (prompt: string, modelOverride?: string): Promise<string> => {
  const apiKey = readOpenAIKey()
  if (!apiKey) throw new Error('OpenAI 未設定（OPENAI_API_KEY）')
  const model = modelOverride ?? 'codex-mini-latest'
  const taskId = startAiTask('openai', 'text', model)
  console.log(`[OpenAI] → ${model}`)
  try {
    if (LEGACY_COMPLETIONS_MODELS.has(model)) {
      // Legacy completions API
      const resp = await fetch('https://api.openai.com/v1/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model, prompt, max_tokens: 8192 }),
      })
      const data = await resp.json() as { choices?: { text?: string }[]; error?: { message?: string } }
      if (!resp.ok || data.error) throw new Error(`OpenAI 錯誤 (${resp.status}): ${data.error?.message ?? '未知'}`)
      const content = data.choices?.[0]?.text
      if (!content) throw new Error('OpenAI 回傳空結果')
      finishAiTask(taskId)
      return content
    }

    // Chat completions API
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
    })
    const data = await resp.json() as { choices?: { message?: { content?: string } }[]; error?: { message?: string } }
    if (!resp.ok || data.error) throw new Error(`OpenAI 錯誤 (${resp.status}): ${data.error?.message ?? '未知'}`)
    const content = data.choices?.[0]?.message?.content
    if (!content) throw new Error('OpenAI 回傳空結果')
    finishAiTask(taskId)
    return content
  } catch (e) {
    finishAiTask(taskId, e instanceof Error ? e.message : String(e))
    throw e
  }
}

/** Call OpenAI Chat Completions API with vision (image + text). */
export const callOpenAIVision = async (prompt: string, imageBase64: string, modelOverride?: string): Promise<string> => {
  const apiKey = readOpenAIKey()
  if (!apiKey) throw new Error('OpenAI 未設定（OPENAI_API_KEY）')
  const model = modelOverride ?? 'gpt-4o'
  const taskId = startAiTask('openai', 'vision', model)
  console.log(`[OpenAI] vision → ${model}`)
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
          ],
        }],
      }),
    })
    const data = await resp.json() as { choices?: { message?: { content?: string } }[]; error?: { message?: string } }
    if (!resp.ok || data.error) throw new Error(`OpenAI Vision 錯誤 (${resp.status}): ${data.error?.message ?? '未知'}`)
    const content = data.choices?.[0]?.message?.content
    if (!content) throw new Error('OpenAI Vision 回傳空結果')
    finishAiTask(taskId)
    return content
  } catch (e) {
    finishAiTask(taskId, e instanceof Error ? e.message : String(e))
    throw e
  }
}

// ─── Unified LLM Dispatch ────────────────────────────────────────────────────

/**
 * Unified text call. modelSpec format:
 *   'gemini'            → Gemini with key rotation (default)
 *   'ollama:<model>'    → specific Ollama model (e.g. 'ollama:gemma4:26b')
 *   'openai:<model>'    → OpenAI model (e.g. 'openai:codex-mini-latest')
 */
export const callLLM = async (prompt: string, modelSpec?: string): Promise<string> => {
  if (modelSpec?.startsWith('ollama:')) return callOllama(prompt, modelSpec.slice(7))
  if (modelSpec?.startsWith('openai:')) return callOpenAI(prompt, modelSpec.slice(7))
  return callGeminiWithRotation(prompt)
}

/**
 * Unified vision call. modelSpec same format as callLLM.
 */
export const callLLMVision = async (prompt: string, imageBase64: string, modelSpec?: string): Promise<string> => {
  if (modelSpec?.startsWith('ollama:')) return callOllamaVision(prompt, imageBase64, modelSpec.slice(7))
  if (modelSpec?.startsWith('openai:')) return callOpenAIVision(prompt, imageBase64, modelSpec.slice(7))
  return callGeminiVision(prompt, imageBase64)
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/models/available — list all available LLM models (Gemini + Ollama)
router.get('/api/models/available', async (_req, res) => {
  const models: { id: string; label: string; provider: string }[] = [
    { id: 'gemini', label: 'Gemini (自動輪換)', provider: 'gemini' },
  ]
  const { baseUrl: base } = readOllamaConfig()
  if (base) {
    try {
      // Use manual AbortController + .catch(null) to prevent undici UND_ERR_BODY_TIMEOUT
      // from escaping as an uncaught exception when the host is unreachable
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 2500)
      const r = await fetch(`${base}/api/tags`, { signal: ac.signal }).catch(() => null)
      clearTimeout(timer)
      if (r?.ok) {
        const data = await r.json() as { models?: { name: string }[] }
        for (const m of data.models ?? []) {
          models.push({ id: `ollama:${m.name}`, label: `${m.name} (本地)`, provider: 'ollama' })
        }
      }
    } catch { /* Ollama unavailable */ }
  }
  if (readOpenAIKey()) {
    models.push({ id: 'openai:codex-mini-latest', label: 'Codex Mini (OpenAI)', provider: 'openai' })
    models.push({ id: 'openai:gpt-5.3-codex', label: 'GPT-5.3 Codex (OpenAI)', provider: 'openai' })
    models.push({ id: 'openai:gpt-4o', label: 'GPT-4o (OpenAI)', provider: 'openai' })
  }
  res.json({ ok: true, models })
})

// GET /api/ai-agent/monitor
// Global monitor for all AI agent calls (Gemini/OpenAI/Ollama).
router.get('/api/ai-agent/monitor', (_req, res) => {
  cleanupAiTasks()
  const tasks = [...aiTaskStore.values()].sort((a, b) => b.startedAt - a.startedAt)
  const running = tasks.filter(t => t.status === 'running')
  const latest = tasks.slice(0, 20)
  res.json({
    ok: true,
    runningCount: running.length,
    runningByProvider: {
      gemini: running.filter(t => t.provider === 'gemini').length,
      openai: running.filter(t => t.provider === 'openai').length,
      ollama: running.filter(t => t.provider === 'ollama').length,
    },
    latest,
  })
})

// GET /api/gemini/keys
router.get('/api/gemini/keys', (_req, res) => {
  const keys = readGeminiKeys().map(k => ({ label: k.label, keyMasked: k.key.slice(0, 8) + '****', isEnv: false }))
  const envKey = process.env.GEMINI_API_KEY ?? ''
  if (envKey) keys.push({ label: 'env', keyMasked: envKey.slice(0, 8) + '****', isEnv: true })
  const nextIndex = keys.length > 0 ? rrIndex % keys.length : 0
  res.json({ ok: true, keys, nextRrIndex: nextIndex, nextRrLabel: keys[nextIndex]?.label ?? null })
})

// POST /api/gemini/keys
router.post('/api/gemini/keys', writeLimiter, (req, res) => {
  const body = z.object({ label: z.string().min(1), key: z.string().min(10) }).parse(req.body)
  const exists = readGeminiKeys().find(k => k.label === body.label)
  if (exists) return res.status(400).json({ ok: false, message: '此名稱已存在' })
  db.prepare('INSERT INTO gemini_keys (label, key) VALUES (?, ?)').run(body.label, body.key)
  res.json({ ok: true })
})

// DELETE /api/gemini/keys/:label
router.delete('/api/gemini/keys/:label', (req, res) => {
  db.prepare('DELETE FROM gemini_keys WHERE label = ?').run(req.params.label)
  res.json({ ok: true })
})

// GET /api/openai/key
router.get('/api/openai/key', (_req, res) => {
  const key = readOpenAIKey()
  if (!key) return res.json({ ok: true, isSet: false })
  res.json({ ok: true, isSet: true, keyMasked: key.slice(0, 7) + '****' + key.slice(-4) })
})

// POST /api/openai/key
router.post('/api/openai/key', writeLimiter, (req, res) => {
  const { key } = z.object({ key: z.string().min(10) }).parse(req.body)
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('openai_api_key', key)
  res.json({ ok: true })
})

// DELETE /api/openai/key
router.delete('/api/openai/key', (_req, res) => {
  db.prepare('DELETE FROM settings WHERE key = ?').run('openai_api_key')
  res.json({ ok: true })
})

// ─── Ollama Config Endpoints ──────────────────────────────────────────────────

// GET /api/ollama/config
router.get('/api/ollama/config', (_req, res) => {
  const { baseUrl, model } = readOllamaConfig()
  res.json({ ok: true, baseUrl, model, isSet: !!(baseUrl && model) })
})

// POST /api/ollama/config
router.post('/api/ollama/config', writeLimiter, (req, res) => {
  const { baseUrl, model } = z.object({ baseUrl: z.string(), model: z.string() }).parse(req.body)
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('ollama_base_url', baseUrl)
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('ollama_model', model)
  res.json({ ok: true })
})

// DELETE /api/ollama/config
router.delete('/api/ollama/config', (_req, res) => {
  db.prepare('DELETE FROM settings WHERE key = ?').run('ollama_base_url')
  db.prepare('DELETE FROM settings WHERE key = ?').run('ollama_model')
  res.json({ ok: true })
})

// GET /api/gemini/key-stats
router.get('/api/gemini/key-stats', (_req, res) => {
  const stats = db.prepare('SELECT * FROM gemini_key_stats').all() as {
    label: string; calls_today: number; calls_total: number;
    last_used_at: number | null; last_error: string | null; last_error_at: number | null; stats_date: string
  }[]
  res.json({ ok: true, today: today(), stats })
})

/**
 * POST /api/gemini/probe
 * 同時測試所有 Gemini API Key 的可用狀態（發送 "1+1=?" 探針請求）。
 * @rate-limit heavyLimiter — 每分鐘最多 15 次，避免同時對所有 Key 發出大量請求。
 * @returns { results: { label, status: 'ok'|'exhausted'|'invalid'|'error', message }[] }
 */
router.post('/api/gemini/probe', heavyLimiter, async (_req, res) => {
  const stored = readGeminiKeys()
  const envKey = process.env.GEMINI_API_KEY ?? ''
  const keys: { label: string; key: string }[] = [...stored]
  if (envKey) keys.push({ label: 'env', key: envKey })
  const model = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash'
  const results = await Promise.all(keys.map(async ({ label, key }) => {
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: '1+1=?' }] }], generationConfig: { maxOutputTokens: 5 } }),
        },
      )
      const data = await resp.json() as { error?: { status?: string; message?: string } }
      if (data.error?.status === 'RESOURCE_EXHAUSTED' || resp.status === 429) {
        probeUpdateStatus(label, data.error?.status ?? 'RESOURCE_EXHAUSTED')
        return { label, status: 'exhausted' as const, message: '配額已耗盡' }
      }
      if (data.error?.status === 'PERMISSION_DENIED' || data.error?.status === 'INVALID_ARGUMENT') {
        probeUpdateStatus(label, data.error.status)
        return { label, status: 'invalid' as const, message: 'Key 無效或無權限' }
      }
      if (!resp.ok || data.error) {
        const msg = data.error?.message ?? `HTTP ${resp.status}`
        probeUpdateStatus(label, msg)
        return { label, status: 'error' as const, message: msg }
      }
      probeUpdateStatus(label, null)  // clear error, no call count
      return { label, status: 'ok' as const, message: '可用' }
    } catch (e) {
      return { label, status: 'error' as const, message: String(e) }
    }
  }))
  res.json({ ok: true, results })
})

// GET /api/gemini/prompts
router.get('/api/gemini/prompts', (_req, res) => {
  res.json({ ok: true, prompts: readGeminiPrompts() })
})

// POST /api/gemini/prompts
router.post('/api/gemini/prompts', writeLimiter, (req, res) => {
  const body = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    template: z.string().min(1),
    category: z.string().default(''),
  }).parse(req.body)
  db.prepare('INSERT OR REPLACE INTO gemini_prompts (id, name, template, category) VALUES (?, ?, ?, ?)').run(body.id, body.name, body.template, body.category)
  res.json({ ok: true })
})

// DELETE /api/gemini/prompts/:id
router.delete('/api/gemini/prompts/:id', (req, res) => {
  db.prepare('DELETE FROM gemini_prompts WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

// ─── Per-user AI key endpoints ────────────────────────────────────────────────
// Keys are scoped to the requesting user's email. No user can read or affect
// another user's personal keys.

// GET /api/user-ai-keys — list current user's personal key stubs (key masked)
router.get('/api/user-ai-keys', (req, res) => {
  const account = getAuthAccount(req)
  if (!account) { res.status(401).json({ error: 'unauthenticated' }); return }
  const rows = db.prepare('SELECT provider, label, api_key FROM user_ai_keys WHERE user_email = ?')
    .all(account.email) as { provider: string; label: string; api_key: string }[]
  const keys = rows.map(r => ({
    provider: r.provider,
    label: r.label,
    keyMasked: r.api_key.slice(0, 7) + '****' + r.api_key.slice(-4),
  }))
  res.json({ ok: true, keys })
})

// PUT /api/user-ai-keys/:provider — set or update personal key for a provider
router.put('/api/user-ai-keys/:provider', writeLimiter, (req, res) => {
  const account = getAuthAccount(req)
  if (!account) { res.status(401).json({ error: 'unauthenticated' }); return }
  const provider = req.params.provider  // 'gemini' | 'openai' | 'ollama'
  const { key, label } = z.object({ key: z.string().min(8), label: z.string().default('') }).parse(req.body)
  setUserAiKey(account.email, provider, key, label)
  res.json({ ok: true })
})

// DELETE /api/user-ai-keys/:provider — remove personal key for a provider
router.delete('/api/user-ai-keys/:provider', (req, res) => {
  const account = getAuthAccount(req)
  if (!account) { res.status(401).json({ error: 'unauthenticated' }); return }
  deleteUserAiKey(account.email, req.params.provider)
  res.json({ ok: true })
})

// GET /api/history
router.get('/api/history', (req, res) => {
  const feature = typeof req.query.feature === 'string' && req.query.feature !== 'all' ? req.query.feature : null
  const days = parseInt(typeof req.query.days === 'string' ? req.query.days : '7', 10) || 7
  const since = Date.now() - days * 24 * 60 * 60 * 1000
  const rows = feature
    ? db.prepare('SELECT * FROM operation_history WHERE feature = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 200').all(feature, since)
    : db.prepare('SELECT * FROM operation_history WHERE created_at >= ? ORDER BY created_at DESC LIMIT 200').all(since)
  res.json({ ok: true, records: rows })
})
