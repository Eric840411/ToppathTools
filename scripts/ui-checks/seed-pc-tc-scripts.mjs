/**
 * 幫 PC 的「UAT 整合測試」放幾份對得上 TC 的起始腳本。
 *
 *   node scripts/ui-checks/seed-pc-tc-scripts.mjs [--dry]
 *
 * 🚨 **PC 不能照抄 H5。** 實測：PC 的 DOM 裡只有 1 個 canvas、**0 個有 class 的可見元素**，
 *    載入期間也沒有任何業務 HTTP API（全走 WS）。所以 `assert_visible`／`assert_api_called`
 *    在 PC 上一律驗不到東西——這裡用的是讀 Cocos 場景樹的兩顆積木：
 *    `pc_enter_machine`（操作）與 `assert_pc_scene`（判定）。
 *
 * ⚠️ **只放「積木真的驗得到」的 TC。** 缺圖、排序、跑馬燈、影片、聲音這類要人眼比對的，
 *    這裡只截圖存證、不假裝斷言——硬綁會得到一份永遠全綠的假報告。
 *
 * ⚠️ 執行解析度建議 **1280x800**（PC 畫布 1280x720）。視窗太窄時卡片會落在畫布外點不到。
 */
import Database from 'better-sqlite3'

const DRY = process.argv.includes('--dry')
const BASE = 'http://localhost:3000'
const LARK_URL = 'https://casinoplus.sg.larksuite.com/base/KRv8bF5C4aaIacsN5L6le9Rugre?table=tblnIiFRlZk46OKo&view=vew1'
const TABLE_ID = 'tblnIiFRlZk46OKo'
/** 要進哪一款。只填遊戲名＝讓系統在同款裡挑一台空的（指定某一台會因為被佔用而隨機失敗）。 */
const GAME = process.env.GAME ?? 'Phoenix'

const db = new Database('server/data.db')
const sess = db.prepare('SELECT sid FROM auth_sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 1').get(Date.now())
if (!sess) { console.log('沒有有效登入 session'); process.exit(1) }
const HEADERS = { 'content-type': 'application/json', cookie: `toppath_auth=${sess.sid}` }

const scan = await fetch(`${BASE}/api/osm-uat/scan?larkUrl=${encodeURIComponent(LARK_URL)}`, { headers: HEADERS }).then(r => r.json())
if (!scan.ok) { console.log('掃 TC 失敗：', JSON.stringify(scan).slice(0, 200)); process.exit(1) }
console.log(`TC 來源：${scan.total} 筆`)

function tc(...fragments) {
  const hit = scan.tcs.find(t => fragments.every(f => t.text.includes(f)))
  if (!hit) { console.log(`  ⚠️ 對不到 TC：${fragments.join(' + ')}`); return null }
  return { recordId: hit.recordId, number: hit.number, text: hit.text }
}

const TC = {
  version:   tc('OSM前端版本'),
  loading:   tc('載入圖'),
  enter:     tc('電腦PC點擊任一空閒機台'),
  status:    tc('大廳機器的狀態有即時更新'),
  quitBack:  tc('中handpay鎖機中可退出機器'),
  // ── machine 群組（2026-09-19 量到機台內的 Cocos 節點之後才寫得出來）──────
  road:      tc('路書下方按照Jackpot Ranking的中獎紀錄顯示'),
  favorite:  tc('最愛能正常開關並根據收藏機器顯示'),
  history:   tc('History能正常開關'),
  rank:      tc('Rank可正常開啟'),
  // ── 大廳側邊欄（2026-09-19 量到節點名之後才寫得出來）────────────────────
  rankList:  tc('Ranking List>滑動加載正常'),
  historyPg: tc('History>顯示近3天投注紀錄'),
  howToPlay: tc('遊戲上方How to play可正常開啟關閉'),
  // ── 側邊欄各頁（2026-09-20 量到節點）────────────────────────────────────
  rewardCards: tc('Reward Points>顯示6個等级的会员卡'),
  jpVideo:     tc('JP Video>後台用JP gameID配置'),
  newsOrder:   tc('News>前端排序比照後台'),
  spinKeys:    tc('SPIN功能 > 可以用鍵盤空白鍵、Enter可觸發'),
}

