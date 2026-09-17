/**
 * server/live-ledger-sls-machine.ts — 把 SLS 服務健康**綁到單一機台**。
 *
 * 🚨 使用者要的是「操作 A 獎池就只監控 A 的 log，其餘不管」。
 *    整個 logstore 層級的判定（`live-ledger-sls.ts`）回答不了這件事——
 *    一個 logstore 底下可能有好幾台機器，而定時彙總報告是**一台一張卡**。
 *
 * ── 機台怎麼對應到 logstore：用 groupId，不要用名稱 ────────────────────
 *
 * ⚠️ **名稱比對會配錯，而且錯得看不出來。**實測（2026-09-17）23 種機台遊戲代號
 *    只有 12 種配得上 logstore 名稱，而且錯的方式很陰：
 *      · `873-DFDC-*`（8 台）被前綴配到 `dfdcgrand-*` 的 7 個 logstore——不同遊戲
 *      · `897-BIGFULINK-2065` 對應的其實是 `bigfucash`——名稱完全不像
 *      · `tcjl` ↔ `tiancijinlu`、`mightycashlink` ↔ `mightycash` 同樣配不上
 *    配錯的後果是畫面說「這台機器的服務正常」，而你看的是別台的 log。
 *
 * ✅ `groupId` 兩種協議都有，實測確認：
 *      MML  `已连接上的客户端信息: 总数:1 ... groupId: 132`
 *      G2S  `[HTTP UpdateJP] 收到服务器彩金更新: groupId=138`
 *    而它就是 `recon_pool_change.groupid`，對得回 machineName：
 *      132 → 666-DFDCGRAND-0148 ·  138 → 897-BIGFULINK-2065 ·  144 → 873-LIONLINK-1337
 */
import { db } from './shared.js'
import { SLS_PROJECTS, slsGet, listLogstores } from './lib/sls.js'
import type { ReconEnv } from './live-ledger.js'

/** 兩種協議的 groupId 寫法都吃：`groupId: 132`（MML）與 `groupId=138`（G2S）。 */
const GROUP_ID_RE = /group[_ ]?id\s*[:=]\s*(\d+)/i
/** MML 的 JP 廣播行：`build cmd 4101 <machineid>`。 */
const BROADCAST_RE = /build cmd 4101\s+(\d+)/

const INDEX_SAMPLE_LINES = 200
/** 建索引時往回看多久。太短會漏掉低流量的 logstore。 */
const INDEX_WINDOW_SEC = 30 * 60

export interface SlsLogLine { ts: number; text: string }

function kindOfProject(project: string): 'mml' | 'g2s' | 'other' {
  if (project.includes('luckylinkmml')) return 'mml'
  if (project.includes('luckylinkg2s')) return 'g2s'
  return 'other'
}

/**
 * 撈一段 log。⚠️ 一定要帶回 `__time__`——報告要顯示「什麼時候報錯」，
 * 只回文字的話時間點就只能從內文硬解，而各服務的內文格式不一樣。
 */
export async function sampleLog(
  project: string, logstore: string, fromSec: number, toSec: number, lines: number,
): Promise<SlsLogLine[]> {
  const data = await slsGet(project, `/logstores/${logstore}`, {
    // ⚠️ 一定要 `*`。這些 project 的 content 沒有全文索引，關鍵字查一律回 0 筆。
    type: 'log', query: '*',
    from: String(fromSec), to: String(toSec), line: String(lines), offset: '0',
  }) as { logs?: Record<string, string>[] } | Record<string, string>[]
  const arr = Array.isArray(data) ? data : (data?.logs ?? [])
  return arr.map(l => ({
    ts: Number(l['__time__'] ?? l['_time_'] ?? 0) * 1000,
    text: String(l.content ?? l.message ?? ''),
  }))
}

/**
 * 掃一輪、把每個 logstore 出現過的 groupId 記下來。
 *
 * ⚠️ 這是**觀測到的**對應，不是設定的。某個 logstore 最近沒流量就不會有紀錄——
 *    所以查不到對應時要明講「查不到」，不可以當成「這台沒問題」（見 `machineSlsStatus`）。
 */
