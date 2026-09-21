/**
 * 幫 H5 的「UAT 整合測試」放幾份**對得上 TC 的起始腳本**。
 *
 *   node scripts/ui-checks/seed-h5-tc-scripts.mjs [--dry]
 *
 * 為什麼要有這支：清單裡原本那幾份是上一輪錄製留下的 `H5 完整流程 02:06:12`——
 * 名字看不出在測什麼、也沒綁任何 TC，跑完不會回寫。這支放的是**按 TC 命名、
 * 而且 steps 裡每一顆都標了 `tcId`** 的腳本，開起來就能跑、跑完判定寫得回去。
 *
 * ⚠️ **選擇器全部是實測量到的**（見 `h5-spin-quit-recon.mjs` 與
 *    [[project_toppath_uat_h5]]），不是從 TC 文字猜的。猜來的選擇器會讓腳本
 *    在畫面上看起來很完整，跑起來整批「命中 0」。
 *
 * ⚠️ **只放「積木真的驗得到」的 TC。** 影片播放、聲音、動畫、排序正確與否
 *    這類要人眼判斷的，這裡**只截圖存證、不假裝斷言**——`assert_visible` 只能
 *    證明元素在，證明不了內容對。硬綁上去會得到一份「永遠全綠」的假報告。
 *
 * ⚠️ 第一顆一定是 `goto` 且 **value 留空**：執行時會用 RUN SETTINGS 的目標網址，
 *    這樣同一份腳本可以換不同帳號跑（寫死網址等於把某支帳號焊進腳本裡）。
 */
import Database from 'better-sqlite3'

const DRY = process.argv.includes('--dry')
const BASE = 'http://localhost:3000'
const LARK_URL = 'https://casinoplus.sg.larksuite.com/base/KRv8bF5C4aaIacsN5L6le9Rugre?table=tblaS8n0Fup00p6l&view=vewMbYXND3'
const TABLE_ID = 'tblaS8n0Fup00p6l'
const CREATED_BY = 'claude'

const db = new Database('server/data.db')
const sess = db.prepare('SELECT sid FROM auth_sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 1').get(Date.now())
if (!sess) { console.log('沒有有效登入 session'); process.exit(1) }
const HEADERS = { 'content-type': 'application/json', cookie: `toppath_auth=${sess.sid}` }

// ── TC 對照：用敘述的關鍵片段去認，認不到就不綁（寧可少綁，不要綁錯筆）──────
const scan = await fetch(`${BASE}/api/osm-uat/scan?larkUrl=${encodeURIComponent(LARK_URL)}`, { headers: HEADERS }).then(r => r.json())
if (!scan.ok) { console.log('掃 TC 失敗：', JSON.stringify(scan).slice(0, 200)); process.exit(1) }
console.log(`TC 來源：${scan.total} 筆（${scan.groups.map(g => `${g.name} ${g.count}`).join('、')}）`)

/** 用關鍵片段找一筆 TC。找不到回 null——呼叫端要能接受「這顆沒綁到」。 */
function tc(...fragments) {
  const hit = scan.tcs.find(t => fragments.every(f => t.text.includes(f)))
  if (!hit) { console.log(`  ⚠️ 對不到 TC：${fragments.join(' + ')}`); return null }
  return { recordId: hit.recordId, number: hit.number, text: hit.text }
}

