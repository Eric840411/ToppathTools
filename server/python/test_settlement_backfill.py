"""
驗證「結算補登」——把缺的『餘額後 / win』往回補。

🚨 背景：`win` 與 `餘額後` 都要「這一局 begin 之後的 end」，而 `do_spin()` 只多等
   1.5 秒。實測 outcome=completed 455 筆，其中餘額後只有 1 筆有值（0.2%）。
   改成往回補（下一次 spin 前 / 停止時），不是等更久。

🚨 **這支測試的重點是使用者提的那個情境**：Spin 間隔 0.3~0.5 秒時，
   第 N 局的結算還沒回來、第 N+1 局就來了。此時
   ① 只留一個位子會被覆蓋 → 幾乎補不到
   ② 每局各自去找「我後面第一個 end」會**配到上一局的結算** → 錯值

   錯值比缺值危險：缺值只是少一筆樣本，錯值是一筆看起來有效的假資料。

跑法：python server/python/test_settlement_backfill.py
"""
import importlib.util
import os
import time

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('agent', os.path.join(HERE, 'toppath-agent.py'))
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

agent.log = lambda msg: None

# 攔下背景送出，改成收集起來檢查
POSTED = []
agent.async_call = lambda fn, *a, **k: POSTED.append(a)

PASS = FAIL = 0


def check(name, ok, extra=''):
    global PASS, FAIL
    print(('  PASS  ' if ok else '  FAIL  ') + name + (('  ' + extra) if extra else ''))
    if ok:
        PASS += 1
    else:
        FAIL += 1


class FakeFrame:
    def __init__(self, log):
        self.log = log

    def evaluate(self, expr):
        # 只實作 read_money_since 用的那個查詢
        if '__moneyLog' in expr:
            seq = int(expr.split('x.seq > ')[1].split(')')[0])
            return [e for e in self.log if e['seq'] > seq]
        return None


class FakePage:
    def __init__(self, log):
        self.frames = [FakeFrame(log)]


def pending(spin_seq, begin_seq, begin_coin, bal_before, bet, age=0.0):
    return {'spinSeq': spin_seq, 'beginSeq': begin_seq, 'beginCoin': begin_coin,
            'balanceBefore': bal_before, 'bet': bet, 'outcome': 'completed',
            'observedAt': 1000, 'at': time.time() - age}


CFG = {'machineType': 'M'}

print('1) 基本：end 到了就補上，win = end.coin - begin.coin')
POSTED.clear()
mp = {'pending_settlements': [pending(1, 10, 1000, 1250, 250)]}
page = FakePage([{'seq': 10, 'reason': 'begin', 'coin': 1000},
                 {'seq': 11, 'reason': 'end', 'coin': 1400}])
n = agent.try_backfill_settlement(page, mp, CFG, 'M')
check('補了 1 筆', n == 1, 'n=%s' % n)
check('餘額後 = end 的 coin', POSTED and POSTED[0][4] == 1400, str(POSTED[:1]))
check('win = 1400 - 1000 = 400', POSTED and POSTED[0][8] == 400)
check('補完就從佇列移除', mp['pending_settlements'] == [])

print('\n2) end 還沒到 → 留在佇列裡等，不要丟掉')
POSTED.clear()
mp = {'pending_settlements': [pending(1, 10, 1000, 1250, 250)]}
page = FakePage([{'seq': 10, 'reason': 'begin', 'coin': 1000}])
n = agent.try_backfill_settlement(page, mp, CFG, 'M')
check('沒補到', n == 0)
check('🚨 仍留在佇列（下一輪再試，不是一次不成就放棄）',
      len(mp['pending_settlements']) == 1)

print('\n3) 🚨 快速連打：多局同時待補 —— 使用者提的那個情境')
# 0.3s 間隔下第 1、2、3 局的結算都還沒回來就又打了下一局。
# 之後三個 end 陸續到達，必須「依序一對一」配回去。
POSTED.clear()
mp = {'pending_settlements': [pending(1, 10, 1000, 1250, 250),
                              pending(2, 12, 900, 1000, 100),
                              pending(3, 14, 800, 900, 100)]}
