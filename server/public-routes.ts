/**
 * 不需要登入 cookie 就能打的 API（main 與 worker 共用這一份，資安審查 2026-10-19）。
 *
 * 原本後端沒有全站登入檢查，約 300 條 API 不登入就打得到。改成**預設要登入**，只有這裡列的放行。
 * 每一條都要寫清楚「誰在不帶 cookie 的情況下打它」；說不出來的就不該在這裡。
 *
 * 三類：
 *  1. LOGIN：登入畫面本身要用的
 *  2. OWN_CHECK：有自己的憑證檢查（agent token／ticket），放行讓它走到那個檢查
 *  3. AGENT_NO_CRED：agent／外部推送打的、**目前沒有任何憑證**——要它們帶 token 必須先更新每台 agent，
 *     不然部署當下全部斷線。先放行，下一階段補憑證（清單見 docs/features/32-security.md「待辦」）
 *
 * ⚠️ 比對用 method + 完整路徑的正規式（^…$），不用 startsWith——前綴放行很容易順手放掉旁邊的路由。
 */

type Rule = { method: 'GET' | 'POST' | 'PUT' | 'DELETE' | '*'; re: RegExp; why: string }

const r = (method: Rule['method'], re: RegExp, why: string): Rule => ({ method, re, why })

export const PUBLIC_API_RULES: Rule[] = [
  // ── 1. LOGIN ──
  r('GET', /^\/api\/health$/, '前端每 30 秒探活（登入前也會）'),
  r('GET', /^\/api\/build-info$/, '維運看兩支 process 跑哪份 build'),
  r('GET', /^\/api\/auth\/me$/, '開頁時判斷登入狀態'),
  r('POST', /^\/api\/auth\/login$/, '登入'),
  r('POST', /^\/api\/auth\/logout$/, '登出（cookie 過期也要能清）'),
  r('GET', /^\/api\/(jira\/)?accounts$/, '登入畫面的帳號清單（只回 email／名稱／有沒有 PIN）'),
  r('POST', /^\/api\/(jira\/)?accounts$/, '登入畫面的「新增帳號」（不能覆蓋既有帳號；是否保留自助註冊待使用者決定）'),

  // ── 2. OWN_CHECK ──
  r('POST', /^\/api\/machine-test\/ocr-proxy$/, 'Local Agent：x-agent-token + x-agent-owner'),
  r('GET', /^\/api\/osm-uat\/upload-assets\/[^/]+\/raw$/, 'UAT runner 取素材：?token= 一次性票'),
  r('POST', /^\/api\/frontend-auto\/runs\/[^/]+\/evidence$/, 'Local Agent 回傳 H5/PC 證據：body.token'),

  // ── 3. AGENT_NO_CRED（程式碼本身就在 repo 裡，下載不構成洩漏）──
  r('GET', /^\/api\/machine-test\/agent\/(source-manifest|seed-manifest|agent-package\.json)$/, 'Local Agent／install.bat 下載程式碼'),
  r('GET', /^\/api\/machine-test\/agent\/(source|seed)\/.+$/, 'Local Agent／install.bat 下載程式碼'),
  r('GET', /^\/api\/autospin\/agent\/download\/(agent\.py|launcher\.bat|launcher-mac\.sh)$/, 'AutoSpin launcher 每次啟動重新下載'),
  r('POST', /^\/api\/ui-screenshot\/(scan-result\/[^/]+|run\/[^/]+\/(agent-done|log)|task\/[^/]+\/(status|upload))$/, 'Local Agent 回報 UI 截圖'),
  r('PUT', /^\/api\/machine-test\/(cctv|audio)-upload$/, 'Local Agent 上傳 CCTV／音頻'),
  r('GET', /^\/api\/frontend-auto\/images\/[^/]+$/, 'Local Agent 取比對基準圖'),
  r('POST', /^\/api\/autospin\/agent\/start$/, 'Python AutoSpin agent'),
  r('POST', /^\/api\/autospin\/agent\/[^/]+\/(log|stop|history|recon-spin|game-record|status-report)$/, 'Python AutoSpin agent'),
  r('GET', /^\/api\/autospin\/agent\/[^/]+\/should-stop$/, 'Python AutoSpin agent'),
  r('GET', /^\/api\/autospin\/templates$/, 'Python AutoSpin agent 取範本清單'),
  r('GET', /^\/api\/autospin\/template-img\/[^/]+$/, 'Python AutoSpin agent 取範本圖（檔名已白名單）'),
  r('POST', /^\/api\/machine-test\/osm-status$/, 'OSMWatcher 推送機台狀態'),
  r('GET', /^\/api\/autospin\/live-ledger\/sls-health$/, 'osm-qa-agent usage-monitor 定時檢查（唯讀）'),
]

export function publicApiRule(method: string, path: string): Rule | null {
  const m = method.toUpperCase()
  const effective = m === 'HEAD' ? 'GET' : m
  for (const rule of PUBLIC_API_RULES) {
    if ((rule.method === '*' || rule.method === effective) && rule.re.test(path)) return rule
  }
  return null
}

/** 需要登入檢查的路徑：/api/* 與 /internal/*（其餘是前端靜態檔） */
export function isGuardedPath(path: string): boolean {
  return path.startsWith('/api/') || path === '/api' || path.startsWith('/internal/')
}

/**
 * /internal/* 只給同一台主機上的另一支 process 打（main ↔ worker）：
 * 連線來源必須是 loopback，而且**沒有經過反向代理**（nginx 在同一台時來源也是 127.0.0.1，
 * 但它會加 X-Forwarded-For／X-Real-IP——有這兩個 header 就代表是外面進來的）。
 */
export function isLoopbackDirect(remoteAddress: string | undefined, headers: Record<string, unknown>): boolean {
  const ip = (remoteAddress ?? '').replace(/^::ffff:/, '')
  const loopback = ip === '127.0.0.1' || ip === '::1'
  return loopback && !headers['x-forwarded-for'] && !headers['x-real-ip']
}
