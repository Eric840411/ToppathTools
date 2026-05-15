import { EventEmitter } from 'events'
import { chromium, type Browser, type ElementHandle, type Frame, type Page } from 'playwright'
import type {
  ScriptedBetAccount,
  ScriptedBetAccountStatus,
  ScriptedBetConfig,
  ScriptedBetEvent,
} from './types.js'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

interface GMEventData {
  errcode: number
  errcodedes: string
  machineType?: string
}

type GMWaitFn = (timeoutMs: number) => Promise<GMEventData | null>

const GM_EVENT_MONITOR_SCRIPT = `
(() => {
  if (window.__gmMonitorInjected) return;
  window.__gmMonitorInjected = true;
  function scanForGMEvent(text) {
    try {
      for (var i = 0; i < 2; i++) {
        var evName = i === 0 ? 'enterGMNtc' : 'leaveGMNtc';
        if (text.indexOf(evName) === -1) continue;
        var m1 = text.match(/"errcode"\\s*:\\s*(-?\\d+)/);
        var errcode = m1 ? parseInt(m1[1]) : 0;
        var m2 = text.match(/"errcodedes"\\s*:\\s*"([^"]*)"/);
        var errcodedes = m2 ? m2[1] : '';
        var m3 = text.match(/"machineType"\\s*:\\s*"([^"]*)"/);
        var machineType = m3 ? m3[1] : '';
        console.log('__gm_event:' + evName, errcode, errcodedes + '||' + machineType);
        return;
      }
    } catch(e) {}
  }

  var OrigWS = window.WebSocket;
  function PatchedWS(url, protocols) {
    var ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
    ws.addEventListener('message', function(ev) {
      try {
        var text = '';
        if (typeof ev.data === 'string') text = ev.data;
        else if (ev.data instanceof ArrayBuffer) text = new TextDecoder('iso-8859-1').decode(ev.data);
        if (text) scanForGMEvent(text);
      } catch(e) {}
    });
    return ws;
  }
  PatchedWS.prototype = OrigWS.prototype;
  PatchedWS.CONNECTING = OrigWS.CONNECTING;
  PatchedWS.OPEN = OrigWS.OPEN;
  PatchedWS.CLOSING = OrigWS.CLOSING;
  PatchedWS.CLOSED = OrigWS.CLOSED;
  window.WebSocket = PatchedWS;
})();
`

function randInt(min: number, max: number) {
  const lo = Math.min(min, max)
  const hi = Math.max(min, max)
  return Math.floor(Math.random() * (hi - lo + 1)) + lo
}

async function sleepOrStop(ms: number, shouldStop: () => boolean) {
  const end = Date.now() + ms
  while (Date.now() < end && !shouldStop()) {
    await sleep(Math.min(250, end - Date.now()))
  }
}

function tryExtractGMEvent(text: string): ({ event: 'enterGMNtc' | 'leaveGMNtc' } & GMEventData) | null {
  for (const eventName of ['enterGMNtc', 'leaveGMNtc'] as const) {
    const idx = text.indexOf(eventName)
    if (idx === -1) continue

    let start = idx
    while (start > 0 && text[start] !== '{') start--
    let outerStart = start
    let depth = 0
    for (let i = start; i >= 0; i--) {
      if (text[i] === '}') depth++
      else if (text[i] === '{') {
        if (depth === 0) {
          outerStart = i
          break
        }
        depth--
      }
    }

    depth = 0
    let end = -1
    for (let i = outerStart; i < Math.min(text.length, outerStart + 2000); i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end === -1) continue

    try {
      const parsed = JSON.parse(text.slice(outerStart, end + 1)) as Record<string, unknown>
      const eventKey = parsed['event'] ?? parsed['route']
      if (eventKey !== eventName) continue
      const body = (parsed['body'] as Record<string, unknown> | undefined) ?? parsed
      const machineType = String(body['machineType'] ?? parsed['machineType'] ?? '')
      return {
        event: eventName,
        errcode: Number(body['errcode'] ?? parsed['errcode'] ?? 0),
        errcodedes: String(body['errcodedes'] ?? parsed['errcodedes'] ?? ''),
        ...(machineType ? { machineType } : {}),
      }
    } catch {
      // malformed JSON, try the next event name
    }
  }
  return null
}

