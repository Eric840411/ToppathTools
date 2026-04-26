import os
import sys
import json
import time
import hashlib
import logging
import signal
import threading
import traceback
import re
from datetime import datetime, timedelta
from urllib.parse import parse_qs, urlparse
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np
import requests
import subprocess

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.edge.service import Service
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, NoSuchElementException
from pynput import keyboard

try:
    # webdriver_manager 非必要；若同目錄已有 msedgedriver.exe，會優先使用那個
    from webdriver_manager.microsoft import EdgeChromiumDriverManager  # type: ignore
except Exception:  # pragma: no cover
    EdgeChromiumDriverManager = None  # type: ignore

from dotenv import load_dotenv
from history_monitor import HistoryMonitor

# =========================== 常量與初始化 ===========================
# BASE_DIR: 若是打包成 .exe，取可執行檔所在資料夾；否則取 .py 檔案所在資料夾
BASE_DIR = Path(getattr(sys, "frozen", False) and Path(sys.executable).parent or Path(__file__).resolve().parent)

# 截圖輸出資料夾（RTMP 與瀏覽器）
SCREENSHOT_RTMP = BASE_DIR / "stream_captures"
SCREENSHOT_DIR = BASE_DIR / "screenshots"
# 模板資料夾、FFmpeg 與 EdgeDriver 預設路徑（同目錄）
TEMPLATE_DIR = BASE_DIR / "templates"
FFMPEG_EXE = BASE_DIR / "ffmpeg.exe"
EDGEDRIVER_EXE = BASE_DIR / "msedgedriver.exe"
# 🔹 Manifest 檔案（用來管理 類型→模板、門檻、遮罩）
TEMPLATES_MANIFEST = BASE_DIR / "templates_manifest.json"

SCREENSHOT_RTMP.mkdir(parents=True, exist_ok=True)
SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

# 載入 .env（LARK Webhook 等）
load_dotenv(BASE_DIR / "dotenv.env")
LARK_WEBHOOK = os.getenv("LARK_WEBHOOK_URL")
BACKEND_AUTH_FILE = BASE_DIR / "backend_auth.json"

# 設定 logging 到終端（INFO：一般流程、WARNING：非致命、ERROR：例外）
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)

# 全域停止旗標：Ctrl+C 或外部觸發可讓迴圈收斂退出
stop_event = threading.Event()
pause_event = threading.Event()   # 置位時代表「暫停」

# 全域 spin 頻率控制（秒）
spin_frequency = 1.0  # 預設 1 秒間隔
spin_frequency_lock = threading.Lock()  # 保護頻率變數的鎖

# 以來源名稱（rtmp_name）記住上一張影像的 MD5，用來偵測連續重複畫面
last_image_hash: Dict[str, str] = {}

# 特殊機台集合：影響餘額 selector 與 spin 按鈕 selector 的選擇
SPECIAL_GAMES = {"BULLBLITZ", "ALLABOARD"}

# ---- 全域熱鍵監聽：Space 切換暫停/恢復；Esc 結束 ----
pressed_keys = set()

def _toggle_pause():
    if pause_event.is_set():
        pause_event.clear()
        logging.info("[Hotkey] 解除暫停（Resume）")
        print("▶️  Resume")
    else:
        pause_event.set()
        logging.info("[Hotkey] 進入暫停（Pause）")
        print("⏸️  Paused")

def _on_press(key):
    try:
        pressed_keys.add(key)
        # 偵測 Ctrl + Space
        if key == keyboard.Key.space and keyboard.Key.ctrl_l in pressed_keys:
            _toggle_pause()
        elif key == keyboard.Key.esc and keyboard.Key.ctrl_l in pressed_keys:
            logging.info("[Hotkey] ESC 被按下，停止所有執行緒")
            print("🛑 Stop requested (ESC)")
            stop_event.set()
        # 偵測直接數字鍵調整頻率
        else:
            _handle_frequency_keys(key)
    except Exception as e:
        logging.warning(f"[Hotkey] 監聽例外：{e}")

def _handle_frequency_keys(key):
    """處理頻率調整熱鍵（小鍵盤數字鍵）"""
    global spin_frequency
    
    try:
        # 檢查是否為小鍵盤數字鍵（使用 hasattr 檢查 vk 屬性）
        if hasattr(key, 'vk'):
            # 小鍵盤數字鍵的 VK 碼範圍是 0x60-0x69 (96-105)
            numpad_vk_map = {
                96: 0.01,   # 小鍵盤 0
                97: 0.05,   # 小鍵盤 1
                98: 0.1,     # 小鍵盤 2
                99: 0.5,     # 小鍵盤 3
                100: 1.0,    # 小鍵盤 4
                101: 1.5,    # 小鍵盤 5
                102: 2.0,    # 小鍵盤 6
                103: 3.0,    # 小鍵盤 7
                104: 5.0,   # 小鍵盤 8
                105: 10.0,   # 小鍵盤 9
            }
            
            if key.vk in numpad_vk_map:
                new_freq = numpad_vk_map[key.vk]
                
                # 極限和超快頻率的安全檢查
                if new_freq == 0.01:
                    print("🚨🚨🚨 極度危險警告：極限頻率 (0.01s) 極度危險！")
                    print("   可能造成：瀏覽器崩潰、網路超載、伺服器封鎖、系統當機")
                    print("   強烈建議僅在測試環境使用，且持續時間不超過 10 秒")
                    print("   按 Ctrl+Esc 可立即停止程序")
                elif new_freq == 0.05:
                    print("🚨 極限警告：極限頻率 (0.05s) 可能導致系統不穩定！")
                    print("   可能造成：瀏覽器崩潰、網路超載、伺服器封鎖")
                    print("   強烈建議僅在測試環境使用，且持續時間不超過 30 秒")
                    print("   按 Ctrl+Esc 可立即停止程序")
                elif new_freq == 0.1:
                    print("⚠️  警告：超快頻率 (0.1s) 可能會對系統造成較大負載")
                    print("   建議僅在測試時使用，生產環境請使用較慢頻率")
                
                with spin_frequency_lock:
                    old_freq = spin_frequency
                    spin_frequency = new_freq
                    logging.info(f"[Hotkey] Spin 頻率調整：{old_freq:.1f}s → {spin_frequency:.1f}s")
                    
                    # 顯示頻率狀態
                    freq_desc = {
                        0.01: "💀 極度危險",
                        0.05: "🔥 極限",
                        0.1: "🚀 超快",
                        0.5: "🚀 快速",
                        1.0: "⚡ 正常", 
                        1.5: "🐌 慢速",
                        2.0: "🐢 很慢",
                        3.0: "🐌 極慢",
                        5.0: "🐢 非常慢",
                        10.0: "🐌 極度慢"
                    }
                    print(f"🎛️  Spin 頻率：{freq_desc.get(spin_frequency, f'{spin_frequency:.1f}s')}")
                
    except Exception as e:
        logging.warning(f"[Hotkey] 頻率調整失敗：{e}")

def _on_release(key):
    try:
        # 放開的時候從集合中移除
        if key in pressed_keys:
            pressed_keys.remove(key)
    except Exception:
        pass

def get_current_frequency_status():
    """取得當前頻率狀態的顯示文字"""
    with spin_frequency_lock:
        freq_desc = {
            0.01: "💀 極度危險",
            0.05: "🔥 極限",
            0.1: "🚀 超快",
            0.5: "🚀 快速",
            1.0: "⚡ 正常", 
            1.5: "🐌 慢速",
            2.0: "🐢 很慢",
            3.0: "🐌 極慢",
            5.0: "🐢 非常慢",
            10.0: "🐌 極度慢"
        }
        return freq_desc.get(spin_frequency, f"{spin_frequency:.1f}s")

def start_hotkey_listener():
    logging.info("[Hotkey] 啟動全域熱鍵監聽（Ctrl+Space=Pause/Resume, 小鍵盤數字鍵=頻率調整, Ctrl+Esc=Stop）")
    print("🔧 Hotkeys: Ctrl+Space = Pause/Resume | Ctrl+Esc = Stop")
    print("🎛️  Spin 頻率: 小鍵盤0=極度危險(0.01s) | 小鍵盤1=極限(0.05s) | 小鍵盤2=超快(0.1s) | 小鍵盤3=快速(0.5s) | 小鍵盤4=正常(1.0s) | 小鍵盤5=慢速(1.5s) | 小鍵盤6=很慢(2.0s) | 小鍵盤7=極慢(3.0s) | 小鍵盤8=非常慢(5.0s) | 小鍵盤9=極度慢(10.0s)")
    print(f"📊 當前頻率: {get_current_frequency_status()}")
    listener = keyboard.Listener(on_press=_on_press, on_release=_on_release)
    listener.daemon = True
    listener.start()


# =========================== 小工具函式 ===========================
def file_md5(path: Path) -> str:
    """計算檔案 MD5（逐塊讀取，避免占用過多記憶體）"""
    h = hashlib.md5()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()
    


def wait_for(driver, by, selector, timeout: float = 8.0):
    """等待單一元素存在（presence），回傳 WebElement；逾時拋例外"""
    return WebDriverWait(driver, timeout).until(EC.presence_of_element_located((by, selector)))


def wait_for_all(driver, by, selector, timeout: float = 8.0):
    """等待多個元素存在（presence），回傳 WebElements 清單；逾時拋例外"""
    return WebDriverWait(driver, timeout).until(EC.presence_of_all_elements_located((by, selector)))


def safe_click(driver, elem) -> bool:
    """通用點擊：先滾動到視窗中，再以 JS click，失敗不拋例外而回傳 False"""
    try:
        driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", elem)
        time.sleep(0.15)  # 很短暫的穩定延遲
        driver.execute_script("arguments[0].click();", elem)
        return True
    except Exception as e:
        logging.warning(f"safe_click failed: {e}")
        return False

# =========================== Lark 機器人 ===========================
class LarkClient:
    """極簡 Lark 文本通知客戶端，內建重試機制與明確日誌"""

    def __init__(self, webhook: Optional[str]):
        self.webhook = (webhook or "").strip()
        self.enabled = bool(self.webhook)
        if not self.enabled:
            logging.warning("[Lark] LARK_WEBHOOK_URL 未設定，推播停用")
        else:
            logging.info(f"[Lark] Webhook 已載入（長度={len(self.webhook)}）")

    def send_text(self, text: str, retries: int = 2, timeout: float = 6.0):
        """
        發送文本訊息到 Lark Webhook
        
        參數:
            text (str): 要發送的訊息內容
            retries (int): 重試次數，預設 2 次
            timeout (float): 請求超時時間（秒），預設 6.0 秒
            
        返回:
            bool: True 表示發送成功，False 表示失敗或未啟用
            
        流程:
        1. 檢查是否啟用（webhook 是否存在）
        2. 建立請求 payload
        3. 發送 POST 請求（帶重試機制）
        4. 檢查回應狀態碼
        
        異常處理:
        - 未啟用：直接返回 False，不記錄敏感資訊
        - 請求失敗：記錄錯誤但不洩露 webhook URL
        - 非 2xx 回應：記錄狀態碼和錯誤訊息（截取前 200 字元）
        - 最終失敗：記錄最後一次錯誤
        
        注意:
        - 不會在日誌中記錄完整的 webhook URL
        - 錯誤訊息會截取前 200 字元以避免過長
        """
        if not self.enabled:
            logging.debug("[Lark] 已停用，略過訊息：%s", text[:60])
            return False

        payload = {"msg_type": "text", "content": {"text": text}}
        last_err = None
        for i in range(retries + 1):
            try:
                r = requests.post(self.webhook, json=payload, timeout=timeout)
                if r.status_code >= 200 and r.status_code < 300:
                    logging.info("[Lark] 推播成功")
                    return True
                else:
                    # 只記錄狀態碼和錯誤訊息，不記錄完整回應（可能包含敏感資訊）
                    error_msg = r.text[:200] if r.text else "無回應內容"
                    logging.warning("[Lark] 非 2xx 回應：%s %s", r.status_code, error_msg)
            except requests.exceptions.Timeout as e:
                last_err = e
                logging.warning("[Lark] 請求逾時 (try %d/%d)：%s", i+1, retries+1, str(e))
            except requests.exceptions.RequestException as e:
                last_err = e
                logging.warning("[Lark] 請求失敗 (try %d/%d)：%s", i+1, retries+1, str(e))
            except Exception as e:
                last_err = e
                logging.warning("[Lark] 未知錯誤 (try %d/%d)：%s", i+1, retries+1, str(e))
            time.sleep(0.8 * (i + 1))  # backoff

        logging.error("[Lark] 最終失敗：%s", last_err)
        return False


