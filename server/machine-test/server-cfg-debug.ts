/**
 * 正式站把 serverCfg.js 的 debug 打開，讓前端印出 console 的 SEND／ON（1008，osm-qa-agent-03 實測、使用者提供做法）。
 *
 * 🚨 **為什麼需要**：正式站（client-h5.osmplay.com）的 `window._ServerCfg = { debug: false }`，
 *    前端**完全不印** `SEND: <seq> hall.hallHandler.dealGMActionReq …`／`ON: …`。
 *    runner 判 iDeck、最小注確認、觸屏送出都是讀這些 console 行——正式站上一律變成「前端沒送」
 *    （實測觸屏 0/11、iDeck 0/2），看起來像機台壞掉，其實是**我們看不到**。
 *    攔下 serverCfg.js 把 debug 改成 true（等同使用者在 Chrome 用「區域覆寫」），大廳 SEND／ON 0 → 42 行，
 *    格式跟 osmslot 一樣，既有的解析不用改。
 *
 * ⚠️ 只把**明確是關閉**的值（false／0／"false"）改成 true；其他內容一個字都不動。
 *    沒有 debug 這個鍵 → 不加、只記下來讓呼叫端警告——自己硬塞一個鍵等於在猜前端怎麼讀設定。
 * ⚠️ 開 / 關兩種狀態的大廳實測：連線的網域完全相同、畫面沒有 debug 面板，差別只有 console。
 *    **機台內（遊戲 iframe、效能）還沒比對過**——第一次真機跑要留意。
 */
import type { BrowserContext } from 'playwright'

export interface ServerCfgDebugState {
  /** 攔到幾次 serverCfg.js（0＝這個站沒有這支檔，或網址規則對不上） */
  hits: number
  /** 原本的 debug 值（例如 `debug: false`）；`''`＝檔案裡沒有 debug 這個鍵 */
  original: string
  /** 這次有沒有真的改成 true */
  enabled: boolean
  /** 攔截本身出錯（抓原檔失敗等）——出錯時照原樣放行，不擋頁面載入 */
  error: string
}

const CFG_URL = /serverCfg\.js(\?|$)/
// ⚠️ 要有字界：`apiDebug: false`、`_debug: 0` 這種別的鍵不能被改到。鍵可帶引號（`"debug": false`）
const DEBUG_KEY = /(["']?)\bdebug\1\s*:\s*[^,\r\n}]+/
const DEBUG_OFF = /(["']?)\bdebug\1\s*:\s*(false|0|"false"|'false')(?=\s*[,\r\n}])/

/** 純字串轉換（測試直接打這支）：只把關閉的 debug 改成 true */
export function enableServerCfgDebug(body: string): { body: string; original: string; changed: boolean } {
  const original = body.match(DEBUG_KEY)?.[0].trim() ?? ''
  if (!DEBUG_OFF.test(body)) return { body, original, changed: false }
  return { body: body.replace(DEBUG_OFF, '$1debug$1: true'), original, changed: true }
}

/** 在 context 上掛攔截。回傳的 state 會隨攔截更新，進大廳後再讀它決定要不要警告 */
export async function installServerCfgDebug(ctx: BrowserContext): Promise<ServerCfgDebugState> {
  const state: ServerCfgDebugState = { hits: 0, original: '', enabled: false, error: '' }
  await ctx.route(CFG_URL, async route => {
    state.hits++
    try {
      const res = await route.fetch()
      const r = enableServerCfgDebug(await res.text())
      state.original = r.original
      if (r.changed) state.enabled = true
      await route.fulfill({ response: res, body: r.body })
    } catch (e) {
      state.error = e instanceof Error ? e.message : String(e)
      await route.continue().catch(() => { /* 頁面已關 */ })
    }
  })
  return state
}

/** 給 log 用的一句話。回傳 level：info＝已開或本來就開；warn＝沒攔到／沒有 debug 鍵／出錯 */
export function describeServerCfgDebug(s: ServerCfgDebugState): { level: 'info' | 'warn'; text: string } {
  if (s.error) return { level: 'warn', text: `⚠️ serverCfg debug 攔截出錯，照原檔放行（${s.error}）——console 的 SEND／ON 可能看不到` }
  if (!s.hits) return { level: 'warn', text: '⚠️ 沒攔到 serverCfg.js——若是正式站，console 的 SEND／ON 可能看不到（iDeck／觸屏會判成前端沒送）' }
  if (s.enabled) return { level: 'info', text: `🔧 serverCfg debug 已開啟（原值 ${s.original}）` }
  if (!s.original) return { level: 'warn', text: '⚠️ serverCfg.js 裡沒有 debug 這個鍵，沒有改——console 的 SEND／ON 可能看不到' }
  return { level: 'info', text: `serverCfg debug 原本就是開的（${s.original}），沒有改` }
}
