"""
驗證「父程序停得下來」——按下停止之後機台被不斷重新拉起的那個 bug。

🚨 **原本的壞法**：AutoSpin 是「一個父程序 + 每台機台一個子程序」。
   伺服器在執行中重啟時（部署就會），子程序自己重新註冊拿到新的 session id
   ——**但那是它自己那個 process 裡的變數，父程序不知道**。父程序還拿著舊的、
   已失效的 id 在問「該停了嗎」，而它只看回應裡有沒有 `stop`；
   session 不存在的回應裡當然沒有 `stop`，所以**父程序永遠等不到停止指令**，
   只會一直看到子程序結束、再把它拉起來。

   使用者按停止 → 子程序乖乖離機關瀏覽器 → 父程序把它重啟 → 無限循環。

⚠️ 這段要真的多程序才跑得起來，所以邏輯抽成純函式來測。
   測試重點是**兩條路互相獨立**：任何一條單獨壞掉，另一條都還要能停。

跑法：python server/python/test_parent_stop.py
"""
import importlib.util
import os

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


SID = agent.SHARED_SESSION_KEY
STOP = agent.SHARED_STOP_KEY

print('1) 父程序要用「子程序重新註冊後的新 session id」')
check('共用狀態有新 id → 用新的',
      agent.parent_poll_session_id({SID: 'new-1'}, 'old-0') == 'new-1')
check('還沒有新 id → 用自己原本的',
      agent.parent_poll_session_id({}, 'old-0') == 'old-0')
check('值是空字串也視為沒有（不要拿空字串去打 API）',
      agent.parent_poll_session_id({SID: ''}, 'old-0') == 'old-0')
check('拿不到共用物件時不炸、退回自己的',
      agent.parent_poll_session_id(None, 'old-0') == 'old-0')

print('\n2) 🚨 兩條路互相獨立 —— 任一條單獨成立就要停')
# 路 ①：伺服器明講 stop
check('只有伺服器回 stop（共用旗標沒設）→ 停',
      agent.parent_should_stop({'stop': True}, {}) is True)
# 路 ②：子程序設了共用旗標
check('🚨 只有共用旗標（伺服器回應完全沒用）→ 一樣要停',
      agent.parent_should_stop({}, {STOP: True}) is True)
check('   連 HTTP 都失敗、只剩共用旗標 → 一樣要停',
      agent.parent_should_stop(None, {STOP: True}) is True)

print('\n3) ⚠️ 重現那個 bug 的實際情境')
# session 失效的回應長這樣：有 sessionNotFound、但**沒有 stop**。
# 舊版只看 stop，於是永遠不停。
dead = {'stop': False, 'sessionNotFound': True, 'pause': False}
check('🚨 session 已失效的回應（沒有 stop）→ 舊版就是卡在這裡',
      agent.parent_should_stop(dead, {}) is False,
      '這條回 False 是對的——這個當下確實還沒有人要求停止')
check('🚨 同樣的回應，但子程序已經看過停止指令 → **停得下來**',
      agent.parent_should_stop(dead, {STOP: True}) is True,
      '這就是修好的地方')

print('\n4) 都沒有停止意圖時不要亂停')
check('正常回應、旗標沒設 → 不停',
      agent.parent_should_stop({'stop': False}, {}) is False)
check('空回應、旗標沒設 → 不停', agent.parent_should_stop({}, {}) is False)
check('共用狀態拿不到 → 不停（不要因為讀不到就殺掉長壓測）',
      agent.parent_should_stop({}, None) is False)

print('\n5) 最後一道閘：有人要求停止就不准重啟機台')
check('🚨 旗標已設 → 監控迴圈不准復活機台',
      agent.restart_blocked({STOP: True}) is True)
check('旗標沒設 → 照常可以自動重啟（這是既有的斷線復原能力，不能弄丟）',
      agent.restart_blocked({}) is False)
check('共用狀態拿不到 → 不阻擋（保守：寧可多重啟一次，也不要讓斷線復原失效）',
      agent.restart_blocked(None) is False)


class Boom(dict):
    def get(self, *a, **k):
        raise RuntimeError('Manager 連線斷了')


print('\n6) ⚠️ 共用狀態本身壞掉時不能連累主流程')
# Manager 的 proxy 物件在 parent 收尾時可能已經關閉，讀取會拋例外。
check('讀取拋例外 → 判成「沒有停止意圖」而不是整個崩掉',
      agent.parent_should_stop({}, Boom()) is False)
check('讀取拋例外 → 不阻擋重啟', agent.restart_blocked(Boom()) is False)
check('讀取拋例外 → session id 退回自己的',
      agent.parent_poll_session_id(Boom(), 'old-0') == 'old-0')

print('\n%s（pass %d / fail %d）' % ('全部通過' if FAIL == 0 else '%d 項未過' % FAIL, PASS, FAIL))
raise SystemExit(1 if FAIL else 0)
