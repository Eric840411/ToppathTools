import { createContext, useContext } from 'react'

const GameModeContext = createContext(false)

export const GameModeProvider = GameModeContext.Provider

export function useIsGameMode(): boolean {
  return useContext(GameModeContext)
}
