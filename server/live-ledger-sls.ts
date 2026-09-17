/**
 * server/live-ledger-sls.ts — L6：G2S／MML **服務健康偵測**（不是對帳）。
 *
 * 🚨 **SLS 的定位在 2026-09-17 被重新定義。**
 *    舊的「三路對帳」拿 SLS 當對帳來源，那條路走不通——`historyListReq` 沒有 order id，
 *    只能靠時間窗猜配對，實測 71% unmatched 而且 **mismatch 自始至終是 0**。
 *    使用者定案：「SLS保留，但是是偵測G2S MML服務有沒有異常」。
 *
 *    SLS 不適合當對帳來源，但**非常適合偵測服務死沒死**。
 *
 * ── 核心原則 ────────────────────────────────────────────────────────────
 *
 * 🚨 **偵測「該出現的東西消失」，不要等 ERROR 出現。**
 *    服務掛掉／pod 被殺通常**不會印錯誤**，就是安靜地停。等 ERROR 等不到。
 *
 * 訊號（都是實測確認過的）：
 *   MML  · `已连接上的客户端信息: 总数:N 握手完成:N 登录完成:N` — 每 30 秒，
 *          三段分階段，斷在連線／握手／登入哪一層看得出來
 *        · `build cmd 4101 <machine_id> {...}` JP 廣播 — QAT 2.0s／UAT 1.1s
 *   G2S  · `[State: onLine]`（出現 `offLine` 即斷線）
 *        · `errorCode` 正常值是 `"G2S_none"`
 *        · `[HTTP UpdateJP] 收到服务器彩金更新` — 每 10 秒
 *
 * ── 兩個實測踩過的坑 ────────────────────────────────────────────────────
 *
 * ⚠️ **這些 project 的 `content` 沒有全文索引。**`*` 撈得到資料，但關鍵字查
 *    （`"award"`／`"hit"`）一律回 0 筆 → **只能按時間整段撈回本地過濾**。
 *    `fetchSlsErrors()` 那支用的是關鍵字查詢，在這幾個 project 上撈不到東西。
 *
 * ⚠️ **「0 筆」有兩種意思，混在一起這條線就廢了**：服務停了是 0 筆，
 *    沒人在測那個遊戲也是 0 筆。所以一定要比對**兩個時間窗**——
 *    近窗 0 筆但長窗有資料 ＝ 安靜了（要告警）；兩個窗都 0 ＝ 本來就沒在跑（不告警）。
 *    只看近窗的話，30 個 logstore 裡大部分平常就沒流量，會天天噴假警報。
 */
import { SLS_PROJECTS, slsGet, listLogstores } from './lib/sls.js'

/** 近窗：服務是不是還活著。 */
const LIVE_WINDOW_SEC = 10 * 60
/** 長窗：這個 logstore「平常」有沒有流量，用來分辨「停了」與「本來就沒在跑」。 */
const BASELINE_WINDOW_SEC = 24 * 3600
/** 每個 logstore 抓幾行就夠判斷。⚠️ 只是判活，不是要撈全部。 */
const SAMPLE_LINES = 200
/** 長窗抓幾行（只用來判斷「平常有沒有流量」，不做內容分析）。 */
const BASELINE_LINES = 50
/**
 * 長窗要有幾行才算「平常有在跑」。
 *
 * ⚠️ **1 行不算。**有些 logstore 只有偶發的 PM2 訊息、沒有業務流量
 *    （實測 `wlzbhelix-fivedragongold` 近 72 小時只有 10 筆 PM2 訊息）。
 *    門檻設 1 的話，這些 logstore 會每天被報成「服務安靜了」——
 *    30 個 logstore 裡大部分都是這種，天天假警報的下場就是沒人看告警。
 */
const BASELINE_MIN_LINES = 20

export type SlsVerdict = 'ok' | 'went_silent' | 'degraded' | 'idle' | 'unreachable'

export interface SlsServiceRow {
  project: string
  logstore: string
  kind: 'mml' | 'g2s' | 'other'
  liveLines: number
  baselineLines: number
  /** MML：心跳與 JP 廣播；G2S：onLine／offLine／UpdateJP */
  signals: Record<string, number>
  verdict: SlsVerdict
  note: string
}

