"""
驗證「離桌後要等畫面真的回到大廳才重進」。

🚨 **原本的壞法**（2026-11-11 Spug RISINGROCKETS，隨機離開連續 3 次）：
   leaveGMNtc errcode=0 一到就 enter_game，舊遊戲 DOM 還在 → is_in_game() 判
   「已在遊戲中，跳過大廳」→ 根本沒重進 → 20 秒讀不到餘額 → 停這台 → watchdog 重啟。

跑法：python server/python/test_reenter_lobby.py
"""
import importlib.util
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('agent', os.path.join(HERE, 'toppath-agent.py'))
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

PASS = FAIL = 0


def check(name, ok, extra=''):
    global PASS, FAIL
    print(('  PASS  ' if ok else '  FAIL  ') + name + (('  ' + extra) if extra else ''))
    if ok:
        PASS += 1
    else:
        FAIL += 1


class El:
    def __init__(self, visible):
        self.visible = visible

    def is_visible(self):
        return self.visible


class Loc:
    def __init__(self, page, sel):
        self.page, self.sel = page, sel

    def all(self):
        return [El(True)] if self.sel in self.page.visible_now() else []


GAME = {'.my-button.btn_spin', '.balance-bg.hand_balance'}
LOBBY = {'#grid_gm_item'}


class FakePage:
    """timeline: [(從開始經過幾秒, 那時看得到的 selector 集合), ...]，取最後一個已到的。"""

    def __init__(self, timeline):
        self.timeline = timeline
        self.t0 = time.time()

    def visible_now(self):
        el = time.time() - self.t0
        cur = set()
        for at, vis in self.timeline:
            if el >= at:
                cur = vis
        return cur

    def locator(self, sel):
        return Loc(self, sel)


print('1) is_clean_lobby：大廳要看得到，而且舊遊戲指標要消失')
check('只有遊戲畫面 → 不是大廳', not agent.is_clean_lobby(FakePage([(0, GAME)])))
check('新舊 DOM 重疊（大廳＋Spin 按鈕都在）→ 不是大廳',
      not agent.is_clean_lobby(FakePage([(0, GAME | LOBBY)])))
check('只有大廳 → 是大廳', agent.is_clean_lobby(FakePage([(0, LOBBY)])))
check('什麼都沒有（切換中空白）→ 不是大廳', not agent.is_clean_lobby(FakePage([(0, set())])))

print('2) wait_clean_lobby')
p = FakePage([(0, GAME), (0.8, GAME | LOBBY), (1.6, LOBBY)])
t = time.time()
ok = agent.wait_clean_lobby(p, 5)
check('延遲切換：等到乾淨的大廳才回 True', ok and time.time() - t >= 1.5, f'{time.time() - t:.1f}s')
check('一直卡在舊遊戲畫面 → 逾時回 False', not agent.wait_clean_lobby(FakePage([(0, GAME)]), 1.2))
agent.stop_flag.set()
t = time.time()
r = agent.wait_clean_lobby(FakePage([(0, GAME)]), 5)
check('按停止會中斷等待', not r and time.time() - t < 1.5, f'{time.time() - t:.1f}s')
agent.stop_flag.clear()

print('3) leave_and_reenter 整條')
calls = []
agent.log = lambda m: calls.append(('log', m))
agent.leave_game = lambda page, cfg, mt: True
agent.wait_fresh_balance = lambda page, since, mb: (True, 100.0)
agent.REENTRY_LOBBY_WAIT_SEC = 1.2


def fake_enter(page, cfg):
    calls.append(('enter', page.visible_now()))
    return True


agent.enter_game = fake_enter

calls.clear()
mp = {}
r = agent.leave_and_reenter(FakePage([(0, GAME), (0.6, LOBBY)]), {}, 'MT', mp, 0.0, '隨機離開')
enters = [c for c in calls if c[0] == 'enter']
check('畫面切回大廳後才呼叫 enter_game', r and len(enters) == 1 and enters[0][1] == LOBBY)
check('重進時 left_seat 改回 False（收尾要照樣離桌）', mp.get('left_seat') is False)

calls.clear()
mp = {}
r = agent.leave_and_reenter(FakePage([(0, GAME)]), {}, 'MT', mp, 0.0, '隨機離開')
check('舊畫面一直不走 → 不重進、回 False', not r and not [c for c in calls if c[0] == 'enter'])
check('這時離桌已確認、沒重進 → left_seat=True', mp.get('left_seat') is True)
check('有寫出原因', any('沒有切回大廳' in c[1] for c in calls if c[0] == 'log'))

calls.clear()
mp = {}
agent.enter_game = lambda page, cfg: False
agent.detect_seat_state = lambda page: 'unknown'
r = agent.leave_and_reenter(FakePage([(0, LOBBY)]), {}, 'MT', mp, 0.0, '隨機離開')
check('回到大廳但重進失敗、狀態不明 → left_seat=False（收尾再離一次）',
      not r and mp.get('left_seat') is False)

print(f'\n{PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
