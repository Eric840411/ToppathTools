/**
 * shared/autospin-log-rules.ts
 *
 * AutoSpin 執行日誌的分類與篩選規則。**前後端共用同一份。**
 *
 * ⚠️ 為什麼一定要共用：使用者要求「導出時要照畫面上篩選的內容導」。
 *    篩選條件（類別／pinus 子類／搜尋字）原本只存在前端，而完整紀錄在 server 的檔案裡
 *    ——server 要做同樣的篩選，就得跑同一套分類規則。
 *    兩邊各寫一份必然漂掉，而漂掉的症狀是「畫面上看到 12 筆錯誤、導出來卻是 15 筆」，
 *    沒有人會發現是規則不同步造成的。
 *
 * ⚠️ `shared/` 只放純函式、型別、常數，不碰 fs／DB／env／Express／React
 *    （CLAUDE.md 定的界線）——放 server/lib 就沒有這道界線，
 *    哪天不小心 import 到 server-only 的東西，前端 build 會直接炸。
 */

export type LogCategory = 'sys' | 'spin' | 'shot' | 'warn' | 'err' | 'pinus' | 'other'
export type PinusCategory = 'connect' | 'enter' | 'spin' | 'money' | 'broadcast' | 'heartbeat' | 'other'

/** 畫面保留的行數上限。完整紀錄靠 server 落檔，不是靠前端硬撐。 */
export const MAX_VISIBLE_LOGS = 10000

export function classifyLogLine(l: string): LogCategory {
  if (l.includes('[pinus:')) return 'pinus'
  if (l.includes('[console:error]')) return 'err'
  if (l.includes('[console:warn]')) return 'warn'
  if (l.includes('ERROR') || l.includes('[stderr]') || l.includes('錯誤') || l.includes('失敗') || l.includes('逾時')) return 'err'
  if (l.includes('WARNING') || l.includes('警') || l.includes('警告')) return 'warn'
  if (l.includes('[截圖]') || l.includes('截圖已上傳')) return 'shot'
  if (/Spin #\d+/.test(l) || l.includes('Spin 耗時')) return 'spin'
  if (l.includes('[系統]') || l.includes('[Agent]')) return 'sys'
  return 'other'
}

export function classifyPinusRoute(l: string): PinusCategory {
  if (l.includes('dealGMActionReq')) return 'spin'
  if (l.includes('moneyNtc')) return 'money'
  if (l.includes('broadcastReq')) return 'broadcast'
  if (l.includes('enterGMNtc') || l.includes('leaveGMNtc')) return 'enter'
  if (l.includes('gateHandler.loginReq') || l.includes('entryHandler.enterReq') || l.includes('[push] close')) return 'connect'
  if (l.includes('heartReq') || l.includes('getGMLockListReq') || l.includes('getAllGMListReq')) return 'heartbeat'
  return 'other'
}


/**
 * 「只看重點」要留下來的行。
 *
 * 使用者的實際困擾不是「捲太快」，是**訊號被稀釋**——絕大多數行都是例行的
 * （Spin #N、pinus 心跳、broadcast），真正要看的很少但被沖掉。
 *
 * 這裡刻意**不發明新的分類**，只是把既有的東西組合起來：
 * 警告／錯誤，加上「狀態真的改變了」的那幾種事件。
 */
const KEY_EVENT_PATTERNS = [
  '被伺服器拒絕', '扣款但未轉成', '需要查帳',
  '低於閾值', '退出重進',          // kickout
  '特殊狀態', 'bonusAction',        // FG/JP
  '重新連線', '斷線', 'RECOVER',
  '已啟動', '已停止', '已暫停', '繼續',
  '延遲推定完成',                    // 補判（v4.88.0）
]

export function isKeyEvent(line: string): boolean {
  const cat = classifyLogLine(line)
  if (cat === 'warn' || cat === 'err') return true
  return KEY_EVENT_PATTERNS.some(p => line.includes(p))
}

/** 畫面上那組篩選條件。全部留空＝不篩，導出就是完整檔案。 */
export type LogFilter = {
  /** 'all' | 'sys' | 'spin' | 'shot' | 'error'（error 同時涵蓋 warn 與 err，跟畫面一致） */
  cat?: string
  /** 要顯示的 pinus 子類。`undefined` = 全部顯示 */
  pinusCats?: PinusCategory[]
  /** 關鍵字，不分大小寫 */
  search?: string
}

/**
 * 一行日誌通不通過篩選。
 *
 * ⚠️ 判斷順序與語意要跟畫面上那段**完全一致**，否則就會出現
 *    「畫面 12 筆、導出 15 筆」這種沒人查得出來的落差。
 *    特別是 `error` 這一項在畫面上是「warn 或 err 都算」，不是只有 err。
 */
/**
 * 已經知道分類時用這支，不要再分類一次。
 *
 * ⚠️ 前端把分類算在「收到當下」（避免每次 render 重算造成 O(N²)），
 *    所以它不能呼叫會重新分類的版本。但**判斷邏輯必須是同一份**——
 *    我第一版就是只把「只看重點」加進共用檔、畫面卻還在用元件內自己那套 filter，
 *    結果按鈕按下去完全沒反應。兩份實作漂掉的第一個症狀就是這個。
 */
export function matchesLogFilterPre(
  line: string, cat: LogCategory, pinusCat: PinusCategory | null, filter: LogFilter,
): boolean {
  if (pinusCat && filter.pinusCats && !filter.pinusCats.includes(pinusCat)) return false
  if (filter.cat === 'sys' && cat !== 'sys') return false
  if (filter.cat === 'spin' && cat !== 'spin') return false
  if (filter.cat === 'shot' && cat !== 'shot') return false
  if (filter.cat === 'error' && cat !== 'warn' && cat !== 'err') return false
  if (filter.cat === 'key' && !isKeyEvent(line)) return false
  if (filter.search && !line.toLowerCase().includes(filter.search.toLowerCase())) return false
  return true
}

export function matchesLogFilter(line: string, filter: LogFilter): boolean {
  const cat = classifyLogLine(line)
  return matchesLogFilterPre(line, cat, cat === 'pinus' ? classifyPinusRoute(line) : null, filter)
}


/** 這組條件等不等於「沒有篩選」。用來決定導出的檔名與提示文字。 */
export function isEmptyFilter(filter: LogFilter): boolean {
  return (!filter.cat || filter.cat === 'all')
    && !filter.search
    && (!filter.pinusCats || filter.pinusCats.length === 7)
}
