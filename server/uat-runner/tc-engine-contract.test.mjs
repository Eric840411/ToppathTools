/**
 * server/uat-runner/tc-engine-contract.test.mjs
 *
 * **同一組情境、兩套積木引擎，判定結果必須一模一樣。**
 *
 * ## 為什麼是「契約測試」而不是各驗各的
 * Backend 與 H5／PC 是兩套積木（`block-engine` vs `frontend-engine`），但
 * 「什麼算通過」只能有一份。各自寫一支測試的話，兩邊都會綠——
 * **而規則已經漂了也照樣綠**，因為沒有任何一條斷言在比較兩邊。
 *
 * 所以這支把同一個情境餵給兩個引擎，斷言**聚合結果相等**：
 *
 *   ① 失敗隔離：一筆 TC 失敗，其他筆照跑照過
 *   ② 零斷言＝待確認（不是通過）——只截圖不檢查的 TC 不能算驗過
 *   ③ 共用步驟失敗 → 全部 blocked
 *   ④ 未知動作 → 明確失敗，不是跳過
 *   ⑤ 硬失敗優先於共用失敗（CodeX 指出的既有行為，釘住它）
 *   ⑥ 截圖只進所屬 TC；上傳失敗那一筆不回寫、其他筆照回
 *
 * ⚠️ 兩邊的動作名稱不同是**刻意的**——測的是「規則」不是「動作名」。
 *    用同一組動作名反而驗不到東西（那只是在測同一支程式跑兩次）。
 *
 * 跑法：node server/uat-runner/tc-engine-contract.test.mjs
 */
import assert from 'node:assert/strict';
import { runMultiTcSteps, publishMultiTcResults, validateMultiTcScript, BACKEND_TC_ENGINE } from './multi-tc.js';
import { createFrontendTcEngine, toMultiTcSteps, FRONTEND_BLOCK_DEFS } from './frontend-tc-engine.js';

let passed = 0;
const failures = [];
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`PASS  ${name}`) }
  catch (error) { failures.push(name); console.log(`FAIL  ${name}\n        ${error.message}`) }
};

const bindings = ['blue', 'orange', 'green'].map(recordId => ({ recordId, tableId: 'tbl', number: 'T-A-002', text: recordId }));

// ── 兩套「同義積木」。同一個情境各用自己那一套寫一次 ──────────────────────
const stubLocator = (visible = true) => {
  const self = {
    async count() { return 1 }, first() { return self }, nth() { return self },
    async isVisible() { return visible },
    async waitFor() { if (!visible) throw new Error('元素沒有出現') },
    async innerText() { return '' }, async focus() {}, async click() {},
    async fill() {}, async setChecked() {}, async selectOption() {},
    async boundingBox() { return null }, async elementHandle() { return {} },
    async evaluate() { return { amount: '5' } },
  };
  return self;
};

/** Backend：假 page ＋ block-engine 自己的動作名 */
const backendWorld = () => {
  const shots = [];
  const ctx = {
    page: {
      url: () => 'https://stub.test/', async waitForTimeout() {}, async evaluate() { return { amount: '5' } },
      locator: () => stubLocator(), getByText: () => stubLocator(), getByLabel: () => stubLocator(),
    },
    async openPath() {},
    takeScreenshot: async name => { shots.push(name); return `${name}.png` },
  };
  return {
    name: 'Backend', ctx, shots, engine: BACKEND_TC_ENGINE,
    nav: () => ({ action: 'open_page', path: '/dashboard' }),
    okCheck: tcId => ({ action: 'assert_equals', tcId, left: '5', right: '5', tolerancePct: 0, absoluteTolerance: 0 }),
    badCheck: tcId => ({ action: 'assert_equals', tcId, left: '1', right: '9', tolerancePct: 0, absoluteTolerance: 0 }),
    badNav: () => ({ action: 'assert_equals', left: '1', right: '9', tolerancePct: 0, absoluteTolerance: 0, tcId: undefined }),
    shot: (tcId, name) => ({ action: 'screenshot', tcId, name }),
    prepare: steps => steps,
  };
};

/**
 * H5／PC：假 page ＋ frontend-engine 的動作名。
 *
 * ⚠️ **檢查類用 `assert_api_called`，不用 `assert_visible`。**
 *    `assert_visible` 現在直接對 `ctx.page` 呼叫 `countRecorded()`／`locateRecorded()`
 *    （2026-09-19 為了處理「命中多個」改的），假 page 餵不動它——結果是
 *    **每一條檢查都會通過**，這支測試整個變成空的（實測：該紅的 7 條全變綠）。
 *    DOM 那一層由真瀏覽器那支 E2E 負責；這裡要驗的是**聚合規則**，
 *    所以改用一個不碰 DOM、但真的會判成功／失敗的檢查動作。
 */
