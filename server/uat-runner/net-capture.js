/**
 * server/uat-runner/net-capture.js
 *
 * UAT 共用的網路量測收集器：掛在一個 Playwright page 上，記錄每支 API 與每張圖
 * 的載入時間，找出超過門檻的那幾筆。
 *
 * 為什麼放在 uat-runner/ 而不是開一個新的 TS 模組：三個啟動 Playwright 的地方
 * 分屬不同的執行方式——
 *   1. server/uat-runner/run-lark-tc-backend.js  純 node 直接跑（Backend 分頁）
 *   2. server/agent-runner.ts                    agent 端用 tsx 跑（H5/PC 派工）
 *   3. server/routes/frontend-auto.ts            編譯進 dist-server（H5/PC 伺服器端）
 * 只有 uat-runner/ 這個目錄會被 scripts/build-server.cjs 整包複製到 dist-server，
 * 所以放這裡是唯一一份原始碼三邊都能載入的位置。同一份邏輯不要抄三次。
 * 型別給 TS 端用的宣告在隔壁 net-capture.d.ts。
 *
 * 量測資料一律取自 Playwright 的 request.timing()，不注入頁面 JS——時間由瀏覽器
 * 本身提供最準，也不會被遊戲自己的程式碼干擾（pinus 那種協定層的東西才需要注入，
 * 見 pinus-probe.js）。
 */

/** 預設門檻（毫秒）。刻意用固定值而不是 p95 之類的相對統計：
 *  UAT 要的是「這次有沒有異常」的紅黃綠判斷，固定門檻好解釋、好調參；
 *  樣本數少的時候相對統計會飄得很厲害，反而不能用來判定。 */
export const DEFAULT_THRESHOLDS = {
  api: 2000,
  image: 1500,
  other: 3000,
};

/**
 * Backend runner 跟 server 之間只有 stdout 一條通道，要把結構化資料帶出來只能
 * 在 log 流裡夾一行有標記的 JSON。這個前綴由 net-capture.js 統一定義，
 * 印的那端（run-lark-tc-backend.js）跟解析的那端（osm-uat.ts）共用同一個常數，
 * 不要兩邊各寫一份字串——改了一邊沒改另一邊，症狀是面板永遠不更新而且沒有錯誤。
 */
export const STATS_LINE_PREFIX = '@@UAT_STATS@@';

/** 把一份快照序列化成可以直接 console.log 的單行 */
export function formatStatsLine(payload) {
  return STATS_LINE_PREFIX + JSON.stringify(payload);
}

/** 從一行 stdout 解析回快照；不是統計行就回 null */
export function parseStatsLine(line) {
  if (typeof line !== 'string' || !line.startsWith(STATS_LINE_PREFIX)) return null;
  try { return JSON.parse(line.slice(STATS_LINE_PREFIX.length)); } catch { return null; }
}

/** 明細最多留幾筆，避免一個遊戲頁載入上千張圖把記憶體吃爆 */
const MAX_RECORDS = 4000;
/** summary 裡「最慢的前幾筆」列幾筆 */
const SLOWEST_N = 10;

/** Playwright resourceType → 我們的分類 */
function classify(resourceType) {
  if (resourceType === 'xhr' || resourceType === 'fetch') return 'api';
  if (resourceType === 'image') return 'image';
  return 'other';
}

/**
 * timing 的單位是相對於 startTime 的毫秒；-1 代表「這個階段沒有發生」。
 * responseEnd 才是整筆結束，用它減 startTime 之外的欄位算不出總時間。
 */
function durationOf(timing) {
  if (!timing || typeof timing.responseEnd !== 'number' || timing.responseEnd < 0) return null;
  return Math.round(timing.responseEnd * 100) / 100;
}

