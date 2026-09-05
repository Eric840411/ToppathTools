#!/usr/bin/env python3
"""
toppath-agent.py — Toppath Tools 本機 AutoSpin Agent（Playwright 版）
完整移植 AutoSpin.py 的遊戲進入流程、Spin 邏輯與 keyword_actions。
"""

import sys
import json
import time
import threading
import multiprocessing
import queue
import signal
import os
import re
import tempfile
import base64
import urllib.parse
from datetime import datetime
from urllib.parse import urlparse, parse_qs

# Optional: OpenCV for template matching
try:
    import cv2 as _cv2
    import numpy as _np
    OPENCV_AVAILABLE = True
except ImportError:
    OPENCV_AVAILABLE = False

try:
    import requests
except ImportError:
    print("[ERROR] 缺少 requests 套件，請執行: pip install requests")
    sys.exit(1)

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PwTimeout
except ImportError:
    print("[ERROR] 缺少 playwright 套件，請執行: pip install playwright && playwright install chromium")
    sys.exit(1)

# ─── 伺服器連線資訊（多進程架構：每台機台一個獨立 process，下面這幾個模組全域變數
# 由「parent process」的 main() 解析/註冊一次，再透過 machine_worker() 的參數把值帶進
# 每個 child process，並在 child 一開始用 global 賦值——本檔案其餘所有函式（log/do_spin/
# enter_game/...）都直接讀這幾個模組全域變數，維持不變，不用每個函式都加參數 ───
server_url = "http://localhost:3000"
user_label = ""
session_id = None
keyword_actions: dict = {}  # enter_game() 讀這個當作 bare global（fallback 用），machine_worker() 進場時賦值
machine_actions: dict = {}  # 目前未串接的殘留變數，保留只為了跟伺服器回傳的資料形狀一致
screenshot_enabled: bool = True  # 截圖監控依帳號開關（2026-08-17），啟動當下讀一次，不即時生效

# ─── 工具函數 ─────────────────────────────────────────────────────────────────

stop_flag = threading.Event()
pause_flag = threading.Event()

log_queue: "queue.Queue[str]" = queue.Queue()

def log(msg: str):
    """印到本機 console（立即）+ 丟進背景佇列非同步上傳伺服器，主自動化迴圈不會被網路請求卡住。"""
    ts = datetime.now().strftime("%H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    log_queue.put(line)

AGENT_LOCAL_LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'agent-reconnect.log')