function createGMEventWatcher(page: Page): { waitForEnterGM: GMWaitFn; waitForLeaveGM: GMWaitFn } {
  let enterResolve: ((v: GMEventData | null) => void) | null = null
  let leaveResolve: ((v: GMEventData | null) => void) | null = null
  let enterBuffer: GMEventData | null = null
  let leaveBuffer: GMEventData | null = null

  const dispatch = (event: 'enterGMNtc' | 'leaveGMNtc', data: GMEventData) => {
    if (event === 'enterGMNtc') {
      if (enterResolve) {
        enterResolve(data)
        enterResolve = null
      } else {
        enterBuffer = data
      }
      return
    }

    if (leaveResolve) {
      leaveResolve(data)
      leaveResolve = null
    } else {
      leaveBuffer = data
    }
  }

  page.on('websocket', ws => {
    ws.on('framereceived', frame => {
      try {
        const text = Buffer.from(frame.payload as string, 'binary').toString('latin1')
        const event = tryExtractGMEvent(text)
        if (event) dispatch(event.event, event)
      } catch {
        // ignore malformed frames
      }
    })
  })

  page.on('console', msg => {
    try {
      const text = msg.text()
      if (!text.startsWith('__gm_event:')) return
      const parts = text.split(' ')
      const eventName = parts[0].replace('__gm_event:', '') as 'enterGMNtc' | 'leaveGMNtc'
      if (eventName !== 'enterGMNtc' && eventName !== 'leaveGMNtc') return
      const errcode = parseInt(parts[1] ?? '0') || 0
      const rawDes = parts.slice(2).join(' ')
      const sepIdx = rawDes.lastIndexOf('||')
      const errcodedes = sepIdx >= 0 ? rawDes.slice(0, sepIdx) : rawDes
      const machineType = sepIdx >= 0 ? rawDes.slice(sepIdx + 2) : ''
      dispatch(eventName, { errcode, errcodedes, ...(machineType ? { machineType } : {}) })
    } catch {
      // ignore malformed console logs
    }
  })

  const makeWaiter = (type: 'enter' | 'leave'): GMWaitFn => (timeoutMs) =>
    new Promise<GMEventData | null>(resolve => {
      if (type === 'enter' && enterBuffer) {
        const buffered = enterBuffer
        enterBuffer = null
        resolve(buffered)
        return
      }
      if (type === 'leave' && leaveBuffer) {
        const buffered = leaveBuffer
        leaveBuffer = null
        resolve(buffered)
        return
      }

      const timer = setTimeout(() => {
        if (type === 'enter') enterResolve = null
        else leaveResolve = null
        resolve(null)
      }, timeoutMs)
      const wrapped = (v: GMEventData | null) => {
        clearTimeout(timer)
        resolve(v)
      }
      if (type === 'enter') enterResolve = wrapped
      else leaveResolve = wrapped
    })

  return { waitForEnterGM: makeWaiter('enter'), waitForLeaveGM: makeWaiter('leave') }
}

async function safeClick(page: Page, selector: string, timeout = 2000): Promise<boolean> {
  try {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      for (const frame of page.frames()) {
        try {
          const els = await frame.$$(selector)
          for (const el of els) {
            if (await el.isVisible()) {
              await el.evaluate((node: Element) => (node as HTMLElement).click())
              return true
            }
          }
        } catch {
          // frame may detach; continue
        }
      }
      await sleep(150)
    }
    return false
  } catch {
    return false
  }
}

async function safeClickXPath(page: Page, xpath: string, timeout = 2000): Promise<boolean> {
  try {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      for (const frame of page.frames()) {
        try {
          const els = await frame.$$(xpath)
          for (const el of els) {
            if (await el.isVisible()) {
              await el.evaluate((node: Element) => (node as HTMLElement).click())
              return true
            }
          }
        } catch {
          // frame may detach; continue
        }
      }
      await sleep(150)
    }
    return false
  } catch {
    return false
  }
}

