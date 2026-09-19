/**
 * src/features/changelog/entry-format.ts
 *
 * **更新日誌一行要怎麼解讀——只有這一份。**
 *
 * ## 為什麼會需要這支
 * 原本這段規則**同時寫在兩個檔案裡**（`ChangelogModal.tsx` 與 `ChangelogPage.tsx`，
 * 一模一樣的 regex）。而規則本身是這樣的：
 *
 *     /^(feat|fix|chore|…)(\(scope\))?:\s*(.*)/
 *
 * 也就是**必須從第一個字元就是 `feat`**、而且冒號必須是**半形**。
 * 後來寫日誌的人（包含我）開始寫成：
 *
 *     '✨ **feat(uat)：H5／PC 腳本可以綁 Lark TC 了…**'
 *
 * 三個地方同時打破它：**開頭多了 emoji**、**包了 `**`**、**冒號變成全形「：」**。
 * 於是那一行掉進「沒有比對到」的分支，結果是：
 *   - 左邊的 `feat(uat)` 色塊**不見了**
 *   - `**` 直接以原始字元印出來（因為那個分支完全不處理行內語法）
 *
 * ⚠️ **這種壞法沒有任何錯誤訊息**：畫面照常渲染，只是變醜、而且變得難讀。
 *
 * ## 修的方向
 * **不是去改幾百筆日誌**（那會把內容的重點標示全部洗掉），而是讓解讀端認得
 * 實際寫出來的樣子：容許開頭的 emoji、容許 `**` 包住、半形全形冒號都收，
 * 並且真的把 `**粗體**` 與 `` `程式碼` `` 渲染出來。
 */

/** 認得的變更類型與對應顏色 */
export const CHANGE_TYPE_COLORS: Record<string, string> = {
  feat: '#34d399', fix: '#f87171', chore: '#64748b',
  docs: '#60a5fa', refactor: '#a78bfa', perf: '#fbbf24',
  style: '#f0abfc', test: '#fbbf24', revert: '#fb923c',
}

const TYPES = Object.keys(CHANGE_TYPE_COLORS).join('|')

/**
 * ⚠️ **冒號要同時收半形 `:` 與全形 `：`。**
 * 中文輸入法下打出來的是全形，而寫日誌的人不會特別去切。只認半形的話，
 * 一行只要用了全形冒號就整行掉出格式——而且看起來像是「忘了加標籤」。
 *
 * 🚨 **開頭的符號只認真正的 emoji，不要用「非英數」去吃。**
 *    第一版寫成 `[\p{Extended_Pictographic}\uFE0F\u200D\u2B00-\u2BFF]+`，看起來很通用，實際上有兩個洞：
 *      ① JS 的 `\w` 只有 `[A-Za-z0-9_]`——**每一個中文字都算「非英數」**，
 *         所以那一組會把整句中文吃進去
 *      ② 它是 `(X+ Y*)+` 的形狀，比對失敗時會**災難性回溯**
 *    後果：短測試案例全部通過，但拿真的日誌（756 行）去跑會**整支卡死**。
 *    ⚠️ 我是在「把全部真實資料跑一遍」時才發現的——這一步不能省。
 *
 *    改成用 Unicode 屬性明確指定表情符號：單一量詞、不會回溯爆炸，
 *    也不會誤吃中文。
 */
const LINE = new RegExp(
  '^\\s*'
  // `\\uFE0F` 是變體選擇符、`\\u200D` 是組合用的零寬連接，⚠️ 這兩個要一起收，
  // 否則像 ⚠️ 這種「符號＋變體選擇符」的會只吃掉一半
  + '(?<emoji>[\\p{Extended_Pictographic}\\uFE0F\\u200D\\u2B00-\\u2BFF]+)?'
  + '\\s*'
  + '(?<bold>\\*\\*)?'                     // 可有可無的 ** 包裝
  + `(?<type>${TYPES})`
  + '(?<scope>\\([^)]*\\))?'
  + '\\s*[:：]\\s*'
  + '(?<rest>[\\s\\S]*)$',
  'u',
)

export interface ParsedChange {
  /** 有比對到類型才有值；沒有的話整行都是 `text` */
  type?: string
  scope?: string
  /** 開頭那顆 emoji（原樣保留，畫面上放在色塊之前） */
  emoji?: string
  /** 去掉標籤之後的內容，**行內語法原樣保留**交給 `renderInline` */
  text: string
}

