import { z } from 'zod'

export const tcBindingSchema = z.object({
  recordId: z.string().min(1).max(80), tableId: z.string().min(1).max(80),
  number: z.string().max(80).default(''), text: z.string().min(1).max(1000), sub: z.string().max(80).default(''),
})
export const scriptSchema = z.object({
  id: z.string().min(1).max(80).optional(), title: z.string().trim().min(1).max(200),
  larkUrl: z.string().url().max(2000), tableId: z.string().min(1).max(80),
  bindings: z.array(tcBindingSchema).min(1).max(20),
  steps: z.array(z.object({ action: z.string().min(1).max(60), tcId: z.string().max(80).nullable().optional(), disabled: z.boolean().optional(), baselinePng: z.string().max(2800000).optional() }).passthrough()).max(300),
})

export function recordingSaveErrors(input: unknown): string[] {
  const result = scriptSchema.safeParse(input)
  if (!result.success) return [...new Set(result.error.issues.map(issue => {
    const [root, index, field] = issue.path
    if (root === 'title') return '請填寫腳本名稱（1～200 字）'
    if (root === 'larkUrl') return 'Lark 網址格式不正確，請回主畫面確認'
    if (root === 'tableId') return '尚未指定 Lark 表格，請先掃描並綁定 TC'
    if (root === 'bindings') return typeof index === 'number' ? `第 ${index + 1} 筆 TC 的 ${String(field || '資料')} 格式不正確` : '請綁定 1～20 筆 TC'
    if (root === 'steps') return typeof index === 'number' ? `第 ${index + 1} 步的 ${String(field || '資料')} 格式不正確` : '腳本最多可儲存 300 步，請拆分腳本'
    return `欄位 ${issue.path.join('.')} 格式不正確`
  }))]
  const value = result.data
  const url = new URL(value.larkUrl)
  if (!/\/base\/[^/]+/.test(url.pathname) || url.searchParams.get('table') !== value.tableId) return ['Lark 網址與綁定表格不一致，請確認主畫面網址與本腳本使用同一張表格']
  if (JSON.stringify(value).length > 8_000_000) return ['腳本含基準圖最多 8 MB，請縮小區域或拆分腳本']
  return []
}