function textXPath(labels: string[]): string {
  const tests = labels.map(label => {
    const escaped = label.replace(/'/g, "\\'")
    return `contains(normalize-space(.),'${escaped}')`
  })
  return `//*[self::button or self::div or self::span or self::a][${tests.join(' or ')}]`
}

async function clickAnyText(page: Page, labels: string[], timeout = 1500): Promise<string | null> {
  const xpath = textXPath(labels)
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try {
        const els = await frame.$$(xpath)
        for (const el of els) {
          if (await el.isVisible()) {
            await el.evaluate((node: Element) => (node as HTMLElement).click())
            const text = await el.evaluate((node: Element) => (node.textContent ?? '').trim())
            return text || labels[0]
          }
        }
      } catch {
        // frame may detach; continue
      }
    }
    await sleep(150)
  }
  return null
}

async function hasVisible(page: Page, selectors: string[], timeout = 500): Promise<boolean> {
  for (const selector of selectors) {
    try {
      const loc = page.locator(selector).first()
      await loc.waitFor({ state: 'visible', timeout })
      return true
    } catch {
      // try next selector
    }
  }
  return false
}

async function hasVisibleXPath(page: Page, xpath: string, timeout = 500): Promise<boolean> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try {
        const els = await frame.$$(xpath)
        for (const el of els) {
          if (await el.isVisible()) return true
        }
      } catch {
        // frame may detach; continue
      }
    }
    await sleep(100)
  }
  return false
}

async function isMachinePreviewOpen(page: Page): Promise<boolean> {
  return hasVisibleXPath(
    page,
    "//*[self::button or self::div or self::span or self::a][normalize-space(.)='Join' or contains(normalize-space(.),'Game Preview')]",
    300,
  )
}

async function isInGame(page: Page): Promise<boolean> {
  if (await isMachinePreviewOpen(page)) return false
  try {
    const lobby = await page.$('#grid_gm_item')
    if (lobby && await lobby.isVisible()) return false
  } catch {
    // Continue with in-game selectors.
  }
  return hasVisible(page, [
    '.my-button.btn_spin',
    '.btn_spin .my-button',
    '.btn_spin',
    '[class*="btn_spin"]',
    '.balance-bg.hand_balance',
    '.h-balance.hand_balance',
    '[class*="hand_balance"]',
  ], 700)
}

function machineCodeCandidates(machineCode: string): string[] {
  const trimmed = machineCode.trim()
  const parts = trimmed.split('-').filter(Boolean)
  const withoutSite = parts.length >= 3 ? parts.slice(1).join('-') : trimmed
  const compact = withoutSite.replace(/\s+/g, '')
  return [...new Set([trimmed, withoutSite, compact].filter(Boolean))]
}

async function clickJoinButton(page: Page, emit: (msg: string) => void): Promise<boolean> {
  const joinXpaths = [
    "//div[contains(@class,'gm-info-box')]//span[normalize-space(text())='Join']",
    "//*[self::button or self::div or self::span or self::a][normalize-space(.)='Join']",
    "//*[self::button or self::div or self::span or self::a][.//span[normalize-space(text())='Join']]",
  ]

  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    for (const xpath of joinXpaths) {
      for (const frame of page.frames()) {
        try {
          const joinEls = await frame.$$(xpath)
          for (const join of joinEls) {
            if (await join.isVisible()) {
              await join.evaluate((el: Element) => (el as HTMLElement).click())
              emit('click Join button')
              await sleep(3000)
              return true
            }
          }
        } catch {
          // frame may detach; continue
        }
      }
    }
    await sleep(250)
  }
  return false
}

async function clickMachineCard(page: Page, machineCode: string, emit: (msg: string) => void): Promise<boolean> {
  const deadline = Date.now() + 30_000
  const candidates = machineCodeCandidates(machineCode)
  while (Date.now() < deadline) {
    try {
      const items = await page.$$('#grid_gm_item')
      for (const item of items) {
        const title = await item.getAttribute('title')
        if (title && candidates.some(code => title.includes(code))) {
          await item.scrollIntoViewIfNeeded()
          await item.evaluate((el: Element) => (el as HTMLElement).click())
          emit(`click machine item: ${title}`)
          await sleep(1500)

          if (await clickJoinButton(page, emit)) return true
          emit('machine preview opened, but Join button was not clicked')
          return false
        }
      }
    } catch {
      // Lobby may still be rendering; retry below.
    }

    try {
      await page.mouse.wheel(0, 700)
    } catch {
      // non-critical
    }
    emit(`尋找機台 ${machineCode}，比對 ${candidates.join(' / ')}...`)
    await sleep(900)
  }
  return false
}