/**
 * 是不是「很可能吃到快取」。
 *
 * ⚠️ 這是推測不是事實：Playwright 沒有直接暴露 fromDiskCache（那是 CDP 的
 * Network.responseReceived 才有的欄位）。這裡用「完全沒有建線階段 + 總時間極短」
 * 當訊號，所以欄位名稱刻意叫 likelyCached 而不是 cached——快取命中的圖看起來
 * 一定很快，但那不代表首次載入也快，統計時要能把它排除掉才不會誤導。
 */
function likelyCached(timing, duration) {
  if (!timing) return false;
  const noConnect = timing.connectStart === -1 && timing.domainLookupStart === -1;
  return noConnect && duration !== null && duration < 5;
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return null;
  const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1));
  return sortedValues[idx];
}

function statsOf(records) {
  const durations = records.map(r => r.durationMs).filter(v => typeof v === 'number').sort((a, b) => a - b);
  if (!durations.length) return { count: records.length, avgMs: null, maxMs: null, p95Ms: null };
  const sum = durations.reduce((a, b) => a + b, 0);
  return {
    count: records.length,
    avgMs: Math.round(sum / durations.length),
    maxMs: Math.round(durations[durations.length - 1]),
    p95Ms: Math.round(percentile(durations, 95)),
  };
}

/**
 * 把量測掛到一個 page 上。
 *
 * @param {import('playwright').Page} page
 * @param {{ thresholds?: Partial<typeof DEFAULT_THRESHOLDS>, onSlow?: (record: object) => void }} [options]
 *        onSlow 只有超過門檻的那幾筆會呼叫——逐筆回報會直接洗版執行日誌
 *        （一個遊戲頁動輒幾百張圖），比照 AutoSpin track_button_health() 的做法，
 *        平常只累積、結束時出 summary，只有異常才即時吐出來。
 */
