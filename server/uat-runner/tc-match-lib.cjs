/**
 * tc-match-lib.cjs
 * 共用的「Lark TC ↔ run-lark-tc-backend.js verifier規則」比對邏輯。
 *
 * 這支lib被兩個工具共用：
 *   - check-tc-coverage.cjs  （每次跑：找缺口 + 找registry drift）
 *   - build-tc-registry.cjs  （手動跑：新增/刷新 tc-registry.json 凍結快照）
 *
 * ⚠️ 只維護一份抽取邏輯，避免像2026-08-06那次 detectManual() 抽取規則跟其他
 * verifier不同格式、兩支腳本各自維護一份導致其中一份漏判的問題重演。
 */
const fs = require('fs');
const path = require('path');

const SCRIPT_PATH = path.join(__dirname, 'run-lark-tc-backend.js');

function loadSrcText() {
  return fs.readFileSync(SCRIPT_PATH, 'utf8');
}

function extractConstOrFallback(srcText, name) {
  const m = srcText.match(new RegExp(`const ${name}\\s*=[^;]*?(['"\`])([^'"\`]*?)\\1\\s*;`));
  return m ? m[2] : null;
}

// APP_TOKEN/TABLE_ID 在 run-lark-tc-backend.js 裡實際宣告是
// `process.env.LARK_APP_TOKEN || '固定預設值'`，regex抽取只能抓到最後的字串
// fallback（預設/正式表），抓不到process.env這段——這代表先前extractConstOrFallback
// 抓到的永遠是「正式表」，即使該次live run是帶著LARK_APP_TOKEN/LARK_TABLE_ID
// 環境變數指向另一張表（例如2026-08-06的新表 KRv8bF5C4aaIacsN5L6le9Rugre）在跑。
// 這裡讓env var優先於regex抽出的預設值，這樣同一套matching/registry工具才能
// 用在「非預設Lark表」上，不會誤把新表的TC數當成永遠等於正式表數量。
function getLarkConfig(srcText) {
  return {
    APP_ID: extractConstOrFallback(srcText, 'APP_ID'),
    APP_SECRET: extractConstOrFallback(srcText, 'APP_SECRET'),
    APP_TOKEN: process.env.LARK_APP_TOKEN || extractConstOrFallback(srcText, 'APP_TOKEN'),
    TABLE_ID: process.env.LARK_TABLE_ID || extractConstOrFallback(srcText, 'TABLE_ID'),
    LARK_BASE: extractConstOrFallback(srcText, 'LARK_BASE') || 'https://open.larksuite.com/open-apis',
    LARK_TOKEN_URL: extractConstOrFallback(srcText, 'LARK_TOKEN_URL') || 'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal',
  };
}

function extractSubtypeMap(srcText) {
  const m = srcText.match(/const SUBTYPE_MAP = \{([\s\S]*?)\n\};/);
  const body = m[1];
  const entries = {};
  const re = /'([^']+)':\s*\{\s*path:\s*'([^']*)'/g;
  let mm;
  while ((mm = re.exec(body))) entries[mm[1]] = mm[2];
  return entries;
}

function extractPageVerifiers(srcText) {
  const m = srcText.match(/const PAGE_VERIFIERS = \{([\s\S]*?)\n\};/);
  const body = m[1];
  const entries = {};
  const re = /'([^']+)':\s*(\w+),/g;
  let mm;
  while ((mm = re.exec(body))) entries[mm[1]] = mm[2];
  return entries;
}

