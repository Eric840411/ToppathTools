import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { BLOCK_DEFS } from '../../server/uat-runner/block-engine.js';
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  let status = 'error';
  const script = { id: 's', title: 'Retry fixture', tableId: 't', larkUrl: 'https://fixture.test/base/app?table=t', bindings: [{ recordId: 'r', tableId: 't', number: 'TC', text: 'Fixture', sub: '' }], steps: [{ action: 'assert_equals', tcId: 'r', left: '1', right: '1' }] };
  await page.addInitScript(() => {
    window.streams = [];
    window.EventSource = class extends EventTarget {
      constructor() { super(); window.streams.push(this); queueMicrotask(() => this.dispatchEvent(new MessageEvent('status', { data: JSON.stringify({ status: window.streams.length === 1 ? 'error' : 'running' }) }))); }
      close() { this.closed = true; }
    };
  });
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url()); let data = { ok: true };
    if (url.pathname.endsWith('/recorded-scripts')) data = route.request().method() === 'PUT' ? { ok: true, script } : { ok: true, scripts: [script] };
    else if (url.pathname.endsWith('/results')) data.runs = [];
    else if (url.pathname.endsWith('/blocks')) data.blockDefs = BLOCK_DEFS;
    else if (url.pathname.endsWith('/run')) { status = 'running'; data.sessionId = 'run'; }
    else if (url.pathname.endsWith('/status')) data = { status };
    else if (url.pathname.endsWith('/agents')) data = { ok: true, agents: [], outdated: 0 };
    else if (url.pathname.endsWith('/backend-credentials')) data.credentials = [];
    else if (url.pathname.endsWith('/tc-list')) data.tcs = [];
    else if (url.pathname.endsWith('/custom-tcs')) data.tcs = [];
    return route.fulfill({ json: data });
  });
  await page.goto('http://127.0.0.1:5199/scripts/ui-checks/uat-status-fixture.html');
  await page.getByRole('button', { name: /Retry fixture/ }).click();
  const run = page.getByRole('button', { name: '儲存並試跑', exact: true });
  await run.click();
  await page.waitForFunction(() => window.streams.length >= 2);
  assert.equal(await run.isDisabled(), true);
  status = 'error'; // Deliberately drop the SSE completion: the reconciliation poll must recover.
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === '儲存並試跑' && !b.disabled));
  await run.click();
  await page.waitForFunction(() => window.streams.length >= 3);
  await page.evaluate(() => window.streams.at(-1).dispatchEvent(new MessageEvent('status', { data: JSON.stringify({ status: 'done' }) })));
  assert.equal(await run.isEnabled(), true);
  console.log('PASS closed stream reconnects on each multi-TC run; missed completion polling restores retry; SSE completion unlocks button');
} finally { await browser.close(); }
