/**
 * API 參數紀錄：機台輸入與 console 解析（agent 與 server 共用；agent 會下載這支，只能用標準函式庫）。
 */

/** 機台輸入（144／DFDCGRAND-0144／873-DFDCGRAND-0144）→ 比對用的號碼與機種 */
export function parseMachineInput(input: string): { num: string | null; type: string | null; raw: string } {
  const raw = input.trim()
  const parts = raw.split(/[-\s]+/).filter(Boolean)
  const num = [...parts].reverse().find(p => /^\d+$/.test(p)) ?? null
  const type = parts.find(p => /[A-Za-z]/.test(p)) ?? null
  // 只有一段而且是純數字＝機台號；873-XXX-0144 的 873 是渠道，不是機台號
  return { num: num ? String(Number(num)) : null, type: type ? type.toUpperCase() : null, raw }
}

/** 大廳卡片名稱（如「144-DFDCGRAND」或 title「873-DFDCGRAND-0144」）是不是這台 */
export function cardMatches(cardText: string, m: { num: string | null; type: string | null }): boolean {
  const p = cardPattern(m)
  const t = cardText.toUpperCase()
  if (p.type && !t.includes(p.type)) return false
  return p.numSource ? new RegExp(p.numSource).test(t) : !!p.type
}

/**
 * 卡片比對規則的可序列化版本：大廳頁裡（page.evaluate）沒辦法 import，
 * 把規則從這裡算好傳進去，頁面端只做 `new RegExp(numSource)`——規則只有這一份。
 */
export function cardPattern(m: { num: string | null; type: string | null }): { type: string | null; numSource: string | null } {
  return { type: m.type, numSource: m.num ? `(^|[^0-9])0*${m.num}([^0-9]|$)` : null }
}

/** console 的 moneyNtc：`ON: 0 moneyNtc {event: moneyNtc, coin: 999982, reason: begin}` */
export function parseMoneyNtc(text: string): { coin: number; reason: string } | null {
  if (!/moneyNtc/.test(text)) return null
  const coin = /coin:\s*(-?[\d.]+)/.exec(text)
  const reason = /reason:\s*"?(\w+)/.exec(text)
  if (!coin || !reason) return null
  return { coin: Number(coin[1]), reason: reason[1] }
}

/** 比對基準用的機台鍵：有機種就「機種-號碼」，否則只有號碼 */
export function machineKey(input: string): string {
  const m = parseMachineInput(input)
  return [m.type ?? '', m.num ?? ''].filter(Boolean).join('-') || input.trim().toUpperCase()
}
