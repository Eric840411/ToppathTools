"""
驗證 errcode 現場快照的分類邏輯。

這是整個功能的核心：把「發生過 errcode」變成「對玩家的影響」，靠的就是
把錯誤分成三種嚴重度完全不同的情況。分錯的話，報告會比沒有還糟——
把無害的雜訊報成扣款事故，或反過來把真的損失漏掉。

不需要瀏覽器：用假的 page/frame 餵 window.__lastSpinErr。

跑法：python server/python/test_err_snapshot.py
"""
import importlib.util
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('agent', os.path.join(HERE, 'toppath-agent.py'))
agent = importlib.util.module_from_spec(spec)
# toppath-agent.py 頂層有 argparse / 網路登錄，都包在 if __name__ == '__main__' 底下，
# 所以直接 exec 模組本體是安全的
spec.loader.exec_module(agent)


class FakeFrame:
    def __init__(self, err):
        self._err = err

    def evaluate(self, expr):
        if '__lastSpinErr' in expr:
            return self._err
        return None


class FakePage:
    def __init__(self, err):
        self.frames = [FakeFrame(err)]


passed = failed = 0


def check(name, ok, extra=''):
    global passed, failed
    print(f"  {'✅' if ok else '❌'} {name}" + (f'  {extra}' if extra else ''))
    if ok:
        passed += 1
    else:
        failed += 1


print('1) 三種嚴重度要分得開')

# ① 扣了、沒轉成 → 玩家真的損失
mp = {'last_ok_spin_ts': time.time()}
page = FakePage({'errcode': 25, 'errcodedes': 'service restarting', 'ts': 0})
snap = agent.record_err_snapshot(page, mp, 1000.0, 980.0)
check('扣款但未轉成 → deducted=True', snap['deducted'] is True)
check('扣款但未轉成 → 需要查帳', snap['needsReconcile'] is True)
check('帶上伺服器描述', snap['errcodedes'] == 'service restarting', snap['errcodedes'])

# ② 沒扣、沒轉成 → 只是按了沒反應
mp2 = {'last_ok_spin_ts': time.time()}
snap2 = agent.record_err_snapshot(page, mp2, 1000.0, 1000.0)
check('餘額沒變 → deducted=False', snap2['deducted'] is False)
check('餘額沒變且剛剛才成功過 → 不需要查帳', snap2['needsReconcile'] is False)

# ③ 讀不到餘額 → 判斷不了，要保守標記
mp3 = {'last_ok_spin_ts': time.time()}
snap3 = agent.record_err_snapshot(page, mp3, None, None)
check('餘額讀不到 → balanceUnknown=True', snap3['balanceUnknown'] is True)
check('餘額讀不到 → 保守標記需要查帳', snap3['needsReconcile'] is True)

print('\n2) 長時間沒恢復要升級（不只是單局失敗）')
mp4 = {'last_ok_spin_ts': time.time() - (agent.RECONCILE_GAP_SEC + 5)}
snap4 = agent.record_err_snapshot(page, mp4, 1000.0, 1000.0)
check(f'超過 {agent.RECONCILE_GAP_SEC}s 沒成功 → 需要查帳', snap4['needsReconcile'] is True)

print('\n3) 恢復時間要回填')
mp5 = {'err_snapshots': []}
agent.record_err_snapshot(page, mp5, 1000.0, 1000.0)
agent.record_err_snapshot(page, mp5, 1000.0, 1000.0)
check('回填前 recoverSec 是 None', all(x['recoverSec'] is None for x in mp5['err_snapshots']))
time.sleep(0.05)
agent.mark_spin_recovered(mp5)
check('成功後兩筆都被回填', all(x['recoverSec'] is not None for x in mp5['err_snapshots']))
check('成功後 last_ok_spin_ts 有更新', mp5.get('last_ok_spin_ts') is not None)

# 再錯一次，之前那批不該被重算
before = [x['recoverSec'] for x in mp5['err_snapshots']]
agent.record_err_snapshot(page, mp5, 1000.0, 1000.0)
agent.mark_spin_recovered(mp5)
after = [x['recoverSec'] for x in mp5['err_snapshots'][:2]]
check('已回填過的不會被第二次覆蓋', before == after, f'{before} vs {after}')

print('\n4) 統計結論')
snaps = [
    {'errcode': '25', 'deducted': True, 'balanceUnknown': False, 'needsReconcile': True, 'recoverSec': 3.0, 'errcodedes': 'a'},
    {'errcode': '25', 'deducted': False, 'balanceUnknown': False, 'needsReconcile': False, 'recoverSec': 8.2, 'errcodedes': 'service restarting'},
    {'errcode': '28', 'deducted': False, 'balanceUnknown': True, 'needsReconcile': True, 'recoverSec': None, 'errcodedes': ''},
]
summary = agent.summarize_err_snapshots(snaps)
check('err25 次數 2', summary['25']['count'] == 2)
check('err25 扣款疑慮 1', summary['25']['deducted'] == 1)
check('err25 最長恢復取最大值 8.2', summary['25']['maxRecoverSec'] == 8.2, str(summary['25']['maxRecoverSec']))
check('err25 描述取最後一筆非空的', summary['25']['lastDes'] == 'service restarting', summary['25']['lastDes'])
check('err28 餘額不明 1', summary['28']['unknown'] == 1)
check('沒有恢復時間時 maxRecoverSec 是 None', summary['28']['maxRecoverSec'] is None)

print('\n5) 本機快照有上限（不會無限長大）')
mp6 = {'err_snapshots': []}
for _ in range(agent.ERR_SNAPSHOT_KEEP + 50):
    agent.record_err_snapshot(page, mp6, 1000.0, 1000.0)
check(f'最多保留 {agent.ERR_SNAPSHOT_KEEP} 筆',
      len(mp6['err_snapshots']) == agent.ERR_SNAPSHOT_KEEP, str(len(mp6['err_snapshots'])))

print(f'\n{passed} 通過 / {failed} 失敗')
sys.exit(1 if failed else 0)