class BackendRecordClient:
    """
    後台 gameRecordList API 客戶端：
    - 從 backend_auth.json 熱重載 token / lastlogintime
    - 以時間窗查詢後台戰績，供 HistoryMonitor 對帳
    """

    def __init__(self, lark: "LarkClient", auth_path: Path = BACKEND_AUTH_FILE):
        self.lark = lark
        self.auth_path = auth_path
        self.session = requests.Session()
        self._auth_cache: Dict[str, Any] = {}
        self._auth_mtime: float = 0.0
        self._auth_warned_missing = False
        self._auth_invalid_notified = False

    def _load_auth(self) -> Dict[str, Any]:
        if not self.auth_path.exists():
            if not self._auth_warned_missing:
                logging.warning(
                    "[BackendAPI] 找不到 %s，後台對帳停用（請手動登入後填入 token）",
                    self.auth_path.name
                )
                self._auth_warned_missing = True
            self._auth_cache = {}
            return {}

        try:
            mtime = self.auth_path.stat().st_mtime
            if mtime != self._auth_mtime:
                self._auth_cache = json.loads(self.auth_path.read_text(encoding="utf-8"))
                self._auth_mtime = mtime
                self._auth_warned_missing = False
                logging.info("[BackendAPI] 已重新載入 %s", self.auth_path.name)
        except Exception as e:
            logging.warning("[BackendAPI] 讀取 %s 失敗：%s", self.auth_path.name, e)
            self._auth_cache = {}

        return self._auth_cache

    def _save_auth(self, auth: Dict[str, Any]):
        try:
            self.auth_path.write_text(
                json.dumps(auth, ensure_ascii=False, indent=2),
                encoding="utf-8"
            )
            self._auth_cache = auth
            self._auth_mtime = self.auth_path.stat().st_mtime
        except Exception as e:
            logging.warning("[BackendAPI] 寫入 %s 失敗：%s", self.auth_path.name, e)

    def _build_common_headers(self, auth: Dict[str, Any], *, with_token: bool) -> Dict[str, str]:
        origin = str(auth.get("origin", "https://qat-cp.osmslot.org")).strip()
        referer = str(auth.get("referer", "https://qat-cp.osmslot.org/")).strip()
        user_agent = str(
            auth.get(
                "user_agent",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 Edg/145.0.0.0",
            )
        ).strip()
        headers = {
            "accept": "application/json, text/plain, */*",
            "origin": origin,
            "referer": referer,
            "user-agent": user_agent,
        }
        if with_token:
            headers["token"] = str(auth.get("token", "")).strip()
            headers["lastlogintime"] = str(auth.get("lastlogintime", "")).strip()
        return headers

    def _login_and_refresh_token(self, auth: Dict[str, Any]) -> bool:
        """
        透過 /auth/login 自動取得最新 token，成功後回寫 backend_auth.json。
        支援 login_payload 直接自訂送出的 JSON body。
        """
        base_url = str(auth.get("base_url", "https://backendservertest.osmslot.org")).rstrip("/")
        login_path = str(auth.get("login_path", "/auth/login")).strip() or "/auth/login"
        login_url = f"{base_url}{login_path if login_path.startswith('/') else '/' + login_path}"

        # 優先使用完整 login_payload，避免後端欄位名稱變動造成失敗
        payload = auth.get("login_payload")
        if not isinstance(payload, dict):
            username = str(auth.get("username", "")).strip()
            password = str(auth.get("password", "")).strip()
            if not username or not password:
                logging.warning(
                    "[BackendAPI] 缺少 login_payload 或 username/password，無法自動登入拿 token"
                )
                return False
            payload = {"username": username, "password": password}

        headers = self._build_common_headers(auth, with_token=False)
        headers["content-type"] = "application/json"

        try:
            r = self.session.post(login_url, json=payload, headers=headers, timeout=10)
            if r.status_code != 200:
                logging.warning("[BackendAPI] 自動登入 HTTP %s", r.status_code)
                return False

            resp = r.json()
            if not isinstance(resp, dict) or resp.get("code") != 20000:
                code = resp.get("code") if isinstance(resp, dict) else None
                msg = resp.get("message") if isinstance(resp, dict) else None
                logging.warning("[BackendAPI] 自動登入失敗：code=%s message=%s", code, msg)
                return False

            data = resp.get("data", {}) if isinstance(resp.get("data"), dict) else {}
            new_token = str(data.get("token", "")).strip()
            new_last_login_time = str(data.get("lastLoginTime", "")).strip()
            if not new_token:
                logging.warning("[BackendAPI] 自動登入成功但未取得 token")
                return False

            auth["token"] = new_token
            if new_last_login_time:
                auth["lastlogintime"] = new_last_login_time

            # 若未指定 channelId，從 token 自動推導
            if not str(auth.get("channelId", "")).strip():
                inferred = self._extract_channel_id(new_token)
                if inferred:
                    auth["channelId"] = inferred

            self._save_auth(auth)
            self._auth_invalid_notified = False
            logging.info("[BackendAPI] 自動登入成功，token 已更新")
            return True
        except Exception as e:
            logging.warning("[BackendAPI] 自動登入失敗：%s", e)
            return False

    def _ensure_token(self, auth: Dict[str, Any]) -> Dict[str, Any]:
        # auto_login=true 時每次檢查 token，缺失時自動重登
        auto_login = bool(auth.get("auto_login", True))
        token = str(auth.get("token", "")).strip()
        if token:
            return auth
        if auto_login:
            self._login_and_refresh_token(auth)
            return self._load_auth()
        return auth

    def initialize_auth(self) -> bool:
        """
        啟動時主動檢查/刷新 token，避免等到第一輪對帳才發現登入失敗。
        回傳 True 代表目前已有可用 token。
        """
        auth = self._ensure_token(self._load_auth())
        token = str(auth.get("token", "")).strip()
        if token:
            logging.info("[BackendAPI] 啟動前登入檢查完成（token 就緒）")
            return True
        logging.warning("[BackendAPI] 啟動前登入檢查失敗（token 不可用）")
        return False

    @staticmethod
    def _extract_channel_id(token: str) -> str:
        # token 範例：0000873_1-xxxxxxxx；取 "_" 前數字段並去除前導 0
        m = re.match(r"0*(\d+)_", token or "")
        if m:
            return m.group(1)
        return ""

    def fetch_game_records(
        self,
        start_dt: datetime,
        end_dt: datetime,
        *,
        channel_id: Optional[str] = None,
        player_id: Optional[str] = None,
        page_size: int = 50,
        max_pages: int = 3,
    ) -> List[dict]:
        auth = self._ensure_token(self._load_auth())
        token = str(auth.get("token", "")).strip()
        if not token:
            return []

        base_url = str(auth.get("base_url", "https://backendservertest.osmslot.org")).rstrip("/")
        endpoint = f"{base_url}/egm/reports/gameRecordList"
        channel = (channel_id or auth.get("channelId") or self._extract_channel_id(token) or "873").strip()
        playerstudioid = str(auth.get("playerstudioid", "")).strip() or "cp,wf,tbr,tbp,ncl,bpo,mdr,dhs,cf,np,pf,igo,ALL"
        headers = self._build_common_headers(auth, with_token=True)
        query_player_id = str(player_id or "").strip()
        logging.info(
            "[BackendAPI] 查詢參數: start=%s end=%s channelId=%s playerId=%s playerstudioid=%s pageSize=%d maxPages=%d",
            start_dt.strftime("%Y-%m-%d %H:%M:%S"),
            end_dt.strftime("%Y-%m-%d %H:%M:%S"),
            channel,
            query_player_id or "(empty)",
            playerstudioid,
            page_size,
            max_pages,
        )

        all_items: List[dict] = []
        relogin_retried = False
        for page in range(1, max_pages + 1):
            params = {
                "dateTime[]": [
                    start_dt.strftime("%Y-%m-%d %H:%M:%S"),
                    end_dt.strftime("%Y-%m-%d %H:%M:%S"),
                ],
                "clientMachineName": "",
                "playerId": query_player_id,
                "playerName": "",
                "orderId": "",
                "page": page,
                "pageSize": page_size,
                "dateTimeType": 0,
                "playerstudioid": playerstudioid,
                "bgType": 0,
                "dataType": 0,
                "isall": "false",
                "channelId": channel,
            }

            try:
                prepared_url = requests.Request("POST", endpoint, params=params).prepare().url
                logging.info("[BackendAPI] page=%d request_url=%s", page, prepared_url)
                r = self.session.post(endpoint, params=params, headers=headers, timeout=10)
                if r.status_code != 200:
                    logging.warning("[BackendAPI] HTTP %s", r.status_code)
                    break

                payload = r.json()
                code = payload.get("code")
                msg = payload.get("message") if isinstance(payload, dict) else ""
                logging.info(
                    "[BackendAPI] page=%d 回應: code=%s message=%s",
                    page, code, msg
                )
                if code == 40200:
                    auto_login = bool(auth.get("auto_login", True))
                    if auto_login and not relogin_retried and self._login_and_refresh_token(auth):
                        # 重新讀取 token 後，重試當前頁
                        auth = self._load_auth()
                        headers = self._build_common_headers(auth, with_token=True)
                        relogin_retried = True
                        logging.info("[BackendAPI] 40200 後已自動重登，重試 page=%d", page)
                        r = self.session.post(endpoint, params=params, headers=headers, timeout=10)
                        if r.status_code != 200:
                            logging.warning("[BackendAPI] 重試後 HTTP %s", r.status_code)
                            break
                        payload = r.json()
                        code = payload.get("code")
                        if code == 40200:
                            logging.warning("[BackendAPI] 重試後仍 40200")
                            self._auth_invalid_notified = True
                            break
                    else:
                        if not self._auth_invalid_notified:
                            msg = (
                                f"後台 token 驗證失敗(code=40200)，自動重登失敗，"
                                f"請檢查 {self.auth_path.name} 的登入參數"
                            )
                            logging.warning("[BackendAPI] %s", msg)
                            try:
                                self.lark.send_text(f"[BackendAPI]\n⚠️ {msg}")
                            except Exception:
                                pass
                            self._auth_invalid_notified = True
                        break

                self._auth_invalid_notified = False
                items = payload.get("data", {}).get("items", []) if isinstance(payload, dict) else []
                if isinstance(items, list):
                    logging.info("[BackendAPI] page=%d items=%d", page, len(items))
                if not isinstance(items, list) or not items:
                    break
                all_items.extend(items)
                if len(items) < page_size:
                    break
            except Exception as e:
                logging.warning("[BackendAPI] 查詢失敗：%s", e)
                break

        return all_items

# =========================== 模板比對（OpenCV） ===========================
class TemplateMatcher:
    """
    以 OpenCV 做模板比對。
    ✅ 增強：
      - 支援讀取 templates_manifest.json，依「類型」精準指定模板與門檻
      - 支援每模板專屬 threshold 與可選 mask
      - 仍保留原本 detect()/detect_by_type() 介面以相容舊呼叫
    """

    def __init__(self, template_dir: Path, manifest_path: Optional[Path] = None):
        if not template_dir.is_dir():
            raise RuntimeError(f"找不到模板資料夾: {template_dir}")

        self.template_dir = template_dir

        # ── 載入 manifest（若不存在仍可照舊運作） ──
        self.manifest = None
        if manifest_path is None:
            manifest_path = template_dir.parent / "templates_manifest.json"
        if manifest_path.exists():
            try:
                self.manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                logging.info(f"[Template] 載入 manifest: {manifest_path}")
            except Exception as e:
                logging.error(f"[Template] 讀取 manifest 失敗：{e}")
                self.manifest = None
        else:
            logging.info("[Template] 未找到 manifest，將使用傳統全掃比對")

        # ── 遞迴掃描 templates 目錄，預先載入所有模板影像 ──
        self.templates_all: Dict[str, np.ndarray] = {}
        self.masks_all: Dict[str, Optional[np.ndarray]] = {}

        for p in sorted(template_dir.rglob("*")):
            if p.is_file() and p.suffix.lower() in {".png", ".jpg", ".jpeg"}:
                img = cv2.imread(str(p), cv2.IMREAD_GRAYSCALE)
                if img is not None:
                    self.templates_all[p.name] = img
                else:
                    logging.warning(f"[Template] 載入失敗：{p}")

        # mask 採 lazy 載入：先設 None
        for name in self.templates_all.keys():
            self.masks_all[name] = None

        # 舊介面（無 manifest 時使用）
        self.templates: List[Tuple[str, np.ndarray]] = [(n, self.templates_all[n]) for n in sorted(self.templates_all.keys())]
        logging.info(f"[Template] 可用模板數：{len(self.templates_all)}（有/無 manifest 均可運作）")

    # ---------- 基礎工具 ----------
    def _resolve_mask(self, mask_name: Optional[str]) -> Optional[np.ndarray]:
        """依檔名回傳灰階遮罩（0/255）。不存在或讀取失敗則回 None。"""
        if not mask_name:
            return None
        cached = self.masks_all.get(mask_name, None)
        if cached is not None:
            return cached

        candidates = list(self.template_dir.rglob(mask_name))
        if not candidates:
            logging.warning(f"[Template] 找不到 mask 檔：{mask_name}")
            self.masks_all[mask_name] = None
            return None

        m = cv2.imread(str(candidates[0]), cv2.IMREAD_GRAYSCALE)
        if m is None:
            logging.warning(f"[Template] 讀取 mask 失敗：{mask_name}")
            self.masks_all[mask_name] = None
            return None

        # 二值化（確保為 0/255）
        _, m_bin = cv2.threshold(m, 127, 255, cv2.THRESH_BINARY)
        self.masks_all[mask_name] = m_bin
        return m_bin

    def _find_file_image(self, file_name: str) -> Optional[np.ndarray]:
        """由檔名取出已載入的模板影像"""
        return self.templates_all.get(file_name)

    # ---------- Manifest 驅動偵測 ----------
    def detect_by_manifest(
        self,
        image_bgr: np.ndarray,
        type_name: Optional[str],
        *,
        default_threshold: Optional[float] = None,
        return_report: bool = False,
    ):
        """
        依 manifest 設定只比對指定 type 的模板；回傳 (命中模板名 or None, 報告 or None)
        - 命中邏輯：低於門檻觸發（分數 <= threshold）
        - 命中邏輯：優先用模板 threshold；無則用類型 threshold；再無則用 default_threshold / manifest.default_threshold
        - report=True 會回傳一個 JSON-like dict，包含每模板分數與命中判斷
        - 建議的 templates_manifest.json 例：
          {
            "default_threshold": 0.80,
            "types": {
              "MOREPUFF": {
                "threshold": 0.80,
                "templates": [
                  { "file": "MOREPUFF.png", "threshold": 0.85 },
                  { "file": "MOREPUFF_freeze.png", "mask": "MOREPUFF_mask.png" }
                ]
              }
            }
          }
        """
        if image_bgr is None or image_bgr.size == 0:
            logging.warning("[Template] 輸入影像為空，略過比對")
            return None, None

        # 用來回傳詳細分數資訊（僅在 return_report=True 時有意義）
        report = {"type": type_name, "templates": []}

        if self.manifest is None:
            # 無 manifest：退回舊邏輯（全模板掃描，以 default_threshold 當高分門檻，這裡直接反轉成「低於門檻觸發」也可）
            thr = default_threshold if default_threshold is not None else 0.8
            # 取得最高分模板
            gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
            best_name, best_score = None, float("-inf")
            for name, tpl in self.templates:
                if gray.shape[0] < tpl.shape[0] or gray.shape[1] < tpl.shape[1]:
                    continue
                res = cv2.matchTemplate(gray, tpl, cv2.TM_CCOEFF_NORMED)
                _, max_val, _, _ = cv2.minMaxLoc(res)
                if max_val > best_score:
                    best_name, best_score = name, float(max_val)
            # 低於門檻才觸發
            if best_name is not None and best_score <= thr:
                logging.warning(f"[Template] 低分觸發（無 manifest）：{best_name} score={best_score:.3f} <= thr {thr:.2f}")
                if return_report:
                    report["templates"].append(
                        {"file": best_name, "score": float(best_score), "thr": float(thr), "hit": True}
                    )
                    return best_name, report
                return best_name
            logging.info(f"[Template] 未觸發（無 manifest）：best={best_name} {best_score:.3f} > thr {thr:.2f}")
            if return_report:
                if best_name is not None:
                    report["templates"].append(
                        {"file": best_name, "score": float(best_score), "thr": float(thr), "hit": False}
                    )
                return None, report
            return None

        gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)

        types = self.manifest.get("types", {})
        type_cfg = types.get(type_name or "", {})
        type_threshold = type_cfg.get("threshold", None)
        eff_default_thr = default_threshold if default_threshold is not None else self.manifest.get("default_threshold", 0.8)
        tpl_specs = type_cfg.get("templates", [])

        # ===== 依 when 條件過濾可用模板（方案 B 核心）=====
        # 讓 matcher 能讀到當前 Runner 的設定（由呼叫端注入 self.matcher.cfg）
        rtmp  = getattr(getattr(self, "cfg", None), "rtmp", "") or ""
        title = getattr(getattr(self, "cfg", None), "game_title_code", "") or ""

        def _match_when(cond: Optional[dict]) -> bool:
            if not cond:
                return True
            # 精確比對
            if "rtmp" in cond and cond["rtmp"] != rtmp:
                return False
            if "title" in cond and cond["title"] != title:
                return False
            # 包含判斷（可選）
            contains = cond.get("contains", {})
            if isinstance(contains, dict):
                for k, v in contains.items():
                    src = ""
                    if k == "rtmp":
                        src = rtmp
                    elif k == "title":
                        src = title
                    else:
                        continue
                    if v not in src:
                        return False
            return True
        
        filtered_specs = [s for s in tpl_specs if _match_when(s.get("when"))]
        if not filtered_specs:
            logging.info(f"[Template] 類型 {type_name} 在當前條件下無可用模板（rtmp='{rtmp}', title='{title}'）")
            return None
        
        tpl_specs = filtered_specs
        logging.info(f"[Template] 類型 {type_name}：符合條件模板 {len(tpl_specs)} 張（rtmp='{rtmp}', title='{title}'）")
        # ===== 過濾結束 =====

        if not tpl_specs:
            logging.warning(f"[Template] manifest 中類型 '{type_name}' 沒有模板清單，略過")
            return None
       
        # 逐一比對，任何一張「分數 <= 自己門檻」即觸發
        for spec in tpl_specs:
            file = spec.get("file")
            if not file:
                continue

            tpl_img = self._find_file_image(file)
            if tpl_img is None:
                logging.warning(f"[Template] 找不到模板影像：{file}")
                continue

            # 尺寸檢查
            if gray.shape[0] < tpl_img.shape[0] or gray.shape[1] < tpl_img.shape[1]:
                logging.info(f"[Template] 跳過（畫面比模板小）：{file}")
                continue

            # 取得遮罩（若有）
            mask = self._resolve_mask(spec.get("mask"))

            # 以 TM_CCOEFF_NORMED 比對（OpenCV 4.2+ 支援 mask）
            res = cv2.matchTemplate(gray, tpl_img, cv2.TM_CCOEFF_NORMED, mask=mask)
            _, max_val, _, max_loc = cv2.minMaxLoc(res)

            # 此模板有效門檻（模板 > 類型 > 預設）
            tpl_thr = float(spec.get("threshold", type_threshold if type_threshold is not None else eff_default_thr))
            hit = (max_val <= tpl_thr)  # ★ 低於門檻觸發
            logging.info(f"[Template][{type_name}][{getattr(self, 'current_game', 'NA')}] {file} → score={max_val:.5f} thr={tpl_thr:.2f} hit={hit}")

            if return_report:
                report["templates"].append(
                    {"file": file, "score": float(max_val), "thr": float(tpl_thr), "hit": bool(hit)}
                )

            if hit:
                logging.warning(f"[Template][{type_name}][{getattr(self, 'current_game', 'NA')}] 低分觸發：{file} (score={max_val:.3f} <= thr {tpl_thr:.2f})")
                if return_report:
                    return file, report
                return file
        
        logging.info(f"[Template][{type_name}][{getattr(self, 'current_game', 'NA')}] 未觸發（已比對 {len(tpl_specs)} 張模板）")
        if return_report:
            return None, report
        return None

    def detect_by_manifest_fast(
        self,
        image_bgr: np.ndarray,
        type_name: Optional[str],
        *,
        default_threshold: Optional[float] = None,
        max_templates: int = 2,
    ) -> Optional[str]:
        """
        快速模板比對版本：
        - 限制比對的模板數量
        - 跳過複雜的條件過濾
        - 優化性能，適合超快頻率使用
        """
        if image_bgr is None or image_bgr.size == 0:
            return None

        if self.manifest is None:
            # 無 manifest：使用快速全掃描
            thr = default_threshold if default_threshold is not None else 0.8
            gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
            best_name, best_score = None, float("-inf")
            
            # 限制比對數量
            templates_to_check = list(self.templates.items())[:max_templates]
            for name, tpl in templates_to_check:
                if gray.shape[0] < tpl.shape[0] or gray.shape[1] < tpl.shape[1]:
                    continue
                res = cv2.matchTemplate(gray, tpl, cv2.TM_CCOEFF_NORMED)
                _, max_val, _, _ = cv2.minMaxLoc(res)
                if max_val > best_score:
                    best_name, best_score = name, float(max_val)
            
            if best_name is not None and best_score <= thr:
                return best_name
            return None

        gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
        types = self.manifest.get("types", {})
        type_cfg = types.get(type_name or "", {})
        type_threshold = type_cfg.get("threshold", None)
        eff_default_thr = default_threshold if default_threshold is not None else self.manifest.get("default_threshold", 0.8)
        tpl_specs = type_cfg.get("templates", [])

        if not tpl_specs:
            return None
        
        # 限制比對數量
        tpl_specs = tpl_specs[:max_templates]
        
        # 快速比對（跳過複雜的條件過濾）
        for spec in tpl_specs:
            file = spec.get("file")
            if not file:
                continue

            tpl_img = self._find_file_image(file)
            if tpl_img is None:
                continue

            # 尺寸檢查
            if gray.shape[0] < tpl_img.shape[0] or gray.shape[1] < tpl_img.shape[1]:
                continue

            # 快速比對（不使用 mask）
            res = cv2.matchTemplate(gray, tpl_img, cv2.TM_CCOEFF_NORMED)
            _, max_val, _, _ = cv2.minMaxLoc(res)

            # 此模板有效門檻
            tpl_thr = float(spec.get("threshold", type_threshold if type_threshold is not None else eff_default_thr))
            hit = (max_val <= tpl_thr)
            
            if hit:
                return file
        
        return None
            
        logging.info(f"[Template] 未觸發（類型 {type_name} 的所有模板皆高於各自門檻）")
        return None

    # ---------- 原本 detect_by_type / detect（保留相容） ----------
    def detect_by_type(
        self,
        image_bgr: np.ndarray,
        type_name: Optional[str],
        threshold: float = 0.40,
        log_top_n: int = 0,
        debug: bool = False,
        debug_dir: Optional[Path] = None,
        top_k_boxes: int = 0,
        nms_iou: float = 0.3,
        save_topk_heatmaps: bool = False,
    ) -> Optional[str]:
        """備用舊行為：依類型名稱（以資料夾/前綴推斷）做比對；建議改用 manifest"""
        if image_bgr is None or image_bgr.size == 0:
            return None
        gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)

        # 若未建立 type 索引，退回全掃
        # 這裡簡化：直接用 self.templates（全掃）
        scores = []
        for name, tpl in self.templates:
            if gray.shape[0] < tpl.shape[0] or gray.shape[1] < tpl.shape[1]:
                continue
            res = cv2.matchTemplate(gray, tpl, cv2.TM_CCOEFF_NORMED)
            _, max_val, _, max_loc = cv2.minMaxLoc(res)
            scores.append((name, float(max_val), max_loc))
            if log_top_n == 0:
                logging.info(f"[Template][{type_name or 'ALL'}] {name} → {max_val:.5f}")

        if not scores:
            return None
        best_name, best_score, _ = max(scores, key=lambda x: x[1])
        return best_name if best_score >= threshold else None

    def detect(self, image_bgr: np.ndarray, threshold: float = 0.40, log_top_n: int = 0, debug: bool = False, debug_dir: Optional[Path] = None,) -> Optional[str]:
        """備用舊行為：全模板掃描"""
        if image_bgr is None or image_bgr.size == 0:
            return None
        gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
        scores = []
        for name, tpl in self.templates:
            if gray.shape[0] < tpl.shape[0] or gray.shape[1] < tpl.shape[1]:
                continue
            res = cv2.matchTemplate(gray, tpl, cv2.TM_CCOEFF_NORMED)
            _, max_val, _, _ = cv2.minMaxLoc(res)
            scores.append((name, float(max_val)))
        if not scores:
            return None
        best_name, best_score = max(scores, key=lambda x: x[1])
        return best_name if best_score >= threshold else None


