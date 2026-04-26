/**
 * Floating button that switches between 'game' and 'normal' UI mode.
 * Persists choice to localStorage under key 'ui-mode'.
 */
export function UiModeToggle({ mode }: { mode: 'game' | 'normal' }) {
  const toggle = () => {
    localStorage.setItem('ui-mode', mode === 'game' ? 'normal' : 'game')
    window.location.reload()
  }

  return (
    <button
      type="button"
      onClick={toggle}
      title={mode === 'game' ? '切換為一般模式' : '切換為遊戲模式'}
      style={{
        position: 'fixed',
        bottom: 20,
        right: 20,
        zIndex: 99999,
        width: 44,
        height: 44,
        borderRadius: mode === 'game' ? 2 : '50%',
        border: mode === 'game' ? '2px solid #00d4ff' : '2px solid #555',
        background: mode === 'game' ? '#00d4ff18' : '#1a1a2e',
        boxShadow: mode === 'game' ? '0 0 8px #00d4ff88' : '0 2px 8px rgba(0,0,0,0.4)',
        cursor: 'pointer',
        fontSize: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {mode === 'game' ? '🖥' : '🎮'}
    </button>
  )
}
