/**
 * server/agent-runner.ts
 * Standalone worker agent — connects to central server via WebSocket,
 * joins a session, then claims machines one at a time (work-stealing),
 * runs each locally, and reports events back.
 *
 * Usage (on worker machine, from project root):
 *   CENTRAL_URL=ws://192.168.1.100:3000 node dist/server/agent-runner.js
 *
 * Optional env vars:
 *   CENTRAL_URL    WebSocket URL of the central server (default: ws://localhost:3000)
 *   AGENT_LABEL    Display name for this agent (default: machine hostname)
 *   AGENT_OWNER_KEY   Operator key this agent belongs to
 *   AGENT_OWNER_NAME  Operator display name
 *   AGENT_TOKEN       Local Agent registration token
 *   AGENT_CAPABILITIES Comma-separated capability list (default: machine-test,scripted-bet)
 *   GEMINI_API_KEY Gemini API key for CCTV vision test (optional)
 */
import WebSocket from 'ws'
import { hostname, tmpdir } from 'os'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { MachineTestRunner } from './machine-test/runner.js'
import type { MachineTestSession, MachineProfile, TestEvent } from './machine-test/types.js'
import { ScriptedBetRunner } from './scripted-bet/runner.js'
import type { ScriptedBetAccount, ScriptedBetConfig, ScriptedBetEvent } from './scripted-bet/types.js'
import type { Page } from 'playwright'

const CENTRAL_URL = (process.env.CENTRAL_URL ?? 'ws://localhost:3000').trim().replace(/\/$/, '')
const AGENT_LABEL = process.env.AGENT_LABEL ?? hostname()
const AGENT_ID = `${AGENT_LABEL}_${process.pid}`
const AGENT_OWNER_KEY = (process.env.AGENT_OWNER_KEY ?? '').trim()
const AGENT_OWNER_NAME = (process.env.AGENT_OWNER_NAME ?? AGENT_OWNER_KEY).trim()
const AGENT_TOKEN = (process.env.AGENT_TOKEN ?? '').trim()
const AGENT_CAPABILITIES = (process.env.AGENT_CAPABILITIES ?? 'machine-test,scripted-bet,uat-record,uat-run')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean)
const AGENT_VERSION = '2026-05-agent-owner-v1'

let currentRunner: { stop: () => void } | null = null

interface SessionJoinMessage {
  type: 'session_join'
  sessionId: string
  /** Base session config — machineCodes is empty; agent claims codes via claim_job */
  session: MachineTestSession
  profiles: MachineProfile[]
  betRandomConfig: Record<string, string[]>
  osmMachineStatus: [string, number][]
  geminiKey?: string
  ollamaBaseUrl?: string
  ollamaModel?: string
}

interface ScriptedBetStartMessage {
  type: 'scripted_bet_start'
  sessionId: string
  accounts: ScriptedBetAccount[]
  config: ScriptedBetConfig
}

interface UatRecordStartMessage {
  type: 'uat_record_start'
  sessionId: string
  url: string
  resolution: string
  platform?: 'h5' | 'pc'
}

interface UatRecordCropMessage {
  type: 'uat_record_crop'
  sessionId: string
  scriptId: string
  platform: string
  name: string
  threshold: number
  createdBy: string
}

interface UatRecordStopMessage {
  type: 'uat_record_stop'
  sessionId: string
}

interface UatScriptRunMessage {
  type: 'uat_script_run'
  runId: string
  steps: string
  url: string
  platform: 'h5' | 'pc'
  resolution: string
  failureMode: string
  headed: boolean
}

interface UiScreenshotStartMessage {
  type: 'ui_screenshot_start'
  sessionId: string
  run: {
    id: string
    gameUrlTemplate: string
    tasks: Array<{ id: string; gmid: string; resolution: string }>
    options: Record<string, boolean | number>
    concurrency: number
  }
}

type IncomingMessage =
  | SessionJoinMessage
  | ScriptedBetStartMessage
  | UatRecordStartMessage
  | UatRecordCropMessage
  | UatRecordStopMessage
  | UatScriptRunMessage
  | UiScreenshotStartMessage
  | { type: 'job_assigned'; machineCode: string }
  | { type: 'no_more_jobs' }
  | { type: 'stop' }
  | { type: string }

// ── UAT Recording (Chrome CDP) ───────────────────────────────────────────────

type CdpMessage = { id?: number; result?: Record<string, unknown>; error?: { message?: string } }
type CdpSend = (method: string, params?: object) => Promise<CdpMessage>

interface UatRecSession {
  sessionId: string
  proc: ReturnType<typeof spawn>
  profileDir: string
  done: boolean
  steps: object[]
  width: number
  height: number
  platform: 'h5' | 'pc'
  ws?: WebSocket
  cdpSend?: CdpSend
  cropRequest?: { scriptId: string; platform: string; name: string; threshold: number; createdBy: string }
}

const uatRecSessions = new Map<string, UatRecSession>()

// ── UAT Script Run Sessions ──────────────────────────────────────────────────
const uatScriptRuns = new Map<string, { active: boolean }>()

// ── UI Screenshot Run Sessions ────────────────────────────────────────────────
const uiScreenshotRuns = new Map<string, { stopped: boolean }>()

interface UiScreenshotRunConfig {
  id: string
  gameUrlTemplate: string
  tasks: Array<{ id: string; gmid: string; resolution: string }>
  options: Record<string, boolean | number>
  concurrency: number
}

function normalizeMachineCode(value: string): string {
  return value.trim().toUpperCase().replace(/[–—−]/g, '-')
}

