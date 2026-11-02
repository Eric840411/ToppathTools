/**
 * 文書工具（Eric Office）的靜態檔解析。純函式，沒有 Express／DB，方便單測。
 *
 * Eric Office（craft-office）是 13 個 Rust→WASM 的純靜態 build，沒有自己的後端。
 * Toppath 把它們掛在同網域 /office/<app>/ 底下送出，登入與權限照 Toppath（使用者 2026-11-02 選同源）。
 *
 * 目錄結構（OFFICE_DIST_DIR，預設 <cwd>/office-dist）：
 *   releases/<版本>/<app>/index.html …   一個版本一個目錄，不覆寫舊的
 *   CURRENT                               一行字＝目前用哪個版本；部署腳本先寫 CURRENT.tmp 再 rename，一次切換
 * 退版＝把 CURRENT 改回上一個版本名。不用 symlink：Windows 開發機建 symlink 要權限。
 */
import { existsSync, readFileSync, statSync } from 'fs'
import { join, resolve, sep } from 'path'

export type OfficeApp = {
  id: string
  label: string
  group: '文書' | '影像設計' | '影音'
  /** 需要 cross-origin isolation（SharedArrayBuffer），只能開在最上層分頁，不能嵌 iframe */
  isolate: boolean
}

// id 要跟 craft-office/live 底下的目錄名一致（serve-web.mjs 的 mount 名）
export const OFFICE_APPS: readonly OfficeApp[] = [
  { id: 'word', label: 'Word', group: '文書', isolate: false },
  { id: 'excel', label: 'Excel', group: '文書', isolate: false },
  { id: 'ppt', label: 'PPT', group: '文書', isolate: false },
  { id: 'pdf', label: 'PDF', group: '文書', isolate: false },
  { id: 'photo', label: 'Photo', group: '影像設計', isolate: false },
  { id: 'light', label: 'Light', group: '影像設計', isolate: false },
  { id: 'vector', label: 'Vector', group: '影像設計', isolate: false },
  { id: 'design', label: 'Design', group: '影像設計', isolate: false },
  { id: 'fig', label: 'Fig', group: '影像設計', isolate: false },
  { id: 'cad', label: 'CAD', group: '影像設計', isolate: false },
  { id: 'film', label: 'Film', group: '影音', isolate: true },
  { id: 'effect', label: 'Effect', group: '影音', isolate: true },
  { id: 'sound', label: 'Sound', group: '影音', isolate: false },
]

const APP_IDS = new Set(OFFICE_APPS.map(a => a.id))

export const OFFICE_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
}

/** 部署腳本會替這些副檔名預先產生 .gz；伺服器只送現成的，不即時壓（WASM 動輒幾十 MB） */
export const OFFICE_GZIP_EXTS = new Set(['.html', '.js', '.mjs', '.wasm', '.css', '.json', '.svg', '.webmanifest'])

/** Trunk 產的 `name-<16 hex>` 檔名內容不會變；其他（FilmCraft／EffectCraft／LightCraft 固定檔名）要重新驗證 */
export function isHashedAsset(name: string): boolean {
  return /-[0-9a-f]{16}(_bg)?\.[a-z0-9]+$/.test(name)
}

const RELEASE_NAME = /^[A-Za-z0-9._-]{1,64}$/

/** 目前生效的版本目錄；沒部署、CURRENT 壞掉或指到不存在的目錄都回 null（呼叫端回 503，不猜） */
export function currentReleaseDir(baseDir: string): { name: string; dir: string } | null {
  const pointer = join(baseDir, 'CURRENT')
  if (!existsSync(pointer)) return null
  const name = readFileSync(pointer, 'utf8').trim()
  if (!RELEASE_NAME.test(name) || name === '.' || name === '..') return null
  const dir = resolve(baseDir, 'releases', name)
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null
  return { name, dir }
}

/** 這個版本裡實際有部署的工具（目錄裡有 index.html 才算），畫面只列這些，不列沒部署的 */
export function availableApps(releaseDir: string): OfficeApp[] {
  return OFFICE_APPS.filter(a => existsSync(join(releaseDir, a.id, 'index.html')))
}

export type OfficeTarget =
  | { kind: 'file'; app: OfficeApp; file: string }
  | { kind: 'redirect'; to: string }
  | { kind: 'sw' }
  | { kind: 'undeployed' }
  | { kind: 'notfound' }

/** 版本目錄（releases/<name>）；名稱不合法或不存在回 null */
export function releaseDirByName(baseDir: string, name: string): string | null {
  if (!RELEASE_NAME.test(name) || name === '.' || name === '..') return null
  const dir = resolve(baseDir, 'releases', name)
  return existsSync(dir) && statSync(dir).isDirectory() ? dir : null
}

