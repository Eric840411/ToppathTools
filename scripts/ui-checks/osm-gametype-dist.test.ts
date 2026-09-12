/**
 * src/pages/osm-gametype-dist 的單元測試。純函式，不開瀏覽器也不打網路。
 *
 * 跑法：npx tsx scripts/ui-checks/osm-gametype-dist.test.ts
 *
 * 這裡守三條容易靜默壞掉的線：
 *   ① 機種代碼的取法要跟機種卡完全一樣（不一樣的話彈窗台數會跟卡片數字對不上）
 *   ② 只有離線機台的渠道**仍然要被列出來**（濾掉等於回答「這個渠道沒有這個機種」）
 *   ③ 版本基準只看線上機台（含離線的話會把正常機台標成異常）
 */
import {
  gameTypeOf,
  isMachineOnline,
  groupByChannelForType,
  groupByMachineType,
  machineTypeKeyOf,
  hasVersionMismatch,
  matchRange,
  normalizeQuery,
  referenceVersion,
  searchDistribution,
  visibleMachines,
  type GtChannel,
  type GtMachine,
} from '../../src/pages/osm-gametype-dist.ts'

let pass = 0
const fails: string[] = []

function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) }
  else { fails.push(name + ' | got: ' + g + ' | want: ' + w); console.log('❌ ' + name + ' | got: ' + g + ' | want: ' + w) }
}

let seq = 0
const M = (machineName: string, onlineState: string, version = '1.0.0', machineType = ''): GtMachine =>
  ({ id: 'm' + (++seq), machineName, machineType, version, onlineState })

// ── ① 機種代碼取法 ───────────────────────────────────────────────────────────
eq('取名稱中段', gameTypeOf(M('873-RISINGROCKETS-0011', 'online')), 'risingrockets')
eq('大小寫收斂成小寫', gameTypeOf(M('873-BullBlitz-0001', 'online')), 'bullblitz')
// ⚠️ 這條是兩套取法的差異點：名稱切不出中段時要退回 machineType
eq('名稱沒有分隔號時退回 machineType', gameTypeOf(M('SOMEBOX', 'online', '1.0.0', 'DFDC')), 'dfdc')
eq('連 machineType 也沒有才用整段名稱', gameTypeOf(M('SOMEBOX', 'online', '1.0.0', '')), 'somebox')

eq('online 判定', isMachineOnline(M('a-b-1', 'Online')), true)
eq('前後空白也認得', isMachineOnline(M('a-b-1', '  online  ')), true)
eq('offline 不是 online', isMachineOnline(M('a-b-1', 'offline')), false)
eq('空字串不是 online', isMachineOnline(M('a-b-1', '')), false)

// ── ② 分組 ───────────────────────────────────────────────────────────────────
const CHANNELS: GtChannel[] = [
  { name: 'CP', machines: [
    M('873-RISINGROCKETS-0011', 'online', '1.2.24'),
    M('873-RISINGROCKETS-0012', 'online', '1.2.24'),
    M('873-BULLBLITZ-0001', 'online', '2.0.0'),
  ] },
  { name: 'WF', machines: [
    M('881-RISINGROCKETS-0002', 'online', '1.2.24'),
    M('881-RISINGROCKETS-0003', 'offline', '1.2.19'),
    M('881-RISINGROCKETS-0004', '', '1.2.19'),
  ] },
  // ⚠️ 這個渠道的目標機種「全部離線」——它一定要出現在結果裡
  { name: 'TBR', machines: [
    M('885-RISINGROCKETS-0001', 'offline', '1.2.19'),
    M('885-RISINGROCKETS-0002', 'offline', '1.2.19'),
  ] },
  // 完全沒有這個機種的渠道才該被濾掉
  { name: 'TBP', machines: [M('887-DFDC-0001', 'online', '3.0.0')] },
]

