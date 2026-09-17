/**
 * 把原始碼的註解剝掉——**認得字串，不會把字串裡的 `/*` 當成註解開頭**。
 *
 * ## 為什麼需要這支（純正則版本會安靜地吃掉真實程式碼）
 * 檢查腳本一直用這兩行剝註解：
 * ```js
 * src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*!/g, '')
 * ```
 * 它在 `agent-runner.ts` 上壞得很嚴重：那支檔案裡有 XPath 字串
 * `"//*[normalize-space(text())='Join']"`，裡面的 `/*` 被當成註解開頭，
 * 非貪婪比對一路吃到下一個 `*​/`——**一次刪掉 15,376 個字元的真實程式碼**。
 *
 * 後果是檢查腳本對著一份殘缺的原始碼下判斷：
 * - 斷言找不到東西 → 誤報（我就是這樣才發現的）
 * - 更糟的是**反向**：要求「不得出現某個模式」的斷言，會因為那段程式碼被吃掉而**假通過**
 *
 * 剝註解本來就是為了「註解裡寫著我有做，不算做了」；結果剝的過程自己把程式碼弄丟，
 * 等於換一種方式得到假結論。
 *
 * ## 做法
 * 一個小狀態機，逐字元走過，認得：單引號／雙引號／樣板字串／正則字面值／
 * 行註解／區塊註解。註解換成等量空白（保留 offset，讓「A 在 B 之前」這類
 * 位置比較仍然成立）。
 */

/** 前一個有意義的字元決定 `/` 是除號還是正則開頭 */
const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '\n', '+', '-', '*', '%', '<', '>', '~', '^']);

export function stripComments(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  /** 最後一個非空白、非註解的字元——用來判斷 `/` 的角色 */
  let lastMeaningful = '\n';

  const keep = (ch) => { out.push(ch); if (!/\s/.test(ch)) lastMeaningful = ch; };
  const blank = (ch) => { out.push(ch === '\n' ? '\n' : ' '); };

  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];

    // ── 區塊註解 ──
    if (ch === '/' && next === '*') {
      i += 2;
      out.push(' ', ' ');
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { blank(src[i]); i++; }
      if (i < n) { out.push(' ', ' '); i += 2; }
      continue;
    }
    // ── 行註解 ──
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') { blank(src[i]); i++; }
      continue;
    }
    // ── 字串／樣板 ──
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      keep(ch); i++;
      while (i < n) {
        if (src[i] === '\\') { keep(src[i]); keep(src[i + 1] ?? ''); i += 2; continue; }
        if (src[i] === quote) { keep(src[i]); i++; break; }
        // 樣板字串裡的 ${...} 可能包含引號與註解，但為了這些檢查的用途
        // 不需要遞迴進去——整段當字串保留就好（保留才找得到裡面的識別字）
        keep(src[i]); i++;
      }
      continue;
    }
    // ── 正則字面值 ──
    // `/` 前面是運算子或開括號時才是正則；是識別字或 `)` 時是除號。
    if (ch === '/' && REGEX_PRECEDERS.has(lastMeaningful)) {
      keep(ch); i++;
      let inClass = false;
      while (i < n) {
        if (src[i] === '\\') { keep(src[i]); keep(src[i + 1] ?? ''); i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) { keep(src[i]); i++; break; }
        else if (src[i] === '\n') break;   // 正則不跨行，走到這裡代表判斷錯了，收手
        keep(src[i]); i++;
      }
      continue;
    }
    keep(ch); i++;
  }
  return out.join('');
}
