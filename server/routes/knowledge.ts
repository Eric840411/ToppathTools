/**
 * Knowledge Base Routes — /api/knowledge/*
 * 管理 AI 知識庫文件，供批次評論 / TestCase 生成等功能調用
 */
import { Router } from 'express'
import multer from 'multer'
import pdfParse from 'pdf-parse'
import mammoth from 'mammoth'
import { z } from 'zod'
import { db, getLarkToken } from '../shared.js'
import { getAuthAccount } from '../auth-session.js'

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } })

export const router = Router()

function textQualityScore(value: string): number {
  const cjkMatches = value.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0
  const mojibakeMatches = value.match(/[ÃÂâãåæçèéäöü\u0080-\u009f]/g)?.length ?? 0
  const replacementMatches = value.match(/\uFFFD/g)?.length ?? 0
  return cjkMatches * 4 - mojibakeMatches * 3 - replacementMatches * 8
}

function fixLatin1Utf8Mojibake(value: string | null): string | null {
  if (!value || !/[ÃÂâãåæçèéäöü\u0080-\u009f]/.test(value)) return value
  const decoded = Buffer.from(value, 'latin1').toString('utf8')
  if (decoded.includes('\uFFFD')) return value
  return textQualityScore(decoded) > textQualityScore(value) ? decoded : value
}

function normalizeKnowledgeDocForResponse<T extends { type?: string; source_url?: string | null }>(doc: T): T {
  if (doc.type !== 'file_upload' || !doc.source_url) return doc
  return { ...doc, source_url: fixLatin1Utf8Mojibake(doc.source_url) }
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface KnowledgeDoc {
  id: number
  name: string
  type: 'lark_wiki' | 'pdf' | 'google_doc' | 'text' | 'file_upload'
  source_url: string | null
  content_cache: string | null
  tags: string
  cached_at: number | null
  created_at: number
  folder_id: number | null
}

interface KnowledgeFolder {
  id: number
  name: string
  color: string
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
  const parsed = await pdfParse(buffer)
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

// ─── GET /api/knowledge/folders ───────────────────────────────────────────────

router.get('/api/knowledge/folders', (req, res) => {
  const account = getAuthAccount(req)
  if (!account) { res.status(401).json({ ok: false, error: 'unauthenticated' }); return }
  try {
    const folders = db.prepare(`
      SELECT f.id, f.name, f.color, f.created_at,
             COUNT(d.id) as doc_count
      FROM knowledge_folders f
      LEFT JOIN knowledge_docs d ON d.folder_id = f.id
      GROUP BY f.id ORDER BY f.created_at ASC
    `).all()
    let unclassifiedCnt = 0
    try {
      const row = db.prepare('SELECT COUNT(*) as cnt FROM knowledge_docs WHERE folder_id IS NULL').get() as { cnt: number }
      unclassifiedCnt = row.cnt
    } catch {
      // folder_id column may not exist yet — fall back to total doc count
      const row = db.prepare('SELECT COUNT(*) as cnt FROM knowledge_docs').get() as { cnt: number }
      unclassifiedCnt = row.cnt
    }
    res.json({ ok: true, folders, unclassified_count: unclassifiedCnt })
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message })
  }
})

// ─── POST /api/knowledge/folders ──────────────────────────────────────────────

router.post('/api/knowledge/folders', (req, res) => {
  const account = getAuthAccount(req)
  if (!account) { res.status(401).json({ ok: false, error: 'unauthenticated' }); return }
  const { name, color = 'blue' } = req.body as { name: string; color?: string }
  if (!name?.trim()) { res.status(400).json({ ok: false, error: '名稱不能為空' }); return }
  const now = Date.now()
  const result = db.prepare('INSERT INTO knowledge_folders (name, color, created_at) VALUES (?, ?, ?)').run(name.trim(), color, now)
  res.json({ ok: true, id: result.lastInsertRowid })
})

// ─── PATCH /api/knowledge/folders/:id ─────────────────────────────────────────

router.patch('/api/knowledge/folders/:id', (req, res) => {
  const account = getAuthAccount(req)
  if (!account) { res.status(401).json({ ok: false, error: 'unauthenticated' }); return }
  const { name, color } = req.body as { name?: string; color?: string }
  const folder = db.prepare('SELECT id FROM knowledge_folders WHERE id = ?').get(req.params.id) as KnowledgeFolder | undefined
  if (!folder) { res.status(404).json({ ok: false, error: '資料夾不存在' }); return }
  if (name?.trim()) db.prepare('UPDATE knowledge_folders SET name = ? WHERE id = ?').run(name.trim(), folder.id)
  if (color) db.prepare('UPDATE knowledge_folders SET color = ? WHERE id = ?').run(color, folder.id)
  res.json({ ok: true })
})

// ─── DELETE /api/knowledge/folders/:id ────────────────────────────────────────

