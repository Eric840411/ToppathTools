import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { backendRecorderScript, RECORDER_MARKER, eventsToSteps } from './backend-recorder.js';
import { runMultiTcSteps } from './multi-tc.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const bindings = ['blue', 'orange', 'green', 'red'].map(recordId => ({ recordId, tableId: 'tbl', number: 'T-A-002', text: `${recordId} area` }));
const html = '<html><body><input id="query"><button id="search">Search</button><input type="checkbox" id="enabled"><select id="channel"><option value="cp">CP</option><option value="bp">BP</option></select>'
  + bindings.map(b => `<div id="${b.recordId}" style="margin:20px;padding:20px;background:#ddd"><span>5</span></div>`).join('') + '</body></html>';
const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/dashboard`;
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  await context.addInitScript(backendRecorderScript({ bindings, sessionId: 'test-session' }));
  const page = await context.newPage();
  const events = [];
  page.on('console', message => { if (message.text().startsWith(RECORDER_MARKER)) events.push(JSON.parse(message.text().slice(RECORDER_MARKER.length).trim())); });
  await page.goto(url); await page.evaluate(() => window.__toppathArmRecorder());
  await page.locator('#query').pressSequentially('abc123'); await page.locator('#query').press('Enter'); await page.locator('#search').click();
  await page.locator('#enabled').check(); await page.locator('#channel').selectOption('bp');
  await page.waitForTimeout(50);
  assert.equal(events.filter(e => e.action === 'type_text' && e.selector === '#query').length, 1);
  assert.equal(events.find(e => e.action === 'type_text').value, 'abc123');
  assert.ok(!events.some(e => e.action === 'keypress' && /^[0-9]$/.test(e.key)));
  assert.ok(events.some(e => e.action === 'set_checked' && e.checked));
  assert.ok(events.some(e => e.action === 'select_option' && e.value === 'bp'));
  console.log('PASS normalized typing, Enter, checkbox and native select');
  await page.getByRole('button', { name: '暫停錄製', exact: true }).click();
  const pausedCount = events.length;
  await page.locator('#query').fill('not-recorded'); await page.locator('#search').click();
  await page.waitForTimeout(30); assert.equal(events.length, pausedCount);
  await page.getByRole('button', { name: '繼續錄製', exact: true }).click();
  console.log('PASS pause does not record incidental actions');
  // No dialog handler: browser automation dismisses native prompts by default.
  await page.getByRole('button', { name: '加入截圖指令', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '請先選擇截圖所屬 TC' }).waitFor();
  await page.getByLabel('檢查與截圖歸屬').selectOption('orange');
  const beforeShots = events.filter(e => e.action === 'screenshot').length;
  await page.getByRole('button', { name: '加入截圖指令', exact: true }).click();
  await page.getByRole('button', { name: '加入截圖指令', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '已加入截圖指令（2）' }).waitFor();
  assert.equal(events.filter(e => e.action === 'screenshot').length, beforeShots + 2);
  assert.equal(events.at(-1).tcId, 'orange');
  assert.notEqual(events.at(-1).name, events.at(-2).name);
  await page.getByRole('button', { name: '暫停錄製', exact: true }).click();
  await page.getByRole('button', { name: '加入截圖指令', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '目前暫停中' }).waitFor();
  assert.equal(events.filter(e => e.action === 'screenshot').length, beforeShots + 2);
  await page.getByRole('button', { name: '繼續錄製', exact: true }).click();
  console.log('PASS screenshot button emits without native dialogs, repeats, requires owner and reports pause');

  const badge = page.locator('[data-toppath-recorder-ui]').filter({ hasText: /^○ 標記模式/ });
  await badge.click();
  for (const binding of bindings) {
    await page.getByLabel('檢查與截圖歸屬').selectOption(binding.recordId);
    await page.locator(`#${binding.recordId} span`).click();
    await page.getByRole('button', { name: /^必須有值/ }).click();
    await page.locator(`#${binding.recordId}`).click({ position: { x: 3, y: 3 } });
    await page.getByRole('button', { name: /^截取這個區域/ }).click();
  }
  const steps = eventsToSteps(events);
  for (const binding of bindings) {
    assert.ok(steps.some(s => s.tcId === binding.recordId && s.action === 'assert_filled'));
    assert.ok(steps.some(s => s.tcId === binding.recordId && s.action === 'read_block' && s.selector === `#${binding.recordId} > span`));
    assert.ok(steps.some(s => s.tcId === binding.recordId && s.action === 'screenshot' && s.selector === `#${binding.recordId}`));
  }
  assert.ok(!events.some(e => e.selector?.includes('toppath')));
  console.log('PASS four identical display numbers retain distinct TC ownership and region selectors');
  await page.reload(); await page.evaluate(() => window.__toppathArmRecorder());
  assert.equal(await page.getByLabel('檢查與截圖歸屬').inputValue(), 'red');
  await page.locator('#query').fill('last-unblurred');
  await page.evaluate(() => window.__toppathFlushRecorder());
  await page.waitForTimeout(30);
  assert.ok(events.some(e => e.value === 'last-unblurred'));
  console.log('PASS navigation retains owner; stopping flushes the focused input');

  // Replay the recorder-produced four-TC definitions against a clean, uninstrumented page.
  const replayContext = await browser.newContext();
  const replay = await replayContext.newPage(); await replay.goto(url);
  const outputDir = await mkdtemp(path.join(tmpdir(), 'uat-multi-evidence-'));
  const ownedSteps = steps.filter(s => s.tcId);
  const result = await runMultiTcSteps(ownedSteps, {
    page: replay,
    takeScreenshot: async (name, selector) => {
      const file = path.join(outputDir, `${name}-${Date.now()}.png`);
      await (selector ? replay.locator(selector) : replay).screenshot({ path: file }); return file;
    },
  }, bindings);
  assert.ok(result.results.every(r => r.outcome === 'pass' && r.allShotPaths.length === (r.recordId === 'orange' ? 3 : 1)), JSON.stringify(result.results));
  console.log('PASS real Chromium replays recorded checks and creates four separately owned region screenshots');
  console.log(`Evidence fixture output: ${outputDir}`);
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
