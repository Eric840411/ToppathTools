#!/usr/bin/env python3
"""
toppath-agent.py — Toppath Tools 本機 AutoSpin Agent（Playwright 版）
完整移植 AutoSpin.py 的遊戲進入流程、Spin 邏輯與 keyword_actions。
"""

import sys
import json
import time
import threading
import queue
import signal
import os
import tempfile
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

# ─── 解析伺服器 URL ────────────────────────────────────────────────────────────

server_url = "http://localhost:3000"
user_label = ""
if len(sys.argv) > 1:
    try:
        parsed = urlparse(sys.argv[1])
        params = parse_qs(parsed.query)
        server_url = params.get('server', [server_url])[0].rstrip('/')
        user_label = params.get('user', [''])[0]
    except Exception:
        pass

print(f"[Agent] 連接伺服器：{server_url}，使用者：{user_label or '(未設定)'}")

# ─── 向伺服器登錄，取得 session ID、機台設定與 actions ───────────────────────

try:
    resp = requests.post(f"{server_url}/api/autospin/agent/start",
                         json={'userLabel': user_label}, timeout=10)
    data = resp.json()
    session_id       = data['sessionId']
    configs          = data['configs']
    keyword_actions  = data.get('keywordActions', {})
    machine_actions  = data.get('machineActions', {})
    bet_random_config = data.get('betRandomConfig', {})
    print(f"[Agent] Session: {session_id}，共 {len(configs)} 台機台")
except Exception as e:
    print(f"[ERROR] 無法連接伺服器: {e}")
    sys.exit(1)

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

threading.Thread(target=log_worker, daemon=True).start()

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

signal.signal(signal.SIGINT,  lambda s, f: stop_flag.set())
signal.signal(signal.SIGTERM, lambda s, f: stop_flag.set())

spin_interval_override = None  # set by server via should-stop poll
spin_interval_lock = __import__('threading').Lock()

def poll_stop():
    global spin_interval_override, session_id
    while not stop_flag.is_set():
        try:
            r = requests.get(f"{server_url}/api/autospin/agent/{session_id}/should-stop", timeout=5)
            d = r.json()
            # Session not found (server restarted) — re-register to get a new session
            if d.get('sessionNotFound'):
                print(f"[Agent] Session 已失效，嘗試重新連線伺服器...")
                try:
                    resp = requests.post(f"{server_url}/api/autospin/agent/start",
                                         json={'userLabel': user_label}, timeout=10)
                    new_data = resp.json()
                    session_id = new_data['sessionId']
                    print(f"[Agent] 重新連線成功，新 Session: {session_id}")
                    log(f"[Agent] 斷線重連成功（伺服器重啟），繼續執行中")
                except Exception as e:
                    print(f"[Agent] 重連失敗，將在下次輪詢重試: {e}")
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
        except Exception:
            pass
        time.sleep(3)

threading.Thread(target=poll_stop, daemon=True).start()

# ─── 常量 ─────────────────────────────────────────────────────────────────────

