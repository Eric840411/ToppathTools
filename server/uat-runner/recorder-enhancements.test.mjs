import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { compareRegionPng, pngPreview, decodePng } from './recorder-visual.js';
import { runMultiTcSteps, validateMultiTcScript } from './multi-tc.js';
import { runSteps } from './block-engine.js';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const png = (width = 10, height = 10, changed = 0) => {
  const p = new PNG({ width, height }); p.data.fill(255);
  for (let i = 0; i < changed; i++) { p.data[i * 4] = 0; p.data[i * 4 + 1] = 0; p.data[i * 4 + 2] = 0; }
  return PNG.sync.write(p);
};
test('visual comparison detects difference, dimensions and exact threshold without learning a baseline', () => {
  assert.equal(compareRegionPng(png(), png(), 0, 0).pass, true);
  const result = compareRegionPng(png(), png(10, 10, 2), 1, 0);
  assert.equal(result.pass, false); assert.equal(result.differencePct, 2); assert.ok(result.diffPng);
  assert.equal(compareRegionPng(png(), png(10, 10, 2), 2, 0).pass, true);
  assert.equal(compareRegionPng(png(), png(11, 10), 100).pass, false);
  assert.throws(() => compareRegionPng(null, png()), /基準圖/);
  assert.throws(() => compareRegionPng(png(), png(), NaN), /門檻/);
  assert.throws(() => decodePng(Buffer.from('not an image')), /PNG/);
  const forged = Buffer.from(png()); forged.writeUInt32BE(500000, 16);
  assert.throws(() => decodePng(forged), /像素/);
  const preview = decodePng(pngPreview(png(1000, 500)));
  assert.equal(preview.width, 480); assert.equal(preview.height, 240);
});
const bindings = [{ recordId: 'a', tableId: 't', text: 'A' }, { recordId: 'b', tableId: 't', text: 'B' }];
test('disabled checks neither execute nor count as verified; trace preserves original indices', async () => {
  const steps = [{ action: 'assert_equals', tcId: 'a', left: '1', right: '1', disabled: true }, { action: 'assert_equals', tcId: 'b', left: '3', right: '4', absoluteTolerance: 0, tolerancePct: 0 }];
  let calls = 0;
  const { results } = await runMultiTcSteps(steps, { checkLocator: () => { calls++; } }, bindings);
  assert.equal(calls, 1); assert.equal(results[0].outcome, 'unverified');
  assert.equal(results[0].steps[0].status, 'disabled');
  assert.equal(results[1].steps[0].index, 1); assert.equal(results[1].outcome, 'fail');
  assert.deepEqual(results[1].steps[0].diagnostics[0], { expected: '4', actual: '3' });
  assert.ok(validateMultiTcScript({ tableId: 't', bindings, steps: [steps[0]] }, true).length);
});
test('visual failure keeps actual and diff evidence with independent TC ownership', async () => {
  const { results } = await runMultiTcSteps([
    { action: 'assert_region_image', tcId: 'a', selector: '#area', baselinePng: 'fixture' },
    { action: 'assert_equals', tcId: 'b', left: '3', right: '3' },
  ], { compareRegion: async () => ({ pass: false, expected: '0%', actual: '2%', message: 'different', shots: ['actual.png', 'diff.png'] }),
    previewEvidence: async () => 'data:image/png;base64,fixture', takeScreenshot: async () => 'failure.png' }, bindings);
  assert.equal(results[0].outcome, 'fail'); assert.equal(results[1].outcome, 'pass');
  assert.deepEqual(results[0].allShotPaths, ['actual.png', 'diff.png', 'failure.png']);
  assert.equal(results[0].steps[0].evidence.length, 3); assert.equal(results[1].allShotPaths.length, 0);
  const missing = await runSteps([{ action: 'assert_region_image', selector: '#area' }], {}, { autoScreenshot: false });
  assert.equal(missing.pass, false);
});
test('large UTF-8 JSON survives stdin and split stdout framing', async () => {
  const payload = { text: '繁體中文'.repeat(100000) };
  const child = spawn(process.execPath, ['-e', "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{JSON.parse(s);process.stdout.write(s.slice(0,19001));process.stdout.write(s.slice(19001)+'\\n')})"], { windowsHide: true });
  const lines = []; createInterface({ input: child.stdout }).on('line', line => lines.push(line));
  child.stdin.end(JSON.stringify(payload));
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(String(code)))); });
  assert.equal(lines.length, 1); assert.deepEqual(JSON.parse(lines[0]), payload);
});


test('explicit TC decisions preview independently and never overwrite execution failures', async () => {
  const decision = (id, outcome) => ({ action: 'set_tc_result', tcId: id, outcome, reason: 'QA confirmed' });
  const { results } = await runMultiTcSteps([decision('a', 'PASS'), decision('b', 'FAIL')], {}, bindings);
  assert.deepEqual(results.map(r => r.outcome), ['pass', 'fail']);
  assert.equal(results[0].assertions, 0);
  assert.equal(results[0].decisionSource, '人工指定');
  const failed = await runMultiTcSteps([decision('a', 'PASS'), { action: 'assert_equals', tcId: 'a', left: '1', right: '5', absoluteTolerance: 0 }], {}, bindings);
  assert.equal(failed.results[0].outcome, 'fail');
  const blocked = await runMultiTcSteps([decision('a', 'PASS'), { action: 'click', selector: '#missing' }], { clickSelector: () => { throw new Error('missing'); } }, bindings);
  assert.equal(blocked.results[0].outcome, 'blocked');
  const invalid = await runMultiTcSteps([decision('a', '')], {}, bindings);
  assert.equal(invalid.results[0].outcome, 'fail');
  assert.ok(validateMultiTcScript({ tableId: 't', bindings, steps: [decision('a', 'PASS'), decision('a', 'FAIL')] }).length);
  assert.ok(validateMultiTcScript({ tableId: 't', bindings, steps: [{ ...decision('a', 'PASS'), tcId: null }] }, true).length);
});
