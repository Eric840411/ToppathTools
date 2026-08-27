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
import { submitWeeklyDraft, clearRetryableSubmissions, packLines } from './routes/weekly-report.js'

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

    // 訊息本體只放一行結論；明細全部放 embed 欄位。
    // **不做「…另有 N 筆」的省略**（2026-08-27 使用者要求）——訊息本體上限 2000 字元擠不下，
    // 但 embed 欄位可以切成多個，切的是容器不是內容。
    const summary = `✅ **已送出 ${outcome.sent.length} 筆**`
      + (outcome.skipped.length > 0 ? `　⏭️ 跳過 ${outcome.skipped.length}` : '')
      + (outcome.failed.length > 0 ? `　❌ 失敗 ${outcome.failed.length}` : '')
      + (outcome.blockers.length > 0 ? `　⚠️ 待處理 ${outcome.blockers.length}` : '')
      + `（由 ${i.user.tag} 於 <t:${Math.floor(Date.now() / 1000)}:t> 按下）`

    const fields: Array<{ name: string; value: string; inline: boolean }> = []
    if (outcome.sent.length > 0) {
      fields.push(...packLines(`已送出（${outcome.sent.length}）`,
        outcome.sent.map(x => `• ${x.person}：${x.content}`)))
    }
    if (outcome.skipped.length > 0) {
      fields.push(...packLines(`跳過（${outcome.skipped.length}）`,
        outcome.skipped.map(x => `• ${x.person}：${x.content}　—— ${x.reason}`)))
    }
    if (outcome.failed.length > 0) {
      fields.push(...packLines(`失敗（${outcome.failed.length}）`,
        outcome.failed.map(x => `• ${x.person}：${x.content}　—— ${x.message}`)))
    }
    // 待處理一定要逐條列出並寫原因——使用者要知道為什麼、去哪處理
    if (outcome.blockers.length > 0) {
      fields.push(...packLines(`需要你去頁面處理（${outcome.blockers.length}）`,
        outcome.blockers.map(b => `• ${b.detail}`)))
    }

    await i.editReply({
      content: summary,
      embeds: packFieldsIntoEmbeds(fields, '送出結果'),
      components: [disabledRow('已送出')],
    })
  })

  client.on(Events.Error, e => console.error('[WeeklyBot] Gateway 錯誤：', e))

  client.login(token).catch(e => {
    console.error('[WeeklyBot] 登入失敗：', e)
    ready = false
  })
}

/** 把欄位切進多個 embed。Discord 一個 embed 最多 25 欄／6000 字元，超過整包被拒、
 *  訊息完全發不出去。切的是容器不是內容，不會因此少列任何一筆。 */
function packFieldsIntoEmbeds(fields: Array<{ name: string; value: string; inline: boolean }>, title: string) {
  if (fields.length === 0) return []
  const out: Array<Record<string, unknown>> = []
  let cur: typeof fields = []
  let len = 0
  const flush = () => {
    if (cur.length === 0) return
    out.push({
      title: out.length === 0 ? title : `${title}（續 ${out.length + 1}）`,
      color: 0x62C6A5,
      fields: cur,
    })
    cur = []; len = 0
  }
  for (const f of fields) {
    const size = f.name.length + f.value.length
    if (cur.length >= 25 || (cur.length > 0 && len + size > 5500)) flush()
    cur.push(f); len += size
  }
  flush()
  return out.slice(0, 10) as never
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
  /** 可能不只一個——逐筆完整列出之後欄位數會隨人數成長，而 Discord 一個 embed
   *  最多 25 欄／6000 字元，超過整包被拒。切的是容器不是內容。 */
  embeds: Array<Record<string, unknown>>
}): Promise<boolean> {
  const { channelId } = cfg()
  if (!client || !ready || !channelId) return false
  try {
    const ch = await client.channels.fetch(channelId)
    if (!ch || !('send' in ch)) return false
    await (ch as TextChannel).send({
      content: payload.content,
      // 一則訊息最多 10 個 embed；超過的話寧可少顯示尾巴也不要整則發不出去，
      // 但真的到 10 個 embed（250 個欄位）代表資料量已經不適合塞在 Discord 裡了
      embeds: payload.embeds.slice(0, 10) as never,
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
