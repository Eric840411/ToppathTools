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
  const only = String((req.body as { onlySource?: string })?.onlySource ?? '').trim().slice(0, 40)

  // 語錄庫現況——要餵給模型，也要拿來去重。
  const existing = db.prepare('SELECT text, source FROM xianxia_quotes').all() as { text: string; source: string }[]
  const haveSources = [...new Set(existing.map(r => (r.source || '').trim()).filter(Boolean))]

  /**
   * 🚨 **例子作品會把模型錨死。**原本 prompt 固定舉《凡人修仙傳》《仙逆》
   *    《斗破蒼穹》《誅仙》四部，結果語錄庫 21 則裡有 20 則就是那四部——
   *    模型幾乎只會在被點名的作品裡繞。所以改成從一個較大的清單隨機抽幾部當例子，
   *    而且**優先抽語錄庫還沒有的**。
   */
  const POOL = [
    '凡人修仙傳', '仙逆', '斗破蒼穹', '誅仙', '一念永恆', '遮天', '完美世界', '聖墟',
    '莽荒紀', '星辰變', '盤龍', '雪中悍刀行', '劍來', '武動乾坤', '大主宰', '神墓',
    '飄邈之旅', '佛本是道', '長生界', '不朽凡人', '我欲封天', '無限恐怖',
  ]
  const fresh = POOL.filter(w => !haveSources.some(s => s.includes(w) || w.includes(s)))
  const pickFrom = fresh.length >= 4 ? fresh : POOL
  const examples = [...pickFrom].sort(() => Math.random() - 0.5).slice(0, 5)

  // ⚠️ 已有的句子只餵**最近 60 則**：全部塞進去會把 prompt 撐爆，
  //    而且模型對長清單的遵守度本來就會下降。真正保證不重複的是下面的去重，不是這段。
  const avoidText = existing.slice(-60).map(r => r.text).filter(Boolean)

  const prompt = only
    ? `請列出 ${count} 句出自《${only}》的經典名言或台詞。`
    : `請列出 ${count} 句知名中國網路小說/國漫/仙俠劇的經典名言或台詞。`
  const fullPrompt = [
    prompt,
    only ? '' : `這一次請優先從這幾部裡挑：${examples.map(w => `《${w}》`).join('、')}。`,
    only ? '' : '同一次回覆裡**不要都來自同一部作品**，盡量分散。',
    avoidText.length
      ? `以下句子語錄庫已經有了，**一句都不要重複**（連改寫過的版本也不要）：\n${avoidText.map(t => `- ${t}`).join('\n')}`
      : '',
    '每句請用「台詞內容｜出處作品名」這個格式輸出，一行一句，不要編號、不要多餘說明文字。',
    '只列出你有信心真的存在於原著/劇集台詞的句子，不要自己編造或改寫；如果不確定某句的確切字句或出處，請不要列出，寧可少列也不要列錯。',
  ].filter(Boolean).join('\n')
  try {
    const text = await callGeminiWithRotation(fullPrompt)
    const suggestions = text
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const [quoteText, source] = line.split('｜').map(s => s?.trim() ?? '')
        return { text: quoteText, source: source ?? '' }
      })
      .filter(s => s.text)

    /**
     * 🚨 **去重要在伺服器端做，不能只靠 prompt。**
     *    上面已經把「已有的句子」餵給模型並要求不要重複，但那是**指令**——
     *    模型可以忽略，而且只餵了最近 60 則。真正保證不重複的是這一段。
     *
     * ⚠️ **只做「正規化後精確比對」，不做模糊比對**（跟 CodeX 提過，但他這輪掛了，
     *    所以先照這個取捨走，之後可以推翻）：正規化只拿掉標點、空白與全半形差異。
     *
     *    刻意不做編輯距離那類模糊比對——它會把「意思相近但確實是兩句不同台詞」
     *    也砍掉，而那比漏掉一筆重複糟得多：漏一筆重複，人在審閱時看得出來；
     *    砍掉一句真的新語錄，人**永遠不知道它曾經出現過**。
     *
     * ⚠️ **已知擋不掉**：簡繁不同寫法的同一句（資料裡「凡人修仙传」與
     *    「凡人修仙傳」就是分開兩筆）。要擋需要簡繁轉換的相依，這版沒做——
     *    交給人工審閱那關。
     */
    const norm = (s: string) => s
      .replace(/[\s　]/g, '')
      .replace(/[，。、！？；：「」『』（）()《》〈〉,.!?;:"'`~—…·]/g, '')
      .toLowerCase()
    const known = new Set(existing.map(r => norm(r.text)))
    const seen = new Set<string>()
    const deduped = suggestions.filter(s => {
      const k = norm(s.text)
      if (!k || known.has(k) || seen.has(k)) return false
      seen.add(k)
      return true
    })
    // ⚠️ 回傳時把「丟掉幾筆」講出來。安靜地少給幾句，使用者只會覺得「AI 這次很懶」，
    //    而不知道是被擋掉的——那又是「沒有結論卻看起來像結論」那一類。
    res.json({
      ok: true, suggestions: deduped,
      duplicatesDropped: suggestions.length - deduped.length,
    })
  } catch (error) {
    res.status(500).json({ ok: false, message: error instanceof Error ? error.message : String(error) })
  }
})