const groups = groupByChannelForType(CHANNELS, 'risingrockets')
eq('只列出真的有這個機種的渠道', groups.map(g => g.name), ['CP', 'WF', 'TBR'])
eq('渠道順序沿用傳進來的順序', groups.map(g => g.name).join('>'), 'CP>WF>TBR')
eq('每個渠道只留這個機種的機台', groups.map(g => g.machines.length), [2, 3, 2])
eq('線上數', groups.map(g => g.online), [2, 1, 0])
eq('離線數', groups.map(g => g.offline), [0, 1, 2])
eq('未知數', groups.map(g => g.unknown), [0, 1, 0])
// 這條是這個功能的重點：全部離線的渠道不能消失
eq('全部離線的渠道仍然在結果裡', groups.some(g => g.name === 'TBR' && g.online === 0), true)
eq('沒有這個機種的渠道被濾掉', groups.some(g => g.name === 'TBP'), false)
eq('查不到的機種回空陣列', groupByChannelForType(CHANNELS, 'notexist'), [])

// ── ③ 版本基準 ───────────────────────────────────────────────────────────────
// 線上版本：1.2.24 ×3（CP 兩台 + WF 一台）。離線的 1.2.19 有四台，但不該影響基準。
eq('版本基準只看線上機台', referenceVersion(groups), null)

const MIXED: GtChannel[] = [
  { name: 'CP', machines: [
    M('873-X-0001', 'online', '1.2.24'),
    M('873-X-0002', 'online', '1.2.24'),
    M('873-X-0003', 'online', '1.2.19'),
    M('873-X-0004', 'offline', '0.9.0'),
    M('873-X-0005', 'offline', '0.9.0'),
    M('873-X-0006', 'offline', '0.9.0'),
  ] },
]
const mixedGroups = groupByChannelForType(MIXED, 'x')
// 離線的 0.9.0 有三台、比任何線上版本都多，但它不能成為基準
eq('離線版本再多也不會變成基準', referenceVersion(mixedGroups), '1.2.24')

eq('只有一種線上版本時不標色', referenceVersion(groupByChannelForType([
  { name: 'CP', machines: [M('873-Y-0001', 'online', '1.0.0'), M('873-Y-0002', 'online', '1.0.0')] },
], 'y')), null)
eq('線上機台沒有版本字串時不標色', referenceVersion(groupByChannelForType([
  { name: 'CP', machines: [M('873-Z-0001', 'online', ''), M('873-Z-0002', 'online', '')] },
], 'z')), null)

// ── 顯示哪些列 ───────────────────────────────────────────────────────────────
const wf = groups[1]
eq('預設只顯示線上機台', visibleMachines(wf, false).map(m => m.machineName), ['881-RISINGROCKETS-0002'])
eq('開關打開顯示全部', visibleMachines(wf, true).map(m => m.machineName).length, 3)
eq('開關打開時線上排前面',
  visibleMachines(wf, true).map(m => isMachineOnline(m)), [true, false, false])
const tbr = groups[2]
eq('全部離線的渠道預設沒有可顯示的列', visibleMachines(tbr, false), [])
eq('全部離線的渠道打開開關就看得到', visibleMachines(tbr, true).length, 2)
// visibleMachines 不能就地改動原陣列（原陣列同時是上面那些數字的來源）。
// ⚠️ 這裡刻意用「來源順序剛好跟排序後不同」的資料——用 WF 那組驗不到，因為它本來就已經是
// 線上排前面，就地排序前後看起來一樣，測試會假通過。
const UNSORTED: GtChannel[] = [
  { name: 'MDR', machines: [
    M('889-RISINGROCKETS-0009', 'offline', '1.2.19'),
    M('889-RISINGROCKETS-0001', 'online', '1.2.24'),
  ] },
]
const unsortedGroup = groupByChannelForType(UNSORTED, 'risingrockets')[0]
const sourceOrderBefore = unsortedGroup.machines.map(m => m.machineName).join(',')
eq('排序後線上排前面',
  visibleMachines(unsortedGroup, true).map(m => m.machineName),
  ['889-RISINGROCKETS-0001', '889-RISINGROCKETS-0009'])
eq('不會就地改動來源陣列',
  unsortedGroup.machines.map(m => m.machineName).join(','), sourceOrderBefore)
eq('來源順序確實跟排序結果不同（證明上一條驗得到東西）',
  sourceOrderBefore, '889-RISINGROCKETS-0009,889-RISINGROCKETS-0001')



