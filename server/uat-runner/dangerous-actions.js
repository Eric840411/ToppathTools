/**
 * server/uat-runner/dangerous-actions.js
 *
 * **會造成真實副作用的操作清單。只有這一份**（錄製器與執行引擎共用）。
 *
 * ## 為什麼需要
 * 這套工具跑在**共用的 QA 環境**上。有些按鈕按下去不是「畫面變一下」：
 *   - Reserve Now：把一台機台**鎖 24 小時**，別人就進不去了
 *   - 帶入額度／Join／PLAY NOW：**動到餘額**，而且會佔住位子
 *   - 充值面板的 Confirm：**真的轉錢**
 * 錄製的時候手滑按到、或重播時腳本順手點下去，事後都很難救——而且**畫面上看不出
 * 剛剛發生了什麼**，過幾天才有人問「這台怎麼一直是被預約的」。
 *
 * ## 判斷依據（CodeX 2026-09-20 定的邊界）
 * **依副作用辨識，不是只看按鈕上的字。** 字是會翻譯、會改的（同一顆在中文站叫「預約」、
 * 英文站叫 Reserve Now、下一版可能叫 Book）。所以每一條規則以**選擇器／節點名**為主、
 * 文字只當**額外**的補強訊號；只靠文字命中的一律標成 `weak`，不用來擋人，只用來提醒。
 *
 * ## 放行的規矩
 * - **不做全域開關。** 放行是「這一顆積木」的事（`step.allowDangerous`），
 *   不是「這次執行」的事——一次放行整輪的話，後面新加的危險步驟會自動被放行。
 * - **正式環境一律不放行**，連 `allowDangerous` 也蓋不掉（見 `isProdLike`）。
 */

/**
 * 規則表。
 *
 * @typedef {{ id: string, why: string, dom?: string[], node?: string[], text?: RegExp }} DangerRule
 */
export const DANGEROUS_RULES = [
  {
    id: 'reserve',
    why: '這會真的預約機台（鎖 24 小時，別人進不去）',
    dom: ['.reserve-btn-long', '.reserve-btn', '.reserve-now'],
    node: ['btn_reserve', 'reserve_btn', 'btn-reserve'],
    text: /reserve\s*now|立即預約|預約機台/i,
  },
  {
    id: 'join',
    why: '這會真的入座／佔住機台（別人就進不去了）',
    dom: ['.gm-info-join', '.quick-join'],
    node: ['btn_join', 'join_btn'],
    text: /quick\s*join|^join$|進入機台/i,
  },
  {
    id: 'credit-in',
    why: '這會真的把額度帶進機台（動到餘額）',
    dom: ['.btn_play', '.play-now', '.btn-playnow'],
    node: ['play_btn1', 'play_btn2', 'btn_play'],
    text: /play\s*now|帶入額度/i,
  },
  {
    id: 'recharge',
    why: '這會真的轉帳／充值',
    dom: ['.recharge-confirm', '.transfer-confirm'],
    node: ['btn_recharge_confirm'],
    text: /confirm\s*(recharge|transfer)|確認充值|確認轉帳/i,
  },
  /**
   * 後台（CP／NC 管理站）的破壞性操作。
   *
   * 🚨 **後台能做的破壞比前台大**：補發彩金、處理 Hand Pay、刪設定、把機台停用——
   *    錄製時手滑點下去就真的執行了，而且後台不會有任何「你剛剛改了什麼」的提示。
   * ⚠️ 這裡刻意**不含**一般的 Save／Submit：後台幾乎每個表單都有，全擋的話
   *    會變成每點一下都要確認，人就會養成閉著眼睛按確定的習慣——那比不擋更糟。
   */
  {
    id: 'backend-resend',
    why: '這會真的補發／重送彩金或帳務（後台）',
    dom: ['.resend-btn', '.reissue-btn'],
    text: /resend|reissue|補發|重送/i,
  },
  {
    id: 'backend-handpay',
    why: '這會真的處理 Hand Pay（後台）',
    dom: ['.handpay-confirm', '.hand-pay-btn'],
    text: /hand\s*pay|手動派彩/i,
  },
  {
    id: 'backend-delete',
    why: '這會真的刪除資料（後台）',
    dom: ['.delete-btn', '.el-button--danger'],
    text: /^\s*(delete|remove|刪除)\s*$/i,
  },
  {
    id: 'backend-machine-state',
    why: '這會改變機台狀態（停用／維護／踢出玩家）',
    dom: ['.maintain-btn', '.kickout-btn'],
    text: /maintain|kick\s*out|停用|維護|踢出/i,
  },
  {
    id: 'cash-out',
    why: '這會真的把機台裡的錢收回（結束這一輪）',
    dom: ['.cash-out', '.btn_cashout'],
    node: ['btn_cashout', 'cash_out'],
    text: /cash\s*out/i,
  },
]

