import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from 'discord.js'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

// ─── Config（在函式內讀取，確保 dotenv 已先執行）────────────────────────────

const getConfig = () => ({
  botToken:   process.env.DISCORD_BOT_TOKEN ?? '',
  channelId:  process.env.DISCORD_CURSOR_CHANNEL_ID ?? '',
  allowedIds: (process.env.DISCORD_ALLOWED_USER_IDS ?? '')
    .split(',').map(s => s.trim()).filter(Boolean),
})

// ─── Gemini helper（複用 .env 的 key）────────────────────────────────────────

async function askGemini(prompt: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY ?? ''
  if (!key) throw new Error('未設定 GEMINI_API_KEY')

  // Discord bot 優先用 2.0-flash（額度高），fallback 到 1.5-flash
  const models = ['gemini-2.0-flash', 'gemini-1.5-flash']

  for (const model of models) {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3 },
        }),
      },
    )
    const data = await resp.json() as {
      candidates?: { content?: { parts?: { text?: string }[] } }[]
      error?: { code?: number; message?: string; status?: string }
    }

    if (data.error?.status === 'RESOURCE_EXHAUSTED' || resp.status === 429) {
      console.warn(`[Discord] ${model} 額度不足，嘗試下一個模型`)
      continue
    }
    if (data.error) throw new Error(data.error.message)
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '（無回應）'
  }

  throw new Error('所有 Gemini 模型額度已用盡，請稍後再試或新增其他 API Key')
}

// ─── Shell 執行（回傳輸出，限制 10 秒）───────────────────────────────────────

async function runShell(cmd: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: 10_000,
      shell: 'powershell.exe',
      cwd: process.cwd(),
    })
    const out = (stdout + stderr).trim()
    return out.length > 1800 ? out.slice(0, 1800) + '\n...(輸出過長，已截斷)' : out
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    const out = (((err.stdout ?? '') + (err.stderr ?? '')) || (err.message ?? String(e))).trim()
    return `❌ 錯誤：${out.slice(0, 1800)}`
  }
}

// ─── 呼叫本機 Express API ─────────────────────────────────────────────────────

async function callLocalApi(method: string, path: string, body?: unknown): Promise<string> {
  const port = process.env.PORT ?? 3000
  const url  = `http://localhost:${port}${path}`
  try {
    const resp = await fetch(url, {
      method: method.toUpperCase(),
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await resp.text()
    return text.length > 1800 ? text.slice(0, 1800) + '\n...(截斷)' : text
  } catch (e) {
    return `❌ API 呼叫失敗：${String(e)}`
  }
}

// ─── 訊息路由 ─────────────────────────────────────────────────────────────────

/**
 * 指令說明（發送 !help 可查看）：
 *
 * !run <command>          — 執行 shell 指令（PowerShell）
 * !api <METHOD> <path>    — 呼叫本機 API，例：!api GET /api/health
 * !api <METHOD> <path> {json} — 帶 body 的 API，例：!api POST /api/gemini/keys {...}
 * 其他任意文字            — 交給 Gemini AI 回答
 */
async function handleMessage(content: string): Promise<string> {
  const trimmed = content.trim()

  // ── !help ──────────────────────────────────────────────────────────────────
  if (trimmed === '!help') {
    return [
      '**可用指令：**',
      '`!run <command>` — 執行 shell 指令（PowerShell）',
      '`!api GET /api/health` — 呼叫本機 Express API',
      '`!api POST /api/xxx {...}` — 帶 JSON body 的 API',
      '`!help` — 顯示此說明',
      '',
      '其他任意文字會交給 Gemini AI 處理。',
    ].join('\n')
  }

  // ── !run <shell command> ───────────────────────────────────────────────────
  if (trimmed.startsWith('!run ')) {
    const cmd = trimmed.slice(5).trim()
    if (!cmd) return '⚠️ 請輸入要執行的指令，例：`!run dir`'
    const result = await runShell(cmd)
    return `\`\`\`\n${result || '（無輸出）'}\n\`\`\``
  }

  // ── !api <METHOD> <path> [body] ────────────────────────────────────────────
  if (trimmed.startsWith('!api ')) {
    const parts  = trimmed.slice(5).trim().split(/\s+/)
    const method = parts[0]
    const path   = parts[1]
    if (!method || !path) return '⚠️ 格式：`!api <METHOD> <path> [JSON body]`'

    const bodyStart = trimmed.indexOf('{')
    let body: unknown
    if (bodyStart !== -1) {
      try { body = JSON.parse(trimmed.slice(bodyStart)) }
      catch { return '⚠️ JSON body 格式錯誤' }
    }
    const result = await callLocalApi(method, path, body)
    return `\`\`\`json\n${result}\n\`\`\``
  }

  // ── 自由文字 → Gemini ──────────────────────────────────────────────────────
  const systemCtx = `你是部署在本機 Express 伺服器上的助理，負責遠端控制這台機器。
使用者透過 Discord 傳送指令，你需要用繁體中文簡潔回覆。
若需要執行指令，請告知使用者用 !run 或 !api 前綴。`

  return askGemini(`${systemCtx}\n\n使用者說：${trimmed}`)
}

// ─── 權限檢查 ─────────────────────────────────────────────────────────────────

// ─── Discord Client ───────────────────────────────────────────────────────────

export function startDiscordBot(): void {
  const { botToken, channelId, allowedIds } = getConfig()

  if (!botToken) {
    console.warn('[Discord] DISCORD_BOT_TOKEN 未設定，跳過啟動')
    return
  }
  if (!channelId || channelId === '填入你要監聽的頻道ID') {
    console.warn('[Discord] DISCORD_CURSOR_CHANNEL_ID 未設定，跳過啟動')
    return
  }

  const isAllowed = (userId: string) =>
    allowedIds.length === 0 || allowedIds.includes(userId)

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  })

  client.once(Events.ClientReady, (c) => {
    console.log(`[Discord] Bot 上線：${c.user.tag}，監聽頻道 ${channelId}`)
  })

  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return
    if (message.channelId !== channelId) return
    if (!isAllowed(message.author.id)) {
      await message.reply('⛔ 你沒有操作權限。').catch(() => null)
      return
    }

    const content = message.content.trim()
    if (!content) return

    // 顯示「正在輸入」
    const channel = message.channel as TextChannel
    await channel.sendTyping().catch(() => null)

    try {
      const reply = await handleMessage(content)
      await message.reply({ content: reply, allowedMentions: { repliedUser: false } })
    } catch (e) {
      await message.reply(`❌ 處理失敗：${String(e)}`).catch(() => null)
    }
  })

  client.login(botToken).catch((e) => {
    console.error('[Discord] 登入失敗：', e)
  })
}
