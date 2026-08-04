import { randomUUID } from 'crypto'
import { Router } from 'express'
import { z } from 'zod'
import { getAuthAccount } from '../auth-session.js'
import { db } from '../shared.js'
import { callGeminiWithRotation } from './gemini.js'

export const router = Router()

type QuoteRow = { id: string; text: string; source: string; created_at: number; last_used_cycle: number }

function todayTaipei(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' })
}

type DailyQuoteState = { date: string; quoteId: string; cycle: number }

function readDailyQuoteState(): DailyQuoteState | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'xianxia_daily_quote'").get() as { value: string } | undefined
  if (!row) return null
  try { return JSON.parse(row.value) as DailyQuoteState } catch { return null }
}

function writeDailyQuoteState(state: DailyQuoteState) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('xianxia_daily_quote', JSON.stringify(state))
}

/**
 * 每天固定抽一則（同一天內大家看到的都一樣），抽選邏輯是「這一輪還沒抽過的語錄裡隨機挑」，
 * 整輪全抽完才會重新洗牌開始下一輪——語錄庫夠大時很久才會重複，且庫子可以隨時新增成長。
 */
function getDailyQuote(): { text: string; source: string } | null {
  const today = todayTaipei()
  const state = readDailyQuoteState()
  if (state && state.date === today) {
    const row = db.prepare('SELECT text, source FROM xianxia_quotes WHERE id = ?').get(state.quoteId) as { text: string; source: string } | undefined
    if (row) return row
    // 該語錄後來被刪除了，往下重新抽一則給今天
  }

  const all = db.prepare('SELECT id, text, source, last_used_cycle FROM xianxia_quotes').all() as QuoteRow[]
  if (all.length === 0) return null

  let cycle = state?.cycle ?? 1
  let candidates = all.filter(q => q.last_used_cycle < cycle)
  if (candidates.length === 0) {
    cycle += 1
    candidates = all
  }
  const picked = candidates[Math.floor(Math.random() * candidates.length)]
  db.prepare('UPDATE xianxia_quotes SET last_used_cycle = ? WHERE id = ?').run(cycle, picked.id)
  writeDailyQuoteState({ date: today, quoteId: picked.id, cycle })
  return { text: picked.text, source: picked.source }
}

router.get('/api/xianxia/quote-of-day', (req, res) => {
  const account = getAuthAccount(req)
  if (!account) return res.status(401).json({ ok: false, message: 'unauthenticated' })
  res.json({ ok: true, quote: getDailyQuote() })
})

router.get('/api/xianxia/quotes', (req, res) => {
  const account = getAuthAccount(req)
  if (!account) return res.status(401).json({ ok: false, message: 'unauthenticated' })
  const rows = db.prepare('SELECT id, text, source, created_at, last_used_cycle FROM xianxia_quotes ORDER BY created_at DESC').all()
  res.json({ ok: true, quotes: rows })
})

const quoteBodySchema = z.object({
  text: z.string().min(1),
  source: z.string().default(''),
})

router.post('/api/xianxia/quotes', (req, res) => {
  const account = getAuthAccount(req)
  if (!account) return res.status(401).json({ ok: false, message: 'unauthenticated' })
  const body = quoteBodySchema.parse(req.body)
  const id = randomUUID()
  db.prepare('INSERT INTO xianxia_quotes (id, text, source, created_at, last_used_cycle) VALUES (?, ?, ?, ?, 0)')
    .run(id, body.text.trim(), body.source.trim(), Date.now())
  res.json({ ok: true, id })
})

router.put('/api/xianxia/quotes/:id', (req, res) => {
  const account = getAuthAccount(req)
  if (!account) return res.status(401).json({ ok: false, message: 'unauthenticated' })
  const body = quoteBodySchema.parse(req.body)
  db.prepare('UPDATE xianxia_quotes SET text = ?, source = ? WHERE id = ?').run(body.text.trim(), body.source.trim(), req.params.id)
  res.json({ ok: true })
})

router.delete('/api/xianxia/quotes/:id', (req, res) => {
  const account = getAuthAccount(req)
  if (!account) return res.status(401).json({ ok: false, message: 'unauthenticated' })
  db.prepare('DELETE FROM xianxia_quotes WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

// AI 建議候選語錄——只回傳草稿供人工審閱，不會自動寫入語錄庫。
// 因為 AI 常會編造根本不存在的句子或講錯出處，prompt 明確要求「不確定就不要列」，
// 但最終是否採用仍需要人親自確認出處真的存在。
router.post('/api/xianxia/quotes/ai-suggest', async (req, res) => {
  const account = getAuthAccount(req)
  if (!account) return res.status(401).json({ ok: false, message: 'unauthenticated' })
  const count = Math.min(10, Math.max(1, Number((req.body as { count?: number })?.count) || 5))
  const prompt = `請列出 ${count} 句知名中國網路小說/國漫/仙俠劇的經典名言或台詞（例如《凡人修仙傳》《仙逆》《斗破蒼穹》《誅仙》等仙俠/修仙題材作品）。
每句請用「台詞內容｜出處作品名」這個格式輸出，一行一句，不要編號、不要多餘說明文字。
只列出你有信心真的存在於原著/劇集台詞的句子，不要自己編造或改寫；如果不確定某句的確切字句或出處，請不要列出，寧可少列也不要列錯。`
  try {
    const text = await callGeminiWithRotation(prompt)
    const suggestions = text
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const [quoteText, source] = line.split('｜').map(s => s?.trim() ?? '')
        return { text: quoteText, source: source ?? '' }
      })
      .filter(s => s.text)
    res.json({ ok: true, suggestions })
  } catch (error) {
    res.status(500).json({ ok: false, message: error instanceof Error ? error.message : String(error) })
  }
})
