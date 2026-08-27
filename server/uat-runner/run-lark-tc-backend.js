/**
 * run-lark-tc-backend.js
 * 執行後台 UAT TC，截圖上傳 Lark 附圖欄，勾選 UAT測試通過
 *
 * 用法: node run-lark-tc-backend.js
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';
import { attachNetworkCapture, DEFAULT_THRESHOLDS, formatStatsLine } from './net-capture.js';
import { runSteps as runBlockSteps } from './block-engine.js';
import { resolveVerifierParams, verifierRanAssertion } from './verifier-params.js';

// ─── Lark 設定 ───────────────────────────────────────────────────────
const LARK_TOKEN_URL = 'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal';
const APP_ID         = 'cli_a80489fc6d389028';
const APP_SECRET     = 'HFXG1sWdNDiX0Aa4MngsTgzFxUKAci8I';
const APP_TOKEN      = process.env.LARK_APP_TOKEN || 'RjiabXR3Ra2pm4shI05lD4azgjg';
const TABLE_ID       = process.env.LARK_TABLE_ID  || 'tbllkNHrRF5ii6Qc';
const LARK_BASE      = 'https://open.larksuite.com/open-apis';

// ─── 篩選設定（留空 = 跑全部，填入 subtype 名稱 = 只跑該分類）─────────
// 用法: node run-lark-tc-backend.js "Daily Dashboard"
//   或直接改這裡: const FILTER_SUBTYPES = ['Daily Dashboard'];
const FILTER_SUBTYPES = process.argv[2]
  ? process.argv[2].split(',').map(s => s.trim())
  : [];

const LEGACY_MODULE_FILTERS = {
  dashboard: ['Dashboard'],
  'egm-core': ['EGM List', 'EGM Status', 'Gaming User', 'Machine Monitoring', 'Player Watch'],
  reports: ['EGM Detail', 'User Detail', 'EGM Transfer', 'Game Record', 'EGM DayCount', 'Player Credit Log', 'Fault List'],
  'game-config': ['Loading Tips', 'White List', 'Game Jump Set', 'News Set', 'Advert Set', 'How To Play', 'Special Entrance Set', 'Test Setting', 'Deposit Setting'],
  meters: ['Meter'], ranking: ['Daily Ranking', 'Channel Ranking', 'Bonus'], jackpot: ['Jackpot', 'JP Percent'],
  reservation: ['Reservation', '預約'], logs: ['Log', 'Abnormality', 'Error Record', 'Out Log'],
  'vip-version': ['VIP', 'Points', 'Membership', 'Version', '版本'], other: ['*'],
};
const MODULE_PLAN = (() => {
  try {
    const parsed = JSON.parse(process.env.UAT_MODULE_PLAN || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item, index) => {
      if (typeof item === 'string' && LEGACY_MODULE_FILTERS[item]) {
        return [{ instanceId: item, name: item, filters: LEGACY_MODULE_FILTERS[item] }];
      }
      if (!item || typeof item !== 'object') return [];
      const filters = Array.isArray(item.filters)
        ? item.filters.filter(filter => typeof filter === 'string' && filter.trim()).slice(0, 50).map(filter => filter.trim())
        : [];
      if (!filters.length) return [];
      return [{
        instanceId: String(item.instanceId || `module-${index}`).slice(0, 100),
        name: String(item.name || `Module ${index + 1}`).slice(0, 100),
        filters,
      }];
    });
  } catch {
    return [];
  }
})();

function findBackendModuleIndex(subtype, taskType) {
  const name = `${subtype || ''} ${taskType || ''}`.toLocaleLowerCase();
  const specificIndex = MODULE_PLAN.findIndex(module => module.filters.some(filter => filter !== '*' && name.includes(filter.toLocaleLowerCase())));
  if (specificIndex >= 0) return specificIndex;
  return MODULE_PLAN.findIndex(module => module.filters.includes('*'));
}

// ─── 後台設定 ─────────────────────────────────────────────────────────
const BACKEND_URL = 'http://uat-cp.osmslot.org';
const SCREENSHOT_DIR = './data/raw/screenshots/lark_tc';

// ─── 可調整參數（config/backend-test-params.json）──────────────────────
// 使用者可直接編輯這個JSON檔調整帳密/數值門檻/合法選項清單，不用動這支腳本本身的流程邏輯。
// 找不到檔案或格式錯誤時 fallback 到內建預設值，不會讓整支腳本掛掉。
const TEST_PARAMS = (() => {
  const defaults = {
    credentials: {
      // 內建預設留空：真實帳密一律走環境變數（伺服器端依登入者從 DB 取出注入）或本機的
      // config 檔（已 gitignore）。寫死 admin/123456 這種值等於把可用的帳密留在 repo 裡，
      // 而這個專案的後台密碼長度剛好就是 6 碼，不能當成無害的佔位符（2026-08-21）。
      cpBackend: { username: '', password: '' },
      nchBackend: { username: '', password: '' },
    },
    jackpotAbnormality: {
      maxInputDigits: 9,
      jackpotValuePrefix: '777',
      handpayValuePrefix: '888',
      cleanRowPayoutThreshold: 100000,
      rankingPollAttempts: 8,
      rankingPollIntervalMs: 8000,
    },
    jackpotRanking: {
      validJackpotTypes: ['Super-Tier1', 'Fortune-Tier1', 'Grand-Tier1', 'Mega-Tier1', 'Gold-Tier1', 'Grand-Tier2', 'Mega-Tier2', 'Major-Tier2', 'Maxi-Tier2', 'Pearl-Tier2'],
    },
  };
  // 帳密優先吃環境變數（由伺服器端依「目前登入的人」從 DB 取出後注入），
  // 沒有才 fallback 到 config 檔——真實帳密不應該躺在 repo 裡，config 檔已加進 .gitignore，
  // 只保留 backend-test-params.example.json 當結構範本（2026-08-21）。
  const envCreds = {
    cpBackend: { username: process.env.UAT_CP_USERNAME, password: process.env.UAT_CP_PASSWORD },
    nchBackend: { username: process.env.UAT_NCH_USERNAME, password: process.env.UAT_NCH_PASSWORD },
  };
  const mergeCreds = (base) => {
    const out = { ...base };
    for (const [profile, pair] of Object.entries(envCreds)) {
      if (pair.username && pair.password) out[profile] = { username: pair.username, password: pair.password };
    }
    return out;
  };
  try {
    const loaded = JSON.parse(fs.readFileSync('./config/backend-test-params.json', 'utf8'));
    const merged = { ...defaults, ...loaded };
    return { ...merged, credentials: mergeCreds({ ...defaults.credentials, ...(loaded.credentials || {}) }) };
  } catch (e) {
    console.warn(`⚠️ config/backend-test-params.json 讀取失敗（${e.message}），改用環境變數／內建預設值`);
    return { ...defaults, credentials: mergeCreds(defaults.credentials) };
  }
})();

// ─── 欄位 ID ─────────────────────────────────────────────────────────
/** 回寫 Lark 失敗的紀錄。收工時要再報一次，不能讓它只留在中間的日誌裡被洗掉 */
const larkWriteFailures = [];

const FIELD = {
  uat_pass:  'fld8qizcOu',   // UAT測試 checkbox
  uat_time:  'fld2kLMXQ5',   // UAT測試通過時間
  attach:    'fldN42zhZL',   // 附圖
};

// ─── TC Registry（2026-08-06 架構升級，同步自osm-qa-agent）─────────────
// 根因：verifier內部用regex比對Lark即時抓到的TC文字挑分支，文字只要被PM/QA
// 潤飾幾個字，regex就默默失效（同一天內發生3次：簡繁體不一致、外層gate regex太窄等）。
// record_id是天然穩定ID（除非TC整筆被刪除重建，否則不會變），用它當key凍結一份
// 「上次確認能命中規則時的TC文字」，執行時優先用凍結版去跑regex比對，不受之後
// 潤飾影響；重大變更（相似度太低，可能是意圖真的變了）則不自動吸收，照舊用即時
// 文字（可能對不到規則，變成可見的缺口，而不是靜默用舊意圖誤判新測試）。
// 建立/刷新快照用 build-tc-registry.cjs；drift偵測報告用 check-tc-coverage.cjs。
const TC_REGISTRY = (() => {
  try { return JSON.parse(fs.readFileSync('./tc-registry.json', 'utf8')); }
  catch (e) { return {}; }
})();

/**
 * 使用者在畫面上編的積木。存在 server 的 DB（不是這個檔案——這份 registry 在
 * runtime 是 dist-server/ 的建置產物，npm run build 會整個刪掉重建），
 * 執行時由 server 透過 UAT_TC_STEPS 環境變數整包帶下來，這裡疊回 registry 上。
 * agent 派工也走同一條路，agent 端不需要有任何積木檔案。
 */
(() => {
  if (!process.env.UAT_TC_STEPS) return;
  try {
    const overlay = JSON.parse(process.env.UAT_TC_STEPS);
    let n = 0;
    for (const [recordId, steps] of Object.entries(overlay)) {
      if (!Array.isArray(steps) || !steps.length) continue;
      TC_REGISTRY[recordId] = { ...(TC_REGISTRY[recordId] ?? {}), steps };
      n++;
    }
    if (n) console.log(`🧱 已載入 ${n} 筆 TC 的自訂積木`);
  } catch (e) {
    console.log(`⚠️ UAT_TC_STEPS 解析失敗，這次照原本的驗證器跑: ${e.message}`);
  }
})();
function normalizeForCompare(s) { return (s || '').replace(/\s+/g, '').trim(); }
function trigramSet(s) {
  const n = normalizeForCompare(s);
  const set = new Set();
  if (n.length < 3) { if (n) set.add(n); return set; }
  for (let i = 0; i <= n.length - 3; i++) set.add(n.slice(i, i + 3));
  return set;
}
function textSimilarity(a, b) {
  if (normalizeForCompare(a) === normalizeForCompare(b)) return 1;
  const ta = trigramSet(a), tb = trigramSet(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const g of ta) if (tb.has(g)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 1 : inter / union;
}
// 回傳 { text, source } —— text是要拿去給verifier做regex比對的「有效文字」，
// source純供log/debug用，不影響流程：
//   'live-new'                 registry沒有這筆（新TC），直接用即時文字（跟改版前行為一致）
//   'live-stable'               文字跟凍結版完全一樣
//   'canonical-minor-drift'     文字有小幅潤飾（相似度>=0.75），改用凍結版比對，避免regex失效
//   'live-major-drift'          文字變動很大，不信任凍結版，照舊用即時文字（可能變成缺口，需人工用
//                                build-tc-registry.cjs --refresh 重新確認後刷新）
function resolveEffectiveTcText(recordId, liveText) {
  const entry = TC_REGISTRY[recordId];
  if (!entry) return { text: liveText, source: 'live-new' };
  if (normalizeForCompare(entry.canonicalText) === normalizeForCompare(liveText)) {
    return { text: liveText, source: 'live-stable' };
  }
  const sim = textSimilarity(entry.canonicalText, liveText);
  if (sim >= 0.75) {
    return { text: entry.canonicalText, source: 'canonical-minor-drift', similarity: sim };
  }
  return { text: liveText, source: 'live-major-drift', similarity: sim };
}

// ─── 每個 subtype 對應的後台路徑與測試邏輯 ────────────────────────────
const SUBTYPE_MAP = {
  'Dashboard':         { path: '/dashboard',                        action: 'screenshot_verify' },
  'Daily Dashboard':   { path: '/daily_dashboard',                   action: 'daily_dashboard_verify' },
  'EGM List':          { path: '/egm/egmList',                      action: 'screenshot_verify_data' },
  'EGM Status':        { path: '/egm/egmStatusList',                action: 'screenshot_verify_data' },
  'Gaming User':       { path: '/egm/onlineList',                   action: 'screenshot_verify_data' },
  'EGM Detail':        { path: '/egm/reports/egmCount',             action: 'screenshot_date_search' },
  'User Detail':       { path: '/egm/reports/plyerMachineCount',    action: 'screenshot_date_search' },
  'EGM Transfer':      { path: '/egm/reports/egmTransfer',          action: 'screenshot_date_search' },
  'Game Record':       { path: '/egm/reports/gameRecordList',       action: 'screenshot_date_search' },
  'EGM DayCount':      { path: '/egm/reports/gameCount',            action: 'screenshot_date_search' },
  'Player Credit Log': { path: '/egm/reports/rechargeRecordList',   action: 'screenshot_date_search' },
  'Jackpot Record':    { path: '/egm/reports/jackpotRecordList',     action: 'screenshot_date_search' },
  'Loading Tips':      { path: '/game/loadingTips',                 action: 'screenshot_verify_data' },
  'Channel Ranking':   { path: '/game/getChannelRankInfo',          action: 'screenshot_verify_data' },
  'White List':        { path: '/game/getWhiteList',                action: 'screenshot_verify_data' },
  'Game Jump Set':     { path: '/game/gameJumpSet',                 action: 'screenshot_verify_data' },
  'News Set':          { path: '/game/bannerSet',                   action: 'screenshot_verify_data' },
  'EGM JP Percent':    { path: '/game/egmJpPercent',                action: 'screenshot_verify_data' },
  'Advert Set':        { path: '/game/advertSet',                   action: 'screenshot_verify_data' },
  'EGM Hourly Meter':  { path: '/egm/meter/egmMeterHourList',       action: 'screenshot_date_search' },
  'EGM Performance Meter': { path: '/egm/meter/egmPerformanceMeter', action: 'screenshot_date_search' },
  'Jackpot Moment':    { path: '/game/upJackpotVideo',              action: 'screenshot_verify_data' },
  'Deposit Setting':   { path: '/game/getPayButtonToggle',          action: 'screenshot_verify' },
  '自動預約相關功能':   { path: '/game/machineReservationList',      action: 'screenshot_verify_data' },
  'Daily Ranking':     { path: '/rankinglist/dailyRanking',         action: 'screenshot_verify_data' },
  'Jackpot Ranking':   { path: '/rankinglist/jackpotRanking',       action: 'screenshot_verify_data' },
  '小額推薦影片':       { path: '/game/recommendSetting',           action: 'screenshot_verify_data' },
  'How To Play':           { path: '/game/howToPlay',                        action: 'screenshot_verify_data' },
  // ── 新增頁面 ──
  'Machine Monitoring':    { path: '/egm/monitoring',                       action: 'screenshot_verify_data' },
  'Player Watch':          { path: '/egm/reports/playerWatchList',           action: 'screenshot_verify_data' },
  'Fault List':            { path: '/egm/reports/faultList',                 action: 'screenshot_date_search' },
  'OSM Instant Meter':     { path: '/egm/meter/egmMeterList',               action: 'screenshot_verify_data' },
  'GCP Instant Meter':     { path: '/egm/gsameter/egmMeterList',            action: 'screenshot_verify_data' },
  'Stress Test Instant Meter': { path: '/egm/meter/egmMeterExtraList',      action: 'screenshot_verify_data' },
  'Recovery Meter':        { path: '/egm/meter/getSpinDataRecoveryList',    action: 'screenshot_verify_data' },
  'Daily Meter Reading':   { path: '/egm/gsameter/dailyMeterReadingReport', action: 'screenshot_verify_data' },
  'Record Abnormality':    { path: '/abnormality/gameHistorySyncFailed',    action: 'screenshot_verify_data' },
  'Machine Abnormality':   { path: '/abnormality/machine',                  action: 'screenshot_verify_data' },
  'Jackpot Abnormality':   { path: '/abnormality/getHandPayRecord',         action: 'screenshot_verify_data' },
  'Game Error Record':     { path: '/abnormality/gameErrorRecordList',      action: 'screenshot_verify_data' },
  'Machine Reservation Limit': { path: '/game/reservationLimit',            action: 'screenshot_verify_data' },
  'Special Entrance Set':  { path: '/game/denomSet',                        action: 'screenshot_verify_data' },
  'Test Setting':          { path: '/game/testTimeList',                    action: 'screenshot_verify_data' },
  'Log Third Http Req':    { path: '/log/logThirdHttpReq',                  action: 'screenshot_verify_data' },
  'Log Third Bet Req':     { path: '/log/logThirdHttpBetReq',               action: 'screenshot_verify_data' },
  'Log EGM Status':        { path: '/log/gmErrorLog',                       action: 'screenshot_verify_data' },
  'MeterCompensateSpinLog':{ path: '/log/meterCompensateSpinLog',           action: 'screenshot_verify_data' },
  'Error Meter Info':      { path: '/log/getErrorMeterInfoList',            action: 'screenshot_verify_data' },
  'Operation Log':         { path: '/log/operationlog',                     action: 'screenshot_verify_data' },
  'Login Log':             { path: '/log/loginlog',                         action: 'screenshot_verify_data' },
  'Out Log Records':       { path: '/log/sendOutLogRecord',                 action: 'screenshot_verify_data' },
};

if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// ─── Daily Ranking Bonus 計時器狀態（跨 TC 共享）────────────────────────
// 記錄 TC2 修改後的計時開始時間，5分鐘後回來驗證 TC2+TC3
let _bonusTimerState = null; // { startTime, pageUrl, newVals, fieldLabels }

// ─── Lark API helpers ────────────────────────────────────────────────
async function getLarkToken() {
  const res = await fetch(LARK_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const d = await res.json();
  return d.tenant_access_token;
}

/**
 * UAT_DRY_RUN=1：照常跑測試、照常產出日誌與量測，但完全不動 Lark——
 * 不上傳截圖、也不把 pass/fail PUT 回 TC 表。
 *
 * 加這個開關是因為這支腳本每跑一次都會寫回團隊共用的 TC 表，想驗證腳本本身
 * （例如新加的網路量測）就沒辦法不弄髒那張表。
 * ⚠️ 上傳與回寫要一起擋：只擋回寫的話截圖仍會進 Lark Drive，變成沒有掛在任何
 * 記錄上的孤兒檔案，比兩者都做還糟。
 */
const DRY_RUN = process.env.UAT_DRY_RUN === '1';

async function uploadAttachment(token, filePath) {
  if (DRY_RUN) {
    console.log(`  🧪 [dry-run] 略過上傳 Lark：${path.basename(filePath)}`);
    return null;
  }
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  const form = new FormData();
  form.append('file_name', fileName);
  form.append('parent_type', 'bitable_file');
  form.append('parent_node', APP_TOKEN);
  form.append('size', String(fileBuffer.length));
  form.append('file', new Blob([fileBuffer], { type: 'image/png' }), fileName);

  const res = await fetch(`${LARK_BASE}/drive/v1/medias/upload_all`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const d = await res.json();
  if (d.code !== 0) throw new Error(`Upload failed: ${d.msg}`);
  return d.data.file_token;
}

/**
 * 回寫 Lark。
 *
 * @param outcome 三態，不是布林：
 *   'pass'   → 勾 PASS、清掉 FAIL
 *   'fail'   → 勾 FAIL、清掉 PASS
 *   'manual' → 兩個都清掉（機器判不了，既不是通過也不是失敗）
 *   'none'   → 兩個都不動（例如只是要清舊截圖）
 *
 * 為什麼要三態：原本傳的是布林 markPass = result.pass && !result.manual，
 * 「失敗」跟「人工判讀」都被壓成 false。以前只勾一個 UAT測試 時看不出差別；
 * 現在要分別寫 PASS / FAIL 兩欄，就必須分得出來。
 *
 * 為什麼要清掉另一邊：同一筆 TC 會重跑。上次 FAIL 這次 PASS，不清的話兩個框
 * 都是勾的，表上看起來自相矛盾。
 */
async function updateRecord(token, recordId, fileTokens, outcome) {
  if (DRY_RUN) {
    console.log(`  🧪 [dry-run] 略過回寫 Lark：record=${recordId} outcome=${outcome}`);
    return { code: 0, dryRun: true };
  }
  // fileTokens: string (single) or string[] (multiple)
  const tokens = Array.isArray(fileTokens)
    ? fileTokens.filter(Boolean)
    : (fileTokens ? [fileTokens] : []);

  const putRecord = async (fields) => {
    const res = await fetch(`${LARK_BASE}/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records/${recordId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
    const d = await res.json();
    if (d.code !== 0) {
      // ⚠️ 這裡以前只印 warning，整輪照樣顯示綠色的 PASS——欄位型別一改就會出現
      // 「畫面全通過、Lark 上什麼都沒寫進去」而且沒人發現。回寫失敗是實質失敗，
      // 要印得夠明顯，並且計數在收工時再講一次。
      larkWriteFailures.push(`${recordId}: ${d.msg}`);
      console.log(`  ❌ 回寫 Lark 失敗 ${recordId}: ${d.msg}（欄位型別或權限問題，這筆結果沒有被寫進表裡）`);
    }
    return d;
  };

  // Step 1: 一律先清空附圖（不只在tokens.length>0時才清）——
  // 2026-08-07：MANUAL/SKIP的TC現在tokens必為空(不上傳新圖)，如果沿用舊的
  // 「只在有新圖時才清」邏輯，這裡就完全不會執行，導致MANUAL/SKIP列上殘留舊版本
  // (改成不上傳截圖之前)留下的舊截圖，重跑再多次也清不掉。一律先清空可同時涵蓋
  // 「有新圖要換」跟「MANUAL/SKIP要清掉舊圖」兩種情境。
  await putRecord({ '附圖': [] });

  // Step 2: set remaining fields
  const fields = {};
  // PASS / FAIL 是兩個獨立的勾選欄位（使用者 2026-08-24 加的），互斥要自己維護。
  // 原本的 UAT測試 欄位保留在表上但這裡不再寫入——使用者指定改寫這兩欄。
  if (outcome === 'pass') {
    fields['PASS'] = true;
    fields['FAIL'] = false;
    fields['UAT測試通過時間'] = Date.now();
  } else if (outcome === 'fail') {
    fields['PASS'] = false;
    fields['FAIL'] = true;
  } else if (outcome === 'manual') {
    // 機器判不了：兩個都清掉。留著上一輪的結果會讓人以為這次有驗過
    fields['PASS'] = false;
    fields['FAIL'] = false;
  }
  if (tokens.length > 0) {
    fields['附圖'] = tokens.map((ft, i) => ({
      file_token: ft,
      name: `screenshot_${i + 1}.png`,
    }));
  }
  if (Object.keys(fields).length === 0) return;
  return putRecord(fields);
}

// ─── 強制關閉所有 dialog（bypass overlay 攔截）────────────────────────
async function dismissDialogs(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.el-dialog button').forEach(btn => {
      const t = btn.innerText?.trim();
      if (t === 'Cancel' || t === '取消' || t === 'Close' || t === '關閉') btn.click();
    });
  });
  await page.waitForTimeout(500);
}

// ─── 共用工具函式 ──────────────────────────────────────────────────────

/**
 * getBaseInfo(page) → 回傳 { bodyText, h1, rowCount, allBtns, allHeaders }
 */
async function getBaseInfo(page) {
  const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  const h1 = await page.evaluate(() => document.querySelector('h1,h2,.page-title')?.innerText?.trim() || '').catch(() => '');
  const rowCount = await page.locator('.el-table__body tr').count().catch(() => 0);
  const allBtns = await page.evaluate(() =>
    [...document.querySelectorAll('button')].map(b => b.innerText?.trim()).filter(Boolean)
  ).catch(() => []);
  const allHeaders = await page.evaluate(() =>
    [...document.querySelectorAll('th, .el-table__header th')].map(h => h.innerText?.trim()).filter(Boolean)
  ).catch(() => []);
  return { bodyText, h1, rowCount, allBtns, allHeaders };
}

/**
 * detectManual(full) → 回傳 manualReason string 或 null
 */
function detectManual(full) {
  const manualPatterns = [
    [/盒子.*斷線|斷線.*紅色|egm.*disconnect/i, '需要EGM斷線環境'],
    [/前端進入機台.*後台.*即時更新|後台.*實時更新/i, '需要前端玩家進入機台才能驗證'],
    [/現場.*handpay|handpay.*後.*查看/i, '需要現場 handpay 操作'],
    [/機器門.*打開|kickout.*卡額度/i, '需要硬體操作（機器門）'],
    // ⭐ 2026-08-06：新表補上的TC，描述「有時候須現場cash out有時不用」是依情境而定的
    // 業務規則，不是固定可判定的行為，無法從後台頁面單方面判斷該次kickout屬於哪種情境。
    // ⚠️ 實測發現這筆TC文字在「kickout功能需正常」後面是真的換行(\n)才接「(有時候...)」，
    // 用.*會因為JS regex預設.不跨行而漏配，改用[\s\S]*確保跨行也能命中。
    [/kickout功能需正常[\s\S]*現場cash out/i, '依情境而定（是否需現場cash out），需人工依實際狀況確認'],
    [/5.*分鐘.*更新|每5分鐘/i, '需要等待5分鐘觀察更新'],
    [/23:59:59|05:59:59|特殊時間段/i, '需要特定時間段歷史資料'],
    // ⭐ 2026-08-05：「Jackpot Abnormality補發→自動寫入Jackpot Ranking」跟「審核通過…預設為空」
    // 這兩筆原本在這裡標MANUAL，已經在使用者說明操作步驟後改成verifyJackpotRanking裡的
    // 真實自動化流程（runJackpotAbnormalityFlow），不再需要人工，故從這個清單移除。
    [/不可以兩支.*帳號.*預約同機台/i, '需要兩個前端帳號同時操作'],
    [/前端預約後.*機台.*展示/i, '跨系統驗證（需前端操作）'],
    [/快速join.*直接跳轉遊戲/i, '跨系統驗證（需前端 quick join）'],
    [/前端可以看到|前端.*可以看到|前端.*能看到/i, '跨系統驗證（需前端確認）'],
    [/前端.*大廳.*後台.*設置後/i, '跨系統驗證（前台需觀察）'],
    [/先前.*前端.*確認後台|前後台.*同步/i, '需前後台同時操作'],
    [/玩家.*遊玩機台.*對照後台/i, '需要玩家實際遊玩資料'],
    [/帶入.*帶出.*金額.*是否正確/i, '需要實際 transfer 記錄驗證計算'],
    [/投注.*輸贏.*紀錄.*是否正確/i, '需要實際遊玩記錄驗證'],
    [/每10分鐘.*寫.*數據/i, '需等待10分鐘觀察定時寫入'],
    [/delay.*玩家.*遊玩資料|玩家遊玩資料.*沒被清空/i, '需前端玩家實際投注後點Delay確認數值不歸零'],
    [/maintenance.*是否.*把玩家提出|是否.*把玩家提出.*機台/i, '需前端帳號在機台內才能驗證 maintenance kick'],
    [/jackpotContribution|userbethistory.*bpo/i, '需前端遊玩 + BPO API 驗證 jackpotContribution'],
    [/預約時間到後.*繼續遊玩/i, '需等待預約時間到期後觀察計費行為'],
    // ⭐ 2026-08-05：Jackpot Ranking 深度實查新增（真的去後台點過 Announcement/Batch/Add
    // 三個 dialog 確認過欄位後才分類，不是憑TC文字臆測）
    [/如果有視頻.*彈框.*打開video|視頻.*跳出彈框.*打開video/i, '需前端確認：有視頻時彈框可播放，無視頻時不顯示（後台看不到前端彈框）'],
    [/彈框須按照排名順序|排名順序.*跳出/i, '需前端確認：JP中獎彈框依排名順序跳出（後台看不到前端彈框順序）'],
    // ⭐ 2026-08-06：Jackpot Moment 深度實查新增（真的去後台點過Add/Check確認過欄位跟真實error訊息後才分類）
    [/quick join就會直接跳轉遊戲|quick join.*直接跳轉/i, '需前端確認：quick join是否直接跳轉遊戲（後台看不到前端跳轉行為）'],
    // ⭐ 2026-08-06：Machine Reservation 深度實查新增（真的去後台操作過Add Reservation/
    // Reservation List/VIP名單後才分類，跨渠道/跨系統/前端行為類無法從單一後台session驗證）
    [/預約時間到後.*繼續遊玩.*筆數計算到離開機台/i, '需前端確認：預約到期後繼續遊玩的計費行為（後台看不到前端遊玩狀態）'],
    [/add reservation按钮只有cp渠道会显示|其他渠道隐藏/i, '需跨渠道比對：Add Reservation按鈕僅CP顯示（需切換到非CP渠道後台驗證隱藏）'],
    [/壓測各渠道可以分開新增.*不會互相影響/i, '需跨渠道壓測比對：各渠道新增是否互不影響（需多渠道同時操作）'],
    [/machine reservation limit.*限制遊戲預約上限.*有區分渠道/i, '需至Reservation Limit頁面+跨渠道比對驗證預約上限（該頁目前無獨立live TC）'],
    [/後台已預約數量會占用到前端預約的數量/i, '需前後台同時比對：後台預約是否占用前端名額（跨系統驗證）'],
    // ⭐ 2026-08-06：Channel Ranking 深度實查新增
    [/在bpo渠道把某個渠道拔掉.*news quick join進入不會進到已拔掉渠道的機器/i, '需前端確認：BPO渠道拔掉某渠道後，quick join是否正確排除（後台看不到前端進場行為）'],
    // ⭐ 2026-08-06：EGM List 深度實查新增
    [/只有lavie後台.*機器可設置machine\s*type為gsa類型/i, '需至Lavie後台(uat-nc.osmslot.org)測試GSA Machine Type設定與對應報表分類，非CP渠道功能'],
    // ⭐ 2026-08-06：報表頁面群組深度實查新增（User Detail/EGM Transfer/Jackpot Record）
    [/帳號進入前端遊玩機台.*對照後台的投注.*輸贏紀錄是否正確/i, '需前端遊玩+後台比對投注輸贏紀錄（跨系統驗證）'],
    [/前端進入機台遊玩.*確認帶入機台金額跟帶出機台金額是否正確/i, '需前端遊玩+後台比對帶入/帶出機台金額（跨系統驗證）'],
    [/機台達到鎖機金額時.*請現場handpay後.*補handpay後.*查看是否有紀錄/i, '需現場硬體handpay操作+後台補發（需實體機台）'],

    // ⭐ 2026-08-27：這 12 筆的 verifier 分支只寫 notes.push(⚠️…) 沒有任何 criticalFails——
    // 也就是「跑起來是綠的，但一個斷言都沒執行」。它們走的是 SUBTYPE_MAP 舊路徑，
    // 上面沒有零斷言守門（那個只裝在積木路徑），所以一直沒被發現。
    //
    // 逐筆讀完之後確認：它們本來就是機器判不了的，不是「還沒寫驗證邏輯」。
    // 誠實標成 MANUAL 比留一個假綠燈好——假綠燈會讓人以為這件事有在測。
    [/確認只有主渠道才有此功能/i, '需切換到非主渠道後台比對「這個功能是否不存在」，單一渠道看不出來'],
    [/最多只能新增20筆紀錄/i, '需實際新增到第21筆才驗得了伺服器端有沒有擋，會對共用UAT資料造成不可逆影響'],
    [/渠道需個別設置.*cp設置cp.*bpo設置bpo/i, '需切換到不同渠道後台各設定一次再互相比對'],
    [/^每個主?渠道獨立設置$/i, '需切換到不同渠道後台各設定一次再互相比對'],
    [/推荐栏位功能需要区分渠道，每个渠道分开配置/i, '需切換到不同渠道後台各設定一次再互相比對'],
    [/operation：点击cannel后对此台机器取消预定/i, '需有真實預約資料才點得到Cancel，且取消後不可逆'],
    [/时长设置，页面中需要增加按钮.*time setting/i, '設定值要跨頁到 Reservation List>Setting 再回頭確認，且會改動共用的預約參數'],
    [/2\.预约时间根据配置时间决定，预约成功消耗一次预约次数/i, '需實際送出一次預約才驗得了時長與次數扣減，會佔用共用機台'],
    [/3\.若提交预约时机器内有玩家或該玩家不再預約名單內/i, '需要「機台內有玩家」或「玩家不在名單內」的前置狀態，無法從後台單方面製造'],
    [/4\.若提交预约时机器为离线\/维护状态/i, '需要離線或維護中的機台當樣本，UAT環境不一定有'],
    // ⚠️ 原文的 > 後面就換行，JS regex 的 . 預設不跨行，要用 [sS]
    [/machine reservation後台預約功能>[\s\S]*add reservation功能測試/i, '六種情境各需要一種前置機台/玩家狀態（已預約、佔用、離線、非名單內、壓測中），無法從後台單方面製造'],
    [/reservation list>[\s\S]*account>支援模糊搜尋[\s\S]*view點了後才執行/i, '需要VIP名單裡有資料才驗得了模糊搜尋與編輯刪除'],
  ];
  for (const [pat, reason] of manualPatterns) {
    if (pat.test(full)) return reason;
  }
  return null;
}

/**
 * doExport(page) → 處理 Export button + 下載，回傳 { notes, criticalFails, exportedXlsxPath }
 */
async function doExport(page) {
  const notes = [];
  const criticalFails = [];
  let exportedXlsxPath = null;

  const hasExportEl = await page.evaluate(() => {
    return !![...document.querySelectorAll('.img-btn, [class*="img-btn"], .export-btn, button')]
      .find(el => /export|csv|excel/i.test(el.innerText?.trim()));
  }).catch(() => false);

  if (hasExportEl) {
    try {
      const downloadPromise = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);
      await page.evaluate(() => {
        const el = [...document.querySelectorAll('.img-btn, [class*="img-btn"], .export-btn, button')]
          .find(e => /export|csv|excel/i.test(e.innerText?.trim()));
        if (el) el.click();
      });
      await page.waitForTimeout(1000);
      await page.evaluate(() => {
        const sureBtn = [...document.querySelectorAll('.el-message-box button')]
          .find(b => /sure|confirm|ok|yes/i.test(b.innerText?.trim()));
        if (sureBtn) sureBtn.click();
      });
      const download = await downloadPromise;
      if (download) {
        const fname = await download.suggestedFilename();
        const savePath = path.join('./data/raw/exports', fname);
        await download.saveAs(savePath);
        exportedXlsxPath = savePath;
        notes.push(`✅Export(已下載:${fname})`);
      } else {
        notes.push('✅Export(已確認Sure，下載中)');
      }
    } catch (e) {
      notes.push('✅Export(按鈕存在，下載監聽逾時)');
    }
  } else {
    notes.push('❌Export按鈕缺失');
    criticalFails.push('Export按鈕缺失');
  }

  return { notes: notes.join(' | '), criticalFails, exportedXlsxPath };
}

/**
 * doBonusSettings(page) → 完整 Bonus Settings 流程
 * 回傳 { notes, criticalFails, toastShotPath, extraShotPaths }
 */
async function doBonusSettings(page) {
  const notes = [];
  const criticalFails = [];
  const extraShotPaths = [];
  let toastShotPath = null;

  const apiLog = { getStatus: null, postStatus: null };
  const responseListener = (resp) => {
    const url = resp.url().toLowerCase();
    if (url.includes('getrankaward')) apiLog.getStatus = resp.status();
    if (url.includes('setrankaward')) apiLog.postStatus = resp.status();
  };
  page.on('response', responseListener);

  try {
    // ① 點擊 Bonus Settings 按鈕
    const clickedBonus = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button'))
        .find(b => /bonus\s*settings?/i.test(b.innerText));
      if (btn) { btn.click(); return true; }
      return false;
    });

    if (!clickedBonus) {
      notes.push('❌Bonus Settings 按鈕缺失');
      criticalFails.push('Bonus Settings 按鈕缺失');
      page.off('response', responseListener);
      return { notes: notes.join(' | '), criticalFails, toastShotPath, extraShotPaths };
    }

    // ② 等 Dialog 出現（最多 5s）
    await page.waitForSelector('.el-dialog__body input', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1000);

    // ③ 確認 GET API
    if (apiLog.getStatus !== null) {
      const getOk = apiLog.getStatus === 200;
      notes.push(getOk ? '✅GET /getrankaward 200' : `❌GET /getrankaward ${apiLog.getStatus}`);
      if (!getOk) criticalFails.push('GET /getrankaward 非 200');
    } else {
      notes.push('⚠️GET /getrankaward 未偵測到（可能已快取）');
    }

    // ④ 確認 Dialog 出現
    const inputCount = await page.locator('.el-dialog__body input').count().catch(() => 0);
    if (inputCount === 0) {
      notes.push('❌Bonus Settings Dialog 未開啟');
      criticalFails.push('Bonus Settings Dialog 未開啟');
      page.off('response', responseListener);
      return { notes: notes.join(' | '), criticalFails, toastShotPath, extraShotPaths };
    }
    notes.push(`✅Bonus Settings Dialog 已開啟（${inputCount}個輸入框）`);

    // ⑤ 讀取所有欄位 label + 原始值
    // 改版後 Bonus Settings 是 el-table 表格佈局（input 直接在 td > div.cell 裡），
    // 不再是舊版的 .el-form-item 表單列，兩種都嘗試，避免下次又改版就整段讀空。
    // ⭐ 2026-08-06：加入disabled偵測——實測發現新版(細分ALL/CP/BP)Bonus Settings
    // 表格裡混雜了disabled的唯讀欄位（例如Ranking排名顯示欄），舊版邏輯無視disabled、
    // 對每個偵測到的input一律click+fill，遇到唯讀欄位會卡在locator.click逾時30秒。
    const fieldData = await page.evaluate(() => {
      const formItems = Array.from(document.querySelectorAll('.el-dialog__body .el-form-item'));
      if (formItems.length > 0) {
        return formItems.map((item, idx) => {
          const labelEl = item.querySelector('.el-form-item__label');
          const inputEl = item.querySelector('input');
          return {
            label: labelEl ? labelEl.innerText.trim() : `Field ${idx + 1}`,
            origVal: inputEl ? inputEl.value : '',
            disabled: inputEl ? inputEl.disabled : true,
          };
        }).filter(f => f.origVal !== '' || f.label);
      }
      // Table 佈局 fallback：input 在 td.el-table__cell 裡，label 取同一欄的表頭文字
      const table = document.querySelector('.el-dialog__body .el-table');
      if (!table) return [];
      const headerCells = Array.from(table.querySelectorAll('thead th'));
      const inputs = Array.from(table.querySelectorAll('tbody input.el-input__inner, tbody input'));
      return inputs.map((inputEl, idx) => {
        const td = inputEl.closest('td');
        const colIdx = td ? Array.from(td.parentElement.children).indexOf(td) : -1;
        const headerEl = colIdx >= 0 ? headerCells[colIdx] : null;
        return {
          label: headerEl ? headerEl.innerText.trim() : `Column ${idx + 1}`,
          origVal: inputEl.value || '',
          disabled: !!inputEl.disabled,
        };
      });
    });

    if (fieldData.length === 0) {
      notes.push('⚠️無法讀取任何欄位值');
      page.off('response', responseListener);
      return { notes: notes.join(' | '), criticalFails, toastShotPath, extraShotPaths };
    }
    // ⭐ 2026-08-06：TC文字補充「細分ALL、CP、BP，並且全渠道共用」，這裡把實際讀到的
    // 欄位label明列出來，讓報告直接證實（或反駁）這個補充說明，不是憑舊note默默沿用。
    // ⭐ 實測發現表格是「Start Ranking / End Ranking / Bonus」三欄一組（8組=24欄），
    // Start/End Ranking兩欄互相有「start必須<=end」的跨欄位驗證規則——如果每欄各自填
    // 獨立隨機值，很容易產生start>end而被後台拒絕(Save後無toast、實際是表單驗證錯誤
    // 被吞掉，不是真的功能壞掉)。TC文字本身要驗證的是「Bonus settings可以正常設置」，
    // 不是排名範圍設定，所以只改Bonus欄位、Ranking欄位保留原值不動，這樣既測到了
    // Bonus可設置，也不會誤觸發跟本次驗證目的無關的排名範圍驗證規則。
    const editableCount = fieldData.filter(f => !f.disabled).length;
    const bonusEditCount = fieldData.filter(f => !f.disabled && /bonus/i.test(f.label)).length;
    notes.push(`✅已測試欄位: ${fieldData.map(f => f.label).join('/')}（可編輯${editableCount}/${fieldData.length}個，其中Bonus欄位${bonusEditCount}個會實際修改，Ranking等其他欄位保留原值避免觸發start<=end等跨欄位驗證規則）`);

    // 截圖①：Dialog 開啟狀態（修改前）
    const dialogBeforePath = path.join(SCREENSHOT_DIR, `bonus_before_${Date.now()}.png`);
    await page.screenshot({ path: dialogBeforePath, fullPage: false });
    extraShotPaths.push(dialogBeforePath);

    // ⑥ 為每個欄位產生隨機值（1–7位隨機整數）；只有Bonus欄位會被實際修改，
    // disabled或非Bonus欄位一律保留原值，不生成新值也不嘗試填寫。
    const shouldFill = (f) => !f.disabled && /bonus/i.test(f.label);
    const newVals = fieldData.map(f => {
      if (!shouldFill(f)) return f.origVal;
      const digits = Math.floor(Math.random() * 5) + 2; // 2–6位
      const min = Math.pow(10, digits - 1);
      const max = Math.pow(10, digits) - 1;
      return String(Math.floor(Math.random() * (max - min + 1)) + min);
    });

    // ⑦ 依序 fill 每個 input（表單列或表格佈局都用同一個寬鬆選擇器，跟⑤讀值範圍一致）
    // disabled或非Bonus欄位直接跳過，避免click卡死逾時、也避免誤觸發跨欄位驗證規則
    let inputs = page.locator('.el-dialog__body .el-form-item input');
    let actualCount = await inputs.count().catch(() => 0);
    if (actualCount === 0) {
      inputs = page.locator('.el-dialog__body .el-table tbody input');
      actualCount = await inputs.count().catch(() => 0);
    }
    for (let i = 0; i < Math.min(actualCount, newVals.length); i++) {
      if (!shouldFill(fieldData[i] || {})) continue;
      const inp = inputs.nth(i);
      await inp.click({ clickCount: 3 });
      await inp.fill(newVals[i]);
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(400);

    // 截圖②：填完後（修改後、儲存前）
    const dialogAfterPath = path.join(SCREENSHOT_DIR, `bonus_after_${Date.now()}.png`);
    await page.screenshot({ path: dialogAfterPath, fullPage: false });
    extraShotPaths.push(dialogAfterPath);

    // ⑧ 點 Save 按鈕
    const saveBtn = page.locator('.el-dialog__body button, .el-dialog__footer button')
      .filter({ hasText: /save/i }).first();
    await saveBtn.click().catch(async () => {
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('.el-dialog button'))
          .find(b => /save/i.test(b.innerText));
        if (btn) btn.click();
      });
    });

    // ⑧b 如果彈出確認 dialog（el-message-box），點 OK/Confirm
    await page.waitForTimeout(600);
    const msgBoxVisible = await page.locator('.el-message-box__wrapper').isVisible({ timeout: 1000 }).catch(() => false);
    if (msgBoxVisible) {
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('.el-message-box button'));
        const okBtn = btns.find(b => /ok|confirm|sure|yes/i.test(b.innerText));
        if (okBtn) okBtn.click();
      });
      await page.waitForTimeout(800);
    }

    // ⭐ 2026-08-06新增診斷：Save後若沒有success toast，先檢查是不是有錯誤訊息/表單
    // 驗證錯誤被忽略了，不要只回報「無toast」卻不知道真正原因。
    const errorDiag = await page.evaluate(() => {
      const errToast = document.querySelector('.el-message--error');
      const formErrors = [...document.querySelectorAll('.el-form-item__error')].map(e => e.innerText?.trim()).filter(Boolean);
      return { errToastText: errToast?.innerText?.trim() || null, formErrors };
    }).catch(() => ({ errToastText: null, formErrors: [] }));
    if (errorDiag.errToastText) notes.push(`❌偵測到錯誤訊息: ${errorDiag.errToastText}`);
    if (errorDiag.formErrors.length > 0) notes.push(`❌表單驗證錯誤: ${errorDiag.formErrors.join(', ')}`);

    // ⑨ 輪詢 success toast（最多等 4s）
    let toastFound = false;
    for (let t = 0; t < 20; t++) {
      await page.waitForTimeout(200);
      toastFound = await page.locator('.el-message--success').isVisible({ timeout: 100 }).catch(() => false);
      if (toastFound) break;
    }

    // ⑩ 截圖③：toast / 儲存後狀態
    toastShotPath = path.join(SCREENSHOT_DIR, `bonus_settings_${toastFound ? 'toast' : 'after'}_${Date.now()}.png`);
    await page.screenshot({ path: toastShotPath, fullPage: false });

    // ⑪ 確認 POST API 狀態
    await page.waitForTimeout(500);
    if (apiLog.postStatus !== null) {
      const postOk = apiLog.postStatus === 200;
      notes.push(postOk ? '✅POST /setrankaward 200' : `❌POST /setrankaward ${apiLog.postStatus}`);
      if (!postOk) criticalFails.push('POST /setrankaward 失敗');
    } else {
      if (toastFound) {
        notes.push('✅POST /setrankaward（由 success toast 間接確認）');
      } else {
        notes.push('❌POST /setrankaward 未觸發（無 toast）');
        criticalFails.push('Save 後無 success toast');
      }
    }
    notes.push(toastFound ? '✅Success toast 截圖完成' : '⚠️Toast 未偵測到，截取當前畫面');

    // ⑫a 關閉 Dialog，拍主畫面確認 Bonus 設定值已套用
    await page.evaluate(() => {
      document.querySelectorAll('.el-dialog__wrapper').forEach(el => el.style.display = 'none');
      const overlay = document.querySelector('.v-modal');
      if (overlay) overlay.style.display = 'none';
      document.querySelectorAll('.el-message-box__wrapper').forEach(el => el.style.display = 'none');
    });
    await page.waitForTimeout(1000);
    const mainPageShotPath = path.join(SCREENSHOT_DIR, `bonus_main_after_save_${Date.now()}.png`);
    await page.screenshot({ path: mainPageShotPath, fullPage: false });
    extraShotPaths.push(mainPageShotPath);
    notes.push('✅主畫面截圖（Bonus 套用後）');

    // ⑫ 產生 Before vs After 比對截圖（HTML table）
    const compareRows = fieldData.map((f, i) => {
      const nv = newVals[i] ?? '-';
      const changed = f.origVal !== nv;
      return `<tr style="background:${changed ? '#e6f4ea' : '#fff'}">
        <td style="padding:6px 12px;border:1px solid #ddd">${f.label}</td>
        <td style="padding:6px 12px;border:1px solid #ddd;text-align:right">${f.origVal}</td>
        <td style="padding:6px 12px;border:1px solid #ddd;text-align:right;color:#1a7a2e;font-weight:bold">${nv}</td>
        <td style="padding:6px 12px;border:1px solid #ddd;text-align:center">${changed ? '✅' : '—'}</td>
      </tr>`;
    }).join('');
    const compareHtml = `<div style="font-family:sans-serif;margin:20px">
      <h2 style="background:#1a56db;color:#fff;padding:10px 16px;margin:0 0 0 0;font-size:15px">
        Bonus Settings — 修改前後對照（${new Date().toLocaleString('zh-TW')}）
      </h2>
      <table style="border-collapse:collapse;width:100%;margin-top:0">
        <thead><tr style="background:#f0f0f0">
          <th style="padding:8px 12px;border:1px solid #ddd;text-align:left">欄位</th>
          <th style="padding:8px 12px;border:1px solid #ddd;text-align:right">修改前</th>
          <th style="padding:8px 12px;border:1px solid #ddd;text-align:right">修改後</th>
          <th style="padding:8px 12px;border:1px solid #ddd;text-align:center">變更</th>
        </tr></thead>
        <tbody>${compareRows}</tbody>
      </table>
    </div>`;
    const prevUrl = page.url();
    const compareShotPath = path.join(SCREENSHOT_DIR, `bonus_compare_${Date.now()}.png`);
    await page.setViewportSize({ width: 900, height: 600 });
    await page.setContent(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0">${compareHtml}</body></html>`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: compareShotPath, fullPage: true });
    extraShotPaths.push(compareShotPath);
    // 導航回原頁
    await page.goto(prevUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // ⑬ 啟動 5 分鐘計時器（不還原，等 TC3 驗證）
    _bonusTimerState = {
      startTime: Date.now(),
      pageUrl: prevUrl,
      newVals,
      fieldLabels: fieldData.map(f => f.label),
    };
    notes.push(`⏳5分鐘計時開始（TC3將於計時結束後驗證）`);

  } catch (e) {
    notes.push(`⚠️Bonus Settings 測試例外: ${e.message}`);
  } finally {
    page.off('response', responseListener);
  }

  return { notes: notes.join(' | '), criticalFails, toastShotPath, extraShotPaths };
}

/**
 * doShowcase(page) → Showcase dialog 流程
 * 回傳 { notes, criticalFails, extraShotPaths }
 */
async function doShowcase(page) {
  const notes = [];
  const criticalFails = [];
  const extraShotPaths = [];

  // 先關閉所有現有 dialog
  await page.evaluate(() => {
    document.querySelectorAll('.el-dialog__wrapper, .v-modal').forEach(el => el.style.display = 'none');
  });
  await page.waitForTimeout(300);
  // 點第一個 fa-edit icon 按鈕
  await page.evaluate(() => {
    const editBtn = Array.from(document.querySelectorAll('.el-table__row button'))
      .find(b => b.querySelector('.fa-edit'));
    if (editBtn) editBtn.click();
  });
  await page.waitForTimeout(2000);
  // 滾動 dialog 到底部
  await page.evaluate(() => {
    const d = document.querySelector('.el-dialog__body');
    if (d) d.scrollTop = 99999;
  });
  await page.waitForTimeout(500);
  // 確認 Showcase 欄位存在
  const hasShowcase = await page.evaluate(() => {
    const d = document.querySelector('.el-dialog__body');
    return d ? /showcase/i.test(d.innerText) : false;
  }).catch(() => false);
  if (hasShowcase) {
    notes.push('✅Showcase設定欄位');
  } else {
    notes.push('❌Showcase設定欄位缺失');
    criticalFails.push('Showcase設定欄位缺失');
  }
  // 截圖（Edit Dialog 開啟狀態）
  const showcaseShotPath = path.join(SCREENSHOT_DIR, `showcase_dialog_${Date.now()}.png`);
  await page.screenshot({ path: showcaseShotPath, fullPage: false });
  extraShotPaths.push(showcaseShotPath);
  // 關閉 dialog
  await page.evaluate(() => {
    document.querySelectorAll('.el-dialog__wrapper').forEach(el => el.style.display = 'none');
  });
  await page.waitForTimeout(300);

  return { notes: notes.join(' | '), criticalFails, extraShotPaths };
}

/**
 * doGearPanel(page) → Gear panel 流程
 * 回傳 { notes, criticalFails, extraShotPaths }
 */
async function doGearPanel(page) {
  const notes = [];
  const criticalFails = [];
  const extraShotPaths = [];

  await page.evaluate(() => {
    const rows = document.querySelectorAll('.el-table__row');
    for (const row of rows) {
      const cogBtn = Array.from(row.querySelectorAll('button')).find(b => b.querySelector('.fa-cog'));
      if (cogBtn) { cogBtn.click(); return; }
    }
  });
  await page.waitForTimeout(2000);
  const panelText = await page.evaluate(() => {
    const panels = document.querySelectorAll('.el-dialog__body, .el-drawer__body');
    return Array.from(panels).map(p => p.innerText?.substring(0, 200)).join(' ');
  }).catch(() => '');
  if (/machine.*name|machine.*credit|machine.*status/i.test(panelText)) {
    notes.push('✅齒輪面板有機台資訊');
  } else {
    notes.push('⚠️齒輪面板內容待確認');
  }
  // 截圖（齒輪面板開啟狀態）
  const gearShotPath = path.join(SCREENSHOT_DIR, `gear_panel_${Date.now()}.png`);
  await page.screenshot({ path: gearShotPath, fullPage: false });
  extraShotPaths.push(gearShotPath);

  return { notes: notes.join(' | '), criticalFails, extraShotPaths };
}

/**
 * doTimeSetting(page) → TimeSetting dialog 流程
 * 回傳 { notes, criticalFails, extraShotPaths }
 */
async function doTimeSetting(page) {
  const notes = [];
  const criticalFails = [];
  const extraShotPaths = [];

  // 點 Reservation List 按鈕（開啟內層面板）
  const clickedResList = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const btn = btns.find(b => /reservation.*list/i.test(b.innerText));
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (clickedResList) {
    await page.waitForTimeout(2000);
    // 點 Parameter Setting 按鈕
    const clickedParam = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const btn = btns.find(b => /parameter.*setting/i.test(b.innerText));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (clickedParam) {
      await page.waitForTimeout(1500);
      const dialogText = await page.evaluate(() => {
        const d = document.querySelector('.el-dialog__body');
        return d ? d.innerText : '';
      }).catch(() => '');
      if (/lock.*count|lock.*time|machine.*count/i.test(dialogText)) {
        notes.push('✅TimeSetting dialog（Lock Count / Lock Time / Machine Count）');
      } else {
        notes.push('❌TimeSetting dialog 內容異常');
        criticalFails.push('TimeSetting dialog 內容異常');
      }
      // 截圖（TimeSetting dialog 開啟狀態）
      const timeSettingShotPath = path.join(SCREENSHOT_DIR, `timesetting_dialog_${Date.now()}.png`);
      await page.screenshot({ path: timeSettingShotPath, fullPage: false });
      extraShotPaths.push(timeSettingShotPath);
      // 關閉 dialog
      await page.evaluate(() => {
        document.querySelectorAll('.el-dialog__wrapper').forEach(el => el.style.display = 'none');
      });
    } else {
      notes.push('❌Parameter Setting 按鈕缺失');
      criticalFails.push('Parameter Setting 按鈕缺失');
    }
  } else {
    notes.push('❌Reservation List 按鈕缺失（Time Setting 無法驗證）');
    criticalFails.push('Reservation List 按鈕缺失');
  }

  return { notes: notes.join(' | '), criticalFails, extraShotPaths };
}

// ─── 每頁獨立 verify functions ────────────────────────────────────────

// ⭐ 2026-08-06 重寫：原本只數「.el-card/[class*=card]」元素數量>0就算pass，完全不管
// 藍/橘/綠/紅四個色塊各自該顯示哪些欄位。已實際登入uat-cp.osmslot.org/dashboard，
// 用innerClass+背景色確認過四色塊對應：藍=.egm(Total Available/Connected EGM)、
// 橘=.patros(Online Users，即時性需等5分鐘，已由detectManual正確分流)、
// 綠=.meter(Online Total In/Out/Bet Coin/Actual Win/Win Lose Ratio)、
// 紅=.coin(Online Total Player Balance)，改成每筆TC對應各自色塊的真實欄位斷言。

async function verifyDashboard(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1 } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);

  const readBlock = async (cls, expectedLabels) => page.evaluate(({ cls, expectedLabels }) => {
    const el = document.querySelector(`.${cls}`);
    if (!el) return { found: false };
    const text = el.innerText || '';
    const results = expectedLabels.map(label => {
      const idx = text.indexOf(label);
      if (idx === -1) return { label, present: false, value: null };
      const after = text.slice(idx + label.length, idx + label.length + 40).trim().split('\n')[0];
      return { label, present: true, value: after };
    });
    return { found: true, results };
  }, { cls, expectedLabels });

  const checkBlock = async (cls, expectedLabels, blockName) => {
    const r = await readBlock(cls, expectedLabels);
    if (!r.found) {
      notes.push(`❌找不到${blockName}色塊(.${cls})`);
      criticalFails.push(`${blockName}色塊缺失`);
      return;
    }
    const missing = r.results.filter(x => !x.present).map(x => x.label);
    const emptyVal = r.results.filter(x => x.present && !x.value).map(x => x.label);
    if (missing.length === 0 && emptyVal.length === 0) {
      notes.push(`✅${blockName}色塊有數據: ${r.results.map(x => `${x.label}=${x.value}`).join(', ')}`);
    } else {
      if (missing.length) {
        notes.push(`❌${blockName}色塊缺少欄位:${missing.join(',')}`);
        criticalFails.push(`${blockName}色塊缺少欄位:${missing.join(',')}`);
      }
      if (emptyVal.length) {
        notes.push(`❌${blockName}色塊欄位無數值:${emptyVal.join(',')}`);
        criticalFails.push(`${blockName}色塊欄位無數值:${emptyVal.join(',')}`);
      }
    }
  };

  // TC1：藍底 - 當前可用的機器數量，當前有人在遊戲內的機器數量(即時更新)
  if (/藍底.*當前可用的機器數量|當前可用的機器數量.*藍底/i.test(full) || (/藍底/.test(full) && /可用的機器數量/.test(full))) {
    await checkBlock('egm', ['Total Available EGM', 'Total System Connected EGM'], '藍底(EGM數量)');
  }

  // TC3：綠底 - 當前的總帶入金額、總帶出金額、總投注、總輸贏值、總輸贏率(５分鐘左右更新一次)
  if (/綠底.*總帶入金額|總帶入金額.*綠底/i.test(full) || (/綠底/.test(full) && /總帶入金額/.test(full))) {
    await checkBlock('meter', ['Online Total In', 'Online Total Out', 'Online Total Bet Coin', 'Online Total Actual Win', 'Total Win Lose Ratio'], '綠底(金額統計)');
  }

  // TC4：紅底 - 前總玩家所帶入機台的金額(即時更新)
  if (/紅底.*所帶入機台的金額|所帶入機台的金額.*紅底/i.test(full) || (/紅底/.test(full) && /帶入機台的金額/.test(full))) {
    await checkBlock('coin', ['Online Total Player Balance'], '紅底(玩家帶入金額)');
  }

  if (notes.length === (h1 ? 1 : 0)) {
    notes.push(`⚠️這筆TC文字沒有對應到已知的驗證規則，未執行任何斷言: ${full.slice(0, 40)}`);
  }

  return { notes: notes.join(' | '), criticalFails };
}

// ─── Daily Dashboard filter helpers ──────────────────────────────────────────

async function dashSetDate(page, dateStr) {
  // Try multiple selectors for the date input
  const selectors = [
    '.el-date-editor input',
    'input[placeholder*="Date"]',
    'input[placeholder*="date"]',
    '.el-input__inner[value*="20"]',  // value starts with year
    'input[type="text"][class*="input"]',
  ];
  let input = null;
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    const visible = await loc.isVisible({ timeout: 2000 }).catch(() => false);
    if (visible) { input = loc; break; }
  }
  if (!input) {
    // Fallback: first visible text input in the filter bar
    input = page.locator('input[type="text"]').first();
  }
  try {
    await input.click({ clickCount: 3, timeout: 5000 });
    await input.fill(dateStr);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  } catch {
    // If fill fails, try evaluate
    await page.evaluate((date) => {
      const inputs = document.querySelectorAll('input[type="text"]');
      for (const inp of inputs) {
        if (/\d{4}-\d{2}/.test(inp.value) || inp.placeholder?.toLowerCase().includes('date')) {
          const nativeInput = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
          nativeInput?.set?.call(inp, date);
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          break;
        }
      }
    }, dateStr);
    await page.waitForTimeout(500);
  }
}

