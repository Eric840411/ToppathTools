/**
 * Jira 單號（issue key）辨識規則——前後端共用這一份。
 *
 * 為什麼抽出來：原本前端（批量評論）和後端（批量更新狀態讀 Sheet）各寫一份
 * `[A-Z]{2,}[0-9]*-\d+`，要求「開頭至少兩個字母」，於是 `P5MA-9675` 這種第二碼是數字的
 * 專案代號整批被當成「不是單號」，而且畫面沒有任何提示，只是默默少了幾張（2026-09-30，
 * CGFB/P5MA 那份 Sheet 136 列只抓到 58 張，P5MA 全漏）。兩邊各寫一份所以才會一起錯。
 *
 * 格式：字母開頭，後面大寫字母／數字／底線，再接 `-數字`。這是 Jira Data Center 文件列出的
 * 可設定 project key 格式（https://confluence.atlassian.com/adminjiraserver/changing-the-project-key-format-938847081.html），
 * 不是每個版本的預設值，但涵蓋我們實際遇到的代號（CGFB、DSFT、P5MA、CGLD3）。
 *
 * 邊界：結尾不設（真資料有 `CGFB-1Free Bet…` 這種連結文字黏標題的格式）；
 * 任意位置搜尋另外擋開頭（見 START）。
 *
 * ⚠️ 已知限制：regex 只能判斷「長得像不像單號」，不能判斷「是不是 Jira 單」。
 *    `H5-1` 符合格式，在「任意位置搜尋」的路徑（後端讀 Sheet）會被當成單號。
 *    各呼叫端保留原本的擷取位置（開頭／browse 網址／任意位置），不要為了多抓幾張
 *    順手把只看開頭的路徑改成全文搜尋——那會把這個限制帶進原本沒有的地方（CodeX review）。
 */

const KEY = '[A-Z][A-Z0-9_]+-\\d+'
// 結尾刻意不設邊界。曾經加過「後面不能接字母」，真 Sheet 就漏掉 `CGFB-1Free Bet 製作主單`
// （超連結文字黏著標題，2026-09-30 實測第 50 列）。數字那端不用擋：`\d+` 是貪婪的、後面沒有東西
// 要它退讓，`CGFB-12` 本來就不會被截成 `CGFB-1`。
// 任意位置搜尋才需要開頭邊界：前面緊貼字母／數字／底線／連字號就不算。
// 實例（2026-09-30 真 Sheet）：URL 欄讀回公式原文 `REGEXEXTRACT(Q2, "[A-Z0-9]+-[0-9]+")`，
// 沒有這條會抓出 `Z0-9` 拿去流轉；舊規則則會把 `P5MA-9570` 截成 `MA-9570`——同一類問題。
const START = '(?<![A-Za-z0-9_-])'

/** 整串就是一個單號（驗證用） */
export const JIRA_KEY_EXACT_RE = new RegExp(`^${KEY}$`)
/** 開頭是單號：「CGFB-98 標題」→ CGFB-98 */
export const JIRA_KEY_AT_START_RE = new RegExp(`^(${KEY})`)
/** 文字任意位置的第一個單號 */
export const JIRA_KEY_IN_TEXT_RE = new RegExp(`${START}(${KEY})`)
/** Jira 網址裡的單號：…/browse/P5MA-9675 */
export const JIRA_KEY_IN_BROWSE_URL_RE = new RegExp(`/browse/(${KEY})`)
/** 「[CGLD3-1]標題」這種中括號開頭格式；群組 1 是單號、群組 2 是後面的標題 */
export const JIRA_KEY_BRACKET_PREFIX_RE = new RegExp(`^\\[(${KEY})\\](.*)$`)
