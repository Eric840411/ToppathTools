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
 * 一定超過 3 秒——所以按下當下先 `update()` 把按鈕改成反灰的「發送中…」（它同時是 ACK
 * 也是編輯），跑完再 `editReply()` 出結果。實測編輯約 500ms，來得及。
 *
 * ⚠️ 這裡原本用 `deferUpdate()`——它只 ACK、**不動訊息**，整段送出期間按鈕還是可點的
 * 「確認送出到 Lark」（使用者 2026-09-03 回報怕重複點）。但要注意：**按鈕 disabled 只是
 * 視覺防呆，不是正確性保證**，真正擋重複的一直是 `submitWeeklyDraft()` 裡「先 INSERT
 * 搶 claim」那層（CodeX 原話）。
 */
import { Client, GatewayIntentBits, Events, type TextChannel } from 'discord.js'
import { submitWeeklyDraft, clearRetryableSubmissions, packLines } from './routes/weekly-report.js'
import { db } from './shared.js'

/** 按鈕的 custom_id。帶版本後綴——之後改了語意，舊訊息上的按鈕就不會被新程式誤解成同一件事 */
const BTN_SUBMIT = 'weekly_submit_v1'

/**
 * 「有一則卡片正在送出中」的紀錄。
 *
 * ⚠️ 按鈕 disabled **只是視覺防呆，不是正確性保證**（CodeX 原話）——正確性一直是靠
 *    `submitWeeklyDraft()` 裡「先 INSERT 搶 claim」那層。這裡解決的是使用者狂點的體感。
 *
 * ⚠️ 但一旦按下就 disable，**process 中途掛掉的話按鈕會永遠卡在「發送中…」**，
 *    從 Discord 再也按不了。所以一定要有復原路徑，不能永遠鎖死。
 */
const PENDING_KEY = 'weekly_report_submit_pending'
type PendingSubmit = { channelId: string; messageId: string; startedAt: number; userTag: string }