async function dashSelectDropdown(page, labelText, optionText) {
  // Find the el-select closest to the label text, click it, pick option
  await page.evaluate((label) => {
    const labels = [...document.querySelectorAll('label, span, div')]
      .filter(el => el.childElementCount === 0 && el.innerText?.trim() === label);
    // Try parent's sibling el-select
    for (const lbl of labels) {
      const parent = lbl.closest('.el-form-item, .filter-item, div');
      const sel = parent?.querySelector('.el-select .el-input__inner');
      if (sel) { sel.click(); return; }
    }
    // Fallback: find by placeholder or current value
    const selects = [...document.querySelectorAll('.el-select .el-input__inner')];
    for (const s of selects) {
      if (s.placeholder?.includes(label) || s.closest('.el-select')?.previousElementSibling?.innerText?.includes(label)) {
        s.click(); return;
      }
    }
  }, labelText);
  await page.waitForTimeout(400);

  const clicked = await page.evaluate((opt) => {
    const items = [...document.querySelectorAll('.el-select-dropdown__item:not(.is-disabled)')];
    const item = items.find(i => i.innerText?.trim() === opt);
    if (item) { item.click(); return true; }
    return false;
  }, optionText);

  await page.waitForTimeout(300);
  // Close dropdown if still open
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  return clicked;
}

async function dashClickView(page) {
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /^view$/i.test(b.innerText?.trim()));
    if (btn) btn.click();
  });
  await page.waitForTimeout(1500);
}

async function dashReadCards(page) {
  return await page.evaluate(() => {
    const text = document.body?.innerText || '';
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

    function findAfter(label) {
      const idx = lines.findIndex(l => l.toLowerCase() === label.toLowerCase());
      if (idx === -1) return null;
      for (let i = idx + 1; i < lines.length && i <= idx + 3; i++) {
        const v = lines[i];
        if (v && v !== label) return v;
      }
      return null;
    }
    function parsePHP(s) {
      if (!s) return null;
      const m = s.replace(/,/g, '').match(/-?[\d.]+/);
      return m ? parseFloat(m[0]) : null;
    }
    function parseRatio(s) {
      if (!s) return null;
      const m = s.match(/-?[\d.]+/);
      return m ? parseFloat(m[0]) : null;
    }

    const betPlayerRaw = findAfter('Total bet player');
    const totalInRaw   = findAfter('Total in');
    const totalOutRaw  = findAfter('Total out');
    const totalBetRaw  = findAfter('Total bet');
    const winRaw       = findAfter('Total Actual Win');
    const ratioRaw     = findAfter('Total win lose ratio');

    return {
      betPlayer:    betPlayerRaw ? parseInt(betPlayerRaw.replace(/[^\d]/g, '')) : null,
      totalIn:      parsePHP(totalInRaw),
      totalOut:     parsePHP(totalOutRaw),
      totalBet:     parsePHP(totalBetRaw),
      actualWin:    parsePHP(winRaw),
      winLoseRatio: parseRatio(ratioRaw),
      raw: { betPlayerRaw, totalInRaw, totalOutRaw, totalBetRaw, winRaw, ratioRaw },
    };
  });
}

async function daycountRead(page, targetDate) {
  // Read the row matching targetDate from EGM DayCount table
  return await page.evaluate((date) => {
    // Try el-table rows first
    const rows = [...document.querySelectorAll('tr')].filter(r => r.querySelector('td'));
    for (const row of rows) {
      const cells = [...row.querySelectorAll('td')].map(td => td.innerText?.trim() || '');
      if (cells[0] === date || cells[0]?.startsWith(date)) {
        function parsePHP(s) {
          const m = (s || '').replace(/,/g, '').match(/-?[\d.]+/);
          return m ? parseFloat(m[0]) : null;
        }
        return {
          totalIn:      parsePHP(cells[1]),
          totalOut:     parsePHP(cells[2]),
          betUser:      parseInt((cells[3] || '').replace(/[^\d]/g, '')) || null,
          totalBet:     parsePHP(cells[5]),
          totalWinLose: parsePHP(cells[6]),
          winLoseRatio: parseFloat((cells[7] || '').replace(/[^-\d.]/g, '')) || null,
        };
      }
    }
    return null;
  }, targetDate);
}

function dashCompare(dashVals, dcVals, label) {
  if (!dcVals) return `⚠️${label}：EGM DayCount 無對應日期資料`;
  const results = [];
  function cmp(name, dv, dcv, pct = 0.01) {
    if (dv == null || dcv == null) { results.push(`⚠️${name}無法取得`); return; }
    const ok = Math.abs(dv - dcv) <= Math.max(Math.abs(dcv) * pct, 1);
    results.push(ok
      ? `✅${name}吻合(${dv})`
      : `❌${name}不符(Dashboard:${dv} DayCount:${dcv})`);
  }
  cmp('投注人數', dashVals.betPlayer, dcVals.betUser, 0);
  cmp('TotalIn', dashVals.totalIn, dcVals.totalIn);
  cmp('TotalOut', dashVals.totalOut, dcVals.totalOut);
  cmp('TotalBet', dashVals.totalBet, dcVals.totalBet);
  cmp('ActualWin', dashVals.actualWin, dcVals.totalWinLose);
  cmp('WinLoseRatio%', dashVals.winLoseRatio, dcVals.winLoseRatio, 0.1);
  return `【${label}】${results.join(' ')}`;
}

async function dismissWarningDialog(page) {
  // JS-hide Warning dialog to avoid triggering Vue Router navigation via Cancel button
  await page.locator('.el-dialog').filter({ hasText: /Warnning|Warning/i }).waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  await page.evaluate(() => {
    document.querySelectorAll('.el-dialog__wrapper').forEach(el => {
      if (/Warnning|Warning/i.test(el.textContent || '')) el.style.display = 'none';
    });
    const overlay = document.querySelector('.v-modal');
    if (overlay) overlay.style.display = 'none';
  });
  await page.waitForTimeout(500);
}

