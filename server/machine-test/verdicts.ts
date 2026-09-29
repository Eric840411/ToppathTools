// 各步驟的純判定函式（2026-09-29 從 runner.ts 抽出來，好寫探針：scripts/verdicts-probe.ts）
// 規則跟 CodeX 對過：
//   - 每顆 SEND/ON 的 seq＋actionid 都對上才算點擊成功（只證明 server 收到）
//   - play 鍵（isspin:1）等不到 moneyNtc end → 中止後面所有點擊、判失敗（不補點，避免重複扣款）
//   - 有倍數鍵（BetMultipleN）就一定要按回 BetMultiple1 且驗到 ON；找不到還原鍵或還原沒回應都是失敗
//   - 盒子 log 是選配：查不到不影響；查得到但 0 筆 → WARN 待查（不能把 FAIL 降成 WARN）
// 訊息尾巴的「判定：no response／flow fail」給 batch 端 shortLine() 分 F 欄用語，改字要同步改那邊。

export type IdeckResult = 'ack' | 'mismatch' | 'noAck' | 'notSent' | 'noElement' | 'spinTimeout'
export interface IdeckOutcome { label: string; text: string; name: string | null; result: IdeckResult; note: string }

// 只有「送了沒回／actionid 對不上」才算 no response；前端沒送出（notSent）是點擊沒生效，算流程失敗（CodeX 0929）
const NO_RESPONSE: IdeckResult[] = ['mismatch', 'noAck']

export function ideckVerdict(p: {
  outcomes: IdeckOutcome[]
  restore: IdeckOutcome | null
  aborted: boolean
  apiErr: string | null
  boxCount: number
}): { status: 'pass' | 'warn' | 'fail'; message: string } {
  const { outcomes, restore, aborted, apiErr, boxCount } = p
  if (outcomes.length === 0) return { status: 'fail', message: '沒有可點的 iDeck 按鈕｜判定：flow fail' }

  const total = outcomes.length
  const acked = outcomes.filter(o => o.result === 'ack').length
  const bad = outcomes.filter(o => o.result !== 'ack')
  const hasMultiplier = outcomes.some(o => /^BetMultiple\d+$/.test(o.name ?? ''))

  const detail = outcomes.map(o => `${o.name ?? o.label}${o.result === 'ack' ? '✓' : '✗'}`).join(' ')
  let restoreTxt: string, restoreBad: 'noResponse' | 'flow' | null = null
  if (aborted) { restoreTxt = '；⚠️ 中止，沒有還原倍數'; restoreBad = 'flow' }
  else if (restore) {
    const ok = restore.result === 'ack'
    restoreTxt = `；還原 BetMultiple1 ${ok ? '✓' : '✗（⚠️ 倍數可能還留在最後按的那顆）'}`
    if (!ok) restoreBad = NO_RESPONSE.includes(restore.result) ? 'noResponse' : 'flow'
  } else if (hasMultiplier) { restoreTxt = '；⚠️ 有倍數鍵但找不到 BetMultiple1，還原未驗證'; restoreBad = 'flow' }
  else restoreTxt = '；沒有倍數鍵，不需還原'
  const boxTxt = apiErr ? `；盒子 log 未查（${apiErr}）` : `；盒子 log 新增 ${boxCount} 筆`

  let message = `server 回應 ${acked}/${total}（${detail}）${restoreTxt}${boxTxt}`
  if (bad.length) message += `｜未通過：${bad.map(o => `${o.label}「${o.text}」${o.result}${o.note ? '(' + o.note + ')' : ''}`).join('、')}`

  if (bad.length || restoreBad) {
    // 全部問題都是「送了沒回／actionid 對不上」才叫 no response；找不到元素、逾時、中止、找不到還原鍵＝流程失敗
    const flow = bad.some(o => !NO_RESPONSE.includes(o.result)) || restoreBad === 'flow'
    return { status: 'fail', message: `${message}｜判定：${flow ? 'flow fail' : 'no response'}` }
  }
  if (!apiErr && boxCount === 0) return { status: 'warn', message: `${message}｜⚠️ server 全部回應但盒子 log 0 筆，待查` }
  return { status: 'pass', message }
}