async function enterMachine(page: Page, machineCode: string, emit: (msg: string) => void, waitForEnterGM?: GMWaitFn): Promise<boolean> {
  emit(`進入機台，尋找 ${machineCode}`)
  await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})

  try {
    await page.waitForSelector('#grid_gm_item', { timeout: 15_000 })
  } catch {
    if (await isInGame(page)) return true
    emit('lobby machine grid not ready, keep searching')
  }

  const clicked = await clickMachineCard(page, machineCode, emit)
  if (!clicked) return false

  emit(`machine item clicked: ${machineCode}, waiting for enterGMNtc`)
  const enterEvent = waitForEnterGM ? await waitForEnterGM(12_000) : null
  if (enterEvent) {
    emit(`enterGMNtc errcode=${enterEvent.errcode}: ${enterEvent.errcodedes}${enterEvent.machineType ? ` machineType=${enterEvent.machineType}` : ''}`)
    return enterEvent.errcode === 0
  }
  emit('enterGMNtc not received, fallback to DOM detection')

  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    if (await isInGame(page)) return true
    await sleep(800)
  }
  return false
}

type SpinButton = { el: ElementHandle<SVGElement | HTMLElement>; selector: string }

async function isElementDisabled(el: ElementHandle<SVGElement | HTMLElement>): Promise<boolean> {
  return el.evaluate((node: SVGElement | HTMLElement) => {
    const btn = node as HTMLElement & { disabled?: boolean }
    return !!btn.disabled || btn.classList.contains('disabled') || btn.getAttribute('aria-disabled') === 'true'
  })
}

async function findVisibleBySelectors(page: Page, selectors: string[]): Promise<SpinButton | null> {
  for (const selector of selectors) {
    try {
      const els = await page.$$(selector)
      for (const el of els) {
        if (await el.isVisible()) return { el, selector }
      }
    } catch {
      // try next selector
    }
  }
  return null
}

async function findSpinButton(page: Page): Promise<SpinButton | null> {
  const selectors = [
    '.my-button.btn_spin',
    '.btn_spin .my-button',
    '.btn_spin',
    '[class*="btn_spin"] .my-button',
    '[class*="btn_spin"]',
    'button[class*="spin"]',
    '[class*="spin-btn"]',
  ]
  for (const selector of selectors) {
    try {
      const els = await page.$$(selector)
      for (const el of els) {
        if (!await el.isVisible()) continue
        const disabled = await isElementDisabled(el)
        if (disabled) continue
        return { el, selector }
      }
    } catch {
      // try next selector
    }
  }
  return null
}

async function clickSpin(page: Page): Promise<string | null> {
  const button = await findSpinButton(page)
  if (!button) return null
  await button.el.evaluate((node: Element) => (node as HTMLElement).click())
  return button.selector
}

