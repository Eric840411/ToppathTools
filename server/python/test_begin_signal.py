"""
驗證「沒收到 moneyNtc begin 就不算起注」的三態判定。

這條規則的風險是**單向的**：判太寬會把真實的局標成「沒起注」而排除在對帳外，
**整台機台的帳會靜默歸零**——那比現在的誤報嚴重得多，因為畫面上看起來很乾淨。
所以測試重點放在 fail-open：**還沒證明 begin 可信之前，一律不套用規則。**

跑法：python server/python/test_begin_signal.py
（注意是 python 不是 python3——python3 那個沒有 requests）
"""
import importlib.util
import os

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('agent', os.path.join(HERE, 'toppath-agent.py'))
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

LOGS = []
agent.log = lambda msg: LOGS.append(msg)

PASS = FAIL = 0


def check(name, ok, extra=''):
    global PASS, FAIL
    print(('  PASS  ' if ok else '  FAIL  ') + name + (('  ' + extra) if extra else ''))
    if ok:
        PASS += 1
    else:
        FAIL += 1


def reset():
    agent.begin_signal_state = 'unknown'
    agent.no_begin_streak = 0
    agent.last_begin_at = None
    LOGS.clear()


print('1) fail-open：還沒看過 begin 之前，規則不准生效')
# 某款遊戲若根本不發 begin，一律套用會讓整台機台的對帳靜默歸零。
reset()
for _ in range(50):
    st = agent.update_begin_signal_state(False, 'M', now=1000.0)
check('沒看過 begin 時，連續 50 次仍維持 unknown', st == 'unknown', 'state=' + st)
check('   而且不會誤跳到 disabled（那會讓人以為偵測壞了）', st != 'disabled')

print('\n2) 看過一次 begin 之後才開始信任它')
reset()
check('第一次 begin → supported', agent.update_begin_signal_state(True, 'M', now=1000.0) == 'supported')
check('   有印出啟用訊息（使用者要看得到規則何時開始生效）',
      any('啟用' in m for m in LOGS))
check('之後沒有 begin → 仍是 supported（單次沒有不代表壞掉）',
      agent.update_begin_signal_state(False, 'M', now=1001.0) == 'supported')

print('\n3) ⚠️ 雙門檻：次數與時間都要超過才停用規則')
# 只看次數會被長 FG 打爆；只看時間會在「沒人操作／機台停住」時誤觸發。
reset()
agent.update_begin_signal_state(True, 'M', now=0.0)
st = 'supported'
for i in range(agent.NO_BEGIN_STREAK_LIMIT + 5):
    st = agent.update_begin_signal_state(False, 'M', now=60.0)   # 只過 1 分鐘
check('🚨 次數超過但時間沒到 → 不停用（長 FG 不該把規則關掉）',
      st == 'supported', 'streak=%d state=%s' % (agent.no_begin_streak, st))

reset()
agent.update_begin_signal_state(True, 'M', now=0.0)
st = agent.update_begin_signal_state(False, 'M', now=99999.0)    # 時間夠久但只有 1 次
check('🚨 時間超過但次數沒到 → 不停用（機台停住不該誤判成故障）',
      st == 'supported', 'streak=%d state=%s' % (agent.no_begin_streak, st))

reset()
agent.update_begin_signal_state(True, 'M', now=0.0)
st = 'supported'
for i in range(agent.NO_BEGIN_STREAK_LIMIT):
    st = agent.update_begin_signal_state(False, 'M', now=agent.NO_BEGIN_SECONDS_LIMIT + 1)
check('兩個都超過 → 才停用並告警', st == 'disabled', 'state=' + st)
check('   告警訊息同時講出次數與時間（只講一個看不出是哪個門檻踩到）',
      any('連續' in m and '分鐘' in m for m in LOGS))

print('\n4) 收到 begin 就把計數與計時一起歸零')
reset()
agent.update_begin_signal_state(True, 'M', now=0.0)
for _ in range(10):
    agent.update_begin_signal_state(False, 'M', now=100.0)
check('中途有 begin → streak 歸零',
      agent.update_begin_signal_state(True, 'M', now=200.0) == 'supported'
      and agent.no_begin_streak == 0, 'streak=%d' % agent.no_begin_streak)
check('   last_begin_at 也跟著更新（不更新的話時間門檻會一直是滿的）',
      agent.last_begin_at == 200.0, 'last_begin_at=%s' % agent.last_begin_at)

print('\n5) ⚠️ disabled 之後不會自己悄悄復原')
# 復原的正確途徑是人去修 begin 偵測，不是讓它自己回來——
# 自己回來的話問題會在「偶爾生效、偶爾不生效」之間漂，比一直壞更難查。
reset()
agent.update_begin_signal_state(True, 'M', now=0.0)
for _ in range(agent.NO_BEGIN_STREAK_LIMIT):
    agent.update_begin_signal_state(False, 'M', now=agent.NO_BEGIN_SECONDS_LIMIT + 1)
check('已 disabled', agent.begin_signal_state == 'disabled')
st = agent.update_begin_signal_state(True, 'M', now=99999.0)
check('   再收到 begin 會回到 supported（這是明確的證據，可以復原）', st == 'supported')

print('\n6) outcome 判定的順序')
{
    # no_bet 一定要排在 completed 之前：FG 派彩也會觸發 coin_update，
    # 先判 completed 的話特殊遊戲期間每一次按鈕都會被記成「完成一局」。
}
src = open(os.path.join(HERE, 'toppath-agent.py'), encoding='utf-8').read()
i_no_bet = src.find("outcome = 'no_bet'")
i_completed = src.find("outcome = 'completed'")
i_not_started = src.find("outcome = 'not_started'")
check('🚨 no_bet 判定排在 completed 之前（FG 派彩也會觸發 coin_update）',
      0 < i_no_bet < i_completed, 'no_bet@%d completed@%d' % (i_no_bet, i_completed))
check('not_started（伺服器明確拒絕）排最前面', 0 < i_not_started < i_no_bet)

print('\n%s（pass %d / fail %d）' % ('全部通過' if FAIL == 0 else '%d 項未過' % FAIL, PASS, FAIL))
raise SystemExit(1 if FAIL else 0)
