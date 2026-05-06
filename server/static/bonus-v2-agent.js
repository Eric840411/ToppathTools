#!/usr/bin/env node
import { chromium } from 'playwright'

const args = parseArgs(process.argv.slice(2))
const gameUrl = args.url
const sessionId = args.session
const serverUrl = (args.server || 'http://localhost:3000').replace(/\/+$/, '')

if (!gameUrl || !sessionId) {
  console.error('Usage: node bonus-v2-agent.js --url=GAME_URL --session=SESSION_ID --server=http://SERVER_URL')
  process.exit(1)
}

const COLOR_MAP = {
  801: '黃', 802: '白', 803: '粉', 804: '藍', 805: '紅', 806: '綠'
}

/** 解析 d.v[10][143] 電子骰資料（bonus-v2 規格） */
function parseBonusData(data143) {
  const result = { single_m2: [], single_m3: [], any_double: null, any_triple: null }
  for (const [key, val] of Object.entries(data143)) {
    const k = Number(key)
    if (k >= 801 && k <= 806) {
      const color = COLOR_MAP[k] ?? `色${k}`
      if (val?.matchColors === 2) result.single_m2.push({ color, rate: val.rate ?? 0 })
      else if (val?.matchColors === 3) result.single_m3.push({ color, rate: val.rate ?? 0 })
    } else if (k === 807) {
      result.any_double = { color: COLOR_MAP[val?.bonusColor] ?? String(val?.bonusColor ?? ''), rate: val?.rate ?? 0 }
    } else if (k === 808) {
      result.any_triple = { color: COLOR_MAP[val?.bonusColor] ?? String(val?.bonusColor ?? ''), rate: val?.rate ?? 0 }
    }
  }
  return result
}

const processedRounds = new Set()
const pendingReports = []
let retryTimer = null
let stopped = false
let browser = null
let context = null
let page = null
let roundCount = 0

function parseArgs(argv) {
  const result = {}
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq < 0) {
      result[arg.slice(2)] = 'true'
    } else {
      result[arg.slice(2, eq)] = arg.slice(eq + 1)
    }
  }
  return result
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function frameText(payload) {
  return (typeof payload === 'string' ? payload : payload.toString('utf8')).trim()
}

function stripKnownPrefix(raw) {
  let text = raw.trim()
  if (text.startsWith('0|#$')) text = text.slice(4).trim()
  if (text.startsWith('$#|#$')) text = text.slice(5).trim()
  return text
}

