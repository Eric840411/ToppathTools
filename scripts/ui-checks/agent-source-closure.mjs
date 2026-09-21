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
  // 2026-09-21 補上（見下方註解）：H5/PC 那條路徑終於納入檢查
  'agent-runner.ts',
];

/* ── `agent-runner.ts` 的盲點已補上（2026-09-21）────────────────────────────
 *
 * 它是 agent 端的主程式（H5/PC 派工是它在跑），所以它的相依也必須在 agent 上存在。
 * 2026-09-18 試著加進來時，閉包會走到 `machine-test/runner.ts → routes/gemini.ts →
 * shared.ts／auth-session.ts／request-context.ts`，那四個都不在白名單，
 * 當時的判斷是「在查清楚之前不加，免得這支長期紅著、訓練大家忽略它」。
 *
 * 2026-09-21 重跑：**那條路徑已經不會走到了**，加進來是綠的（檢查 44 個節點）。
 * 所以正式納入——而這次漏掉的 `pc-node-hittest.js` 正是被 `frontend-engine.js`
 * import 的，也就是**只有涵蓋這條路徑才抓得到**。
 *
 * ⚠️ 如果哪天它又紅了而且紅在 `shared.ts` 那條，**不要直接把 agent-runner 拿掉**——
 *    先確認是不是有人把 server 專用的東西 import 進 agent 路徑了，那才是真問題。 */

// 從原始碼直接抓白名單的 key，不另外維護一份（維護兩份必然漂移）
const mtSrc = fs.readFileSync(path.join(root, 'server/routes/machine-test.ts'), 'utf8');
const block = mtSrc.slice(mtSrc.indexOf('AGENT_SOURCE_WHITELIST'));
const whitelist = new Set([...block.slice(0, block.indexOf('\n}')).matchAll(/'([^']+\.(?:ts|js|json|ps1|py))'\s*:/g)].map(m => m[1]));

if (whitelist.size === 0) { console.log('讀不到白名單——machine-test.ts 的格式可能改了'); process.exit(1) }
console.log(`白名單 ${whitelist.size} 個檔案\n`);

/**
 * NodeNext 的 import 寫的是 `.js`，但 TypeScript 原始檔是 `.ts`。
 *
 * ⚠️ 不做這層對應的話，凡是 `.ts` 寫的相依都會被報成「白名單缺少」——
 *    而它們其實好好地在白名單裡（key 是 `.ts`）。那種假警報會讓人學會忽略這支檢查，
 *    真的漏檔案時就沒人看了。（2026-09-18 把 agent-runner.ts 加成進入點時浮出來。）
 */
const onDisk = (relPath) => {
  if (fs.existsSync(path.join(root, 'server', relPath))) return relPath;
  if (relPath.endsWith('.js')) {
    const ts = `${relPath.slice(0, -3)}.ts`;
    if (fs.existsSync(path.join(root, 'server', ts))) return ts;
  }
  return relPath;
};

const relImports = (relPath) => {
  const abs = path.join(root, 'server', relPath);
  if (!fs.existsSync(abs)) return null;
  const src = fs.readFileSync(abs, 'utf8');
  const dir = path.dirname(relPath);
  return [...src.matchAll(/(?:from|import)\s+['"](\.[^'"]+)['"]/g)]
    .map(m => onDisk(path.posix.normalize(path.posix.join(dir, m[1]))));
};

let missing = 0, checked = 0;
for (const entry of ENTRY_POINTS) {
  const seen = new Set();
  const stack = [onDisk(entry)];
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