function machineTextHasExactCode(text: string | null | undefined, machineCode: string): boolean {
  if (!text) return false
  const expected = normalizeMachineCode(machineCode)
  const normalized = normalizeMachineCode(text)
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`).test(normalized)
}

async function enterUiScreenshotMachine(page: Page, machineCode: string): Promise<'entered' | 'already-in-game'> {
  const lobbyItem = await page.waitForSelector('#grid_gm_item', { timeout: 15000 }).catch(() => null)
  if (!lobbyItem) return 'already-in-game'

  let foundMachine = false
  for (let attempt = 1; attempt <= 3; attempt++) {
    const items = await page.$$('#grid_gm_item')
    for (const item of items) {
      const title = await item.getAttribute('title')
      const cardText = await item.innerText().catch(() => '')
      if (!machineTextHasExactCode(`${title ?? ''} ${cardText}`, machineCode)) continue
      foundMachine = true

      await item.scrollIntoViewIfNeeded().catch(() => {})
      await item.evaluate(el => (el as HTMLElement).click())
      console.log(`[UI-SS] ${machineCode} selected lobby item: ${title ?? cardText.slice(0, 80)} (attempt ${attempt})`)
      await page.waitForTimeout(1500)

      const joinClicked = await clickFirstVisible(page, [
        "//div[contains(@class,'gm-info-box')]//span[normalize-space(text())='Join']",
        "//div[contains(@class,'gm-info-box')]//*[normalize-space(text())='Join']",
        "//*[normalize-space(text())='Join']",
        "//*[contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'join')]",
        ".gm-info-box [class*='join']",
        "[class*='join']",
      ])
      if (joinClicked) {
        console.log(`[UI-SS] ${machineCode} clicked Join`)
        await page.waitForTimeout(3000)
        return 'entered'
      }

      const panelText = await page.locator('.gm-info-box').first().innerText({ timeout: 1000 }).catch(() => '')
      console.log(`[UI-SS] ${machineCode} Join not found (attempt ${attempt}) panel="${panelText.replace(/\s+/g, ' ').slice(0, 160)}"`)
      await page.keyboard.press('Escape').catch(() => {})
      await page.waitForTimeout(1000)
      break
    }

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    await page.waitForSelector('#grid_gm_item', { timeout: 15000 }).catch(() => null)
    await page.waitForTimeout(1500)
  }

  if (foundMachine) throw new Error(`Join button not found after selecting machine: ${machineCode}`)
  throw new Error(`Lobby machine not found: ${machineCode}`)
}

async function isUiScreenshotLobbyVisible(page: Page): Promise<boolean> {
  const items = await page.locator('#grid_gm_item').all().catch(() => [])
  for (const item of items) {
    if (await item.isVisible().catch(() => false)) return true
  }
  return false
}

async function waitForUiScreenshotReady(page: Page, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isUiScreenshotLobbyVisible(page)) {
      await page.waitForTimeout(500)
      continue
    }

    const ready = await page.evaluate(() => {
      const gameSelectors = ['.my-button.btn_spin', '.balance-bg.hand_balance', '.h-balance.hand_balance']
      const hasGameUi = gameSelectors.some(sel =>
        Array.from(document.querySelectorAll(sel)).some(el => (el as HTMLElement).offsetParent !== null),
      )
      const videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[]
      const hasVideo = videos.some(v => !v.paused && v.readyState >= 2 && v.videoWidth > 0)
      const canvases = Array.from(document.querySelectorAll('canvas')) as HTMLCanvasElement[]
      const hasCanvas = canvases.some(c => c.width > 100 && c.height > 100)

      return hasGameUi || hasVideo || hasCanvas
    }).catch(() => false)

    if (ready) return true
    await page.waitForTimeout(500)
  }
  return false
}

async function isUiScreenshotPopupVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const selectors = ['.select-bg', '.select-main', '.van-popup', '.van-overlay']
    return selectors.some(sel =>
      Array.from(document.querySelectorAll(sel)).some(el => {
        const node = el as HTMLElement
        const rect = node.getBoundingClientRect()
        const style = window.getComputedStyle(node)
        return rect.width > 20 && rect.height > 20 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
      }),
    )
  }).catch(() => false)
}

async function clickFirstVisible(page: Page, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    const locator = selector.startsWith('//') ? page.locator(`xpath=${selector}`) : page.locator(selector)
    const count = await locator.count().catch(() => 0)
    for (let i = 0; i < count; i++) {
      const target = locator.nth(i)
      if (!await target.isVisible().catch(() => false)) continue
      await target.evaluate(el => (el as HTMLElement).click()).catch(async () => {
        await target.click({ force: true, timeout: 1000 })
      })
      return true
    }
  }
  return false
}

async function waitForUiScreenshotLobby(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isUiScreenshotLobbyVisible(page)) return true
    await page.waitForTimeout(500)
  }
  return false
}

async function exitUiScreenshotMachine(page: Page, machineCode: string): Promise<void> {
  const cashoutSelectors = [
    '.handle-main .my-button.btn_cashout',
    '.my-button.btn_cashout',
    '.btn_cashout',
    '[class*="btn_cashout"]',
    '[class*="cashout"]',
  ]
  const exitSelectors = [
    '.function-btn .reserve-btn-gray',
    '.reserve-btn-gray',
    '[class*="exit"]',
    '[class*="back"]',
    "//button[normalize-space(text())='Exit']",
    "//button[normalize-space(text())='Exit To Lobby']",
    "//*[contains(concat(' ', normalize-space(@class), ' '), ' reserve-btn-gray ') and normalize-space(.)='Exit']",
    "//*[contains(concat(' ', normalize-space(@class), ' '), ' reserve-btn-gray ') and normalize-space(.)='Exit To Lobby']",
  ]
  const confirmSelectors = [
    "//button[.//div[normalize-space(text())='Confirm']]",
    "//button[normalize-space(text())='Confirm']",
    "//button[normalize-space(text())='確認']",
    "//*[normalize-space(text())='Confirm']",
    "//*[normalize-space(text())='確認']",
  ]

  const cashoutClicked = await clickFirstVisible(page, cashoutSelectors)
  if (cashoutClicked) {
    console.log(`[UI-SS] ${machineCode} clicked cashout`)
    await page.waitForTimeout(3000)
    if (await waitForUiScreenshotLobby(page, 1500)) {
      console.log(`[UI-SS] ${machineCode} returned to lobby after cashout`)
      return
    }
  }

  if (!cashoutClicked) {
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(1000)
    if (await isUiScreenshotLobbyVisible(page)) {
      console.log(`[UI-SS] ${machineCode} returned to lobby after Escape`)
      return
    }
  }

  console.log(`[UI-SS] ${machineCode} checking second-step exit/confirm`)
  await page.waitForTimeout(1000)
  const exitClicked = await clickFirstVisible(page, exitSelectors).catch(() => false)
  if (exitClicked) {
    console.log(`[UI-SS] ${machineCode} clicked second-step Exit`)
    await page.waitForTimeout(1000)
  }

  const confirmClicked = await clickFirstVisible(page, confirmSelectors).catch(() => false)
  if (confirmClicked) {
    console.log(`[UI-SS] ${machineCode} clicked Confirm`)
    await page.waitForTimeout(1000)
  }

  if (await waitForUiScreenshotLobby(page, 12_000)) {
    console.log(`[UI-SS] ${machineCode} returned to lobby`)
    return
  }

  throw new Error(`Exit machine failed before closing page: ${machineCode} (cashout=${cashoutClicked}, exit=${exitClicked}, confirm=${confirmClicked})`)
}

async function runUiScreenshot(runConfig: UiScreenshotRunConfig, serverBaseUrl: string) {
  const { id: runId, gameUrlTemplate, tasks, options } = runConfig
  uiScreenshotRuns.set(runId, { stopped: false })

  const { chromium } = await import('playwright')

  // Group tasks by gmid — one browser session per gmid
  const tasksByGmid = new Map<string, typeof tasks>()
  for (const task of tasks) {
    if (!tasksByGmid.has(task.gmid)) tasksByGmid.set(task.gmid, [])
    tasksByGmid.get(task.gmid)!.push(task)
  }

  const postStatus = (taskId: string, status: string, errorMsg?: string) =>
    fetch(`${serverBaseUrl}/api/ui-screenshot/task/${taskId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, errorMsg }),
    }).catch(() => {})

  for (const [gmid, gmidTasks] of tasksByGmid) {
    const ctrl = uiScreenshotRuns.get(runId)
    if (ctrl?.stopped) break

    const url = gameUrlTemplate.replace('{gmid}', gmid)
    console.log(`[UI-SS] gmid=${gmid} url=${url} resolutions=${gmidTasks.map(t => t.resolution).join(',')}`)

    let browser: import('playwright').Browser | null = null
    try {
      // ── 進入機器 ──────────────────────────────────────────────────────────
      const firstTask = gmidTasks[0]
      const [w0, h0] = firstTask.resolution.split('x').map(Number)
      browser = await chromium.launch({ headless: !options.headedMode })
      const ctx = await browser.newContext({ viewport: { width: w0 || 390, height: h0 || 844 } })
      const page = await ctx.newPage()

      await postStatus(firstTask.id, 'running')
      await page.goto(url, { timeout: 30000 })
      const entryState = await enterUiScreenshotMachine(page, gmid)
      console.log(`[UI-SS] ${gmid} entry=${entryState}`)
      console.log(`[UI-SS] ${gmid} — page loaded`)

      // ── 檢測推流 ──────────────────────────────────────────────────────────
      const ready = await waitForUiScreenshotReady(page)
      if (!ready) throw new Error(`Game surface not ready after entering machine: ${gmid}`)
      console.log(`[UI-SS] ${gmid} — stream ready`)

      // ── 機器內操作：點選面額 ───────────────────────────────────────────────
      if (options.dismissPopup !== false) {
        const popupEl = await page.$('.select-bg')
        if (popupEl) {
          const firstBtn = await page.$('.select-row .van-col')
          if (firstBtn) {
            await firstBtn.click()
            await page.waitForTimeout(800)
            console.log(`[UI-SS] ${gmid} — denom popup dismissed`)
          }
        }
      }
      const screenshotDelaySeconds = typeof options.screenshotDelaySeconds === 'number'
        ? Math.max(0, Math.min(60, options.screenshotDelaySeconds))
        : 5
      if (screenshotDelaySeconds > 0) {
        console.log(`[UI-SS] ${gmid} waiting ${screenshotDelaySeconds}s before screenshots`)
        await page.waitForTimeout(screenshotDelaySeconds * 1000)
      }

      // ── 截圖（調整 viewport，不重新導航）────────────────────────────────
      for (const task of gmidTasks) {
        const ctrl2 = uiScreenshotRuns.get(runId)
        if (ctrl2?.stopped) break

        if (task.id !== firstTask.id) await postStatus(task.id, 'running')

        const [w, h] = task.resolution.split('x').map(Number)
        await page.setViewportSize({ width: w || 390, height: h || 844 })
        await page.waitForTimeout(400) // let layout settle after resize
        if (await isUiScreenshotLobbyVisible(page)) {
          throw new Error(`Still in lobby before screenshot: ${gmid}`)
        }

        const screenshotBuf = await page.screenshot({ type: 'png', fullPage: false })
        const taskStatus = await isUiScreenshotPopupVisible(page) ? 'popup' : 'ok'
        console.log(`[UI-SS] ${gmid} ${task.resolution} → ${taskStatus}`)

        const form = new FormData()
        form.append('screenshot', new Blob([new Uint8Array(screenshotBuf)], { type: 'image/png' }), `${task.resolution}.png`)
        form.append('status', taskStatus)
        const uploadRes = await fetch(`${serverBaseUrl}/api/ui-screenshot/task/${task.id}/upload`, {
          method: 'POST', body: form,
        })
        if (!uploadRes.ok) {
          const uploadError = `upload failed: HTTP ${uploadRes.status}`
          console.warn(`[UI-SS] ${gmid} ${task.resolution} ${uploadError}`)
          await postStatus(task.id, 'err', uploadError)
        }
      }

      // ── 離開機器 ──────────────────────────────────────────────────────────
      await exitUiScreenshotMachine(page, gmid)
      console.log(`[UI-SS] ${gmid} — done, closing browser`)

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message.split('\n')[0] : String(err)
      const isTimeout = errorMsg.includes('timeout') || errorMsg.includes('Timeout')
      const status = isTimeout ? 'timeout' : 'err'
      console.error(`[UI-SS] ${gmid} error: ${errorMsg}`)
      for (const task of gmidTasks) {
        await postStatus(task.id, status, errorMsg)
      }
    } finally {
      await browser?.close().catch(() => {})
    }
  }

  uiScreenshotRuns.delete(runId)
}

