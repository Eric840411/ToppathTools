import { useState, useCallback } from 'react'

// ── Level thresholds (cumulative XP) ──────────────────────
export const LEVEL_XP = [0, 200, 500, 1000, 1800, 3000, 4500, 6500, 9000, 12000, 99999]

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

// ── Character Class System ────────────────────────────────
export type CharacterClass = 'commander' | 'hacker' | 'guardian' | 'ranger' | 'sage'
export type StatKey = 'atk' | 'def' | 'int' | 'spd'

export const STAT_LABELS: Record<StatKey, string> = { atk: 'ATK', def: 'DEF', int: 'INT', spd: 'SPD' }
export const STAT_COLORS: Record<StatKey, string> = { atk: '#ef4444', def: '#4A90D9', int: '#9F7AEA', spd: '#FFD700' }
export const STAT_ICONS: Record<StatKey, string>  = { atk: '⚔', def: '🛡', int: '🧠', spd: '⚡' }

export interface SkillEffect {
  type: 'xp-mult' | 'instant-xp' | 'cd-reduce'
  value: number
  durationMs?: number
  action?: string  // if set, only boosts this specific action
}

export interface ClassSkillDef {
  id: string
  classId: CharacterClass
  name: string
  nameZh: string
  desc: string
  icon: string
  cooldownMs: number
  unlockLevel: number
  effect: SkillEffect
}

export interface ActiveSkillEffect {
  skillId: string
  type: 'xp-mult' | 'instant-xp' | 'cd-reduce'
  value: number
  expiresAt: number
  action?: string
}

export interface ClassDef {
  id: CharacterClass
  name: string
  nameZh: string
  color: string
  desc: string
  primaryActions: string[]
  xpBonus: number
  baseStats: Record<StatKey, number>
  skills: ClassSkillDef[]
  quotes: { idle: string[]; celebrate: string[]; levelup: string[] }
}