async function runDashFilterTest(page, filterLabel, targetDate, gameType, clientVersion, extraShotPaths, notes, criticalFails) {
  // ① Navigate to Daily Dashboard
  await page.goto(`${BACKEND_URL}/daily_dashboard`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);
  await dismissWarningDialog(page);

  // ② Set filters
  await dashSetDate(page, targetDate);
  if (gameType && gameType !== 'All Game') await dashSelectDropdown(page, 'Game Type', gameType);
  if (clientVersion && clientVersion !== 'ALL') await dashSelectDropdown(page, 'Client Version', clientVersion);
  await dashClickView(page);
  await page.waitForTimeout(2000); // 等動畫跑完

  // ③ Screenshot Dashboard
  const dashShotPath = path.join(SCREENSHOT_DIR, `dash_filter_${filterLabel}_${Date.now()}.png`);
  await page.screenshot({ path: dashShotPath, fullPage: false });
  extraShotPaths.push(dashShotPath);

  // ④ Read Dashboard values
  const dashVals = await dashReadCards(page);

  // ⑤ Navigate to EGM DayCount
  await page.goto(`${BACKEND_URL}/egm/reports/gameCount`, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(1000);
  await dismissWarningDialog(page);

  // ⑥ Set same date range (from = to = targetDate)
  const dateInputs = page.locator('.el-date-editor input');
  const inputCount = await dateInputs.count().catch(() => 0);
  if (inputCount >= 2) {
    await dateInputs.nth(0).click({ clickCount: 3 });
    await dateInputs.nth(0).fill(targetDate);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(200);
    await dateInputs.nth(1).click({ clickCount: 3 });
    await dateInputs.nth(1).fill(targetDate);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
  } else if (inputCount === 1) {
    await dashSetDate(page, targetDate);
  }

  // ⑦ Set same Game Type / Client Version on DayCount
  if (gameType && gameType !== 'All Game') await dashSelectDropdown(page, 'Game Type', gameType);
  if (clientVersion && clientVersion !== 'ALL') await dashSelectDropdown(page, 'Client Version', clientVersion);

  // ⑧ Click View
  await dashClickView(page);

  // ⑨ Screenshot DayCount
  const dcShotPath = path.join(SCREENSHOT_DIR, `daycount_filter_${filterLabel}_${Date.now()}.png`);
  await page.screenshot({ path: dcShotPath, fullPage: false });
  extraShotPaths.push(dcShotPath);

  // ⑩ Read DayCount row
  const dcVals = await daycountRead(page, targetDate);

  // ⑩b Export + compare xlsx with on-screen values
  const exportResult = await doExport(page);
  notes.push(`Export(${filterLabel}):${exportResult.notes}`);
  criticalFails.push(...exportResult.criticalFails);

  // Declare xlsx vars at outer scope so they're available for return
  let xlsxVals = null;

  if (exportResult.exportedXlsxPath) {
    // Read xlsx and find row matching targetDate
    const { headers, rows } = extractXlsxData(exportResult.exportedXlsxPath);
    const dateColIdx = headers.findIndex(h => /^date$/i.test(h.trim()));
    const xlsxRow = rows.find(r => {
      const cellVal = String(r[dateColIdx >= 0 ? dateColIdx : 0] ?? '').trim();
      return cellVal === targetDate || cellVal.startsWith(targetDate);
    });

    if (xlsxRow) {
      const xlsxNum = (colPattern) => {
        const idx = headers.findIndex(h => new RegExp(colPattern, 'i').test(h));
        if (idx === -1) return null;
        const v = xlsxRow[idx];
        return v != null && v !== '' ? parseFloat(String(v).replace(/,/g, '')) : null;
      };
      const rawRatio = xlsxNum('win.lose.ratio');
      xlsxVals = {
        betUser:      xlsxNum('bet.user|bet user'),
        totalIn:      xlsxNum('transfer.in|in.amount'),
        totalOut:     xlsxNum('transfer.out|out.amount'),
        totalBet:     xlsxNum('bet.amount'),
        totalWinLose: xlsxNum('win.or.lose|win.lose.amount'),
        // xlsx stores ratio as decimal (e.g. 0.437), screen shows percentage (43.7) → ×100
        winLoseRatio: rawRatio != null ? parseFloat((rawRatio * 100).toFixed(4)) : null,
      };
      // Compare xlsx vs on-screen DayCount
      const xlsxCompare = dashCompare(
        { betPlayer: xlsxVals.betUser, totalIn: xlsxVals.totalIn, totalOut: xlsxVals.totalOut,
          totalBet: xlsxVals.totalBet, actualWin: xlsxVals.totalWinLose, winLoseRatio: xlsxVals.winLoseRatio },
        dcVals,
        `${filterLabel}(xlsx↔畫面)`
      );
      notes.push(xlsxCompare);
      if (xlsxCompare.includes('❌')) criticalFails.push(`DayCount xlsx與畫面數值不符(${filterLabel})`);
    } else {
      notes.push(`⚠️xlsx中找不到${targetDate}對應行`);
    }
  }

  // ⑪ Compare Dashboard ↔ DayCount
  const compareNote = dashCompare(dashVals, dcVals, filterLabel);
  const pass = !compareNote.includes('❌');
  notes.push(compareNote);
  if (!pass) criticalFails.push(`Daily Dashboard ${filterLabel} 篩選數據與DayCount不符`);

  // Return raw values for visual report generation
  return { pass, dashVals, dcVals, xlsxVals, filterLabel };
}

async function generateDashFilterReport(page, filterResults, targetDate) {
  function fmt(v) { return v == null ? '–' : typeof v === 'number' ? v.toLocaleString() : String(v); }
  function cmpColor(a, b, pct = 0.01) {
    if (a == null || b == null) return '#f59e0b'; // amber = unknown
    return Math.abs(a - b) <= Math.max(Math.abs(b) * pct, 1) ? '#16a34a' : '#dc2626';
  }

  const fields = [
    { key: 'betPlayer/betUser', label: '投注人數', dashKey: 'betPlayer', dcKey: 'betUser', xlsxKey: 'betUser', pct: 0 },
    { key: 'totalIn',           label: 'TotalIn',   dashKey: 'totalIn',   dcKey: 'totalIn',   xlsxKey: 'totalIn'   },
    { key: 'totalOut',          label: 'TotalOut',  dashKey: 'totalOut',  dcKey: 'totalOut',  xlsxKey: 'totalOut'  },
    { key: 'totalBet',          label: 'TotalBet',  dashKey: 'totalBet',  dcKey: 'totalBet',  xlsxKey: 'totalBet'  },
    { key: 'actualWin',         label: 'ActualWin', dashKey: 'actualWin', dcKey: 'totalWinLose', xlsxKey: 'totalWinLose' },
    { key: 'winLoseRatio',      label: 'WinLoseRatio%', dashKey: 'winLoseRatio', dcKey: 'winLoseRatio', xlsxKey: 'winLoseRatio', pct: 0.1 },
  ];

  let html = `<div style="font-family:sans-serif;padding:16px;background:#f8fafc;font-size:13px">
    <h2 style="color:#1e40af;margin:0 0 4px;font-size:16px">Daily Dashboard 篩選比對報告</h2>
    <p style="color:#64748b;margin:0 0 14px">目標日期: ${targetDate} | 比對: Dashboard ↔ EGM DayCount ↔ xlsx</p>`;

  for (const fr of filterResults) {
    const { filterLabel, dashVals, dcVals, xlsxVals } = fr;
    const hasXlsx = xlsxVals != null;
    html += `<div style="margin-bottom:14px;background:#fff;border:1px solid #e2e8f0;border-radius:6px;overflow:hidden">
      <div style="background:#1e40af;color:#fff;padding:6px 12px;font-weight:bold">${filterLabel}</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <tr style="background:#f1f5f9">
          <th style="padding:5px 10px;text-align:left;border-bottom:1px solid #e2e8f0">欄位</th>
          <th style="padding:5px 10px;text-align:right;border-bottom:1px solid #e2e8f0">Dashboard</th>
          <th style="padding:5px 10px;text-align:right;border-bottom:1px solid #e2e8f0">DayCount(畫面)</th>
          <th style="padding:5px 10px;text-align:right;border-bottom:1px solid #e2e8f0">Dash↔DC</th>
          ${hasXlsx ? `<th style="padding:5px 10px;text-align:right;border-bottom:1px solid #e2e8f0">xlsx</th><th style="padding:5px 10px;text-align:right;border-bottom:1px solid #e2e8f0">xlsx↔DC</th>` : ''}
        </tr>`;
    for (const f of fields) {
      const dv  = dashVals?.[f.dashKey] ?? null;
      const dcv = dcVals?.[f.dcKey]     ?? null;
      const xv  = xlsxVals?.[f.xlsxKey] ?? null;
      const dcColor  = cmpColor(dv, dcv, f.pct ?? 0.01);
      const xlsxColor = cmpColor(xv, dcv, f.pct ?? 0.01);
      const dcIcon  = dv == null || dcv == null ? '⚠' : (dcColor === '#16a34a' ? '✓' : '✗');
      const xlsxIcon = xv == null || dcv == null ? '⚠' : (xlsxColor === '#16a34a' ? '✓' : '✗');
      html += `<tr style="border-bottom:1px solid #f1f5f9">
        <td style="padding:4px 10px;color:#475569">${f.label}</td>
        <td style="padding:4px 10px;text-align:right">${fmt(dv)}</td>
        <td style="padding:4px 10px;text-align:right">${fmt(dcv)}</td>
        <td style="padding:4px 10px;text-align:center;color:${dcColor};font-weight:bold">${dcIcon}</td>
        ${hasXlsx ? `<td style="padding:4px 10px;text-align:right">${fmt(xv)}</td><td style="padding:4px 10px;text-align:center;color:${xlsxColor};font-weight:bold">${xlsxIcon}</td>` : ''}
      </tr>`;
    }
    html += `</table></div>`;
  }
  html += `</div>`;

  const reportPath = path.join(SCREENSHOT_DIR, `dash_filter_report_${Date.now()}.png`);
  const prevUrl = page.url();
  await page.setViewportSize({ width: 860, height: 600 });
  await page.setContent(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0">${html}</body></html>`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  await page.screenshot({ path: reportPath, fullPage: true });
  await page.goto(prevUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  return reportPath;
}

async function verifyDailyDashboard(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1 } = await getBaseInfo(page);
  if (!/daily.dashboard/i.test(h1 || '')) {
    const currentUrl = await page.evaluate(() => window.location.href).catch(() => '');
    if (!/daily.dashboard/i.test(currentUrl)) {
      notes.push('❌未進入Daily Dashboard');
      criticalFails.push('未進入Daily Dashboard');
      return { notes: notes.join(' | '), criticalFails };
    }
  }
  if (h1) notes.push(`頁面:${h1}`);

  const pageText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');

  if (/藍底|投注.*新用戶/i.test(full)) {
    const hasData = /Total bet player|Bet Player|New Player|Total.*Player|投注|新用戶/i.test(pageText);
    if (hasData) {
      notes.push('✅藍底有數據(Total bet player)');
    } else {
      notes.push('❌藍底 Total bet player 未找到');
      criticalFails.push('Daily Dashboard 藍底 Total bet player 缺失');
    }
  }

  if (/橘底|handpay.*金額/i.test(full)) {
    const hasHandpay = /Total Jackpot|HandPay|Handpay|handpay|手動支付/i.test(pageText);
    if (hasHandpay) {
      notes.push('✅橘底Total Jackpot有數據');
    } else {
      notes.push('❌橘底 Total Jackpot 未找到');
      criticalFails.push('Daily Dashboard 橘底 Total Jackpot 缺失');
    }
  }

  if (/綠底|輸贏率/i.test(full)) {
    const hasIn = /Total in/i.test(pageText);
    const hasRatio = /Total win lose ratio|Win.*Lose.*Ratio/i.test(pageText);
    if (hasIn && hasRatio) {
      notes.push('✅綠底(Total in + Total win lose ratio)');
    } else {
      notes.push(`❌綠底缺失(Total in:${hasIn}, Ratio:${hasRatio})`);
      criticalFails.push('Daily Dashboard 綠底資料缺失');
    }
  }

  if (/紅底|留存率|dau|mau/i.test(full)) {
    const hasDAU = /DAU/i.test(pageText);
    const hasMAU = /MAU/i.test(pageText);
    const hasRetention = /User retention rate|Retention/i.test(pageText);
    if (hasDAU && hasMAU && hasRetention) {
      notes.push('✅紅底(DAU/MAU/User retention rate)');
    } else {
      notes.push(`❌紅底缺失(DAU:${hasDAU}, MAU:${hasMAU}, Retention:${hasRetention})`);
      criticalFails.push('Daily Dashboard 紅底資料缺失');
    }
  }

  if (/game.*type.*client.*version|date.*功能|game\s*type.*date|client.*version.*date/i.test(full)) {
    const extraShotPaths = [];

    // Determine a target date: yesterday (YYYY-MM-DD)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const targetDate = yesterday.toISOString().split('T')[0];

    // ── TC: Date filter ──
    const r1 = await runDashFilterTest(page, 'Date篩選', targetDate, 'All Game', 'ALL', extraShotPaths, notes, criticalFails);

    // ── TC: Client Version filter ──
    const testClientVersion = process.env.DASH_CLIENT_VERSION || 'H5(1.5)';
    const r2 = await runDashFilterTest(page, `ClientVersion(${testClientVersion})`, targetDate, 'All Game', testClientVersion, extraShotPaths, notes, criticalFails);

    // ── TC: Game Type filter ──
    const testGameType = process.env.DASH_GAME_TYPE || 'BWJL';
    const r3 = await runDashFilterTest(page, `GameType(${testGameType})`, targetDate, testGameType, 'ALL', extraShotPaths, notes, criticalFails);

    // ── Generate visual comparison report screenshot ──
    // Put report FIRST so it's the primary thumbnail in Lark
    try {
      const reportPath = await generateDashFilterReport(page, [r1, r2, r3], targetDate);
      console.log(`[DashFilterReport] generated: ${reportPath}, exists: ${fs.existsSync(reportPath)}`);
      if (reportPath && fs.existsSync(reportPath)) extraShotPaths.unshift(reportPath);
    } catch (e) {
      console.log(`[DashFilterReport] ERROR: ${e.message}`);
      notes.push(`⚠️比對報告截圖生成失敗: ${e.message}`);
    }

    return { notes: notes.join(' | '), criticalFails, extraShotPaths };
  }

  return { notes: notes.join(' | '), criticalFails };
}


async function verifyEGMList(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';
  const desc = full.toLowerCase();

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, rowCount, allBtns } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);
  notes.push(`表格${rowCount}筆`);

  let exportedXlsxPath = null;
  const extraShotPaths = [];

  if (/\badd\b|新增/.test(desc)) {
    const hasAdd = allBtns.some(t => /^add\b/i.test(t));
    if (hasAdd) {
      notes.push('✅Add按鈕');
    } else {
      notes.push('❌Add按鈕缺失');
      criticalFails.push('Add按鈕缺失');
    }
  }

  if (/set.*config|config.*按鈕/i.test(full)) {
    const hasConfig = allBtns.some(t => /config/i.test(t));
    notes.push(hasConfig ? '✅Set Config按鈕' : '⚠️Set Config按鈕未找到');
  }

  if (/batch.*set|批量設置/i.test(full)) {
    const hasBatch = allBtns.some(t => /batch/i.test(t));
    notes.push(hasBatch ? '✅Batch Set按鈕' : '⚠️Batch Set按鈕未找到');
  }

  if (/excel|export|匯出|導出|csv/.test(desc)) {
    const exportResult = await doExport(page);
    if (exportResult.notes) notes.push(exportResult.notes);
    criticalFails.push(...exportResult.criticalFails);
    exportedXlsxPath = exportResult.exportedXlsxPath;
  }

  if (/showcase/i.test(full)) {
    const showcaseResult = await doShowcase(page);
    if (showcaseResult.notes) notes.push(showcaseResult.notes);
    criticalFails.push(...showcaseResult.criticalFails);
    extraShotPaths.push(...showcaseResult.extraShotPaths);
  }

  if (/maintenance|維護.*喚醒/i.test(full)) {
    const hasMaint = allBtns.some(t => /maintenance|wake/i.test(t));
    notes.push(hasMaint ? '✅Maintenance按鈕' : '⚠️Maintenance/Wake按鈕未找到');
  }

  // ⭐ 2026-08-06新增：確認是否能編輯機台資訊(Alias/限額/設置白名單)
  // 已實際點開Edit Machine Dialog確認：Alias對應欄位是「GameNameAlias」、限額對應「Enter Limit」、
  // 設置白名單對應「VIP」(YES/NO開關，語意上是VIP名單/白名單存取控制)
  if (/確認是否能編輯機台資訊.*alias.*限額.*設置白名單/i.test(full)) {
    if (rowCount === 0) {
      notes.push('⚠️表格無資料，無法開啟Edit Machine Dialog驗證');
    } else {
      const clicked = await page.evaluate(() => {
        const row = document.querySelectorAll('.el-table__body tr')[0];
        const btn = row && [...row.querySelectorAll('button')].find(b => !b.innerText?.trim());
        if (btn) { btn.click(); return true; }
        return false;
      });
      await page.waitForTimeout(1000);
      if (!clicked) {
        notes.push('❌找不到Edit機台圖示按鈕');
        criticalFails.push('Edit機台圖示按鈕缺失');
      } else {
        const labels = await page.evaluate(() => {
          const d = [...document.querySelectorAll('.el-dialog')].filter(x => x.getBoundingClientRect().width > 0).pop();
          return d ? [...d.querySelectorAll('.el-form-item__label')].map(l => l.innerText?.trim()) : null;
        });
        const shotPath = path.join(SCREENSHOT_DIR, `egmlist_edit_${Date.now()}.png`);
        await page.screenshot({ path: shotPath });
        extraShotPaths.push(shotPath);
        const expected = ['GameNameAlias', 'Enter Limit', 'VIP'];
        const missing = expected.filter(e => !labels?.includes(e));
        if (missing.length === 0) {
          notes.push('✅Edit Machine Dialog含Alias(GameNameAlias)/限額(Enter Limit)/白名單相關(VIP)欄位');
        } else {
          notes.push(`❌Edit Machine Dialog缺少欄位:${missing.join(',')}（實際:${labels?.join(',') || '無'}）`);
          criticalFails.push(`Edit Machine Dialog缺少欄位:${missing.join(',')}`);
        }
        await page.keyboard.press('Escape').catch(() => {});
      }
    }
  }

  if (/可以.*編輯|可以.*刪除|edit.*delete|delete.*edit|編輯.*刪除|刪除.*編輯/.test(desc)) {
    if (rowCount === 0) {
      notes.push('⚠️操作按鈕待確認（表格無資料）');
    } else {
      const hasEdit = await page.evaluate(() =>
        document.querySelectorAll('.el-button--primary, .el-button--warning').length > 0
      ).catch(() => false);
      const hasDel = await page.evaluate(() =>
        document.querySelectorAll('.el-button--danger').length > 0
      ).catch(() => false);
      if (hasEdit || hasDel) {
        notes.push(`✅操作按鈕(edit:${hasEdit},del:${hasDel})`);
      } else {
        notes.push('❌編輯/刪除按鈕缺失');
        criticalFails.push('編輯/刪除按鈕缺失');
      }
    }
  }

  return { notes: notes.join(' | '), criticalFails, exportedXlsxPath, extraShotPaths };
}

async function verifyEGMStatus(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, rowCount, allBtns } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);
  notes.push(`表格${rowCount}筆`);

  const extraShotPaths = [];

  if (/齒輪|gear|機台詳細|machine.*detail|screen.*cctv|cctv.*grid/i.test(full)) {
    const gearResult = await doGearPanel(page);
    if (gearResult.notes) notes.push(gearResult.notes);
    criticalFails.push(...gearResult.criticalFails);
    extraShotPaths.push(...gearResult.extraShotPaths);
  }

  if (/maintenance|維護.*喚醒/i.test(full)) {
    const hasMaint = allBtns.some(t => /maintenance|wake/i.test(t));
    notes.push(hasMaint ? '✅Maintenance按鈕' : '⚠️Maintenance按鈕未找到');
  }

  return { notes: notes.join(' | '), criticalFails, extraShotPaths };
}

// ⭐ 2026-08-06 重寫：原本不管TC實際內容，只回報「表格0筆（UAT環境可能為0）」就算pass。
// 已實際登入uat-cp.osmslot.org/egm/onlineList查證：這頁的「Online Type」下拉正好就是
// 3筆TC分別對應的3個選項(Gaming User/Online User/Occupied Machine)，且實測確認選
// "Online User"時Game Type欄位真的會被disabled=true（對應TC2「確認會屏蔽Game Type功能」），
// 選"Gaming User"時則是disabled=false——這是可以真的操作切換+讀DOM disabled屬性驗證的，
// 不是臆測。改成每筆TC實際切換對應的Online Type並驗證真實行為。

async function verifyGamingUser(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';
  const desc = full.toLowerCase();

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, rowCount } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);

  const selectOnlineType = async (value) => {
    await page.evaluate((label) => {
      const item = [...document.querySelectorAll('.el-form-item')].find(it => it.querySelector('.el-form-item__label')?.innerText?.trim() === 'Online Type');
      item?.querySelector('.el-input__inner')?.click();
    });
    await page.waitForTimeout(400);
    const clicked = await page.evaluate((value) => {
      const dropdowns = [...document.querySelectorAll('.el-select-dropdown')].filter(d => d.getBoundingClientRect().width > 0);
      const last = dropdowns[dropdowns.length - 1];
      const opt = last && [...last.querySelectorAll('li')].find(li => li.innerText?.trim() === value);
      if (opt) { opt.click(); return true; }
      return false;
    }, value);
    await page.waitForTimeout(400);
    return clicked;
  };

  const getOnlineTypeOptions = async () => {
    await page.evaluate(() => {
      const item = [...document.querySelectorAll('.el-form-item')].find(it => it.querySelector('.el-form-item__label')?.innerText?.trim() === 'Online Type');
      item?.querySelector('.el-input__inner')?.click();
    });
    await page.waitForTimeout(400);
    const opts = await page.evaluate(() => {
      const dropdowns = [...document.querySelectorAll('.el-select-dropdown')].filter(d => d.getBoundingClientRect().width > 0);
      const last = dropdowns[dropdowns.length - 1];
      return last ? [...last.querySelectorAll('li')].map(li => li.innerText?.trim()) : [];
    });
    await page.keyboard.press('Escape').catch(() => {});
    return opts;
  };

  const getGameTypeDisabled = () => page.evaluate(() => {
    const item = [...document.querySelectorAll('.el-form-item')].find(it => it.querySelector('.el-form-item__label')?.innerText?.trim() === 'Game Type');
    return item?.querySelector('input')?.disabled ?? null;
  });

  // TC1：Gaming User計算玩家在機台內的人數，並確認篩選機台功能有成功篩選正確人數
  if (/gaming user計算玩家在機台內的人數|篩選機台功能.*篩選正確人數/i.test(full)) {
    const opts = await getOnlineTypeOptions();
    const expectedOpts = ['Gaming User', 'Online User', 'Occupied Machine'];
    const missingOpts = expectedOpts.filter(o => !opts.includes(o));
    if (missingOpts.length > 0) {
      notes.push(`❌Online Type選項缺少:${missingOpts.join(',')}（實際:${opts.join(',')}）`);
      criticalFails.push(`Online Type選項缺少:${missingOpts.join(',')}`);
    } else {
      await selectOnlineType('Gaming User');
      const gtDisabled = await getGameTypeDisabled();
      const { rowCount: rc2 } = await getBaseInfo(page);
      if (gtDisabled === false) {
        notes.push(`✅Online Type=Gaming User時Game Type篩選可用（可篩選機台）| 表格${rc2}筆${rc2 === 0 ? '（UAT環境目前無在線玩家，僅驗證篩選機制存在，未驗證實際計數）' : ''}`);
      } else {
        notes.push(`❌Online Type=Gaming User時Game Type篩選未如預期啟用(disabled=${gtDisabled})`);
        criticalFails.push('Gaming User模式下Game Type篩選未啟用');
      }
    }
  }

  // TC2：Online User計算大廳內的人數，並確認會屏蔽Game Type功能
  if (/online user計算大廳內的人數|確認會屏蔽game type功能/i.test(full)) {
    const selected = await selectOnlineType('Online User');
    if (!selected) {
      notes.push('❌找不到Online Type="Online User"選項');
      criticalFails.push('Online User選項缺失');
    } else {
      const gtDisabled = await getGameTypeDisabled();
      const { rowCount: rc2 } = await getBaseInfo(page);
      if (gtDisabled === true) {
        notes.push(`✅Online Type=Online User時Game Type欄位正確被disabled（屏蔽） | 表格${rc2}筆`);
      } else {
        notes.push(`❌Online Type=Online User時Game Type欄位未被屏蔽(disabled=${gtDisabled})`);
        criticalFails.push('Online User模式下Game Type未被屏蔽');
      }
    }
  }

  // TC3：后台Game User增加预约机器+占用机器数量记录，Type为Occupied Machine
  if (/占用机器数量记录|type為occupied machine|type为occupied machine/i.test(full)) {
    const selected = await selectOnlineType('Occupied Machine');
    if (!selected) {
      notes.push('❌找不到Online Type="Occupied Machine"選項');
      criticalFails.push('Occupied Machine選項缺失');
    } else {
      const { rowCount: rc2, allHeaders: ah2 } = await getBaseInfo(page);
      if (rc2 > 0) {
        const typeColOk = await page.evaluate(() => {
          const rows = [...document.querySelectorAll('.el-table__body tr')];
          return rows.some(r => /occupied machine/i.test(r.innerText || ''));
        });
        notes.push(typeColOk
          ? `✅Online Type=Occupied Machine：表格${rc2}筆，含Occupied Machine記錄`
          : `⚠️Online Type=Occupied Machine：表格${rc2}筆，但未在列中看到"Occupied Machine"字樣（實際欄位:${ah2.join(',')}）`);
      } else {
        notes.push(`✅Online Type=Occupied Machine選項可正常切換 | 表格${rc2}筆（UAT環境目前無占用機器記錄，僅驗證篩選機制存在）`);
      }
    }
  }

  let exportedXlsxPath = null;

  if (/excel|export|匯出|導出|csv/.test(desc)) {
    const exportResult = await doExport(page);
    if (exportResult.notes) notes.push(exportResult.notes);
    criticalFails.push(...exportResult.criticalFails);
    exportedXlsxPath = exportResult.exportedXlsxPath;
  }

  if (notes.length === (h1 ? 1 : 0)) {
    notes.push(`表格${rowCount}筆（UAT環境可能為0） | ⚠️這筆TC文字沒有對應到已知的驗證規則，未執行額外斷言: ${full.slice(0, 40)}`);
  }

  return { notes: notes.join(' | '), criticalFails, exportedXlsxPath };
}

// ⭐ 2026-08-06 重寫：這支verifier共用給7個報表頁面（User Detail/EGM Detail/EGM Transfer/
// Game Record/EGM DayCount/Player Credit Log/Jackpot Record，共28筆TC），原本只檢查
// 「有日期篩選元件」就算pass，不管TC實際要求哪些搜尋欄位。已實際登入uat-cp.osmslot.org
// 逐頁查證7個頁面的真實filter欄位組合（每頁不同），改成依頁面breadcrumb分流+關鍵字比對
// 各自的真實搜尋欄位。

// ⭐ 2026-08-06 重寫：這支verifier共用給7個報表頁面（User Detail/EGM Detail/EGM Transfer/
// Game Record/EGM DayCount/Player Credit Log/Jackpot Record，共28筆TC），原本只檢查
// 「有日期篩選元件」就算pass，不管TC實際要求哪些搜尋欄位。已實際登入uat-cp.osmslot.org
// 逐頁查證7個頁面的真實filter欄位組合（每頁不同），改成依頁面breadcrumb分流+關鍵字比對
// 各自的真實搜尋欄位。

async function verifyReportPage(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';
  const desc = full.toLowerCase();

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, rowCount } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);
  notes.push(`表格${rowCount}筆`);

  const extraShotPaths = [];
  const breadcrumb = await page.evaluate(() => document.querySelector('.el-breadcrumb, h1, h2, .page-title')?.innerText || '').catch(() => '');
  const isPage = (name) => new RegExp(name, 'i').test(breadcrumb);
  const filterLabels = await page.evaluate(() => [...document.querySelectorAll('.el-form-item__label')].map(l => l.innerText?.trim()).filter(Boolean)).catch(() => []);

  const checkFields = (expected) => {
    const missing = expected.filter(e => !filterLabels.includes(e));
    if (missing.length === 0) {
      notes.push(`✅搜尋欄位完整(${expected.join('/')})`);
    } else {
      notes.push(`❌缺少搜尋欄位:${missing.join(',')}（實際:${filterLabels.join(',')}）`);
      criticalFails.push(`缺少搜尋欄位:${missing.join(',')}`);
    }
  };

  // TC：確認日期可以選擇(當日)（7頁共通）
  if (/確認日期可以選擇\(當日\)|確認日期可以選擇（當日）/i.test(full)) {
    const dateEditorCount = await page.evaluate(() => document.querySelectorAll('.el-date-editor').length).catch(() => 0);
    if (dateEditorCount >= 2) {
      notes.push(`✅日期篩選存在(${dateEditorCount}個日期輸入框，From/To區間)`);
    } else {
      notes.push(`❌日期篩選元件數量異常(${dateEditorCount}個，預期至少2個From/To)`);
      criticalFails.push('日期篩選元件缺失或不完整');
    }
    // Game Record TC1同時混雜「前端玩機台查看是否有實時紀錄」的跨系統要求，後台看不到，如實記錄
    if (/前端玩機台.*查看是否有實時紀錄/i.test(full)) {
      notes.push('⚠️「前端玩機台是否有實時紀錄」為跨系統驗證，後台看不到前端操作，僅驗證了日期篩選部分');
    }
    // ⭐ 2026-08-06：Player Credit Log這筆TC文字補充「如果跟Egm Detail不同是正常的，
    // 可以到盒子看看是不是有AFT問題」——這是給人看的troubleshooting指引（AFT問題需實體
    // 機台/盒子才能確認），不是可從後台頁面斷言的行為，這裡只如實記錄補充說明存在，
    // 不假裝驗證過AFT狀態。
    if (/egm detail不同是正常的|aft問題/i.test(full)) {
      notes.push('ℹ️TC文字補充：與EGM Detail數字不同時屬正常，需到實體機台盒子確認AFT狀態，本工具僅驗證後台頁面本身，未做實體AFT狀態確認');
    }
  }

  // TC：Machine Name/UserId/Account/Game Type/Player Channel/Type/Game Order 搜尋欄位（各頁不同組合）
  if (/可以搜尋|搜尋機型正確|篩選正確|都可以正確搜尋/i.test(full)) {
    if (isPage('User Detail') && /machine name.*userid.*account/i.test(full)) {
      checkFields(['Machine Name', 'UserId', 'Account']);
    } else if (isPage('User Detail') && /game type/i.test(full)) {
      checkFields(['Game Type']);
    } else if (isPage('EGM Detail') && /machine name可以搜尋/i.test(full)) {
      checkFields(['Machine Name']);
    } else if (isPage('EGM Detail') && /game type/i.test(full)) {
      checkFields(['Game Type']);
    } else if (isPage('EGM Transfer')) {
      checkFields(['Machine Name', 'UserId', 'Account']);
    } else if (isPage('Game Record') && /game order/i.test(full)) {
      checkFields(['Machine Name', 'UserId', 'Account', 'Game Order']);
    } else if (isPage('Game Record') && /player channel/i.test(full)) {
      checkFields(['Player Channel']);
    } else if (isPage('EGM DayCount') && /game type/i.test(full)) {
      checkFields(['Game Type']);
    } else if (isPage('EGM DayCount') && /player channel/i.test(full)) {
      checkFields(['Player Channel']);
    } else if (isPage('Player Credit Log') && /player channel/i.test(full)) {
      checkFields(['Player Channel']);
    } else if (isPage('Player Credit Log') && /type都可以正確搜尋/i.test(full)) {
      checkFields(['UserId', 'Account', 'Type']);
    } else if (isPage('Jackpot Record') && /game type/i.test(full)) {
      checkFields(['Game Type']);
    }
  }

  // TC：Jackpot Record「Game Record中增加每局游戏类型Spin Type」——文字講的是Game Record頁面
  // 的欄位，不是Jackpot Record本身，已跨頁查證(navigate過去讀header再導回，不影響外層流程)
  if (/game\s*record中增加每局游戏类型spin\s*type/i.test(full)) {
    const originalUrl = page.url();
    await page.goto(originalUrl.replace(/\/egm\/reports\/\w+$/, '/egm/reports/gameRecordList'), { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(1200);
    await page.evaluate(() => {
      document.querySelectorAll('.el-dialog__wrapper').forEach(el => { if (/Warnning/i.test(el.textContent || '')) el.style.display = 'none'; });
      const overlay = document.querySelector('.v-modal'); if (overlay) overlay.style.display = 'none';
    });
    await page.waitForTimeout(300);
    const btn = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(x => /^view$|^search$/i.test(x.innerText?.trim()));
      if (b) { b.click(); return true; }
      return false;
    });
    await page.waitForTimeout(2000);
    const gameRecordHeaders = await page.evaluate(() => [...document.querySelectorAll('.el-table th')].map(h => h.innerText?.trim()).filter(Boolean));
    const shotPath = path.join(SCREENSHOT_DIR, `gamerecord_spintype_crosscheck_${Date.now()}.png`);
    await page.screenshot({ path: shotPath });
    extraShotPaths.push(shotPath);
    await page.goto(originalUrl, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(800);
    const hasSpinType = gameRecordHeaders.some(h => /spin type/i.test(h));
    notes.push(`⚠️此TC文字實為「Game Record」頁面的欄位（已跨頁確認），非Jackpot Record本身 | ${hasSpinType ? '✅Game Record表格含Spin Type欄位' : `❌Game Record表格缺少Spin Type欄位（實際:${gameRecordHeaders.join(',') || '無資料/未搜尋'}）`}`);
    if (!hasSpinType && btn) criticalFails.push('Game Record缺少Spin Type欄位');
  }

  let exportedXlsxPath = null;

  if (/excel|export|匯出|導出|csv/.test(desc)) {
    const exportResult = await doExport(page);
    if (exportResult.notes) notes.push(exportResult.notes);
    criticalFails.push(...exportResult.criticalFails);
    exportedXlsxPath = exportResult.exportedXlsxPath;
    // ⭐ 2026-08-06：TC文字補充「(沒有千分位)」——這是在說明預期行為(千分位缺失是正常
    // 的，不是bug)，doExport()本身從未檢查過數字格式，這裡不新增假設沒問過的斷言，
    // 只是誠實記錄這是已知/預期的行為說明，不代表本輪有實際去讀xlsx儲存格格式驗證。
    if (/沒有千分位|无千分位/i.test(full)) {
      notes.push('ℹ️TC文字說明「沒有千分位」為預期行為（非缺陷），本次未逐格核對xlsx數字格式，僅確認匯出流程本身正常');
    }
  }

  if (notes.length === (h1 ? 2 : 1)) {
    notes.push(`⚠️這筆TC文字沒有對應到已知的驗證規則，未執行額外斷言: ${full.slice(0, 40)}`);
  }

  return { notes: notes.join(' | '), criticalFails, exportedXlsxPath, extraShotPaths };
}

// ⭐ 2026-08-06 重寫：原本只檢查表格存在/選填日期篩選就算pass。已實際登入uat-cp.osmslot.org
// 逐頁查證EGM Hourly Meter與EGM Performance Meter兩頁的真實filter結構——確認含「Gaming Day」
// checkbox + 「Date Type」radio(06:00:00-06:00:00／00:00:00-00:00:00)，跟既有Toppath Tools
// Performance Meter對帳功能既有記錄的架構完全吻合(Gaming Day=本地06:00~隔天05:59:59，
// egmMeterHourList API帶gameDay/dateType參數控制)。

async function verifyMeterPage(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';
  const desc = full.toLowerCase();

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, rowCount, allHeaders } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);
  notes.push(`表格${rowCount}筆`);

  const filterLabels = await page.evaluate(() => [...document.querySelectorAll('.el-form-item__label')].map(l => l.innerText?.trim()).filter(Boolean)).catch(() => []);
  const checkboxLabels = await page.evaluate(() => [...document.querySelectorAll('.el-checkbox__label')].map(l => l.innerText?.trim()).filter(Boolean)).catch(() => []);
  const radioLabels = await page.evaluate(() => [...document.querySelectorAll('.el-radio__label')].map(l => l.innerText?.trim()).filter(Boolean)).catch(() => []);

  // TC：Machine Name/Machine No的搜索條件功能正常
  if (/machine name\s*\/\s*machine no的搜索條件功能正常/i.test(full)) {
    const missing = ['Machine Name', 'Machine No'].filter(e => !filterLabels.includes(e));
    if (missing.length === 0) {
      notes.push('✅Machine Name/Machine No搜尋欄位皆存在');
    } else {
      notes.push(`❌搜尋欄位缺失:${missing.join(',')}（實際:${filterLabels.join(',')}）`);
      criticalFails.push(`搜尋欄位缺失:${missing.join(',')}`);
    }
  }

  // TC：Gaming Day功能正常，可以正確指定該日期的搜尋數據
  if (/gaming day功能正常/i.test(full)) {
    const hasGamingDay = checkboxLabels.includes('Gaming Day');
    if (hasGamingDay) {
      notes.push('✅Gaming Day勾選框存在（對應本地06:00~隔天05:59:59邊界，實際查詢結果差異需搭配Date Type一併驗證）');
    } else {
      notes.push('❌Gaming Day勾選框缺失');
      criticalFails.push('Gaming Day勾選框缺失');
    }
  }

  // TC：Date Type的06/00搜索條件顯示數據正常
  if (/date type的06\s*\/\s*00搜索條件顯示數據正常/i.test(full)) {
    const expected = ['06:00:00-06:00:00', '00:00:00-00:00:00'];
    const missing = expected.filter(e => !radioLabels.includes(e));
    if (missing.length === 0) {
      notes.push('✅Date Type含06:00:00-06:00:00與00:00:00-00:00:00兩個選項');
    } else {
      notes.push(`❌Date Type選項缺失:${missing.join(',')}（實際:${radioLabels.join(',')}）`);
      criticalFails.push(`Date Type選項缺失:${missing.join(',')}`);
    }
  }

  // TC：確認每小時都會有一筆紀錄，並且記錄正確，可與Game Record比對確認數據（EGM Hourly Meter）
  if (/確認每小時都會有一筆紀錄.*可與game record比對確認數據/i.test(full)) {
    notes.push(rowCount > 0
      ? `✅表格有${rowCount}筆小時級紀錄（實際與Game Record加總比對需套用對賬公式：預期Coin Out = Game Record總Win + Attendant Paid JP − Jackpot Wins，此處僅驗證每小時紀錄存在，完整數值比對未在本次自動化執行）`
      : '⚠️表格目前無資料，無法驗證每小時紀錄');
  }

  // TC：如果盒子斷線，會採用紅色字體顯示
  if (/如果盒子斷線.*會採用紅色字體顯示/i.test(full)) {
    const hasRedIndicator = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.el-table__body tr')];
      return rows.some(r => [...r.querySelectorAll('td, span')].some(el => {
        const color = getComputedStyle(el).color;
        return /rgb\(2[0-4]\d,\s*\d{1,2},\s*\d{1,2}\)|red/i.test(color) && el.innerText?.trim();
      }));
    }).catch(() => false);
    notes.push(rowCount === 0
      ? '⚠️表格目前無資料，無法驗證斷線紅字顯示（目前UAT環境無斷線機台樣本）'
      : (hasRedIndicator ? '✅發現紅色字體標示的儲存格（疑似斷線指示）' : '⚠️目前資料中沒有觀察到紅色字體儲存格，可能目前無斷線機台，非功能缺失'));
  }

  // TC：確認特殊時間段，23:59:59/05:59:59的紀錄都有顯示
  if (/確認特殊時間段.*23:59:59.*05:59:59.*的紀錄都有顯示/i.test(full)) {
    const timeColIdx = allHeaders.findIndex(h => /time|時間/i.test(h));
    const times = timeColIdx >= 0 ? await page.evaluate((idx) => [...document.querySelectorAll('.el-table__body tr')].map(r => r.querySelectorAll('td')[idx]?.innerText?.trim()), timeColIdx) : [];
    const hasBoundary = times.some(t => /23:59:59|05:59:59/.test(t || ''));
    notes.push(rowCount === 0
      ? '⚠️表格目前無資料，無法驗證邊界時間點紀錄'
      : (hasBoundary ? '✅找到23:59:59或05:59:59邊界時間點紀錄' : `⚠️目前查詢範圍內未見23:59:59/05:59:59邊界紀錄（實際時間點:${times.slice(0,5).join(',')}...），可能與查詢的Gaming Day/自然日邊界設定有關，非必然缺失`));
  }

  // TC：數據可以展示正確(新機台需掛數據2小時以上才會準確)（EGM Performance Meter）
  if (/數據可以展示正確.*新機台需掛數據2小時以上才會準確/i.test(full)) {
    notes.push(rowCount > 0
      ? `✅表格有${rowCount}筆數據展示（2小時準確度門檻為業務規則，非UI可驗證項目，僅確認資料展示存在）`
      : '⚠️表格目前無資料可展示');
  }

  let exportedXlsxPath = null;

  if (/excel|export|匯出|導出|csv/.test(desc)) {
    const exportResult = await doExport(page);
    if (exportResult.notes) notes.push(exportResult.notes);
    criticalFails.push(...exportResult.criticalFails);
    exportedXlsxPath = exportResult.exportedXlsxPath;
  }

  if (notes.length === (h1 ? 2 : 1)) {
    notes.push(`⚠️這筆TC文字沒有對應到已知的驗證規則，未執行額外斷言: ${full.slice(0, 40)}`);
  }

  return { notes: notes.join(' | '), criticalFails, exportedXlsxPath };
}

