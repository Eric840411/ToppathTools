/**
 * 機台測試 profile 的 iDeck XPath 格式檢查——前後端共用這一份（v5.50.0，osm-qa-agent spec #10，CodeX 1013）。
 *
 * 為什麼：同一類錯字出現過兩次（LIONLINK ideckXpaths[2]、SQUIDGAME 第 7 條開頭多一個 `b`：`b//div…`）。
 * 存得進去、跑的時候找不到元素，而 runner 原本把找不到的那顆**跳過**——判定照樣 9/9 PASS，完全看不出漏按。
 *
 * 這裡只做「結構」檢查（開頭、括號／引號成對、不能是空的）。真正的 XPath 語法：
 *   - 編輯頁存檔前用瀏覽器的 document.evaluate 再驗一次（server 端沒有 XPath 引擎）
 *   - runner 執行時解析失敗＝找不到元素，現在會記成 noElement 判 FAIL，不會再靜默跳過
 */

/** 回傳錯誤原因；沒問題回 null。呼叫端先 trim 再存 */
export function ideckXpathProblem(raw: string): string | null {
  const s = raw.trim()
  if (!s) return '是空的'
  if (!/^[/(]/.test(s)) return `開頭必須是「/」或「(」（現在是「${s.slice(0, 12)}${s.length > 12 ? '…' : ''}」）`
  // 括號／中括號成對、引號關好；引號裡的字不算
  const stack: string[] = []
  let quote: string | null = null
  for (const ch of s) {
    if (quote) { if (ch === quote) quote = null; continue }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '(' || ch === '[') stack.push(ch)
    else if (ch === ')' || ch === ']') {
      const open = stack.pop()
      if (open !== (ch === ')' ? '(' : '[')) return `「${ch}」沒有對應的開頭括號`
    }
  }
  if (quote) return `引號 ${quote} 沒有關`
  if (stack.length) return `「${stack.at(-1)}」沒有關`
  return null
}

/** 整份清單：第幾條（從 1 開始）有什麼問題 */
export function ideckXpathProblems(list: readonly string[]): Array<{ index: number; problem: string }> {
  return list.flatMap((x, i) => { const p = ideckXpathProblem(x); return p ? [{ index: i + 1, problem: p }] : [] })
}