/**
 * 判斷一個「選擇器／節點名／文字」是不是危險操作。
 *
 * @param {{ selector?: string, node?: string, text?: string }} what
 * @returns {{ id: string, why: string, strength: 'strong' | 'weak' } | null}
 */
export function classifyDanger(what = {}) {
  const selector = String(what.selector ?? '')
  const node = String(what.node ?? '')
  // 路徑形式（`a>b>c`）比最後一段就好——中間那幾層是容器
  const nodeLeaf = node.includes('>') ? node.split('>').pop() : node
  const text = String(what.text ?? '')
  for (const rule of DANGEROUS_RULES) {
    const hitDom = (rule.dom ?? []).some(sel => selector.includes(sel))
    const hitNode = (rule.node ?? []).some(n => nodeLeaf === n || node.includes(n))
    if (hitDom || hitNode) return { id: rule.id, why: rule.why, strength: 'strong' }
  }
  // ⚠️ 只有文字命中時**不用來擋**，只用來提醒：字會翻譯、會改版，
  //    拿它當唯一依據的話，一個無害的「Join our Discord」也會被擋下來。
  for (const rule of DANGEROUS_RULES) {
    if (rule.text && rule.text.test(text)) return { id: rule.id, why: rule.why, strength: 'weak' }
  }
  return null
}

/**
 * 這個網址是不是**正式（或模擬正式）**環境。
 *
 * 🚨 正式環境**不接受任何放行**。`allowDangerous` 是給 QAT/UAT 用的，
 *    不是給人拿來在正式站上預約機台的。判斷寧可寬——不確定就當成正式。
 */
/**
 * 1008 claude-osm-2 回報、CodeX 方案審查 h：帳號池中轉網址（工作台給的連結）一律被當成正式環境——
 * `https://eric.osmslot.org/api/url-pool/go/<帳號>?user=…&to=<base64>` 的 hostname 是工具自己，不帶 uat。
 * 中轉路由（routes/integrations.ts）只做一件事：302 到解碼後的 `to`。所以改判 `to`：
 *   - 只認**可信的工具來源**＋**精確的 go 路徑**（別的網域掛同樣路徑不算）
 *   - 只拆一層；解碼失敗、不是 http(s)、拆出來又是一層 go → 一律當正式（擋）
 *   - 操作當下的實際網址（currentUrl）照樣另外檢查；逐積木放行照舊要勾
 */
