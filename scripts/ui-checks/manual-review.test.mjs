/**
 * 機台測試報告：人工複核優先於自動判定（1007 osm-qa-agent 回報、CodeX 定案）。
 *
 *   node scripts/ui-checks/manual-review.test.mjs
 *
 * 守：iDeck／CCTV 複核後重產兩次仍是 pass；未複核照舊；FAIL 不能用這個旗標轉 pass；
 *     其他次執行的覆核不沿用；applyGameRules 和 classify 兩處都認（只修一處會被另一處改判）。
 * 最後用 osm-qa-agent 的真 summary（有的話）跑一次，只讀不寫。
 */
import fs from 'node:fs'
import path from 'node:path'
import { applyGameRules, classify } from '../machine-test/machine-test-batch.mjs'

let fail = 0, n = 0
const ok = (c, label, got) => { n++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${!c && got !== undefined ? `：${JSON.stringify(got).slice(0, 400)}` : ''}`) }

const SID = 'mt_test_manual'
const run = (code, steps, sessionId = SID) => applyGameRules({ machineCode: code, sessionId, steps })
const one = (code, step, sessionId) => run(code, [step], sessionId).steps[0]
const ideckOrig = 'server 回應 10/10（Bet0✓ Bet1✓）；還原 BetMultiple1 ✓｜iDeck 開局 0 顆'
const ideckStep = { step: 'iDeck 測試', status: 'pass', message: ideckOrig, extraData: { learn: JSON.stringify({ actions: [{ name: 'Bet0' }] }), ideckShots: '[]' } }
const reviewed = (s, mr = true) => ({ ...s, status: 'pass', manualReview: mr, message: `［人工複核 1007，使用者確認］BET 欄有跟著變｜原訊息：${s.message}` })

// ── iDeck：未複核照舊（未驗）；複核過 → pass，重產兩次仍是 pass ──
const auto = one('873-ZZNOCFG-0001', ideckStep)
ok(auto.status === 'skip' && classify(auto) === 'na', '未複核：iDeck 開局 0 顆 → 未驗（照舊）', auto)
const r1 = one('873-ZZNOCFG-0001', reviewed(ideckStep))
ok(r1.status === 'pass' && classify(r1) === 'pass' && r1.manualApplied?.auto === 'na' && r1.manualApplied.legacy === true, 'iDeck 人工複核（舊格式 true）→ pass，記下覆核前是 N/V', r1)
const r2 = one('873-ZZNOCFG-0001', r1)
ok(r2.status === 'pass' && classify(r2) === 'pass', '重產第二次仍是 pass（套過規則的結果再套一次）', r2)
const pre = one('873-ZZNOCFG-0001', { ...ideckStep, status: 'pass', message: `［人工複核 1007］看過了｜原訊息：${ideckOrig}` })
ok(pre.status === 'pass' && pre.manualApplied?.legacy === true, '只有訊息前綴「［人工複核」（舊資料）也認，標 legacy', pre)

// ── CCTV：影像編號不符 → check；複核過 → pass ──
const cctv = { step: 'CCTV 號碼比對', status: 'warn', message: 'CCTV 影像編號不符：畫面 0347、預期 0354' }
ok(classify(one('892-ZZNOCFG-0347', cctv)) === 'check', '未複核：CCTV 影像編號不符 → check（照舊）')
const c1 = one('892-ZZNOCFG-0347', { ...reviewed(cctv), manualReview: { by: 'osm-qa-agent', at: '2026-10-07', sessionId: SID, before: { status: 'warn', message: cctv.message } } })
ok(c1.status === 'pass' && classify(c1) === 'pass' && c1.manualApplied?.auto === 'check' && c1.manualApplied.by === 'osm-qa-agent', 'CCTV 人工複核（結構化）→ pass，記下覆核人與覆核前是 check', c1)
ok(classify(one('892-ZZNOCFG-0347', c1)) === 'pass', 'CCTV 重產第二次仍是 pass')
const comp = { step: 'CCTV 號碼比對', status: 'warn', message: 'CCTV 構圖待人工確認（兩次判讀不一致）' }
ok(classify(one('892-ZZNOCFG-0347', reviewed(comp))) === 'pass', 'CCTV 構圖待人工確認 → 複核後 pass')

// ── FAIL 不能用這個旗標轉 pass ──
const silent = { step: '音頻檢測', status: 'warn', message: 'VB-Cable 錄音：RMS -99.7 dB｜靜音' }
ok(classify(silent) === 'fail', '前提：靜音的音頻步驟自動判定是 FAIL')
const a1 = one('892-ZZNOCFG-0210', { ...reviewed(silent), manualReview: { by: 'x', at: 'y', before: { status: 'warn', message: silent.message } } })
ok(a1.status === 'warn' && classify(a1) === 'fail' && /人工複核未採用：自動判定是 FAIL/.test(a1.message), '結構化 before 顯示原本是 FAIL → 不採用、狀態回到原本、仍是 FAIL', a1)
// ARUZE 機種規則把「開局 0 顆」判 FAIL：舊格式複核也不能放行
const aruze = one('873-ARUZE-0333', reviewed({ ...ideckStep, message: 'server 回應 5/5｜iDeck 開局 0 顆' }))
ok(aruze.status === 'fail' && classify(aruze) === 'fail' && /人工複核未採用/.test(aruze.message), 'ARUZE 規則判 FAIL 的 iDeck，複核旗標不能改成 pass', aruze)

// ── 覆核只綁定該次執行 ──
const other = one('873-ZZNOCFG-0001', reviewed(ideckStep, { by: 'x', at: 'y', sessionId: 'mt_old_run', before: { status: 'pass', message: ideckOrig } }))
ok(other.status === 'skip' && classify(other) === 'na' && /另一次執行/.test(other.message), '覆核記錄屬於另一次執行 → 不沿用，照自動判定', other)

// ── 沒覆核、但狀態本來就 pass 的：不受影響 ──
const plain = { step: 'Spin 測試', status: 'pass', message: 'Spin 正常' }
ok(JSON.stringify(one('873-ZZNOCFG-0001', plain)) === JSON.stringify(plain), '沒有複核標記的步驟原封不動')

// ── 真資料（osm-qa-agent 的 summary，只讀）：複核過的步驟都不能再被判成 N/V／check ──
const REPORTS = path.join(process.env.USERPROFILE ?? '', 'Desktop', 'osm-qa-agent', 'reports')
const real = ['mt_1791367950172_uyxqr'].map(s => path.join(REPORTS, `machine-test-${s}`, 'summary.json')).filter(f => fs.existsSync(f))
for (const f of real) {
  const sum = JSON.parse(fs.readFileSync(f, 'utf8'))
  const bad = [], seen = []
  for (const m of sum.machines ?? []) {
    if (!m.result?.steps) continue
    const ruled = applyGameRules(m.result)
    ruled.steps.forEach((s, i) => {
      if (!m.result.steps[i].manualReview) return
      const c = classify(s)
      seen.push(`${m.code} ${s.step}=${c}`)
      if (c === 'na' || c === 'check') bad.push(`${m.code} ${s.step}=${c}`)
    })
  }
  ok(seen.length > 0 && !bad.length, `真資料 ${path.basename(path.dirname(f))}：${seen.length} 個複核步驟都沒被判回 N/V／check`, { bad, seen })
}

console.log(fail ? `❌ ${fail}/${n} 失敗` : `✅ ${n}/${n} 通過`)
process.exit(fail ? 1 : 0)
