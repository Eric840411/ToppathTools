/**
 * server/weekly-report-bot.ts
 *
 * 週報提醒的 Discord 機器人：發帶按鈕的訊息、接「按鈕被按了」、送出、把按鈕改成反灰。
 *
 * ## 為什麼是 Bot 不是 Webhook
 * **Webhook 送 `components` 會被 Discord 靜默丟掉**——HTTP 200、訊息照送、回應裡
 * `"components":[]`、不報錯。已實測。要有按鈕就一定得是 application 發的訊息。
 *
 * ## 為什麼用既有的 discord.js 而不是自己接 Gateway
 * 專案裡本來就有（`server/discord-bot.ts` 在用）。heartbeat／reconnect／resume／rate limit
 * 這些雜務不值得自己重寫一遍。
 *
 * ## 跟既有那支 bot 的關係
 * **是不同的機器人、不同的 token**（`WEEKLY_DISCORD_BOT_TOKEN` vs `DISCORD_BOT_TOKEN`），
 * 刻意分開避免動到既有 `discord-bot.ts` 的行為。
 *
 * ## Discord 的 3 秒硬限制
 * 按鈕被按之後 3 秒內一定要回應，否則使用者看到「此互動失敗」。送 Lark 一筆一筆寫，
 * 一定超過 3 秒——所以先 `deferUpdate()` 佔位，跑完再 `editReply()`。實測單純回應約 500ms，
 * defer 完全來得及。
 */
import { Client, GatewayIntentBits, Events, type TextChannel } from 'discord.js'
import { submitWeeklyDraft, clearRetryableSubmissions } from './routes/weekly-report.js'

/** 按鈕的 custom_id。帶版本後綴——之後改了語意，舊訊息上的按鈕就不會被新程式誤解成同一件事 */
const BTN_SUBMIT = 'weekly_submit_v1'

let client: Client | null = null
let ready = false

const cfg = () => ({
  token: process.env.WEEKLY_DISCORD_BOT_TOKEN ?? '',
  channelId: process.env.WEEKLY_DISCORD_CHANNEL_ID ?? '',
})

/** 誰可以按這顆按鈕。空的代表不限制（只有伺服器成員看得到訊息，本來就有一層）。 */
function allowedUserIds(): string[] {
  return (process.env.WEEKLY_DISCORD_ALLOWED_USER_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean)
}

export function isWeeklyBotReady(): boolean {
  return ready
}

/** 啟動 Gateway 連線。沒設 token 就靜靜不啟動——這是選配功能，不該讓 server 起不來。 */
export function startWeeklyReportBot(): void {
  const { token } = cfg()
  if (!token) return
  if (client) return

  // Guilds 就夠了：只發訊息、收 interaction。不需要 MessageContent 那種特權 intent，
  // 要求越少權限越好過審、也越不會讀到不該讀的東西
  client = new Client({ intents: [GatewayIntentBits.Guilds] })

  client.once(Events.ClientReady, c => {
    ready = true
    console.log(`[WeeklyBot] Gateway 已連上：${c.user.tag}`)
  })

  client.on(Events.InteractionCreate, async i => {
    if (!i.isButton() || i.customId !== BTN_SUBMIT) return

    const allowed = allowedUserIds()
    if (allowed.length > 0 && !allowed.includes(i.user.id)) {
      // ephemeral：只有按的人看得到，不會在頻道洗一則所有人都看到的拒絕訊息
      await i.reply({ content: '你沒有權限按這顆按鈕。', ephemeral: true })
      return
    }

    // 送 Lark 一定超過 3 秒，先 defer 佔位，不然使用者會看到「此互動失敗」
    await i.deferUpdate()

    // 上一輪失敗的、以及中途掛掉留下的殭屍 processing，按之前先清掉才重試得了
    clearRetryableSubmissions()

    const actor = `discord:${i.user.tag}(${i.user.id})`
    const result = await submitWeeklyDraft(actor)

    if (result.ok === false) {
      await i.editReply({
        content: `❌ 送不出去：${result.message}`,
        components: [disabledRow('送出失敗')],
      })
      return
    }

    const { outcome } = result
    const lines: string[] = []
    lines.push(`✅ **已送出 ${outcome.sent.length} 筆**（由 ${i.user.tag} 於 <t:${Math.floor(Date.now() / 1000)}:t> 按下）`)
    if (outcome.skipped.length > 0) lines.push(`⏭️ 跳過 ${outcome.skipped.length} 筆（之前已經送過）`)
    if (outcome.failed.length > 0) {
      lines.push(`❌ 失敗 ${outcome.failed.length} 筆：`)
      for (const f of outcome.failed.slice(0, 3)) lines.push(`　• ${f.person}：${f.message.slice(0, 80)}`)
    }
    // 待處理一定要列出來並寫原因，不能只說「還有 N 筆」——使用者要知道為什麼、去哪處理
    if (outcome.blockers.length > 0) {
      lines.push('', `⚠️ **還有 ${outcome.blockers.length} 項要你去頁面處理**：`)
      for (const b of outcome.blockers.slice(0, 5)) lines.push(`　• ${b.detail}`)
      if (outcome.blockers.length > 5) lines.push(`　…另有 ${outcome.blockers.length - 5} 項`)
    }

    let content = lines.join('\n')
    // Discord 訊息本體上限 2000 字元，超過會整包被拒——寧可截斷也不要整則發不出去
    if (content.length > 1900) content = `${content.slice(0, 1890)}\n…（過長已截斷）`

    await i.editReply({ content, components: [disabledRow('已送出')] })
  })

  client.on(Events.Error, e => console.error('[WeeklyBot] Gateway 錯誤：', e))

  client.login(token).catch(e => {
    console.error('[WeeklyBot] 登入失敗：', e)
    ready = false
  })
}

/** 按完之後的按鈕列——保留按鈕但一律 disabled，讓人看得出「這則已經處理過了」，
 *  而不是整排消失讓人以為訊息被改壞了 */
function disabledRow(label: string) {
  return {
    type: 1 as const,
    components: [{ type: 2 as const, style: 2 as const, label, custom_id: BTN_SUBMIT, disabled: true }],
  }
}

/**
 * 發一則帶「確認送出」按鈕的提醒。
 *
 * 回傳 `false` 代表沒發出去（沒設定、還沒連上、頻道抓不到）——呼叫端要能退回用 webhook 發，
 * 不能因為 bot 沒起來就整個提醒都不見了。
 */
export async function sendWeeklyReminderWithButton(payload: {
  content: string
  embed: Record<string, unknown>
}): Promise<boolean> {
  const { channelId } = cfg()
  if (!client || !ready || !channelId) return false
  try {
    const ch = await client.channels.fetch(channelId)
    if (!ch || !('send' in ch)) return false
    await (ch as TextChannel).send({
      content: payload.content,
      embeds: [payload.embed as never],
      components: [{
        type: 1,
        components: [{ type: 2, style: 3, label: '確認送出到 Lark', custom_id: BTN_SUBMIT }],
      }],
    })
    return true
  } catch (e) {
    console.error('[WeeklyBot] 發送提醒失敗：', e)
    return false
  }
}
