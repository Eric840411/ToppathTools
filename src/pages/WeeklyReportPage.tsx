import { useEffect, useRef, useState } from 'react'
import { loadGlobalAccount } from '../authSession'

interface FieldOption { id: string; name: string }
interface ParsedTable { appToken: string; tableId: string; members: FieldOption[]; projects: FieldOption[] }

const LAST_URL_KEY = 'weekly_report_last_url'
const STACK_BREAKPOINT = 1100

/** 視窗寬度 < 1100px 時 Step2/3 從左右兩欄改回上下堆疊（2026-08-11：純 flexbox 縮小在小筆電寬度下
 * textarea 會被壓到只剩 ~340px，堪用但偏窄，改成真正的斷點比較可預期） */
function useIsNarrow(breakpoint: number): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < breakpoint)
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < breakpoint)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [breakpoint])
  return narrow
}

export function WeeklyReportPage({ themeMode }: { themeMode: 'classic' | 'xianxia' }) {
  const isXianxia = themeMode === 'xianxia'
  const t = isXianxia
    ? {
        title: '行跡呈報',
        sub: '每週貼上當週玉簡（Lark Base）鏈印，擇己身道號、記本週行跡，直入宗門卷宗一列',
        step1: '貼上本週玉簡鏈印', step1Sub: '每週卷宗不同，貼上鏈印後自動啟卷讀取選項',
        reload: '重新啟卷', parseOkPrefix: '已啟卷', projectLabel: '職司選項', memberLabel: '道友選項',
        step2: '擇己身道號', step2Sub: '道號為必填，主司職務為選填',
        memberField: '道號', projectField: '主司職務', projectPlaceholder: '不指定（行跡自行標註）',
        step3: '本週行跡', step3Sub: '可將 Jira 令牌摘要與親筆手記混寫，最終合併成同一段行跡紀要',
        jiraPlaceholder: '貼上 Jira 令牌編號，例如 CGMN-26（可一次貼多個，用逗號分隔）',
        jiraBtn: '帶入摘要', jiraHint: '按下後會自動抓摘要與狀態，插入到下方手記，插入後可自由編修',
        submit: '呈報宗門', submitNote: '呈報後會在該卷宗新增一列（道號 / 主司職務 / 行跡紀要）',
        selectPlaceholder: '請擇一...',
      }
    : {
        title: '週報彙整',
        sub: '每週貼上當週 Lark Base 網址，選擇自己、填寫本週工作內容，直接送出成一列紀錄',
        step1: '貼上本週 Lark Base 網址', step1Sub: '每週表格不同，貼上網址後自動讀取欄位選項',
        reload: '重新讀取', parseOkPrefix: '已讀取表格', projectLabel: '專案選項', memberLabel: '成員選項',
        step2: '選擇自己', step2Sub: '成員為必填，主要專案為選填',
        memberField: '成員', projectField: '主要專案', projectPlaceholder: '不指定（內容自己標專案）',
        step3: '本週工作內容', step3Sub: '可混寫 Jira 單摘要與手寫文字，最終合併成同一段補充說明',
        jiraPlaceholder: '貼上 Jira 單號，例如 CGMN-26（可一次貼多個，用逗號分隔）',
        jiraBtn: '帶入摘要', jiraHint: '按下後會自動抓摘要與狀態，插入到下方文字框，插入後可自由編輯',
        submit: '送出至 Lark', submitNote: '送出後會在該表新增一列（成員 / 主要專案 / 補充說明）',
        selectPlaceholder: '請選擇...',
      }

  const [url, setUrl] = useState(() => localStorage.getItem(LAST_URL_KEY) ?? '')
  const [parsed, setParsed] = useState<ParsedTable | null>(null)
  const [parseMsg, setParseMsg] = useState('')
  const [parsing, setParsing] = useState(false)

  const [member, setMember] = useState('')
  const [project, setProject] = useState('')
  const [content, setContent] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const [jiraKeys, setJiraKeys] = useState('')
  const [jiraLoading, setJiraLoading] = useState(false)
  const [jiraMsg, setJiraMsg] = useState('')

  const [submitting, setSubmitting] = useState(false)
  const [submitMsg, setSubmitMsg] = useState('')

  const isNarrow = useIsNarrow(STACK_BREAKPOINT)

  const handleParse = async () => {
    if (!url.trim()) return
    setParsing(true); setParseMsg(''); setParsed(null); setMember(''); setProject('')
    try {
      const r = await fetch('/api/weekly-report/parse', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
      })
      const d = await r.json() as { ok: boolean; message?: string; appToken?: string; tableId?: string; members?: FieldOption[]; projects?: FieldOption[] }
      if (d.ok && d.appToken && d.tableId) {
        setParsed({ appToken: d.appToken, tableId: d.tableId, members: d.members ?? [], projects: d.projects ?? [] })
        setParseMsg(`${t.parseOkPrefix} — ${t.projectLabel} ${d.projects?.length ?? 0} 個、${t.memberLabel} ${d.members?.length ?? 0} 個`)
        localStorage.setItem(LAST_URL_KEY, url)
      } else {
        setParseMsg(d.message || '讀取失敗')
      }
    } catch (e) {
      setParseMsg(`讀取失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setParsing(false)
    }
  }

  const handleJiraFetch = async () => {
    const keys = jiraKeys.split(',').map(s => s.trim()).filter(Boolean)
    if (keys.length === 0) return
    const account = loadGlobalAccount()
    if (!account?.email) { setJiraMsg('找不到目前登入帳號，請重新登入'); return }

    setJiraLoading(true); setJiraMsg('')
    try {
      const r = await fetch('/api/jira/batch-fetch-fields', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-jira-email': account.email },
        body: JSON.stringify({ issueKeys: keys }),
      })
      const d = await r.json() as { ok: boolean; message?: string; issues?: Record<string, { summary?: string; status?: string }> }
      if (!d.ok) { setJiraMsg(d.message || '帶入失敗'); return }

      const lines = keys
        .map(key => d.issues?.[key] ? `[${key}] ${d.issues[key].summary ?? ''}（${d.issues[key].status ?? ''}）` : null)
        .filter((l): l is string => !!l)
      if (lines.length === 0) { setJiraMsg('沒有抓到任何單號的資料，確認單號正確或有存取權限'); return }

      const insertText = `${lines.join('\n')}\n`
      const ta = textareaRef.current
      if (ta) {
        const start = ta.selectionStart ?? content.length
        const end = ta.selectionEnd ?? content.length
        const next = content.slice(0, start) + insertText + content.slice(end)
        setContent(next)
        const cursor = start + insertText.length
        requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(cursor, cursor) })
      } else {
        setContent(c => c + (c ? '\n' : '') + insertText)
      }
      setJiraKeys('')
    } catch (e) {
      setJiraMsg(`帶入失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setJiraLoading(false)
    }
  }

  const canSubmit = !!parsed && !!member && content.trim().length > 0 && !submitting

  const handleSubmit = async () => {
    if (!parsed || !member || !content.trim()) return
    setSubmitting(true); setSubmitMsg('')
    try {
      const r = await fetch('/api/weekly-report/submit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appToken: parsed.appToken, tableId: parsed.tableId, member, project: project || undefined, content }),
      })
      const d = await r.json() as { ok: boolean; message?: string }
      if (d.ok) { setSubmitMsg('通過 已送出'); setContent('') }
      else setSubmitMsg(`失敗 ${d.message}`)
    } catch (e) {
      setSubmitMsg(`失敗 ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={{ maxWidth: 1200, width: '100%', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
      {/* topbar 已經顯示標題，這裡不重複顯示大標題，只留說明文字 */}
      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 20 }}>{t.sub}</div>

      {/* Step 1 — 全寬，網址本來就長 */}
      <div style={{ border: '1px solid #2d3f55', borderRadius: 10, background: '#10182a', padding: '18px 20px', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <span style={{ width: 22, height: 22, borderRadius: '50%', background: parsed ? 'var(--xx-jade-solid)' : 'var(--cr-cyan-soft)', color: parsed ? '#fff' : 'var(--cr-cyan)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>{parsed ? '✓' : '1'}</span>
          <span style={{ fontSize: 13.5, fontWeight: 700 }}>
            {t.step1}
            <small style={{ display: 'block', fontSize: 10.5, fontWeight: 400, color: '#64748b', marginTop: 2 }}>{t.step1Sub}</small>
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input type="text" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://.../base/{appToken}?table={tableId}"
            style={{ flex: 1, padding: '8px 10px', background: '#0b1322', border: '1px solid #2d3f55', borderRadius: 7, color: '#e2e8f0', fontSize: 12.5 }} />
          <button onClick={handleParse} disabled={parsing || !url.trim()}
            style={{ padding: '6px 12px', fontSize: 11.5, fontWeight: 700, borderRadius: 7, background: 'var(--cr-cyan-soft)', color: 'var(--cr-cyan)', border: '1px solid var(--cr-cyan-border, transparent)', cursor: parsing ? 'default' : 'pointer', opacity: parsing ? .6 : 1 }}>
            {parsing ? '讀取中…' : t.reload}
          </button>
        </div>
        {parseMsg && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 11.5, borderRadius: 7, padding: '8px 10px', color: parsed ? 'var(--cr-cyan)' : 'var(--cr-rose)', background: parsed ? 'var(--cr-cyan-soft)' : 'var(--cr-rose-soft, rgba(223,118,94,.12))', border: `1px solid ${parsed ? 'var(--cr-cyan-border)' : 'transparent'}` }}>
            <span>{parsed ? '✓' : '⚠'}</span>
            <span>{parseMsg}</span>
          </div>
        )}
      </div>

      {/* Step 2 + 3 — 寬螢幕左右兩欄利用空間，<1100px 斷回上下堆疊（純 flex 縮小在小筆電寬度下
          textarea 會被壓太窄，改用真正的斷點） */}
      <div style={{ display: 'flex', flexDirection: isNarrow ? 'column' : 'row', gap: 14, alignItems: 'stretch', marginBottom: 14 }}>
        {/* Step 2 */}
        <div style={{ flex: isNarrow ? '1 1 auto' : '0 0 340px', width: isNarrow ? '100%' : undefined, border: '1px solid #2d3f55', borderRadius: 10, background: '#10182a', padding: '18px 20px', opacity: parsed ? 1 : .5, pointerEvents: parsed ? 'auto' : 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <span style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--cr-cyan-soft)', color: 'var(--cr-cyan)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>2</span>
            <span style={{ fontSize: 13.5, fontWeight: 700 }}>
              {t.step2}
              <small style={{ display: 'block', fontSize: 10.5, fontWeight: 400, color: '#64748b', marginTop: 2 }}>{t.step2Sub}</small>
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label style={{ display: 'block', fontSize: 11, color: '#94a3b8', marginBottom: 5 }}>
                {t.memberField} <span style={{ fontSize: 9.5, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: 'var(--cr-rose-soft, rgba(223,118,94,.12))', color: 'var(--cr-rose)', marginLeft: 6 }}>必填</span>
              </label>
              <select value={member} onChange={e => setMember(e.target.value)}
                style={{ width: '100%', padding: '8px 10px', background: '#0b1322', border: '1px solid #2d3f55', borderRadius: 7, color: '#e2e8f0', fontSize: 12.5 }}>
                <option value="">{t.selectPlaceholder}</option>
                {parsed?.members.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 11, color: '#94a3b8', marginBottom: 5 }}>
                {t.projectField} <span style={{ fontSize: 9.5, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: 'rgba(148,163,184,.12)', color: '#94a3b8', marginLeft: 6 }}>選填</span>
              </label>
              <select value={project} onChange={e => setProject(e.target.value)}
                style={{ width: '100%', padding: '8px 10px', background: '#0b1322', border: '1px solid #2d3f55', borderRadius: 7, color: '#e2e8f0', fontSize: 12.5 }}>
                <option value="">{t.projectPlaceholder}</option>
                {parsed?.projects.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
              </select>
            </div>
          </div>
        </div>

        {/* Step 3 */}
        <div style={{ flex: 1, minWidth: 0, border: '1px solid #2d3f55', borderRadius: 10, background: '#10182a', padding: '18px 20px', opacity: parsed ? 1 : .5, pointerEvents: parsed ? 'auto' : 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <span style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--cr-cyan-soft)', color: 'var(--cr-cyan)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>3</span>
            <span style={{ fontSize: 13.5, fontWeight: 700 }}>
              {t.step3}
              <small style={{ display: 'block', fontSize: 10.5, fontWeight: 400, color: '#64748b', marginTop: 2 }}>{t.step3Sub}</small>
            </span>
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <input type="text" value={jiraKeys} onChange={e => setJiraKeys(e.target.value)} placeholder={t.jiraPlaceholder}
              style={{ flex: 1, padding: '8px 10px', background: '#0b1322', border: '1px solid #2d3f55', borderRadius: 7, color: '#e2e8f0', fontSize: 12.5 }} />
            <button onClick={handleJiraFetch} disabled={jiraLoading || !jiraKeys.trim()}
              style={{ padding: '6px 12px', fontSize: 11.5, fontWeight: 700, borderRadius: 7, background: 'var(--cr-cyan-soft)', color: 'var(--cr-cyan)', border: '1px solid var(--cr-cyan-border, transparent)', cursor: jiraLoading ? 'default' : 'pointer', opacity: jiraLoading ? .6 : 1 }}>
              {jiraLoading ? '帶入中…' : t.jiraBtn}
            </button>
          </div>
          <div style={{ fontSize: 10.5, color: '#64748b', marginBottom: 6 }}>{t.jiraHint}</div>
          {jiraMsg && <div style={{ fontSize: 11, color: 'var(--cr-rose)', marginBottom: 6 }}>{jiraMsg}</div>}

          <textarea ref={textareaRef} value={content} onChange={e => setContent(e.target.value)}
            style={{ width: '100%', minHeight: 260, padding: '8px 10px', background: '#0b1322', border: '1px solid #2d3f55', borderRadius: 7, color: '#e2e8f0', fontSize: 12.5, lineHeight: 1.6, resize: 'vertical', fontFamily: 'inherit' }} />
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={handleSubmit} disabled={!canSubmit}
          style={{ padding: '8px 16px', fontSize: 12.5, fontWeight: 700, borderRadius: 7, background: canSubmit ? 'var(--xx-jade-solid)' : '#334155', color: '#fff', border: 'none', cursor: canSubmit ? 'pointer' : 'default' }}>
          {submitting ? '送出中…' : t.submit}
        </button>
        <span style={{ fontSize: 11, color: '#64748b' }}>{t.submitNote}</span>
        {submitMsg && <span style={{ fontSize: 12, color: submitMsg.startsWith('通過') ? '#16a34a' : '#dc2626' }}>{submitMsg}</span>}
      </div>
    </div>
  )
}
