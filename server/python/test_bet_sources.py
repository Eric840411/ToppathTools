"""注額的兩個來源：①流水相鄰性 ②戰績同質推定。

    python server/python/test_bet_sources.py

🚨 **這支守的是「看起來有效的錯誤數字」。**
   注額一旦算錯，值不是 0、不是負、也沒超過餘額——所有合理性檢查都擋不住，
   最後只會變成對帳的 MISSING，看起來像掉單，其實是觀測算錯。
   所以每一條規則都要能回答：「它擋住的是什麼？」

   ⚠️ 只驗「算得對」是不夠的（feedback_test_false_assurance）。下面每一組都有
      對應的**反例**：把規則拿掉會發生什麼、舊規則在同一份資料上會錯成什麼樣。
"""
import importlib.util
import io
import sys
from pathlib import Path

# Windows 終端預設 cp950，印中文/✅ 會 UnicodeEncodeError 讓整支測試「失敗」
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

_spec = importlib.util.spec_from_file_location(
    'tpagent', str(Path(__file__).with_name('toppath-agent.py')))
agent = importlib.util.module_from_spec(_spec)
sys.modules['tpagent'] = agent
_spec.loader.exec_module(agent)

results = []


def check(title, ok, extra=''):
    print(f"  {'PASS' if ok else 'FAIL'}  {title}" + ('' if ok or not extra else f"  ← {extra}"))
    results.append(bool(ok))
    return ok


def row(seq, reason, coin):
    return {'seq': seq, 'reason': reason, 'coin': coin, 'ts': seq * 1000}


# ─── ① 流水相鄰性 ────────────────────────────────────────────────────────────
print('① 注額＝完整流水裡 begin 正前方那一則 end')

# 正常：…end(1050) → begin(962) → end(1000)   注額 88、派彩 38
normal = [row(1, 'begin', 1000), row(2, 'end', 1050), row(3, 'begin', 962), row(4, 'end', 1000)]
bet, win, before, after = agent.derive_round_amounts(normal, 2)
check('正常結算：bet=88、win=38', (bet, win) == (88, 38), f"{bet}/{win}")
check('前後餘額一起帶出來', (before, after) == (1050, 1000), f"{before}/{after}")

# 上一局還沒結算：begin 正前方是另一個 begin → 未知（**不是猜一個**）
pending = [row(1, 'end', 1050), row(2, 'begin', 962), row(3, 'begin', 874)]
bet_p, _, _, _ = agent.derive_round_amounts(pending, 2)
check('上一局還沒結算 → 注額未知', bet_p is None, str(bet_p))

# 🚨 反例：舊規則（取「流水裡最後一則 end」）在同一份資料上會算出 176——
#    那正是實測看到的值，而後台每一局都是 88。
old_rule_bet = 1050 - 874   # last end 1050 − 這局 begin 874
check('（反例）舊規則在同一份資料上會算出 176 這種跨局值', old_rule_bet == 176)
check('新規則不會輸出那個值', bet_p != old_rule_bet)

# begin 是流水的第一則（log 被截斷）→ 沒有「正前方」可看 → 未知
check('流水被截斷、begin 沒有前一則 → 未知',
      agent.derive_round_amounts([row(1, 'begin', 900), row(2, 'end', 950)], 0)[0] is None)

# begin 必須比「按下之前」的序號新，否則那是上一局的 begin
stale = [row(1, 'end', 1050), row(2, 'begin', 962), row(3, 'end', 1000)]
check('只認按下之後才出現的 begin（序號 <= 記號的不算）',
      agent.derive_round_amounts(stale, 2)[0] is None)
check('同一份流水，記號較早時就取得到', agent.derive_round_amounts(stale, 1)[0] == 88)

# 沒有 begin ＝ 這一下沒起局
check('沒有 begin → 四個值全是 None（不是 0）',
      agent.derive_round_amounts([row(1, 'end', 1050)], 0) == (None, None, None, None))

# 合理性檢查仍在：負的派彩不留
weird = [row(1, 'end', 1000), row(2, 'begin', 900), row(3, 'end', 800)]
check('派彩算出負數 → 當未知，不保留錯值', agent.derive_round_amounts(weird, 1)[1] is None)

# 🚨 **先過濾再找前一則**是錯的（CodeX 2026-09-20 指出）——證明我們沒這樣做：
#    只看 end 的話，begin(874) 的「前一則 end」是 1050，又會算出 176。
filtered_prev_end = [e for e in pending if e['reason'] == 'end'][-1]['coin']
check('（反例）先過濾成 end 再找前一則 → 又回到 176', filtered_prev_end - 874 == 176)


