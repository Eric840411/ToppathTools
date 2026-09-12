type Evidence = { index: number; name: string; path: string; preview?: string }
type Trace = { index: number; action: string; selector?: string; status: string; durationMs: number; notes?: string;
  locator?: { count: number; visible: boolean; preview?: string; bounds?: { x: number; y: number; width: number; height: number } | null };
  diagnostics?: { expected?: string; actual?: string; differencePct?: number }[]; evidence?: Evidence[] }
export type MultiResult = { recordId: string; task: string; decisionSource?: string; declaredOutcome?: string; outcome: string; assertions: number; allShotPaths: string[]; notes: string; published?: boolean; publishError?: string; steps?: Trace[]; sharedSteps?: Trace[]; evidence?: Evidence[] }
const status: Record<string, string> = { pass: 'PASS', fail: 'FAIL', blocked: '受阻', unverified: '未驗證', disabled: '已停用' }

function Images({ evidence }: { evidence: Evidence[] }) {
  return <div className="uat-evidence-grid">{evidence.map((e, i) => <figure key={`${e.path}-${i}`}>
    {e.preview?.startsWith('data:image/png;base64,') ? <details><summary><img src={e.preview} alt={`第 ${e.index + 1} 步：${e.name}`} loading="lazy" /></summary><a href={e.preview} download={e.name}>下載預覽圖</a><img className="uat-evidence-expanded" src={e.preview} alt={e.name} /></details> : <span>預覽未取得；原圖路徑見下方</span>}
    <figcaption>第 {e.index + 1} 步 · {e.name}<small>{e.path}</small></figcaption>
  </figure>)}</div>
}

export function MultiTcResults({ results, dryRun }: { results: MultiResult[]; dryRun: boolean }) {
  return <>{results.map(r => <div className={`uat-multi-result is-${r.outcome}`} key={r.recordId}>
    <strong>{status[r.outcome] || r.outcome} · {r.task}</strong>
    <span>{r.assertions} 個通過檢查 · {r.allShotPaths.length} 張圖片 · {dryRun ? '未上傳（試跑）' : r.published ? '已回寫 Lark' : '未回寫'}</span>
    {r.decisionSource && <span>{r.decisionSource}：{r.declaredOutcome?.toUpperCase()}（最終結果仍以執行狀態為準）</span>}<small>{r.notes}</small>{r.publishError && <small className="uat-multi-alert">{r.publishError}</small>}
    <details className="uat-run-details"><summary>逐步診斷與證據</summary>
      {!(r.steps?.length || r.sharedSteps?.length) && <p>這筆舊結果沒有逐步資料，更新 Agent 後重新試跑即可產生。</p>}
      {[...(r.sharedSteps || []), ...(r.steps || [])].sort((a, b) => a.index - b.index).map(t => <article className="uat-step-trace" key={t.index}>
        <b>第 {t.index + 1} 步 · {t.action} · {status[t.status] || t.status}</b><small>{t.durationMs} ms</small>
        {t.selector && <code>{t.selector}</code>}
        {t.locator && <span>命中 {t.locator.count} 個 · {t.locator.visible ? '可見' : '不可見'}{t.locator.bounds ? ` · 位置 (${Math.round(t.locator.bounds.x)}, ${Math.round(t.locator.bounds.y)})，${Math.round(t.locator.bounds.width)} × ${Math.round(t.locator.bounds.height)}` : ''}</span>}
        {t.locator?.preview?.startsWith('data:image/png;base64,') && <img src={t.locator.preview} alt={`第 ${t.index + 1} 步命中元素（金框）`} loading="lazy" />}
        {t.diagnostics?.map((d, i) => <div key={i}>預期：{d.expected ?? '—'}<br />實際：{d.actual ?? '—'}</div>)}
        <small>{t.notes}</small><Images evidence={t.evidence || []} />
      </article>)}
      <p>預覽圖會縮小以利傳輸；正式回寫使用原始截圖。超出預覽容量時仍保留原圖路徑。</p>
    </details>
  </div>)}</>
}
