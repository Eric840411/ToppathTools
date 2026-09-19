/**
 * scripts/ui-checks/changelog-render-all.mjs
 *
 * **把 `src/version.ts` 裡每一行更新日誌都真的跑一次渲染。**
 *
 * ## 為什麼要有這支（它抓到過什麼）
 * 寫 `entry-format.ts` 時我先寫了 9 項單元測試，**全部通過**。然後拿真的日誌
 * （當時 756 行）跑一次，結果是**整支卡死**——我那條認 emoji 的 regex 寫成
 * `(?:[^\w\s(*`]+\s*)+`，而 JS 的 `\w` 只有 `[A-Za-z0-9_]`，
 * **每一個中文字都符合「非英數」**：那一組會把整句中文吃進去，再加上
 * `(X+ Y*)+` 的形狀，比對失敗時災難性回溯。
 *
 * 短測試案例永遠碰不到那個情況。**只有拿全部真實資料跑過才會知道。**
 *
 * ## 它守三件事
 *   ① **跑得完**（不會因為某一行的回溯而卡住）
 *   ② **內容一個字都不能少**：拆成片段再接回去必須跟原字串完全相同
 *   ③ **不能有殘留的 `**`**：那正是使用者回報的症狀
 *
 * 跑法：node scripts/ui-checks/changelog-render-all.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// ⚠️ Node 24 原生吃得下 .ts（type stripping），所以直接 import 產品那一份，
//    不用 tsx、也不用自己重寫一份解析——重寫的話就變成在測我自己的副本。
const { parseChangeLine, renderInline } = await import(
  pathToFileURL(path.join(root, 'src/features/changelog/entry-format.ts')).href
);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};

// ── 從 version.ts 抽出每一行 changes 字串 ─────────────────────────────────
const src = fs.readFileSync(path.join(root, 'src/version.ts'), 'utf8').replace(/\r\n/g, '\n');
const lines = [];
for (const block of src.matchAll(/changes: \[(.*?)\] \},\n/gs)) {
  for (const hit of block[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)) {
    lines.push(hit[1].replace(/\\'/g, "'"));
  }
}
check('抽得到日誌內容（抽不到的話下面全都是空跑）', lines.length > 100, `只抽到 ${lines.length} 行`);

// ── ① 跑得完 ──────────────────────────────────────────────────────────────
// ⚠️ 用時間上限而不是「有沒有丟例外」：回溯爆炸不會報錯，它只是**不回來**。
const started = Date.now();
let tagged = 0;
let leaked = 0;
let altered = [];
for (const line of lines) {
  const parsed = parseChangeLine(line);
  if (parsed.type) tagged++;
  const tokens = renderInline(parsed.text);
  const textOnly = tokens.filter(t => t.kind === 'text').map(t => t.value).join('');
  if (textOnly.includes('**')) leaked++;
  // ⚠️ 不能用「重組回原字串」來比——粗體裡面包程式碼時，重組出來的標記位置
  //    本來就跟原文不同（那是正常的）。真正要守的是**字有沒有少**，
  //    所以兩邊都把標記字元拿掉再比。
  const strip = (x) => x.replace(/[`*]/g, '');
  const joined = tokens.map(t => t.value).join('');
  if (strip(joined) !== strip(parsed.text) && altered.length < 5) altered.push(line.slice(0, 70));
}
const elapsed = Date.now() - started;
check(`① 全部 ${lines.length} 行跑得完（${elapsed}ms）`, elapsed < 5000,
  `花了 ${elapsed}ms——回溯爆炸不會報錯，它只是不回來`);

// ── ② 內容不能少 ──────────────────────────────────────────────────────────
check('② 🚨 拆完再接回去跟原文一字不差（少字是最難發現的壞法）',
  altered.length === 0, altered.join('\n        '));

// ── ③ 不能有殘留的 `**` ───────────────────────────────────────────────────
check('③ 🚨 渲染後沒有任何一行還露出 `**`（這正是使用者回報的症狀）',
  leaked === 0, `還有 ${leaked} 行`);

// ── 附帶：有標籤的比例（掉太多代表格式規則又被打破了）─────────────────────
const ratio = lines.length ? tagged / lines.length : 0;
check(`附帶：${tagged}/${lines.length} 行認得出類型標籤（${Math.round(ratio * 100)}%）`,
  ratio > 0.3,
  '比例掉太低通常代表日誌又改成另一種寫法，而解析端沒跟上');

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