async function runUatScript(msg: UatScriptRunMessage, serverWs: WebSocket) {
  const { runId, steps: stepsRaw, url: startUrl, platform, resolution, failureMode, headed } = msg
  const sendEvent = (event: Record<string, unknown>) => {
    if (serverWs.readyState === serverWs.OPEN) {
      serverWs.send(JSON.stringify({ type: 'uat_run_event', runId, event }))
    }
  }
  const log = (line: string) => sendEvent({ kind: 'log', line })

  type StepObj = { name?: string; action: string; value?: string; selector?: string; x?: number; y?: number; baselineId?: string; threshold?: number; scrollStep?: number; maxScrolls?: number }
  let steps: StepObj[]
  try { steps = JSON.parse(stepsRaw) as StepObj[] } catch {
    await log('❌ 步驟 JSON 解析失敗')
    sendEvent({ kind: 'error', message: '步驟 JSON 解析失敗' })
    uatScriptRuns.delete(runId)
    return
  }

  const [rawW, rawH] = resolution.split('x').map(Number)
  const w = rawW || 390
  const h = rawH || 844
  await log(`🔧 準備啟動瀏覽器：${headed ? 'Headed' : 'Headless'}，viewport ${w}x${h}`)

  const pw = await import('playwright')
  let browser: import('playwright').Browser | null = null
  let chromeProc: ReturnType<typeof spawn> | null = null
  let chromeProfileDir: string | null = null
  let passed = 0; let failed = 0; let skipped = 0

  try {
    if (headed) {
      const port = 9400 + Math.floor(Math.random() * 400)
      const profileDir = join(tmpdir(), `toppath-run-${runId}`)
      chromeProfileDir = profileDir
      const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        '--no-first-run', '--no-default-browser-check', '--new-window',
        `--window-size=${w + 20},${h + 140}`,
        'about:blank',
      ]
      chromeProc = spawn(chromeExecutable(), args, { stdio: 'ignore', shell: false, windowsHide: false })
      await waitForJson(`http://127.0.0.1:${port}/json/version`)
      browser = await pw.chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    } else {
      browser = await pw.chromium.launch({ headless: true, args: ['--force-device-scale-factor=1'] })
    }
    await log('✅ 瀏覽器已啟動')

    const ctx = headed
      ? (browser.contexts()[0] ?? await browser.newContext())
      : await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: platform === 'h5', hasTouch: platform === 'h5' })
    const page = headed
      ? (ctx.pages()[0] ?? await ctx.newPage())
      : await ctx.newPage()
    if (headed) {
      await page.setViewportSize({ width: w, height: h }).catch(() => {})
    }
    await log('✅ 執行頁面已準備完成')

    for (const [i, step] of steps.entries()) {
      if (!uatScriptRuns.get(runId)?.active) { await log('🛑 執行已中止'); break }
      const label = step.name ?? `步驟 ${i + 1}`
      const idx = `[${i + 1}/${steps.length}]`
      try {
        if (step.action === 'goto') {
          const target = step.value || startUrl
          await log(`⏳ ${idx} ${label} → ${target}`)
          await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 })
          await page.waitForTimeout(3000)
          await log(`✅ ${idx} ${label}`)
          sendEvent({ kind: 'step_result', index: i, status: 'pass', message: label })
          passed++
        } else if (step.action === 'click') {
          await log(`⏳ ${idx} ${label}`)
          await page.locator(step.selector ?? '').click({ timeout: 10000 })
          await log(`✅ ${idx} ${label}`)
          sendEvent({ kind: 'step_result', index: i, status: 'pass', message: label })
          passed++
        } else if (step.action === 'click_xy') {
          await log(`⏳ ${idx} ${label}`)
          await page.locator('canvas').first().click({ position: { x: step.x ?? 0, y: step.y ?? 0 }, timeout: 10000 })
          await log(`✅ ${idx} ${label}`)
          sendEvent({ kind: 'step_result', index: i, status: 'pass', message: label })
          passed++
        } else if (step.action === 'click_viewport') {
          await log(`⏳ ${idx} ${label}`)
          await page.mouse.click(step.x ?? 0, step.y ?? 0)
          await page.waitForTimeout(500)
          await log(`✅ ${idx} ${label}`)
          sendEvent({ kind: 'step_result', index: i, status: 'pass', message: label })
          passed++
        } else if (step.action === 'type' || step.action === 'fill') {
          await log(`⏳ ${idx} ${label}`)
          await page.locator(step.selector ?? '').fill(step.value ?? '', { timeout: 10000 })
          await log(`✅ ${idx} ${label}`)
          sendEvent({ kind: 'step_result', index: i, status: 'pass', message: label })
          passed++
        } else if (step.action === 'wait') {
          await log(`⏳ ${idx} ${label}`)
          await page.waitForTimeout(Number(step.value) || 1000)
          await log(`✅ ${idx} ${label}`)
          sendEvent({ kind: 'step_result', index: i, status: 'pass', message: label })
          passed++
        } else if (step.action === 'screenshot') {
          await log(`⏳ ${idx} ${label}`)
          await page.screenshot()
          await log(`✅ ${idx} ${label}`)
          sendEvent({ kind: 'step_result', index: i, status: 'pass', message: label })
          passed++
        } else if (step.action === 'assert_visible') {
          await log(`⏳ ${idx} ${label}`)
          await page.locator(step.selector ?? '').waitFor({ state: 'visible', timeout: 10000 })
          await log(`✅ ${idx} ${label}`)
          sendEvent({ kind: 'step_result', index: i, status: 'pass', message: label })
          passed++
        } else {
          await log(`⏭ ${idx} ${label}（不支援的動作：${step.action}）`)
          sendEvent({ kind: 'step_result', index: i, status: 'skip', message: `不支援: ${step.action}` })
          skipped++
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message.split('\n')[0] : String(err)
        await log(`❌ ${idx} ${label}：${errMsg}`)
        sendEvent({ kind: 'step_result', index: i, status: 'fail', message: errMsg })
        failed++
        const browserClosed = errMsg.includes('closed') || errMsg.includes('Target crashed')
        if (failureMode === 'stop' || browserClosed) {
          await log(browserClosed ? '🛑 瀏覽器已關閉，中止執行' : '🛑 失敗後停止')
          break
        }
      }
    }

    const result = failed > 0 ? 'fail' : 'pass'
    await log(`─── 完成 ─── 通過 ${passed} ／ 失敗 ${failed} ／ 跳過 ${skipped}`)
    sendEvent({ kind: 'done', passed, failed, skipped, result })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message.split('\n')[0] : String(err)
    await log(`❌ 執行器初始化失敗：${errMsg}`)
    sendEvent({ kind: 'done', passed, failed, skipped, result: 'fail' })
  } finally {
    await browser?.close().catch(() => {})
    if (chromeProc) {
      try {
        if (process.platform === 'win32' && chromeProc.pid) {
          spawn('taskkill', ['/F', '/T', '/PID', String(chromeProc.pid)], { stdio: 'ignore', shell: false })
        } else {
          chromeProc.kill('SIGTERM')
        }
      } catch {}
    }
    if (chromeProfileDir) { try { rmSync(chromeProfileDir, { recursive: true, force: true }) } catch {} }
    uatScriptRuns.delete(runId)
    console.log(`[Agent:${AGENT_LABEL}] UAT script run finished: ${runId}`)
  }
}

