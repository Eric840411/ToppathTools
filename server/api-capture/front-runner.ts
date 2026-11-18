/**
 * API 參數紀錄：agent 端的前台錄製（docs/features/35-api-capture.md）。
 *
 * 用指定帳號的大廳連結開 H5 大廳 → 找機台 → Join → 用預設（最小）注一直 Spin 到停止條件
 * → 退出機台放掉位子。全程錄前台 WebSocket、遊戲 console（解碼過的 pinus SEND/ON）、HTTP（xhr/fetch）。
 *
 * ⚠️ 跑在 Local Agent（AGENT_SOURCE_WHITELIST），Spug server 不開瀏覽器。
 * ⚠️ 大廳連結含 token：只在記憶體，錄到的東西送出前一律 maskText。
 * ⚠️ 不調整注額：進機台後只關掉面額選單（選第一個＝預設最小面額），不按加注。
 */
import { EventEmitter } from 'events'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { launchGuardedChromium, newGuardedContext } from '../lib/egress-guard.js'
import { startLobbyPopupWatcher } from '../uat-runner/lobby-popup.js'
import { h5BackToLobby, h5InGame } from '../uat-runner/h5-seat.js'
import { clickJoinButton, clickSpin, waitSpinSettle } from '../scripted-bet/runner.js'
import { clip, maskUrl, HTTP_NOISE_HOST } from './mask.js'
import { cardPattern, parseMachineInput, parseMoneyNtc } from './parse.js'
import type { ApiCaptureStartMessage, ApiCaptureDone, CapturePhase, FrontEvent, SpinRecord } from './types.js'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** 遊戲 console 裡值得留的行（解碼過的 pinus、Ntc、錯誤碼） */
const CONSOLE_KEEP = /SEND:|ON:|Ntc|Req\b|Res\b|errcode|request |response /

export class ApiCaptureFrontRunner extends EventEmitter {
  private stopped = false
  private browser: Browser | null = null
  private events: FrontEvent[] = []
  private sentUpTo = 0

  constructor(private msg: ApiCaptureStartMessage) { super() }

  stop() { this.stopped = true }

  private push(ev: FrontEvent) { this.events.push(ev) }
  private step(action: string, detail?: Record<string, unknown>) { this.push({ kind: 'step', t: Date.now(), action, ...(detail ? { detail } : {}) }) }
  private progress(phase: CapturePhase, message: string, spin?: number) { this.emit('progress', { phase, message, spin }) }

  /** 把還沒送的事件吐出去（呼叫端決定怎麼分批） */
  drain(): FrontEvent[] {
    const out = this.events.slice(this.sentUpTo)
    this.sentUpTo = this.events.length
    return out
  }

  private attach(page: Page) {
    page.on('websocket', ws => {
      const url = maskUrl(ws.url())
      ws.on('framesent', f => this.push({ kind: 'ws', t: Date.now(), dir: 'send', url, text: clip(typeof f.payload === 'string' ? f.payload : Buffer.from(f.payload).toString('latin1'), 8000) }))
      ws.on('framereceived', f => this.push({ kind: 'ws', t: Date.now(), dir: 'recv', url, text: clip(typeof f.payload === 'string' ? f.payload : Buffer.from(f.payload).toString('latin1'), 8000) }))
    })
    page.on('console', m => {
      const text = m.text()
      if (CONSOLE_KEEP.test(text)) this.push({ kind: 'console', t: Date.now(), text: clip(text, 4000) })
    })
    page.on('response', async r => {
      const rq = r.request()
      const ty = rq.resourceType()
      if (!['xhr', 'fetch'].includes(ty)) return
      const t = Date.now()
      const url = rq.url()
      const noise = HTTP_NOISE_HOST.test(url)
      let body = ''
      try { body = await r.text() } catch { /* 串流／已釋放 */ }
      const max = noise ? 500 : 8000
      this.push({ kind: 'http', t, method: rq.method(), url: clip(url, 2000), status: r.status(), resourceType: ty, req: clip(rq.postData() ?? '', max), res: clip(body, max), noise })
    })
  }

