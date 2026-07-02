/**
 * server/luckylink-poller.mjs
 * LuckyLink JP 獎池輪詢器 v2（API 直連版，不再使用 Playwright）
 *
 * 核心 API（由 Codex 分析確認）：
 *   POST /auth/login                    — 取得 token
 *   POST /auth/permissionInfo           — 確認 token 有效
 *   POST /progressives/levelsListData   — 即時 pool 值（主要輪詢）
 *   POST /reports/awardsReport          — JP 中獎紀錄
 *
 * 環境變數（由 agent-runner 注入）：
 *   LL_URL             LuckyLink 後台 URL
 *   LL_GROUP_NAME      Group Name，用於過濾 levelsListData
 *   LL_LOGIN_USER      登入帳號（預設 admin）
 *   LL_LOGIN_PASS      登入密碼（預設 123456）
 *   LL_POLL_SEC        輪詢間隔秒數（預設 60）
 *   LL_JP_GROUP_CODE   JP Group 代碼（供 log 識別用）
 *   LL_GAME_CODES      逗號分隔的 Game Code 清單
 */

const LL_URL        = process.env.LL_URL || '';
const LL_GROUP_NAME = process.env.LL_GROUP_NAME || '';
const LL_LOGIN_USER = process.env.LL_LOGIN_USER || 'admin';
const LL_LOGIN_PASS = process.env.LL_LOGIN_PASS || '123456';
const LL_POLL_SEC   = Math.max(10, Math.min(3600, parseInt(process.env.LL_POLL_SEC || '60', 10)));
const JP_GROUP_CODE = process.env.LL_JP_GROUP_CODE || 'unknown';
const GAME_CODES    = (process.env.LL_GAME_CODES || '').split(',').map(s => s.trim()).filter(Boolean);

if (!LL_URL) { console.error('[LL-POLLER] LL_URL 未設定，退出'); process.exit(1); }

const log = (tag, msg) => {
  const t = new Date(Date.now() + 8 * 3600000).toISOString().slice(11, 19);
  const line = `[${t}][LL-POLL][${JP_GROUP_CODE}][${tag}] ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`;
  console.log(line);
};

const emit = (type, data) => {
  console.log(JSON.stringify({ type, data, ts: new Date().toISOString() }));
};

const wait = (ms) => new Promise(r => setTimeout(r, ms));

let authToken = null;
let loginCookie = '';

async function llPost(path, body, opts = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(authToken ? { 'Authorization': `Bearer ${authToken}`, 'token': authToken } : {}),
    ...(loginCookie ? { 'Cookie': loginCookie } : {}),
    ...opts.headers,
  };
  const url = opts.tokenQuery && authToken
    ? `${LL_URL}${path}?token=${authToken}&clientversion=1.0.4.10`
    : `${LL_URL}${path}`;
  const r = await fetch(url, { method: 'POST', headers, body: body ? JSON.stringify(body) : undefined });
  if (r.headers.get('set-cookie')) loginCookie = r.headers.get('set-cookie').split(';')[0];
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status: r.status, json };
}

async function llLogin() {
  log('LOGIN', `POST ${LL_URL}/auth/login (user=${LL_LOGIN_USER})`);
  const { status, json } = await llPost('/auth/login', {
    loginName: LL_LOGIN_USER,
    loginPassword: LL_LOGIN_PASS,
    username: LL_LOGIN_USER,
    password: LL_LOGIN_PASS,
  });
  log('LOGIN', `status=${status} response=${JSON.stringify(json).slice(0, 200)}`);

  const token = json.token || json.data?.token || json.result?.token
    || json.accessToken || json.data?.accessToken || json.tokenValue;
  if (!token) {
    throw new Error(`Login failed (${status}): no token in ${JSON.stringify(json).slice(0, 300)}`);
  }
  authToken = token;
  log('LOGIN', `Token: ${token.slice(0, 12)}...`);

  // Confirm token via permissionInfo
  const perm = await llPost('/auth/permissionInfo', null, { tokenQuery: true });
  log('PERM', `status=${perm.status}`);
  return token;
}

async function getLevelsListData() {
  const { status, json } = await llPost('/progressives/levelsListData', {
    page: 1,
    pageSize: 200,
    groupName: LL_GROUP_NAME || '',
    levelName: '',
  });

  if (status === 401) {
    log('SESSION', '401 — Token 過期，重新登入...');
    await llLogin();
    return getLevelsListData();
  }

  // Parse response — try common formats (confirmed: data.items from prod)
  const raw = json.data?.items ?? json.data?.list ?? json.data ?? json.list ?? json.rows ?? json.result ?? json;
  const levels = Array.isArray(raw) ? raw : [];

  if (levels.length === 0 && pollCount === 0) {
    log('DEBUG', `levelsListData raw response: ${JSON.stringify(json).slice(0, 400)}`);
  }

  return levels.map(l => {
    const rawValue   = l.poolamount ?? l.poolAmount ?? l.amount ?? l.pool ?? 0;
    const basevalue  = l.basevalue ?? l.baseValue ?? l.base_value ?? 0;
    const maxValue   = l.maxValue ?? l.maxvalue ?? l.max_value ?? 0;
    const overageValue = l.OverageCurrentValue ?? l.overageCurrentValue ?? l.overage_current_value ?? 0;
    // displayValue in PHP: micro-PHP ÷ 1,000,000 + basevalue (reset seed)
    const displayValue = rawValue / 1_000_000 + basevalue;
    return {
      name: l.levelName ?? l.levelname ?? l.name ?? String(l.levelid ?? l.id ?? ''),
      rawValue,
      displayValue,
      basevalue,
      maxValue,
      overageValue,
      levelid: l.levelid ?? l.id,
      groupName: l.groupName ?? l.group_name ?? '',
    };
  });
}