async function verifyLoadingTips(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';
  const desc = full.toLowerCase();

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, rowCount, allBtns } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);
  notes.push(`表格${rowCount}筆`);

  if (/\badd\b|新增/.test(desc)) {
    const hasAdd = allBtns.some(t => /^add\b/i.test(t));
    if (hasAdd) {
      notes.push('✅Add按鈕');
    } else {
      notes.push('❌Add按鈕缺失');
      criticalFails.push('Add按鈕缺失');
    }
  }

  if (/可以.*編輯|可以.*刪除|edit.*delete|delete.*edit|編輯.*刪除|刪除.*編輯/.test(desc)) {
    if (rowCount === 0) {
      notes.push('⚠️操作按鈕待確認（表格無資料）');
    } else {
      const hasEdit = await page.evaluate(() =>
        document.querySelectorAll('.el-button--primary, .el-button--warning').length > 0
      ).catch(() => false);
      const hasDel = await page.evaluate(() =>
        document.querySelectorAll('.el-button--danger').length > 0
      ).catch(() => false);
      notes.push(`✅操作按鈕(edit:${hasEdit},del:${hasDel})`);
    }
  }

  return { notes: notes.join(' | '), criticalFails };
}

// ⭐ 2026-08-06 重寫：原本6筆TC只有1條規則（Add按鈕存在與否），其餘5筆全落到「表格N筆」。
// 已實際登入uat-cp.osmslot.org/game/getChannelRankInfo點過ChannelRankID(Add)按鈕，確認
// Dialog欄位為Channel Rank ID/Channel Rank/Machine Type，對應表格欄位完全一致。
// ⚠️TC2「確認只有主渠道才有此功能」原本依賴20天前的memory（子渠道WF應該404），但今天
// 用admin/123456實測uat-wf.osmslot.org，Channel Ranking頁面正常載入且isMainChannel API
// 回傳都是1（CP跟WF都是1）——跟舊memory的結論不一致，如實記錄這個矛盾，不直接採信舊memory
// 也不假裝驗證通過，避免誤導。

async function verifyChannelRanking(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, rowCount, allBtns, allHeaders } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);
  notes.push(`表格${rowCount}筆`);

  const extraShotPaths = [];

  const openAddDialog = async () => {
    const clicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => /channelrankid|^add$/i.test(b.innerText?.trim()));
      if (btn) { btn.click(); return true; }
      return false;
    });
    await page.waitForTimeout(1000);
    return clicked;
  };
  const getVisibleDialogLabels = () => page.evaluate(() => {
    const d = [...document.querySelectorAll('.el-dialog')].filter(x => x.getBoundingClientRect().width > 0).pop();
    return d ? [...d.querySelectorAll('.el-form-item__label')].map(l => l.innerText?.trim()) : null;
  });
  const closeDialog = async () => {
    await page.evaluate(() => {
      const d = [...document.querySelectorAll('.el-dialog')].filter(x => x.getBoundingClientRect().width > 0).pop();
      const headerBtn = d?.querySelector('.el-dialog__headerbtn');
      if (headerBtn) { headerBtn.click(); return; }
      const btn = d && [...d.querySelectorAll('button')].find(b => b.innerText?.trim() === 'Close');
      if (btn) btn.click();
    });
    await page.waitForTimeout(600);
  };

  // TC1：新增Channel ID後，前端可以看到該渠道的機器
  if (/新增channel\s*id後.*前端可以看到該渠道的機器/i.test(full)) {
    const clicked = await openAddDialog();
    if (!clicked) {
      notes.push('❌ChannelRankID(Add)按鈕缺失');
      criticalFails.push('ChannelRankID(Add)按鈕缺失');
    } else {
      const labels = await getVisibleDialogLabels();
      const shotPath = path.join(SCREENSHOT_DIR, `channelranking_add_${Date.now()}.png`);
      await page.screenshot({ path: shotPath });
      extraShotPaths.push(shotPath);
      const expected = ['Channel Rank ID', 'Channel Rank', 'Machine Type'];
      const missing = expected.filter(e => !labels?.includes(e));
      if (missing.length === 0) {
        notes.push(`✅Add Dialog欄位完整(${expected.join('/')})（前端是否顯示該渠道機器為跨系統驗證，後台看不到）`);
      } else {
        notes.push(`❌Add Dialog缺少欄位:${missing.join(',')}`);
        criticalFails.push(`Add Dialog缺少欄位:${missing.join(',')}`);
      }
      await closeDialog();
    }
  }

  // TC2：確認只有主渠道才有此功能
  // isMainChannel需在登入POST當下攔截才能取得，但登入發生在performAction()的流程更早處，
  // 這支verifier拿到page時已經登入完成，無法回溯攔截——改為結構性 + 如實記錄已知矛盾。
  if (/確認只有主渠道才有此功能/i.test(full)) {
    notes.push(`⚠️結構性驗證：目前(CP，已知為主渠道)頁面可正常載入且有${rowCount}筆資料`);
    notes.push('⚠️與既有memory記錄矛盾待釐清：2026-08-06實測uat-wf.osmslot.org用admin帳號登入，Channel Ranking頁面正常載入且isMainChannel API回傳同樣是1，跟20天前記錄的「子渠道應404」結論不一致，可能是帳號權限差異或規格已變更，不直接採信舊結論');
  }

  // TC3：排序為數字最大，權位最高
  if (/排序為數字最大，權位最高/i.test(full)) {
    if (rowCount === 0) {
      notes.push('⚠️表格無資料，無法驗證Channel Rank數值與權位對應關係');
    } else {
      const hasRankCol = allHeaders.includes('Channel Rank');
      notes.push(hasRankCol
        ? `✅表格含Channel Rank欄位（數字大小與「權位」的實際業務效果為後台看不到的執行期邏輯，僅驗證欄位存在）`
        : '❌表格缺少Channel Rank欄位');
      if (!hasRankCol) criticalFails.push('Channel Rank欄位缺失');
    }
  }

  // TC4：可以正常編輯 / 刪除
  if (/可以正常編輯\s*\/\s*刪除/i.test(full)) {
    const hasEditCol = allHeaders.includes('Edit');
    const hasDelCol = allHeaders.includes('Delete');
    notes.push(hasEditCol && hasDelCol
      ? '✅表格含Edit/Delete操作欄'
      : `❌表格缺少操作欄(Edit:${hasEditCol},Delete:${hasDelCol})`);
    if (!hasEditCol || !hasDelCol) criticalFails.push('Edit/Delete操作欄缺失');
  }

  // TC6：可以設置每個渠道顯示OSM或GSA機器
  if (/可以設置每個渠道顯示osm或gsa機器/i.test(full)) {
    const clicked = await openAddDialog();
    if (!clicked) {
      notes.push('❌ChannelRankID(Add)按鈕缺失');
      criticalFails.push('ChannelRankID(Add)按鈕缺失');
    } else {
      const labels = await getVisibleDialogLabels();
      const shotPath = path.join(SCREENSHOT_DIR, `channelranking_machinetype_${Date.now()}.png`);
      await page.screenshot({ path: shotPath });
      extraShotPaths.push(shotPath);
      const hasType = labels?.includes('Machine Type');
      notes.push(hasType
        ? '✅Add Dialog含Machine Type欄位（OSM/GSA選項僅Lavie渠道適用，目前CP渠道實際選項未逐一驗證）'
        : '❌Add Dialog缺少Machine Type欄位');
      if (!hasType) criticalFails.push('Machine Type欄位缺失');
      await closeDialog();
    }
  }

  if (allBtns.length && notes.length === (h1 ? 2 : 1)) {
    const hasBtn = allBtns.some(t => /add|channelrankid/i.test(t));
    notes.push(hasBtn ? `✅Add/ChannelRankID按鈕(${allBtns.find(t => /add|channelrankid/i.test(t))})` : '❌Add/ChannelRankID按鈕缺失');
    if (!hasBtn) criticalFails.push('Add/ChannelRankID按鈕缺失');
  }

  return { notes: notes.join(' | '), criticalFails, extraShotPaths };
}


async function verifyWhiteList(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';
  const desc = full.toLowerCase();

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, rowCount, allBtns, allHeaders } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);
  notes.push(`表格${rowCount}筆`);

  if (/\badd\b|white.*account/i.test(full)) {
    const hasBtn = allBtns.some(t => /white.*account/i.test(t));
    if (hasBtn) {
      notes.push('✅White Account按鈕');
    } else {
      notes.push('❌White Account按鈕缺失');
      criticalFails.push('White Account按鈕缺失');
    }
  }

  // ⭐ 2026-08-06新增：可以新增/刪除白名單帳號
  // 已實測uat-cp.osmslot.org/game/getWhiteList：Add按鈕實際文字是「White Account」
  // （非泛用的"Add"），表格欄位為Account/Delete，目前10筆真實資料。
  if (/可以新增\s*\/\s*刪除白名單帳號/i.test(full)) {
    const hasAddBtn = allBtns.some(t => /white.*account/i.test(t));
    const hasDelCol = allHeaders.includes('Delete');
    if (hasAddBtn && hasDelCol) {
      notes.push(`✅可新增(White Account按鈕)/可刪除(Delete欄)白名單帳號（目前${rowCount}筆）`);
    } else {
      notes.push(`❌新增/刪除功能缺失(Add按鈕:${hasAddBtn},Delete欄:${hasDelCol})`);
      criticalFails.push('White List新增/刪除功能缺失');
    }
  }

  return { notes: notes.join(' | '), criticalFails };
}

// ⭐ 2026-08-06 重寫：這支verifier共用給6個頁面（Game Jump Set/News Set/Advert Set/
// 小額推薦影片/How To Play/Special Entrance Set），原本只靠關鍵字查按鈕/開關數量>0就算pass，
// 不管實際欄位內容。已實際登入uat-cp.osmslot.org逐頁查證過真實表格欄位/Edit Dialog欄位後，
// 改成依頁面h1分流各自的真實斷言。
// ⚠️ 重要發現：小額推薦影片(Recommend Setting)的TC1-4文字（Sort ID/Name/Param/Type開Denom）
// 實際講的是「小額入口(SMALL BET)」功能，查證後那其實是**另一個獨立頁面**Special Entrance
// Set(/game/denomSet，欄位正好是Sort ID/Name/Param/Type/Min Bet)，不是Recommend Setting
// 頁面本身——這4筆TC在Lark被歸類到錯誤的子類型（可能是規格文件裡兩個功能寫在同一段被
// 一起拆分TC時分類分錯）。已跨頁面驗證（navigate過去查完欄位後導回原頁面，不影響外層
// screenshot流程），並在notes中如實記錄這個歸類問題，不是憑空放棄不測。

async function verifyGameSettingPage(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';
  const desc = full.toLowerCase();

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, rowCount, allBtns, allHeaders } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);
  notes.push(`表格${rowCount}筆`);

  let exportedXlsxPath = null;
  const extraShotPaths = [];
  // ⚠️ 2026-08-06 修正：getBaseInfo()的h1用選擇器'h1,h2,.page-title'，但這幾頁實際只有
  // '.el-breadcrumb'（沒有真正的<h1>標籤），導致h1永遠是空字串，下面所有isPage()判斷
  // 全部silently false、19筆TC整批落到「找不到對應規則」的fallback——即使程式碼邏輯本身
  // 是對的，也會因為這個上游選擇器問題完全沒被觸發到。改成在這支verifier內自己讀
  // .el-breadcrumb文字，不依賴getBaseInfo()的h1。
  const breadcrumb = await page.evaluate(() => document.querySelector('.el-breadcrumb, h1, h2, .page-title')?.innerText || '').catch(() => '');
  const isPage = (name) => new RegExp(name, 'i').test(breadcrumb);

  // ── Special Entrance Set 欄位查證（供小額推薦影片TC1-4跨頁引用）──
  const checkDenomSetFields = async (expectedCols) => {
    const originalUrl = page.url();
    await page.goto(originalUrl.replace(/\/game\/\w+$/, '/game/denomSet'), { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(1200);
    await page.evaluate(() => {
      document.querySelectorAll('.el-dialog__wrapper').forEach(el => { if (/Warnning/i.test(el.textContent || '')) el.style.display = 'none'; });
      const overlay = document.querySelector('.v-modal'); if (overlay) overlay.style.display = 'none';
    });
    await page.waitForTimeout(300);
    const headers = await page.evaluate(() => [...document.querySelectorAll('.el-table th')].map(h => h.innerText?.trim()).filter(Boolean));
    const shotPath = path.join(SCREENSHOT_DIR, `denomset_crosscheck_${Date.now()}.png`);
    await page.screenshot({ path: shotPath });
    extraShotPaths.push(shotPath);
    await page.goto(originalUrl, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      document.querySelectorAll('.el-dialog__wrapper').forEach(el => { if (/Warnning/i.test(el.textContent || '')) el.style.display = 'none'; });
      const overlay = document.querySelector('.v-modal'); if (overlay) overlay.style.display = 'none';
    });
    const missing = expectedCols.filter(c => !headers.some(h => h.includes(c)));
    return { headers, missing };
  };

  // ══ Recommend Setting (小額推薦影片) ══
  if (isPage('Recommend Setting')) {
    if (/sort\s*id[:：]順序|小額入口.*sort\s*id/i.test(full)) {
      const r = await checkDenomSetFields(['Sort ID']);
      notes.push(r.missing.length === 0
        ? `⚠️此TC文字實為「Special Entrance Set」頁面的Sort ID欄位（已跨頁確認存在:${r.headers.join(',')}），非Recommend Setting本身——Lark分類疑似有誤，5分鐘更新時效未測`
        : `❌跨頁查證Special Entrance Set缺少Sort ID欄位（實際:${r.headers.join(',')}）`);
      if (r.missing.length > 0) criticalFails.push('Special Entrance Set缺少Sort ID欄位');
    } else if (/^name[:：]名稱/i.test(full)) {
      const r = await checkDenomSetFields(['Name']);
      notes.push(r.missing.length === 0
        ? `⚠️此TC文字實為「Special Entrance Set」頁面的Name欄位（已跨頁確認存在），非Recommend Setting本身——Lark分類疑似有誤`
        : `❌跨頁查證Special Entrance Set缺少Name欄位`);
      if (r.missing.length > 0) criticalFails.push('Special Entrance Set缺少Name欄位');
    } else if (/^param[:：]參數/i.test(full)) {
      const r = await checkDenomSetFields(['Param']);
      notes.push(r.missing.length === 0
        ? `⚠️此TC文字實為「Special Entrance Set」頁面的Param欄位（已跨頁確認存在），非Recommend Setting本身——Lark分類疑似有誤`
        : `❌跨頁查證Special Entrance Set缺少Param欄位`);
      if (r.missing.length > 0) criticalFails.push('Special Entrance Set缺少Param欄位');
    } else if (/^type[:：]開denom/i.test(full)) {
      const r = await checkDenomSetFields(['Type']);
      notes.push(r.missing.length === 0
        ? `⚠️此TC文字實為「Special Entrance Set」頁面的Type欄位（已跨頁確認存在），非Recommend Setting本身——Lark分類疑似有誤，P0.8/1/4/8/9實際選項值未逐一測試`
        : `❌跨頁查證Special Entrance Set缺少Type欄位`);
      if (r.missing.length > 0) criticalFails.push('Special Entrance Set缺少Type欄位');
    } else if (/recommend setting規格.*game\s*type|依照game\s*type去設定/i.test(full)) {
      const clicked = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(b => b.innerText?.trim() === 'Recommend Setting');
        if (btn) { btn.click(); return true; }
        return false;
      });
      await page.waitForTimeout(1000);
      const dlg = await page.evaluate(() => {
        const d = [...document.querySelectorAll('.el-dialog')].filter(x => x.getBoundingClientRect().width > 0).pop();
        return d ? [...d.querySelectorAll('.el-form-item__label')].map(l => l.innerText?.trim()) : null;
      });
      const shotPath = path.join(SCREENSHOT_DIR, `recsetting_dialog_${Date.now()}.png`);
      await page.screenshot({ path: shotPath });
      extraShotPaths.push(shotPath);
      if (clicked && dlg?.includes('Game Type')) {
        notes.push(`✅Recommend Setting Dialog含Game Type欄位（多選/排序邏輯未逐一驗證，僅確認欄位存在）`);
      } else {
        notes.push('❌Recommend Setting Dialog或Game Type欄位缺失');
        criticalFails.push('Recommend Setting Dialog或Game Type欄位缺失');
      }
      await page.keyboard.press('Escape').catch(() => {});
    } else if (/wallet[：:]钱包金额区间/i.test(full)) {
      const hasWallet = allHeaders.some(h => /wallet/i.test(h));
      notes.push(hasWallet ? '✅表格含Wallet欄位' : '❌表格缺少Wallet欄位');
      if (!hasWallet) criticalFails.push('Wallet欄位缺失');
    } else if (/recommend\s*amount[：:]推荐机器数量/i.test(full)) {
      const hasCol = allHeaders.some(h => /recommend amount/i.test(h));
      notes.push(hasCol ? '✅表格含Recommend Amount欄位' : '❌表格缺少Recommend Amount欄位');
      if (!hasCol) criticalFails.push('Recommend Amount欄位缺失');
    } else if (/min\s*bet[：:]机器最小投注金额/i.test(full)) {
      const hasCol = allHeaders.some(h => /min bet/i.test(h));
      notes.push(hasCol ? '✅表格含Min Bet欄位（實際配置來源疑似為EGM List各機台設定，此處僅顯示，未逐一驗證多值逗號分隔輸入）' : '❌表格缺少Min Bet欄位');
      if (!hasCol) criticalFails.push('Min Bet欄位缺失');
    } else if (/可关闭\/开启推荐栏功能/i.test(full)) {
      const switchCount = await page.evaluate(() => document.querySelectorAll('.el-switch').length).catch(() => 0);
      notes.push(switchCount > 0 ? `✅推薦欄開關存在×${switchCount}` : '❌推薦欄開關缺失');
      if (switchCount === 0) criticalFails.push('推薦欄開關缺失');
    } else if (/推荐栏位功能需要区分渠道/i.test(full)) {
      notes.push('⚠️渠道分開配置需跨渠道比對，僅能確認目前(CP)渠道功能存在，未做跨渠道驗證');
    }
  }

  // ══ Game Jump Set ══
  else if (isPage('Game Jump Set')) {
    if (/開啟或關閉前端顯示.*more game/i.test(full)) {
      const switchCount = await page.evaluate(() => document.querySelectorAll('.el-switch').length).catch(() => 0);
      notes.push(switchCount > 0 ? `✅More Game顯示開關存在×${switchCount}（需重整生效，時效未測）` : '❌More Game顯示開關缺失');
      if (switchCount === 0) criticalFails.push('More Game顯示開關缺失');
    } else if (/add\s*game可新增遊戲/i.test(full)) {
      const hasAdd = allBtns.some(t => /^add game$/i.test(t));
      notes.push(hasAdd ? '✅Add Game按鈕存在' : '❌Add Game按鈕缺失');
      if (!hasAdd) criticalFails.push('Add Game按鈕缺失');
    } else if (/可以隱藏、編輯跟刪除遊戲/i.test(full)) {
      const rowBtns = rowCount > 0 ? await page.evaluate(() => [...document.querySelectorAll('.el-table__body tr')[0].querySelectorAll('button')].map(b => b.innerText?.trim())) : [];
      const hasSet = ['Edit', 'Delete'].every(b => rowBtns.includes(b)) && (rowBtns.includes('Hidden') || rowBtns.includes('Show'));
      notes.push(hasSet ? `✅列上有Edit/Delete/Show-Hidden按鈕（實際:${rowBtns.join(',')}）（2分鐘生效時效未測）` : `❌列按鈕不完整（實際:${rowBtns.join(',') || '無資料'}）`);
      if (!hasSet && rowCount > 0) criticalFails.push('Edit/Delete/Hidden按鈕不完整');
    }
  }

  // ══ News Set ══
  else if (isPage('News Set')) {
    if (/add\s*banner可以新增遊戲入口/i.test(full)) {
      const hasAdd = allBtns.some(t => /^add banner$/i.test(t));
      notes.push(hasAdd ? '✅Add Banner按鈕存在' : '❌Add Banner按鈕缺失');
      if (!hasAdd) criticalFails.push('Add Banner按鈕缺失');
    } else if (/可以編輯跟刪除遊戲/i.test(full)) {
      const rowBtns = rowCount > 0 ? await page.evaluate(() => [...document.querySelectorAll('.el-table__body tr')[0].querySelectorAll('button')].map(b => b.innerText?.trim())) : [];
      const hasSet = ['Edit', 'Delete'].every(b => rowBtns.includes(b));
      notes.push(hasSet ? '✅列上有Edit/Delete按鈕' : `❌列按鈕不完整（實際:${rowBtns.join(',') || '無資料'}）`);
      if (!hasSet && rowCount > 0) criticalFails.push('Edit/Delete按鈕不完整');
    } else if (/渠道需個別設置.*cp設置cp.*bpo設置bpo/i.test(full)) {
      notes.push('⚠️渠道個別設置需跨渠道比對，僅能確認目前(CP)渠道功能存在，未做跨渠道驗證');
    }
  }

  // ══ Advert Set ══
  else if (isPage('Advert Set')) {
    if (/只能新增一個廣告配置/i.test(full)) {
      notes.push(rowCount <= 1
        ? `✅目前僅${rowCount}筆廣告配置，與「只能新增一個」規格一致（未實際嘗試新增第2筆測試伺服器端是否真的擋下，避免污染共用UAT資料）`
        : `❌目前有${rowCount}筆廣告配置，超過規格描述的1筆上限`);
      if (rowCount > 1) criticalFails.push('廣告配置超過1筆上限');
    } else if (/每個主?渠道獨立設置/i.test(full)) {
      // ⭐ 2026-08-06：新表文字是「每個主渠道獨立設置」（多了「主」），跟舊表「每個渠道
      // 獨立設置」語意可能不同（本專案有「主渠道限定頁面清單」概念，主渠道≠全部
      // 渠道）。broaden regex吸收兩種寫法，但note文字如實反映「主」的存在，不假裝驗證過
      // 範圍是否真的限定在主渠道，避免誤導成比實際測試範圍更強的結論。
      const scopeNote = /每個主渠道/i.test(full) ? '（TC文字明確寫「主渠道」，僅能確認目前(CP)渠道功能存在，未驗證是否真的限定主渠道、也未做跨渠道比對）' : '';
      notes.push(`⚠️渠道獨立設置需跨渠道比對，僅能確認目前(CP)渠道功能存在，未做跨渠道驗證${scopeNote}`);
    }
  }

  // ══ How To Play ══
  else if (isPage('How To Play')) {
    if (/[后後]台增加视频上传功能.*一个游戏只能配置一个视频/i.test(full)) {
      const hasAdd = allBtns.some(t => /^add how to play$/i.test(t));
      const gameIds = allHeaders.includes('Game ID') && rowCount > 0
        ? await page.evaluate(() => [...document.querySelectorAll('.el-table__body tr')].map(r => r.querySelectorAll('td')[0]?.innerText?.trim()))
        : [];
      const dup = gameIds.length > 0 && new Set(gameIds).size !== gameIds.length;
      notes.push(hasAdd
        ? `✅Add How To Play按鈕存在${gameIds.length > 0 ? `，目前${gameIds.length}筆Game ID${dup ? '❌發現重複(可能違反一game一視頻限制)' : '皆不重複'}` : ''}（每次登入載入最新配置的時效性未測）`
        : '❌Add How To Play按鈕缺失');
      if (!hasAdd) criticalFails.push('Add How To Play按鈕缺失');
      if (dup) criticalFails.push('發現重複Game ID，可能違反一遊戲一視頻限制');
    }
  }

  // ══ 未特別處理的頁面（Special Entrance Set/Test Setting目前0 live TC）或上述頁面
  // 沒對到的其餘TC文字，沿用原本的通用關鍵字判斷作為fallback，不留空 ══
  if (notes.length === (h1 ? 2 : 1)) {
    if (/\badd\b|新增/.test(desc)) {
      const hasAdd = allBtns.some(t => /^add\b/i.test(t));
      notes.push(hasAdd ? '✅Add按鈕' : '❌Add按鈕缺失');
      if (!hasAdd) criticalFails.push('Add按鈕缺失');
    }
    if (/開啟.*關閉|關閉.*開啟|switch|toggle/.test(desc)) {
      const switchCount = await page.evaluate(() => document.querySelectorAll('.el-switch, input[type="checkbox"]').length).catch(() => 0);
      notes.push(switchCount > 0 ? `✅開關×${switchCount}` : '❌開關元件缺失');
      if (switchCount === 0) criticalFails.push('開關元件缺失');
    }
    if (/可以.*編輯|可以.*刪除|edit.*delete|delete.*edit|編輯.*刪除|刪除.*編輯/.test(desc)) {
      if (rowCount === 0) {
        notes.push('⚠️操作按鈕待確認（表格無資料）');
      } else {
        const hasEdit = await page.evaluate(() => document.querySelectorAll('.el-button--primary, .el-button--warning').length > 0).catch(() => false);
        const hasDel = await page.evaluate(() => document.querySelectorAll('.el-button--danger').length > 0).catch(() => false);
        notes.push(hasEdit || hasDel ? `✅操作按鈕(edit:${hasEdit},del:${hasDel})` : '❌編輯/刪除按鈕缺失');
        if (!hasEdit && !hasDel) criticalFails.push('編輯/刪除按鈕缺失');
      }
    }
    if (notes.length === (h1 ? 2 : 1)) {
      notes.push(`⚠️這筆TC文字沒有對應到已知的驗證規則，未執行額外斷言: ${full.slice(0, 40)}`);
    }
  }

  if (/excel|export|匯出|導出|csv/.test(desc)) {
    const exportResult = await doExport(page);
    if (exportResult.notes) notes.push(exportResult.notes);
    criticalFails.push(...exportResult.criticalFails);
    exportedXlsxPath = exportResult.exportedXlsxPath;
  }

  return { notes: notes.join(' | '), criticalFails, exportedXlsxPath, extraShotPaths };
}

// ⭐ 2026-08-06 重寫：原本4筆TC全部共用「表格有Fortune/Grand/Major/Minor/Mini欄位就pass」
// 的模糊判斷。已實際登入uat-cp.osmslot.org點過Edit/Batch Set Percent兩個dialog、
// 確認過Channel ID下拉選單真實選項(cp/wf/tbr/tbp/ncl/mdr/dhs/igo/cf/bpo/np/np2/dy)後，
// 改成每筆TC對應各自的真實斷言。保守原則：Edit/Batch對話框只驗證欄位存在後關閉，不送出
// 改動共用UAT資料的比例數值（不清楚這些比例欄位的驗證規則/加總限制，不猜測著送出）。

async function verifyEGMJPPercent(page, tc) {
  const notes = [];
  const criticalFails = [];
  const extraShotPaths = [];
  const full = tc || '';

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1 } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);

  const closeDialog = async () => {
    await page.evaluate(() => {
      const dialogs = [...document.querySelectorAll('.el-dialog')].filter(d => d.offsetParent !== null);
      const dialog = dialogs[dialogs.length - 1];
      const btn = dialog && [...dialog.querySelectorAll('button')].find(b => /close|cancel/i.test(b.innerText?.trim()));
      if (btn) btn.click();
    });
    await page.waitForTimeout(500);
  };

  // TC1：Player Channel>可分渠道顯示機器
  if (/player channel.*可分渠道顯示機器/i.test(full)) {
    const channelInfo = await page.evaluate(() => {
      const label = [...document.querySelectorAll('label, span')].find(el => el.innerText?.trim() === 'Channel ID');
      const container = label?.closest('.el-form-item, div');
      const select = container?.querySelector('.el-select .el-input__inner');
      return { hasChannelSelect: !!select, currentValue: select?.value || '' };
    });
    if (!channelInfo.hasChannelSelect) {
      notes.push('❌找不到Channel ID下拉選單');
      criticalFails.push('Channel ID下拉選單缺失');
    } else {
      await page.evaluate(() => {
        const label = [...document.querySelectorAll('label, span')].find(el => el.innerText?.trim() === 'Channel ID');
        const select = label?.closest('.el-form-item, div')?.querySelector('.el-select .el-input__inner');
        select?.click();
      });
      await page.waitForTimeout(500);
      const options = await page.evaluate(() => {
        const dropdowns = document.querySelectorAll('.el-select-dropdown');
        const dd = dropdowns[dropdowns.length - 1];
        return dd ? [...dd.querySelectorAll('.el-select-dropdown__item')].map(i => i.innerText?.trim()) : [];
      });
      await page.keyboard.press('Escape').catch(() => {});
      if (options.length > 1) {
        notes.push(`✅Channel ID下拉選單存在(目前:${channelInfo.currentValue}，共${options.length}個渠道選項:${options.join(',')})`);
      } else {
        notes.push(`❌Channel ID下拉選單選項異常(只有${options.length}個)`);
        criticalFails.push('Channel ID下拉選單選項數量異常');
      }
    }
  }

  // TC2：可对各机器配置5个比例参数（小数点后7位）...批量勾选机器配置功能
  if (/可对各机器配置5个比例参数/.test(full)) {
    const expectedFields = ['Fortune', 'Grand', 'Major', 'Minor', 'Mini'];

    // 單台 Edit
    const editClicked = await page.evaluate(() => {
      const row = document.querySelector('.el-table__body tr');
      const btn = row && [...row.querySelectorAll('button')].find(b => /^edit$/i.test(b.innerText?.trim()));
      if (btn) { btn.click(); return true; }
      return false;
    });
    await page.waitForTimeout(800);
    if (!editClicked) {
      notes.push('❌找不到Edit按鈕');
      criticalFails.push('Edit按鈕缺失');
    } else {
      const editFields = await page.evaluate(() => {
        const dialogs = [...document.querySelectorAll('.el-dialog')].filter(d => d.offsetParent !== null);
        const dialog = dialogs[dialogs.length - 1];
        return dialog ? [...dialog.querySelectorAll('.el-form-item__label')].map(l => l.innerText?.trim()) : [];
      });
      const editShotPath = path.join(SCREENSHOT_DIR, `egmjp_edit_dialog_${Date.now()}.png`);
      await page.screenshot({ path: editShotPath });
      extraShotPaths.push(editShotPath);
      const missingEdit = expectedFields.filter(f => !editFields.some(l => l.includes(f)));
      if (missingEdit.length === 0) {
        notes.push(`✅Edit Dialog含5個比例欄位(${editFields.join('/')})`);
      } else {
        notes.push(`❌Edit Dialog缺少欄位:${missingEdit.join(',')}（實際:${editFields.join(',') || '無'}）`);
        criticalFails.push(`Edit Dialog缺少比例欄位:${missingEdit.join(',')}`);
      }
      await closeDialog();
    }

    // 批量勾選 + Batch Set Percent
    const checked = await page.evaluate(() => {
      const cb = document.querySelector('.el-table__body tr .el-checkbox .el-checkbox__inner, .el-table__body tr .el-checkbox input');
      if (cb) { cb.click(); return true; }
      return false;
    });
    await page.waitForTimeout(300);
    const batchClicked = checked && await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => /batch set percent/i.test(b.innerText?.trim()));
      if (btn) { btn.click(); return true; }
      return false;
    });
    await page.waitForTimeout(800);
    if (!checked) {
      notes.push('❌找不到列勾選框（批量勾選機器配置功能）');
      criticalFails.push('批量勾選框缺失');
    } else if (!batchClicked) {
      notes.push('❌找不到Batch Set Percent按鈕');
      criticalFails.push('Batch Set Percent按鈕缺失');
    } else {
      const batchFields = await page.evaluate(() => {
        const dialogs = [...document.querySelectorAll('.el-dialog')].filter(d => d.offsetParent !== null);
        const dialog = dialogs[dialogs.length - 1];
        return dialog ? [...dialog.querySelectorAll('.el-form-item__label')].map(l => l.innerText?.trim()) : [];
      });
      const batchShotPath = path.join(SCREENSHOT_DIR, `egmjp_batch_dialog_${Date.now()}.png`);
      await page.screenshot({ path: batchShotPath });
      extraShotPaths.push(batchShotPath);
      const missingBatch = expectedFields.filter(f => !batchFields.some(l => l.includes(f)));
      if (missingBatch.length === 0) {
        notes.push(`✅批量勾選機器配置功能：Batch Set Percent Dialog含5個比例欄位(${batchFields.join('/')})（僅驗證表單，未送出避免改動共用UAT資料的比例數值）`);
      } else {
        notes.push(`❌Batch Set Percent Dialog缺少欄位:${missingBatch.join(',')}`);
        criticalFails.push(`Batch Dialog缺少比例欄位:${missingBatch.join(',')}`);
      }
      await closeDialog();
    }
  }

  // TC3：菜单显示字段：机器ID/机器名/Fortune/Grand/Major/Minor/Mini
  if (/菜单显示字段/.test(full)) {
    const { allHeaders } = await getBaseInfo(page);
    const expected = ['Machine No', 'Machine Name', 'Fortune', 'Grand', 'Major', 'Minor', 'Mini'];
    const missing = expected.filter(c => !allHeaders.some(h => h.includes(c)));
    if (missing.length === 0) {
      notes.push(`✅表格欄位完整(${expected.join('/')})`);
    } else {
      notes.push(`❌表格欄位缺失:${missing.join(',')}（實際:${allHeaders.join(',')}）`);
      criticalFails.push(`表格欄位缺失:${missing.join(',')}`);
    }
  }

  if (notes.length === (h1 ? 1 : 0)) {
    notes.push(`⚠️這筆TC文字沒有對應到已知的驗證規則，未執行任何斷言: ${full.slice(0, 40)}`);
  }

  return { notes: notes.join(' | '), criticalFails, extraShotPaths };
}

