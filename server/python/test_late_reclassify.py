"""
驗證「延遲推定完成」的補判邏輯（reclassify_pending_unknown）。

這條規則的風險是**單向的**：判太寬會把「不確定」洗成「完成」，
報告會看起來比實際健康——那比什麼都不做更糟，因為它會讓人不去查。
所以測試重點放在「什麼情況下**不該**補判」。

不需要瀏覽器：用假的 page/frame 餵 window.__coinUpdatedAt。

跑法：python server/python/test_late_reclassify.py
"""
import importlib.util
import os
import time

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('agent', os.path.join(HERE, 'toppath-agent.py'))
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

# log() 會想打 HTTP 回伺服器，測試裡換成收集起來就好
LOGS = []
agent.log = lambda msg: LOGS.append(msg)


class FakeFrame:
    def __init__(self, coin_ts, raise_on_read=False):
        self.coin_ts = coin_ts
        self.raise_on_read = raise_on_read

    def evaluate(self, expr):
        if '__coinUpdatedAt' in expr:
            if self.raise_on_read:
                raise RuntimeError('frame detached')
            return self.coin_ts
        return None


class FakePage:
    def __init__(self, coin_ts, raise_on_read=False):
        self.frames = [FakeFrame(coin_ts, raise_on_read)]


passed = failed = 0


def check(name, ok, extra=''):
    global passed, failed
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f'  {extra}' if extra else ''))
    if ok:
        passed += 1
    else:
        failed += 1


def mk(unknown=1, coin_ts_at_click=1000.0, age_sec=2.0, **counts):
    """做一台有 1 筆待判 unknown 的機台狀態"""
    base = {'unknown': unknown}
    base.update(counts)
    return {
        'outcome_counts': base,
        'pending_unknown': {'coinTs': coin_ts_at_click, 'at': time.time() - age_sec},
    }


print('\n1) 該補判的情況')
mp = mk()
r = agent.reclassify_pending_unknown(FakePage(1500.0), mp, 'T')
check('coin 更新晚到 → 補判成 completed_late', r is True)
check('  unknown 減 1', mp['outcome_counts'].get('unknown') == 0, str(mp['outcome_counts']))
check('  completed_late 加 1', mp['outcome_counts'].get('completed_late') == 1)
check('  log 帶得出 reason', any('late_coin_update_within_30s' in m for m in LOGS), LOGS[-1] if LOGS else '')

print('\n2) 不該補判的情況（判太寬會把不確定洗成完成）')

mp = mk(coin_ts_at_click=1500.0)
r = agent.reclassify_pending_unknown(FakePage(1500.0), mp, 'T')
check('coin 完全沒更新 → 不補判', r is False and mp['outcome_counts']['unknown'] == 1)

mp = mk(coin_ts_at_click=1500.0)
r = agent.reclassify_pending_unknown(FakePage(1200.0), mp, 'T')
check('coin 時間戳反而變小（重連歸零）→ 不補判', r is False and mp['outcome_counts']['unknown'] == 1)

mp = mk(age_sec=45.0)
r = agent.reclassify_pending_unknown(FakePage(1500.0), mp, 'T')
check('距離點擊超過 30 秒 → 不補判（中間可能卡過 FG/JP，那是派彩不是結算）',
      r is False and mp['outcome_counts']['unknown'] == 1)

mp = mk(age_sec=29.0)
r = agent.reclassify_pending_unknown(FakePage(1500.0), mp, 'T')
check('29 秒 → 還在界線內，補判', r is True)

mp = {'outcome_counts': {'unknown': 1}, 'pending_unknown': None}
r = agent.reclassify_pending_unknown(FakePage(9999.0), mp, 'T')
check('沒有待判紀錄 → 不補判（例如中間卡過 FG，pending 已被清掉）',
      r is False and mp['outcome_counts']['unknown'] == 1)

mp = mk(unknown=0)
r = agent.reclassify_pending_unknown(FakePage(1500.0), mp, 'T')
check('計數器已經是 0 → 不會把 unknown 減成負數',
      r is False and mp['outcome_counts'].get('unknown') == 0)

mp = mk()
r = agent.reclassify_pending_unknown(FakePage(1500.0, raise_on_read=True), mp, 'T')
check('讀不到 coin 時間戳 → 不補判（讀不到不等於有更新）',
      r is False and mp['outcome_counts']['unknown'] == 1)

print('\n3) 一筆只補一次，不留佇列')
mp = mk()
agent.reclassify_pending_unknown(FakePage(1500.0), mp, 'T')
before = dict(mp['outcome_counts'])
r2 = agent.reclassify_pending_unknown(FakePage(1600.0), mp, 'T')
check('第二次呼叫不會重複補判', r2 is False and mp['outcome_counts'] == before, str(mp['outcome_counts']))
check('  pending 已清空', mp.get('pending_unknown') is None)

print('\n4) 總數守恆——補判只能搬動分類，不能憑空生出局數')
mp = mk(unknown=3, completed=10, suspected=2, not_started=1)
total_before = sum(mp['outcome_counts'].values())
agent.reclassify_pending_unknown(FakePage(1500.0), mp, 'T')
total_after = sum(mp['outcome_counts'].values())
check('補判前後 outcome 總數不變', total_before == total_after,
      f'{total_before} → {total_after}  {mp["outcome_counts"]}')
check('  completed 沒有被動到（延遲推定不併進確定）',
      mp['outcome_counts']['completed'] == 10)

print(f'\n{passed} 通過 / {failed} 失敗')
raise SystemExit(1 if failed else 0)
