// 各步驟的純判定函式（2026-09-29 從 runner.ts 抽出來，好寫探針：scripts/verdicts-probe.ts）

// ─── 錄音裝置診斷（1013 spec #11，CodeX：只是診斷，不影響錄音判定）────────────────────────
// record-spin.ps1 錄的是「預設錄音裝置」。播放切到 CABLE Input 只解決一半：預設錄音不是 CABLE Output 的話，
// 錄到的是別的來源（麥克風之類），整段 -70 dB 看起來就像機台沒聲音（0234：工具 -71.9 dB、AI 同台錄得到聲音）
export type AudioEndpoint = { name: string | null; id: string | null; why: string | null }
export type AudioRouting = { render: AudioEndpoint; capture: AudioEndpoint } | { err: string }
export function audioRoutingNote(r: AudioRouting | undefined | null): string {
  if (!r) return '錄音裝置：這次錄音沒有讀'
  if ('err' in r) return `錄音裝置：讀不到（${r.err}）`
  const nm = (e: AudioEndpoint) => e.name ?? `讀不到（${e.why ?? '?'}）`
  const warns: string[] = []
  if (r.render.name && !/CABLE Input/i.test(r.render.name)) warns.push('預設播放不是 CABLE Input，遊戲聲音可能沒進 VB-Cable')
  if (r.capture.name && !/CABLE Output/i.test(r.capture.name)) warns.push('預設錄音不是 CABLE Output，錄到的可能不是遊戲聲音')
  return `錄音裝置：播放 ${nm(r.render)}／錄音 ${nm(r.capture)}${warns.length ? `｜⚠️ ${warns.join('；')}` : ''}`
}

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
  /** 1008 SPIN 一律最小注：開局族群只按最小那顆，其餘略過（不算失敗、寫在訊息裡） */
  skipped?: Array<{ label: string; text: string; why: string }>
  /** 1008：倍數族群是開局鍵（只按了 x1）→ 倍數本來就停在 x1，不需還原 */
  restoreSkipped?: string | null
  /** 1013 spec #2：這次 iDeck 的盒子三層統計（ideckBoxChain）；沒查到盒子 log 就不給 */
  boxChain?: ReturnType<typeof ideckBoxChain> | null
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
  else if (p.restoreSkipped) restoreTxt = `；不還原倍數（${p.restoreSkipped}）`
  else if (restore) {
    const ok = restore.result === 'ack'
    restoreTxt = `；還原 BetMultiple1 ${ok ? '✓' : '✗（⚠️ 倍數可能還留在最後按的那顆）'}`
    if (!ok) restoreBad = NO_RESPONSE.includes(restore.result) ? 'noResponse' : 'flow'
  } else if (hasMultiplier) { restoreTxt = '；⚠️ 有倍數鍵但找不到 BetMultiple1，還原未驗證'; restoreBad = 'flow' }
  else restoreTxt = '；沒有倍數鍵，不需還原'
  const boxTxt = apiErr ? `；盒子 log 未查（${apiErr}）` : `；盒子 log 新增 ${boxCount} 筆${p.boxChain ? `（${p.boxChain.note}）` : ''}`

  let message = `server 回應 ${acked}/${total}（${detail}）${restoreTxt}${boxTxt}`
  if (p.skipped?.length) message += `｜略過 ${p.skipped.length} 顆（${p.skipped.map(s => `${s.text || s.label}：${s.why}`).join('、')}）`
  if (bad.length) message += `｜未通過：${bad.map(o => `${o.label}「${o.text}」${o.result}${o.note ? '(' + o.note + ')' : ''}`).join('、')}`

  if (p.ambiguous) {
    // 中止前已經有真的「送了沒回」→ 那是確定的問題，照判 no response；其他（含沒還原倍數）都歸在歧義底下、記未驗
    if (bad.some(o => NO_RESPONSE.includes(o.result))) return { status: 'fail', message: `${message}｜⚠️ ${p.ambiguous}｜判定：no response` }
    // 1013（CodeX 749a324 [P2]）：profile xpath 找不到元素也是確定的問題，跟開局歸屬無關，不能被另一顆的歧義降成 SKIP
    if (bad.some(o => o.result === 'noElement')) return { status: 'fail', message: `${message}｜⚠️ ${p.ambiguous}｜判定：flow fail` }
    return { status: 'skip', message: `${message}｜⚠️ ${p.ambiguous}｜判定：ideck not verified (timing ambiguous)` }
  }
  if (bad.length || restoreBad) {
    // 全部問題都是「送了沒回／actionid 對不上」才叫 no response；找不到元素、逾時、中止、找不到還原鍵＝流程失敗
    const flow = bad.some(o => !NO_RESPONSE.includes(o.result)) || restoreBad === 'flow'
    return { status: 'fail', message: `${message}｜判定：${flow ? 'flow fail' : 'no response'}` }
  }
  // 1013（CodeX）：盒子 log 0 筆／usb 0 只記未確認，不升 WARN（原本 boxCount===0 → WARN，會跟三層判定一起誤升）
  if (!apiErr && boxCount === 0) return { status: 'pass', message: `${message}｜盒子 log 0 筆，未確認機台端` }
  // 1013 spec #2：server 都回應、但盒子 log **確定**送了指令卻一筆回應都沒有（0237：usb 15／26、hw 0）。只在既有判定是 PASS 時才升 WARN
  if (p.boxChain?.noResponse) return { status: 'warn', message: `${message}｜⚠️ server 已回應；盒子已送出 ${p.boxChain.sent} 筆，觀察窗口內未見機台回應` }
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
  /** 1008 SPIN 一律最小注：還原倍數之前先按回這一顆（最小的 Credits 鍵；回傳它在 buttons 的位置，null＝不按）；idx 記成 restore-min */
  minRestore?: (outcomes: O[]) => number | null | 'stop' | Promise<number | null | 'stop'>
  /** 1008：還原 BetMultiple1 之前問一次，回傳原因＝不還原（倍數族群是開局鍵、只按了 x1） */
  skipRestore?: (outcomes: O[]) => string | null
}): Promise<{ outcomes: O[]; restore: O | null; aborted: boolean; stopped: boolean; backs: Array<{ of: number; o: O }>; minRestore?: O | null; skipped: O[]; restoreSkipped?: string | null }> {
  const skipped: O[] = []
  const outcomes: O[] = []
  /**
   * CodeX 3487482 [P1]：outcomes[k] 是 buttons[btnOf[k]] 按出來的。有略過的鍵之後兩者位置就錯開了——
   * 原本拿 outcomes 的位置去取 buttons，「還原 x1」會按到別顆（重現：略過 Bet88 後還原按到 Bet88）。back 同理。
   */
  const btnOf: number[] = []
  const backs: Array<{ of: number; o: O }> = []
  const step = async (b: B, idx: string) => {
    const o = await p.press(b, idx)
    // 1008：press 回 skipped（開局族群的大注鍵）＝沒有按，不 settle、不算進 outcomes
    if ((o as { skipped?: string }).skipped) return { o, timeout: false, skipped: true }
    if (o.result === 'spinTimeout' || o.halt) { await p.afterTimeout(o, idx); return { o, timeout: true } }
    await p.settle(o, idx)
    return { o, timeout: false }
  }
  for (let i = 0; i < p.buttons.length; i++) {
    if (p.shouldStop()) return { outcomes, restore: null, aborted: false, stopped: true, backs, skipped }
    const st = await step(p.buttons[i], String(i + 1))
    const { o, timeout } = st
    if ((st as { skipped?: boolean }).skipped) { skipped.push(o); continue }
    outcomes.push(o); btnOf.push(i)
    if (timeout) return { outcomes, restore: null, aborted: true, stopped: false, backs, skipped }
    const ok = p.back?.(outcomes) ?? null
    const bi = ok !== null && ok >= 0 && ok < outcomes.length - 1 ? btnOf[ok] : null
    if (bi !== null) {
      if (p.shouldStop()) return { outcomes, restore: null, aborted: false, stopped: true, backs, skipped }
      const r = await step(p.buttons[bi], `back-${bi + 1}`)
      backs.push({ of: bi, o: r.o })
      if (r.timeout) return { outcomes, restore: null, aborted: true, stopped: false, backs, skipped }
    }
  }
  let minRestore: O | null = null
  // 1008：minRestore 可以先做收尾的關卡（等最後一顆的保守窗口、晚到的局）；回 'stop'＝局沒結束，零後續點擊（連 x1 都不按）
  const mi = (await p.minRestore?.(outcomes)) ?? null
  if (mi === 'stop') return { outcomes, restore: null, aborted: true, stopped: false, backs, minRestore, skipped }
  if (mi !== null && mi >= 0 && mi < p.buttons.length) {
    if (p.shouldStop()) return { outcomes, restore: null, aborted: false, stopped: true, backs, minRestore, skipped }
    const r = await step(p.buttons[mi], 'restore-min')
    minRestore = r.o
    if (r.timeout) return { outcomes, restore: null, aborted: true, stopped: false, backs, minRestore, skipped }
  }
  const x1o = outcomes.findIndex(o => o.name === 'BetMultiple1')
  const x1 = x1o >= 0 ? btnOf[x1o] : -1
  if (x1 < 0) return { outcomes, restore: null, aborted: false, stopped: false, backs, minRestore, skipped }
  const noRestore = p.skipRestore?.(outcomes) ?? null
  if (noRestore) return { outcomes, restore: null, aborted: false, stopped: false, backs, minRestore, skipped, restoreSkipped: noRestore }
  if (p.shouldStop()) return { outcomes, restore: null, aborted: false, stopped: true, backs, minRestore, skipped }
  const { o: restore, timeout } = await step(p.buttons[x1], 'restore')
  return { outcomes, restore, aborted: timeout, stopped: false, backs, minRestore, skipped }
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
export type BlindBurstState = { presses: number; bal0: number | null | undefined; lastBal?: number; lastPresses?: number; debited?: number; lastSeenBal?: number; lastSeenPresses?: number; moneySeq0?: number }
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
  /** CodeX 224801b [P1]：開始盲推以來 moneyNtc 逐筆的實際扣款（派彩不抵銷）；null＝讀不到流水 → 每一下照單把成本算 */
  readDebited?: () => Promise<number | null>
  press: () => Promise<void>
}): Promise<{ halt: string | null; pressed: number }> {
  const s = d.state
  let pressed = 0
  if (!Number.isFinite(d.spinCost) || d.spinCost <= 0) return { halt: '注額不明（讀不到這台實際扣款），不盲推', pressed }
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
    // 1013：累積扣款（派彩不抵銷），不是 bal0 − bal 的淨額
    const sampled = noteBlindDebit(s, bal, s.presses, d.spinCost)
    const tx = d.readDebited ? await d.readDebited() : undefined
    const spent = tx === undefined ? sampled : Math.max(sampled, tx ?? s.presses * d.spinCost)
    if (d.maxSpend - spent < d.spinCost) return { halt: `剩餘額度不夠再付一把（已扣 ${spent}，上限 ${d.maxSpend}，單把 ${d.spinCost}）`, pressed }
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
/**
 * 1013 spec #7（CodeX）：盲推的扣款上限算**累積扣款**——每次讀到餘額，比上一次少的部分加進 debited；派彩（變多）不抵銷。
 * 原本用 bal0 − bal（淨額），中一把就把額度補回來，等於沒上限。回傳更新後的 debited
 */
export function noteBlindDebit(state: { debited?: number; lastSeenBal?: number; lastSeenPresses?: number }, bal: number, presses?: number, spinCost?: number): number {
  if (state.lastSeenBal !== undefined) {
    if (bal < state.lastSeenBal) state.debited = (state.debited ?? 0) + (state.lastSeenBal - bal)
    // 餘額只在兩下之間讀一次：這段期間按了、又剛好中獎 → 那一下的成本藏在淨增加裡。
    // 派彩不能抵銷（CodeX）→ 變多的區間，這段期間按的每一下都照單把成本算（保守：可能提早停，不會多花）
    else if (bal > state.lastSeenBal && presses !== undefined && spinCost !== undefined && Number.isFinite(spinCost)) {
      const k = Math.max(0, presses - (state.lastSeenPresses ?? presses))
      state.debited = (state.debited ?? 0) + k * spinCost
    }
  }
  state.lastSeenBal = bal
  if (presses !== undefined) state.lastSeenPresses = presses
  return state.debited ?? 0
}
/**
 * CodeX 224801b [P1]：餘額只在兩下之間讀一次，扣 18、派 9 的話淨額只少 9 → 上限 252 按了 27 把（實扣 486）。
 * 改看 **moneyNtc 流水逐筆**：每一局 begin 比上一筆少多少就是那一局實際扣的（派彩在 end，不會抵銷）。
 * 從 seq0（開始盲推時的最後一筆）起算；seq0 那筆已經不在流水裡（環形緩衝 200 筆被擠掉）＝無法逐筆確認 → 回 null（呼叫端改保守：每一下照單把成本算）
 */
export function blindDebitsSince(log: Array<{ seq: number; coin: number; reason: string }>, seq0: number): number | null {
  const s = [...log].sort((a, b) => a.seq - b.seq)
  if (seq0 > 0 && !s.some(e => e.seq === seq0)) return null
  const startCoin = seq0 > 0 ? s.find(e => e.seq === seq0)!.coin : null
  // 開始盲推時流水是空的（seq0＝0）：沒有起點，第一筆如果就是 begin，那一局扣多少算不出來 → 無法逐筆確認
  if (seq0 === 0 && s.length && s[0].reason === 'begin') return null
  // seq0＝0 時第一筆（不是 begin）當起點；否則從 seq0 那筆的餘額起算
  const r = roundDeductions(startCoin, seq0 > 0 ? s.filter(e => e.seq > seq0) : s)
  return r.rounds.filter(x => x.kind === 'paid').reduce((a, x) => a + x.deduction, 0)
}
/** 1013：盲推單把成本＝實測注額（spinCost）、上限＝BLIND_SPEND_SPINS 倍；注額不明就不盲推（回 null） */
export const BLIND_SPEND_SPINS = 14
export function blindBudget(measuredBet: number | null | undefined): { spinCost: number; maxSpend: number } | null {
  if (typeof measuredBet !== 'number' || !Number.isFinite(measuredBet) || measuredBet <= 0) return null
  return { spinCost: measuredBet, maxSpend: measuredBet * BLIND_SPEND_SPINS }
}
export function extraSpinDecision(s: { stopped: boolean; presses: number; maxPresses: number; bodyText: string; bal: number | null; bal0: number | null | undefined; maxSpend: number; spinCost: number; state?: { debited?: number; lastSeenBal?: number; lastSeenPresses?: number }; txDebited?: number | null }): { ok: boolean; reason?: string } {
  if (s.stopped) return { ok: false, reason: '收到停止指令' }
  if (s.presses >= s.maxPresses) return { ok: false, reason: `已達單台上限 ${s.maxPresses} 下` }
  if (/hand\s*-?\s*pay/i.test(s.bodyText)) return { ok: false, reason: '畫面出現 Handpay' }
  if (!Number.isFinite(s.spinCost) || s.spinCost <= 0) return { ok: false, reason: '注額不明（讀不到這台實際扣款），不盲推' }
  if (s.bal == null || s.bal0 == null) return { ok: false, reason: '讀不到前端餘額' }
  // 有給 state＝累積扣款（派彩不抵銷）；沒給才退回舊的淨額算法（舊呼叫端相容）
  const sampled = s.state ? noteBlindDebit(s.state, s.bal, s.presses, s.spinCost) : Math.max(0, s.bal0 - s.bal)
  // 有給 txDebited（流水逐筆）就用它跟取樣值取大的；流水讀不到（null）＝每一下照單把成本算（保守）
  const spent = s.txDebited === undefined ? sampled : Math.max(sampled, s.txDebited ?? s.presses * s.spinCost)
  if (s.maxSpend - spent < s.spinCost) return { ok: false, reason: `剩餘額度不夠再付一把（已扣 ${spent}，上限 ${s.maxSpend}）` }
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
// 1013 spec #7（CodeX）：
//   - Take Win 優先：只在這個機種確定 Take＝收分（profile clickTake 或 bonusAction=takewin）時才給 takeWin；每一下前重查 end／停止、算進動作次數
//   - SPIN 照舊要 OCR 判成 spin 才按
//   - 扣款守門：這一局還開著、機台餘額低於這局 begin 的餘額 → 回 debit，立刻交人工，**不做任何後續救援**
export type OpenRoundResult = { result: 'done' | 'stalled' | 'stopped' | 'debit'; acts: number; ms: number; how: string[] }
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
  /** 1013：按畫面上看得到的 Take（收分）；呼叫端只在機種確定 Take＝收分時才給。點之前自己重查 end／停止，回傳有沒有真的點 */
  takeWin?: () => Promise<boolean>
  /** 1013：這一局還開著、餘額卻低於這局 begin 的餘額（＝按到付費局）。讀不到 begin 餘額就不給 */
  debited?: () => Promise<boolean>
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
  const debit = async () => !!d.debited && await d.debited()
  while (true) {
    if (await d.ended()) return out('done')
    if (d.stop()) return out('stopped')
    if (await debit()) { how.push('debit'); return out('debit') }   // 扣款：立刻交人工，不救援
    if (d.now() - t0 >= d.maxMs) return out('stalled')
    if (acts >= d.maxActs) { await d.sleep(d.pollMs); continue }   // 點擊上限：只被動等 end
    await d.closeOverlays()
    if (await d.ended()) return out('done')   // 關遮罩途中收到 end
    // Take Win 優先（收分不會下注）：按到了就等下一輪再看，這一輪不再按別的
    if (d.takeWin && acts < d.maxActs && !d.stop() && !(await d.ended())) {
      if (await d.takeWin()) {
        acts++; how.push('take'); lastProgress = d.now()
        if (await debit()) { how.push('debit'); return out('debit') }
        await d.sleep(d.pollMs); continue
      }
    }
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
    // 任何一下點擊之後：餘額比這局 begin 少、局還開著 → 按到付費局，立刻停（不進下面的救援）
    if (await debit()) { how.push('debit'); return out('debit') }
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

// ── 1008 SPIN 一律最小注（使用者硬規則：「SPIN 一律用最小注、別下大注」；先做後審，CodeX 14:59 後補看）──────────
// iDeck 鍵依按鈕上的字分三組：面額（₱ 0.50）、Credits（PLAY 9 Credits／88Credits）、倍數（BETx1）。每組挑數字最小的那顆。
// ⚠️ 同一組最小值有兩顆、字讀不懂 → 不猜（回 ambiguous），呼叫端就不 SPIN。
export type BetKeyGroup = 'denom' | 'credits' | 'mult'
export function classifyBetKey(text: string): { group: BetKeyGroup; value: number } | null {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  let m = t.match(/^BET\s*x\s*(\d+)$/i) ?? t.match(/^x\s*(\d+)$/i)
  if (m) return { group: 'mult', value: Number(m[1]) }
  m = t.match(/(\d+(?:\.\d+)?)\s*Credits?$/i)
  if (m) return { group: 'credits', value: Number(m[1]) }
  m = t.match(/^[₱P]\s*(\d+(?:\.\d+)?)$/)
  if (m) return { group: 'denom', value: Number(m[1]) }
  return null
}
export function pickMinBetKeys(keys: Array<{ idx: number; text: string }>): { picks: Partial<Record<BetKeyGroup, { idx: number; text: string; value: number }>>; ambiguous: string[]; groups: BetKeyGroup[] } {
  const by: Partial<Record<BetKeyGroup, Array<{ idx: number; text: string; value: number }>>> = {}
  for (const k of keys) { const c = classifyBetKey(k.text); if (c) (by[c.group] ??= []).push({ idx: k.idx, text: k.text, value: c.value }) }
  const picks: Partial<Record<BetKeyGroup, { idx: number; text: string; value: number }>> = {}
  const ambiguous: string[] = []
  for (const g of ['denom', 'credits', 'mult'] as BetKeyGroup[]) {
    const list = by[g]; if (!list?.length) continue
    const min = Math.min(...list.map(x => x.value))
    const hits = list.filter(x => x.value === min)
    if (hits.length > 1) ambiguous.push(`${g} 最小值 ${min} 有 ${hits.length} 顆（${hits.map(h => h.text).join('、')}）`)
    else picks[g] = hits[0]
  }
  return { picks, ambiguous, groups: Object.keys(by) as BetKeyGroup[] }
}

/**
 * 1008 iDeck 依族群排序（使用者：「iDeck 會開局的狀況要在學習時驗證出來」、別下大注）：
 * 同一族群（面額／Credits／倍數）佔用的位置不變，但族群內改成**由小到大**——最小那顆一定先按，用它判斷這個族群是不是開局鍵。
 * 不屬於任何族群的鍵留在原位。回傳新順序（原本的 index）。
 */
export function ideckFamilyOrder(texts: string[]): number[] {
  const fam = texts.map(t => classifyBetKey(t))
  const order = texts.map((_, i) => i)
  for (const g of ['denom', 'credits', 'mult'] as BetKeyGroup[]) {
    const slots = fam.map((f, i) => (f?.group === g ? i : -1)).filter(i => i >= 0)
    const sorted = [...slots].sort((a, b) => fam[a]!.value - fam[b]!.value || a - b)
    slots.forEach((slot, k) => { order[slot] = sorted[k] })
  }
  return order
}

// ─── 盒子 log 三層配對（1013 spec #2，CodeX 定案）─────────────────────────────────────────────
// 一次觸屏／iDeck 在盒子 log 是三層：success_json{cmd,is_touch}（盒子收到）→ usb_coordinate（盒子送到機台）→ hw_response（機台有回應）。
// 只有「盒子收到」不等於機台有反應：0237 盒子送了 usb 15／26 次、機台 hw_response 0（停在 SELECT DENOM），原本照樣判 PASS 3/3；
// 0245 盒子 success_json 都在、連 usb 都沒送。正常台 hw 數＝usb 數（0231 16/16、0232 15/15）。
//
// 配對規則：
//   - usb：綁在這一筆 success 之後、下一筆觸屏 success 之前、10 秒內（沿用原本 followedByUsb）
//   - hw：沒有序號可對（只有 raw payload；gmid／userid 是整台的），而且會**晚到下一筆 success 之後**（0231：usb 6,4 → success 8,4 → hw）
//     → 不能用「下一筆之前」的窗口，也不能 FIFO 硬配（A 沒回、B 有回時 FIFO 會把 B 的 hw 配給 A，CodeX）。
//     改成「重疊群組」：等待中的 usb（各自 10 秒窗口，從 usb 發生時間起算）互相重疊就是同一組；hw 只歸到「組」，不歸到某一筆。
//     組內 hw 數＝usb 數 → 全部有回；hw 是 0 → 全部沒回；介於兩者 → 這組每一格都**未驗**（不硬配 PASS）
//   - 群組包含同一台**所有** usb（含非測試操作），避免借到別筆的 hw
//   - 窗口過了才到的 hw 不補給任何一筆；剛有一筆逾時沒回、10 秒內又開新組 → 新組的 hw 可能是舊那筆晚到的，有 hw 就算未驗
//   - log 不夠長（窗口還沒過完 log 就結束了）→ 沒回的那格算未驗，不算機台不回應
export type BoxLogEntry = { time: string; type: string; data: unknown }
export type BoxChainState = 'ok' | 'noUsb' | 'noHw' | 'unknown' | 'noBox'
export const BOX_CHAIN_WINDOW_S = 10

const boxData = (e: BoxLogEntry): Record<string, unknown> => {
  if (typeof e.data === 'string') { try { return JSON.parse(e.data) as Record<string, unknown> } catch { return {} } }
  return (e.data ?? {}) as Record<string, unknown>
}
const boxSecs = (t: string) => { const [h, m, s] = String(t).split(':').map(Number); return h * 3600 + m * 60 + s }
const isTouchSuccess = (e: BoxLogEntry) => { if (e.type !== 'success_json') return false; const d = boxData(e); return d.is_touch === true || d.is_touch === 1 }

/** API 的排序方向沒保證：頭尾比一下，統一成由舊到新（同原本 stepTouchscreen 的做法） */
export function orderBoxTimeline(tl: BoxLogEntry[]): BoxLogEntry[] {
  return tl.length > 1 && boxSecs(tl[0].time) > boxSecs(tl[tl.length - 1].time) ? [...tl].reverse() : tl
}

/** 每顆 usb 的回應狀態：answered／none／unknown（附原因） */
export function usbResponseStates(ordered: BoxLogEntry[]): Map<BoxLogEntry, { state: 'answered' | 'none' | 'unknown'; why: string }> {
  // 組＝窗口互相重疊的 usb。hw 只算進「組」，**不從組裡拿掉任何一筆的期限**——
  //   CodeX c287073 [P2]：原本 hw 一到就 pending.shift()，把某一筆的期限丟掉；A＝0 秒、B＝9 秒、hw＝11 秒時，
  //   11 秒的 hw 可能是 A 晚回（B 其實沒回），但 B 的期限被丟掉 → 21 秒的 C 收到 hw 被判 ok（應該是未驗：可能是 B 晚回）。
  // 組結束：全部回完（hw 數＝usb 數）就提早結束；否則等組裡最晚的期限過了才結束，並記下這個期限——
  //   沒回完的組，裡面每一筆都可能是沒回的那筆，之後 10 秒內開的新組收到的 hw 可能是它晚到的
  type Group = { usbs: BoxLogEntry[]; lastDeadline: number; hw: number; tainted: boolean }
  const groups: Group[] = []
  let cur: Group | null = null
  let lastUnresolved = -Infinity
  const close = () => { if (cur && cur.hw < cur.usbs.length) lastUnresolved = Math.max(lastUnresolved, cur.lastDeadline); cur = null }
  const expire = (t: number) => { if (cur && t > cur.lastDeadline) close() }
  for (const e of ordered) {
    const t = boxSecs(e.time)
    if (e.type === 'usb_coordinate') {
      expire(t)
      if (!cur) { cur = { usbs: [], lastDeadline: -Infinity, hw: 0, tainted: t - lastUnresolved <= BOX_CHAIN_WINDOW_S }; groups.push(cur) }
      cur.usbs.push(e); cur.lastDeadline = Math.max(cur.lastDeadline, t + BOX_CHAIN_WINDOW_S)
    } else if (e.type === 'hw_response') {
      expire(t)
      if (!cur) continue   // 沒有開著的組：逾時晚到或不相干，不補給任何一筆
      cur.hw++
      if (cur.hw >= cur.usbs.length) close()   // 全部回完：不管哪一筆配哪一筆，都有回
    }
  }
  close()
  const horizon = ordered.reduce((m, e) => Math.max(m, boxSecs(e.time)), -Infinity)
  const out = new Map<BoxLogEntry, { state: 'answered' | 'none' | 'unknown'; why: string }>()
  for (const g of groups) {
    const n = g.usbs.length
    for (const u of g.usbs) {
      let st: { state: 'answered' | 'none' | 'unknown'; why: string }
      if (g.hw >= n) st = g.tainted ? { state: 'unknown', why: '前一筆逾時沒回，這組的回應可能是它晚到的' } : { state: 'answered', why: '' }
      // 整組一筆回應都沒有：窗口已被 log 涵蓋完的那幾筆＝確定沒回（窗口內只要有 hw 就會算進這組）；還沒涵蓋完的才是未驗。
      //   0237 實測：沒有回應時 usb 會一路串成同一組，不能因為最後一筆接近 log 結尾就整組變未驗
      else if (g.hw === 0) st = boxSecs(u.time) + BOX_CHAIN_WINDOW_S <= horizon ? { state: 'none', why: '' } : { state: 'unknown', why: 'log 還沒涵蓋完整 10 秒' }
      else st = { state: 'unknown', why: `同時 ${n} 筆在等、只回 ${g.hw} 筆，無法確定是哪一筆沒回` }
      out.set(u, st)
    }
  }
  return out
}

/**
 * 每個點過的格子（success_json 的 cmd）→ 三層狀態。
 * isNew：排除點擊前就存在的 success（呼叫端用 baseline 判斷）。同一格有多筆 success 時，有一筆三層齊全就算 ok；
 * 沒有就取確定的失敗（機台不回應 > 盒子沒送 > 未驗）——重複的 success 不能補別格的缺（CodeX）
 */
export function boxChains(timeline: BoxLogEntry[], labels: string[], isNew: (e: BoxLogEntry) => boolean = () => true): Record<string, { state: BoxChainState; why: string }> {
  const per: Record<string, Array<{ state: BoxChainState; why: string }>> = Object.fromEntries(labels.map(l => [l, []]))
  for (const c of successChains(timeline, isNew)) if (c.cmd in per) per[c.cmd].push({ state: c.state, why: c.why })
  // 有一次三層齊全就算 ok；否則確定的失敗優先（某一次確定沒回，比另一次 log 沒涵蓋完更有資訊），最後才是未驗
  const rank: Record<BoxChainState, number> = { ok: 0, noHw: 1, noUsb: 2, unknown: 3, noBox: 4 }
  return Object.fromEntries(labels.map(l => {
    const xs = per[l]
    if (!xs.length) return [l, { state: 'noBox' as BoxChainState, why: '' }]
    const ok = xs.find(x => x.state === 'ok')
    return [l, ok ?? [...xs].sort((a, b) => rank[a.state] - rank[b.state])[0]]
  }))
}

/** 每一筆新的觸屏／iDeck success_json → 三層狀態（觸屏依格子彙整，iDeck 直接統計） */
export function successChains(timeline: BoxLogEntry[], isNew: (e: BoxLogEntry) => boolean = () => true): Array<{ cmd: string; time: string; state: Exclude<BoxChainState, 'noBox'>; why: string }> {
  const ordered = orderBoxTimeline(timeline)
  const usbState = usbResponseStates(ordered)
  const out: Array<{ cmd: string; time: string; state: Exclude<BoxChainState, 'noBox'>; why: string }> = []
  for (let i = 0; i < ordered.length; i++) {
    const s = ordered[i]
    if (!isTouchSuccess(s) || !isNew(s)) continue
    const cmd = String(boxData(s).cmd ?? '')
    let usb: BoxLogEntry | null = null
    for (let k = i + 1; k < ordered.length; k++) {
      const u = ordered[k]
      if (boxSecs(u.time) - boxSecs(s.time) > BOX_CHAIN_WINDOW_S) break
      if (isTouchSuccess(u)) break
      if (u.type === 'usb_coordinate') { usb = u; break }
    }
    if (!usb) {
      // 窗口還沒過完 log 就結束（後面也沒有下一筆觸屏把窗口關掉）→ 未驗；否則確定盒子沒送
      const horizon = boxSecs(ordered[ordered.length - 1].time)
      const open = boxSecs(s.time) + BOX_CHAIN_WINDOW_S > horizon && !ordered.slice(i + 1).some(isTouchSuccess)
      out.push(open ? { cmd, time: s.time, state: 'unknown', why: 'log 還沒涵蓋完整 10 秒' } : { cmd, time: s.time, state: 'noUsb', why: '' })
      continue
    }
    const r = usbState.get(usb)!
    out.push(r.state === 'answered' ? { cmd, time: s.time, state: 'ok', why: '' } : r.state === 'none' ? { cmd, time: s.time, state: 'noHw', why: '' } : { cmd, time: s.time, state: 'unknown', why: r.why })
  }
  return out
}

/**
 * iDeck 的盒子三層統計（1013 spec #2，CodeX：iDeck 不靠「開局鍵」判，改看盒子 log 有沒有機台回應）。
 * 只在**確定**的情況回 noResponse：這次 iDeck 的指令都有送到機台（usb）、每一筆的等待窗口都被 log 涵蓋、配對沒有歧義，而且一筆回應都沒有。
 * 有歧義／log 不完整／usb＝0 → 只記未確認（不升 WARN）。驗的是通訊回應，不代表驗過開局能力。
 */
export function ideckBoxChain(chains: Array<{ state: Exclude<BoxChainState, 'noBox'> }>): { received: number; sent: number; answered: number; unknown: number; noResponse: boolean; note: string } {
  const received = chains.length
  const answered = chains.filter(c => c.state === 'ok').length
  const noHw = chains.filter(c => c.state === 'noHw').length
  const unknown = chains.filter(c => c.state === 'unknown').length
  const sent = answered + noHw   // 確定有送 usb、而且配得到狀態的筆數
  const noResponse = received > 0 && noHw === received   // 每一筆都確定「有送、沒回」
  const note = received === 0 ? '盒子 log 沒有這次的 iDeck 指令（未確認）'
    : `盒子三層：收到 ${received}、確定送出 ${sent}、機台回應 ${answered}${unknown ? `、未確認 ${unknown}` : ''}${chains.length - sent - unknown ? `、沒送到機台 ${chains.length - sent - unknown}` : ''}`
  return { received, sent, answered, unknown, noResponse, note }
}

/** 觸屏的盒子 log 判定（apiErr 由呼叫端先處理成未驗） */
export function touchChainVerdict(chains: Record<string, { state: BoxChainState; why: string }>): { status: 'pass' | 'warn' | 'fail' | 'skip'; ok: number; total: number; detail: string; tag: string } {
  const labels = Object.keys(chains)
  const by = (s: BoxChainState) => labels.filter(l => chains[l].state === s)
  const ok = by('ok').length, total = labels.length
  const mark: Record<BoxChainState, string> = { ok: '✓', noUsb: '✗盒子沒送到機台', noHw: '✗機台不回應', unknown: '?未驗', noBox: '✗盒子沒收到' }
  const detail = labels.map(l => `${l}${mark[chains[l].state]}${chains[l].state === 'unknown' && chains[l].why ? `(${chains[l].why})` : ''}`).join(' ')
  const noHw = by('noHw'), noUsb = by('noUsb'), noBox = by('noBox'), unk = by('unknown')
  // 確定的失敗先判；有 usb 沒 hw＝機台不回應（no response），連 usb 都沒有＝盒子沒送（flow fail）
  if (noHw.length) return { status: 'fail', ok, total, detail, tag: `判定：no response（機台不回應：${noHw.join('、')}）` }
  if (noUsb.length) return { status: 'fail', ok, total, detail, tag: `判定：flow fail（盒子沒送到機台：${noUsb.join('、')}）` }
  // 盒子沒收到：沿用原本規則（一格都沒有＝FAIL、部分＝WARN）
  if (noBox.length) return ok === 0 && !unk.length ? { status: 'fail', ok, total, detail, tag: '判定：no response' } : { status: 'warn', ok, total, detail, tag: `盒子沒收到：${noBox.join('、')}` }
  if (unk.length) return { status: 'skip', ok, total, detail, tag: `未驗：${unk.length} 格盒子 log 無法確認三層` }
  return { status: 'pass', ok, total, detail, tag: '' }
}

// ─── 每局扣款（1013 spec #6，CodeX 有條件同意）────────────────────────────────────────────────
// 起點＝enterGMNtc 的 coin（本台入帳後餘額；osm-qa-agent 用 0231 實測：＝盒子 credit_load 2,000,000、跟 moneyNtc 同單位）。
// 每局扣款＝上一筆 moneyNtc 的餘額（第一局用起點）− 這局 begin 的餘額：
//   > 0 → paid；＝ 0 → zero（可能是免費局，**不能要求 > 0**，記未驗）；< 0 → gap（流水不連續，記未驗）
// 只產生紀錄與訊息，不改 Spin 判定（畫面 BET 值還沒讀，「扣款與注額不符」這次不判）
export type RoundDeduction = { seq: number; prev: number; begin: number; deduction: number; kind: 'paid' | 'zero' | 'gap' }
export function roundDeductions(start: number | null, log: Array<{ seq: number; coin: number; reason: string }>): { rounds: RoundDeduction[]; note: string } {
  const s = [...log].sort((a, b) => a.seq - b.seq)
  let prev: number | null = start
  const rounds: RoundDeduction[] = []
  for (const e of s) {
    if (e.reason === 'begin' && prev !== null && Number.isFinite(e.coin)) {
      const d = prev - e.coin
      rounds.push({ seq: e.seq, prev, begin: e.coin, deduction: d, kind: d > 0 ? 'paid' : d === 0 ? 'zero' : 'gap' })
    }
    if (Number.isFinite(e.coin)) prev = e.coin
  }
  const paid = rounds.filter(r => r.kind === 'paid'), zero = rounds.filter(r => r.kind === 'zero'), gap = rounds.filter(r => r.kind === 'gap')
  const last = s.length ? s[s.length - 1].coin : null
  const parts = [`餘額 ${start ?? '?'}（進場）→ ${last ?? '?'}`, paid.length ? `每局扣款 ${paid.map(r => r.deduction).join('、')}` : '沒有確認到扣款']
  if (zero.length) parts.push(`${zero.length} 局扣款 0（可能是免費局，未驗）`)
  if (gap.length) parts.push(`${gap.length} 局流水不連續（未驗）`)
  return { rounds, note: parts.join('，') }
}

// ─── AFT 轉入失敗熔斷（1013 spec #5，CodeX 定案）─────────────────────────────────────────────
// 10-13 晚上 0233～0245 共 12 台進場 AFT 轉入失敗（盒子 aft_in_end success:false state=87），之後全部卡成 Occupied——
// 一路連打下去只會鎖住更多台。這比較可能是帳號或 AFT 系統端的問題，不是單台。
// 規則：連續 2 台都在**本台這次進場**查到 AFT 轉入失敗、而且 state 相同（已知的 state）→ 停批。
//   - 舊的失敗紀錄（這次進場窗口以外）不算；state 不明（'?'）不算；查不到／無法確認也不算，而且會把連續計數歸零
//   - 檢查在 runner 派下一台**之前**完成（runWorker 每台跑完先看 haltReason）
export type AftLookup = { kind: 'fail'; state: string; time: string } | { kind: 'ok' } | { kind: 'unknown'; why: string }
export function aftBreaker(prev: { code: string; state: string } | null, code: string, cur: AftLookup): { next: { code: string; state: string } | null; halt: string | null } {
  if (cur.kind !== 'fail' || !/^\d+$/.test(cur.state)) return { next: null, halt: null }
  if (prev && prev.state === cur.state) return { next: { code, state: cur.state }, halt: `連續 2 台 AFT 轉入失敗、state 相同（${prev.code}、${code}：state=${cur.state}）——比較可能是帳號或 AFT 系統端的問題，繼續跑只會鎖住更多台；停批，請先查帳號與 AFT（被鎖的機台要到後台 EGM Status 釋放）` }
  return { next: { code, state: cur.state }, halt: null }
}
/** 進場失敗的訊息要不要查 AFT：大廳找不到（沒進到 AFT）、AUDIT MODE（機台在維修選單）不查 */
export function entryNeedsAftLookup(entry: { status: string; message: string } | undefined): boolean {
  if (!entry || entry.status !== 'fail') return false
  if (/大廳找不到|AUDIT MODE/.test(entry.message)) return false
  return true
}
/**
 * 盒子 log 裡這個帳號在窗口內的 aft_in_end（跟 batch 的 findAftFailure 同一套窗口：盒子時間是 UTC+8 的 HH:MM:SS、
 * 時鐘比我們快約 2 分鐘 → 進場前 1 分～結束後 6 分）。有失敗回 fail；只有成功回 ok；一筆都沒有回 null（呼叫端決定要不要再等）
 */
export function findAftInEnd(timeline: BoxLogEntry[], p: { uid: string; fromMs: number; toMs: number; date: string }): AftLookup | null {
  let sawOk = false
  for (const e of timeline) {
    if (e.type !== 'aft_in_end' || String((e as { userid?: unknown }).userid ?? '') !== p.uid) continue
    const t = Date.parse(`${p.date}T${e.time}+08:00`)
    if (!(t >= p.fromMs && t <= p.toMs)) continue
    const d = boxData(e)
    if (d.success === false) return { kind: 'fail', state: String(d.state ?? '?'), time: e.time }
    if (d.success === true) sawOk = true
  }
  return sawOk ? { kind: 'ok' } : null
}
