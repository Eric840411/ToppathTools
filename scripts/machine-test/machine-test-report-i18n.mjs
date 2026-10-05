// 機台測試報告中英對照（1004 使用者要求報告可切換中／EN）
// 做法：工具產生的訊息是固定句型拼起來的，所以用「片語對照表」由長到短替換，數字／代碼原樣保留；
// 對照表沒有的中文就留著（toEn 不會壞掉，只是那段還是中文）——新句型出現時在 PHRASES 補一行即可。
// 檢查覆蓋率：node machine-test-report-i18n.mjs  → 列出所有歷史報告裡還沒翻到的中文片段

const PHRASES = [
  // ── 步驟名稱／判定 ──
  ['進入機台', 'Enter machine'], ['推流檢測', 'Stream check'], ['Spin 測試', 'Spin test'], ['音頻檢測', 'Audio check'],
  ['iDeck 測試', 'iDeck test'], ['觸屏測試', 'Touchscreen test'], ['CCTV 號碼比對', 'CCTV ID match'], ['退出測試', 'Exit test'],
  ['測試流程', 'Test flow'], ['特殊遊戲等待', 'Feature game wait'],
  ['驗證通過', 'Verified'], ['驗證未過', 'Failed verification'], ['已驗項目通過', 'All verified items passed'],
  ['待人工確認', 'Needs manual check'], ['有必驗項目未驗', 'Required items not verified'],
  ['只跑部分測項', 'Partial run'], ['不判定整台', 'machine not judged as a whole'],
  ['沒有收到結果', 'No result received'], ['未執行或被中止', 'not run or aborted'], ['需重測', 're-test needed'],
  ['Lark 未回寫', 'not written back to Lark'], ['採用 session', 'using session'],
  ['結果沒帶 sessionId', 'result has no sessionId'], ['舊版 agent', 'old agent'], ['無法證明屬於本批', 'cannot prove it belongs to this batch'],
  ['待確認', 'to confirm'], ['使用者', 'user'],
  ['觸屏因機種未設定 touchPoints 未驗', 'touchscreen not verified (no touchPoints configured for this game)'], ['不列入必驗', 'not required'],
  ['進入', 'Enter'], ['推流', 'Stream'], ['音頻', 'Audio'], ['觸屏', 'Touchscreen'], ['退出', 'Exit'],

  // ── 進入 ──
  ['成功進入遊戲', 'Entered game'], ['協議回報進入成功', 'Protocol reported entry success'],
  ['秒後沒有任何 frame 進到 /game', 's later no frame reached /game'], ['整輪沒按到 Join', 'Join was never clicked'],
  ['可能停在 Game Preview', 'possibly stuck on Game Preview'], ['大廳找不到機台代碼', 'Machine code not found in lobby'],
  ['機台 Occupied', 'Machine Occupied'], ['Preview 畫面停在維修選單', 'Preview stuck on maintenance menu'],
  ['Game Preview 顯示 Occupied，沒有 Join', 'Game Preview shows Occupied, no Join'], ['進入失敗，跳過', 'Entry failed, skipped'],
  ['截圖', 'screenshot'],

  // ── 推流 ──
  ['沒有任何 video 在播', 'no video playing'], ['canvas 是遊戲 UI，不算推流', 'canvas is game UI, not a stream'],
  ['無 <video> 播放，但有 canvas 畫面，可能為 WebGL 推流', 'No <video> playing but canvas present, possibly WebGL stream'],
  ['播放中', 'playing'], ['活躍', 'active'], ['螢幕數', 'screens'], ['等了', 'waited'], ['例外', 'Exception'],

  // ── Spin ──
  ['Spin 確認執行', 'Spin confirmed'], ['餘額變化', 'balance change'], ['開局訊號', 'round-start signal'],
  ['Spin 已點擊，但餘額未變化', 'Spin clicked but balance unchanged'], ['可能：餘額為', 'possible: balance is'], ['或遊戲未實際執行', 'or game did not actually run'],
  ['Spin 按鈕已找到並點擊', 'Spin button found and clicked'], ['無法讀取餘額，無法確認是否執行', 'balance unreadable, cannot confirm it ran'],
  ['選單狀態未知', 'menu state unknown'], ['推流畫面判斷不了', 'cannot judge from stream image'], ['前端選面額等', 'frontend denomination pick waited'],
  ['秒選單', 's for menu'], ['這個機種沒有選單參考', 'no menu reference for this game'], ['停', 'stopped'],

  // ── 音頻 ──
  ['VB-Cable 錄音', 'VB-Cable recording'], ['峰值', 'peak'], ['基準', 'baseline'], ['重心', 'centroid'], ['PCM 樣本', 'PCM samples'],
  ['Spin 錄音', 'Spin recording'], ['無 media 元素', 'no media element'], ['個 media', ' media'], ['未靜音', 'unmuted'],
  ['問題', 'Issue'], ['音色偏亮/清脆', 'tone too bright'], ['頻譜重心', 'spectral centroid'], ['閾值', 'threshold'],
  ['可能受其他聲音干擾', 'possibly affected by other sound'], ['爆音風險', 'clipping risk'], ['靜音', 'silent'], ['無音訊', 'no audio'],
  ['音量偏低', 'volume low'], ['音量過大', 'volume too high'], ['可能受其', 'possibly affected by'],

  // ── iDeck ──
  ['server 回應', 'server responded'], ['還原', 'restored'], ['中止，沒有還原倍數', 'aborted, multiplier not restored'],
  ['沒有倍數鍵，不需還原', 'no multiplier key, no restore needed'], ['盒子 log 新增', 'box log added'], ['盒子 log 未查', 'box log not checked'],
  ['筆', ' entries'], ['未通過', 'Failed'], ['秒內', 's'], ['機台 log API 查不到', 'machine log API cannot find'],
  ['CMDB未找到机器', 'CMDB has no machine'], ['的IP', ' IP'], ['已點', 'clicked'], ['個按鈕但無法確認盒子回應', ' buttons but cannot confirm box response'],
  ['隨機下注XPath', 'Random bet XPath'], ['個按鈕', ' buttons'], ['有 iDeck 回應', 'with iDeck response'], ['API 確認', 'API confirmed'],
  ['未驗', 'Not verified'],

  // ── 觸屏 ──
  ['個觸屏點位', ' touch points'], ['遊戲收下', 'game received'], ['送出', 'sent'], ['有觸屏回應', 'with touch response'],
  ['前端沒送', 'frontend did not send'], ['滑鼠無反應', 'mouse no response'], ['滑鼠', 'mouse'], ['CDP觸控', 'CDP touch'], ['JS觸控', 'JS touch'],
  ['【畫面判定】', '[Screen check] '], ['【自動挑點】', '[Auto points] '], ['賠率表', 'paytable'],
  ['選面額選單', 'denomination menu'], ['畫面有打開、但再點一次沒關掉', 'screen opened but did not close on second tap'],
  ['雜訊', 'noise'], ['門檻', 'threshold'], ['點後', 'after tap'], ['關後', 'after close'],
  ['找不到 main 推流畫面', 'main stream not found'], ['沒點', 'not tapped'], ['點下去畫面有變，但不是', 'screen changed after tap but is not'],
  ['點之前已經在', 'already on'], ['點之前畫面已經是', 'screen was already'], ['點一次', 'tap once'], ['參考', 'reference'],
  ['點下去畫面有打開', 'screen opened after tap'], ['設定為', 'configured as'], ['想關掉但', 'to close but'],
  ['點了但畫面沒變', 'tapped but screen unchanged'], ['診斷', 'diagnostics'], ['文字符合', 'text match'], ['用外層定位', 'outer positioning'],
  ['量不到尺寸', 'size unmeasurable'], ['不同高度', 'different height'], ['中間', 'middle'], ['前端送出', 'frontend sent'],
  ['未設定 touchPoints，且自動偵測找不到觸屏格子', 'No touchPoints configured and auto-detect found no touch grid'],
  ['個 frame 都沒有文字符合「列,行」的 span', ' frames have no span matching "row,col"'], ['沒有文字符合「列,行」的 span', 'no span matching "row,col"'],
  ['點之前', 'Before tap'], ['點下去（應為預期畫面）', 'After tap (should be expected screen)'], ['再點一次（應關回來）', 'Tap again (should close)'],

  // ── CCTV ──
  ['CCTV 播放中', 'CCTV playing'], ['識別碼', 'ID'], ['時間', 'time'], ['畫面清晰', 'image clear'], ['畫面模糊', 'image blurry'],
  ['偵測到異常文字', 'unexpected text detected'], ['編號相符', 'ID matches'], ['構圖完整', 'framing complete'], ['構圖未判讀', 'framing not judged'],
  ['構圖', 'framing'], ['只拍到機台側邊局部', 'only part of machine side captured'], ['人工判', 'manual judgment'],
  ['影像編號不符', 'video ID mismatch'], ['影像', 'video'], ['機台', 'machine'], ['編號未驗證', 'ID not verified'],
  ['OCR 讀到的', 'OCR value'], ['也出現在網頁文字', 'also appears in page text'], ['跑馬燈等', 'marquee etc.'],
  ['影像或機台代碼取不到數字', 'no digits in video or machine code'], ['無法識別', 'unrecognized'],
  ['CCTV 容器存在但找不到 video 元素', 'CCTV container exists but no video element'], ['已截圖留證', 'screenshot saved'],
  ['浮水印只有', 'watermark only shows'], ['OCR 回的', 'OCR returned'], ['是頁面跑馬燈，不採用', 'is page marquee, ignored'],
  ['判定', 'verdict'], ['CCTV 畫面', 'CCTV image'], ['模糊', 'blurry'], ['沒有機台編號浮水印', 'no machine ID watermark'],

  // ── 退出 ──
  ['已成功退出至大廳', 'Exited to lobby'], ['後收到', 'then received'], ['退出成功，期間推進遊戲', 'exit succeeded; game advanced'],
  ['退出異常（帳號卡在這台）', 'exit abnormal (account stuck on this machine)'], ['連續', ''], ['退出都沒回到大廳、看不出遊戲進行中', ' exit attempts in a row did not return to lobby, no game in progress'],
  ['症狀', 'symptom'], ['畫面', 'screen'], ['最後一次', 'last attempt'], ['點擊退出後仍偵測為在遊戲內', 'still in game after clicking exit'],
  ['可能有未處理的確認視窗', 'possibly an unhandled confirm dialog'], ['沒有彈窗', 'no popup'], ['使用者中止', 'Aborted by user'],
  ['未確認已離機', 'leaving machine not confirmed'], ['退出超過上限', 'exit exceeded limit'], ['仍未回到大廳', 'still not back in lobby'],
  ['分鐘', ' min'], ['推進', 'advanced'], ['額度可能還在', 'credit may still be on machine'],
  ['盲推 feature 中止：剩餘額度不夠再付一把', 'blind feature push aborted: not enough credit for another round'],
  ['已少', 'lost'], ['上限', 'limit'], ['單把估', 'est. per round'], ['本台已推', 'pushed on this machine'], ['下', 'times'],
  ['本批次後面的機台不再測試', 'remaining machines in this batch not tested'], ['未執行：前一台需人工處理', 'Not run: previous machine needs manual handling'],
  ['第', '#'], ['次', 'x'],

  // ── 開跑前檢查／測試前準備 ──
  ['CCTV 構圖範例', 'CCTV framing samples'], ['agent 已是最新', 'agent up to date'], ['機種設定', 'game config'], ['已同步', 'synced'],
  ['沒有機種設定檔（新機種，走自動偵測）', 'no game config file (new game, auto-detect)'], ['在線、閒置', 'online, idle'],
  ['不在影像辨識監控內（FG/JP 偵測不到）', 'not in image-recognition monitoring (FG/JP not detectable)'],
  ['帳號在大廳', 'account in lobby'], ['帳號環境', 'account environment'], ['本機 agent 不在線，將自動啟動', 'local agent offline, will auto-start'],
  ['機種', 'Game'], ['FG/JP 啟動方式', 'FG/JP trigger'], ['觸屏 未設定 → 觸屏步驟會自動偵測格子（找不到才算未驗）', 'touchscreen not configured → auto-detect grid (not verified only if none found)'],
  ['觸屏 未設定（觸屏會是未驗）', 'touchscreen not configured (will be not verified)'], ['格', ' cells'],
  ['沒有機台配置（FG/JP 啟動方式、iDeck、觸屏會用預設或跳過）', 'no machine config (FG/JP trigger, iDeck, touchscreen use defaults or skip)'],
  ['退出處理手冊', 'exit playbook'], ['條', ' entries'],
  ['中控目前有進行中的測試 session', 'control server has a test session running'], ['忙碌中', 'busy'],
  ['有任務進行中，不檢查／不清理帳號座位', 'task running, account seat not checked/cleared'],
  ['盒子版號', 'Box version'], ['盒子狀態', 'Box status'], ['盒子', 'Box'], ['有無接 LuckyLink', 'LuckyLink connected'],
  ['LuckyLink 版本', 'LuckyLink version'], ['LuckyLink 協議', 'LuckyLink protocol'], ['LuckyLink 沒接上（沒有協議、未授權、沒有群組），預期有接', 'LuckyLink not connected (no protocol, unauthorized, no group), expected connected'],
  ['沒有這台，預期有接', 'does not list this machine, expected connected'], ['協議', 'protocol'], ['版本', 'version'], ['預期', 'expected'],
  ['沒接（無協議、未授權、無群組）', 'not connected (no protocol, unauthorized, no group)'], ['無', 'none'],

  // ── 錯誤區常見 ──
  ['已斷線', 'disconnected'], ['部署重啟中控，跑中的 session 被斷', 'deploy restarted control server, running session cut off'],
  ['起各中斷一次，已重跑', 'each interrupted once, re-run'], ['重測紀錄', 're-test log'], ['重測', 're-test'], ['再', 'again'],
['閒置踢出', 'idle-kicked'], ['最後下注→退出約', 'last bet → exit about'], ['換', 'switched to'],
  ['全部 PASS', 'all PASS'], ['閒置時間較短，尚不能斷定是帳號問題', 'shorter idle time, cannot yet conclude it is an account issue'],
  ['本報告', 'this report'], ['採最後一次結果', 'uses the latest result'], ['由', 'tested by'], ['測試', 'test'], ['批自動換帳號', ' batch auto account switch'], ['自動換帳號', ' auto account switch'], ['預期值', 'Expected'],
  ['退出前已被', 'before exit, already'],
  ['自動續跑中止', 'auto-resume aborted'], ['續跑準備例外', 'resume preparation exception'],

  // ── 補充（覆蓋率檢查找出來的）──
  ['iDeck 開局', 'iDeck round starts'], ['開局', 'round start'], ['顆', ' buttons'], ['到達', 'reached'], ['監聽', 'listeners'],
  ['點擊點最上層', 'topmost at click point'], ['祖先', 'ancestors'], ['分布', 'distribution'], ['觸控事件', 'touch event'], ['事件', 'event'],
  ['面板', 'panel'], ['無音頻輸出', 'no audio output'], ['輸出', 'output'], ['設定為不關閉', 'configured not to close'], ['不關閉', 'not closing'],
  ['基準量測', 'baseline measurement'], ['量測', 'measurement'], ['重拍', 'retakes'], ['輪', ' rounds'],
  ['server 全部回應但盒子 log', 'server responded to all but box log'], ['待查', 'to investigate'], ['正常範圍', 'normal range'],
  ['參考圖差異', 'reference image diff'], ['圖差異', 'image diff'], ['點了也看不出反應', 'no visible reaction after tap'],
  ['確認是', 'confirmed as'], ['不合格', 'unacceptable'], ['不是攝影機浮水印', 'not the camera watermark'], ['浮水印沒有機台編號', 'watermark has no machine ID'],
  ['浮水印', 'watermark'], ['沒關', 'not closed'], ['仍開著', 'still open'], ['沒有設定關選單的', 'no menu-close configured for'],
  ['不判', 'not judged'], ['沒等到', 'did not get'], ['不補點', 'no extra tap'], ['點', 'tap'], ['失敗', 'failed'], ['秒', 's'], ['但', 'but'],
  ['差值僅', 'difference only'], ['沒反應', 'no response'], ['沒有彈框', 'no popup'], ['未知', 'unknown'], ['沒在播', 'not playing'],
  ['照原流程', 'following original flow'], ['仍顯示在遊戲內', 'still shown in game'], ['看不出', 'cannot tell'], ['是不是', 'whether'],
  ['在選單', 'on menu'], ['自動學選單', 'auto-learned menu'], ['試跑進場造成', 'caused by trial entry'], ['之後', 'after'], ['掛著帳號', 'account still attached'],
  ['期間', 'during'], ['干擾', 'interference'], ['編號', 'ID'], ['帶', 'with'], ['此', 'this'], ['數', 'count'], ['圖', 'image'],

  // ── 畫面方向 ──
  ['待人工判讀', 'needs manual review'], ['塊', ' panels'], ['舊 agent 沒帶畫面位置，整張', 'old agent sent no positions, whole image'],
  ['沒有推流截圖，方向未驗', 'no stream screenshot, orientation not verified'], ['只拍到 Game Preview（Occupied），沒有推流可判', 'only Game Preview (Occupied), no stream to judge'],
  ['正向', 'upright'], ['正立', 'upright'], ['可讀', 'readable'], ['皆', 'all'], ['上螢幕', 'top screen'], ['下螢幕', 'bottom screen'], ['主螢幕', 'main screen'],
  ['不列入', 'excluded'], ['網頁浮層', 'web overlay'], ['浮層', 'overlay'], ['網頁 UI', 'web UI'], ['寶箱', 'chest'], ['獎池', 'jackpot'], ['金額', 'amount'],
  ['字樣', 'text'], ['文字', 'text'], ['滾輪符號', 'reel symbols'], ['滾輪', 'reels'], ['列', 'row'], ['數字', 'digits'], ['正讀', 'read upright'],
  ['小工具', 'widget'], ['前端', 'frontend'], ['先前倒轉，這次已正常', 'was upside down before, normal now'], ['直排為設計', 'vertical by design'],
  ['主推流沒在播', 'main stream not playing'], ['裁切只截到', 'crop only caught'], ['無法判讀方向', 'cannot judge orientation'],
  ['另兩塊為', 'other two panels are'], ['亦', 'also'], ['只截到', 'only caught'], ['判讀', 'judged'], ['為', 'is'], ['與', 'and'], ['字', 'text'],
  ['另', 'other'], ['個', ''], ['和', 'and'], ['或', 'or'],
]

