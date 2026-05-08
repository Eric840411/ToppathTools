#!/usr/bin/env python3
"""
toppath-agent.py — Toppath Tools 本機 AutoSpin Agent（Playwright 版）
完整移植 AutoSpin.py 的遊戲進入流程、Spin 邏輯與 keyword_actions。
"""

import sys
import json
import time
import threading
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

def log(msg: str):
    ts = datetime.now().strftime("%H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    try:
        requests.post(f"{server_url}/api/autospin/agent/{session_id}/log",
                      json={'line': line}, timeout=5)
    except Exception:
        pass

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
    global spin_interval_override
    while not stop_flag.is_set():
        try:
            r = requests.get(f"{server_url}/api/autospin/agent/{session_id}/should-stop", timeout=5)
            d = r.json()
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


def dismiss_popups(page):
    """關閉大廳彈出的廣告 / 公告 popup（找 X 關閉按鈕或 ESC）"""
    # 常見關閉按鈕 selector（廣告 popup、公告、品牌新遊戲推薦等）
    close_selectors = [
        '.modal-close', '.popup-close', '.close-btn', '.btn-close',
        '[class*="close"]', '[class*="Close"]',
        'button:has-text("X")', 'button:has-text("×")',
        '.icon-close', '.lc-close',
    ]
    dismissed = False
    for sel in close_selectors:
        try:
            btns = page.locator(sel).all()
            for btn in btns:
                if btn.is_visible():
                    btn.click(timeout=1500)
                    time.sleep(0.3)
                    dismissed = True
        except Exception:
            pass
    # 也試 Escape
    try:
        page.keyboard.press('Escape')
        time.sleep(0.3)
    except Exception:
        pass
    return dismissed


def enter_game(page, cfg: dict) -> bool:
    """從大廳進入指定遊戲，對應 AutoSpin.py scroll_and_click_game()"""
    mt = cfg['machineType']
    game_title_code = cfg.get('gameTitleCode') or ''
    if not game_title_code:
        log(f"[{mt}] 未設定 gameTitleCode，跳過大廳尋找")
        return True

    # 先等頁面穩定：等到遊戲指標或大廳元素出現其中一個再判斷
    # 避免頁面尚未載入時 is_in_game() 觸發「保守策略 → return True」
    try:
        page.wait_for_selector(
            '.my-button.btn_spin, .btn_spin .my-button, #grid_gm_item',
            timeout=12000,
        )
    except PwTimeout:
        log(f"[{mt}] 頁面載入等待超時（12s），繼續嘗試判斷狀態")

    if is_in_game(page):
        log(f"[{mt}] 已在遊戲中，跳過大廳")
        return True

    time.sleep(1.0)

    # 先關閉任何彈出的廣告 popup
    if dismiss_popups(page):
        log(f"[{mt}] 已關閉廣告/公告 popup")
        time.sleep(0.5)

    try:
        page.wait_for_selector('#grid_gm_item', timeout=12000)
    except PwTimeout:
        if is_in_game(page):
            return True
        log(f"[{mt}] 大廳元素未找到（逾時）")
        return False

    # 再次嘗試關閉 popup（有些在頁面完全載入後才出現）
    dismiss_popups(page)

    items = page.locator('#grid_gm_item').all()
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

    # 捲動到目標卡片並點擊
    try:
        target_item.scroll_into_view_if_needed(timeout=3000)
        time.sleep(0.3)
    except Exception:
        pass

    try:
        target_item.click(timeout=3000)
    except Exception as e:
        log(f"[{mt}] 點擊遊戲卡片失敗: {e}")
        return False

    log(f"[{mt}] 點擊遊戲卡片: {target_item.get_attribute('title') or game_title_code}")
    time.sleep(1.2)

    # 嘗試點擊 Join 按鈕
    try:
        join = page.locator(".gm-info-box span:text('Join')").first
        join.click(timeout=3000)
        log(f"[{mt}] 點擊 Join 進入遊戲")
        time.sleep(3.0)
    except Exception:
        pass  # Join 不一定存在

    # 執行 keyword_actions（對應 AutoSpin.py 中的 keyword_actions 邏輯）
    for kw, positions in keyword_actions.items():
        if kw in game_title_code and positions:
            log(f"[{mt}] 執行 keyword_actions: {kw} -> {positions}")
            time.sleep(1.0)
            click_positions(page, positions)
            time.sleep(1.0)
            break

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
    """讀取餘額，回傳 float 或 None"""
    try:
        text = page.locator(selector).first.inner_text(timeout=2000)
        # 保留數字和小數點
        import re as _re
        cleaned = _re.sub(r'[^\d.]', '', text)
        return float(cleaned) if cleaned else None
    except Exception:
        return None


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


def do_spin(page, cfg: dict) -> bool:
    """執行一次 Spin，對應 AutoSpin.py 的 spin selector 邏輯"""
    mt = cfg['machineType']
    game_title_code = cfg.get('gameTitleCode') or ''
    is_special = mt in SPECIAL_GAMES or game_title_code in SPECIAL_GAMES

    # 優先使用機台設定中指定的 selector
    spin_sel = cfg.get('spinSelector') or ''
    if not spin_sel:
        # 對應 AutoSpin.py：SPECIAL_GAMES 用 .btn_spin .my-button，其他用 .my-button.btn_spin
        spin_sel = '.btn_spin .my-button' if is_special else '.my-button.btn_spin'

    try:
        btn = page.locator(spin_sel).first
        btn.click(timeout=8000)
        return True
    except PwTimeout:
        pass

    # Fallback：點擊 canvas 右下角
    try:
        box = page.locator('canvas').bounding_box()
        if box:
            page.mouse.click(box['x'] + box['width'] * 0.85,
                             box['y'] + box['height'] * 0.85)
            return True
    except Exception:
        pass
    return False


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
            machine_pages.append({'page': page, 'config': cfg, 'spin_count': 0, 'error_count': 0, 'last_balance': None})
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
                    bal_sel   = cfg.get('balanceSelector') or ''
                    threshold = float(cfg.get('lowBalanceThreshold') or 0)
                    if bal_sel:
                        balance = get_balance(page, bal_sel)
                        if balance is not None:
                            mp['last_balance'] = balance
                    if bal_sel and threshold > 0:
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
