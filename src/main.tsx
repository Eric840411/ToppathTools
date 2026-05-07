import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { ComponentType } from 'react'

const uiMode = (localStorage.getItem('ui-mode') ?? 'normal') as 'game' | 'normal'

async function boot() {
  const [{ UiModeToggle }, appModule] = await Promise.all([
    import('./components/UiModeToggle.tsx'),
    uiMode === 'game'
      ? import('./GameApp.tsx')
      : import('./App.tsx'),
  ])

  // Load mode CSS after the app chunk so production CSS order matches dev.
  if (uiMode === 'game') {
    await import('./game/theme/pixel.css')
  } else {
    await import('./index.css')
  }

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