// 推流 main/pool（使用者 0929 確認的共通規則）：看得到的 video 依上下排，最上面＝pool（獎池畫面）、其餘＝main（滾輪）；只有一個＝main。
// 只要有一塊沒在播就算那一塊 no show（CodeX：不能讓 canvas 把全部停播蓋成 WARN）。
export interface VideoRect { y: number; h: number; playing: boolean }
// expected：這個機種應該有幾個畫面（machine-layout.json，BZZF＝2）；viewportH：畫面高度
// 少畫面時不能再「只有一個＝main」（0929 0243：唯一的 video 是上方獎池，main 整個不見）→ 依位置判：頂端在畫面上方 25% 內＝pool，否則＝main；缺的那個算 no show
export function streamRoles(rects: VideoRect[], opts: { expected?: number | null; viewportH?: number } = {}) {
  const sorted = [...rects].sort((a, b) => a.y - b.y)
  const expected = opts.expected ?? null
  let roles: Array<{ role: 'pool' | 'main'; playing: boolean; y: number; h: number }>
  if (expected && expected >= 2 && sorted.length < expected && opts.viewportH) {
    roles = sorted.map(v => ({ role: v.y < opts.viewportH! * 0.25 ? 'pool' as const : 'main' as const, playing: v.playing, y: Math.round(v.y), h: Math.round(v.h) }))
  } else {
    roles = sorted.map((v, i) => ({ role: sorted.length >= 2 && i === 0 ? 'pool' as const : 'main' as const, playing: v.playing, y: Math.round(v.y), h: Math.round(v.h) }))
  }
  const missing = expected && expected >= 2 ? (['main', 'pool'] as const).filter(r => !roles.some(x => x.role === r)) : []
  const noShow = [...new Set([...missing.map(r => `${r}stream no show`), ...roles.filter(v => !v.playing).map(v => `${v.role}stream no show`)])]
    .sort((a, b) => a.startsWith('main') ? -1 : b.startsWith('main') ? 1 : 0)
  return { roles, noShow, missing: [...missing] }
}

// iDeck 點擊順序（CodeX 0929：逾時後要「零點擊」——面額選單、下一顆、還原都不能再點）
//   press：點一顆並驗 SEND/ON（會真的點）；settle：點完後的收尾（關面額選單＝會再點、截圖、印 log）；
//   afterTimeout：開轉逾時的收尾（只能截圖、印 log，不可點任何東西）
export async function runIdeckSequence<B, O extends { name: string | null; result: IdeckResult }>(p: {
  buttons: B[]
  press: (b: B, idx: string) => Promise<O>
  settle: (o: O, idx: string) => Promise<void>
  afterTimeout: (o: O, idx: string) => Promise<void>
  shouldStop: () => boolean
}): Promise<{ outcomes: O[]; restore: O | null; aborted: boolean; stopped: boolean }> {
  const outcomes: O[] = []
  const step = async (b: B, idx: string) => {
    const o = await p.press(b, idx)
    if (o.result === 'spinTimeout') { await p.afterTimeout(o, idx); return { o, timeout: true } }
    await p.settle(o, idx)
    return { o, timeout: false }
  }
  for (let i = 0; i < p.buttons.length; i++) {
    if (p.shouldStop()) return { outcomes, restore: null, aborted: false, stopped: true }
    const { o, timeout } = await step(p.buttons[i], String(i + 1))
    outcomes.push(o)
    if (timeout) return { outcomes, restore: null, aborted: true, stopped: false }
  }
  const x1 = outcomes.findIndex(o => o.name === 'BetMultiple1')
  if (x1 < 0) return { outcomes, restore: null, aborted: false, stopped: false }
  if (p.shouldStop()) return { outcomes, restore: null, aborted: false, stopped: true }
  const { o: restore, timeout } = await step(p.buttons[x1], 'restore')
  return { outcomes, restore, aborted: timeout, stopped: false }
}