// ── 型號（machineType）分組 ──────────────────────────────────────────────────
// 案例取自真實資料（全渠道 1460 筆 egmList）：machineType 是 `dfdcgrand1`／`wlzbhelix25`
// 這種「機種代碼 + 編號」的值，**0 筆空值、0 組大小寫或空白不一致**（65 種全部本來就是小寫），
// 所以這裡不需要像機殼名稱那種麻煩的合併判斷，只要 trim + 小寫防呆。
const TYPE_ROWS: GtMachine[] = [
  // 真實資料：NP 渠道的 wlzbhelix 底下有 wlzbhelix9/10/11/…/25 共 12 種
  M('873-WLZBHELIX-0001', 'online', '1.0.0', 'wlzbhelix10'),
  M('873-WLZBHELIX-0002', 'online', '1.0.0', 'wlzbhelix10'),
  M('873-WLZBHELIX-0003', 'offline', '1.0.0', 'wlzbhelix10'),
  M('873-WLZBHELIX-0004', 'online', '1.0.0', 'wlzbhelix9'),
  M('873-WLZBHELIX-0005', 'online', '1.0.0', 'wlzbhelix25'),
  M('873-WLZBHELIX-0006', 'online', '1.0.0', 'WLZBHELIX25'), // 大小寫防呆
  M('873-WLZBHELIX-0007', 'online', '1.0.0', ' wlzbhelix25 '), // 前後空白防呆
]

eq('大小寫算同一個型號',
  machineTypeKeyOf(M('a-b-1', 'online', '1.0.0', 'WLZBHELIX25')),
  machineTypeKeyOf(M('a-b-2', 'online', '1.0.0', 'wlzbhelix25')))
eq('前後空白算同一個型號',
  machineTypeKeyOf(M('a-b-1', 'online', '1.0.0', ' wlzbhelix25 ')),
  machineTypeKeyOf(M('a-b-2', 'online', '1.0.0', 'wlzbhelix25')))
// ⚠️ 編號不同就是不同型號，絕對不能因為前綴一樣就併起來
eq('編號不同是不同型號',
  machineTypeKeyOf(M('a-b-1', 'online', '1.0.0', 'wlzbhelix25'))
    === machineTypeKeyOf(M('a-b-2', 'online', '1.0.0', 'wlzbhelix24')), false)
eq('10pct 那種變體也是獨立型號',
  machineTypeKeyOf(M('a-b-1', 'online', '1.0.0', 'wlzbhelix10'))
    === machineTypeKeyOf(M('a-b-2', 'online', '1.0.0', 'wlzbhelix10pct19')), false)

const typeGroups = groupByMachineType(TYPE_ROWS)
eq('分出正確的型號組數', typeGroups.length, 3)
eq('wlzbhelix25 三種寫法併成一組',
  typeGroups.find(g => g.key === 'wlzbhelix25')?.machines.length, 3)
// 同一組裡有多種寫法時顯示「最多台在用」的那個：這裡 'wlzbhelix25' 2 台、'WLZBHELIX25' 1 台
eq('顯示最多台在用的原始寫法，不是正規化後的 key',
  typeGroups.find(g => g.key === 'wlzbhelix25')?.label, 'wlzbhelix25')
// 平手時取 codepoint 順序第一個（穩定、不隨環境 locale 變）
eq('平手時的顯示寫法是穩定的',
  groupByMachineType([
    M('873-Y-0001', 'online', '1.0.0', 'wlzbhelix30'),
    M('873-Y-0002', 'online', '1.0.0', 'WLZBHELIX30'),
  ])[0].label, 'WLZBHELIX30')
eq('wlzbhelix10 那組有 3 台', typeGroups.find(g => g.key === 'wlzbhelix10')?.machines.length, 3)
eq('wlzbhelix10 那組線上 2 台', typeGroups.find(g => g.key === 'wlzbhelix10')?.online, 2)
// ⚠️ 自然排序：純字串排序會把 wlzbhelix10 排在 wlzbhelix9 前面，而真實資料裡一個機種底下
// 有 16 種型號（6、8、9、10…25），排錯會很難掃
eq('型號用自然排序（9 在 10 前面）',
  typeGroups.map(g => g.key), ['wlzbhelix9', 'wlzbhelix10', 'wlzbhelix25'])

