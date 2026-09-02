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

console.log('\n6) 需重啟清單不能手寫了就放著——從程式碼推導出來對答案');
// ⚠️ RESTART_REQUIRED_SOURCES 是手寫的 Set，跟「手動版號會漂」是同一個病：
//    有人加了新的 import，這份清單不會自己跟上，而且**不會有任何錯誤**
//    ——只會靜靜地把「該重啟」判成「不用重啟」，使用者按了更新以為好了，
//    實際跑的還是舊的（CodeX review 提醒：要逼它明確歸類，不要默默漏掉）。
{
  const fs = await import('node:fs');
  const readRel = (rel) => {
    for (const cand of [rel, rel.replace(/\.js$/, '.ts')]) {
      const abs = path.join(root, 'server', cand);
      if (!fs.existsSync(abs)) continue;
      let src = fs.readFileSync(abs, 'utf8');
      // ⚠️ 要讀「agent 實際拿到的那份」，不是 repo 裡的原始檔。
      //    serveAgentSource() 會把 runner.ts 的 gemini import 改寫成 ./gemini-agent.js，
      //    照原始檔走的話會漏掉 gemini-agent.ts，然後這支守門會反過來說「你多列了」。
      //    （第一次跑就是這樣誤報的。）
      if (cand === 'machine-test/runner.ts') {
        src = src.replace(
          /import \{[^}]+\} from '\.\.\/routes\/gemini\.js'/,
          "import { callGeminiVision, callGeminiVisionMulti } from './gemini-agent.js'",
        );
      }
      return src;
    }
    return null;
  };
  // 只認靜態 import。之後若有人改成 dynamic import，這支會抓到「被 import 卻沒列」
  // 或反過來的落差而變紅，逼人明確決定要不要算進需重啟。
  const staticImports = (src) =>
    [...src.matchAll(/^\s*import\s[^;]*?from\s+['"](\.[^'"]+)['"]/gm)].map(m => m[1]);
  const seen = new Set();
  const walk = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const src = readRel(rel);
    if (!src) return;
    const dir = path.posix.dirname(rel);
    for (const spec of staticImports(src)) walk(path.posix.normalize(path.posix.join(dir, spec)));
  };
  walk('agent-runner.ts');

  // 只比對白名單內的——非白名單的檔案 agent 根本不會拿到
  const mt = fs.readFileSync(path.join(root, 'server/routes/machine-test.ts'), 'utf8');
  const block = mt.slice(mt.indexOf('AGENT_SOURCE_WHITELIST'));
  const whitelist = new Set(
    [...block.slice(0, block.indexOf('\n}')).matchAll(/'([^']+\.(?:ts|js|json|ps1|py))'\s*:/g)].map(m => m[1]),
  );

  // ⚠️ 副檔名要對齊才比得起來：TS 的 ESM import 寫的是 `./machine-test/runner.js`，
  //    但磁碟上與白名單裡都是 `.ts`。不處理的話推導結果會少一半，
  //    然後這支守門就會反過來說「你多列了」——量測工具自己先錯。
  const toWhitelistKey = (f) => whitelist.has(f) ? f
    : whitelist.has(f.replace(/\.js$/, '.ts')) ? f.replace(/\.js$/, '.ts')
    : null;
  const derived = new Set([...seen].map(toWhitelistKey).filter(Boolean));
  const missing = [...derived].filter(f => !RESTART_REQUIRED_SOURCES.has(f));
  const extra = [...RESTART_REQUIRED_SOURCES].filter(f => !derived.has(f));
  check('被靜態 import 卻沒列進需重啟的：無', missing.length === 0, missing.join(', '));
  check('列了卻其實沒被 import 的：無', extra.length === 0, extra.join(', '));
  console.log(`     （從 agent-runner.ts 推導出 ${derived.size} 個白名單內的相依）`);
}

console.log(`\n${fail === 0 ? '全部通過' : fail + ' 項未過'}（pass ${pass} / fail ${fail}）`);
process.exit(fail ? 1 : 0);
