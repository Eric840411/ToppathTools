/**
 * 派給 Local Agent 的原始碼白名單有沒有漏檔案。
 *
 * 背景：`AGENT_SOURCE_WHITELIST`（server/routes/machine-test.ts）決定哪些檔案會被送到
 * agent。**漏一個，agent 端會在 import 當下直接炸掉**——不是執行到那行才失敗，
 * 是整個腳本起不來；而且錯誤只出現在 agent 的 stderr，server 這邊完全看不出原因。
 *
 * 已經發生過兩次：
 *   - net-capture.js / pinus-probe.js（三個 runner 都 import，當時補上了）
 *   - detect-manual.js（v4.52.0 新增檔案時漏加，隔了幾天真的派工才爆出來，
 *     使用者看到的是 `Cannot find module '.../detect-manual.js'`）
 *
 * 這支從 agent 實際會 spawn 的進入點做 BFS 算出相依閉包，跟白名單比對。
 * 純靜態分析，不連任何服務。
 *
 * 跑法：node scripts/ui-checks/agent-source-closure.mjs
 * 加新 import 之後就跑一次。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** agent 端真正會被 spawn／載入的進入點（相對於 server/）。
 *  新增一種派工模式時要一起加進來，否則那條路徑的相依不會被檢查到。 */
const ENTRY_POINTS = [
  'uat-runner/run-lark-tc-backend.js',
  'uat-runner/backend-recorder.js',
];

// 從原始碼直接抓白名單的 key，不另外維護一份（維護兩份必然漂移）
const mtSrc = fs.readFileSync(path.join(root, 'server/routes/machine-test.ts'), 'utf8');
const block = mtSrc.slice(mtSrc.indexOf('AGENT_SOURCE_WHITELIST'));
const whitelist = new Set([...block.slice(0, block.indexOf('\n}')).matchAll(/'([^']+\.(?:ts|js|json|ps1|py))'\s*:/g)].map(m => m[1]));

if (whitelist.size === 0) { console.log('讀不到白名單——machine-test.ts 的格式可能改了'); process.exit(1) }
console.log(`白名單 ${whitelist.size} 個檔案\n`);

const relImports = (relPath) => {
  const abs = path.join(root, 'server', relPath);
  if (!fs.existsSync(abs)) return null;
  const src = fs.readFileSync(abs, 'utf8');
  const dir = path.dirname(relPath);
  return [...src.matchAll(/(?:from|import)\s+['"](\.[^'"]+)['"]/g)]
    .map(m => path.posix.normalize(path.posix.join(dir, m[1])));
};

let missing = 0, checked = 0;
for (const entry of ENTRY_POINTS) {
  const seen = new Set();
  const stack = [entry];
  const gaps = [];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (!whitelist.has(cur)) gaps.push(cur);
    const deps = relImports(cur);
    if (deps === null) { console.log(`  (檔案不存在，略過) ${cur}`); continue }
    stack.push(...deps);
  }
  checked += seen.size;
  console.log(`${entry}`);
  console.log(`  相依閉包 ${seen.size} 個：${[...seen].sort().join(', ')}`);
  if (gaps.length) {
    missing += gaps.length;
    console.log(`  FAIL 白名單缺少：${gaps.join(', ')}`);
  } else {
    console.log('  PASS 白名單完整');
  }
  console.log();
}

// 白名單裡有、但沒被任何進入點用到的不算錯（例如 pinus-probe.js 只有 H5/PC 的
// runner 會用，那兩個是 .ts 走另一條打包路徑），只列出來當參考
const used = new Set();
for (const entry of ENTRY_POINTS) {
  const stack = [entry];
  while (stack.length) {
    const cur = stack.pop();
    if (used.has(cur)) continue;
    used.add(cur);
    stack.push(...(relImports(cur) ?? []));
  }
}
const unused = [...whitelist].filter(w => w.startsWith('uat-runner/') && !used.has(w) && !w.endsWith('.json'));
if (unused.length) console.log(`（參考）白名單裡的 uat-runner 檔案沒被上面的進入點 import：${unused.join(', ')}`);

console.log(`\n${missing === 0 ? '通過——所有進入點的相依都在白名單裡' : `未過：${missing} 個檔案不在白名單`}（檢查 ${checked} 個節點）`);
process.exit(missing ? 1 : 0);