// 真實資料裡的 test3：CP 的 4171-BWJL-9015 型號是 test3，不以機種代碼開頭（測試機）。
// 它應該照樣被列出來，不能因為「看起來不像這個機種的型號」就藏掉。
const ODD_ROWS: GtMachine[] = [
  M('4171-BWJL-9001', 'online', '1.0.0', 'bwjl1'),
  M('4171-BWJL-9015', 'online', '1.0.0', 'test3'),
]
const oddGroups = groupByMachineType(ODD_ROWS)
eq('型號不以機種代碼開頭也照樣列出', oddGroups.map(g => g.key), ['bwjl1', 'test3'])

// 型號沒有值的那組
const NO_TYPE_ROWS: GtMachine[] = [
  M('873-X-0001', 'online', '1.0.0', 'x1'),
  M('873-X-0002', 'online', '1.0.0', ''),
]
const noTypeGroups = groupByMachineType(NO_TYPE_ROWS)
eq('沒有型號的那組不會被丟掉', noTypeGroups.length, 2)
eq('沒有型號的那組排最後', noTypeGroups[noTypeGroups.length - 1].key, '')
eq('沒有型號的那組 label 是空的（畫面顯示「型號未提供」）',
  noTypeGroups[noTypeGroups.length - 1].label, '')

// ⚠️ 台數守恆：分組只能搬動機台，不能弄丟。少一台在畫面上看不出來，但渠道統計就會對不上
eq('分組前後台數守恆',
  typeGroups.reduce((sum, g) => sum + g.machines.length, 0), TYPE_ROWS.length)
eq('每台機器只會出現在一組',
  new Set(typeGroups.flatMap(g => g.machines.map(m => m.id))).size, TYPE_ROWS.length)
eq('空陣列不會爆', groupByMachineType([]), [])
// ── 彈窗內搜尋（v4.143.0）────────────────────────────────────────────────────
// 這四項是 CodeX review 時點名要驗的：濾掉後的計數、離線被藏住的狀態、
// 完全沒命中的狀態、以及「按了顯示離線之後結果要立刻正確浮出來」。
const SRCH: GtChannel[] = [
  // WF：26 台全離線（真實資料 dragontrio 的形狀）
  { name: 'WF', machines: Array.from({ length: 26 }, (_, i) =>
      M('4173-DRAGONTRIO-' + (2001 + i), 'offline', '1.17.40', 'dragontrio1')) },
  // NCH：13 台全線上
  { name: 'NCH', machines: Array.from({ length: 13 }, (_, i) =>
      M('4175-DRAGONTRIO-' + (1456 + i), 'online', '1.18.10', 'dragontrio1')) },
]
const sg = groupByChannelForType(SRCH, 'dragontrio')

// 沒有搜尋時：行為必須跟加搜尋之前完全一樣
const none = searchDistribution(sg, '', false)
eq('沒搜尋時 active 是 false', none.active, false)
eq('沒搜尋時渠道全列出（含全離線的 WF）', none.channels.map(c => c.channel.name), ['WF', 'NCH'])
eq('沒搜尋時 totalCount 是機種總台數', none.totalCount, 39)
eq('沒搜尋時 WF 沒有可見列（預設不顯示離線）',
  none.channels[0].models[0].visible.length, 0)
eq('沒搜尋時 NCH 13 台都看得到', none.channels[1].models[0].visible.length, 13)

// ① 濾掉後的計數：命中一台線上機台
const one = searchDistribution(sg, '1460', false)
eq('① 只留有命中的渠道', one.channels.map(c => c.channel.name), ['NCH'])
eq('① 全域命中數', one.matchCount, 1)
eq('① 分母不隨搜尋變動', one.totalCount, 39)
eq('① 渠道層級的命中數', one.channels[0].matchCount, 1)
eq('① 型號那組只留命中的那台', one.channels[0].models[0].matched.length, 1)
eq('① 可見列數跟命中數一致', one.channels[0].models[0].visible.length, 1)
// ⚠️ 型號標籤上的「總數」要維持整組，否則畫面會說「1 / 1 台」，看起來像這個型號只有一台
eq('① 型號標籤的分母仍是整組台數', one.channels[0].models[0].group.machines.length, 13)