// ── 觸屏畫面判定（2026-09-29，規則跟 CodeX 對過兩輪；BZZF：點 18,9 開賠率表、再點一次關）──────────────
// 點一格會讓機台畫面變化的位置，看 main 推流有沒有變，不靠盒子 log（CMDB 查不到的台也能驗）。
//   雜訊：不點，連拍 5 張，跟第一張比的「變動像素比例」最大值（像素 RGB 平均差 > 20/255 才算變動）
//   門檻：max(5%, 3×雜訊)
//   **點擊前**就擋：推流沒在播、畫面凍結、雜訊 > 30% → 未驗，而且不點（避免點開了卻判不了、留下打開的頁面）
//   開／關都看**最後兩張**（輪詢到連續兩張成立就停，所以最後兩張就是判定依據；中途成立又反轉不算）
//   輪詢期間推流凍結（currentTime 沒前進）→ 未驗，不能誤報成 no response
//   PASS 只代表「開關有反應」；開出來的是不是賠率表是影子模式人工確認，訊息要寫明
export const TOUCH_NOISE_MAX = 0.3
export const touchThreshold = (noise: number) => Math.max(0.05, 3 * noise)
/** 點擊前的閘門：回傳 null＝可以點；否則是「未驗」的原因 */
export function touchVisualPrecheck(p: { streamPlaying: boolean; frozen: boolean; noise: number }): string | null {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`
  if (!p.streamPlaying) return '未驗：main 推流沒在播，看不到畫面變化（沒點）'
  if (p.frozen) return '未驗：main 推流畫面凍結（currentTime 沒前進，沒點）'
  if (p.noise > TOUCH_NOISE_MAX) return `未驗：畫面本身變動太大（雜訊 ${pct(p.noise)}），判不了（沒點）`
  return null
}
/** 最後兩張都成立 */
export const lastTwo = (xs: number[], ok: (x: number) => boolean) => xs.length >= 2 && ok(xs[xs.length - 1]) && ok(xs[xs.length - 2])
// noClose：這個點打開的畫面不用（也不能）再點同一格關掉——BZZF 18,9 開的是選面額選單，再點一次會改選面額（0929 實測）；
//   使用者確認「打開就算觸屏有反應」，選單留著由後面的退出帶走
export interface TouchVisualInput { noise: number; opened: number[]; openFrozen: boolean; closed: number[] | null; closeFrozen: boolean; expect: string; noClose?: boolean }
export function touchVisualVerdict(p: TouchVisualInput): { status: 'pass' | 'fail' | 'skip'; message: string; threshold: number } {
  const threshold = touchThreshold(p.noise)
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`
  const base = `雜訊 ${pct(p.noise)}、門檻 ${pct(threshold)}`
  const openSeq = p.opened.map(pct).join('/')
  if (!lastTwo(p.opened, x => x > threshold)) {
    if (p.openFrozen) return { status: 'skip', message: `未驗：點擊後推流凍結，看不出有沒有打開（${base}；點後 ${openSeq}）`, threshold }
    return { status: 'fail', message: `點了但畫面沒變（${base}；點後 ${openSeq}）｜判定：no response`, threshold }
  }
  if (p.noClose) return { status: 'pass', message: `點下去畫面有打開（${p.expect}；設定為不關閉）（${base}；點後 ${openSeq}）`, threshold }
  if (!p.closed) return { status: 'fail', message: `畫面有打開但沒有執行關閉（${base}；點後 ${openSeq}）｜判定：flow fail`, threshold }
  const closeSeq = p.closed.map(pct).join('/')
  if (!lastTwo(p.closed, x => x <= threshold)) {
    if (p.closeFrozen) return { status: 'skip', message: `未驗：關閉時推流凍結，看不出有沒有關回來（${base}；點後 ${openSeq}；關後 ${closeSeq}）`, threshold }
    return { status: 'fail', message: `畫面有打開、但再點一次沒關掉（${base}；點後 ${openSeq}；關後 ${closeSeq}）｜判定：flow fail`, threshold }
  }
  return { status: 'pass', message: `開關反應通過，${p.expect}內容待人工確認（${base}；點後 ${openSeq}；關後 ${closeSeq}）`, threshold }
}

