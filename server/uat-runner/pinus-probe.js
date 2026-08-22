/**
 * server/uat-runner/pinus-probe.js
 *
 * UAT 的 pinus 協定攔截器（只有 H5 / PC 分頁用得到——Backend 測的是 CP/NC
 * 後台管理站，那是一般網站沒有 pinus）。
 *
 * 網路量測（net-capture.js）走 Playwright 的 requestfinished 事件就夠了，但
 * pinus 是包在一個 JS 物件底下的 WebSocket 協定，HTTP 層看不到，只能注入頁面。
 *
 * ## 補丁要打在 prototype 上，不是 instance 上
 *
 * 這點是 AutoSpin 那邊踩了 v3.90.1 → v3.90.12 一整串版本才確定的（見 CLAUDE.md
 * 的 AutoSpin 章節）：center update 熱更新或斷線重連時，遊戲會建立一個全新的
 * window.pinus 物件（Object.create(EventEmitter.prototype)），補在舊 instance 上
 * 的東西對新物件完全無效。早期版本一路嘗試用輪詢/WS事件去追那個時機點，本質上
 * 是在跟遊戲的同步初始化程式碼賽跑——如果遊戲是「建立新物件 → 同一個 tick 內就
 * 同步呼叫 .on(...)」，任何非同步的追法天生就贏不了。
 *
 * patchMethod() 沿 prototype chain 找到「實際定義這個方法的物件」直接補在那裡：
 * .on() 幾乎必然定義在 EventEmitter.prototype 上，補一次就永久生效，之後所有共用
 * 同一個 prototype 的新 instance（包含還沒發生的下一次重連）自動繼承補丁版本。
 * .request() 若是 instance-level（跟 reqId 計數器綁在一起），會 fallback 補在
 * instance 上並靠輪詢重補——風險較低，因為 request 是「發送後等回應」，沒有
 * .on() 那種「先註冊、之後可能永遠不會再呼叫第二次」的一次性視窗問題。
 */

/** 頁面端最多堆積幾筆，避免長時間測試把記憶體吃爆（drain 會清空） */
const PAGE_BUFFER_MAX = 2000;

/**
 * 要注入頁面的腳本原始碼。
 * 用 page.addInitScript() 掛，這樣每個 document（含跳轉、iframe）都會在頁面自己的
 * 程式碼之前執行，不會漏掉遊戲載入初期的訊息。
 */
export function pinusProbeSource(bufferMax = PAGE_BUFFER_MAX) {
  return `(() => {
  if (window.__uatPinusProbe) return;
  const BUF_MAX = ${Number(bufferMax) || PAGE_BUFFER_MAX};
  const buf = [];
  let droppedCount = 0;

  const probe = { buf, dropped: () => droppedCount, patched: { request: false, on: false } };
  window.__uatPinusProbe = probe;

  function safeShape(value, depth) {
    // 只留結構與純量，不整包塞進來：遊戲的訊息裡可能有很大的陣列（例如整份牌面/
    // 獎項表），逐筆完整保存會讓頁面記憶體爆掉，也讓日誌完全不能讀。
    if (value === null || value === undefined) return value;
    const t = typeof value;
    if (t === 'number' || t === 'boolean') return value;
    if (t === 'string') return value.length > 200 ? value.slice(0, 200) + '…' : value;
    if (t !== 'object') return String(t);
    if (depth <= 0) return Array.isArray(value) ? '[Array(' + value.length + ')]' : '{…}';
    if (Array.isArray(value)) {
      const head = value.slice(0, 10).map(v => safeShape(v, depth - 1));
      return value.length > 10 ? head.concat(['…共 ' + value.length + ' 筆']) : head;
    }
    const out = {};
    let n = 0;
    for (const k of Object.keys(value)) {
      if (n++ >= 30) { out['…'] = '其餘 ' + (Object.keys(value).length - 30) + ' 個欄位省略'; break; }
      try { out[k] = safeShape(value[k], depth - 1); } catch { out[k] = '[unreadable]'; }
    }
    return out;
  }

  function push(direction, route, payload) {
    if (buf.length >= BUF_MAX) { droppedCount++; return; }
    let shaped;
    try { shaped = safeShape(payload, 3); } catch { shaped = '[unserializable]'; }
    buf.push({ direction, route: String(route || ''), payload: shaped, ts: Date.now() });
  }

  // 沿 prototype chain 找到真正定義這個方法的物件，補在那裡（見檔頭註解）
  function patchMethod(obj, methodName, wrapFactory) {
    let owner = obj;
    while (owner && !Object.prototype.hasOwnProperty.call(owner, methodName)) {
      owner = Object.getPrototypeOf(owner);
    }
    if (!owner || typeof owner[methodName] !== 'function') return false;
    const flag = '__uatPinusPatched_' + methodName;
    if (owner[flag]) return true;
    owner[flag] = true;
    owner[methodName] = wrapFactory(owner[methodName]);
    return true;
  }

  function tryPatch() {
    const p = window.pinus;
    if (!p) return;
    if (!probe.patched.request) {
      probe.patched.request = patchMethod(p, 'request', (orig) => function (route, msg, cb) {
        const startedAt = Date.now();
        push('request', route, msg);
        return orig.call(this, route, msg, function (resp) {
          // 每支 pinus request 的往返時間——這是 HTTP 層量不到的，
          // net-capture 只看得到那條 WebSocket 本身，看不到裡面每一筆
          push('response', route, resp);
          const last = buf[buf.length - 1];
          if (last && last.direction === 'response') last.elapsedMs = Date.now() - startedAt;
          if (typeof cb === 'function') return cb.apply(this, arguments);
        });
      });
    }
    if (!probe.patched.on) {
      probe.patched.on = patchMethod(p, 'on', (orig) => function (event, handler) {
        if (typeof handler !== 'function') return orig.apply(this, arguments);
        return orig.call(this, event, function () {
          try { push('push', event, arguments.length > 1 ? Array.from(arguments) : arguments[0]); } catch {}
          return handler.apply(this, arguments);
        });
      });
    }
  }

  tryPatch();
  // prototype 補丁成功後就永久生效，這個輪詢主要是等 window.pinus 第一次出現，
  // 以及涵蓋 .request() 是 instance-level 而需要每次重連重補的情況
  setInterval(tryPatch, 300);
})();`;
}

