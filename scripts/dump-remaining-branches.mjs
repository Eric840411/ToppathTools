/**
 * 把「還沒積木化、而且真的會跑驗證」那幾筆 TC 對應的 verifier 分支本體 dump 出來。
 *
 * 為什麼要這支：上一輪估「41 筆可以拆」，實際讀完程式碼只剩 13——**照 TC 筆數和印象
 * 分類會估錯**，一定要看 verifier 真正做了什麼。這支就是把該讀的東西一次撈齊。
 *
 * 跑法：node scripts/dump-remaining-branches.mjs
 */
import fs from 'fs';

const src = fs.readFileSync('server/uat-runner/run-lark-tc-backend.js', 'utf8');
const reg = JSON.parse(fs.readFileSync('server/uat-runner/tc-registry.json', 'utf8'));

// detectManual 直接從原始碼取出來用，不重寫一份
const di = src.indexOf('function detectManual');
const dj = src.indexOf('\n}', src.indexOf('return null', di));
const detectManual = new Function(src.slice(di, dj + 2) + '; return detectManual;')();

const Database = (await import('better-sqlite3')).default;
const db = new Database('server/data.db', { readonly: true });
const have = new Set(db.prepare('SELECT record_id FROM uat_tc_steps').all().map(r => r.record_id));

/** 取出某支 verifier 的完整原始碼 */
function verifierBody(name) {
  const i = src.indexOf(`async function ${name}(`);
  if (i < 0) return null;
  const j = src.indexOf('\nasync function ', i + 10);
  return src.slice(i, j > 0 ? j : src.length);
}

/** 在 verifier 裡找出「會命中這段 TC 文字」的那個 if 分支，連同本體一起回傳 */
function matchingBranch(body, tcText) {
  const lines = body.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/if \((\/.*?\/[a-z]*)\.test\(full\)\)/);
    if (!m) continue;
    let re;
    try { re = eval(m[1]) } catch { continue }
    if (!re.test(tcText)) continue;
    // 抓到對的分支——往下找到縮排回到同一層的 `}`
    const indent = lines[i].match(/^\s*/)[0].length;
    let end = i + 1;
    for (; end < lines.length; end++) {
      const l = lines[end];
      if (l.trim() === '' ) continue;
      const ind = l.match(/^\s*/)[0].length;
      if (ind <= indent && /^\s*\}/.test(l)) break;
    }
    out.push({ cond: m[1], body: lines.slice(i, end + 1).join('\n') });
  }
  return out;
}

let n = 0;
for (const id of Object.keys(reg)) {
  if (have.has(id)) continue;
  const text = reg[id].canonicalText || '';
  if (detectManual(text)) continue;
  n++;
  const vname = reg[id].verifierName;
  console.log(`\n${'='.repeat(78)}`);
  console.log(`${n}. [${vname}] ${id}`);
  console.log(`   ${text.replace(/\s+/g, ' ').slice(0, 120)}`);
  const body = verifierBody(vname);
  if (!body) { console.log('   ⚠️ 找不到 verifier'); continue }
  const branches = matchingBranch(body, text);
  if (branches.length === 0) { console.log('   ⚠️ 沒有任何分支條件命中——這筆跑起來什麼都不會驗'); continue }
  for (const b of branches) {
    console.log(`   --- 命中條件 ${b.cond} ---`);
    const lines = b.body.split('\n');
    console.log(lines.slice(0, 45).map(l => '   ' + l).join('\n'));
    if (lines.length > 45) console.log(`   …（還有 ${lines.length - 45} 行）`);
  }
}
console.log(`\n總共 ${n} 筆`);
