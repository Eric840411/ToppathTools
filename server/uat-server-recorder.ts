import { chromium, type Browser } from 'playwright'
import { toUrlPattern } from './uat-runner/net-capture.js'

type Options = {
  backendUrl: string; username: string; password: string; script: string; marker: string;
  event: (payload: string) => void; net: (call: unknown) => void;
  console: (entry: unknown) => void; ws: (frame: unknown) => void;
  done: (error?: string) => void;
}

/** Explicit server mode only; no automatic fallback from a disconnected Agent. */
export async function startServerRecorder(options: Options, launch = () => chromium.launch({ headless: false, args: ['--start-maximized'] })) {
  let browser: Browser | undefined
  let finished = false
  let armed = false
  const redact = (text: string) => text.split(options.password).join('[REDACTED]').slice(0, 1500)
  const finish = async (error?: string) => {
    if (finished) return
    finished = true
    options.done(error)
    await browser?.close().catch(() => {})
  }
  try {
    browser = await launch()
    const context = await browser.newContext({ viewport: null })
    await context.addInitScript(options.script)
    const page = await context.newPage()
    page.on('console', message => {
      const text = message.text()
      if (finished || !armed) return
      if (text.startsWith(options.marker)) options.event(text.slice(options.marker.length).trim())
      else options.console({ type: message.type(), text: redact(text), ts: Date.now() })
    })
    page.on('pageerror', error => { if (armed && !finished) options.console({ type: 'pageerror', text: redact(error.message), ts: Date.now() }) })
    page.on('close', () => { void finish() })
    browser.on('disconnected', () => { void finish() })
    page.on('domcontentloaded', () => {
      if (armed && !finished) void page.evaluate(() => (window as unknown as { __toppathArmRecorder?: () => void }).__toppathArmRecorder?.()).catch(() => {})
    })
    const net = async (request: import('playwright').Request, failed = false) => {
      if (!armed || finished) return
      try {
        const response = failed ? null : await request.response()
        const timing = request.timing(), type = request.resourceType()
        options.net({ method: request.method(), url: request.url(), urlPattern: toUrlPattern(request.url()), status: response?.status() ?? null,
          durationMs: timing.responseEnd >= 0 ? Math.round(timing.responseEnd) : null, resourceType: type,
          kind: ['xhr', 'fetch'].includes(type) ? 'api' : type === 'image' ? 'image' : 'other',
          failure: failed ? request.failure()?.errorText : null, ts: Date.now() })
      } catch { /* Recording must survive individual network failures. */ }
    }
    page.on('requestfinished', request => { void net(request) })
    page.on('requestfailed', request => { void net(request, true) })
    page.on('websocket', socket => {
      const send = (direction: string, payload?: string | Buffer) => {
        if (armed && !finished) options.ws({ direction, url: socket.url(), payload: payload ? redact(String(payload)) : '', ts: Date.now() })
      }
      send('open'); socket.on('framesent', event => send('sent', event.payload)); socket.on('framereceived', event => send('received', event.payload)); socket.on('close', () => send('close'))
    })
    await page.goto(`${options.backendUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.locator('input[type="text"], input[name*="user"], input[id*="user"]').first().fill(options.username)
    await page.locator('input[type="password"]').fill(options.password)
    await page.keyboard.press('Enter')
    await page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 20000 })
    // Match replay setup: the warning can mount after the URL has changed.
    await page.locator('.el-dialog').filter({ hasText: /Warnning|Warning/i }).waitFor({ state: 'visible', timeout: 3000 }).catch(() => {})
    await page.evaluate(() => {
      let found = false
      document.querySelectorAll<HTMLElement>('.el-dialog__wrapper').forEach(el => {
        if (/Warnning|Warning/i.test(el.textContent || '')) { el.style.display = 'none'; found = true }
      })
      const overlay = document.querySelector<HTMLElement>('.v-modal')
      if (found && overlay) overlay.style.display = 'none'
    })
    armed = true
    await page.evaluate(() => (window as unknown as { __toppathArmRecorder?: () => void }).__toppathArmRecorder?.())
    if (finished) throw new Error('錄製視窗已關閉')
    return { stop: async () => {
      if (finished) return
      await page.evaluate(() => (window as unknown as { __toppathFlushRecorder?: () => void }).__toppathFlushRecorder?.()).catch(() => {})
      await page.waitForTimeout(100).catch(() => {})
      await finish()
    } }
  } catch (error) {
    await finish(error instanceof Error ? error.message : String(error))
    throw error
  }
}
