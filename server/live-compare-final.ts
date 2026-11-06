/**
 * 停止後結算＋後台對照總表：接正式 DB、即時對照比對、Lark 發送（邏輯在 live-compare-final-store.ts）。
 */
import { db } from './shared.js'
import { liveCompareLocked } from './live-compare.js'
import { sendLarkCard } from './lark-notify.js'
import { createFinalizer, ensureRunTable, type LiveSessionInfo } from './live-compare-final-store.js'

export type { RunRow, LiveSessionInfo } from './live-compare-final-store.js'
export { FINAL_REPORT_CHAT_KEY } from './live-compare-final-store.js'

ensureRunTable(db)

const f = createFinalizer(db, {
  compare: (env, sessions, opts) => liveCompareLocked(env, sessions, opts),
  send: (chatId, card, opts) => sendLarkCard(chatId, card, opts),
  now: () => Date.now(),
})

export const finalReportChatId = f.finalReportChatId
export const setFinalReportChatId = f.setFinalReportChatId
export const noteRunningRows = f.noteRunningRows
export const latestRunFor = f.latestRunFor
export const cardForRun = f.cardForRun
export const tickLiveCompareFinal = (getSessions: () => LiveSessionInfo[]) => f.tick(getSessions)
