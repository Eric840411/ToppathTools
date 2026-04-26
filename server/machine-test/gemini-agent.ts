/**
 * Minimal LLM vision helper for standalone agent use.
 * Supports Gemini (via GEMINI_API_KEY) and Ollama (via OLLAMA_BASE_URL / OLLAMA_MODEL).
 */

const callOllamaVisionAgent = async (prompt: string, imageBase64: string, model: string): Promise<string> => {
  const base = process.env.OLLAMA_BASE_URL
  if (!base) throw new Error('OLLAMA_BASE_URL 環境變數未設定')
  const resp = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, images: [imageBase64], stream: false }),
  })
  if (!resp.ok) throw new Error(`Ollama Vision HTTP ${resp.status}`)
  const data = await resp.json() as { response?: string; error?: string }
  if (data.error) throw new Error(`Ollama Vision 錯誤：${data.error}`)
  return data.response ?? ''
}

const geminiGenerate = async (parts: unknown[]): Promise<string> => {
  const key = process.env.GEMINI_API_KEY ?? ''
  if (!key) throw new Error('GEMINI_API_KEY 環境變數未設定（請在 start.bat 中加入 set GEMINI_API_KEY=...）')
  const model = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash'
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { temperature: 0.1 },
      }),
    },
  )
  const data = await resp.json() as {
    candidates?: { content?: { parts?: { text?: string }[] } }[]
    error?: { message?: string }
  }
  if (data.error) throw new Error(data.error.message ?? 'Gemini API error')
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
}

export const callGeminiVision = async (prompt: string, imageBase64: string, mimeType = 'image/png'): Promise<string> => {
  // Check for Ollama model spec via env var set by agent-runner
  const modelSpec = process.env.CCTV_MODEL_SPEC
  if (modelSpec?.startsWith('ollama:')) {
    return callOllamaVisionAgent(prompt, imageBase64, modelSpec.slice(7))
  }
  return geminiGenerate([
    { inlineData: { mimeType, data: imageBase64 } },
    { text: prompt },
  ])
}

export const callGeminiVisionMulti = async (
  prompt: string,
  images: Array<{ base64: string; mimeType?: string }>,
): Promise<string> => {
  return geminiGenerate([
    ...images.map(img => ({ inlineData: { mimeType: img.mimeType ?? 'image/png', data: img.base64 } })),
    { text: prompt },
  ])
}
