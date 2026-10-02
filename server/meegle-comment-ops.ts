/**
 * Meegle 批量評論（「Meegle 評論」分頁）要用到的 Meegle 操作與純函式。
 * 設計與踩坑：docs/features/28-meegle.md「批量評論」。
 *
 * 2026-10-02 在測試單 #15190441 實測過的行為（改這裡前先讀）：
 * - 測試說明 field_89ff93 是 multi-text，`workitem update` **整格覆寫**；Markdown 會保留
 * - Meegle 會改寫存進去的內容：連續空行縮成一行、圖片 `![名稱](url)` 變成 `![](url)<!-- image:{"uuid":...} -->`
 *   → 比對「是不是我上次寫的」只能比**讀回來**的值，而且要先做 normalizeDesc
 * - 富文本圖片：`attachment +upload --resource-type 16 --field-key field_89ff93` 拿 file_url，Markdown 嵌入
 * - 評論：HTML 註解 `<!-- -->` 會被剝掉（不能藏標記）；帶 --file-token 會**另外**生一則只有附件的評論，
 *   給兩個 --file-token 只有一個生效 → 每支影片一則
 * - comment add 不回 comment_id
 */
import { createHash } from 'crypto'
import { call, defaultRunner, meegleTarget, type CallOutcome, type Runner } from './meegle-workitem.js'

export const DESC_FIELD = 'field_89ff93' // 任務項「測試說明」

/** 讀測試說明目前的值。欄位不存在（從沒填過）回空字串。 */
export async function getDescription(token: string, workItemId: string, runner: Runner = defaultRunner, env: NodeJS.ProcessEnv = process.env): Promise<CallOutcome<string>> {
  const t = meegleTarget(env)
  const r = await call(runner, ['workitem', 'get', '--project-key', t.projectKey, '--work-item-id', workItemId, '--fields', DESC_FIELD], token)
  if (r.kind !== 'ok') return r
  const v = r.value as { work_item_attribute?: { work_item_id?: unknown }; work_item_fields?: Array<{ key?: unknown; value?: unknown }> }
  if (!v || typeof v !== 'object' || !v.work_item_attribute) return { kind: 'unknown', message: 'Meegle 回應裡沒有這張單' }
  const f = (v.work_item_fields ?? []).find(x => x.key === DESC_FIELD)
  return { kind: 'ok', value: typeof f?.value === 'string' ? f.value : '' }
}

/** 整格覆寫測試說明。成功只代表 Meegle 收下，實際存了什麼要再讀回來看。 */
export async function setDescription(token: string, workItemId: string, markdown: string, runner: Runner = defaultRunner, env: NodeJS.ProcessEnv = process.env): Promise<CallOutcome<true>> {
  const t = meegleTarget(env)
  const r = await call(runner, ['workitem', 'update', '--project-key', t.projectKey, '--work-item-id', workItemId,
    '--fields', JSON.stringify([{ field_key: DESC_FIELD, field_value: markdown }])], token)
  return r.kind === 'ok' ? { kind: 'ok', value: true } : r
}

export type Uploaded = { fileToken: string; fileUrl: string }

/** 上傳檔案。kind=image → 測試說明的富文本圖片（16）；kind=comment → 評論附件（13）。 */
export async function uploadFile(token: string, workItemId: string, path: string, filename: string, kind: 'image' | 'comment', runner: Runner = defaultRunner, env: NodeJS.ProcessEnv = process.env): Promise<CallOutcome<Uploaded>> {
  const t = meegleTarget(env)
  const args = ['attachment', '+upload', path, '--resource-type', kind === 'image' ? '16' : '13', '--project-key', t.projectKey, '--work-item-id', workItemId, '--filename', filename]
  if (kind === 'image') args.push('--field-key', DESC_FIELD)
  const r = await call(runner, args, token)
  if (r.kind !== 'ok') return r
  const v = r.value as { file_token?: unknown; file_url?: unknown }
  if (typeof v?.file_token !== 'string' || !v.file_token) return { kind: 'unknown', message: 'Meegle 上傳回應沒有 file_token' }
  return { kind: 'ok', value: { fileToken: v.file_token, fileUrl: typeof v.file_url === 'string' ? v.file_url : '' } }
}

