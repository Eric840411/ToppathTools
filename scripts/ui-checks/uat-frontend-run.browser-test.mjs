/**
 * scripts/ui-checks/uat-frontend-run.browser-test.mjs
 *
 * **H5／PC 腳本的端到端執行測試**——真的開瀏覽器、真的跑一份含各種積木的腳本。
 *
 * ## 為什麼需要這支
 * 在這之前，H5/PC 的執行迴圈**沒有任何一支測試真的把腳本從頭跑到尾**。
 * 代價已經發生過：`find_baseline_scroll`（尋找基準圖）**只有伺服器端實作**，
 * 派工給 agent 時掉進「不認得的動作 → 跳過」——**腳本照樣 PASS，而視覺比對根本沒跑**。
 * 有這支的話，那個 bug 當初就會被抓到。
 *
 * ## 它有兩個職責
 *   ① **釘住每一顆積木實際會做什麼**（真瀏覽器、真點擊、真斷言）。
 *      這是接下來「把兩份引擎合併成一份」的**安全網**——合併前後跑同一支，結果要一樣。
 *   ② **擋住兩份引擎再次漂掉**：兩邊實作的動作集合必須一致。
 *      ⚠️ 這一項是原始碼比對（agent 端的 runner 在 import 當下就會去連線，沒辦法直接跑），
 *      但它正對著已經發生過的那個失效方式。合併之後這一項會自然成立。
 *
 * 跑法：node scripts/ui-checks/uat-frontend-run.browser-test.mjs
 * ⚠️ 需要先 `npm run build`。
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { stripComments } from './lib/strip-comments.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};

// ── 假的受測頁面 ──────────────────────────────────────────────────────────
// 刻意做得像 H5：一顆 canvas、一個會打 API 的按鈕、一個輸入框。
const PAGE = `<!doctype html><meta charset="utf-8"><title>h5 run fixture</title>
<style>body{margin:0;font:14px system-ui}#game{display:block;background:#123}</style>
<button id="play" aria-label="開始">開始遊戲</button>
<input id="nick" name="nickname">
<div id="later" style="display:none">出現了</div>
<canvas id="game" width="240" height="160"></canvas>
<script>
  document.getElementById('play').addEventListener('click', () => {
    fetch('/api/spin').then(() => { document.getElementById('later').style.display = 'block' });
  });
</script>`;

const site = http.createServer((req, res) => {
  if (req.url === '/api/spin') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}') }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
await new Promise(r => site.listen(0, '127.0.0.1', r));
const siteUrl = `http://127.0.0.1:${site.address().port}/`;

const express = (await import('express')).default;
const fa = await load('dist-server/server/routes/frontend-auto.js');
const hub = await load('dist-server/server/agent-hub.js');
const { runWithRequestContext } = await load('dist-server/server/request-context.js');
const { signInternalIdentity, db } = await load('dist-server/server/shared.js');

const ME = 'frontend-run@toppath.invalid';
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const signed = signInternalIdentity(ME);
  runWithRequestContext(
    { ip: '127.0.0.1', user: ME, userDisplay: ME, authEmail: signed.email, path: req.path, method: req.method, operation: 'test' },
    () => next(),
  );
});
app.use(fa.router);
const server = app.listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

/** 等這一輪跑完（日誌出現「─── 完成 ───」或逾時） */
const waitForRun = async (runId, timeoutMs = 120_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const lines = fa.logBuffers.get(runId) ?? [];
    if (lines.some(l => l.includes('─── 完成 ───'))) return lines;
    await new Promise(r => setTimeout(r, 250));
  }
  return fa.logBuffers.get(runId) ?? [];
};