const TC = {
  version:    tc('版本號確認最新'),
  quickJoin:  tc('觀戰相關', 'Quick join'),
  cctv:       tc('機台內 CCTV切換正常'),
  road:       tc('機台內 路書正常'),
  favorite:   tc('機台內 左上角愛心'),
  quit:       tc('Quit、下方Cash Out 離開正常'),
  sound:      tc('聲音正常'),
  // ── 第二批（2026-09-19 傍晚量到大廳各面板的選擇器之後才寫得出來）──────────
  points:     tc('積分頁面 註冊會員卡'),
  pointsBar:  tc('積分頁面 會員卡下注後有累積進度條'),
  rankJp:     tc('排行榜 JP排行榜 ALL.Tier1.Tier2數據跟獎池顯示正確'),
  betHistory: tc('投注明細 打開確認有記錄三天內數據'),
  rechargeLobby: tc('充值 大廳彈框充值'),
  watchInfo:  tc('觀戰相關 打開有聲音'),
  meRecent:   tc('大廳Me Recently Played'),
  meFavorite: tc('大廳Me My Favorite'),
  videoInfo:  tc('大廳 Video 上方資訊跟影片顯示正確'),
  videoNext:  tc('大廳 Video 右下NEXT功能正常'),
  lobbyTop:   tc('大廳往下滑 右下的top'),
  rankScroll: tc('排行榜 JP排行榜 滑動加載正常'),
  reserve:    tc('機台內 預約Reserve 頁面 Reserve Now可立刻預約'),
  reserveCancel: tc('機台內 預約Reserve 頁面 預約後可再次打開確認預約機台名稱與時間正確'),
}

// ── 積木 ──────────────────────────────────────────────────────────────────────
let n = 0
const step = (action, name, extra = {}) => ({ id: `seed-${Date.now().toString(36)}-${n++}`, name, action, ...extra })
const goto = () => step('goto', '前往 H5 大廳（用執行設定的網址）')
const wait = (ms, name) => step('wait', name, { value: String(ms) })
const shot = (name, tcId) => step('screenshot', name, tcId ? { tcId } : {})
const see = (selector, name, tcId) => step('assert_visible', name, { selector, ...(tcId ? { tcId } : {}) })
const tap = (selector, name, tcId) => step('click', name, { selector, ...(tcId ? { tcId } : {}) })
/**
 * 會造成真實副作用的點擊（預約／帶入額度／Join／Cash Out）。
 *
 * 🚨 用 `tap` 點這些按鈕現在會被守衛擋下來——**這是故意的**：
 *    錄製或改腳本的人不該在沒意識到的情況下鎖住一台機台 24 小時。
 *    這些步驟是我們**明知故犯而且測試本來就要做**的，所以逐顆放行。
 *    （放行只對這一顆有效；正式環境連這個也不接受。）
 */
const tapDanger = (selector, name, tcId) => step('click', name, { selector, allowDangerous: true, ...(tcId ? { tcId } : {}) })
/** 捲動：value 填 top／bottom／px 數字；只填 selector＝把那個元素捲進畫面 */
const scroll = (value, name, selector) => step('scroll', name, { ...(value ? { value } : {}), ...(selector ? { selector } : {}) })

/** 大廳 →（第一張卡片）→ 機台列表 → Quick Join → 真的進到機台。 */
const enterMachine = (tcId) => [
  goto(),
  wait(13000, '等大廳載入（H5 首次載入要十幾秒）'),
  // ⚠️ 點 `.grid-item-name` 會 timeout，可點的是外層 `.grid-item`；`nth=0` 是為了讓命中唯一
  tap('.grid-item >> nth=0', '點第一張遊戲卡片', tcId),
  wait(8000, '等該遊戲的機台列表頁'),
  // ⚠️ 不要自己挑「看起來沒人」的機台——卡片的 OCCUPIED 在 textContent 讀不到，實測第一次就挑到被佔用的
  tapDanger('text=Quick Join', '按 Quick Join（讓系統配一台沒人的）', tcId),
  wait(16000, '等進機台（/lobby → /game）'),
  // 🚨 進機台後第一件事是選面額：「SELECT A DENOMINATION」會蓋住整個畫面（含 header），
  //    元素讀得到、就是點不動。不先選的話後面每一顆都會 timeout
  // ⚠️ **一定要收斂到唯一。** `click` 積木是 `requireUnique`——命中 4 顆就直接失敗
  //    （訊息寫「定位必須唯一」）。這是對的：不知道點哪一顆就不該點。
  //    目前選中的那顆是 `my-button--disabled`（點了一樣 timeout），所以先排除再取第一顆。
  tap('.btn_bet:not(.my-button--disabled) >> nth=0', '選面額（不選的話整個畫面點不動）', tcId),
  wait(6000, '等面額套用'),
]

