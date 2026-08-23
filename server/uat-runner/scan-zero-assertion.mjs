/**
 * 掃出「跑完但一個斷言都沒執行」的 TC。
 *
 * 這種 TC 目前會判定為通過——驗證器裡每一條分支條件都不命中，什麼都沒驗，
 * criticalFails 是空的，於是綠燈。比直接失敗還糟：它讓人以為這件事有在測。
 *
 * 判斷方式是靜態的：拿 TC 的描述文字去比對它那支驗證器的所有分支 regex，
 * 一條都不中就必然零斷言（跟頁面當下的狀態無關）。先被 detectManual 攔下的
 * 不算——那是正當的人工判讀結果。
 *
 * 跑法：cd server/uat-runner && node scan-zero-assertion.mjs
 */
import fs from 'fs';

const src = fs.readFileSync('run-lark-tc-backend.js', 'utf8');
const lines = src.split(/\r?\n/);

const bodies = {};
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^async function (verify\w+)\s*\(/);
  if (!m) continue;
  let e = i + 1;
  while (e < lines.length && !/^(async )?function /.test(lines[e])) e++;
  bodies[m[1]] = lines.slice(i, e);
}

/** 從一行 `if (/xxx/i.test(full)) {` 取出那個 regex。用字串切割，不用 regex 去 parse regex */
function pickRegex(line) {
  const t = line.trim();
  if (!t.startsWith('if (') && !t.startsWith('[')) return null;
  const at = ['.test(full)', '.test(desc)'].map(k => t.indexOf(k)).find(i => i >= 0);
  const cut = at === undefined ? t : t.slice(0, at);
  const start = cut.indexOf('/');
  const end = cut.lastIndexOf('/');
  if (start < 0 || end <= start) return null;
  try { return new RegExp(cut.slice(start + 1, end), cut.slice(end + 1).replace(/[^a-z]/g, '').replace('g', '')) }
  catch { return null }
}

const regexOf = {};
for (const [name, body] of Object.entries(bodies)) {
  regexOf[name] = body
    .filter(l => l.trim().startsWith('if (') && /\.test\((full|desc)\)/.test(l))
    .map(pickRegex).filter(Boolean);
}

// detectManual 的樣式：這些 TC 會在任何斷言之前就被判成人工判讀，是正當結果不是假通過
const dm = src.match(/function detectManual[\s\S]*?\n\}/)[0];
const manualPatterns = dm.split(/\r?\n/)
  .filter(l => l.trim().startsWith('['))
  .map(pickRegex).filter(Boolean);

const reg = JSON.parse(fs.readFileSync('tc-registry.json', 'utf8'));
let total = 0, manual = 0;
const falsePass = [];
for (const [, v] of Object.entries(reg)) {
  const name = v.verifierName;
  const text = v.canonicalText || '';
  if (!name || !regexOf[name]?.length) continue;
  total++;
  if (manualPatterns.some(r => r.test(text))) { manual++; continue }   // 先被判成 MANUAL
  if (!regexOf[name].some(r => r.test(text))) falsePass.push([name, text.replace(/\s+/g, ' ').slice(0, 46)]);
}

console.log(`可分析：${total} 筆`);
console.log(`  先被 detectManual 攔成人工判讀（正當結果）：${manual} 筆`);
console.log(`  跑完但一個分支都不中 ＝ 目前判定為通過、實際零斷言：${falsePass.length} 筆\n`);
const by = {};
for (const [n] of falsePass) by[n] = (by[n] || 0) + 1;
for (const [n, c] of Object.entries(by).sort((a, b) => b[1] - a[1])) console.log(`  ${String(c).padStart(3)}  ${n}`);
console.log('\n全部列出：');
for (const [n, t] of falsePass) console.log(`  ${n.padEnd(26)}${t}`);