const frontendWorld = () => {
  const shots = [];
  const host = {
    idx: '[1/1]', label: 'step', log: async () => {},
    page: {
      async goto() {}, async waitForTimeout() {}, async screenshot() { return Buffer.alloc(0) },
      async evaluate() { return 0 }, mouse: { async click() {}, async wheel() {} },
      locator: () => stubLocator(true),
    },
    browser: null,
    recordedLocator: async () => stubLocator(true),
    // 這一輪「打到過」的 API：okCheck 配得上、badCheck 配不上
    netCapture: { records: () => [{ url: 'https://stub.test/api/ok', status: 200, ts: Date.now() + 1000 }] },
    startUrl: 'https://stub.test/', viewportHeight: 844, backend: null,
    takeScreenshot: async name => { shots.push(name); return `${name}.png` },
  };
  const ctx = { ...host, engine: createFrontendTcEngine(host) };
  return {
    name: 'H5／PC', ctx, shots, engine: ctx.engine,
    nav: () => ({ action: 'goto', value: 'https://stub.test/' }),
    okCheck: tcId => ({ action: 'assert_api_called', tcId, urlPattern: '*/api/ok', expectStatus: '2xx' }),
    badCheck: tcId => ({ action: 'assert_api_called', tcId, urlPattern: '*/api/never-called', expectStatus: '2xx' }),
    badNav: () => ({ action: 'assert_api_called', urlPattern: '*/api/never-called', expectStatus: '2xx', tcId: undefined }),
    shot: (tcId, name) => ({ action: 'screenshot', tcId, name }),
    prepare: steps => toMultiTcSteps(steps),
  };
};

const worlds = [backendWorld, frontendWorld];

/** 同一個情境跑兩個引擎，回傳兩份結果供比對 */
const both = async (build) => {
  const out = [];
  for (const make of worlds) {
    const w = make();
    const steps = w.prepare(build(w));
    out.push({ world: w, ...(await runMultiTcSteps(steps, w.ctx, bindings)) });
  }
  return out;
};

const sameOutcomes = (runs, expected, what) => {
  for (const run of runs) {
    assert.deepEqual(run.results.map(r => r.outcome), expected,
      `${run.world.name}：${what}\n        實際 ${JSON.stringify(run.results.map(r => ({ id: r.recordId, outcome: r.outcome, err: r.error })))}`);
  }
};

// ── ① 失敗隔離 ────────────────────────────────────────────────────────────
await test('① 一筆 TC 失敗，其他筆照跑照過（兩個引擎一致）', async () => {
  const runs = await both(w => [w.nav(), w.okCheck('blue'), w.badCheck('orange'), w.okCheck('green')]);
  sameOutcomes(runs, ['pass', 'fail', 'pass'], '失敗隔離');
});

await test('① 失敗的那一筆說得出原因（不是空的 error）', async () => {
  const runs = await both(w => [w.nav(), w.badCheck('blue'), w.okCheck('orange'), w.okCheck('green')]);
  for (const run of runs) {
    const row = run.results[0];
    assert.equal(row.outcome, 'fail', run.world.name);
    assert.ok(row.error && row.error.length > 3, `${run.world.name}：error 是空的（${JSON.stringify(row.error)}）`);
    assert.ok(row.criticalFails.length, `${run.world.name}：🚨 pass=false 但沒記硬失敗——會被降級成待確認`);
  }
});

// ── ② 零斷言 ≠ 通過 ───────────────────────────────────────────────────────
await test('② 🚨 只截圖沒檢查的 TC 是「待確認」，不是通過', async () => {
  const runs = await both(w => [w.nav(), w.shot('blue', 'b'), w.okCheck('orange'), w.okCheck('green')]);
  sameOutcomes(runs, ['unverified', 'pass', 'pass'], '零斷言必須是待確認');
});

// ── ③ 共用步驟失敗 → 全部 blocked ─────────────────────────────────────────
await test('③ 共用步驟失敗 → 每一筆都 blocked（不是各自 pass）', async () => {
  const runs = await both(w => [w.nav(), w.badNav(), w.okCheck('blue'), w.okCheck('orange'), w.okCheck('green')]);
  sameOutcomes(runs, ['blocked', 'blocked', 'blocked'], '共用步驟失敗');
});