export const CHARACTER_CLASSES: Record<CharacterClass, ClassDef> = {
  commander: {
    id: 'commander', name: 'COMMANDER', nameZh: '指揮官',
    color: '#FFD700',
    desc: '全能指揮，Jira 批量與機台協調專家',
    primaryActions: ['jira-create', 'machine-test'],
    xpBonus: 1.5,
    baseStats: { atk: 2, def: 1, int: 1, spd: 0 },
    quotes: {
      idle: ['準備好了，指揮官！', '今天的測試交給我！', '衝啊！', '機台再多也不怕。'],
      celebrate: ['任務完成！', '勝利！', '再來一個！'],
      levelup: ['我變強了！', '升級！力量暴增！'],
    },
    skills: [
      { id: 'cmd-rally',  classId: 'commander', name: 'Rally',     nameZh: '批量攻勢', desc: '5 分鐘內所有 XP ×2',        icon: '⚔',  cooldownMs: 4*60*60*1000,  unlockLevel: 2, effect: { type: 'xp-mult',    value: 2,   durationMs: 5*60*1000 } },
      { id: 'cmd-order',  classId: 'commander', name: 'Order',     nameZh: '號令群雄', desc: '立即獲得 +150 XP',          icon: '📣',  cooldownMs: 24*60*60*1000, unlockLevel: 4, effect: { type: 'instant-xp', value: 150 } },
      { id: 'cmd-will',   classId: 'commander', name: 'Iron Will', nameZh: '鐵血意志', desc: '所有技能 CD 縮短 30%',      icon: '🔥',  cooldownMs: 12*60*60*1000, unlockLevel: 6, effect: { type: 'cd-reduce',  value: 0.3 } },
    ],
  },
  hacker: {
    id: 'hacker', name: 'HACKER', nameZh: '駭客',
    color: '#00FF41',
    desc: '高智力，AI TestCase 生成與 Config 分析專家',
    primaryActions: ['testcase-gen', 'osm-config'],
    xpBonus: 1.8,
    baseStats: { atk: 0, def: 0, int: 4, spd: 0 },
    quotes: {
      idle: ['魔法分析，開始！', '資料已讀取完畢。', '讓我看看有什麼異常...', '所有日誌盡在掌握。'],
      celebrate: ['完美執行！', '程式碼破譯完成！', '✨ 成功！'],
      levelup: ['智力提升！', '升級！系統已入侵！'],
    },
    skills: [
      { id: 'hck-decode',  classId: 'hacker', name: 'Decode',    nameZh: '代碼破譯', desc: '2 分鐘內所有 XP ×2.5',            icon: '💻', cooldownMs: 6*60*60*1000,  unlockLevel: 2, effect: { type: 'xp-mult',    value: 2.5, durationMs: 2*60*1000 } },
      { id: 'hck-inject',  classId: 'hacker', name: 'AI Inject', nameZh: 'AI 注入',  desc: '立即獲得 +200 XP',                icon: '🤖', cooldownMs: 24*60*60*1000, unlockLevel: 4, effect: { type: 'instant-xp', value: 200 } },
      { id: 'hck-zero',    classId: 'hacker', name: 'Zero Day',  nameZh: '零日攻擊', desc: '1 分鐘 testcase XP ×4',           icon: '⚡', cooldownMs: 12*60*60*1000, unlockLevel: 6, effect: { type: 'xp-mult',    value: 4,   durationMs: 60*1000, action: 'testcase-gen' } },
    ],
  },
  guardian: {
    id: 'guardian', name: 'GUARDIAN', nameZh: '守護者',
    color: '#4A90D9',
    desc: '高防禦，AutoSpin 與 Jackpot 監控專家',
    primaryActions: ['autospin', 'jackpot-alert'],
    xpBonus: 1.5,
    baseStats: { atk: 0, def: 4, int: 0, spd: 0 },
    quotes: {
      idle: ['監控中，萬無一失。', '任何異常逃不過我。', '鐵壁防禦，穩如磐石。'],
      celebrate: ['防線穩固！', '任務達成！', '🛡 完美守護！'],
      levelup: ['防禦強化！', '升級！護甲更堅！'],
    },
    skills: [
      { id: 'grd-shield', classId: 'guardian', name: 'Shield',    nameZh: '持久監控', desc: '1h autospin XP ×3',             icon: '🛡', cooldownMs: 24*60*60*1000, unlockLevel: 2, effect: { type: 'xp-mult',    value: 3,   durationMs: 60*60*1000, action: 'autospin' } },
      { id: 'grd-sense',  classId: 'guardian', name: 'Sense',     nameZh: '金庫感應', desc: '立即獲得 +100 XP',               icon: '👁',  cooldownMs: 8*60*60*1000,  unlockLevel: 4, effect: { type: 'instant-xp', value: 100 } },
      { id: 'grd-wall',   classId: 'guardian', name: 'Iron Wall', nameZh: '鐵壁',     desc: '30 分鐘所有 XP ×1.5',           icon: '🏰', cooldownMs: 12*60*60*1000, unlockLevel: 6, effect: { type: 'xp-mult',    value: 1.5, durationMs: 30*60*1000 } },
    ],
  },
  ranger: {
    id: 'ranger', name: 'RANGER', nameZh: '遊俠',
    color: '#10B981',
    desc: '高速，Machine Test 快速掃盪與圖片驗證專家',
    primaryActions: ['machine-test', 'imagecheck'],
    xpBonus: 1.5,
    baseStats: { atk: 2, def: 1, int: 0, spd: 1 },
    quotes: {
      idle: ['目標鎖定！', '快速突擊，敵人消失！', '圖片也逃不過我的眼。', '掃盪開始！'],
      celebrate: ['搞定！', '精準命中！', '🏹 完美射擊！'],
      levelup: ['速度提升！', '升級！移動更快！'],
    },
    skills: [
      { id: 'rgr-chain', classId: 'ranger', name: 'Chain Test', nameZh: '連環測試', desc: '10 分鐘 machine-test XP ×3',     icon: '🏹', cooldownMs: 8*60*60*1000,  unlockLevel: 2, effect: { type: 'xp-mult',    value: 3,   durationMs: 10*60*1000, action: 'machine-test' } },
      { id: 'rgr-hunt',  classId: 'ranger', name: 'Hunt',       nameZh: '圖片獵影', desc: '立即獲得 +100 XP',              icon: '🖼',  cooldownMs: 12*60*60*1000, unlockLevel: 4, effect: { type: 'instant-xp', value: 100 } },
      { id: 'rgr-dash',  classId: 'ranger', name: 'Dash',       nameZh: '疾風步',   desc: '所有技能 CD 縮短 50%',           icon: '💨', cooldownMs: 24*60*60*1000, unlockLevel: 6, effect: { type: 'cd-reduce',  value: 0.5 } },
    ],
  },
  sage: {
    id: 'sage', name: 'SAGE', nameZh: '賢者',
    color: '#9F7AEA',
    desc: '高智力，GS 統計與 Log 分析的數據預言家',
    primaryActions: ['gs-stats', 'gs-log'],
    xpBonus: 1.8,
    baseStats: { atk: 0, def: 1, int: 3, spd: 0 },
    quotes: {
      idle: ['數據不會說謊。', '機率已在掌控之中。', '宇宙的規律，盡在我心。'],
      celebrate: ['洞察完成！', '一切如預測！', '✨ 賢者之眼！'],
      levelup: ['智慧增長！', '升級！預言更準！'],
    },
    skills: [
      { id: 'sge-insight', classId: 'sage', name: 'Insight',     nameZh: '機率洞察', desc: '15 分鐘 gs-stats XP ×3',         icon: '🔮', cooldownMs: 8*60*60*1000,  unlockLevel: 2, effect: { type: 'xp-mult',    value: 3,   durationMs: 15*60*1000, action: 'gs-stats' } },
      { id: 'sge-wisdom',  classId: 'sage', name: 'Wisdom',      nameZh: '古老智慧', desc: '立即獲得 +150 XP',               icon: '📚', cooldownMs: 24*60*60*1000, unlockLevel: 4, effect: { type: 'instant-xp', value: 150 } },
      { id: 'sge-eye',     classId: 'sage', name: 'All-Seeing',  nameZh: '全知之眼', desc: '15 分鐘所有 XP ×1.5',            icon: '✨', cooldownMs: 12*60*60*1000, unlockLevel: 6, effect: { type: 'xp-mult',    value: 1.5, durationMs: 15*60*1000 } },
    ],
  },
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
  counts: Record<string, number>
}

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'first-blood',    name: 'FIRST BLOOD',   desc: '第一張 Jira 開單',       icon: '⚔',  bonusXp: 100,  check: s => (s.counts['jira-create']  ?? 0) >= 1 },
  { id: 'raider',         name: 'RAIDER',         desc: '機台測試 1 次',           icon: '🤖', bonusXp: 50,   check: s => (s.counts['machine-test']  ?? 0) >= 1 },
  { id: 'raid-master',    name: 'RAID MASTER',    desc: '機台測試 10 次',          icon: '🏆', bonusXp: 200,  check: s => (s.counts['machine-test']  ?? 0) >= 10 },
  { id: 'testmaster',     name: 'TEST MASTER',    desc: '生成 10 份 TestCase',     icon: '🔬', bonusXp: 200,  check: s => (s.counts['testcase-gen']  ?? 0) >= 10 },
  { id: 'jackpot-witch',  name: 'JACKPOT WITCH',  desc: '觸發 Jackpot 告警',       icon: '🎰', bonusXp: 100,  check: s => (s.counts['jackpot-alert'] ?? 0) >= 1 },
  { id: 'sentinel',       name: 'SENTINEL',       desc: 'AutoSpin 啟動 5 次',      icon: '👁',  bonusXp: 150,  check: s => (s.counts['autospin']      ?? 0) >= 5 },
  { id: 'analyst',        name: 'ANALYST',        desc: 'GS 統計 5 次',            icon: '📊', bonusXp: 120,  check: s => (s.counts['gs-stats']       ?? 0) >= 5 },
  { id: 'veteran',        name: 'VETERAN',        desc: '達到 Lv.5',               icon: '🎖', bonusXp: 500,  check: s => s.level >= 5 },
  { id: 'legend',         name: 'LEGEND',         desc: '達到 Lv.10',              icon: '👑', bonusXp: 1000, check: s => s.level >= 10 },
  { id: 'class-chosen',   name: 'AWAKENED',       desc: '選擇職業',                icon: '⭐', bonusXp: 100,  check: () => false },  // manually awarded in selectClass()
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
  { id: 'q-jira-3',    name: '開 3 張 Jira',        action: 'jira-create',   target: 3, xp: 150 },
  { id: 'q-jira-5',    name: '開 5 張 Jira',        action: 'jira-create',   target: 5, xp: 250 },
  { id: 'q-test-2',    name: '機台測試 2 次',        action: 'machine-test',  target: 2, xp: 200 },
  { id: 'q-test-5',    name: '機台測試 5 次',        action: 'machine-test',  target: 5, xp: 400 },
  { id: 'q-tc-1',      name: '生成 1 份 TestCase',   action: 'testcase-gen',  target: 1, xp: 100 },
  { id: 'q-tc-3',      name: '生成 3 份 TestCase',   action: 'testcase-gen',  target: 3, xp: 250 },
  { id: 'q-osm-sync',  name: 'OSM 版號同步',         action: 'osm-sync',      target: 1, xp: 80  },
  { id: 'q-jackpot',   name: '監控 Jackpot',         action: 'jackpot-alert', target: 1, xp: 150 },
  { id: 'q-gs-stats',  name: '執行機率統計',          action: 'gs-stats',      target: 1, xp: 100 },
  { id: 'q-autospin',  name: '啟動 AutoSpin',        action: 'autospin',      target: 1, xp: 80  },
  { id: 'q-comment-3', name: '批次評論 3 次',         action: 'jira-comment',  target: 3, xp: 100 },
  { id: 'q-imgcheck',  name: '執行圖片驗證',          action: 'imagecheck',    target: 1, xp: 60  },
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
  questProgress: Record<string, number>
  questsClaimed: string[]
  // Class system (new — all nullable/defaulted for backward compat)
  classId: CharacterClass | null
  stats: Record<StatKey, number>
  statPoints: number
  skillCooldowns: Record<string, number>  // skillId → readyAt timestamp (ms)
  activeEffects: ActiveSkillEffect[]
}

