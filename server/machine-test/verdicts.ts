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

// ── 盲推 feature（2026-09-30）────────────────────────────────────────────────
// 機台不在影像辨識監控、退出被 feature 擋住（cannot be quit／10002）時，連續按 SPIN 推一段再回去試退出。
// CodeX 0930 要求成本有界、可模擬驗證：每一下「按之前」都要過完所有關卡，任一條不過就回 halt（呼叫端停整批、不換台）：
//   停止指令／整台時限到期／單台次數上限／畫面 Handpay／餘額讀不到／剩餘額度不夠再付一把。
// 「剩餘額度不夠再付一把」是硬上限：要求 maxSpend − 已花 ≥ spinCost 才按，所以最後一把也不會超過 maxSpend。
export type BlindBurstState = { presses: number; bal0: number | null | undefined }
export async function runBlindBurst(d: {
  state: BlindBurstState
  maxPresses: number
  maxSpend: number
  spinCost: number
  burstMs: number
  intervalMs: number
  now: () => number
  sleep: (ms: number) => Promise<void>
  isStopped: () => boolean
  deadlineExceeded: () => boolean
  bodyText: () => Promise<string>
  readBalance: () => Promise<number | null>
  press: () => Promise<void>
}): Promise<{ halt: string | null; pressed: number }> {
  const s = d.state
  let pressed = 0
  if (s.bal0 === undefined) s.bal0 = await d.readBalance()
  if (s.bal0 == null) return { halt: '讀不到前端餘額，無法確認扣款上限', pressed }
  const end = d.now() + d.burstMs
  while (d.now() < end) {
    if (d.isStopped()) return { halt: '收到停止指令', pressed }
    if (d.deadlineExceeded()) return { halt: '整台退出時限到期', pressed }
    if (s.presses >= d.maxPresses) return { halt: `超過單台上限 ${d.maxPresses} 下`, pressed }
    if (/hand\s*-?\s*pay/i.test(await d.bodyText())) return { halt: '畫面出現 Handpay，需人工處理', pressed }
    const bal = await d.readBalance()
    if (bal == null) return { halt: '讀不到前端餘額，無法確認扣款上限', pressed }
    const spent = Math.max(0, s.bal0 - bal)
    if (d.maxSpend - spent < d.spinCost) return { halt: `剩餘額度不夠再付一把（已少 ${spent}，上限 ${d.maxSpend}，單把估 ${d.spinCost}）`, pressed }
    await d.press()
    s.presses++; pressed++
    await d.sleep(d.intervalMs)
  }
  return { halt: null, pressed }
}

// ── Spin 前的選面額選單閘門（2026-09-30，使用者 hhenghheng 定案）─────────────
// BZZF 機台停在 CHOOSE A DENOMINATION（選單開著）時按 SPIN 本來就無效——0266 因此被誤判 spin no response。
// 規則：Spin 前先看選單（參考圖比對）→ 開著就先在前端選面額、等機台 LOADING 跑完自己關（最多 loadingMs）
//   → 還開著就點觸屏（18,9 等點位）看會不會關 → 都沒反應＝touchscreen no response，Spin 不驗（spin not verified）。
// 只有「選單已關、按了 SPIN 還是沒開局」才算 spin no response（那段在 batch 的 classify）。
// isOpen 回 null＝判斷不了（沒參考圖／推流沒在播）→ 照原流程按 SPIN，不擋。
export type MenuGateResult =
  | { state: 'closed'; note: string; taps: number }
  | { state: 'unknown'; note: string; taps: number }
  | { state: 'touchNoResponse'; note: string; taps: number }
