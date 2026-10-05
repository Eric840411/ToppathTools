/**
 * AutoSpin 定時彙總報告的 **Lark 原生卡片**（v5.8.0，使用者看過預覽卡片確認）。
 *
 * 原本 Lark 走 notify-outlet 的 embedToLarkCard()，把整段 description 塞成一個 markdown——Lark 上是一大坨字。
 * 這裡用同一份資料組 Lark 的 header／column_set／note，Discord embed（buildStatusReportEmbed）不動。
 *
 * 用詞沿用 CodeX 先前定的：「延遲推定」不是「延遲完成」、不出現 ok%、「查不了」不寫成「服務正常」。
 * 哪些區塊出現照使用者的欄位開關（fields）。純函式，測試：npx tsx server/autospin-report-lark-card.test.ts
 */
import type { MachineSlsStatus } from './live-ledger-sls-machine.js'

/** 每個 errcode 的「影響」結論。Agent 端由 summarize_err_snapshots() 算好送上來。 */
export interface ErrImpact {
  count: number
  /** 餘額有減少但這局沒轉成 —— 也就是「扣了錢沒東西」，這是唯一真正該升級的訊號 */
  deducted: number
  /** 當下讀不到餘額，判斷不了有沒有扣 */
  unknown: number
  /** 需要進一步對帳的筆數（扣款疑慮／狀態不明／長時間沒恢復）*/
  needsReconcile: number
  /** 從錯誤到下一次成功 spin 最久花了幾秒 —— 熱更新測試真正要回報的「多久恢復」*/
  maxRecoverSec: number | null
  /** 伺服器自己給的錯誤描述，回答「異常是什麼」*/
  lastDes: string
}

export interface StatusReportStats {
  spinCount: number; okSpinCount: number; winCount: number; totalWin: number; lastCoin: number | null
  errcodeCounts: Record<string, number>; errcodeTimes?: Record<string, number[]>
  recoverCount: number; kickoutCount: number
  crChecks: number; crNoResponse: number
  /** 舊版 Agent 不會送這個欄位，所以是選填——沒有就退回只顯示次數 */
  errImpact?: Record<string, ErrImpact>
  /** 局數分類（見 routes/autospin.ts buildStatusReportEmbed 的說明）。舊版 Agent 沒有 */
  outcomeCounts?: { completed?: number; completed_late?: number; suspected?: number; unknown?: number; not_started?: number }
}

export type StatusReportFieldKey = 'spins' | 'winRate' | 'errcodes' | 'recover' | 'kickouts' | 'crChecks' | 'uptime' | 'sls'

export interface StatusReportOpts {
  machineType: string
  gameTitleCode?: string | null
  periodMinutes: number
  cumulative: StatusReportStats
  period: StatusReportStats
  uptimeMinutes?: number | null
  fields: Record<StatusReportFieldKey, boolean>
  customNote: string
  isTest?: boolean
  aiAnalysis?: string | null
  /** 這台機台在本期間的 SLS 服務狀況。null＝沒查（功能關閉、或查詢失敗） */
  sls?: MachineSlsStatus | null
}

const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })
const n = (v?: number | null) => (v ?? 0).toLocaleString()
/** 外來文字（伺服器描述、自訂備註、AI 分析）裡的 < > 換成全形：Lark markdown 會把 <font>、<at> 當標籤，混進來會弄壞版面或亂 @ 人。
 *  * _ 等 markdown 符號不轉——AI 分析本來就會用粗體，轉掉反而變成一堆反斜線 */
const esc = (s: string) => s.replace(/</g, '＜').replace(/>/g, '＞')

const md = (content: string) => ({ tag: 'markdown', content })
const note = (text: string) => ({ tag: 'note', elements: [{ tag: 'plain_text', content: text }] })
const col = (content: string, weight = 1) => ({ tag: 'column', width: 'weighted', weight, vertical_align: 'top', elements: [md(content)] })
const cols = (columns: object[], bg: 'grey' | 'default' = 'grey') => ({ tag: 'column_set', flex_mode: 'stretch', background_style: bg, columns })
const kpi = (label: string, value: string, sub = '') => col(`<font color='grey'>${label}</font>\n**${value}**${sub ? `\n<font color='grey'>${sub}</font>` : ''}`)
const hr = { tag: 'hr' }