await test('⑤ 硬失敗優先於共用失敗（已經 FAIL 的不會被改成 blocked）', async () => {
  // CodeX 指出的既有行為。釘住它：否則「這一筆到底是自己錯還是被擋住」會變成看運氣。
  const runs = await both(w => [w.nav(), w.badCheck('blue'), w.badNav(), w.okCheck('orange')]);
  for (const run of runs) {
    assert.equal(run.results[0].outcome, 'fail', `${run.world.name}：blue 應該保持 fail`);
    assert.equal(run.results[1].outcome, 'blocked', `${run.world.name}：orange 應該 blocked`);
  }
});

// ── ④ 未知動作 ────────────────────────────────────────────────────────────
await test('④ 🚨 不認得的動作要失敗，不是跳過（兩個引擎一致）', async () => {
  const runs = await both(w => [w.nav(), { action: 'this_block_does_not_exist', tcId: 'blue' }, w.okCheck('orange'), w.okCheck('green')]);
  sameOutcomes(runs, ['fail', 'pass', 'pass'], '不認得的動作');
});

await test('④ 存檔驗證也擋得住不認得的動作（不只執行時才發現）', async () => {
  const H5_ENGINE = { defs: FRONTEND_BLOCK_DEFS, runSteps: async () => ({}) };
  for (const [label, engine] of [['Backend', BACKEND_TC_ENGINE], ['H5／PC', H5_ENGINE]]) {
    const errors = validateMultiTcScript(
      { tableId: 'tbl', bindings, steps: [{ action: 'this_block_does_not_exist', tcId: 'blue' }] },
      false, engine);
    assert.ok(errors.some(e => e.includes('不支援')), `${label}：存檔時沒擋下來 → ${JSON.stringify(errors)}`);
  }
});

await test('④ 🚨 檢查／截圖積木沒指定 TC → 存檔驗證要擋（分類表要用對那一張）', async () => {
  // ⚠️ 這一條是端到端測試抓到的：`validateMultiTcScript` 裡的歸戶檢查原本
  //    **沒有把 engine 傳下去**，於是它拿 Backend 的分類表去看 H5 積木，
  //    結果每一顆 H5 檢查都被當成「不是檢查」——沒指定 TC 照樣放行，
  //    跑完才發現那些結果不知道要回寫到哪。
  const H5_ENGINE = { defs: FRONTEND_BLOCK_DEFS, runSteps: async () => ({}) };
  for (const [label, engine, check, shot] of [
    ['Backend', BACKEND_TC_ENGINE, { action: 'assert_equals', left: '1', right: '1' }, { action: 'screenshot', name: 's' }],
    ['H5／PC', H5_ENGINE, { action: 'assert_visible', selector: '#a' }, { action: 'screenshot', name: 's' }],
  ]) {
    for (const [what, step] of [['檢查', check], ['截圖', shot]]) {
      const errors = validateMultiTcScript({ tableId: 'tbl', bindings, steps: [step] }, true, engine);
      assert.ok(errors.some(e => e.includes('所屬')), `${label} 的${what}積木沒指定 TC 卻放行了 → ${JSON.stringify(errors)}`);
    }
  }
});

await test('④ H5 的積木在 Backend 引擎下會被擋（分類表真的有換到）', async () => {
  const errors = validateMultiTcScript(
    { tableId: 'tbl', bindings, steps: [{ action: 'assert_visible', tcId: 'blue' }] }, false, BACKEND_TC_ENGINE);
  assert.ok(errors.length, 'Backend 不該認得 assert_visible');
  const ok = validateMultiTcScript(
    { tableId: 'tbl', bindings, steps: [{ action: 'assert_visible', tcId: 'blue' }] },
    false, { defs: FRONTEND_BLOCK_DEFS, runSteps: async () => ({}) });
  assert.equal(ok.length, 0, `H5 引擎下應該通過，實際 ${JSON.stringify(ok)}`);
});

// ── ⑥ 截圖歸屬與上傳失敗 ──────────────────────────────────────────────────
await test('⑥ 截圖只進所屬 TC（不會灑給每一筆）', async () => {
  const runs = await both(w => [w.nav(), w.okCheck('blue'), w.shot('blue', 'blue-1'), w.okCheck('orange'), w.shot('orange', 'orange-1'), w.okCheck('green')]);
  for (const run of runs) {
    assert.deepEqual(run.results[0].allShotPaths, ['blue-1.png'], `${run.world.name}：blue 的截圖`);
    assert.deepEqual(run.results[1].allShotPaths, ['orange-1.png'], `${run.world.name}：orange 的截圖`);
    assert.deepEqual(run.results[2].allShotPaths, [], `${run.world.name}：green 不該有截圖`);
  }
});