// 由長到短，避免短詞先吃掉長句的一部分
const SORTED = [...PHRASES].sort((a, b) => b[0].length - a[0].length)
const PUNCT = [['（', ' ('], ['）', ') '], ['：', ': '], ['，', ', '], ['、', ', '], ['；', '; '], ['｜', ' | '], ['。', '. '], ['「', '"'], ['」', '"'], ['／', '/'], ['→', ' → '], ['——', ' — ']]

// 帶數字的句型先用正則處理（片語表處理不了語序）
const PATTERNS = [
  [/iDeck 開局\s*(\d+)\s*顆/g, 'iDeck buttons that started a round: $1'],
  [/由\s*(\S+?)\s*測試/g, 'tested by $1'],
  [/第\s*(\d+)\s*批/g, 'batch $1'], [/第\s*(\d+)\s*次/g, 'attempt $1'], [/第\s*(\d+)\s*列/g, 'row $1'],
  [/(\d+)\s*次/g, '$1×'], [/(\d+(?:\.\d+)?)\s*分(?!鐘)/g, '$1 min'],
]

export function toEn(text) {
  if (text == null) return ''
  let t = String(text)
  if (!/[　-鿿＀-￯]/.test(t)) return t
  for (const [re, en] of PATTERNS) t = t.replace(re, en)
  for (const [zh, en] of SORTED) if (t.includes(zh)) t = t.split(zh).join(` ${en} `)
  for (const [a, b] of PUNCT) t = t.split(a).join(b)
  return t.replace(/[ \t]{2,}/g, ' ').replace(/ +([,.:;)])/g, '$1').replace(/\( +/g, '(').trim()
}