/** 新增一則評論（可帶一個附件）。不回 comment_id——逾時要靠 listComments 找候選，不能重送。 */
export async function addComment(token: string, workItemId: string, content: string, fileToken?: string, runner: Runner = defaultRunner, env: NodeJS.ProcessEnv = process.env): Promise<CallOutcome<true>> {
  const t = meegleTarget(env)
  const args = ['comment', 'add', '--project-key', t.projectKey, '--work-item-id', workItemId, '--content', content]
  if (fileToken) args.push('--file-token', fileToken)
  const r = await call(runner, args, token)
  if (r.kind !== 'ok') return r
  const v = r.value as { success?: unknown }
  return v?.success === true ? { kind: 'ok', value: true } : { kind: 'unknown', message: 'Meegle 沒有回報評論成功' }
}

export type RemoteComment = { commentId: string; content: string; creator: string; createdAt: string; fileUrl: string }

/** 列出某個時間之後的評論（翻完每一頁；任何一頁失敗整個回不明，不回半份清單）。 */
export async function listComments(token: string, workItemId: string, sinceMs: number, runner: Runner = defaultRunner, env: NodeJS.ProcessEnv = process.env): Promise<CallOutcome<RemoteComment[]>> {
  const t = meegleTarget(env)
  const out: RemoteComment[] = []
  for (let page = 1; page <= 20; page++) {
    const r = await call(runner, ['comment', 'list', '--project-key', t.projectKey, '--work-item-id', workItemId,
      '--start-time', String(Math.max(0, sinceMs)), '--page-num', String(page)], token)
    if (r.kind !== 'ok') return r.kind === 'rejected' ? r : { kind: 'unknown', message: r.message }
    const v = r.value as { comments?: unknown; pagination?: { total_pages?: unknown } }
    if (!Array.isArray(v?.comments)) return { kind: 'unknown', message: `評論清單第 ${page} 頁格式不對` }
    for (const c of v.comments as Array<Record<string, unknown>>) {
      out.push({ commentId: String(c.comment_id ?? ''), content: String(c.content ?? ''), creator: String(c.creator ?? ''), createdAt: String(c.created_at ?? ''), fileUrl: String(c.file_url ?? '') })
    }
    const totalPages = Number(v.pagination?.total_pages ?? 1)
    if (!Number.isFinite(totalPages) || page >= totalPages) return { kind: 'ok', value: out }
  }
  return { kind: 'unknown', message: '評論清單超過 20 頁，沒有拿齊' }
}

// ─── 純函式 ──────────────────────────────────────────────────────────────────

/**
 * 只做 Meegle **已知**的改寫（CodeX：正規化別刪掉有語意的差異）：
 * - 圖片：`![任何文字](url)` → `![](url)`，拿掉 `<!-- image:{...} -->`
 * - 行尾空白、連續空行縮成一行、頭尾空白
 */
export function normalizeDesc(s: string): string {
  return s
    .replace(/\r\n/g, '\n')
    .replace(/<!--\s*image:\{[^}]*\}\s*-->/g, '')
    .replace(/!\[[^\]]*\]\(([^)\s]+)\)/g, '![]($1)')
    .split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/**
 * 「讀回來的是不是我剛送的」用這個比：**只比看得到的文字**，不比 Markdown 格式。
 *
 * 2026-10-02 使用者真送兩張全被判「讀回不一致」，實測 Meegle 存檔時會把 Markdown 解析再重新輸出
 * （server/__fixtures__/meegle-md-sent.txt → meegle-md-back.txt）：清單重新編號、`*`→`-`、子清單縮排改 4 格、
 * `1)`→`1.`、`__粗__`→`**粗**`、部分換行合併、`<tag>` 被拿掉、引用區塊延續到後面幾行。
 * 只處理「已知改寫」的 normalizeDesc 追不完這些，所以改成：拿掉清單／標題／引用標記、強調符號、反引號、HTML 標籤、所有空白後比對。
 * 會忽略的只有格式差異（粗體與否、清單符號、縮排、換行）；字有任何增刪改都比得出來——同時被人改內容仍會判不一致。
 */