const TOOL_HOSTS = new Set(['eric.osmslot.org', 'localhost', '127.0.0.1', '[::1]'])
const isToolHost = (host) => TOOL_HOSTS.has(host) || /^(10\.\d+|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+$/.test(host)
const GO_PATH = /^\/api\/url-pool\/go\/[^/]+\/?$/
/** 中轉網址 → 解碼後的目標；不是中轉網址回 null；是中轉網址卻解不開回 ''（呼叫端當正式） */
export function unwrapUrlPool(url = '') {
  let u
  try { u = new URL(String(url)) } catch { return null }
  if (!isToolHost(u.hostname.toLowerCase()) || !GO_PATH.test(u.pathname)) return null
  const to = u.searchParams.get('to')
  if (!to) return ''
  let decoded = ''
  try {
    const b64 = to.replace(/-/g, '+').replace(/_/g, '/')
    decoded = Buffer.from(b64 + '='.repeat((4 - (b64.length % 4)) % 4), 'base64').toString('utf8')
  } catch { return '' }
  let target
  try { target = new URL(decoded) } catch { return '' }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return ''
  return target.href
}

export function isProdLike(url = '') {
  const inner = unwrapUrlPool(url)
  if (inner === '') return true
  if (inner !== null) return unwrapUrlPool(inner) !== null || isProdLikeHost(inner)
  return isProdLikeHost(url)
}

function isProdLikeHost(url = '') {
  // 1007 CodeX（af25442 審查 P1）：原本對**整條網址**找 qat／uat／test 字樣——正式網址加 `?note=uat` 就被當成測試環境放行。
  // 改成只看 **hostname**，而且只認已知的測試環境，其他（含讀不出 hostname）一律當正式：
  //   - *.osmslot.org 且 hostname 帶 qat／uat／test／stg／staging、又不帶 prod
  //   - osm-redirect.osmslot.org（QAT 的導轉入口，沿用既有判定）
  //   - 測試用保留網域（*.test、*.example、localhost、127.0.0.1）——探針的假頁面
  let host = ''
  try { host = new URL(String(url)).hostname.toLowerCase() } catch { return true }
  if (!host) return true
  if (host === 'localhost' || host === '127.0.0.1' || /\.(test|example)$/.test(host)) return false
  if (!host.endsWith('.osmslot.org') || /prod/.test(host)) return true
  if (host === 'osm-redirect.osmslot.org') return false
  return !/qat|uat|test|stg|staging/.test(host)
}

/**
 * 執行時的守衛：**動作發生之前**呼叫。危險而且沒放行就 throw。
 *
 * @param {{ step: object, what: object, startUrl?: string }} args
 */
export function guardDangerousStep({ step = {}, what = {}, startUrl = '', currentUrl }) {
  const danger = classifyDanger(what)
  if (!danger || danger.strength !== 'strong') return danger
  const label = `「${step.name || step.action}」${danger.why}`
  // 1007 CodeX：起始網址是 QAT、中途導頁到正式站也要擋——**操作當下**的實際網址也要是測試環境
  if (isProdLike(startUrl) || (currentUrl !== undefined && isProdLike(currentUrl))) {
    throw new Error(`${label}——這裡看起來是正式環境，**任何放行都不接受**。要測請改用 QAT/UAT 的網址`)
  }
  // ⚠️ 後台的參數表單沒有勾選框，只有下拉，所以字串 'yes' 也算放行。
  //    兩邊各認各的話，同一個欄位在 H5 有效、在後台無效——而且只會在真的點下去時才發現。
  const allowed = step.allowDangerous === true || step.allowDangerous === 'yes'
  if (!allowed) {
    throw new Error(`${label}。確定要讓腳本真的做這件事的話，請在這顆積木上勾「允許這個危險操作」`
      + `（放行只對這一顆有效，不會影響其他步驟）`)
  }
  return danger
}

/**
 * 錄製器要注入頁面的那一份（純字串，**不可含反引號**）。
 * 規則表用 JSON 帶過去，避免兩邊各寫一份而漂掉。
 */
export function dangerousRulesSource() {
  const plain = DANGEROUS_RULES.map(r => ({
    id: r.id, why: r.why, dom: r.dom ?? [], node: r.node ?? [], text: r.text ? r.text.source : '', flags: r.text ? r.text.flags : '',
  }))
  return [
    '(() => {',
    '  if (window.__uatDanger) return;',
    '  const RULES = ' + JSON.stringify(plain) + ';',
    '  window.__uatDanger = {',
    '    rules: RULES,',
    '    classify: (what) => {',
    '      const selector = String((what && what.selector) || "");',
    '      const node = String((what && what.node) || "");',
    '      const leaf = node.indexOf(">") >= 0 ? node.split(">").pop() : node;',
    '      const text = String((what && what.text) || "");',
    '      for (let i = 0; i < RULES.length; i++) { const r = RULES[i];',
    '        const hitDom = r.dom.some((s) => selector.indexOf(s) >= 0);',
    '        const hitNode = r.node.some((n) => leaf === n || node.indexOf(n) >= 0);',
    '        if (hitDom || hitNode) return { id: r.id, why: r.why, strength: "strong" }; }',
    '      for (let i = 0; i < RULES.length; i++) { const r = RULES[i];',
    '        if (r.text && new RegExp(r.text, r.flags).test(text)) return { id: r.id, why: r.why, strength: "weak" }; }',
    '      return null; },',
    '  };',
    '})();',
  ].join('\n')
}
