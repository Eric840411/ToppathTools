// 1007 CodeX（af25442 審查 P2）：UAT 執行入口的步驟清理（純函式，探針 scripts/ui-checks/server-derived-fields.test.ts）
/**
 * 這幾個欄位**只能由 server 產生**（基準圖網址／門檻、後台片段內容）。
 * 前端 step-model 改成保留所有欄位之後，畫面路徑也能把它們帶進來——agent 會直接 fetch 帶進來的 baselineUrl、照帶進來的片段步驟跑。
 * 所以執行入口一律先清掉，再由 attachBaselineInfo／resolveBackendSnippets 從 DB 重建；查不到就保持沒有（agent 端會明確失敗）。
 */
export const SERVER_DERIVED_STEP_FIELDS = ['baselineUrl', 'baselineName', 'baselineThreshold', 'snippetSteps', 'snippetTitle'] as const
export function stripServerDerivedFields<T>(steps: T[]): T[] {
  return steps.map(step => {
    if (!step || typeof step !== 'object') return step
    const out = { ...(step as Record<string, unknown>) }
    for (const k of SERVER_DERIVED_STEP_FIELDS) delete out[k]
    if (Array.isArray(out.children)) out.children = stripServerDerivedFields(out.children as unknown[])
    return out as T
  })
}