# =========================== FFmpeg 截圖 ===========================
class FFmpegRunner:
    """以 FFmpeg 針對 RTMP 取單張快照；若失敗或逾時回傳 False"""

    def __init__(self, ffmpeg_path: Path):
        self.ffmpeg = ffmpeg_path

    def snapshot(self, rtmp_url: str, output: Path, timeout: float = 5.0) -> bool:
        """
        從 RTMP 串流截取單張畫面
        
        參數:
            rtmp_url (str): RTMP 串流 URL（不記錄到日誌以避免洩露）
            output (Path): 輸出圖片路徑
            timeout (float): 執行超時時間（秒），預設 5.0 秒
            
        返回:
            bool: True 表示截圖成功，False 表示失敗或超時
            
        流程:
        1. 建立 FFmpeg 命令（-frames:v 1 只取單張，-q:v 2 提高品質）
        2. 執行 FFmpeg 子程序
        3. 檢查輸出檔案是否存在
        
        異常處理:
        - 超時：記錄警告並返回 False
        - FFmpeg 執行失敗：記錄警告並返回 False
        - 檔案不存在：返回 False
        
        注意:
        - 不會在日誌中記錄完整的 RTMP URL
        - 使用 subprocess.DEVNULL 隱藏 FFmpeg 輸出
        """
        cmd = [str(self.ffmpeg), "-y", "-i", rtmp_url, "-frames:v", "1", "-q:v", "2", str(output)]
        try:
            import subprocess
            subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout)
            return output.exists()
        except subprocess.TimeoutExpired:
            logging.warning(f"FFmpeg 截圖超時（{timeout}s）")
            return False
        except FileNotFoundError:
            logging.error("找不到 FFmpeg 執行檔")
            return False
        except Exception as e:
            logging.warning(f"FFmpeg 截圖失敗: {e}")
            return False


# =========================== 404 頁面檢測 ===========================
def is_404_page(driver):
    """
    檢測當前頁面是否為 404 錯誤頁面
    
    參數:
        driver: Selenium WebDriver 實例
        
    返回:
        bool: True 表示是 404 頁面，False 表示不是
        
    檢測方法:
        1. 檢查頁面標題（包含 "404" 或 "not found"）
        2. 檢查頁面內容（包含 "404 not found" 或 "nginx/1.20.1"）
        3. 檢查 URL（包含 "404"）
        
    異常處理:
        - 檢測過程中的例外：記錄 debug 日誌並返回 False（保守策略）
        
    注意:
        - 使用保守策略：無法確定時返回 False
        - 避免誤判導致不必要的刷新
    """
    try:
        # 檢查頁面標題
        page_title = driver.title.lower()
        if "404" in page_title or "not found" in page_title:
            logging.warning("🚨 檢測到 404 頁面（通過標題）")
            return True
        
        # 檢查頁面內容
        page_source = driver.page_source.lower()
        if "404 not found" in page_source or "nginx/1.20.1" in page_source:
            logging.warning("🚨 檢測到 404 頁面（通過內容）")
            return True
        
        # 檢查 URL
        current_url = driver.current_url.lower()
        if "404" in current_url:
            logging.warning("🚨 檢測到 404 頁面（通過 URL）")
            return True
        
        return False
        
    except Exception as e:
        logging.debug(f"檢測 404 頁面時發生錯誤: {e}")
        return False


# =========================== 域模型（設定） ===========================
@dataclass
class GameConfig:
    """單一機台／測試目標的設定模型（來自 game_config.json 的一筆）"""
    url: str
    rtmp: Optional[str] = None
    rtmp_url: Optional[str] = None
    game_title_code: Optional[str] = None
    template_type: Optional[str] = None  # ✅ 新增：可直接指定類型（覆蓋推斷）
    # ✅ 只針對特定機器啟用的「錯誤畫面」模板類型（例如 RTMP error 畫面）
    # 未設定時保持舊行為，不會多做任何比對
    error_template_type: Optional[str] = None
    enabled: bool = True
    enable_recording: bool = True  # ✅ 新增：是否啟用錄製功能
    enable_template_detection: bool = True  # ✅ 新增：是否啟用模板偵測（高頻率時可關閉）
    # ✅ 隨機退出功能
    random_exit_enabled: bool = False  # 是否啟用隨機退出
    random_exit_chance: float = 0.02  # 退出機率（例如 0.02 = 2%）
    random_exit_min_spins: int = 50  # 最少 spin 次數（達到這個次數後才可能觸發退出）


