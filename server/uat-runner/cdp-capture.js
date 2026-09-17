/**
 * server/uat-runner/cdp-capture.js
 *
 * 錄製時的 console／network／pinus 攔截——走**原始 CDP**，不需要 Playwright。
 *
 * ## 為什麼不能直接用 net-capture.js 的 attachNetworkCapture
 * 那支吃的是 Playwright 的 `page`（用 `page.on('requestfinished')`）。但 H5/PC 的
 * **錄製**沒有 Playwright page 物件——它是自己開一顆 Chrome、用 WebSocket 連上
 * CDP endpoint 收事件的（`agent-runner.ts` 的 connectUatRecorder、
 * `frontend-auto.ts` 的 connectRecorder，兩支都是）。
 *
 * ## 規則只有一份
 * 分類、門檻、統計、上限全部來自 `net-capture.js` 的 `createNetCollector()`；
 * pinus 的 route 統計來自 `pinus-probe.js` 的 `pinusSummaryOf()`。
 * 這支只負責**把 CDP 事件正規化成那些規則吃的形狀**。
 *
 * 各寫一份的下場是「同一個請求，執行時算慢、錄製時算不慢」——兩邊都不會報錯，
 * 只會讓人對著兩個對不起來的數字懷疑人生。
 *
 * ## 為什麼兩個 host 要共用這支
 * H5/PC 錄製有兩條路：agent 模式與本機模式，兩支的 CDP 迴圈幾乎一模一樣。
 * 只改一邊的話另一種模式會安靜地什麼都收不到——跟 Backend 錄製的停止按鈕
 * 是同一類坑（見 24-27-uat.md）。
 */
import { createNetCollector, classifyResourceType, toUrlPattern } from './net-capture.js';
import { pinusProbeSource, pinusSummaryOf, PINUS_DRAIN_EXPRESSION } from './pinus-probe.js';

/**
 * 上限。**這些不是可有可無的調校，是必要的防護**：一個遊戲畫面動輒上百個請求、
 * console 也可能被遊戲自己洗版，而錄製 session 的內容每 2 秒會被
 * `/record/status` 整包回傳給前端。不設上限的話，錄十分鐘就會同時吃掉
 * agent 的記憶體跟前端的頻寬。
 */
const CONSOLE_MAX = 500;
const PINUS_MAX = 2000;
/** 單行 console 最多留多長。遊戲會 print 整包 JSON，不截的話一行就幾百 KB */
const TEXT_MAX = 800;

/** CDP 的 timestamp 是「秒」而且是單調時鐘，不是 epoch。相減才有意義。 */
const secToMs = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.round((b - a) * 1000) : null);

function argToText(arg) {
  if (!arg) return '';
  if (typeof arg.value === 'string') return arg.value;
  if (arg.value !== undefined) { try { return JSON.stringify(arg.value); } catch { return String(arg.value); } }
  if (typeof arg.description === 'string') return arg.description;
  if (arg.preview?.description) return String(arg.preview.description);
  return arg.type ? `[${arg.type}]` : '';
}

/**
 * @param {(method: string, params?: object) => Promise<any>} send CDP 送訊息的函式，
 *        回傳 `{ result: ... }`（兩個 host 的 send 形狀一致）
 * @param {{
 *   thresholds?: object,
 *   consoleMarkers?: string[],   錄製器自己的標記，這些不要當成使用者的 console
 *   redact?: (text: string) => string,
 * }} [options]
 */