function kindOf(project: string): 'mml' | 'g2s' | 'other' {
  if (project.includes('luckylinkmml')) return 'mml'
  if (project.includes('luckylinkg2s')) return 'g2s'
  return 'other'
}

interface RawLog { content?: string; message?: string; [k: string]: unknown }

async function sampleLines(project: string, logstore: string, fromSec: number, toSec: number, lines: number): Promise<string[]> {
  const data = await slsGet(project, `/logstores/${logstore}`, {
    // ⚠️ 一定要 `*`。關鍵字查在這些 project 上一律回 0 筆（沒有全文索引）。
    type: 'log', query: '*',
    from: String(fromSec), to: String(toSec),
    line: String(lines), offset: '0',
  }) as { logs?: RawLog[] } | RawLog[]
  const arr: RawLog[] = Array.isArray(data) ? data : (data?.logs ?? [])
  return arr.map(l => String(l.content ?? l.message ?? JSON.stringify(l)))
}

/** 從一批日誌行數出訊號。⚠️ 純函式，測試不用連網路。 */
export function countSignals(kind: 'mml' | 'g2s' | 'other', texts: string[]): Record<string, number> {
  if (kind === 'mml') {
    return {
      heartbeat: texts.filter(t => t.includes('已连接上的客户端信息')).length,
      jpBroadcast: texts.filter(t => t.includes('build cmd 4101')).length,
    }
  }
  if (kind === 'g2s') {
    return {
      onLine: texts.filter(t => t.includes('[State: onLine]')).length,
      offLine: texts.filter(t => t.includes('offLine')).length,
      updateJp: texts.filter(t => t.includes('收到服务器彩金更新')).length,
      // ⚠️ 正常值是 "G2S_none"；任何其他值都是協議錯
      protocolError: texts.filter(t => /"errorCode"\s*:\s*"(?!G2S_none")/.test(t)).length,
    }
  }
  return {}
}

/**
 * 依訊號與兩個窗的行數下判定。⚠️ 純函式——判定邏輯要能離線測，
 * 不然「會不會誤報」這件事只能靠在線上等它出事來驗證。
 */
export function judge(
  kind: 'mml' | 'g2s' | 'other', liveLines: number, baselineLines: number, signals: Record<string, number>,
): { verdict: SlsVerdict; note: string } {
  // 🚨 最重要的一條：近窗沒聲音、長窗有資料 = 安靜了
  if (liveLines === 0) {
    if (baselineLines >= BASELINE_MIN_LINES) {
      return {
        verdict: 'went_silent',
        note: `近 ${LIVE_WINDOW_SEC / 60} 分鐘一行都沒有，但過去 24 小時有 ${baselineLines}+ 行`
          + '——**服務安靜了**。服務掛掉／pod 被殺通常不會印錯誤，就是停止輸出',
      }
    }
    if (baselineLines > 0) {
      // ⚠️ 長窗只有零星幾行 = 只有 PM2 之類的雜訊，沒有業務流量。
      //    把它當成「安靜了」就是天天假警報（30 個 logstore 大多是這種）。
      return {
        verdict: 'idle',
        note: `過去 24 小時只有 ${baselineLines} 行（門檻 ${BASELINE_MIN_LINES}）`
          + '——只有零星訊息、沒有業務流量，判定為本來就沒在跑',
      }
    }
    // ⚠️ 兩個窗都沒有 ＝ 這個遊戲本來就沒在跑，不是異常。報了就是天天假警報
    return { verdict: 'idle', note: '近 10 分鐘與過去 24 小時都沒有紀錄——這個遊戲本來就沒在跑，不是異常' }
  }

  if (kind === 'g2s') {
    const bad: string[] = []
    if (signals.offLine > 0) bad.push(`斷線 ${signals.offLine} 次（出現 offLine）`)
    if (signals.protocolError > 0) bad.push(`協議錯 ${signals.protocolError} 筆（errorCode 不是 G2S_none）`)
    if (bad.length) return { verdict: 'degraded', note: bad.join('；') }
    if (signals.onLine === 0 && signals.updateJp === 0) {
      return {
        verdict: 'went_silent',
        note: `有 ${liveLines} 行輸出，但**完全沒有 onLine 狀態也沒有彩金更新**`
          + '——有東西在寫日誌，但該有的協議訊號不見了',
      }
    }
    return { verdict: 'ok', note: `onLine ${signals.onLine} · 彩金更新 ${signals.updateJp}` }
  }

  if (kind === 'mml') {
    // ⚠️ 心跳每 30 秒一次，10 分鐘的窗**至少**該有幾次。一次都沒有就是停了，
    //    即使其他行還在寫——那代表連線層死了但程序還活著。
    if (signals.heartbeat === 0 && signals.jpBroadcast === 0) {
      return {
        verdict: 'went_silent',
        note: `有 ${liveLines} 行輸出，但**心跳與 JP 廣播都是 0**`
          + '——連線層可能已經死了，程序還活著所以不會有錯誤訊息',
      }
    }
    return { verdict: 'ok', note: `心跳 ${signals.heartbeat} · JP 廣播 ${signals.jpBroadcast}` }
  }

  return { verdict: 'ok', note: `${liveLines} 行` }
}