async function clickConfiguredTouchPoints(
  page: Page,
  points: string[],
  emit: (msg: string) => void,
  shouldStop: () => boolean,
): Promise<void> {
  if (!points.length) return
  for (let i = 0; i < points.length; i++) {
    if (shouldStop()) return
    const label = points[i].trim()
    if (!label) continue
    let clicked = false
    try {
      for (const frame of page.frames()) {
        const els = await frame.$$(`//span[normalize-space(text())='${label}']`)
        if (els.length > 0) {
          await els[0].evaluate((node: Element) => (node as HTMLElement).click())
          emit(`click exit-fail touchPoint ${i + 1}/${points.length} "${label}"`)
          clicked = true
          break
        }
      }
    } catch (error) {
      emit(`exit-fail touchPoint "${label}" click failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!clicked) emit(`exit-fail touchPoint "${label}" not found`)
    await sleepOrStop(1000, shouldStop)
  }
}

async function waitSpinSettle(page: Page, shouldStop: () => boolean, spinSelector?: string) {
  const selectors = spinSelector ? [spinSelector] : [
    '.my-button.btn_spin',
    '.btn_spin .my-button',
    '.btn_spin',
    '[class*="btn_spin"] .my-button',
    '[class*="btn_spin"]',
    'button[class*="spin"]',
    '[class*="spin-btn"]',
  ]
  let spinStarted = false
  const start = Date.now()
  const deadline = start + 60_000
  while (Date.now() < deadline && !shouldStop()) {
    try {
      const current = await findVisibleBySelectors(page, selectors)
      if (!current) return
      const disabled = await isElementDisabled(current.el)
      if (disabled && !spinStarted) spinStarted = true
      if (spinStarted && !disabled) return
      if (!spinStarted && Date.now() - start > 1500) return
    } catch {
      return
    }
    await sleep(300)
  }
}

async function tryExit(page: Page, emit: (msg: string) => void, waitForLeaveGM?: GMWaitFn): Promise<boolean> {
  const selectors = [
    '.handle-main .my-button.btn_cashout',
    '.my-button.btn_cashout',
    '.btn_cashout .my-button',
    '.btn_cashout',
    '[class*="btn_cashout"]',
    '[class*="cashout"]',
    '[class*="exit"]',
    '[class*="back"]',
  ]

  const leaveEventPromise = waitForLeaveGM ? waitForLeaveGM(10_000) : Promise.resolve(null)
  let clicked = false
  for (const selector of selectors) {
    if (await safeClick(page, selector, 2500)) {
      emit(`cashout clicked (${selector})`)
      clicked = true
      await sleep(3000)
      break
    }
  }

  if (clicked) {
    emit('cashout clicked, waiting for leaveGMNtc')
    const leaveEvent = await leaveEventPromise
    if (leaveEvent) {
      emit(`leaveGMNtc errcode=${leaveEvent.errcode}: ${leaveEvent.errcodedes}`)
      if (leaveEvent.errcode === 10002) return false
      if (leaveEvent.errcode !== 0) return false
      if (!(await isInGame(page))) return true
    }
  }

  if (!clicked) {
    const text = await clickAnyText(page, ['Cash Out', 'CashOut', 'Quit', 'Exit', 'Exit To Lobby', 'Return', 'Back'], 2500)
    if (text) {
      emit(`click exit text button (${text})`)
      clicked = true
      await sleep(3000)
    }
  }

  if (!clicked) {
    await page.keyboard.press('Escape').catch(() => {})
    await sleep(1000)
    if (!(await isInGame(page))) return true
  }

  emit('leaveGMNtc not received or DOM still in game, trying Exit/Confirm')
  const leaveEvent2Promise = waitForLeaveGM ? waitForLeaveGM(15_000) : Promise.resolve(null)

  await sleep(1000)
  const exitClicked = await safeClick(page, '.function-btn .reserve-btn-gray', 1200)
    || await safeClick(page, '.reserve-btn-gray', 1200)
    || await safeClickXPath(page, "//button[normalize-space(text())='Exit']", 1200)
    || await safeClickXPath(page, "//button[normalize-space(text())='Exit To Lobby']", 1200)
    || await safeClickXPath(page, "//*[contains(concat(' ', normalize-space(@class), ' '), ' reserve-btn-gray ') and normalize-space(.)='Exit To Lobby']", 1200)
    || await clickAnyText(page, ['Exit', 'Exit To Lobby', 'Quit', 'Leave', 'Return', 'Back'], 1200) !== null
  if (exitClicked) {
    emit('click Exit button')
    await sleep(1000)
  }

  const confirmClicked = await safeClickXPath(page, "//button[.//div[normalize-space(text())='Confirm']]", 1200)
    || await safeClickXPath(page, "//button[normalize-space(text())='Confirm']", 1200)
    || await safeClickXPath(page, "//button[contains(normalize-space(.),'Confirm')]", 1200)
    || await clickAnyText(page, ['Confirm', 'OK', 'Yes', 'Sure'], 1800) !== null
  if (confirmClicked) emit('click Confirm button')

  if (exitClicked || confirmClicked) {
    const eventAfterClick = await Promise.race([
      leaveEvent2Promise,
      new Promise<null>(resolve => setTimeout(() => resolve(null), 10_000)),
    ])
    if (eventAfterClick) {
      emit(`leaveGMNtc errcode=${eventAfterClick.errcode}: ${eventAfterClick.errcodedes}`)
      if (eventAfterClick.errcode === 10002) return false
      if (eventAfterClick.errcode !== 0) return false
      if (!(await isInGame(page))) return true
    }
  }

  const exitDeadline = Date.now() + 12_000
  while (Date.now() < exitDeadline) {
    if (!(await isInGame(page))) {
      const finalEvent = await Promise.race([
        leaveEvent2Promise,
        new Promise<null>(resolve => setTimeout(() => resolve(null), 300)),
      ])
      if (finalEvent && finalEvent.errcode !== 0) {
        emit(`leaveGMNtc errcode=${finalEvent.errcode}: ${finalEvent.errcodedes}`)
        return false
      }
      return true
    }
    await sleep(500)
  }

  const finalEvent = await Promise.race([
    leaveEvent2Promise,
    new Promise<null>(resolve => setTimeout(() => resolve(null), 300)),
  ])
  if (finalEvent) {
    emit(`leaveGMNtc errcode=${finalEvent.errcode}: ${finalEvent.errcodedes}`)
    return finalEvent.errcode === 0 && !(await isInGame(page))
  }
  return false

}

export class ScriptedBetRunner extends EventEmitter {
  private stopped = false
  private statuses: ScriptedBetAccountStatus[]
  private currentContext: Awaited<ReturnType<Browser['newContext']>> | null = null
  private currentBrowser: Browser | null = null

  constructor(
    private sessionId: string,
    private accounts: ScriptedBetAccount[],
    private config: ScriptedBetConfig,
  ) {
    super()
    this.statuses = accounts.map(account => ({
      account: account.account,
      username: account.username,
      label: account.label,
      state: 'pending',
      targetMachineCode: config.targetMachineCode,
      spinDone: 0,
      exitAttempts: 0,
      message: 'pending',
    }))
  }

  stop() {
    this.stopped = true
    void this.currentContext?.close().catch(() => {})
    void this.currentBrowser?.close().catch(() => {})
  }

  snapshot() {
    return this.statuses
  }

  private send(event: Omit<ScriptedBetEvent, 'sessionId' | 'ts'>) {
    this.emit('event', {
      ...event,
      sessionId: this.sessionId,
      statuses: this.snapshot(),
      ts: new Date().toISOString(),
    } satisfies ScriptedBetEvent)
  }

  private update(account: ScriptedBetAccount, patch: Partial<ScriptedBetAccountStatus>) {
    const row = this.statuses.find(s => s.account === account.account)
    if (!row) return
    Object.assign(row, patch)
    this.send({
      type: 'account_update',
      account: account.account,
      status: row.state,
      message: row.message,
    })
  }

  private log(account: ScriptedBetAccount | null, message: string) {
    this.send({
      type: 'log',
      account: account?.account,
      status: 'info',
      message,
    })
  }

  private async runOne(browser: Browser, account: ScriptedBetAccount) {
    let context: Awaited<ReturnType<Browser['newContext']>> | null = null
    const startedAt = Date.now()
    this.update(account, { state: 'opening', startedAt, message: 'open account URL' })

    try {
      context = await browser.newContext({
        viewport: { width: 430, height: 860 },
        isMobile: true,
        hasTouch: true,
      })
      this.currentContext = context
      await context.addInitScript(GM_EVENT_MONITOR_SCRIPT)
      const page = await context.newPage()
      const { waitForEnterGM, waitForLeaveGM } = createGMEventWatcher(page)
      await page.goto(account.url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      if (this.stopped) throw new Error('stopped')

      this.update(account, { state: 'entering', message: `enter machine ${this.config.targetMachineCode}` })
      const entered = await enterMachine(page, this.config.targetMachineCode, msg => this.log(account, msg), waitForEnterGM)
      if (!entered) {
        this.update(account, {
          state: 'failed',
          finishedAt: Date.now(),
          message: `failed to enter machine ${this.config.targetMachineCode}`,
        })
        return
      }

      this.log(account, 'entered machine, wait 3s before Spin')
      await sleepOrStop(3000, () => this.stopped)
      if (this.stopped) throw new Error('stopped')

      const spinTarget = randInt(this.config.spinMin, this.config.spinMax)
      this.update(account, {
        state: 'spinning',
        spinTarget,
        spinDone: 0,
        message: `Spin target ${spinTarget}`,
      })

      for (let i = 0; i < spinTarget; i++) {
        if (this.stopped) throw new Error('stopped')
        const spinSelector = await clickSpin(page)
        if (!spinSelector) {
          this.update(account, {
            state: 'failed',
            finishedAt: Date.now(),
            message: 'Spin button not found',
          })
          return
        }
        this.log(account, `Spin ${i + 1}/${spinTarget} clicked (${spinSelector})`)
        await waitSpinSettle(page, () => this.stopped, spinSelector)
        this.update(account, {
          state: 'spinning',
          spinDone: i + 1,
          message: `Spin ${i + 1}/${spinTarget} completed`,
        })
        await sleepOrStop(randInt(this.config.spinDelayMinMs, this.config.spinDelayMaxMs), () => this.stopped)
      }

      this.update(account, { state: 'exiting', message: 'exiting machine' })
      for (let attempt = 1; attempt <= this.config.maxExitRetries; attempt++) {
        if (this.stopped) throw new Error('stopped')
        const exited = await tryExit(page, msg => this.log(account, msg), waitForLeaveGM)
        this.update(account, { exitAttempts: attempt })
        if (exited) {
          this.update(account, {
            state: 'done',
            finishedAt: Date.now(),
            message: 'exit succeeded, window will close and continue next account',
          })
          return
        }

        this.update(account, {
          state: 'exiting',
          message: `exit failed ${attempt}/${this.config.maxExitRetries}, click touchPoints then retry Spin`,
        })
        await clickConfiguredTouchPoints(
          page,
          this.config.exitFailTouchPoints ?? [],
          msg => this.log(account, msg),
          () => this.stopped,
        )
        if (this.stopped) throw new Error('stopped')

        const retrySpinSelector = await clickSpin(page)
        if (retrySpinSelector) {
          this.log(account, `exit retry spin clicked (${retrySpinSelector})`)
          await waitSpinSettle(page, () => this.stopped, retrySpinSelector)
          const current = this.statuses.find(s => s.account === account.account)
          this.update(account, {
            spinDone: (current?.spinDone ?? 0) + 1,
            message: 'exit failed, retry Spin completed; preparing to retry exit',
          })
        }
        await sleepOrStop(randInt(this.config.spinDelayMinMs, this.config.spinDelayMaxMs), () => this.stopped)
      }

      this.update(account, {
        state: 'failed',
        finishedAt: Date.now(),
        message: `exit failed after ${this.config.maxExitRetries} attempts`,
      })
    } catch (error) {
      const stopped = this.stopped || (error instanceof Error && error.message === 'stopped')
      this.update(account, {
        state: stopped ? 'stopped' : 'failed',
        finishedAt: Date.now(),
        message: stopped ? 'stopped manually; current window closed' : `run error: ${error instanceof Error ? error.message : String(error)}`,
      })
    } finally {
      await context?.close().catch(() => {})
      if (this.currentContext === context) this.currentContext = null
    }
  }

  async run() {
    let browser: Browser | null = null
    this.send({
      type: 'session_start',
      status: 'info',
      message: `start scripted bet: ${this.accounts.length} accounts, target ${this.config.targetMachineCode}`,
    })

    try {
      browser = await chromium.launch({
        headless: !this.config.headedMode,
        args: this.config.headedMode ? [] : ['--mute-audio'],
      })
      this.currentBrowser = browser

      for (const account of this.accounts) {
        if (this.stopped) {
          this.update(account, { state: 'stopped', finishedAt: Date.now(), message: 'stopped before account start' })
          continue
        }
        await this.runOne(browser, account)
      }

      this.send({
        type: 'session_done',
        status: this.stopped ? 'stopped' : 'done',
        message: this.stopped ? 'scripted bet stopped' : 'all accounts completed',
      })
    } catch (error) {
      this.send({
        type: 'error',
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      await browser?.close().catch(() => {})
      if (this.currentBrowser === browser) this.currentBrowser = null
    }
  }
}