SPECIAL_GAMES = {'BULLBLITZ', 'ALLABOARD'}

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

  // Hook WebSocket so we can scan raw frames for enterGMNtc/leaveGMNtc before pinus decodes them
  var _OrigWS = window.WebSocket;
  function PatchedWS(url, protocols) {
    var ws = protocols !== undefined ? new _OrigWS(url, protocols) : new _OrigWS(url);
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
  function tryPatchPinus() {
    var p = window.pinus;
    if (!p) return false;
    if (p.__toppathTracked) return true;
    p.__toppathTracked = true;

    var origRequest = p.request.bind(p);
    p.request = function (route, msg, cb) {
      pushPinusLog('request', route, msg);
      return origRequest(route, msg, function (resp) {
        pushPinusLog('response', route, resp);
        if (resp && typeof resp.coin === 'number') {
          window.__lastCoin = resp.coin;
          window.__coinUpdatedAt = Date.now();
        }
        cb && cb(resp);
      });
    };

    var origOn = p.on.bind(p);
    p.on = function (route, cb) {
      return origOn(route, function (data) {
        pushPinusLog('push', route, data);
        if (data && typeof data.coin === 'number') {
          window.__lastCoin = data.coin;
          window.__coinUpdatedAt = Date.now();
        }
        cb && cb(data);
      });
    };
    return true;
  }
  var timer = setInterval(function () {
    if (tryPatchPinus()) clearInterval(timer);
  }, 200);
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
    """等待文字內容為 text 的 span 出現並可見，回傳該 locator，逾時回傳 None。
    完整移植自 machine-test/runner.ts 的 waitForSpanText()。"""
    deadline = time.time() + timeout_ms / 1000
    while time.time() < deadline:
        try:
            loc = page.locator(f"span:text('{text}')").first
            if loc.count() > 0 and loc.is_visible():
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
            log(f"[{mt}] 找不到 Join 按鈕（此機種可能不需要），繼續下一步")
    except Exception as e:
        log(f"[{mt}] 找不到 Join 按鈕（此機種可能不需要），繼續下一步: {e}")

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
    if enter_ev:
        errcode = enter_ev.get('errcode', 0)
        if errcode == 0:
            log(f"[{mt}] ✅ enterGMNtc 確認進入成功（耗時 {time.time() - t0:.1f}s）")
        else:
            log(f"[{mt}] ⚠️ enterGMNtc errcode={errcode}: {enter_ev.get('errcodedes', '')}（耗時 {time.time() - t0:.1f}s）")
    else:
        log(f"[{mt}] ⚠️ 未收到 enterGMNtc（12s 逾時），改用 DOM 偵測判斷是否進入成功")

    log(f"[{mt}] ── 進入流程結束，總耗時 {time.time() - t_start:.1f}s ──")
    return True


def execute_bet_random(page, game_title_code: str, bet_cfg: dict):
    """Spin 後 30% 機率隨機點擊下注按鈕（對應 AutoSpin.py _execute_bet_random）"""
    import random as _random
    if not bet_cfg or not game_title_code:
        return
    if _random.random() > 0.3:
        return
    selectors = None
    if game_title_code in bet_cfg:
        v = bet_cfg[game_title_code]
        selectors = v if isinstance(v, list) else v.get('selectors')
    else:
        for key, val in bet_cfg.items():
            if key in game_title_code:
                selectors = val if isinstance(val, list) else val.get('selectors')
                break
    if not selectors:
        return
    sel = _random.choice(selectors)
    try:
        elems = page.locator(sel).all()
        for e in elems:
            if e.is_visible():
                e.click(timeout=1500)
                log(f"  [BetRandom] 點擊下注按鈕: {sel}")
                time.sleep(0.5)
                return
    except Exception:
        pass


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


def poll_pinus_log(page, mt: str):
    """取出（drain）window.__pinusLog 中新累積的 pinus request/response/push 訊息並轉發到日誌，
    監控 pinus 所有打印的訊息。掃描所有 frame（pinus 可能在子 iframe）。"""
    for frame in page.frames:
        try:
            entries = frame.evaluate("() => { var l = window.__pinusLog || []; window.__pinusLog = []; return l; }")
        except Exception:
            continue
        if not entries:
            continue
        for e in entries:
            direction = e.get('dir', '')
            route = e.get('route', '')
            data = e.get('data', '')
            log(f"[{mt}][pinus:{direction}] {route} {data}")
        return  # pinus 通常只存在單一 frame，找到有訊息的就停止掃描其他 frame


def fetch_and_post_pinus_records(page, machine_type: str):
    """透過 window.pinus.request 取得歷史戰績並上傳到伺服器"""
    try:
        uid = page.evaluate("window._uid || (window.pinus && window.pinus.uid) || ''")
        records = page.evaluate("""(uid) => new Promise((resolve) => {
            var p = window.pinus;
            if (!p || typeof p.request !== 'function') { resolve([]); return; }
            p.request('status.statusHandler.historyListReq',
                {uid: uid || '', pageindex: 0, pagecount: 15},
                function(res) { resolve((res && res.list) ? res.list : []); }
            );
        })""", uid)
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


def do_spin(page, cfg: dict) -> bool:
    """執行一次 Spin。點擊邏輯與 machine-test 的 stepSpin 完全同步：
    找按鈕（selector fallback chain）→ 確認未 disabled → native click（overlay 攔截時改 force click）
    → 輪詢按鈕 disabled→enabled 確認動畫完成（最多 8 秒）。"""
    spin_sel_cfg = cfg.get('spinSelector') or ''

    sel, btn = find_spin_button(page, spin_sel_cfg)
    if not btn:
        # Fallback：找不到任何已知 selector 時，點擊 canvas 右下角（AutoSpin 既有保底方案）
        try:
            box = page.locator('canvas').bounding_box()
            if box:
                page.mouse.click(box['x'] + box['width'] * 0.85,
                                 box['y'] + box['height'] * 0.85)
                return True
        except Exception:
            pass
        return False

    try:
        if btn.evaluate("el => el.disabled || el.classList.contains('disabled')"):
            return False
    except Exception:
        pass

    try:
        btn.click(timeout=5000)
    except Exception as e:
        if 'intercepts pointer events' in str(e) or 'Timeout' in str(e):
            try:
                btn.click(force=True, timeout=3000)
            except Exception:
                return False
        else:
            return False

    # 等待動畫完成（按鈕 disabled → enabled），對應 machine-test 的動畫偵測，最多等 8 秒
    deadline = time.time() + 8
    spin_started = False
    while time.time() < deadline:
        time.sleep(0.3)
        try:
            dis = btn.evaluate("el => el.disabled || el.classList.contains('disabled')")
        except Exception:
            break
        if dis and not spin_started:
            spin_started = True
        if spin_started and not dis:
            break

    return True


# ─── 主流程 ───────────────────────────────────────────────────────────────────

active_configs = [c for c in configs if c.get('enabled')]
if not active_configs:
    log("[Agent] 沒有啟用的機台，請在「機台設定」中啟用至少一台")
    send_stopped()
    sys.exit(0)

log(f"[Agent] 啟動 {len(active_configs)} 台機台: {', '.join(c['machineType'] for c in active_configs)}")

# 下載模板（若有 templateType/errorTemplateType 設定）
load_templates()

with sync_playwright() as p:
    browser = p.chromium.launch(
        headless=False,
        args=['--no-sandbox', '--disable-dev-shm-usage', '--window-size=432,860']
    )

    # 若任何機台啟用錄影，開啟 Playwright 錄影
    enable_video = any(c.get('enableRecording') for c in active_configs)
    video_dir = None
    if enable_video:
        ts = datetime.now().strftime('%Y%m%d_%H%M%S')
        import pathlib
        video_dir = str(pathlib.Path(__file__).parent / 'recordings' / ts)
        os.makedirs(video_dir, exist_ok=True)
        log(f"[Agent] 錄影已啟動，儲存至: {video_dir}")

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

    machine_pages = []
    for cfg in active_configs:
        if not cfg.get('gameUrl'):
            log(f"[{cfg['machineType']}] 未設定 Game URL，跳過")
            continue
        try:
            page = context.new_page()
            page.goto(cfg['gameUrl'], wait_until='domcontentloaded', timeout=30000)
            if not enter_game(page, cfg):
                log(f"[{cfg['machineType']}] 無法進入遊戲，跳過")
                continue
            time.sleep(3.0)  # 等待遊戲穩定
            machine_pages.append({'page': page, 'config': cfg, 'spin_count': 0, 'error_count': 0, 'last_balance': None, 'last_pinus_poll': 0.0})
            post_history(cfg['machineType'], None, 0, event='start', note='Agent 開始')
            log(f"[{cfg['machineType']}] 遊戲已就緒")
        except Exception as e:
            log(f"[{cfg['machineType']}] 開啟失敗: {e}")

    if not machine_pages:
        log("[Agent] 所有機台開啟失敗，結束")
        send_stopped()
        browser.close()
        sys.exit(1)

    log(f"[Agent] 開始執行 Spin 循環（共 {len(machine_pages)} 台）")
    screenshot_interval = 20

    was_paused = False

    while not stop_flag.is_set():
        for mp in machine_pages:
            if stop_flag.is_set():
                break
            page   = mp['page']
            cfg    = mp['config']
            mt     = cfg['machineType']

            # ── 暫停/恢復 ────────────────────────────────────────────────────
            if pause_flag.is_set():
                if not was_paused:
                    log("[Agent] 已暫停，等待繼續...")
                    was_paused = True
                time.sleep(1)
                continue
            if was_paused:
                log("[Agent] 已繼續執行")
                was_paused = False

            try:
                # ── pinus 日誌監控（每台機每 2 秒轉發一次累積的訊息，避免洗版）──
                now_ts = time.time()
                if now_ts - mp.get('last_pinus_poll', 0) >= 2.0:
                    mp['last_pinus_poll'] = now_ts
                    try:
                        poll_pinus_log(page, mt)
                    except Exception:
                        pass

                # ── 404 / 錯誤頁面偵測 ───────────────────────────────────────
                if check_page_error(page):
                    log(f"[{mt}] 偵測到頁面錯誤（404/空白），重新載入...")
                    send_lark(cfg.get('larkWebhook') or '', f"[{mt}] 頁面錯誤", "偵測到 404/空白頁，已自動重新載入")
                    try:
                        page.reload(wait_until='domcontentloaded', timeout=30000)
                        enter_game(page, cfg)
                        time.sleep(3.0)
                    except Exception as re_err:
                        log(f"[{mt}] 重新載入失敗: {re_err}")
                    continue

                # 若被踢回大廳，重新進入
                if not is_in_game(page):
                    log(f"[{mt}] 偵測到回到大廳，重新進入遊戲...")
                    if enter_game(page, cfg):
                        time.sleep(3.0)
                    continue

                if do_spin(page, cfg):
                    mp['spin_count'] += 1
                    mp['error_count'] = 0
                    with spin_interval_lock:
                        ov = spin_interval_override
                    spin_interval = ov if ov is not None else float(cfg.get('spinInterval') or 1.0)

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
                            lark_hook = cfg.get('larkWebhook') or ''
                            send_lark(lark_hook, f"[{mt}] 低餘額警告",
                                      f"餘額 {balance:.2f} 低於設定閾值 {threshold:.2f}")
                            post_history(mt, balance, mp['spin_count'],
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
                    if cfg.get('betRandomEnabled') and bet_random_config:
                        game_code = cfg.get('gameTitleCode') or ''
                        execute_bet_random(page, game_code, bet_random_config)

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
                            img = page.screenshot()
                            name = f"{mt}_{mp['spin_count']:06d}.png"
                            send_screenshot(name, img)
                            log(f"[{mt}] 截圖已上傳: {name}")

                            # ── 戰績紀錄 + 對帳資料 ───────────────────────────
                            bal_for_history = mp.get('last_balance')
                            post_history(mt, bal_for_history, mp['spin_count'])
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
                                        send_lark(lark_hook, f"[{mt}] 模板匹配",
                                                  f"偵測到 {match[0]}（信心度 {match[1]:.1%}）")
                                        post_history(mt, mp.get('last_balance'), mp['spin_count'],
                                                     event='bonus', note=f"{match[0]} ({match[1]:.1%})")
                                # Error 偵測
                                err_type = cfg.get('errorTemplateType') or ''
                                if err_type:
                                    err_match = match_templates(img, err_type, threshold=0.65)
                                    if err_match:
                                        log(f"[{mt}] ⚠️ 錯誤模板匹配：{err_match[0]} (信心度 {err_match[1]:.2f})")
                                        send_lark(lark_hook, f"[{mt}] 偵測到錯誤",
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

    log("[Agent] 停止執行，關閉瀏覽器")
    try:
        browser.close()
    except Exception:
        pass

send_stopped()
log("[Agent] 已結束")
