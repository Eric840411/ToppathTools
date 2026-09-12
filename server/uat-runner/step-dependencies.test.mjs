import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { eventsToSteps } from './backend-recorder.js';
import { runMultiTcSteps, validateMultiTcScript } from './multi-tc.js';
import { stepDependencyIssues } from './step-dependencies.js';
const bindings = [{ recordId: 'orange', tableId: 'tbl', text: 'Orange' }];
const steps = eventsToSteps([{ assertion: { kind: 'filled' }, selector: '#orange', tcId: 'orange' }]);
assert.equal(steps.length, 2);
assert.deepEqual(stepDependencyIssues(steps), []);
for (const broken of [steps.slice(1), [...steps].reverse(), [{ ...steps[0], disabled: true }, steps[1]], [{ ...steps[0], as: 'changed' }, steps[1]]]) {
  assert.ok(stepDependencyIssues(broken).length);
  assert.ok(validateMultiTcScript({ bindings, tableId: 'tbl', steps: broken }, true).length);
}
assert.ok(stepDependencyIssues([{ ...steps[0], selector: '' }, steps[1]]).length);
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent('<div id="orange">0</div>');
  let result = await runMultiTcSteps(steps, { page }, bindings);
  assert.equal(result.results[0].outcome, 'pass');
  await page.locator('#orange').evaluate(el => el.textContent = '');
  // With an explicit label an empty value must fail, not reuse a recorded value.
  result = await runMultiTcSteps([{ ...steps[0], labels: ['Players'] }, steps[1]], { page }, bindings);
  assert.equal(result.results[0].outcome, 'fail');
  console.log('PASS recorded read/assert replay, missing/deleted/disabled/reordered/renamed sources and empty selector preflight');
} finally { await browser.close(); }