export async function attachCdpCapture(send, options = {}) {
  const collector = createNetCollector({ thresholds: options.thresholds });
  const markers = options.consoleMarkers ?? [];
  const redact = typeof options.redact === 'function' ? options.redact : (t) => t;

  const consoleLogs = [];
  const pinusMessages = [];
  let consoleDropped = 0;
  let pinusPageDropped = 0;
  let pinusPatched = null;

  /** requestId → 這筆請求已知的資訊，等 loadingFinished 才成一筆 record */
  const inflight = new Map();

  const pushConsole = (entry) => {
    if (consoleLogs.length >= CONSOLE_MAX) { consoleDropped++; return; }
    entry.text = redact(String(entry.text ?? '')).slice(0, TEXT_MAX);
    consoleLogs.push(entry);
  };

  const finishRecord = (requestId, endTs) => {
    const info = inflight.get(requestId);
    if (!info) return;
    inflight.delete(requestId);
    collector.add({
      url: info.url,
      method: info.method,
      kind: classifyResourceType(info.resourceType),
      resourceType: info.resourceType,
      // 錄製的用途是「之後把這筆 API 變成斷言」，所以一定要留 pattern：
      // 原始網址裡的 id／token／時間戳直接當條件的話，換一筆資料就全紅。
      urlPattern: toUrlPattern(info.url),
      status: info.status ?? null,
      durationMs: secToMs(info.startTs, endTs),
      // CDP 的 fromDiskCache 是**事實**，不像 Playwright 那邊只能用時間推測。
      // 欄位名沿用 likelyCached 是為了讓統計那層兩邊共用同一份規則。
      likelyCached: !!info.fromCache,
      isRedirect: !!info.isRedirect,
      isPreflight: info.method === 'OPTIONS',
    });
  };

  await send('Network.enable', {});
  await send('Log.enable', {});
  // pinus 是包在 JS 物件底下的 WebSocket 協定，HTTP 層看不到，只能注入頁面。
  // addScriptToEvaluateOnNewDocument 讓跳轉後的新 document 也有；
  // 再 evaluate 一次是補打給「已經載入好的」這一頁（前者只對之後的 document 生效）。
  const probe = pinusProbeSource();
  await send('Page.addScriptToEvaluateOnNewDocument', { source: probe });
  await send('Runtime.evaluate', { expression: probe }).catch(() => { /* about:blank 還沒有 document */ });

  return {
    /** 換頁之後補打探針——原本的 document 沒了，頁面端的 buffer 也跟著不見 */
    async reinject() {
      await send('Runtime.evaluate', { expression: probe }).catch(() => {});
    },

    /**
     * 把一則 CDP 訊息餵進來。回傳 true 代表「這則被我收掉了」。
     *
     * ⚠️ host 端自己的標記訊息（錄到的積木、框選截圖）**不在這裡處理**——
     *    那是 host 的事，這裡只認得它們是「不要當成使用者 console」。
     */
    handle(msg) {
      const method = msg?.method;
      if (!method) return false;
      const p = msg.params ?? {};

      switch (method) {
        case 'Network.requestWillBeSent': {
          // 有 redirectResponse 代表「上一跳是轉址、而且已經結束了」，
          // 同一個 requestId 會被重複使用。先把那一跳結掉再開新的。
          if (p.redirectResponse) {
            const prev = inflight.get(p.requestId);
            if (prev) {
              prev.status = p.redirectResponse.status ?? null;
              prev.isRedirect = true;
              finishRecord(p.requestId, p.timestamp);
            }
          }
          inflight.set(p.requestId, {
            url: p.request?.url ?? '',
            method: p.request?.method ?? 'GET',
            resourceType: p.type ?? 'Other',
            startTs: p.timestamp,
            status: null,
            fromCache: false,
            isRedirect: false,
          });
          return true;
        }
        case 'Network.responseReceived': {
          const info = inflight.get(p.requestId);
          if (info) {
            info.status = p.response?.status ?? null;
            info.fromCache = !!(p.response?.fromDiskCache || p.response?.fromPrefetchCache);
            // type 在 responseReceived 上比 requestWillBeSent 準（有些請求一開始是 Other）
            if (p.type) info.resourceType = p.type;
          }
          return true;
        }
        case 'Network.loadingFinished': {
          finishRecord(p.requestId, p.timestamp);
          return true;
        }
        case 'Network.loadingFailed': {
          const info = inflight.get(p.requestId);
          inflight.delete(p.requestId);
          // 使用者自己停掉錄製時會有一堆 canceled，那不是問題，不要當失敗報
          if (p.canceled) return true;
          collector.addFailure({
            url: info?.url ?? '',
            method: info?.method ?? 'GET',
            kind: classifyResourceType(info?.resourceType ?? p.type),
            resourceType: info?.resourceType ?? p.type ?? 'Other',
            failure: p.errorText || 'unknown',
          });
          return true;
        }
        case 'Runtime.consoleAPICalled': {
          const args = p.args ?? [];
          // 錄製器自己印的標記不是使用者的 console，交給 host 處理
          if (markers.includes(args[0]?.value)) return false;
          pushConsole({
            type: p.type ?? 'log',
            text: args.map(argToText).join(' '),
            ts: Date.now(),
          });
          return true;
        }
        case 'Runtime.exceptionThrown': {
          const d = p.exceptionDetails ?? {};
          pushConsole({
            type: 'pageerror',
            text: d.exception?.description || d.text || 'Uncaught error',
            location: d.url ? `${d.url}:${(d.lineNumber ?? 0) + 1}` : '',
            ts: Date.now(),
          });
          return true;
        }
        case 'Log.entryAdded': {
          const e = p.entry ?? {};
          // 瀏覽器層級的訊息（CORS、mixed content、404 之類）。
          // info 以下的太吵，只留 warning 以上。
          if (e.level !== 'warning' && e.level !== 'error') return true;
          pushConsole({
            type: e.level === 'error' ? 'error' : 'warning',
            text: e.text ?? '',
            location: e.url ? `${e.url}:${e.lineNumber ?? 0}` : '',
            ts: Date.now(),
          });
          return true;
        }
        default:
          return false;
      }
    },

    /** 把頁面端累積的 pinus 訊息搬回來並清空頁面 buffer。要定期呼叫。 */
    async drainPinus() {
      const resp = await send('Runtime.evaluate', {
        expression: PINUS_DRAIN_EXPRESSION,
        returnByValue: true,
      }).catch(() => null);
      const value = resp?.result?.result?.value;
      if (!value) return { items: [], dropped: 0, patched: pinusPatched };
      if (typeof value.dropped === 'number' && value.dropped > pinusPageDropped) pinusPageDropped = value.dropped;
      if (value.patched != null) pinusPatched = value.patched;
      for (const item of value.items ?? []) {
        if (pinusMessages.length >= PINUS_MAX) break;
        pinusMessages.push(item);
      }
      return value;
    },

    /**
     * 這頁到底有沒有攔到 pinus——回一句人看得懂的話，或 null 代表「沒有」。
     *
     * ⚠️ 頁面端的 `patched` 是 **`{ request, on }` 物件**，每個欄位是補在哪
     *    （`'prototype'`／`'instance'`）或 `false`。直接往外丟的話呼叫端會拿到
     *    一個物件——畫面上就是 `[object Object]`，而且**沒有 pinus 的頁面也是物件**
     *    （`{request:false,on:false}` 是 truthy），於是「這頁沒有 pinus」跟
     *    「攔到了」變得分不出來。瀏覽器測試就是這樣抓到的。
     */
    pinusPatched() {
      if (!pinusPatched || typeof pinusPatched !== 'object') return null;
      const parts = [];
      if (pinusPatched.on) parts.push(`on=${pinusPatched.on}`);
      if (pinusPatched.request) parts.push(`request=${pinusPatched.request}`);
      return parts.length ? parts.join(', ') : null;
    },

    consoleLogs() { return consoleLogs.slice(); },
    consoleDropped() { return consoleDropped; },

    /** 給 NetworkPanel 直接吃的形狀（跟執行時的 stats event 同一個型別） */
    snapshot() {
      return {
        scope: 'record',
        net: collector.summary(),
        pinus: pinusSummaryOf(pinusMessages, pinusPageDropped),
      };
    },
  };
}
