/**
 * server/uat-runner/backend-ops.js
 *
 * 在 **H5／PC 的執行流程中間**跑一段後台操作（例如「把某個開關打開」），
 * 然後回到前端腳本繼續驗證。使用者的情境：**後台設置開關，前端才有反應。**
 *
 * ## 這支刻意不做的事
 * - **不碰 Lark。** 設定動作不是測試案例，跑完不該去改任何一筆 TC 的結果
 *   （後台「錄製腳本」會回寫 Lark：上傳截圖、寫 pass/fail）。
 * - **不佔同腳本互斥鎖。** 那把鎖是給正式 TC 排隊用的。
 * - **不自動還原。** 程式不知道「還原」是什麼（關回去？改回原值？原值多少？），
 *   猜錯會留下「你以為還原了、其實沒有」的狀態——比忘記還原更糟。
 *   還原要由作者在腳本最後自己放一段，看得見也改得動。
 *
 * ## 動作只支援「設定類」的子集，而且**不支援的一律明確失敗**
 * ⚠️ H5/PC 的執行引擎對不認得的動作是「**跳過**」不是失敗（v4.167.0 踩過：
 *    `fill` 在伺服器模式不存在，腳本照樣 PASS）。這裡絕不能重蹈——
 *    片段裡有執行器不支援的動作時，**在跑之前就擋下來並指名是哪一個**，
 *    不然會拿到一份「綠的、但其實沒設定到」的結果。
 */
import { runSteps } from './block-engine.js';

/**
 * 設定片段允許的動作。
 *
 * 刻意**不放**斷言類與報表類（`assert_*`、`run_export`、`read_table`…）：
 * 設定片段的職責是「把狀態改成某個樣子」，驗證是前端腳本那半的事。
 * 混進來的話會出現「設定片段自己判了 pass/fail」，而那個結果沒有人會去看。
 */
export const BACKEND_OP_ACTIONS = Object.freeze([
  'open_page',      // 切到某個後台頁面
  'click',          // 點按鈕／連結
  'set_checked',    // 勾選／取消勾選 ← 開關就是這個
  'select_option',  // 下拉選單
  'type_text',      // 填欄位
  'keypress',       // 送 Enter 之類
  'submit_search',  // 送出查詢
  'wait',           // 等元素或等時間
]);

/** 片段裡有哪些動作是這個執行器不支援的（回傳去重後的動作名） */
export function unsupportedBackendOps(steps) {
  const bad = [];
  for (const step of steps ?? []) {
    const action = String(step?.action ?? '');
    if (!action) { bad.push('(空白)'); continue }
    if (!BACKEND_OP_ACTIONS.includes(action)) bad.push(action);
  }
  return [...new Set(bad)];
}

/**
 * 後台登入。
 *
 * ⚠️ 選擇器跟 `uat-server-recorder.ts` 那支**刻意一樣**——後台只有一個登入頁，
 *    兩邊各寫一套的話，改版時只會有一邊被修到，而壞掉的那邊症狀是
 *    「登入畫面停著不動」，看起來像帳密錯。
 */