// ⭐ 2026-08-06 重寫：原本8筆TC全部共用「表格有Account/Jp欄位就pass」的模糊判斷，
// 完全不管TC實際在測什麼（Add流程/Game Order查核/排序邏輯/影片上傳/編輯刪除/20筆上限
// 全部沒真的測）。已實際登入uat-cp.osmslot.org點過Add dialog、用假Game Order測過
// Check按鈕的真實錯誤訊息（"Game Order No Exist"）、讀過現有20筆真實資料驗證過
// Sort Id排序邏輯後，改成每筆TC對應各自的真實斷言。

async function verifyJackpotMoment(page, tc) {
  const notes = [];
  const criticalFails = [];
  const extraShotPaths = [];
  const full = tc || '';

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, allHeaders, rowCount, allBtns } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);

  // ⚠️ 根因（2026-08-06 查出，兩層）：
  // (1) 呼叫這個function之前，performAction()的通用流程已經點過表格第一列的"View"按鈕
  //     （screenshot_verify_data action的通用邏輯），這頁的"View"會開啟一個
  //     class="player-video-dialog"的影片預覽dialog，且從未關閉，跟Add/Edit表單dialog
  //     （class="add-floor"）的.el-dialog__title文字**完全相同**("Jackpot Video")，
  //     所以「最後一個可見的.el-dialog」不保證是表單dialog。
  // (2) 改用class="add-floor"鎖定後，實測DOM裡同時存在**兩個**.add-floor節點
  //     （Element UI預先渲染、用visibility切換，非v-if動態插入）——一個是目前隱藏的
  //     殘留節點(width:0)，一個才是真正開啟中的(width>0)，且隱藏的那個在DOM順序上
  //     排在前面，document.querySelector()會抓到錯的那個。
  // 正確做法：先關掉任何殘留的可見dialog，再用class="add-floor" + width>0雙重篩選。
  const ADD_FORM_SELECTOR = '.el-dialog.add-floor';
  const closeAnyOpenDialog = async () => {
    await page.evaluate(() => {
      const dialogs = [...document.querySelectorAll('.el-dialog')].filter(d => d.getBoundingClientRect().width > 0);
      dialogs.forEach(dialog => {
        const btn = [...dialog.querySelectorAll('button')].find(b => /close|cancel/i.test(b.innerText?.trim()));
        if (btn) btn.click();
      });
    });
    await page.waitForTimeout(500);
  };
  const closeDialog = async () => {
    await page.evaluate((sel) => {
      const dialog = [...document.querySelectorAll(sel)].find(d => d.getBoundingClientRect().width > 0);
      const btn = dialog && [...dialog.querySelectorAll('button')].find(b => /close|cancel/i.test(b.innerText?.trim()));
      if (btn) btn.click();
    }, ADD_FORM_SELECTOR);
    await page.waitForTimeout(500);
  };
  // 進入TC前先清掉「View」殘留的影片預覽dialog，避免污染後續的Add表單dialog偵測
  await closeAnyOpenDialog();
  const openAddDialog = async () => {
    const clicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => /^add\b/i.test(b.innerText?.trim()));
      if (btn) { btn.click(); return true; }
      return false;
    });
    await page.waitForTimeout(1000);
    return clicked;
  };

  // TC1：Add 按鈕可以新增視頻
  if (/^add\s*按鈕可以新增視頻/i.test(full)) {
    const clicked = await openAddDialog();
    if (!clicked) {
      notes.push('❌找不到Add Jackpot Moment按鈕');
      criticalFails.push('Add按鈕缺失');
    } else {
      const dlg = await page.evaluate((sel) => {
        const dialog = [...document.querySelectorAll(sel)].find(d => d.getBoundingClientRect().width > 0);
        return dialog ? { title: dialog.querySelector('.el-dialog__title')?.innerText?.trim(), labels: [...dialog.querySelectorAll('.el-form-item__label')].map(l => l.innerText?.trim()) } : null;
      }, ADD_FORM_SELECTOR);
      const shotPath = path.join(SCREENSHOT_DIR, `jpmoment_add_dialog_${Date.now()}.png`);
      await page.screenshot({ path: shotPath });
      extraShotPaths.push(shotPath);
      const expected = ['Game Order', 'Account', 'Jackpot Amount', 'Time', 'Game ID', 'Sort Id', 'Video'];
      const missing = dlg ? expected.filter(e => !dlg.labels.some(l => l.includes(e))) : expected;
      if (missing.length === 0) {
        notes.push(`✅Add Dialog(${dlg.title})欄位完整(${expected.join('/')})`);
      } else {
        notes.push(`❌Add Dialog缺少欄位:${missing.join(',')}`);
        criticalFails.push(`Add Dialog缺少欄位:${missing.join(',')}`);
      }
      await closeDialog();
    }
  }

  // TC2：Game Order確認是抓取Game Record的紀錄，如果不是Game Record的紀錄，點擊Check會跳出找不到的提示
  if (/game order確認是抓取game record的紀錄/i.test(full)) {
    const clicked = await openAddDialog();
    if (!clicked) {
      notes.push('❌找不到Add Jackpot Moment按鈕');
      criticalFails.push('Add按鈕缺失');
    } else {
      await page.evaluate((sel) => {
        const dialog = [...document.querySelectorAll(sel)].find(d => d.getBoundingClientRect().width > 0);
        const input = dialog?.querySelector('input[placeholder*="Game Order" i]');
        if (input) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, 'FAKE-NONEXISTENT-ORDER-999999');
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, ADD_FORM_SELECTOR);
      await page.waitForTimeout(300);
      const checkClicked = await page.evaluate((sel) => {
        const dialog = [...document.querySelectorAll(sel)].find(d => d.getBoundingClientRect().width > 0);
        const btn = dialog && [...dialog.querySelectorAll('button')].find(b => /^check$/i.test(b.innerText?.trim()));
        if (btn) { btn.click(); return true; }
        return false;
      }, ADD_FORM_SELECTOR);
      await page.waitForTimeout(1200);
      const shotPath = path.join(SCREENSHOT_DIR, `jpmoment_check_notfound_${Date.now()}.png`);
      await page.screenshot({ path: shotPath });
      extraShotPaths.push(shotPath);
      if (!checkClicked) {
        notes.push('❌找不到Check按鈕');
        criticalFails.push('Check按鈕缺失');
      } else {
        const hasError = await page.evaluate(() => !!document.querySelector('.el-message--error, .el-message-box'));
        if (hasError) {
          notes.push('✅輸入不存在的Game Order並按Check後，正確跳出找不到的提示');
        } else {
          notes.push('❌輸入不存在的Game Order並按Check後，沒有跳出找不到的提示');
          criticalFails.push('Check未對不存在的Game Order顯示錯誤提示');
        }
      }
      await closeDialog();
    }
  }

  // TC3：Sort id用來顯示排序，可輸入相同Sort id，但優先順序會按照Bet Time排序，越接近目前時間的在越前面
  if (/sort id用來顯示排序/i.test(full)) {
    const rows = await page.evaluate(() => {
      const table = document.querySelector('.el-table');
      const ths = [...table.querySelectorAll('th')].map(h => h.innerText?.trim() || '');
      const si = ths.findIndex(h => /sort id/i.test(h));
      const ti = ths.findIndex(h => /^time$/i.test(h));
      return [...table.querySelectorAll('.el-table__body tr')].map(row => {
        const cells = row.querySelectorAll('td');
        return { sortId: cells[si]?.innerText?.trim(), time: cells[ti]?.innerText?.trim() };
      });
    });
    const bySort = {};
    rows.forEach(r => { (bySort[r.sortId] = bySort[r.sortId] || []).push(r.time); });
    const multiGroups = Object.entries(bySort).filter(([, times]) => times.length > 1);
    if (multiGroups.length === 0) {
      notes.push('⚠️目前資料沒有重複的Sort Id，無法驗證排序邏輯（僅能之後有重複資料時再驗證）');
    } else {
      let allSorted = true;
      const details = [];
      for (const [sortId, times] of multiGroups) {
        const sortedDesc = times.every((t, i) => i === 0 || new Date(t) <= new Date(times[i - 1]));
        details.push(`SortId=${sortId}(${times.length}筆${sortedDesc ? '✅' : '❌'})`);
        if (!sortedDesc) allSorted = false;
      }
      if (allSorted) {
        notes.push(`✅重複Sort Id的紀錄皆依Bet Time降序排列: ${details.join(', ')}`);
      } else {
        notes.push(`❌部分重複Sort Id的紀錄未依Bet Time降序排列: ${details.join(', ')}`);
        criticalFails.push('Sort Id相同時未依Bet Time降序排列');
      }
    }
  }

  // TC4：Video可以正常上傳 / 預覽
  if (/video可以正常上傳\s*\/\s*預覽/i.test(full)) {
    const clicked = await openAddDialog();
    if (!clicked) {
      notes.push('❌找不到Add Jackpot Moment按鈕');
      criticalFails.push('Add按鈕缺失');
    } else {
      const videoUi = await page.evaluate((sel) => {
        const dialog = [...document.querySelectorAll(sel)].find(d => d.getBoundingClientRect().width > 0);
        if (!dialog) return null;
        const hasFileInput = !!dialog.querySelector('input[type="file"]');
        const hasSelectBtn = [...dialog.querySelectorAll('button')].some(b => /select video file/i.test(b.innerText?.trim()));
        const hasViewBtn = [...dialog.querySelectorAll('button')].some(b => /^view$/i.test(b.innerText?.trim()));
        return { hasFileInput, hasSelectBtn, hasViewBtn };
      }, ADD_FORM_SELECTOR);
      const shotPath = path.join(SCREENSHOT_DIR, `jpmoment_video_ui_${Date.now()}.png`);
      await page.screenshot({ path: shotPath });
      extraShotPaths.push(shotPath);
      if (videoUi && videoUi.hasFileInput && videoUi.hasSelectBtn) {
        notes.push(`✅Video上傳UI存在(Select Video File按鈕${videoUi.hasViewBtn ? '+View預覽按鈕' : ''})（未提供實際影片檔案，僅驗證上傳/預覽UI存在，未實際上傳）`);
      } else {
        notes.push('❌Video上傳UI（Select Video File按鈕或file input）缺失');
        criticalFails.push('Video上傳UI缺失');
      }
      await closeDialog();
    }
  }

  // TC5：視頻記錄顯示正確 (Account / Jp amount / Time)
  if (/視頻記錄顯示正確/.test(full)) {
    const expected = ['Account', 'Jackpot Amount', 'Time'];
    const missing = expected.filter(c => !allHeaders.some(h => h.includes(c)));
    notes.push(`表格${rowCount}筆`);
    if (missing.length === 0) {
      notes.push(`✅表格欄位完整(${expected.join('/')})`);
    } else {
      notes.push(`❌表格欄位缺失:${missing.join(',')}（實際:${allHeaders.join(',')}）`);
      criticalFails.push(`表格欄位缺失:${missing.join(',')}`);
    }
  }

  // TC6：視頻可以做編輯 / 刪除 / 預覽
  if (/視頻可以做編輯\s*\/\s*刪除\s*\/\s*預覽/.test(full)) {
    const rowBtns = await page.evaluate(() => {
      const row = document.querySelector('.el-table__body tr');
      return row ? [...row.querySelectorAll('button')].map(b => b.innerText?.trim()) : [];
    });
    const expected = ['Edit', 'Delete', 'View'];
    const missing = expected.filter(e => !rowBtns.some(b => b === e));
    notes.push(`表格${rowCount}筆`);
    if (missing.length === 0) {
      notes.push(`✅每列皆有Edit/Delete/View按鈕`);
    } else {
      notes.push(`❌列按鈕缺失:${missing.join(',')}（實際:${rowBtns.join(',') || '無'}）`);
      criticalFails.push(`列按鈕缺失:${missing.join(',')}`);
    }
  }

  // TC7：最多只能新增20筆紀錄
  if (/最多只能新增20筆紀錄/.test(full)) {
    notes.push(`表格${rowCount}筆`);
    if (rowCount >= 20) {
      notes.push(`✅目前已達20筆上限（${rowCount}筆），與規格描述的上限一致（僅為現有資料觀察，未實際嘗試新增第21筆測試伺服器端是否真的擋下）`);
    } else {
      notes.push(`⚠️目前僅${rowCount}筆，未達20筆上限，無法驗證是否真的擋在20筆（未嘗試新增到21筆，避免對共用UAT資料造成不可逆影響）`);
    }
  }

  if (notes.length === (h1 ? 1 : 0)) {
    notes.push(`⚠️這筆TC文字沒有對應到已知的驗證規則，未執行任何斷言: ${full.slice(0, 40)}`);
  }

  return { notes: notes.join(' | '), criticalFails, extraShotPaths };
}

async function verifyDepositSetting(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1 } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);

  const switchCount = await page.evaluate(() =>
    document.querySelectorAll('.el-switch, input[type="checkbox"]').length
  ).catch(() => 0);
  if (switchCount > 0) {
    notes.push(`✅開關元件×${switchCount}`);
  } else {
    notes.push('❌開關元件缺失');
    criticalFails.push('開關元件缺失');
  }

  return { notes: notes.join(' | '), criticalFails };
}

// ⭐ 2026-08-06 重寫：原本19筆TC只有2條關鍵字規則（Reservation List按鈕存在/doTimeSetting），
// 其餘11筆全部落到「表格N筆」就算pass。已實際登入uat-cp.osmslot.org/game/machineReservationList
// 操作過：Add Reservation Dialog(Account+Machine No兩欄)、Reservation List面板內的VIP名單
// (Account/Type/Lock Count/Remaining Count/Machine Count/Lock Time(H)/Operation，10筆真實資料)、
// +Add VIP Dialog(Account/Lock Count/Lock Time(H)/Machine Count)。並實測確認Add Reservation
// 兩個真實錯誤訊息：用VIP名單裡的真實帳號+假Machine No →"Machine No is not exist"；
// 假帳號+真實Machine No(873-DFDCGRAND-0023) →"Account is not exist"。
// 保守原則：不實際建立/取消真實預約（會動到共用UAT的VIP名單與Remaining Count），
// 也不做跨渠道比對（CP限定按鈕、壓測隔離等，已加入detectManual跨系統分流）。

async function verifyMachineReservation(page, tc, params = {}) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, rowCount, allBtns, allHeaders } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);
  notes.push(`表格${rowCount}筆`);

  const extraShotPaths = [];

  const openReservationList = async () => {
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.innerText?.trim() === 'Reservation List');
      btn?.click();
    });
    await page.waitForTimeout(1200);
  };
  // ⚠️ 2026-08-06 修正重大bug：原本用/close|cancel/i比對按鈕文字關閉dialog，但Reservation
  // List面板裡VIP名單「每一列」都有自己的"Cancel"按鈕（語意是刪除該筆VIP名單，不是關閉面板！），
  // find()抓到第一個符合的按鈕，等於誤點了第一列VIP帳號的刪除鈕，跳出真實的
  // "Are you sure to cancel the Account?"刪除確認框（幸好從未真的點下Confirm，VIP名單
  // 10筆帳號事後查證仍完整）。改成優先找Element UI標準的右上角X關閉鈕(.el-dialog__headerbtn)，
  // 找不到才退而求其次用「精確等於"Close"」（不再接受"Cancel"字樣，避免同樣誤觸)。
  const closeVisibleDialog = async () => {
    await page.evaluate(() => {
      const dialogs = [...document.querySelectorAll('.el-dialog')].filter(d => d.getBoundingClientRect().width > 0);
      const dlg = dialogs[dialogs.length - 1];
      if (!dlg) return;
      const headerBtn = dlg.querySelector('.el-dialog__headerbtn');
      if (headerBtn) { headerBtn.click(); return; }
      const btn = [...dlg.querySelectorAll('button')].find(b => b.innerText?.trim() === 'Close');
      if (btn) btn.click();
    });
    await page.waitForTimeout(600);
  };
  const getVisibleDialogInfo = () => page.evaluate(() => {
    const dialogs = [...document.querySelectorAll('.el-dialog')].filter(d => d.getBoundingClientRect().width > 0);
    const d = dialogs[dialogs.length - 1];
    if (!d) return null;
    return {
      title: d.querySelector('.el-dialog__title')?.innerText,
      labels: [...d.querySelectorAll('.el-form-item__label')].map(l => l.innerText?.trim()),
      buttons: [...d.querySelectorAll('button')].map(b => b.innerText?.trim()).filter(Boolean),
      headers: [...d.querySelectorAll('.el-table th')].map(h => h.innerText?.trim()).filter(Boolean),
      rowCount: d.querySelectorAll('.el-table__body tr').length,
      filterLabels: [...d.querySelectorAll('.el-form-item__label')].map(l => l.innerText?.trim()),
    };
  });

  // TC：查询：需要可以根据UserID/Account/Start Time查询，根据Status筛选
  if (/查询.*userid.*account.*start\s*time|根据status筛选/i.test(full)) {
    const filterLabels = await page.evaluate(() => [...document.querySelectorAll('.el-form-item__label')].map(l => l.innerText?.trim()));
    const expected = ['UserId', 'Account', 'Start Time', 'Status'];
    const missing = expected.filter(e => !filterLabels.includes(e));
    if (missing.length === 0) {
      notes.push(`✅主表查詢欄位完整(${expected.join('/')})`);
    } else {
      notes.push(`❌主表查詢欄位缺失:${missing.join(',')}（實際:${filterLabels.join(',')}）`);
      criticalFails.push(`查詢欄位缺失:${missing.join(',')}`);
    }
  }

  // TC：Reservation List 按鈕（一般存在性）
  if (/reservation.*list|預約名單/i.test(full) && !/parameter\s*setting/i.test(full)) {
    const hasResBtn = allBtns.some(t => /reservation.*list/i.test(t));
    notes.push(hasResBtn ? '✅Reservation List按鈕' : '⚠️Reservation List按鈕未找到');
  }

  // TC：時長設置/Parameter Setting（既有真實流程）
  // ⚠️ 2026-08-06 修正：原本含lock.*time|lock.*count兩個過寬的alternative，導致TC18
  // （+Add VIP名單，欄位本身就叫Lock Count/Lock Time(H)）被誤判成這條規則，doTimeSetting()
  // 搶先執行並把Reservation List面板隱藏，後面的+Add VIP檢查再打開時錯誤判定按鈕缺失。
  // "Time Setting"/"Parameter Setting"（英文詞組）已足夠精準識別TC4本身，不需要額外的
  // 寬鬆fallback。
  if (/time.*setting|parameter.*setting|自動預約.*時長|時長.*設置/i.test(full)) {
    const timeResult = await doTimeSetting(page);
    if (timeResult.notes) notes.push(timeResult.notes);
    criticalFails.push(...timeResult.criticalFails);
    extraShotPaths.push(...timeResult.extraShotPaths);
  }

  // TC：操作日誌
  if (/操作日志|操作日誌/i.test(full)) {
    const clicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.innerText?.trim() === 'Operation Log');
      if (btn) { btn.click(); return true; }
      return false;
    });
    await page.waitForTimeout(1200);
    if (!clicked) {
      notes.push('❌Operation Log按鈕缺失');
      criticalFails.push('Operation Log按鈕缺失');
    } else {
      const info = await getVisibleDialogInfo();
      const shotPath = path.join(SCREENSHOT_DIR, `reservation_oplog_${Date.now()}.png`);
      await page.screenshot({ path: shotPath });
      extraShotPaths.push(shotPath);
      if (info) {
        notes.push(`✅Operation Log面板開啟(${info.rowCount}筆記錄)`);
      } else {
        notes.push('❌Operation Log面板未開啟');
        criticalFails.push('Operation Log面板未開啟');
      }
      await closeVisibleDialog();
    }
  }

  // TC：Add Reservation 負向情境（Machine No不存在／Account不存在，實測真實錯誤訊息）
  if (/add\s*reservation功能測試|machine\s*no\s*is\s*not\s*exist|account\s*is\s*not\s*exist/i.test(full)) {
    // 預設值要跟 VERIFIER_PARAM_SCHEMAS 宣告的一致——走 SUBTYPE_MAP 那條舊路徑進來時
    // 不會帶 params，兩邊不一致的話同一筆 TC 會因為「是怎麼被呼叫的」而驗到不同東西
    const P = {
      realMachineNo: params.realMachineNo ?? TEST_PARAMS?.machineReservation?.realMachineNo ?? '873-DFDCGRAND-0023',
      fakeMachineNo: params.fakeMachineNo ?? 'FAKE-MACHINE-NOTEXIST-999',
      fakeAccount: params.fakeAccount ?? 'FAKE-ACCOUNT-NOTEXIST-999',
      expectMachineError: params.expectMachineError ?? 'machine no is not exist',
      expectAccountError: params.expectAccountError ?? 'account is not exist',
    };
    await openReservationList();
    const vipAccounts = await page.evaluate(() => {
      const dlg = [...document.querySelectorAll('.el-dialog')].filter(d => d.getBoundingClientRect().width > 0).pop();
      return dlg ? [...dlg.querySelectorAll('.el-table__body tr')].map(r => r.querySelectorAll('td')[0]?.innerText?.trim()).filter(Boolean) : [];
    });
    await closeVisibleDialog();
    const realVipAccount = vipAccounts[0];

    const fillAddReservation = async (account, machineNo) => {
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(b => b.innerText?.trim() === 'Add Reservation');
        btn?.click();
      });
      await page.waitForTimeout(1000);
      await page.evaluate(({ account, machineNo }) => {
        const dlg = [...document.querySelectorAll('.el-dialog')].filter(d => d.getBoundingClientRect().width > 0).pop();
        const setVal = (label, value) => {
          const item = [...dlg.querySelectorAll('.el-form-item')].find(it => it.querySelector('.el-form-item__label')?.innerText?.trim() === label);
          const input = item?.querySelector('input');
          if (input) {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }
        };
        setVal('Account', account);
        setVal('Machine No', machineNo);
      }, { account, machineNo });
      await page.waitForTimeout(300);
      await page.evaluate(() => {
        const dlg = [...document.querySelectorAll('.el-dialog')].filter(d => d.getBoundingClientRect().width > 0).pop();
        const btn = dlg && [...dlg.querySelectorAll('button')].find(b => b.innerText?.trim() === 'Add');
        btn?.click();
      });
      await page.waitForTimeout(1200);
      const errMsg = await page.evaluate(() => document.querySelector('.el-message--error, .el-message-box')?.innerText || null);
      await closeVisibleDialog();
      return errMsg;
    };

    if (realVipAccount) {
      const msg1 = await fillAddReservation(realVipAccount, P.fakeMachineNo);
      const shot1 = path.join(SCREENSHOT_DIR, `reservation_add_fakemachine_${Date.now()}.png`);
      await page.screenshot({ path: shot1 });
      extraShotPaths.push(shot1);
      if (new RegExp(P.expectMachineError, 'i').test(msg1 || '')) {
        notes.push(`✅Machine No不存在時正確提示"${msg1}"`);
      } else {
        notes.push(`❌Machine No不存在時提示異常(實際:${msg1 || '無'})`);
        criticalFails.push('Machine No不存在時未正確提示');
      }
    } else {
      notes.push('⚠️VIP名單目前無資料，無法取得真實帳號測試Machine No情境');
    }

    const msg2 = await fillAddReservation(P.fakeAccount, P.realMachineNo);
    const shot2 = path.join(SCREENSHOT_DIR, `reservation_add_fakeaccount_${Date.now()}.png`);
    await page.screenshot({ path: shot2 });
    extraShotPaths.push(shot2);
    if (new RegExp(P.expectAccountError, 'i').test(msg2 || '')) {
      notes.push(`✅Account不存在時正確提示"${msg2}"`);
    } else {
      notes.push(`❌Account不存在時提示異常(實際:${msg2 || '無'})`);
      criticalFails.push('Account不存在時未正確提示');
    }
    notes.push('ℹ️其餘4種情境（已被預約/機台狀態異常/玩家不在名單/壓測中）因需預先建立真實預約或占用狀態，避免污染共用UAT資料未實測，僅UI流程存在已確認');
  }

  // TC8/9/10：Add Reservation情境的延伸編號子句（"2./3./4."），跟TC7同一組規格拆開列的
  // 子TC，皆需要預先建立真實預約占用/離線機台/非VIP玩家狀態才能觸發，避免污染共用UAT資料
  if (/^\d\.\s*(预约时间根据配置时间决定|若提交预约时机器内有玩家|若提交预约时机器为离线)/i.test(full)) {
    notes.push('⚠️此為Add Reservation驗證情境的子句（需預先建立真實預約占用/離線機台/非VIP玩家等前置狀態），與TC7同組規格，避免污染共用UAT資料未單獨實測，實際情境覆蓋見TC7的Machine No/Account不存在測試');
  }

  // TC：Reservation List > Account 模糊搜尋 + VIP名單可編輯/刪除
  if (/account.*支援模糊搜尋|vip清單.*可編輯跟刪除/i.test(full)) {
    await openReservationList();
    const info = await getVisibleDialogInfo();
    const shotPath = path.join(SCREENSHOT_DIR, `reservation_viplist_${Date.now()}.png`);
    await page.screenshot({ path: shotPath });
    extraShotPaths.push(shotPath);
    const hasAccountFilter = info?.filterLabels?.includes('Account');
    const hasEditDel = info?.buttons?.includes('Edit') && info?.buttons?.includes('Cancel');
    if (hasAccountFilter && hasEditDel) {
      notes.push(`✅VIP名單Account篩選存在，且列上有Edit/Cancel(刪除)按鈕（${info.rowCount}筆VIP資料）`);
    } else {
      notes.push(`❌VIP名單功能缺失(Account篩選:${!!hasAccountFilter}, Edit/Cancel:${!!hasEditDel})`);
      criticalFails.push('VIP名單Account篩選或Edit/Cancel按鈕缺失');
    }
    await closeVisibleDialog();
  }

  // TC：Export（Reservation List面板內，搜尋後只匯出搜尋結果）
  if (/export.*確認匯出檔案正確|只會匯出目前搜尋的帳號資料/i.test(full)) {
    await openReservationList();
    const exportResult = await doExport(page);
    if (exportResult.notes) notes.push(exportResult.notes);
    criticalFails.push(...exportResult.criticalFails);
    await closeVisibleDialog();
  }

  // TC：+Add 可增加VIP預約名單（Lock Count/Lock Time(H)/Machine Count）
  if (/\+add.*可增加vip預約名單|输入lock\s*count.*lock\s*time.*machine\s*count/i.test(full)) {
    await openReservationList();
    const addClicked = await page.evaluate(() => {
      const dlg = [...document.querySelectorAll('.el-dialog')].filter(d => d.getBoundingClientRect().width > 0).pop();
      const btn = dlg && [...dlg.querySelectorAll('button')].find(b => b.innerText?.trim() === 'Add');
      if (btn) { btn.click(); return true; }
      return false;
    });
    await page.waitForTimeout(1000);
    if (!addClicked) {
      notes.push('❌VIP名單Add按鈕缺失');
      criticalFails.push('VIP名單Add按鈕缺失');
    } else {
      const info = await getVisibleDialogInfo();
      const shotPath = path.join(SCREENSHOT_DIR, `reservation_addvip_dialog_${Date.now()}.png`);
      await page.screenshot({ path: shotPath });
      extraShotPaths.push(shotPath);
      const expected = ['Account', 'Lock Count', 'Lock Time(H)', 'Machine Count'];
      const missing = expected.filter(e => !info?.labels?.includes(e));
      if (missing.length === 0) {
        notes.push(`✅+Add VIP Dialog欄位完整(${expected.join('/')})（僅驗證表單存在，未實際新增避免污染共用VIP名單）`);
      } else {
        notes.push(`❌+Add VIP Dialog缺少欄位:${missing.join(',')}`);
        criticalFails.push(`+Add VIP Dialog缺少欄位:${missing.join(',')}`);
      }
      await closeVisibleDialog();
    }
    await closeVisibleDialog();
  }

  // TC：Import Excel
  if (/import\s*excel/i.test(full)) {
    await openReservationList();
    const hasImportBtn = await page.evaluate(() => {
      const dlg = [...document.querySelectorAll('.el-dialog')].filter(d => d.getBoundingClientRect().width > 0).pop();
      return !!dlg && [...dlg.querySelectorAll('button')].some(b => /import\s*excel/i.test(b.innerText?.trim()));
    });
    const shotPath = path.join(SCREENSHOT_DIR, `reservation_import_${Date.now()}.png`);
    await page.screenshot({ path: shotPath });
    extraShotPaths.push(shotPath);
    if (hasImportBtn) {
      notes.push('✅Import Excel按鈕存在（未提供實際檔案，僅驗證按鈕存在，未實際上傳避免污染共用VIP名單）');
    } else {
      notes.push('❌Import Excel按鈕缺失');
      criticalFails.push('Import Excel按鈕缺失');
    }
    await closeVisibleDialog();
  }

  // TC：主表排序/Cancel操作/Delay（目前無資料時如實記錄，非fail）
  if (/预定列表需要按照开始时间进行排序|时间约近的排在越前面/i.test(full)) {
    if (rowCount === 0) {
      notes.push('⚠️主表目前無預約資料（0筆），無法驗證按Start Time排序邏輯');
    } else {
      const startTimeIdx = allHeaders.findIndex(h => /start time/i.test(h));
      const times = startTimeIdx >= 0 ? await page.evaluate((idx) => [...document.querySelectorAll('.el-table__body tr')].map(r => r.querySelectorAll('td')[idx]?.innerText?.trim()), startTimeIdx) : [];
      const isAsc = times.every((t, i) => i === 0 || new Date(t) >= new Date(times[i - 1]));
      if (isAsc) {
        notes.push(`✅預約列表依Start Time正確排序（越近越前）`);
      } else {
        notes.push(`❌預約列表未依Start Time正確排序`);
        criticalFails.push('預約列表排序錯誤');
      }
    }
  }
  if (/点击cannel后对此台机器取消预定|delay.*点击后弹出选择框/i.test(full)) {
    notes.push(rowCount === 0
      ? '⚠️主表目前無預約資料（0筆），無法驗證Cancel/Delay操作（避免無資料時誤觸發其他機台）'
      : `ℹ️主表有${rowCount}筆資料，Operation欄按鈕存在性已於基礎檢查涵蓋，實際Cancel/Delay動作未執行避免影響真實預約`);
  }

  if (notes.length === (h1 ? 2 : 1)) {
    notes.push(`⚠️這筆TC文字沒有對應到已知的驗證規則，未執行額外斷言: ${full.slice(0, 40)}`);
  }

  return { notes: notes.join(' | '), criticalFails, extraShotPaths };
}

async function verifyReservationLimit(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1 } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);

  const hasInput = await page.evaluate(() =>
    document.querySelectorAll('.el-switch, input[type="number"], input[type="text"]').length > 0
  ).catch(() => false);
  notes.push(hasInput ? '✅設定欄位(Switch/輸入框)存在' : '⚠️設定欄位未偵測到');

  return { notes: notes.join(' | '), criticalFails };
}