await test('⑥ 某一筆截圖上傳失敗 → 只有那一筆不回寫，其他照回', async () => {
  const runs = await both(w => [w.nav(), w.okCheck('blue'), w.shot('blue', 'bad'), w.okCheck('orange'), w.shot('orange', 'fine'), w.okCheck('green')]);
  for (const run of runs) {
    const updated = [];
    const fails = await publishMultiTcResults(run.results, {
      upload: async path => { if (path.startsWith('bad')) throw new Error('offline'); return `token:${path}` },
      update: async (recordId, tokens, outcome) => { updated.push([recordId, outcome]); return { code: 0 } },
    });
    assert.equal(fails.length, 1, `${run.world.name}：應該只有一筆失敗，實際 ${JSON.stringify(fails)}`);
    assert.deepEqual(updated.map(u => u[0]), ['orange', 'green'], `${run.world.name}：回寫名單`);
    assert.equal(run.results[0].published, false, `${run.world.name}：blue 不該標成已回寫`);
  }
});

await test('⑥ 待確認／blocked 回寫的是 manual，不是 pass 也不是 fail', async () => {
  const runs = await both(w => [w.nav(), w.shot('blue', 'only'), w.okCheck('orange'), w.badCheck('green')]);
  for (const run of runs) {
    const updated = [];
    await publishMultiTcResults(run.results, {
      upload: async p => `token:${p}`,
      update: async (recordId, tokens, outcome) => { updated.push([recordId, outcome]); return { code: 0 } },
    });
    assert.deepEqual(updated, [['blue', 'manual'], ['orange', 'pass'], ['green', 'fail']], run.world.name);
  }
});

// ── H5 專屬：失敗處置的欄位名翻譯 ─────────────────────────────────────────
await test('⚠️ H5 的 failureMode 要翻成 onFail，否則 continue 會安靜失效', async () => {
  const w = frontendWorld();
  const steps = toMultiTcSteps([
    w.nav(),
    { ...w.badCheck('blue'), failureMode: 'continue' },
    w.okCheck('blue'),
  ]);
  const { results } = await runMultiTcSteps(steps, w.ctx, bindings);
  // continue：那一筆仍然是 FAIL（失敗就是失敗），但後面的步驟有跑到
  assert.equal(results[0].outcome, 'fail');
  assert.equal(results[0].steps.filter(s => s.status === 'blocked').length, 0,
    `後面的步驟被擋掉了＝continue 沒生效：${JSON.stringify(results[0].steps.map(s => s.status))}`);
});

await test('⚠️ H5 的 retry 由 adapter 處理，而且真的重試到成功', async () => {
  const w = frontendWorld();
  let tries = 0;
  // ⚠️ 用 `click`——它仍然走 `ctx.recordedLocator`，所以假的定位器餵得動。
  //    （`assert_visible` 已改成直接查 page，那條路徑歸真瀏覽器那支測。）
  w.ctx.recordedLocator = async () => { tries++; if (tries < 3) throw new Error('還沒出現'); return stubLocator(true) };
  w.ctx.engine = createFrontendTcEngine(w.ctx);
  // ⚠️ 後面要接一顆**檢查**：`click` 是操作不是檢查，只有它的話這筆 TC 是
  //    「零斷言 → 待確認」（那是對的聚合行為，不是 retry 失敗）。
  const steps = toMultiTcSteps([
    { action: 'click', tcId: 'blue', selector: '#slow', failureMode: 'retry', retryCount: 5 },
    w.okCheck('blue'),
  ]);
  const { results } = await runMultiTcSteps(steps, w.ctx, bindings);
  assert.equal(tries, 3, `應該試三次，實際 ${tries}`);
  assert.equal(results[0].outcome, 'pass', '重試成功之後後面的步驟要照跑')
});

await test('⚠️ 瀏覽器關掉不重試（重試只會拿到同一個錯誤，還把中止拖慢）', async () => {
  const w = frontendWorld();
  let tries = 0;
  w.ctx.recordedLocator = async () => { tries++; throw new Error('Target page, context or browser has been closed') };
  w.ctx.engine = createFrontendTcEngine(w.ctx);
  const steps = toMultiTcSteps([{ action: 'click', tcId: 'blue', selector: '#x', failureMode: 'retry', retryCount: 5 }]);
  await runMultiTcSteps(steps, w.ctx, bindings);
  assert.equal(tries, 1, `不該重試，實際試了 ${tries} 次`);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
