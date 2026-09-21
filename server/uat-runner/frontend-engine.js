/**
 * server/uat-runner/frontend-engine.js
 *
 * **H5／PC 積木的執行引擎——只有這一份。**
 *
 * ## 為什麼要合併
 * 在這之前這張「哪顆積木做什麼」的對照表**存在兩份**：`routes/frontend-auto.ts`（伺服器端）
 * 與 `agent-runner.ts`（agent 端）。而它們**已經漂了**：
 *
 *   - `find_baseline_scroll`（尋找基準圖）**只有伺服器端有** → 派工給 agent 時掉進
 *     「不認得的動作 → 跳過」，**腳本照樣 PASS，而視覺比對根本沒跑**。
 *     更糟的是框選截圖自動產生的就是那顆積木。
 *   - 加「後台設定」積木時，同一段邏輯得寫兩次——寫的當下有意識到所以兩邊都補了，
 *     但那正說明：**只要有兩份，就會有人哪次只改一邊**。
 *
 * 後台那條線早就只有一份（`block-engine.js`），H5 的**錄製器**上個月也因為一模一樣的
 * 理由合併過（當時一邊錄 `click`、另一邊錄 `click_viewport`）。這是第三次。
 *
 * ## 切法
 * 引擎只管「這顆積木要做什麼」，**環境差異由 host 用 ctx 提供**：
 *
 *   | host 提供 | 伺服器端 | agent 端 |
 *   |---|---|---|
 *   | `log` | `pushLog` | ws 事件 |
 *   | `loadBaseline` | 讀 DB ＋ 本機檔案 | 從 server 抓 |
 *   | `backend` | 直接從 DB 取 | server 派工時帶過來 |
 *
 * ## 約定
 * - **成功就正常返回，失敗一律 `throw`。** host 的迴圈負責重試／failureMode／計數，
 *   那部分兩邊本來就不同（agent 還要回報 step_result 事件）。
 * - **不認得的動作要 throw，不能回「跳過」。** 少驗是誠實的，假裝驗過不是。
 */
import { evaluateApiAssertion } from './api-assert.js';
import { runBackendOps } from './backend-ops.js';
import { clickRecorded, countRecorded, describeLocateFailure, locateRecorded } from './recorded-selector.js';
import { h5BackToLobby, h5InGame } from './h5-seat.js';
import { guardDangerousStep } from './dangerous-actions.js';
import { pcNodeAtPoint, pcNodeText } from './pc-node-hittest.js';
import { evaluateExpr } from './expr.js';
/**
 * PC（Cocos）版的能力**由 host 從 ctx 給**（`ctx.pc`），這支不自己 import。
 *
 * 🚨 **PC 不能用 DOM 選擇器測**，這是實測的：整個畫面是一張 canvas，
 *    DOM 裡**只有 1 個 canvas、0 個有 class 的可見元素**；載入期間也**沒有任何業務
 *    HTTP API**（只有 posthog／GA 遙測），業務全走 WS(pinus)。
 *    所以 `assert_visible` 與 `assert_api_called` 在 PC 上都驗不到東西——
 *    照抄 H5 腳本會得到一整排「命中 0」，看起來像選擇器寫錯。判定只能讀 Cocos 場景樹。
 *
 * ⚠️ **為什麼不在這裡 `import lib/pc-cocos.js`**：那是 TypeScript，只有編譯過的
 *    伺服器端有 `.js`。這支是純 JS，測試與 agent 都可能直接用 node 跑它——
 *    靜態 import 會在**載入當下** `ERR_MODULE_NOT_FOUND`，把整支引擎（含 H5 那條線）
 *    一起拖垮。實際踩過：加上去之後 `tc-engine-contract.test.mjs` 連跑都跑不起來。
 *    這也正是這個檔案開頭寫的原則——**環境差異由 host 用 ctx 提供**。
 */

/** 這份引擎實作了哪些積木。⚠️ 加新積木時這裡也要加——測試會比對 */
export const FRONTEND_ACTIONS = Object.freeze([
  'goto', 'click', 'click_xy', 'click_viewport', 'type', 'fill', 'wait',
  'screenshot', 'find_baseline_scroll', 'assert_api_called', 'assert_visible',
  'backend_snippet',
  // PC（Cocos）專用：畫面上沒有 DOM，只能讀場景樹。見上面那段 import 的說明
  'pc_enter_machine', 'assert_pc_scene', 'pc_click_node', 'assert_pc_node',
  'scroll', 'pc_scroll', 'press_key', 'assert_ws_called',
  // 前置條件：不成立時判「受阻」，見下面那顆積木的說明
  'require_precondition',
  // 驗文字／數字（H5 讀 DOM、PC 讀 Cocos label——**不是 OCR**）
  'assert_text',
  // 等到條件成立（取代「等 N 毫秒」這種猜的等待）
  'wait_for',
  // 讀成變數 ＋ 比對（前台原本只有「驗這一格的文字」，沒辦法把兩個地方的數字擺在一起比）
  'read_value', 'assert_compare',
]);

/**
 * 前台的變數表放在 `ctx.state.vars`。
 *
 * ⚠️ **跟著 state 走，不要用模組層的變數**：同一個 runner 會連續跑很多支腳本，
 *    模組層存的話上一支的值會留到下一支——而且只有在「剛好同名」時才出錯，
 *    查起來像是讀到了幽靈資料。
 */
function frontendVars(ctx) {
  if (!ctx.state) throw new Error('這顆積木需要執行狀態（host 沒給 ctx.state）');
  if (!ctx.state.vars) ctx.state.vars = {};
  return ctx.state.vars;
}

/** 數字比較（跟後台同一套語意：相對容差或絕對容差任一成立就算相等） */
function frontendNumbersEqual(a, b, tolPct, abs) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (a === b) return true;
  if (Math.abs(a - b) <= abs) return true;
  const base = Math.max(Math.abs(a), Math.abs(b));
  return base > 0 && (Math.abs(a - b) / base) * 100 <= tolPct;
}

/**
 * 文字比對。**把數字正規化**：畫面上的「31,568,677,510.61」與「$31568677510.61」
 * 是同一個數，但字串比對會說不一樣。
 *
 * ⚠️ 只在數值模式做這件事。文字模式不能亂正規化——
 *    「Bet 10」與「Bet10」的差別有時候正是要驗的東西。
 */
/** 算式用的數字正規化。跟 `toNumber` 同一套，命名分開是因為算式那邊會再多一層格式檢查 */
const frontendToNumber = (value) => toNumber(value);