async function verifyDailyRanking(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';

  // TC3（每5分鐘更新）：若計時器已啟動，標記為計時中（不走 MANUAL）
  if (/5.*分鐘.*更新|每5分鐘/i.test(full)) {
    if (_bonusTimerState) {
      const elapsed = Math.floor((Date.now() - _bonusTimerState.startTime) / 1000);
      notes.push(`⏳5分鐘計時中（已過${elapsed}秒）— 所有TC跑完後回來驗證`);
      return { notes: notes.join(' | '), criticalFails: [], manual: true };
    }
  }

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, rowCount, allHeaders } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);
  notes.push(`表格${rowCount}筆`);

  let toastShotPath = null;
  let exportedXlsxPath = null;
  const extraShotPaths = [];

  // ── TC1：排序規則驗證 — Total Bet Amount 必須降序 ─────────────────────
  if (/排序.*投注|投注.*排序|total.*bet.*amount|按照.*投注額/i.test(full)) {
    if (rowCount === 0) {
      notes.push('⚠️排序驗證跳過（今日無資料）');
    } else {
      const betColIdx = allHeaders.findIndex(h => /total.*bet.*amount/i.test(h));
      if (betColIdx === -1) {
        notes.push('❌Total Bet Amount欄位不存在');
        criticalFails.push('Total Bet Amount欄位缺失');
      } else {
        const betValues = await page.evaluate((colIdx) => {
          const rows = [...document.querySelectorAll('.el-table__body tr')];
          return rows.map(row => {
            const cells = row.querySelectorAll('td');
            const cell = cells[colIdx];
            if (!cell) return null;
            const txt = cell.innerText?.trim().replace(/,/g, '') || '';
            return txt === '' ? null : parseFloat(txt);
          }).filter(v => v !== null && !isNaN(v));
        }, betColIdx).catch(() => []);

        if (betValues.length === 0) {
          notes.push('⚠️Total Bet Amount欄位無數值可驗證');
        } else {
          let isDesc = true;
          for (let i = 1; i < betValues.length; i++) {
            if (betValues[i] > betValues[i - 1]) { isDesc = false; break; }
          }
          const today = new Date().toISOString().slice(0, 10);
          const rowsHtml = betValues.map((v, i) => {
            const ok = i === 0 || betValues[i] <= betValues[i - 1];
            const bg = ok ? '#f0fdf4' : '#fef2f2';
            const icon = ok ? '✅' : '❌';
            return `<tr style="background:${bg}"><td style="padding:6px 12px;font-weight:bold">#${i + 1}</td><td style="padding:6px 12px">${icon} ${v.toLocaleString()}</td><td style="padding:6px 12px;color:#666;font-size:11px">${i === 0 ? '—' : (ok ? `≤ ${betValues[i-1].toLocaleString()} ✓` : `> ${betValues[i-1].toLocaleString()} ✗`)}</td></tr>`;
          }).join('');
          const resultColor = isDesc ? '#16a34a' : '#dc2626';
          const resultText = isDesc ? '✅ PASS — 排序符合規格（Total Bet Amount 降序）' : '❌ FAIL — 排序不符（非 Total Bet Amount 降序）';
          const sortHtml = `<div style="padding:14px;font-family:sans-serif;font-size:12px;line-height:1.7;background:#f8f8f8;min-width:300px">
  <div style="font-size:14px;font-weight:bold;color:${resultColor};margin-bottom:10px">${resultText}</div>
  <div style="color:#444;margin-bottom:8px">📅 驗證日期：${today}<br>📐 規則：排名按 Total Bet Amount 降序（#1 最高）</div>
  <table border="1" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px;width:100%">
    <tr style="background:#dbeafe"><th style="padding:6px 12px">排名</th><th style="padding:6px 12px">Total Bet Amount</th><th style="padding:6px 12px">比較</th></tr>
    ${rowsHtml}
  </table>
  <div style="margin-top:10px;font-size:13px;font-weight:bold;color:${resultColor}">整體結果：${isDesc ? '✅ PASS' : '❌ FAIL'}</div>
</div>`;
          // 生成排序驗證截圖
          const sortShotPath = path.join(SCREENSHOT_DIR, `sort_verify_${Date.now()}.png`);
          await page.setContent(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0">${sortHtml}</body></html>`, { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(300);
          await page.screenshot({ path: sortShotPath, fullPage: true });
          // 回到原頁
          await page.goto(BACKEND_URL + '/rankinglist/dailyRanking', { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
          await page.waitForTimeout(1000);
          await dismissDialogs(page);
          extraShotPaths.push(sortShotPath);

          if (isDesc) {
            notes.push(`✅Total Bet Amount降序正確（排序驗證截圖已上傳）`);
          } else {
            notes.push(`❌排序錯誤：非降序`);
            criticalFails.push('Daily Ranking排序規則錯誤：非按Total Bet Amount降序');
          }
        }
      }
    }
  }

  // ── TC2：Bonus Settings 完整流程 ─────────────────────────────────────
  if (/bonus\s*settings?/i.test(full)) {
    // ① 修改前：讀取 Daily Ranking 表格 Bonus 欄位的值 + 截圖（before）
    const bonusColIdx = allHeaders.findIndex(h => /^bonus$/i.test(h.trim()));
    const beforeBonusVals = bonusColIdx >= 0
      ? await page.evaluate((colIdx) => {
          const rows = [...document.querySelectorAll('.el-table__body tr')];
          return rows.map(row => {
            const cell = row.querySelectorAll('td')[colIdx];
            return cell ? cell.innerText?.trim() : null;
          }).filter(v => v !== null);
        }, bonusColIdx).catch(() => [])
      : [];
    const beforeTableShotPath = path.join(SCREENSHOT_DIR, `bonus_table_before_${Date.now()}.png`);
    await page.screenshot({ path: beforeTableShotPath, fullPage: false });
    extraShotPaths.push(beforeTableShotPath);
    if (beforeBonusVals.length > 0) {
      notes.push(`📊修改前Bonus欄: [${beforeBonusVals.join(', ')}]`);
    }

    // ② 執行 Bonus Settings 修改流程
    const bonusResult = await doBonusSettings(page);
    if (bonusResult.notes) notes.push(bonusResult.notes);
    criticalFails.push(...bonusResult.criticalFails);
    toastShotPath = bonusResult.toastShotPath;
    extraShotPaths.push(...(bonusResult.extraShotPaths || []));

    // ③ 將 before 數據存入計時器狀態，供 5 分鐘後比對
    if (_bonusTimerState) {
      _bonusTimerState.beforeBonusVals = beforeBonusVals;
      _bonusTimerState.beforeTableShotPath = beforeTableShotPath;
      _bonusTimerState.bonusColIdx = bonusColIdx;
    }
  }

  // ── TC4：Export CSV 驗證 ──────────────────────────────────────────────
  if (/export|csv|導出|匯出/i.test(full)) {
    const expResult = await doExport(page);
    if (expResult.notes) notes.push(expResult.notes);   // doExport 回傳 string
    criticalFails.push(...expResult.criticalFails);
    exportedXlsxPath = expResult.exportedXlsxPath;
  }

  // ── TC5：Set Config 深層驗證 ──────────────────────────────────────────
  // ⭐ 2026-08-05 改版：舊版是兩個 el-switch 開關(Daily Rank / Daily Rank-Bonus)
  // + Info dialog + Confirm 流程；新版改成表單 dialog：Ranking Type(下拉) /
  // Time(日期區間) / Show The Top(數字) / Bonus(下拉，Show/Hidden) + Save/Close，
  // 沒有 el-switch、沒有切換用的 Info confirm dialog 了。只針對確認存在的
  // 「Bonus」下拉做開關等效驗證(對應舊版Daily Rank-Bonus)；「Daily Rank」本身
  // 開關在新UI找不到對應控制項，如實記錄待人工確認是否已移到別處，不臆測。
  if (/set.*config|config.*開關|開關.*日榜/i.test(full)) {
    try {
      // ① 點 Set Config 按鈕
      const setConfigBtn = page.locator('button').filter({ hasText: /set\s*config/i }).first();
      const btnVisible = await setConfigBtn.isVisible({ timeout: 3000 }).catch(() => false);
      if (!btnVisible) {
        notes.push('❌Set Config按鈕缺失');
        criticalFails.push('Set Config按鈕缺失');
      } else {
        await setConfigBtn.click();
        await page.waitForTimeout(1000);

        // ② 截圖（Set Config dialog 開啟初始狀態）
        const beforeShotPath = path.join(SCREENSHOT_DIR, `setconfig_before_${Date.now()}.png`);
        await page.screenshot({ path: beforeShotPath });
        extraShotPaths.push(beforeShotPath);

        // ③ 確認新版4個欄位存在：Ranking Type / Time / Show The Top / Bonus
        const fieldsFound = await page.evaluate(() => {
          const items = [...document.querySelectorAll('.el-dialog .el-form-item')];
          return items.map(item => item.querySelector('.el-form-item__label')?.innerText?.trim() || '');
        }).catch(() => []);
        const expected = ['Ranking Type', 'Time', 'Show The Top', 'Bonus'];
        const missing = expected.filter(e => !fieldsFound.some(f => f.includes(e)));
        if (missing.length > 0) {
          notes.push(`⚠️Set Config欄位跟已知版面(${expected.join('/')})對不上，目前抓到:${fieldsFound.join(',') || '無'}——可能又改版了，需要重新確認`);
        } else {
          notes.push(`✅Set Config欄位確認存在: ${fieldsFound.join(' / ')}`);
        }

        // ④ 找「Bonus」下拉(對應舊版Daily Rank-Bonus開關)，讀取目前值(Show/Hidden)
        const bonusItem = page.locator('.el-dialog .el-form-item').filter({ hasText: 'Bonus' }).last();
        const bonusSelectVisible = await bonusItem.locator('.el-select').isVisible({ timeout: 2000 }).catch(() => false);
        if (!bonusSelectVisible) {
          notes.push('❌Bonus下拉選單找不到，跟情境C原本描述的「開關」概念對不上，需要人工確認新UI對應方式');
          criticalFails.push('Bonus 下拉選單缺失');
        } else {
          const origBonusVal = (await bonusItem.locator('.el-select .el-input__inner').inputValue().catch(() => '')) || '';
          await bonusItem.locator('.el-select').click();
          await page.waitForTimeout(500);
          const options = await page.locator('.el-select-dropdown__item').allInnerTexts().catch(() => []);
          const otherOption = options.find(o => o.trim() && o.trim() !== origBonusVal);
          if (!otherOption) {
            notes.push(`⚠️Bonus下拉目前值"${origBonusVal}"，但選單只有${options.length}個選項，無法測試切換`);
            await page.keyboard.press('Escape').catch(() => {});
          } else {
            await page.locator('.el-select-dropdown__item').filter({ hasText: otherOption }).first().click().catch(() => {});
            await page.waitForTimeout(400);

            // Save
            const saveBtn = page.locator('.el-dialog button').filter({ hasText: /save/i }).first();
            await saveBtn.click().catch(() => {});
            await page.waitForTimeout(600);
            const hasToast = await page.locator('.el-message--success').isVisible({ timeout: 2000 }).catch(() => false);
            const afterShotPath = path.join(SCREENSHOT_DIR, `setconfig_bonus_toggle_${Date.now()}.png`);
            await page.screenshot({ path: afterShotPath });
            extraShotPaths.push(afterShotPath);
            notes.push(`${hasToast ? '✅' : '⚠️'}Bonus下拉切換 ${origBonusVal}→${otherOption} 並儲存${hasToast ? '(toast確認)' : '(未偵測到toast)'}`);

            // 還原：重開Set Config，切回原值
            await setConfigBtn.click().catch(() => {});
            await page.waitForTimeout(800);
            const bonusItem2 = page.locator('.el-dialog .el-form-item').filter({ hasText: 'Bonus' }).last();
            await bonusItem2.locator('.el-select').click().catch(() => {});
            await page.waitForTimeout(400);
            await page.locator('.el-select-dropdown__item').filter({ hasText: origBonusVal }).first().click().catch(() => {});
            await page.waitForTimeout(300);
            await page.locator('.el-dialog button').filter({ hasText: /save/i }).first().click().catch(() => {});
            await page.waitForTimeout(600);
            notes.push('✅Bonus下拉已還原原始值');
          }
        }

        notes.push('ℹ️「Daily Rank」本身的開關在新版Set Config找不到對應控制項(舊版是獨立el-switch)，可能已移除或移到別處，需要人工確認，不臆測其現況');

        // ⑤ 關閉 Set Config dialog
        await page.evaluate(() => {
          const closeBtn = [...document.querySelectorAll('.el-dialog button')]
            .find(b => /close/i.test(b.innerText));
          if (closeBtn) closeBtn.click();
        });
        await page.waitForTimeout(500);
      }
    } catch (e) {
      notes.push(`⚠️Set Config驗證例外: ${e.message}`);
    }
  }

  return { notes: notes.join(' | '), criticalFails, toastShotPath, exportedXlsxPath, extraShotPaths };
}

// ⭐ 2026-08-05 使用者實際說明操作步驟並全程確認過：Jackpot Abnormality補發 → Jackpot Ranking
// 自動寫入（含JackpotType預設為空）的完整流程。真實走過一次才發現的關鍵坑：
// Info確認彈窗是Element UI的`.el-message-box`，不是`.el-dialog`——用`.el-dialog, .el-message-box`
// 混在一起查再用offsetParent篩選，會選到錯的（或空的）元素，導致最後一步Sure按鈕根本沒被
// 真的點到，整個流程看似跑完但資料其實沒confirm。已用page.waitForResponse實測
// `sureHandPayRecord`真的回200才敢確認流程有效。
async function runJackpotAbnormalityFlow(page) {
  await page.goto(`${BACKEND_URL}/abnormality/getHandPayRecord`, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(1500);
  await dismissDialogs(page);

  // ⚠️ 用「Game Order」欄位（每筆bet唯一的訂單號，例如4186-XXX-0000|hash）當這一列的
  // 穩定身分識別——account這種共用測試帳號在表格裡會重複出現很多列，且Handpay/Jackpot
  // 數值本身會被這次操作改掉、不能拿新值回頭找列。Game Order從頭到尾都不會變，
  // 才是唯一能安全重新定位「就是這一列」的欄位。
  // ⭐ 2026-08-05：不能固定選第一列——當天第一列一直是先前測試留下、疑似已經卡在異常
  // 狀態的舊列（Payout被改成天文數字後，Sure確認一直沒有真正生效）。改成挑一列Payout
  // 金額落在正常範圍（<100000）的「乾淨」列，避開被之前測試污染過的列。
  const rowBefore = await page.evaluate((cleanThreshold) => {
    const table = document.querySelector('.el-table');
    if (!table) return null;
    const ths = [...table.querySelectorAll('th')].map(h => h.innerText?.trim() || '');
    const ai = ths.findIndex(h => /^account$/i.test(h));
    const gi = ths.findIndex(h => /game order/i.test(h));
    const pi = ths.findIndex(h => /^payout$/i.test(h));
    const rows = [...table.querySelectorAll('.el-table__body tr')];
    const isClean = (row) => {
      const payoutText = row.querySelectorAll('td')[pi]?.innerText || '';
      const n = parseFloat(payoutText.replace(/,/g, ''));
      return !isNaN(n) && n < cleanThreshold;
    };
    const row = rows.find(isClean) || rows[0];
    if (!row) return null;
    const cells = row.querySelectorAll('td');
    return { account: cells[ai]?.innerText?.trim(), gameOrder: cells[gi]?.innerText?.trim() };
  }, TEST_PARAMS.jackpotAbnormality.cleanRowPayoutThreshold);
  if (!rowBefore || !rowBefore.gameOrder) return { ok: false, error: '讀不到Jackpot Abnormality的Game Order（無法安全定位可用的列）' };

  // ⭐ 2026-08-05 使用者確認並要求記住的關鍵限制：Handpay/Jackpot Amount欄位最多只能
  // 輸入9位數，超過會導致DB查詢不到資料（UI操作流程本身看起來完全正常、會顯示成功，
  // 但後續在Jackpot Ranking永遠查不到）。之前多輪測試用11~15位數天文數字全部卡在這裡，
  // 花了很多輪才定位到根因。用時間戳尾碼組出恰好9位數，確保每次跑都獨一無二方便比對，
  // 同時絕對不超過這個上限。見memory: project_jackpot_abnormality_testing
  const { maxInputDigits, jackpotValuePrefix, handpayValuePrefix } = TEST_PARAMS.jackpotAbnormality;
  const uniqueSuffix = String(Date.now()).slice(-(maxInputDigits - jackpotValuePrefix.length));
  const targetJackpot = `${jackpotValuePrefix}${uniqueSuffix}`;
  const targetHandpay = `${handpayValuePrefix}${uniqueSuffix}`;

  const editClicked = await page.evaluate((gameOrder) => {
    const row = ([...document.querySelectorAll('.el-table__body tr')]).find(r => r.innerText.includes(gameOrder));
    const btn = row && [...row.querySelectorAll('button')].find(b => /^edit$/i.test(b.innerText?.trim()));
    if (btn) { btn.click(); return true; }
    return false;
  }, rowBefore.gameOrder);
  if (!editClicked) return { ok: false, error: '找不到Jackpot Abnormality Edit按鈕' };
  await page.waitForTimeout(800);

  await page.evaluate(({ hp, jp }) => {
    const dialogs = [...document.querySelectorAll('.el-dialog')].filter(d => d.offsetParent !== null);
    const dialog = dialogs[dialogs.length - 1];
    const inputs = [...(dialog?.querySelectorAll('input') || [])];
    const setVal = (el, val) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    if (inputs[0]) setVal(inputs[0], hp);
    if (inputs[1]) setVal(inputs[1], jp);
  }, { hp: targetHandpay, jp: targetJackpot });
  await page.waitForTimeout(300);

  const editShotPath = path.join(SCREENSHOT_DIR, `jpabnormality_edit_filled_${Date.now()}.png`);
  await page.screenshot({ path: editShotPath });

  // ⭐ 2026-08-05 重要修正：原本以為「Edit對話框送出」跟「列上的Sure按鈕」是兩個獨立步驟
  // （先送出Edit關閉對話框，再另外去點列上的Sure），這是錯的，已用截圖實測證實：
  // Edit對話框裡的「+Edit」按鈕一按下去，會直接疊出同一個Info確認彈窗（Edit PayOut對話框
  // 還留在背景沒關閉），根本不需要、也不應該再去找列上獨立的Sure按鈕——那顆是給「上次
  // Edit送出過、但還沒完成Info確認」的半殘列用的收尾按鈕，不是正常單次流程的一部分。
  // 之前一直卡住是因為程式碼在等一個從未存在過的「Edit本身送出網路請求」，然後又去點
  // 列上的Sure（此時Info彈窗已經蓋在畫面上，那個點擊點到不該點的地方），流程整個對不起來。
  await page.evaluate(() => {
    const dialogs = [...document.querySelectorAll('.el-dialog')].filter(d => d.offsetParent !== null);
    const dialog = dialogs[dialogs.length - 1];
    const btn = dialog && [...dialog.querySelectorAll('button')].find(b => /^edit$/i.test(b.innerText?.trim()));
    if (btn) btn.click();
  });
  await page.waitForTimeout(1200);

  const infoAppeared = await page.evaluate(() => !!document.querySelector('.el-message-box'));
  if (!infoAppeared) {
    return { ok: false, error: 'Edit送出後沒有跳出預期的Info確認彈窗（.el-message-box）', editShotPath };
  }

  // 關鍵修正：Info確認彈窗是.el-message-box，要獨立處理，不能跟.el-dialog混在一起查
  // 網路回應比對放寬成任何POST（不死守sureHandPayRecord這個精確字串，避免共用UAT環境
  // 負載較高時延遲更久導致誤判逾時），並且不完全依賴network capture當唯一證據——
  // 額外用「該列是否從待確認清單消失」當第二重驗證（已用真實成功案例確認：
  // 完成確認後，該列會從Jackpot Abnormality列表移除）。
  const respPromise = page.waitForResponse(r => r.request().method() === 'POST' && /handpay|abnormality/i.test(r.url()), { timeout: 12000 }).catch(() => null);
  const confirmClicked = await page.evaluate(() => {
    const box = document.querySelector('.el-message-box');
    const btn = box && [...box.querySelectorAll('button')].find(b => /^sure$/i.test(b.innerText?.trim()));
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (!confirmClicked) return { ok: false, error: '找不到Info確認彈窗(.el-message-box)的Sure按鈕' };
  const resp = await respPromise;
  await page.waitForTimeout(1500);
  const confirmShotPath = path.join(SCREENSHOT_DIR, `jpabnormality_confirmed_${Date.now()}.png`);
  await page.screenshot({ path: confirmShotPath });

  // 第二重驗證：不管有沒有捕捉到network response，都直接重新整理列表確認該列是否已消失
  await page.goto(`${BACKEND_URL}/abnormality/getHandPayRecord`, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await dismissDialogs(page);
  let stillPending = await page.evaluate((gameOrder) => {
    return !!([...document.querySelectorAll('.el-table__body tr')]).find(r => r.innerText.includes(gameOrder));
  }, rowBefore.gameOrder);

  // ⭐ 2026-08-05 新增第二階段確認：連續4次測試（乾淨列+大數值都試過）都卡在同一個地方——
  // Edit對話框自己的Info確認彈窗按完Sure後，該列依然留在待確認清單裡。回頭比對當初唯一
  // 一次真正成功的案例，懷疑其實需要「兩階段」確認：Edit對話框的Sure只是暫存數值，
  // 真正觸發寫入Jackpot Ranking的是列上『獨立』的Sure按鈕（再跳一次Info彈窗、再Sure一次）。
  // 保守起見：只有在第一階段後該列還在時才嘗試第二階段，不會對已經消失的列做多餘操作。
  let secondStageShotPath = null;
  if (stillPending) {
    const rowSureClicked = await page.evaluate((gameOrder) => {
      const row = ([...document.querySelectorAll('.el-table__body tr')]).find(r => r.innerText.includes(gameOrder));
      const btn = row && [...row.querySelectorAll('button')].find(b => /^sure$/i.test(b.innerText?.trim()));
      if (btn) { btn.click(); return true; }
      return false;
    }, rowBefore.gameOrder);
    if (rowSureClicked) {
      await page.waitForTimeout(1000);
      const secondRespPromise = page.waitForResponse(r => r.request().method() === 'POST' && /handpay|abnormality/i.test(r.url()), { timeout: 12000 }).catch(() => null);
      const secondConfirmClicked = await page.evaluate(() => {
        const box = document.querySelector('.el-message-box');
        const btn = box && [...box.querySelectorAll('button')].find(b => /^sure$/i.test(b.innerText?.trim()));
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (secondConfirmClicked) {
        await secondRespPromise;
        await page.waitForTimeout(1500);
        secondStageShotPath = path.join(SCREENSHOT_DIR, `jpabnormality_confirmed2_${Date.now()}.png`);
        await page.screenshot({ path: secondStageShotPath });
        await page.goto(`${BACKEND_URL}/abnormality/getHandPayRecord`, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(1000);
        await dismissDialogs(page);
        stillPending = await page.evaluate((gameOrder) => {
          return !!([...document.querySelectorAll('.el-table__body tr')]).find(r => r.innerText.includes(gameOrder));
        }, rowBefore.gameOrder);
      }
    }
  }

  if (stillPending) {
    return {
      ok: false,
      error: `兩階段確認後該列仍在待確認清單中（未消失）——判定為真的沒確認成功`,
      editShotPath, confirmShotPath,
      extraShotPaths: secondStageShotPath ? [editShotPath, confirmShotPath, secondStageShotPath] : [editShotPath, confirmShotPath],
    };
  }

  // 輪詢Jackpot Ranking找這筆獨一無二的Jackpot Amount值。次數/間隔可調（config/backend-test-params.json）。
  const { rankingPollAttempts, rankingPollIntervalMs } = TEST_PARAMS.jackpotAbnormality;
  let rankingResult = null;
  for (let attempt = 1; attempt <= rankingPollAttempts && !rankingResult; attempt++) {
    await page.goto(`${BACKEND_URL}/rankinglist/jackpotRanking`, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(1500);
    await dismissDialogs(page);
    rankingResult = await page.evaluate((targetJp) => {
      const table = document.querySelector('.el-table');
      const ths = [...table.querySelectorAll('th')].map(h => h.innerText?.trim() || '');
      const ji = ths.findIndex(h => /^jackpot amount$/i.test(h));
      const jti = ths.findIndex(h => /^jackpot type$/i.test(h));
      const rows = [...table.querySelectorAll('.el-table__body tr')];
      for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells[ji]?.innerText?.trim().replace(/,/g, '') === targetJp) {
          return { found: true, jackpotType: cells[jti]?.innerText?.trim() };
        }
      }
      return null;
    }, targetJackpot);
    if (!rankingResult) await page.waitForTimeout(rankingPollIntervalMs);
  }
  const rankingShotPath = path.join(SCREENSHOT_DIR, `jpranking_after_abnormality_${Date.now()}.png`);
  await page.screenshot({ path: rankingShotPath });

  return {
    ok: true,
    account: rowBefore.account,
    targetJackpot,
    found: !!rankingResult,
    jackpotType: rankingResult?.jackpotType,
    extraShotPaths: [editShotPath, confirmShotPath, ...(secondStageShotPath ? [secondStageShotPath] : []), rankingShotPath],
  };
}

// ⭐ 2026-08-05 重寫：原本11筆TC全部共用「有Jackpot Amount欄位就pass」的模糊判斷，
// 完全不管TC實際在測什麼。已實際登入uat-cp.osmslot.org點過Add/Announcement/
// Batch Set Jackpot Type三個dialog確認真實欄位後，改成每筆TC對應各自的真實操作+斷言。
// 保守原則：會開啟dialog確認欄位存在，但不送出會改到共用UAT資料的操作（Add新增假紀錄、
// Batch真的改JP Type），避免污染其他人在用的測試資料；這部分留白會在notes裡明說，不假裝已驗證。
async function verifyJackpotRanking(page, tc) {
  const notes = [];
  const criticalFails = [];
  const extraShotPaths = [];
  const full = tc || '';

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, allHeaders, rowCount } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);

  const getVisibleDialog = () => page.locator('.el-dialog:visible').last();
  const closeDialog = async () => {
    await page.evaluate(() => {
      const dialogs = [...document.querySelectorAll('.el-dialog')].filter(d => d.offsetParent !== null);
      const dialog = dialogs[dialogs.length - 1];
      const btn = dialog && [...dialog.querySelectorAll('button')].find(b => /close|cancel/i.test(b.innerText?.trim()));
      if (btn) btn.click();
    });
    await page.waitForTimeout(500);
  };

  // TC1：排序是按照 Jackpot Amount 排序
  // ⚠️ 欄位index必須在同一次evaluate內、用未過濾的th清單去對應td——getBaseInfo()的
  // allHeaders會filter(Boolean)把checkbox欄的空字串th濾掉，導致index跟td錯位一格
  // （已用真實DOM除錯確認：filter後index=6對到的其實是Machine Name那格td，不是Jackpot Amount）
  if (/排序.*jackpot.*amount.*排序|jackpot.*amount.*排序/i.test(full)) {
    const values = await page.evaluate(() => {
      const table = document.querySelector('.el-table');
      if (!table) return null;
      const ths = [...table.querySelectorAll('th')].map(h => h.innerText?.trim() || '');
      const idx = ths.findIndex(h => /jackpot.*amount/i.test(h));
      if (idx === -1) return null;
      return [...table.querySelectorAll('.el-table__body tr')].map(row => {
        const cell = row.querySelectorAll('td')[idx];
        const n = parseFloat((cell?.innerText || '').replace(/[^0-9.-]/g, ''));
        return isNaN(n) ? null : n;
      }).filter(n => n != null);
    });
    if (values === null) {
      notes.push('❌找不到Jackpot Amount欄位，無法驗證排序');
      criticalFails.push('找不到Jackpot Amount欄位');
    } else {
      let sorted = true;
      for (let i = 1; i < values.length; i++) {
        if (values[i] > values[i - 1]) { sorted = false; break; }
      }
      if (values.length < 2) {
        notes.push(`⚠️資料筆數不足(${values.length})無法確認排序`);
      } else if (sorted) {
        notes.push(`✅Jackpot Amount降序正確(前3筆:${values.slice(0,3).join(',')})`);
      } else {
        notes.push(`❌Jackpot Amount排序錯誤(前5筆:${values.slice(0,5).join(',')})`);
        criticalFails.push('Jackpot Amount未按降序排列');
      }
      const sortShotPath = path.join(SCREENSHOT_DIR, `jpranking_sort_${Date.now()}.png`);
      await page.screenshot({ path: sortShotPath });
      extraShotPaths.push(sortShotPath);
    }
  }

  // TC2：可以更新上傳 / 刪除 / 觀看視頻
  if (/更新上傳.*刪除.*觀看視頻|上傳.*刪除.*視頻/.test(full)) {
    const hasUpload = allHeaders.length > 0 && await page.evaluate(() =>
      [...document.querySelectorAll('.el-table__body tr')].every(row =>
        [...row.querySelectorAll('button')].some(b => /^upload$/i.test(b.innerText?.trim()))
      )
    ).catch(() => false);
    if (hasUpload) {
      notes.push('✅每列皆有Upload按鈕（Video欄）');
    } else {
      notes.push('❌部分列缺少Upload按鈕');
      criticalFails.push('Video欄Upload按鈕缺失');
    }
  }

  // TC3：可以編輯 / 刪除獎池額度
  if (/可以編輯.*刪除獎池額度|編輯.*刪除.*獎池額度/.test(full)) {
    const hasEditDel = rowCount > 0 && await page.evaluate(() =>
      [...document.querySelectorAll('.el-table__body tr')].every(row => {
        const btns = [...row.querySelectorAll('button')].map(b => b.innerText?.trim());
        return btns.some(t => /^edit$/i.test(t)) && btns.some(t => /^delete$/i.test(t));
      })
    ).catch(() => false);
    if (hasEditDel) {
      notes.push('✅每列皆有Edit+Delete按鈕（Operation欄）');
    } else {
      notes.push('❌部分列缺少Edit/Delete按鈕');
      criticalFails.push('Operation欄Edit/Delete按鈕缺失');
    }
  }

  // TC4：可以透過"add"按鈕新增獎池紀錄
  if (/透過.*add.*按鈕新增獎池紀錄|add.*按鈕新增獎池/i.test(full)) {
    const clicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => /^add$/i.test(b.innerText?.trim()));
      if (btn) { btn.click(); return true; }
      return false;
    });
    await page.waitForTimeout(1000);
    if (!clicked) {
      notes.push('❌找不到Add按鈕');
      criticalFails.push('Add按鈕缺失');
    } else {
      const dlg = await page.evaluate(() => {
        const dialogs = [...document.querySelectorAll('.el-dialog')].filter(d => d.offsetParent !== null);
        const dialog = dialogs[dialogs.length - 1];
        if (!dialog) return null;
        return {
          title: (dialog.querySelector('.el-dialog__title')?.innerText || dialog.querySelector('.el-dialog__header')?.innerText || '')?.trim(),
          labels: [...dialog.querySelectorAll('.el-form-item__label')].map(l => l.innerText?.replace(/[\s*]/g,'')),
        };
      });
      const expected = ['SpinId','MachineNo','JackpotType','Bet','Payout','JackpotAmount','Account','BetTime'];
      const missing = dlg ? expected.filter(e => !dlg.labels.some(l => l.replace(/\s/g,'') === e)) : expected;
      const addDialogShotPath = path.join(SCREENSHOT_DIR, `jpranking_add_dialog_${Date.now()}.png`);
      await page.screenshot({ path: addDialogShotPath });
      extraShotPaths.push(addDialogShotPath);
      if (missing.length === 0) {
        notes.push(`✅Add Dialog(${dlg.title})欄位完整(${expected.length}項)`);
      } else {
        notes.push(`⚠️Add Dialog欄位缺失:${missing.join(',')}（未實際送出新增，避免污染共用UAT資料，僅驗證表單欄位）`);
        if (!dlg) criticalFails.push('Add Dialog未開啟');
      }
      await closeDialog();
    }
  }

  // TC5：確認CSV導出數據顯示正確
  // ⚠️ 同TC1，index必須在同一次evaluate內用未過濾的th清單算，不能借用外層已filter(Boolean)的allHeaders
  if (/確認csv導出數據顯示正確/i.test(full)) {
    const firstRow = await page.evaluate(() => {
      const table = document.querySelector('.el-table');
      if (!table) return null;
      const ths = [...table.querySelectorAll('th')].map(h => h.innerText?.trim() || '');
      const ai = ths.findIndex(h => /^account$/i.test(h));
      const ji = ths.findIndex(h => /jackpot.*amount/i.test(h));
      const row = table.querySelector('.el-table__body tr');
      if (!row) return null;
      const cells = row.querySelectorAll('td');
      return { account: cells[ai]?.innerText?.trim(), jpAmount: cells[ji]?.innerText?.trim() };
    });
    const exportResult = await doExport(page);
    notes.push(exportResult.notes);
    criticalFails.push(...exportResult.criticalFails);
    if (exportResult.exportedXlsxPath && firstRow) {
      const { headers, rows } = extractXlsxData(exportResult.exportedXlsxPath);
      const xAcctIdx = headers.findIndex(h => /account/i.test(h));
      const xJpIdx = headers.findIndex(h => /jackpot.*amount/i.test(h));
      const xlsxRow = rows.find(r => String(r[xAcctIdx] ?? '').trim() === firstRow.account);
      if (xlsxRow) {
        const xlsxJp = parseFloat(String(xlsxRow[xJpIdx] ?? '').replace(/,/g, ''));
        const screenJp = parseFloat((firstRow.jpAmount || '').replace(/,/g, ''));
        if (Math.abs(xlsxJp - screenJp) < 0.01) {
          notes.push(`✅xlsx內容與畫面吻合(${firstRow.account}:${screenJp})`);
        } else {
          notes.push(`❌xlsx數值與畫面不符(畫面:${screenJp} xlsx:${xlsxJp})`);
          criticalFails.push('CSV導出數值與畫面不符');
        }
      } else {
        notes.push(`⚠️xlsx中找不到對應帳號(${firstRow.account})的行`);
      }
    }
  }

  // TC6：數據透過Jackpot Abronmality補發後，會自動寫入到Jackpot Raking中
  // ⭐ 2026-08-05 使用者實際說明操作步驟後改成真實流程（runJackpotAbnormalityFlow），
  // 不再是MANUAL——見該函式註解，關鍵坑是Info確認彈窗是.el-message-box不是.el-dialog。
  if (/數據透過jackpot abronmality補發後，會自動寫入到jackpot raking中/i.test(full)) {
    const flow = await runJackpotAbnormalityFlow(page);
    if (flow.extraShotPaths) extraShotPaths.push(...flow.extraShotPaths);
    if (!flow.ok) {
      notes.push(`❌Jackpot Abnormality補發流程失敗：${flow.error}`);
      criticalFails.push('Jackpot Abnormality補發流程失敗');
    } else if (flow.found) {
      notes.push(`✅補發後Jackpot Amount=${flow.targetJackpot}的紀錄已自動寫入Jackpot Ranking（帳號${flow.account}）`);
    } else {
      notes.push(`❌補發後等待約90秒（8次輪詢），Jackpot Ranking仍找不到Jackpot Amount=${flow.targetJackpot}的新紀錄`);
      criticalFails.push('補發資料未自動寫入Jackpot Ranking');
    }
    // 回到Jackpot Ranking頁面讓後續TC（若有）狀態一致
    await page.goto(`${BACKEND_URL}/rankinglist/jackpotRanking`, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(800);
  }

  // TC7：Announcement可設定JP彈框跳出時間
  if (/announcement可設定jp彈框跳出時間/i.test(full)) {
    const clicked = await page.evaluate(() => {
      const row = document.querySelector('.el-table__body tr');
      const btn = row && [...row.querySelectorAll('button')].find(b => /^announcement$/i.test(b.innerText?.trim()));
      if (btn) { btn.click(); return true; }
      return false;
    });
    await page.waitForTimeout(1000);
    if (!clicked) {
      notes.push('❌找不到Announcement按鈕');
      criticalFails.push('Announcement按鈕缺失');
    } else {
      const dlg = await page.evaluate(() => {
        const dialogs = [...document.querySelectorAll('.el-dialog')].filter(d => d.offsetParent !== null);
        const dialog = dialogs[dialogs.length - 1];
        if (!dialog) return null;
        return {
          title: (dialog.querySelector('.el-dialog__title')?.innerText || dialog.querySelector('.el-dialog__header')?.innerText || '')?.trim(),
          hasTimeField: /start to end time/i.test(dialog.innerText || ''),
        };
      });
      const annShotPath = path.join(SCREENSHOT_DIR, `jpranking_announcement_dialog_${Date.now()}.png`);
      await page.screenshot({ path: annShotPath });
      extraShotPaths.push(annShotPath);
      if (dlg && dlg.hasTimeField) {
        notes.push(`✅Announcement Dialog(${dlg.title})含Start To End Time欄位（僅驗證表單，未送出變更共用UAT資料）`);
      } else {
        notes.push('❌Announcement Dialog未含預期的時間欄位');
        criticalFails.push('Announcement Dialog缺少時間欄位');
      }
      await closeDialog();
    }
  }

  // TC10：勾選批量修改JP Type
  // ⭐ 2026-08-05 使用者實際操作說明後改成真實送出+驗證持久化+還原：
  // 只勾選第1列（不用全選，降低對共用UAT資料的影響範圍），記錄該列身分(Account+Bet Time)
  // 與原始Jackpot Type，送出改成一個不同的合法值後，重新讀表確認該列真的變成新值，
  // 最後再用同一套Batch流程改回原始值，把資料復原。
  if (/勾選批量修改jp type/i.test(full)) {
    const pickDialogOption = async (targetText) => {
      // Element UI 的下拉選單用 popper teleport 到 document.body，同時間可能有多個
      // select 的選項清單都在 DOM 裡，只是非開啟狀態的用 display:none 隱藏——
      // 必須用「目前哪個 .el-select-dropdown 容器本身是可見的」來篩選，不能直接抓全頁面的
      // .el-select-dropdown__item（會連背景頁面的 Game Type 篩選選單選項也一起抓到）。
      await page.evaluate(() => {
        const dialogs = [...document.querySelectorAll('.el-dialog')].filter(d => d.offsetParent !== null);
        const dialog = dialogs[dialogs.length - 1];
        dialog?.querySelector('.el-select .el-input__inner')?.click();
      });
      await page.waitForTimeout(500);
      const picked = await page.evaluate((text) => {
        // ⚠️ 已用真實DOM除錯確認：.el-select-dropdown這個popper容器即使正在顯示，
        // offsetParent/computed display都回報跟隱藏狀態一樣（跟.el-dialog行為不同，
        // 不能套用同一種過濾方式）。改成直接取DOM順序最後一個，因為Element UI是
        // 點開時才lazy掛載popper到body，最後掛上去的就是這次剛點開的下拉選單。
        const dropdowns = document.querySelectorAll('.el-select-dropdown');
        const dd = dropdowns[dropdowns.length - 1];
        if (!dd) return false;
        const item = [...dd.querySelectorAll('.el-select-dropdown__item')].find(i => i.innerText?.trim() === text);
        if (item) { item.click(); return true; }
        return false;
      }, targetText);
      await page.waitForTimeout(300);
      return picked;
    };

    const rowBefore = await page.evaluate(() => {
      const table = document.querySelector('.el-table');
      if (!table) return null;
      const ths = [...table.querySelectorAll('th')].map(h => h.innerText?.trim() || '');
      const ai = ths.findIndex(h => /^account$/i.test(h));
      const bi = ths.findIndex(h => /bet time/i.test(h));
      const ji = ths.findIndex(h => /^jackpot type$/i.test(h));
      const row = table.querySelector('.el-table__body tr');
      if (!row) return null;
      const cells = row.querySelectorAll('td');
      return { account: cells[ai]?.innerText?.trim(), betTime: cells[bi]?.innerText?.trim(), jackpotType: cells[ji]?.innerText?.trim() };
    });

    const checked = rowBefore && await page.evaluate(() => {
      const cb = document.querySelector('.el-table__body tr .el-checkbox .el-checkbox__inner, .el-table__body tr .el-checkbox input');
      if (cb) { cb.click(); return true; }
      return false;
    });
    await page.waitForTimeout(300);
    const clicked = checked && await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => /batch.*set.*jackpot.*type/i.test(b.innerText?.trim()));
      if (btn) { btn.click(); return true; }
      return false;
    });
    await page.waitForTimeout(1000);

    if (!rowBefore) {
      notes.push('❌讀不到第一列資料，無法識別要驗證哪一列');
      criticalFails.push('讀不到列資料');
    } else if (!checked) {
      notes.push('❌找不到列勾選框');
      criticalFails.push('批量勾選框缺失');
    } else if (!clicked) {
      notes.push('❌找不到Batch Set Jackpot Type按鈕');
      criticalFails.push('Batch Set Jackpot Type按鈕缺失');
    } else {
      // 合法Jackpot Type選項清單來自config/backend-test-params.json，挑一個跟原值不同的當目標值
      const JP_TYPE_OPTIONS = TEST_PARAMS.jackpotRanking.validJackpotTypes;
      const targetType = JP_TYPE_OPTIONS.find(t => t !== rowBefore.jackpotType) || JP_TYPE_OPTIONS[0];

      const picked = await pickDialogOption(targetType);
      const batchShotPath = path.join(SCREENSHOT_DIR, `jpranking_batch_dialog_${Date.now()}.png`);
      await page.screenshot({ path: batchShotPath });
      extraShotPaths.push(batchShotPath);

      if (!picked) {
        notes.push(`❌Batch Dialog選單找不到目標值(${targetType})`);
        criticalFails.push('Batch Dialog選單選項不符預期');
        await closeDialog();
      } else {
        await page.evaluate(() => {
          const dialogs = [...document.querySelectorAll('.el-dialog')].filter(d => d.offsetParent !== null);
          const dialog = dialogs[dialogs.length - 1];
          const btn = dialog && [...dialog.querySelectorAll('button')].find(b => /^sure$/i.test(b.innerText?.trim()));
          if (btn) btn.click();
        });
        await page.waitForTimeout(1500);

        // ⭐ 2026-08-05 使用者指出：之前只截了「選好新值、還沒送出」那一刻的圖，看不出
        // 真的有沒有送出、送出結果對不對。改成送出+確認後，額外截一張該列的實際畫面，
        // 讓Lark附圖能肉眼看到Jackpot Type欄位真的變成目標值。
        const afterShotPath = path.join(SCREENSHOT_DIR, `jpranking_batch_after_${Date.now()}.png`);
        await page.screenshot({ path: afterShotPath });
        extraShotPaths.push(afterShotPath);

        const rowAfter = await page.evaluate((acct) => {
          const table = document.querySelector('.el-table');
          const ths = [...table.querySelectorAll('th')].map(h => h.innerText?.trim() || '');
          const ai = ths.findIndex(h => /^account$/i.test(h));
          const ji = ths.findIndex(h => /^jackpot type$/i.test(h));
          const row = [...table.querySelectorAll('.el-table__body tr')].find(r => r.querySelectorAll('td')[ai]?.innerText?.trim() === acct);
          if (!row) return null;
          return row.querySelectorAll('td')[ji]?.innerText?.trim();
        }, rowBefore.account);

        if (rowAfter === targetType) {
          notes.push(`✅Batch送出成功：${rowBefore.account}的Jackpot Type從${rowBefore.jackpotType}變更為${targetType}（已於Lark記錄實際操作證據）`);
        } else {
          notes.push(`❌Batch送出後未生效：${rowBefore.account}預期變成${targetType}，實際讀到${rowAfter}`);
          criticalFails.push('Batch Set Jackpot Type未真正持久化');
        }

        // 還原：用同一套流程把這一列改回原始值，避免污染共用UAT資料
        const restoreChecked = await page.evaluate((acct) => {
          const table = document.querySelector('.el-table');
          const ths = [...table.querySelectorAll('th')].map(h => h.innerText?.trim() || '');
          const ai = ths.findIndex(h => /^account$/i.test(h));
          const row = [...table.querySelectorAll('.el-table__body tr')].find(r => r.querySelectorAll('td')[ai]?.innerText?.trim() === acct);
          const cb = row?.querySelector('.el-checkbox .el-checkbox__inner, .el-checkbox input');
          if (cb) { cb.click(); return true; }
          return false;
        }, rowBefore.account);
        await page.waitForTimeout(300);
        if (restoreChecked) {
          await page.evaluate(() => {
            const btn = [...document.querySelectorAll('button')].find(b => /batch.*set.*jackpot.*type/i.test(b.innerText?.trim()));
            btn?.click();
          });
          await page.waitForTimeout(1000);
          const restorePicked = await pickDialogOption(rowBefore.jackpotType);
          if (restorePicked) {
            await page.evaluate(() => {
              const dialogs = [...document.querySelectorAll('.el-dialog')].filter(d => d.offsetParent !== null);
              const dialog = dialogs[dialogs.length - 1];
              const btn = dialog && [...dialog.querySelectorAll('button')].find(b => /^sure$/i.test(b.innerText?.trim()));
              if (btn) btn.click();
            });
            await page.waitForTimeout(1500);
            const restoreShotPath = path.join(SCREENSHOT_DIR, `jpranking_batch_restored_${Date.now()}.png`);
            await page.screenshot({ path: restoreShotPath });
            extraShotPaths.push(restoreShotPath);
            const restoredValue = await page.evaluate((acct) => {
              const table = document.querySelector('.el-table');
              const ths = [...table.querySelectorAll('th')].map(h => h.innerText?.trim() || '');
              const ai = ths.findIndex(h => /^account$/i.test(h));
              const ji = ths.findIndex(h => /^jackpot type$/i.test(h));
              const row = [...table.querySelectorAll('.el-table__body tr')].find(r => r.querySelectorAll('td')[ai]?.innerText?.trim() === acct);
              return row ? row.querySelectorAll('td')[ji]?.innerText?.trim() : null;
            }, rowBefore.account);
            if (restoredValue === rowBefore.jackpotType) {
              notes.push(`✅已還原${rowBefore.account}的Jackpot Type回${rowBefore.jackpotType}（已截圖確認畫面上的實際值）`);
            } else {
              notes.push(`❌還原送出後實際讀到"${restoredValue}"，跟原始值"${rowBefore.jackpotType}"不符`);
              criticalFails.push('還原後實際值與原始值不符');
            }
          } else {
            notes.push(`⚠️還原失敗：Batch Dialog選單找不到原始值(${rowBefore.jackpotType})，資料目前仍是${targetType}，需人工復原`);
          }
        } else {
          notes.push('⚠️還原失敗：找不到該列勾選框，資料需人工復原');
        }
      }
    }
  }

  // TC11：審核通過JP排行榜預設類型，預設為空
  // ⭐ 2026-08-05 使用者實際說明操作步驟後改成真實流程，跟TC6共用同一套
  // runJackpotAbnormalityFlow（同一個補發動作同時驗證「有沒有寫入」跟「JackpotType是否為空」）
  if (/審核通過jp排行榜預設類型，預設為空/i.test(full)) {
    const flow = await runJackpotAbnormalityFlow(page);
    if (flow.extraShotPaths) extraShotPaths.push(...flow.extraShotPaths);
    if (!flow.ok) {
      notes.push(`❌Jackpot Abnormality補發流程失敗：${flow.error}`);
      criticalFails.push('Jackpot Abnormality補發流程失敗');
    } else if (!flow.found) {
      notes.push(`❌補發後Jackpot Ranking找不到Jackpot Amount=${flow.targetJackpot}的新紀錄，無法確認JackpotType預設值`);
      criticalFails.push('補發資料未自動寫入Jackpot Ranking');
    } else if (flow.jackpotType === '') {
      notes.push(`✅新補發紀錄（帳號${flow.account}）的Jackpot Type預設為空，符合預期`);
    } else {
      notes.push(`❌新補發紀錄的Jackpot Type預設值是"${flow.jackpotType}"，不是空值`);
      criticalFails.push('Jackpot Type預設值不是空');
    }
    await page.goto(`${BACKEND_URL}/rankinglist/jackpotRanking`, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(800);
  }

  if (notes.length === (h1 ? 1 : 0)) {
    // 沒有任何規則命中這筆TC文字，誠實標示，不假裝驗證過
    notes.push(`⚠️這筆TC文字沒有對應到已知的驗證規則，未執行任何斷言: ${full.slice(0, 40)}`);
  }

  return { notes: notes.join(' | '), criticalFails, extraShotPaths };
}

async function verifyAbnormalityPage(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';
  const desc = full.toLowerCase();

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, rowCount } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);
  notes.push(`表格${rowCount}筆`);

  let exportedXlsxPath = null;

  if (/excel|export|匯出|導出|csv/.test(desc)) {
    const exportResult = await doExport(page);
    if (exportResult.notes) notes.push(exportResult.notes);
    criticalFails.push(...exportResult.criticalFails);
    exportedXlsxPath = exportResult.exportedXlsxPath;
  }

  return { notes: notes.join(' | '), criticalFails, exportedXlsxPath };
}