let n = 0
const step = (action, name, extra = {}) => ({ id: `pcseed-${Date.now().toString(36)}-${n++}`, name, action, ...extra })
const goto = () => step('goto', '前往 PC 大廳（用執行設定的網址）')
const wait = (ms, name) => step('wait', name, { value: String(ms) })
const shot = (name, tcId) => step('screenshot', name, tcId ? { tcId } : {})
/** PC 判定：value = 場景（lobby / game）；selector 欄位在這顆積木裡是**機台名稱** */
const scene = (want, name, tcId, machine) => step('assert_pc_scene', name, { value: want, ...(machine ? { selector: machine } : {}), ...(tcId ? { tcId } : {}) })
const enter = (game, name) => step('pc_enter_machine', name, { value: game })
/** PC 機台內：點場景樹的節點（填節點名或畫面上的字） */
const clickNode = (node, name) => step('pc_click_node', name, { value: node })
/** 會動到餘額／佔機台的節點點擊——逐顆放行，理由見 H5 那支的 `tapDanger` */
const clickNodeDanger = (node, name) => step('pc_click_node', name, { value: node, allowDangerous: true })
const seeNode = (node, name, tcId) => step('assert_pc_node', name, { value: node, ...(tcId ? { tcId } : {}) })
/**
 * 驗 PC 畫面上的文字／數字——**讀 Cocos label，不是 OCR**。
 * ⚠️ 不要把「當下的餘額數字」寫死成期望值：下一輪它就變了，那是自己製造的假紅。
 *    要驗的是**性質**（大於 0、是這個帳號），不是那一瞬間的快照。
 */
const seeText = (node, want, name, tcId, mode = 'contains') =>
  step('assert_text', name, { nodeName: node, value: want, matchMode: mode, ...(tcId ? { tcId } : {}) })
/** PC 捲動：top／bottom／0~1 比例，或 `find:<節點>`＝捲到那個節點進視窗為止 */
const pcScroll = (value, name, list) => step('pc_scroll', name, { value, ...(list ? { selector: list } : {}) })
/** 按鍵盤（PC 機台內的 SPIN 就是靠這個） */
const pressKey = (key, name) => step('press_key', name, { value: key })
/**
 * WS 斷言：`route` 可加方向前綴（`send:` / `recv:`），`payload` 是要包含的片段。
 * ⚠️ 只驗 `send:` 代表「有送出去」，**不代表 server 接受了**——要驗成功請一併驗 `recv:`。
 */
const seeWs = (route, name, tcId, payload, minCount) => step('assert_ws_called', name, {
  value: route, ...(payload ? { selector: payload } : {}), ...(minCount ? { minCount } : {}), ...(tcId ? { tcId } : {}),
})