// 覆蓋率檢查：掃歷史報告 summary.json，列出 toEn 後仍殘留的中文片段（出現次數多的先列）
// 直接執行：node scripts/machine-test/machine-test-report-i18n.mjs [列幾筆]（資料在 MT_HOME，預設 repo 旁邊的 osm-qa-agent）
const { fileURLToPath } = await import('node:url')
const path = await import('node:path')
const SELF = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const fs = await import('node:fs')
  const texts = []
  const reports = path.join(process.env.MT_HOME ?? path.resolve(path.dirname(SELF), '..', '..', '..', 'osm-qa-agent'), 'reports')
  for (const d of fs.readdirSync(reports).filter(d => d.startsWith('machine-test-'))) {
    const f = path.join(reports, d, 'summary.json'); if (!fs.existsSync(f)) continue
    const s = JSON.parse(fs.readFileSync(f, 'utf8'))
    texts.push(...(s.preflight?.problems ?? []), ...(s.preflight?.notes ?? []), ...(s.errors ?? []), ...(s.preTest?.batchWarn ?? []), ...(s.preTest?.errs ?? []))
    for (const r of s.preTest?.rows ?? []) texts.push(...r.issues)
    for (const m of s.machines ?? []) { texts.push(m.verdict, m.orientation?.note); for (const x of m.result?.steps ?? []) texts.push(x.message) }
  }
  const left = new Map(); let total = 0, clean = 0
  for (const t of texts.filter(Boolean)) { total++; const e = toEn(t); const hits = e.match(/[　-鿿]+/g); if (!hits) clean++; for (const h of hits ?? []) left.set(h, (left.get(h) ?? 0) + 1) }
  console.log(`訊息 ${total} 則，完全翻譯 ${clean} 則（${(clean / total * 100).toFixed(1)}%）`)
  console.log([...left].sort((a, b) => b[1] - a[1]).slice(0, Number(process.argv[2] ?? 40)).map(([k, n]) => `${n}\t${k}`).join('\n'))
}
