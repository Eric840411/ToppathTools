/**
 * Knowledge Base Routes — /api/knowledge/*
 * 管理 AI 知識庫文件，供批次評論 / TestCase 生成等功能調用
 */
import { Router } from 'express'
import { PDFParse } from 'pdf-parse'
import { z } from 'zod'
import { db, getLarkToken } from '../shared.js'
import { getAuthAccount } from '../auth-session.js'

export const router = Router()

// ─── Types ────────────────────────────────────────────────────────────────────

interface KnowledgeDoc {
  id: number
  name: string
  type: 'lark_wiki' | 'pdf' | 'google_doc' | 'text'
  source_url: string | null
  content_cache: string | null
  tags: string
  cached_at: number | null
  created_at: number
}

// ─── Content fetchers ─────────────────────────────────────────────────────────

async function fetchLarkContent(url: string): Promise<string> {
  const match = url.match(/\/wiki\/([A-Za-z0-9]+)/)
  if (!match) throw new Error(`無法解析 Lark Wiki URL：${url}`)
  const documentId = match[1]
  const token = await getLarkToken()
  const base = process.env.LARK_BASE_URL ?? 'https://open.larksuite.com'
  const resp = await fetch(`${base}/open-apis/docx/v1/documents/${documentId}/raw_content`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const data = await resp.json() as { code?: number; data?: { content?: string }; msg?: string }
  if (!resp.ok || data.code !== 0) throw new Error(`讀取 Lark Wiki 失敗 (code=${data.code}): ${data.msg}`)
  return data.data?.content ?? ''
}

async function fetchGoogleDocContent(url: string): Promise<string> {
  const match = url.match(/\/document\/d\/([^/?\s]+)/)
  if (!match) throw new Error(`無法解析 Google Doc URL：${url}`)
  const docId = match[1]
  const resp = await fetch(`https://docs.google.com/document/d/${docId}/export?format=txt`)
  if (!resp.ok) throw new Error(`讀取 Google Doc 失敗 (HTTP ${resp.status})，請確認文件已設為「任何人可查看」`)
  return resp.text()
}

async function fetchPdfContent(url: string): Promise<string> {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`下載 PDF 失敗 (HTTP ${resp.status})`)
  const buffer = Buffer.from(await resp.arrayBuffer())
  const parsed = await PDFParse(buffer)
  return parsed.text
}

async function fetchContent(type: string, source_url: string | null, text_content?: string): Promise<string> {
  if (type === 'text') return text_content ?? ''
  if (!source_url) throw new Error('來源 URL 不能為空')
  if (type === 'lark_wiki') return fetchLarkContent(source_url)
  if (type === 'google_doc') return fetchGoogleDocContent(source_url)
  if (type === 'pdf') return fetchPdfContent(source_url)
  throw new Error(`不支援的文件類型：${type}`)
}

// ─── GET /api/knowledge/docs ──────────────────────────────────────────────────

router.get('/api/knowledge/docs', (req, res) => {
  const account = getAuthAccount(req)
  if (!account) { res.status(401).json({ ok: false, error: 'unauthenticated' }); return }

  const docs = db.prepare(`
    SELECT id, name, type, source_url, tags, cached_at, created_at,
           CASE WHEN content_cache IS NOT NULL THEN length(content_cache) ELSE 0 END as content_length
    FROM knowledge_docs ORDER BY created_at DESC
  `).all()
  res.json({ ok: true, docs })
})

// ─── POST /api/knowledge/docs ─────────────────────────────────────────────────

const AddDocSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['lark_wiki', 'pdf', 'google_doc', 'text']),
  source_url: z.string().optional(),
  text_content: z.string().optional(),
  tags: z.array(z.string()).default([]),
})

router.post('/api/knowledge/docs', async (req, res) => {
  const account = getAuthAccount(req)
  if (!account) { res.status(401).json({ ok: false, error: 'unauthenticated' }); return }

  const parsed = AddDocSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ ok: false, error: parsed.error.message }); return }

  const { name, type, source_url, text_content, tags } = parsed.data
  const now = Date.now()

  try {
    const content = await fetchContent(type, source_url ?? null, text_content)
    const result = db.prepare(`
      INSERT INTO knowledge_docs (name, type, source_url, content_cache, tags, cached_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(name, type, source_url ?? null, content, JSON.stringify(tags), now, now)
    res.json({ ok: true, id: result.lastInsertRowid })
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message })
  }
})

// ─── POST /api/knowledge/docs/:id/refresh ─────────────────────────────────────

router.post('/api/knowledge/docs/:id/refresh', async (req, res) => {
  const account = getAuthAccount(req)
  if (!account) { res.status(401).json({ ok: false, error: 'unauthenticated' }); return }

  const doc = db.prepare('SELECT * FROM knowledge_docs WHERE id = ?').get(req.params.id) as KnowledgeDoc | undefined
  if (!doc) { res.status(404).json({ ok: false, error: '文件不存在' }); return }
  if (doc.type === 'text') { res.status(400).json({ ok: false, error: '純文字文件無需重抓' }); return }

  try {
    const content = await fetchContent(doc.type, doc.source_url)
    const now = Date.now()
    db.prepare('UPDATE knowledge_docs SET content_cache = ?, cached_at = ? WHERE id = ?')
      .run(content, now, doc.id)
    res.json({ ok: true, content_length: content.length, cached_at: now })
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message })
  }
})

// ─── GET /api/knowledge/docs/:id/content ─────────────────────────────────────

router.get('/api/knowledge/docs/:id/content', (req, res) => {
  const account = getAuthAccount(req)
  if (!account) { res.status(401).json({ ok: false, error: 'unauthenticated' }); return }

  const doc = db.prepare('SELECT id, name, content_cache FROM knowledge_docs WHERE id = ?').get(req.params.id) as Pick<KnowledgeDoc, 'id' | 'name' | 'content_cache'> | undefined
  if (!doc) { res.status(404).json({ ok: false, error: '文件不存在' }); return }
  res.json({ ok: true, id: doc.id, name: doc.name, content: doc.content_cache ?? '' })
})

// ─── DELETE /api/knowledge/docs/:id ──────────────────────────────────────────

router.delete('/api/knowledge/docs/:id', (req, res) => {
  const account = getAuthAccount(req)
  if (!account) { res.status(401).json({ ok: false, error: 'unauthenticated' }); return }

  const doc = db.prepare('SELECT id FROM knowledge_docs WHERE id = ?').get(req.params.id)
  if (!doc) { res.status(404).json({ ok: false, error: '文件不存在' }); return }

  db.prepare('DELETE FROM knowledge_docs WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})