# 🚨 **相鄰性不是萬用的——有的遊戲一局送三則 moneyNtc。**
#    實測 BIGFULINK/NWR2065（2026-09-21）的真實流水：
#        begin(1997455) → end(1997455) → end(1998730) → begin(1997367) → …
#    下一局的 begin 是上一局 begin −88（＝真正的注額），但 begin 正前方那一則
#    end 是 1998730，相減得到 1363。**相鄰性在這個遊戲上算不出正確注額。**
#    這一組存在的意義是把這件事釘住：不要再以為相鄰性修好就萬事OK——
#    這種遊戲要靠 ② 的戰績推定，而守門（bet_is_plausible）是它們之間的閘。
bfl = [row(19, 'begin', 1997455), row(20, 'end', 1997455), row(21, 'end', 1998730),
       row(22, 'begin', 1997367), row(23, 'end', 1997367), row(24, 'end', 1997772)]
bfl_bet, _, _, _ = agent.derive_round_amounts(bfl, 21)
check('（已知限制）三則式遊戲：相鄰性算出的不是真注額', bfl_bet == 1363, str(bfl_bet))
check('而真正的注額是兩個 begin 的差 88', 1997455 - 1997367 == 88)
agent.known_bets_by_machine.clear()
agent.known_bets_by_machine['BFL'] = {88.0}
check('守門擋得住那個值（戰績裡沒有 1363）', agent.bet_is_plausible('BFL', bfl_bet) is False)
check('還沒收到戰績時也當未知（不放行）', agent.bet_is_plausible('NEW', bfl_bet) is False)
agent.known_bets_by_machine.clear()


# ─── ② 戰績同質推定 ──────────────────────────────────────────────────────────
print('\n② 涵蓋已確認 + 全同值 → 推定注額')

posted = []


def fake_async_call(fn, *args, **kwargs):
    if fn is agent.post_recon_spin:
        posted.append(args)


agent.async_call = fake_async_call


def rec(t, bet=88.0, win=0.0, gmid='G1'):
    return {'recordTime': t, 'bet': bet, 'win': win, 'gmid': gmid, 'gameid': '', 'orderId': ''}


def fresh(queue_len=3, rounds=3):
    agent.history_state_by_machine.clear()
    posted.clear()
    mp = {'bet_pending': [{'spinSeq': i, 'balanceBefore': 1000, 'balanceAfter': 1050,
                           'observedAt': 1_700_000_000_000 + i, 'outcome': 'completed', 'win': 50}
                          for i in range(1, queue_len + 1)],
          'rounds_since_history': rounds}
    return mp


BATCH1 = [rec(f'2026-09-21 10:00:{i:02d}') for i in range(10)]

# 第一次抓：沒有上一批可以比對重疊 → 只建基準，**不推定**
mp = fresh()
agent.apply_history_coverage('M', BATCH1, mp, {})
check('第一次抓只建基準，不推定', not posted and mp['bet_pending'] == [])

# 第二次抓：跟上一批有重疊、新增筆數夠、全同值 → 推定
mp = fresh()
agent.apply_history_coverage('M', BATCH1, mp, {})
mp['bet_pending'] = fresh_q = [{'spinSeq': i, 'balanceBefore': 1000, 'balanceAfter': 1050,
                                'observedAt': 1_700_000_000_000 + i, 'outcome': 'completed', 'win': 50}
                               for i in range(1, 4)]
mp['rounds_since_history'] = 3
batch2 = BATCH1[3:] + [rec(f'2026-09-21 10:00:{i:02d}') for i in range(10, 14)]
agent.apply_history_coverage('M', batch2, mp, {})
check('涵蓋成立＋全同值 → 三局都補上注額', len(posted) == 3, f"實際 {len(posted)}")
check('補上去的是戰績裡那個值 88', all(p[7] == 88.0 for p in posted), str(posted[:1]))
check('而且標成 history_uniform（推定，不是實算）',
      all(p[9] == "history_uniform" for p in posted), str(posted[:1]))
check('推定後佇列清空', mp['bet_pending'] == [])

# 斷鏈：這一批跟上一批完全沒有重疊 → 證明不了中間沒漏 → 維持未知
mp = fresh()
agent.apply_history_coverage('M', BATCH1, mp, {})
mp['bet_pending'] = list(fresh_q)
mp['rounds_since_history'] = 3
posted.clear()
agent.apply_history_coverage('M', [rec(f'2026-09-21 11:00:{i:02d}') for i in range(10)], mp, {})
check('沒有重疊（斷鏈）→ 不推定', not posted)
check('斷鏈時佇列丟掉，不留著假裝之後補得到', mp['bet_pending'] == [])