const SCRIPTS = [
  {
    name: 'T-A-001 大廳載入與版本（截圖存證）',
    bind: [TC.version],
    steps: [
      goto(),
      wait(13000, '等大廳載入'),
      // ⚠️ **檢查與截圖一定要指定所屬 TC**，否則正式執行路徑會在開瀏覽器前就擋下來
      //    （訊息：「請指定檢查、讀值或截圖的所屬 TC」）——結果不知道要回寫到哪一筆。
      //    這兩顆是「版本看得到」的前提：大廳沒建出來就談不上核對版本號。
      see('.grid-item', '大廳機台卡片有渲染', TC.version?.recordId),
      see('.section-title', '大廳分區標題有渲染', TC.version?.recordId),
      // ⚠️ 版本號要人眼看——這裡只留證據，不假裝斷言
      shot('大廳首屏（版本號請人眼核對）', TC.version?.recordId),
    ],
  },
  {
    name: 'T-A-009 觀戰 → Quick Join 進機台',
    bind: [TC.quickJoin],
    steps: [
      goto(),
      wait(13000, '等大廳載入'),
      tap('.grid-item >> nth=0', '點第一張遊戲卡片', TC.quickJoin?.recordId),
      wait(8000, '等機台列表／Game Preview'),
      shot('Game Preview 面板', TC.quickJoin?.recordId),
      tapDanger('text=Quick Join', '按 Quick Join', TC.quickJoin?.recordId),
      wait(16000, '等進機台'),
      // 面額按鈕只有在機台內才有——拿它當「真的進去了」的證據
      see('.btn_bet', '已進入機台（面額按鈕出現）', TC.quickJoin?.recordId),
      shot('機台內首屏', TC.quickJoin?.recordId),
    ],
  },
  {
    name: 'T-B-012 機台內功能盤點（CCTV／路書／Cash Out／說明／Top Up）',
    // ⚠️ 步驟上出現的 TC **都要在 bind 裡**，否則回寫時那一筆沒有歸屬
    bind: [TC.cctv, TC.road, TC.favorite, TC.quit],
    steps: [
      ...enterMachine(TC.cctv?.recordId),
      see('.video_cctv', 'CCTV 畫面在', TC.cctv?.recordId),
      see('.road', '路書在', TC.road?.recordId),
      see('.btn_cashout', 'Cash Out 在', TC.quit?.recordId),
      // ⚠️ 說明／Top Up／header 這幾顆**這張表裡沒有對應的 TC**。
      //    硬掛到別筆 TC 上會讓那筆的證據變成不相干的東西，所以不留斷言——
      //    它們出現在下面那張截圖裡，要看的人自己看。
      shot('機台內控制列（愛心／CCTV 切換要人眼確認）', TC.favorite?.recordId),
    ],
  },
  {
    name: 'T-B-012 機台內下注：帶入額度 → SPIN ×3',
    bind: [TC.sound],
    steps: [
      ...enterMachine(TC.sound?.recordId),
      // 🚨 `.btn_spin` 是**帶入額度之後才出現**的，順序不能顛倒
      tapDanger('.btn_play >> nth=0', '帶入額度（會動到餘額）'),
      wait(9000, '等額度帶入'),
      see('.btn_spin', '轉動控制出現（買入後才會有）', TC.sound?.recordId),
      tap('.btn_spin', 'SPIN 第 1 把'),
      wait(5000, '等這一局跑完（單局約 3 秒，太快會被 1035 擋掉＝假轉）'),
      tap('.btn_spin', 'SPIN 第 2 把'),
      wait(5000, '等這一局跑完'),
      tap('.btn_spin', 'SPIN 第 3 把'),
      wait(6000, '等結算'),
      shot('下注後畫面', TC.sound?.recordId),
    ],
  },
  {
    name: 'T-B-012 離開機台：Cash Out → Confirm 回大廳',
    bind: [TC.quit],
    steps: [
      ...enterMachine(TC.quit?.recordId),
      tapDanger('.btn_cashout', '按 Cash Out', TC.quit?.recordId),
      wait(5000, '等 Tips 框'),
      // ⚠️ 這個框的按鈕是 `.box-btn_text1`=Cancel、`.box-btn_text2`=Confirm。
      //    用 `:text-is("Confirm")` 找會命中 0（踩過）
      see('.box-btn_text2', 'Tips 框出現（Cash out credit）', TC.quit?.recordId),
      shot('Cash Out 確認框', TC.quit?.recordId),
      tap('.box-btn_text2', '按 Confirm', TC.quit?.recordId),
      wait(8000, '等退回大廳'),
      see('.grid-item', '已回到大廳（機台卡片又出現）', TC.quit?.recordId),
    ],
  },
  // ── 第二批：大廳各面板 ────────────────────────────────────────────────────
  //
  // ⚠️ 入口的圖示**沒有文字**（標籤是圖），所以只能用 class：
  //    `.header_btn_item_reward`（積分）／`.header_btn_item_ranking`（排行榜）／
  //    `.header_btn_item_history`（投注明細）／`.header_btn_item`（充值）。
  //    ⚠️ **絕對不要點 `.header_btn_item_return`**——那會離開 OSM 回 CP，回不來。
  {
    name: 'T-A-002 積分頁面打得開（會員卡＋累積進度條）',
    bind: [TC.points, TC.pointsBar],
    steps: [
      goto(),
      wait(13000, '等大廳載入'),
      tap('.header_btn_item_reward', '點 Reward Point'),
      wait(5000, '等積分頁面開起來'),
      see('.membership', '會員卡區塊有出現', TC.points?.recordId),
      see('.progress-value', '累積進度條有出現', TC.pointsBar?.recordId),
      // ⚠️ 等級對不對、明細數字對不對要人眼看——這裡只留證據
      shot('積分頁面（等級／進度數字請人眼核對）', TC.points?.recordId),
    ],
  },
  {
    name: 'T-A-004 JP 排行榜打得開（All／Tier1／Tier2 ＋ 獎池）',
    bind: [TC.rankJp],
    steps: [
      goto(),
      wait(13000, '等大廳載入'),
      tap('.header_btn_item_ranking', '點 Ranking'),
      wait(5000, '等排行榜開起來'),
      see('.ranking_bg', '排行榜面板有出現', TC.rankJp?.recordId),
      see('.jackpot-header-middle-selection', 'All／Tier 1／Tier 2 分頁在', TC.rankJp?.recordId),
      see('.section-jackpot-number', '獎池金額有顯示', TC.rankJp?.recordId),
      shot('JP 排行榜（金額與排序請人眼核對）', TC.rankJp?.recordId),
    ],
  },
  {
    name: 'T-A-005 投注明細打得開且有資料',
    bind: [TC.betHistory],
    steps: [
      goto(),
      wait(13000, '等大廳載入'),
      tap('.header_btn_item_history', '點 History'),
      wait(5000, '等投注明細開起來'),
      see('.history_bg', '投注明細面板有出現', TC.betHistory?.recordId),
      // 🚨 **「打得開」跟「裡面有資料」是兩件事。**只驗面板的話，空清單也會過——
      //    而這條 TC 要的就是「有記錄三天內數據」，所以一定要驗到列。
      see('.table-item', '明細列表真的有資料列', TC.betHistory?.recordId),
      shot('投注明細（日期範圍與金額請人眼核對）', TC.betHistory?.recordId),
    ],
  },
  {
    name: 'T-A-003 大廳充值入口會跳確認框',
    bind: [TC.rechargeLobby],
    steps: [
      goto(),
      wait(13000, '等大廳載入'),
      tap('.header_btn_item', '點 Top Up'),
      wait(4000, '等 Tips 框'),
      // 實測：充值入口會先跳「Recharge will leave the current page」的確認框
      see('.box-btn_text2', '跳出「離開本頁去充值」確認框', TC.rechargeLobby?.recordId),
      shot('充值確認框', TC.rechargeLobby?.recordId),
      // 🚨 **只按 Cancel，不按 Confirm。** 按下去會真的離開 OSM 去充值頁，
      //    後面的步驟會全部失敗，而且那是有副作用的動作。
      tap('.box-btn_text1', '按 Cancel 留在大廳'),
      wait(3000, '等框關掉'),
      see('.grid-item', '還留在大廳（機台卡片還在）', TC.rechargeLobby?.recordId),
    ],
  },
  {
    name: 'T-B-012 機台內資訊列（愛心／機台名／觀戰人數／預約入口）',
    bind: [TC.favorite, TC.watchInfo],
    steps: [
      ...enterMachine(TC.favorite?.recordId),
      // 這幾顆原本只有截圖存證，量到選擇器之後升級成真的斷言
      see('.gm-favor', '左上角愛心在', TC.favorite?.recordId),
      see('.machine-id', '機台名有顯示', TC.favorite?.recordId),
      see('.game-id', '遊戲名有顯示', TC.favorite?.recordId),
      see('.watch_count', '觀戰人數有顯示', TC.watchInfo?.recordId),
      // ⛔ **預約入口只驗「在」，不點。** 實測 osmel002 點下去是
      //    「You do not have permission to use this feature」——這支帳號不在預約白名單。
      //    預約那幾條 TC 要換一支白名單內的帳號才能自動化。
      see('.reserve', '預約入口在（本帳號無權限，只驗存在）', TC.favorite?.recordId),
      shot('機台內資訊列（名稱／人數數字請人眼核對）', TC.watchInfo?.recordId),
    ],
  },
  // ── 下排導覽分頁 ──────────────────────────────────────────────────────────
  //
  // 選擇器：`.profile`(Me)／`.slots`(Live Slots)／`.quick_join`／`.news`／`.video`(JACKPOT)
  // 🚨 **這排要用真實 pointer 事件才點得動。** 實測 `page.mouse.click(50, 844)` 完全沒反應，
  //    換成 `locator.click()` 就開了——`click` 積木走的正是後者，所以腳本沒問題。
  // ⚠️ **不點 `.quick_join`**（會直接進機台），News 的項目也不點（點了有機台就進機台）。
  {
    name: 'T-A-011 大廳 Me（最近遊玩／我的最愛分頁）',
    bind: [TC.meRecent, TC.meFavorite],
    steps: [
      goto(),
      wait(13000, '等大廳載入'),
      tap('.profile', '點下排 Me'),
      wait(5000, '等 Me 頁開起來'),
      see('.profile_tab', 'Me 的分頁列出現', TC.meRecent?.recordId),
      see('.profile_tab_recently', '「最近遊玩」分頁在', TC.meRecent?.recordId),
      see('.profile_tab_favourite', '「我的最愛」分頁在', TC.meFavorite?.recordId),
      // ⚠️ 排序對不對要人眼看（TC 寫的是「同遊戲排序會依照最近遊玩往前排」）
      shot('Me 頁（排序請人眼核對）', TC.meRecent?.recordId),
    ],
  },
  {
    name: 'T-A-011 大廳 Video（JACKPOT 影片頁）',
    bind: [TC.videoInfo, TC.videoNext],
    steps: [
      goto(),
      wait(13000, '等大廳載入'),
      tap('.video', '點下排 JACKPOT Video'),
      wait(6000, '等影片頁開起來'),
      see('.video-slider', '影片區塊出現', TC.videoInfo?.recordId),
      see('.video-item', '影片項目有資料', TC.videoInfo?.recordId),
      see('.account-content', '上方帳號資訊有顯示', TC.videoInfo?.recordId),
      see('.time-content', '上方時間資訊有顯示', TC.videoInfo?.recordId),
      see('.switch-btn', '右下切換（NEXT）鍵在', TC.videoNext?.recordId),
      // ⚠️ 影片播不播得動、聲音同不同步要人眼——只留證據
      shot('Video 頁（播放與聲音請人眼確認）', TC.videoInfo?.recordId),
    ],
  },
  {
    name: 'T-A-008 大廳往下滑，右下 Top 鍵出現',
    bind: [TC.lobbyTop],
    steps: [
      goto(),
      wait(13000, '等大廳載入'),
      // ⚠️ 行動版**不是 window 在捲**，是內層容器——`scroll` 積木會自己找真的捲得動的那個
      scroll('1500', '往下捲 1500px'),
      wait(2500, '等清單穩定'),
      // 🚨 `.footer-top` **只有捲下去之後才存在**——這正是這條 TC 要的行為
      see('.footer-top', '右下 Top 鍵出現', TC.lobbyTop?.recordId),
      tap('.footer-top', '點 Top 鍵'),
      wait(3000, '等回到最上方'),
      // ⚠️ 「真的回到最上方」用截圖給人眼確認（目前沒有能斷言捲動位置的積木）
      shot('點 Top 之後的畫面（是否回到最上方請人眼確認）', TC.lobbyTop?.recordId),
    ],
  },
  {
    name: 'T-A-004 JP 排行榜滑動加載',
    bind: [TC.rankScroll],
    steps: [
      goto(),
      wait(13000, '等大廳載入'),
      tap('.header_btn_item_ranking', '點 Ranking'),
      wait(5000, '等排行榜開起來'),
      see('.ranking_bg', '排行榜面板出現', TC.rankScroll?.recordId),
      // ⚠️ 排行榜的資料列**不是** `.table-item`（那是投注明細的）——第一版就這樣紅了。
      //    實測排行榜是 `.table_body_jackpot`。同樣叫「表格」，class 不共用。
      see('.table_body_jackpot', '排行榜有資料列', TC.rankScroll?.recordId),
      scroll('1200', '在排行榜裡往下捲'),
      wait(3000, '等滑動加載'),
      // 捲完還有資料列＝有跟著載（TC 寫的是「無限制筆數」）
      see('.table_body_jackpot', '捲動後仍有資料列', TC.rankScroll?.recordId),
      shot('排行榜捲動後（筆數與排序請人眼核對）', TC.rankScroll?.recordId),
    ],
  },
  {
    name: 'T-B-012 機台內預約 Reserve 頁面打得開',
    bind: [TC.reserve],
    steps: [
      ...enterMachine(TC.reserve?.recordId),
      tap('.reserve', '點預約入口'),
      wait(5000, '等預約面板展開'),
      // 面板長這樣（2026-09-19 實測）：上方兩個分頁 Reserve／Reserved，
      // 中間寫「Want to reserve this machine?」與保留時數，下方一顆 Reserve Now
      see('.reserve-btn-long', 'Reserve Now 按鈕在', TC.reserve?.recordId),
      see('.reserved', 'Reserved 分頁在', TC.reserve?.recordId),
      // 🚨 **只開面板、不按 Reserve Now。** 真的預約下去會把機台保留 24 小時、
      //    別人用不了，而「Cancel Reservation」的選擇器我還沒量到——
      //    收不回來的副作用不能留給使用者。要做完整的預約→取消流程，得先量那一段。
      shot('預約面板（保留時數與剩餘次數請人眼核對）', TC.reserve?.recordId),
    ],
  },
  {
    name: 'T-B-012 有預約資格時 Quit 會跳預約視窗，Exit To Lobby 可離開',
    bind: [TC.quit, TC.reserve],
    steps: [
      ...enterMachine(TC.quit?.recordId),
      // 🚨 帳號**有預約資格**時，按 Quit 跳的不是一般 Tips，而是**預約視窗**
      //    （TC 原文：「右上Quit、下方Cash Out 離開正常(有預約資格會跳預約視窗)」）
      tap('.header_btn_item >> nth=2', '按 Quit（header 最後一顆）', TC.quit?.recordId),
      wait(5000, '等視窗跳出來'),
      // ⚠️ 由 Quit 觸發的版本**按鈕 class 跟從 `.reserve` 入口開的不一樣**
      //    （入口版只有一顆 `.reserve-btn-long`；Quit 版是兩顆），所以驗那顆會命中 0。
      //    改驗「Exit To Lobby」——它只在 Quit 觸發的版本才有，正好就是這條 TC 要的。
      see('text=Exit To Lobby', '跳出預約視窗（有 Exit To Lobby 可選）', TC.reserve?.recordId),
      shot('Quit 跳出的預約視窗', TC.quit?.recordId),
      // ⚠️ **按左邊灰色的 Exit To Lobby，不是右邊黃色的 Reserve Now**——
      //    後者會把機台保留 24 小時，是收不回來的副作用。
      tap('text=Exit To Lobby', '按 Exit To Lobby', TC.quit?.recordId),
      wait(6000, '等離開機台'),
      // 離開時若身上有額度會再跳一次下分確認
      tap('.box-btn_text2', '若跳下分確認就按 Confirm'),
      wait(6000, '等回到大廳'),
      see('.grid-item', '已回到大廳', TC.quit?.recordId),
    ],
  },
  {
    name: 'T-B-012 預約完整流程：Reserve Now → Reserved 分頁 → Cancel',
    bind: [TC.reserve, TC.reserveCancel],
    steps: [
      ...enterMachine(TC.reserve?.recordId),
      tap('.reserve', '開預約面板'),
      wait(4500, '等面板展開'),
      see('.reserve-btn-long', 'Reserve Now 在', TC.reserve?.recordId),
      // 🚨 **這一步會真的預約**：機台被保留 24 小時、別人用不了。
      //    所以這份腳本**最後一定要取消**——中途失敗的話請手動到 Reserved 分頁按 Cancel。
      tapDanger('.reserve-btn-long', '按 Reserve Now（真的預約）'),
      wait(6000, '等預約送出（面板會自己關掉）'),
      tap('.reserve', '再開一次預約面板'),
      wait(4500, '等面板展開'),
      tap('.reserved', '切到 Reserved 分頁'),
      wait(4500, '等清單載入'),
      // 預約成功的話這一筆會有 Join（灰的）與 Cancel 兩顆
      see('.cancel-btn', 'Reserved 分頁看得到剛才那筆預約', TC.reserveCancel?.recordId),
      shot('Reserved 分頁（機台名稱與剩餘時間請人眼核對）', TC.reserveCancel?.recordId),
      /**
       * ⚠️ 要點的是 `.cancel-btn` 本身，**不是外層的 `.function`**——
       * 那個容器的文字是「JoinCancel」（子元素串起來的），用文字找會先命中它，
       * 點下去等於點在兩顆按鈕中間的空白處，取消不掉。
       */
      tap('.cancel-btn', '按 Cancel 取消預約', TC.reserveCancel?.recordId),
      wait(4000, '等取消'),
      tap('.box-btn_text2', '若跳確認就按 Confirm'),
      wait(4500, '等清單更新'),
      shot('取消之後的 Reserved 分頁', TC.reserveCancel?.recordId),
    ],
  },
]