  private async findAndJoin(page: Page): Promise<void> {
    const m = parseMachineInput(this.msg.machine)
    if (!m.num && !m.type) throw new Error(`機台格式看不懂：${this.msg.machine}`)
    const deadline = Date.now() + 60_000
    let clicked = ''
    while (!clicked && Date.now() < deadline && !this.stopped) {
      clicked = await page.evaluate(({ type, numSource }) => {
        const re = numSource ? new RegExp(numSource) : null
        const match = (s: string) => {
          const t = s.toUpperCase()
          if (type && !t.includes(type)) return false
          return re ? re.test(t) : !!type
        }
        // 兩種大廳版型：.grid-item（名稱在 .grid-item-name）、#grid_gm_item（名稱在 title）
        for (const el of Array.from(document.querySelectorAll('.grid-item, #grid_gm_item, [id="grid_gm_item"]'))) {
          const name = ((el.querySelector('.grid-item-name') as HTMLElement | null)?.innerText || el.getAttribute('title') || '').trim()
          if (!name || !match(name)) continue
          ;(el as HTMLElement).scrollIntoView({ block: 'center' })
          ;(el as HTMLElement).click()
          return name
        }
        return ''
      }, cardPattern(m)).catch(() => '')
      if (!clicked) { await page.mouse.wheel(0, 600).catch(() => {}); await sleep(500) }
    }
    if (this.stopped) throw new Error('stopped')
    if (!clicked) throw new Error(`大廳 60 秒內找不到機台 ${this.msg.machine}`)
    this.step('find-machine', { cardName: clicked })
    this.progress('enter', `找到機台 ${clicked}，點 Join`)
    await sleep(1500)
    // Join：先試 Game Preview 的可按版本（被佔用時是 .gm-info-join-unable），再退回通用文字比對
    const join = page.locator('.pop-page-watch .gm-info-join:not(.gm-info-join-unable)').first()
    if (await join.isVisible().catch(() => false)) {
      await join.click().catch(() => join.evaluate(e => (e as HTMLElement).click()))
    } else {
      const unable = await page.locator('.pop-page-watch .gm-info-join-unable').first().isVisible().catch(() => false)
      if (unable) throw new Error('Join 不可按（機台佔用中）')
      if (!(await clickJoinButton(page, () => {}))) throw new Error('找不到 Join 按鈕')
    }
    this.step('click-join')
    const t0 = Date.now()
    while (!h5InGame(page) && Date.now() - t0 < 30_000 && !this.stopped) await sleep(800)
    if (!h5InGame(page)) throw new Error('點 Join 後 30 秒沒進機台')
    this.step('in-game')
  }

  /** 面額選單：選第一個（預設最小）並按 YES。不加注。 */
  private async dismissDenom(page: Page): Promise<boolean> {
    const opt = page.locator('.select-main .select-btn, .select-main .my-button').first()
    if (!(await opt.isVisible().catch(() => false))) return false
    await opt.click().catch(() => {})
    await sleep(800)
    for (const yes of [page.locator('.box-btn_text2:visible').first(), page.getByText('YES', { exact: true }).first()]) {
      if (await yes.isVisible().catch(() => false)) { await yes.click().catch(() => {}); break }
    }
    await sleep(800)
    return true
  }

  private async waitMoney(fromIdx: number, reason: 'begin' | 'end', ms: number): Promise<{ t: number; coin: number } | null> {
    const end = Date.now() + ms
    while (Date.now() < end && !this.stopped) {
      for (let i = fromIdx; i < this.events.length; i++) {
        const e = this.events[i]
        if (e.kind !== 'console') continue
        const mn = parseMoneyNtc(e.text)
        if (mn && mn.reason === reason) return { t: e.t, coin: mn.coin }
      }
      await sleep(300)
    }
    return null
  }

