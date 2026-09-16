import { useCallback, useEffect, useRef, useState } from 'react'
import { assetKind, UAT_ASSET_KIND_LABEL, formatBytes, type UatAssetKind } from '../../../shared/uat-asset-kind'

export type UatAsset = {
  id: string; name: string; mime: string; size: number; sha256: string
  createdBy: string | null; createdAt: number
}

/**
 * 「上傳檔案」積木的素材選擇器。
 *
 * ⚠️ 素材存在 server、步驟只記 id——所以換哪一台 agent 執行都拿得到。
 *    記本機路徑的話換機器就找不到檔，那正是使用者一開始擔心的跨裝置問題。
 *
 * ⚠️ 類型（影片／圖檔／CSV…）**只拿來顯示與篩選，不拿來擋上傳**。
 *    擋了就測不了「上傳錯誤格式應該被拒絕」，而那本來就是要測的 TC。
 *    所以下面的 <input type="file"> 刻意**不寫 accept**。
 */
export function UatAssetPicker({ value, onChange }: {
  value: string
  onChange: (assetId: string) => void
}) {
  const [assets, setAssets] = useState<UatAsset[] | null>(null)
  const [maxBytes, setMaxBytes] = useState(20 * 1024 * 1024)
  const [kind, setKind] = useState<UatAssetKind | 'all'>('all')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/osm-uat/upload-assets')
      const d = await r.json()
      if (d.ok) { setAssets(d.assets || []); if (d.maxBytes) setMaxBytes(d.maxBytes) }
      else setError(d.error || '讀取素材清單失敗')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [])

  useEffect(() => { void load() }, [load])

  const upload = async (file: File) => {
    setError('')
    if (file.size > maxBytes) {
      setError(`${file.name} 是 ${formatBytes(file.size)}，超過上限 ${formatBytes(maxBytes)}`)
      return
    }
    setBusy(true)
    try {
      // ⚠️ 用 FileReader 轉 base64，不要自己 btoa(String.fromCharCode(...bytes))
      //    ——後者對大檔會因為展開成參數而爆掉（Maximum call stack size exceeded）。
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader()
        fr.onerror = () => reject(new Error('讀取檔案失敗'))
        fr.onload = () => resolve(String(fr.result).split(',')[1] ?? '')
        fr.readAsDataURL(file)
      })
      const r = await fetch('/api/osm-uat/upload-assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, mime: file.type, dataBase64 }),
      })
      const d = await r.json()
      if (!d.ok) { setError(d.error || '上傳失敗'); return }
      await load()
      onChange(d.asset.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const remove = async (a: UatAsset) => {
    // 刪除是不可逆的，而且別的步驟可能還在用——問清楚再刪
    if (!window.confirm(`刪除素材「${a.name}」？\n\n其他步驟若還在用它，執行時會直接失敗（不會靜默跳過）。`)) return
    setBusy(true)
    try {
      const r = await fetch(`/api/osm-uat/upload-assets/${encodeURIComponent(a.id)}`, { method: 'DELETE' })
      const d = await r.json()
      if (!d.ok) setError(d.error || '刪除失敗')
      else { if (value === a.id) onChange(''); await load() }
    } finally { setBusy(false) }
  }

  const shown = (assets ?? []).filter(a => kind === 'all' || assetKind(a.name, a.mime) === kind)
  const chosen = (assets ?? []).find(a => a.id === value) ?? null

  return (
    <div className="uat-asset-picker">
      <div className="uat-asset-picker-row">
        <select aria-label="素材類型篩選" value={kind} onChange={e => setKind(e.target.value as UatAssetKind | 'all')}>
          <option value="all">全部類型</option>
          {(Object.keys(UAT_ASSET_KIND_LABEL) as UatAssetKind[])
            .map(k => <option key={k} value={k}>{UAT_ASSET_KIND_LABEL[k]}</option>)}
        </select>
        <select aria-label="要上傳的素材" value={value} onChange={e => onChange(e.target.value)}>
          <option value="">— 尚未選擇 —</option>
          {shown.map(a => (
            <option key={a.id} value={a.id}>
              [{UAT_ASSET_KIND_LABEL[assetKind(a.name, a.mime)]}] {a.name}（{formatBytes(a.size)}）
            </option>
          ))}
        </select>
      </div>

      {/* ⚠️ 刻意不寫 accept：限制副檔名就測不了「上傳錯誤格式應該被拒絕」 */}
      <div className="uat-asset-picker-row">
        <input ref={fileRef} aria-label="上傳新素材" type="file" disabled={busy}
          onChange={e => { const f = e.target.files?.[0]; if (f) void upload(f) }} />
        {chosen && (
          <button type="button" className="uat-btn is-quiet" disabled={busy} onClick={() => void remove(chosen)}>
            刪除這個素材
          </button>
        )}
      </div>

      {error && <small className="uat-asset-picker-err" role="alert">{error}</small>}
      {assets && !assets.length && <small>還沒有任何素材，先用上面的欄位上傳一個。</small>}
      {value && !chosen && (
        <small className="uat-asset-picker-err" role="alert">
          這個步驟指向的素材已經不存在（可能被刪掉了），請重新選一個——執行時會直接失敗。
        </small>
      )}
      <small>素材存在伺服器，換哪一台 Agent 執行都拿得到。單檔上限 {formatBytes(maxBytes)}，不限副檔名。</small>
    </div>
  )
}