/**
 * 掃一輪 G2S／MML 服務健康。
 *
 * ⚠️ **抓不到資料要回 `unreachable`，不可以當成 `idle`。**憑證過期、權限不足、
 *    網路不通，全部長得跟「這個遊戲沒在跑」一樣——那正是這整份規格在防的假結論。
 */
export async function slsServiceHealth(opts: {
  projects?: string[]; nowSec?: number; maxLogstores?: number
} = {}): Promise<SlsServiceRow[]> {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000)
  // 預設只掃 test 環境那兩個 project（cms 那兩個是另一回事）
  const projects = opts.projects
    ?? SLS_PROJECTS.filter(p => p.includes('-test-logs'))
  const out: SlsServiceRow[] = []

  for (const project of projects) {
    const kind = kindOf(project)
    let stores: string[] = []
    try {
      stores = await listLogstores(project)
    } catch (e) {
      out.push({
        project, logstore: '(全部)', kind, liveLines: 0, baselineLines: 0, signals: {},
        verdict: 'unreachable',
        note: `列不出 logstore：${String(e).slice(0, 120)}——這不是「沒有異常」，是查不到`,
      })
      continue
    }
    const targets = opts.maxLogstores ? stores.slice(0, opts.maxLogstores) : stores

    for (const logstore of targets) {
      try {
        const live = await sampleLines(project, logstore, nowSec - LIVE_WINDOW_SEC, nowSec, SAMPLE_LINES)
        // ⚠️ 只有近窗是 0 才需要問「平常有沒有流量」——有資料時不必多打一次 API
        const baseline = live.length === 0
          ? await sampleLines(project, logstore, nowSec - BASELINE_WINDOW_SEC, nowSec, BASELINE_LINES)
          : []
        const signals = countSignals(kind, live)
        const { verdict, note } = judge(kind, live.length, baseline.length, signals)
        out.push({ project, logstore, kind, liveLines: live.length, baselineLines: baseline.length, signals, verdict, note })
      } catch (e) {
        out.push({
          project, logstore, kind, liveLines: 0, baselineLines: 0, signals: {},
          verdict: 'unreachable',
          note: `查詢失敗：${String(e).slice(0, 120)}——這不是「沒有異常」，是查不到`,
        })
      }
    }
  }

  // 要看的排前面：斷線／協議錯 → 安靜了 → 查不到 → 沒在跑 → 正常
  const rank: Record<SlsVerdict, number> = { degraded: 0, went_silent: 1, unreachable: 2, idle: 3, ok: 4 }
  return out.sort((a, b) => rank[a.verdict] - rank[b.verdict] || a.logstore.localeCompare(b.logstore))
}

export function slsSummary(rows: SlsServiceRow[]): {
  total: number; ok: number; degraded: number; wentSilent: number; idle: number; unreachable: number
} {
  return {
    total: rows.length,
    ok: rows.filter(r => r.verdict === 'ok').length,
    degraded: rows.filter(r => r.verdict === 'degraded').length,
    wentSilent: rows.filter(r => r.verdict === 'went_silent').length,
    idle: rows.filter(r => r.verdict === 'idle').length,
    unreachable: rows.filter(r => r.verdict === 'unreachable').length,
  }
}