/**
 * 把 probe 掛到 page 上。要在 goto 之前呼叫。
 * @param {import('playwright').Page} page
 */
export async function attachPinusProbe(page, options = {}) {
  const bufferMax = options.bufferMax ?? PAGE_BUFFER_MAX;
  const source = pinusProbeSource(bufferMax);
  await page.addInitScript(source);
  // 已經載入的頁面補打一次（addInitScript 只對「之後」的 document 生效）
  await page.evaluate(source).catch(() => { /* about:blank 或還沒有 document */ });

  /** @type {object[]} */
  const collected = [];
  let pageDropped = 0;

  return {
    /**
     * 把頁面端累積的訊息搬回 node 端並清空頁面 buffer。
     * 要定期呼叫——頁面 buffer 滿了就會開始丟棄。
     */
    async drain() {
      const batch = await page.evaluate(() => {
        const p = window.__uatPinusProbe;
        if (!p) return { items: [], dropped: 0, patched: null };
        const items = p.buf.splice(0, p.buf.length);
        return { items, dropped: p.dropped(), patched: p.patched };
      }).catch(() => ({ items: [], dropped: 0, patched: null }));
      pageDropped = batch.dropped || pageDropped;
      collected.push(...batch.items);
      return batch;
    },

    /** 目前 node 端收到的全部訊息 */
    messages() { return collected.slice(); },

    /** pinus 有沒有真的被攔到——沒有的話多半是這頁根本沒有 pinus，或補丁太晚 */
    async status() {
      return page.evaluate(() => {
        const p = window.__uatPinusProbe;
        return { present: typeof window.pinus !== 'undefined', probe: !!p, patched: p ? p.patched : null };
      }).catch(() => ({ present: false, probe: false, patched: null }));
    },

    summary() {
      const byRoute = new Map();
      for (const m of collected) {
        const key = `${m.direction} ${m.route}`;
        const cur = byRoute.get(key) ?? { key, count: 0, totalMs: 0, timed: 0, maxMs: 0 };
        cur.count++;
        if (typeof m.elapsedMs === 'number') {
          cur.totalMs += m.elapsedMs; cur.timed++;
          if (m.elapsedMs > cur.maxMs) cur.maxMs = m.elapsedMs;
        }
        byRoute.set(key, cur);
      }
      const routes = [...byRoute.values()]
        .map(r => ({ key: r.key, count: r.count, avgMs: r.timed ? Math.round(r.totalMs / r.timed) : null, maxMs: r.timed ? r.maxMs : null }))
        .sort((a, b) => b.count - a.count);
      return { total: collected.length, pageDropped, routes };
    },

    formatSummary() {
      const s = this.summary();
      if (!s.total) return '── pinus 訊息 ──\n  （這次沒有攔截到 pinus 訊息）';
      const out = [`── pinus 訊息 ──`, `  共 ${s.total} 筆` + (s.pageDropped ? `（頁面端因超過上限丟棄 ${s.pageDropped} 筆）` : '')];
      for (const r of s.routes.slice(0, 15)) {
        out.push(`  ${String(r.count).padStart(5)} 次  ${r.key}` + (r.avgMs !== null ? `  平均 ${r.avgMs}ms / 最慢 ${r.maxMs}ms` : ''));
      }
      if (s.routes.length > 15) out.push(`  …另外還有 ${s.routes.length - 15} 種 route`);
      return out.join('\n');
    },
  };
}