def local_log(msg: str):
    """印到 console + 額外寫進本機檔案，專門給「連線/斷線重連」這類訊息用，不透過 log()。
    重連失敗當下 session_id 是無效的（連線本身就是問題所在），log() 送去伺服器一定被 404 吞掉，
    網頁「執行日誌」面板永遠看不到失敗訊息；終端機視窗又常被多台機台持續洗版蓋過去、捲動緩衝區
    有限，長時間跑下來很難用肉眼在終端機裡找到某次特定的重連事件。寫進固定的本機檔案，不受
    終端機緩衝區限制，之後可以直接開檔案搜尋確認實際發生過什麼。"""
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    try:
        with open(AGENT_LOCAL_LOG_PATH, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:
        pass

def log_worker():
    """背景執行緒：批次把佇列裡的日誌行 POST 給伺服器。
    pinus 監控一次 spin 可能連續產生好幾行（request/response/push...），
    改成背景執行緒 + 批次上傳，避免逐行同步 POST 拖慢主 Spin 迴圈。"""
    while True:
        line = log_queue.get()
        batch = [line]
        while len(batch) < 50:
            try:
                batch.append(log_queue.get_nowait())
            except queue.Empty:
                break
        try:
            requests.post(f"{server_url}/api/autospin/agent/{session_id}/log",
                          json={'lines': batch}, timeout=5)
        except Exception:
            pass

def async_call(fn, *args, **kwargs):
    """在背景執行緒跑一個網路呼叫（fire-and-forget），避免呼叫方（主 Spin 迴圈）被同步網路請求卡住。
    post_history()/send_screenshot()/send_lark() 都是 best-effort、內部已吞掉例外，適合這樣用。"""
    threading.Thread(target=fn, args=args, kwargs=kwargs, daemon=True).start()

def send_screenshot(name: str, img_bytes: bytes):
    try:
        requests.post(f"{server_url}/api/autospin/agent/{session_id}/screenshot",
                      files={'file': (name, img_bytes, 'image/png')}, timeout=15)
    except Exception as e:
        log(f"[截圖上傳失敗] {e}")

def send_stopped():
    try:
        requests.post(f"{server_url}/api/autospin/agent/{session_id}/stop",
                      json={'reason': 'user_stopped'}, timeout=5)
    except Exception:
        pass

def post_history(machine_type: str, balance, spin_count: int, event: str = 'balance', note: str = ''):
    """上傳一筆戰績紀錄到伺服器"""
    try:
        r = requests.post(f"{server_url}/api/autospin/agent/{session_id}/history",
                          json={'machineType': machine_type, 'balance': balance,
                                'spinCount': spin_count, 'event': event, 'note': note},
                          timeout=5)
        d = r.json()
        if d.get('isAnomaly'):
            log(f"[{machine_type}] ⚠️ 異常偵測：餘額相比本次開局下降超過 30%")
    except Exception:
        pass

def resolve_real_game_url(url: str) -> str:
    """把 URL 帳號池的中轉網址還原成真正的遊戲網址。

    ⚠️ 這一步不能省。中轉網址長這樣：

        http://<host>/api/url-pool/go/9111222002?user=Eric%20Wu&to=<base64>

    **帳號不在這一層**——`username=osmel002` 是藏在 base64 的 `to=` 裡面的。
    直接對中轉網址取 `username` 會拿到空字串，然後：

      · recon_spin 落庫時 username 是空的
      · 後台拉取沒有過濾值可用
      · 結果是一筆都對不上，但**畫面上看起來就像「設計失敗」**，
        而不是「網址沒解開」——這正是最難查的那種壞法。

    路徑上的 `9111222002` 是帳號池的門號 id、不是遊戲帳號，不能拿來當 username。

    解不開時回傳原字串（不是空字串）：讓後面的 username 取值照舊失敗，
    比在這裡吞掉、讓上層拿到一個看似正常的空值好。
    """
    if '/api/url-pool/go/' not in url:
        return url
    m = re.search(r'[?&]to=([^&]+)', url)
    if not m:
        return url
    try:
        raw = urllib.parse.unquote(m.group(1))
        # base64 少了 padding 會丟 binascii.Error，補滿再解
        raw += '=' * (-len(raw) % 4)
        decoded = base64.b64decode(raw).decode('utf-8')
    except Exception:
        return url
    # ⚠️ b64decode 對非法字元「不會拋例外」——它默默略過，`!!!` 解出來是空字串。
    #    不檢查就會把一個壞掉的網址靜默換成 ''，比解不開更糟：
    #    上層拿到空字串會以為「這台沒有 Game URL」，而不是「網址壞了」。
    return decoded if decoded.startswith('http') else url


def post_recon_spin(machine_type: str, cfg: dict, spin_seq: int, balance_before, balance_after, observed_at_ms: int):
    """Live Ledger 觀測落庫——三段式綁定的第 ① 段。

    ⚠️ 一定要走 async_call 丟背景執行緒。這支每次 spin 都會呼叫，
       同步打會把網路延遲加進 spin 迴圈的節奏裡，直接影響壓測本身的間隔。

    ⚠️ env 與 username 都從 Game URL 推——agent 這側沒有別的來源：
       uat-osm-redirect → uat，其餘 → qat；username 取 query 的 username 參數。
       username 是後台查詢的過濾值，推錯會導致整批對到別人的資料（後端有防呆會擋，
       但那時只會看到 DEGRADED，不會知道是這裡推錯）。
    """
    try:
        url = resolve_real_game_url(cfg.get('gameUrl') or '')
        env = 'uat' if 'uat-osm-redirect' in url else 'qat'
        m = re.search(r'[?&]username=([^&]+)', url)
        username = m.group(1) if m else ''
        requests.post(
            f"{server_url}/api/autospin/agent/{session_id}/recon-spin",
            json={
                'env': env,
                'machineType': machine_type,
                'gmid': cfg.get('gameTitleCode') or '',
                'username': username,
                'spinSeq': spin_seq,
                # ⚠️ bet 目前拿不到：dealGMActionReq 的請求裡沒有 bet 欄位（下注額是另一個
                #    動作設定的），而餘額在實測的 session 完全沒變動，也推不出來。
                #    留 None，序列對齊會跳過 bet 驗證。
                'betAmount': None,
                'balanceBefore': balance_before,
                'balanceAfter': balance_after,
                'observedAt': observed_at_ms,
            },
            timeout=5)
    except Exception:
        # 對帳落庫失敗絕不能影響壓測。真正的訊號是 recon_spin 有沒有在長。
        pass

spin_interval_override = None  # set by server via should-stop poll
spin_interval_lock = __import__('threading').Lock()

# OSMWatcher 狀態快取（key=gmid/gameTitleCode, value=status code），隨 should-stop 心跳一起更新
osm_status_cache: dict = {}
osm_status_lock = __import__('threading').Lock()

# 定時彙總報告設定（間隔/開關可從伺服器即時調整，不用重啟 Agent），隨 should-stop 心跳一起更新
status_report_enabled = False
status_report_interval_min = 20.0
status_report_lock = __import__('threading').Lock()

AGENT_START_TS = time.time()  # 用來算「已跑時間」（累計 uptime）

def poll_stop():
    global spin_interval_override, session_id, status_report_enabled, status_report_interval_min
    while not stop_flag.is_set():
        try:
            r = requests.get(f"{server_url}/api/autospin/agent/{session_id}/should-stop", timeout=5)
            d = r.json()
            # Session not found (server restarted) — re-register to get a new session
            if d.get('sessionNotFound'):
                local_log("[Agent] Session 已失效，嘗試重新連線伺服器...")
                try:
                    resp = requests.post(f"{server_url}/api/autospin/agent/start",
                                         json={'userLabel': user_label}, timeout=10)
                    new_data = resp.json()
                    session_id = new_data['sessionId']
                    local_log(f"[Agent] 重新連線成功，新 Session: {session_id}")
                    log(f"[Agent] 斷線重連成功（伺服器重啟），繼續執行中")
                except Exception as e:
                    local_log(f"[Agent] 重連失敗，將在下次輪詢重試: {e}")
                time.sleep(3)
                continue
            if d.get('stop'):
                log("[Agent] 伺服器發出停止指令")
                stop_flag.set()
                break
            # Update spin interval override if provided
            sv = d.get('spinInterval')
            with spin_interval_lock:
                if sv is not None and spin_interval_override != sv:
                    log(f"[Agent] Spin 間隔已更新：{sv}s")
                    spin_interval_override = sv
                elif sv is None:
                    spin_interval_override = None
            # Update pause flag
            if d.get('pause', False):
                pause_flag.set()
            else:
                pause_flag.clear()
            # Update OSMWatcher status cache（key=gmid）
            osm_status = d.get('osmStatus')
            if isinstance(osm_status, dict):
                with osm_status_lock:
                    osm_status_cache.clear()
                    osm_status_cache.update(osm_status)
            # 定時彙總報告設定
            with status_report_lock:
                status_report_enabled = bool(d.get('statusReportEnabled', False))
                iv = d.get('statusReportIntervalMin')
                if isinstance(iv, (int, float)) and iv > 0:
                    status_report_interval_min = float(iv)
        except Exception:
            pass
        time.sleep(3)

# ─── 常量 ─────────────────────────────────────────────────────────────────────

SPECIAL_GAMES = {'BULLBLITZ', 'ALLABOARD'}

# OSMWatcher 狀態碼（與 machine-test/runner.ts 的 BONUS_STATUSES/OSM_STATUS_LABELS 對應，
# 只讀取同一份 osmMachineStatus 資料源，不修改 Machine Test 本身程式碼）
BONUS_STATUSES = {1, 2, 3, 4, 5, 8}
OSM_STATUS_LABELS = {
    1: 'Free Game 觸發', 2: 'Free Game 觸發 (2)', 3: 'Jackpot 觸發',
    4: 'Jackpot 進行中', 5: 'Free Game 進行中', 8: '面額切換',
    9: 'Handpay（需人工處理）',
}

# Machine Log API（daily-analysis）—— 與 machine-test/runner.ts 的 DAILY_ANALYSIS_URLS 同步
DAILY_ANALYSIS_URLS = {
    'qat': 'https://qat-osmtrace.osmslot.org/api/machine/daily-analysis',
    'prod': 'https://prod-osmtrace.osmslot.org/api/machine/daily-analysis',
}
daily_log_state: dict = {}  # machineType -> {'date': 'YYYY-MM-DD', 'last_time': 'HH:MM:SS'}
daily_log_lock = threading.Lock()

# 按鈕健康度追蹤（從 daily-analysis 的 success_json 事件解析，只算 iDeck/觸屏按鈕，不算其他事件類型）
# machineType -> {'ideck_ok':int, 'ideck_err':int, 'touch_ok':int, 'touch_err':int, 'since_summary':int}
button_health: dict = {}

# 「還沒拿到 uid 所以略過戰績查詢」的次數，用來節流那行日誌。
# module-level 即可：spawn 模式下每個 child 各自一份，天然隔離（跟 button_health 同理）。
pinus_uid_skip_count: dict = {}
button_health_lock = threading.Lock()
BUTTON_SUMMARY_EVERY = 20  # 每累積這麼多次按鈕確認事件，印一次健康度摘要

# ─── Pinus / GM Event 監控 injected script ────────────────────────────────────
# 完整移植自 server/machine-test/runner.ts 的 PINUS_TRACKER_SCRIPT + GM_EVENT_MONITOR_SCRIPT，
# 並擴充 window.__pinusLog 記錄所有 pinus request/response/push 訊息（供監控功能使用）。
TOPPATH_MONITOR_SCRIPT = r"""
(() => {
  if (window.__toppathMonitorInjected) return;
  window.__toppathMonitorInjected = true;
  window.__lastCoin = null;
  window.__coinUpdatedAt = 0;
  window.__gmEvents = [];
  window.__pinusLog = [];
  window.__lastSpinErr = null;
  window.__spinErrCounts = {};  // { "100": 3, "5": 10, ... } —— 每種 errcode 各自累計次數，供定時彙總報告用
  window.__spinErrTimes = {};  // { "100": [ts1, ts2, ...] } —— 每種 errcode 最近 5 次發生時間（epoch ms），供定時彙總報告用
  window.__wsRecoverCount = 0;  // pinus WebSocket 斷線後重新連上的次數
  var MAX_LOG = 500;

  function pushPinusLog(dir, route, data) {
    try {
      var text;
      try { text = JSON.stringify(data); } catch (e) { text = String(data); }
      if (text && text.length > 500) text = text.slice(0, 500) + '…';
      window.__pinusLog.push({ dir: dir, route: route || '', data: text, ts: Date.now() });
      if (window.__pinusLog.length > MAX_LOG) window.__pinusLog.shift();
    } catch (e) {}
  }

  // 攔截 console.warn/console.error（遊戲端 WebSocket 斷線、"Game exception" 等原生報錯）
  // 只攔 warn/error，不攔 log，避免把大量除錯用的 console.log 也導進來洗版。
  // 注意：這裡跑在遊戲自己的頁面 context，故意不用 JSON.stringify（大型物件深度序列化
  // 可能佔用遊戲本身的主執行緒時間，拖慢動畫/渲染），只用便宜的 String() 轉換，
  // 且最多只處理前 3 個參數，避免遊戲一次印很多東西時拖慢畫面。
  window.__consoleLog = [];
  function pushConsoleLog(level, args) {
    try {
      var parts = [];
      for (var i = 0; i < args.length && i < 3; i++) {
        var a = args[i];
        parts.push(typeof a === 'string' ? a : String(a));
      }
      var text = parts.join(' ');
      if (text && text.length > 300) text = text.slice(0, 300) + '…';
      window.__consoleLog.push({ level: level, text: text, ts: Date.now() });
      if (window.__consoleLog.length > 200) window.__consoleLog.shift();
    } catch (e) {}
  }
  var _origConsoleWarn = console.warn.bind(console);
  console.warn = function () { pushConsoleLog('warn', arguments); return _origConsoleWarn.apply(console, arguments); };
  var _origConsoleError = console.error.bind(console);
  console.error = function () { pushConsoleLog('error', arguments); return _origConsoleError.apply(console, arguments); };

  function scanForGMEvent(text) {
    try {
      for (var i = 0; i < 2; i++) {
        var evName = i === 0 ? 'enterGMNtc' : 'leaveGMNtc';
        if (text.indexOf(evName) === -1) continue;
        var m1 = text.match(/"errcode"\s*:\s*(-?\d+)/);
        var errcode = m1 ? parseInt(m1[1]) : 0;
        var m2 = text.match(/"errcodedes"\s*:\s*"([^"]*)"/);
        var errcodedes = m2 ? m2[1] : '';
        var m3 = text.match(/"machineType"\s*:\s*"([^"]*)"/);
        var machineType = m3 ? m3[1] : '';
        window.__gmEvents.push({ event: evName, errcode: errcode, errcodedes: errcodedes, machineType: machineType, ts: Date.now() });
        return;
      }
    } catch (e) {}
  }

  // Hook WebSocket so we can scan raw frames for enterGMNtc/leaveGMNtc before pinus decodes them.
  // 順便偵測斷線重連（RECOVER）：一個 WS 實例 close 之後，若之後又有新的 WS 實例成功 open，
  // 代表 pinus 自己重連成功了，算一次 RECOVER。
  var _OrigWS = window.WebSocket;
  window.__wsHadClose = false;
  function PatchedWS(url, protocols) {
    // 遊戲通常是先把新的 window.pinus 物件準備好，才呼叫 new WebSocket() 開始連線
    // （實測 DevTools 追蹤過，「準備新 connector: window.pinus: ...」這行 log 早於
    // 「connect to wss://...」），這裡先嘗試補丁一次，可能比等 WS open 更早搶到。
    try { tryPatchPinus(); } catch (e) {}
    var ws = protocols !== undefined ? new _OrigWS(url, protocols) : new _OrigWS(url);
    var wasReconnectAttempt = window.__wsHadClose;
    ws.addEventListener('open', function () {
      if (wasReconnectAttempt) {
        window.__wsRecoverCount++;
        window.__wsHadClose = false;
      }
      // 斷線重連/熱更新切換 connector 時，遊戲會建立全新的 window.pinus 物件，
      // 並在這個新 WebSocket open 之後才開始註冊自己的 .on('moneyNtc', ...) 等監聽器。
      // 光靠下面固定 200ms 輪詢跟遊戲的註冊時機賽跑，賽輸的話那個監聽器就永遠繞過
      // 我們的補丁（.on() 只包裝「補丁生效之後」才呼叫的註冊，補丁生效前就註冊好的
      // 監聽器不會被追溯包裝）——實測發現 moneyNtc 確實會在熱更新後就此收不到。
      // 在 WS 一 open 就立刻嘗試補丁一次，搶在遊戲註冊監聽器之前完成，是比固定輪詢
      // 更可靠的時機點（下面的 setInterval 仍保留當作補漏用的保底機制）。
      try { tryPatchPinus(); } catch (e) {}
    });
    ws.addEventListener('close', function () {
      window.__wsHadClose = true;
    });
    ws.addEventListener('message', function (ev) {
      try {
        var text = '';
        if (typeof ev.data === 'string') {
          text = ev.data;
        } else if (ev.data instanceof ArrayBuffer) {
          text = new TextDecoder('iso-8859-1').decode(ev.data);
        }
        if (text) scanForGMEvent(text);
      } catch (e) {}
    });
    return ws;
  }
  PatchedWS.prototype = _OrigWS.prototype;
  PatchedWS.CONNECTING = _OrigWS.CONNECTING;
  PatchedWS.OPEN = _OrigWS.OPEN;
  PatchedWS.CLOSING = _OrigWS.CLOSING;
  PatchedWS.CLOSED = _OrigWS.CLOSED;
  window.WebSocket = PatchedWS;

  // Hook window.pinus.request / .on — coin 追蹤 + 完整訊息記錄（監控用）
  //
  // v3.90.12 靠「WS open 事件 + 30ms 輪詢」搶在遊戲註冊監聽器之前補丁，實測仍會漏：
  // 如果遊戲是「建立新 pinus 物件 → 同一個 tick 內就呼叫 .on('moneyNtc', ...)」，
  // 兩者是同步執行的，任何事件驅動/輪詢都是非同步觸發，天生就贏不了同一個 tick 內的
  // 同步呼叫，moneyNtc 監聽器永遠註冊在補丁生效之前，重連後就此收不到（已用
  // 2026-08-07 v3.90.12 實測日誌驗證：moneyNtc 在 serverUpdateNtc 熱更新那一刻後
  // 完全消失，之後每次 Spin 全部 timeout_8s）。
  //
  // 真正解法：不要補在「instance」上，改補在「prototype」上。使用者 DevTools 截圖
  // 證實新 pinus 物件是用 `Object.create(EventEmitter.prototype)` 建立的——同一個
  // prototype 物件會被之後每一次 center update/斷線重連建立的新 instance 共用。
  // .on() 這種方法幾乎必然定義在 prototype 上（EventEmitter 模式的通例，不會每個
  // instance 各自覆寫一份），只要找到「實際定義這個方法的物件」（沿 prototype chain
  // 往上找 hasOwnProperty），直接在那裡補一次，之後所有共用這個 prototype 的新
  // instance 自動繼承補丁後的版本，不再需要每次重連後重新賽跑時機——徹底解決
  // race condition，而不是繼續想辦法縮小時間窗。
  //
  // .request() 有可能是 instance 自己的方法（跟 reqId 計數器等 instance 狀態綁在一起，
  // 每次 connect() 時重新賦值），這種情況下補在 prototype 上找不到 hasOwnProperty，
  // patchMethod() 會 fallback 補在 instance 上——跟舊行為一致，仍需要靠輪詢/WS事件
  // 在每次重連後重新補一次，只是這條路徑上優先順序較低（request 是「發送後等回應」，
  // 沒有 on() 這種「先註冊、可能永遠不會再呼叫第二次」的一次性視窗問題）。
  function patchMethod(obj, methodName, wrapFactory) {
    var owner = obj;
    while (owner && !Object.prototype.hasOwnProperty.call(owner, methodName)) {
      owner = Object.getPrototypeOf(owner);
    }
    if (!owner || typeof owner[methodName] !== 'function') return false;
    var flag = '__toppathPatched_' + methodName;
    if (owner[flag]) return true;
    owner[flag] = true;
    owner[methodName] = wrapFactory(owner[methodName]);
    return true;
  }

  function tryPatchPinus() {
    var p = window.pinus;
    if (!p) return false;

    var okRequest = patchMethod(p, 'request', function (origRequest) {
      return function (route, msg, cb) {
        pushPinusLog('request', route, msg);
        var isSpinReq = route && route.indexOf('dealGMActionReq') !== -1 && msg && msg.isspin === 1;
        return origRequest.call(this, route, msg, function (resp) {
          pushPinusLog('response', route, resp);
          // ⚠️ uid **只認登入回應**，不要「看到任何帶 uid 的封包就記」。
          //    historyListReq 要的是「目前登入者」的 uid；broadcastReq 這類廣播裡的 uid
          //    可能是別的玩家（實際日誌就同時出現過 325599 與 328980）。泛抓會把
          //    「撈不到資料」這個 bug 變成更危險的「撈到別人的戰績」（CodeX review）。
          if (route && route.indexOf('gate.gateHandler.loginReq') !== -1 && resp) {
            var u = resp.uid || (resp.data && resp.data.uid);
            if (u) window.__pinusUid = String(u);
          }
          if (resp && typeof resp.coin === 'number') {
            window.__lastCoin = resp.coin;
            window.__coinUpdatedAt = Date.now();
          }
          // 遊戲伺服器直接拒絕 Spin 請求（例如 errcode:100「請求超時或未確認錯誤」）：
          // 這種情況下 spin 動作根本沒有在伺服器端執行成功，按鈕 disabled 切換、coin 更新
          // 這兩個完成訊號都不會觸發，記錄下來讓 do_spin() 可以立即中斷等待，而不是傻等滿 8 秒。
          if (isSpinReq && resp && typeof resp.errcode === 'number' && resp.errcode !== 0) {
            window.__lastSpinErr = { errcode: resp.errcode, errcodedes: resp.errcodedes || '', ts: Date.now() };
            var ek = String(resp.errcode);
            window.__spinErrCounts[ek] = (window.__spinErrCounts[ek] || 0) + 1;
            if (!window.__spinErrTimes[ek]) window.__spinErrTimes[ek] = [];
            window.__spinErrTimes[ek].push(Date.now());
            if (window.__spinErrTimes[ek].length > 5) window.__spinErrTimes[ek].shift();
          }
          cb && cb(resp);
        });
      };
    });

    var okOn = patchMethod(p, 'on', function (origOn) {
      return function (route, cb) {
        return origOn.call(this, route, function (data) {
          pushPinusLog('push', route, data);
          if (data && typeof data.coin === 'number') {
            window.__lastCoin = data.coin;
            window.__coinUpdatedAt = Date.now();
          }
          cb && cb(data);
        });
      };
    });

    return okRequest || okOn;
  }
  // prototype 補丁一旦成功就永久生效（見上方 patchMethod 註解），這裡的輪詢主要是
  // 為了「補第一次」——遊戲第一次建立 pinus 物件的時機不確定，且 request 若是
  // instance-level 仍需要每次重連後重新補一次。間隔維持 30ms（v3.90.12 從 200ms 收緊）。
  setInterval(function () {
    tryPatchPinus();
  }, 30);
})();
"""

# ─── Playwright 輔助邏輯 ──────────────────────────────────────────────────────

def is_in_game(page) -> bool:
    """檢查目前是否已在遊戲中（非大廳），對應 AutoSpin.py _is_in_game()"""
    try:
        for sel in ['.my-button.btn_spin', '.btn_spin .my-button',
                    '.balance-bg.hand_balance', '.h-balance.hand_balance']:
            elems = page.locator(sel).all()
            if elems and any(e.is_visible() for e in elems):
                return True
        grid = page.locator('#grid_gm_item').all()
        if grid and any(e.is_visible() for e in grid):
            return False
    except Exception:
        pass
    return True  # 保守策略：不確定時視為在遊戲中


def detect_seat_state(page) -> str:
    """分辨「真的坐上機台」還是「只是在旁觀」。回傳 seated / spectator / lobby / unknown。

    ⚠️ 為什麼不能用 `is_in_game()`：**旁觀者一樣看得到 Spin 按鈕和餘額**。
       那支的四個 selector 對旁觀模式全部命中，而且不確定時預設回 True。
       用它判進場，等於把「坐在旁邊看」判成「已入座」。

    這正是 2026-09-05 那次 29 小時無效壓測的根因：進場流程判定成功 → 主迴圈開始按 spin
    → 每一發都回 `errcode 25 该玩家已经不在机器上了` → 16,573 次、0 局、沒有任何告警。

    判斷依據是**旁觀面板還開著沒有**（`.pop-page-watch`）——點卡片會開這個面板，
    真的按下 Join 入座後它會關掉。面板還在＝還沒入座。
    """
    try:
        for sel in ['.bg.pop-page-watch', '.pop-page-watch']:
            els = page.locator(sel).all()
            if els and any(e.is_visible() for e in els):
                return 'spectator'
        grid = page.locator('#grid_gm_item').all()
        if grid and any(e.is_visible() for e in grid):
            return 'lobby'
        for sel in ['.my-button.btn_spin', '.btn_spin .my-button',
                    '.balance-bg.hand_balance', '.h-balance.hand_balance']:
            els = page.locator(sel).all()
            if els and any(e.is_visible() for e in els):
                return 'seated'
    except Exception:
        pass
    return 'unknown'


def click_positions(page, positions: list):
    """點擊指定座標位（尋找文字內容為 'X,Y' 的 span），對應 AutoSpin.py click_multiple_positions()"""
    for pos in positions:
        try:
            elem = page.locator(f"span:text('{pos}')").first
            elem.click(timeout=2500)
            log(f"  已點擊座標位: {pos}")
            time.sleep(0.4)
        except Exception:
            log(f"  找不到座標位: {pos}")


def wait_for_span_text(page, text: str, timeout_ms: int = 10000):
    """等待文字內容為 text 的 span 出現，回傳該 locator，逾時回傳 None。
    完整移植自 machine-test/runner.ts 的 waitForSpanText()——包含同一個關鍵行為：
    觸屏測試用的 .screen-touch 疊加層 span 是完全透明的，Playwright 的 is_visible()
    對這種 span 一律回傳 False，所以只能檢查元素是否存在（count() > 0），不能檢查可見性，
    否則所有 touchPoints/bonusAction 觸屏點擊都會被誤判成「找不到元素」而略過。"""
    deadline = time.time() + timeout_ms / 1000
    while time.time() < deadline:
        try:
            loc = page.locator(f"span:text('{text}')").first
            if loc.count() > 0:
                return loc
        except Exception:
            pass
        time.sleep(0.3)
    return None


def run_entry_touch_points(page, mt: str, positions: list, stage_label: str):
    """兩階段進入觸屏（entryTouchPoints / entryTouchPoints2），逐一等元素出現再點擊。
    完整移植自 machine-test/runner.ts 的進入機台步驟，行為與逾時秒數（10s）保持一致。"""
    if not positions:
        return
    log(f"[{mt}] {stage_label}，等待元素出現...")
    for pos in positions:
        log(f"  等待元素「{pos}」...")
        elem = wait_for_span_text(page, pos, 10000)
        if elem:
            try:
                elem.evaluate("el => el.click()")
                log(f"  ✅ 已點擊「{pos}」")
            except Exception as e:
                log(f"  ⚠️ 點擊「{pos}」失敗: {e}")
            time.sleep(0.4)
        else:
            log(f"  ⚠️ 找不到元素「{pos}」（逾時 10s），跳過")
    time.sleep(0.8)


def wait_for_enter_gm(page, timeout_ms: int = 12000, baseline_ts: float = 0):
    """輪詢 window.__gmEvents 確認收到 enterGMNtc，回傳事件 dict 或 None。
    完整移植自 machine-test/runner.ts 的 waitForEnterGM()，掃描所有 frame（pinus 可能在子 iframe）。"""
    deadline = time.time() + timeout_ms / 1000
    while time.time() < deadline:
        for frame in page.frames:
            try:
                events = frame.evaluate("window.__gmEvents || []")
            except Exception:
                continue
            for ev in reversed(events or []):
                if ev.get('event') == 'enterGMNtc' and ev.get('ts', 0) > baseline_ts:
                    return ev
        time.sleep(0.3)
    return None


# 已知的浮動彈窗 overlay / 關閉按鈕 selector —— 完整移植自 machine-test/runner.ts 的 CCTV 步驟
# 清彈窗邏輯（原本只在 CCTV 步驟使用，範圍窄不會誤點遊戲 UI 本身，適合搬進入場流程重用）
OVERLAY_SELS = ['div.bg', '[class*="win-frame"]', '[class*="bonus-popup"]', '[class*="float-layer"]']
CLOSE_BTN_SELS = ['[class*="btn_close"]', '[class*="close-btn"]', '.btn_ok', 'button[class*="close"]', 'button[class*="ok"]', '.btn_take']


# 大廳專用：這幾層會蓋住機台卡片，讓點擊打不開機台面板。
# ⚠️ 跟 OVERLAY_SELS 分開，因為那組含 `div.bg`——`.bg` 在這個站是通用 class，
#    廣告、Tips、機台面板**全都是它**。拿它當「面板開了沒」的判準會誤判。
LOBBY_OVERLAY_CLOSE_SELS = [
    '[class*="advert"] [class*="close"]', '[class*="advert"] .closeBtn',
    '[class*="tips"] [class*="close"]', '[class*="tip-"] [class*="close"]',
    '.close', '.closeBtn', '.btn-close', '[class*="btn_close"]', '[class*="close-btn"]',
]
# 機台面板真的開了的判準（**不含 `.bg`**）
MACHINE_PANEL_SELS = ['.bg.pop-page-watch', '.pop-page-watch', '[class*="gm-info"]', '.gm-info-box']


def machine_panel_open(page) -> bool:
    """機台面板是不是真的開著。⚠️ 不要用 `.bg` 判——見 LOBBY_OVERLAY_CLOSE_SELS 的說明。"""
    for sel in MACHINE_PANEL_SELS:
        try:
            els = page.locator(sel).all()
            if els and any(e.is_visible() for e in els):
                return True
        except Exception:
            continue
    return False


# 廣告 overlay 是**延遲出現**的（實測第 4 秒才畫出來），所以清彈窗一定要輪詢，
# 而且不能太早宣告乾淨——見 dismiss_lobby_overlays() 的說明。
LOBBY_OVERLAY_MIN_WAIT_SEC = 6.0
LOBBY_OVERLAY_TIMEOUT_SEC = 15.0


def lobby_overlay_present(page) -> bool:
    """大廳上還有沒有蓋著的廣告／Tips。判準是「看得到的關閉鈕或廣告容器」。"""
    for sel in ['[class*="advert"]'] + LOBBY_OVERLAY_CLOSE_SELS:
        try:
            els = page.locator(sel).all()
            if els and any(e.is_visible() for e in els):
                return True
        except Exception:
            continue
    return False


def dismiss_lobby_overlays(page, mt: str,
                           min_wait: float = LOBBY_OVERLAY_MIN_WAIT_SEC,
                           timeout: float = LOBBY_OVERLAY_TIMEOUT_SEC) -> bool:
    """輪詢式清掉蓋在大廳上的廣告／Tips 彈窗。回傳「畫面是不是乾淨的」。

    ⚠️ **一定要輪詢，不能載入完立刻清一次就算數。**實測逐秒觀察：

        第 1~3 秒  沒有任何 overlay
        第 4 秒    `PLAY GAME` 廣告才出現（`.advert-container` 裡的 `.closeBtn`）

    也就是說「goto 之後馬上清」會清到空氣，然後等廣告真的出現時，卡片已經被點過了。
    選擇器一直都是對的，**錯的是時間點**。

    ⚠️ 同理，**不能在 `min_wait` 之前就宣告乾淨**——那個當下的「乾淨」只代表
    廣告還沒畫出來。這是這支函式最容易寫錯的地方：看起來成功、實際上什麼都沒等到。

    只點明確的關閉鈕，**不 force-click 彈窗本體**——這幾層的本體按下去是
    `PLAY GAME`／`Join`，會把我們帶到另一台機器上，比沒關掉更糟。
    """
    t0 = time.time()
    clean_streak = 0
    while time.time() - t0 < timeout:
        hit = False
        for sel in LOBBY_OVERLAY_CLOSE_SELS:
            try:
                for el in page.locator(sel).all():
                    if not el.is_visible():
                        continue
                    el.evaluate("el => el.click()")
                    log(f"[{mt}] 關閉大廳彈窗: {sel}（第 {time.time() - t0:.1f}s）")
                    hit = True
                    time.sleep(0.3)
                    break
            except Exception:
                continue
            if hit:
                break
        if hit:
            clean_streak = 0
            continue
        # 沒東西可點：確認真的乾淨，但必須先撐過 min_wait（廣告還沒出現時也是「乾淨」）
        clean_streak = clean_streak + 1 if not lobby_overlay_present(page) else 0
        if clean_streak >= 2 and time.time() - t0 >= min_wait:
            log(f"[{mt}] 大廳畫面已乾淨（耗時 {time.time() - t0:.1f}s）")
            return True
        time.sleep(0.8)
    still = lobby_overlay_present(page)
    log(f"[{mt}] {'⚠️ 逾時仍有彈窗未關掉' if still else '大廳畫面已乾淨（逾時前一刻）'}"
        f"（{timeout:.0f}s）")
    return not still


def dismiss_known_overlays(page, mt: str, rounds: int = 3):
    """清除已知類型的浮動彈窗（bonus/win-frame/float-layer 等，如 Game Preview / Jackpot 宣傳面板）。
    完整移植自 machine-test/runner.ts CCTV 步驟的 findOverlays + 清除邏輯：優先點關閉/OK 按鈕，
    找不到才 force-click 彈窗本體；最多重試 3 輪，最後補一次 Escape。"""
    def find_overlays():
        found = []
        for frame in page.frames:
            try:
                for sel in OVERLAY_SELS:
                    for el in frame.locator(sel).all():
                        try:
                            if not el.is_visible():
                                continue
                            box = el.bounding_box()
                            if box and box['width'] > 80 and box['height'] > 80:
                                found.append((frame, el, sel))
                        except Exception:
                            continue
            except Exception:
                continue
        return found

    dismissed_any = False
    for round_idx in range(rounds):
        overlays = find_overlays()
        if not overlays:
            break
        log(f"[{mt}] 清除彈窗第 {round_idx + 1} 輪（{len(overlays)} 個）...")
        for frame, el, sel in overlays:
            closed = False
            for close_sel in CLOSE_BTN_SELS:
                try:
                    btn = el.locator(close_sel).first
                    if btn.count() == 0:
                        btn = frame.locator(close_sel).first
                    if btn.count() > 0 and btn.is_visible():
                        btn.click(timeout=500)
                        log(f"[{mt}]   已點擊關閉按鈕（{close_sel}）")
                        closed = True
                        dismissed_any = True
                        break
                except Exception:
                    continue
            if not closed:
                try:
                    el.click(force=True, timeout=500)
                    log(f"[{mt}]   已 force-click 彈窗本體：{sel}")
                    dismissed_any = True
                except Exception:
                    pass
        time.sleep(1.0)

    try:
        page.keyboard.press('Escape')
    except Exception:
        pass

    if dismissed_any:
        time.sleep(0.5)
    return dismissed_any


def dismiss_denom_overlay(page, mt: str = '') -> bool:
    """偵測並點掉「選面額遮罩」（.select-main 疊層，例如 SELECT A DENOMINATION）。
    完整移植自 machine-test/runner.ts 的 dismissDenomOverlay()：這個遮罩不是只在剛進場時出現，
    Bet Change / Cashout 等操作之後也可能重新彈出蓋住 Spin 按鈕，導致 Spin 點擊完全沒反應
    （native click 可能不報錯，但遊戲根本沒收到，因為真正要點的是遮罩裡的面額選項，不是被蓋住的 Spin 按鈕）。
    找到就點第一個選項（JS 強制 click，繞過遮罩層），回傳是否有點過。"""
    for frame in page.frames:
        try:
            btns = frame.locator('.select-main .select-btn, .select-main .my-button').all()
            if btns:
                log(f"[{mt}] 偵測到選面額遮罩（{len(btns)} 個選項），點擊第一個...")
                btns[0].evaluate("el => el.click()")
                time.sleep(0.8)
                return True
        except Exception:
            continue
    return False


def dismiss_jackpot_notification(page, mt: str = '') -> bool:
    """偵測並點掉 Jackpot 中獎通知彈窗（.notification-close 關閉鈕，例如「WIN THE JACKPOT」
    彈窗，顯示中獎機台/帳號資訊，蓋住畫面含 Spin 按鈕）。這個彈窗可能在任何時候彈出（不只
    是進場時），跟選面額遮罩一樣需要每次 Spin 前主動偵測，不能只靠點擊失敗時的例外處理。"""
    for frame in page.frames:
        try:
            btn = frame.locator('.notification-close').first
            if btn.count() > 0:
                log(f"[{mt}] 偵測到 Jackpot 中獎通知彈窗，點擊關閉...")
                btn.evaluate("el => el.click()")
                time.sleep(0.5)
                return True
        except Exception:
            continue
    return False


def enter_game(page, cfg: dict) -> bool:
    """從大廳進入指定遊戲，對應 AutoSpin.py scroll_and_click_game()。
    每個步驟都印出開始/結束與耗時，方便追蹤整段進入流程實際花的時間。"""
    mt = cfg['machineType']
    game_title_code = cfg.get('gameTitleCode') or ''
    if not game_title_code:
        log(f"[{mt}] 未設定 gameTitleCode，跳過大廳尋找")
        return True

    t_start = time.time()
    log(f"[{mt}] ── 開始進入流程 ──")

    # 先等頁面穩定：等到遊戲指標或大廳元素出現其中一個再判斷
    # 避免頁面尚未載入時 is_in_game() 觸發「保守策略 → return True」
    t0 = time.time()
    log(f"[{mt}] 等待頁面穩定（遊戲或大廳元素其中一個出現，最多 12s）...")
    try:
        page.wait_for_selector(
            '.my-button.btn_spin, .btn_spin .my-button, #grid_gm_item',
            timeout=12000,
        )
        log(f"[{mt}] 頁面已穩定（耗時 {time.time() - t0:.1f}s）")
    except PwTimeout:
        log(f"[{mt}] 頁面載入等待超時（12s），繼續嘗試判斷狀態")

    if is_in_game(page):
        log(f"[{mt}] 已在遊戲中，跳過大廳")
        return True

    log(f"[{mt}] 判定目前在大廳，準備尋找機台卡片；等待 1s 讓大廳穩定...")
    time.sleep(1.0)

    t0 = time.time()
    log(f"[{mt}] 等待大廳機台列表載入（#grid_gm_item，最多 12s）...")
    try:
        page.wait_for_selector('#grid_gm_item', timeout=12000)
        log(f"[{mt}] 大廳機台列表已載入（耗時 {time.time() - t0:.1f}s）")
    except PwTimeout:
        if is_in_game(page):
            return True
        log(f"[{mt}] 大廳元素未找到（逾時）")
        return False

    items = page.locator('#grid_gm_item').all()
    log(f"[{mt}] 大廳共 {len(items)} 個機台卡片，尋找 gameTitleCode 含「{game_title_code}」的卡片...")
    target_item = None
    for item in items:
        title = item.get_attribute('title') or ''
        if game_title_code not in title:
            continue
        target_item = item
        break

    if not target_item:
        log(f"[{mt}] 大廳找不到遊戲: {game_title_code}")
        return False
    log(f"[{mt}] 找到目標卡片: {target_item.get_attribute('title') or game_title_code}")

    # ⚠️ **點卡片之前**先清一次彈窗。原本只在點完卡片之後清，但蓋住大廳的那幾層
    #    （全螢幕 `PLAY GAME` 廣告 `advert-container`、「預約機台權益」Tips）在點擊當下還在，
    #    機台面板就開不起來——接著「找不到 Join」被當成「此機種不需要」，一路走成旁觀者。
    #    （2026-09-05 由 DOM dump 確認：畫面上只有 .quick-join/.recommend-join 這類廣告按鈕，
    #     `.gm-info-box` 與 `.pop-page-watch` 兩個都不存在，代表面板真的沒開。）
    if not dismiss_lobby_overlays(page, mt):
        log(f"[{mt}] ❌ 大廳彈窗清不掉——這時點卡片會點到廣告（PLAY GAME），"
            f"而不是開啟機台面板，中止進場。")
        return False
    time.sleep(0.4)

    # 捲動到目標卡片並點擊
    try:
        target_item.scroll_into_view_if_needed(timeout=3000)
        time.sleep(0.3)
    except Exception:
        pass

    # 記錄點擊前的時間戳，稍後用來過濾出「這次進入」才收到的 enterGMNtc（避免比對到上次進入的殘留事件）
    enter_baseline_ts = time.time() * 1000

    # 直接用 JS click（同 machine-test 做法，繞過 Playwright pointer-events 攔截）
    try:
        target_item.evaluate("el => el.click()")
    except Exception as e:
        log(f"[{mt}] JS click 失敗: {e}")
        return False

    log(f"[{mt}] 點擊遊戲卡片: {target_item.get_attribute('title') or game_title_code}")
    log(f"[{mt}] 等待卡片點擊反應 1.2s...")
    time.sleep(1.2)

    # 嘗試點擊 Join 按鈕 —— 完整移植自 machine-test/runner.ts：
    # 1) 文字需完全等於「Join」（不是子字串比對，避免誤中「Join Now」之類的其他按鈕）
    # 2) 找到多個符合時，逐一檢查取第一個「可見」的（不是 DOM 順序第一個）
    # 3) 用 JS evaluate click（繞過 Playwright pointer-events 攔截，跟卡片點擊同一招）
    # ⚠️ 先看機台能不能入座。不能入座時 Join 按鈕**仍然存在**，只是帶 `gm-info-join-unable`
    #    且文字變成 `Occupied`——不先判這個的話，「找不到文字等於 Join 的按鈕」會被歸成
    #    「此機種不需要 Join」繼續往下走，變成旁觀者，又是同一種誤判。
    #    這也比等 enterGMNtc 逾時 12 秒快得多，而且是明確訊號不是推測。
    #
    # ⚠️ **畫面上的 `Occupied` 分不出「有人在玩」和「維護中」。**已用後台
    #    `/egm/floor/egmList` 核對過：三台 RISINGROCKETS 在畫面上都寫 Occupied，
    #    但 `machineStatus` 其實是 `maintain`。所以訊息只能說「無法入座」，
    #    不能說死是被人佔用——講錯原因會讓人去等一個永遠不會釋放的機台。
    try:
        occupied = page.locator('.gm-info-join-unable').all()
        if occupied and any(e.is_visible() for e in occupied):
            txt = ''
            try:
                txt = (occupied[0].inner_text() or '').strip()
            except Exception:
                pass
            log(f"[{mt}] ❌ 機台目前無法入座（Join 為 disabled{f'，畫面顯示「{txt}」' if txt else ''}）"
                f"——可能是有人在玩，也可能是維護中，畫面上分不出來。中止進場。"
                f"確認實際狀態請查後台 egmList 的 machineStatus（occupy / maintain）。")
            return False
    except Exception:
        pass

    log(f"[{mt}] 嘗試尋找 Join 按鈕（不一定存在）...")
    try:
        join_candidates = page.locator(".gm-info-box span:text-is('Join')").all()
        joined = False
        for j in join_candidates:
            if j.is_visible():
                j.evaluate("el => el.click()")
                log(f"[{mt}] 點擊 Join 進入遊戲，等待 3s 讓遊戲載入...")
                time.sleep(3.0)
                joined = True
                break
        if not joined:
            # ⚠️ 「找不到 Join」有兩種完全不同的意思，不能都當成可以繼續：
            #    ① 這個機種真的不需要 Join（面板開著、就是沒有那顆按鈕）
            #    ② 面板根本沒開（點卡片沒反應／被彈窗蓋掉）——這時往下走就是旁觀者
            #
            #    先前兩種都印「此機種可能不需要，繼續下一步」，於是 ② 一路走到主迴圈，
            #    變成坐在旁邊按 spin 按 29 小時。
            if machine_panel_open(page):
                log(f"[{mt}] 面板已開但沒有 Join 按鈕（此機種不需要 Join），繼續下一步")
            else:
                # 面板沒開＝點卡片沒生效。多半是還有彈窗蓋著——再清一次、重點一次卡片。
                log(f"[{mt}] 機台面板未開啟，再清一次彈窗後重試點擊卡片...")
                dismiss_lobby_overlays(page, mt)
                time.sleep(0.6)
                try:
                    target_item.evaluate("el => el.click()")
                    time.sleep(1.5)
                except Exception:
                    pass
                if machine_panel_open(page):
                    log(f"[{mt}] 重試後面板已開，繼續下一步")
                else:
                    log(f"[{mt}] ❌ 機台面板始終沒有開啟（找不到 {', '.join(MACHINE_PANEL_SELS)}）——"
                        f"點卡片沒有生效，或仍被廣告／Tips 彈窗蓋住。"
                        f"這時往下走只會變成旁觀者（每一發 spin 回 errcode 25），中止進場。")
                    return False
    except Exception as e:
        log(f"[{mt}] ❌ 尋找 Join 按鈕時發生例外，中止進場: {e}")
        return False

    # ── 清除已知浮動彈窗（Game Preview / Jackpot 宣傳面板等）── 與 Machine Test 完全同步
    # 選用 machine-test/runner.ts CCTV 步驟同一套 overlay/close-btn selector（範圍窄，不會誤點遊戲 UI）
    log(f"[{mt}] 檢查是否有已知類型的浮動彈窗（Game Preview / Jackpot 宣傳面板等）...")
    if dismiss_known_overlays(page, mt):
        log(f"[{mt}] 已清除浮動彈窗")
    else:
        log(f"[{mt}] 沒有偵測到已知類型的浮動彈窗")

    # ── 進入觸屏（entryTouchPoints / entryTouchPoints2）── 與 Machine Test 完全同步
    # 機種設定檔（machine_test_profiles）有設定時優先使用；沒有設定的機種才 fallback 用舊的 keyword_actions
    entry_touch_points = cfg.get('entryTouchPoints') or []
    entry_touch_points2 = cfg.get('entryTouchPoints2') or []
    if entry_touch_points or entry_touch_points2:
        log(f"[{mt}] 機種設定檔有 entryTouchPoints，開始兩階段進入觸屏處理")
        run_entry_touch_points(page, mt, entry_touch_points, '進入觸屏第一階段（選擇 DENOM）')
        run_entry_touch_points(page, mt, entry_touch_points2, '進入觸屏第二階段（YES/NO 確認）')
    else:
        # 執行 keyword_actions（對應 AutoSpin.py 中的 keyword_actions 邏輯）
        matched_kw = False
        for kw, positions in keyword_actions.items():
            if kw in game_title_code and positions:
                log(f"[{mt}] 執行 keyword_actions: {kw} -> {positions}")
                time.sleep(1.0)
                click_positions(page, positions)
                time.sleep(1.0)
                matched_kw = True
                break
        if not matched_kw:
            log(f"[{mt}] 無 entryTouchPoints 設定，也無符合的 keyword_actions，跳過進入觸屏處理")

    # ── 等待 enterGMNtc 確認進入成功（與 Machine Test 完全同步）──
    log(f"[{mt}] 等待 enterGMNtc WebSocket 事件確認進入成功（最多 12s）...")
    t0 = time.time()
    enter_ev = wait_for_enter_gm(page, 12000, enter_baseline_ts)
    # ⚠️ 這一段先前**四種情況全部 return True**，包括 errcode≠0 和 12 秒逾時。
    #    註解寫「與 Machine Test 完全同步」，但 machine-test 的判定其實是：
    #      errcode=0 → pass ｜ errcode≠0 → **fail** ｜ 逾時+DOM → warn ｜ 都沒有 → **fail**
    #    這份只複製了訊息文字、沒有複製判定，是最難發現的那種漂移：日誌長得一模一樣。
    #
    #    尤其「改用 DOM 偵測判斷是否進入成功」那句是**假的**——底下根本沒有任何偵測，
    #    直接 return True。逾時等於進場成功。
    if enter_ev:
        errcode = enter_ev.get('errcode', 0)
        if errcode == 0:
            log(f"[{mt}] ✅ enterGMNtc 確認進入成功（耗時 {time.time() - t0:.1f}s）")
            log(f"[{mt}] ── 進入流程結束，總耗時 {time.time() - t_start:.1f}s ──")
            return True
        log(f"[{mt}] ❌ 進入失敗：enterGMNtc errcode={errcode} — {enter_ev.get('errcodedes', '')}"
            f"（耗時 {time.time() - t0:.1f}s）")
        return False

    # 逾時：真的做 DOM 偵測，而且要能分辨「旁觀」——這是先前缺的那一步
    seat = detect_seat_state(page)
    log(f"[{mt}] ⚠️ 未收到 enterGMNtc（12s 逾時），改用 DOM 偵測：座位狀態 = {seat}")
    if seat == 'seated':
        # 對齊 machine-test 的 warn：沒有 enterGMNtc 佐證，但畫面上確實不是旁觀面板也不是大廳
        log(f"[{mt}] ⚠️ 以 DOM 判定為已入座（無 enterGMNtc 佐證，降級通過）")
        log(f"[{mt}] ── 進入流程結束，總耗時 {time.time() - t_start:.1f}s ──")
        return True
    if seat == 'spectator':
        log(f"[{mt}] ❌ 仍停留在旁觀面板——**沒有真的入座**。"
            f"繼續下去每一發 spin 都會回 errcode 25（该玩家已经不在机器上了），中止進場。")
    else:
        log(f"[{mt}] ❌ 未收到 enterGMNtc 且 DOM 判定為 {seat}，無法確認已入座，中止進場。")
    return False


def execute_bet_random(page, ideck_xpaths: list):
    """Spin 後 30% 機率隨機點擊下注按鈕（對應 AutoSpin.py _execute_bet_random）

    XPath 來源改為 machine_test_profiles.ideck_xpaths（跟 Machine Test 共用同一份設定，
    2026-07-30 起不再有獨立的 bet_random.json + 隨機下注頁面），已經是該機台自己的清單，
    不用再做 game_title_code 比對。"""
    import random as _random
    if not ideck_xpaths:
        return
    if _random.random() > 0.3:
        return
    sel = _random.choice(ideck_xpaths)
    try:
        elems = page.locator(sel).all()
        for e in elems:
            if e.is_visible():
                e.click(timeout=1500)
                log(f"  [BetRandom] 點擊下注按鈕: {sel}")
                time.sleep(0.5)
                return
        log(f"  [BetRandom] 機率命中但畫面上找不到可見元素: {sel}")
    except Exception as e:
        log(f"  [BetRandom] 機率命中但點擊失敗: {sel} ({e})")


def check_page_error(page) -> bool:
    """檢查頁面是否為 404 / 錯誤頁面"""
    try:
        url = page.url()
        if 'about:blank' in url or url == '':
            return True
        title = page.title()
        if any(x in title for x in ['404', 'Error', 'Not Found']):
            return True
        body = page.locator('body').inner_text(timeout=2000)
        if any(x in body for x in ['404', 'Page Not Found', 'Not Found', '找不到頁面']):
            return True
    except Exception:
        pass
    return False


def get_balance(page, selector: str):
    """讀取餘額（DOM selector 版本，已停用的舊 selector 邏輯可能失效，保留供 fallback）"""
    try:
        text = page.locator(selector).first.inner_text(timeout=2000)
        # 保留數字和小數點
        import re as _re
        cleaned = _re.sub(r'[^\d.]', '', text)
        return float(cleaned) if cleaned else None
    except Exception:
        return None


def read_balance(page):
    """從 pinus WebSocket 攔截讀取餘額（window.__lastCoin），掃描所有 frame。
    完整移植自 machine-test/runner.ts 的 readBalance() — 不再依賴 DOM selector（selector 常隨版更失效）。"""
    for frame in page.frames:
        try:
            coin = frame.evaluate("window.__lastCoin ?? null")
            if coin is not None:
                return coin
        except Exception:
            pass
    return None


def get_coin_updated_at(page) -> float:
    """讀取 window.__coinUpdatedAt（最近一次 pinus coin 更新的時間戳），掃描所有 frame。"""
    for frame in page.frames:
        try:
            ts = frame.evaluate("window.__coinUpdatedAt || 0")
            if ts:
                return ts
        except Exception:
            pass
    return 0


def get_last_spin_err(page):
    """讀取 window.__lastSpinErr（最近一次 dealGMActionReq spin 請求被伺服器拒絕的錯誤），
    掃描所有 frame。回傳 {errcode, errcodedes, ts} 或 None。"""
    for frame in page.frames:
        try:
            err = frame.evaluate("window.__lastSpinErr || null")
            if err:
                return err
        except Exception:
            pass
    return None


def read_errcode_counts(page) -> dict:
    """讀取 window.__spinErrCounts（各 errcode 累計次數，例如 {"100": 3}），掃描所有 frame，
    取有內容的那一份（跟 __lastSpinErr 同樣的多 frame 情境）。"""
    for frame in page.frames:
        try:
            counts = frame.evaluate("window.__spinErrCounts || null")
            if counts:
                return counts
        except Exception:
            pass
    return {}


def read_errcode_times(page) -> dict:
    """讀取 window.__spinErrTimes（各 errcode 最近 5 次發生時間，epoch ms），掃描所有 frame，
    取有內容的那一份。只給累計用，不做「本期間」切分——時間點列表沒辦法像次數一樣用相減
    算出區間差，直接呈現最近幾次的絕對時間即可。"""
    for frame in page.frames:
        try:
            times = frame.evaluate("window.__spinErrTimes || null")
            if times:
                return times
        except Exception:
            pass
    return {}


def read_recover_count(page) -> int:
    """讀取 window.__wsRecoverCount（pinus WebSocket 斷線後重新連上的累計次數），掃描所有 frame。"""
    for frame in page.frames:
        try:
            n = frame.evaluate("window.__wsRecoverCount || 0")
            if n:
                return int(n)
        except Exception:
            pass
    return 0


def poll_monitor_logs(page, mt: str):
    """取出（drain）window.__pinusLog + window.__consoleLog 中新累積的訊息並轉發到日誌。
    兩者合併成單一 evaluate（而不是各自掃一輪 frame），減少每次輪詢對 Playwright 的
    IPC 往返次數 —— 分開輪詢等於每 2 秒對同一個 frame 多打一次 evaluate，
    在遊戲畫面/動畫忙碌時 evaluate 排隊等待的時間會被放大，容易被誤以為是 Spin 變慢。

    ⚠️ 不能「找到有訊息的 frame 就 return 停止掃描其他 frame」——原本的假設是
    pinus/console 訊息一定同時出現在同一個 frame，但實際上大廳 frame 也會有自己的
    console.warn（跟遊戲 iframe 的 window.pinus 是不同 frame），只要大廳 frame 排在
    game iframe 前面被掃到、且剛好有 console 訊息（pinus 訊息是空的），原本的邏輯就會
    在抵達真正有 pinus 資料的 game iframe 之前提前 return，造成「console 有訊息、
    pinus log 永久是空的」——這正是先前誤以為是「重連後遺失補丁」的真正根因（重連補丁
    修正本身沒錯，但沒解決這個更早發生、範圍更廣的 frame 掃描 bug）。改成掃完所有
    frame、每個 frame 各自的訊息都轉發，不再提前中斷。

    ⚠️ 掃完所有 frame 之後緊接著發現的新問題：`page.frames` 在某些時刻（推測是
    navigation/reload 過渡期間，例如熱更新切換 connector 時遊戲 iframe 重新載入）
    會把同一個實際頁面同時列出兩份 frame 物件，導致同一批 pinus/console 訊息被
    drain 兩次、每一行都印出兩次一模一樣的內容。用 frame.url 去重——同一輪
    poll_monitor_logs() 呼叫內，URL 相同的 frame 只處理第一個，避免這種情況下
    的重複轉發（真正不同的 frame 本來就有不同 URL，不會被誤過濾掉）。"""
    seen_urls: set = set()
    for frame in page.frames:
        try:
            frame_url = frame.url
            if frame_url and frame_url in seen_urls:
                continue
            if frame_url:
                seen_urls.add(frame_url)
        except Exception:
            pass
        try:
            result = frame.evaluate("""() => {
                var p = window.__pinusLog || []; window.__pinusLog = [];
                var c = window.__consoleLog || []; window.__consoleLog = [];
                return { pinus: p, console: c };
            }""")
        except Exception:
            continue
        pinus_entries = result.get('pinus') or []
        console_entries = result.get('console') or []
        if not pinus_entries and not console_entries:
            continue
        for e in pinus_entries:
            direction = e.get('dir', '')
            route = e.get('route', '')
            data = e.get('data', '')
            log(f"[{mt}][pinus:{direction}] {route} {data}")
            # 熱更新（center update）連線切換偵測——serverUpdateNtc 是遊戲收到後台
            # 通知「換一個 connector」時推播的 pinus push，本身就帶新的 host/port 等
            # 結構化資料。除了併入上面一般的 [pinus:push] 那行，額外補一行明顯標記，
            # 不用特地展開 pinus 分類篩選（預設全部收合）就能一眼看到熱更新切換時機。
            if route == 'serverUpdateNtc':
                log(f"[{mt}] ⚡ 偵測到熱更新（center update）連線切換：{data}")
        for e in console_entries:
            level = e.get('level', 'warn')
            text = e.get('text', '')
            log(f"[{mt}][console:{level}] {text}")


def fetch_and_post_pinus_records(page, machine_type: str):
    """透過 window.pinus.request 取得歷史戰績並上傳到伺服器"""
    try:
        # ⚠️ uid 原本取自 `window._uid || window.pinus.uid`——**這個遊戲兩個都沒有**，
        #    所以永遠是空字串，送出去每次都被伺服器回 errcode 15「參數錯誤」。
        #    實測（BULLBLITZ，2026-09-03）：整個 session 打了 10 次 historyListReq、
        #    10 次全失敗、`reconcile_front_records` 一筆都沒有，而三路對帳因此
        #    111 筆全部顯示「缺資料」。真正的 uid 在登入回應裡，由 pinus 補丁記進
        #    `window.__pinusUid`（只認 loginReq 的回應，見上方註解）。
        uid = page.evaluate("window.__pinusUid || window._uid || (window.pinus && window.pinus.uid) || ''")
        if not uid:
            # 取不到就不要送——照送空字串只是每 20 次 spin 打一個註定失敗的請求，
            # 污染日誌也污染伺服器，真正的錯誤還是被淹掉（CodeX review）。
            # 節流：同一台機台每 10 次才印一次，不然它本身會變成洗版來源。
            mp_skip = pinus_uid_skip_count.get(machine_type, 0) + 1
            pinus_uid_skip_count[machine_type] = mp_skip
            if mp_skip == 1 or mp_skip % 10 == 0:
                log(f"[{machine_type}] 略過戰績紀錄：還沒取得 uid（第 {mp_skip} 次；uid 由登入回應提供，重連後才會再出現）")
            return
        result = page.evaluate("""(uid) => new Promise((resolve) => {
            var p = window.pinus;
            if (!p || typeof p.request !== 'function') { resolve({err: 'no_pinus'}); return; }
            p.request('status.statusHandler.historyListReq',
                {uid: uid, pageindex: 0, pagecount: 15},
                function(res) { resolve({res: res}); }
            );
        })""", uid)
        if result.get('err') == 'no_pinus':
            return
        res = result.get('res') or {}
        # ⚠️ 非 0 的 errcode **一定要印出來**。原本錯誤回應沒有 `list`，就直接落到
        #    `if not records: return` 靜默結束——這次的問題本來一分鐘就該看出來，
        #    是這個靜默 return 把訊號整個吃掉，拖了十天沒人發現（CodeX review）。
        errcode = res.get('errcode')
        if isinstance(errcode, (int, float)) and errcode != 0:
            log(f"[{machine_type}] 戰績紀錄查詢失敗：historyListReq errcode={errcode} "
                f"{res.get('errcodedes', '')}（uid={uid}）")
            return
        records = res.get('list') or []
        if not records:
            return
        normalized = []
        for r in records:
            normalized.append({
                'gmid': str(r.get('gmid', '') or ''),
                'gameid': str(r.get('gameid', '') or ''),
                'orderId': str(r.get('order_id', '') or ''),
                'bet': float(r.get('bet', 0) or 0),
                'win': float(r.get('win', 0) or 0),
                'recordTime': str(r.get('time', '') or ''),
            })
        requests.post(
            f"{server_url}/api/autospin/agent/{session_id}/game-record",
            json={'machineType': machine_type, 'records': normalized},
            timeout=10,
        )
        log(f"[{machine_type}] 上傳 {len(normalized)} 筆戰績紀錄")
    except Exception as e:
        log(f"[{machine_type}] 戰績紀錄上傳失敗: {e}")


def send_lark(webhook: str, title: str, content: str):
    """發送 Lark 推播通知"""
    if not webhook:
        return
    try:
        requests.post(webhook, json={
            "msg_type": "text",
            "content": {"text": f"[AutoSpin] {title}\n{content}"}
        }, timeout=10)
    except Exception as e:
        log(f"[Lark] 推播失敗: {e}")


# ─── 模板下載與比對 ───────────────────────────────────────────────────────────

_template_dir = os.path.join(tempfile.gettempdir(), 'toppath_templates')
_templates_loaded = False

def load_templates():
    """從 server 下載所有模板圖片到本地暫存目錄"""
    global _templates_loaded
    if _templates_loaded:
        return
    if not OPENCV_AVAILABLE:
        log("[Template] OpenCV 未安裝（pip install opencv-python），模板比對已停用")
        _templates_loaded = True
        return
    try:
        r = requests.get(f"{server_url}/api/autospin/templates", timeout=10)
        files = r.json().get('files', [])
        if not files:
            _templates_loaded = True
            return
        os.makedirs(_template_dir, exist_ok=True)
        for f in files:
            name = f['name']
            dest = os.path.join(_template_dir, name)
            if not os.path.exists(dest):
                img_r = requests.get(f"{server_url}/api/autospin/template-img/{name}", timeout=15)
                if img_r.ok:
                    with open(dest, 'wb') as fh:
                        fh.write(img_r.content)
        log(f"[Template] 已載入 {len(files)} 個模板")
    except Exception as e:
        log(f"[Template] 載入失敗: {e}")
    _templates_loaded = True


def match_templates(screenshot_bytes: bytes, template_type: str, threshold: float = 0.7):
    """比對截圖與模板，回傳 (matched_filename, confidence) 或 None"""
    if not OPENCV_AVAILABLE or not template_type:
        return None
    try:
        nparr = _np.frombuffer(screenshot_bytes, _np.uint8)
        img = _cv2.imdecode(nparr, _cv2.IMREAD_COLOR)
        if img is None:
            return None
        ih, iw = img.shape[:2]
        best = None
        for fname in os.listdir(_template_dir):
            if template_type.upper() not in fname.upper():
                continue
            tpl_path = os.path.join(_template_dir, fname)
            tpl = _cv2.imread(tpl_path)
            if tpl is None:
                continue
            th, tw = tpl.shape[:2]
            if th > ih or tw > iw:
                continue
            result = _cv2.matchTemplate(img, tpl, _cv2.TM_CCOEFF_NORMED)
            _, max_val, _, _ = _cv2.minMaxLoc(result)
            if max_val >= threshold and (best is None or max_val > best[1]):
                best = (fname, max_val)
        return best
    except Exception:
        return None


# Spin 按鈕 selector fallback chain — 完整移植自 machine-test/runner.ts 的 spinSelectors
SPIN_SELECTORS_DEFAULT = [
    '.my-button.btn_spin',
    '.btn_spin .my-button',   # special games（BULLBLITZ、ALLABOARD 等）：inner clickable element
    '.btn_spin',
    '[class*="btn_spin"] .my-button',
    '[class*="btn_spin"]',
    'button[class*="spin"]',
    '[class*="spin-btn"]',
]


def find_spin_button(page, custom_sel: str = ''):
    """依序嘗試 selector 清單找到可見的 Spin 按鈕，回傳 (selector, element) 或 (None, None)。"""
    selectors = ([custom_sel] if custom_sel else []) + SPIN_SELECTORS_DEFAULT
    for sel in selectors:
        try:
            elems = page.locator(sel).all()
            for el in elems:
                if el.is_visible():
                    return sel, el
        except Exception:
            continue
    return None, None


def do_spin(page, cfg: dict):
    """執行一次 Spin。點擊邏輯：
    找按鈕（selector fallback chain）→ 確認未 disabled → native click
    → 若被上層（選面額面板等）攔截，改用 JS click 直接點下層 Spin 按鈕本身
      （el.click()，跟 Join 按鈕同一招，不做真實滑鼠座標點擊，不會誤點到蓋在上面的那層）
    → 等待動畫完成，最多 8 秒。
    完成判定取兩個訊號中先到者：① 按鈕 disabled→enabled（部分機台適用）
    ② pinus 推播新的 coin 更新（moneyNtc reason=end，各機台都適用，且通常比按鈕狀態更快更準）。
    有些機台的 Spin 按鈕動畫全程不會切換 disabled/class（例如 RISINGROCKETS），
    只靠①偵測時，每次 Spin 都會固定卡滿 8 秒才返回，AutoSpin 連續跑很多輪時等於被拖慢 8 倍以上。

    回傳：失敗回傳 None；成功回傳
    (balance_before, balance_after, rejected, outcome, coin_ts_at_click) 這個 5-tuple。
    最後一個是「按下去當下 window.__coinUpdatedAt 的值」，給 outcome='unknown' 時
    回頭補判用（見 reclassify_pending_unknown）。
    balance_before/after 其中一個或兩個都可能是 None，代表當下讀不到餘額；
    rejected 代表這次 Spin 被遊戲伺服器明確拒絕（例如 errcode:100）。

    outcome 是「這一下到底有沒有跑成一局」的分類，取自結束訊號（跟 CodeX 討論定案）：

      'completed'    coin_update —— 有 moneyNtc 結算，**確定完成一局**
      'suspected'    button_disabled_toggle —— 按鈕進入 spinning 又離開，
                     代表前端認定跑過一局，**但缺結算證據**
      'unknown'      timeout_8s —— 什麼訊號都沒收到，不代表沒跑
                     （下一次 spin 前可能被補判成 'completed_late'，見
                      reclassify_pending_unknown）
      'not_started'  spin_rejected —— 伺服器明確拒絕，確定沒起

    ⚠️ 'suspected' 不能跟 'not_started' 併成一類。前者有「disabled → enabled」的狀態
       轉換證據（局跑過了），後者是根本沒起，兩者相反；併起來會低估局數。
       而且 suspected 變多本身就是訊號——那代表 moneyNtc 收不到，
       正是熱更新後 pinus 補丁失效的典型症狀（v3.90.x 那批問題）。"""
    spin_sel_cfg = cfg.get('spinSelector') or ''
    mt = cfg.get('machineType', '')

    # Spin 按鈕若被「選面額遮罩」或「Jackpot 中獎通知彈窗」蓋住，先點掉再找 Spin 按鈕——
    # 這兩種疊層點擊都不會拋例外，只是遊戲完全沒反應，所以要主動偵測，不能只靠 native click
    # 失敗時的例外處理。
    dismiss_denom_overlay(page, mt)
    dismiss_jackpot_notification(page, mt)

    sel, btn = find_spin_button(page, spin_sel_cfg)
    if not btn:
        # Fallback：找不到任何已知 selector 時，點擊 canvas 右下角（AutoSpin 既有保底方案）
        try:
            box = page.locator('canvas').bounding_box()
            if box:
                page.mouse.click(box['x'] + box['width'] * 0.85,
                                 box['y'] + box['height'] * 0.85)
                return (None, None, False)
        except Exception:
            pass
        return None

    try:
        if btn.evaluate("el => el.disabled || el.classList.contains('disabled')"):
            return None
    except Exception:
        pass

    balance_before = read_balance(page)
    updated_at_before = get_coin_updated_at(page)
    click_start = time.time()

    # 清掉上一次殘留的錯誤紀錄，避免誤判成這次 Spin 剛發生的拒絕
    for frame in page.frames:
        try:
            frame.evaluate("window.__lastSpinErr = null")
        except Exception:
            pass

    try:
        btn.click(timeout=5000)
    except Exception as e:
        if 'intercepts pointer events' in str(e) or 'Timeout' in str(e):
            # 上層有東西擋住（選面額面板、宣傳彈窗等）：不用真實滑鼠座標硬點（可能點到上層），
            # 改用 JS 直接呼叫按鈕本身的 click()，略過上層直接觸發下層 Spin。
            try:
                btn.evaluate("el => el.click()")
            except Exception:
                return None
        else:
            return None

    # 等待動畫完成，最多等 8 秒；按鈕 disabled→enabled、pinus coin 更新、或伺服器明確拒絕，先到者為準
    deadline = time.time() + 8
    spin_started = False
    rejected = False
    exit_reason = 'timeout_8s（兩個訊號都沒偵測到，等滿上限）'
    while time.time() < deadline:
        time.sleep(0.3)
        try:
            dis = btn.evaluate("el => el.disabled || el.classList.contains('disabled')")
            if dis and not spin_started:
                spin_started = True
            if spin_started and not dis:
                exit_reason = 'button_disabled_toggle'
                break
        except Exception:
            pass
        try:
            if get_coin_updated_at(page) > updated_at_before:
                exit_reason = 'coin_update（moneyNtc end，遊戲已結算）'
                break
        except Exception:
            pass
        try:
            err = get_last_spin_err(page)
            if err:
                rejected = True
                exit_reason = f"spin_rejected（伺服器拒絕，errcode:{err.get('errcode')} {err.get('errcodedes', '')}）"
                break
        except Exception:
            pass

    balance_after = read_balance(page)
    duration = time.time() - click_start
    if rejected:
        log(f"[{mt}] ⚠️ Spin 被伺服器拒絕，耗時 {duration:.1f}s（{exit_reason}）")
    else:
        log(f"[{mt}] Spin 耗時 {duration:.1f}s（訊號：{exit_reason}）")

    # 「按了幾次」不等於「跑了幾局」——實體機台上按 SPIN 可能落在動畫中或 FG/JP，
    # 那一下不會起局。這裡把結束訊號翻譯成局的狀態，報告才分得開這兩件事。
    if exit_reason.startswith('coin_update'):
        outcome = 'completed'
    elif exit_reason.startswith('button_disabled_toggle'):
        outcome = 'suspected'
    elif exit_reason.startswith('spin_rejected'):
        outcome = 'not_started'
    else:
        outcome = 'unknown'

    return (balance_before, balance_after, rejected, outcome, updated_at_before)


# 補判的時間上限。超過就不補——中間若卡過 FG/JP 等待（最長 15 分鐘），
# 那段一定有派彩造成的 coin 更新，拿它來補判會把派彩誤記成上一局的結算。
RECLASSIFY_MAX_GAP_SEC = 30.0


def reclassify_pending_unknown(page, mp, mt: str = '') -> bool:
    """把上一次判成 unknown、但之後才觀察到 coin 更新的那一筆改記成 completed_late。

    ⚠️ **一定要在按下這次 spin「之前」呼叫。**這一次的結算會把 __coinUpdatedAt
       往前推，補判就分不出那是上一局晚到、還是這一局剛結算。
       這個呼叫時機同時也讓 CodeX 提的 `coinUpdatedAt <= nextSpinStartAt` 自動成立
       ——還沒點下去，讀到的值必然早於下一次 spin 的起點。

    ⚠️ **只補上一筆，不做待判佇列**（跟 CodeX 討論定案）。
       `__coinUpdatedAt` 是「任何一則帶 coin 欄位的 pinus 訊息」都會更新，
       route 跟 reason 都沒過濾，所以一次 coin 更新**無法歸屬到特定某一局**。
       連續多筆 unknown 時拿一次更新去分配，只會做出更精緻的錯覺。
       而且不會因此漏判——補判點是「每次 spin 前檢查上一筆」，
       A、B 連續 unknown 時 B 之前檢查 A、C 之前檢查 B，每一筆各有一次機會。

    ⚠️ 這只證明「spin 之後、下一次 spin 之前曾經有 coin 更新」，
       **證據等級低於 8 秒內收到的結算**，所以歸成獨立的 completed_late，
       不能併進 completed（併進去等於把確定訊號換成混合訊號）。
    """
    pending = mp.get('pending_unknown')
    if not pending:
        return False
    mp['pending_unknown'] = None   # 一筆只有一次機會

    gap = time.time() - pending['at']
    if gap > RECLASSIFY_MAX_GAP_SEC:
        return False
    try:
        now_coin_ts = get_coin_updated_at(page)
    except Exception:
        return False
    if now_coin_ts <= pending['coinTs']:
        return False

    counts = mp.setdefault('outcome_counts', {})
    if counts.get('unknown', 0) <= 0:
        return False
    counts['unknown'] -= 1
    counts['completed_late'] = counts.get('completed_late', 0) + 1
    # reason 留在 log 裡，之後看測試資料才追得回來是哪一條規則命中的（CodeX 建議）
    log(f"[{mt}] 上一次 spin 補判為「延遲推定完成」"
        f"（late_coin_update_within_{int(RECLASSIFY_MAX_GAP_SEC)}s，逾時後 {gap:.1f}s 才見到 coin 更新）")
    return True


def execute_bonus_action(page, cfg: dict, mt: str, spin_sel_cfg: str):
    """執行機種設定檔裡指定的 bonusAction 一次（spin/takewin/touchscreen），auto_wait 則不做任何事。
    完整移植自 machine-test/runner.ts 的 waitForNormalStatus() 第一步。"""
    bonus_action = cfg.get('bonusAction') or 'auto_wait'
    if bonus_action == 'auto_wait':
        return
    try:
        if bonus_action == 'spin':
            _, btn = find_spin_button(page, spin_sel_cfg)
            if btn:
                try:
                    btn.click(timeout=3000)
                except Exception:
                    try:
                        btn.evaluate("el => el.click()")
                    except Exception:
                        pass
            log(f"[{mt}]（執行特殊流程：Spin）")
        elif bonus_action == 'takewin':
            try:
                btn = page.locator('.btn_takewin, [class*="takewin"], [class*="take-win"], [class*="take_win"]').first
                if btn.is_visible():
                    btn.click(timeout=3000)
            except Exception:
                pass
            log(f"[{mt}]（執行特殊流程：TakeWin）")
        elif bonus_action == 'touchscreen':
            pts = cfg.get('touchPoints') or []
            for pt in pts:
                elem = wait_for_span_text(page, pt, 3000)
                if elem:
                    try:
                        elem.evaluate("el => el.click()")
                        log(f'[{mt}]（觸屏點擊: "{pt}"）')
                    except Exception:
                        pass
                else:
                    log(f'[{mt}]（找不到觸屏元素: "{pt}"，略過）')
                time.sleep(0.8)
            if cfg.get('clickTake'):
                try:
                    btn = page.locator('.my-button.btn_take, .btn_take').first
                    if btn.is_visible():
                        btn.click(timeout=3000)
                        log(f"[{mt}]（點擊 Take）")
                except Exception:
                    pass
            if pts:
                log(f"[{mt}]（特殊流程觸屏完成: {' → '.join(pts)}）")
    except Exception:
        pass
    time.sleep(1.0)


def poll_daily_analysis_log(mt: str, gmid: str, env: str):
    """輪詢 Machine Log API（daily-analysis），把遊玩期間新出現的日誌印到執行日誌。
    完整移植自 machine-test/runner.ts 的 daily-analysis 查詢方式（同一個 API、同一套 gmid+date 參數），
    只是這裡改成背景執行緒定期輪詢並印出「新增」的紀錄，而不是等某個動作再去確認。
    第一次輪詢只記錄基準時間、不印東西，避免把今天已經發生過的歷史紀錄整批倒出來洗版。"""
    if not gmid:
        return
    base = DAILY_ANALYSIS_URLS.get(env, DAILY_ANALYSIS_URLS['qat'])
    now = datetime.now()
    today = now.strftime('%Y-%m-%d')
    now_time = now.strftime('%H:%M:%S')

    with daily_log_lock:
        state = daily_log_state.get(mt)
        if state is None or state.get('date') != today:
            daily_log_state[mt] = {'date': today, 'last_time': now_time, 'last_err_log': 0.0}
            return
        last_time = state['last_time']
        last_err_log = state.get('last_err_log', 0.0)

    # 查詢失敗（網路不通/逾時/非 200）不會整個吞掉不出聲——這台 Agent 所在網路如果連不到
    # {qat|prod}-osmtrace.osmslot.org，靠使用者自己發現「怎麼一直沒有印東西」會很難排查，
    # 所以失敗時至少每 60 秒印一次警告（避免同一個錯誤每 5 秒洗一次版）。
    try:
        resp = requests.get(base, params={'gmid': gmid, 'date': today}, timeout=8)
        if resp.status_code != 200:
            if time.time() - last_err_log >= 60:
                with daily_log_lock:
                    daily_log_state[mt]['last_err_log'] = time.time()
                log(f"[{mt}][daily-analysis] ⚠️ API 回應非 200（狀態碼 {resp.status_code}），略過這次輪詢")
            return
        timeline = ((resp.json() or {}).get('data') or {}).get('timeline') or []
    except Exception as e:
        if time.time() - last_err_log >= 60:
            with daily_log_lock:
                daily_log_state[mt]['last_err_log'] = time.time()
            log(f"[{mt}][daily-analysis] ⚠️ 查詢失敗：{e}（可能是這台 Agent 所在網路連不到 {base}，例如需要 VPN/白名單）")
        return

    new_entries = sorted(
        (e for e in timeline if isinstance(e, dict) and e.get('time', '') > last_time),
        key=lambda e: e.get('time', ''),
    )
    if not new_entries:
        return

    with daily_log_lock:
        daily_log_state[mt]['last_time'] = new_entries[-1].get('time', last_time)

    for e in new_entries:
        try:
            data_str = json.dumps(e.get('data'), ensure_ascii=False)
        except Exception:
            data_str = str(e.get('data'))
        if len(data_str) > 300:
            data_str = data_str[:300] + '…'
        log(f"[{mt}][daily-analysis] {e.get('time', '')} {e.get('type', '')} {data_str}")

        if e.get('type') == 'success_json':
            track_button_health(mt, e.get('data') if isinstance(e.get('data'), dict) else {})


def track_button_health(mt: str, data: dict):
    """解析 daily-analysis 的 success_json 事件，追蹤 iDeck/觸屏按鈕的健康度。
    error==0 代表這次按鈕指令有被硬體/遊戲端正確處理；非 0 代表真的有異常，立即印警告
    （附上 cmd，方便定位是哪一顆按鈕/座標）。累積到一定次數印一次整體摘要，不逐行洗版。"""
    is_ideck = bool(data.get('is_ideck'))
    is_touch = bool(data.get('is_touch'))
    if not is_ideck and not is_touch:
        return  # 不是按鈕確認事件（例如純粹的畫面/連線類 success_json），不計入
    error = data.get('error', 0)
    cmd = data.get('cmd', '')
    kind = 'ideck' if is_ideck else 'touch'

    with button_health_lock:
        h = button_health.setdefault(mt, {'ideck_ok': 0, 'ideck_err': 0, 'touch_ok': 0, 'touch_err': 0, 'since_summary': 0,
                                           'no_response': 0, 'gap_flagged': False, 'last_event_ts': 0.0})
        if error == 0:
            h[f'{kind}_ok'] += 1
        else:
            h[f'{kind}_err'] += 1
        h['since_summary'] += 1
        h['last_event_ts'] = time.time()
        h['gap_flagged'] = False  # 有新事件進來，之前偵測到的「無回應」空窗結束
        due_summary = h['since_summary'] >= BUTTON_SUMMARY_EVERY
        if due_summary:
            h['since_summary'] = 0
        snapshot = dict(h)

    if error != 0:
        log(f"[{mt}] ⚠️ 按鈕異常（{'iDeck' if is_ideck else '觸屏'}）cmd={cmd} error={error}")
    if due_summary:
        log(f"[{mt}] 按鈕健康度：iDeck {snapshot['ideck_ok']}/{snapshot['ideck_ok']+snapshot['ideck_err']} 正常，"
            f"觸屏 {snapshot['touch_ok']}/{snapshot['touch_ok']+snapshot['touch_err']} 正常")


# ── errcode 現場快照 ──────────────────────────────────────────────────────────
# 為什麼要這個：定時彙總報告原本只有「errcode + 次數 + 最近幾次時間」，
# 開發問「對玩家有什麼影響」時答不出來。但影響資料當下其實已經抓到了——
# `get_last_spin_err()` 有 errcodedes、`do_spin()` 有 balance_before/after——
# 只是沒被綁在一起帶進報告。這裡就是把它們綁起來。
#
# 最關鍵的欄位是 deducted（餘額有沒有被扣但這局沒轉成）。它把錯誤分成三種
# 完全不同的嚴重度，而原本的計數器分不出來：
#   扣了、沒轉成 → 玩家真的損失，要升級查帳
#   沒扣、沒轉成 → 只是按了沒反應，重按就好
#   扣了、也轉成 → 那個 errcode 其實無害，是雜訊
ERR_SNAPSHOT_KEEP = 300      # 本機最多留幾筆完整快照（Discord 上只出統計結論，不塞明細）
RECONCILE_GAP_SEC = 30.0     # 超過這麼久沒有成功 spin，就算「不只是單局失敗」，標記需要查帳


def record_err_snapshot(page, mp: dict, balance_before, balance_after):
    """spin 被伺服器拒絕時，記一筆現場快照。

    ⚠️ errcode 是從 `window.__lastSpinErr` 讀的，那是「最近一次」而不是
       「這一次」。緊接在拒絕後讀通常就是對的那筆，但如果同一輪內連續多次
       拒絕、而中間沒有機會讀取，可能會拿到後面那個。這裡接受這個誤差——
       要精準對應得改 do_spin 的回傳值，那會動到它的簽章與四個呼叫點。"""
    err = get_last_spin_err(page) or {}
    now = time.time()
    last_ok = mp.get('last_ok_spin_ts')
    unknown = balance_before is None or balance_after is None
    deducted = (not unknown) and balance_after < balance_before
    stalled = last_ok is not None and (now - last_ok) > RECONCILE_GAP_SEC

    snap = {
        'ts': int(now * 1000),
        'errcode': str(err.get('errcode', '')),
        'errcodedes': (err.get('errcodedes') or '')[:120],
        'balanceBefore': balance_before,
        'balanceAfter': balance_after,
        'deducted': deducted,
        'balanceUnknown': unknown,
        'recoverSec': None,          # 等下一次成功 spin 才填得出來
        # CodeX 的「異常升級」設計：不是每筆都去查帳，只有這三種才標記。
        # 熱更新期間本來就會有一堆預期內的錯誤，全部打成查帳事件等於沒有訊號。
        'needsReconcile': bool(deducted or unknown or stalled),
    }
    buf = mp.setdefault('err_snapshots', [])
    buf.append(snap)
    if len(buf) > ERR_SNAPSHOT_KEEP:
        del buf[:-ERR_SNAPSHOT_KEEP]
    return snap


def mark_spin_recovered(mp: dict):
    """成功 spin 之後回填「從錯誤到恢復花了幾秒」。

    往回找還沒填 recoverSec 的快照——它們就是這次成功之前積著的那批。
    這個數字是熱更新測試真正要回報的東西之一：不是「錯了幾次」，
    而是「服務多久才恢復」。"""
    now = time.time()
    for snap in reversed(mp.get('err_snapshots', [])):
        if snap.get('recoverSec') is not None:
            break
        snap['recoverSec'] = round(now - snap['ts'] / 1000.0, 1)
    mp['last_ok_spin_ts'] = now


def summarize_err_snapshots(snaps: list) -> dict:
    """把快照收斂成「每個 errcode 一行結論」，這是要送上 Discord 的形狀。

    Discord 上不塞明細（訊息會爆），只出統計結論：
    發生幾次、其中幾次有扣款疑慮、最長多久才恢復、伺服器最後怎麼解釋。"""
    out = {}
    for snap in snaps:
        key = snap.get('errcode') or '?'
        row = out.setdefault(key, {
            'count': 0, 'deducted': 0, 'unknown': 0,
            'needsReconcile': 0, 'maxRecoverSec': None, 'lastDes': '',
        })
        row['count'] += 1
        if snap.get('deducted'):
            row['deducted'] += 1
        if snap.get('balanceUnknown'):
            row['unknown'] += 1
        if snap.get('needsReconcile'):
            row['needsReconcile'] += 1
        rec = snap.get('recoverSec')
        if rec is not None and (row['maxRecoverSec'] is None or rec > row['maxRecoverSec']):
            row['maxRecoverSec'] = rec
        if snap.get('errcodedes'):
            row['lastDes'] = snap['errcodedes']
    return out


CR_NO_RESPONSE_TIMEOUT = 60.0  # 秒；被動觀察，超過這麼久沒有新的 daily-analysis 按鈕健康度事件就算一次「無回應」

def check_cr_gap(mt: str):
    """被動偵測 CR checks（daily-analysis 的 success_json 按鈕健康度事件）多久沒有新事件——完全不主動
    點擊任何東西，純粹觀察正常 Spin 過程中本來就會觸發的事件多久沒出現一次，超過門檻算一次「無回應」。
    每個空窗只算一次（靠 gap_flagged 避免同一段空窗被重複計數），有新事件進來才會重置。"""
    with button_health_lock:
        h = button_health.get(mt)
        if not h or not h.get('last_event_ts'):
            return
        gap = time.time() - h['last_event_ts']
        if gap >= CR_NO_RESPONSE_TIMEOUT and not h.get('gap_flagged', False):
            h['gap_flagged'] = True
            h['no_response'] = h.get('no_response', 0) + 1
            log(f"[{mt}] ⚠️ CR 無回應：已 {gap:.0f} 秒沒有收到按鈕健康度確認事件")


def maybe_send_status_report(mp: dict, page):
    """定時彙總報告：累計 + 本期間（距上次報告）兩組統計。
    間隔/開關由伺服器（should-stop 心跳）即時控制，不用重啟 Agent 就能調整。
    這裡只做「判斷是否該送 + 讀 page 上的統計資料」（必須留在主執行緒，Playwright 頁面操作
    不能跨執行緒呼叫），實際 POST 網路請求丟給 async_call() 背景執行，不卡主 Spin 迴圈。"""
    mt = mp['config']['machineType']
    now = time.time()
    last_sent = mp.get('report_last_sent_ts', AGENT_START_TS)
    with status_report_lock:
        enabled, interval_min = status_report_enabled, status_report_interval_min
    if not enabled or now - last_sent < interval_min * 60:
        return

    errcode_counts = read_errcode_counts(page)
    errcode_times = read_errcode_times(page)
    recover_count = read_recover_count(page)
    with button_health_lock:
        h = button_health.get(mt, {})
        cr_checks = h.get('ideck_ok', 0) + h.get('ideck_err', 0) + h.get('touch_ok', 0) + h.get('touch_err', 0)
        cr_no_response = h.get('no_response', 0)

    cumulative = {
        'spinCount': mp.get('spin_count', 0), 'okSpinCount': mp.get('ok_spin_count', 0),
        'winCount': mp.get('win_count', 0), 'totalWin': mp.get('total_win', 0.0),
        'lastCoin': mp.get('last_balance'),
        'errcodeCounts': errcode_counts, 'errcodeTimes': errcode_times,
        'recoverCount': recover_count, 'kickoutCount': mp.get('kickout_count', 0),
        'crChecks': cr_checks, 'crNoResponse': cr_no_response,
        # 每個 errcode 的「影響」結論（扣款疑慮/最長恢復/伺服器描述），
        # 這是報告能回答「對玩家有什麼影響」的關鍵欄位
        'errImpact': summarize_err_snapshots(mp.get('err_snapshots', [])),
        # 局數分類。spinCount 是按鈕嘗試次數，這裡才是「跑了幾局」。
        # 兩者分開之後，原本的 ok%（非拒絕比例）就沒有意義了，報告已拿掉——
        # 一個百分比蓋不住四種狀態，而且「ok」聽起來像品質判定，
        # 但它其實只是結束原因（跟 CodeX 討論定案）。
        'outcomeCounts': dict(mp.get('outcome_counts', {})),
    }
    baseline = mp.get('report_period_start')
    if baseline is None:
        # 第一次報告：本期間 = 從 Agent 啟動到現在（累計本身就是本期間）
        period = dict(cumulative)
        period_minutes = (now - AGENT_START_TS) / 60
    else:
        base_errcodes = baseline.get('errcodeCounts', {})
        period_errcodes = {k: cumulative['errcodeCounts'].get(k, 0) - base_errcodes.get(k, 0) for k in cumulative['errcodeCounts']}
        period = {
            'spinCount': cumulative['spinCount'] - baseline['spinCount'],
            'okSpinCount': cumulative['okSpinCount'] - baseline['okSpinCount'],
            'winCount': cumulative['winCount'] - baseline['winCount'],
            'totalWin': cumulative['totalWin'] - baseline['totalWin'],
            'lastCoin': cumulative['lastCoin'],
            'errcodeCounts': period_errcodes,
            'recoverCount': cumulative['recoverCount'] - baseline['recoverCount'],
            'kickoutCount': cumulative['kickoutCount'] - baseline['kickoutCount'],
            'crChecks': cumulative['crChecks'] - baseline['crChecks'],
            'crNoResponse': cumulative['crNoResponse'] - baseline['crNoResponse'],
            # 本期間的快照 = 時間戳晚於上次送出的那些。不像次數可以相減，
            # 快照要靠時間過濾才切得出區間
            'errImpact': summarize_err_snapshots(
                [x for x in mp.get('err_snapshots', []) if x['ts'] / 1000.0 >= last_sent]),
            'outcomeCounts': {
                k: v - baseline.get('outcomeCounts', {}).get(k, 0)
                for k, v in cumulative['outcomeCounts'].items()
            },
        }
        period_minutes = (now - last_sent) / 60

    mp['report_last_sent_ts'] = now
    mp['report_period_start'] = cumulative
    gmid = mp['config'].get('gameTitleCode') or ''
    async_call(post_status_report, mt, gmid, period_minutes, cumulative, period, (now - AGENT_START_TS) / 60)


def post_status_report(mt: str, gmid: str, period_minutes: float, cumulative: dict, period: dict, uptime_minutes: float):
    """背景執行緒：把 maybe_send_status_report() 準備好的統計資料 POST 給伺服器（純網路呼叫，
    不碰 Playwright page，可以安全地跑在背景執行緒）。"""
    try:
        requests.post(
            f"{server_url}/api/autospin/agent/{session_id}/status-report",
            json={
                'machineType': mt, 'gameTitleCode': gmid, 'periodMinutes': period_minutes,
                'cumulative': cumulative, 'period': period, 'uptimeMinutes': uptime_minutes,
            },
            timeout=10,
        )
        log(f"[{mt}] 已送出定時彙總報告（本期間約 {period_minutes:.1f} 分鐘）")
    except Exception as e:
        log(f"[{mt}] ⚠️ 定時彙總報告送出失敗：{e}")


def wait_for_normal_osm_status(gmid: str, page, cfg: dict, mt: str, heartbeats=None) -> bool:
    """偵測到 OSMWatcher 回報特殊狀態時：執行一次 bonusAction，然後持續 Spin 直到狀態恢復正常
    （或 15 分鐘逾時），狀態恢復後再 10 秒 cooldown spin。
    完整移植自 machine-test/runner.ts 的 waitForNormalStatus()（只讀取同一份 osmMachineStatus
    資料源，未修改 Machine Test 本身程式碼）。
    回傳 True 代表有處理過特殊狀態，False 代表沒有（正常/未連線/Handpay 沒有 gmid 對應資料）。
    這裡面的兩個 while 迴圈最長各自可以跑到 15 分鐘/10 秒，比 machine_worker() 外層迴圈一次
    迭代正常耗時長非常多——heartbeats（若有提供）要在這裡也持續更新，不然自動重啟監控會把
    「正在正常等特殊遊戲結束」誤判成「process 卡死」而白白重啟一台其實沒問題的機台。"""
    with osm_status_lock:
        current = osm_status_cache.get(gmid)
    if current is None or current == 0:
        return False  # 未連線 OSMWatcher，或狀態正常 — 靜默跳過，呼叫方會用相容 fallback 判斷
    if current == 9:
        log(f"[{mt}] ⚠️ Handpay 狀態（需人工處理），跳過等待")
        return True

    label = OSM_STATUS_LABELS.get(current, f'狀態 {current}')
    bonus_action = cfg.get('bonusAction') or 'auto_wait'
    spin_sel_cfg = cfg.get('spinSelector') or ''
    log(f"[{mt}] 偵測到特殊狀態：{label}，動作：{bonus_action}")

    start = time.time()
    max_wait = 15 * 60  # 15 分鐘逾時

    execute_bonus_action(page, cfg, mt, spin_sel_cfg)

    last_spin_at = 0.0
    while time.time() - start < max_wait:
        time.sleep(1.0)
        if heartbeats is not None:
            heartbeats[mt] = time.time()
        with osm_status_lock:
            s = osm_status_cache.get(gmid, 0)
        if s not in BONUS_STATUSES:
            waited = time.time() - start
            log(f"[{mt}] 特殊狀態結束，耗時 {waited:.0f}s，繼續 Spin 10 秒 cooldown...")
            cooldown_end = time.time() + 10
            while time.time() < cooldown_end:
                time.sleep(1.0)
                if heartbeats is not None:
                    heartbeats[mt] = time.time()
                if bonus_action != 'auto_wait':
                    _, btn = find_spin_button(page, spin_sel_cfg)
                    if btn:
                        try:
                            btn.click(timeout=2000)
                        except Exception:
                            pass
                    log(f"[{mt}]（Cooldown Spin...）")
                    time.sleep(2.0)
            log(f"[{mt}] Cooldown 完成，繼續下一步驟")
            return True

        if bonus_action != 'auto_wait' and time.time() - last_spin_at > 3.0:
            last_spin_at = time.time()
            _, btn = find_spin_button(page, spin_sel_cfg)
            if btn:
                try:
                    btn.click(timeout=2000)
                except Exception:
                    pass
            log(f"[{mt}]（Spin 中，等待特殊遊戲結束...）")

    log(f"[{mt}] ⚠️ 等待特殊狀態結束逾時（15 分鐘），繼續正常流程")
    return True


# ─── 主流程（多進程架構）───────────────────────────────────────────────────────
# Playwright sync API 官方明文只支援單執行緒操作，原本所有機台共用同一個
# browser/context、單一 for 迴圈輪流跑，改成每台機台各自獨立的 process（各自
# sync_playwright + browser + context + page），一台卡住/掛掉不會影響其他台。
# 各 process 沿用 parent 向伺服器登錄拿到的同一個 session_id，停止/暫停協調
# 完全透過既有的 /should-stop 心跳輪詢（各 process 各自獨立輪詢同一個
# session_id），不需要額外的跨 process 通訊。

_child_processes: list = []  # parent process 用，讓 signal handler 拿得到子行程清單


def _parent_signal_handler(signum, frame):
    print("[Agent] 收到停止信號，通知所有機台 process 結束...")
    for proc in _child_processes:
        if proc.is_alive():
            proc.terminate()


def machine_worker(session_id_: str, server_url_: str, user_label_: str, cfg: dict,
                    keyword_actions_: dict, machine_actions_: dict, heartbeats=None,
                    screenshot_enabled_: bool = True):
    """單一機台的完整生命週期，跑在自己獨立的 process 裡。heartbeats（multiprocessing.Manager
    的共享 dict，parent 傳入）在每次主迴圈迭代開頭寫入目前時間，讓 parent 端的監控迴圈能判斷
    這台機台是「活著且有在動」還是「process 還在但卡死」（例如瀏覽器已無回應），據此自動重啟。"""
    global session_id, server_url, user_label, keyword_actions, machine_actions, AGENT_START_TS, screenshot_enabled
    session_id = session_id_
    server_url = server_url_
    user_label = user_label_
    keyword_actions = keyword_actions_
    machine_actions = machine_actions_
    screenshot_enabled = screenshot_enabled_
    AGENT_START_TS = time.time()

    signal.signal(signal.SIGINT,  lambda s, f: stop_flag.set())
    signal.signal(signal.SIGTERM, lambda s, f: stop_flag.set())
    threading.Thread(target=log_worker, daemon=True).start()
    threading.Thread(target=poll_stop, daemon=True).start()

    mt = cfg['machineType']
    load_templates()

    if not cfg.get('gameUrl'):
        log(f"[{mt}] 未設定 Game URL，結束")
        return

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=False,
            args=['--no-sandbox', '--disable-dev-shm-usage', '--window-size=432,860']
        )

        # 每台機台各自獨立 context，錄影開關改成只看這一台自己的設定（原本共用一個
        # context 時，只要「任何一台」開錄影，其他台也會被一起錄進去，是不精準的）
        enable_video = bool(cfg.get('enableRecording'))
        video_dir = None
        if enable_video:
            ts = datetime.now().strftime('%Y%m%d_%H%M%S')
            import pathlib
            video_dir = str(pathlib.Path(__file__).parent / 'recordings' / f"{ts}_{mt}")
            os.makedirs(video_dir, exist_ok=True)
            log(f"[{mt}] 錄影已啟動，儲存至: {video_dir}")

        ctx_options = dict(
            viewport={"width": 432, "height": 780},
            is_mobile=True,
            user_agent="Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
        )
        if video_dir:
            ctx_options['record_video_dir'] = video_dir
            ctx_options['record_video_size'] = {"width": 432, "height": 780}

        context = browser.new_context(**ctx_options)
        # 注入 pinus/GM 事件監控 script（於所有頁面載入前執行），提供 __lastCoin/__gmEvents/__pinusLog
        context.add_init_script(TOPPATH_MONITOR_SCRIPT)

        mp = None
        try:
            page = context.new_page()
            page.goto(cfg['gameUrl'], wait_until='domcontentloaded', timeout=30000)
            if not enter_game(page, cfg):
                log(f"[{mt}] 無法進入遊戲，結束")
            else:
                time.sleep(3.0)  # 等待遊戲穩定
                mp = {'page': page, 'config': cfg, 'spin_count': 0, 'error_count': 0, 'last_balance': None, 'last_pinus_poll': 0.0, 'no_change_count': 0}
                post_history(mt, None, 0, event='start', note='Agent 開始')
                log(f"[{mt}] 遊戲已就緒")
        except Exception as e:
            log(f"[{mt}] 開啟失敗: {e}")

        if mp is None:
            try:
                browser.close()
            except Exception:
                pass
            return

        log(f"[{mt}] 開始執行 Spin 循環")
        screenshot_interval = 20

        was_paused = False

        while not stop_flag.is_set():
            page   = mp['page']
            cfg    = mp['config']

            # 每次迭代開頭就寫入心跳（暫停中也要寫，避免暫停中的機台被誤判成卡死）
            if heartbeats is not None:
                heartbeats[mt] = time.time()

            # ── 暫停/恢復 ────────────────────────────────────────────────────
            if pause_flag.is_set():
                if not was_paused:
                    log(f"[{mt}] 已暫停，等待繼續...")
                    was_paused = True
                time.sleep(1)
                continue
            if was_paused:
                log(f"[{mt}] 已繼續執行")
                was_paused = False

            try:
                # ── pinus + console 日誌監控（每台機每 2 秒轉發一次累積的訊息，避免洗版）──
                now_ts = time.time()
                if now_ts - mp.get('last_pinus_poll', 0) >= 2.0:
                    mp['last_pinus_poll'] = now_ts
                    try:
                        poll_monitor_logs(page, mt)
                    except Exception:
                        pass

                # ── QAT/PROD 日誌 API（daily-analysis）輪詢（每台機每 5 秒，背景執行緒查詢
                # 不會卡住主 Spin 迴圈）──────────────────────────────────────────
                if now_ts - mp.get('last_daily_log_poll', 0) >= 5.0:
                    mp['last_daily_log_poll'] = now_ts
                    async_call(poll_daily_analysis_log, mt, cfg.get('gameTitleCode') or '', cfg.get('logApiEnv') or 'qat')
                    check_cr_gap(mt)  # 被動偵測 CR checks 多久沒新事件，不主動點擊任何東西
                    maybe_send_status_report(mp, page)  # 內部自己判斷間隔到了沒才會真的送

                # ── 404 / 錯誤頁面偵測 ───────────────────────────────────────
                if check_page_error(page):
                    log(f"[{mt}] 偵測到頁面錯誤（404/空白），重新載入...")
                    async_call(send_lark, cfg.get('larkWebhook') or '', f"[{mt}] 頁面錯誤", "偵測到 404/空白頁，已自動重新載入")
                    try:
                        page.reload(wait_until='domcontentloaded', timeout=30000)
                        enter_game(page, cfg)
                        time.sleep(3.0)
                    except Exception as re_err:
                        log(f"[{mt}] 重新載入失敗: {re_err}")
                    continue

                # 若被踢回大廳、或掉進旁觀模式，重新進入
                # ⚠️ 只查 is_in_game() 抓不到旁觀模式——那支對旁觀者的 Spin／餘額 selector
                #    全部命中，會回 True。29 小時無效壓測就是卡在這裡：進場誤判之後，
                #    這個「掉出去了就重進」的保險也跟著失效，沒有任何一層攔得住。
                seat_now = detect_seat_state(page)
                if seat_now == 'spectator' or not is_in_game(page):
                    reason = '停留在旁觀面板（未入座）' if seat_now == 'spectator' else '回到大廳'
                    log(f"[{mt}] 偵測到{reason}，重新進入遊戲...")
                    if enter_game(page, cfg):
                        time.sleep(3.0)
                    continue

                # ── 特殊遊戲偵測（OSMWatcher）───────────────────────────────
                # gameTitleCode 就是 gmid（例如 "873-RISINGROCKETS-0140"），跟 osmMachineStatus 用同一把 key。
                gmid = cfg.get('gameTitleCode') or ''
                osm_handled = wait_for_normal_osm_status(gmid, page, cfg, mt, heartbeats) if gmid else False
                with osm_status_lock:
                    osm_connected = gmid in osm_status_cache

                # ⚠️ 補判一定要在點下這次 spin 之前——這次的結算會把 __coinUpdatedAt
                #    往前推，之後就分不出是上一局晚到還是這一局剛結算。
                if osm_handled:
                    # 中間卡過 FG/JP：那段一定有派彩造成的 coin 更新，
                    # 拿它補判會把派彩誤記成上一局的結算，直接放棄這一筆。
                    mp['pending_unknown'] = None
                reclassify_pending_unknown(page, mp, mt)

                spin_result = do_spin(page, cfg)
                if spin_result:
                    balance_before, balance_after, spin_rejected, spin_outcome, coin_ts_at_click = spin_result
                    # spin_count 是「按鈕嘗試次數」，不是局數——名字保留是為了不動既有欄位，
                    # 但報告上已經改叫 spin_attempts，不再讓人誤會成局數
                    mp['spin_count'] += 1
                    mp['outcome_counts'] = mp.get('outcome_counts', {})
                    mp['outcome_counts'][spin_outcome] = mp['outcome_counts'].get(spin_outcome, 0) + 1
                    # 只有 unknown 需要留下來等下一次 spin 前補判；其餘三種都已經定案
                    mp['pending_unknown'] = (
                        {'coinTs': coin_ts_at_click, 'at': time.time()}
                        if spin_outcome == 'unknown' else None
                    )
                    mp['error_count'] = 0
                    # Live Ledger：每次 spin 即時落庫（fire-and-forget，不擋主迴圈）
                    async_call(post_recon_spin, mt, cfg, mp['spin_count'],
                               balance_before, balance_after, int(time.time() * 1000))
                    if not spin_rejected:
                        mp['ok_spin_count'] = mp.get('ok_spin_count', 0) + 1
                        mark_spin_recovered(mp)
                    else:
                        # 記下現場：錯誤描述 + 餘額前後 + 是否需要查帳。
                        # 只有計數器的話，事後完全答不出「對玩家的影響」。
                        snap = record_err_snapshot(page, mp, balance_before, balance_after)
                        if snap['deducted']:
                            log(f"[{mt}] ⚠️ errcode {snap['errcode']} 且餘額減少 "
                                f"{snap['balanceBefore']:.2f} → {snap['balanceAfter']:.2f}"
                                f"（扣款但未轉成，需要查帳）")
                    with spin_interval_lock:
                        ov = spin_interval_override
                    spin_interval = ov if ov is not None else float(cfg.get('spinInterval') or 1.0)

                    # ── 餘額前後記錄 ──────────────────────────────────────────
                    if balance_before is not None and balance_after is not None:
                        delta = balance_after - balance_before
                        if delta > 0:
                            mp['win_count'] = mp.get('win_count', 0) + 1
                            mp['total_win'] = mp.get('total_win', 0) + delta
                        if mp['spin_count'] % 10 == 0 or delta != 0:
                            log(f"[{mt}] Spin #{mp['spin_count']} 餘額 {balance_before:.2f} → {balance_after:.2f}（{'+' if delta >= 0 else ''}{delta:.2f}）")

                    # ── 相容 fallback：沒有 OSMWatcher 資料時，用連續無變化次數推測特殊遊戲 ──
                    # osm_handled=True 代表這次已經是 OSMWatcher 確認過的特殊狀態處理，不需要再用 fallback；
                    # osm_connected=True 代表這台機台有 OSMWatcher 在回報（即使這次狀態正常），也不需要 fallback；
                    # spin_rejected=True 代表這次餘額沒變是因為伺服器直接拒絕了 Spin 請求（例如逾時），
                    # 不是特殊遊戲狀態，不計入連續無變化次數，避免誤判成特殊遊戲亂點 bonusAction。
                    if spin_rejected:
                        pass
                    elif not osm_handled and not osm_connected:
                        no_change = balance_before is not None and balance_after is not None and balance_before == balance_after
                        if no_change:
                            mp['no_change_count'] = mp.get('no_change_count', 0) + 1
                        else:
                            mp['no_change_count'] = 0
                        if mp['no_change_count'] >= 10:
                            log(f"[{mt}] ⚠️ 連續 10 次 Spin 餘額都沒變化，且無 OSMWatcher 資料，判斷為特殊遊戲，執行 bonusAction（相容 fallback）")
                            execute_bonus_action(page, cfg, mt, cfg.get('spinSelector') or '')
                            mp['no_change_count'] = 0
                            # 跟 osm_handled 同一個理由：bonus 派彩會更新 coin，
                            # 拿它補判會把派彩誤記成上一局的結算
                            mp['pending_unknown'] = None

                    # ── 進度回報（獨立於截圖週期，避免 Discord 通知的 Spin 數卡在很舊的數字）──
                    # 截圖/歷史紀錄仍維持每 screenshot_interval 次才寫一次；這裡只是輕量地讓
                    # Discord 卡片上的 Spin 數每 ~10 秒就跟上最新進度。
                    if now_ts - mp.get('last_progress_post', 0) >= 10.0:
                        mp['last_progress_post'] = now_ts
                        async_call(post_history, mt, mp.get('last_balance'), mp['spin_count'])

                    # ── 低餘額偵測 ────────────────────────────────────────────
                    threshold = float(cfg.get('lowBalanceThreshold') or 0)
                    # 餘額改用 pinus WebSocket 攔截讀取（與 Machine Test 完全同步），不再依賴 DOM selector
                    balance = read_balance(page)
                    if balance is not None:
                        mp['last_balance'] = balance
                    if threshold > 0:
                        balance = mp.get('last_balance')
                        if balance is not None and balance < threshold:
                            log(f"[{mt}] 餘額 {balance:.2f} 低於閾值 {threshold:.2f}，退出重進")
                            mp['kickout_count'] = mp.get('kickout_count', 0) + 1
                            lark_hook = cfg.get('larkWebhook') or ''
                            async_call(send_lark, lark_hook, f"[{mt}] 低餘額警告",
                                       f"餘額 {balance:.2f} 低於設定閾值 {threshold:.2f}")
                            async_call(post_history, mt, balance, mp['spin_count'],
                                       event='low_balance', note=f"閾值 {threshold:.2f}")
                            for exit_sel in ['.balance-bg.hand_balance', '.h-balance.hand_balance',
                                             '.btn-exit', '.exit-btn', '.btn_exit']:
                                try:
                                    btn = page.locator(exit_sel).first
                                    if btn.is_visible():
                                        btn.click(timeout=2000)
                                        break
                                except Exception:
                                    pass
                            time.sleep(2.0)
                            enter_game(page, cfg)
                            time.sleep(2.0)

                    # ── 隨機下注（BetRandom）──────────────────────────────────
                    if cfg.get('betRandomEnabled'):
                        execute_bet_random(page, cfg.get('ideckXpaths') or [])

                    # ── 隨機離開（RandomExit）────────────────────────────────
                    import random as _rand
                    if cfg.get('randomExitEnabled'):
                        min_spins = int(cfg.get('randomExitMinSpins') or 50)
                        chance    = float(cfg.get('randomExitChance') or 0.02)
                        if mp['spin_count'] >= min_spins and _rand.random() < chance:
                            log(f"[{mt}] 觸發隨機離開（spin #{mp['spin_count']}，機率 {chance:.1%}）")
                            exited = False
                            for exit_sel in ['.balance-bg.hand_balance', '.h-balance.hand_balance',
                                             '.btn-exit', '.exit-btn', '.btn_exit']:
                                try:
                                    btn = page.locator(exit_sel).first
                                    if btn.is_visible():
                                        btn.click(timeout=2000)
                                        exited = True
                                        break
                                except Exception:
                                    pass
                            time.sleep(2.0)
                            enter_game(page, cfg)
                            time.sleep(2.0)
                            mp['spin_count'] = 0

                    if mp['spin_count'] % 10 == 0:
                        log(f"[{mt}] Spin #{mp['spin_count']} (間隔 {spin_interval}s)")
                    if mp['spin_count'] % screenshot_interval == 0:
                        try:
                            # 截圖本身（page.screenshot()）仍然要拍，因為下面的模板比對（Bonus/Error
                            # 偵測）需要這張圖才能運作；screenshot_enabled 只控制「要不要上傳存進
                            # 截圖監控畫廊」這個部分，不影響模板偵測/戰績紀錄/對帳資料（2026-08-17，
                            # 使用者反應的是截圖監控畫廊洗版的問題，不是要連這些功能一起關掉）
                            img = page.screenshot()
                            name = f"{mt}_{mp['spin_count']:06d}.png"
                            if screenshot_enabled:
                                async_call(send_screenshot, name, img)
                                log(f"[{mt}] 截圖已上傳: {name}")

                            # ── 戰績紀錄 + 對帳資料 ───────────────────────────
                            bal_for_history = mp.get('last_balance')
                            async_call(post_history, mt, bal_for_history, mp['spin_count'])
                            # 注意：fetch_and_post_pinus_records 內部會呼叫 page.evaluate()，
                            # Playwright sync API 不能跨執行緒操作 page，這個不能丟進背景執行緒。
                            fetch_and_post_pinus_records(page, mt)

                            # ── 模板比對 ──────────────────────────────────────
                            lark_hook = cfg.get('larkWebhook') or ''
                            if cfg.get('enableTemplateDetection'):
                                # Bonus 偵測
                                tpl_type = cfg.get('templateType') or ''
                                if tpl_type:
                                    match = match_templates(img, tpl_type)
                                    if match:
                                        log(f"[{mt}] 🎯 模板匹配：{match[0]} (信心度 {match[1]:.2f})")
                                        async_call(send_lark, lark_hook, f"[{mt}] 模板匹配",
                                                   f"偵測到 {match[0]}（信心度 {match[1]:.1%}）")
                                        async_call(post_history, mt, mp.get('last_balance'), mp['spin_count'],
                                                   event='bonus', note=f"{match[0]} ({match[1]:.1%})")
                                # Error 偵測
                                err_type = cfg.get('errorTemplateType') or ''
                                if err_type:
                                    err_match = match_templates(img, err_type, threshold=0.65)
                                    if err_match:
                                        log(f"[{mt}] ⚠️ 錯誤模板匹配：{err_match[0]} (信心度 {err_match[1]:.2f})")
                                        async_call(send_lark, lark_hook, f"[{mt}] 偵測到錯誤",
                                                   f"錯誤模板 {err_match[0]}（信心度 {err_match[1]:.1%}），請檢查")
                        except Exception as se:
                            log(f"[{mt}] 截圖失敗: {se}")

                    time.sleep(spin_interval)
                else:
                    mp['error_count'] += 1
                    log(f"[{mt}] Spin 失敗（累計 {mp['error_count']} 次）")
                    if mp['error_count'] >= 10:
                        log(f"[{mt}] 連續錯誤過多，重新載入頁面")
                        try:
                            page.reload(wait_until='domcontentloaded', timeout=30000)
                            enter_game(page, cfg)
                            time.sleep(3.0)
                            mp['error_count'] = 0
                        except Exception:
                            pass

            except PwTimeout:
                mp['error_count'] += 1
                log(f"[{mt}] Spin 逾時（累計 {mp['error_count']} 次）")
                if mp['error_count'] >= 10:
                    try:
                        page.reload(wait_until='domcontentloaded', timeout=30000)
                        enter_game(page, cfg)
                        time.sleep(3.0)
                        mp['error_count'] = 0
                    except Exception:
                        pass
            except Exception as e:
                mp['error_count'] += 1
                log(f"[{mt}] 錯誤: {e}")

        log(f"[{mt}] 停止執行，關閉瀏覽器")
        try:
            browser.close()
        except Exception:
            pass