/**
 * 網址一律綁版本：/office/v/<版本>/<app>/<子路徑>。
 * 不綁的話每個請求都重讀 CURRENT，舊版 HTML 載入後一切版，它要的 hash JS 在新版目錄裡就找不到（CodeX 審 5f7c6d0 [P2]，實際重現）。
 * /office/<app>/… 只是入口，導到目前版本；畫面一律用 /api/office/apps 回的版本組網址。
 *
 * pathname 是 req.path（還沒解碼）。先照 `/` 切段、每段各自解碼再驗——
 * 整串先解碼的話 `%2F` 會變成新的分隔字元，`..%2F..` 就繞過逐段檢查了。
 */
export function resolveOfficePath(baseDir: string, pathname: string, current: string | null): OfficeTarget {
  // 任何層的 sw.js 都換成「退役」Service Worker，見 OFFICE_RETIRE_SW。
  // ⚠️ 要比對**解碼後**的最後一段：原本比原始字串，`%73w.js` 解碼後一樣是 sw.js、照樣送出原本那支 SW（CodeX 複審 38f09fb [P1] 實際重現）。
  // ⚠️ 也要在檢查版本存不存在**之前**：版本目錄被清掉後，註冊在那個 scope 的舊 SW 仍要換得掉。
  if (/^\/office\//i.test(pathname)) {
    const last = pathname.slice(pathname.lastIndexOf('/') + 1)
    let name = ''
    try { name = decodeURIComponent(last) } catch { /* 壞掉的編碼交給下面回 404 */ }
    if (name.toLowerCase() === 'sw.js') return { kind: 'sw' }
  }

  const v = /^\/office\/v\/([^/]+)\/([^/]+)(\/.*)?$/i.exec(pathname)
  if (v) {
    const releaseDir = releaseDirByName(baseDir, v[1])
    if (!releaseDir) return { kind: 'notfound' }
    const id = v[2].toLowerCase()
    const app = OFFICE_APPS.find(a => a.id === id)
    if (!app || !APP_IDS.has(id)) return { kind: 'notfound' }
    // 少了結尾斜線要補：index.html 裡都是 ./xxx 相對路徑，不補會解析到上一層
    if (v[3] === undefined) return { kind: 'redirect', to: `/office/v/${v[1]}/${id}/` }
    const raw = v[3].slice(1).split('/')
    if (raw[raw.length - 1] === '') raw[raw.length - 1] = 'index.html'
    const segs: string[] = []
    for (const r of raw) {
      let s: string
      try { s = decodeURIComponent(r) } catch { return { kind: 'notfound' } }
      if (!s || s === '.' || s === '..' || s.length > 255) return { kind: 'notfound' }
      // eslint-disable-next-line no-control-regex -- 就是要擋控制字元（NUL 截斷等）
      if (/[\\/\x00-\x1f:]/.test(s)) return { kind: 'notfound' }
      segs.push(s)
    }
    const appRoot = resolve(releaseDir, id)
    const file = resolve(appRoot, ...segs)
    if (!file.startsWith(appRoot + sep)) return { kind: 'notfound' }
    return { kind: 'file', app, file }
  }

  const m = /^\/office\/([^/]+)(\/.*)?$/i.exec(pathname)
  if (!m) return { kind: 'notfound' }
  const id = m[1].toLowerCase()
  if (!APP_IDS.has(id)) return { kind: 'notfound' }
  if (!current) return { kind: 'undeployed' }
  return { kind: 'redirect', to: `/office/v/${current}/${id}${m[2] ?? '/'}` }
}

/**
 * Effect 的 build 會註冊一支 cache-first 的 Service Worker（離線用）。它會把頁面快取起來，
 * 登出後瀏覽器重開仍由 SW 回 200——繞過 /office 的登入檢查（CodeX 審 5f7c6d0 [P1]，實際重現）。
 * 所以 /office 底下的 sw.js 一律回這支：裝上就清掉 Office 的快取、把自己註銷、重新載入已開的頁面，
 * 之後的請求都回到網路、經過登入檢查。代價是 Effect 不能離線用。
 * ⚠️ 這支要**不登入也拿得到**：瀏覽器更新 SW 時是直接打網路，登出狀態下回 401 的話舊 SW 永遠換不掉。
 * 內容固定、不含任何資料，公開沒有風險。
 */
export const OFFICE_RETIRE_SW = `// Toppath：Office 工具不使用 Service Worker（避免登出後仍由快取開啟）
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (/^(effectcraft|filmcraft|lightcraft|craft)-/.test(k)) await caches.delete(k)
    }
    await self.registration.unregister()
    for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url)
  })())
})
`