function loadProfile(): StoredProfile {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      return {
        xp:            parsed.xp            ?? 0,
        achievements:  parsed.achievements  ?? [],
        counts:        parsed.counts        ?? {},
        questsDate:    parsed.questsDate    ?? '',
        questProgress: parsed.questProgress ?? {},
        questsClaimed: parsed.questsClaimed ?? [],
        classId:       parsed.classId       ?? null,
        stats:         parsed.stats         ?? { atk: 0, def: 0, int: 0, spd: 0 },
        statPoints:    parsed.statPoints    ?? 0,
        skillCooldowns: parsed.skillCooldowns ?? {},
        activeEffects: (parsed.activeEffects ?? []).filter((e: ActiveSkillEffect) => e.expiresAt > Date.now()),
      }
    }
  } catch {}
  return { xp: 0, achievements: [], counts: {}, questsDate: '', questProgress: {}, questsClaimed: [], classId: null, stats: { atk: 0, def: 0, int: 0, spd: 0 }, statPoints: 0, skillCooldowns: {}, activeEffects: [] }
}

function saveProfile(p: StoredProfile) {
  // Prune expired effects before saving
  const now = Date.now()
  const clean = { ...p, activeEffects: p.activeEffects.filter(e => e.expiresAt > now) }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(clean))
}

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