def main():
    global server_url, user_label, session_id

    if len(sys.argv) > 1:
        try:
            parsed = urlparse(sys.argv[1])
            params = parse_qs(parsed.query)
            server_url = params.get('server', [server_url])[0].rstrip('/')
            user_label = params.get('user', [''])[0]
        except Exception:
            pass

    print(f"[Agent] 連接伺服器：{server_url}，使用者：{user_label or '(未設定)'}")

    try:
        resp = requests.post(f"{server_url}/api/autospin/agent/start",
                             json={'userLabel': user_label}, timeout=10)
        data = resp.json()
        if not data.get('ok', True):
            # 伺服器明確拒絕（例如 heavy-task 衝突：這個帳號已有其他重任務在跑），印出伺服器
            # 給的實際原因，不要直接 data['sessionId'] 導致難懂的 KeyError。
            print(f"[ERROR] 伺服器拒絕註冊：{data.get('message', '未知原因')}")
            sys.exit(1)
        session_id          = data['sessionId']
        configs              = data['configs']
        keyword_actions_data = data.get('keywordActions', {})
        machine_actions_data = data.get('machineActions', {})
        # 截圖監控依帳號開關（2026-08-17），帳號層級偏好、不是逐機台設定，只在這裡（啟動當下）讀一次，
        # 啟動後切換不會即時生效，要等下次重啟 session（跟 CodeX 討論定案，範圍/成本考量）
        screenshot_enabled_data = data.get('screenshotEnabled', True)
        print(f"[Agent] Session: {session_id}，共 {len(configs)} 台機台，截圖監控：{'開啟' if screenshot_enabled_data else '關閉'}")
    except Exception as e:
        print(f"[ERROR] 無法連接伺服器: {e}")
        sys.exit(1)

    # parent process 自己的 log_worker，讓登錄階段（啟動訊息、沒有啟用機台等）也能上傳給伺服器
    threading.Thread(target=log_worker, daemon=True).start()

    active_configs = [c for c in configs if c.get('enabled')]
    if not active_configs:
        log("[Agent] 沒有啟用的機台，請在「機台設定」中啟用至少一台")
        send_stopped()
        sys.exit(0)

    log(f"[Agent] 啟動 {len(active_configs)} 台機台（多進程模式，各自獨立 process）: "
        f"{', '.join(c['machineType'] for c in active_configs)}")

    # 下載模板（若有 templateType/errorTemplateType 設定）——parent 先下載一次到共用暫存
    # 目錄，各 child process 進來時也會各自呼叫 load_templates()（已存在的檔案會跳過下載）
    load_templates()

    signal.signal(signal.SIGINT,  _parent_signal_handler)
    signal.signal(signal.SIGTERM, _parent_signal_handler)

    # 心跳機制：每台機台的 machine_worker() 在主迴圈每次迭代（含暫停中、含 wait_for_normal_osm_status()
    # 內部最長 15 分鐘的等待迴圈）都會寫入 heartbeats[machineType] = 現在時間。這是跨 process 共享的
    # multiprocessing.Manager dict（各 child process 是獨立記憶體空間，一般 dict 或全域變數不會同步，
    # 只有透過 Manager 的 proxy 物件才能讓 parent 讀到 child 寫入的值）。parent 端的監控迴圈用這個
    # 判斷「process 還活著，但其實已經卡死沒在動」（例如瀏覽器已無回應）的情況——只看 proc.is_alive()
    # 抓不到這種，因為 process 本身沒死，只是裡面的 Playwright 呼叫卡住不回應。
    manager = multiprocessing.Manager()
    heartbeats = manager.dict()
    machine_cfgs: dict = {c['machineType']: c for c in active_configs}
    machine_procs: dict = {}
    restart_counts: dict = {mt: 0 for mt in machine_cfgs}
    HEARTBEAT_STALE_SEC = 120   # 單次主迴圈迭代最長合理耗時的安全邊界（含 404 重載等復原流程）
    MONITOR_INTERVAL_SEC = 20
    MAX_RESTARTS_PER_MACHINE = 5

    def spawn_machine(mt: str) -> None:
        proc = multiprocessing.Process(
            target=machine_worker,
            args=(session_id, server_url, user_label, machine_cfgs[mt], keyword_actions_data, machine_actions_data, heartbeats, screenshot_enabled_data),
        )
        proc.start()
        machine_procs[mt] = proc
        _child_processes.append(proc)

    # 分批啟動、每台間隔 2 秒——同時開好幾個 Chromium 是資源尖峰，全部一次 start() 容易讓
    # 部分裝置（尤其效能較弱的機器）卡住，錯開啟動比較穩
    STAGGER_START_SEC = 2.0
    for i, cfg in enumerate(active_configs):
        mt = cfg['machineType']
        spawn_machine(mt)
        log(f"[{mt}] 已啟動獨立 process（PID {machine_procs[mt].pid}）")
        if i < len(active_configs) - 1:
            time.sleep(STAGGER_START_SEC)

    # parent 自己也獨立輪詢 /should-stop（跟每個 child 各自的 poll_stop() 是分開的兩份輪詢），
    # 讓 parent 能自己判斷「使用者/伺服器要整個 session 停止了」，藉此決定監控迴圈何時該收手，
    # 不要在使用者已經按停止的情況下還去自動重啟正在正常關閉中的機台。
    global_stop = threading.Event()

    def poll_stop_parent():
        while not global_stop.is_set():
            try:
                r = requests.get(f"{server_url}/api/autospin/agent/{session_id}/should-stop", timeout=5)
                d = r.json()
                if d.get('stop'):
                    global_stop.set()
                    break
            except Exception:
                pass
            time.sleep(3)

    threading.Thread(target=poll_stop_parent, daemon=True).start()

    # ── 監控迴圈：自動偵測「process 已終止」或「心跳過期（卡死）」，自動重啟該台機台 ──────
    while not global_stop.is_set():
        time.sleep(MONITOR_INTERVAL_SEC)
        if global_stop.is_set():
            break
        for mt, proc in list(machine_procs.items()):
            now = time.time()
            hb = heartbeats.get(mt, 0)
            alive = proc.is_alive()
            stale = hb > 0 and (now - hb) > HEARTBEAT_STALE_SEC
            if alive and not stale:
                continue
            # heartbeat 從未寫入過（hb==0）代表機台在進入主 Spin 迴圈之前就已經結束
            # （例如未設定 Game URL、或無法進入遊戲）——這是設定問題，不是斷線，不重啟。
            if not alive and hb == 0:
                continue
            if restart_counts[mt] >= MAX_RESTARTS_PER_MACHINE:
                continue  # 已達重啟上限，之前那次觸發時已經印過警告訊息了
            reason = "process 已終止" if not alive else f"心跳超過 {HEARTBEAT_STALE_SEC}s 無更新（瀏覽器可能已無回應）"
            log(f"[{mt}] ⚠️ 偵測到異常（{reason}），自動重啟該機台...")
            if alive:
                try:
                    proc.terminate()
                    proc.join(timeout=10)
                except Exception:
                    pass
            restart_counts[mt] += 1
            heartbeats[mt] = 0  # 重置，避免重啟後的新 process 還沒寫入第一次心跳前就被誤判成 stale
            time.sleep(3)  # 短暫緩衝，避免瞬間重啟造成資源尖峰
            if global_stop.is_set():
                break
            spawn_machine(mt)
            log(f"[{mt}] 已重新啟動（第 {restart_counts[mt]} 次自動重啟，PID {machine_procs[mt].pid}）")
            if restart_counts[mt] >= MAX_RESTARTS_PER_MACHINE:
                log(f"[{mt}] ⚠️ 已達自動重啟上限（{MAX_RESTARTS_PER_MACHINE} 次），之後若再異常將不再自動重啟，需人工檢查")

    log("[Agent] 收到停止指令，等待所有機台 process 結束...")
    for proc in list(machine_procs.values()):
        proc.join(timeout=60)

    log("[Agent] 所有機台 process 已結束")
    send_stopped()
    log("[Agent] 已結束")


if __name__ == "__main__":
    main()