export function uptimeText(min?: number | null): string {
  if (min == null) return ''
  return `~${Math.floor(min / 60)}h${Math.round(min % 60)}m`
}

/** 疑似完成／延遲推定／不確定／未起局 縮成一行小字；沒有任何一項就回空字串 */
function outcomeNote(st: StatusReportStats): string {
  const oc = st.outcomeCounts
  if (!oc) return ''
  const parts: string[] = []
  if ((oc.suspected ?? 0) > 0) parts.push(`疑似完成 ${n(oc.suspected)}（無結算證據）`)
  if ((oc.completed_late ?? 0) > 0) parts.push(`延遲推定 ${n(oc.completed_late)}`)
  if ((oc.unknown ?? 0) > 0) parts.push(`不確定 ${n(oc.unknown)}`)
  if ((oc.not_started ?? 0) > 0) parts.push(`未起局 ${n(oc.not_started)}`)
  return parts.join('｜')
}

/** 完成局數：主數字只放「確定完成」，延遲推定另外標（合併就看不出結算訊號的品質） */
function completedKpi(st: StatusReportStats) {
  const oc = st.outcomeCounts
  if (!oc) return kpi('完成局數', '—', '舊版 Agent 沒有局數分類')
  const late = oc.completed_late ?? 0
  return kpi('完成局數', n(oc.completed), late > 0 ? `＋延遲推定 ${n(late)} ＝ ${n((oc.completed ?? 0) + late)}` : '')
}

