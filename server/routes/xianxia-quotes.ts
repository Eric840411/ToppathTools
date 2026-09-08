import { randomUUID } from 'crypto'
import { Router } from 'express'
import { z } from 'zod'
import { getAuthAccount } from '../auth-session.js'
import { db } from '../shared.js'
import { callGeminiWithRotation } from './gemini.js'

export const router = Router()

/**
 * 繁體專用字的偵測集合——**只用來標示，不做自動轉換。**
 *
 * ⚠️ 這裡刻意不接簡繁轉換：一句台詞被自動改字之後，**沒有人看得出它被改過**，
 *    而改錯一個字就變成一句原著裡不存在的話——那正是這個功能最該避免的事。
 *    所以只在畫面上標一個「繁」，由人決定要不要用。
 *
 * ⚠️ 不完整是預期的（不可能窮舉），漏標最多是少一個提示，不會弄壞任何東西。
 */
// ⚠️ 收錄前要逐字確認「這個字簡繁真的不同形」。第一版收了「墟」——但簡繁都寫「墟」，
//    於是《圣墟》整部作品每次都被誤標成繁體。**偵測器自己也要驗**。
const TRAD_ONLY = /[會說這來個學經萬國無傳聖劍長變紀蒼誅飄邊為與們時實對開關發點頭沒過還種樣讓從應機轉間問題靈華氣鬥龍鳳島東馬車遠達運遊過還電腦網絡當語詞讀寫愛樂觀點題]/

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
  /**
   * 🚨 **每一部都要同時記簡體與繁體寫法，比對時兩種都試。**
   *
   *    這裡本來只寫繁體，而語錄庫裡存的絕大多數是簡體——於是
   *    「诛仙」對不上 POOL 的「誅仙」，明明已經有 4 則的作品被算成
   *    **還沒收錄過**，反而被優先當例子推給模型。修多樣性的那段自己踩了
   *    同一個坑：**看起來有在避開重複，實際上比對根本沒對上。**
   *
   *    例子一律送簡體那個寫法出去（見下方 prompt 的簡體要求）。
   */
  const POOL = [
    { s: '凡人修仙传', t: '凡人修仙傳' }, { s: '仙逆', t: '仙逆' },
    { s: '斗破苍穹', t: '斗破蒼穹' }, { s: '诛仙', t: '誅仙' },
    { s: '一念永恒', t: '一念永恆' }, { s: '遮天', t: '遮天' },
    { s: '完美世界', t: '完美世界' }, { s: '圣墟', t: '聖墟' },
    { s: '莽荒纪', t: '莽荒紀' }, { s: '星辰变', t: '星辰變' },
    { s: '盘龙', t: '盤龍' }, { s: '雪中悍刀行', t: '雪中悍刀行' },
    { s: '剑来', t: '劍來' }, { s: '武动乾坤', t: '武動乾坤' },
    { s: '大主宰', t: '大主宰' }, { s: '神墓', t: '神墓' },
    { s: '飘邈之旅', t: '飄邈之旅' }, { s: '佛本是道', t: '佛本是道' },
    { s: '长生界', t: '長生界' }, { s: '不朽凡人', t: '不朽凡人' },
    { s: '我欲封天', t: '我欲封天' }, { s: '无限恐怖', t: '無限恐怖' },
  ]
  const hit = (w: string) => haveSources.some(s => s.includes(w) || w.includes(s))
  const fresh = POOL.filter(w => !hit(w.s) && !hit(w.t))
  const pickFrom = fresh.length >= 4 ? fresh : POOL
  const examples = [...pickFrom].sort(() => Math.random() - 0.5).slice(0, 5).map(w => w.s)

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
    // ⚠️ 這些作品的原著本來就是簡體寫成的，庫裡 21 則有 19 則也是簡體。
    //    統一成簡體不只是外觀一致，也讓下面的去重真的有效——同一句用兩種寫法
    //    存進來，精確比對是擋不掉的。
    '**台詞內容與出處作品名一律使用簡體中文**，不要輸出繁體字。',
    '只列出你有信心真的存在於原著/劇集台詞的句子，不要自己編造或改寫；如果不確定某句的確切字句或出處，請不要列出，寧可少列也不要列錯。',
    // ⚠️ 實測：指定單一作品又要 8 句時，模型會用「小心駛得萬年船」「斬草不除根」
    //    這類通用成語湊數。明講一次，但**不能只靠這句**——真正的防線是人工那關。
    '通用成語、俗諺、勵志金句都不算——必須是該作品裡真的出現過的台詞。寧可只給兩三句，也不要湊數量。',
  ].filter(Boolean).join('\n')
  try {
    const text = await callGeminiWithRotation(fullPrompt)
    const rawLines = text.split('\n').map(line => line.trim()).filter(Boolean)
    /**
     * 🚨 **沒有「｜」分隔的行一律丟掉。**
     *
     *    模型常會先寫一句開場白（「以下是 5 句知名中國網路小說的經典名言：」），
     *    原本那行會被當成一句語錄收進候選清單——**出處空白、內容是說明文字**。
     *    要求的格式就是「台詞｜出處」，對不上格式的行就不是語錄。
     *
     * ⚠️ 丟掉幾行要回報，理由跟去重那邊一樣：安靜地少給會被當成 AI 很懶。
     */
    const parsable = rawLines.filter(l => l.includes('｜'))
    const suggestions = parsable
      .map(line => {
        const [quoteText, source] = line.split('｜').map(s => s?.trim() ?? '')
        return { text: quoteText, source: source ?? '', hasTraditional: TRAD_ONLY.test(`${quoteText}${source ?? ''}`) }
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
      unparsedDropped: rawLines.length - parsable.length,
    })
  } catch (error) {
    res.status(500).json({ ok: false, message: error instanceof Error ? error.message : String(error) })
  }
})
