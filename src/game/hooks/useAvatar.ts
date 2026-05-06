import { useState, useEffect } from 'react'

const STORAGE_KEY = 'toppath.avatar'

export const AVATAR_OPTIONS = [
  { id: 'avatar-01-male-commander-light',    src: '/game-assets/icons/avatar-presets/avatar-01-male-commander-light.png',    label: 'Commander', gender: 'male' },
  { id: 'avatar-02-female-commander-light',  src: '/game-assets/icons/avatar-presets/avatar-02-female-commander-light.png',  label: 'Commander', gender: 'female' },
  { id: 'avatar-03-male-hacker-dark',        src: '/game-assets/icons/avatar-presets/avatar-03-male-hacker-dark.png',        label: 'Hacker',    gender: 'male' },
  { id: 'avatar-04-female-hacker-dark',      src: '/game-assets/icons/avatar-presets/avatar-04-female-hacker-dark.png',      label: 'Hacker',    gender: 'female' },
  { id: 'avatar-05-male-medic-medium',       src: '/game-assets/icons/avatar-presets/avatar-05-male-medic-medium.png',       label: 'Medic',     gender: 'male' },
  { id: 'avatar-06-female-medic-mediumdark', src: '/game-assets/icons/avatar-presets/avatar-06-female-medic-mediumdark.png', label: 'Medic',     gender: 'female' },
  { id: 'avatar-07-male-pilot-tan',          src: '/game-assets/icons/avatar-presets/avatar-07-male-pilot-tan.png',          label: 'Pilot',     gender: 'male' },
  { id: 'avatar-08-female-pilot-light',      src: '/game-assets/icons/avatar-presets/avatar-08-female-pilot-light.png',      label: 'Pilot',     gender: 'female' },
  { id: 'avatar-09-male-mechanic-dark',      src: '/game-assets/icons/avatar-presets/avatar-09-male-mechanic-dark.png',      label: 'Mechanic',  gender: 'male' },
  { id: 'avatar-10-female-mechanic-medium',  src: '/game-assets/icons/avatar-presets/avatar-10-female-mechanic-medium.png',  label: 'Mechanic',  gender: 'female' },
  { id: 'avatar-11-male-analyst-light',      src: '/game-assets/icons/avatar-presets/avatar-11-male-analyst-light.png',      label: 'Analyst',   gender: 'male' },
  { id: 'avatar-12-female-analyst-dark',     src: '/game-assets/icons/avatar-presets/avatar-12-female-analyst-dark.png',     label: 'Analyst',   gender: 'female' },
  { id: 'avatar-13-male-scout-tan',          src: '/game-assets/icons/avatar-presets/avatar-13-male-scout-tan.png',          label: 'Scout',     gender: 'male' },
  { id: 'avatar-14-female-scout-medium',     src: '/game-assets/icons/avatar-presets/avatar-14-female-scout-medium.png',     label: 'Scout',     gender: 'female' },
  { id: 'avatar-15-male-security-dark',      src: '/game-assets/icons/avatar-presets/avatar-15-male-security-dark.png',      label: 'Security',  gender: 'male' },
  { id: 'avatar-16-female-security-light',   src: '/game-assets/icons/avatar-presets/avatar-16-female-security-light.png',   label: 'Security',  gender: 'female' },
  { id: 'avatar-17-male-comms-medium',       src: '/game-assets/icons/avatar-presets/avatar-17-male-comms-medium.png',       label: 'Comms',     gender: 'male' },
  { id: 'avatar-18-female-comms-dark',       src: '/game-assets/icons/avatar-presets/avatar-18-female-comms-dark.png',       label: 'Comms',     gender: 'female' },
  { id: 'avatar-19-male-researcher-light',   src: '/game-assets/icons/avatar-presets/avatar-19-male-researcher-light.png',   label: 'Researcher',gender: 'male' },
  { id: 'avatar-20-female-researcher-medium',src: '/game-assets/icons/avatar-presets/avatar-20-female-researcher-medium.png',label: 'Researcher',gender: 'female' },
] as const

export type AvatarId = typeof AVATAR_OPTIONS[number]['id']

const DEFAULT_ID: AvatarId = 'avatar-01-male-commander-light'

// Legacy commander-vN values from before v3.9.46
const LEGACY_IDS = new Set(['commander', 'commander-v2', 'commander-v3', 'commander-v4', 'commander-v5', 'commander-v6'])

function readStoredId(): AvatarId {
  try {
    const stored = typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
    if (!stored) return DEFAULT_ID
    // Legacy migration
    if (LEGACY_IDS.has(stored)) return DEFAULT_ID
    return (AVATAR_OPTIONS.find(a => a.id === stored)?.id) ?? DEFAULT_ID
  } catch {
    return DEFAULT_ID
  }
}

export function useAvatar() {
  const [avatarId, setAvatarIdState] = useState<AvatarId>(readStoredId)

  const setAvatarId = (id: AvatarId) => {
    try { localStorage.setItem(STORAGE_KEY, id) } catch {}
    // Notify all useAvatar instances in the same tab
    window.dispatchEvent(new CustomEvent('toppath:avatar-changed', { detail: id }))
  }

  // Same-tab sync (custom event) + cross-tab sync (storage event)
  useEffect(() => {
    const onCustom = (e: CustomEvent<string>) => {
      const matched = AVATAR_OPTIONS.find(a => a.id === e.detail)
      setAvatarIdState(matched ? matched.id : DEFAULT_ID)
    }
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setAvatarIdState(readStoredId())
    }
    window.addEventListener('toppath:avatar-changed', onCustom as EventListener)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('toppath:avatar-changed', onCustom as EventListener)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const avatarSrc = AVATAR_OPTIONS.find(a => a.id === avatarId)?.src
    ?? AVATAR_OPTIONS[0].src

  return { avatarId, avatarSrc, setAvatarId }
}
