import { useEffect, useState } from 'react'

interface ModelOption {
  id: string
  label: string
  provider: string
}

interface Props {
  value: string
  onChange: (v: string) => void
  style?: React.CSSProperties
}

export function ModelSelector({ value, onChange, style }: Props) {
  const [models, setModels] = useState<ModelOption[]>([{ id: 'gemini', label: 'Gemini (自動輪換)', provider: 'gemini' }])

  useEffect(() => {
    fetch('/api/models/available')
      .then(r => r.json())
      .then((d: { models?: ModelOption[] }) => { if (d.models?.length) setModels(d.models) })
      .catch(() => {})
  }, [])

  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #2d3f55', fontSize: 13, color: '#e2e8f0', background: '#0f172a', ...style }}
    >
      {models.map(m => (
        <option key={m.id} value={m.id}>{m.label}</option>
      ))}
    </select>
  )
}