function extractFunctionBody(srcText, fnName) {
  const marker = `async function ${fnName}(page, tc) {`;
  const idx = srcText.indexOf(marker);
  if (idx === -1) return null;
  let i = srcText.indexOf('{', idx);
  let depth = 0, end = -1;
  for (let j = i; j < srcText.length; j++) {
    if (srcText[j] === '{') depth++;
    else if (srcText[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return srcText.slice(idx, end);
}

function extractFunctionBody0(srcText, fnName) {
  const marker = `function ${fnName}(full) {`;
  const idx = srcText.indexOf(marker);
  if (idx === -1) return '';
  let i = srcText.indexOf('{', idx);
  let depth = 0, end = -1;
  for (let j = i; j < srcText.length; j++) {
    if (srcText[j] === '{') depth++;
    else if (srcText[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return srcText.slice(idx, end);
}

function extractTcMatchRegexes(fnBody) {
  const re = /\/((?:\\.|[^/\n])+)\/([a-z]*)\.test\((full|desc)\)/g;
  const out = [];
  let m;
  while ((m = re.exec(fnBody))) {
    try {
      out.push({ regex: new RegExp(m[1], m[2]), source: `/${m[1]}/${m[2]}`, target: m[3] });
    } catch (e) { /* 忽略無法編譯的 */ }
  }
  return out;
}

// detectManual() 用陣列literal `[/regex/flags, '原因'],`，跟其他verifier的
// `if (/regex/.test(full))` 呼叫式不同，需要專門抽取pattern。
function extractManualPatterns(srcText) {
  const fnBody = extractFunctionBody0(srcText, 'detectManual');
  const re = /\[\s*\/((?:\\.|[^/\n])+)\/([a-z]*)\s*,/g;
  const out = [];
  let m;
  while ((m = re.exec(fnBody))) {
    try { out.push({ regex: new RegExp(m[1], m[2]), source: `/${m[1]}/${m[2]}` }); } catch (e) { /* 忽略 */ }
  }
  return out;
}

// 完全沒有 TC 文字關鍵字分支的通用verifier（純結構性檢查），matching無意義，
// 不列入registry/覆蓋率統計。verifyDailyDashboard另計：它有真實TC文字分支，
// 只是用body text關鍵字比對而非regex.test(full)，靜態掃描抓不到，人工已核對過。
const STRUCTURAL_ONLY = new Set([
  'verifyLogPage', 'verifyAbnormalityPage', 'verifyMachineMonitoring',
  'verifyPlayerWatch', 'verifyDepositSetting', 'verifyReservationLimit',
  'verifyDailyDashboard',
]);

// 2026-08-06新增：這些「任務子類型」根本不走SUBTYPE_MAP/PAGE_VERIFIERS這條主線，
// 是main()裡獨立特判分支處理（例如積分VIP用REWARD_POINTS_MAP關鍵字二次比對，
// 對應到rewardpoints/*底下6個不同頁面）。靜態掃描只看SUBTYPE_MAP/PAGE_VERIFIERS，
// 天生看不到這類特判邏輯，會誤報成「無verifier對照」（看起來像完全沒人處理），
// 實際上是main()有處理、只是繞過了這支工具在檢查的那條路徑。列在這裡讓覆蓋率報告
// 誠實區分「真的沒人管」vs「工具看不到但main()有特判」，避免像CodeX提醒的誤導判斷。
const SPECIAL_CASE_SUBTYPES = new Set(['積分VIP']);

async function fetchAllLiveTCs(cfg) {
  const tokRes = await fetch(cfg.LARK_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: cfg.APP_ID, app_secret: cfg.APP_SECRET }),
  });
  const tokD = await tokRes.json();
  const token = tokD.tenant_access_token;

  let allRecords = [];
  let pageToken = null;
  do {
    const url = new URL(`${cfg.LARK_BASE}/bitable/v1/apps/${cfg.APP_TOKEN}/tables/${cfg.TABLE_ID}/records`);
    url.searchParams.set('page_size', '100');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    const d = await res.json();
    if (d.code !== 0) throw new Error('fetch failed: ' + d.msg);
    allRecords = allRecords.concat(d.data.items || []);
    pageToken = d.data.has_more ? d.data.page_token : null;
  } while (pageToken);

  return allRecords.filter(r => {
    const envs = r.fields['環境'] || [];
    const devices = r.fields['裝置'] || [];
    const port = r.fields['端口'] || '';
    const sub = r.fields['任務子類型'] || '';
    return envs.includes('UAT服') && (devices.includes('後台') || port === '後台') && sub;
  });
}

/**
 * 對一批live TC records計算覆蓋狀態。
 * 回傳 { covered, gaps, structuralOnly, noVerifierMapped }
 * covered 項目含 { id, sub, tcText, verifierName, via }
 */
function computeCoverage(srcText, targets) {
  const subtypeMap = extractSubtypeMap(srcText);
  const pageVerifiers = extractPageVerifiers(srcText);
  const manualPatterns = extractManualPatterns(srcText);

  const fnBodyCache = {};
  const fnRegexCache = {};
  function getRegexesFor(fnName) {
    if (!fnRegexCache[fnName]) {
      fnBodyCache[fnName] = extractFunctionBody(srcText, fnName) || '';
      fnRegexCache[fnName] = extractTcMatchRegexes(fnBodyCache[fnName]);
    }
    return fnRegexCache[fnName];
  }

  const gaps = [];
  const covered = [];
  const structuralOnly = [];
  const noVerifierMapped = [];
  const specialCaseHandled = [];

  for (const r of targets) {
    const sub = r.fields['任務子類型'];
    const tcText = r.fields['任務'] || '';
    if (SPECIAL_CASE_SUBTYPES.has(sub)) {
      specialCaseHandled.push({ id: r.record_id, sub, tcText });
      continue;
    }
    const verifierName = pageVerifiers[sub];
    if (!verifierName) {
      noVerifierMapped.push({ id: r.record_id, sub, tcText });
      continue;
    }
    if (STRUCTURAL_ONLY.has(verifierName)) {
      structuralOnly.push({ id: r.record_id, sub, tcText, verifierName });
      continue;
    }
    const manualHit = manualPatterns.find(p => p.regex.test(tcText));
    if (manualHit) {
      covered.push({ id: r.record_id, sub, tcText, verifierName, via: `MANUAL(${manualHit.source})` });
      continue;
    }
    const regexes = getRegexesFor(verifierName);
    const hit = regexes.find(p => p.regex.test(tcText));
    if (hit) {
      covered.push({ id: r.record_id, sub, tcText, verifierName, via: hit.source });
    } else {
      gaps.push({ id: r.record_id, sub, tcText, verifierName, availableRules: regexes.length });
    }
  }

  return { covered, gaps, structuralOnly, noVerifierMapped, specialCaseHandled };
}

// ── 文字相似度（正規化後的字元 trigram Jaccard相似度，夠用、不需要外部套件）──
function normalize(s) {
  return (s || '').replace(/\s+/g, '').trim();
}
function trigrams(s) {
  const n = normalize(s);
  const set = new Set();
  if (n.length < 3) { if (n) set.add(n); return set; }
  for (let i = 0; i <= n.length - 3; i++) set.add(n.slice(i, i + 3));
  return set;
}
function textSimilarity(a, b) {
  if (normalize(a) === normalize(b)) return 1;
  const ta = trigrams(a), tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const g of ta) if (tb.has(g)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 1 : inter / union;
}

const REGISTRY_PATH = path.join(__dirname, 'tc-registry.json');
function loadRegistry() {
  try { return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')); } catch (e) { return {}; }
}
function saveRegistry(reg) {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2), 'utf8');
}

module.exports = {
  SCRIPT_PATH, REGISTRY_PATH,
  loadSrcText, getLarkConfig, fetchAllLiveTCs, computeCoverage,
  STRUCTURAL_ONLY, textSimilarity, normalize,
  loadRegistry, saveRegistry,
};