/**
 * 解一行變更說明。
 *
 * ⚠️ **比對到 `**` 開頭時要把它補回內容前面。** 那個 `**` 的結尾通常在句子中間
 * （`**feat(uat)：重點。**後面接說明`），只把開頭那一半吃掉的話，剩下的字串會有
 * 一個**沒有開頭的 `**`**，渲染出來就是一串裸露的星號——比原本還糟。
 */
export function parseChangeLine(line: string): ParsedChange {
  const m = LINE.exec(line ?? '')
  if (!m?.groups) return { text: String(line ?? '') }
  const { emoji, bold, type, scope, rest } = m.groups
  return {
    type,
    scope: scope ?? '',
    emoji: emoji?.trim() || undefined,
    text: (bold ? '**' : '') + (rest ?? ''),
  }
}

/** 行內語法的一段。`code`／`bold` 以外都是 `text` */
export interface InlineToken { kind: 'text' | 'bold' | 'code'; value: string }

/**
 * 把 `**粗體**` 與反引號括起來的程式碼拆成可渲染的片段。
 *
 * ## ⚠️ 找粗體的結尾時要跳過程式碼片段
 * 兩種標記混在同一行時，天真的「從左掃到右、看到哪個處理哪個」會壞在這裡：
 *
 *     **標題。**……開頭印出一堆 `**`……
 *
 * 粗體去找下一個 `**`，找到的卻是**反引號裡面那一組**——粗體提早結束、後面整串錯位，
 * 最後留下一個沒人收的 `**` 印在畫面上。
 * （這一行是我自己寫的日誌，被 `changelog-render-all.mjs` 當場抓出來。）
 *
 * 反過來「先把程式碼全部切出來、再找粗體」也不行：那會讓**跨越程式碼的粗體**
 * （`**前面 \`code\` 後面**`）兩端都配不到，實測一次讓 88 行露出星號。
 *
 * 所以是**單趟掃描，但找結尾時略過程式碼區段**；粗體內部的程式碼再切一次。
 *
 * ⚠️ 沒有配對到結尾的標記一律當成純文字，不要硬吃掉——
 * 吃掉的話畫面上會少一段字，而少字是最難發現的壞法（沒人會注意到不見的東西）。
 */
export function renderInline(text: string): InlineToken[] {
  const out: InlineToken[] = []
  let buffer = ''
  let i = 0
  const flush = () => { if (buffer) { out.push({ kind: 'text', value: buffer }); buffer = '' } }
  while (i < text.length) {
    if (text.startsWith('**', i)) {
      const end = findBoldCloser(text, i + 2)
      if (end > i + 2) {
        flush()
        // 粗體裡面也可能有程式碼。⚠️ 一個片段只能有一種樣式，
        //    所以程式碼那幾段維持程式碼樣式（本來就已經夠顯眼），其餘才是粗體。
        for (const piece of splitCode(text.slice(i + 2, end))) {
          out.push(piece.kind === 'text' ? { kind: 'bold', value: piece.value } : piece)
        }
        i = end + 2
        continue
      }
    } else if (text[i] === '`') {
      const end = text.indexOf('`', i + 1)
      if (end > i + 1) {
        flush()
        out.push({ kind: 'code', value: text.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }
    buffer += text[i]
    i += 1
  }
  flush()
  return out
}

/** 找粗體的結尾，**略過反引號括起來的區段**。找不到回 -1 */
function findBoldCloser(text: string, from: number): number {
  let i = from
  while (i < text.length) {
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1)
      if (end > i + 1) { i = end + 1; continue }
    }
    if (text.startsWith('**', i)) return i
    i += 1
  }
  return -1
}

/** 把 `` `…` `` 切出來，其餘原樣留著 */
function splitCode(text: string): InlineToken[] {
  const out: InlineToken[] = []
  let buffer = ''
  let i = 0
  const flush = () => { if (buffer) { out.push({ kind: 'text', value: buffer }); buffer = '' } }
  while (i < text.length) {
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1)
      if (end > i + 1) {
        flush()
        out.push({ kind: 'code', value: text.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }
    buffer += text[i]
    i += 1
  }
  flush()
  return out
}
