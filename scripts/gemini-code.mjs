#!/usr/bin/env node
/**
 * scripts/gemini-code.mjs
 *
 * Delegates a code-generation task to Gemini, using the keys stored in the
 * project's SQLite DB (server/data.db) or the GEMINI_API_KEY env var.
 *
 * Usage (Claude Code calls this via Bash):
 *   node scripts/gemini-code.mjs "Write a TypeScript function that..."
 *   echo "prompt text" | node scripts/gemini-code.mjs
 *
 * Output: raw Gemini response printed to stdout.
 */

import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = join(__dirname, '../server/data.db')
const MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash'

// ── Get prompt from args or stdin ──────────────────────────────────────────
let prompt = process.argv[2] ?? ''
if (!prompt) {
  try { prompt = readFileSync('/dev/stdin', 'utf8').trim() } catch { /* no stdin */ }
}
if (!prompt) {
  console.error('Usage: node scripts/gemini-code.mjs "<prompt>"')
  process.exit(1)
}

// ── Load API keys ──────────────────────────────────────────────────────────
function loadKeys() {
  const keys = []
  try {
    const db = new Database(DB_PATH, { readonly: true })
    const rows = db.prepare('SELECT key FROM gemini_keys').all()
    keys.push(...rows.map(r => r.key).filter(Boolean))
    db.close()
  } catch { /* DB not accessible */ }
  const envKey = process.env.GEMINI_API_KEY ?? ''
  if (envKey) keys.push(envKey)
  return keys
}

// ── Call Gemini ────────────────────────────────────────────────────────────
async function callGemini(key, prompt) {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2 },
      }),
    },
  )
  const data = await resp.json()
  // RESOURCE_EXHAUSTED can mean daily quota (skip key) or RPM rate limit (retry after delay)
  if (data.error?.status === 'RESOURCE_EXHAUSTED') {
    const msg = data.error?.message ?? ''
    // RPM rate limit: retry with delay; daily quota: mark exhausted
    if (msg.includes('quota_metric') && msg.includes('per_minute')) return { rateLimited: true }
    if (msg.includes('per_day') || msg.includes('GenerateRequestsPerDayPerProjectPerModel')) return { exhausted: true }
    // Default: treat as rate limited (can retry)
    return { rateLimited: true }
  }
  if (!resp.ok || data.error) throw new Error(data.error?.message ?? `HTTP ${resp.status}`)
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error(`Empty response, finishReason: ${data.candidates?.[0]?.finishReason}`)
  return { text }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── Main ───────────────────────────────────────────────────────────────────
const keys = loadKeys()
if (keys.length === 0) {
  console.error('No Gemini API keys found. Add keys via Gemini Settings or set GEMINI_API_KEY in .env')
  process.exit(1)
}

// Try each key; if all rate-limited, wait 5s and retry once
for (let attempt = 0; attempt < 2; attempt++) {
  if (attempt > 0) {
    console.error('All keys rate-limited, waiting 5s before retry...')
    await sleep(5000)
  }
  for (const key of keys) {
    try {
      const result = await callGemini(key, prompt)
      if (result.exhausted) { console.error('Key daily quota exhausted, trying next...'); continue }
      if (result.rateLimited) { console.error('Key rate-limited (RPM), trying next...'); continue }
      process.stdout.write(result.text)
      process.exit(0)
    } catch (e) {
      console.error(`Key failed: ${e.message}, trying next...`)
    }
  }
}

console.error('All Gemini keys failed or exhausted.')
process.exit(1)
