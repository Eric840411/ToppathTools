import { useEffect, useRef, useState } from 'react'

interface Option {
  value: string
  label: string
  sublabel?: string
}

interface SearchSelectProps {
  options: Option[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  loading?: boolean
}

export function SearchSelect({ options, value, onChange, placeholder = '— 選擇 —', disabled, loading }: SearchSelectProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const selected = options.find(o => o.value === value)

  const filtered = query
    ? options.filter(o =>
        o.label.toLowerCase().includes(query.toLowerCase()) ||
        (o.sublabel?.toLowerCase().includes(query.toLowerCase()))
      )
    : options

  useEffect(() => {
    if (open) {
      setQuery('')
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleSelect = (val: string) => {
    onChange(val)
    setOpen(false)
    setQuery('')
  }

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%' }}>
      <button
        type="button"
        disabled={disabled || loading}
        onClick={() => !disabled && !loading && setOpen(v => !v)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '8px 12px',
          borderRadius: 8,
          border: `1.5px solid ${open ? '#6366f1' : '#d1d5db'}`,
          background: disabled ? '#f9fafb' : '#fff',
          cursor: disabled || loading ? 'not-allowed' : 'pointer',
          fontSize: 14,
          color: selected ? '#111827' : '#9ca3af',
          fontWeight: selected ? 500 : 400,
          transition: 'border-color 0.15s, box-shadow 0.15s',
          boxShadow: open ? '0 0 0 3px rgba(99,102,241,0.15)' : 'none',
          textAlign: 'left',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {loading ? '載入中...' : (selected ? selected.label : placeholder)}
        </span>
        <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"
          style={{ flexShrink: 0, color: '#9ca3af', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
        </svg>
      </button>

      {open && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 4px)',
          left: 0,
          right: 0,
          zIndex: 200,
          background: '#fff',
          border: '1.5px solid #e5e7eb',
          borderRadius: 10,
          boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
          overflow: 'hidden',
        }}>
          {options.length > 6 && (
            <div style={{ padding: '8px 10px', borderBottom: '1px solid #f3f4f6' }}>
              <input
                ref={inputRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="搜尋..."
                style={{
                  width: '100%',
                  border: '1px solid #e5e7eb',
                  borderRadius: 6,
                  padding: '5px 10px',
                  fontSize: 13,
                  outline: 'none',
                  background: '#f9fafb',
                  boxSizing: 'border-box',
                }}
              />
            </div>
          )}
          <div style={{ maxHeight: 220, overflowY: 'auto' }}>
            {filtered.length === 0 && (
              <div style={{ padding: '10px 14px', fontSize: 13, color: '#9ca3af' }}>無結果</div>
            )}
            {filtered.map(o => (
              <button
                key={o.value}
                type="button"
                onClick={() => handleSelect(o.value)}
                style={{
                  display: 'block',
                  width: '100%',
                  padding: '9px 14px',
                  textAlign: 'left',
                  background: o.value === value ? '#f5f3ff' : 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 13,
                  color: o.value === value ? '#4f46e5' : '#111827',
                  fontWeight: o.value === value ? 600 : 400,
                  borderLeft: o.value === value ? '3px solid #6366f1' : '3px solid transparent',
                }}
                onMouseEnter={e => { if (o.value !== value) (e.currentTarget as HTMLButtonElement).style.background = '#f9fafb' }}
                onMouseLeave={e => { if (o.value !== value) (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
