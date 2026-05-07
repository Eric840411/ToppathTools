import { createContext, useContext, useEffect, type ReactNode } from 'react'
import {
  useGameProfile,
  type GameNotification,
  type QuestDef,
  type CharacterClass,
  type ClassDef,
  type StatKey,
  type ActiveSkillEffect,
} from '../hooks/useGameProfile'

interface GameProfileCtx {
  xp: number
  level: number
  xpPct: number
  xpCurrent: number
  xpNeeded: number
  achievements: string[]
  counts: Record<string, number>
  todayQuests: QuestDef[]
  questProgress: Record<string, number>
  questsClaimed: string[]
  notifications: GameNotification[]
  // Class system
  classId: CharacterClass | null
  classDef: ClassDef | null
  stats: Record<StatKey, number>
  statPoints: number
  skillCooldowns: Record<string, number>
  activeEffects: ActiveSkillEffect[]
  // Actions
  awardXP: (action: string, overrideXp?: number) => void
  dismissNotif: (id: string) => void
  selectClass: (classId: CharacterClass) => void
  activateSkill: (skillId: string) => boolean
  allocateStat: (stat: StatKey) => void
}

const Ctx = createContext<GameProfileCtx | null>(null)

export function GameProfileProvider({ children }: { children: ReactNode }) {
  const {
    profile, levelInfo, todayQuests,
    awardXP, notifications, dismissNotif,
    selectClass, activateSkill, allocateStat, classDef,
  } = useGameProfile()

  // ── Fetch interceptor — award XP on successful API calls ──
  useEffect(() => {
    const orig = window.fetch.bind(window)
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const res = await orig(...args)
      if (res.ok) {
        const url = (typeof args[0] === 'string' ? args[0] : (args[0] as Request).url) ?? ''
        // Map API endpoints → game actions
        if      (/\/api\/jira\/.*(create|batch)/.test(url))    awardXP('jira-create')
        else if (/\/api\/jira\/.*comment/.test(url))            awardXP('jira-comment')
        else if (/\/api\/(integrations\/generate|lark.*testcase|gs\/pdf)/.test(url)) awardXP('testcase-gen')
        else if (/\/api\/machine-test\/start/.test(url))        awardXP('machine-test')
        else if (/\/api\/osm\/(sync|push|pull)/.test(url))      awardXP('osm-sync')
        else if (/\/api\/osm\/alert/.test(url))                 awardXP('osm-alert')
        else if (/\/api\/image-check\/start/.test(url))         awardXP('imagecheck')
        else if (/\/api\/osm\/config-compare/.test(url))        awardXP('osm-config')
        else if (/\/api\/autospin\/start/.test(url))            awardXP('autospin')
        else if (/\/api\/osm\/jackpot/.test(url))               awardXP('jackpot-alert')
        else if (/\/api\/gs\/stats/.test(url))                  awardXP('gs-stats')
        else if (/\/api\/gs\/log/.test(url))                    awardXP('gs-log')
        else if (/\/api\/gs\/img-compare/.test(url))            awardXP('gs-imgcompare')
        else if (/\/api\/url-pool\/claim/.test(url))            awardXP('url-pool')
      }
      return res
    }
    return () => { window.fetch = orig }
  }, [awardXP])

  return (
    <Ctx.Provider value={{
      xp: profile.xp,
      level: levelInfo.level,
      xpPct: levelInfo.pct,
      xpCurrent: levelInfo.current,
      xpNeeded: levelInfo.needed,
      achievements: profile.achievements,
      counts: profile.counts,
      todayQuests,
      questProgress: profile.questProgress,
      questsClaimed: profile.questsClaimed ?? [],
      notifications,
      classId: profile.classId,
      classDef,
      stats: profile.stats,
      statPoints: profile.statPoints,
      skillCooldowns: profile.skillCooldowns,
      activeEffects: profile.activeEffects,
      awardXP,
      dismissNotif,
      selectClass,
      activateSkill,
      allocateStat,
    }}>
      {children}
    </Ctx.Provider>
  )
}

export function useGameProfileCtx() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useGameProfileCtx must be used inside GameProfileProvider')
  return ctx
}