const SCRIPTS = [
  {
    name: 'PC T-A-001 大廳載入與版本（截圖存證）',
    bind: [TC.version, TC.loading],
    steps: [
      goto(),
      wait(15000, '等 Cocos 起來（PC 版載入比 H5 久）'),
      // ⚠️ 這顆會等到場景真的變 lobby，而且清單建得出來才算過——
      //    載入後場景先是 `start`，只取樣一次會紅在時間差上
      scene('lobby', '大廳就緒（場景 lobby ＋ 機台清單建出來）', TC.loading?.recordId),
      // 進到的是**自己的**帳號、而且餘額讀得出來——這兩件事以前只能靠人看截圖
      seeText('lb_name', 'osmel', '左上顯示的是登入的帳號', TC.loading?.recordId),
      seeText('lb_coin', '>0', '餘額讀得到而且大於 0', TC.loading?.recordId, 'number'),
      shot('大廳首屏（版本號請人眼核對）', TC.version?.recordId),
    ],
  },
  {
    name: 'PC T-A-002 點空閒機台直接進機台',
    bind: [TC.enter, TC.status],
    steps: [
      goto(),
      wait(15000, '等 Cocos 起來'),
      scene('lobby', '先確認人在大廳', TC.status?.recordId),
      // ⚠️ 大廳「載出來了」跟「卡片點得動」不是同一件事：剛載完的卡片是黑的（快照還沒載），
      //    點下去沒反應。實測在載入後多停 30 秒才點得進去。
      wait(30000, '讓大廳的卡片真的畫出來（剛載完點不動）'),
      // 🚨 這顆會：等大廳就緒 → 全程盯著關彈窗 → 挑一台空的 → 點進去 → 驗證「實際進到哪一台」
      //    （實測點座標會點到隔壁，所以進去之後一定要再對一次名字）
      enter(GAME, `進一台空的 ${GAME}`),
      scene('game', '已經在機台內', TC.enter?.recordId),
      shot('機台內首屏', TC.enter?.recordId),
    ],
  },
  {
    name: 'PC T-B machine 機台內功能鍵齊全（CCTV／Sound／Road／Favorite／History／Rank）',
    bind: [TC.road, TC.favorite, TC.history, TC.rank],
    steps: [
      goto(),
      wait(15000, '等 Cocos 起來'),
      enter(GAME, `進一台空的 ${GAME}`),
      wait(6000, '等機台內畫面建好'),
      // 節點名是實測量到的（`pc-ingame-recon.ts`），不是猜的
      seeNode('btn-road', '路書鍵在', TC.road?.recordId),
      seeNode('btn-favorite', '最愛鍵在', TC.favorite?.recordId),
      seeNode('btn-history', 'History 鍵在', TC.history?.recordId),
      seeNode('btn-rank', 'Rank 鍵在', TC.rank?.recordId),
      // 用畫面上的字找也可以（標籤比對）
      seeNode('CCTV', 'CCTV 鍵在（用畫面上的字找）', TC.road?.recordId),
      shot('機台內控制列', TC.road?.recordId),
    ],
  },
  {
    name: 'PC T-B machine 路書打得開',
    bind: [TC.road],
    steps: [
      goto(),
      wait(15000, '等 Cocos 起來'),
      enter(GAME, `進一台空的 ${GAME}`),
      wait(6000, '等機台內畫面建好'),
      clickNode('btn-road', '點開路書'),
      wait(5000, '等面板展開（是動畫，點完馬上驗會抓到還沒建出來）'),
      // 路書打開之後 `road` 節點才會 active——這是實測 diff 出來的
      seeNode('road', '路書面板出現', TC.road?.recordId),
      // ⚠️ 「中獎紀錄顯示是否正確」要人眼看，這裡只留證據
      shot('路書面板（內容請人眼核對）', TC.road?.recordId),
    ],
  },
  {
    name: 'PC T-A 大廳側邊欄：排行榜／投注明細打得開',
    bind: [TC.rankList, TC.historyPg],
    steps: [
      goto(),
      wait(15000, '等 Cocos 起來'),
      scene('lobby', '先確認人在大廳', TC.rankList?.recordId),
      // 側邊欄節點名是實測量到的：btn_home／btn_smallbet／btn_newport／btn_recents／
      // btn_favorite／btn_points／btn_jackpot／btn_news／btn_rank／btn_history
      clickNode('btn_rank', '點側邊欄 Ranking List'),
      wait(5000, '等排行榜頁建出來'),
      // `rank` 節點是點開之後才 active 的（實測 diff 出來的）
      seeNode('rank', '排行榜頁出現', TC.rankList?.recordId),
      shot('排行榜頁（數據與排序請人眼核對）', TC.rankList?.recordId),
      clickNode('btn_home', '回 Live Slots'),
      wait(4000, '等回到大廳'),
      clickNode('btn_history', '點側邊欄 History'),
      wait(5000, '等投注明細頁建出來'),
      seeNode('history', '投注明細頁出現', TC.historyPg?.recordId),
      // ⚠️ 「近三天」與滑動要人眼看
      shot('投注明細頁（日期範圍請人眼核對）', TC.historyPg?.recordId),
    ],
  },
  {
    name: 'PC T-A-002 How to play 影片打得開',
    bind: [TC.howToPlay],
    steps: [
      goto(),
      wait(15000, '等 Cocos 起來'),
      scene('lobby', '先確認人在大廳', TC.howToPlay?.recordId),
      // 🚨 `how_to_play` 掛在某一列遊戲上，一載入算出來是 (1188, -1184)＝**視窗外，點不到**。
      //    `find:` 會一路捲到它進視窗為止（自己猜百分比是猜不準的，實測捲 30% 反而更遠）。
      pcScroll('find:how_to_play', '捲到 How to play 進畫面'),
      seeNode('how_to_play', 'How to play 鍵在視窗內', TC.howToPlay?.recordId),
      clickNode('how_to_play', '點 How to play'),
      wait(6000, '等影片面板展開'),
      // `howtoplay_video` 是點開之後才 active 的（實測 diff 出來的）
      seeNode('howtoplay_video', '影片面板出現', TC.howToPlay?.recordId),
      // ⚠️ 影片播不播得動、關得掉關不掉要人眼——只留證據
      shot('How to play 面板（播放／關閉請人眼確認）', TC.howToPlay?.recordId),
    ],
  },
  {
    name: 'PC T-A Ranking List 滑動加載',
    bind: [TC.rankList],
    steps: [
      goto(),
      wait(15000, '等 Cocos 起來'),
      scene('lobby', '先確認人在大廳', TC.rankList?.recordId),
      clickNode('btn_rank', '點側邊欄 Ranking List'),
      wait(5000, '等排行榜頁建出來'),
      seeNode('rank', '排行榜頁出現', TC.rankList?.recordId),
      seeNode('item-jp', '排行榜有資料列', TC.rankList?.recordId),
      // 🚨 **一定要指定 `ScrollView-jp`。** 不指定的話它會去捲**被蓋在底下的大廳清單**，
      //    然後回報「捲到 50%」——畫面沒動、積木卻綠燈（實測 `item-jp` 位置 298 → 298）。
      //    指定之後才真的捲得到（298 → -176）。
      pcScroll('0.5', '把排行榜捲到一半', 'ScrollView-jp'),
      wait(3000, '等滑動加載'),
      // 捲完還有資料列＝清單有跟著載（空掉就是加載壞了）
      seeNode('item-jp', '捲動後仍有資料列（滑動加載正常）', TC.rankList?.recordId),
      // ⚠️ 「數據跟排序與後台對照一致」要人眼比對後台——這裡只留證據
      shot('排行榜捲動後（數據與排序請人眼對後台）', TC.rankList?.recordId),
    ],
  },
  {
    name: 'PC T-A 側邊欄：Reward Points／News／JP Video 三頁打得開',
    bind: [TC.rewardCards, TC.newsOrder, TC.jpVideo],
    steps: [
      goto(),
      wait(15000, '等 Cocos 起來'),
      scene('lobby', '先確認人在大廳', TC.rewardCards?.recordId),

      // ── Reward Points ──────────────────────────────────────────────────
      clickNode('btn_points', '點 Reward Points'),
      wait(5000, '等頁面建出來'),
      // 節點是實測 diff 出來的：點開後才 active
      seeNode('rewardpoints', '積分頁出現', TC.rewardCards?.recordId),
      seeNode('level', '等級區塊在', TC.rewardCards?.recordId),
      // ⚠️ 「6 個等級、鎖圖標、可左右滑」要人眼看——這裡只留證據
      shot('Reward Points 頁（等級卡與鎖圖標請人眼核對）', TC.rewardCards?.recordId),
      clickNode('btn_home', '回 Live Slots'),
      wait(4000, '等回大廳'),

      // ── News ───────────────────────────────────────────────────────────
      clickNode('btn_news', '點 News'),
      wait(5000, '等頁面建出來'),
      seeNode('news', 'News 頁出現', TC.newsOrder?.recordId),
      // ⚠️ 「排序比照後台」要人眼對後台
      shot('News 頁（排序請人眼對後台）', TC.newsOrder?.recordId),
      clickNode('btn_home', '回 Live Slots'),
      wait(4000, '等回大廳'),

      // ── Jackpot Video ──────────────────────────────────────────────────
      clickNode('btn_jackpot', '點 Jackpot Video'),
      wait(6000, '等影片頁建出來'),
      seeNode('jpmoment', 'JP Video 頁出現', TC.jpVideo?.recordId),
      seeNode('jpMomentItem', '影片項目有資料', TC.jpVideo?.recordId),
      shot('JP Video 頁（影片與資訊請人眼核對）', TC.jpVideo?.recordId),
    ],
  },
  {
    name: 'PC T-B machine 下注：帶入額度 → 空白鍵／Enter 轉動',
    bind: [TC.spinKeys],
    steps: [
      goto(),
      wait(15000, '等 Cocos 起來'),
      enter(GAME, `進一台空的 ${GAME}`),
      wait(8000, '等機台內畫面建好'),
      // 節點是實測量到的：play_btn1~5＝帶入額度（18/28/38/68/88 credits）、bet_btn1~5＝倍數
      seeNode('play_btn1', '帶入額度的按鈕在', TC.spinKeys?.recordId),
      // 🚨 **這一步會動到餘額**（實測送出 `dealGMActionReq {actionid: 6, isspin: 0}`）
      clickNodeDanger('play_btn1', '帶入額度（最小的那檔）'),
      wait(9000, '等額度帶入'),
      /**
       * 🚨 PC 的轉動**沒有按鈕節點**——帶入額度之後場景樹也沒有多出 spin 節點
       * （跟 H5 的 `.btn_spin` 不一樣）。實測**空白鍵與 Enter 都會送出
       * `dealGMActionReq {actionid: 7, isspin: 1}`**，正是這條 TC 要的。
       */
      pressKey('Space', '按空白鍵轉動'),
      // 🚨 這才是「真的轉了」的證據：WS 要送出 SPIN（actionid 7 / isspin 1）
      //    ⚠️ WS 界線是在**動作之前**推的，所以這裡只看得到剛才那一下按鍵之後的訊息
      seeWs('send:dealGMActionReq', '空白鍵真的送出 SPIN（isspin:1）', TC.spinKeys?.recordId, 'isspin:1'),
      seeWs('recv:dealGMActionReq', 'server 有回應這次 SPIN', TC.spinKeys?.recordId),
      wait(6000, '等這一局跑完'),
      pressKey('Enter', '按 Enter 轉動'),
      seeWs('send:dealGMActionReq', 'Enter 也真的送出 SPIN', TC.spinKeys?.recordId, 'isspin:1'),
      wait(6000, '等結算'),
      shot('按鍵轉動後的畫面（捲軸是否真的轉請人眼確認）', TC.spinKeys?.recordId),
      scene('game', '還在機台內（沒有被踢出去）', TC.spinKeys?.recordId),
    ],
  },
]