export async function refreshLogstoreIndex(opts: { nowSec?: number; projects?: string[] } = {}): Promise<{
  scanned: number; groups: number; failed: number
}> {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000)
  const projects = opts.projects ?? SLS_PROJECTS.filter(p => p.includes('-test-logs'))
  const now = Date.now()
  const up = db.prepare(`
    INSERT INTO recon_sls_logstore_group (project, logstore, groupId, kind, firstSeen, lastSeen)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(project, logstore, groupId) DO UPDATE SET lastSeen=excluded.lastSeen
  `)
  let scanned = 0, groups = 0, failed = 0

  for (const project of projects) {
    const kind = kindOfProject(project)
    let stores: string[] = []
    try { stores = await listLogstores(project) } catch { failed++; continue }
    for (const logstore of stores) {
      try {
        const rows = await sampleLog(project, logstore, nowSec - INDEX_WINDOW_SEC, nowSec, INDEX_SAMPLE_LINES)
        scanned++
        const seen = new Set<string>()
        for (const r of rows) {
          const m = GROUP_ID_RE.exec(r.text)
          if (m) seen.add(m[1])
        }
        for (const g of seen) { up.run(project, logstore, g, kind, now, now); groups++ }
      } catch { failed++ }
    }
  }
  return { scanned, groups, failed }
}