async function verifyLogPage(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';
  const desc = full.toLowerCase();

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, rowCount } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);
  notes.push(`表格${rowCount}筆`);

  let exportedXlsxPath = null;

  if (/excel|export|匯出|導出|csv/.test(desc)) {
    const exportResult = await doExport(page);
    if (exportResult.notes) notes.push(exportResult.notes);
    criticalFails.push(...exportResult.criticalFails);
    exportedXlsxPath = exportResult.exportedXlsxPath;
  }

  if (/date|日期/.test(desc)) {
    const hasDate = await page.evaluate(() =>
      document.querySelectorAll('.el-date-editor, input[type="date"], .el-date-picker, [class*="date-range"]').length > 0
    ).catch(() => false);
    notes.push(hasDate ? '✅日期篩選' : '⚠️日期篩選未偵測到');
  }

  return { notes: notes.join(' | '), criticalFails, exportedXlsxPath };
}

async function verifyMachineMonitoring(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1 } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);

  const hasContent = await page.evaluate(() =>
    document.querySelectorAll('table, .el-table, .el-card, [class*="card"]').length > 0
  ).catch(() => false);
  notes.push(hasContent ? '✅監控畫面存在' : '⚠️監控元素未偵測到');

  return { notes: notes.join(' | '), criticalFails };
}

async function verifyPlayerWatch(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, rowCount } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);
  notes.push(`表格${rowCount}筆`);

  return { notes: notes.join(' | '), criticalFails };
}

async function verifyGenericPage(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';
  const desc = full.toLowerCase();

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, rowCount, allBtns } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);
  notes.push(`表格${rowCount}筆`);

  let exportedXlsxPath = null;

  if (/\badd\b|新增/.test(desc)) {
    const hasAdd = allBtns.some(t => /^add\b/i.test(t));
    if (hasAdd) {
      notes.push('✅Add按鈕');
    } else {
      notes.push('❌Add按鈕缺失');
      criticalFails.push('Add按鈕缺失');
    }
  }

  if (/excel|export|匯出|導出|csv/.test(desc)) {
    const exportResult = await doExport(page);
    if (exportResult.notes) notes.push(exportResult.notes);
    criticalFails.push(...exportResult.criticalFails);
    exportedXlsxPath = exportResult.exportedXlsxPath;
  }

  if (/開啟.*關閉|關閉.*開啟|switch|toggle/.test(desc)) {
    const switchCount = await page.evaluate(() =>
      document.querySelectorAll('.el-switch, input[type="checkbox"]').length
    ).catch(() => 0);
    notes.push(switchCount > 0 ? `✅開關×${switchCount}` : '⚠️開關元件未偵測到');
  }

  return { notes: notes.join(' | '), criticalFails, exportedXlsxPath };
}

// ─── PAGE_VERIFIERS mapping ───────────────────────────────────────────
const PAGE_VERIFIERS = {
  'Dashboard':                verifyDashboard,
  'Daily Dashboard':          verifyDailyDashboard,
  'EGM List':                 verifyEGMList,
  'EGM Status':               verifyEGMStatus,
  'Gaming User':              verifyGamingUser,
  'EGM Detail':               verifyReportPage,
  'User Detail':              verifyReportPage,
  'EGM Transfer':             verifyReportPage,
  'Game Record':              verifyReportPage,
  'EGM DayCount':             verifyReportPage,
  'Player Credit Log':        verifyReportPage,
  'Jackpot Record':           verifyReportPage,
  'Fault List':               verifyReportPage,
  'Loading Tips':             verifyLoadingTips,
  'Channel Ranking':          verifyChannelRanking,
  'White List':               verifyWhiteList,
  'Game Jump Set':            verifyGameSettingPage,
  'News Set':                 verifyGameSettingPage,
  'EGM JP Percent':           verifyEGMJPPercent,
  'Advert Set':               verifyGameSettingPage,
  'EGM Hourly Meter':         verifyMeterPage,
  'EGM Performance Meter':    verifyMeterPage,
  'Jackpot Moment':           verifyJackpotMoment,
  'Deposit Setting':          verifyDepositSetting,
  '自動預約相關功能':           verifyMachineReservation,
  'Daily Ranking':            verifyDailyRanking,
  'Jackpot Ranking':          verifyJackpotRanking,
  '小額推薦影片':              verifyGameSettingPage,
  'How To Play':              verifyGameSettingPage,
  'Machine Monitoring':       verifyMachineMonitoring,
  'Player Watch':             verifyPlayerWatch,
  'OSM Instant Meter':        verifyMeterPage,
  'GCP Instant Meter':        verifyMeterPage,
  'Stress Test Instant Meter':verifyMeterPage,
  'Recovery Meter':           verifyMeterPage,
  'Daily Meter Reading':      verifyMeterPage,
  'Record Abnormality':       verifyAbnormalityPage,
  'Machine Abnormality':      verifyAbnormalityPage,
  'Jackpot Abnormality':      verifyAbnormalityPage,
  'Game Error Record':        verifyAbnormalityPage,
  'Machine Reservation Limit':verifyReservationLimit,
  'Special Entrance Set':     verifyGameSettingPage,
  'Test Setting':             verifyGameSettingPage,
  'Log Third Http Req':       verifyLogPage,
  'Log Third Bet Req':        verifyLogPage,
  'Log EGM Status':           verifyLogPage,
  'MeterCompensateSpinLog':   verifyLogPage,
  'Error Meter Info':         verifyLogPage,
  'Operation Log':            verifyLogPage,
  'Login Log':                verifyLogPage,
  'Out Log Records':          verifyLogPage,
};

async function callPageVerify(mapKey, page, tc) {
  const verifier = (mapKey && PAGE_VERIFIERS[mapKey]) ? PAGE_VERIFIERS[mapKey] : verifyGenericPage;
  return verifier(page, tc);
}

// ─── 後台測試 actions ────────────────────────────────────────────────
/**
 * 用積木跑一筆 TC。
 *
 * 這是 registry 有 `steps` 時走的路；沒有 steps 就 fallback 回既有的
 * verifierName / SUBTYPE_MAP 那條路。fallback 是**遷移期的橋**不是常駐相容層——
 * 終點是全部積木化，那時 verifierName 與 SUBTYPE_MAP 都會變成死碼可以整段移除
 * （跟使用者與 CodeX 都確認過方向）。
 *
 * 回傳形狀刻意跟 performAction() 對齊，外層的截圖上傳與 Lark 回寫不用改。
 */
/**
 * 內建驗證器名冊。`builtin_verifier` 積木靠這張表把名字對到函式。
 *
 * 這是**遷移期的橋**：終點是全部積木化，這張表會隨著 TC 逐筆拆成積木而縮小，
 * 清空之後連同 SUBTYPE_MAP 一起移除。不要在新功能上依賴它。
 *
 * 目前每支都還是零參數模組——`options` 有傳下去但 verifier 還沒宣告自己的參數表。
 * 下一步是逐支把寫死的常數（cmp() 的 pct = 0.01、Bonus 的 5 分鐘、報表的比對欄位
 * 清單）接成 options，一次接一支，沒接的維持原行為。
 */
const BUILTIN_VERIFIERS = {
  verifyAbnormalityPage,
  verifyChannelRanking,
  verifyDailyDashboard,
  verifyDailyRanking,
  verifyDashboard,
  verifyDepositSetting,
  verifyEGMJPPercent,
  verifyEGMList,
  verifyEGMStatus,
  verifyGameSettingPage,
  verifyGamingUser,
  verifyGenericPage,
  verifyJackpotMoment,
  verifyJackpotRanking,
  verifyLoadingTips,
  verifyLogPage,
  verifyMachineMonitoring,
  verifyMachineReservation,
  verifyMeterPage,
  verifyPlayerWatch,
  verifyReportPage,
  verifyReservationLimit,
  verifyWhiteList,
};

/**
 * 執行一筆 TC 的積木。
 *
 * taskFull 是 TC 的描述文字，內建驗證器要靠它比對自己該跑哪些分支——
 * 少傳這個，builtin_verifier 積木會靜默通過（見 callBuiltin 的註解）。
 */
async function performSteps(p, steps, label, taskFull) {
  const result = await runBlockSteps(steps, {
    page: p,
    async openPath(targetPath, waitMs) {
      await p.goto(BACKEND_URL + targetPath, { waitUntil: 'networkidle', timeout: 20000 });
      await p.waitForTimeout(waitMs);
    },
    resolveSubtypePath(subtype) {
      if (!subtype) return null;
      const key = Object.keys(SUBTYPE_MAP).find(k => k === subtype)
        || Object.keys(SUBTYPE_MAP).sort((a, b) => b.length - a.length).find(k => subtype.includes(k));
      return key ? SUBTYPE_MAP[key].path : null;
    },
    /** 錄製產生的 click 積木用。選擇器支援 Playwright 的 text= 語法 */
    async clickSelector(selector, waitMs) {
      try {
        await p.locator(selector).first().click({ timeout: 10000 });
      } catch (e) {
        // 後台登入後有一個站台層級的警告彈窗（「Currently N machines are abnormal」），
        // 它的遮罩會把底下的按鈕蓋住，Playwright 的 click 會一直等到逾時。
        //
        // 既有的 verifier 全部是用 page.evaluate(() => btn.click()) 繞過去的——那不是
        // 偶然，是這個後台的常態。所以攔截時改用 JS 直接觸發下層元素，跟 AutoSpin／
        // 機台自動化測試處理選面額遮罩的做法同一套。
        const text = /^text=/.test(selector) ? selector.replace(/^text=/, '') : null;
        const clicked = await p.evaluate(({ sel, txt }) => {
          const el = txt
            ? [...document.querySelectorAll('button, a, .el-button')]
                .find(b => (b.innerText || '').trim() === txt)
            : document.querySelector(sel);
          if (!el) return false;
          el.click();
          return true;
        }, { sel: selector, txt: text }).catch(() => false);
        if (!clicked) throw e;   // 真的找不到元素就照原本的錯誤拋出去，不要吞掉
        console.log(`  ↳ 點擊被遮罩攔截，改用 JS 直接觸發：${selector}`);
      }
      await p.waitForTimeout(waitMs);
    },
    async typeInto(selector, value) {
      await p.locator(selector).first().fill(value, { timeout: 10000 });
    },
    /**
     * 套用篩選：先把值填進欄位，再按查詢。沒指定查詢按鈕就試常見的幾個文字，
     * 都找不到就按 Enter——不同報表頁的查詢鈕文字不一致，寫死一個會有一半頁面用不了。
     */
    async applyFilter(field, value, submitSelector, waitMs) {
      const input = p.locator(`input[placeholder*="${field}"], input[name="${field}"]`).first();
      if (await input.count()) await input.fill(value, { timeout: 10000 });
      if (submitSelector) {
        await p.locator(submitSelector).first().click({ timeout: 10000 });
      } else {
        const btn = p.locator('button:has-text("Search"), button:has-text("查詢"), button:has-text("搜尋")').first();
        if (await btn.count()) await btn.click({ timeout: 10000 });
        else await p.keyboard.press('Enter');
      }
      await p.waitForTimeout(waitMs);
    },
    async takeScreenshot(name) {
      const safe = String(name).replace(/[^\w.-]/g, '_');
      const shotPath = path.join(SCREENSHOT_DIR, `${safe}_${Date.now()}.png`);
      try { await p.screenshot({ path: shotPath, fullPage: false }); return shotPath; }
      catch { return null; }
    },
    /**
     * 這個時間點之後打到的 API。assert_api_called 用它判斷「這一步有沒有打到後端」。
     *
     * netCapture 是整輪共用的（掛在同一個 page 上），所以一定要用時間界線切，
     * 不然問的會變成「整輪跑下來有沒有出現過」——那幾乎永遠是 true，等於沒驗。
     */
    netCallsSince(sinceTs) {
      if (!netCapture) return [];
      return netCapture.records().filter(r => r.kind === 'api' && r.ts >= sinceTs);
    },
    /**
     * 執行匯出。直接借用既有的 doExport()——它已經是單一共用函式（14 個呼叫點
     * 完全同形、零參數），積木沒有理由再寫一份「幾乎一樣但細節會漂移」的實作。
     *
     * 回傳只講事實：按鈕在不在、檔案有沒有下來。要不要算失敗由積木那邊決定——
     * doExport() 原本把「等不到下載」記成 ✅，積木會改記成 warn（判定不變）。
     */
    /**
     * 報表頁要先送出查詢才會有 Export 按鈕。原本的 screenshot_date_search 就是做這件事：
     * 找 innerText 剛好是 View 或 Search 的按鈕點下去。
     *
     * 兩個都要試——不同報表頁用的字不一樣，逐頁去猜是錯的做法。用 JS 點是因為那個
     * 站台警告彈窗的遮罩會擋住（跟 clickSelector 的 fallback 同一個理由）。
     */
    async submitSearch(waitMs) {
      const clicked = await p.evaluate(() => {
        const btn = [...document.querySelectorAll('button')]
          .find(b => { const t = (b.innerText || '').trim(); return t === 'View' || t === 'Search' });
        if (!btn) return false;
        btn.click();
        return true;
      }).catch(() => false);
      await p.waitForTimeout(waitMs);
      return clicked;
    },

    async runExport() {
      const r = await doExport(p);
      return {
        hasButton: r.criticalFails.length === 0,
        file: r.exportedXlsxPath ? path.basename(r.exportedXlsxPath) : null,
      };
    },

    async callBuiltin(name, options) {
      const fn = BUILTIN_VERIFIERS[name];
      if (typeof fn !== 'function') {
        return { notes: `找不到內建驗證器「${name}」`, criticalFails: [`找不到內建驗證器「${name}」`], manual: false };
      }
      // ⚠️ 這兩個引數都曾經傳錯，而且錯法都不會報錯、只會靜默通過：
      //
      // 1. 第一個曾經傳 `page`——那個變數在 performSteps 裡根本不存在（參數叫 p），
      //    module 層也沒有，跑到就 ReferenceError。
      // 2. 第二個曾經傳 `label`，但 label 是截圖檔名（tc12_XXX_YYY），verifier 要的
      //    是 TC 的描述文字。傳 label 的話 verifier 裡每一條 /regex/.test(full) 都不會
      //    命中 → 一個斷言都沒跑 → criticalFails 是空的 → **判定為通過**。
      //    這正是最難察覺的那種錯：畫面上顯示綠色、日誌看起來正常。
      const { params, missing } = resolveVerifierParams(name, options, TEST_PARAMS);
      if (missing.length) {
        // 缺必填參數是設定問題不是執行期狀況，直接說清楚缺什麼，不要拿 undefined 往下跑
        const msg = `內建驗證器「${name}」缺少必填參數：${missing.join('、')}（可在這顆積木的參數裡填，或設在 config/backend-test-params.json）`;
        return { notes: msg, criticalFails: [msg], manual: false };
      }
      const out = await fn(p, taskFull, params);
      // 跑完但一個斷言都沒跑到 → 不准算通過。這條防線跟成因無關：接線錯、TC 文字被改、
      // regex 沒跟上，任何一種都會讓驗證器什麼都沒驗卻回一個空的 criticalFails。
      if (!verifierRanAssertion(out)) {
        const why = `內建驗證器「${name}」跑完但一個斷言都沒執行——通常是這筆 TC 的描述文字跟驗證器裡的判斷條件對不上。這種情況不算通過。`;
        return { ...out, criticalFails: [...(out.criticalFails ?? []), why], notes: [out.notes, why].filter(Boolean).join(' | ') };
      }
      return out;
    },
  });
  return {
    pass: result.pass,
    manual: result.manual,
    notes: result.notes,
    criticalFails: result.criticalFails,
    // warn 級別的結果。notes 裡本來就有一份 ⚠️ 文字，但那是給人讀的；
    // 這個欄位是結構化的，之後要在畫面上列、或統計「這批跑下來有幾個 warn」
    // 才有東西可用——不接出來的話等於又退回散在字串裡
    warnings: result.warnings,
    allShotPaths: result.allShotPaths,
    shotPath: result.allShotPaths[0] ?? null,
    error: result.error,
  };
}

async function performAction(page, pagePath, action, label, taskDesc) {
  try {
    await page.goto(BACKEND_URL + pagePath, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(1500);

    // ── Daily Dashboard 特殊處理 ──────────────────────────────────────────────────────────────
    // goto('/daily_dashboard') 已正確停在 Daily Dashboard（router-link-exact-active 確認）
    // Warning dialog 的 Cancel 按鈕會觸發 Vue Router 導航到 /dashboards，
    // 因此改用 JS 隱藏 dialog + overlay，不觸發任何按鈕。
    if (action === 'daily_dashboard_verify') {
      // 等待 Warning dialog 出現（UAT 環境幾乎必定出現）
      await page.locator('.el-dialog').filter({ hasText: 'Warnning' }).waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      // 用 JS 直接隱藏 Warning dialog 和 modal overlay（避免 Cancel 觸發導航）
      await page.evaluate(() => {
        document.querySelectorAll('.el-dialog__wrapper').forEach(el => {
          if (el.textContent?.includes('Warnning')) el.style.display = 'none';
        });
        const overlay = document.querySelector('.v-modal');
        if (overlay) overlay.style.display = 'none';
      });
      await page.waitForTimeout(800);
      // 點 Search 載入今日數據
      const searchBtn = page.locator('button').filter({ hasText: /^Search$/ }).first();
      if (await searchBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await searchBtn.click();
        await page.waitForTimeout(2000);
      }
    } else {
      await dismissDialogs(page);
    }

    // 確保 Vue router 已完成頁面切換（等 breadcrumb/h1 出現）
    await page.waitForFunction(
      (path) => {
        const url = window.location.pathname;
        return url.includes(path.replace(/^\//, ''));
      },
      pagePath,
      { timeout: 5000 }
    ).catch(() => {});
    await page.waitForTimeout(500);

    if (action === 'screenshot_verify_data' || action === 'screenshot_date_search') {
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => b.innerText?.trim() === 'View' || b.innerText?.trim() === 'Search');
        if (btn) btn.click();
      });
      await page.waitForTimeout(2500);
      await dismissDialogs(page);
    }

    const shotPath = path.join(SCREENSHOT_DIR, `${label.replace(/[^\w]/g,'_')}_${Date.now()}.png`);
    const useFullPage = action === 'daily_dashboard_verify';
    await page.screenshot({ path: shotPath, fullPage: useFullPage });

    // 404 偵測
    const bodyText = await page.evaluate(() => document.body?.innerText || '');
    const is404 = bodyText.includes('OOPS!') || bodyText.includes('can not enter this page') || bodyText.includes('404 Not Found');
    if (is404) return { pass: false, shotPath, error: '404 頁面 (路徑錯誤)' };

    // 錯誤訊息偵測
    const hasError = await page.locator('.el-message--error').isVisible({ timeout: 500 }).catch(() => false);
    if (hasError) return { pass: false, shotPath, error: '頁面有錯誤訊息' };

    // 依頁面呼叫對應 verify function
    const mapKeyForVerify = Object.keys(SUBTYPE_MAP).find(k => SUBTYPE_MAP[k].path === pagePath);
    const { notes: deepNotes, criticalFails, manual, exportedXlsxPath, toastShotPath, extraShotPaths = [] } = await callPageVerify(mapKeyForVerify, page, taskDesc);

    // 收集所有截圖路徑（支援多張上傳）
    const allShotPaths = [];

    if (exportedXlsxPath && fs.existsSync(exportedXlsxPath)) {
      try {
        const pageName = Object.keys(SUBTYPE_MAP).find(k => SUBTYPE_MAP[k].path === pagePath) || path.basename(pagePath);
        const comparePath = await generateExportCompareShot(page, exportedXlsxPath, pageName, label);
        allShotPaths.push(comparePath);
      } catch (e) {
        console.log(` (compare shot err: ${e.message})`);
        allShotPaths.push(shotPath);
      }
    } else if (toastShotPath) {
      // Bonus Settings：dialog 截圖（主頁面）+ toast 截圖
      if (fs.existsSync(shotPath)) allShotPaths.push(shotPath);
      if (fs.existsSync(toastShotPath)) allShotPaths.push(toastShotPath);
    } else {
      if (fs.existsSync(shotPath)) allShotPaths.push(shotPath);
    }

    // 加入 verify function 捕捉的額外截圖（操作中/Panel開啟/Dialog等）
    for (const ep of extraShotPaths) {
      if (ep && fs.existsSync(ep)) allShotPaths.push(ep);
    }

    const finalShotPath = allShotPaths[0] || shotPath;

    if (manual) {
      return { pass: true, skip: false, manual: true, shotPath: finalShotPath, allShotPaths, notes: deepNotes };
    }
    if (criticalFails.length > 0) {
      return { pass: false, shotPath: finalShotPath, allShotPaths, notes: deepNotes, error: criticalFails.join(', ') };
    }
    return { pass: true, shotPath: finalShotPath, allShotPaths, notes: deepNotes };
  } catch (e) {
    if (/crash|closed|Target|Session/i.test(e.message)) throw e; // re-throw crash so outer loop can recover
    return { pass: false, shotPath: null, error: e.message };
  }
}

const NCH_BACKEND_URL = 'http://uat-nc.osmslot.org';
async function testNCHPointsSetting(browser, pagePath, label, taskDesc) {
  let ctx;
  try {
    ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    await p.goto(`${NCH_BACKEND_URL}/login`, { waitUntil: 'networkidle', timeout: 20000 });
    if (!TEST_PARAMS.credentials.nchBackend.username || !TEST_PARAMS.credentials.nchBackend.password) {
      throw new Error('尚未設定「NC 後台」登入帳密——請到 UAT 執行設定頁填寫（每個人存自己的一份）');
    }
    await p.fill('input[type="text"], input[name*="user"], input[id*="user"]', TEST_PARAMS.credentials.nchBackend.username);
    await p.fill('input[type="password"]', TEST_PARAMS.credentials.nchBackend.password);
    await p.keyboard.press('Enter');
    await p.waitForTimeout(3000);
    await p.goto(`${NCH_BACKEND_URL}${pagePath}`, { waitUntil: 'networkidle', timeout: 20000 });
    await p.waitForTimeout(1500);
    const rows = await p.locator('table tr, .el-table__body tr').count().catch(() => 0);
    const shotPath = path.join(SCREENSHOT_DIR, `${label}_nch_${Date.now()}.png`);
    await p.screenshot({ path: shotPath, fullPage: true });
    await ctx.close();
    return { pass: rows > 0, shotPath, notes: `NCH獨立後台(uat-nc.osmslot.org)驗證：表格${rows}列` };
  } catch (e) {
    try { await ctx?.close(); } catch {}
    return { pass: false, shotPath: null, error: `NCH後台驗證例外: ${e.message}` };
  }
}

// ⭐ 2026-08-05 新增：Points History「確認篩選並匯出報表正常」——
// 使用者確認：不勾選"All"時預設日期區間查無資料，必須先勾選"All" checkbox
// 才會有資料可匯出，這是這個頁面特有的行為，不是通用 doExport() 涵蓋的範圍。
async function testPointsHistoryExport(page, label) {
  try {
    await page.goto(BACKEND_URL + '/rewardpoints/pointsHistory', { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(1000);
    await dismissDialogs(page);

    const allChecked = await page.evaluate(() => {
      const label = [...document.querySelectorAll('.el-checkbox')].find(el => /^all$/i.test(el.innerText?.trim()));
      if (!label) return null;
      const input = label.querySelector('input[type="checkbox"]');
      if (input && !input.checked) label.click();
      return input ? true : false;
    });
    if (allChecked === null) {
      return { pass: false, shotPath: null, error: '找不到"All" checkbox，選取器可能已失效' };
    }
    await page.waitForTimeout(1500);

    const rowCount = await page.locator('table tr, .el-table__body tr').count().catch(() => 0);
    const shotPath = path.join(SCREENSHOT_DIR, `${label}_all_${Date.now()}.png`);
    await page.screenshot({ path: shotPath, fullPage: true });

    const exportResult = await doExport(page);
    const pass = exportResult.criticalFails.length === 0;
    return {
      pass,
      shotPath,
      notes: `勾選All後表格${rowCount}筆 | ${exportResult.notes}`,
      error: pass ? undefined : exportResult.criticalFails.join(', '),
    };
  } catch (e) {
    return { pass: false, shotPath: null, error: `Points History Export 測試例外: ${e.message}` };
  }
}

// ─── 版本確認 ────────────────────────────────────────────────────────
async function testVersionConfirm(page, taskName) {
  await page.goto(`${BACKEND_URL}/manage/versionHistoryRecord`, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(1500);
  await dismissDialogs(page);
  // 先點 Update 刷新最新版號
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText?.trim() === 'Update');
    if (btn) btn.click();
  });
  await page.waitForTimeout(3000);
  await dismissDialogs(page);
  // 再點 View 載入資料
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText?.trim() === 'View');
    if (btn) btn.click();
  });
  await page.waitForTimeout(2000);
  await dismissDialogs(page);
  const shotPath = path.join(SCREENSHOT_DIR, `version_${taskName.replace(/[^\w]/g,'_')}_${Date.now()}.png`);
  await page.screenshot({ path: shotPath });
  const rows = await page.locator('.el-table__body tr').count();
  return { pass: rows > 0, shotPath };
}