// ── 觸屏畫面判定的流程（CodeX 0929 第三輪：流程也要能用假資料驗「閘門擋住＝零點擊」、逐次凍結、成立後的穩定窗）──
// sample：拍一張 main 推流，回傳跟點擊前基準圖的變動比例＋video.currentTime＋是否在播；click：點一次格子；save：存「剛剛那張」當證據
// refDiff：這張跟「預期畫面參考圖」指定區域的差異比例（touch-refs/<機種>.png；沒有參考圖就是 undefined）
//   0929 實測 BZZF 選面額選單的橫幅區：有選單 0~6%、沒選單 44~76% → 門檻 20%
export interface TouchSample { ratio: number; time: number; playing: boolean; refDiff?: number }
export const REF_MATCH = 0.2
export async function runTouchVisualFlow(d: {
  sample: () => Promise<TouchSample>
  click: () => Promise<void>
  wait: (ms: number) => Promise<void>
  stop: () => boolean
  save: (tag: string) => void
  // 重拍基準圖（0237 實測：基準拍在中獎動畫上，雜訊 28% → 門檻 85%，選單明明打開了 41% 卻被判 no response）
  rebase?: () => Promise<void>
  expect: string
  noClose?: boolean
  closeIfOpen?: boolean  // 點之前已經是預期畫面時，先點同一格關掉再驗
  maxPoll?: number      // 開／關各最多看幾張（1 秒一張），預設 8
  stableExtra?: number  // 成立之後再多看幾張，確認沒有反轉，預設 2
}): Promise<{ status: 'pass' | 'fail' | 'skip'; message: string; clicks: number; noise: number; opened: number[]; closed: number[] | null }> {
  const maxPoll = d.maxPoll ?? 8, extra = d.stableExtra ?? 2
  let clicks = 0
  // 凍結：逐次比，任兩張之間 currentTime 前進不到 0.3 秒就算凍結（只比頭尾會漏掉中途凍結）
  const frozenIn = (xs: TouchSample[]) => xs.some((s, i) => i > 0 && s.time - xs[i - 1].time < 0.3)
  // 1. 雜訊：不點，再拍 4 張（基準圖由呼叫端先拍好）。雜訊 > 10%（多半是中獎動畫）→ 等 5 秒、重拍基準再量；含首次最多量測 3 輪（重拍 2 次，額外等約 10 秒），
  //    挑安靜的時候當基準；3 輪都吵才交給閘門判
  const measure = async () => {
    let pre: TouchSample[] = []
    let noise = 1
    const noiseRounds: number[] = []
    for (let round = 0; round < 3 && !d.stop(); round++) {
      if (round > 0) { await d.wait(5000); await d.rebase?.() }
      pre = []
      for (let i = 0; i < 4 && !d.stop(); i++) { await d.wait(1000); pre.push(await d.sample()) }
      noise = Math.max(0, ...pre.map(s => s.ratio))
      noiseRounds.push(noise)
      if (noise <= 0.1 || !d.rebase) break
    }
    return { pre, noise, noiseRounds, preRef: pre.length ? pre[pre.length - 1].refDiff : undefined }
  }
  let m = await measure()
  let note = ''
  // 點之前就已經是預期畫面（0245：選面額選單本來就開著，點了當然沒變）：
  //   closeIfOpen（BZZF，使用者 0929：同一格 18,9 就能關，而且不會改到設定）→ 先點一次關掉、確認選單不見了，重量基準再正式驗
  //   沒設定 → 未驗、不點
  if (m.preRef !== undefined && m.preRef < REF_MATCH && d.closeIfOpen && !d.stop()) {
    clicks++
    await d.click()
    let gone = false
    for (let i = 0; i < 15 && !d.stop(); i++) {
      await d.wait(1000)
      const s = await d.sample()
      if (s.refDiff !== undefined && s.refDiff >= REF_MATCH) { gone = true; break }
    }
    // 使用者 0929：停在選單、點 18,9 也關不掉＝觸屏沒反應（touchscreen no response），不是未驗
    if (!gone) return { status: 'fail', message: `點之前已經在${d.expect}，點 18,9 想關掉但 15 秒內沒反應（已點 1 次）｜判定：no response`, clicks, noise: m.noise, opened: [], closed: null }
    await d.wait(2000)
    await d.rebase?.()
    m = await measure()
    note = '｜原本就在選單，先點一次關掉再驗'
  }
  const { pre, noise, noiseRounds, preRef } = m
  const roundsTxt = noiseRounds.map(x => `${(x * 100).toFixed(1)}%`).join('→')
  // 重拍 3 輪還是 > 10%：基準不穩，交給原閘門仍可能假陰性（28%→門檻 85%）→ 直接判未驗、不點（CodeX 0929）
  if (preRef !== undefined && preRef < REF_MATCH) return { status: 'skip', message: `未驗：點之前畫面已經是${d.expect}（參考圖差異 ${(preRef * 100).toFixed(1)}%），點了也看不出反應（${clicks ? `已點 ${clicks} 次想關掉` : '沒點'}）`, clicks, noise, opened: [], closed: null }
  if (d.rebase && noise > 0.1) return { status: 'skip', message: `未驗：基準畫面不穩（量測 ${noiseRounds.length} 輪／重拍 ${noiseRounds.length - 1} 次，雜訊 ${roundsTxt}），無法確認（沒點）`, clicks, noise, opened: [], closed: null }
  // 2. 閘門：播放狀態用**最後一張**（點擊前刷新），凍結逐次比
  const gate = touchVisualPrecheck({ streamPlaying: pre.length > 0 && pre[pre.length - 1].playing, frozen: frozenIn(pre), noise })
  if (gate) return { status: 'skip', message: gate, clicks, noise, opened: [], closed: null }
  const threshold = touchThreshold(noise)
  // 3. 輪詢：連續兩張成立後，再多看 extra 張（穩定窗）；最後兩張決定結果——**額外這兩張內**的反轉能抓到，更晚的反轉看不到
  const poll = async (ok: (x: number) => boolean, tag: string) => {
    const xs: TouchSample[] = []
    let hit = -1
    for (let i = 0; i < maxPoll + extra && !d.stop(); i++) {
      await d.wait(1000)
      xs.push(await d.sample())
      const rs = xs.map(s => s.ratio)
      if (hit < 0 && lastTwo(rs, ok)) hit = xs.length
      if (hit < 0 && xs.length >= maxPoll) break
      if (hit >= 0 && xs.length >= hit + extra) break
    }
    // 證據存在輪詢結束時＝最後一張（跟最終判定用的是同一張；失敗也留最後一張）——CodeX 0929 第四輪
    if (xs.length) d.save(tag)
    return { rs: xs.map(s => s.ratio), frozen: frozenIn(xs), lastRef: xs.length ? xs[xs.length - 1].refDiff : undefined }
  }
  clicks++; await d.click()
  const open = await poll(x => x > threshold, '1-opened')
  let close: { rs: number[]; frozen: boolean; lastRef?: number } | null = null
  if (!d.noClose && lastTwo(open.rs, x => x > threshold) && !d.stop()) { clicks++; await d.click(); close = await poll(x => x <= threshold, '2-closed') }
  const v = touchVisualVerdict({ noise, opened: open.rs, openFrozen: open.frozen, closed: close?.rs ?? null, closeFrozen: close?.frozen ?? false, expect: d.expect, noClose: d.noClose })
  // 有參考圖：畫面有打開時再確認打開的是不是預期畫面
  if (v.status === 'pass' && open.lastRef !== undefined) {
    const pr = `參考圖差異 ${(open.lastRef * 100).toFixed(1)}%`
    if (open.lastRef >= REF_MATCH) return { status: 'skip', message: `未驗：點下去畫面有變，但不是${d.expect}（${pr}）`, clicks, noise, opened: open.rs, closed: close?.rs ?? null }
    v.message = `${v.message.replace(`，${d.expect}內容待人工確認`, '')}｜確認是${d.expect}（${pr}）`
  }
  return { status: v.status, message: (noiseRounds.length > 1 ? `${v.message}｜基準量測 ${noiseRounds.length} 輪／重拍 ${noiseRounds.length - 1} 次（${roundsTxt}）` : v.message) + note, clicks, noise, opened: open.rs, closed: close?.rs ?? null }
}
