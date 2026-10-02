/**
 * 讀 Meegle 單子當「參考單」（TestCase 生成取代原本的 Jira 參考單，使用者 2026-10-02 選 B＝改讀 Meegle）。
 * 用**操作者自己的 Meegle 綁定**讀（不借別人的 token）。任何一張讀不到就整批失敗、講清楚是哪張——
 * 少一張參考單 AI 也不會知道，產出的 TestCase 會默默缺一塊。
 * 回傳的形狀沿用原本 Jira 參考單（key／summary／description／status／issueType），prompt 的 {{jira_issues}} 不用改；
 * 另外帶 source／workItemId 讓之後追得到來源（CodeX：內部記錄來源、空間與工作項 ID）。
 */
import { call, defaultRunner, meegleTarget, type CallOutcome, type Runner } from './meegle-workitem.js'
import { DESC_FIELD } from './meegle-comment-ops.js'

export type RefIssue = { key: string; summary: string; description: string; testNotes: string; status: string; issueType: string; source: 'meegle'; projectKey: string; workItemId: string }

export async function fetchMeegleRefs(token: string, ids: string[], runner: Runner = defaultRunner, env: NodeJS.ProcessEnv = process.env): Promise<CallOutcome<RefIssue[]>> {
  const t = meegleTarget(env)
  const out: RefIssue[] = []
  for (const id of ids) {
    const r = await call(runner, ['workitem', 'get', '--project-key', t.projectKey, '--work-item-id', id, '--fields', 'description', '--fields', DESC_FIELD], token)
    if (r.kind !== 'ok') return { kind: r.kind, message: `讀不到 Meegle #${id}：${r.message}` }
    const v = r.value as { work_item_attribute?: { work_item_name?: unknown; work_item_status?: { name?: unknown }; work_item_type?: { name?: unknown } }; work_item_fields?: Array<{ key?: unknown; value?: unknown }> }
    const a = v?.work_item_attribute
    if (!a) return { kind: 'unknown', message: `Meegle 回應裡沒有 #${id}` }
    const field = (k: string) => { const f = (v.work_item_fields ?? []).find(x => x.key === k)?.value; return typeof f === 'string' ? f : '' }
    out.push({
      key: `#${id}`, summary: String(a.work_item_name ?? ''), description: field('description'), testNotes: field(DESC_FIELD),
      status: String(a.work_item_status?.name ?? ''), issueType: String(a.work_item_type?.name ?? ''), source: 'meegle', projectKey: t.projectKey, workItemId: id,
    })
  }
  return { kind: 'ok', value: out }
}