export async function runMenuGate(d: {
  isOpen: () => Promise<boolean | null>
  selectFrontDenom: () => Promise<void>
  taps: Array<{ label: string; tap: () => Promise<void> }>
  wait: (ms: number) => Promise<void>
  stop: () => boolean
  loadingMs?: number
  afterTapMs?: number
  pollMs?: number
}): Promise<MenuGateResult> {
  const loadingMs = d.loadingMs ?? 30_000, afterTapMs = d.afterTapMs ?? 8_000, pollMs = d.pollMs ?? 2_000
  let taps = 0
  const first = await d.isOpen()
  if (first === null) return { state: 'unknown', note: '選單狀態未知：推流畫面判斷不了（停格或沒在播），照原流程', taps }
  if (!first) return { state: 'closed', note: '選單本來就關著', taps }
  // CodeX 0930：中途畫面判斷不了（推流停格／沒在播）→ 不能拿「沒看到關」當「沒關」，整個閘門改回 unknown，不判觸屏
  let blind = false
  const pollClosed = async (ms: number) => {
    for (let t = 0; t < ms && !d.stop(); t += pollMs) {
      await d.wait(pollMs)
      const o = await d.isOpen()
      if (o === false) return true
      if (o === null) { blind = true; return false }
    }
    return false
  }
  const blindResult = (): MenuGateResult => ({ state: 'unknown', note: '選單狀態未知：操作後推流畫面判斷不了（停格或沒在播），不判觸屏', taps })
  await d.selectFrontDenom()
  const afterFront = await pollClosed(loadingMs)
  if (blind) return blindResult()
  if (afterFront) return { state: 'closed', note: `選單開著 → 前端選面額後 ${Math.round(loadingMs / 1000)} 秒內自己關了`, taps }
  // 0930 JJBXGRAND：沒有設定關選單的觸屏點＝不知道該點哪裡，沒點過就不能說觸屏沒反應 → 判選單狀態未知（Spin 照按但註記、不判 spin no response）
  if (!d.taps.length) return { state: 'unknown', note: `選單狀態未知：前端選面額等 ${Math.round(loadingMs / 1000)} 秒選單仍開著，此機種沒有設定關選單的觸屏點，不判觸屏`, taps }
  for (const t of d.taps) {
    if (d.stop()) break
    await t.tap(); taps++
    const closedNow = await pollClosed(afterTapMs)
    if (blind) return blindResult()
    if (closedNow) return { state: 'closed', note: `選單開著、選面額後沒關 → 點 ${t.label} 後關了`, taps }
  }
  return { state: 'touchNoResponse', note: `機台停在選面額選單：前端選面額等 ${Math.round(loadingMs / 1000)} 秒沒關、點 ${d.taps.map(t => t.label).join('／') || '（沒有可點的點位）'} 也沒關`, taps }
}

// ── 兩段式特殊流程：觸屏之後再按一下 SPIN（2026-09-30 JJBXGRAND）────────────────
// 只對 bonus-sequence.json 標 thenSpin 的機種。CodeX 0930 的要求都在這裡守：
//   · 沒有 guard（呼叫端沒提供額度／停止保護）→ **一律不按**（fail-safe；例如 OSMWatcher 等待流程就不會多按）
//   · guard 在「點完觸屏之後、按 SPIN 之前」才判斷——整輪觸屏可能 20 秒以上，不能沿用點格前的判斷
//   · 找不到 SPIN（轉場中）→ 這一輪就不按，不在這裡重試（下一輪推進再說）
//   · 真的按了 → 回報 pressed，呼叫端要把它計入次數
export async function runTouchThenSpin(d: {
  thenSpin: boolean
  taps: () => Promise<boolean>
  guard?: () => Promise<{ ok: boolean; reason?: string }>
  pressSpin: () => Promise<boolean>
}): Promise<{ tapped: boolean; spin: 'pressed' | 'notListed' | 'noGuard' | 'blocked' | 'noButton'; reason?: string }> {
  const tapped = await d.taps()
  if (!d.thenSpin) return { tapped, spin: 'notListed' }
  if (!d.guard) return { tapped, spin: 'noGuard' }
  const g = await d.guard()
  if (!g.ok) return { tapped, spin: 'blocked', reason: g.reason }
  return (await d.pressSpin()) ? { tapped, spin: 'pressed' } : { tapped, spin: 'noButton' }
}