page = FakePage([
    {'seq': 10, 'reason': 'begin', 'coin': 1000},
    {'seq': 12, 'reason': 'begin', 'coin': 900},
    {'seq': 14, 'reason': 'begin', 'coin': 800},
    {'seq': 15, 'reason': 'end', 'coin': 1100},   # 第 1 局的結算
    {'seq': 16, 'reason': 'end', 'coin': 950},    # 第 2 局
    {'seq': 17, 'reason': 'end', 'coin': 1300},   # 第 3 局
])
n = agent.try_backfill_settlement(page, mp, CFG, 'M')
check('三局都補到', n == 3, 'n=%s' % n)
by_seq = {p[2]: p for p in POSTED}
check('🚨 第 1 局配到第一個 end（1100），不是別局的', by_seq.get(1, [None] * 9)[4] == 1100)
check('🚨 第 2 局配到第二個 end（950）', by_seq.get(2, [None] * 9)[4] == 950)
check('🚨 第 3 局配到第三個 end（1300）', by_seq.get(3, [None] * 9)[4] == 1300)
check('   win 各自對應正確', by_seq.get(1)[8] == 100 and by_seq.get(2)[8] == 50
      and by_seq.get(3)[8] == 500)

print('\n4) 🚨 end 晚於下一局的 begin —— 各自找「我後面第一個 end」會配錯')
# 這正是快速連打的典型：第 1 局的 end 比第 2 局的 begin 還晚到。
# 若第 2 局自己去找「seq > 12 的第一個 end」，會抓到 seq=13——那是第 1 局的結算。
POSTED.clear()
mp = {'pending_settlements': [pending(1, 10, 1000, 1250, 250),
                              pending(2, 12, 900, 1000, 100)]}
page = FakePage([
    {'seq': 10, 'reason': 'begin', 'coin': 1000},
    {'seq': 12, 'reason': 'begin', 'coin': 900},
    {'seq': 13, 'reason': 'end', 'coin': 1100},   # 第 1 局的，但排在第 2 局 begin 之後
    {'seq': 14, 'reason': 'end', 'coin': 980},    # 第 2 局的
])
agent.try_backfill_settlement(page, mp, CFG, 'M')
by_seq = {p[2]: p for p in POSTED}
check('🚨 第 1 局拿到 1100（它自己的）', by_seq.get(1, [None] * 9)[4] == 1100)
check('🚨 第 2 局拿到 980，**不是**第 1 局那筆 1100',
      by_seq.get(2, [None] * 9)[4] == 980,
      '配錯的話這裡會是 1100，而且看起來完全正常')

print('\n5) end 比待補的局少 → 只補得到的那幾筆，其餘留著')
POSTED.clear()
mp = {'pending_settlements': [pending(1, 10, 1000, 1250, 250),
                              pending(2, 12, 900, 1000, 100)]}
page = FakePage([{'seq': 10, 'reason': 'begin', 'coin': 1000},
                 {'seq': 12, 'reason': 'begin', 'coin': 900},
                 {'seq': 13, 'reason': 'end', 'coin': 1100}])
n = agent.try_backfill_settlement(page, mp, CFG, 'M')
check('只補 1 筆', n == 1, 'n=%s' % n)
check('另一筆留在佇列', len(mp['pending_settlements']) == 1
      and mp['pending_settlements'][0]['spinSeq'] == 2)

print('\n6) ⚠️ 過期的一律丟掉，不要硬補')
# 再久就有可能跨到別局或 FG 派彩，補上去會是錯的。
POSTED.clear()
mp = {'pending_settlements': [pending(1, 10, 1000, 1250, 250,
                                      age=agent.SETTLEMENT_BACKFILL_MAX_SEC + 1)]}
page = FakePage([{'seq': 10, 'reason': 'begin', 'coin': 1000},
                 {'seq': 11, 'reason': 'end', 'coin': 9999}])
n = agent.try_backfill_settlement(page, mp, CFG, 'M')
check('🚨 過期就不補（寧可缺值，不要錯值）', n == 0 and POSTED == [])
check('   而且從佇列清掉，不會一直卡著', mp['pending_settlements'] == [])

print('\n7) ⚠️ 派彩不可能是負的 → win 判 None，不要保留錯值')
POSTED.clear()
mp = {'pending_settlements': [pending(1, 10, 1000, 1250, 250)]}
page = FakePage([{'seq': 10, 'reason': 'begin', 'coin': 1000},
                 {'seq': 11, 'reason': 'end', 'coin': 500}])   # 比 begin 還低
agent.try_backfill_settlement(page, mp, CFG, 'M')
check('win 判 None', POSTED and POSTED[0][8] is None, str(POSTED[:1]))
check('   但餘額後照樣記下來（那是實際讀到的值）', POSTED and POSTED[0][4] == 500)

print('\n8) 空佇列不做事')
POSTED.clear()
mp = {'pending_settlements': []}
check('回 0、不送任何東西',
      agent.try_backfill_settlement(FakePage([]), mp, CFG, 'M') == 0 and POSTED == [])

print('\n%s（pass %d / fail %d）' % ('全部通過' if FAIL == 0 else '%d 項未過' % FAIL, PASS, FAIL))
raise SystemExit(1 if FAIL else 0)
