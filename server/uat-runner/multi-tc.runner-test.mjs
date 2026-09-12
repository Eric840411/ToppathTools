/** Execute the actual runner entry/Playwright adapter with intercepted HTTP; never contact Lark/UAT. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright';
import { pngPreview, compareRegionPng } from './recorder-visual.js';
import { runSteps as runBlockSteps } from './block-engine.js';
import { runMultiTcSteps, validateMultiTcScript, publishMultiTcResults } from './multi-tc.js';
import { attachNetworkCapture, DEFAULT_THRESHOLDS, formatStatsLine } from './net-capture.js';
import { resolveVerifierParams, verifierRanAssertion } from './verifier-params.js';
import { detectManual } from './detect-manual.js';
const output = fs.mkdtempSync(path.join(tmpdir(), 'uat-runner-integration-'));
const bindings = [0, 1, 2, 3].map(i => ({ recordId: `rec${i}`, tableId: 'tblFixture', number: 'T-A-002', text: `Area ${i}` }));
const script = { id: 'fixture', title: 'Four TC', tableId: 'tblFixture', bindings, steps: [
  { action: 'open_page', path: '/dashboard', waitMs: 1 },
  ...bindings.flatMap((b, i) => [{ action: 'assert_text', tcId: b.recordId, selector: `#area${i}`, expect: i === 2 ? 'wrong' : '5' }, { action: 'screenshot', tcId: b.recordId, selector: `#area${i}`, name: b.recordId }]),
] };
const source = fs.readFileSync(new URL('./run-lark-tc-backend.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?$/gm, '')
  .replace("const SCREENSHOT_DIR = './data/raw/screenshots/lark_tc';", `const SCREENSHOT_DIR = ${JSON.stringify(path.join(output, 'shots'))};`)
  .replace(/main\(\)\.catch\(error => \{ console\.error\(error\); process\.exitCode = 1; \}\);\s*$/, 'return main();');
assert.ok(source.includes('return main();'), 'runner entry must remain exercised');
const mapped = p => path.isAbsolute(p) ? p : path.join(output, p);
const fixtureFs = { ...fs, existsSync: p => fs.existsSync(mapped(p)), mkdirSync: (p, o) => fs.mkdirSync(mapped(p), o),
  readFileSync: (p, o) => fs.readFileSync(mapped(p), o), writeFileSync: (p, data, o) => fs.writeFileSync(mapped(p), data, o) };
const launch = async () => {
  const browser = await chromium.launch({ headless: true });
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async options => {
    const context = await newContext(options);
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      const body = url.pathname === '/login'
        ? '<input type="text"><input type="password"><button type="submit" onclick="location.href=\'/dashboard\'">Login</button>'
        : bindings.map((b, i) => `<div id="area${i}" style="padding:30px;background:#ddd;margin:10px">5</div>`).join('');
      return route.fulfill({ contentType: 'text/html', body });
    });
    return context;
  };
  return browser;
};
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const baselineBrowser = await launch();
let baseline;
try {
  const context = await baselineBrowser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage(); await page.goto('https://fixture.local/dashboard');
  baseline = 'data:image/png;base64,' + (await page.locator('#area0').screenshot()).toString('base64');
} finally { await baselineBrowser.close(); }
for (const mode of ['trial', 'formal', 'visual', 'partial']) {
  const dryRun = mode !== 'formal';
  const currentScript = structuredClone(script);
  if (mode === 'visual') currentScript.steps.splice(2, 0, { action: 'assert_region_image', tcId: 'rec0', selector: '#area0', baselinePng: baseline, thresholdPct: 0, pixelTolerance: 0 });
  const proc = new EventEmitter();
  proc.argv = ['node', 'runner']; proc.exitCode = 0;
  proc.env = { UAT_MULTI_SCRIPT: JSON.stringify(currentScript), ...(mode === 'partial' ? { UAT_MULTI_STOP_AFTER: '2' } : {}), LARK_APP_TOKEN: 'appFixture', LARK_TABLE_ID: script.tableId,
    UAT_CP_USERNAME: 'fixture', UAT_CP_PASSWORD: 'fixture', ...(dryRun ? { UAT_DRY_RUN: '1' } : {}) };
  const logs = [], updates = []; let uploads = 0;
  const fetch = async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    let data;
    if (pathname.includes('/auth/')) data = { tenant_access_token: 'fixture-token' };
    else if (pathname.endsWith('/upload_all')) data = { code: 0, data: { file_token: `shot-${++uploads}` } };
    else if (init.method === 'PUT') { const fields = JSON.parse(init.body).fields; updates.push({ id: pathname.split('/').at(-1), fields }); data = Object.keys(fields).some(key => !['PASS', 'FAIL', '附圖'].includes(key)) ? { code: 1254045, msg: 'FieldNameNotFound' } : { code: 0 }; }
    else data = { code: 0, data: { items: bindings.map(b => ({ record_id: b.recordId, fields: {} })), has_more: false } };
    return { json: async () => data };
  };
  const dependencies = { chromium: { launch }, fs: fixtureFs, path, XLSX: {}, attachNetworkCapture, DEFAULT_THRESHOLDS,
    pngPreview, compareRegionPng, formatStatsLine, runBlockSteps, runMultiTcSteps, validateMultiTcScript, publishMultiTcResults,
    resolveVerifierParams, verifierRanAssertion, detectManual, process: proc,
    console: { log: (...args) => logs.push(args.join(' ')), warn: () => {}, error: (...args) => logs.push(args.join(' ')) }, fetch };
  await new AsyncFunction(...Object.keys(dependencies), source)(...Object.values(dependencies));
  const payload = JSON.parse(logs.find(line => line.startsWith('@@UAT_MULTI_RESULTS@@')).slice('@@UAT_MULTI_RESULTS@@'.length));
  assert.deepEqual(payload.results.map(r => r.outcome), mode === 'partial' ? ['unverified', 'unverified', 'unverified', 'unverified'] : ['pass', 'pass', 'fail', 'pass'], logs.filter(l => !l.startsWith('@@')).join('\n'));
  assert.equal(proc.exitCode, 1);
  assert.equal(payload.results[0].steps[0].locator.count, 1);
  assert.ok(payload.results[0].steps[0].locator.preview.startsWith('data:image/png;base64,'));
  if (mode === 'visual') {
    assert.equal(payload.results[0].assertions, 2);
    assert.equal(payload.results[0].allShotPaths.length, 3);
    assert.equal(payload.results[0].steps[1].diagnostics[0].actual, '0.000%');
  }
  if (mode === 'partial') assert.equal(payload.results[1].steps.length, 0);
  if (dryRun) { assert.equal(updates.length, 0); assert.equal(uploads, 0); }
  else {
    assert.equal(updates.length, 4, 'one atomic write per TC, never a preliminary clear');
    assert.equal(uploads, 4);
    assert.ok(payload.results.every(r => r.published === true), 'minimal Lark schema must accept every result');
    assert.ok(updates.every(u => !('UAT測試通過時間' in u.fields))); 
    assert.deepEqual(updates.map(u => [u.id, u.fields.PASS, u.fields.FAIL]), [['rec0', true, false], ['rec1', true, false], ['rec2', false, true], ['rec3', true, false]]);
    assert.ok(updates.every(u => u.fields['附圖'].length === 1));
    assert.equal(new Set(updates.map(u => u.fields['附圖'][0].file_token)).size, 4);
  }
  console.log(`PASS actual runner ${mode}: four owned results/evidence, exact Lark fields, nonzero failure exit`);
}