function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter(Boolean) as string[]
  return candidates.find(p => existsSync(p)) ?? (process.platform === 'win32' ? 'chrome.exe' : 'google-chrome')
}

async function waitForJson<T>(url: string, timeoutMs = 20_000): Promise<T> {
  const started = Date.now()
  let lastError: unknown
  while (Date.now() - started < timeoutMs) {
    // Try both localhost and 127.0.0.1 — Windows Chrome may bind to either
    for (const candidate of [url, url.replace('127.0.0.1', 'localhost')]) {
      try {
        const r = await fetch(candidate, { signal: AbortSignal.timeout(2000) })
        if (r.ok) return await r.json() as T
      } catch (error) { lastError = error }
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`Chrome DevTools not ready after ${timeoutMs}ms: ${lastError instanceof Error ? lastError.message : String(lastError ?? '')}`)
}

function recorderScript() {
  return `
(() => {
  if (window.__toppathRecorderInstalled) return;
  window.__toppathRecorderInstalled = true;
  const sent = new Set();
  const cssPath = (el) => {
    if (!el || el === document || el === window) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    const testId = el.getAttribute && (el.getAttribute('data-testid') || el.getAttribute('data-test'));
    if (testId) return '[data-testid="' + testId.replace(/"/g, '\\\\"') + '"]';
    const name = el.getAttribute && el.getAttribute('name');
    if (name) return el.tagName.toLowerCase() + '[name="' + name.replace(/"/g, '\\\\"') + '"]';
    const text = (el.innerText || el.textContent || '').trim();
    if (text && text.length <= 40) return 'text=' + text;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 4) {
      let part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      const siblings = node.parentNode ? [...node.parentNode.children] : [];
      const idx = siblings.indexOf(node);
      if (siblings.length > 1) part += ':nth-child(' + (idx + 1) + ')';
      parts.unshift(part);
      node = node.parentNode;
    }
    return parts.join(' > ');
  };
  document.addEventListener('click', (e) => {
    const el = e.target;
    const key = Date.now() + ':' + (el && el.tagName);
    if (sent.has(key)) return;
    sent.add(key);
    setTimeout(() => sent.delete(key), 200);
    const step = { name: 'Click ' + cssPath(el), action: 'click', selector: cssPath(el) };
    console.info('__TOPPATH_RECORDER__', JSON.stringify(step));
  }, true);
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!el || !el.value) return;
    const step = { name: 'Input ' + cssPath(el), action: 'fill', selector: cssPath(el), value: el.value };
    console.info('__TOPPATH_RECORDER__', JSON.stringify(step));
  }, true);
})();
`
}

function cropScript() {
  return `
(() => {
  if (window.__toppathCropInstalled) return;
  window.__toppathCropInstalled = true;
  window.__toppathStartCropMode = () => {
    const layer = document.createElement('div');
    layer.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,0.25);';
    document.body.appendChild(layer);
    let drawing = false, sx = 0, sy = 0;
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483648;border:2px solid #f59e0b;background:rgba(245,158,11,0.15);';
    document.body.appendChild(overlay);
    const draw = (e) => {
      const ex = e.clientX, ey = e.clientY;
      const x = Math.min(sx, ex), y = Math.min(sy, ey), w = Math.abs(ex - sx), h = Math.abs(ey - sy);
      overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483648;border:2px solid #f59e0b;background:rgba(245,158,11,0.15);left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px;';
      return { x, y, w, h };
    };
    const close = () => { layer.remove(); overlay.remove(); window.__toppathCropInstalled = false; delete window.__toppathStartCropMode; };
    layer.addEventListener('mousedown', event => { event.preventDefault(); event.stopPropagation(); drawing = true; sx = event.clientX; sy = event.clientY; }, true);
    layer.addEventListener('mousemove', event => { if (!drawing) return; event.preventDefault(); event.stopPropagation(); draw(event); }, true);
    layer.addEventListener('mouseup', event => {
      if (!drawing) return; event.preventDefault(); event.stopPropagation(); drawing = false;
      const box = draw(event); close();
      if (box.w >= 5 && box.h >= 5) console.info('__TOPPATH_CROP__', JSON.stringify(box));
    }, true);
  };
})();
`
}

function recordableWindowSize(width: number, height: number) {
  return {
    width: width + (process.platform === 'win32' ? 16 : 0),
    height: height + (process.platform === 'win32' ? 96 : 90),
  }
}

async function syncUatViewport(sess: UatRecSession) {
  if (!sess.cdpSend) return
  await sess.cdpSend('Emulation.setDeviceMetricsOverride', {
    width: sess.width,
    height: sess.height,
    deviceScaleFactor: 1,
    mobile: sess.platform === 'h5',
  })
  const size = await sess.cdpSend('Runtime.evaluate', {
    expression: '({ dw: Math.max(0, window.outerWidth - window.innerWidth), dh: Math.max(0, window.outerHeight - window.innerHeight) })',
    returnByValue: true,
  })
  const delta = size.result?.result as { value?: { dw?: number; dh?: number } } | undefined
  const bounds = await sess.cdpSend('Browser.getWindowForTarget')
  const windowId = (bounds.result as { windowId?: number } | undefined)?.windowId
  if (typeof windowId === 'number') {
    await sess.cdpSend('Browser.setWindowBounds', {
      windowId,
      bounds: {
        width: sess.width + Math.round(delta?.value?.dw ?? 0),
        height: sess.height + Math.round(delta?.value?.dh ?? 0),
      },
    })
  }
}

function killUatSession(sess: UatRecSession) {
  try { sess.ws?.close() } catch {}
  try {
    if (process.platform === 'win32' && sess.proc.pid) {
      spawn('taskkill', ['/F', '/T', '/PID', String(sess.proc.pid)], { stdio: 'ignore', shell: false })
    } else {
      sess.proc.kill('SIGTERM')
    }
  } catch {}
  try { rmSync(sess.profileDir, { recursive: true, force: true }) } catch {}
}

function connectUatRecorder(sess: UatRecSession, port: number, serverWs: WebSocket) {
  // Try both 127.0.0.1 and localhost for Windows CDP binding differences
  const cdpBase = `http://127.0.0.1:${port}`

  void (async () => {
    let attempt = 0
    while (!sess.done && attempt < 3) {
      attempt++
      try {
        const targets = await waitForJson<Array<{ type: string; webSocketDebuggerUrl?: string }>>(`${cdpBase}/json/list`)
        const target = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl)
        if (!target?.webSocketDebuggerUrl) throw new Error('No Chrome page target found')

        const cdpUrl = target.webSocketDebuggerUrl.replace('127.0.0.1', 'localhost')
        const ws = new WebSocket(cdpUrl)
        sess.ws = ws
        let msgId = 0
        const pending = new Map<number, (v: CdpMessage) => void>()
        const send = (method: string, params?: object) => new Promise<CdpMessage>(resolve => {
          const reqId = ++msgId
          pending.set(reqId, resolve)
          ws.send(JSON.stringify({ id: reqId, method, params }))
        })
        sess.cdpSend = send

        await new Promise<void>((resolveConn, rejectConn) => {
          ws.on('open', async () => {
            console.log(`[Agent:${AGENT_LABEL}] CDP connected (attempt ${attempt})`)
            try {
              await send('Runtime.enable')
              await send('Page.enable')
              await syncUatViewport(sess)
              await send('Page.addScriptToEvaluateOnNewDocument', { source: recorderScript() + '\n' + cropScript() })
              await send('Runtime.evaluate', { expression: recorderScript() + '\n' + cropScript() })
              resolveConn()
            } catch (e) { rejectConn(e) }
          })
          ws.on('error', rejectConn)
          ws.on('close', () => {
            // CDP WS closed (page reload or Chrome closed)
            if (!sess.done) {
              // Try to reconnect
              void connectUatRecorder(sess, port, serverWs)
            }
          })
          ws.on('message', raw => {
            try {
              const msg = JSON.parse(String(raw)) as { id?: number; method?: string; params?: { type?: string; args?: Array<{ value?: unknown }> } }
              if (msg.id && pending.has(msg.id)) { pending.get(msg.id)?.({ id: msg.id, result: (msg as Record<string, unknown>).result as Record<string, unknown> }); pending.delete(msg.id); return }
              if (msg.method === 'Runtime.consoleAPICalled') {
                const args = msg.params?.args ?? []
                if (args[0]?.value === '__TOPPATH_RECORDER__' && typeof args[1]?.value === 'string') {
                  try {
                    const step = JSON.parse(args[1].value as string)
                    sess.steps.push(step)
                    if (serverWs.readyState === serverWs.OPEN) {
                      serverWs.send(JSON.stringify({ type: 'uat_record_event', sessionId: sess.sessionId, event: { kind: 'step', step } }))
                    }
                  } catch {}
                }
                if (args[0]?.value === '__TOPPATH_CROP__' && typeof args[1]?.value === 'string') {
                  try { void handleAgentCrop(sess, JSON.parse(args[1].value as string), serverWs) } catch {}
                }
              }
              if (msg.method === 'Page.loadEventFired') {
                void syncUatViewport(sess)
                void send('Runtime.evaluate', { expression: recorderScript() })
                void send('Runtime.evaluate', { expression: cropScript() })
              }
            } catch {}
          })
        })

        // Connected successfully — stay connected (loop ends naturally when sess.done)
        return

      } catch (err) {
        console.error(`[Agent:${AGENT_LABEL}] UAT CDP connect attempt ${attempt} failed:`, err)
        if (attempt < 3 && !sess.done) {
          await new Promise(resolve => setTimeout(resolve, 3000))
        }
      }
    }

    // All attempts failed — notify server but DO NOT mark session done
    // Chrome is still running; user may need to manually stop/restart recording
    console.error(`[Agent:${AGENT_LABEL}] CDP connection failed after ${attempt} attempts — Chrome is open but recorder script unavailable`)
    if (serverWs.readyState === serverWs.OPEN) {
      serverWs.send(JSON.stringify({
        type: 'uat_record_event',
        sessionId: sess.sessionId,
        event: { kind: 'cdp_warn', message: `Chrome 已開啟但 CDP 連線失敗（嘗試 ${attempt} 次），步驟錄製無法使用，但可以手動截圖。` },
      }))
    }
  })()
}