// ── 寫入（同名就更新，不要每跑一次多一份）────────────────────────────────────
const existing = await fetch(`${BASE}/api/frontend-auto/scripts?platform=h5`, { headers: HEADERS })
  .then(r => r.json()).then(r => r.scripts ?? [])

for (const s of SCRIPTS) {
  const bindings = s.bind.filter(Boolean)
  const body = JSON.stringify({
    name: s.name, platform: 'h5', steps: s.steps, createdBy: CREATED_BY, isPublic: true,
    larkUrl: LARK_URL, tableId: TABLE_ID, bindings,
  })
  const hit = existing.find(e => e.name === s.name)
  if (DRY) { console.log(`[dry] ${hit ? '更新' : '新增'} ${s.name}｜${s.steps.length} 顆｜綁 ${bindings.length} 筆 TC`); continue }
  const res = hit
    ? await fetch(`${BASE}/api/frontend-auto/scripts/${hit.id}`, { method: 'PUT', headers: HEADERS, body })
    : await fetch(`${BASE}/api/frontend-auto/scripts`, { method: 'POST', headers: HEADERS, body })
  const out = await res.json()
  console.log(`${out.ok ? '✅' : '❌'} ${hit ? '更新' : '新增'} ${s.name}｜${s.steps.length} 顆｜綁 ${bindings.length} 筆 TC${out.ok ? '' : '：' + JSON.stringify(out).slice(0, 120)}`)
}
