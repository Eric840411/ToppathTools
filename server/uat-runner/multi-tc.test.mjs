import assert from 'node:assert/strict';
import { runMultiTcSteps, validateMultiTcScript, publishMultiTcResults, reviewMultiTcScript } from './multi-tc.js';
import { numbersEqual } from './block-engine.js';
import { eventsToSteps } from './backend-recorder.js';

const bindings = ['blue', 'orange', 'green', 'red'].map(recordId => ({ recordId, tableId: 'tbl', number: 'T-A-002', text: recordId }));
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };
const eq = (tcId, left = '5', right = '5') => ({ action: 'assert_equals', tcId, left, right, tolerancePct: 0, absoluteTolerance: 0 });
const shot = (tcId, name) => ({ action: 'screenshot', tcId, name });
const context = () => {
  const calls = [];
  return { calls, page: { waitForTimeout: async ms => calls.push(['wait', ms]), evaluate: async () => ({ amount: '5' }) },
    openPath: async path => calls.push(['open', path]),
    takeScreenshot: async (name, selector) => { calls.push(['shot', name, selector]); return `${name}.png`; } };
};

await test('one flow / same display number / four independent outcomes and screenshot sets', async () => {
  const ctx = context();
  const steps = [{ action: 'open_page', path: '/dashboard' },
    eq('blue'), shot('blue', 'blue-1'), shot('orange', 'orange-before'),
    { action: 'read_block', tcId: 'orange', selector: '#orange', as: 'before' },
    eq('green', '1', '2'), shot('green', 'must-not-run'), eq('red'), shot('red', 'red'),
    { action: 'wait', waitMs: 1 },
    eq('orange', 'before.amount', '5'), shot('orange', 'orange-after'), shot('blue', 'blue-2')];
  const { results } = await runMultiTcSteps(steps, ctx, bindings);
  assert.deepEqual(results.map(r => r.outcome), ['pass', 'pass', 'fail', 'pass']);
  assert.deepEqual(results[0].allShotPaths, ['blue-1.png', 'blue-2.png']);
  assert.deepEqual(results[1].allShotPaths, ['orange-before.png', 'orange-after.png']);
  assert.match(results[2].allShotPaths[0], /^failure_green_/);
  assert.equal(ctx.calls.filter(c => c[0] === 'open').length, 1);
  assert.equal(ctx.calls.filter(c => c[0] === 'wait').length, 1);
  const updates = [];
  await publishMultiTcResults(results, { upload: async p => `token:${p}`, update: async (...args) => { updates.push(args); return { code: 0 }; } });
  assert.equal(updates.length, 4);
  assert.deepEqual(updates[0], ['blue', ['token:blue-1.png', 'token:blue-2.png'], 'pass']);
  assert.equal(updates[2][2], 'fail');
  assert.ok(results.every(r => r.published));
});
await test('screenshots alone never pass; clear both checkboxes with manual outcome', async () => {
  const { results } = await runMultiTcSteps([shot('blue', 'only-image')], context(), bindings);
  assert.ok(results.every(r => r.outcome === 'unverified' && r.manual && !r.pass));
  const updates = [];
  await publishMultiTcResults(results, { upload: async () => 'image', update: async (...args) => { updates.push(args); return { code: 0 }; } });
  assert.ok(updates.every(call => call[2] === 'manual'));
});
await test('shared failure blocks remaining verification instead of claiming four product failures', async () => {
  const ctx = context(); ctx.openPath = async () => { throw new Error('login failed'); };
  const { results, sharedFailure } = await runMultiTcSteps([{ action: 'open_page', path: '/' }, ...bindings.map(b => eq(b.recordId))], ctx, bindings);
  assert.match(sharedFailure, /login failed/);
  assert.ok(results.every(r => r.outcome === 'blocked' && !r.criticalFails.length));
});
await test('hard fail wins over manual, continue preserves fail and later evidence', async () => {
  const { results } = await runMultiTcSteps([{ ...eq('blue', '0', '1'), onFail: 'continue' }, { action: 'mark_manual', tcId: 'blue', reason: 'review' }], context(), bindings);
  assert.equal(results[0].outcome, 'fail'); assert.equal(results[0].manual, false);
});
await test('warning assertions remain unverified even with a passing check', async () => {
  const { results } = await runMultiTcSteps([eq('blue'), { ...eq('blue', '0', '1'), onFail: 'warn' }], context(), bindings);
  assert.equal(results[0].outcome, 'unverified');
});
await test('upload failure cannot erase existing attachments or publish a misleading pass', async () => {
  const { results } = await runMultiTcSteps([eq('blue'), shot('blue', 'first'), shot('blue', 'second')], context(), bindings.slice(0, 1));
  let updated = false;
  const failures = await publishMultiTcResults(results, { upload: async name => { if (name === 'second.png') throw new Error('offline'); return 'one'; }, update: async () => { updated = true; return { code: 0 }; } });
  assert.equal(updated, false); assert.equal(failures.length, 1); assert.equal(results[0].published, false);
});
await test('writeback failure is reported independently of assertion outcome', async () => {
  const { results } = await runMultiTcSteps([eq('blue')], context(), bindings.slice(0, 1));
  const failures = await publishMultiTcResults(results, { upload: async () => 'unused', update: async () => ({ code: 123, msg: 'permission' }) });
  assert.equal(results[0].outcome, 'pass'); assert.equal(results[0].published, false); assert.match(failures[0], /permission/);
});
await test('strict locator ambiguity fails the owner while other TC continues', async () => {
  const ctx = context(); ctx.checkLocator = async s => { if (s.selector === '.ambiguous') throw new Error('命中 2 個'); };
  const { results } = await runMultiTcSteps([{ action: 'assert_text', tcId: 'blue', selector: '.ambiguous', expect: 'ok' }, eq('red')], ctx, bindings);
  assert.equal(results[0].outcome, 'fail'); assert.equal(results[3].outcome, 'pass');
});
await test('ownership, table consistency, no unknown blocks, editable incomplete drafts', async () => {
  const script = { tableId: 'tbl', bindings, steps: [eq('blue'), { action: 'screenshot' }] };
  assert.equal(validateMultiTcScript(script).length, 0);
  assert.ok(validateMultiTcScript(script, true).some(e => e.includes('所屬')));
  assert.ok(validateMultiTcScript({ ...script, tableId: 'other' }).length);
  assert.ok(validateMultiTcScript({ ...script, steps: [eq('missing')] }).length);
  assert.ok(validateMultiTcScript({ ...script, bindings: [...bindings, bindings[0]] }).length);
  assert.ok(validateMultiTcScript({ ...script, steps: [{ action: 'builtin_verifier' }] }).length);
  assert.equal(reviewMultiTcScript(script)[0].checks, 1);
});
await test('recorder conversion preserves TC ownership across read + assertion and exact amounts', async () => {
  const steps = eventsToSteps([{ tcId: 'blue', assertion: { kind: 'equals', expect: '6' }, selector: '#amount', label: 'amount' }, { tcId: 'red', assertion: { kind: 'screenshot' }, selector: '#red' }, { tcId: 'orange', assertion: { kind: 'text', expect: 'active' }, selector: '#state' }]);
  assert.deepEqual(steps.map(s => s.tcId), ['blue', 'blue', 'red', 'orange']);
  assert.equal(steps[1].absoluteTolerance, 0); assert.equal(steps[1].tolerancePct, 0);
  assert.equal(steps[2].selector, '#red'); assert.equal(steps[3].action, 'assert_text');
  assert.equal(numbersEqual(100, 101, 0, 0), false);
  assert.equal(numbersEqual(100, 101, 0), true); // older scripts keep their explicit legacy default
});
console.log(`${passed} multi-TC scenarios passed`);