export function textFingerprint(s: string): string {
  return s
    .replace(/\r\n/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\(/g, '![](')          // 圖片替代文字會被 Meegle 拿掉
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .split('\n')
    .map(l => l
      .replace(/^[\s>]*/, '')                  // 引用、縮排
      .replace(/^#{1,6}\s+/, '')               // 標題
      .replace(/^(?:[-*+]|\d+[.)])\s+/, ''))   // 清單符號／編號（Meegle 會重新編號）
    .join('')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, '')
}

export function descHash(s: string): string {
  return createHash('sha256').update(normalizeDesc(s)).digest('hex')
}

/** Meegle「測試說明」的預設範本（每列都是這些標題／佔位字）。純範本＝還沒人寫過內容。 */
const TEMPLATE_LINES = new Set([
  '【功能目的】', '1. 目的', '2. 影響範圍',
  '【前置條件】', '1. 環境', '2. 測試資料', '3. 情境', '4. 參數 / 設定',
  '【測試步驟】', '1. 主要流程', '2. 延伸測試',
  '【說明與備註】', '1. 特殊行為 / 已知限制', '2. 風險或需留意事項',
  '【驗證結果】',
])

export function isTemplateOnly(s: string): boolean {
  const text = s.replace(/<[^>]+>/g, '')
  return text.split('\n').map(l => l.trim()).filter(Boolean).every(l => TEMPLATE_LINES.has(l))
}

export type RemoteState = 'empty' | 'same' | 'changed' | 'has-content'

/**
 * 測試說明現況（覆寫前判斷）：
 * - empty：空白或只有範本 → 直接覆寫
 * - same：跟上次工具寫入後讀回的值一樣 → 直接覆寫
 * - changed：有基準、而且不一樣 → 被人改過，要人確認
 * - has-content：沒有基準、但有內容 → 只能說「已有內容」，**不能**宣稱被改過（CodeX）
 */
export function classifyRemote(current: string, snapshotHash: string | null): RemoteState {
  if (!current.trim() || isTemplateOnly(current)) return 'empty'
  if (snapshotHash) return descHash(current) === snapshotHash ? 'same' : 'changed'
  return 'has-content'
}

/** 測試說明內容＋圖片。圖片接在最後（Jira 版也是圖片放評論尾端）。 */
export function buildDescription(text: string, images: Array<{ name: string; url: string }>): string {
  const body = text.replace(/\r\n/g, '\n').trim()
  if (!images.length) return body
  return `${body}\n\n${images.map(i => `![${i.name.replace(/[[\]]/g, '')}](${i.url})`).join('\n\n')}`
}

/**
 * 評論送出結果不明時，找「可能就是這則」的候選。**只產生候選，不判定成功**（CodeX：沒有可歸屬本次操作的證據就維持 unknown）。
 * 條件：同建立者、送出時間（往前 2 分鐘容許時鐘差）之後、正規化內文相同。
 */
export function commentCandidates(comments: RemoteComment[], opts: { creator: string; sinceMs: number; content: string }): RemoteComment[] {
  const want = normalizeDesc(opts.content)
  return comments.filter(c => {
    if (opts.creator && c.creator !== opts.creator) return false
    const t = Date.parse(c.createdAt.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(c.createdAt) ? '' : 'Z'))
    if (Number.isFinite(t) && t < opts.sinceMs - 120_000) return false
    return normalizeDesc(c.content) === want
  })
}
