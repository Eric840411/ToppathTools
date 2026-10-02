/**
 * 批量評論（Jira「批量評論」與「Meegle 評論」兩個分頁）共用的 Sheet 文字規則。
 * 原本寫在 JiraPage.tsx 裡；Meegle 版要「無痛轉移、Sheet 不變」，同一份 Sheet 讀出來的東西必須一模一樣，
 * 所以抽出來兩邊共用，不複製（CLAUDE.md 跨功能踩坑 #3）。內容一字未改。
 */

export type SheetRecordLike = Record<string, string>

export const SHEET_FIELD: Record<string, string> = {
  summary: '摘要',
  description: '內容',
  assigneeAccountId: '受託人',
  rdOwnerAccountId: 'RD負責人',
  reporter: '回報人',
  verifierAccountIds: '驗證人員',
  actualStart: 'Actual Start',
  actualEnd: 'Actual End',
  localTestDone: '本機完成測試時間',
  stagingDeploy: '上C服時間',
  releaseDate: '上線日期',
}

export const getField = (r: SheetRecordLike, fieldName: string): string => {
  const lower = fieldName.toLowerCase()
  const key = Object.keys(r).find(k => k.toLowerCase() === lower)
  return key ? r[key] : ''
}

export const getFieldByHeaderMatch = (r: SheetRecordLike, names: string[]): string => {
  for (const name of names) {
    const exact = getField(r, name).trim()
    if (exact) return exact
  }
  const keys = Object.keys(r).filter(k => k !== '_rowIndex')
  const key = keys.find(k => names.some(name => k.toLowerCase().includes(name.toLowerCase())))
  return key ? (r[key] ?? '').trim() : ''
}

const appendRawSection = (parts: string[], label: string, value: string) => {
  const clean = value.trim()
  if (!clean) return
  if (parts.some(p => p.endsWith(`：${clean}`))) return
  parts.push(`${label}：${clean}`)
}

/** 開「AI 排版」時餵給 AI 的原文：不只評論欄，還有摘要、內容、類別、進度等欄位 */
export const buildAiCommentRawText = (record: SheetRecordLike, commentColumn: string): string => {
  const parts: string[] = []
  appendRawSection(parts, '摘要', getField(record, SHEET_FIELD.summary) || getFieldByHeaderMatch(record, ['摘要', 'summary']))
  appendRawSection(parts, '內容', getField(record, SHEET_FIELD.description) || getFieldByHeaderMatch(record, ['內容', 'description']))
  appendRawSection(parts, commentColumn || '回覆欄位', commentColumn ? getField(record, commentColumn) : '')
  appendRawSection(parts, '類別', getFieldByHeaderMatch(record, ['類別', '測試平台', '平台']))
  appendRawSection(parts, '進度', getFieldByHeaderMatch(record, ['進度']))
  appendRawSection(parts, 'QA確認OK', getFieldByHeaderMatch(record, ['QA確認OK', 'QA 確認 OK', 'QA']))
  appendRawSection(parts, '開發確認OK', getFieldByHeaderMatch(record, ['開發確認OK', '開發 確認 OK', '開發']))
  appendRawSection(parts, '備註', getFieldByHeaderMatch(record, ['備註', 'remark', 'note']))
  return parts.join('\n')
}

export const deriveEnvironment = (record: SheetRecordLike, rawText: string): string | undefined => {
  const explicit = getFieldByHeaderMatch(record, ['環境', '測試環境'])
  if (explicit) return explicit
  const match = rawText.match(/(?:通過-|於|在)?([A-ZＣ]服)/i)
  return match?.[1]
}

export const deriveVersion = (record: SheetRecordLike, rawText: string): string | undefined => {
  const explicit = getFieldByHeaderMatch(record, ['版本', '版號'])
  if (explicit) return explicit
  const match = rawText.match(/(?:\(|（)?[A-Z]?(?:\)|）)?\.?\s*([0-9]+(?:\.[0-9]+)?版)/i)
  return match?.[1]
}

/** AI 排版的環境資訊（Jira 送出時帶的同一組） */
export const aiContextFor = (record: SheetRecordLike, text: string) => ({
  machineId: getField(record, '機台編號') || undefined,
  gameMode: getField(record, '遊戲模式') || undefined,
  environment: deriveEnvironment(record, text) || undefined,
  version: deriveVersion(record, text) || undefined,
  platform: getFieldByHeaderMatch(record, ['測試平台', '平台', '類別']) || undefined,
})

// 評論範本結構：每個區塊含必填細項（細項用「：」結尾，偵測冒號後是否有內容）
export const COMMENT_TEMPLATE_SECTIONS: { header: string; items: string[] }[] = [
  { header: '【功能目的】', items: ['目的', '影響範圍'] },
  { header: '【前置條件】', items: ['環境', '版本', '測試平台', '測試資料', '情境', '參數 / 設定'] },
  { header: '【測試步驟】', items: ['主要流程', '延伸測試'] },
  { header: '【說明與備註】', items: ['特殊行為 / 已知限制', '風險或需留意事項'] },
  { header: '【驗證結果】', items: [] },
]

// 回傳所有「缺漏」項目：缺少區塊標題、缺欄位、或細項冒號後沒填內容
export const validateCommentSections = (text: string): string[] => {
  const problems: string[] = []
  const lines = text.split(/\r?\n/)
  for (const sec of COMMENT_TEMPLATE_SECTIONS) {
    const headerIdx = lines.findIndex(l => l.includes(sec.header))
    if (headerIdx === -1) { problems.push(sec.header); continue }
    if (sec.items.length === 0) {
      // 【驗證結果】：標題之後（到下一個 【 區塊前）需有內容
      let hasContent = false
      for (let i = headerIdx + 1; i < lines.length; i++) {
        if (/^\s*【/.test(lines[i])) break
        if (lines[i].trim()) { hasContent = true; break }
      }
      if (!hasContent) problems.push(`${sec.header} 未填結果`)
    } else {
      for (const item of sec.items) {
        const line = lines.find(l => {
          const t = l.trim()
          return t.startsWith(`${item}：`) || t.startsWith(`${item}:`)
        })
        if (!line) { problems.push(`${item}（缺欄位）`); continue }
        const after = line.replace(/^[^：:]*[：:]/, '').trim()
        if (!after) problems.push(item)
      }
    }
  }
  return problems
}