/** 這台機台屬於哪些 groupId（同一台可能掛多個 Level，但 groupId 通常只有一個）。 */
export function groupIdsForMachine(env: ReconEnv, machineName: string): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT groupid FROM recon_pool_change WHERE env=? AND machineName=? AND groupid != ''
    UNION
    SELECT DISTINCT groupid FROM recon_machine_map WHERE env=? AND machineName=? AND groupid != ''
  `).all(env, machineName, env, machineName) as { groupid: string }[]
  return rows.map(r => String(r.groupid)).filter(Boolean)
}

export interface LogstoreRef { project: string; logstore: string; groupId: string; kind: string }

/** 這些 groupId 對應到哪些 logstore。 */
export function logstoresForGroups(groupIds: string[]): LogstoreRef[] {
  if (!groupIds.length) return []
  const qs = groupIds.map(() => '?').join(',')
  return db.prepare(`
    SELECT project, logstore, groupId, kind FROM recon_sls_logstore_group
    WHERE groupId IN (${qs}) ORDER BY logstore
  `).all(...groupIds) as LogstoreRef[]
}

export type SlsEventKind =
  | 'offline' | 'protocol_error' | 'broadcast_stopped' | 'heartbeat_stopped' | 'no_output'

export interface SlsEvent {
  kind: SlsEventKind
  /** 人看得懂的說明，會直接進 Discord 卡片 */
  label: string
  /** 發生時間（epoch ms）。整段沒有單一時間點的（例如「整段都沒廣播」）給區間結束時間 */
  times: number[]
  count: number
  logstore: string
}

const EVENT_LABEL: Record<SlsEventKind, string> = {
  offline: 'G2S 斷線（offLine）',
  protocol_error: 'G2S 協議錯（errorCode 非 G2S_none）',
  broadcast_stopped: 'JP 廣播中斷（有客戶端登入卻沒下發獎池）',
  heartbeat_stopped: 'MML 心跳消失',
  no_output: 'log 完全沒有輸出',
}

/**
 * 把一段 log 判成事件。⚠️ 純函式，測試不用連網路——
 * 「會不會誤報」不能靠在線上等它出事來驗證。
 */
export function detectEvents(kind: string, logstore: string, rows: SlsLogLine[], windowEndMs: number): SlsEvent[] {
  const out: SlsEvent[] = []
  const push = (k: SlsEventKind, times: number[]) => {
    if (!times.length) return
    out.push({ kind: k, label: EVENT_LABEL[k], times: times.slice(-5), count: times.length, logstore })
  }

  if (!rows.length) {
    // ⚠️ 「這段時間沒有輸出」本身就是事件，但它也可能只是沒人在打這台。
    //    這裡照實回報，要不要當異常由上層決定（`machineSlsStatus` 會看有沒有 spin）。
    push('no_output', [windowEndMs])
    return out
  }

  if (kind === 'g2s') {
    push('offline', rows.filter(r => r.text.includes('offLine')).map(r => r.ts))
    push('protocol_error', rows.filter(r => /"errorCode"\s*:\s*"(?!G2S_none")/.test(r.text)).map(r => r.ts))
    return out
  }

  if (kind === 'mml') {
    const hb = rows.filter(r => r.text.includes('已连接上的客户端信息'))
    const bc = rows.filter(r => BROADCAST_RE.test(r.text))
    // 心跳每 30 秒一次；整段一次都沒有 = 連線層停了（程序可能還活著，所以不會有錯誤訊息）
    if (!hb.length) push('heartbeat_stopped', [windowEndMs])
    // ⚠️ 要先看 `登录完成`：沒有客戶端時 0 次廣播是正常的，
    //    不看的話所有閒置機台都會被報成異常。
    const loggedIn = Math.max(0, ...hb.map(r => Number((/登录完成:(\d+)/.exec(r.text) ?? [])[1] ?? 0)))
    if (loggedIn > 0 && !bc.length) push('broadcast_stopped', [windowEndMs])
    return out
  }
  return out
}

export interface MachineSlsStatus {
  machineName: string
  groupIds: string[]
  logstores: LogstoreRef[]
  events: SlsEvent[]
  /** 查不到對應的 logstore。⚠️ 這是「查不了」不是「沒問題」 */
  unmapped: boolean
  note: string
}

/**
 * 單一機台在某段時間內的 SLS 服務狀況。
 *
 * ⚠️ **查不到對應的 logstore 時回 `unmapped: true`，不可以回「沒有異常」。**
 *    索引是觀測來的，這台最近沒流量就不會有紀錄——那時候我們是「不知道」，
 *    而不是「沒事」。這兩者在報告上必須分得出來。
 */
export async function machineSlsStatus(
  env: ReconEnv, machineName: string, fromMs: number, toMs: number,
): Promise<MachineSlsStatus> {
  const groupIds = groupIdsForMachine(env, machineName)
  const logstores = logstoresForGroups(groupIds)
  const base: MachineSlsStatus = { machineName, groupIds, logstores, events: [], unmapped: false, note: '' }

  if (!groupIds.length) {
    return { ...base, unmapped: true, note: '查不到這台機台的 groupId（沒有池變動紀錄），無法定位它的服務 log' }
  }
  if (!logstores.length) {
    return { ...base, unmapped: true,
      note: `groupId ${groupIds.join('、')} 在 logstore 索引裡找不到對應——索引是觀測來的，`
        + '這個群組最近沒流量就不會有紀錄。**這是查不了，不是沒問題**' }
  }

  const events: SlsEvent[] = []
  for (const ref of logstores) {
    try {
      const rows = await sampleLog(ref.project, ref.logstore,
        Math.floor(fromMs / 1000), Math.floor(toMs / 1000), INDEX_SAMPLE_LINES)
      // ⚠️ 只留這個 groupId 的行。同一個 logstore 可能有別的群組，
      //    混進來的話報告會把別台的問題算到這台頭上。
      const mine = rows.filter(r => {
        const m = GROUP_ID_RE.exec(r.text)
        return !m || m[1] === ref.groupId
      })
      events.push(...detectEvents(ref.kind, ref.logstore, mine, toMs))
    } catch (e) {
      events.push({
        kind: 'no_output', label: `查詢失敗：${String(e).slice(0, 80)}`,
        times: [toMs], count: 1, logstore: ref.logstore,
      })
    }
  }
  return { ...base, events, note: events.length ? '' : '這段期間服務正常' }
}

// ─── 給畫面用的快取版 ────────────────────────────────────────────────────
//
// 🚨 **對帳台每 5 秒輪詢一次 `/pools`。**沒有快取的話，使用者開著畫面就等於
//    每 5 秒對每台在跑的機台各打一次 SLS ——一天下來是幾十萬次查詢。
//
// ⚠️ 快取只存「查詢結果」，不存「沒查到」的原因判定——`unmapped` 也要照樣快取，
//    否則查不到對應的那幾台會每 5 秒重打一次，剛好是最沒必要重打的情況。

const SLS_UI_TTL_MS = Number(process.env.SLS_UI_TTL_MS || 60_000)
const uiCache = new Map<string, { at: number; value: MachineSlsStatus }>()

export async function machineSlsStatusCached(
  env: ReconEnv, machineName: string, windowMs: number, now = Date.now(),
): Promise<MachineSlsStatus> {
  const key = `${env}|${machineName}|${windowMs}`
  const hit = uiCache.get(key)
  if (hit && now - hit.at < SLS_UI_TTL_MS) return hit.value
  const value = await machineSlsStatus(env, machineName, now - windowMs, now)
  uiCache.set(key, { at: now, value })
  // 只留最近 50 台，避免長時間執行後無限成長
  if (uiCache.size > 50) {
    const oldest = [...uiCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) uiCache.delete(oldest[0])
  }
  return value
}

/**
 * 一次查多台（對帳台上「使用者正在跑的機台」通常 1~5 台）。
 *
 * ⚠️ 任何一台查失敗都不能讓整個 `/pools` 掛掉——對帳台的主要內容是對帳，
 *    SLS 只是附加資訊。失敗的那台回 `unmapped` 並寫明原因。
 */
export async function machinesSlsStatus(
  env: ReconEnv, machineNames: string[], windowMs: number,
): Promise<MachineSlsStatus[]> {
  const out: MachineSlsStatus[] = []
  for (const name of machineNames) {
    try {
      out.push(await machineSlsStatusCached(env, name, windowMs))
    } catch (e) {
      out.push({
        machineName: name, groupIds: [], logstores: [], events: [], unmapped: true,
        note: `查詢失敗：${String(e).slice(0, 100)}——這是查不了，不是沒問題`,
      })
    }
  }
  return out
}