  async run(): Promise<Omit<ApiCaptureDone, 'type' | 'runId' | 'total' | 'chunks' | 'agentNow'>> {
    const startedAt = Date.now()
    const spins: SpinRecord[] = []
    let stopReason: ApiCaptureDone['stopReason'] = 'error'
    let error: string | null = null
    let exitOk = false
    let page: Page | null = null
    let ctx: BrowserContext | null = null
    let stopWatch: (() => unknown) | null = null
    try {
      this.browser = await launchGuardedChromium(chromium, { headless: !this.msg.headed, args: this.msg.headed ? [] : ['--mute-audio'] })
      ctx = await newGuardedContext(this.browser, { viewport: { width: 430, height: 860 }, isMobile: true, hasTouch: true })
      page = await ctx.newPage()
      this.attach(page)
      this.progress('login', '開啟大廳')
      this.step('open-lobby', { url: maskUrl(this.msg.url) })
      await page.goto(this.msg.url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      stopWatch = startLobbyPopupWatcher(page, {})
      await sleep(4000)
      if (h5InGame(page)) throw new Error('一開大廳就在機台裡（這個帳號上次沒退出），請先手動退出再重跑')
      if (this.stopped) throw new Error('stopped')

      this.progress('enter', `尋找機台 ${this.msg.machine}`)
      await this.findAndJoin(page)
      // 等推流與面額選單出現，最多 20 秒；Spin 鍵出現就開始
      const tEnter = Date.now()
      let denom = false
      while (Date.now() - tEnter < 20_000 && !this.stopped) {
        if (await this.dismissDenom(page)) { denom = true; break }
        if (await page.locator('.btn_spin').first().isVisible().catch(() => false) && Date.now() - tEnter > 8000) break
        await sleep(1000)
      }
      this.step('select-denom', { denomOverlay: denom })
      await sleep(2000)

      let payoutObservable = false
      const max = Math.max(1, Math.min(this.msg.maxSpins, 500))
      const target = this.msg.stopCondition === 'spins' ? Math.min(Math.max(1, this.msg.spins), max) : max
      stopReason = this.msg.stopCondition === 'spins' ? 'spins' : 'max-spins'
      for (let n = 1; n <= target; n++) {
        if (this.stopped) throw new Error('stopped')
        const from = this.events.length
        const tClick = Date.now()
        const sel = await clickSpin(page, '.btn_spin')
        if (!sel) throw new Error(`第 ${n} 局找不到可按的 Spin 鍵`)
        const begin = await this.waitMoney(from, 'begin', 10_000)
        const end = begin ? await this.waitMoney(from, 'end', 90_000) : null
        if (!begin) await waitSpinSettle(page, () => this.stopped, sel)
        if (begin) payoutObservable = true
        const win = begin && end ? +(end.coin - begin.coin).toFixed(2) : null
        spins.push({ n, tClick, tEnd: end?.t ?? null, coinBegin: begin?.coin ?? null, coinEnd: end?.coin ?? null, win })
        this.step('spin', { n, begin: !!begin, end: !!end, coinBegin: begin?.coin ?? null, coinEnd: end?.coin ?? null, win })
        this.progress('spin', `第 ${n} 局${win === null ? '（看不到 moneyNtc）' : win > 0 ? `派彩 ${win}` : '沒派彩'}`, n)
        this.emit('flush')
        if (this.msg.stopCondition === 'payout' && win !== null && win > 0) { stopReason = 'payout'; break }
        await sleep(600)
      }
      this.step(stopReason === 'payout' ? 'got-payout' : stopReason === 'spins' ? 'spins-reached' : 'max-spins-no-payout')
      await sleep(3000)
      this.progress('exit', '退出機台')
      this.step('exit-begin')
      const back = await h5BackToLobby(page, { log: () => {} }).catch((e: Error) => ({ ok: false, steps: [e.message] }))
      exitOk = !!back.ok
      this.step('exit-done', { ok: exitOk, steps: back.steps })
      const result = { ok: true, cancelled: false, error: null, startedAt, finishedAt: Date.now(), spins, stopReason, payoutObservable, exitOk }
      return result
    } catch (e) {
      const cancelled = this.stopped || (e instanceof Error && e.message === 'stopped')
      error = cancelled ? null : (e instanceof Error ? e.message : String(e))
      this.step(cancelled ? 'cancelled' : 'error', cancelled ? undefined : { error })
      // 收尾：人還在機台裡就退出放位子（取消時也要）
      if (page && h5InGame(page)) {
        const back = await h5BackToLobby(page, { log: () => {} }).catch(() => ({ ok: false, steps: [] as string[] }))
        exitOk = !!back.ok
        this.step('exit-done', { ok: exitOk, steps: back.steps })
      } else {
        exitOk = true   // 沒進到機台（或已經在大廳）＝沒有位子要放
      }
      return {
        ok: false, cancelled, error, startedAt, finishedAt: Date.now(), spins,
        stopReason: cancelled ? 'cancelled' : 'error',
        payoutObservable: spins.some(s => s.win !== null), exitOk,
      }
    } finally {
      try { stopWatch?.() } catch { /* ignore */ }
      await ctx?.close().catch(() => {})
      await this.browser?.close().catch(() => {})
      this.browser = null
    }
  }
}