// ── Notification types ────────────────────────────────────
export interface GameNotification {
  id: string
  type: 'xp' | 'levelup' | 'achievement' | 'quest' | 'skill'
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
    // Ensure new fields exist on old saves
    if (!p.stats) p.stats = { atk: 0, def: 0, int: 0, spd: 0 }
    if (p.statPoints === undefined) p.statPoints = 0
    if (!p.skillCooldowns) p.skillCooldowns = {}
    if (!p.activeEffects) p.activeEffects = []
    return p
  })
  const [notifications, setNotifications] = useState<GameNotification[]>([])

  const pushNotif = useCallback((n: Omit<GameNotification, 'id'>) => {
    const id = `${Date.now()}-${Math.random()}`
    setNotifications(prev => [...prev.slice(-4), { ...n, id }])
    setTimeout(() => setNotifications(prev => prev.filter(x => x.id !== id)), 4000)
  }, [])

  const awardXP = useCallback((action: string, overrideXp?: number) => {
    setProfile(prev => {
      const now = Date.now()
      const classDef = prev.classId ? CHARACTER_CLASSES[prev.classId] : null

      // Base XP
      let xpAmt = overrideXp ?? (XP_TABLE[action] ?? 20)

      // Class primary action bonus
      if (classDef && classDef.primaryActions.includes(action)) {
        xpAmt = Math.round(xpAmt * classDef.xpBonus)
      }

      // Active effect multipliers (prune expired first)
      const activeEffects = prev.activeEffects.filter(e => e.expiresAt > now)
      for (const e of activeEffects) {
        if (e.type === 'xp-mult' && (!e.action || e.action === action)) {
          xpAmt = Math.round(xpAmt * e.value)
        }
      }

      const next: StoredProfile = {
        ...prev,
        xp: prev.xp + xpAmt,
        counts: { ...prev.counts, [action]: (prev.counts[action] ?? 0) + 1 },
        questProgress: { ...prev.questProgress },
        activeEffects,
      }

      // Level up check — award stat point(s)
      const oldInfo = xpToLevel(prev.xp)
      const newInfo = xpToLevel(next.xp)
      if (newInfo.level > oldInfo.level) {
        const levelsGained = newInfo.level - oldInfo.level
        next.statPoints = (prev.statPoints ?? 0) + levelsGained * 3
        pushNotif({ type: 'levelup', message: 'LEVEL UP!', sub: `→ Lv.${newInfo.level}  +${levelsGained * 3} stat pts`, icon: '⬆', xp: xpAmt })
      } else {
        pushNotif({ type: 'xp', message: `+${xpAmt} XP`, sub: action.replace(/-/g, ' ').toUpperCase(), icon: '✨', xp: xpAmt })
      }

      // Daily quest progress
      const today = todayStr()
      const quests = getDailyQuests(today)
      for (const q of quests) {
        if (q.action === action && !(prev.questsClaimed ?? []).includes(q.id)) {
          const progress = (next.questProgress[q.id] ?? 0) + 1
          next.questProgress[q.id] = progress
          if (progress >= q.target) {
            next.questsClaimed = [...(next.questsClaimed ?? []), q.id]
            next.xp += q.xp
            pushNotif({ type: 'quest', message: 'QUEST COMPLETE!', sub: `${q.name} +${q.xp}XP`, icon: '🎯', xp: q.xp })
          }
        }
      }

      // Achievement checks
      const stats: GameStats = { totalXp: next.xp, level: xpToLevel(next.xp).level, counts: next.counts }
      const unlocked: string[] = []
      for (const ach of ACHIEVEMENTS) {
        if (ach.id === 'class-chosen') continue  // checked in selectClass
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

  // ── Select class (one-time) ───────────────────────────
  const selectClass = useCallback((classId: CharacterClass) => {
    setProfile(prev => {
      if (prev.classId) return prev  // already chosen
      const classDef = CHARACTER_CLASSES[classId]
      const next: StoredProfile = {
        ...prev,
        classId,
        stats: { ...classDef.baseStats },
        statPoints: Math.max(0, (prev.statPoints ?? 0)),
      }
      // Grant "AWAKENED" achievement
      if (!prev.achievements.includes('class-chosen')) {
        next.achievements = [...prev.achievements, 'class-chosen']
        next.xp = prev.xp + 100
        pushNotif({ type: 'achievement', message: 'AWAKENED', sub: `職業覺醒：${classDef.nameZh} +100XP`, icon: '⭐', xp: 100 })
      }
      pushNotif({ type: 'skill', message: `${classDef.name}`, sub: `職業選擇完成！技能解鎖中...`, icon: classDef.skills[0]?.icon ?? '⚔' })
      saveProfile(next)
      return next
    })
  }, [pushNotif])

  // ── Activate skill ────────────────────────────────────
  const activateSkill = useCallback((skillId: string): boolean => {
    let success = false
    setProfile(prev => {
      if (!prev.classId) return prev
      const classDef = CHARACTER_CLASSES[prev.classId]
      const skill = classDef.skills.find(s => s.id === skillId)
      if (!skill) return prev

      const now = Date.now()
      const level = xpToLevel(prev.xp).level
      if (level < skill.unlockLevel) return prev  // not unlocked yet
      if ((prev.skillCooldowns[skillId] ?? 0) > now) return prev  // on cooldown

      const next: StoredProfile = { ...prev, skillCooldowns: { ...prev.skillCooldowns, [skillId]: now + skill.cooldownMs }, activeEffects: [...prev.activeEffects.filter(e => e.expiresAt > now)] }

      if (skill.effect.type === 'instant-xp') {
        next.xp = prev.xp + skill.effect.value
        pushNotif({ type: 'skill', message: `${skill.nameZh}`, sub: `+${skill.effect.value} XP`, icon: skill.icon, xp: skill.effect.value })
      } else if (skill.effect.type === 'xp-mult') {
        const expiresAt = now + (skill.effect.durationMs ?? 300000)
        next.activeEffects.push({ skillId, type: 'xp-mult', value: skill.effect.value, expiresAt, action: skill.effect.action })
        const dur = Math.round((skill.effect.durationMs ?? 300000) / 60000)
        pushNotif({ type: 'skill', message: `${skill.nameZh}`, sub: `XP ×${skill.effect.value} — ${dur} 分鐘`, icon: skill.icon })
      } else if (skill.effect.type === 'cd-reduce') {
        const reduce = skill.effect.value
        const newCooldowns = { ...next.skillCooldowns }
        for (const s of classDef.skills) {
          if (s.id !== skillId && (newCooldowns[s.id] ?? 0) > now) {
            const remaining = newCooldowns[s.id] - now
            newCooldowns[s.id] = now + Math.round(remaining * (1 - reduce))
          }
        }
        next.skillCooldowns = newCooldowns
        pushNotif({ type: 'skill', message: `${skill.nameZh}`, sub: `CD 縮短 ${Math.round(reduce * 100)}%`, icon: skill.icon })
      }

      success = true
      saveProfile(next)
      return next
    })
    return success
  }, [pushNotif])

  // ── Allocate stat point ───────────────────────────────
  const allocateStat = useCallback((stat: StatKey) => {
    setProfile(prev => {
      if ((prev.statPoints ?? 0) <= 0) return prev
      const next: StoredProfile = {
        ...prev,
        stats: { ...prev.stats, [stat]: (prev.stats[stat] ?? 0) + 1 },
        statPoints: prev.statPoints - 1,
      }
      saveProfile(next)
      return next
    })
  }, [])

  const dismissNotif = useCallback((id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id))
  }, [])

  const levelInfo = xpToLevel(profile.xp)
  const todayQuests = getDailyQuests(todayStr())
  const classDef = profile.classId ? CHARACTER_CLASSES[profile.classId] : null

  return { profile, levelInfo, todayQuests, awardXP, selectClass, activateSkill, allocateStat, notifications, dismissNotif, classDef }
}