router.delete('/api/knowledge/folders/:id', (req, res) => {
  const account = getAuthAccount(req)
  if (!account) { res.status(401).json({ ok: false, error: 'unauthenticated' }); return }
  const folder = db.prepare('SELECT id FROM knowledge_folders WHERE id = ?').get(req.params.id) as KnowledgeFolder | undefined
  if (!folder) { res.status(404).json({ ok: false, error: '資料夾不存在' }); return }
  // move docs to unclassified
  db.prepare('UPDATE knowledge_docs SET folder_id = NULL WHERE folder_id = ?').run(folder.id)
  db.prepare('DELETE FROM knowledge_folders WHERE id = ?').run(folder.id)
  res.json({ ok: true })
})

// ─── GET /api/knowledge/docs ──────────────────────────────────────────────────

router.get('/api/knowledge/docs', (req, res) => {
  const account = getAuthAccount(req)
  if (!account) { res.status(401).json({ ok: false, error: 'unauthenticated' }); return }

  const { folder_id } = req.query
  let docs
  if (folder_id === 'null' || folder_id === '') {
    docs = db.prepare(`
      SELECT id, name, type, source_url, tags, cached_at, created_at, folder_id,
             CASE WHEN content_cache IS NOT NULL THEN length(content_cache) ELSE 0 END as content_length
      FROM knowledge_docs WHERE folder_id IS NULL ORDER BY created_at DESC
    `).all()
  } else if (folder_id) {
    docs = db.prepare(`
      SELECT id, name, type, source_url, tags, cached_at, created_at, folder_id,
             CASE WHEN content_cache IS NOT NULL THEN length(content_cache) ELSE 0 END as content_length
      FROM knowledge_docs WHERE folder_id = ? ORDER BY created_at DESC
    `).all(folder_id)
  } else {
    docs = db.prepare(`
      SELECT id, name, type, source_url, tags, cached_at, created_at, folder_id,
             CASE WHEN content_cache IS NOT NULL THEN length(content_cache) ELSE 0 END as content_length
      FROM knowledge_docs ORDER BY created_at DESC
    `).all()
  }
  res.json({ ok: true, docs: docs.map(normalizeKnowledgeDocForResponse) })
})

// ─── POST /api/knowledge/docs ─────────────────────────────────────────────────

/** 從上傳檔案 buffer 抽取純文字 */
async function extractFileText(buffer: Buffer, mimetype: string, originalname: string): Promise<string> {
  const ext = originalname.split('.').pop()?.toLowerCase() ?? ''
  // PDF
  if (mimetype === 'application/pdf' || ext === 'pdf') {
    const parsed = await pdfParse(buffer)
    return parsed.text
  }
  // Word (.docx / .doc)
  if (
    mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimetype === 'application/msword' ||
    ext === 'docx' || ext === 'doc'
  ) {
    const result = await mammoth.extractRawText({ buffer })
    return result.value
  }
  // HTML
  if (mimetype === 'text/html' || ext === 'html' || ext === 'htm') {
    const html = buffer.toString('utf-8')
    return html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
  }
  throw new Error(`不支援的檔案格式：${originalname}（支援 PDF / Word / HTML）`)
}

// ─── POST /api/knowledge/docs/upload (multipart) ──────────────────────────────

router.post('/api/knowledge/docs/upload', upload.single('file'), async (req, res) => {
  const account = getAuthAccount(req)
  if (!account) { res.status(401).json({ ok: false, error: 'unauthenticated' }); return }
  if (!req.file) { res.status(400).json({ ok: false, error: '請選擇檔案' }); return }

  const originalname = fixLatin1Utf8Mojibake(req.file.originalname) ?? req.file.originalname
  const name = (req.body.name as string | undefined)?.trim() || originalname
  const tagsRaw = req.body.tags as string | undefined
  const tags = tagsRaw ? JSON.parse(tagsRaw) : []
  const folderId = req.body.folder_id ? Number(req.body.folder_id) : null
  const now = Date.now()

  try {
    const content = await extractFileText(req.file.buffer, req.file.mimetype, originalname)
    const result = db.prepare(`
      INSERT INTO knowledge_docs (name, type, source_url, content_cache, tags, cached_at, created_at, folder_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, 'file_upload', originalname, content, JSON.stringify(tags), now, now, folderId)
    res.json({ ok: true, id: result.lastInsertRowid })
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message })
  }
})

const AddDocSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['lark_wiki', 'pdf', 'google_doc', 'text']),
  source_url: z.string().optional(),
  text_content: z.string().optional(),
  tags: z.array(z.string()).default([]),
  folder_id: z.number().nullable().optional(),
})

router.post('/api/knowledge/docs', async (req, res) => {
  const account = getAuthAccount(req)
  if (!account) { res.status(401).json({ ok: false, error: 'unauthenticated' }); return }

  const parsed = AddDocSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ ok: false, error: parsed.error.message }); return }

  const { name, type, source_url, text_content, tags, folder_id } = parsed.data
  const now = Date.now()

  try {
    const content = await fetchContent(type, source_url ?? null, text_content)
    const result = db.prepare(`
      INSERT INTO knowledge_docs (name, type, source_url, content_cache, tags, cached_at, created_at, folder_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, type, source_url ?? null, content, JSON.stringify(tags), now, now, folder_id ?? null)
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
  if (doc.type === 'text' || doc.type === 'file_upload') { res.status(400).json({ ok: false, error: '此類型文件無需重抓' }); return }

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