export function buildStatusReportLarkCard(o: StatusReportOpts, mentionLine = ''): object {
  const { fields, period, cumulative } = o
  const sub = [o.gameTitleCode, `本期間 ${o.periodMinutes.toFixed(1)} 分鐘`, fields.uptime && o.uptimeMinutes != null ? `已跑 ${uptimeText(o.uptimeMinutes)}` : '']
    .filter(Boolean).join(' · ')
  const header: Record<string, unknown> = {
    template: o.isTest ? 'orange' : 'blue',
    title: { tag: 'plain_text', content: `📊 AutoSpin 定時彙總｜${o.machineType}` },
    subtitle: { tag: 'plain_text', content: sub },
  }
  if (o.isTest) header.text_tag_list = [{ tag: 'text_tag', text: { tag: 'plain_text', content: '試發送' }, color: 'orange' }]

  const el: object[] = []
  const top = [mentionLine.trim(), o.isTest ? "<font color='orange'>⚠️ 這是試發送測試訊息，以下為假資料，非真實 AutoSpin 執行結果</font>" : ''].filter(Boolean)
  if (top.length) el.push(md(top.join('\n')))

  // 🎰 局數與輸贏
  if (fields.spins || fields.winRate) {
    el.push(md('**🎰 局數與輸贏**'))
    el.push(cols([col('**本期間**'), col('**累計**')], 'default'))
    if (fields.spins) {
      el.push(cols([kpi('spin 嘗試', `${n(period.spinCount)} 次`), kpi('spin 嘗試', `${n(cumulative.spinCount)} 次`)]))
      el.push(cols([completedKpi(period), completedKpi(cumulative)]))
    }
    if (fields.winRate) {
      el.push(cols([
        kpi('wins／totalWin', `${n(period.winCount)}／${n(period.totalWin)}`),
        kpi('wins／totalWin', `${n(cumulative.winCount)}／${n(cumulative.totalWin)}`, cumulative.lastCoin != null ? `lastCoin ~${n(cumulative.lastCoin)}` : ''),
      ]))
    }
    if (fields.spins) {
      const p = outcomeNote(period), c = outcomeNote(cumulative)
      if (p || c) el.push(note([p && `本期間：${p}`, c && `累計：${c}`].filter(Boolean).join('　　')))
    }
  }

  // ⚠️ errcode：每個 code 一列；次數寫累計與本期間，影響（扣款疑慮／最長恢復）取累計
  if (fields.errcodes) {
    el.push(hr, md('**⚠️ errcode**'))
    const codes = [...new Set([...Object.keys(cumulative.errcodeCounts ?? {}), ...Object.keys(period.errcodeCounts ?? {})])]
      .filter(c => (cumulative.errcodeCounts?.[c] ?? 0) > 0 || (period.errcodeCounts?.[c] ?? 0) > 0)
      .sort((a, b) => (cumulative.errcodeCounts?.[b] ?? 0) - (cumulative.errcodeCounts?.[a] ?? 0))
    if (!codes.length) el.push(md("<font color='green'>無</font>"))
    const times: string[] = []
    for (const code of codes) {
      const cum = cumulative.errcodeCounts?.[code] ?? 0, per = period.errcodeCounts?.[code] ?? 0
      const im = cumulative.errImpact?.[code] ?? period.errImpact?.[code]
      const desc = im?.lastDes ? `\n<font color='grey'>${esc(im.lastDes)}</font>` : ''
      const columns = [col(`\`err${code}\` × ${n(cum)}　<font color='grey'>本期間 ${n(per)}</font>${desc}`, 2)]
      if (im) {
        columns.push(col(`扣款疑慮\n**<font color='${im.deducted > 0 ? 'red' : 'green'}'>${n(im.deducted)}</font>**`))
        columns.push(col(`最長恢復\n**${im.maxRecoverSec != null ? `${im.maxRecoverSec}s` : '—'}**`))
        const extra = [im.unknown > 0 ? `餘額不明 ${n(im.unknown)}` : '', im.needsReconcile > 0 ? `待查帳 ${n(im.needsReconcile)}` : ''].filter(Boolean)
        if (extra.length) columns.push(col(`<font color='orange'>${extra.join('\n')}</font>`))
      }
      el.push(cols(columns))
      const ts = cumulative.errcodeTimes?.[code]
      if (ts?.length) times.push(`err${code} 最近 ${ts.map(fmtTime).join('、')}`)
    }
    if (times.length) el.push(note(times.join('　')))
  }

  // 🛡️ 穩定性：本期間為主數字，累計放小字
  const stab: object[] = []
  if (fields.recover) stab.push(kpi('RECOVER', n(period.recoverCount), `累計 ${n(cumulative.recoverCount)}`))
  if (fields.kickouts) stab.push(kpi('kickouts', period.kickoutCount > 0 ? `<font color='orange'>${n(period.kickoutCount)}</font>` : n(period.kickoutCount), `累計 ${n(cumulative.kickoutCount)}`))
  if (fields.crChecks) stab.push(kpi('CR checks', n(period.crChecks), `無回應 ${n(period.crNoResponse)}・累計 ${n(cumulative.crChecks)}／${n(cumulative.crNoResponse)}`))
  if (stab.length) el.push(hr, md('**🛡️ 穩定性（本期間）**'), cols(stab))

  // 🌐 SLS：查不到對應是「查不了」，不能寫成正常
  if (fields.sls && o.sls) {
    const s = o.sls
    const gid = s.groupIds.length ? `　<font color='grey'>groupId ${s.groupIds.join('、')}</font>` : ''
    if (s.unmapped) el.push(hr, md(`**🌐 SLS 服務**${gid}`), note(`⚠️ ${s.note}`))
    else if (!s.events.length) el.push(hr, md(`**🌐 SLS 服務**　<font color='green'>● 服務正常</font>${gid}`))
    else {
      el.push(hr, md(`**🌐 SLS 服務**　<font color='red'>● 有異常</font>${gid}`))
      for (const ev of s.events) {
        const store = ev.logstore.replace(/^test-liveslots-luckylink(mml|g2s)-/, '').replace(/-logs$/, '')
        el.push(cols([col(`${esc(ev.label)} × ${n(ev.count)}\n<font color='grey'>${esc(store)}</font>`, 3), col(ev.times.length ? `<font color='grey'>最近</font>\n${ev.times.map(fmtTime).join('、')}` : '', 2)]))
      }
    }
  }

  if (o.customNote.trim()) el.push(hr, md(`**📝 備註**\n${esc(o.customNote.trim())}`))
  if (o.aiAnalysis?.trim()) el.push(hr, md(`**🤖 AI 分析**\n${esc(o.aiAnalysis.trim())}`))
  el.push(note(`Toppath Tools・${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })}`))

  return { config: { wide_screen_mode: true, update_multi: true }, header, elements: el }
}