export function attachNetworkCapture(page, options = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) };
  const onSlow = typeof options.onSlow === 'function' ? options.onSlow : null;

  /** @type {object[]} 正常完成的請求 */
  const records = [];
  /** @type {object[]} 失敗的請求（連不上、被中止），跟慢是兩件事要分開看 */
  const failures = [];
  let dropped = 0;

  const push = (list, item) => {
    if (records.length + failures.length >= MAX_RECORDS) { dropped++; return; }
    list.push(item);
  };

  const onFinished = async (request) => {
    try {
      const timing = request.timing();
      const duration = durationOf(timing);
      const response = await request.response().catch(() => null);
      const kind = classify(request.resourceType());
      const cached = likelyCached(timing, duration);
      const record = {
        url: request.url(),
        method: request.method(),
        kind,
        resourceType: request.resourceType(),
        status: response ? response.status() : null,
        durationMs: duration,
        likelyCached: cached,
        // redirect 的每一跳都是獨立 request，preflight 是瀏覽器自己發的 OPTIONS。
        // 兩者都算進統計會讓「API 平均耗時」失真，所以標起來、統計時排除。
        isRedirect: request.redirectedFrom() !== null,
        isPreflight: request.method() === 'OPTIONS',
        ts: Date.now(),
      };
      push(records, record);

      // 快取命中、redirect 跳轉、preflight 都不參與超標判定：
      // 快取本來就快（判不出問題），另外兩個不是使用者等待的實際內容
      if (duration !== null && !cached && !record.isRedirect && !record.isPreflight) {
        const limit = thresholds[kind] ?? thresholds.other;
        if (duration > limit) {
          record.overThresholdMs = Math.round(duration - limit);
          record.thresholdMs = limit;
          if (onSlow) { try { onSlow(record); } catch { /* 回報失敗不能拖垮量測 */ } }
        }
      }
    } catch { /* 單筆抓不到就跳過，不影響整體 */ }
  };

  const onFailed = (request) => {
    try {
      push(failures, {
        url: request.url(),
        method: request.method(),
        kind: classify(request.resourceType()),
        resourceType: request.resourceType(),
        failure: request.failure()?.errorText ?? 'unknown',
        ts: Date.now(),
      });
    } catch { /* 同上 */ }
  };

  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFailed);

  return {
    /** 拆掉監聽；page 已經關掉時呼叫也不會炸 */
    detach() {
      try { page.off('requestfinished', onFinished); } catch { /* page 已關 */ }
      try { page.off('requestfailed', onFailed); } catch { /* page 已關 */ }
    },

    /** 目前累積的原始明細（給需要自己算的呼叫端用） */
    records() { return records.slice(); },

    /**
     * 收工報告。刻意不回傳全部明細——只回統計數字、超標清單、最慢前 N 筆，
     * 這是「這次有沒有異常」要看的東西，不是效能分析平台。
     */
    summary() {
      // 統計只算「使用者實際等到的內容」：排除快取命中、redirect 跳轉、preflight
      const real = records.filter(r => !r.likelyCached && !r.isRedirect && !r.isPreflight);
      const api = real.filter(r => r.kind === 'api');
      const image = real.filter(r => r.kind === 'image');
      const other = real.filter(r => r.kind === 'other');
      const slow = real.filter(r => typeof r.overThresholdMs === 'number')
        .sort((a, b) => b.durationMs - a.durationMs);
      const slowest = real.filter(r => typeof r.durationMs === 'number')
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, SLOWEST_N);

      return {
        thresholds,
        totals: {
          captured: records.length,
          counted: real.length,
          likelyCached: records.filter(r => r.likelyCached).length,
          redirects: records.filter(r => r.isRedirect).length,
          preflights: records.filter(r => r.isPreflight).length,
          failed: failures.length,
          dropped,
        },
        api: statsOf(api),
        image: statsOf(image),
        other: statsOf(other),
        slow,
        slowest,
        failures: failures.slice(0, SLOWEST_N),
      };
    },

    /** 把 summary 轉成可以直接印進執行日誌的多行文字 */
    formatSummary() {
      const s = this.summary();
      // 中文標籤是全形字，String.padEnd 以「字數」計算會讓中英標籤對不齊，
      // 要按顯示寬度補（CJK 算 2 欄）
      const padDisplay = (text, width) => {
        let w = 0;
        for (const ch of text) w += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
        return text + ' '.repeat(Math.max(0, width - w));
      };
      const line = (label, st, limit) => `  ${padDisplay(label, 6)} ${String(st.count).padStart(4)} 筆` +
        (st.avgMs === null ? '' : ` · 平均 ${st.avgMs}ms · p95 ${st.p95Ms}ms · 最慢 ${st.maxMs}ms（門檻 ${limit}ms）`);
      const out = [
        '── 網路載入量測 ──',
        line('API', s.api, s.thresholds.api),
        line('圖檔', s.image, s.thresholds.image),
        line('其他', s.other, s.thresholds.other),
        `  共擷取 ${s.totals.captured} 筆；納入統計 ${s.totals.counted} 筆` +
          `（排除疑似快取 ${s.totals.likelyCached}、轉址 ${s.totals.redirects}、預檢 ${s.totals.preflights}）` +
          (s.totals.failed ? `；失敗 ${s.totals.failed} 筆` : '') +
          (s.totals.dropped ? `；因超過上限未記錄 ${s.totals.dropped} 筆` : ''),
      ];
      if (s.slow.length) {
        out.push(`  ⚠️ 超過門檻 ${s.slow.length} 筆：`);
        for (const r of s.slow.slice(0, SLOWEST_N)) {
          out.push(`     ${String(Math.round(r.durationMs)).padStart(6)}ms (+${r.overThresholdMs}) ${r.kind} ${r.url.slice(0, 110)}`);
        }
        if (s.slow.length > SLOWEST_N) out.push(`     …另外還有 ${s.slow.length - SLOWEST_N} 筆`);
      } else {
        out.push('  ✅ 沒有超過門檻的請求');
      }
      if (s.failures.length) {
        out.push(`  ❌ 載入失敗 ${s.totals.failed} 筆：`);
        for (const f of s.failures) out.push(`     ${f.failure} ${f.url.slice(0, 110)}`);
      }
      return out.join('\n');
    },
  };
}