const runId = `e2e-${Date.now()}`;
try {
  // ⚠️ 刻意讓它跑在**伺服器端**：沒有可用的 agent 時就是這條路。
  //    （agent 端的 runner 在 import 當下就會去連線，沒辦法在測試裡直接跑——
  //    合併成一份引擎之後這條路會同時涵蓋兩邊。）
  hub.agentConnections.clear();

  const steps = [
    { action: 'goto', name: '前往頁面', value: siteUrl },
    { action: 'assert_visible', name: '驗證按鈕在', selector: '#play' },
    { action: 'type', name: '輸入暱稱', selector: '#nick', value: 'osmel002' },
    { action: 'click', name: '點開始', selector: '#play' },
    { action: 'wait', name: '等一下', value: '500' },
    { action: 'assert_visible', name: '驗證後來才出現的', selector: '#later' },
    { action: 'assert_api_called', name: 'API 要被打到', urlPattern: '*/api/spin', expectStatus: '2xx' },
    { action: 'click_viewport', name: '點畫面', x: 10, y: 10 },
    { action: 'screenshot', name: '留證據' },
    // 🚨 這一顆是重點：一個沒有人實作的動作**必須失敗**，不能跳過。
    { action: '__not_implemented__', name: '沒人實作的動作' },
  ];

  const response = await fetch(`${base}/api/frontend-auto/runs/${runId}/execute`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      steps: JSON.stringify(steps), url: siteUrl, platform: 'h5',
      resolution: '500x877', failureMode: 'continue', headed: false,
    }),
  });
  const started = await response.json().catch(() => ({}));
  check('① 執行啟動了，而且回得出跑在哪', response.ok && started.via === 'server',
    `HTTP ${response.status} ${JSON.stringify(started)}`);

  const lines = await waitForRun(runId);
  const log = lines.join('\n');
  check('① 真的跑完了（不是逾時）', log.includes('─── 完成 ───'), lines.slice(-6).join(' | '));

  // ── 每一顆積木各自的結果 ────────────────────────────────────────────────
  const passed = (name) => new RegExp(`✅ [^\\n]*${name}`).test(log);
  const failedStep = (name) => new RegExp(`❌ [^\\n]*${name}`).test(log);

  check('② 前往頁面', passed('前往頁面'), lines.find(l => l.includes('前往頁面')));
  check('② 驗證可見', passed('驗證按鈕在'), lines.find(l => l.includes('驗證按鈕在')));
  check('② 輸入文字', passed('輸入暱稱'), lines.find(l => l.includes('輸入暱稱')));
  check('② 點擊元素', passed('點開始'), lines.find(l => l.includes('點開始')));
  check('② 等待', passed('等一下'), lines.find(l => l.includes('等一下')));
  check('② ⚠️ 點擊真的有作用（非同步出現的元素之後才看得到）',
    passed('驗證後來才出現的'),
    '這條同時證明前一步的點擊不是「看起來有點」——沒真的點到的話這裡會紅');
  check('② API 斷言', passed('API 要被打到'), lines.find(l => l.includes('API 要被打到')));
  check('② 點畫面座標', passed('點畫面'), lines.find(l => l.includes('點畫面')));
  check('② 截圖', passed('留證據'), lines.find(l => l.includes('留證據')));

  // ── 🚨 沒人實作的動作 ───────────────────────────────────────────────────
  check('③ 🚨 沒有實作的動作要**失敗**，不能跳過',
    failedStep('沒人實作的動作'),
    '跳過的話會拿到「綠燈但那一步沒跑」——`find_baseline_scroll` 在 agent 上就是這樣被跳過的');
  check('③ 而且訊息要說得出是哪個動作',
    /不支援「__not_implemented__」/.test(log), lines.find(l => l.includes('__not_implemented__')));
  check('③ ⚠️ 整輪的結論是失敗（有一步沒跑就不能算通過）',
    /完成 ─── 通過 \d+ ／ 失敗 [1-9]/.test(log), lines.at(-1));
  check('③ ⚠️ 而且沒有任何一步被記成「跳過」',
    /完成 ─── 通過 \d+ ／ 失敗 \d+ ／ 跳過 0/.test(log), lines.at(-1));
} finally {
  fa.activeRuns.delete(runId);
  fa.logBuffers.delete(runId);
  try { db.prepare('DELETE FROM frontend_auto_runs WHERE id = ?').run(runId) } catch { /* ignore */ }
  server.close();
  site.close();
}

// ── ④ 兩份引擎的動作集合必須一致 ──────────────────────────────────────────
// ⚠️ 這一項是**原始碼比對**（agent 端的 runner 在 import 當下就會去連線，跑不起來）。
//    但它正對著已經發生過的失效方式：`find_baseline_scroll` 只有一邊有。
//    合併成一份引擎之後，這一項會自然成立。
console.log('④ 兩份引擎的動作集合（⚠️ 原始碼比對，證明不了行為）');
{
  const actionsOf = (file) => new Set(
    [...stripComments(read(file)).matchAll(/step\.action === '([a-z_]+)'/g)].map(m => m[1]));
  const serverActions = actionsOf('server/routes/frontend-auto.ts');
  const agentActions = actionsOf('server/agent-runner.ts');
  const onlyServer = [...serverActions].filter(a => !agentActions.has(a)).sort();
  const onlyAgent = [...agentActions].filter(a => !serverActions.has(a)).sort();

  /**
   * 🚨 **已知的落差，尚未修**（v4.193.0 發現）。
   *
   * `find_baseline_scroll`（尋找基準圖）只有伺服器端實作。修法要讓 agent 拿得到
   * 基準圖檔，而那排在「合併引擎」之後（合併後只要做一次）。
   *
   * ⚠️ 這裡刻意用「**完全等於**」而不是「至少包含」——所以：
   *   - 多出**新的**落差 → 紅（擋住再漂一次）
   *   - 這個落差**被修好了** → 也會紅，提醒把這個例外拿掉（免得它永遠留著）
   *
   * 在它被擋住之前，agent 端遇到這顆積木會**明確失敗**（v4.193.0 起），不會再靜默跳過。
   */
  const KNOWN_SERVER_ONLY = ['find_baseline_scroll'];
  check('④ 🚨 伺服器端有、agent 端沒有的動作，只能是已知的那一個',
    JSON.stringify(onlyServer) === JSON.stringify(KNOWN_SERVER_ONLY),
    `目前只有伺服器端有：${onlyServer.join('、') || '（無）'}；`
    + `已知例外：${KNOWN_SERVER_ONLY.join('、')}。`
    + `${onlyServer.length < KNOWN_SERVER_ONLY.length ? '少了——是不是修好了？修好了就把例外拿掉。' : '多了——有新的落差，agent 上跑到那顆會失敗。'}`);
  check('④ agent 端有、伺服器端沒有的動作',
    onlyAgent.length === 0, `只有 agent 端有：${onlyAgent.join('、') || '（無）'}`);
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