async function login(page, { backendUrl, username, password, waitMs = 1500 }) {
  await page.goto(backendUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const user = page.locator('input[type="text"], input[name*="user"], input[id*="user"]').first();
  // 已經登入過（cookie 還在）就不會有帳密欄位——這不是錯誤
  if (!(await user.count())) return { loggedIn: false, reason: 'already-signed-in' };
  await user.fill(username);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('button[type="submit"], button:has-text("登录"), button:has-text("登入"), button:has-text("Login")')
    .first().click({ timeout: 15_000 });
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(waitMs);
  return { loggedIn: true };
}

/**
 * 給 `block-engine.runSteps` 用的**最小 ctx**。
 *
 * ⚠️ 只實作設定類動作需要的那幾支。少實作的那些，`BACKEND_OP_ACTIONS` 已經先擋掉了——
 *    **兩道都要有**：allowlist 擋的是「作者放了不該放的動作」，ctx 這邊缺函式時
 *    block-engine 自己也會失敗（例如 `submit_search` 會檢查 `typeof ctx.submitSearch`）。
 */
export function createBackendOpContext(page, { baseUrl, onNote = () => {} }) {
  return {
    page,
    onStep({ index, step }) { onNote(`[後台 ${index + 1}] ${step.action}`); },

    /** open_page：片段一律用明確路徑，不吃 subtype（那是 TC registry 的概念） */
    resolveSubtypePath() { return null },
    async openPath(target, waitMs = 1500) {
      const url = /^https?:\/\//i.test(target) ? target : new URL(target, baseUrl).toString();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(waitMs);
    },

    async clickSelector(selector, waitMs = 800) {
      // ⚠️ **不做座標備援。** 後台設定按錯位置的後果是改到別的設定，
      //    而且你不會知道——寧可失敗。（前端腳本有座標備援是因為 canvas 沒有 DOM。）
      const target = page.locator(selector);
      const count = await target.count();
      if (count !== 1) throw new Error(`「${selector}」命中 ${count} 個，設定操作必須唯一`);
      await target.click({ timeout: 15_000 });
      await page.waitForTimeout(waitMs);
      return 'selector';
    },

    async typeInto(selector, value) {
      const target = page.locator(selector);
      const count = await target.count();
      if (count !== 1) throw new Error(`「${selector}」命中 ${count} 個，輸入必須唯一`);
      await target.fill(String(value ?? ''), { timeout: 15_000 });
    },

    async pressKey(selector, key) {
      if (selector) await page.locator(selector).first().press(key, { timeout: 15_000 });
      else await page.keyboard.press(key);
    },

    async submitSearch(waitMs = 1500) {
      const button = page.locator('button:has-text("查询"), button:has-text("查詢"), button:has-text("Search"), button:has-text("View")').first();
      if (!(await button.count())) throw new Error('找不到送出查詢的按鈕');
      await button.click({ timeout: 15_000 });
      await page.waitForTimeout(waitMs);
    },
  };
}

/**
 * 跑一段後台設定片段。
 *
 * @param {import('playwright').Browser} browser 已經開好的瀏覽器（跟前端腳本共用同一顆）
 * @param {{ backendUrl: string, username: string, password: string, steps: object[],
 *           title?: string, onNote?: (line: string) => void }} options
 * @returns {Promise<{ ok: boolean, notes: string[], fails: string[] }>}
 */
export async function runBackendOps(browser, options) {
  const { backendUrl, username, password, steps, title = '後台設定', onNote = () => {} } = options;
  const fails = [];
  const notes = [];
  const say = (line) => { notes.push(line); onNote(line) };

  // ⚠️ 帳密不能出現在日誌裡。執行日誌會被存起來、也會給別人看。
  const redact = (text) => {
    let out = String(text ?? '');
    for (const secret of [password, username]) {
      if (secret) out = out.split(secret).join('[REDACTED]');
    }
    return out;
  };

  if (!backendUrl) return { ok: false, notes, fails: ['沒有後台網址，無法執行後台設定'] };
  if (!username || !password) {
    return { ok: false, notes, fails: ['沒有後台帳密。請先到 UAT 的執行設定填好後台登入帳密。'] };
  }
  const unsupported = unsupportedBackendOps(steps);
  if (unsupported.length) {
    // ⚠️ **在跑之前就擋**，而且指名是哪一個動作。跑到一半才發現的話，
    //    前面已經改過的設定會留在後台，而結果看起來像「這一步沒做」。
    return {
      ok: false, notes,
      fails: [`後台設定片段「${title}」含有這個執行器不支援的動作：${unsupported.join('、')}。`
        + `目前支援：${BACKEND_OP_ACTIONS.join('、')}。`],
    };
  }
  if (!steps?.length) return { ok: false, notes, fails: [`後台設定片段「${title}」沒有任何步驟`] };

  // ⚠️ 用獨立的 context：後台的 cookie 不能跟遊戲頁混在一起。
  //    共用的話，遊戲頁可能因為多了一組後台 cookie 而走到不同的分支。
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    say(`🔧 後台設定「${title}」：登入中`);
    const signIn = await login(page, { backendUrl, username, password });
    say(signIn.loggedIn ? '🔧 後台登入完成' : '🔧 後台已是登入狀態');

    const ctx = createBackendOpContext(page, { baseUrl: backendUrl, onNote: say });
    const result = await runSteps(steps, ctx, { autoScreenshot: false });
    for (const note of result?.notes ?? []) say(`🔧 ${redact(note)}`);
    for (const problem of result?.criticalFails ?? []) fails.push(redact(problem));
  } catch (error) {
    fails.push(redact(`後台設定「${title}」執行失敗：${error instanceof Error ? error.message : String(error)}`));
  } finally {
    // ⚠️ 一定要收。不收的話每跑一次 H5 腳本就留一個 context，
    //    長時間跑壓測時會把記憶體吃光，而症狀是「跑久了就變慢」。
    await context.close().catch(() => {});
  }
  return { ok: fails.length === 0, notes, fails };
}