async function handleAgentCrop(sess: UatRecSession, crop: { x: number; y: number; w: number; h: number }, serverWs: WebSocket) {
  const request = sess.cropRequest
  if (!request || !sess.cdpSend) return
  const cropX = Math.max(0, Math.round(crop.x))
  const cropY = Math.max(0, Math.round(crop.y))
  const cropW = Math.max(1, Math.round(crop.w))
  const cropH = Math.max(1, Math.round(crop.h))
  try {
    const shot = await sess.cdpSend('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      clip: { x: cropX, y: cropY, width: cropW, height: cropH, scale: 1 },
    })
    const imageBase64 = shot.result?.data
    if (typeof imageBase64 !== 'string') return
    const id = randomUUID()
    if (serverWs.readyState === serverWs.OPEN) {
      serverWs.send(JSON.stringify({
        type: 'uat_record_event',
        sessionId: sess.sessionId,
        event: {
          kind: 'crop_image',
          id,
          imageBase64,
          name: request.name,
          x: cropX, y: cropY, w: cropW, h: cropH,
          threshold: request.threshold,
          platform: request.platform,
          scriptId: request.scriptId,
          createdBy: request.createdBy,
        },
      }))
    }
    sess.cropRequest = undefined
  } catch (err) {
    console.error(`[Agent:${AGENT_LABEL}] UAT crop error:`, err)
    sess.cropRequest = undefined
  }
}