// ② 命中全在離線裡（最危險的狀態）——不能看起來像 0 筆
const off = searchDistribution(sg, '2001', false)
eq('② 有命中（不是 0 筆）', off.matchCount, 1)
eq('② 命中的那台被離線開關藏住', off.hiddenByOffline, 1)
eq('② 所以可見列是 0', off.channels[0].models[0].visible.length, 0)
// 這兩個加起來就是「畫面上要顯示黃字＋按鈕」的判斷依據
eq('② matched > 0 但 visible === 0（畫面據此顯示可行動提示）',
  off.channels[0].models[0].matched.length > 0 && off.channels[0].models[0].visible.length === 0, true)

// ③ 完全沒命中：跟 ② 必須分得開
const no = searchDistribution(sg, 'zzzzz', false)
eq('③ 沒有任何渠道', no.channels.length, 0)
eq('③ 命中數 0', no.matchCount, 0)
eq('③ 沒有被藏住的（跟 ② 的差別就在這）', no.hiddenByOffline, 0)
eq('③ 跟 ② 分得開：② 有命中、③ 沒有',
  off.matchCount > 0 && no.matchCount === 0, true)

// ④ 按「顯示離線」之後，同一個搜尋要立刻正確浮出來
const revealed = searchDistribution(sg, '2001', true)
eq('④ 打開離線後看得到那台', revealed.channels[0].models[0].visible.length, 1)
eq('④ 打開後沒有被藏住的了', revealed.hiddenByOffline, 0)
eq('④ 命中數不變（開關只影響看不看得到，不影響命中）',
  revealed.matchCount, off.matchCount)
eq('④ 浮出來的是搜尋命中的那台，不是整組 26 台',
  revealed.channels[0].models[0].visible.map(m => m.machineName), ['4173-DRAGONTRIO-2001'])

// 搜渠道名 / 型號 → 整個渠道或整組視為符合（否則打 NCH 會什麼都不剩）
const byChan = searchDistribution(sg, 'nch', false)
eq('搜渠道名：只留那個渠道', byChan.channels.map(c => c.channel.name), ['NCH'])
eq('搜渠道名：整個渠道 13 台都算符合', byChan.matchCount, 13)
eq('搜渠道名：標記成整組命中', byChan.channels[0].models[0].wholeGroupHit, true)
const byModel = searchDistribution(sg, 'dragontrio1', false)
eq('搜型號：兩個渠道都留下', byModel.channels.map(c => c.channel.name), ['WF', 'NCH'])
eq('搜型號：39 台全部算符合', byModel.matchCount, 39)

// 搜版本——真實用途：挑出版本落後的那些
const byVer = searchDistribution(sg, '1.17', false)
eq('搜版本只命中舊版那批', byVer.matchCount, 26)
eq('搜版本時它們全被離線開關藏住', byVer.hiddenByOffline, 26)

// 大小寫與前後空白
eq('搜尋不分大小寫', searchDistribution(sg, 'DRAGONTRIO-1456', false).matchCount, 1)
eq('前後空白會被去掉', searchDistribution(sg, '  1456  ', false).matchCount, 1)
eq('只有空白等於沒搜尋', searchDistribution(sg, '   ', false).active, false)

// 高亮位置
eq('matchRange 找得到位置', matchRange('4175-DRAGONTRIO-1456', '1456'), [16, 20])
eq('matchRange 不分大小寫', matchRange('NCH', 'nch'), [0, 3])
eq('matchRange 沒命中回 null', matchRange('NCH', 'wf'), null)
eq('matchRange 沒有 query 回 null', matchRange('NCH', ''), null)
eq('normalizeQuery 去空白轉小寫', normalizeQuery('  AbC '), 'abc')

// ── 接線檢查（純靜態讀原始碼，不連服務）────────────────────────────────────────
// 上面驗的是規則本身。規則對、但沒接上畫面的話，功能一樣是壞的——而且是「按了沒反應」
// 那種最難查的壞法。
import { readFileSync, existsSync } from 'node:fs'

// ⚠️ 剝行註解一律用 [^\r\n] 不用 .*$——CRLF 檔案下 `.` 不匹配 \r（這個坑踩過）
const page = readFileSync('src/pages/OsmPage.tsx', 'utf8').replace(/\/\/[^\r\n]*/g, '')

eq('OsmPage 有接上純判斷模組',
  /from '\.\/osm-gametype-dist'/.test(page), true)