# =========================== 歷史戰績監控器 ===========================
class _HistoryMonitorLegacy:
    """
    獨立執行緒：每隔固定秒數透過 Selenium 執行 JS，
    呼叫 window.pinus.request() 撈取歷史戰績，
    並偵測以下異常：
      1. 同一時間點出現多筆紀錄（重複投注異常）
      2. 同機台短時間內投注暴增（spin 卡住重送）
      3. payout 與 win-bet 不一致（資料異常）
      4. win 金額異常高（超過 bet 的 N 倍）
    異常發生時透過 LarkClient 推播通知。
    """

    def __init__(
        self,
        lark: "LarkClient",
        interval: float = 5.0,
        dup_time_threshold: int = 2,     # 同一時間點出現幾筆以上視為異常
        burst_window: int = 5,          # 秒：N 秒內同機台出現幾筆視為暴增
        burst_count: int = 10,            # 同機台 burst_window 秒內超過此筆數視為異常
        win_multiplier: float = 50.0,    # win > bet * N 倍視為異常
        backend_client: Optional["BackendRecordClient"] = None,
        backend_time_tolerance_sec: int = 3,
        backend_scan_window_sec: int = 10,
        backend_margin_sec: int = 5,
    ):
        self.lark = lark
        self.interval = interval
        self.dup_time_threshold = dup_time_threshold
        self.burst_window = burst_window
        self.burst_count = burst_count
        self.win_multiplier = win_multiplier
        self.backend_client = backend_client
        self.backend_time_tolerance_sec = backend_time_tolerance_sec
        self.backend_scan_window_sec = backend_scan_window_sec
        self.backend_margin_sec = backend_margin_sec

        # 已見過的紀錄（key = gmid+time，避免重複處理）
        self._seen: Dict[str, float] = {}           # key -> 首次出現的 epoch
        self._history_initialized = False           # 首輪只建基線，不告警
        # 每台機台的投注時間序列（用於暴增偵測）
        self._gmid_timestamps: Dict[str, List[float]] = {}  # gmid -> [epoch, ...]
        self._anomaly_cooldown_sec = 120                   # 同事件告警冷卻秒數
        self._anomaly_last_sent: Dict[str, float] = {}     # event_key -> last_sent_epoch
        # 後台比對異常去重（避免同筆連續洗版）
        self._backend_mismatch_seen: Dict[str, float] = {}
        self._last_fetch_time = 0.0
        self._drivers: List = []               # 由外部 register_driver 注入
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None

    # ---------- 公開介面 ----------

    def register_driver(self, driver):
        """由 GameRunner 呼叫，將自己的 driver 註冊進來"""
        with self._lock:
            if driver not in self._drivers:
                self._drivers.append(driver)
                logging.info("[HistoryMonitor] 已註冊新 driver，目前共 %d 個", len(self._drivers))

    def unregister_driver(self, driver):
        with self._lock:
            if driver in self._drivers:
                self._drivers.remove(driver)
                logging.info("[HistoryMonitor] 已移除 driver，剩餘 %d 個", len(self._drivers))

    def start(self):
        """啟動背景監控執行緒"""
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(
            target=self._loop,
            name="HistoryMonitorThread",
            daemon=True,
        )
        self._thread.start()
        logging.info("[HistoryMonitor] 監控執行緒已啟動（間隔 %.1fs）", self.interval)

    # ---------- 內部邏輯 ----------

    def _loop(self):
        while not stop_event.is_set():
            time.sleep(self.interval)
            try:
                self._fetch_and_check()
            except Exception as e:
                logging.warning("[HistoryMonitor] 迴圈例外：%s", e)

    def _get_active_driver(self):
        """取一個可用的 driver（優先取第一個有效的）"""
        with self._lock:
            drivers = list(self._drivers)
        for d in drivers:
            try:
                _ = d.current_url   # 簡單探活
                return d
            except Exception:
                pass
        return None

    def _fetch_records(self, driver) -> List[dict]:
        """透過 JS 呼叫 pinus.request，同步等待回應（最多 8 秒）"""
        try:
            # 先嘗試取得 uid（從頁面 JS 環境）
            uid_js = "return (window._uid || (window.pinus && window.pinus.uid) || '');"
            uid = str(driver.execute_script(uid_js) or "").strip()

            # 抓不到 uid 時，從 URL token 解析出 "-" 後段當 userid
            if not uid:
                try:
                    current_url = driver.current_url or ""
                    token = parse_qs(urlparse(current_url).query).get("token", [""])[0]
                    if "-" in token:
                        uid = token.rsplit("-", 1)[1].strip()
                        logging.info("[HistoryMonitor] uid fallback: 由 token 後段取得 userid=%s", uid)
                    else:
                        logging.warning("[HistoryMonitor] uid fallback 失敗：token 缺少 '-'")
                except Exception as parse_err:
                    logging.warning("[HistoryMonitor] uid fallback 失敗：%s", parse_err)

            result = driver.execute_async_script(
                """
                var monitorUid = arguments[0];
                var callback = arguments[arguments.length - 1];
                var p = window.pinus;
                if (!p || typeof p.request !== 'function') { callback([]); return; }
                p.request(
                    'status.statusHandler.historyListReq',
                    {uid: monitorUid || '', pageindex: 0, pagecount: 15},
                    function(res) { callback((res && res.list) ? res.list : []); }
                );
                """,
                uid,
            )
            return result if isinstance(result, list) else []
        except Exception as e:
            logging.debug("[HistoryMonitor] JS 執行失敗：%s", e)
            return []

    def _fetch_and_check(self):
        driver = self._get_active_driver()
        if not driver:
            logging.debug("[HistoryMonitor] 無可用 driver，跳過本輪")
            return

        records = self._fetch_records(driver)
        if not records:
            logging.debug("[HistoryMonitor] 本輪無新資料")
            return

        now = time.time()

        # 首次抓到資料時只建立基線，避免把歷史資料當成新異常
        if not self._history_initialized:
            for rec in records:
                key = f"{rec.get('gmid','')}_{rec.get('time','')}"
                self._seen[key] = now
            self._history_initialized = True
            logging.info("[HistoryMonitor] 首輪初始化完成，已載入 %d 筆歷史紀錄（本輪不做告警）", len(records))
            return

        new_records = []

        for rec in records:
            key = f"{rec.get('gmid','')}_{rec.get('time','')}"
            if key not in self._seen:
                self._seen[key] = now
                new_records.append(rec)

        if new_records:
            logging.info("[HistoryMonitor] 本輪新增 %d 筆紀錄", len(new_records))
            self._detect_anomalies(records, new_records)
            self._compare_with_backend(new_records, driver=driver, scan_epoch=now)

        # 清理超過 5 分鐘的舊 key，避免記憶體無限增長
        cutoff = now - 300
        self._seen = {k: v for k, v in self._seen.items() if v > cutoff}

    @staticmethod
    def _parse_record_time(value: Any) -> Optional[datetime]:
        if value is None:
            return None

        text = str(value).strip()
        if not text:
            return None

        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M:%S.%f"):
            try:
                return datetime.strptime(text, fmt)
            except Exception:
                pass

        try:
            sec = int(float(text))
            if sec > 1_000_000_000_000:
                sec //= 1000
            return datetime.fromtimestamp(sec)
        except Exception:
            return None

    @staticmethod
    def _to_float(value: Any) -> float:
        try:
            return float(value or 0)
        except Exception:
            return 0.0

    def _normalize_front_record(self, rec: dict) -> Optional[dict]:
        rec_time = self._parse_record_time(rec.get("time"))
        if not rec_time:
            return None
        uid = str(rec.get("gmid", "")).strip()
        if not uid:
            return None
        return {
            "uid": uid,
            "gameid": str(rec.get("gameid", "")).strip(),
            "bet": self._to_float(rec.get("bet")),
            "win": self._to_float(rec.get("win")),
            "time": rec_time,
            "time_raw": str(rec.get("time", "")).strip(),
            "order_id": str(rec.get("order_id", "")).strip(),
        }

    def _normalize_backend_record(self, item: dict) -> Optional[dict]:
        rec_time = self._parse_record_time(item.get("date_time") or item.get("bet_time"))
        if not rec_time:
            return None
        uid = str(item.get("uid", "")).strip()
        if not uid:
            return None
        return {
            "uid": uid,
            "gameid": str(item.get("gameid", "")).strip(),
            "bet": self._to_float(item.get("bet")),
            "win": self._to_float(item.get("win")),
            "time": rec_time,
            "time_raw": str(item.get("date_time", "")).strip(),
            "order_id": str(item.get("order_id", "")).strip(),
        }

    def _compare_with_backend(self, new_records: List[dict], *, driver, scan_epoch: float):
        if self.backend_client is None:
            return

        front = [self._normalize_front_record(r) for r in new_records]
        front = [r for r in front if r is not None]
        if not front:
            return

        scan_dt = datetime.fromtimestamp(scan_epoch)
        front_times = [r["time"] for r in front]
        front_min_dt = min(front_times)
        front_max_dt = max(front_times)
        # 以前端新紀錄時間為主查詢後台，避免掃描時間落後造成時間窗錯位
        start_dt = front_min_dt - timedelta(seconds=self.backend_margin_sec)
        end_dt = front_max_dt + timedelta(seconds=self.backend_margin_sec)

        # 優先從 uid 前綴推導 channelId，例如 873-HOTPOT-0101 -> 873
        first_uid = str(front[0]["uid"])
        m = re.match(r"^(\d+)-", first_uid)
        channel_id = m.group(1) if m else None
        player_id = None
        try:
            current_url = driver.current_url or ""
            token = parse_qs(urlparse(current_url).query).get("token", [""])[0]
            if "-" in token:
                player_id = token.rsplit("-", 1)[1].strip()
        except Exception:
            player_id = None

        backend_items = self.backend_client.fetch_game_records(
            start_dt=start_dt,
            end_dt=end_dt,
            channel_id=channel_id,
            player_id=player_id,
        )
        raw_backend_count = len(backend_items)
        logging.info(
            "[HistoryMonitor] 後台比對查詢: scan=%s front_range=%s~%s margin=±%ss channelId=%s playerId=%s front=%d",
            scan_dt.strftime("%Y-%m-%d %H:%M:%S"),
            front_min_dt.strftime("%Y-%m-%d %H:%M:%S"),
            front_max_dt.strftime("%Y-%m-%d %H:%M:%S"),
            self.backend_margin_sec,
            channel_id or "(none)",
            player_id or "(none)",
            len(front),
        )
        backend = [self._normalize_backend_record(x) for x in backend_items]
        backend = [r for r in backend if r is not None]
        logging.info(
            "[HistoryMonitor] 後台資料解析: raw_items=%d normalized_items=%d",
            raw_backend_count,
            len(backend),
        )
        if raw_backend_count > 0 and len(backend) == 0:
            sample_raw = backend_items[:3]
            sample_text = " | ".join(
                f"uid={str(x.get('uid',''))} date_time={str(x.get('date_time',''))} bet_time={str(x.get('bet_time',''))}"
                for x in sample_raw if isinstance(x, dict)
            )
            logging.warning("[HistoryMonitor] 後台資料全數解析失敗 sample=%s", sample_text or "(empty)")
        if not backend:
            sample_front = ", ".join(
                f"{r['uid']}@{r['time_raw']}"
                for r in front[:3]
            )
            logging.info(
                "[HistoryMonitor] 後台比對：查無資料（%s ~ %s） sample_front=%s",
                start_dt, end_dt, sample_front or "(empty)"
            )
            return

        used_idx: set = set()
        unmatched_front: List[dict] = []
        compare_lines: List[str] = []
        tol = self.backend_time_tolerance_sec

        for idx, fr in enumerate(front, start=1):
            match_idx = None
            # 1) 若雙方都有 order_id，優先精準比對
            if fr["order_id"]:
                for i, br in enumerate(backend):
                    if i in used_idx:
                        continue
                    if br["order_id"] and br["order_id"] == fr["order_id"]:
                        match_idx = i
                        break

            # 2) fallback: uid + bet + win + time 容差
            if match_idx is None:
                for i, br in enumerate(backend):
                    if i in used_idx:
                        continue
                    if br["uid"] != fr["uid"]:
                        continue
                    if fr["gameid"] and br["gameid"] and fr["gameid"] != br["gameid"]:
                        continue
                    if abs(br["bet"] - fr["bet"]) > 0.01:
                        continue
                    if abs(br["win"] - fr["win"]) > 0.01:
                        continue
                    if abs((br["time"] - fr["time"]).total_seconds()) > tol:
                        continue
                    match_idx = i
                    break

            if match_idx is None:
                unmatched_front.append(fr)
                compare_lines.append(
                    f"{idx}. [UNMATCH] uid={fr['uid']} time={fr['time_raw']} "
                    f"bet={fr['bet']:.0f} win={fr['win']:.0f} order_id={fr['order_id'] or '(none)'}"
                )
            else:
                used_idx.add(match_idx)
                br = backend[match_idx]
                delta_sec = int((br["time"] - fr["time"]).total_seconds())
                compare_lines.append(
                    f"{idx}. [MATCH] uid={fr['uid']} front_time={fr['time_raw']} "
                    f"backend_time={br['time_raw']} diff={delta_sec}s "
                    f"bet={fr['bet']:.0f}/{br['bet']:.0f} win={fr['win']:.0f}/{br['win']:.0f} "
                    f"order_id={fr['order_id'] or '(none)'}"
                )

        if compare_lines:
            logging.info("[HistoryMonitor] 後台逐筆比對結果:\n%s", "\n".join(compare_lines))

        if not unmatched_front:
            logging.info("[HistoryMonitor] 後台比對 OK：逐筆皆匹配")
            return

        now = time.time()
        fresh_mismatches: List[dict] = []
        for r in unmatched_front:
            key = f"{r['uid']}|{r['time_raw']}|{r['bet']}|{r['win']}"
            if key in self._backend_mismatch_seen and now - self._backend_mismatch_seen[key] < 120:
                continue
            self._backend_mismatch_seen[key] = now
            fresh_mismatches.append(r)

        # 清理過舊去重 key
        self._backend_mismatch_seen = {
            k: v for k, v in self._backend_mismatch_seen.items() if now - v < 600
        }

        if not fresh_mismatches:
            return

        sample = fresh_mismatches[:3]
        detail = "\n".join(
            f"  uid={r['uid']} time={r['time_raw']} bet={r['bet']:.0f} win={r['win']:.0f}"
            for r in sample
        )
        msg = (
            f"⚠️ [後台比對異常] 前端 {len(fresh_mismatches)} 筆在後台未匹配\n"
            f"比對窗：{start_dt.strftime('%Y-%m-%d %H:%M:%S')} ~ {end_dt.strftime('%Y-%m-%d %H:%M:%S')}\n"
            f"{detail}"
        )
        logging.warning("[HistoryMonitor] %s", msg)
        try:
            self.lark.send_text(f"[HistoryMonitor]\n{msg}")
        except Exception as e:
            logging.warning("[HistoryMonitor] 後台比對推播失敗：%s", e)

    def _detect_anomalies(self, all_records: List[dict], new_records: List[dict]):
        anomalies: List[Tuple[str, str]] = []
        now = time.time()
        scan_time = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now))

        # ── 1. 同一時間點重複筆數偵測 ──
        # 加上 win（以及 gmid/bet）一起判斷，避免同秒不同結果被誤判重複。
        dup_counter: Dict[Tuple[str, str, str, str], List[dict]] = {}
        for rec in all_records:
            t = str(rec.get("time", ""))
            gmid = str(rec.get("gmid", ""))
            bet = str(rec.get("bet", ""))
            win = str(rec.get("win", ""))
            dup_counter.setdefault((t, gmid, bet, win), []).append(rec)

        for (t, gmid, bet, win), recs in dup_counter.items():
            if len(recs) >= self.dup_time_threshold:
                anomalies.append(
                    (
                        f"dup_time:{t}:{gmid}:{bet}:{win}",
                        f"⚠️ [重複時間] 掃描時間={scan_time} | {t} 出現 {len(recs)} 筆相同時間+win紀錄\n"
                        + "\n".join(
                            f"  gmid={r.get('gmid')} bet={r.get('bet')} win={r.get('win')}"
                            for r in recs
                        )
                    )
                )

        # ── 2. 同機台短時間內投注暴增偵測 ──
        # 正常 spin 間隔至少 1 秒以上，若 N 秒內同機台出現大量筆數代表異常
        for rec in new_records:
            gmid = rec.get("gmid", "")
            if not gmid:
                continue
            # 加入本筆的撈取時間
            self._gmid_timestamps.setdefault(gmid, []).append(now)
            # 只保留 burst_window 秒內的記錄
            cutoff = now - self.burst_window
            self._gmid_timestamps[gmid] = [
                t for t in self._gmid_timestamps[gmid] if t >= cutoff
            ]
            count = len(self._gmid_timestamps[gmid])
            if count >= self.burst_count:
                anomalies.append(
                    (
                        f"burst:{gmid}:{self.burst_window}:{self.burst_count}",
                        f"⚠️ [暴增異常] 掃描時間={scan_time} | gmid={gmid} 在 {self.burst_window}s 內出現 {count} 筆"
                        f"（門檻={self.burst_count}）\n"
                        f"  最新：bet={rec.get('bet')} win={rec.get('win')} time={rec.get('time')}"
                    )
                )

        # ── 3. payout 一致性檢查 ──
        # 實務上 payout 常見為「純盈利」(max(win-bet, 0))，
        # 且部分環境會固定回傳 0 代表此欄位未提供，需避免誤報。
        for rec in new_records:
            try:
                bet = float(rec.get("bet", 0) or 0)
                win = float(rec.get("win", 0) or 0)
                payout = float(rec.get("payout", 0) or 0)

                # 多數遊戲 payout 不接受負值，改以純盈利作為預期值
                expected_payout = max(win - bet, 0)

                # payout=0 且實際沒有盈利時屬正常（避免輸家局誤報）
                if payout == 0 and win <= bet:
                    continue

                # payout=0 但有盈利，通常代表欄位未提供；跳過此筆避免洗版
                if payout == 0 and win > bet:
                    continue

                # 允許 1 元誤差（浮點數問題）
                if bet > 0 and abs(payout - expected_payout) > 1:
                    anomalies.append(
                        (
                            f"payout:{rec.get('gmid')}:{rec.get('time')}:{bet}:{win}:{payout}",
                            f"⚠️ [payout 異常] gmid={rec.get('gmid')} time={rec.get('time')}\n"
                            f"  bet={bet} win={win} payout={payout}"
                            f"（預期 payout={expected_payout:.0f}，差異={payout - expected_payout:.0f}）"
                        )
                    )
            except Exception:
                pass

        # ── 4. 異常高倍 win 偵測 ──
        for rec in new_records:
            try:
                bet = float(rec.get("bet", 0) or 0)
                win = float(rec.get("win", 0) or 0)
                if bet > 0 and win > bet * self.win_multiplier:
                    anomalies.append(
                        (
                            f"high_win:{rec.get('gmid')}:{rec.get('time')}:{bet}:{win}",
                            f"💰 [高倍 win] gmid={rec.get('gmid')} 遊戲={rec.get('gameid')}\n"
                            f"  bet={bet} win={win} ({win/bet:.1f}x，門檻={self.win_multiplier}x)"
                            f" time={rec.get('time')}"
                        )
                    )
            except Exception:
                pass

        # ── 推播所有異常 ──
        for event_key, msg in anomalies:
            last_sent = self._anomaly_last_sent.get(event_key, 0.0)
            if now - last_sent < self._anomaly_cooldown_sec:
                logging.info(
                    "[HistoryMonitor] 告警冷卻中，略過重複事件 key=%s（%.0fs < %ss）",
                    event_key,
                    now - last_sent,
                    self._anomaly_cooldown_sec,
                )
                continue
            self._anomaly_last_sent[event_key] = now
            logging.warning("[HistoryMonitor] %s", msg)
            try:
                self.lark.send_text(f"[HistoryMonitor]\n{msg}")
            except Exception as e:
                logging.warning("[HistoryMonitor] Lark 推播失敗：%s", e)

        # 清理過舊冷卻記錄，避免記憶體累積
        self._anomaly_last_sent = {
            k: v for k, v in self._anomaly_last_sent.items()
            if now - v < self._anomaly_cooldown_sec * 3
        }

        # ── 正常摘要 log ──
        if not anomalies and new_records:
            summary = (
                f"[HistoryMonitor] ✅ 新增 {len(new_records)} 筆，無異常 | "
                f"最新：{new_records[0].get('time')} "
                f"bet={new_records[0].get('bet')} win={new_records[0].get('win')}"
            )
            logging.info(summary)


# 全域單例（在 main() 中初始化）
_history_monitor: Optional[HistoryMonitor] = None


# =========================== 遊戲執行器 ===========================
def infer_template_type(game_title_code: Optional[str], keyword_actions: Dict[str, List[str]], machine_actions: Dict[str, Tuple[List[str], bool]]) -> Optional[str]:
    """
    從 game_title_code 內含的關鍵字，推斷模板 type。
    先看 machine_actions 的 key，再看 keyword_actions 的 key；第一個命中的就回傳。
    """
    if not game_title_code:
        return None
    for kw in machine_actions.keys():
        if kw and kw in game_title_code:
            return kw
    for kw in keyword_actions.keys():
        if kw and kw in game_title_code:
            return kw
    return None


