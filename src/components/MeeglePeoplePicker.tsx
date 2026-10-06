import { useState } from 'react'

/**
 * Meegle 批量工具共用的人員欄：下拉（datalist，打字即搜尋）選人，可以選多個人。
 * 開單的「批量設定」（使用者 2026-10-05：QA 驗證要複選）與修改的「固定值」（使用者 2026-10-06：要下拉＋搜尋）共用這一個。
 * 值仍是逗號分隔的字串，跟原本的套用邏輯（split 逗號）同一個格式——資料層本來就支援多人。
 * 選到名單裡的名字、按 Enter 或打逗號就加成一個標籤；× 移除。名單不在這裡給：呼叫端放一個 <datalist id={listId}>。
 * 樣式在 MeegleBatchCreateTab.css（.mb-picker*），用到的頁面都已經載入它。
 */
export function MeeglePeoplePicker({ value, onChange, listId, label, emptyText = '— 不改 —' }: {
  value: string; onChange: (v: string) => void; listId: string; label: string; emptyText?: string
}) {
  const names = value.split(/[,，、]/).map(s => s.trim()).filter(Boolean)
  const [draft, setDraft] = useState('')
  const add = (raw: string) => {
    const more = raw.split(/[,，、]/).map(s => s.trim()).filter(Boolean)
    if (!more.length) return
    const next = [...names]
    for (const n of more) if (!next.some(x => x.toLowerCase() === n.toLowerCase())) next.push(n)
    onChange(next.join(', '))
    setDraft('')
  }
  return (
    <div className="mb-picker">
      {names.map(n => (
        <span key={n} className="mb-picker-chip">{n}<button type="button" aria-label={`移除 ${n}`} onClick={() => onChange(names.filter(x => x !== n).join(', '))}>×</button></span>
      ))}
      <input className="mb-picker-input" list={listId} aria-label={label} placeholder={names.length ? '＋加人' : emptyText} value={draft}
        onChange={e => {
          const v = e.target.value
          // 從下拉選到名單裡的人 → 直接加成標籤（不用再按 Enter）。
          // ⚠️ 名單要在這裡才去抓：render 當下抓的話，第一次 render 時 datalist 還沒掛上去（排在欄位後面），會一直是 null
          const options = document.getElementById(listId) as HTMLDataListElement | null
          if (options && [...options.options].some(o => o.value === v)) { add(v); return }
          if (/[,，、]$/.test(v)) { add(v); return }
          setDraft(v)
        }}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); add(draft) }
          if (e.key === 'Backspace' && !draft && names.length) onChange(names.slice(0, -1).join(', '))
        }}
        onBlur={() => add(draft)} />
    </div>
  )
}
