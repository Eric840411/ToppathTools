#!/usr/bin/env node
/**
 * scripts/openai-code.mjs
 *
 * Delegates a UI/art code-generation task to GPT-4o, using the OpenAI key
 * stored in server/data.db (settings table) or the OPENAI_API_KEY env var.
 *
 * Primary use: game-edition UI/CSS/component generation (美術副手)
 *
 * Usage (Claude Code calls this via Bash):
 *   node scripts/openai-code.mjs "Write a game-style CSS for..."
 *   echo "prompt text" | node scripts/openai-code.mjs
 *
 * Options:
 *   --model <id>   Override model (default: gpt-4o)
 *
 * Output: raw GPT response printed to stdout.
 */

import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = join(__dirname, '../server/data.db')

// ── Parse args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
let model = 'gpt-4o'
let promptArg = ''
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--model' && args[i + 1]) { model = args[++i] }
  else { promptArg = args[i] }
}

let prompt = promptArg
if (!prompt) {
  try { prompt = readFileSync('/dev/stdin', 'utf8').trim() } catch { /* no stdin */ }
}
if (!prompt) {
  console.error('Usage: node scripts/openai-code.mjs "<prompt>" [--model gpt-4o]')
  process.exit(1)
}

// ── Load API key ───────────────────────────────────────────────────────────
function loadKey() {
  try {
    const db = new Database(DB_PATH, { readonly: true })
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('openai_api_key')
    db.close()
    if (row?.value) return row.value
  } catch { /* DB not accessible */ }
  return process.env.OPENAI_API_KEY ?? ''
}

// ── Call OpenAI ────────────────────────────────────────────────────────────
async function callOpenAI(apiKey, prompt, model) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
    }),
  })
  const data = await resp.json()
  if (!resp.ok || data.error) throw new Error(`OpenAI error (${resp.status}): ${data.error?.message ?? 'unknown'}`)
  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error('Empty response from OpenAI')
  return content
}

// ── Main ───────────────────────────────────────────────────────────────────
const apiKey = loadKey()
if (!apiKey) {
  console.error('No OpenAI API key found. Add it via ⚙️ AI 模型和 Prompt 設定 → OpenAI Key, or set OPENAI_API_KEY in .env')
  process.exit(1)
}

try {
  console.error(`[openai-code] → ${model}`)
  const result = await callOpenAI(apiKey, prompt, model)
  process.stdout.write(result)
  process.exit(0)
} catch (e) {
  console.error(`OpenAI failed: ${e.message}`)
  process.exit(1)
}
