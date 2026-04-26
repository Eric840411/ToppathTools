import { useState, useCallback, useEffect } from 'react'

// ── Level thresholds (cumulative XP) ──────────────────────
export const LEVEL_XP = [0, 200, 500, 1000, 1800, 3000, 4500, 6500, 9000, 12000, 99999]
// LEVEL_XP[n] = XP required to reach level n+1

export function xpToLevel(xp: number): { level: number; current: number; needed: number; pct: number } {
  let level = 1
  for (let i = 0; i < LEVEL_XP.length - 1; i++) {
    if (xp >= LEVEL_XP[i]) level = i + 1
    else break
  }
  const floor = LEVEL_XP[level - 1]
  const ceil  = LEVEL_XP[level] ?? LEVEL_XP[LEVEL_XP.length - 1]
  const current = xp - floor
  const needed  = ceil - floor
  return { level, current, needed, pct: Math.min(100, Math.round((current / needed) * 100)) }
}

// ── XP rewards per action ─────────────────────────────────
export const XP_TABLE: Record<string, number> = {
  'jira-create':    50,
  'jira-comment':   30,
  'testcase-gen':   80,
  'machine-test':  100,
  'osm-sync':       40,
  'osm-alert':      60,
  'imagecheck':     50,
  'osm-config':     40,
  'autospin':       70,
  'jackpot-alert': 150,
  'gs-stats':       60,
  'gs-log':         40,
  'gs-pdf':         60,
  'gs-imgcompare':  50,
  'url-pool':       20,
}

// ── Achievements ──────────────────────────────────────────
export interface Achievement {
  id: string
  name: string
  desc: string
  icon: string
  bonusXp: number
  check: (stats: GameStats) => boolean
}

export interface GameStats {
  totalXp: number
  level: number
  counts: Record<string, number>  // action -> total count
}

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'first-blood',    name: 'FIRST BLOOD',   desc: '第一張 Jira 開單',       icon: '⚔',  bonusXp: 100, check: s => (s.counts['jira-create']  ?? 0) >= 1 },
  { id: 'raider',         name: 'RAIDER',         desc: '機台測試 1 次',           icon: '🤖', bonusXp: 50,  check: s => (s.counts['machine-test']  ?? 0) >= 1 },
  { id: 'raid-master',    name: 'RAID MASTER',    desc: '機台測試 10 次',          icon: '🏆', bonusXp: 200, check: s => (s.counts['machine-test']  ?? 0) >= 10 },
  { id: 'testmaster',     name: 'TEST MASTER',    desc: '生成 10 份 TestCase',     icon: '🔬', bonusXp: 200, check: s => (s.counts['testcase-gen']  ?? 0) >= 10 },
  { id: 'jackpot-witch',  name: 'JACKPOT WITCH',  desc: '觸發 Jackpot 告警',       icon: '🎰', bonusXp: 100, check: s => (s.counts['jackpot-alert'] ?? 0) >= 1 },
  { id: 'sentinel',       name: 'SENTINEL',       desc: 'AutoSpin 啟動 5 次',      icon: '👁',  bonusXp: 150, check: s => (s.counts['autospin']      ?? 0) >= 5 },
  { id: 'analyst',        name: 'ANALYST',        desc: 'GS 統計 5 次',            icon: '📊', bonusXp: 120, check: s => (s.counts['gs-stats']       ?? 0) >= 5 },
  { id: 'veteran',        name: 'VETERAN',        desc: '達到 Lv.5',               icon: '🎖', bonusXp: 500, check: s => s.level >= 5 },
  { id: 'legend',         name: 'LEGEND',         desc: '達到 Lv.10',              icon: '👑', bonusXp: 1000,check: s => s.level >= 10 },
]

// ── Daily Quests ──────────────────────────────────────────
export interface QuestDef {
  id: string
  name: string
  action: string
  target: number
  xp: number
}

const QUEST_POOL: QuestDef[] = [
  { id: 'q-jira-3',    name: '開 3 張 Jira',         action: 'jira-create',   target: 3, xp: 150 },
  { id: 'q-jira-5',    name: '開 5 張 Jira',         action: 'jira-create',   target: 5, xp: 250 },
  { id: 'q-test-2',    name: '機台測試 2 次',         action: 'machine-test',  target: 2, xp: 200 },
  { id: 'q-test-5',    name: '機台測試 5 次',         action: 'machine-test',  target: 5, xp: 400 },
  { id: 'q-tc-1',      name: '生成 1 份 TestCase',    action: 'testcase-gen',  target: 1, xp: 100 },
  { id: 'q-tc-3',      name: '生成 3 份 TestCase',    action: 'testcase-gen',  target: 3, xp: 250 },
  { id: 'q-osm-sync',  name: 'OSM 版號同步',          action: 'osm-sync',      target: 1, xp: 80 },
  { id: 'q-jackpot',   name: '監控 Jackpot',          action: 'jackpot-alert', target: 1, xp: 150 },
  { id: 'q-gs-stats',  name: '執行機率統計',           action: 'gs-stats',      target: 1, xp: 100 },
  { id: 'q-autospin',  name: '啟動 AutoSpin',         action: 'autospin',      target: 1, xp: 80 },
  { id: 'q-comment-3', name: '批次評論 3 次',          action: 'jira-comment',  target: 3, xp: 100 },
  { id: 'q-imgcheck',  name: '執行圖片驗證',           action: 'imagecheck',    target: 1, xp: 60 },
]

