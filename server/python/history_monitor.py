from __future__ import annotations

import logging
import re
import threading
import time
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

if TYPE_CHECKING:
    from AutoSpin import BackendRecordClient, LarkClient


class HistoryMonitor:
    """獨立監控歷史戰績並執行異常偵測/後台比對。"""

    def __init__(
        self,
        lark: "LarkClient",
        stop_event: threading.Event,
        interval: float = 5.0,
        dup_time_threshold: int = 2,
        burst_window: int = 5,
        burst_count: int = 10,
        win_multiplier: float = 50.0,
        backend_client: Optional["BackendRecordClient"] = None,
        backend_time_tolerance_sec: int = 3,
        backend_scan_window_sec: int = 10,
        backend_margin_sec: int = 5,
    ):
        self.lark = lark
        self.stop_event = stop_event
        self.interval = interval
        self.dup_time_threshold = dup_time_threshold
        self.burst_window = burst_window
        self.burst_count = burst_count
        self.win_multiplier = win_multiplier
        self.backend_client = backend_client
        self.backend_time_tolerance_sec = backend_time_tolerance_sec
        self.backend_scan_window_sec = backend_scan_window_sec
        self.backend_margin_sec = backend_margin_sec

        self._seen: Dict[str, float] = {}
        self._history_initialized = False
        self._gmid_timestamps: Dict[str, List[float]] = {}
        self._anomaly_cooldown_sec = 120
        self._anomaly_last_sent: Dict[str, float] = {}
        self._backend_mismatch_seen: Dict[str, float] = {}
        self._drivers: List = []
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None

    def register_driver(self, driver):
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
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._loop, name="HistoryMonitorThread", daemon=True)
        self._thread.start()
        logging.info("[HistoryMonitor] 監控執行緒已啟動（間隔 %.1fs）", self.interval)

    def _loop(self):
        while not self.stop_event.is_set():
            time.sleep(self.interval)
            try:
                self._fetch_and_check()
            except Exception as e:
                logging.warning("[HistoryMonitor] 迴圈例外：%s", e)

    def _get_active_driver(self):
        with self._lock:
            drivers = list(self._drivers)
        for d in drivers:
            try:
                _ = d.current_url
                return d
            except Exception:
                pass
        return None

    def _fetch_records(self, driver) -> List[dict]:
        try:
            uid_js = "return (window._uid || (window.pinus && window.pinus.uid) || '');"
            uid = str(driver.execute_script(uid_js) or "").strip()
            if not uid:
                try:
                    token = parse_qs(urlparse(driver.current_url or "").query).get("token", [""])[0]
                    if "-" in token:
                        uid = token.rsplit("-", 1)[1].strip()
                except Exception:
                    pass

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
            return
        records = self._fetch_records(driver)
        if not records:
            return

        now = time.time()
        if not self._history_initialized:
            for rec in records:
                self._seen[f"{rec.get('gmid','')}_{rec.get('time','')}"] = now
            self._history_initialized = True
            logging.info("[HistoryMonitor] 首輪初始化完成，已載入 %d 筆歷史紀錄（本輪不做告警）", len(records))
            return

        new_records: List[dict] = []
        for rec in records:
            key = f"{rec.get('gmid','')}_{rec.get('time','')}"
            if key not in self._seen:
                self._seen[key] = now
                new_records.append(rec)

        if new_records:
            logging.info("[HistoryMonitor] 本輪新增 %d 筆紀錄", len(new_records))
            self._detect_anomalies(records, new_records)
            self._compare_with_backend(new_records, driver=driver, scan_epoch=now)

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
        uid = str(rec.get("gmid", "")).strip()
        if not rec_time or not uid:
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
        uid = str(item.get("uid", "")).strip()
        if not rec_time or not uid:
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
        front = [x for x in (self._normalize_front_record(r) for r in new_records) if x is not None]
        if not front:
            return

        scan_dt = datetime.fromtimestamp(scan_epoch)
        front_min_dt = min(r["time"] for r in front)
        front_max_dt = max(r["time"] for r in front)
        start_dt = front_min_dt - timedelta(seconds=self.backend_margin_sec)
        end_dt = front_max_dt + timedelta(seconds=self.backend_margin_sec)
        m = re.match(r"^(\d+)-", str(front[0]["uid"]))
        channel_id = m.group(1) if m else None
        player_id = None
        try:
            token = parse_qs(urlparse(driver.current_url or "").query).get("token", [""])[0]
            if "-" in token:
                player_id = token.rsplit("-", 1)[1].strip()
        except Exception:
            pass

        backend_items = self.backend_client.fetch_game_records(
            start_dt=start_dt, end_dt=end_dt, channel_id=channel_id, player_id=player_id
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
        backend = [x for x in (self._normalize_backend_record(i) for i in backend_items) if x is not None]
        logging.info("[HistoryMonitor] 後台資料解析: raw_items=%d normalized_items=%d", raw_backend_count, len(backend))
        if not backend:
            sample_front = ", ".join(f"{r['uid']}@{r['time_raw']}" for r in front[:3])
            logging.info(
                "[HistoryMonitor] 後台比對：查無資料（%s ~ %s） sample_front=%s",
                start_dt,
                end_dt,
                sample_front or "(empty)",
            )
            return

        used_idx: set = set()
        unmatched_front: List[dict] = []
        compare_lines: List[str] = []
        tol = self.backend_time_tolerance_sec
        for idx, fr in enumerate(front, start=1):
            match_idx = None
            if fr["order_id"]:
                for i, br in enumerate(backend):
                    if i not in used_idx and br["order_id"] and br["order_id"] == fr["order_id"]:
                        match_idx = i
                        break
            if match_idx is None:
                for i, br in enumerate(backend):
                    if i in used_idx or br["uid"] != fr["uid"]:
                        continue
                    if fr["gameid"] and br["gameid"] and fr["gameid"] != br["gameid"]:
                        continue
                    if abs(br["bet"] - fr["bet"]) > 0.01 or abs(br["win"] - fr["win"]) > 0.01:
                        continue
                    if abs((br["time"] - fr["time"]).total_seconds()) > tol:
                        continue
                    match_idx = i
                    break
            if match_idx is None:
                unmatched_front.append(fr)
                compare_lines.append(
                    f"{idx}. [UNMATCH] uid={fr['uid']} time={fr['time_raw']} bet={fr['bet']:.0f} win={fr['win']:.0f}"
                )
            else:
                used_idx.add(match_idx)
                br = backend[match_idx]
                diff = int((br["time"] - fr["time"]).total_seconds())
                compare_lines.append(
                    f"{idx}. [MATCH] uid={fr['uid']} front_time={fr['time_raw']} backend_time={br['time_raw']} diff={diff}s"
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

        self._backend_mismatch_seen = {k: v for k, v in self._backend_mismatch_seen.items() if now - v < 600}
        if not fresh_mismatches:
            return

        sample = fresh_mismatches[:3]
        detail = "\n".join(
            f"  uid={r['uid']} time={r['time_raw']} bet={r['bet']:.0f} win={r['win']:.0f}" for r in sample
        )
        msg = (
            f"⚠️ [後台比對異常] 前端 {len(fresh_mismatches)} 筆在後台未匹配\n"
            f"比對窗：{start_dt.strftime('%Y-%m-%d %H:%M:%S')} ~ {end_dt.strftime('%Y-%m-%d %H:%M:%S')}\n"
            f"{detail}"
        )
        logging.warning("[HistoryMonitor] %s", msg)
        try:
            self.lark.send_text(f"[HistoryMonitor]\n{msg}")
        except Exception:
            pass

    def _detect_anomalies(self, all_records: List[dict], new_records: List[dict]):
        anomalies: List[Tuple[str, str]] = []
        now = time.time()
        scan_time = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now))

        dup_counter: Dict[Tuple[str, str, str, str], List[dict]] = {}
        for rec in all_records:
            key = (str(rec.get("time", "")), str(rec.get("gmid", "")), str(rec.get("bet", "")), str(rec.get("win", "")))
            dup_counter.setdefault(key, []).append(rec)
        for (t, gmid, bet, win), recs in dup_counter.items():
            if len(recs) >= self.dup_time_threshold:
                anomalies.append(
                    (
                        f"dup_time:{t}:{gmid}:{bet}:{win}",
                        f"⚠️ [重複時間] 掃描時間={scan_time} | {t} 出現 {len(recs)} 筆相同時間+win紀錄",
                    )
                )

        for rec in new_records:
            gmid = rec.get("gmid", "")
            if not gmid:
                continue
            self._gmid_timestamps.setdefault(gmid, []).append(now)
            cutoff = now - self.burst_window
            self._gmid_timestamps[gmid] = [t for t in self._gmid_timestamps[gmid] if t >= cutoff]
            count = len(self._gmid_timestamps[gmid])
            if count >= self.burst_count:
                anomalies.append(
                    (
                        f"burst:{gmid}:{self.burst_window}:{self.burst_count}",
                        f"⚠️ [暴增異常] 掃描時間={scan_time} | gmid={gmid} 在 {self.burst_window}s 內出現 {count} 筆（門檻={self.burst_count}）",
                    )
                )

        for rec in new_records:
            try:
                bet = float(rec.get("bet", 0) or 0)
                win = float(rec.get("win", 0) or 0)
                payout = float(rec.get("payout", 0) or 0)
                expected_payout = max(win - bet, 0)
                if payout == 0:
                    continue
                if bet > 0 and abs(payout - expected_payout) > 1:
                    anomalies.append(
                        (
                            f"payout:{rec.get('gmid')}:{rec.get('time')}:{bet}:{win}:{payout}",
                            f"⚠️ [payout 異常] gmid={rec.get('gmid')} time={rec.get('time')} "
                            f"bet={bet} win={win} payout={payout}（預期={expected_payout:.0f}）",
                        )
                    )
            except Exception:
                pass

        for rec in new_records:
            try:
                bet = float(rec.get("bet", 0) or 0)
                win = float(rec.get("win", 0) or 0)
                if bet > 0 and win > bet * self.win_multiplier:
                    anomalies.append(
                        (
                            f"high_win:{rec.get('gmid')}:{rec.get('time')}:{bet}:{win}",
                            f"💰 [高倍 win] gmid={rec.get('gmid')} 遊戲={rec.get('gameid')} bet={bet} win={win}",
                        )
                    )
            except Exception:
                pass

        for event_key, msg in anomalies:
            last = self._anomaly_last_sent.get(event_key, 0.0)
            if now - last < self._anomaly_cooldown_sec:
                continue
            self._anomaly_last_sent[event_key] = now
            logging.warning("[HistoryMonitor] %s", msg)
            try:
                self.lark.send_text(f"[HistoryMonitor]\n{msg}")
            except Exception:
                pass

