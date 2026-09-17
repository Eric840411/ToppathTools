/**
 * server/uat-runner/api-assert.js
 *
 * 「這支 API 必須被呼叫」的比對規則——**三個執行引擎共用的唯一一份**。
 *
 * ## 為什麼一定要抽出來
 * 同一顆 `assert_api_called` 積木會在三個地方被執行：
 *   1. `uat-runner/block-engine.js`         Backend（純 node 直接跑）
 *   2. `server/agent-runner.ts`             H5/PC 派工給 agent
 *   3. `server/routes/frontend-auto.ts`     H5/PC 伺服器端
 * 各寫一份的話症狀是「**同一條斷言，Backend 判過、H5 判不過**」——
 * 而且兩邊都不會報錯，只會讓人以為是環境差異。
 *
 * ## 判定規則本身要注意的兩件事
 * - **比對 `url` 與 `urlPattern` 兩個欄位**。錄製時存下來的是收斂過的 pattern
 *   （id／token／時間戳換成 `*`），但執行時抓到的是當下那一次的真實網址。
 *   只比其中一邊，就會變成「錄的時候明明有、跑起來永遠對不上」。
 * - **「沒打到」與「打到了但狀態碼不符」是兩種不同的失敗**，訊息要分得開。
 *   混成一句「斷言失敗」的話，使用者不知道該去看後端還是去看自己的步驟。
 */

/** `*` 當萬用字元，其餘一律當字面值。跟 block-engine 的同名函式行為一致。 */
export function wildcardToRegExp(pattern) {
  const escaped = String(pattern).split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, m => `\\${m}`))
    .join('.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * 判斷一批網路紀錄有沒有滿足這顆斷言。**純函式，不碰任何 I/O。**
 *
 * @param {object[]} calls 這一步之後抓到的網路紀錄（要有 url／urlPattern／status）
 * @param {{ urlPattern: string, expectStatus?: '2xx'|'any'|'exact', statusCode?: number|string, minCount?: number }} step
 * @returns {{ ok: boolean, matched: object[], good: object[], why: string }}
 *          `why` 在 ok 時是給 notes 用的說明，失敗時是給使用者看的原因。
 */
export function evaluateApiAssertion(calls, step) {
  const list = Array.isArray(calls) ? calls : [];
  const rx = wildcardToRegExp(step.urlPattern);
  // 兩個欄位都比：錄製存的是收斂後的 pattern，執行抓到的是當下的真實網址
  const matched = list.filter(c => rx.test(String(c.url ?? '')) || rx.test(String(c.urlPattern ?? '')));

  const mode = step.expectStatus ?? '2xx';
  const statusOk = (c) => {
    if (mode === 'any') return true;
    if (mode === 'exact') return Number(c.status) === Number(step.statusCode);
    return Number(c.status) >= 200 && Number(c.status) < 300;
  };
  const good = matched.filter(statusOk);
  const need = step.minCount === undefined ? 1 : Number(step.minCount);

  if (good.length < need) {
    const why = matched.length
      ? `打到了 ${matched.length} 次但狀態碼不符（實際：${[...new Set(matched.map(c => c.status))].join('、')}）`
      : `完全沒有打到這支 API（這一步總共打了 ${list.length} 支）`;
    return { ok: false, matched, good, why };
  }
  return {
    ok: true, matched, good,
    why: `${good.length} 次，狀態 ${[...new Set(good.map(c => c.status))].join('、')}`,
  };
}

/**
 * 這個執行環境拿不拿得到網路紀錄。
 *
 * ⚠️ **拿不到一定要當成失敗，不能跳過。** H5/PC 的執行引擎對不認得的動作是
 *    `⏭ 不支援的動作` 然後 **skipped**——斷言被跳過而腳本照樣 PASS，
 *    正是「假通過比直接報錯更糟」那條。所以呼叫端拿到 false 時要 fail 不是 skip。
 */
export function canAssertApi(records) {
  return typeof records === 'function' || Array.isArray(records);
}