function seedRandom(seed: number) {
  let s = seed
  return () => { s = (s * 16807 + 0) % 2147483647; return (s - 1) / 2147483646 }
}

export function getDailyQuests(dateStr: string): QuestDef[] {
  const seed = dateStr.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  const rng = seedRandom(seed)
  const shuffled = [...QUEST_POOL].sort(() => rng() - 0.5)
  return shuffled.slice(0, 3)
}

// ── Storage ───────────────────────────────────────────────
const STORAGE_KEY = 'game-profile-v1'

interface StoredProfile {
  xp: number
  achievements: string[]
  counts: Record<string, number>
  questsDate: string
  questProgress: Record<string, number>  // questId -> progress this day
  questsClaimed: string[]                // questIds claimed today
}

function loadProfile(): StoredProfile {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {}
  return { xp: 0, achievements: [], counts: {}, questsDate: '', questProgress: {}, questsClaimed: [] }
}

function saveProfile(p: StoredProfile) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
}

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

// ── Notification types ────────────────────────────────────
export interface GameNotification {
  id: string
  type: 'xp' | 'levelup' | 'achievement' | 'quest'
  message: string
  sub?: string
  icon: string
  xp?: number
}

// ── Hook ─────────────────────────────────────────────────
export function useGameProfile() {
  const [profile, setProfile] = useState<StoredProfile>(() => {
    const p = loadProfile()
    const today = todayStr()
    if (p.questsDate !== today) {
      p.questsDate = today
      p.questProgress = {}
      p.questsClaimed = []
    }
    return p
  })
  const [notifications, setNotifications] = useState<GameNotification[]>([])

  const pushNotif = useCallback((n: Omit<GameNotification, 'id'>) => {
    const id = `${Date.now()}-${Math.random()}`
    setNotifications(prev => [...prev.slice(-4), { ...n, id }])
    setTimeout(() => setNotifications(prev => prev.filter(x => x.id !== id)), 4000)
  }, [])

  const awardXP = useCallback((action: string, overrideXp?: number) => {
    const xpAmt = overrideXp ?? (XP_TABLE[action] ?? 20)

    setProfile(prev => {
      const next: StoredProfile = {
        ...prev,
        xp: prev.xp + xpAmt,
        counts: { ...prev.counts, [action]: (prev.counts[action] ?? 0) + 1 },
        questProgress: { ...prev.questProgress },
      }

      // Check level up
      const oldInfo = xpToLevel(prev.xp)
      const newInfo = xpToLevel(next.xp)
      if (newInfo.level > oldInfo.level) {
        pushNotif({ type: 'levelup', message: `LEVEL UP!`, sub: `→ Lv.${newInfo.level}`, icon: '⬆', xp: xpAmt })
      } else {
        pushNotif({ type: 'xp', message: `+${xpAmt} XP`, sub: action.replace(/-/g, ' ').toUpperCase(), icon: '✨', xp: xpAmt })
      }

      // Check daily quest progress
      const today = todayStr()
      const quests = getDailyQuests(today)
      for (const q of quests) {
        if (q.action === action && !prev.questsClaimed.includes(q.id)) {
          const progress = (next.questProgress[q.id] ?? 0) + 1
          next.questProgress[q.id] = progress
          if (progress >= q.target) {
            next.questsClaimed = [...(next.questsClaimed ?? []), q.id]
            next.xp += q.xp
            pushNotif({ type: 'quest', message: 'QUEST COMPLETE!', sub: `${q.name} +${q.xp}XP`, icon: '🎯', xp: q.xp })
          }
        }
      }

      // Check achievements
      const stats: GameStats = { totalXp: next.xp, level: xpToLevel(next.xp).level, counts: next.counts }
      const unlocked: string[] = []
      for (const ach of ACHIEVEMENTS) {
        if (!prev.achievements.includes(ach.id) && ach.check(stats)) {
          unlocked.push(ach.id)
          next.xp += ach.bonusXp
          pushNotif({ type: 'achievement', message: ach.name, sub: `${ach.desc} +${ach.bonusXp}XP`, icon: ach.icon, xp: ach.bonusXp })
        }
      }
      if (unlocked.length) next.achievements = [...prev.achievements, ...unlocked]

      saveProfile(next)
      return next
    })
  }, [pushNotif])

  const dismissNotif = useCallback((id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id))
  }, [])

  const levelInfo = xpToLevel(profile.xp)
  const todayQuests = getDailyQuests(todayStr())

  return { profile, levelInfo, todayQuests, awardXP, notifications, dismissNotif }
}