// 兩段式補按 SPIN 的關卡判定（純函式，runner 的 extraSpinGuard 只負責讀狀態、呼叫這支）：跟盲推每一下前的關卡同一套
export function extraSpinDecision(s: { stopped: boolean; presses: number; maxPresses: number; bodyText: string; bal: number | null; bal0: number | null | undefined; maxSpend: number; spinCost: number }): { ok: boolean; reason?: string } {
  if (s.stopped) return { ok: false, reason: '收到停止指令' }
  if (s.presses >= s.maxPresses) return { ok: false, reason: `已達單台上限 ${s.maxPresses} 下` }
  if (/hand\s*-?\s*pay/i.test(s.bodyText)) return { ok: false, reason: '畫面出現 Handpay' }
  if (s.bal == null || s.bal0 == null) return { ok: false, reason: '讀不到前端餘額' }
  const spent = Math.max(0, s.bal0 - s.bal)
  if (s.maxSpend - spent < s.spinCost) return { ok: false, reason: `剩餘額度不夠再付一把（已少 ${spent}）` }
  return { ok: true }
}

// ── 特殊流程卡在「選元寶／選卡」畫面 → 依機種點位清單逐格點（2026-10-06 ARUZE 0335）────────────────
// 0335 iDeck BETx6 中 JP（SELECT 元寶）卡住，依設定檔推進只會按 SPIN，現場人工點完。清單在 feature-taps.json（不動 profile 的 touchPoints——觸屏測試還在用）。
// 規則（使用者 10-06）：照清單順序一次點一格，每格點完看有沒有進展，一有進展就停；每一下都要留紀錄。
//   · done＝呼叫端判定特殊流程已結束（moneyNtc end）→ 停
//   · screen＝畫面明顯變了 → 停、交回呼叫端「暫停觀察」（CodeX 1006：這只是暫停訊號，不能證明進了 FG）
//   · none＝沒進展 → 點下一格（JP 翻一顆元寶畫面只動一小塊，多半落在這裡，正好繼續點下一顆）
//   · noElement＝找不到這格 → 記下、點下一格
//   · unsure＝量不到（截圖失敗）→ **立刻停手**，交人工（CodeX 1006 P1：不能把缺圖當成「沒變化」繼續點）
// tap 自己在「真的點下去之前」再查一次結束／停止／時限（stop），查到就回 stop、不點。
// cursor 由呼叫端保存：同一台同一段特殊流程裡，每格最多點一次。
export type FeatureTapPoint = { point: string; group: string }
export type FeatureTapLog = { point: string; group: string; result: 'done' | 'screen' | 'none' | 'noElement' | 'unsure'; note?: string }
export async function runFeatureTaps(d: {
  points: FeatureTapPoint[]
  start: number
  stop: () => boolean
  tap: (point: string) => Promise<'ok' | 'noElement' | 'unsure' | 'stop'>
  check: () => Promise<{ result: 'done' | 'screen' | 'none' | 'unsure'; note?: string }>
  onLog?: (l: FeatureTapLog) => void
}): Promise<{ cursor: number; result: 'done' | 'screen' | 'exhausted' | 'stopped' | 'unsure'; log: FeatureTapLog[] }> {
  const log: FeatureTapLog[] = []
  const push = (l: FeatureTapLog) => { log.push(l); d.onLog?.(l) }
  for (let i = d.start; i < d.points.length; i++) {
    if (d.stop()) return { cursor: i, result: 'stopped', log }
    const p = d.points[i]
    const t = await d.tap(p.point)
    if (t === 'stop') return { cursor: i, result: 'stopped', log }
    if (t === 'unsure') { push({ ...p, result: 'unsure', note: '點之前截圖失敗，沒點' }); return { cursor: i, result: 'unsure', log } }
    if (t === 'noElement') { push({ ...p, result: 'noElement' }); continue }
    const c = await d.check()
    push({ ...p, result: c.result, note: c.note })
    if (c.result !== 'none') return { cursor: i + 1, result: c.result, log }
  }
  return { cursor: d.points.length, result: 'exhausted', log }
}
export const featureTapSummary = (log: FeatureTapLog[]) =>
  log.map(l => `${l.point}→${{ done: '結束', screen: '畫面變化', none: '無', noElement: '找不到格', unsure: '量不到' }[l.result]}`).join('、')
/** 畫面上讀到的字有沒有命中這個機種的「選擇畫面」關鍵字（不分大小寫、忽略多餘空白） */
export function onFeatureSelectScreen(ocr: string, keywords: string[]): string | null {
  const norm = (x: string) => x.toLowerCase().replace(/\s+/g, ' ').trim()
  const t = norm(ocr)
  return keywords.find(k => k.trim() && t.includes(norm(k))) ?? null
}