class GameRunner:
    """
    掌管單一機台的整個流程：
    - 啟動 Edge，進入 URL
    - 在 Lobby 找遊戲卡片 -> Join
    - 迴圈地：檢查餘額 -> 點擊 Spin -> 特殊流程 -> RTMP 偵測
    """

    def __init__(
        self,
        config: GameConfig,
        matcher: TemplateMatcher,
        ffmpeg: FFmpegRunner,
        lark: LarkClient,
        keyword_actions: Dict[str, List[str]],
        machine_actions: Dict[str, Tuple[List[str], bool]],
        bet_random_config: Optional[Dict[str, List[str]]] = None,  # ✅ bet_random 配置
    ):
        self.cfg = config
        self.matcher = matcher
        self.ffmpeg = ffmpeg
        self.lark = lark
        self.keyword_actions = keyword_actions          # ex: {"BULL": ["X1","X2"]}
        self.machine_actions = machine_actions          # ex: {"BULL": (["X1","X2"], True)}
        self.bet_random_config = bet_random_config or {}  # ✅ bet_random 配置
        self.driver = None
        self._rec_proc = None          # type: Optional[subprocess.Popen]
        self._rec_end_at = 0.0         # 錄影結束時間（epoch 秒）
        self._rec_name = None          # 正在錄的檔名前綴（rtmp 名稱）
        self._auto_pause = False   # 只暫停本 GameRunner，不影響別台
        self._last_balance = None      # 記錄上次的餘額，用於檢測變化
        self._no_change_count = 0      # 記錄連續無變化的次數
        self._check_interval = 10      # 每 10 次檢查一次
        self._spin_count = 0          # 用於間隔檢測的計數器
        self._last_404_check_time = 0.0  # 上次 404 檢測的時間戳
        self._404_check_interval = 30.0  # 404 檢測間隔（秒）
        self.logger = None  # 執行緒專屬的 logger（在 run 方法中初始化）
        self.log_file_handler = None  # 用於在 finally 中關閉
        self._total_spins = 0  # ✅ 總 spin 次數（用於 random_exit）

        # ✅ 依 game_config 指定或 game_title_code 推斷模板類型，供比對時只用該類型模板
        self.template_type: Optional[str] = (
            config.template_type or infer_template_type(config.game_title_code, keyword_actions, machine_actions)
        )
        logging.info(f"[Template] 類型設定：game='{config.game_title_code}' → type='{self.template_type}'")

        # ✅ 針對個別機器額外指定「錯誤畫面」專用模板類型
        # 若未設定，則維持原本只用 self.template_type 的流程
        self.error_template_type: Optional[str] = getattr(config, "error_template_type", None)
        if self.error_template_type:
            logging.info(
                f"[Template] 錯誤畫面類型設定：game='{config.game_title_code}' → error_type='{self.error_template_type}'"
            )

        # ✅ HistoryMonitor：driver 就緒後再 register（在 run() 中處理）

    # ----------------- 404 頁面檢測與刷新 -----------------
    def _check_and_refresh_if_404(self):
        """
        定時檢測 404 頁面並自動刷新
        
        流程:
        1. 檢查是否到達檢測間隔（預設 30 秒）
        2. 檢測當前頁面是否為 404（檢查標題、內容、URL）
        3. 若為 404，執行刷新流程：
           - 先嘗試 refresh()
           - 若仍為 404，重新載入原始 URL
           - 驗證是否成功恢復
        
        返回:
            bool: True 表示執行過刷新，False 表示未到達檢測時間或無需刷新
            
        異常處理:
        - 檢測過程中的例外：記錄錯誤並返回 False
        - 刷新過程中的例外：記錄錯誤並返回 False
        
        注意:
        - 不會在日誌中記錄完整的 URL
        - 只記錄 RTMP 名稱（如果有的話）
        """
        try:
            current_time = time.time()
            
            # 檢查是否到達檢測間隔
            if current_time - self._last_404_check_time < self._404_check_interval:
                return False  # 尚未到達檢測時間
            
            # 更新檢測時間
            self._last_404_check_time = current_time
            
            # 檢測 404 頁面
            if is_404_page(self.driver):
                logging.warning(f"🚨 [{self.cfg.rtmp or 'Unknown'}] 檢測到 404 頁面，準備刷新...")
                
                # 刷新頁面
                try:
                    self.driver.refresh()
                    logging.info(f"✅ [{self.cfg.rtmp or 'Unknown'}] 頁面已刷新")
                    time.sleep(3.0)  # 等待頁面加載
                    
                    # 再次檢測是否還是 404
                    if is_404_page(self.driver):
                        logging.error(f"❌ [{self.cfg.rtmp or 'Unknown'}] 刷新後仍然是 404 頁面")
                        
                        # 嘗試重新加載原始 URL
                        logging.info(f"🔄 [{self.cfg.rtmp or 'Unknown'}] 嘗試重新加載原始 URL...")
                        self.driver.get(self.cfg.url)
                        time.sleep(3.0)  # 等待頁面加載
                        
                        if is_404_page(self.driver):
                            logging.error(f"❌ [{self.cfg.rtmp or 'Unknown'}] 重新加載後仍然是 404 頁面")
                        else:
                            logging.info(f"✅ [{self.cfg.rtmp or 'Unknown'}] 重新加載成功")
                    else:
                        logging.info(f"✅ [{self.cfg.rtmp or 'Unknown'}] 刷新成功，頁面正常")
                    
                    return True
                    
                except Exception as e:
                    logging.error(f"❌ [{self.cfg.rtmp or 'Unknown'}] 刷新頁面時發生錯誤: {e}")
                    return False
            else:
                logging.debug(f"✅ [{self.cfg.rtmp or 'Unknown'}] 頁面正常，無需刷新")
                return False
                
        except Exception as e:
            logging.error(f"❌ [{self.cfg.rtmp or 'Unknown'}] 檢測 404 頁面時發生錯誤: {e}")
            return False

    # ----------------- 瀏覽器建立 -----------------
    def _build_driver(self):
        """
        建立與回傳 Edge WebDriver
        
        流程：
        1. 設定 Edge 選項（User-Agent、視窗大小、無痕模式）
        2. 優先使用同目錄的 msedgedriver.exe
        3. 若不存在，嘗試使用 webdriver_manager 自動下載
        4. 建立 WebDriver 並載入遊戲 URL
        
        返回:
            webdriver.Edge: 已載入遊戲 URL 的 WebDriver 實例
            
        異常:
            RuntimeError: 找不到 msedgedriver.exe 且未安裝 webdriver_manager
            Exception: 瀏覽器啟動或載入 URL 失敗
        """
        edge_options = webdriver.EdgeOptions()
        # 偽裝 iPhone UA（頁面走行動版流程）
        edge_options.add_argument(
            "--user-agent=Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.127 Mobile Safari/537.36"
        )
        edge_options.add_argument("--window-size=432,859")
        edge_options.add_argument("--incognito")

        try:
            if EDGEDRIVER_EXE.exists():
                service = Service(executable_path=str(EDGEDRIVER_EXE))
            else:
                if EdgeChromiumDriverManager is None:
                    raise RuntimeError("找不到 msedgedriver.exe，且未安裝 webdriver_manager")
                path = EdgeChromiumDriverManager().install()
                service = Service(executable_path=path)

            drv = webdriver.Edge(service=service, options=edge_options)
            # 載入 URL（不記錄完整 URL 以避免洩露敏感資訊）
            drv.get(self.cfg.url)
            logging.info(f"瀏覽器已載入遊戲 URL（rtmp={self.cfg.rtmp or 'N/A'}）")
            return drv
        except RuntimeError:
            raise
        except Exception as e:
            logging.error(f"建立或載入瀏覽器時發生錯誤: {e}")
            raise
    
    def _is_recording_active(self) -> bool:
        """
        檢查目前是否有錄影進行中
        
        返回:
            bool: True 表示錄影進行中，False 表示未錄影或已結束
            
        流程:
        1. 檢查錄影程序是否存在
        2. 檢查程序是否仍在運行（poll() 返回 None 表示運行中）
        3. 若程序已結束，清理內部狀態
        
        注意:
        - 程序結束後會自動清理狀態，無需手動調用清理函數
        """
        if self._rec_proc is None:
            return False
        try:
            if self._rec_proc.poll() is None:
                return True
        except Exception as e:
            logging.debug(f"檢查錄影程序狀態時發生錯誤: {e}")
            # 程序可能已異常終止，清理狀態
            self._rec_proc = None
            self._rec_end_at = 0.0
            self._rec_name = None
            return False
        # 程序已結束，清掉狀態
        self._rec_proc = None
        self._rec_end_at = 0.0
        self._rec_name = None
        return False
    
    def _start_recording(self, name: str, url: str, duration_sec: int = 120, ts: Optional[str] = None) -> None:
        """
        使用 FFmpeg 錄製 RTMP 串流
        
        參數:
            name (str): 錄影檔名前綴（通常是 RTMP 名稱）
            url (str): RTMP 串流 URL
            duration_sec (int): 錄影時長（秒），預設 120 秒
            ts (Optional[str]): 時間戳，用於檔案命名。若為 None，自動生成
            
        流程:
        1. 檢查是否啟用錄製功能
        2. 生成輸出檔案路徑
        3. 建立 FFmpeg 命令（H.264 + AAC 編碼）
        4. 啟動 FFmpeg 子程序
        5. 記錄錄影狀態（程序、結束時間、檔名）
        6. 推播 Lark 通知（可選）
        
        異常處理:
        - 錄製功能停用：直接返回，不執行錄影
        - FFmpeg 啟動失敗：記錄錯誤，不拋出例外（避免中斷主流程）
        """
        # 檢查是否啟用錄製功能
        if not self.cfg.enable_recording:
            logging.info(f"[{name}] 錄製功能已停用，跳過錄影")
            return
            
        if ts is None:
            ts = time.strftime("%Y%m%d_%H%M%S")
        out_mp4 = SCREENSHOT_RTMP / f"{name}_{ts}.mp4"
        cmd = [
            str(FFMPEG_EXE), "-y",
             
            # —— Input 調優 —— 
            "-fflags", "nobuffer",
            "-rtmp_live", "live",
            "-i", url,
        
            # —— 目標時長 —— 
            "-t", str(duration_sec),
            
            # —— 重新編碼（低延遲、關鍵幀密度）——
            "-c:v", "libx264",
            "-preset", "veryfast",           # 或 ultrafast（更省 CPU / 畫質稍差）
            "-tune", "zerolatency",
            "-pix_fmt", "yuv420p",
            "-g", "25",                      # 25fps ≈ 每 1 秒一個 I 幀（依來源 fps 調整）
            "-keyint_min", "25",
            "-sc_threshold", "0",            # 固定 GOP，避免 scene-cut 打破 keyframe 間距
            
            "-c:a", "aac",
            "-b:a", "128k",
            
            # —— MP4 容器 —— 
            "-movflags", "+faststart",
            "-f", "mp4",
            
            str(out_mp4),
            ]

        try:
            self._rec_proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self._rec_end_at = time.time() + duration_sec
            self._rec_name = name
            logging.warning(f"[Record] 開始錄影 {duration_sec}s → {out_mp4.name}")

            # 記錄錄影開始時間，後面 spin_forever 會用
            self._rec_started_at = time.time()
            # 可選：推播開始錄影（不包含完整路徑，避免洩露系統路徑）
            try:
                self.lark.send_text(f"📹 [{name}] 開始錄影 {duration_sec}s：{out_mp4.name}")
            except Exception as e:
                logging.debug(f"推播錄影通知失敗: {e}")
        except FileNotFoundError as e:
            logging.error(f"[Record] 找不到 FFmpeg 執行檔: {e}")
        except subprocess.SubprocessError as e:
            logging.error(f"[Record] FFmpeg 子程序啟動失敗: {e}")
        except Exception as e:
            logging.error(f"[Record] 無法啟動 FFmpeg 錄影: {e}\n{traceback.format_exc()}")

    def _maybe_cleanup_finished_recording(self):
        """如果錄影已結束，清理內部狀態（非必要，但讓狀態即時）"""
        if self._rec_proc is not None and self._rec_proc.poll() is not None:
            logging.info("[Record] 錄影結束")
            self._rec_proc = None
            self._rec_end_at = 0.0
            self._rec_name = None


    # ----------------- Lobby / Join 流程 -----------------
    def scroll_and_click_game(self, game_title_code: str) -> bool:
        """
        從大廳進入指定遊戲
        
        參數:
            game_title_code (str): 遊戲標題代碼，用於匹配遊戲卡片
            
        返回:
            bool: True 表示成功進入遊戲（或已在遊戲中），False 表示失敗
            
        流程:
        1. 檢查是否已在遊戲中（尋找 Spin 按鈕）
        2. 在大廳尋找包含 game_title_code 的遊戲卡片
        3. 滾動到卡片並點擊
        4. 尋找並點擊 Join 按鈕（如果存在）
        5. 執行 keyword_actions（如果匹配到關鍵字）
        
        異常處理:
        - 找不到遊戲卡片：記錄警告並返回 False
        - Join 按鈕不存在：視為正常情況，繼續流程
        - 點擊失敗：記錄錯誤但不拋出例外
        - keyword_actions 執行失敗：記錄警告但不中斷流程
        
        注意:
        - Join 按鈕可能不會每次出現，這是正常情況
        - 即使 Join 失敗，也會嘗試執行 keyword_actions
        """
        try:
            # ✅ 先檢查是否已在遊戲中，避免不必要的等待
            if self._is_in_game():
                logging.info(f"已在遊戲中，跳過大廳查找步驟（game_title_code: {game_title_code}）")
                return True
            
            # 等待頁面穩定（給頁面一些時間載入）
            time.sleep(1.0)
            
            # 嘗試查找大廳元素，如果超時則可能是頁面結構改變或不在大廳
            try:
                items = wait_for_all(self.driver, By.ID, "grid_gm_item", timeout=10)
            except TimeoutException:
                # 超時時，再次檢查是否在遊戲中（可能頁面已經跳轉）
                if self._is_in_game():
                    logging.info(f"等待大廳元素時超時，但檢測到已在遊戲中（game_title_code: {game_title_code}）")
                    return True
                else:
                    # 真的找不到大廳元素，記錄詳細錯誤
                    current_url = self.driver.current_url[:100] if self.driver.current_url else "N/A"
                    page_title = self.driver.title[:50] if self.driver.title else "N/A"
                    logging.warning(
                        f"找不到大廳元素 'grid_gm_item'（超時 10 秒）\n"
                        f"  當前 URL: {current_url}\n"
                        f"  頁面標題: {page_title}\n"
                        f"  可能原因：1) 不在大廳頁面 2) 頁面結構改變 3) 頁面載入失敗"
                    )
                    return False
            for item in items:
                title = item.get_attribute("title")
                if title and game_title_code in title:
                    if not safe_click(self.driver, item):
                        continue
                    logging.info(f"點擊遊戲卡片: {title}")
                    time.sleep(1.2)

                    # Join 按鈕不一定是卡片內部 DOM；改抓全局 gm-info-box
                    # 注意：Join 按鈕可能不會每次出現，這是正常的
                    try:
                        join_btns = wait_for_all(
                            self.driver,
                            By.XPATH,
                            "//div[contains(@class, 'gm-info-box')]//span[normalize-space(text())='Join']",
                            timeout=3,  # 縮短超時時間，快速判斷是否存在
                        )
                        for btn in join_btns:
                            try:
                                if btn.is_displayed() and safe_click(self.driver, btn):
                                    logging.info("點擊 Join 進入遊戲")
                                    time.sleep(3.0)
                                    break
                            except Exception as e:
                                # 處理 stale element reference 或其他錯誤，直接跳過
                                logging.debug(f"點擊 Join 時發生錯誤（已跳過）: {e}")
                    except TimeoutException:
                        # Join 按鈕不存在是正常的，直接跳過
                        logging.info("Join 按鈕未出現（這是正常的），跳過 Join 步驟")
                    except Exception as e:
                        # 其他錯誤也直接跳過，不重試
                        logging.info(f"Join 按鈕查找失敗（已跳過）: {e}")
                    
                    # ✅ 無論 Join 是否成功，都嘗試執行 keyword_actions
                    # 因為可能已經通過其他方式進入遊戲（例如直接點擊卡片就進入）
                    if game_title_code:
                        for kw, positions in self.keyword_actions.items():
                            if kw in game_title_code:
                                logging.info(f"嘗試執行 keyword_actions: {kw} -> {positions}")
                                try:
                                    # 等待一下確保頁面穩定
                                    time.sleep(1.0)
                                    self.click_multiple_positions(positions)
                                    logging.info(f"✅ keyword_actions 執行成功: {kw} -> {positions}")
                                    time.sleep(1.0)
                                except Exception as kw_err:
                                    logging.warning(f"執行 keyword_actions 時發生錯誤: {kw_err}")
                                break  # 只執行第一個匹配的關鍵字
                    
                    # 無論 Join 是否成功，都返回 True 讓流程繼續
                    return True
                        
            logging.warning(f"大廳找不到遊戲: {game_title_code}")
        except Exception as e:
            logging.error(f"scroll_and_click_game 失敗: {e}")
            import traceback
            logging.error(traceback.format_exc())
        return False

    def click_multiple_positions(self, positions: List[str], click_take: bool = False):
        """
        依序點擊多個座標位置
        
        參數:
            positions (List[str]): 座標清單，格式為 ["X,Y", "X,Y", ...]
            click_take (bool): 是否在點擊完所有座標後，額外點擊 Take 按鈕，預設 False
            
        流程:
        1. 依序遍歷 positions 清單
        2. 對每個座標，尋找頁面上文字內容為該座標的 span 元素
        3. 點擊找到的元素
        4. 若 click_take=True，額外點擊 Take 按鈕
        
        異常處理:
        - 找不到座標元素：記錄警告但繼續下一個座標
        - 點擊失敗：記錄警告但繼續下一個座標
        - Take 按鈕不存在：靜默失敗（不記錄錯誤）
        
        注意:
        - 座標格式為 "X,Y"（例如："5,32"）
        - 每個座標點擊後等待 0.2 秒
        - 即使部分座標失敗，也會繼續執行剩餘座標
        """
        for pos in positions:
            try:
                elems = wait_for_all(self.driver, By.XPATH, f"//span[normalize-space(text())='{pos}']", timeout=2.5)
                if elems:
                    safe_click(self.driver, elems[0])
                    logging.info(f"已點擊座標位: {pos}")
                    time.sleep(0.4)
            except TimeoutException:
                logging.warning(f"找不到座標位 {pos}（超時 2.5 秒）")
            except Exception as e:
                logging.warning(f"點擊座標位 {pos} 時發生錯誤: {e}")

        if click_take:
            try:
                take_btn = WebDriverWait(self.driver, 3).until(
                    EC.element_to_be_clickable((By.CSS_SELECTOR, ".my-button.btn_take"))
                )
                safe_click(self.driver, take_btn)
                logging.info("已點擊 Take 按鈕")
            except TimeoutException:
                logging.debug("找不到 Take 按鈕（超時 3 秒）")
            except Exception as e:
                logging.warning(f"點擊 Take 按鈕時發生錯誤: {e}")

    def _execute_bet_random(self, game_title_code: Optional[str]) -> bool:
        """
        執行 bet_random：在 Spin 後隨機點擊下注按鈕
        
        參數:
            game_title_code (Optional[str]): 遊戲標題代碼，用於匹配 bet_random 配置
            
        返回:
            bool: True 表示成功執行，False 表示未執行或失敗
            
        流程:
        1. 檢查是否有 bet_random 配置
        2. 30% 機率觸發（可調整）
        3. 根據 game_title_code 匹配配置
        4. 從配置的 selectors 中隨機選擇一個點擊
        """
        if not self.bet_random_config or not game_title_code:
            return False
        
        # 30% 機率觸發
        if np.random.random() > 0.3:
            return False
        
        # 查找匹配的配置
        matched_selectors = None
        
        # 優先匹配完整的 game_title_code
        if game_title_code in self.bet_random_config:
            config_value = self.bet_random_config[game_title_code]
            if isinstance(config_value, list):
                matched_selectors = config_value
            elif isinstance(config_value, dict) and "selectors" in config_value:
                matched_selectors = config_value["selectors"]
        else:
            # 嘗試部分字串匹配
            for key, value in self.bet_random_config.items():
                if key in game_title_code:
                    if isinstance(value, list):
                        matched_selectors = value
                    elif isinstance(value, dict) and "selectors" in value:
                        matched_selectors = value["selectors"]
                    break
        
        if not matched_selectors:
            return False
        
        # 隨機選擇一個 selector 並點擊
        try:
            selected_selector = np.random.choice(matched_selectors)
            log = self.logger if self.logger else logging
            log.info(f"[BetRandom] 隨機選擇下注按鈕: {selected_selector}")
            
            # 判斷是 XPath 還是 CSS Selector
            if selected_selector.startswith("//"):
                # XPath
                elements = self.driver.find_elements(By.XPATH, selected_selector)
            else:
                # CSS Selector
                elements = self.driver.find_elements(By.CSS_SELECTOR, selected_selector)
            
            if elements:
                # 找到多個元素時，選擇第一個可見的
                for elem in elements:
                    try:
                        if elem.is_displayed() and elem.is_enabled():
                            safe_click(self.driver, elem)
                            log.info(f"[BetRandom] 成功點擊下注按鈕")
                            time.sleep(0.5)  # 等待按鈕響應
                            return True
                    except Exception:
                        continue
                
                # 如果沒有可見的元素，嘗試點擊第一個
                try:
                    safe_click(self.driver, elements[0])
                    log.info(f"[BetRandom] 成功點擊下注按鈕（第一個元素）")
                    time.sleep(0.5)
                    return True
                except Exception as e:
                    log.warning(f"[BetRandom] 點擊下注按鈕失敗: {e}")
            else:
                log.warning(f"[BetRandom] 找不到下注按鈕元素: {selected_selector}")
        except Exception as e:
            log = self.logger if self.logger else logging
            log.warning(f"[BetRandom] 執行時發生錯誤: {e}")
        
        return False

    # ----------------- Spin 迴圈（核心） -----------------
    def _is_in_game(self) -> bool:
        """
        檢查當前頁面是否在遊戲中（而非大廳）
        
        返回:
            bool: True 表示在遊戲中，False 表示在大廳
            
        檢測邏輯:
        1. 檢查遊戲中的指標元素（Spin 按鈕、餘額顯示）
        2. 檢查大廳特有的元素（遊戲卡片網格）
        3. 如果都找不到，預設認為在遊戲中（保守策略）
        
        異常處理:
        - 元素查找失敗：視為在遊戲中（保守策略）
        - 其他例外：記錄警告並視為在遊戲中
        
        注意:
        - 使用保守策略：無法確定時預設認為在遊戲中
        - 避免誤判導致流程中斷
        """
        try:
            # 檢查遊戲中的指標元素
            game_indicators = [
                ".my-button.btn_spin",      # Spin 按鈕
                ".balance-bg.hand_balance", # 餘額顯示
                ".h-balance.hand_balance",  # 特殊機台餘額顯示
            ]
            
            for indicator in game_indicators:
                try:
                    elements = self.driver.find_elements(By.CSS_SELECTOR, indicator)
                    if elements and any(elem.is_displayed() for elem in elements):
                        return True
                except Exception:
                    continue
            
            # 檢查大廳特有的元素（相反的指標）
            lobby_indicators = [
                (By.ID, "grid_gm_item"),  # 遊戲卡片網格
            ]
            
            for by, selector in lobby_indicators:
                try:
                    elements = self.driver.find_elements(by, selector)
                    if elements and any(elem.is_displayed() for elem in elements):
                        logging.info("檢測到大廳元素，當前在大廳")
                        return False
                except Exception:
                    continue
            
            # 如果都找不到，預設認為在遊戲中（保守策略）
            logging.debug("無法確定頁面狀態，預設認為在遊戲中")
            return True
            
        except Exception as e:
            logging.warning(f"檢查遊戲狀態時發生錯誤: {e}")
            # 發生錯誤時，預設認為在遊戲中（保守策略）
            return True

    def _parse_balance(self, is_special: bool) -> Optional[int]:
        """
        擷取當前遊戲餘額並轉換為整數
        
        參數:
            is_special (bool): 是否為特殊機台（影響 selector 選擇）
            
        返回:
            Optional[int]: 餘額數值，若無法取得則返回 None
            
        流程:
        1. 根據機台類型選擇對應的 CSS selector
        2. 尋找餘額元素並取得文字
        3. 移除逗號和空白
        4. 只保留數字字元
        5. 轉換為整數
        
        異常處理:
        - 元素不存在：返回 None
        - 文字格式異常：返回 None
        - 轉換失敗：返回 None
        
        注意:
        - 特殊機台（BULLBLITZ、ALLABOARD）使用不同的 selector
        - 容錯處理：只保留數字字元，忽略其他字元
        """
        sel = ".h-balance.hand_balance .text2" if is_special else ".balance-bg.hand_balance .text2"
        try:
            el = self.driver.find_element(By.CSS_SELECTOR, sel)
            txt = (el.text or "").replace(",", "").strip()
            # 容錯：只保留數字
            nums = "".join(ch for ch in txt if ch.isdigit())
            return int(nums) if nums else None
        except NoSuchElementException:
            logging.debug("找不到餘額元素（selector: %s）", sel)
            return None
        except ValueError as e:
            logging.debug(f"餘額轉換失敗: {e}")
            return None
        except Exception as e:
            logging.debug(f"解析餘額時發生錯誤: {e}")
            return None

    def _click_spin(self, is_special: bool) -> bool:
        """
        點擊 Spin 按鈕
        
        參數:
            is_special (bool): 是否為特殊機台（影響 selector 選擇）
            
        返回:
            bool: True 表示成功點擊，False 表示失敗
            
        流程:
        1. 根據機台類型選擇對應的 CSS selector
        2. 等待 Spin 按鈕出現（超時 8 秒）
        3. 使用 safe_click 安全點擊
        
        異常處理:
        - 按鈕不存在或超時：記錄警告並返回 False
        - 點擊失敗：記錄警告並返回 False
        
        注意:
        - 特殊機台使用 ".btn_spin .my-button"
        - 一般機台使用 ".my-button.btn_spin"
        """
        spin_selector = ".btn_spin .my-button" if is_special else ".my-button.btn_spin"
        try:
            btn = wait_for(self.driver, By.CSS_SELECTOR, spin_selector, timeout=8)
            return safe_click(self.driver, btn)
        except TimeoutException:
            logging.warning(f"找不到 Spin 按鈕（selector: {spin_selector}，超時 8 秒）")
            return False
        except Exception as e:
            logging.warning(f"點擊 Spin 時發生錯誤: {e}")
            return False

    def _find_cashout_button(self):
        """
        尋找 Cashout 按鈕，直接定位到 handle-main 底層的按鈕
        避免被 select-main 遮罩層阻擋
        """
        # 使用已驗證有效的選擇器
        selector = ".handle-main .my-button.btn_cashout"
        
        try:
            elements = self.driver.find_elements(By.CSS_SELECTOR, selector)
            
            for elem in elements:
                try:
                    if elem.is_displayed() and elem.is_enabled():
                        log = self.logger if self.logger else logging
                        log.info(f"✅ 找到 handle-main 底層 Cashout 按鈕，使用選擇器: {selector}")
                        return elem
                except Exception:
                    continue
        except Exception as e:
            log = self.logger if self.logger else logging
            log.debug(f"查找 Cashout 按鈕時發生錯誤: {e}")
        
        log = self.logger if self.logger else logging
        log.warning("⚠️ 找不到 Cashout 按鈕")
        return None

    def _low_balance_exit_and_reenter(self, bal: int, game_title_code: Optional[str]):
        """
        低餘額退出流程：退出遊戲並重新進入
        
        參數:
            bal (int): 當前餘額（用於日誌）
            game_title_code (Optional[str]): 遊戲標題代碼，用於重新進入遊戲
            
        流程:
        1. 點擊 Cashout 按鈕
        2. 點擊 Exit To Lobby 按鈕
        3. 點擊 Confirm 按鈕
        4. 驗證是否成功回到大廳
        5. 重新進入遊戲（如果提供 game_title_code）
        6. 驗證是否成功進入遊戲
        
        異常處理:
        - 找不到 Cashout 按鈕：記錄錯誤並返回 False
        - 找不到 Exit 按鈕：視為正常，直接嘗試 Confirm
        - 退出失敗：記錄錯誤但不拋出例外
        - 重新進入失敗：記錄警告但不拋出例外
        
        返回:
            bool: True 表示退出成功，False 表示失敗
            
        注意:
        - 退出後會等待並驗證是否真的回到大廳
        - 重新進入後會驗證是否真的進入遊戲
        """
        log = self.logger if self.logger else logging
        log.warning(f"BAL 過低（{bal:,}），執行退出流程")
        try:
            quit_btn = self._find_cashout_button()
            if quit_btn:
                safe_click(self.driver, quit_btn)
                time.sleep(1.0)
            else:
                log.error("❌ 找不到 Cashout 按鈕，無法執行退出流程")
                return False

            try:
                exit_btn = WebDriverWait(self.driver, 2).until(
                    EC.element_to_be_clickable((By.CSS_SELECTOR, ".function-btn .reserve-btn-gray"))
                    )
                safe_click(self.driver, exit_btn)
                log.info("[ExitFlow] 已點擊 Exit / Exit To Lobby")
                time.sleep(1.0)
            except TimeoutException:
                log.info("[ExitFlow] 找不到 Exit，直接嘗試 Confirm")

            confirm_btn = WebDriverWait(self.driver, 2).until(
                EC.element_to_be_clickable((By.XPATH, "//button[.//div[normalize-space(text())='Confirm']]"))
            )
            safe_click(self.driver, confirm_btn)
            time.sleep(3.0)
            
            # ✅ 驗證是否成功回到大廳
            if not self._is_in_game():
                log.info("[ExitFlow] 已成功回到大廳")
            else:
                log.warning("[ExitFlow] 退出後仍在遊戲中，可能需要額外等待")
                time.sleep(2.0)
        except Exception as e:
            log.error(f"退出流程失敗: {e}\n{traceback.format_exc()}")
            return False

        # ✅ 重新進入遊戲，並驗證是否成功進入
        if game_title_code:
            log.info(f"[ExitFlow] 準備重新進入遊戲: {game_title_code}")
            if self.scroll_and_click_game(game_title_code):
                # 等待遊戲加載並驗證是否成功進入
                time.sleep(3.0)
                if self._is_in_game():
                    log.info("[ExitFlow] 成功重新進入遊戲")
                else:
                    log.warning("[ExitFlow] 重新進入遊戲後仍在大廳，可能需要額外等待")
                    time.sleep(2.0)
            else:
                log.warning("[ExitFlow] 重新進入遊戲失敗")

    def _fast_low_balance_exit_and_reenter(self, bal: int, game_title_code: Optional[str]):
        """
        超快頻率的快速退出流程：
        Cashout -> Exit To Lobby -> Confirm
        減少等待時間以保持高速
        """
        log = self.logger if self.logger else logging
        log.warning(f"BAL 過低（{bal}），執行快速退出流程")
        try:
            quit_btn = self._find_cashout_button()
            if quit_btn:
                safe_click(self.driver, quit_btn)
                time.sleep(0.5)  # 減少等待時間
            else:
                log.error("❌ 找不到 Cashout 按鈕，無法執行快速退出流程")
                return False

            try:
                exit_btn = WebDriverWait(self.driver, 1).until(  # 減少等待時間
                    EC.element_to_be_clickable((By.CSS_SELECTOR, ".function-btn .reserve-btn-gray"))
                    )
                safe_click(self.driver, exit_btn)
                log.info("[FastExitFlow] 已點擊 Exit / Exit To Lobby")
                time.sleep(0.5)  # 減少等待時間
            except TimeoutException:
                log.info("[FastExitFlow] 找不到 Exit，直接嘗試 Confirm")

            confirm_btn = WebDriverWait(self.driver, 1).until(  # 減少等待時間
                EC.element_to_be_clickable((By.XPATH, "//button[.//div[normalize-space(text())='Confirm']]"))
            )
            safe_click(self.driver, confirm_btn)
            time.sleep(1.5)  # 減少等待時間
            
            # ✅ 驗證是否成功回到大廳
            if not self._is_in_game():
                log.info("[FastExitFlow] 已成功回到大廳")
            else:
                log.warning("[FastExitFlow] 退出後仍在遊戲中，可能需要額外等待")
                time.sleep(1.0)
        except Exception as e:
            log.error(f"快速退出流程失敗: {e}")

        # ✅ 重新進入遊戲，並驗證是否成功進入
        if game_title_code:
            log.info(f"[FastExitFlow] 準備重新進入遊戲: {game_title_code}")
            if self.scroll_and_click_game(game_title_code):
                # 等待遊戲加載並驗證是否成功進入
                time.sleep(2.0)  # 快速流程使用較短等待時間
                if self._is_in_game():
                    log.info("[FastExitFlow] 成功重新進入遊戲")
                else:
                    log.warning("[FastExitFlow] 重新進入遊戲後仍在大廳，可能需要額外等待")
                    time.sleep(1.0)
            else:
                log.warning("[FastExitFlow] 重新進入遊戲失敗")

    def _fast_rtmp_check(self, name: str, url: str, threshold: float = 0.80) -> bool:
        """
        超快頻率專用的快速 RTMP 檢測
        
        參數:
            name (str): RTMP 識別名稱（用於日誌和檔案命名）
            url (str): RTMP 串流 URL
            threshold (float): 模板比對門檻，預設 0.80
            
        返回:
            bool: True 表示觸發錄影（一般模板低分觸發），False 表示未觸發或錯誤模板觸發
            
        流程:
        1. 使用較短超時時間（2秒）截圖
        2. 讀取圖片並驗證
        3. 先用原本的模板類型比對（低分觸發）
        4. 若未觸發，檢查錯誤模板類型（高分觸發，只截圖不錄影）
        5. 立即清理截圖（錯誤模板除外）
        
        優化:
        - 跳過重複畫面檢測（節省時間）
        - 限制比對模板數量（max_templates=2）
        - 錯誤模板觸發時保留截圖但不觸發錄影
        
        異常處理:
        - FFmpeg 截圖失敗：返回 False
        - 圖片讀取失敗：清理截圖後返回 False
        - 模板比對例外：清理截圖後返回 False
        """
        logging.info(f"[{name}] 超快頻率快速 RTMP 檢測")
        
        # 使用較短的截圖超時 (2秒)
        ts = time.strftime("%Y%m%d_%H%M%S")
        out = SCREENSHOT_RTMP / f"{name}_{ts}.jpg"
        if not self.ffmpeg.snapshot(url, out, timeout=2.0):
            logging.warning(f"[{name}] 快速檢測 - FFmpeg 擷取失敗或逾時")
            return False

        # 讀取圖片
        img = cv2.imread(str(out))
        if img is None or img.size == 0:
            logging.warning(f"[{name}] 快速檢測 - 讀圖失敗，刪除後跳過")
            try:
                out.unlink(missing_ok=True)
            except Exception:
                pass
            return False
        
        # 快速模板比對（限制模板數量）
        try:
            self.matcher.current_game = self.cfg.game_title_code or "UnknownGame"
            self.matcher.cfg = self.cfg

            hit = None

            # 1) 先用原本的模板類型比對（維持舊流程，低分觸發）
            if self.template_type:
                hit = self.matcher.detect_by_manifest_fast(
                    img,
                    type_name=self.template_type,
                    default_threshold=threshold,
                    max_templates=2,  # 限制比對數量
                )

            # 2) 若原本類型未觸發，且有為此機台額外指定 error_template_type，
            #    則改用「高分觸發」邏輯再比一次（比分數大則觸發）
            error_hit_file_fast = None
            if hit is None and self.error_template_type and self.error_template_type != self.template_type:
                logging.info(
                    f"[{name}] 快速檢測 - 進行錯誤畫面模板比對（高分觸發），type='{self.error_template_type}'"
                )
                # 為了取得分數細節，error 類型改用完整版 detect_by_manifest
                _, report = self.matcher.detect_by_manifest(
                    img,
                    type_name=self.error_template_type,
                    default_threshold=threshold,
                    return_report=True,
                )
                best_file = None
                best_score = float("-inf")
                error_hit = False
                for item in report.get("templates", []):
                    score = item["score"]
                    thr = item["thr"]
                    hit_high = (score >= thr)
                    logging.info(
                        f"[{name}] ErrorTemplateScore(fast) file={item['file']} "
                        f"score={score:.5f} thr={thr:.2f} hit_high={hit_high} (高分觸發: score>=thr)"
                    )
                    if hit_high:
                        error_hit = True
                        if score > best_score:
                            best_score = score
                            best_file = item["file"]

                if error_hit:
                    error_hit_file_fast = best_file
                    hit = best_file
                    logging.warning(
                        f"[{name}] 🎯 錯誤模板高分觸發（快速檢測）：{best_file} "
                        f"(score={best_score:.5f} >= thr={thr:.2f})"
                    )
                else:
                    logging.info(
                        f"[{name}] 錯誤模板未觸發（快速檢測，所有模板分數皆 < 門檻）"
                    )

        except Exception as e:
            logging.error(f"[{name}] 快速檢測 - 模板比對發生例外：{e}\n{traceback.format_exc()}")
            try:
                out.unlink(missing_ok=True)
            except Exception as cleanup_err:
                logging.debug(f"清理截圖失敗: {cleanup_err}")
            return False
        
        # 針對 error 模板：只截圖、不錄影 → 不刪除截圖並直接返回 False
        if 'error_hit_file_fast' in locals() and error_hit_file_fast:
            logging.info(f"[{name}] 快速檢測：錯誤模板高分觸發，已保留截圖，不觸發錄影")
            return False

        # 其他情況：維持原本流程，立即清理截圖
        try:
            out.unlink(missing_ok=True)
        except Exception:
            pass
        
        if hit is not None:
            logging.warning(f"[{name}] 快速檢測 - 低分觸發：{hit}")
            return True
        
        return False

    def _rtmp_once_check(self, name: str, url: str, threshold: float = 0.80, max_dup: int = 3) -> None:
        """
        針對 RTMP 執行一次截圖 + 模板偵測
        
        參數:
            name (str): RTMP 識別名稱（用於日誌和檔案命名）
            url (str): RTMP 串流 URL（不記錄到日誌以避免洩露）
            threshold (float): 模板比對門檻，預設 0.80
            max_dup (int): 連續重複畫面次數門檻，預設 3
            
        流程:
        1. 檢查是否正在錄影（錄影中跳過檢測，只清理截圖）
        2. 使用 FFmpeg 截圖（超時 5 秒）
        3. 重複畫面檢測（MD5 比對，連續 max_dup 次推播通知）
        4. 模板比對：
           - 先用原本的模板類型（低分觸發 → 錄影）
           - 若未觸發，檢查錯誤模板類型（高分觸發 → 只截圖）
        5. 觸發時保留截圖，未觸發時清理截圖
        
        觸發邏輯:
        - 一般模板：score <= threshold → 啟動錄影 120 秒
        - 錯誤模板：score >= threshold → 只保留截圖，不錄影
        
        異常處理:
        - FFmpeg 截圖失敗：記錄警告並返回
        - 圖片讀取失敗：清理截圖並返回
        - 模板比對例外：保留截圖協助診斷
        """
        # 若已有錄影在進行，先維護一次狀態；錄影中則直接略過「偵測」（但還是清掉截圖）
        if self._is_recording_active():
            ts = time.strftime("%Y%m%d_%H%M%S")
            out = SCREENSHOT_RTMP / f"{name}_{ts}.jpg"
            try:
                if self.ffmpeg.snapshot(url, out, timeout=5.0):
                    try:
                        out.unlink(missing_ok=True)  # 錄影中，任何截圖直接清掉
                    except Exception as cleanup_err:
                        logging.debug(f"錄影中清理截圖失敗: {cleanup_err}")
            except Exception as snapshot_err:
                logging.debug(f"錄影中截圖失敗: {snapshot_err}")
            return

        # 取得一張快照供偵測
        ts = time.strftime("%Y%m%d_%H%M%S")
        out = SCREENSHOT_RTMP / f"{name}_{ts}.jpg"
        try:
            if not self.ffmpeg.snapshot(url, out, timeout=5.0):
                logging.warning(f"[{name}] FFmpeg 擷取失敗或逾時")
                return
        except Exception as e:
            logging.error(f"[{name}] FFmpeg 截圖發生例外: {e}")
            return

        # 重複畫面偵測（以 MD5 比對）
        curr = file_md5(out)
        prev = last_image_hash.get(name)
        if prev == curr:
            cnt = int(last_image_hash.get(f"{name}_dup", "0")) + 1
            last_image_hash[f"{name}_dup"] = str(cnt)
            logging.warning(f"[{name}] 重複圖片 {cnt}/{max_dup}")
            # 重複的這張，立刻刪掉
            try:
                out.unlink(missing_ok=True)
            except Exception:
                pass
            # 達門檻推播一次後把 counter 歸零
            if cnt >= max_dup:
                try:
                    self.lark.send_text(f"🔄 [{name}] RTMP 畫面連續重複 {cnt} 次，請檢查串流")
                except Exception:
                    pass
                last_image_hash[f"{name}_dup"] = "0"
            return
        else:
            last_image_hash[name] = curr
            last_image_hash[f"{name}_dup"] = "0"

        # 模板偵測（低於門檻觸發錄影）
        img = cv2.imread(str(out))
        if img is None or img.size == 0:
            logging.warning(f"[{name}] 讀圖失敗或為空影像：{out.name}，刪除後跳過")
            try:
                out.unlink(missing_ok=True)
            except Exception:
                pass
            return
        
        error_hit_file = None  # 標記是否由 error 模板高分觸發
        try:
            self.matcher.current_game = self.cfg.game_title_code or "UnknownGame"
            self.matcher.cfg = self.cfg

            hit = None

            # 1) 先用原本的模板類型比對（維持舊流程，低分觸發）
            if self.template_type:
                hit = self.matcher.detect_by_manifest(
                    img,
                    type_name=self.template_type,   # 僅比對該遊戲類型
                    default_threshold=threshold     # fallback 門檻
                )

            # 2) 若原本類型未觸發，且有為此機台額外指定 error_template_type，
            #    則改用「高分觸發」邏輯再比一次（比分數大則觸發）
            if hit is None and self.error_template_type and self.error_template_type != self.template_type:
                logging.info(
                    f"[{name}] RTMP 檢測 - 進行錯誤畫面模板比對（高分觸發），type='{self.error_template_type}'"
                )
                _, report = self.matcher.detect_by_manifest(
                    img,
                    type_name=self.error_template_type,
                    default_threshold=threshold,
                    return_report=True,
                )
                # 額外輸出 error 模板的分數細節，並改用「score >= thr」作為觸發條件
                best_file = None
                best_score = float("-inf")
                error_hit = False
                for item in report.get("templates", []):
                    score = item["score"]
                    thr = item["thr"]
                    hit_high = (score >= thr)
                    logging.info(
                        f"[{name}] ErrorTemplateScore file={item['file']} "
                        f"score={score:.5f} thr={thr:.2f} hit_high={hit_high} (高分觸發: score>=thr)"
                    )
                    if hit_high:
                        error_hit = True
                        if score > best_score:
                            best_score = score
                            best_file = item["file"]

                if error_hit:
                    error_hit_file = best_file
                    hit = best_file
                    logging.warning(
                        f"[{name}] 🎯 錯誤模板高分觸發：{best_file} "
                        f"(score={best_score:.5f} >= thr={thr:.2f})"
                    )
                else:
                    logging.info(
                        f"[{name}] 錯誤模板未觸發（所有模板分數皆 < 門檻）"
                    )

        except Exception as e:
            logging.error(f"[{name}] 模板比對發生例外：{e}\n{traceback.format_exc()}")
            # 保留截圖協助診斷（不清理）
            return
            
        if hit is not None:
            # 判斷觸發來源：error_template_type（高分觸發，只截圖不錄影），template_type（低分觸發 + 錄影）
            if error_hit_file:
                # ✅ 錯誤模板：只截圖、不錄影（out 已是本次 error 畫面的截圖）
                logging.warning(f"[{name}] 錯誤模板高分觸發：{hit}，僅截圖、不啟動錄影")
                try:
                    self.lark.send_text(f"⚠️ [{name}] 錯誤畫面偵測到（{hit}），已保留截圖，不自動錄影")
                except Exception:
                    pass
                # 不要刪除 out；直接結束
                return
            else:
                # 一般模板：維持原本「低分觸發 + 錄影」流程
                logging.warning(f"[{name}] 低分觸發：{hit}")
                
                if self.cfg.enable_recording:
                    logging.warning(f"[{name}] 開始錄影 120s")
                    try:
                        self.lark.send_text(f"🎯 [{name}] 低分觸發：{hit}\n即刻開始錄影 2 分鐘")
                    except Exception:
                        pass
                    # ★ 自動暫停本機台（不影響其他台）
                    self._auto_pause = True
                    logging.info(f"[{name}]已暫停spin")

                    # ★ 用同一個 ts（與上面快照 out 同名）
                    self._start_recording(name, url, duration_sec=120, ts=ts)     

                    # 等待錄影程序真的起來（最多 3 秒）
                    t0 = time.time()   
                    while time.time() - t0 < 3.0:
                        if self._is_recording_active():
                            break
                        time.sleep(0.1)
                    # ★ 錄影啟動後，恢復本機台 SPIN
                    self._auto_pause = False
                    logging.info(f"[{name}]已重新啟動spin")
                else:
                    # 錄製功能停用，只推播通知
                    logging.info(f"[{name}] 錄製功能已停用，僅推播觸發通知")
                    try:
                        self.lark.send_text(f"🎯 [{name}] 低分觸發：{hit}\n（錄製功能已停用）")
                    except Exception:
                        pass
            
            # 不刪這張截圖（當作觸發證據）
            return
        else:
            # 未觸發 → 清理截圖
            try:
                out.unlink(missing_ok=True)
            except Exception:
                pass
    
        # 錄影可能剛好在這輪結束（極少數），做個狀態維護
        self._maybe_cleanup_finished_recording()

    def spin_forever(self):
        """
        主要工作迴圈（無限循環直到收到停止訊號）
        
        每輪循環流程:
        1. 檢查暫停狀態（pause_event 或 _auto_pause）
        2. 定時檢測 404 頁面（每 30 秒一次）
        3. 檢查錄影狀態（錄影開始未滿 10 秒時暫停 Spin）
        4. 餘額檢查（Spin 前，低於 20000 執行退出流程）
        5. 檢查是否在遊戲中（退出流程後可能還在大廳）
        6. 點擊 Spin 按鈕
        7. 餘額變化檢測（超快頻率用上次比較，正常頻率用前後比較）
        8. 特殊流程（連續 10 次無變化觸發 machine_actions）
        9. RTMP 檢測（根據頻率和設定執行模板比對）
        10. 動態等待（根據頻率加上隨機抖動）
        
        頻率調整:
        - 超快頻率（≤0.1s）：使用快速餘額檢查、間隔 RTMP 檢測
        - 正常頻率（>0.1s）：使用標準流程
        
        異常處理:
        - 任意例外：記錄錯誤、嘗試 RTMP 截圖、等待 1 秒後繼續
        - KeyboardInterrupt：由外層 run() 處理
        
        停止條件:
        - stop_event 被設置（Ctrl+C 或 Ctrl+Esc）
        """
        game_code = self.cfg.game_title_code or ""
        is_special_game = any(k in game_code for k in SPECIAL_GAMES)
        
        # 使用執行緒專屬 logger（如果存在），否則使用全局 logging
        log = self.logger if self.logger else logging

        while not stop_event.is_set():
            while pause_event.is_set() and not stop_event.is_set():
                log.info("[Loop] 已暫停，等待恢復（Space 解除暫停）")
                time.sleep(0.3)
            try:
                loop_start_time = time.time()  # 記錄循環開始時間
                
                # 獲取當前頻率設定
                with spin_frequency_lock:
                    current_freq = spin_frequency
                
                # ✅ 定時檢測 404 頁面（每 30 秒一次）
                self._check_and_refresh_if_404()
                
                # ✅ 如果正在錄影，並且錄影開始未滿 10 秒，就暫停 spin
                if hasattr(self, "_rec_started_at"):
                    delta = time.time() - self._rec_started_at
                    if delta < 10:
                        log.info(f"[{game_code}] 錄影開始 {delta:.1f}s，等待到 10 秒才開始 Spin")
                        time.sleep(1.0)
                        continue  # 跳過這輪 loop，不執行 Spin
                # 1) Balance 檢查（Spin 前）
                bal_before = self._parse_balance(is_special=is_special_game)
                if bal_before is not None:
                    if bal_before < 20000:
                        # 所有頻率都執行退出流程，但超快頻率使用快速退出
                        if current_freq <= 0.1:  # 超快頻率使用快速退出流程
                            log.warning(f"超快頻率({current_freq}s) - 餘額過低({bal_before})，執行快速退出流程")
                            self._fast_low_balance_exit_and_reenter(bal_before, self.cfg.game_title_code)
                            time.sleep(1.0)  # 減少等待時間
                            continue
                        else:  # 正常頻率使用標準退出流程
                            self._low_balance_exit_and_reenter(bal_before, self.cfg.game_title_code)
                            time.sleep(2.0)
                            continue
                else:
                    log.info("無法取得 BAL，略過本輪餘額檢查")

                # ✅ 檢查是否在遊戲中（退出流程後可能還在大廳）
                if not self._is_in_game():
                    log.warning(f"{game_code} 檢測到在大廳，先嘗試進入遊戲")
                    if game_code:
                        if self.scroll_and_click_game(game_code):
                            log.info(f"{game_code} 成功進入遊戲，等待頁面穩定")
                            time.sleep(3.0)  # 等待遊戲加載
                        else:
                            log.warning(f"{game_code} 無法進入遊戲，跳過本輪")
                            time.sleep(2.0)
                            continue
                    else:
                        log.warning(f"{game_code} 沒有 game_title_code，無法進入遊戲")
                        time.sleep(2.0)
                        continue

                # 2) 點擊 Spin
                if not self._click_spin(is_special=is_special_game):
                    log.warning(f"{game_code} 點擊 Spin 失敗，嘗試回廳重進")
                    if game_code:
                        self.scroll_and_click_game(game_code)
                    time.sleep(1.0)
                    continue

                log.info(f"已點擊 {'特殊' if is_special_game else '一般'} Spin (頻率: {get_current_frequency_status()})")
                
                # ✅ 更新總 spin 次數
                self._total_spins += 1
                
                # ✅ 執行 bet_random（在 Spin 後隨機點擊下注按鈕）
                self._execute_bet_random(self.cfg.game_title_code)

                # 3) 餘額變化檢測（超快頻率使用快速檢查）
                balance_changed = False
                
                # 根據頻率調整等待時間
                if current_freq <= 0.1:  # 超快頻率
                    time.sleep(0.05)  # 極短等待時間
                    log.info(f"超快頻率({current_freq}s) - 快速餘額檢查")
                elif current_freq <= 0.5:  # 快速頻率
                    time.sleep(0.2)  # 較短等待時間
                else:  # 正常頻率以上
                    time.sleep(0.5)  # 標準等待時間
                
                bal_after = self._parse_balance(is_special=is_special_game)
                
                # 檢測餘額變化（累積統計模式）
                balance_changed = False
                should_trigger_special = False
                
                if current_freq <= 0.1:  # 超快頻率使用與上次餘額比較
                    if self._last_balance is not None and bal_after is not None:
                        balance_changed = (bal_after != self._last_balance)
                        if balance_changed:
                            log.info(f"超快頻率餘額變化 (與上次比較): {self._last_balance:,} → {bal_after:,} (變化: {bal_after - self._last_balance:+,})")
                            self._no_change_count = 0  # 重置計數器
                        else:
                            self._no_change_count += 1
                            log.info(f"超快頻率餘額無變化 (與上次比較): {bal_after:,} (連續無變化: {self._no_change_count}/{self._check_interval})")
                    else:
                        self._no_change_count += 1
                        log.info(f"超快頻率 - 無法與上次餘額比較，計入無變化: {self._no_change_count}/{self._check_interval}")
                else:  # 正常頻率使用 Spin 前後比較
                    if bal_before is not None and bal_after is not None:
                        balance_changed = (bal_after != bal_before)
                        if balance_changed:
                            log.info(f"餘額變化: {bal_before:,} → {bal_after:,} (變化: {bal_after - bal_before:+,})")
                            self._no_change_count = 0  # 重置計數器
                        else:
                            self._no_change_count += 1
                            log.info(f"餘額無變化: {bal_after:,} (連續無變化: {self._no_change_count}/{self._check_interval})")
                    elif self._last_balance is not None and bal_after is not None:
                        # 如果這輪無法取得 Spin 前餘額，但能取得 Spin 後餘額，與上次比較
                        balance_changed = (bal_after != self._last_balance)
                        if balance_changed:
                            log.info(f"餘額變化 (與上次比較): {self._last_balance:,} → {bal_after:,} (變化: {bal_after - self._last_balance:+,})")
                            self._no_change_count = 0  # 重置計數器
                        else:
                            self._no_change_count += 1
                            log.info(f"餘額無變化 (與上次比較): {bal_after:,} (連續無變化: {self._no_change_count}/{self._check_interval})")
                    else:
                        self._no_change_count += 1
                        log.info(f"無法檢測餘額變化，計入無變化: {self._no_change_count}/{self._check_interval}")
                
                # 檢查是否達到觸發特殊流程的條件
                if self._no_change_count >= self._check_interval:
                    should_trigger_special = True
                    log.info(f"🎯 連續 {self._check_interval} 次無變化，觸發特殊流程！")
                    self._no_change_count = 0  # 重置計數器
                
                # 更新上次餘額記錄
                if bal_after is not None:
                    self._last_balance = bal_after

                # ✅ 檢查 random_exit（隨機退出功能）
                if self.cfg.random_exit_enabled:
                    if self._total_spins >= self.cfg.random_exit_min_spins:
                        if np.random.random() < self.cfg.random_exit_chance:
                            log.warning(f"🎲 觸發隨機退出（總 spin 次數: {self._total_spins}, 機率: {self.cfg.random_exit_chance:.1%}）")
                            # 執行退出流程
                            if current_freq <= 0.1:  # 超快頻率使用快速退出
                                self._fast_low_balance_exit_and_reenter(bal_after or 0, self.cfg.game_title_code)
                            else:  # 正常頻率使用標準退出
                                self._low_balance_exit_and_reenter(bal_after or 0, self.cfg.game_title_code)
                            # 重置 spin 計數器
                            self._total_spins = 0
                            time.sleep(2.0)
                            continue  # 跳過本輪，等待重新進入遊戲

                # 4) 特殊機台 Spin 後流程（依 actions.json 的 machine_actions）
                # 只有累積 10 次無變化時才執行特殊流程
                if should_trigger_special:
                    for kw, (positions, do_take) in self.machine_actions.items():
                        if game_code and kw in game_code:
                            if current_freq <= 0.1:  # 超快頻率
                                log.info(f"超快頻率({current_freq}s) - 連續{self._check_interval}次無變化觸發特殊流程: {kw} -> {positions}, take={do_take}")
                            else:
                                log.info(f"連續{self._check_interval}次無變化觸發特殊流程: {kw} -> {positions}, take={do_take}")
                            self.click_multiple_positions(positions, click_take=do_take)
                            break
                elif balance_changed:
                    log.info("餘額有變化，重置計數器，繼續 Spin")
                else:
                    log.info(f"餘額無變化，累積計數: {self._no_change_count}/{self._check_interval}，繼續 Spin")

                # 5) RTMP 單次偵測（可選）
                if self.cfg.rtmp and self.cfg.rtmp_url:
                    # 檢查是否啟用模板偵測（高頻率時可關閉以提升性能）
                    if current_freq <= 0.1:  # 超快頻率使用間隔檢測
                        if not self.cfg.enable_template_detection:
                            log.info(f"超快頻率({current_freq}s) - 模板偵測已關閉，跳過 RTMP 檢測")
                        else:
                            self._spin_count += 1
                            # 每隔 5 次 Spin 才檢測一次 RTMP
                            if self._spin_count % 5 == 0:
                                log.info(f"超快頻率({current_freq}s) - 間隔檢測 RTMP (第 {self._spin_count} 次)")
                                if self._fast_rtmp_check(self.cfg.rtmp, self.cfg.rtmp_url, threshold=0.80):
                                    # 快速檢測觸發，執行錄影流程
                                    log.warning(f"[{self.cfg.rtmp}] 快速檢測觸發，開始錄影 120s")
                                    try:
                                        self.lark.send_text(f"🎯 [{self.cfg.rtmp}] 快速檢測觸發\n即刻開始錄影 2 分鐘")
                                    except Exception:
                                        pass
                                    # 自動暫停本機台
                                    self._auto_pause = True
                                    log.info(f"[{self.cfg.rtmp}]已暫停spin")
                                    
                                    # 開始錄影
                                    ts = time.strftime("%Y%m%d_%H%M%S")
                                    self._start_recording(self.cfg.rtmp, self.cfg.rtmp_url, duration_sec=120, ts=ts)
                                    
                                    # 等待錄影程序啟動
                                    t0 = time.time()   
                                    while time.time() - t0 < 3.0:
                                        if self._is_recording_active():
                                            break
                                        time.sleep(0.1)
                                    # 恢復本機台 SPIN
                                    self._auto_pause = False
                                    log.info(f"[{self.cfg.rtmp}]已重新啟動spin")
                    else:  # 正常頻率使用標準檢測
                        if not self.cfg.enable_template_detection:
                            log.info(f"正常頻率({current_freq}s) - 模板偵測已關閉，跳過 RTMP 檢測")
                        else:
                            self._rtmp_once_check(self.cfg.rtmp, self.cfg.rtmp_url, threshold=0.80)

                # 6) 動態 sleep：使用全域頻率設定，加上小幅隨機抖動避免同步問題
                with spin_frequency_lock:
                    base_sleep = spin_frequency
                
                # 根據頻率調整隨機抖動範圍
                if base_sleep <= 0.1:  # 極限頻率使用最小抖動
                    random_factor = 0.95 + np.random.random() * 0.1  # 0.95 到 1.05 (±5%)
                elif base_sleep <= 0.2:  # 超快頻率使用較小抖動
                    random_factor = 0.9 + np.random.random() * 0.2  # 0.9 到 1.1 (±10%)
                else:  # 其他頻率使用標準抖動
                    random_factor = 0.8 + np.random.random() * 0.4  # 0.8 到 1.2 (±20%)
                
                actual_sleep = base_sleep * random_factor
                
                # 計算並顯示實際循環時間
                loop_elapsed = time.time() - loop_start_time
                log.info(f"循環耗時: {loop_elapsed:.3f}s | 設定頻率: {base_sleep:.3f}s | 實際等待: {actual_sleep:.3f}s")
                
                time.sleep(actual_sleep)

            except KeyboardInterrupt:
                # 手動中斷：向上拋出，由 run() 處理
                raise
            except Exception as e:
                # 任意例外：記錄並嘗試拍一次 RTMP 便於診斷
                log.error(f"spin_forever 例外: {e}\n{traceback.format_exc()}")
                try:
                    if self.cfg.rtmp and self.cfg.rtmp_url:
                        self._rtmp_once_check(self.cfg.rtmp + "_Exception", self.cfg.rtmp_url, threshold=0.80)
                except Exception as rtmp_err:
                    log.debug(f"例外時 RTMP 截圖失敗: {rtmp_err}")
                time.sleep(1.0)  # 避免例外循環過快

        while (pause_event.is_set() or self._auto_pause) and not stop_event.is_set():
            log.info("[Loop] 已暫停（%s）" % ("Global" if pause_event.is_set() else "Auto"))
            time.sleep(0.2)

    # ----------------- 對外啟動 -----------------
    def run(self):
        """
        建立瀏覽器、必要時先嘗試從 Lobby 進入遊戲，接著進入 spin_forever 迴圈
        
        流程：
        1. 建立 Edge WebDriver 並載入遊戲 URL
        2. 若提供 game_title_code，從大廳進入指定遊戲
        3. 進入 spin_forever 無限循環（直到收到停止訊號）
        
        異常處理：
        - KeyboardInterrupt：優雅退出，關閉瀏覽器
        - 其他例外：記錄錯誤並關閉瀏覽器
        """
        # ✅ 為每個執行緒創建獨立的 logger 和 log 檔
        start_time = time.strftime("%Y%m%d_%H%M%S")
        rtmp_name = self.cfg.rtmp or self.cfg.game_title_code or "Unknown"
        # 清理檔名中的特殊字元，避免檔案系統問題
        safe_rtmp_name = "".join(c for c in rtmp_name if c.isalnum() or c in ('_', '-'))
        log_filename = BASE_DIR / "logs" / f"{start_time}_{safe_rtmp_name}.log"
        
        # 確保 logs 目錄存在
        log_filename.parent.mkdir(parents=True, exist_ok=True)
        
        # 創建唯一的 logger 名稱（包含時間戳，避免重複使用）
        logger_name = f"GameRunner-{start_time}-{safe_rtmp_name}"
        
        # 如果 logger 已存在，先清理 handlers
        if self.logger is not None:
            for handler in self.logger.handlers[:]:
                handler.close()
                self.logger.removeHandler(handler)
        
        # 創建新的 logger（每次都創建新的，避免重用問題）
        self.logger = logging.getLogger(logger_name)
        self.logger.setLevel(logging.INFO)
        
        # 清除所有現有的 handlers（確保乾淨的狀態）
        self.logger.handlers.clear()
        
        # 創建 FileHandler 寫入獨立 log 檔（使用 'a' 模式以支援追加，但每次執行都是新檔案）
        try:
            self.log_file_handler = logging.FileHandler(log_filename, mode='a', encoding="utf-8")
            self.log_file_handler.setLevel(logging.INFO)
            file_formatter = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
            self.log_file_handler.setFormatter(file_formatter)
            self.logger.addHandler(self.log_file_handler)
        except Exception as e:
            logging.warning(f"無法建立 log 檔 {log_filename}：{e}，將使用控制台輸出")
            self.log_file_handler = None
        
        # 同時也輸出到控制台（保留原有行為）
        console_handler = logging.StreamHandler()
        console_handler.setLevel(logging.INFO)
        console_handler.setFormatter(file_formatter)
        self.logger.addHandler(console_handler)
        
        # 防止 logger 向上傳播到 root logger（避免重複輸出）
        self.logger.propagate = False
        
        self.logger.info("=" * 60)
        self.logger.info("執行緒啟動")
        self.logger.info(f"Log 檔: {log_filename.name}")
        self.logger.info(f"RTMP: {self.cfg.rtmp or 'N/A'}")
        self.logger.info(f"Game: {self.cfg.game_title_code or 'N/A'}")
        self.logger.info(f"Template Type: {self.template_type or 'N/A'}")
        self.logger.info("=" * 60)
        
        # 安全日誌輸出（不洩露 URL 和 token）
        safe_info = f"rtmp={self.cfg.rtmp or 'N/A'}, game={self.cfg.game_title_code or 'N/A'}, template_type={self.template_type or 'N/A'}"
        self.logger.info(f"初始化遊戲測試: {safe_info}")
        try:
            self.driver = self._build_driver()
        except Exception as e:
            self.logger.error(f"建立瀏覽器失敗: {e}")
            raise

        # ✅ 向 HistoryMonitor 全域單例註冊此 driver
        if _history_monitor is not None:
            _history_monitor.register_driver(self.driver)

        try:
            # 若提供 game_title_code，開啟後先嘗試從 Lobby 進入
            if self.cfg.game_title_code:
                self.scroll_and_click_game(self.cfg.game_title_code)
            self.spin_forever()
        except KeyboardInterrupt:
            self.logger.info("手動中止")
        finally:
            # ✅ 執行緒結束前反註冊 driver
            if _history_monitor is not None and self.driver:
                _history_monitor.unregister_driver(self.driver)

            if self.driver:
                try:
                    self.driver.quit()
                    self.logger.info("瀏覽器已關閉")
                except Exception:
                    pass
            
            # ✅ 正確關閉 log handlers，確保所有日誌都寫入檔案
            if self.logger:
                self.logger.info("=" * 60)
                self.logger.info("執行緒結束")
                self.logger.info("=" * 60)
                
                # 關閉所有 handlers
                for handler in self.logger.handlers[:]:
                    try:
                        handler.flush()  # 確保所有緩衝的日誌都寫入
                        handler.close()
                    except Exception as e:
                        logging.warning(f"關閉 log handler 時發生錯誤: {e}")
                    self.logger.removeHandler(handler)
                
                # 清理 logger 引用
                self.logger = None
                self.log_file_handler = None