const existing = await fetch(`${BASE}/api/frontend-auto/scripts?platform=pc`, { headers: HEADERS })
  .then(r => r.json()).then(r => r.scripts ?? [])

for (const s of SCRIPTS) {
  const bindings = s.bind.filter(Boolean)
  const body = JSON.stringify({
    name: s.name, platform: 'pc', steps: s.steps, createdBy: 'claude', isPublic: true,
    larkUrl: LARK_URL, tableId: TABLE_ID, bindings,
  })
  const hit = existing.find(e => e.name === s.name)
  if (DRY) { console.log(`[dry] ${hit ? '更新' : '新增'} ${s.name}｜${s.steps.length} 顆｜綁 ${bindings.length} 筆 TC`); continue }
  const res = hit
    ? await fetch(`${BASE}/api/frontend-auto/scripts/${hit.id}`, { method: 'PUT', headers: HEADERS, body })
    : await fetch(`${BASE}/api/frontend-auto/scripts`, { method: 'POST', headers: HEADERS, body })
  const out = await res.json()
  console.log(`${out.ok ? '✅' : '❌'} ${hit ? '更新' : '新增'} ${s.name}｜${s.steps.length} 顆｜綁 ${bindings.length} 筆 TC${out.ok ? '' : '：' + JSON.stringify(out).slice(0, 140)}`)
}
