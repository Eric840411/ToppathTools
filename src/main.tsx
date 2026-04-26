import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { ComponentType } from 'react'

const uiMode = (localStorage.getItem('ui-mode') ?? 'normal') as 'game' | 'normal'

async function boot() {
  // Load CSS and app module separately based on mode
  // This prevents game's pixel.css global resets from leaking into normal mode
  const [, { UiModeToggle }, appModule] = await Promise.all([
    uiMode === 'game'
      ? import('./game/theme/pixel.css')
      : import('./index.css'),
    import('./components/UiModeToggle.tsx'),
    uiMode === 'game'
      ? import('./GameApp.tsx')
      : import('./App.tsx'),
  ])

  const Root: ComponentType =
    uiMode === 'game'
      ? (appModule as { GameApp: ComponentType }).GameApp
      : (appModule as { default: ComponentType }).default

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Root />
      <UiModeToggle mode={uiMode} />
    </StrictMode>,
  )
}

boot()