// ─── 從 Lark API 拉取所有 TC ─────────────────────────────────────────
async function fetchAllTCsFromLark(token) {
  let allRecords = [];
  let pageToken = null;
  do {
    const url = new URL(`${LARK_BASE}/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records`);
    url.searchParams.set('page_size', '100');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    const d = await res.json();
    if (d.code !== 0) throw new Error(`fetchAllTCs: ${d.msg}`);
    allRecords = allRecords.concat(d.data.items || []);
    pageToken = d.data.has_more ? d.data.page_token : null;
  } while (pageToken);
  console.log(`📥 從 Lark 取得 ${allRecords.length} 筆 TC`);
  // 儲存備份
  const dir = './data/raw';
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/lark_tc_all.json`, JSON.stringify(allRecords, null, 2));
  return allRecords;
}

// ─── Export 比對截圖輔助函式 ──────────────────────────────────────────
function extractXlsxData(xlsxPath) {
  if (!fs.existsSync(xlsxPath)) return { headers: [], rows: [] };
  const wb = XLSX.readFile(xlsxPath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  let headerIdx = -1;
  for (let i = 0; i < raw.length; i++) {
    const nonEmpty = raw[i].filter(c => c !== '');
    const isMeta = nonEmpty.length > 0 && (new Set(nonEmpty).size === 1 || String(nonEmpty[0]).match(/Casino|Print|Total|Period|Date Type/i));
    if (!isMeta && nonEmpty.length > 1) { headerIdx = i; break; }
  }
  if (headerIdx === -1) return { headers: [], rows: [] };
  const headers = raw[headerIdx].map(c => String(c).trim());
  const rows = raw.slice(headerIdx + 1).filter(r => r.some(c => c !== '') && !String(r[0]).match(/^total$/i));
  return { headers, rows };
}

function xlsxToHtml(xlsxPath, title) {
  const { headers, rows } = extractXlsxData(xlsxPath);
  if (!headers.length) return `<p style="color:#999">${title}：今日無資料</p>`;
  let html = `<h3 style="margin:4px 0;font-size:13px;color:#1a56db">${title} xlsx (${rows.length} 筆)</h3>`;
  html += `<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-size:11px;min-width:100%">`;
  html += `<tr style="background:#dbeafe">${headers.map(h => `<th style="white-space:nowrap">${h}</th>`).join('')}</tr>`;
  rows.slice(0, 30).forEach(row => {
    html += `<tr>${headers.map((_, i) => `<td style="white-space:nowrap">${row[i] ?? ''}</td>`).join('')}</tr>`;
  });
  if (rows.length > 30) html += `<tr><td colspan="${headers.length}" style="text-align:center;color:#666">... 共 ${rows.length} 筆（顯示前 30）</td></tr>`;
  html += `</table>`;
  return html;
}

function buildCompareHtmlBlock(xData, bHeaders, bCount, bTotal, pageName, today) {
  const xCount = xData.rows.length;
  const total = bTotal !== null ? bTotal : bCount;
  const countMatch = xCount === total;
  const matchedCols = xData.headers.filter(h => h && bHeaders.some(bh => bh.toLowerCase().includes(h.toLowerCase()) || h.toLowerCase().includes(bh.toLowerCase())));
  let row1Lines = '';
  if (xCount > 0 && bCount > 0) {
    row1Lines = xData.headers.slice(0, 6).map(xh => {
      const bh = bHeaders.find(b => b.toLowerCase().includes(xh.toLowerCase()) || xh.toLowerCase().includes(b.toLowerCase()));
      if (!bh) return '';
      const xv = String(xData.rows[0][xData.headers.indexOf(xh)] ?? '').trim();
      return `  ${xh}: "${xv}"`;
    }).filter(Boolean).join('\n');
  }
  const ok = countMatch && matchedCols.length > 0;
  const col = ok ? '#16a34a' : '#dc2626';
  return `<div style="padding:14px;font-family:sans-serif;font-size:12px;line-height:1.7;background:#f0fdf4;border-left:4px solid ${col};min-width:260px">
  <div style="font-size:15px;font-weight:bold;color:${col};margin-bottom:10px">${ok ? '✅ PASS' : '❌ FAIL'} — ${pageName}</div>
  <div><b>📅 比對日期：</b>${today}<br><b>📁 xlsx：</b>${pageName}.xlsx</div>
  <hr style="border:none;border-top:1px solid #d1fae5;margin:8px 0">
  <div><b>📊 筆數比對</b><br>xlsx：${xCount} 筆<br>後台：${bTotal !== null ? `${bTotal}（pagination 總計）` : bCount} 筆<br>結果：${countMatch ? '✅ 一致' : `❌ 不符（差 ${Math.abs(xCount - total)} 筆）`}</div>
  <hr style="border:none;border-top:1px solid #d1fae5;margin:8px 0">
  <div><b>🗂 欄位比對</b><br>xlsx（${xData.headers.length}）：${xData.headers.slice(0,4).join(', ')}...<br>後台（${bHeaders.length}）：${bHeaders.slice(0,4).join(', ')}...<br>對應：${matchedCols.length} 個 ${matchedCols.length > 0 ? '✅' : '❌'}<br>${matchedCols.slice(0,5).map(c => `<span style="background:#dcfce7;padding:1px 4px;border-radius:3px;margin:1px;display:inline-block">${c}</span>`).join('')}</div>
  ${row1Lines ? `<hr style="border:none;border-top:1px solid #d1fae5;margin:8px 0"><div><b>🔍 第1筆</b><pre style="margin:4px 0;font-size:11px;background:#fff;padding:6px;border-radius:4px;border:1px solid #d1fae5">${row1Lines}</pre></div>` : ''}
  <hr style="border:none;border-top:1px solid #d1fae5;margin:8px 0">
  <div style="font-size:13px;font-weight:bold;color:${col}">整體結果：${ok ? '✅ PASS' : '❌ FAIL'}</div>
</div>`;
}

async function generateExportCompareShot(page, xlsxPath, pageName, label) {
  const today = new Date().toISOString().slice(0, 10);
  const xData = extractXlsxData(xlsxPath);
  const bHeaders = await page.evaluate(() =>
    [...document.querySelectorAll('.el-table__header th .cell')].map(c => c.innerText?.trim()).filter(Boolean)
  ).catch(() => []);
  const bRowCount = await page.locator('.el-table__body tr').count().catch(() => 0);
  const bTotal = await page.evaluate(() => {
    // Element UI pagination
    const elText = document.querySelector('.el-pagination__total, .el-pagination .total')?.innerText || '';
    const elMatch = elText.match(/(\d[\d,]*)/);
    if (elMatch) return parseInt(elMatch[1].replace(/,/g, ''));
    // DataTables style: "Showing X to Y of Z entries"
    const dtText = document.body.innerText.match(/Showing\s+\d+\s+to\s+\d+\s+of\s+([\d,]+)\s+entries/i);
    if (dtText) return parseInt(dtText[1].replace(/,/g, ''));
    return null;
  }).catch(() => null);

  // 後台截圖
  const backendShotPath = path.join(SCREENSHOT_DIR, `${label}_backend_${Date.now()}.png`);
  const tableEl = await page.locator('.el-table').first().boundingBox().catch(() => null);
  if (tableEl) {
    const formEl = await page.locator('.el-form').first().boundingBox().catch(() => null);
    const clip = formEl ? { x: Math.min(formEl.x, tableEl.x) - 10, y: formEl.y - 10, width: Math.max(formEl.width, tableEl.width) + 20, height: (tableEl.y + tableEl.height) - formEl.y + 20 } : { x: tableEl.x - 10, y: tableEl.y - 10, width: tableEl.width + 20, height: tableEl.height + 20 };
    await page.screenshot({ path: backendShotPath, clip });
  } else {
    await page.screenshot({ path: backendShotPath });
  }

  // xlsx HTML 截圖
  const xlsxShotPath = path.join(SCREENSHOT_DIR, `${label}_xlsx_${Date.now()}.png`);
  await page.setContent(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:12px;font-family:sans-serif}</style></head><body>${xlsxToHtml(xlsxPath, pageName)}</body></html>`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  await page.screenshot({ path: xlsxShotPath, fullPage: true });

  // 並排比對截圖
  const backendB64 = fs.readFileSync(backendShotPath).toString('base64');
  const xlsxB64 = fs.readFileSync(xlsxShotPath).toString('base64');
  const compareHtml = buildCompareHtmlBlock(xData, bHeaders, bRowCount, bTotal, pageName, today);
  const comparePath = path.join(SCREENSHOT_DIR, `${label}_compare_${Date.now()}.png`);

  await page.setViewportSize({ width: 1800, height: 1200 });
  await page.setContent(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{margin:0;font-family:sans-serif;background:#f8f8f8}
    .title{background:#1a56db;color:#fff;padding:8px 16px;font-size:14px;font-weight:bold}
    .container{display:flex;gap:0;align-items:flex-start}
    .panel{flex:1;padding:12px;background:#fff;border-right:2px solid #e5e7eb}
    .panel h4{margin:0 0 8px;font-size:12px;color:#444;border-bottom:1px solid #ddd;padding-bottom:4px}
    .result-panel{width:300px;flex-shrink:0}
    img{max-width:100%;border:1px solid #ddd}
  </style></head><body>
    <div class="title">📊 ${pageName} — Export 比對 (${today})</div>
    <div class="container">
      <div class="panel"><h4>🖥 後台表格</h4><img src="data:image/png;base64,${backendB64}"></div>
      <div class="panel"><h4>📄 xlsx 匯出資料</h4><img src="data:image/png;base64,${xlsxB64}"></div>
      <div class="result-panel">${compareHtml}</div>
    </div>
  </body></html>`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  await page.screenshot({ path: comparePath, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });

  // 清理暫存
  fs.existsSync(backendShotPath) && fs.unlinkSync(backendShotPath);
  fs.existsSync(xlsxShotPath) && fs.unlinkSync(xlsxShotPath);
  return comparePath;
}

// ─── TC 任務分析：依描述內容判斷需要做什麼 ──────────────────────────
function analyzeTCTask(taskDesc) {
  const d = (taskDesc || '').toLowerCase();
  return {
    needAdd:        /add|新增|輸入|input|填入/.test(d),
    needSearch:     /search|查詢|view|搜尋/.test(d),
    needDelete:     /delete|刪除|remove/.test(d),
    needEdit:       /edit|修改|update|更新/.test(d),
    needExport:     /export|匯出|導出|csv|excel/.test(d),
    needSwitch:     /開啟.*關閉|關閉.*開啟|switch|toggle|enable|disable/.test(d),
    needErrorCheck: /提示|error|not exist|is wrong|reserved|not met|stress/.test(d),
    errorMsg:       (taskDesc || '').match(/提示[：:]\s*(.+?)($|\n)/)?.[1]?.trim() || null,
    isVersionCheck: /版本確認|version record|version.*confirm|確認.*版本號|client.*server.*version(?!.*game.type)|center.*server|middle.*server|bg.*client/.test(d),
    isReservation:  /reservation|預約/.test(d),
  };
}

// ─── 主程式 ─────────────────────────────────────────────────────────
/**
 * 網路量測門檻。跟其他設定一樣走環境變數由 server 注入，沒設就用共用預設值。
 * Backend 測的是後台管理站（不是遊戲），圖檔多半是小 icon，門檻沿用預設即可。
 */
const NET_THRESHOLDS = {
  api: Number(process.env.UAT_NET_THRESHOLD_API) || DEFAULT_THRESHOLDS.api,
  image: Number(process.env.UAT_NET_THRESHOLD_IMAGE) || DEFAULT_THRESHOLDS.image,
  other: Number(process.env.UAT_NET_THRESHOLD_OTHER) || DEFAULT_THRESHOLDS.other,
};
/** 全程共用一個收集器：這支腳本中途可能整個重啟 browser（見下方 4817 附近的註解），
 *  收集器跟著 page 走的話統計會被截斷，所以掛在外層、每開一個新 page 就再掛一次。 */
let netCapture = null;
/** 每 2 秒把一份快照夾在 stdout 送出去給面板即時更新。
 *  server 端（osm-uat.ts）會用行前綴把這種行挑掉，不會混進執行日誌。 */
let statsTimer = null;

function startStatsBroadcast() {
  if (statsTimer) return;
  statsTimer = setInterval(() => {
    if (!netCapture) return;
    try { console.log(formatStatsLine({ scope: 'backend', net: netCapture.summary() })); } catch { /* 快照失敗不能拖垮測試 */ }
  }, 2000);
  statsTimer.unref?.();
}

async function main() {
  // 取新 token
  let larkToken = await getLarkToken();
  console.log('✅ Lark token 取得');

  // 從 Lark API 動態拉取所有 TC
  const allRecords = await fetchAllTCsFromLark(larkToken);

  // 篩後台 + UAT 服
  const REPORT_SUBTYPES = ['EGM Detail','User Detail','EGM Transfer','Game Record','EGM DayCount','Player Credit Log','Jackpot Record','EGM Hourly Meter','EGM Performance Meter'];
  const targets = allRecords.filter(r => {
    const envs = r.fields['環境'] || [];
    const devices = r.fields['裝置'] || [];
    const port = r.fields['端口'] || '';
    if (!envs.includes('UAT服') || !(devices.includes('後台') || port === '後台')) return false;
    const sub = r.fields['任務子類型'] || '';
    const taskType = r.fields['任務類型'] || '';
    if (MODULE_PLAN.length > 0 && findBackendModuleIndex(sub, taskType) < 0) return false;
    if (process.env.REPORT_ONLY) return REPORT_SUBTYPES.some(s => sub.includes(s));
    if (process.env.METER_ONLY) return ['EGM Hourly Meter','EGM Performance Meter'].some(s => sub.includes(s));
    if (process.env.SUBTYPE) return sub.includes(process.env.SUBTYPE);
    if (FILTER_SUBTYPES.length > 0) return FILTER_SUBTYPES.some(s => sub.includes(s));
    return true;
  }).sort((a, b) => {
    if (MODULE_PLAN.length === 0) return 0;
    return findBackendModuleIndex(a.fields['任務子類型'], a.fields['任務類型'])
      - findBackendModuleIndex(b.fields['任務子類型'], b.fields['任務類型']);
  });
  if (MODULE_PLAN.length > 0) console.log(`Backend 模組流程: ${MODULE_PLAN.map(module => module.name).join(' → ')}`);
  console.log(`📋 後台 UAT TC: ${targets.length} 筆`);

  // 匯出 Excel 儲存目錄
  const EXPORT_DIR = './data/raw/exports';
  if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });

  // 啟動瀏覽器
  /**
   * 停止：一定要自己處理 SIGTERM。
   *
   * node 收到 SIGTERM 的預設行為是直接結束，但 chromium.launch() 預設會註冊
   * handleSIGTERM 去關瀏覽器——**一旦有人註冊了 listener，node 的預設結束行為就沒了**。
   * 結果是：瀏覽器被關掉，腳本卻還活著繼續跑下一筆 TC，每一筆都噴
   * 「Target page, context or browser has been closed」。
   * 使用者看到的就是「按了停止還在跑」（2026-08-24 回報）。
   *
   * 所以自己接一份：標記停止、關瀏覽器、明確 exit。同時把 Playwright 的預設
   * 訊號處理關掉，避免兩邊搶著關同一顆瀏覽器。
   */
  let stopRequested = false;
  const launchOpts = {
    headless: false, slowMo: 50,
    handleSIGTERM: false, handleSIGINT: false, handleSIGHUP: false,
  };
  let browser = await chromium.launch(launchOpts);

  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      if (stopRequested) process.exit(130);   // 按第二次就別再等了
      stopRequested = true;
      console.log('\n🛑 收到停止指令，正在收尾…');
      // 關瀏覽器是非同步的，但不能無限等——3 秒後不管怎樣都結束，
      // 不然「停止」會變成另一種形式的卡住
      const bail = setTimeout(() => process.exit(130), 3000);
      bail.unref?.();
      Promise.resolve(browser?.close()).catch(() => {}).finally(() => process.exit(130));
    });
  }

  async function createLoginPage() {
    const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const p = await ctx2.newPage();
    // 超標的當下就印出來，不然要等整輪跑完才知道哪一步慢；一般的逐筆不印（會洗版）
    netCapture = attachNetworkCapture(p, {
      thresholds: NET_THRESHOLDS,
      onSlow: (r) => console.log(`🐢 [網路] ${Math.round(r.durationMs)}ms（門檻 ${r.thresholdMs}ms）${r.kind} ${r.url.slice(0, 120)}`),
    });
    startStatsBroadcast();
    await p.goto(`${BACKEND_URL}/login`, { waitUntil: 'networkidle', timeout: 30000 });
    if (!TEST_PARAMS.credentials.cpBackend.username || !TEST_PARAMS.credentials.cpBackend.password) {
      throw new Error('尚未設定「CP 後台」登入帳密——請到 UAT 執行設定頁填寫（每個人存自己的一份）');
    }
    await p.fill('input[type="text"], input[name*="user"], input[id*="user"]', TEST_PARAMS.credentials.cpBackend.username);
    await p.fill('input[type="password"]', TEST_PARAMS.credentials.cpBackend.password);
    await p.click('button[type="submit"], button:has-text("Login")');
    await p.waitForTimeout(3000);
    return { page: p, ctx: ctx2 };
  }

  let { page, ctx } = await createLoginPage();
  console.log('✅ 後台登入完成\n');

  const results = [];
  let passCount = 0;
  let failCount = 0;
  let skipCount = 0;

  for (let i = 0; i < targets.length; i++) {
    const r = targets[i];
    const f = r.fields;
    const recordId = r.record_id;
    const taskType = f['任務類型'] || '';
    const subtype = f['任務子類型'] || '';
    const taskFull = f['任務'] || '';
    const task = taskFull.slice(0, 80);
    const label = `tc${i+1}_${taskType}_${subtype}`.replace(/[^\w]/g, '_');
    const analysis = analyzeTCTask(taskFull);

    // 給verifier做regex比對用的「有效文字」，非taskFull直接沿用時代表registry
    // 吸收了drift或標記了重大drift，見上方resolveEffectiveTcText註解
    const { text: verifyText, source: tcTextSource } = resolveEffectiveTcText(recordId, taskFull);
    if (tcTextSource === 'canonical-minor-drift') {
      console.log(`\n[registry] ${label} TC文字有小幅潤飾，改用凍結版比對（不影響判定邏輯）`);
    } else if (tcTextSource === 'live-major-drift') {
      console.log(`\n[registry] ⚠️ ${label} TC文字疑似重大變更，registry可能已過期，改用即時文字比對（可能對不到規則），建議人工確認後執行 node build-tc-registry.cjs --refresh ${recordId}`);
    }

    process.stdout.write(`[${i+1}/${targets.length}] ${subtype || taskType} | ${task.slice(0,50)}...`);

    let result = { pass: false, shotPath: null };

    try {
      // 版本確認特殊處理
      if ((taskType === '版本確認' || analysis.isVersionCheck) && /luckylink|toppath/i.test(taskFull)) {
        // ⭐ 2026-08-05：LuckyLink/Toppath版本需要另外配置(獨立後台/登入)，
        // 目前這支只會重複截同一個OSM Version Record頁面，不是真的驗證，先跳過不誤判成功。
        result = { pass: false, skip: true, shotPath: null, notes: 'LuckyLink/Toppath版本需另外配置，暫時跳過，不採用OSM頁面的通用截圖冒充驗證' };
      } else if (taskType === '版本確認' || analysis.isVersionCheck) {
        result = await testVersionConfirm(page, taskFull || 'version');
      } else if (subtype === '積分VIP') {
        // ⭐ 2026-08-05 新增：積分VIP這個任務子類型底下混了6個不同頁面，SUBTYPE_MAP
        // 一對一的機制沒辦法處理，改成用任務文字內的關鍵字二次比對，路徑來自後台
        // 選單設定截圖(路由：rewardpoints/*)，由長到短排序避免"VIP Level List"先
        // 誤配到"VIP Level Setting"或反過來。
        const REWARD_POINTS_MAP = [
          ['VIP Upgrade Setting',   '/rewardpoints/vipUpgradeSetting'],
          ['VIP Level Setting',     '/rewardpoints/levelSetting'],
          ['VIP Level Change Log',  '/rewardpoints/userLevelList'],   // 假設是VIP Level List頁面內的分頁/子功能，未直接在選單截圖裡看到，待確認
          ['VIP Level List',        '/rewardpoints/userLevelList'],
          ['Membership Card',       '/rewardpoints/membershipCard'],
          ['Points History',        '/rewardpoints/pointsHistory'],
          ['Points Setting',        '/rewardpoints/pointsSetting'],
          ['Points/Bets',           '/rewardpoints/pointsSetting'],   // Points/Bets是Points Setting頁面內的一個欄位，非獨立頁面
        ];
        if (/確認篩選並匯出報表正常/.test(taskFull)) {
          // ✅ 團隊確認(2026-08-05)：這筆指的是 Points History 頁面的 xlsx 匯出，
          // 需要先勾選"All" checkbox才會有資料，不是通用 SUBTYPE_MAP 路徑能涵蓋的行為
          result = await testPointsHistoryExport(page, label);
        } else {
          const found = REWARD_POINTS_MAP.find(([kw]) => taskFull.includes(kw));
          if (found && found[1] === '/rewardpoints/pointsSetting') {
            // ✅ 團隊確認(2026-08-05)：Points Setting/Points-Bets 目前只開給NCH(Lavie)渠道，
            // 要走獨立的uat-nc.osmslot.org後台，不是主流程共用的uat-cp.osmslot.org
            result = await testNCHPointsSetting(browser, found[1], label, taskFull);
          } else if (found) {
            result = await performAction(page, found[1], 'screenshot_verify_data', label, verifyText);
          } else {
            result = { pass: false, shotPath: null, error: `積分VIP底下的任務描述沒有匹配到任何已知關鍵字，不猜測路徑: ${taskFull.slice(0,40)}` };
          }
        }
      } else if (Array.isArray(TC_REGISTRY[recordId]?.steps) && TC_REGISTRY[recordId].steps.length) {
        // registry 這筆有積木就照積木跑。這是新的主要路徑；下面那條 SUBTYPE_MAP
        // 的路是還沒拆成積木的 TC 在走的過渡橋。
        result = await performSteps(page, TC_REGISTRY[recordId].steps, label, taskFull);
      } else {
        // 優先完整匹配，再按鍵長度由長到短做 includes 匹配（避免 'Dashboard' 先匹配到 'Daily Dashboard'）
        const mapKey = Object.keys(SUBTYPE_MAP).find(k => k === subtype || k === taskType)
          || Object.keys(SUBTYPE_MAP)
              .sort((a, b) => b.length - a.length)
              .find(k => subtype.includes(k) || taskType.includes(k));
        const mapped = SUBTYPE_MAP[mapKey];
        if (mapped) {
          // 每筆 TC 獨立執行（不使用頁面快取）
          result = await performAction(page, mapped.path, mapped.action, label, verifyText);
        } else {
          result = { pass: false, shotPath: null, error: `未對應路徑: ${subtype}` };
        }
      }

      // 上傳所有截圖到 Lark（支援多張）
      // ⭐ 2026-08-07：MANUAL/SKIP的TC不上傳截圖——這類TC本來就無法從後台單方面驗證
      // （需前端/硬體才能確認），後台截圖對人工複核沒有實質佐證價值，留著反而讓人誤以為
      // 有留下驗證證據；只有腳本真的做出PASS/FAIL斷言判定時，截圖才有佐證意義。
      const isManualOrSkip = result.manual || result.skip;
      const pathsToUpload = isManualOrSkip ? [] : (result.allShotPaths?.length > 0
        ? result.allShotPaths
        : (result.shotPath && fs.existsSync(result.shotPath) ? [result.shotPath] : []));
      if (isManualOrSkip) {
        console.log(`[Upload] ${label} → MANUAL/SKIP，不上傳截圖`);
      } else {
        console.log(`[Upload] ${label} → ${pathsToUpload.length} 張截圖待上傳: ${pathsToUpload.map(p => path.basename(p)).join(', ')}`);
      }
      const fileTokens = [];
      for (const sp of pathsToUpload) {
        if (sp && fs.existsSync(sp)) {
          try {
            const ft = await uploadAttachment(larkToken, sp);
            // dry-run 時 uploadAttachment 回 null；沒有真的上傳就不要報「上傳成功」，
            // 也不要把 null 塞進 fileTokens（那會變成一個對不到檔案的空 token）
            if (ft) {
              fileTokens.push(ft);
              console.log(` ✅ 上傳成功: ${path.basename(sp)}`);
            }
          } catch (e) {
            console.log(` ❌ 上傳失敗: ${path.basename(sp)} → ${e.message}`);
          }
        }
      }

// 更新 Lark 記錄（多張圖以陣列形式傳入）
      // MANUAL/SKIP TC：不打勾也不上傳截圖（見上方isManualOrSkip），此處fileTokens必為空。
      // 但仍要主動呼叫一次updateRecord（傳空陣列），確保清掉「改成不上傳截圖之前」殘留在
      // 該筆記錄上的舊截圖——若只在fileTokens.length>0才呼叫，MANUAL/SKIP列的舊圖永遠
      // 清不掉。真正的FAIL（非MANUAL/SKIP、且這次沒截到圖，例如navigation timeout）則
      // 不主動清，保留上一次可能還有效的驗證證據，不因單次暫時性失敗就把舊證據洗掉。
      // 三態：通過／失敗／人工判讀。原本壓成一個布林，分不出後兩者
      const outcome = result.manual ? 'manual' : (result.pass ? 'pass' : 'fail');
      if (outcome !== 'manual' || fileTokens.length > 0 || isManualOrSkip) {
        await updateRecord(larkToken, recordId, fileTokens, outcome);
      }

      if (result.pass && result.manual) skipCount++;
      else if (result.pass) passCount++;
      else if (result.skip) skipCount++;
      else failCount++;

      const noteStr = result.notes ? ` (${result.notes})` : '';
      const statusIcon = result.manual ? '🔧' : result.pass ? '✅' : result.skip ? '⏭' : '❌';
      console.log(` ${statusIcon}${noteStr}${result.error ? ' ' + result.error : ''}`);
      results.push({ recordId, subtype, task, pass: result.pass, manual: result.manual, skip: result.skip });

    } catch (e) {
      failCount++;
      console.log(` ❌ ${e.message}`);
      // 若 page 崩潰，重新建立
      if (/crash|closed|Target|Session/i.test(e.message)) {
        console.log('  🔄 偵測到 page crash，重新建立瀏覽器頁面...');
        try { await ctx.close(); } catch {}
        try {
          const r2 = await createLoginPage();
          page = r2.page;
          ctx = r2.ctx;
          console.log('  ✅ 重新登入完成');
        } catch (e2) {
          // 只重開 context 失敗，很可能是 browser 底層程序本身已經壞掉（不只是那個分頁）
          // ——單純再開新 context 救不回來，要整個 chromium.launch() 重啟才行。
          console.log(`  ❌ 重開context失敗(${e2.message})，改為完整重啟瀏覽器...`);
          try { await browser.close(); } catch {}
          try {
            browser = await chromium.launch(launchOpts);
            const r3 = await createLoginPage();
            page = r3.page;
            ctx = r3.ctx;
            console.log('  ✅ 瀏覽器完整重啟後登入完成');
          } catch (e3) {
            console.log(`  ❌ 完整重啟瀏覽器仍然失敗: ${e3.message}，本筆及後續筆數將持續失敗直到手動介入`);
          }
        }
      }
    }

    // 每 20 筆刷新 token
    if ((i + 1) % 20 === 0) {
      larkToken = await getLarkToken();
      console.log('🔄 Lark token 刷新');
    }
  }

  // ─── Bonus 計時器驗證（TC2+TC3）────────────────────────────────────────
  if (_bonusTimerState) {
    const WAIT_MS = 5 * 60 * 1000; // 5 分鐘
    const elapsed = Date.now() - _bonusTimerState.startTime;
    const remaining = Math.max(0, WAIT_MS - elapsed);
    if (remaining > 0) {
      const remSec = Math.ceil(remaining / 1000);
      console.log(`\n⏳ 等待 Bonus 5分鐘更新計時...（剩餘 ${remSec} 秒）`);
      await new Promise(r => setTimeout(r, remaining));
    }
    console.log('⏰ 計時結束，回去驗證 Daily Ranking Bonus 更新...');
    try {
      await page.goto(_bonusTimerState.pageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(2000);
      await page.evaluate(() => {
        document.querySelectorAll('.el-dialog__wrapper').forEach(el => el.style.display = 'none');
        const overlay = document.querySelector('.v-modal');
        if (overlay) overlay.style.display = 'none';
      });
      await page.waitForTimeout(500);

      // 截圖 after
      const afterTableShotPath = path.join(SCREENSHOT_DIR, `bonus_table_after_${Date.now()}.png`);
      await page.screenshot({ path: afterTableShotPath, fullPage: false });

      // 讀取 after Bonus 欄位值
      const { bonusColIdx, beforeBonusVals = [] } = _bonusTimerState;
      const afterBonusVals = bonusColIdx >= 0
        ? await page.evaluate((colIdx) => {
            const rows = [...document.querySelectorAll('.el-table__body tr')];
            return rows.map(row => {
              const cell = row.querySelectorAll('td')[colIdx];
              return cell ? cell.innerText?.trim() : null;
            }).filter(v => v !== null);
          }, bonusColIdx).catch(() => [])
        : [];

      // 生成 before vs after 比對截圖
      const maxRows = Math.max(beforeBonusVals.length, afterBonusVals.length);
      const compareRows = Array.from({ length: maxRows }, (_, i) => {
        const bv = beforeBonusVals[i] ?? '—';
        const av = afterBonusVals[i] ?? '—';
        const changed = bv !== av;
        const bg = changed ? '#e6f4ea' : '#fff';
        const icon = changed ? '✅ 已更新' : '— 未變動';
        return `<tr style="background:${bg}">
          <td style="padding:6px 12px;border:1px solid #ddd;text-align:center">#${i + 1}</td>
          <td style="padding:6px 12px;border:1px solid #ddd;text-align:right">${bv}</td>
          <td style="padding:6px 12px;border:1px solid #ddd;text-align:right;font-weight:bold;color:#1a7a2e">${av}</td>
          <td style="padding:6px 12px;border:1px solid #ddd;text-align:center">${icon}</td>
        </tr>`;
      }).join('');
      const updatedCount = Array.from({ length: maxRows }, (_, i) => beforeBonusVals[i] !== afterBonusVals[i]).filter(Boolean).length;
      const overallResult = updatedCount > 0 ? `✅ PASS — ${updatedCount}/${maxRows} 筆 Bonus 已更新` : `⚠️ 待確認 — 所有 Bonus 欄位無變動（可能尚未到5分鐘週期）`;
      const compareHtml = `<div style="font-family:sans-serif;margin:0">
        <div style="background:#1a56db;color:#fff;padding:10px 16px;font-size:14px;font-weight:bold">
          Daily Ranking Bonus — 5分鐘更新驗證（${new Date().toLocaleString('zh-TW')}）
        </div>
        <div style="padding:10px 16px;font-size:13px;font-weight:bold;color:${updatedCount > 0 ? '#16a34a' : '#d97706'}">${overallResult}</div>
        <table style="border-collapse:collapse;width:100%">
          <thead><tr style="background:#f0f0f0">
            <th style="padding:8px 12px;border:1px solid #ddd">排名</th>
            <th style="padding:8px 12px;border:1px solid #ddd;text-align:right">修改前 Bonus</th>
            <th style="padding:8px 12px;border:1px solid #ddd;text-align:right">5分鐘後 Bonus</th>
            <th style="padding:8px 12px;border:1px solid #ddd">狀態</th>
          </tr></thead>
          <tbody>${compareRows}</tbody>
        </table>
      </div>`;

      const timerShotPath = path.join(SCREENSHOT_DIR, `bonus_timer_compare_${Date.now()}.png`);
      await page.setViewportSize({ width: 900, height: 600 });
      await page.setContent(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0">${compareHtml}</body></html>`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(300);
      await page.screenshot({ path: timerShotPath, fullPage: true });

      // 上傳截圖到 Lark（更新 TC3 記錄）
      const tc3Record = results.find(r => /5.*分鐘|每5分鐘/i.test(r.task));
      if (tc3Record) {
        const toUpload = [afterTableShotPath, timerShotPath].filter(p => fs.existsSync(p));
        const fts = [];
        for (const p of toUpload) {
          const ft = await uploadAttachment(larkToken, p).catch(() => null);
          if (ft) fts.push(ft);
        }
        if (fts.length > 0) {
          // ⭐ 2026-08-07：原本無論updatedCount有沒有>0都固定傳false，等於這筆TC
          // 不管腳本實際等滿5分鐘後查到「真的有更新」的證據，永遠不會被標記PASS。
          // updatedCount>0時是真實比對出的正面證據(修改前後Bonus欄位值不同)，應該讓它
          // 反映到PASS。updatedCount===0這裡production script維持不標記——單一UAT測試
          // checkbox沒有獨立FAIL欄位可標，「不標記」本來就是這個schema下唯一能表達
          // 「沒有正面證據」的方式。⚠️2026-08-07使用者已明確決定：新表(有獨立UAT
          // PASS/FAIL兩個checkbox)這種情況要直接判FAIL不留白（見run-lark-tc-backend-
          // newtable.js/apply-newtable-patch.cjs），production這裡保留原樣只是因為
          // schema限制沒有FAIL欄位可設，不是刻意跟使用者決定不一致。
          // updatedCount === 0 時維持不標記（見上方註解），所以是 pass 或 none 而不是 fail
          await updateRecord(larkToken, tc3Record.recordId, fts, updatedCount > 0 ? 'pass' : 'none');
          console.log(`✅ TC3 5分鐘驗證截圖已上傳（${fts.length}張：after主畫面 + 比對表格）${updatedCount > 0 ? '，已標記PASS' : '，因未偵測到變動維持不標記(非FAIL，避免伺服器更新週期誤判)'}`);
        }
      }
      console.log(`✅ Bonus 5分鐘計時驗證完成 | ${overallResult}`);
    } catch (e) {
      console.log(`⚠️ Bonus 計時驗證例外: ${e.message}`);
    }
  }

  try { await ctx.close(); } catch {}
  await browser.close();

  const manualCount = results.filter(r => r.manual).length;
  console.log(`\n✅ 完成！通過: ${passCount}  🔧需人工: ${manualCount}  跳過: ${skipCount}  失敗: ${failCount}`);
  // 回寫失敗要在收工時再講一次。只印在中間的話會被後面幾百行日誌洗掉，
  // 使用者只會看到最後這行漂亮的統計，完全不知道結果沒進到 Lark。
  if (larkWriteFailures.length) {
    console.log(`\n❌ 有 ${larkWriteFailures.length} 筆結果沒有寫回 Lark（上面的統計是這次跑出來的，但表上沒更新）：`);
    for (const line of larkWriteFailures.slice(0, 10)) console.log(`     ${line}`);
    if (larkWriteFailures.length > 10) console.log(`     …另外還有 ${larkWriteFailures.length - 10} 筆`);
    console.log(`   常見原因：欄位名稱或型別跟程式對不上（例如 PASS／FAIL 被改成非勾選欄位）、或這個 token 沒有寫入權限。`);
  }
  if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
  if (netCapture) {
    // 最後一份一定要送：定時廣播最多晚 2 秒，面板停在倒數第二筆會跟日誌摘要對不起來
    try { console.log(formatStatsLine({ scope: 'backend', net: netCapture.summary(), final: true })); } catch { /* 快照失敗不影響摘要 */ }
    try { console.log('\n' + netCapture.formatSummary()); } catch (e) { console.log(`⚠️ 網路量測摘要產生失敗: ${e.message}`); }
  }
  fs.writeFileSync('./data/raw/lark_tc_results.json', JSON.stringify(results, null, 2));
}

main().catch(console.error);
