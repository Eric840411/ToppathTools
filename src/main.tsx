import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { GameApp } from './GameApp.tsx'
import { UiModeToggle } from './components/UiModeToggle.tsx'

const uiMode = (localStorage.getItem('ui-mode') ?? 'normal') as 'game' | 'normal'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {uiMode === 'game' ? <GameApp /> : <App />}
    <UiModeToggle mode={uiMode} />
  </StrictMode>,
)
