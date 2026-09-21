"""`read_last_end_coin` 的相鄰性規則測試。

    python server/python/test_prev_end_adjacency.py

🚨 **這支在守一個「看起來有效的錯誤數字」。**
   注額是用「上一則 end 的 coin − 這一局 begin 的 coin」推的，而這只有在那個 end
   真的是**上一局**的結算時才成立。Spin 間隔 1 秒、結算常常晚 1~2 秒到，於是
   按下 spin 的當下，`__moneyLog` 最後一則 end 可能是**兩局前**的。

   實測（NWR2065，2026-09-20）推出 bet 176／156／164，而後台每一局都是 88；
   這種值不是 0、不是負、也沒超過餘額——**所有合理性檢查都擋不住**，
   於是對帳的配對鍵（注額相等）永遠對不上，13 筆被記成 MISSING，
   看起來像掉單，其實是觀測算錯。

   規則：最後一則 `end` 之後如果還有 `begin`，代表上一局還沒結算 → 回 None（未知）。
   **寧可少一筆樣本，不要多一個錯值。**
"""
import io
import re
import sys
from pathlib import Path

# ⚠️ Windows 終端預設 cp950，印 ✅/❌ 會 UnicodeEncodeError 讓整支測試「失敗」，
#    而真正的檢查其實全過——先把 stdout 轉成 UTF-8 再說。
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

AGENT = Path(__file__).with_name('toppath-agent.py')


class FakeFrame:
    """把注入的那段 JS 用 Python 重寫一次，語意必須跟 `read_last_end_coin` 裡那段一致。

    ⚠️ 這裡是**複寫**不是執行真的 JS——所以下面第一個檢查會去比對原始碼裡
       真的有那兩個判斷，避免「測試過了但程式其實沒改」。
    """

    def __init__(self, money_log):
        self.money_log = money_log

    def evaluate(self, _script):
        last_end = -1
        last_begin = -1
        for i, row in enumerate(self.money_log):
            if row.get('reason') == 'end':
                last_end = i
            elif row.get('reason') == 'begin':
                last_begin = i
        if last_end < 0:
            return None
        if last_begin > last_end:
            return None
        return self.money_log[last_end].get('coin')


class FakePage:
    def __init__(self, money_log):
        self.frames = [FakeFrame(money_log)]


def check(title, ok, extra=''):
    print(f"  {'PASS' if ok else 'FAIL'}  {title}" + ('' if ok or not extra else f"  ← {extra}"))
    return ok


def main():
    results = []
    src = AGENT.read_text(encoding='utf-8')

    # ① 程式碼真的有那道相鄰性判斷（避免測試自己演一遍、程式沒改）
    results.append(check('原始碼有相鄰性判斷（last_begin > last_end → None）',
                         'if last_begin > last_end:' in src))
    results.append(check('原始碼不再直接取最後一則 end',
                         "filter(x => x.reason === 'end');" not in src))

    log_settled = [
        {'reason': 'begin', 'coin': 1000, 'seq': 1},
        {'reason': 'end', 'coin': 1050, 'seq': 2},
    ]
    log_pending = [
        {'reason': 'begin', 'coin': 1000, 'seq': 1},
        {'reason': 'end', 'coin': 1050, 'seq': 2},
        {'reason': 'begin', 'coin': 962, 'seq': 3},   # 這一局已經扣注，但還沒結算
    ]

    page_settled = FakePage(log_settled)
    page_pending = FakePage(log_pending)

    results.append(check('上一局已結算 → 回得出 coin', page_settled.frames[0].evaluate('') == 1050))
    results.append(check('上一局還沒結算 → 回 None（不要給錯的數字）',
                         page_pending.frames[0].evaluate('') is None))
    results.append(check('完全沒有 end → 回 None',
                         FakePage([{'reason': 'begin', 'coin': 1000, 'seq': 1}]).frames[0].evaluate('') is None))
    results.append(check('空的 moneyLog → 回 None', FakePage([]).frames[0].evaluate('') is None))

    # ② 一定要挑「流水最新」的 frame，不能拿第一個有值的
    results.append(check('有 _money_log_frame（挑最新的 frame）', '_money_log_frame' in src))
    results.append(check('read_money_since 走同一支', 'log, _seq = _money_log_frame(page)' in src))
    results.append(check('不再用「第一個有值的 frame」讀 __moneySeq',
                         'v = frame.evaluate("window.__moneySeq ?? null")' not in src))

    # ③ 回填時**不可以**自己回推注額（實測會產生 176／264／692／1477 這種更糟的值）
    results.append(check('回填路徑沒有用 ends[idx-1] 回推注額', 'ends[idx - 1]' not in src))
    results.append(check('回填仍然沿用點擊當下算出的 bet（未知就維持未知）',
                         re.search(r"p\['outcome'\], p\['bet'\], win", src) is not None))

    # ④ 推導注額要經過「遊戲戰績出現過的值」這道守門
    results.append(check('有 bet_is_plausible 守門', 'def bet_is_plausible' in src))
    results.append(check('送出前會先過守門（不合就當未知）',
                         'if bet is not None and not bet_is_plausible' in src))
    # 2026-09-21 反轉：沒有戰績時**當未知**，不再放行。
    # 未知現在會排進佇列等同質推定補上，所以「先當未知」不再是損失；
    # 而放行的代價是 session 開頭那幾局會原封不動送出算錯的值。
    results.append(check('沒有戰績時當未知（不放行）',
                         re.search(r"known = known_bets_by_machine\.get\(machine_type\)\s+"
                                   r"if not known:\s+return False", src) is not None))
    results.append(check('用「出現過的集合」而不是單一最常見值（隨機注額才不會被誤擋）',
                         'known_bets_by_machine.setdefault' in src and '.update(bets)' in src))

    # 規則本身（跟 toppath-agent.py 裡那支同語意；上面幾項負責確認程式真的有那段）
    known = {'M': {88.0}, 'R': {88.0, 176.0}}

    def gate(machine, bet):
        if bet is None:
            return False
        ks = known.get(machine)
        if not ks:
            return False
        return any(abs(float(bet) - k) < 0.001 for k in ks)

    results.append(check('注額 88 → 放行', gate('M', 88) is True))
    results.append(check('注額 126（跨局推導）→ 擋下', gate('M', 126) is False))
    results.append(check('None → 不算合法值', gate('M', None) is False))
    results.append(check('隨機注額：176 也放行', gate('R', 176) is True))
    results.append(check('沒收到戰績的機台 → 當未知（之後由同質推定補）', gate('NEW', 999) is False))

    ok = all(results)
    print(f"\n{'✅' if ok else '❌'} {sum(results)} 過 / {len(results) - sum(results)} 失敗")
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
