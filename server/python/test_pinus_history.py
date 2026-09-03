"""
驗證 Pinus 戰績紀錄查詢：uid 取值、錯誤要印出來、拿不到 uid 就不要送。

背景（2026-09-03 實測，使用者本機正在跑的 BULLBLITZ session）：
`historyListReq` 送出的 uid 一直是空字串（原本取自 `window._uid` /
`window.pinus.uid`，這個遊戲兩個都沒有），伺服器每次回 errcode 15「參數錯誤」。
而錯誤回應沒有 `list` 欄位，程式落到 `if not records: return` **靜默結束**——
整個 session 打了 10 次、10 次全失敗、一行日誌都沒有，
三路對帳因此 111 筆全部顯示「缺資料」。

⚠️ 所以這支要守的重點是**訊號不能被吞掉**，不只是「uid 要對」：
   uid 修好之後，下一個錯誤如果照樣靜默，一樣會拖十天沒人發現。

不需要瀏覽器：用假的 page。

跑法：python server/python/test_pinus_history.py
"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('agent', os.path.join(HERE, 'toppath-agent.py'))
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

# 這台終端機是 cp950，印不出簡體字（伺服器回的 errcodedes 是「参数错误」）會直接 crash。
# 不 reconfigure 的話測試會在「印出結果」這一步掛掉，而不是在斷言失敗——很難看出真正原因。
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

PASS = []
FAIL = []


def check(name, ok, extra=''):
    (PASS if ok else FAIL).append(name)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{('  ' + str(extra)) if extra else ''}")


class FakePage:
    """假 page：uid 由建構參數給，historyListReq 的回應也由參數給。"""

    def __init__(self, uid, history_res):
        self.uid = uid
        self.history_res = history_res
        self.requests = []   # 記下實際送出的 historyListReq 參數

    def evaluate(self, expr, arg=None):
        if '__pinusUid' in expr:
            return self.uid
        if 'historyListReq' in expr:
            self.requests.append(arg)
            return {'res': self.history_res}
        return None


def run(uid, history_res, machine='TESTM'):
    """跑一次 fetch_and_post_pinus_records，回傳 (page, 印出來的日誌)。"""
    page = FakePage(uid, history_res)
    logs = []
    orig_log, orig_post = agent.log, getattr(agent, 'requests', None)
    agent.log = lambda m: logs.append(m)

    class NoNet:
        @staticmethod
        def post(*a, **k):
            logs.append('__POSTED__')
            class R: status_code = 200
            return R()
    agent.requests = NoNet
    agent.server_url, agent.session_id = 'http://x', 'sess'
    try:
        agent.fetch_and_post_pinus_records(page, machine)
    finally:
        agent.log = orig_log
        if orig_post is not None:
            agent.requests = orig_post
    return page, logs


print('\n1) 拿不到 uid：不要送出註定失敗的請求')
# ⚠️ 原本是照送空字串。每 20 次 spin 打一次一定被打回的請求，
#    污染日誌也污染伺服器，而且真正的錯誤還是被淹掉。
agent.pinus_uid_skip_count.clear()
page, logs = run('', {'list': [{'order_id': 'A'}]})
check('完全沒有送出 historyListReq', len(page.requests) == 0, f'送了 {len(page.requests)} 次')
check('有印出略過的原因', any('略過戰績紀錄' in m for m in logs), logs)
check('沒有上傳任何東西', '__POSTED__' not in logs)

print('\n2) 略過的日誌要節流，不能自己變成洗版來源')
agent.pinus_uid_skip_count.clear()
counts = []
for i in range(25):
    _, lg = run('', {})
    counts.append(sum(1 for m in lg if '略過戰績紀錄' in m))
total = sum(counts)
check('25 次只印 3 次（第 1、10、20 次）', total == 3, f'印了 {total} 次')
check('第一次一定印（不然完全不知道發生過）', counts[0] == 1)

print('\n3) 錯誤回應一定要印出來，不能靜默 return')
# 這是這次真正的教訓：uid 修好之後，下一個錯誤如果照樣靜默，一樣會拖很久沒人發現。
agent.pinus_uid_skip_count.clear()
page, logs = run('325599', {'errcode': 15, 'errcodedes': '参数错误'})
errline = next((m for m in logs if 'errcode' in m), '')
check('有印出錯誤', errline != '', logs)
check('訊息含 errcode 值', '15' in errline)
check('訊息含伺服器給的描述', '参数错误' in errline)
check('訊息含 uid（才知道是不是身分抓錯）', '325599' in errline)
check('錯誤時不上傳', '__POSTED__' not in logs)

print('\n4) 正常情況：拿得到 uid 就用它、有資料就上傳')
agent.pinus_uid_skip_count.clear()
page, logs = run('325599', {'list': [
    {'order_id': '873-BULLBLITZ-0136|6A99', 'bet': 1250, 'win': 0, 'gmid': 'g', 'gameid': 'bullblitz', 'time': 't'},
]})
check('有送出 historyListReq', len(page.requests) == 1)
check('送出的 uid 是真的 uid 不是空字串', page.requests[0] == '325599', page.requests)
check('有上傳', '__POSTED__' in logs)
check('有印出上傳筆數', any('上傳 1 筆' in m for m in logs), logs)

print('\n5) errcode 0 是正常，不要誤判成錯誤')
agent.pinus_uid_skip_count.clear()
page, logs = run('325599', {'errcode': 0, 'list': [{'order_id': 'X', 'bet': 1, 'win': 0}]})
check('errcode 0 不當成錯誤', not any('查詢失敗' in m for m in logs), logs)
check('照常上傳', '__POSTED__' in logs)

print('\n6) 有 uid 但真的沒紀錄：安靜結束是對的')
# 這種情況本來就沒東西可傳，印日誌只會變雜訊
agent.pinus_uid_skip_count.clear()
page, logs = run('325599', {'list': []})
check('不上傳', '__POSTED__' not in logs)
check('不印錯誤', not any('查詢失敗' in m for m in logs))

print(f"\n{'全部通過' if not FAIL else str(len(FAIL)) + ' 項未過'}（pass {len(PASS)} / fail {len(FAIL)}）")
sys.exit(1 if FAIL else 0)
