/**
 * Local Agent 版本比對：三種狀態要分得開，而且不能有「永遠顯示最新」這種壞法。
 *
 * ⚠️ 這類比對邏輯寫錯**不會噴錯**，只會靜靜地永遠給同一個答案：
 *    - 永遠「最新」→ 真的落後的 agent 不會被提醒，功能吃不到卻查不出原因
 *    - 永遠「需要更新」→ 使用者按了更新還是紅的，最後學會忽略它
 *    兩種都比沒有這個功能更糟，所以每一條分支都要有測試。
 *
 * 也驗指紋本身的性質：換行正規化、順序無關、少一個檔案要測得出來。
 *
 * 跑法：node scripts/ui-checks/agent-version-check.mjs
 */
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// ⚠️ Windows 上一定要 pathToFileURL——直接把 `C:\...` 丟給 import() 會被當成
//    protocol 'c:' 而拒絕（ERR_UNSUPPORTED_ESM_URL_SCHEME）
const mod = await import(pathToFileURL(path.join(root, 'dist-server/server/agent-source-hash.js')).href);
const { hashSources, hashOne, normalizeSource, compareAgentSources, RESTART_REQUIRED_SOURCES } = mod;

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++ };

console.log('\n1) 指紋的基本性質');
check('CRLF 與 LF 算出來一樣（Windows checkout vs macOS agent）',
  hashOne('a\r\nb\r\n') === hashOne('a\nb\n'));
check('檔尾多餘換行不影響', hashOne('a\nb') === hashOne('a\nb\n\n\n'));
check('內容不同就不同', hashOne('a') !== hashOne('b'));
check('鍵的插入順序不影響（Object.keys 順序不保證穩定）',
  hashSources({ b: '2', a: '1' }) === hashSources({ a: '1', b: '2' }));
check('少一個檔案測得出來',
  hashSources({ a: '1', b: '2' }) !== hashSources({ a: '1' }));
// 檔案存在但內容空 vs 檔案不存在：agent 端把讀不到當空字串，兩者要能區分「有沒有這個鍵」
check('空內容的檔案仍計入（不會跟「沒有這個檔案」撞在一起）',
  hashSources({ a: '1', b: '' }) !== hashSources({ a: '1' }));

console.log('\n2) 三種狀態');
const E = { expectedAll: 'AAA', expectedRestartScoped: 'RRR' };
check('全部一致 → current',
  compareAgentSources({ ...E, agentAll: 'AAA', agentRestartScopedAtBoot: 'RRR' }) === 'current');
check('檔案指紋不同 → needs_update',
  compareAgentSources({ ...E, agentAll: 'OLD', agentRestartScopedAtBoot: 'RRR' }) === 'needs_update');
check('檔案已最新、但啟動時載入的是舊的 → needs_restart',
  compareAgentSources({ ...E, agentAll: 'AAA', agentRestartScopedAtBoot: 'OLD' }) === 'needs_restart');

console.log('\n3) 不能假裝正常');
check('舊版 agent 沒回報指紋 → unknown（不是 current）',
  compareAgentSources({ ...E }) === 'unknown');
check('只回報一半也算 unknown',
  compareAgentSources({ ...E, agentAll: 'AAA' }) === 'unknown');

console.log('\n4) needs_update 優先於 needs_restart');
// 兩個都不一致時要先叫他更新——更新完才知道需不需要重啟，反過來會叫他白重開一次
check('兩者都落後 → 先報 needs_update',
  compareAgentSources({ ...E, agentAll: 'OLD', agentRestartScopedAtBoot: 'OLD' }) === 'needs_update');

console.log('\n5) 要重啟的清單');
// 這幾支是 agent-runner.ts 靜態 import 的，換檔案不重啟不會生效
for (const f of ['agent-runner.ts', 'machine-test/runner.ts', 'uat-runner/net-capture.js', 'uat-runner/pinus-probe.js'])
  check(`${f} 列為需重啟`, RESTART_REQUIRED_SOURCES.has(f));
// 這幾支每次執行才 spawn，寫完就生效
for (const f of ['uat-runner/run-lark-tc-backend.js', 'python/toppath-agent.py', 'uat-runner/block-engine.js'])
  check(`${f} 不需重啟`, !RESTART_REQUIRED_SOURCES.has(f));

console.log(`\n${fail === 0 ? '全部通過' : fail + ' 項未過'}（pass ${pass} / fail ${fail}）`);
process.exit(fail ? 1 : 0);