# 筆數不夠：新增 2 筆但這段期間起注 5 局 → 還沒全部入榜 → **留著等下一批**
mp = fresh()
agent.apply_history_coverage('M', BATCH1, mp, {})
mp['bet_pending'] = list(fresh_q)
mp['rounds_since_history'] = 5
posted.clear()
agent.apply_history_coverage('M', BATCH1[2:] + [rec('2026-09-21 10:00:10'), rec('2026-09-21 10:00:11')], mp, {})
check('新增筆數 < 起注局數 → 不推定', not posted)
check('而且佇列要留著（尾端局等下一批補齊，不是丟掉）', len(mp['bet_pending']) == 3)
check('累計筆數要延續到下一批，不歸零',
      agent.history_state_by_machine['M']['newAccum'] == 2,
      str(agent.history_state_by_machine['M']['newAccum']))

# 兩種注額 → 不猜
mp = fresh()
agent.apply_history_coverage('M', BATCH1, mp, {})
mp['bet_pending'] = list(fresh_q)
mp['rounds_since_history'] = 3
posted.clear()
agent.apply_history_coverage('M', BATCH1[3:] + [rec('2026-09-21 10:00:10', bet=176.0),
                                                rec('2026-09-21 10:00:11'),
                                                rec('2026-09-21 10:00:12'),
                                                rec('2026-09-21 10:00:13')], mp, {})
check('戰績出現兩種注額 → 不猜，維持未知', not posted)

# 🚨 **有交集 ≠ 沒漏**（CodeX 2026-09-21 更正）。舊局也可能湊出交集。
#    真正的證明是「上一批**最新**的那幾筆，這一批還看得到」——那才代表中間沒整段漏掉。
#    這一組就是分辨這兩者的：交集有（舊的那幾筆還在），但最新那筆已經被擠出名單。
mp = fresh()
agent.apply_history_coverage('M', BATCH1, mp, {})
mp['bet_pending'] = list(fresh_q)
mp['rounds_since_history'] = 3
posted.clear()
half_overlap = BATCH1[:3] + [rec(f'2026-09-21 10:00:{i:02d}') for i in range(20, 27)]
check('（分辨力）有交集但上一批最新筆不見了 → 不推定',
      (agent.apply_history_coverage('M', half_overlap, mp, {}), not posted)[1])
_key = lambda rs: {(r['recordTime'], r['bet'], r['win'], r['gmid']) for r in rs}
check('舊規則（只要有交集）會誤判成連續', bool(_key(BATCH1) & _key(half_overlap)))

# 別台機台的局不可以拿來湊筆數
mp = fresh()
agent.apply_history_coverage('M', BATCH1, mp, {'gameTitleCode': 'G1'})
mp['bet_pending'] = list(fresh_q)
mp['rounds_since_history'] = 4
posted.clear()
other_machine = BATCH1[3:] + [rec(f'2026-09-21 10:00:{i:02d}', gmid='G2') for i in range(10, 16)]
agent.apply_history_coverage('M', other_machine, mp, {'gameTitleCode': 'G1'})
check('別台機台的戰績不算進涵蓋筆數 → 不推定', not posted)
check('而且佇列留著等本台的局入榜', len(mp['bet_pending']) == 3)

# 隨機注額開著 → 整個推定停用（「目前為止同值」推不到下一局）
mp = fresh()
agent.apply_history_coverage('M', BATCH1, mp, {})
mp['bet_pending'] = list(fresh_q)
mp['rounds_since_history'] = 3
posted.clear()
agent.apply_history_coverage('M', BATCH1[3:] + [rec(f'2026-09-21 10:00:{i:02d}') for i in range(10, 14)],
                             mp, {'betRandomEnabled': True})
check('betRandom 開著 → 不推定', not posted)


# ─── ③ 設定本身（結構上就不能漏）──────────────────────────────────────────────
print('\n③ 抓取節奏')
check('每次抓的筆數要明顯大於抓取間隔的局數',
      agent.HISTORY_PAGE_COUNT >= agent.HISTORY_EVERY_SPINS * 2,
      f"{agent.HISTORY_PAGE_COUNT} vs {agent.HISTORY_EVERY_SPINS}")
src = Path(__file__).with_name('toppath-agent.py').read_text(encoding='utf-8')
check('戰績抓取已經不掛在截圖區塊底下',
      'fetch_and_post_pinus_records(page, mt, mp, cfg)' in src
      and 'pagecount: args.pagecount' in src)
check('注額來源有跟著送出去', "'betSource':" in src)

print(f"\n{'✅' if all(results) else '❌'} {sum(results)} 過 / {len(results) - sum(results)} 失敗")
sys.exit(0 if all(results) else 1)