eq('機種卡點下去會開彈窗',
  /className="osm-gt-card" onClick=\{\(\) => setDistType\(type\)\}/.test(page), true)
// 卡片裡本來就有一顆「缺少 N 台」的展開按鈕，不擋冒泡的話點它會連帶把彈窗也開起來
eq('缺少機台的展開按鈕不會順便開彈窗',
  /onClick=\{e => \{ e\.stopPropagation\(\); toggleExpand\(\) \}\}/.test(page), true)
// 這個版面的祖先有 backdrop-filter，會把 position:fixed 困在容器裡——不走 portal 會被裁掉
eq('彈窗走 createPortal 掛到 body',
  /createPortal\([\s\S]*document\.body/.test(page), true)
eq('彈窗只在有選機種時渲染',
  /\{distType && \([\s\S]{0,200}GameTypeChannelsModal/.test(page), true)
// v4.143.0 起型號拆分包在 searchDistribution() 裡（搜尋要能逐型號過濾），
// 所以元件不再直接呼叫 groupByMachineType——但它必須走那支共用函式、不能自己 group。
eq('彈窗的渠道／型號來自共用的 searchDistribution()',
  /const found = searchDistribution\(groups, query, showOffline\)/.test(page), true)
eq('彈窗有按型號拆分', /\{models\.map\(mg =>/.test(page), true)
eq('元件沒有自己再 group 一次型號',
  /groupByMachineType\(/.test(page), false)
eq('關閉鈕用 flex 置中（× 靠 lineHeight 對不準）',
  /alignItems: 'center', justifyContent: 'center'/.test(page), true)
eq('OsmPage 沒有自己再寫一份機種代碼取法',
  /function gameTypeOf\(/.test(page), false)

// ── 型號標籤（v4.142.0 / v4.142.1）──────────────────────────────────────────────
// 這排守三件事：① 銘牌不能退回純文字 ② 素材路徑不能對不上（壞掉時畫面不報錯，
// 只會少掉光刃／金符，看起來像設計就長這樣）③ **修仙版的特效不能漏到普通版**。
const css = readFileSync('src/App.css', 'utf8')
const app = readFileSync('src/App.tsx', 'utf8')

// 把修仙版那半切出來，才驗得到「哪些規則只在修仙版生效」。
// ⚠️ 一定要按「規則區塊」切，不能按行切——選擇器和宣告不在同一行，
//    按行切的話宣告會被歸到普通版那半，整排檢查會給出反過來的結論（踩過）。
const XX = ':root[data-theme-mode="xianxia"]'

/** 抽出 .osm-modeltag 的規則，並把 @media 外殼拆掉（只留裡面的規則）*/
function modeltagRules(src: string): { selector: string; body: string }[] {
  // ⚠️ 註解要在切片「之前」剝掉。先切再剝的話，切點會落在區塊註解內部、
  //    那段就沒有開頭的 /* 可以匹配，整段註解文字會被當成第一條規則的選擇器。
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '')
  const seg = noComments.slice(noComments.indexOf('.osm-modeltag'))
  const flat = seg.replace(/@media[^{]*\{([\s\S]*?)\n\}/g, '$1')   // 拆 @media 外殼
    .replace(/@keyframes[^{]*\{[\s\S]*?\n\}/g, '')                 // keyframes 定義不參與歸類
  const out: { selector: string; body: string }[] = []
  for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim()
    if (!selector.includes('.osm-modeltag')) continue
    out.push({ selector, body: m[2] })
  }
  return out
}
const rules = modeltagRules(css)
const classicCss = rules.filter(r => !r.selector.includes(XX)).map(r => r.selector + '{' + r.body + '}').join('\n')
const xianxiaCss = rules.filter(r => r.selector.includes(XX)).map(r => r.selector + '{' + r.body + '}').join('\n')
// 切錯的話下面整排都沒有意義，所以先確認兩半都不是空的
eq('規則切分有抓到普通版規則', classicCss.length > 200, true)
eq('規則切分有抓到修仙版規則', xianxiaCss.length > 200, true)

eq('型號那行用標籤 class，不是行內灰字',
  /<div className=\{tagClass\}>/.test(page) && /'osm-modeltag',/.test(page), true)
eq('標籤 class 定義在 App.css',
  rules.some(r => r.selector === '.osm-modeltag'), true)

// alert 的條件必須跟逐台標色共用同一支判斷——自己再寫一份 some() 等於畫面上兩個地方
// 各自定義「異常」，症狀是「標籤說這組有異常、底下每一台都沒標黃」（或反過來），
// 而且兩邊都不會報錯。
eq('alert 走共用的 hasVersionMismatch()',
  /hasVersionMismatch\(mg\.group\.machines, refVersion\)/.test(page), true)
eq('元件裡沒有自己再寫一份版本比對',
  /!!refVersion && mg\.[a-zA-Z.]*machines\.some\(/.test(page), false)
// ⚠️ 看整組、不是搜尋後的子集——版本異常是事實，不該因為搜尋縮小範圍就消失
eq('alert 看整組機台不是搜尋結果', /hasVersionMismatch\(mg\.group\.machines/.test(page), true)

// 全離線的型號只降透明，不能整段不渲染——它本身就是「這個渠道跑什麼型號」的答案
eq('全離線的型號仍然渲染（只降透明）',
  /mg\.group\.online === 0 \? 'osm-modeltag--empty'/.test(page), true)
eq('降透明是用 opacity 不是 display:none',
  /\.osm-modeltag--empty\{[^}]*opacity: \.55/.test(classicCss), true)

// ---- 模式隔離（v4.142.1）----
// 使用者要求：特效只在修仙版，普通版用樸素但清楚的標籤。
// ⚠️ 漏到普通版時不會報錯，只是看起來很突兀——所以要逐項擋。
eq('App.tsx 有把 themeMode 寫到 documentElement（CSS 才判斷得到）',
  /document\.documentElement\.dataset\.themeMode = themeMode/.test(app), true)
eq('普通版的標籤沒有青玉光刃素材', classicCss.includes('modeltag-blade'), false)
eq('普通版的標籤沒有金符素材', classicCss.includes('modeltag-rune'), false)
eq('普通版的標籤沒有斜切角', classicCss.includes('clip-path'), false)
eq('普通版的標籤沒有用掃光動畫', classicCss.includes('animation: osm-modeltag-sweep'), false)
eq('普通版的標籤沒有用呼吸動畫', classicCss.includes('animation: osm-modeltag-breathe'), false)
eq('普通版的金符整個不顯示', /\.osm-modeltag__rune\{[^}]*display: none/.test(classicCss), true)
eq('普通版有左側色條當層級提示', classicCss.includes('border-left: 3px solid #60a5fa'), true)
eq('普通版的 alert 用既有的 diff 黃', /\.osm-modeltag--alert\{[^}]*border-left-color: #fbbf24/.test(classicCss), true)

eq('光刃只在修仙版出現', xianxiaCss.includes('modeltag-blade'), true)
eq('金符只在修仙版出現', xianxiaCss.includes('modeltag-rune'), true)
eq('斜切角只在修仙版出現', xianxiaCss.includes('clip-path'), true)
eq('修仙版才把金符顯示回來', xianxiaCss.includes('display: block'), true)

// 一個渠道最多 16 個型號，常駐動畫會很吵也吃 CPU（CodeX 也特別提了這點）
// ⚠️ 這條原本寫成「檔案裡找得到 `…:hover::after {` 這串字」，是個假檢查：
//    prefers-reduced-motion 那個 override 也長這樣，所以就算把真正的掃光改成常駐，
//    字串還在、檢查照樣綠。改成看「套用掃光的規則，選擇器是不是每一條都帶 :hover」。
const sweepSelectors = rules
  .filter(r => r.body.includes('animation: osm-modeltag-sweep'))
  .map(r => r.selector)
eq('有規則真的套用掃光（不然下一條會空過）', sweepSelectors.length > 0, true)
eq('掃光只在 hover 跑，不是常駐',
  sweepSelectors.every(sel => sel.includes(':hover')), true)
// 呼吸同理：只能掛在 --alert 上，不能整排常駐
const breatheSelectors = rules
  .filter(r => r.body.includes('animation: osm-modeltag-breathe'))
  .map(r => r.selector)
eq('有規則真的套用呼吸', breatheSelectors.length > 0, true)
eq('呼吸只掛在 --alert 上',
  breatheSelectors.every(sel => sel.includes('--alert')), true)
eq('靜態時掃光停在框外（left:-60%）', xianxiaCss.includes('left: -60%'), true)

// 素材路徑：CSS 寫的檔名要跟 public/ 底下真的存在的檔案一致
const bladeUrl = /url\(([^)]*modeltag-blade[^)]*)\)/.exec(css)?.[1] ?? ''
const runeUrl  = /url\(([^)]*modeltag-rune[^)]*)\)/.exec(css)?.[1] ?? ''
eq('光刃素材的 URL 指到 /osm/', bladeUrl, '/osm/modeltag-blade.png')
eq('金符素材的 URL 指到 /osm/', runeUrl, '/osm/modeltag-rune.png')
eq('光刃素材檔案真的存在', existsSync('public' + bladeUrl), true)
eq('金符素材檔案真的存在', existsSync('public' + runeUrl), true)

// ---- 搜尋欄接線（v4.143.0）----
eq('彈窗有搜尋輸入框', /className="osm-dist-search"/.test(page), true)
eq('搜尋有清除鈕', /className="osm-dist-clear"/.test(page), true)
eq('命中處有高亮', /className="osm-dist-hit"/.test(page), true)
// ⚠️ 兩個狀態必須各自存在且用不同 class——共用一個 class 就分不出
// 「有命中但被藏住」跟「完全沒命中」，那正是這個功能最容易被誤讀的地方（CodeX review）
eq('有「命中但被離線藏住」的狀態', /className="osm-dist-hidden"/.test(page), true)
eq('有「完全沒命中」的空狀態', /className="osm-dist-empty"/.test(page), true)
eq('兩個狀態用不同 class（不能共用）',
  /osm-dist-hidden/.test(page) && /osm-dist-empty/.test(page)
    && !/osm-dist-hidden[^"]*osm-dist-empty/.test(page), true)
// ⚠️「顯示離線」一定要是 <button>，不是一句可點的灰字（CodeX review 的重點）
eq('「顯示離線」是真的 button',
  /<button type="button" className="osm-dist-reveal"/.test(page), true)
eq('按下去真的會打開離線開關', /onClick=\{\(\) => setShowOffline\(true\)\}/.test(page), true)
eq('空狀態與被藏住狀態在 CSS 裡是不同顏色',
  /\.osm-dist-hidden \{[^}]*#fbbf24/.test(css) && /\.osm-dist-empty \{[^}]*#64748b/.test(css), true)
// 搜尋中不要再顯示渠道層級那句「都不在線上」——它的台數是整個渠道的、跟搜尋結果對不上
eq('搜尋中不顯示渠道層級的離線說明',
  /!found\.active && channelVisible === 0/.test(page), true)
// ⚠️ 改搜尋字串要把清單捲回最上面——141 台的機種捲得很長，捲到下面才打字的話
// 命中的列在最上面、畫面一片空白，看起來像沒命中（跟「被離線藏住」同一類的假象）
eq('改搜尋時把清單捲回最上面',
  /useEffect\(\(\) => \{ if \(bodyRef\.current\) bodyRef\.current\.scrollTop = 0 \}, \[query\]\)/.test(page), true)
eq('捲動容器有掛上 ref', /<div ref=\{bodyRef\} style=\{\{ overflowY: 'auto'/.test(page), true)

// Esc 維持關彈窗（跟 CodeX 定案：不為了清搜尋加行為複雜度）
eq('Esc 仍然是關彈窗', /if \(e\.key === 'Escape'\) onClose\(\)/.test(page), true)

// 圖載不到時仍要有東西可看——◆ 是備援字元，靠 font-size:0 平常藏起來
eq('金符有備援字元 ◆', /className="osm-modeltag__rune">&#9670;</.test(page), true)
eq('備援字元在修仙版用 font-size:0 藏著', xianxiaCss.includes('font-size: 0'), true)

console.log('')
console.log(pass + '/' + (pass + fails.length) + ' 通過（含接線檢查）')
if (fails.length > 0) {
  console.log('')
  console.log('失敗：')
  for (const item of fails) console.log('  - ' + item)
  process.exit(1)
}
