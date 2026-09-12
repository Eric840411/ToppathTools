import assert from 'node:assert/strict'
import { chromium, type Browser } from 'playwright'
import { startServerRecorder } from '../../server/uat-server-recorder.js'
import { backendRecorderScript, RECORDER_MARKER, eventsToSteps } from '../../server/uat-runner/backend-recorder.js'

let browser: Browser
const events: unknown[] = []
let done = 0
const controller = await startServerRecorder({ backendUrl: 'https://fixture.test', username: 'tester', password: 'fixture-secret',
  script: backendRecorderScript({ sessionId: 'fixture', bindings: [] }), marker: RECORDER_MARKER,
  event: payload => events.push(JSON.parse(payload)), net: () => {}, console: () => {}, ws: () => {}, done: () => { done++ },
}, async () => {
  browser = await chromium.launch({ headless: true })
  const original = browser.newContext.bind(browser)
  browser.newContext = async options => {
    const context = await original(options)
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: new URL(route.request().url()).pathname === '/login'
      ? '<form action="/dashboard"><input type="text"><input type="password"><button type="submit">Login</button></form>'
      : '<input id="value"><a href="/next">Next</a><script>setTimeout(() => { const w=document.createElement("div"); w.className="el-dialog__wrapper"; w.innerHTML="<div class=el-dialog>Warnning<button>Cancel</button></div>"; document.body.appendChild(w); }, 150)</script>' }))
    return context
  }
  return browser
})
try {
  const page = browser!.contexts()[0].pages()[0]
  assert.equal(await page.locator('.el-dialog__wrapper').isVisible(), false)
  await page.locator('#value').fill('before-navigation')
  await page.getByText('Next', { exact: true }).click()
  await page.waitForURL('**/next')
  await page.locator('#value').fill('final-unblurred-value')
  await controller.stop()
  const steps = eventsToSteps(events)
  assert.ok(steps.some(s => s.value === 'final-unblurred-value'), JSON.stringify(steps))
  assert.ok(!JSON.stringify(events).includes('fixture-secret'))
  assert.ok(!JSON.stringify(events).includes('tester'))
  assert.equal(done, 1)
  await controller.stop(); assert.equal(done, 1)
  assert.equal(browser!.isConnected(), false)
  console.log('PASS server recording: login excluded, navigation rearmed, final input flushed, browser closed, stop idempotent')
} finally { await browser!.close() }
