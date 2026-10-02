/**
 * 評論格式檢查（Jira／Meegle 批量評論共用）。跑法：npx tsx src/features/batch-comment/comment-text.test.ts
 * 編號版取自 2026-10-02 #15194994 預覽畫面的 AI 產出（Meegle 測試說明範本本身就是「1. 目的」格式）。
 */
import { validateCommentSections } from './comment-text'

let pass = 0, fail = 0
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : ` | got: ${JSON.stringify(got)} | want: ${JSON.stringify(want)}`}`)
  ok ? pass++ : fail++
}

const build = (marker: (i: number) => string, overrides: Record<string, string> = {}) => {
  const sec = (header: string, items: string[]) =>
    [header, ...items.map((k, i) => `${marker(i + 1)}${k}：${overrides[k] ?? '有內容'}`)].join('\n')
  return [
    sec('【功能目的】', ['目的', '影響範圍']),
    sec('【前置條件】', ['環境', '版本', '測試平台', '測試資料', '情境', '參數 / 設定']),
    sec('【測試步驟】', ['主要流程', '延伸測試']),
    sec('【說明與備註】', ['特殊行為 / 已知限制', '風險或需留意事項']),
    '【驗證結果】\n通過',
  ].join('\n\n')
}

eq('無編號（Jira 原本格式）全齊', validateCommentSections(build(() => '')), [])
eq('「1. 目的：」編號格式全齊（#15194994 實況）', validateCommentSections(build(i => `${i}. `)), [])
eq('「1、」編號', validateCommentSections(build(i => `${i}、`)), [])
eq('「(1)」編號', validateCommentSections(build(i => `(${i}) `)), [])
eq('「- 」清單', validateCommentSections(build(() => '- ')), [])
eq('「* 」清單', validateCommentSections(build(() => '* ')), [])
eq('「• 」清單', validateCommentSections(build(() => '• ')), [])
eq('「1)」編號', validateCommentSections(build(i => `${i}) `)), [])
eq('全形括號「（1）」編號', validateCommentSections(build(i => `（${i}）`)), [])
eq('編號格式下冒號後空字串仍算沒填', validateCommentSections(build(i => `${i}. `, { 版本: '' })), ['版本'])
eq('編號格式下冒號後只有空格仍算沒填', validateCommentSections(build(i => `${i}. `, { 版本: '   ' })), ['版本'])
eq('編號格式下冒號後只有 Tab 仍算沒填', validateCommentSections(build(i => `${i}. `, { 版本: '\t' })), ['版本'])
eq('編號格式下真的缺欄位仍報缺', validateCommentSections(build(i => `${i}. `).replace(/\d+\. 情境：有內容\n/, '')), ['情境（缺欄位）'])
eq('欄位名稱不放寬：「目的說明：」不算「目的」', validateCommentSections(build(i => `${i}. `).replace('目的：', '目的說明：')), ['目的（缺欄位）'])
eq('半形冒號', validateCommentSections(build(i => `${i}. `).replace('目的：', '目的:')), [])

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) throw new Error(`${fail} failed`)
