/**
 * 批量評論的兩項 AI：排版（用 Prompt 模板改寫正文）與完整性分析。Jira 批量評論與 Meegle 批量評論共用這一份
 * （CodeX 2026-10-02：共用 prompt、輸入型別與分析邏輯；平台格式轉換各自處理）。
 *
 * ⚠️ 兩邊跑的**時機不同**（記在 docs/decisions.md）：Jira 版在送出時於後端改寫；Meegle 版在③預覽時就跑，
 *    送出的是使用者最後看到、手改過的內容，送出時不再跑 AI。
 */
import { callLLM, readGeminiPrompts, renderPrompt } from './routes/gemini.js'

export interface CommentContext {
  rawText: string
  promptId?: string
  environment?: string
  version?: string
  platform?: string
  machineId?: string
  gameMode?: string
  specContext?: string
  modelSpec?: string
}

/** AI 排版：用 Prompt 模板改寫評論正文 */
export async function formatCommentWithAI(ctx: CommentContext): Promise<string> {
  const { rawText, promptId, environment = '', version = '', platform = '', machineId = '', gameMode = '', specContext = '', modelSpec } = ctx

  const envBlock = [
    `測試環境：${environment || '未指定'}`,
    `版本號：${version || '未指定'}`,
    `測試平台：${platform || '未指定'}`,
    machineId ? `機台編號：${machineId}` : '',
    gameMode ? `遊戲模式：${gameMode}` : '',
  ].filter(Boolean).join('\n')

  const prompts = readGeminiPrompts()
  const tpl = (promptId ? prompts.find(p => p.id === promptId) : null) ?? prompts.find(p => p.id === 'default') ?? prompts[0]
  if (!tpl) throw new Error('找不到可用的 Prompt 模板')

  const prompt = renderPrompt(tpl.template, {
    rawText,
    envBlock,
    environment: environment || '未指定',
    version: version || '未指定',
    platform: platform || '未指定',
    machineId: machineId || '',
    gameMode: gameMode || '',
    specContext: specContext || '',
  })

  return callLLM(prompt, modelSpec)
}

/** AI 完整性分析的 prompt（分析的是「實際要貼出去的正文」） */
export function buildCompletenessPrompt(summary: string, description: string, commentText: string): string {
  return `你是 QA 評審員，請分析以下測試評論的完整性。

【Issue 摘要】
${summary.trim() || '（無摘要）'}

【Issue 描述】
${description.trim() || '（無描述）'}

【測試者評論】
${commentText}

請用繁體中文，以三點條列方式回覆：
1️⃣ **已涵蓋的重點**：評論中已說明清楚的部分
2️⃣ **可能遺漏或不足之處**：對照規格和評論格式要求，尚未說明或需補充的地方
3️⃣ **整體評估**：完整性評分 X/10，以及改善建議

格式簡潔，每點 2-3 句即可。`
}

/** 知識庫文件內容接到 specContext 前面（Jira 版既有行為） */
export function buildSpecContext(kb: Array<{ name: string; content: string }>, manual: string): string {
  const parts = kb.filter(d => d.content).map(d => `=== 知識庫：${d.name} ===\n${d.content.slice(0, 12000)}`)
  if (!parts.length) return manual
  const kbBlock = parts.join('\n\n')
  return manual.trim() ? `${kbBlock}\n\n=== 補充說明 ===\n${manual}` : kbBlock
}