function readPending(): PendingSubmit | null {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(PENDING_KEY) as { value: string } | undefined
    return row ? JSON.parse(row.value) as PendingSubmit : null
  } catch { return null }
}
function writePending(p: PendingSubmit | null): void {
  try {
    if (p) db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(PENDING_KEY, JSON.stringify(p))
    else db.prepare('DELETE FROM settings WHERE key = ?').run(PENDING_KEY)
  } catch (e) { console.error('[WeeklyBot] 寫入送出中狀態失敗：', e) }
}

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
    // 上一個 process 死在送出途中的話，那張卡片還停在「發送中…」且按不了。
    // 這裡不用等 timeout：**能跑到 ClientReady 就代表舊 process 已經不在了**，
    // 留下來的 pending 一定是遺骸，直接復原成可重試。
    void recoverStuckSubmit()
  })

  client.on(Events.InteractionCreate, async i => {
    if (!i.isButton() || i.customId !== BTN_SUBMIT) return

    const allowed = allowedUserIds()
    if (allowed.length > 0 && !allowed.includes(i.user.id)) {
      // ephemeral：只有按的人看得到，不會在頻道洗一則所有人都看到的拒絕訊息
      await i.reply({ content: '你沒有權限按這顆按鈕。', ephemeral: true })
      return
    }

    // 送 Lark 一定超過 3 秒，3 秒內沒回應使用者會看到「此互動失敗」。
    // ⚠️ 原本是 `deferUpdate()`——它只 ACK、**不動訊息**，所以整段送出期間按鈕還是
    //    綠色的「確認送出到 Lark」而且點得下去（使用者 2026-09-03 回報怕重複點）。
    //    改用 `update()`：它同時是 ACK 也是編輯，一次解決。實測編輯約 500ms，來得及。
    // ⚠️ 順序是「先記 pending，再改按鈕」，不能反過來。
    //    反過來的話，改完按鈕、記錄失敗（writePending 自己吞例外）＝卡片停在「發送中…」
    //    但沒有任何復原線索，永遠鎖死。這個順序最壞只會多記一筆用不到的 pending，
    //    下次啟動把一張沒真的送出的卡片改成「重試送出」——安全的方向。
    writePending({ channelId: i.channelId, messageId: i.message.id, startedAt: Date.now(), userTag: i.user.tag })
    await i.update({ components: [disabledRow('發送中…')] })

    // 上一輪失敗的、以及中途掛掉留下的殭屍 processing，按之前先清掉才重試得了
    clearRetryableSubmissions()

    const actor = `discord:${i.user.tag}(${i.user.id})`
    let result: Awaited<ReturnType<typeof submitWeeklyDraft>>
    try {
      result = await submitWeeklyDraft(actor)
    } catch (e) {
      // ⚠️ 這裡不能只是 rethrow：拋出去的話 pending 留著、按鈕停在「發送中…」，
      //    而 process 沒死所以 ClientReady 的復原也不會跑——就真的鎖死了。
      writePending(null)
      await i.editReply({
        content: `❌ 送出時發生未預期錯誤：${e instanceof Error ? e.message : String(e)}`,
        components: [enabledRow('重試送出')],
      }).catch(() => {})
      return
    }
    writePending(null)

    if (result.ok === false) {
      await i.editReply({
        content: `❌ 送不出去：${result.message}`,
        // ⚠️ 原本是 disabledRow('送出失敗')——失敗之後從 Discord 就再也按不了。
        //    但 clearRetryableSubmissions() 本來就是為了讓失敗的能重試而存在，
        //    把出口關掉等於那段程式碼白寫（CodeX：不要永遠鎖死）。
        components: [enabledRow('重試送出')],
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

/** 可以按的按鈕。初次發送、失敗後重試、卡死復原共用同一份——三處各寫一份遲早會漂。 */
function enabledRow(label: string) {
  return {
    type: 1 as const,
    components: [{ type: 2 as const, style: 3 as const, label, custom_id: BTN_SUBMIT }],
  }
}

/**
 * 把上一個 process 死在送出途中留下的「發送中…」卡片復原成可重試。
 *
 * ⚠️ 刻意**不做 timeout 判斷**。timeout 的用途是分辨「還在跑」跟「已經死了」，
 *    但這支只在 ClientReady 跑——能跑到這裡就代表舊 process 已經不在，
 *    留著的 pending 必然是遺骸。加 timeout 只會讓復原白白晚 N 分鐘，
 *    而使用者當下看到的就是卡死（CodeX：「體感會像壞掉」）。
 *
 * 失敗一律吞掉：訊息可能已被刪除、頻道權限可能變了，這些都不該讓 bot 起不來。
 */
async function recoverStuckSubmit(): Promise<void> {
  const p = readPending()
  if (!p) return
  writePending(null)
  const mins = Math.round((Date.now() - p.startedAt) / 60000)
  console.warn(`[WeeklyBot] 發現中斷的送出（${p.userTag} 於 ${mins} 分鐘前按下），復原按鈕`)
  try {
    const ch = await client!.channels.fetch(p.channelId)
    if (!ch || !('messages' in ch)) return
    const msg = await (ch as TextChannel).messages.fetch(p.messageId)
    await msg.edit({
      // ⚠️ 一定要講「不確定送出去幾筆」。送到一半掛掉時，前面那些是真的寫進 Lark 了，
      //    說成「沒有送出」會讓人重送一次；但重送本身是安全的——資料層的 claim 會擋掉
      //    已經送成功的那幾筆，所以按下去只會補送剩下的。
      content: `⚠️ 上一次送出中斷了（${p.userTag} 於 ${mins} 分鐘前按下），不確定完成到哪一筆。`
        + `可以直接重試——已經寫進 Lark 的不會重複送。`,
      components: [enabledRow('重試送出')],
    })
  } catch (e) {
    console.error('[WeeklyBot] 復原中斷的送出失敗（訊息可能已被刪除）：', e)
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
      components: [enabledRow('確認送出到 Lark')],
    })
    return true
  } catch (e) {
    console.error('[WeeklyBot] 發送提醒失敗：', e)
    return false
  }
}

/** 只給檢查腳本用。正式程式碼不要從這裡取——這幾支是模組內部狀態。 */
export const __testables = { readPending, writePending, recoverStuckSubmit, enabledRow, disabledRow, PENDING_KEY,
  setClientForTest: (c: unknown) => { client = c as Client } }