let prevPool = null;
let pollCount = 0;

(async () => {
  log('START', `LuckyLink API Poller v2 啟動 | url=${LL_URL} | group=${LL_GROUP_NAME} | interval=${LL_POLL_SEC}s`);
  emit('luckylink_start', { jpGroupCode: JP_GROUP_CODE, luckylinkUrl: LL_URL, pollIntervalSec: LL_POLL_SEC, gameCodes: GAME_CODES });

  try {
    await llLogin();

    // Initial snapshot
    const initPool = await getLevelsListData();
    prevPool = initPool;
    log('INIT', `初始 JP 池: ${initPool.map(l => `${l.name}=₱${l.displayValue.toFixed(2)}`).join(' | ') || '(無資料)'}`);
    emit('luckylink_pool', { poll: 0, pool: initPool, diffs: [], gameCodes: GAME_CODES });

    while (true) {
      await wait(LL_POLL_SEC * 1000);
      pollCount++;
      try {
        const currPool = await getLevelsListData();
        const diffs = currPool.map(cur => {
          const prev = prevPool?.find(p => p.name === cur.name);
          const rawDelta = prev ? cur.rawValue - prev.rawValue : null;
          const delta = rawDelta !== null ? rawDelta / 1_000_000 : null; // PHP display delta
          let state = 'unknown';
          if (rawDelta === null) state = 'new';
          else if (rawDelta === 0) state = 'frozen';
          else if (rawDelta < 0) state = cur.rawValue < 1_000_000_000 ? 'reset' : 'drop'; // < ₱1000 accumulated = JP reset
          else state = 'increase';
          const matchedGameCodes = GAME_CODES.filter(gc => cur.name.toUpperCase().includes(gc.toUpperCase()));
          return { name: cur.name, prev: prev?.displayValue ?? null, curr: cur.displayValue, delta, state, matchedGameCodes };
        });

        if (pollCount === 1 && GAME_CODES.length > 0 && !diffs.some(d => d.matchedGameCodes.length > 0)) {
          log('WARN', `⚠️ gameCodes [${GAME_CODES.join(',')}] 未對應到任何 JP pool entry`);
          emit('luckylink_alert', { level: 'warn', name: 'all', state: 'no_match', gameCodes: GAME_CODES, message: `No JP pool entry matched game codes: ${GAME_CODES.join(', ')}` });
        }

        log('POLL', `#${pollCount} ${diffs.map(d => `${d.name}:${d.state}(Δ₱${d.delta?.toFixed ? d.delta.toFixed(2) : d.delta})`).join(' | ')}`);
        emit('luckylink_pool', { poll: pollCount, pool: currPool, diffs, gameCodes: GAME_CODES });

        for (const d of diffs) {
          if (d.state === 'drop') {
            log('ALERT', `❌ 異常下跌 ${d.name}: ${d.prev} → ${d.curr}`);
            emit('luckylink_alert', { level: 'error', name: d.name, state: d.state, prev: d.prev, curr: d.curr, delta: d.delta });
          } else if (d.state === 'reset') {
            log('JP-RESET', `✅ JP 觸發重置 ${d.name}: ${d.prev} → ${d.curr}`);
            emit('luckylink_alert', { level: 'info', name: d.name, state: d.state, prev: d.prev, curr: d.curr, delta: d.delta });
          }
        }
        if (diffs.length > 0 && diffs.every(d => d.state === 'frozen')) {
          log('ALERT', `⚠️ 所有獎池凍結（${diffs.length} levels 無變動）`);
          emit('luckylink_alert', { level: 'warn', name: 'all', state: 'frozen', count: diffs.length });
        }

        prevPool = currPool;
      } catch (pollErr) {
        const msg = pollErr instanceof Error ? pollErr.message : String(pollErr);
        log('POLL-ERR', msg);
        emit('luckylink_error', { poll: pollCount, message: msg });
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('FATAL', msg);
    emit('luckylink_error', { poll: pollCount, message: msg, fatal: true });
  } finally {
    log('END', 'LuckyLink API Poller v2 退出');
    emit('luckylink_stop', { jpGroupCode: JP_GROUP_CODE, polls: pollCount });
  }
})();
