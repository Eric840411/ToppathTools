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

/**
 * 一行看起來是不是分支條件。
 *
 * ⚠️ 只認 `if (` 開頭會嚴重低估——驗證器裡最常見的寫法是一連串 `} else if (`
 * 各接一筆 TC（verifyGameSettingPage 就是這樣）。漏掉 else if 的話，那些 TC 會
 * 被誤判成「對不到任何分支」，掃描結果會憑空多出一堆假的假通過。
 */
const BRANCH_LINE = /^(\}\s*)?(else\s+)?if \(/;

/** 從一行 `if (/xxx/i.test(full)) {` 取出那個 regex。用字串切割，不用 regex 去 parse regex */
function pickRegex(line) {
  const t = line.trim();
  if (!BRANCH_LINE.test(t) && !t.startsWith('[')) return null;
  const at = ['.test(full)', '.test(desc)'].map(k => t.indexOf(k)).find(i => i >= 0);
  const cut = at === undefined ? t : t.slice(0, at);
  const start = cut.indexOf('/');
  const end = cut.lastIndexOf('/');
  if (start < 0 || end <= start) return null;
  // ⚠️ flags 只能取緊接在結尾斜線之後的那幾個字母。
  // 不能整段 replace(/[^a-z]/g,'')——detectManual 那些行長這樣：
  //   [/現場.*handpay/i, '需要現場 handpay 操作'],
  // 訊息字串裡的 "handpay" 會一起被當成 flags，new RegExp 拋錯，整條 pattern 就被
  // 默默丟掉。丟掉 detectManual 的 pattern = 把本來就標人工判讀的 TC 誤算成假通過。
  const flags = (cut.slice(end + 1).match(/^[a-z]*/) ?? [''])[0].replace('g', '');
  try { return new RegExp(cut.slice(start + 1, end), flags) }
  catch { return null }
}

const regexOf = {};
for (const [name, body] of Object.entries(bodies)) {
  regexOf[name] = body
    .filter(l => BRANCH_LINE.test(l.trim()) && /\.test\((full|desc)\)/.test(l))
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
