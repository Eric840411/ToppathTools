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
      className={`ui-mode-toggle ui-mode-toggle--${mode}`}
    >
      {mode === 'game' ? '樞' : '境'}
    </button>
  )
}
