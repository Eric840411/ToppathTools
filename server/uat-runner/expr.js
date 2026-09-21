/**
 * server/uat-runner/expr.js
 *
 * 積木用的**小算式**求值：`before.Balance - bet.Amount * 2`。
 *
 * ## 為什麼需要
 * 「兩值必須相等」只驗得了 A = B。但金流相關的 TC 幾乎都是另一種形狀：
 * 「扣款後餘額 = 扣款前 − 下注」「各列加總 = 總計列」——沒有算式就只能人工核對，
 * 或是在腳本外面自己算好再填死一個數字（那等於沒驗，因為那個數字是人算的）。
 *
 * ## 為什麼不用 `eval` / `new Function`
 * 算式是使用者從畫面上填的，直接 eval 等於把任意程式碼放進 runner。
 * 這裡自己做一個只認得「數字、變數、`+ - * /`、括號」的解析器——
 * 認不得的東西一律報錯，**不會有「看起來能跑但其實在做別的事」的空間**。
 *
 * ## 數字怎麼讀
 * 變數值可能是 `PHP 7,995,000.00`、`14.06%`、`1,408`。取值時一律走呼叫端給的
 * `toNumber`（跟其他積木同一套），所以幣別、千分位、百分號的處理只有一份。
 */

/** 把算式切成 token。認不得的字元**立刻報錯**，不要跳過——跳過會讓 `a ; b` 這種東西安靜通過 */
function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue }
    if ('+-*/()'.includes(ch)) { tokens.push({ type: ch }); i++; continue }
    // 數字（允許千分位與小數點）
    const num = /^[0-9][0-9,]*(\.[0-9]+)?/.exec(src.slice(i));
    if (num) { tokens.push({ type: 'num', value: Number(num[0].replace(/,/g, '')) }); i += num[0].length; continue }
    // 變數：`名稱` 或 `名稱.欄位.欄位`（欄位允許數字，例如 rows.0.Total）
    const ref = /^[A-Za-z_$][\w$]*(\.[\w$]+)*/.exec(src.slice(i));
    if (ref) { tokens.push({ type: 'ref', value: ref[0] }); i += ref[0].length; continue }
    throw new Error(`算式裡有看不懂的字元「${ch}」（只支援數字、變數、+ - * / 與括號）`);
  }
  return tokens;
}

/**
 * 求值。
 * @param {string} src 算式
 * @param {(name: string) => unknown} lookup 變數取值（回 undefined＝找不到）
 * @param {(value: unknown) => number|undefined} toNumber 數字正規化（跟其他積木共用那支）
 */
export function evaluateExpr(src, lookup, toNumber) {
  const text = String(src ?? '').trim();
  if (!text) throw new Error('算式是空的');
  const tokens = tokenize(text);
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (type) => { if (peek()?.type === type) { pos++; return true } return false };

  const primary = () => {
    const token = peek();
    if (!token) throw new Error('算式結尾不完整');
    if (eat('(')) {
      const value = expr();
      if (!eat(')')) throw new Error('括號沒有關起來');
      return value;
    }
    if (eat('-')) return -primary();
    if (eat('+')) return primary();
    if (token.type === 'num') { pos++; return token.value }
    if (token.type === 'ref') {
      pos++;
      const raw = lookup(token.value);
      if (raw === undefined || raw === null || raw === '') throw new Error(`取不到「${token.value}」的值`);
      /**
       * 🚨 **比 `toNumber` 嚴格。** `toNumber('Phoenix-132')` 會回 **-132**
       *    （它只是把非數字字元丟掉），於是把機台名字算進金額裡而且完全不會報錯。
       *    算式這裡允許的只有「最多 4 個字的幣別前綴 ＋ 數字（可含千分位／小數）＋ 可選的 %」。
       */
      if (!/^\s*[A-Za-z$₱¥€£]{0,4}\s*[+-]?[\d,]+(\.\d+)?\s*%?\s*$/.test(String(raw))) {
        throw new Error(`「${token.value}」的值是「${String(raw).slice(0, 30)}」，不是數字`);
      }
      const num = toNumber(raw);
      if (num === undefined) throw new Error(`「${token.value}」的值是「${String(raw).slice(0, 30)}」，不是數字`);
      return num;
    }
    throw new Error(`算式裡多了一個「${token.type}」`);
  };

  const term = () => {
    let value = primary();
    for (;;) {
      if (eat('*')) { value *= primary(); continue }
      if (eat('/')) {
        const divisor = primary();
        // ⚠️ 除以 0 要明講。放任它變成 Infinity 的話，後面的比對會說「Infinity ≠ 3」，
        //    看起來像資料有問題，其實是算式寫錯。
        if (divisor === 0) throw new Error('算式裡出現除以 0');
        value /= divisor;
        continue;
      }
      return value;
    }
  };

  const expr = () => {
    let value = term();
    for (;;) {
      if (eat('+')) { value += term(); continue }
      if (eat('-')) { value -= term(); continue }
      return value;
    }
  };

  const result = expr();
  if (pos !== tokens.length) throw new Error('算式後面有多餘的東西');
  if (!Number.isFinite(result)) throw new Error('算式的結果不是有限數字');
  return result;
}
