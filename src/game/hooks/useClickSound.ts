import { useEffect } from 'react'

const SFX_URL = '/game-assets/sfx/soft_click_01_moss_stone.wav'

// Pre-load audio pool (3 instances for rapid clicks)
const POOL_SIZE = 3
let pool: HTMLAudioElement[] | null = null

function getPool(): HTMLAudioElement[] {
  if (!pool) {
    pool = Array.from({ length: POOL_SIZE }, () => {
      const a = new Audio(SFX_URL)
      a.volume = 0.35
      return a
    })
  }
  return pool
}

let poolIndex = 0

function playClick() {
  const p = getPool()
  const audio = p[poolIndex % POOL_SIZE]
  poolIndex++
  audio.currentTime = 0
  audio.play().catch(() => {})
}

export function useClickSound() {
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      // Only fire on real clicks (left button), not programmatic
      if (e.isTrusted) playClick()
    }
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [])
}