function toNumber(text) {
  const cleaned = String(text ?? '').replace(/[^0-9.+-]/g, '');
  // ⚠️ 不能只靠 `Number()`：`Number('')` 是 **0**，於是「abc」會被當成 0 而不是錯誤——
  //    症狀是 `>=abc` 這種打錯的期望值變成 `>=0`，**永遠通過**。
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * 「前置條件不成立」的記號。
 *
 * 🚨 **靠訊息前綴傳遞，是因為積木之間只有 `throw` 這一條路**（見檔頭的約定）。
 *    所以這個字串**兩邊都要用同一個常數**——自己在另一支檔案裡重打一次的話，
 *    改一個字就會讓整個受阻機制安靜失效（判定會退回 FAIL，而且沒有人會發現）。
 */
export const PRECONDITION_PREFIX = '⛔前置條件不成立：';

/**
 * 執行前的步驟整理。
 *
 * 目前只做一件事：**丟掉「座標點擊後面緊接著的 selector 點擊」**——錄製器對同一下操作
 * 會送出兩種形式，不丟的話同一個地方會被點兩次。
 *
 * ⚠️ 這段原本**只有伺服器端有**（agent 端沒有），所以同一份腳本在兩邊會點不一樣多次。
 *    這是合併時發現的第二處漂移——第一處是 `find_baseline_scroll`。
 *
 * @returns {{ steps: object[], dropped: number }}
 */
/**
 * 取出 host 提供的 PC 能力。
 *
 * ⚠️ **沒提供就 throw，不要靜默跳過。** 這顆積木少跑一次的症狀是「腳本全綠但什麼都沒驗」，
 *    那正是這個檔案開頭那段「不認得的動作要 throw」在防的事。
 */
/** PC 捲動失敗的說法——要能分辨「沒指定時找不到大廳清單」與「指定的那份不存在」 */
function describeScrollFail(status, listName) {
  if (status === 'no-target') return `找不到名叫「${listName}」的清單（ScrollView）——名字打錯，或這一頁還沒開`;
  if (status === 'no-sv') return '找不到大廳的清單（ScrollView）——可能還沒載好，或現在不在大廳';
  if (status === 'no-cc') return '頁面裡沒有 Cocos（window.cc 不存在）';
  return `捲動失敗（${status}）`;
}

/**
 * 動作發生**之前**把 WS 界線往前推。
 *
 * 🚨 CodeX 2026-09-20 指出的關鍵點：游標若在斷言時才設，**舊訊息會被算進去**——
 *    第二次 SPIN 會吃到第一次的訊息，等於沒驗到第二次。所以每個「會造成動作」的積木
 *    在動手前先推界線，後面的 `assert_ws_called` 只看得到這個動作之後的訊息。
 */
function markWsBefore(ctx) {
  if (ctx.state) ctx.state.wsMark = Date.now();
}

function requirePc(ctx, blockName) {
  const pc = ctx.pc;
  if (!pc || typeof pc.sceneName !== 'function') {
    throw new Error(`「${blockName}」是 PC（Cocos）專用積木，但這次執行沒有帶 PC 能力進來（host 沒給 ctx.pc）`);
  }
  return pc;
}

export function compileFrontendSteps(steps) {
  const kept = (steps ?? []).filter((step, index, list) => {
    const prev = list[index - 1];
    return !(prev?.action === 'click_viewport' && step.action === 'click');
  });
  return { steps: kept, dropped: (steps ?? []).length - kept.length };
}

/**
 * 跑一顆積木。
 *
 * @param {object} step 積木
 * @param {{
 *   idx: string,                 顯示用的 [3/10]
 *   label: string,               顯示用的步驟名稱
 *   log: (line: string) => Promise<void> | void,
 *   page: import('playwright').Page,
 *   browser: import('playwright').Browser | null,
 *   recordedLocator: (selector: string) => Promise<import('playwright').Locator>,
 *   netCapture: { records: () => object[] } | null,
 *   state: { netMark: number },  ⚠️ goto 會改它，所以是可變物件不是值
 *   startUrl: string,
 *   viewportHeight: number,
 *   backend: { backendUrl: string, username: string, password: string } | null,
 *   loadBaseline?: (step: object) => Promise<{ name: string, template: object, threshold: number }>,
 *   compareTemplate?: (shotPng: Buffer, template: object, threshold: number) => { x: number, y: number, diff: number } | null,
 *   decodePng?: (buffer: Buffer) => object,
 * }} ctx
 */
export async function runFrontendStep(step, ctx) {
  const { idx, label, log, page } = ctx;
  /**
   * 這一步產出的證據檔（目前只有截圖積木會放東西進來）。
   *
   * ⚠️ 回傳值是**後加的**，舊的兩個 host 都沒在收——所以一律回一個物件，
   * 不能改成「有東西才回」，不然接收端得多判一次 undefined。
   */
  const shots = [];

  if (step.action === 'goto') {
    const target = step.value || ctx.startUrl;
    await log(`⏳ ${idx} ${label} → ${target}`);
    // ⚠️ **netMark 要設在導頁之前，不是之後。**
    // 「開這頁時打了哪些後端」正是最常要驗的東西——設在 goto 完成又等三秒之後的話，
    // 載入期間那批 API 全部落在界線之前，assert_api_called 會永遠看到 0 支。
    // Backend 的 block-engine 早就踩過這個坑（也是實測才發現）。
    ctx.state.netMark = Date.now();
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    /**
     * 🚨 **上一輪的位子還佔著時，載入會直接掉進機台。**
     *
     * 要去的是大廳，站台卻把我們送回 /game——後面所有大廳積木會全部命中 0，
     * 而錯誤訊息長得像選擇器寫錯（實測某一輪大廳 3/4/6/9 四步全掛、機台內 12～19 全過）。
     * PC 版早就有這道防線（`pcBackToLobby`），H5 一直沒有。
     *
     * ⚠️ 只在「目標不是 /game」時才退出。腳本如果本來就要直接進機台，
     *    這裡把人踢回大廳會變成我們自己弄壞測試。
     */
    if (h5InGame(page) && !String(target).includes('/game')) {
      await log(`⚠️ ${idx} ${label}：載入後直接掉進機台（上一輪的位子還佔著）→ 先退回大廳`);
      const back = await h5BackToLobby(page, { log });
      await log(`${back.ok ? '✅' : '❌'} 退回大廳${back.ok ? '成功' : '失敗'}：${back.steps.join(' → ') || '(沒點到任何按鈕)'}`);
      if (back.ok) await page.waitForTimeout(3000);
    }
    await log(`✅ ${idx} ${label}`);
    return { shots };
  }

  if (step.action === 'click') {
    // 🚨 守衛要在**動作之前**（CodeX 2026-09-20）：點完才警告就來不及了，
    //    機台已經被預約、錢已經轉出去。見 dangerous-actions.js。
    guardDangerousStep({ step, what: { selector: step.selector, text: step.name }, startUrl: ctx.startUrl });
    markWsBefore(ctx);
    await log(`⏳ ${idx} ${label}`);
    /**
     * 🚨 **被蓋住的按鈕要有退路，否則只會看到一句 `Timeout 10000ms exceeded`。**
     *
     * 2026-09-19 實測（H5 機台內選面額）：`.btn_bet >> nth=1` 唯一命中、畫面上看得到、
     * 也沒有彈窗，但 `locator.click()` 一直 timeout——「SELECT A DENOMINATION」那圈
     * 發光的托盤蓋在按鈕上，攔截了 pointer events。Playwright 會一直等它變成可點，
     * 等到逾時為止，而錯誤訊息完全看不出「是被蓋住」。
     *
     * Backend 早就有 `clickRecorded`：先正常點，被擋就對**同一個已解析節點**呼叫
     * `el.click()`（事件照樣冒泡到 Vue 的 handler）。H5 這邊沒跟上，所以一樣的頁面
     * Backend 點得動、H5 點不動。
     *
     * ⚠️ `allowFallback` 只開到 JS 那一層——**不給座標退路**。
     *    座標會真的在那個位置按下去，把「不知道該點哪」變成一個看不見的誤點
     *    （`clickRecorded` 內部已經擋掉歧義錯誤，不會進退路）。
     */
    const target = await ctx.recordedLocator(step.selector ?? '');
    await clickRecorded({
      page: ctx.page, locator: target, selector: step.selector ?? '',
      allowFallback: true,
      viewportOk: async () => false,   // 不允許座標退路
      log,
    });
    await log(`✅ ${idx} ${label}`);
    return { shots };
  }

  if (step.action === 'pc_enter_machine') {
    markWsBefore(ctx);
    const pc = requirePc(ctx, 'PC 進機台');
    const want = (step.value ?? '').trim();
    // 留空的話要挑哪一台？「隨便一台」不是測試，是抽籤——報告上會看不出測的是什麼
    if (!want) throw new Error('要指定機台：填 `Rising Rockets` 會挑同款空的一台，填 `Rising Rockets Emperor-141` 指定那一台');
    await log(`⏳ ${idx} ${label} → ${want}`);

    await pc.installEvalShim(page);
    const diag = await pc.waitLobby(page, 30000);
    if (!diag.ready) throw new Error(`大廳沒就緒：${pc.describeLobby(diag)}`);
    // JACKPOT／廣告彈窗是畫在 canvas 上的節點，DOM 關不掉，要把節點 active 設成 false
    const closed = await pc.closePopups(page);
    if (closed) await log(`   🧹 關掉 ${closed} 個彈窗節點`);

    /**
     * ⚠️ **挑到一台不等於進得去，所以要換一台再試。**
     *    從「看到它空著」到「捲回來點它」中間過了好幾秒，別人可能已經坐下；
     *    也可能點在卡片的空白處。實測第一次就遇到（`點了 (292, 667) 但還停在大廳`）。
     *    `pcSeekMachine` 的 `skip` 就是為這件事準備的——不跳過的話會對著同一台原地重試。
     *
     * ⚠️ 上限 3 次。失敗要看得出「試過哪幾台、各自為什麼」，不要只留最後一次的訊息。
     */
    /**
     * 🚨 **整段期間要盯著關彈窗，關一次不夠。**
     *    實測：進迴圈前關過、點之前也關過，點下去還是停在大廳——截圖顯示點擊當下
     *    畫面中央又有一張「WIN THE JACKPOT」（畫在 canvas 上，會把點擊整個吃掉）。
     *    seek + 捲動 + 再確認要好幾秒，那段時間只要有人中獎就會再播一張。
     *    H5 早就有看門狗（`startLobbyPopupWatcher`），PC 這邊是這次才補上。
     */
    const stopWatcher = pc.startPopupWatcher(page, {
      onClose: (n) => { void log(`   🧹 看門狗關掉 ${n} 個彈窗節點`); },
    });
    try {
    /**
     * 🚨 **剛載完的大廳要先捲一輪，卡片才點得動。**
     *
     * 實測 2026-09-19：載入後直接挑機台去點，`點了 (292, 712) 但還停在大廳`——
     * 畫面上那張卡是**黑的**（快照還沒載）。而在另一輪（前面剛好做過一次全清單搜尋、
     * 捲過整個列表）同樣的座標一點就進去了。差別只有「有沒有捲過」。
     * 場景樹裡 699 個 `machine_item` 一開始就存在，**被延後生成的是文字與圖**，
     * 所以「找得到名字」不代表「那張卡已經畫出來可以點」。
     *
     * ⚠️ 不要用這裡的台數當判準——它是現場資料，只拿來讓人看得出有沒有捲到東西。
     */
    // ⚠️ 捲的步數不能省。實測 8 步不夠、把整個清單捲過一輪（40 步）才點得進去——
    //    差別就在目標那張卡有沒有被真的畫出來
    const warm = await pc.collectMachines(page, { steps: 40 });
    await log(`   🔄 先捲一輪讓卡片畫出來（看到 ${warm.machines?.length ?? 0} 台${warm.partial ? '、清單還沒掃完' : ''}）`);
    const skip = new Set();
    const tried = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const seek = await pc.seekMachine(page, want, { skip });
      /**
       * 🚨 **點之前要再關一次彈窗。**
       *
       * 進迴圈前關過了，但 seek 要花好幾秒，中間只要有人中獎就會再播一張
       * 「WIN THE JACKPOT」——它是畫在 canvas 上的節點，**會把整個畫面的點擊吃掉**。
       * 症狀是 `點了 (292, 712) 但還停在大廳`，看起來像座標算錯或機台被佔用，
       * 實際上座標是對的、機台也是空的（實測截圖裡那張彈窗就蓋在畫面中央）。
       */
      const reclosed = await pc.closePopups(page);
      if (reclosed) await log(`   🧹 點之前又冒出 ${reclosed} 個彈窗節點，已關掉`);
      if (!seek.picked) {
        const why = `找不到可用的「${want}」：看過 ${seek.scanned} 台，同款 ${seek.matched.total} 台、其中 ${seek.matched.free} 台空著`;
        throw new Error(tried.length ? `${why}；先前試過 ${tried.join('、')}` : why);
      }
      const entered = await pc.enterMachine(page, seek.picked.name);
      // 🚨 **點座標會點到隔壁**（實測：目標 Ingot-NWR2017、進去卻是 NWR2024）。
      //    所以這裡報告的是「實際進到哪一台」，而且要讓它留在 log 裡——
      //    不講的話報告會寫著 A 機台、證據圖卻是 B 機台拍的，畫面上完全看不出來。
      if (entered.entered) {
        await log(`✅ ${idx} ${label}（第 ${attempt} 次：挑中 ${seek.picked.name}、實際進到 ${entered.actual}）`);
        return { shots };
      }
      tried.push(`${seek.picked.name}（${entered.reason ?? `場景 ${entered.scene || '讀不到'}`}）`);
      await log(`   ↻ 第 ${attempt} 次沒進去：${tried[tried.length - 1]}`);
      skip.add(seek.picked.name);
    }
    throw new Error(`連續 3 台都進不去：${tried.join('；')}`);
    } finally {
      // ⚠️ 一定要停。不停的話頁面關掉之後看門狗還在戳它，log 會冒出一堆無關的錯
      stopWatcher();
    }
  }

  if (step.action === 'scroll') {
    await log(`⏳ ${idx} ${label}`);
    const raw = (step.value ?? '').trim().toLowerCase();
    const sel = (step.selector ?? '').trim();
    /**
     * H5（DOM）捲動。三種用法：
     *   - 有 selector、value 空 → 把那個元素捲進畫面（`scrollIntoView`）
     *   - value = `top` / `bottom` → 捲到頭／捲到底
     *   - value = 數字 → 相對捲動幾個 px（負數往上）
     *
     * ⚠️ **不是每個頁面都靠 window 捲。** 這種行動版版面常常是內層容器在捲，
     *    `window.scrollBy` 會完全沒反應而且不報錯。所以沒指定 selector 時，
     *    會自己找「真的捲得動」的那個容器（scrollHeight 比 clientHeight 大的最大那個），
     *    找不到才退回 window——並且**把用了哪一個寫進 log**，不然完全看不出是誰在捲。
     */
    const result = await page.evaluate(({ raw, sel }) => {
      const pickScroller = () => {
        let best = null; let bestArea = 0;
        for (const el of document.querySelectorAll('div, main, section, ul')) {
          const canScroll = el.scrollHeight - el.clientHeight > 40;
          if (!canScroll) continue;
          const st = getComputedStyle(el);
          if (!/(auto|scroll)/.test(st.overflowY)) continue;
          const r = el.getBoundingClientRect();
          const area = r.width * r.height;
          if (area > bestArea) { best = el; bestArea = area; }
        }
        return best;
      };
      if (sel) {
        const target = document.querySelector(sel);
        if (!target) return { ok: false, how: '', message: `找不到 ${sel}` };
        if (!raw) { target.scrollIntoView({ block: 'center' }); return { ok: true, how: `scrollIntoView(${sel})` }; }
      }
      const scroller = sel ? document.querySelector(sel) : (pickScroller() ?? document.scrollingElement ?? document.body);
      if (!scroller) return { ok: false, how: '', message: '找不到可以捲的容器' };
      const how = sel || (scroller === document.scrollingElement ? 'window' : `.${String(scroller.className ?? '').split(' ')[0] || scroller.tagName}`);
      const before = scroller.scrollTop;
      if (raw === 'bottom') scroller.scrollTop = scroller.scrollHeight;
      else if (raw === 'top') scroller.scrollTop = 0;
      // `to:<N>`＝**捲到絕對位置**。錄製器錄的是這種：相對位移在「內容長度跟錄的時候不一樣」
      // 時會落在完全不同的地方，而絕對位置至少是可解釋的。
      else if (raw.startsWith('to:')) scroller.scrollTop = Number(raw.slice(3)) || 0;
      else scroller.scrollTop = before + (Number(raw) || 0);
      return { ok: true, how, before, after: scroller.scrollTop };
    }, { raw, sel });
    if (!result.ok) throw new Error(result.message ?? '捲不動');
    await page.waitForTimeout(1200);
    await log(`✅ ${idx} ${label}（${result.how}${result.after !== undefined ? `：${result.before} → ${result.after}` : ''}）`);
    return { shots };
  }

  if (step.action === 'pc_scroll') {
    const pc = requirePc(ctx, 'PC 捲動');
    await log(`⏳ ${idx} ${label}`);
    /**
     * 🚨 **要捲哪一份清單一定要講清楚。**
     *
     * 實測 2026-09-19：排行榜頁開著時呼叫 `pc_scroll`，它去捲**被蓋在底下的大廳清單**
     * （`ScrollView-gms`），然後回報「捲到 50%」——畫面上什麼都沒變，積木卻是綠的。
     * 排行榜的項目 `item-jp` 位置 298 → 298，完全沒動。**那是最糟的一種假通過。**
     *
     * 所以：`selector` 欄位在這顆積木裡是**清單的節點名**（例如排行榜頁的 `ScrollView-jp`）。
     * 不填＝大廳那份；填了卻找不到＝**明確失敗**，不會偷偷改捲別的。
     */
    const listName = (step.selector ?? '').trim() || undefined;
    const rawInput = (step.value ?? '').trim();
    const raw = rawInput.toLowerCase();

    /**
     * `find:<節點>` —— **一路捲到那個節點進到視窗裡為止**。
     *
     * 🚨 為什麼需要它：`how_to_play` 這種節點掛在「某一列遊戲」上，
     *    一開始算出來的位置是 (1188, **-1184**)——在視窗外，點不到。
     *    而「捲到 30%」也不保證它就會進來（實測反而跑得更遠：y -1184 → -1568）。
     *    所以要能說「捲到我看得到它為止」，而不是叫人自己猜百分比。
     *
     * ⚠️ 找不到就**明確失敗**，不要停在最後一格假裝成功。
     */
    if (raw.startsWith('find:')) {
      const wantNode = rawInput.slice(5).trim();
      if (!wantNode) throw new Error('`find:` 後面要接節點名稱，例如 `find:how_to_play`');
      const tried = [];
      for (let i = 0; i <= 20; i++) {
        const f = i / 20;
        const r = await pc.scrollToFraction(page, f, listName);
        if (r.status !== 'ok') throw new Error(describeScrollFail(r.status, listName));
        await page.waitForTimeout(700);
        const node = await pc.findNode(page, wantNode);
        if (node?.inViewport) {
          await log(`✅ ${idx} ${label}（捲到 ${Math.round(f * 100)}% 時「${wantNode}」進到視窗，@${node.x},${node.y}）`);
          return { shots };
        }
        if (node) tried.push(`${Math.round(f * 100)}%:y=${node.y}`);
      }
      throw new Error(`整份清單都捲過了，「${wantNode}」始終沒有進到視窗內${tried.length ? `（試過 ${tried.slice(0, 6).join('、')}…）` : '（連節點都找不到）'}`);
    }

    // PC 是 Cocos 的 ScrollView，其餘用法是「捲到整份清單的百分之幾」
    const frac = raw === 'top' ? 0 : raw === 'bottom' ? 1 : Math.min(1, Math.max(0, Number(raw)));
    if (Number.isNaN(frac)) throw new Error('要填 `top`、`bottom`、0~1 之間的比例（例如 0.3），或 `find:<節點名>`');
    /**
     * 🚨 **不能用「瞬間跳過去」。** `scrollToOffset(pos, 0)` 列表收不到 scrolling 事件，
     *    卡片上的文字與圖不會生出來（實測：瞬跳整輪只撈到 29 台，改成 0.25 秒動畫撈到 695 台）。
     *    `pcScrollToFraction` 內部已經用 0.25 秒動畫，這裡只要等它跑完。
     */
    const res = await pc.scrollToFraction(page, frac, listName);
    if (res.status !== 'ok') throw new Error(describeScrollFail(res.status, listName));
    await page.waitForTimeout(2000);
    await log(`✅ ${idx} ${label}（${res.sv}：${res.before} → ${res.after}，整份的 ${Math.round(frac * 100)}%）`);
    return { shots };
  }

  if (step.action === 'pc_click_node') {
    markWsBefore(ctx);
    const pc = requirePc(ctx, 'PC 點節點');
    const want = (step.value ?? '').trim();
    if (!want) throw new Error('要填節點名稱或標籤文字，例如 `btn-road`（節點名）或 `Road`（畫面上的字）');
    guardDangerousStep({ step, what: { node: want, text: step.name }, startUrl: ctx.startUrl });
    await log(`⏳ ${idx} ${label} → ${want}`);
    // 點之前關一次彈窗：中獎彈窗會把整個畫面的點擊吃掉（見 pc-cocos.ts 的說明）
    const closed = await pc.closePopups(page);
    if (closed) await log(`   🧹 關掉 ${closed} 個彈窗節點`);
    const res = await pc.clickNode(page, want);
    if (!res.ok) throw new Error(res.reason ?? `點不到「${want}」`);
    await log(`✅ ${idx} ${label}（點在 ${res.name} @${res.at.x},${res.at.y}）`);
    return { shots };
  }

  if (step.action === 'assert_pc_node') {
    const pc = requirePc(ctx, 'PC 驗節點');
    const want = (step.value ?? '').trim();
    if (!want) throw new Error('要填節點名稱或標籤文字');
    await log(`⏳ ${idx} ${label}`);
    /**
     * ⚠️ **要等。** 面板是動畫展開的，點完馬上驗會抓到「還沒建出來」。
     *    但條件一直不成立時照樣失敗——驗收腳本有故意指不存在的節點確認會紅。
     */
    const deadline = Date.now() + 15_000;
    let node = await pc.findNode(page, want);
    while (!node && Date.now() < deadline) {
      await page.waitForTimeout(1000);
      node = await pc.findNode(page, want);
    }
    if (!node) throw new Error(`場景樹裡找不到「${want}」（等了 15 秒；名稱與標籤都比過了）`);
    await log(`✅ ${idx} ${label}（${node.name}${node.label ? ` 「${node.label}」` : ''} @${node.x},${node.y}${node.inViewport ? '' : '、⚠️ 在視窗外'}）`);
    return { shots };
  }

  if (step.action === 'assert_pc_scene') {
    const pc = requirePc(ctx, 'PC 驗場景');
    await log(`⏳ ${idx} ${label}`);
    const wantScene = (step.value ?? '').trim() || 'lobby';
    // 場景樹要先掛 shim 才讀得到（這顆積木可能是腳本的第一顆，不能假設前面已經掛過）
    await pc.installEvalShim(page);

    /**
     * 🚨 **要等，不能只取樣一次。**
     *
     * PC 客戶端載入後場景先是 `start`，過幾秒才變 `lobby`——實測 `goto` 之後
     * 立刻驗「大廳」會抓到 `start` 而**紅在時間差上**，看起來像功能壞了。
     * 反過來如果只放寬判定（例如把 start 也算大廳），那才是真的把斷言弄假。
     * 所以做法跟 Playwright 的斷言一樣：**在期限內反覆看，變成預期就過，到期沒變才紅。**
     *
     * ⚠️ 這不是放水：條件一直不成立時照樣失敗（驗收腳本有故意造反例確認會紅）。
     */
    const deadline = Date.now() + 30_000;
    let scene = await pc.sceneName(page);
    while (scene !== wantScene && Date.now() < deadline) {
      await page.waitForTimeout(1000);
      scene = await pc.sceneName(page);
    }
    if (scene !== wantScene) throw new Error(`場景是「${scene || '讀不到'}」，但預期「${wantScene}」（等了 30 秒）`);
    // ⚠️ 「場景叫 lobby」跟「大廳能用」不是同一件事：機台清單可能還沒建出來，
    //    那時候後面每一步都會失敗，而錯誤訊息完全指不到這裡。
    if (wantScene === 'lobby') {
      const diag = await pc.waitLobby(page, Math.max(3000, deadline - Date.now()));
      if (!diag.ready) throw new Error(`場景是大廳，但清單沒建出來：${pc.describeLobby(diag)}`);
    }

    /**
     * ⚠️ `selector` 這個欄位在這顆積木裡是**機台名稱**，不是 CSS——PC 沒有 DOM 可選。
     *    共用欄位是為了不動 `step-model.ts` 那兩份「寫出去／讀回來」的白名單
     *    （只補一邊的話欄位會存得進去卻讀不回來，而且完全不報錯）。編輯器那邊的
     *    標籤有跟著換成「機台名稱」。
     *
     * 🚨 **名稱是當場從場景樹讀的**，不是拿我們自己記下來的值回頭對——
     *    用自己推導出來的東西檢查自己，永遠會通過。
     */
    const wantName = (step.selector ?? '').trim();
    if (wantName) {
      if (wantScene !== 'game') throw new Error('機台名稱只有在「機台內（game）」才讀得到，場景請選 game');
      const actual = await pc.inGameMachineName(page);
      if (!actual) throw new Error('場景是 game，但讀不到機台名稱（節點還沒建好？）');
      if (!actual.includes(wantName)) throw new Error(`人在「${actual}」，但預期是「${wantName}」`);
      await log(`✅ ${idx} ${label}（場景 ${scene}、機台 ${actual}）`);
      return { shots };
    }

    // 大廳：順便把「掃得到幾台」講出來。⚠️ 只報數字**不當門檻**——
    // 台數是現場資料（會因為上下架、佔用而變），寫死成驗收條件會變成假紅燈
    if (wantScene === 'lobby') {
      const machines = await pc.scanLobby(page, { onScreenOnly: true });
      await log(`✅ ${idx} ${label}（場景 ${scene}、畫面上 ${machines.length} 台、其中 ${machines.filter(m => !m.occupied).length} 台空著）`);
      return { shots };
    }
    await log(`✅ ${idx} ${label}（場景 ${scene}）`);
    return { shots };
  }

  if (step.action === 'press_key') {
    markWsBefore(ctx);
    await log(`⏳ ${idx} ${label}`);
    const key = (step.value ?? '').trim();
    if (!key) throw new Error('要填按鍵名稱，例如 `Space`、`Enter`、`ArrowDown`');
    /**
     * 鍵盤操作。PC（Cocos）機台內的 SPIN 就是靠這個——
     * 實測空白鍵與 Enter 都會送出 `dealGMActionReq {actionid: 7, isspin: 1}`，
     * 跟 TC 寫的「SPIN功能 > 可以用鍵盤空白鍵、Enter可觸發」一致。
     *
     * ⚠️ 焦點要在頁面上。Cocos 是掛在 document 上聽鍵盤的，所以先點一下畫布再按——
     *    不點的話事件可能被瀏覽器吃掉，症狀是「按了完全沒反應」。
     *    ⚠️ 點的是**畫布中央偏上**的位置，避開下方那排下注／帶入按鈕（那些會動到餘額）。
     */
    const canvas = page.locator('canvas').first();
    if (await canvas.count()) {
      const box = await canvas.boundingBox();
      if (box) await page.mouse.click(Math.round(box.x + box.width / 2), Math.round(box.y + box.height * 0.3));
    }
    await page.waitForTimeout(500);
    await page.keyboard.press(key);
    await log(`✅ ${idx} ${label}（按了 ${key}）`);
    return { shots };
  }

  if (step.action === 'read_value') {
    await log(`⏳ ${idx} ${label}`);
    /**
     * 把畫面上的一個值讀下來存成變數，之後用「比對兩個值」對照。
     *
     * 🚨 **為什麼需要**：前台原本只有「驗這一格的文字是不是 X」，
     *    驗不了「大廳顯示的餘額 = 機台內顯示的餘額」「下注後餘額 = 下注前 − 注額」——
     *    那些都要先把兩個地方的數字**同時**握在手上。
     */
    const vars = frontendVars(ctx);
    const name = (step.as ?? '').trim();
    if (!name) throw new Error('要填變數名稱');
    if (name in vars && step.overwrite !== true) {
      // ⚠️ 靜默覆寫會讓後面引用的到底是哪一次的值完全看不出來（後台同一條規則）
      throw new Error(`變數名「${name}」重複。換個名字，或勾「允許覆寫」`);
    }
    const domSel = (step.selector ?? '').trim();
    const nodeName = (step.nodeName ?? '').trim();
    if (!!domSel === !!nodeName) throw new Error('要**擇一**填：DOM 選擇器（H5）或 Cocos 節點名（PC）');
    let value;
    if (domSel) {
      if (!(await page.locator(domSel).count())) throw new Error(`找不到 ${domSel}`);
      const target = page.locator(domSel).first();
      value = (await target.innerText().catch(() => target.textContent())) ?? '';
    } else {
      const text = await pcNodeText(page, nodeName);
      if (text === null) throw new Error(`場景樹裡找不到「${nodeName}」`);
      value = text;
    }
    vars[name] = String(value).replace(/\s+/g, ' ').trim();
    await log(`✅ ${idx} ${label}（${name} = ${String(vars[name]).slice(0, 40)}）`);
    return { shots };
  }

  if (step.action === 'assert_compare') {
    await log(`⏳ ${idx} ${label}`);
    /**
     * 比對兩個算式。左右兩邊都可以是**變數、數字或算式**（`before - bet`）。
     * ⚠️ 算式走共用的解析器（`expr.js`），**沒有 eval**——認不得的東西一律報錯。
     */
    const vars = frontendVars(ctx);
    const lookup = (nameRef) => nameRef.split('.').reduce((cur, part) => (cur === undefined || cur === null ? cur : cur[part]), vars);
    const tol = Number(step.tolerancePct ?? 0), abs = Number(step.absoluteTolerance ?? 0);
    if (!Number.isFinite(tol) || tol < 0 || !Number.isFinite(abs) || abs < 0) throw new Error('容差必須是大於等於 0 的數字');
    let lv, rv;
    try {
      lv = evaluateExpr(step.value ?? '', lookup, frontendToNumber);
      rv = evaluateExpr(step.expect ?? '', lookup, frontendToNumber);
    } catch (error) {
      // 算式寫錯 ≠ 數字對不上，訊息要分得出來
      throw new Error(`算式沒辦法求值——${error.message}`);
    }
    if (!frontendNumbersEqual(lv, rv, tol, abs)) {
      throw new Error(`${step.value} = ${lv}，但 ${step.expect} = ${rv}（容差 ${tol}%／${abs}）`);
    }
    await log(`✅ ${idx} ${label}（${step.value} = ${lv} ≈ ${step.expect} = ${rv}）`);
    return { shots };
  }

  if (step.action === 'wait_for') {
    await log(`⏳ ${idx} ${label}`);
    /**
     * 等到某件事成立，而不是等固定秒數。
     *
     * 🚨 **固定秒數是 flaky 的最大來源**：填太短會偶爾紅，而且紅在**下一顆**積木上，
     *    看起來像選擇器寫錯；填太長則每支腳本都白等十幾秒。
     * ⚠️ 等不到要**明確失敗**——等完就當過了，等於把「頁面沒反應」寫成「跑完了」。
     */
    const until = String(step.until || 'visible');
    const sel = (step.selector ?? '').trim();
    const nodeName = (step.nodeName ?? '').trim();
    const wantText = String(step.value ?? '').trim();
    const timeoutMs = Math.min(Math.max(Number(step.timeoutMs) || 15000, 500), 600000);
    if (until === 'node' && !nodeName) throw new Error('等 Cocos 節點就要填節點名或路徑');
    if (until === 'text' && !wantText) throw new Error('等文字出現就要填那段文字');
    if ((until === 'visible' || until === 'hidden') && !sel) throw new Error('這個等待條件需要填 DOM 選擇器');

    const started = Date.now();
    let met = false;
    while (Date.now() - started < timeoutMs) {
      if (until === 'node') {
        const pc = requirePc(ctx, '等 Cocos 節點');
        const node = await pc.findNode(page, nodeName).catch(() => null);
        if (node?.found) { met = true; break }
      } else if (until === 'text') {
        const body = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
        if (String(body).includes(wantText)) { met = true; break }
      } else {
        const visible = await page.locator(sel).first().isVisible().catch(() => false);
        if (until === 'visible' ? visible : !visible) { met = true; break }
      }
      await page.waitForTimeout(300);
    }
    if (!met) {
      const what = until === 'node' ? `節點「${nodeName}」出現`
        : until === 'text' ? `文字「${wantText}」出現`
          : until === 'hidden' ? `${sel} 消失` : `${sel} 出現`;
      throw new Error(`等了 ${timeoutMs}ms，${what}還是沒發生`);
    }
    await log(`✅ ${idx} ${label}（${Math.round((Date.now() - started) / 100) / 10}s 後條件成立）`);
    return { shots };
  }

  if (step.action === 'assert_text') {
    await log(`⏳ ${idx} ${label}`);
    /**
     * 驗畫面上的文字／數字。
     *
     * 🚨 **PC 不需要 OCR。** 整個畫面雖然是 canvas，文字本身還是 Cocos label 上的字串，
     *    直接讀比截圖辨識準（不怕字體、動畫、背景色），而且零依賴。
     *    （資產面板那個「辨識區域（OCR）」只有資料表沒有引擎，別把它當成這顆的替代。）
     *
     * 欄位：`selector`＝DOM 選擇器（H5）／`nodeName`＝Cocos 節點或路徑（PC），二選一；
     *       `value`＝期望值；`matchMode`＝contains（預設）／equals／regex／number。
     *       number 模式的期望值可以帶比較符號：`>=100`、`<50`、`=0`。
     */
    const domSel = (step.selector ?? '').trim();
    const nodeName = (step.nodeName ?? '').trim();
    if (!!domSel === !!nodeName) throw new Error('要**擇一**填：DOM 選擇器（H5）或 Cocos 節點名／路徑（PC）');
    const want = String(step.value ?? '').trim();
    if (!want) throw new Error('要填期望的文字；數值模式可以寫 `>=100`、`<50`、`=0`');
    const mode = step.matchMode || 'contains';

    let actual;
    if (domSel) {
      const target = page.locator(domSel).first();
      if (!(await page.locator(domSel).count())) throw new Error(`找不到 ${domSel}`);
      actual = (await target.innerText().catch(() => target.textContent())) ?? '';
    } else {
      const pcText = await pcNodeText(page, nodeName);
      // ⚠️ null＝找不到節點，''＝節點上沒有字。兩者要分開報，不然查起來完全是兩回事
      if (pcText === null) throw new Error(`場景樹裡找不到「${nodeName}」`);
      actual = pcText;
    }
    const seen = String(actual).replace(/\s+/g, ' ').trim();

    let ok = false;
    let how = '';
    if (mode === 'number') {
      const m = want.match(/^(>=|<=|>|<|=)?\s*(.+)$/);
      const op = m?.[1] ?? '=';
      const target = toNumber(m?.[2]);
      const got = toNumber(seen);
      if (target === null) throw new Error(`期望值「${want}」不是數字`);
      if (got === null) throw new Error(`畫面上讀到的「${seen.slice(0, 40)}」轉不成數字`);
      ok = op === '>' ? got > target : op === '>=' ? got >= target
        : op === '<' ? got < target : op === '<=' ? got <= target : got === target;
      how = `讀到 ${got}，要求 ${op} ${target}`;
    } else if (mode === 'equals') {
      ok = seen === want;
      how = `讀到「${seen.slice(0, 60)}」，要求完全等於「${want}」`;
    } else if (mode === 'regex') {
      let re;
      try { re = new RegExp(want); } catch (e) { throw new Error(`正則寫錯：${e.message}`); }
      ok = re.test(seen);
      how = `讀到「${seen.slice(0, 60)}」，要求符合 /${want}/`;
    } else {
      ok = seen.includes(want);
      how = `讀到「${seen.slice(0, 60)}」，要求包含「${want}」`;
    }
    if (!ok) throw new Error(`文字不符：${how}`);
    await log(`✅ ${idx} ${label}（${how}）`);
    return { shots };
  }

  if (step.action === 'require_precondition') {
    await log(`⏳ ${idx} ${label}`);
    /**
     * 前置條件。**不成立時整筆 TC 判「受阻」，不是 FAIL、也不是 PASS。**
     *
     * 🚨 **為什麼一定要分這一態**：像「Lucky Hour Bonus 活動要開著」「要有同款的第二台空機」
     *    這種條件，環境沒備好時腳本一定過不了。判 FAIL 會變成**謊報 bug**（對照 Lark 上
     *    那一格紅字，RD 會真的去查一個不存在的問題）；判 PASS 更糟；判「待確認」則會混在
     *    一堆真的需要人看的項目裡，看不出是環境沒開。所以要有 `blocked`。
     *
     * ⚠️ CodeX 2026-09-20 的兩條邊界，這裡都遵守：
     *    ① **前置檢查自己壞掉不可以吞成 blocked。** 只有「條件乾淨地判定為不成立」才 blocked；
     *       頁面掛了、Cocos 不在、選擇器寫成歧義——那些是我們自己的錯，照樣 FAIL。
     *    ② **若「那個條件」本身就是這條 TC 要驗的東西，就不該用這顆積木**（那是 fail）。
     *       所以說明欄位是必填的：寫不出「為什麼這是環境不是驗收項」就不該放這顆。
     *
     * 欄位：`selector`＝DOM 選擇器（H5）／`value`＝Cocos 節點名或標籤（PC），二選一；
     *       `reason`＝不成立時要寫進報告的說明（必填）。
     */
    const reason = (step.reason ?? '').trim();
    if (!reason) throw new Error('前置條件要填「不成立時的說明」——寫不出為什麼這是環境問題，就代表它其實是驗收項');
    const domSel = (step.selector ?? '').trim();
    const nodeName = (step.value ?? '').trim();
    if (!!domSel === !!nodeName) throw new Error('前置條件要**擇一**填：DOM 選擇器（H5）或 Cocos 節點名（PC）');

    let satisfied;
    if (domSel) {
      // ⚠️ 這裡用 count() 而不是 recordedLocator：命中多筆對「在不在」來說不是歧義。
      //    真正的錯誤（頁面關掉之類）會從這裡 throw 出去 → FAIL，不會變成 blocked。
      const n = await page.locator(domSel).count();
      satisfied = n > 0 && await page.locator(domSel).first().isVisible().catch(() => false);
    } else {
      const pc = requirePc(ctx, '前置條件（PC 節點）');
      const node = await pc.findNode(page, nodeName);
      satisfied = !!node?.found;
    }
    if (!satisfied) throw new Error(`${PRECONDITION_PREFIX}${reason}（找不到 ${domSel || nodeName}）`);
    await log(`✅ ${idx} ${label}（前置條件成立）`);
    return { shots };
  }

  if (step.action === 'click_xy') {
    const underXy = await pcNodeAtPoint(page, step.x ?? 0, step.y ?? 0).catch(() => null);
    guardDangerousStep({ step, what: { node: underXy?.id ?? underXy?.name ?? '', text: underXy?.label || step.name }, startUrl: ctx.startUrl });
    markWsBefore(ctx);
    await log(`⏳ ${idx} ${label}`);
    await page.locator('canvas').first().click({ position: { x: step.x ?? 0, y: step.y ?? 0 }, timeout: 10000 });
    await log(`✅ ${idx} ${label}`);
    return { shots };
  }

  if (step.action === 'click_viewport') {
    /**
     * ⚠️ **座標點擊也要守。** 只守 `click`／`pc_click_node` 的話，
     *    舊腳本（或反查失敗退回座標的那些）就繞過整道防線了——而且看不出來。
     *    這裡先把座標反查成節點再判斷；反查不到就只剩步驟名稱可看（弱訊號，不擋）。
     */
    const under = await pcNodeAtPoint(page, step.x ?? 0, step.y ?? 0).catch(() => null);
    guardDangerousStep({ step, what: { node: under?.id ?? under?.name ?? '', text: under?.label || step.name }, startUrl: ctx.startUrl });
    markWsBefore(ctx);
    await log(`⏳ ${idx} ${label}${under?.name ? `（這個位置是節點 ${under.name}）` : ''}`);
    await page.mouse.click(step.x ?? 0, step.y ?? 0);
    await page.waitForTimeout(500);
    await log(`✅ ${idx} ${label}`);
    return { shots };
  }

  if (step.action === 'type' || step.action === 'fill') {
    // ⚠️ `fill` 是 agent 模式舊錄製器的動作名。少了它的話，那些舊腳本會落到
    //    「不認得的動作」而失敗——留著是為了相容，新錄的一律是 type。
    await log(`⏳ ${idx} ${label}`);
    await (await ctx.recordedLocator(step.selector ?? '')).fill(step.value ?? '', { timeout: 10000 });
    await log(`✅ ${idx} ${label}`);
    return { shots };
  }

  if (step.action === 'wait') {
    await log(`⏳ ${idx} ${label}`);
    await page.waitForTimeout(Number(step.value) || 1000);
    await log(`✅ ${idx} ${label}`);
    return { shots };
  }

  if (step.action === 'screenshot') {
    await log(`⏳ ${idx} ${label}`);
    // ⚠️ **拍了就要留得下來。** 這顆積木原本是 `await page.screenshot()` 然後把 Buffer
    //    丟掉——畫面上那個 ✅ 看起來拍好了，但**沒有任何地方存得到那張圖**。
    //    綁了 TC 的腳本要把截圖當證據回寫 Lark，所以由 host 提供「存到哪」。
    //    host 沒提供時維持舊行為（只是把畫面拍一次確認頁面還活著）。
    if (ctx.takeScreenshot) {
      const shot = await ctx.takeScreenshot(step.name || label || 'screenshot');
      if (shot) shots.push(shot);
    } else {
      await page.screenshot();
    }
    await log(`✅ ${idx} ${label}`);
    return { shots };
  }

  if (step.action === 'find_baseline_scroll') {
    await log(`⏳ ${idx} ${label}`);
    // ⚠️ 這顆積木**以前只有伺服器端有**，agent 上被靜默跳過。現在由 host 提供
    //    「怎麼拿到基準圖」，拿不到就**明確失敗**——不能再變回跳過。
    if (!ctx.loadBaseline || !ctx.compareTemplate || !ctx.decodePng) {
      throw new Error('這個執行環境無法取得基準圖（host 沒有提供 loadBaseline）——請更新 Agent 程式碼');
    }
    const baseline = await ctx.loadBaseline(step);
    const threshold = typeof step.threshold === 'number' ? step.threshold : baseline.threshold || 0.08;
    const scrollStep = Math.max(50, Number(step.scrollStep) || Math.floor((ctx.viewportHeight || 844) * 0.7));
    const maxScrolls = Math.max(1, Number(step.maxScrolls) || 20);
    let found = null;
    for (let attempt = 0; attempt <= maxScrolls; attempt++) {
      const shot = await page.screenshot({ fullPage: false });
      found = ctx.compareTemplate(ctx.decodePng(shot), baseline.template, threshold);
      if (found) break;
      const before = await page.evaluate(() => window.scrollY);
      const atBottom = await page.evaluate(() => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2);
      if (atBottom) break;
      await page.mouse.wheel(0, scrollStep);
      await page.waitForTimeout(700);
      const after = await page.evaluate(() => window.scrollY);
      if (after === before) break;
    }
    if (!found) throw new Error(`baseline "${baseline.name}" not found before page bottom`);
    await log(`✅ ${idx} ${label} → (${found.x}, ${found.y}), diff ${found.diff.toFixed(3)}`);
    return { shots };
  }

  if (step.action === 'assert_ws_called') {
    await log(`⏳ ${idx} ${label}`);
    /**
     * WS（pinus）斷言。
     *
     * 🚨 **為什麼需要**：OSM 的業務幾乎全走 WS，HTTP 那邊只有遙測。
     *    所以 `assert_api_called` 對「下注有沒有真的送出去」完全無能為力——
     *    SPIN 這類 TC 以前只能截圖，**按鈕動了但 server 沒收到，畫面看起來一模一樣**。
     *    runner 本來就在收 pinus 訊息（日誌尾端那段摘要），這顆只是把它接上斷言。
     *
     * 欄位：`value`＝route 關鍵字（例 `dealGMActionReq`）、
     *       `selector`＝payload 必須包含的片段（例 `isspin:1`）、`minCount`＝至少幾筆。
     *
     * ⚠️ **只看「這一步之後」的訊息**：每次通過就把界線往前推（`state.wsMark`），
     *    否則第二次 SPIN 會把第一次的訊息算進去——那等於沒驗到第二次。
     */
    const probe = ctx.pinus;
    if (!probe || typeof probe.drain !== 'function') {
      throw new Error('這次執行沒有帶 WS 擷取（host 沒給 ctx.pinus）——伺服器端與 agent 端都要傳進來');
    }
    let route = (step.value ?? '').trim();
    if (!route) throw new Error('要填 route 關鍵字，例如 `dealGMActionReq`，可加方向前綴 `send:` / `recv:`');
    /**
     * 方向限定（CodeX 2026-09-20）：`send:` 只算我們送出去的、`recv:` 只算收回來的。
     * ⚠️ **送出請求 ≠ 這一注成功**——要驗成功請用 `recv:` 對回應下斷言，
     *    或再加一顆斷言去驗畫面／狀態。只驗 send 的話，server 拒絕了也會綠。
     */
    let wantDir = '';
    const dirMatch = route.match(/^(send|recv|request|response)\s*:\s*/i);
    if (dirMatch) {
      wantDir = dirMatch[1].toLowerCase().replace('request', 'send').replace('response', 'recv');
      route = route.slice(dirMatch[0].length).trim();
    }
    /**
     * 🚨 擷取器用的字是 `request` / `response` / `push`，**不是 send / recv**。
     *    v4.243 第一版用「開頭字母」對（send→'s'、recv→'r'），結果是
     *    **`send:` 永遠對不到任何東西**（'request' 開頭是 r），而
     *    **`recv:` 反而對到了 request**——一個永遠紅、一個是假綠，兩個都看不出來。
     *    所以這裡明列對應，不要再用前綴猜。
     */
    const dirOk = (raw) => {
      const d = String(raw ?? '').toLowerCase();
      if (!wantDir) return true;
      return wantDir === 'send' ? d === 'request' : (d === 'response' || d === 'push');
    };
    const needle = (step.selector ?? '').trim();
    const min = typeof step.minCount === 'number' && step.minCount > 0 ? step.minCount : 1;
    const since = ctx.state.wsMark ?? ctx.state.netMark ?? 0;
    // payload 比對用「去掉引號與空白」的寬鬆形式：使用者寫 `isspin:1`，
    // 實際 JSON 是 `"isspin":1`——不正規化的話永遠對不上，而且錯得很難看出來
    const loose = (v) => String(v).replace(/["'\s]/g, '').toLowerCase();
    const wantPayload = loose(needle);

    // WS 訊息常常比動作晚一點點到，所以要等；但條件不成立時照樣失敗
    const deadline = Date.now() + 10_000;
    let hits = [];
    let fresh = [];
    let scanned = 0;
    while (Date.now() < deadline) {
      await probe.drain().catch(() => {});
      const all = typeof probe.messages === 'function' ? probe.messages() : [];
      scanned = all.length;
      fresh = all.filter(m => (m.ts ?? 0) >= since);
      hits = fresh.filter(m => String(m.route ?? '').includes(route)
        && dirOk(m.direction)
        && (!wantPayload || loose(JSON.stringify(m.payload ?? '')).includes(wantPayload)));
      if (hits.length >= min) break;
      await page.waitForTimeout(800);
    }
    if (hits.length < min) {
      /**
       * ⚠️ 失敗訊息要**帶上實際看到什麼**。只寫「找不到」的話，三種完全不同的原因
       *    （route 名字寫錯／方向寫反／payload 欄位不是那個名字）長得一模一樣，
       *    只能靠再跑一輪手動 dump 才分得出來——這次就花了一整輪在這上面。
       */
      const sameRoute = fresh.filter(m => String(m.route ?? '').includes(route));
      const detail = sameRoute.length
        ? `同名 route 有 ${sameRoute.length} 筆，方向是 ${[...new Set(sameRoute.map(m => m.direction))].join('／')}`
          + `；第一筆 payload 欄位：${Object.keys(sameRoute[0].payload ?? {}).slice(0, 12).join(',') || '(非物件)'}`
        : `這一步之後出現過的 route：${[...new Set(fresh.map(m => `${m.direction} ${m.route}`))].slice(0, 8).join('、') || '(一筆都沒有)'}`;
      throw new Error(`WS 沒有${wantDir === 'recv' ? '收到' : '送出'}「${route}」${needle ? `（payload 要含 ${needle}）` : ''}`
        + `：需要 ${min} 筆，只找到 ${hits.length} 筆（這一步之後共收到 ${scanned} 筆 WS 訊息）。${detail}`);
    }
    // ⚠️ 這裡**不推界線**。界線由「動作類積木」在動作前推（見 markWsBefore）——
    //    在斷言通過後才推的話，同一個動作的第二顆斷言就看不到那批訊息了。
    await log(`✅ ${idx} ${label}（${route}${needle ? ` 含 ${needle}` : ''} ${hits.length} 筆）`);
    return { shots };
  }

  if (step.action === 'assert_api_called') {
    await log(`⏳ ${idx} ${label}`);
    // ⚠️ 拿不到網路紀錄一定要**失敗**。斷言被安靜跳過而腳本照樣 PASS，比直接報錯糟得多。
    if (!ctx.netCapture) throw new Error('這個執行環境沒有網路紀錄可查（量測沒有掛上）');
    if (!step.urlPattern) throw new Error('沒有填 API 網址樣式');
    const verdict = evaluateApiAssertion(
      ctx.netCapture.records().filter(r => Number(r.ts) >= ctx.state.netMark),
      { urlPattern: step.urlPattern, expectStatus: step.expectStatus, statusCode: step.statusCode, minCount: step.minCount },
    );
    if (!verdict.ok) throw new Error(`${step.urlPattern} —— ${verdict.why}`);
    await log(`✅ ${idx} ${label}（${verdict.why}）`);
    return { shots };
  }

  if (step.action === 'assert_visible') {
    await log(`⏳ ${idx} ${label}`);
    /**
     * 🚨 **這顆不能用 `ctx.recordedLocator()`。**
     *
     * host 建出來的那支帶 `requireUnique: true`，命中多筆就直接拋
     * 「定位必須唯一（命中 N 個）」。對 `click` 來說那是對的——不知道該點哪個就不該亂點；
     * 但這顆問的是「**畫面上看得到這東西嗎**」，`.grid-item-name` 這種一頁 30 個是常態。
     *
     * 2026-09-19 實測（H5 大廳，真站台）：
     * ```
     * .grid-item-name  → 定位必須唯一（命中 30 個）  ← 東西明明就在，卻判失敗
     * .section-title   → 定位必須唯一（命中 39 個）
     * .jackpot-number  → 定位必須唯一（命中 21 個）
     * ```
     * Backend 的 `assert_count` 早就踩過同一個坑並留了註解（`block-engine.js`：
     * 「這顆**不能**用 recordedLocator()」）——H5 這邊沒跟上，所以**任何會命中多個元素的
     * 選擇器都永遠通不過**，而錯誤訊息講的是「定位必須唯一」，看起來像選擇器寫錯，
     * 不像引擎限制。
     *
     * ⚠️ 仍然要走 Playwright locator，不能丟進 `querySelectorAll`：
     *    錄製器產出的 `:text-is()` / `text=` / `label=` 都不是合法 CSS。
     */
    const counted = await countRecorded(ctx.page, step.selector ?? '');
    if (counted.failure) {
      throw new Error(describeLocateFailure(counted, step.selector ?? label));
    }
    if (counted.count < 1) {
      throw new Error(`找不到元素：${step.selector ?? label}（命中 0 個）`);
    }
    // 命中多個時只要求「有一個看得見」——這顆的語意是存在且可見，不是數量檢查。
    // 要驗數量請用 Backend 的 assert_count；H5 目前沒有對應積木。
    // ⚠️ `locateRecorded` 在非唯一模式**已經挑好單一個**（優先挑看得見的），
    //    所以這裡不要再 `.first()`——那會把「它挑的那個」換回第一個，白挑一次。
    const located = await locateRecorded(ctx.page, step.selector ?? '', { requireUnique: false });
    if (located.failure || !located.locator) {
      throw new Error(describeLocateFailure(located, step.selector ?? label) || `找不到可用的元素：${step.selector ?? label}`);
    }
    await located.locator.waitFor({ state: 'visible', timeout: 10000 });
    await log(`✅ ${idx} ${label}（命中 ${counted.count} 個）`);
    return { shots };
  }

  if (step.action === 'backend_snippet') {
    // 後台設定：另開一顆 context 登入後台跑一段設定，跑完回來繼續前端腳本。
    const snippetSteps = step.snippetSteps ?? [];
    const snippetTitle = step.snippetTitle ?? '後台設定';
    if (!ctx.browser) throw new Error('瀏覽器尚未就緒，無法執行後台設定');
    if (!ctx.backend) throw new Error('沒有後台帳密，無法執行後台設定');
    await log(`⏳ ${idx} ${label}：${snippetTitle}`);
    const opResult = await runBackendOps(ctx.browser, {
      ...ctx.backend, steps: snippetSteps, title: snippetTitle,
      onNote: (line) => { void log(line) },
    });
    if (!opResult.ok) throw new Error(opResult.fails.join('；'));
    await log(`✅ ${idx} ${label}：${snippetTitle} 完成`);
    return { shots };
  }

  // 🚨 **不認得的動作一律失敗，不能跳過。**
  //
  // 原本兩邊都是「⏭ 跳過」，而那讓 `find_baseline_scroll` 在 agent 上被跳過很久——
  // 腳本照樣 PASS，視覺比對根本沒跑。少驗是誠實的，假裝驗過不是。
  throw new Error(`這個執行環境不支援「${step.action}」這個動作。`
    + '請確認伺服器與 Local Agent 都已更新到含這顆積木的版本；'
    + '若更新後仍然如此，代表這顆積木還沒有被實作。');
}