# =========================== 主程式與訊號處理 ===========================
def handle_interrupt(sig, frame):
    """Ctrl+C 時將 stop_event 設為 True，讓各執行緒優雅退出"""
    print("\n🛑 收到 Ctrl+C，中止中…")
    stop_event.set()

signal.signal(signal.SIGINT, handle_interrupt)


def main():
    """
    入口函式：
    - 讀取 game_config.json -> 過濾 enabled 機台 -> 轉成 GameConfig
    - 讀取 actions.json（keyword_actions / machine_actions）
    - 建立共享元件：TemplateMatcher / FFmpegRunner / LarkClient
    - 針對每一台機台啟動一個執行緒跑 GameRunner.run()
    """
    start_hotkey_listener()
    logging.info("[Main] 啟動主程式，開始讀取設定檔")
    # 讀取遊戲清單
    try:
        with (BASE_DIR / "game_config.json").open("r", encoding="utf-8") as f:
            cfg_list = json.load(f)
        logging.info(f"[Main] 讀取 game_config.json 成功，筆數={len(cfg_list)}")
    except Exception as e:
        logging.error(f"[Main] 讀取 game_config.json 失敗: {e}")
        raise

    games: List[GameConfig] = []
    for raw in cfg_list:
        if raw.get("enabled", True):
            games.append(
                GameConfig(
                    url=raw.get("url"),
                    rtmp=raw.get("rtmp"),
                    rtmp_url=raw.get("rtmp_url"),
                    game_title_code=raw.get("game_title_code"),
                    template_type=raw.get("template_type"),  # ✅ 支援直接指定
                    error_template_type=raw.get("error_template_type"),  # ✅ 針對特定機器的錯誤畫面模板類型
                    enabled=True,
                    enable_recording=raw.get("enable_recording", True),  # ✅ 支援錄製功能開關
                    enable_template_detection=raw.get("enable_template_detection", True),  # ✅ 支援模板偵測開關
                    random_exit_enabled=raw.get("random_exit_enabled", False),  # ✅ 隨機退出功能
                    random_exit_chance=raw.get("random_exit_chance", 0.02),  # ✅ 退出機率
                    random_exit_min_spins=raw.get("random_exit_min_spins", 50),  # ✅ 最少 spin 次數
                )
            )

    # 讀取動作定義
    with (BASE_DIR / "actions.json").open("r", encoding="utf-8") as f:
        actions = json.load(f)
    keyword_actions: Dict[str, List[str]] = actions.get("keyword_actions", {})
    # 將 {"kw": {"positions":[...], "click_take":true}} 轉成 {"kw": ([...], True)}
    machine_actions: Dict[str, Tuple[List[str], bool]] = {
        kw: (info.get("positions", []), bool(info.get("click_take", False)))
        for kw, info in actions.get("machine_actions", {}).items()
    }
    
    # ✅ 讀取 bet_random 配置
    bet_random_config: Dict[str, List[str]] = {}
    bet_random_file = BASE_DIR / "bet_random.json"
    if bet_random_file.exists():
        try:
            with bet_random_file.open("r", encoding="utf-8") as f:
                bet_random_raw = json.load(f)
                # 處理兩種格式：陣列格式和物件格式
                for key, value in bet_random_raw.items():
                    # 忽略註解（key 以 // 開頭）
                    if key.startswith("//"):
                        continue
                    if isinstance(value, list):
                        bet_random_config[key] = value
                    elif isinstance(value, dict) and "selectors" in value:
                        bet_random_config[key] = value["selectors"]
            logging.info(f"[Main] 讀取 bet_random.json 成功，配置數={len(bet_random_config)}")
        except Exception as e:
            logging.warning(f"[Main] 讀取 bet_random.json 失敗: {e}，將不使用 bet_random 功能")
    else:
        logging.info("[Main] bet_random.json 不存在，將不使用 bet_random 功能")

    # 共用元件（✅ 帶入 manifest）
    matcher = TemplateMatcher(TEMPLATE_DIR, manifest_path=TEMPLATES_MANIFEST)
    ff = FFmpegRunner(FFMPEG_EXE)
    lark = LarkClient(LARK_WEBHOOK)
    backend_client = BackendRecordClient(lark=lark, auth_path=BACKEND_AUTH_FILE)
    backend_client.initialize_auth()

    # ✅ 建立全域 HistoryMonitor 單例並啟動
    global _history_monitor
    _history_monitor = HistoryMonitor(
        lark=lark,
        stop_event=stop_event,
        interval=5.0,             # 每 5 秒撈一次
        dup_time_threshold=2,     # 同一時間點出現 2 筆以上視為異常
        burst_window=5,           # 5 秒內
        burst_count=10,           # 同機台出現 10 筆以上視為暴增異常
        win_multiplier=50.0,      # win > bet * 50 倍視為異常
        backend_client=backend_client,  # 後台 API 對帳
        backend_time_tolerance_sec=3,   # 前後台時間容差（秒）
        backend_scan_window_sec=10,     # 後台查詢窗：掃描時間往前 10 秒
        backend_margin_sec=5,           # 查詢窗前後額外緩衝 ±5 秒
    )
    _history_monitor.start()
    logging.info("[Main] HistoryMonitor 已啟動")


    # 每台機台一個執行緒
    threads: List[threading.Thread] = []
    recording_enabled_count = sum(1 for conf in games if conf.enable_recording)
    logging.info(f"[Main] 準備啟動 {len(games)} 個執行緒，其中 {recording_enabled_count} 個啟用錄製功能")
    
    for idx, conf in enumerate(games):
        runner = GameRunner(conf, matcher, ff, lark, keyword_actions, machine_actions, bet_random_config)
        recording_status = "啟用錄製" if conf.enable_recording else "停用錄製"
        random_exit_status = f", 隨機退出: {conf.random_exit_chance:.1%} (最少 {conf.random_exit_min_spins} 次)" if conf.random_exit_enabled else ""
        logging.info(f"[Main] 啟動執行緒 {idx+1}/{len(games)}: {conf.rtmp or conf.game_title_code or 'NA'} ({recording_status}{random_exit_status})")
        
        t = threading.Thread(
            target=runner.run,
            name=f"GameThread-{conf.rtmp or conf.game_title_code or 'NA'}",
            daemon=True,  # 設為守護緒，主程式結束時可隨之關閉
        )
        t.start()
        threads.append(t)
        # 錯開啟動時間，避免同時連接 RTMP 造成資源競爭（每個間隔 1-2 秒）
        if idx < len(games) - 1:
            delay = 1.0 + np.random.random()
            logging.info(f"[Main] 等待 {delay:.2f} 秒後啟動下一個執行緒")
            time.sleep(delay)

    # 等待所有執行緒完成（一般情況下會長時運行）
    for t in threads:
        t.join()


if __name__ == "__main__":
    main()