function parseFrame(raw) {
  const text = stripKnownPrefix(raw)
  if (!text.startsWith('{') && !text.startsWith('[')) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function getRoundColors(round) {
  const colors = []
  for (const item of round.single_m2 || []) colors.push(item.color)
  for (const item of round.single_m3 || []) colors.push(item.color)
  if (round.any_double?.color) colors.push(round.any_double.color)
  if (round.any_triple?.color) colors.push(round.any_triple.color)
  return [...new Set(colors)].filter(Boolean).slice(0, 3).join('/') || '-'
}

function logRound(round) {
  roundCount += 1
  const colors = getRoundColors(round)
  const twoSame = (round.single_m2 || []).map(item => item.color).filter(Boolean).join('/') || '-'
  const threeSame = (round.single_m3 || []).map(item => item.color).filter(Boolean).join('/') || '-'
  console.log(`[Round ${roundCount}] ${colors} | 2同: ${twoSame} 3同: ${threeSame}`)
}

async function postRound(round) {
  const res = await fetch(`${serverUrl}/api/gs/bonus-v2-client/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, round })
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  if (!json || !json.ok) throw new Error(json?.message || 'report failed')
}

function enqueueReport(round) {
  pendingReports.push({ round, retries: 0, nextAt: Date.now() })
  flushReports()
}

function scheduleRetry() {
  if (stopped || retryTimer || !pendingReports.length) return
  const nextAt = pendingReports.reduce((min, item) => Math.min(min, item.nextAt), Infinity)
  retryTimer = setTimeout(() => {
    retryTimer = null
    flushReports()
  }, Math.max(1000, Math.min(5000, nextAt - Date.now())))
}

async function flushReports() {
  if (stopped) return
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }

  const now = Date.now()
  const ready = pendingReports.filter(item => item.nextAt <= now)
  if (!ready.length) {
    scheduleRetry()
    return
  }

  for (const item of ready) {
    try {
      await postRound(item.round)
      const idx = pendingReports.indexOf(item)
      if (idx >= 0) pendingReports.splice(idx, 1)
    } catch (err) {
      if (item.retries >= 3) {
        const idx = pendingReports.indexOf(item)
        if (idx >= 0) pendingReports.splice(idx, 1)
        console.error(`[report] failed after 3 retries, discarded: ${String(err?.message || err)}`)
      } else {
        item.retries += 1
        item.nextAt = Date.now() + 5000
        console.error(`[report] failed, retry ${item.retries}/3 in 5s: ${String(err?.message || err)}`)
      }
    }
  }

  scheduleRetry()
}

function processRawFrame(raw) {
  if (stopped) return
  const data = parseFrame(raw)
  if (!data || data.e !== 'notify' || data.d?.v?.[3] !== 'prepareBonusResult') return

  const roundId = String(data.d?.v?.[10]?.[0] ?? '')
  if (roundId && processedRounds.has(roundId)) return
  const data143 = data.d?.v?.[10]?.[143]
  if (!data143 || typeof data143 !== 'object' || !Object.keys(data143).length) return

  if (roundId) processedRounds.add(roundId)
  const round = parseBonusData(data143)
  logRound(round)
  enqueueReport(round)
}

async function stopSession() {
  try {
    await fetch(`${serverUrl}/api/gs/bonus-v2-client/stop/${encodeURIComponent(sessionId)}`, { method: 'POST' })
    console.log('[agent] session stopped')
  } catch (err) {
    console.error(`[agent] stop failed: ${String(err?.message || err)}`)
  }
}

async function closeBrowser() {
  if (page) await page.close().catch(() => {})
  if (context) await context.close().catch(() => {})
  if (browser) await browser.close().catch(() => {})
  page = null
  context = null
  browser = null
}

async function runCapture() {
  console.log(`[agent] server: ${serverUrl}`)
  console.log(`[agent] session: ${sessionId}`)
  console.log(`[agent] opening: ${gameUrl}`)

  while (!stopped) {
    let reconnect
    const reconnectPromise = new Promise(resolve => { reconnect = resolve })
    let loaded = false
    let reconnecting = false
    const requestReconnect = reason => {
      if (stopped || reconnecting) return
      reconnecting = true
      console.error(`[agent] reconnecting: ${reason}`)
      reconnect()
    }

    try {
      await closeBrowser()
      browser = await chromium.launch({ headless: true })
      context = await browser.newContext()
      page = await context.newPage()

      page.on('websocket', ws => {
        console.log(`[ws] connected: ${ws.url()}`)
        ws.on('framereceived', frame => processRawFrame(frameText(frame.payload)))
        ws.on('close', () => console.log(`[ws] closed: ${ws.url()}`))
      })
      page.on('crash', () => requestReconnect('page crashed'))
      page.on('close', () => requestReconnect('page closed'))
      page.on('framenavigated', frame => {
        if (!loaded || frame !== page.mainFrame()) return
        if (page.url() !== gameUrl) requestReconnect(`navigated away to ${page.url()}`)
      })

      console.log('[agent] navigating')
      await page.goto(gameUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
      loaded = true
      console.log('[agent] capture running; press Ctrl+C to stop')
      await reconnectPromise
    } catch (err) {
      if (!stopped) console.error(`[agent] capture error: ${String(err?.message || err)}`)
    }

    if (!stopped) await sleep(3000)
  }
}

process.on('SIGINT', async () => {
  if (stopped) return
  stopped = true
  console.log('\n[agent] stopping')
  if (retryTimer) clearTimeout(retryTimer)
  await stopSession()
  await closeBrowser()
  process.exit(0)
})

runCapture().catch(async err => {
  console.error(`[agent] fatal: ${String(err?.message || err)}`)
  stopped = true
  await closeBrowser()
  process.exit(1)
})
