/**
 * Meegle 批量評論的 Meegle 操作與純函式。跑法：npx tsx server/meegle-comment-ops.test.ts
 * 假資料都取自 2026-10-02 在測試單 #15190441 的實測回應。
 */
import {
  addComment, buildDescription, classifyRemote, commentCandidates, descHash, getDescription, isTemplateOnly,
  listComments, normalizeDesc, setDescription, textFingerprint, uploadFile,
} from './meegle-comment-ops.js'
import type { Runner } from './meegle-workitem.js'
import { readFileSync } from 'fs'
import type { CliResult } from './meegle-cli.js'

let pass = 0, fail = 0
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : ` | got: ${JSON.stringify(got)} | want: ${JSON.stringify(want)}`}`)
  ok ? pass++ : fail++
}
const out = (stdout: string, timedOut = false): CliResult => ({ exitCode: 0, stdout, stderr: '', timedOut })
const ENV = {} as NodeJS.ProcessEnv

// ── 實測：Meegle 預設範本（HTML span 包住的標題／佔位字）──
const span = (t: string) => `<span style="background-color: rgb(255, 255, 255)"><span style="font-size: 14px"><span style="color: #292A2E">${t}</span></span></span>`
const TEMPLATE = ['【功能目的】', '1. 目的', '2. 影響範圍', '【前置條件】', '1. 環境', '2. 測試資料', '3. 情境', '4. 參數 / 設定',
  '【測試步驟】', '1. 主要流程', '2. 延伸測試', '【說明與備註】', '1. 特殊行為 / 已知限制', '2. 風險或需留意事項', '【驗證結果】'].map(span).join('\n\n')

// ── normalizeDesc：只做已知改寫 ──
const sent = '【驗證結果】\n\n- **通過**：工具附圖測試\n\n![tool-test.png](https://x/download/abc?u=1)'
const readBack = '【驗證結果】\n- **通過**：工具附圖測試\n\n![](https://x/download/abc?u=1)<!-- image:{"uuid":"B969DB4C-D585-4A8E-838F-F7DE4F2F96FB"} -->'
eq('實測：送出值與讀回值正規化後相同', normalizeDesc(sent), normalizeDesc(readBack))
eq('有語意的差異不會被抹掉（文字不同）', normalizeDesc('通過') === normalizeDesc('不通過'), false)
eq('粗體符號不被抹掉', normalizeDesc('**通過**') === normalizeDesc('通過'), false)
eq('不同圖片網址不相同', normalizeDesc('![](https://x/a)') === normalizeDesc('![](https://x/b)'), false)

// ── textFingerprint：只比看得到的文字（真實送出／讀回 fixture）──
{
  const sentMd = readFileSync('server/__fixtures__/meegle-md-sent.txt', 'utf8')
  const backMd = readFileSync('server/__fixtures__/meegle-md-back.txt', 'utf8')
  eq('實測：Meegle 重排 Markdown 後文字內容相同', textFingerprint(sentMd) === textFingerprint(backMd), true)
  eq('圖片替代文字被拿掉也算相同', textFingerprint('![a.png](https://x/1)') === textFingerprint('![](https://x/1)<!-- image:{"uuid":"U"} -->'), true)
  eq('字被改 → 不同', textFingerprint(backMd) === textFingerprint(backMd.replace('最後一行', '最後二行')), false)
  eq('多一行字 → 不同', textFingerprint(backMd) === textFingerprint(backMd + '\n有人補了一句'), false)
  eq('通過 vs 不通過 → 不同', textFingerprint('- 通過') === textFingerprint('- 不通過'), false)
  eq('不同圖片 → 不同', textFingerprint('![](https://x/a)') === textFingerprint('![](https://x/b)'), false)
}

// ── 範本判斷 ──
eq('Meegle 預設範本＝純範本', isTemplateOnly(TEMPLATE), true)
eq('空白＝純範本', isTemplateOnly(''), true)
eq('範本裡多填一行字＝不是範本', isTemplateOnly(TEMPLATE + '\n\n' + span('登入後顯示 OK')), false)

// ── classifyRemote ──
const mine = '【驗證結果】\n- 通過'
eq('空白 → empty', classifyRemote('', null), 'empty')
eq('只有範本 → empty（即使有基準）', classifyRemote(TEMPLATE, descHash('別的')), 'empty')
eq('跟上次寫入讀回值相同 → same', classifyRemote(mine, descHash(mine)), 'same')
eq('Meegle 改寫格式（空行、圖片註解）仍算 same', classifyRemote(readBack, descHash(sent)), 'same')
eq('有基準、內容不同 → changed', classifyRemote(mine + '\n- RD 補充：已修', descHash(mine)), 'changed')
eq('沒有基準、有內容 → has-content（不能說被改過）', classifyRemote(mine, null), 'has-content')

// ── buildDescription ──
eq('沒有圖片就是原文', buildDescription('A\r\nB\n', []), 'A\nB')
eq('圖片接在最後、名稱裡的中括號拿掉', buildDescription('A', [{ name: 'a[1].png', url: 'https://x/1' }]), 'A\n\n![a1.png](https://x/1)')

// ── 評論候選（只產生候選，不判定成功）──
const cs = [
  { commentId: '1', content: '[測試] 驗證通過\n', creator: 'u1', createdAt: '2026-10-02 04:13:25', fileUrl: '' },
  { commentId: '2', content: '[測試] 驗證通過', creator: 'u2', createdAt: '2026-10-02 04:13:30', fileUrl: '' },
  { commentId: '3', content: '[測試] 驗證通過', creator: 'u1', createdAt: '2026-10-01 01:00:00', fileUrl: '' },
  { commentId: '4', content: '別的內容', creator: 'u1', createdAt: '2026-10-02 04:14:00', fileUrl: '' },
]
const since = Date.parse('2026-10-02T04:13:00Z')
eq('同建立者＋時間之後＋內文相同 → 候選 1', commentCandidates(cs, { creator: 'u1', sinceMs: since, content: '[測試] 驗證通過' }).map(c => c.commentId), ['1'])
eq('別人貼的不算', commentCandidates(cs, { creator: 'u2', sinceMs: since, content: '[測試] 驗證通過' }).map(c => c.commentId), ['2'])
eq('太早之前的同文字不算', commentCandidates(cs, { creator: 'u1', sinceMs: Date.parse('2026-10-02T05:00:00Z'), content: '[測試] 驗證通過' }).length, 0)

// ── CLI 包裝（實測回應格式）──
{
  const getOut = JSON.stringify({ work_item_attribute: { work_item_id: '15190441' }, work_item_fields: [{ key: 'field_89ff93', name: '測試說明', value: readBack }] })
  let seen: string[] = []
  const r: Runner = async args => { seen = args; return out(getOut) }
  eq('讀測試說明', await getDescription('t', '15190441', r, ENV), { kind: 'ok', value: readBack })
  eq('讀的是 field_89ff93', seen.includes('field_89ff93'), true)
  eq('欄位沒值 → 空字串', await getDescription('t', '1', async () => out(JSON.stringify({ work_item_attribute: {}, work_item_fields: [] })), ENV), { kind: 'ok', value: '' })
  eq('回應沒有這張單 → unknown（不能當空白去覆寫）', (await getDescription('t', '1', async () => out('{}'), ENV)).kind, 'unknown')
  eq('讀取逾時 → unknown', (await getDescription('t', '1', async () => out('', true), ENV)).kind, 'unknown')
}
{
  let fields = ''
  const r: Runner = async args => { fields = args[args.indexOf('--fields') + 1]; return out('{"mcp_result": ""}') }
  eq('覆寫成功（實測回 mcp_result）', await setDescription('t', '1', 'X', r, ENV), { kind: 'ok', value: true })
  eq('送出的是整格 field_value', JSON.parse(fields), [{ field_key: 'field_89ff93', field_value: 'X' }])
  eq('覆寫逾時 → unknown', (await setDescription('t', '1', 'X', async () => out('', true), ENV)).kind, 'unknown')
}
{
  let seen: string[] = []
  const up = JSON.stringify({ file_token: 'tok', file_url: 'https://x/f', name: 'a.png', size: 1, mime_type: 'image/png' })
  const r: Runner = async args => { seen = args; return out(up) }
  eq('圖片上傳拿 token＋url', await uploadFile('t', '1', 'C:/a.png', 'a.png', 'image', r, ENV), { kind: 'ok', value: { fileToken: 'tok', fileUrl: 'https://x/f' } })
  eq('圖片用 16＋field-key', seen.includes('16') && seen.includes('--field-key'), true)
  await uploadFile('t', '1', 'C:/a.mp4', 'a.mp4', 'comment', r, ENV)
  eq('評論附件用 13、不帶 field-key', seen.includes('13') && !seen.includes('--field-key'), true)
  eq('回應沒有 token → unknown', (await uploadFile('t', '1', 'p', 'n', 'image', async () => out('{}'), ENV)).kind, 'unknown')
}
{
  let seen: string[] = []
  const r: Runner = async args => { seen = args; return out('{"action":"create","success":true}') }
  eq('評論成功（實測回 success:true）', await addComment('t', '1', '內容', undefined, r, ENV), { kind: 'ok', value: true })
  eq('沒附件不帶 --file-token', seen.includes('--file-token'), false)
  await addComment('t', '1', '', 'ft', r, ENV)
  eq('有附件只帶一個 --file-token', seen.filter(a => a === '--file-token').length, 1)
  eq('沒有 success:true → unknown（不當成功）', (await addComment('t', '1', 'x', undefined, async () => out('{"action":"create"}'), ENV)).kind, 'unknown')
  eq('評論逾時 → unknown（不能重送）', (await addComment('t', '1', 'x', undefined, async () => out('', true), ENV)).kind, 'unknown')
}
{
  const page = (n: number, total: number) => JSON.stringify({ comments: [{ comment_id: `c${n}`, content: 'x', creator: 'u', created_at: '2026-10-02 04:13:25', file_url: '' }], pagination: { page_num: n, total_pages: total } })
  const r: Runner = async args => out(page(Number(args[args.indexOf('--page-num') + 1]), 2))
  eq('評論清單翻完兩頁', (await listComments('t', '1', 0, r, ENV)).kind === 'ok' ? ((await listComments('t', '1', 0, r, ENV)) as { value: unknown[] }).value.length : -1, 2)
  const bad: Runner = async args => args[args.indexOf('--page-num') + 1] === '2' ? out('', true) : out(page(1, 2))
  eq('第 2 頁失敗 → 整個 unknown，不回半份', (await listComments('t', '1', 0, bad, ENV)).kind, 'unknown')
}

console.log(`\n${pass} 通過，${fail} 失敗`)
process.exit(fail ? 1 : 0)