/** Promise resolve for the pending claim_job → job_assigned/no_more_jobs round-trip */
let pendingClaimResolve: ((code: string | null) => void) | null = null

/** Live OSM machine status — updated in real-time by server pushes */
const currentOsmMap = new Map<string, number>()

function connect() {
  const url = `${CENTRAL_URL}/ws/agent`
  console.log(`[Agent:${AGENT_LABEL}] Connecting to ${url} ...`)
  const ws = new WebSocket(url)

  ws.on('open', () => {
    console.log(`[Agent:${AGENT_LABEL}] Connected — ready`)
    ws.send(JSON.stringify({
      type: 'agent_ready',
      agentId: AGENT_ID,
      hostname: AGENT_LABEL,
      operatorKey: AGENT_OWNER_KEY,
      operatorName: AGENT_OWNER_NAME,
      agentToken: AGENT_TOKEN,
      capabilities: AGENT_CAPABILITIES,
      version: AGENT_VERSION,
    }))
  })

  ws.on('message', async (raw) => {
    let msg: IncomingMessage
    try { msg = JSON.parse(raw.toString()) } catch { return }

    // ── Server response: next machine to test ──────────────────────────────────
    // ── Live OSM status push from server ──────────────────────────────────────
    if (msg.type === 'osm_status_update') {
      const updates = (msg as { type: 'osm_status_update'; updates: { machineId: string; status: number }[] }).updates
      if (Array.isArray(updates)) {
        for (const { machineId, status } of updates) {
          currentOsmMap.set(machineId, status)
        }
      }
      return
    }

    if (msg.type === 'job_assigned') {
      pendingClaimResolve?.((msg as { type: 'job_assigned'; machineCode: string }).machineCode)
      pendingClaimResolve = null
      return
    }

    if (msg.type === 'no_more_jobs') {
      pendingClaimResolve?.(null)
      pendingClaimResolve = null
      return
    }

    // ── Stop: kill current runner immediately ─────────────────────────────────
    if (msg.type === 'stop') {
      console.log(`[Agent:${AGENT_LABEL}] Stop requested`)
      currentRunner?.stop()
      // Abort any pending claim
      pendingClaimResolve?.(null)
      pendingClaimResolve = null
      return
    }

    // ── Session join: start claim-loop for the given session ──────────────────
    if (msg.type === 'scripted_bet_start') {
      const { sessionId, accounts, config } = msg as ScriptedBetStartMessage
      console.log(`[Agent:${AGENT_LABEL}] Scripted Bet session ${sessionId} started (${accounts.length} accounts)`)
      const runner = new ScriptedBetRunner(sessionId, accounts, config)
      currentRunner = runner

      runner.on('event', (ev: ScriptedBetEvent) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'scripted_bet_event', sessionId, event: ev }))
        }
      })

      runner.run()
        .catch(err => {
          console.error(`[Agent:${AGENT_LABEL}] Scripted Bet ${sessionId} error:`, err)
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({
              type: 'scripted_bet_event',
              sessionId,
              event: {
                type: 'error',
                sessionId,
                status: 'stopped',
                message: String(err),
                ts: new Date().toISOString(),
              } satisfies ScriptedBetEvent,
            }))
          }
        })
        .finally(() => {
          if (currentRunner === runner) currentRunner = null
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'scripted_bet_done', sessionId }))
          }
        })
      return
    }

    // ── UAT Recording ────────────────────────────────────────────────────────────
    if (msg.type === 'uat_record_start') {
      const { sessionId, url, resolution, platform = 'h5' } = msg as UatRecordStartMessage
      const [w, h] = resolution.split('x')
      const width = Number(w) || 390
      const height = Number(h) || 844
      const initialWindow = recordableWindowSize(width, height)
      const port = 9300 + Math.floor(Math.random() * 400)
      const profileDir = join(tmpdir(), `toppath-uat-${sessionId}`)
      const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        '--no-first-run', '--no-default-browser-check', '--new-window',
        `--window-size=${initialWindow.width},${initialWindow.height}`,
        url,
      ]
      const proc = spawn(chromeExecutable(), args, { stdio: 'ignore', shell: false, windowsHide: false })
      const sess: UatRecSession = {
        sessionId, proc, profileDir, done: false,
        width, height, platform,
        steps: [{ name: '前往頁面', action: 'goto', value: url }],
      }
      uatRecSessions.set(sessionId, sess)
      proc.on('close', () => {
        sess.done = true
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'uat_record_event', sessionId, event: { kind: 'done', steps: sess.steps } }))
        }
        uatRecSessions.delete(sessionId)
      })
      connectUatRecorder(sess, port, ws)
      console.log(`[Agent:${AGENT_LABEL}] UAT record started: ${sessionId}`)
      return
    }

    if (msg.type === 'uat_record_crop') {
      const { sessionId, scriptId, platform, name, threshold, createdBy } = msg as UatRecordCropMessage
      const sess = uatRecSessions.get(sessionId)
      if (!sess || !sess.cdpSend) return
      sess.cropRequest = { scriptId, platform, name, threshold, createdBy }
      void sess.cdpSend('Runtime.evaluate', { expression: 'window.__toppathStartCropMode && window.__toppathStartCropMode()' })
      return
    }

    if (msg.type === 'uat_record_stop') {
      const { sessionId } = msg as UatRecordStopMessage
      const sess = uatRecSessions.get(sessionId)
      if (!sess) return
      const steps = sess.steps
      sess.done = true  // Set before kill so CDP WS-close handler won't trigger reconnect
      killUatSession(sess)
      uatRecSessions.delete(sessionId)
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'uat_record_event', sessionId, event: { kind: 'done', steps } }))
      }
      console.log(`[Agent:${AGENT_LABEL}] UAT record stopped: ${sessionId}`)
      return
    }

    if (msg.type === 'uat_script_run') {
      const scriptMsg = msg as UatScriptRunMessage
      uatScriptRuns.set(scriptMsg.runId, { active: true })
      void runUatScript(scriptMsg, ws)
      return
    }

    if (msg.type === 'uat_script_stop') {
      const { runId } = msg as { type: string; runId: string }
      const run = uatScriptRuns.get(runId)
      if (run) run.active = false
      return
    }

    if (msg.type === 'ui_screenshot_start') {
      const { run: runConfig } = msg as UiScreenshotStartMessage
      console.log(`[Agent:${AGENT_LABEL}] UI Screenshot run ${runConfig.id} started (${runConfig.tasks.length} tasks)`)
      void runUiScreenshot(runConfig, CENTRAL_URL.replace(/^ws/, 'http'))
      return
    }

    if (msg.type === 'ui_screenshot_stop') {
      const { sessionId } = msg as { type: string; sessionId: string }
      const ctrl = uiScreenshotRuns.get(sessionId)
      if (ctrl) ctrl.stopped = true
      return
    }

    if (msg.type === 'session_join') {
      const { sessionId, session, profiles, betRandomConfig, osmMachineStatus, geminiKey, ollamaBaseUrl, ollamaModel } = msg as SessionJoinMessage

      // Configure AI/runtime env vars
      if (geminiKey) process.env.GEMINI_API_KEY = geminiKey
      if (ollamaBaseUrl) process.env.OLLAMA_BASE_URL = ollamaBaseUrl
      if (ollamaModel) process.env.OLLAMA_MODEL = ollamaModel
      if (session.cctvModelSpec) process.env.CCTV_MODEL_SPEC = session.cctvModelSpec
      else delete process.env.CCTV_MODEL_SPEC

      // Seed the module-level osmMap with the session snapshot; live updates will keep it current
      currentOsmMap.clear()
      for (const [k, v] of osmMachineStatus) currentOsmMap.set(k, v)
      const profileMap = new Map<string, MachineProfile>(profiles.map(p => [p.machineType, p]))

      console.log(`[Agent:${AGENT_LABEL}] Joined session ${sessionId} — starting claim-loop`)

      const runClaimLoop = async () => {
        while (true) {
          // Request the next available machine from the central queue
          const code = await new Promise<string | null>((resolve) => {
            pendingClaimResolve = resolve
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: 'claim_job', sessionId }))
            } else {
              resolve(null)
            }
          })

          if (!code) break  // no_more_jobs or WS closed

          console.log(`[Agent:${AGENT_LABEL}] Claimed machine: ${code}`)
          let failed = false

          try {
            // Create a fresh runner for each machine (avoids stale state)
            const runner = new MachineTestRunner(currentOsmMap, profileMap, betRandomConfig)
            currentRunner = runner

            runner.on('event', (ev: TestEvent) => {
              // Filter out session lifecycle events — central server manages these directly
              if (ev.type === 'session_done') return   // server emits unified session_done
              if (ev.type === 'session_start') return  // each machine run() sends one; would clear viewer results
              if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type: 'event', sessionId, event: ev }))
              }
            })

            // Agent always runs headless — ignore headedMode from main UI
            await runner.run({ ...session, sessionId, machineCodes: [code], headedMode: session.headedMode === true })
          } catch (err) {
            console.error(`[Agent:${AGENT_LABEL}] Machine ${code} error:`, err)
            failed = true
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({
                type: 'event',
                sessionId,
                event: {
                  type: 'error',
                  message: `機台 ${code} 執行錯誤：${String(err)}`,
                  ts: new Date().toISOString(),
                } as TestEvent,
              }))
            }
          } finally {
            currentRunner = null
          }

          // Report this machine's result to the central queue
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'job_done', sessionId, machineCode: code, failed }))
          }
        }

        // Claim-loop exhausted — signal done and release agent slot
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'agent_done', sessionId }))
        }
        console.log(`[Agent:${AGENT_LABEL}] No more jobs — session ${sessionId} complete`)
      }

      runClaimLoop().catch(err => {
        console.error(`[Agent:${AGENT_LABEL}] Claim loop error:`, err)
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'agent_done', sessionId }))
        }
      })
    }
  })

  ws.on('close', (code) => {
    console.log(`[Agent:${AGENT_LABEL}] Disconnected (code=${code}), reconnecting in 5s ...`)
    currentRunner = null
    // Abort any in-flight claim
    pendingClaimResolve?.(null)
    pendingClaimResolve = null
    setTimeout(connect, 5000)
  })

  ws.on('error', (err) => {
    console.error(`[Agent:${AGENT_LABEL}] WS error:`, err.message)
  })
}

connect()
