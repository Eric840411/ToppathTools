import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

export default function Portal({ children }: { children: React.ReactNode }) {
  const el = useRef(document.createElement('div'))

  useEffect(() => {
    document.body.appendChild(el.current)
    return () => { document.body.removeChild(el.current) }
  }, [])

  return createPortal(children, el.current)
}
