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
  /** 1007 iDeck 時間學習：晚到的 begin 歸屬不明 → 本台 iDeck 中止。不因歧義判 fail、也不能算 pass（CodeX） */
  ambiguous?: string | null
}): { status: 'pass' | 'warn' | 'fail' | 'skip'; message: string } {
  const { outcomes, restore, aborted, apiErr, boxCount } = p
  if (outcomes.length === 0) return { status: 'fail', message: '沒有可點的 iDeck 按鈕｜判定：flow fail' }

  const total = outcomes.length
  const acked = outcomes.filter(o => o.result === 'ack').length
  const bad = outcomes.filter(o => o.result !== 'ack')
  const hasMultiplier = outcomes.some(o => /^BetMultiple\d+$/.test(o.name ?? ''))

  const detail = outcomes.map(o => `${o.name ?? o.label}${o.result === 'ack' ? '✓' : '✗'}`).join(' ')
  let restoreTxt: string, restoreBad: 'noResponse' | 'flow' | null = null
  // 1007：沒有倍數鍵就不需要還原，中止本身不另算流程失敗（中止的原因——逾時、局沒結束——會在那一顆的結果裡判）
  if (aborted) { restoreTxt = hasMultiplier ? '；⚠️ 中止，沒有還原倍數' : '；中止（沒有倍數鍵，不需還原）'; restoreBad = hasMultiplier ? 'flow' : null }
  else if (restore) {
    const ok = restore.result === 'ack'
    restoreTxt = `；還原 BetMultiple1 ${ok ? '✓' : '✗（⚠️ 倍數可能還留在最後按的那顆）'}`
    if (!ok) restoreBad = NO_RESPONSE.includes(restore.result) ? 'noResponse' : 'flow'
  } else if (hasMultiplier) { restoreTxt = '；⚠️ 有倍數鍵但找不到 BetMultiple1，還原未驗證'; restoreBad = 'flow' }
  else restoreTxt = '；沒有倍數鍵，不需還原'
  const boxTxt = apiErr ? `；盒子 log 未查（${apiErr}）` : `；盒子 log 新增 ${boxCount} 筆`

  let message = `server 回應 ${acked}/${total}（${detail}）${restoreTxt}${boxTxt}`
  if (bad.length) message += `｜未通過：${bad.map(o => `${o.label}「${o.text}」${o.result}${o.note ? '(' + o.note + ')' : ''}`).join('、')}`

  if (p.ambiguous) {
    // 中止前已經有真的「送了沒回」→ 那是確定的問題，照判 no response；其他（含沒還原倍數）都歸在歧義底下、記未驗
    if (bad.some(o => NO_RESPONSE.includes(o.result))) return { status: 'fail', message: `${message}｜⚠️ ${p.ambiguous}｜判定：no response` }
    return { status: 'skip', message: `${message}｜⚠️ ${p.ambiguous}｜判定：ideck not verified (timing ambiguous)` }
  }
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
// 1007：press 回傳的 O 帶 halt（歸屬不明、noAck 後狀態不明、按之前的局沒結束）→ 跟開轉逾時一樣零後續點擊
export async function runIdeckSequence<B, O extends { name: string | null; result: IdeckResult; halt?: string }>(p: {
  buttons: B[]
  press: (b: B, idx: string) => Promise<O>
  settle: (o: O, idx: string) => Promise<void>
  afterTimeout: (o: O, idx: string) => Promise<void>
  shouldStop: () => boolean
  /** 1007 learn 來回按（只在 ideckCapture 時給）：每按完一顆問要不要「按回」前面某顆（回傳它在 outcomes 的位置）；idx 記成 back-<那顆的 idx> */
  back?: (outcomes: O[]) => number | null
}): Promise<{ outcomes: O[]; restore: O | null; aborted: boolean; stopped: boolean; backs: Array<{ of: number; o: O }> }> {
  const outcomes: O[] = []
  const backs: Array<{ of: number; o: O }> = []
  const step = async (b: B, idx: string) => {
    const o = await p.press(b, idx)
    if (o.result === 'spinTimeout' || o.halt) { await p.afterTimeout(o, idx); return { o, timeout: true } }
    await p.settle(o, idx)
    return { o, timeout: false }
  }
  for (let i = 0; i < p.buttons.length; i++) {
    if (p.shouldStop()) return { outcomes, restore: null, aborted: false, stopped: true, backs }
    const { o, timeout } = await step(p.buttons[i], String(i + 1))
    outcomes.push(o)
    if (timeout) return { outcomes, restore: null, aborted: true, stopped: false, backs }
    const bi = p.back?.(outcomes) ?? null
    if (bi !== null && bi >= 0 && bi < i) {
      if (p.shouldStop()) return { outcomes, restore: null, aborted: false, stopped: true, backs }
      const r = await step(p.buttons[bi], `back-${bi + 1}`)
      backs.push({ of: bi, o: r.o })
      if (r.timeout) return { outcomes, restore: null, aborted: true, stopped: false, backs }
    }
  }
  const x1 = outcomes.findIndex(o => o.name === 'BetMultiple1')
  if (x1 < 0) return { outcomes, restore: null, aborted: false, stopped: false, backs }
  if (p.shouldStop()) return { outcomes, restore: null, aborted: false, stopped: true, backs }
  const { o: restore, timeout } = await step(p.buttons[x1], 'restore')
  return { outcomes, restore, aborted: timeout, stopped: false, backs }
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
/** lastBal／lastPresses：上一次讀到的機台餘額與當時的累計次數（1007 合理性檢查用） */
export type BlindBurstState = { presses: number; bal0: number | null | undefined; lastBal?: number; lastPresses?: number }
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
    // 1007 合理性（CodeX：扣款與派彩分開判，不取絕對值——JP 大額派彩本來就會超過）：
    // 跟上一次讀值比，**少掉的**超過「單把估價 × 這段期間按的次數 × 2」→ 不合理，可能讀錯 → 當成讀不到、停手待核對（不說是資料汙染）
    if (s.lastBal !== undefined) {
      const drop = s.lastBal - bal
      const allowed = d.spinCost * Math.max(1, s.presses - (s.lastPresses ?? s.presses)) * 2
      if (drop > allowed) return { halt: `待核對：機台餘額一次少了 ${drop}（${s.lastBal} → ${bal}），超過合理範圍 ${allowed}，可能讀錯，先停手`, pressed }
    }
    s.lastBal = bal; s.lastPresses = s.presses
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

// ── 退出路徑每一輪「要不要推進、怎麼推進」（CodeX 1006 第二輪 P1）──────────────────────────
// runner 的退出迴圈每一輪只照這裡的回答做事；探針 scripts/feature-taps-probe.ts 用同一支模擬整段退出迴圈，
// 驗「unsure 之後所有推進呼叫都是零」「觀察期間零推進」。
//   · handOff＝觸屏推進時量不到（截圖失敗）→ **結束本台自動操作**、回傳待人工確認（不能只 emit，下面也不能再推）
//   · hold＝觸屏有進展後的 60 秒觀察期 → 什麼都不推，只重試退出
//   · featureTap＝跑一輪觸屏清單（還有沒點的格、OCR 次數沒用完）
//   · legacy＝原本的推進流程（SPIN／盲推／OSMWatcher 補點）
export const FEATURE_HOLD_MS = 60_000
export const FEATURE_MAX_OCR = 5
export type ExitFeatureState = { cursor: number; total: number; holdUntil: number; ocrTries: number; handOff: string | null }
export const exitFeatureState = (total: number): ExitFeatureState => ({ cursor: 0, total, holdUntil: 0, ocrTries: 0, handOff: null })
/** 觸屏推進後的觀察期。退出迴圈兩條分支（遊戲進行中／沒有證據的 retry＋手冊）都用這一支擋（CodeX 第三輪 P1：手冊動作之前就要攔住） */
export const inFeatureHold = (s: ExitFeatureState, now: number) => now < s.holdUntil
export function planExitAdvance(s: ExitFeatureState, now: number, enabled: boolean): 'handOff' | 'hold' | 'featureTap' | 'legacy' {
  if (s.handOff) return 'handOff'
  if (inFeatureHold(s, now)) return 'hold'
  if (enabled && s.cursor < s.total && s.ocrTries < FEATURE_MAX_OCR) return 'featureTap'
  return 'legacy'
}
/**
 * 一輪觸屏推進的結果 → 新狀態，以及這一輪接下來：
 *   handOff＝**當輪**就結束本台自動操作（CodeX 第三輪 P1：不能 continue——下一輪會先跑 stepExit、手冊動作，繞過交人工）
 *   retryExit＝回去重試退出；legacy＝照原本流程推
 */
export function applyFeatureRound(s: ExitFeatureState, r: { result: string; cursor: number }, now: number): { state: ExitFeatureState; then: 'handOff' | 'retryExit' | 'legacy' } {
  const state = { ...s, cursor: r.cursor, ocrTries: s.ocrTries + 1 }
  if (r.result === 'done' || r.result === 'screen') return { state: { ...state, holdUntil: now + FEATURE_HOLD_MS, ocrTries: 0 }, then: 'retryExit' }
  if (r.result === 'unsure') return { state: { ...state, handOff: '觸屏推進時截圖失敗，量不到畫面' }, then: 'handOff' }
  // stopped：被停止／時限／動作上限擋下——回去重試退出，由退出迴圈原本的上限檢查收尾
  if (r.result === 'stopped') return { state, then: 'retryExit' }
  return { state, then: 'legacy' }   // notOnScreen／exhausted
}

// ── 未監控機台「開局沒結束」＝疑似特殊遊戲（1007，claude-osm-3 規格 A；CodeX 定案）────────────────
// 機台不在 OSMWatcher 名單（或狀態 0）時，特殊遊戲只看得到 moneyNtc：最後一筆是 begin、超過 OPEN_ROUND_SUSPECT_MS 沒有 end。
// 門檻 35 秒：claude-osm-3 從 9 份 batch log 配對 1354 局 begin→end，p95 5 秒、最長 28 秒（ARUZE 正常局）；20 秒會誤觸發。
// 推進流程跟 OSMWatcher 偵測到時同一套（關 Tips／面額 → featureTaps → bonusAction → 卡住救援），結束條件換成「收到這一局的 end」。
// 安全（不能變付費下注）：
//   - 只在這一局還開著時動作；**每一下實際點擊前都重查**（關遮罩、OCR、等待之後都要），收到 end 立刻停、不再加碼
//   - 按 SPIN 要有「當下畫面是特殊遊戲」的明確證據（OCR 判成 spin）＋距離最後一則 moneyNtc 超過 quietMs（只是節流，不是保證）；
//     沒有證據就等，逾時 stalled——end 延遲／漏送時寧可停在 stalled 交人工
//   - 從頭到尾沒有 begin（讀不到 moneyNtc）＝不啟動
export const OPEN_ROUND_SUSPECT_MS = 35_000
export type OpenRoundResult = { result: 'done' | 'stalled' | 'stopped'; acts: number; ms: number; how: string[] }
export async function superviseOpenRound(d: {
  /** 這一局（綁定開始時那筆 begin）收到 end 了沒 */
  ended: () => Promise<boolean>
  /** 距離最後一則 moneyNtc 多久（毫秒） */
  lastMoneyAgo: () => Promise<number>
  stop: () => boolean
  closeOverlays: () => Promise<void>
  /** 有機種點位清單才給：一輪點選（內部每一下前也會查 ended）；budget＝還能點幾下，回傳實際點了幾下 */
  featureTaps?: (budget: number) => Promise<{ kind: 'progress' | 'none' | 'giveUp'; taps: number }>
  action: 'spin' | 'touchscreen' | 'takewin' | 'auto_wait'
  /** 截圖 OCR 判斷畫面：spin＝畫面叫你按 SPIN／PLAY（特殊遊戲中）、touch、wait、unknown；截圖／OCR 失敗回 fail */
  screen: () => Promise<'spin' | 'touch' | 'wait' | 'unknown' | 'fail'>
  pressSpin: () => Promise<boolean>
  /** 逐格點 touchPoints（每一格前自己重查 end／停止），最多 budget 下，回傳實際點了幾下 */
  touch: (budget: number) => Promise<number>
  /** 卡住救援（只做一次）：回傳學到的動作 */
  rescue?: () => Promise<'spin' | 'touchscreen' | null>
  now: () => number
  sleep: (ms: number) => Promise<void>
  maxMs: number
  maxActs: number
  quietMs: number
  pollMs: number
  stallMs: number
}): Promise<OpenRoundResult> {
  const t0 = d.now()
  const how: string[] = []
  let acts = 0, action = d.action, ftOn = !!d.featureTaps, rescued = false, lastProgress = t0
  const out = (result: OpenRoundResult['result']): OpenRoundResult => ({ result, acts, ms: d.now() - t0, how })
  while (true) {
    if (await d.ended()) return out('done')
    if (d.stop()) return out('stopped')
    if (d.now() - t0 >= d.maxMs) return out('stalled')
    if (acts >= d.maxActs) { await d.sleep(d.pollMs); continue }   // 點擊上限：只被動等 end
    await d.closeOverlays()
    if (await d.ended()) return out('done')   // 關遮罩途中收到 end
    // 動作上限算**實際點擊次數**（CodeX 2d513b6 [P2]：一輪點位原本只算一次）
    if (ftOn && d.featureTaps) {
      const r = await d.featureTaps(d.maxActs - acts)
      acts += r.taps
      if (r.kind === 'progress') { lastProgress = d.now(); how.push('featureTaps') }
      if (r.kind === 'giveUp') ftOn = false
    } else if (action === 'touchscreen') {
      if (await d.ended() || d.stop()) continue
      const n = await d.touch(d.maxActs - acts)
      if (n > 0) { acts += n; how.push('touch') }
    } else if (action === 'spin' || action === 'takewin') {
      const s = await d.screen()
      // OCR 之後、真的按之前再查一次（CodeX）
      if (s === 'spin' && !d.stop() && !(await d.ended()) && (await d.lastMoneyAgo()) >= d.quietMs) {
        if (await d.pressSpin()) { acts++; how.push('spin') }
      } else if (s !== 'spin') how.push(`wait(${s})`)
    }
    if (d.rescue && !rescued && d.now() - lastProgress >= d.stallMs) {
      rescued = true
      const learned = await d.rescue()
      if (learned) { action = learned; ftOn = false; lastProgress = d.now(); how.push(`rescue→${learned}`) }
    }
    await d.sleep(d.pollMs)
  }
}

/**
 * 要不要啟動 superviseOpenRound（純函式）。log＝moneyNtc 流水（seq 遞增），sinceSeq＝這次進機台時的序號（換台清狀態）。
 * - OSMWatcher 有這台而且狀態不是 0 → 交給原本的 waitForNormalStatus（monitored）
 * - 進機台之後一筆 begin 都沒有 → 不啟動（noSignal）
 * - 最後一筆是 end → 沒有開著的局（closed）
 * - 最後一筆 begin 還沒滿門檻 → 再等（young，附還要等多久）
 * - 滿門檻 → 啟動，綁定那一筆 begin 的 seq
 */
export function openRoundTrigger(s: { log: Array<{ seq: number; reason: string; ts: number }>; sinceSeq: number; now: number; osmStatus: number | undefined; suspectMs?: number }):
  | { start: true; beginSeq: number; ageMs: number }
  | { start: false; why: 'monitored' | 'noSignal' | 'closed' | 'young'; waitMs?: number } {
  if (s.osmStatus !== undefined && s.osmStatus !== 0) return { start: false, why: 'monitored' }
  const mine = s.log.filter(e => e.seq > s.sinceSeq && (e.reason === 'begin' || e.reason === 'end'))
  if (!mine.some(e => e.reason === 'begin')) return { start: false, why: 'noSignal' }
  const last = mine[mine.length - 1]
  if (last.reason !== 'begin') return { start: false, why: 'closed' }
  const ageMs = s.now - last.ts, need = s.suspectMs ?? OPEN_ROUND_SUSPECT_MS
  if (ageMs < need) return { start: false, why: 'young', waitMs: need - ageMs }
  return { start: true, beginSeq: last.seq, ageMs }
}

/**
 * 每個步驟之前要不要擋（1007，CodeX 35d17c9 [P1]：停止或疑似特殊遊戲 stalled 之後不能再放行 Spin／iDeck…）。
 * halt＝疑似特殊遊戲沒結束的說明（有值就連退出也擋——局還開著，退出會被擋／按到局裡）。
 * 使用者停止但沒有開著的特殊遊戲：測試步驟擋、退出照舊試（不然帳號留在機台上，exitUntilLobby 會依停止狀態收尾）。
 */
export function stepGateBlock(s: { stopped: boolean; halt: string | null; isExit: boolean }): { status: 'skip' | 'fail'; message: string } | null {
  if (s.halt) return { status: s.isExit ? 'fail' : 'skip', message: `${s.isExit ? '🆘 ' : ''}未執行：疑似特殊遊戲未結束，已停止所有自動操作，請人工處理（${s.halt}）` }
  if (s.stopped && !s.isExit) return { status: 'skip', message: '未執行：使用者已停止' }
  return null
}

// ── 提示框處理（1007，規格 spec-mt-popup-handling-1007；CodeX 定案）──────────────────────────────────
// 辨識（哪一種框）在 uat-runner/popup-catalog.js，兩邊共用；這裡是**機台測試**的處理方式（category／action／verdict）。
// 優先序：stop ＞ unknown ＞ ack／close ＞ wait。stop 有 scope：account（換帳號續跑，帳號池空了才停批）／machine（本台判定、受限退出、換台）。
export type PopupPhase = 'test' | 'exit'
export type PopupDecision =
  | { kind: 'ack'; id: string; click: 'confirm' | 'exitToLobby' | 'yes' }
  | { kind: 'close'; id: string; click: 'closeX' | 'denom' | 'closeBtn' | 'recommendClose' }
  | { kind: 'wait'; id: string; maxMs: number }
  | { kind: 'stop'; id: string; verdict: string; scope: 'machine' | 'account' }
  | { kind: 'unknown'; id: string; text: string }
type Rule = { test?: PopupDecision | null; exit?: PopupDecision | null }
const MT_POPUP_POLICY: Record<string, Rule> = {
  'bonus-15min': { test: { kind: 'ack', id: 'bonus-15min', click: 'confirm' }, exit: { kind: 'ack', id: 'bonus-15min', click: 'confirm' } },
  // 代表 FG／JP 進行中：按掉 Confirm，後續交給特殊遊戲流程
  'cannot-quit': { test: { kind: 'ack', id: 'cannot-quit', click: 'confirm' }, exit: { kind: 'ack', id: 'cannot-quit', click: 'confirm' } },
  'reserve-panel': { test: { kind: 'close', id: 'reserve-panel', click: 'closeX' }, exit: { kind: 'ack', id: 'reserve-panel', click: 'exitToLobby' } },
  'quit-wait': { test: { kind: 'wait', id: 'quit-wait', maxMs: 15_000 }, exit: { kind: 'wait', id: 'quit-wait', maxMs: 15_000 } },
  // 只有退出時按 Confirm；其他時候出現＝誤觸 Cash Out → 不按、當未知框擋操作
  'cashout-credit': { test: null, exit: { kind: 'ack', id: 'cashout-credit', click: 'confirm' } },
  'game-exception': { test: { kind: 'stop', id: 'game-exception', verdict: 'game exception', scope: 'machine' }, exit: { kind: 'stop', id: 'game-exception', verdict: 'game exception', scope: 'machine' } },
  'other-device': { test: { kind: 'stop', id: 'other-device', verdict: 'account in use', scope: 'account' }, exit: { kind: 'stop', id: 'other-device', verdict: 'account in use', scope: 'account' } },
  'conn-timeout': { test: { kind: 'stop', id: 'conn-timeout', verdict: 'AFT error', scope: 'machine' }, exit: { kind: 'stop', id: 'conn-timeout', verdict: 'AFT error', scope: 'machine' } },
  'lhb-transfer': { test: { kind: 'ack', id: 'lhb-transfer', click: 'confirm' }, exit: { kind: 'ack', id: 'lhb-transfer', click: 'confirm' } },
  'no-machine': { test: { kind: 'stop', id: 'no-machine', verdict: 'offline', scope: 'machine' }, exit: null },
  'no-permission': { test: { kind: 'ack', id: 'no-permission', click: 'confirm' }, exit: { kind: 'ack', id: 'no-permission', click: 'confirm' } },
  'entry-1044': { test: { kind: 'stop', id: 'entry-1044', verdict: '進入失敗：機台配置不一致(1044)', scope: 'machine' }, exit: null },
  'entry-10006': { test: { kind: 'stop', id: 'entry-10006', verdict: '進入失敗：機台維護(10006)', scope: 'machine' }, exit: null },
  'denom': { test: { kind: 'close', id: 'denom', click: 'denom' }, exit: { kind: 'close', id: 'denom', click: 'denom' } },
  'play-game-char': { test: { kind: 'close', id: 'play-game-char', click: 'closeBtn' }, exit: { kind: 'close', id: 'play-game-char', click: 'closeBtn' } },
  'recommend': { test: { kind: 'close', id: 'recommend', click: 'recommendClose' }, exit: { kind: 'close', id: 'recommend', click: 'recommendClose' } },
}
const RANK: Record<PopupDecision['kind'], number> = { stop: 0, unknown: 1, ack: 2, close: 2, wait: 3 }
/**
 * 一個框命中的目錄 id（matchPopup 的結果）→ 機台測試要怎麼處理（純函式）。
 * 沒命中任何 id、或命中的在這個階段沒有設定（例 cashout-credit 在測試中）→ unknown：不點、擋操作、留證
 */
export function decidePopup(ids: string[], text: string, phase: PopupPhase): PopupDecision {
  const ds = ids.map(id => MT_POPUP_POLICY[id]?.[phase]).filter((d): d is PopupDecision => !!d)
  if (!ds.length) return { kind: 'unknown', id: ids[0] ?? 'unknown', text: String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) }
  return ds.sort((a, b) => RANK[a.kind] - RANK[b.kind])[0]
}
/** 這些決定會不會擋遊戲操作（stop／unknown 出現就擋；30 秒只是 unknown 的結案門檻，不是放行條件） */
export function popupBlocksGame(ds: PopupDecision[]): PopupDecision | null {
  return ds.find(d => d.kind === 'stop') ?? ds.find(d => d.kind === 'unknown') ?? null
}

/**
 * 提示框造成的步驟關卡（純函式，1007）。
 * - stop（scope account：帳號在別處登入）→ 所有步驟含退出都不做；回 accountHalt 讓 batch 換帳號續跑（帳號池空了才停）
 * - stop（scope machine：AFT error／game exception／offline／進場錯誤碼）→ 本台判定；測試步驟不做，退出照走（受限：遊戲操作都被擋）
 * - unknown 30 秒還在 → 本台判 unknown popup；測試步驟不做，退出照走
 * - unknown 還沒滿 30 秒 → 這一步不做（遊戲操作本來就被擋）；退出照走
 */
export function popupStepBlock(s: {
  stop: { id: string; verdict: string; scope: 'machine' | 'account' } | null
  unknown: { text: string } | null
  unknownExpired: boolean
  isExit: boolean
}): { skip?: { status: 'skip' | 'fail'; message: string }; verdictStep?: string; accountHalt?: string } | null {
  if (s.stop?.scope === 'account') {
    return { accountHalt: `${s.stop.verdict}（提示框 ${s.stop.id}）`, verdictStep: `判定：${s.stop.verdict}（提示框 ${s.stop.id}）——這個帳號不能再用，換帳號續跑`, skip: { status: s.isExit ? 'fail' : 'skip', message: `未執行：${s.stop.verdict}，帳號不能再用` } }
  }
  if (s.stop) {
    const v = `判定：${s.stop.verdict}（提示框 ${s.stop.id}）`
    return s.isExit ? { verdictStep: v } : { verdictStep: v, skip: { status: 'skip', message: `未執行：${s.stop.verdict}（提示框 ${s.stop.id}），只做退出` } }
  }
  if (s.unknown && s.unknownExpired) {
    const v = `判定：unknown popup (${s.unknown.text.replace(/\s+/g, ' ').slice(0, 30)})`
    return s.isExit ? { verdictStep: v } : { verdictStep: v, skip: { status: 'skip', message: `未執行：未知提示框 30 秒還在（${s.unknown.text.slice(0, 60)}），只做退出` } }
  }
  if (s.unknown && !s.isExit) return { skip: { status: 'skip', message: `未執行：畫面有未知提示框（${s.unknown.text.slice(0, 60)}），不操作遊戲` } }
  return null
}

// ── iDeck 時間學習 第一期（1007，claude-osm-3 規格 spec-mt-ideck-timing-learn-1007，CodeX 定案）──────────────
// 只**套用已確認**的值：confirmed 機種、SEND 的 name 精確在不開局清單、ack 正確、按之前 gate 證明空閒 → 等 beginWaitMs 看 begin（原本固定 6 秒）。
// 安全來自「靜默窗」：短等待的那一顆按下去之後，下一顆至少等到保守窗口（6 秒）滿才按——
//   所以晚到的 begin 只會落在「按下一顆之前」（gate 抓得到、歸給前一顆），不會跟下一顆的 begin 混在一起；
//   萬一還是落在下一顆送出之後、又在前一顆的窗口內（理論上不該發生）→ 歸屬不明，只中止本台 iDeck、記 not verified。
// 局狀態只認單一來源（本頁 game iframe 的 __moneyLog，本台本次進場、依 seq 排序），不跟 console 監聽混算（CodeX：兩路會亂序）。
export const IDECK_CONSERVATIVE_BEGIN_MS = 6000
export type IdeckTimingStatus = 'learning' | 'learned-unconfirmed' | 'confirmed'
export interface IdeckTimingCfg {
  schemaVersion: 1
  status: IdeckTimingStatus
  confirmedAt?: string | null
  confirmedBy?: string | null
  samples?: number | null
  /** 不開局按鈕等 begin 的時間（候選值 1500） */
  beginWaitMs: number
  /** 按鈕識別鍵（ideckButtonKey：按鈕字去空白，例 PLAY11Credits／BETx1；沒字才用 SEND 的 action name）→ 設定 */
  buttons: Record<string, { noRound: boolean }>
  revokedAt?: string | null
  revokeReason?: string | null
}
export interface MoneyEv { seq: number; reason: string; ts: number }
/** 局狀態：最後一筆（seq 最大）begin＝open、end＝idle；**沒有任何事件＝unknown（無法證明空閒）** */
export function ideckRoundState(log: MoneyEv[]): 'idle' | 'open' | 'unknown' {
  let last: MoneyEv | null = null
  for (const e of log) if ((e.reason === 'begin' || e.reason === 'end') && (!last || e.seq > last.seq)) last = e
  if (!last) return 'unknown'
  return last.reason === 'begin' ? 'open' : 'idle'
}
/** 這一顆要等 begin 多久：回 beginWaitMs＝短等待；null＝保守（6 秒）。理由寫在 why */
export function ideckBeginWait(p: { cfg: IdeckTimingCfg | null | undefined; /** 按鈕識別鍵（ideckButtonKey：按鈕字去空白，沒字才用 action name）——清單用的就是這個 */ key: string | null; ackOk: boolean; gate: 'idle' | 'open' | 'unknown'; degraded: string | null }): { ms: number | null; why: string } {
  const c = p.cfg
  if (!c) return { ms: null, why: '機種沒有學習值' }
  if (c.schemaVersion !== 1) return { ms: null, why: `學習值版本不符（${String(c.schemaVersion)}）` }
  if (c.status !== 'confirmed') return { ms: null, why: `學習值狀態 ${c.status}（只有 confirmed 才套用）` }
  if (p.degraded) return { ms: null, why: `本台已改回保守：${p.degraded}` }
  if (!p.ackOk) return { ms: null, why: 'ack 沒對上' }
  if (p.gate !== 'idle') return { ms: null, why: p.gate === 'unknown' ? '沒看過任何 money 事件，無法證明空閒' : '按之前還有局沒結束' }
  if (!p.key || !c.buttons[p.key]?.noRound) return { ms: null, why: `「${p.key ?? '?'}」不在已確認的不開局清單` }
  const ms = Math.max(1000, Math.min(IDECK_CONSERVATIVE_BEGIN_MS, Math.round(c.beginWaitMs)))
  return { ms, why: `已確認不開局（${c.confirmedAt ?? '?'}）` }
}
/**
 * 前一顆用了短等待之後，下一顆最早什麼時候能按（靜默窗）：前一顆按下去滿 IDECK_CONSERVATIVE_BEGIN_MS。
 * 回傳還要等幾毫秒（0＝可以按）。前一顆不是短等待＝0
 */
export function ideckQuietWaitMs(prev: { clickTs: number; fast: boolean } | null, now: number): number {
  if (!prev || !prev.fast) return 0
  return Math.max(0, prev.clickTs + IDECK_CONSERVATIVE_BEGIN_MS - now)
}
/**
 * 一筆 begin 歸給誰（時間都用**頁面時鐘**：begin.ts 與按下時的 clickTs 都取自同一個 frame 的 Date.now）。
 * - 在下一顆按下之前 → prev（前一顆晚到的 begin）
 * - 在下一顆按下之後：前一顆是短等待、而且還在它的保守窗口內 → ambiguous；否則 → next
 */
export function attributeBegin(p: { beginTs: number; prev: { clickTs: number; fast: boolean } | null; nextClickTs: number | null }): 'prev' | 'next' | 'ambiguous' {
  if (p.nextClickTs === null || p.beginTs < p.nextClickTs) return 'prev'
  if (p.prev?.fast && p.beginTs - p.prev.clickTs < IDECK_CONSERVATIVE_BEGIN_MS) return 'ambiguous'
  return 'next'
}

// ── 1007 learn 來回按（osm-qa-agent／主使用者：「按 A → 按 B → 再按回 A 會變回 A 的樣子」才是真指標，動畫和獎池不會）──
// 每組（SEND 的 name 去掉尾數：Denom／Bet／BetMultiple）只做一次：同組連著兩顆 A、B 都按完、A 沒開局 → 按回 A。
//   A 開過局（例如按到已選中的 88Credits）不拿來當回程鍵——按回去會再開一局；等同組下一對。
//   B 開局也不做：開局會改 CREDIT 等區，按回 A 也回不去，比不出東西。
export function ideckBackPick(outcomes: Array<{ name: string | null; result: IdeckResult; round?: boolean }>, done: Set<string>): number | null {
  const n = outcomes.length
  if (n < 2) return null
  const a = outcomes[n - 2], b = outcomes[n - 1]
  const g = (x: { name: string | null }) => (x.name ?? '').replace(/\d+$/, '')
  if (!a.name || !b.name || g(a) !== g(b) || done.has(g(a))) return null
  if (a.result !== 'ack' || b.result !== 'ack' || a.round || b.round) return null
  done.add(g(a))
  return n - 2
}

// ── 1008 音頻判 no sound 時再 Spin 重錄（使用者定案、osm-qa-agent 規格 spec-mt-audio-retry-1008、CodeX 定案）──────────
// 首次錄音＋最多重錄 2 次＝最多錄音 3 次。只有 VB-Cable 的「真靜音」觸發；任一次有效錄音不再靜音就用那一次照正常規則判。
/** VB-Cable 真靜音（stepAudio 與重錄共用這一份）：RMS < -80，或 RMS < -60 且 crest < 6；讀不到 RMS 也算 */
export function isAudioTrueSilence(rmsDb: number | null | undefined, crestFactor: number | null | undefined): boolean {
  const r = typeof rmsDb === 'number' ? rmsDb : NaN
  const c = typeof crestFactor === 'number' ? crestFactor : 0
  return !isFinite(r) || r < -80 || (r < -60 && c < 6)
}
/** 最近一次開局扣了多少（begin 那筆的 coin 比前一筆少多少）；算不出來回 null（呼叫端當成「不確定夠不夠下注」） */
export function lastBetFromMoneyLog(log: Array<{ seq: number; coin: number; reason: string }>): number | null {
  const s = [...log].sort((a, b) => a.seq - b.seq)
  for (let i = s.length - 1; i > 0; i--) {
    if (s[i].reason !== 'begin') continue
    const d = s[i - 1].coin - s[i].coin
    if (d > 0) return d
  }
  return null
}
/**
 * 重錄前的守衛：全部**明確通過**才可以再按 SPIN（每一次都是真下注）。回傳 null＝可以；否則是不重錄的原因。
 * CodeX：選單／局狀態讀不到也要中止；餘額要讀得到而且夠這一把。選單是否關著，用「原本的 Spin 有開局」當證據（選單開著 SPIN 不會開局）
 */
export function audioRetryPrecheck(p: {
  popupStop: boolean; popupUnknown: boolean
  /** 原本 Spin 步驟（或上一次重錄）的 moneyNtc begin 次數；null＝讀不到 */
  lastSpinBegins: number | null
  roundState: 'idle' | 'open' | 'unknown' | null
  balance: number | null; lastBet: number | null
}): string | null {
  if (p.popupStop) return '畫面有異常提示框（停止類），不再按 SPIN'
  if (p.popupUnknown) return '畫面有未知提示框，不再按 SPIN'
  if (p.lastSpinBegins === null) return '讀不到上一把 Spin 有沒有開局（無法確認選單已關）'
  if (p.lastSpinBegins === 0) return '上一把 Spin 沒有開局（選單可能開著或機台沒反應）'
  if (p.roundState === null || p.roundState === 'unknown') return '讀不到局狀態（__moneyLog）'
  if (p.roundState === 'open') return '還有一局沒結束（可能是 FG／JP／Handpay）'
  if (p.balance === null) return '讀不到機台餘額'
  if (p.lastBet === null) return '算不出一把的下注金額，無法確認餘額夠不夠'
  if (p.balance < p.lastBet) return `餘額 ${p.balance} 不夠一把（${p.lastBet}）`
  return null
}
/** 重錄歷程的一句話（寫在音頻步驟訊息最前面；批次判定看 extraData.audioFinal，不看這段字） */
export function audioRetrySummary(p: { attempts: Array<{ rmsDb: number | null; peakDb: number | null }>; recovered: boolean; stopReason: string | null }): string {
  const f = (a: { rmsDb: number | null; peakDb: number | null }) => `${a.rmsDb === null || !isFinite(a.rmsDb) ? '-∞' : a.rmsDb.toFixed(1)}/${a.peakDb === null || !isFinite(a.peakDb) ? '-∞' : a.peakDb.toFixed(1)}`
  const n = p.attempts.length
  const list = p.attempts.map(f).join('、')
  if (p.recovered) return `音頻重錄：前 ${n - 1} 次靜音（${p.attempts.slice(0, -1).map(f).join('、')} dB），第 ${n} 次錄到 ${f(p.attempts[n - 1])} dB → 用這次判`
  return `音頻重錄：錄音 ${n} 次（首次＋重錄 ${n - 1} 次）都靜音（${list} dB）${p.stopReason ? `；重錄中止：${p.stopReason}` : ''} → no sound`
}
