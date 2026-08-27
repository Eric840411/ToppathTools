/**
 * Discord 按鈕的端到端探測：連 Gateway → 發一則帶按鈕的訊息 → 等人按 → 回應 → 把按鈕改成反灰。
 *
 * 這支只是驗證「這條路走不走得通」，不是產品程式碼。真正的實作會接進 server。
 *
 * ## 為什麼一定要真的按一次
 * 「webhook 送 components 會被靜默丟掉」就是只有實際送出去看回應才發現的。
 * 按鈕能不能顯示、按下去伺服器收不收得到、能不能改成反灰——是三件不同的事，
 * 只驗第一件會得到「看起來可以」的假結論。
 *
 * 跑法：node scripts/ui-checks/discord-button-probe.mjs
 */
import 'dotenv/config';
import { Client, GatewayIntentBits, Events } from 'discord.js';

const token = process.env.WEEKLY_DISCORD_BOT_TOKEN;
const channelId = process.env.WEEKLY_DISCORD_CHANNEL_ID;
if (!token || !channelId) { console.log('❌ .env 缺 WEEKLY_DISCORD_BOT_TOKEN / WEEKLY_DISCORD_CHANNEL_ID'); process.exit(1) }

// 逾時要留夠時間給人真的看到訊息並按下去。第一次設 150 秒太短，人還沒看到就過期了。
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 600_000);
// Guilds 就夠了——只發訊息、收 interaction，不需要 MessageContent 這種特權 intent
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

let sentId = null;
const t0 = Date.now();

client.once(Events.ClientReady, async c => {
  console.log(`✅ Gateway 連上了：${c.user.tag}（${Date.now() - t0}ms）`);
  const ch = await client.channels.fetch(channelId);
  const msg = await ch.send({
    content: '🔬 **端到端測試**：請按一下「確認發送」，我要驗證伺服器收不收得到、能不能把按鈕改成反灰。',
    components: [{
      type: 1,
      components: [
        { type: 2, style: 3, label: '確認發送', custom_id: 'probe_confirm' },
        { type: 2, style: 2, label: '不要', custom_id: 'probe_cancel' },
      ],
    }],
  });
  sentId = msg.id;
  console.log(`✅ 訊息已送出（id ${msg.id}），等你按…最多等 ${TIMEOUT_MS / 1000} 秒`);
});

client.on(Events.InteractionCreate, async i => {
  if (!i.isButton() || !i.message || i.message.id !== sentId) return;
  console.log(`✅ 收到按鈕事件：custom_id=${i.customId}，按的人=${i.user.tag}（${i.user.id}）`);

  // Discord 要求 3 秒內回應，超過就會顯示「此互動失敗」
  const t = Date.now();
  await i.update({
    content: `✅ **收到了**。按的是「${i.customId === 'probe_confirm' ? '確認發送' : '不要'}」，由 ${i.user.tag} 在 <t:${Math.floor(Date.now() / 1000)}:T> 按下。`,
    components: [{
      type: 1,
      components: [
        { type: 2, style: 3, label: '確認發送', custom_id: 'probe_confirm', disabled: true },
        { type: 2, style: 2, label: '不要', custom_id: 'probe_cancel', disabled: true },
      ],
    }],
  });
  console.log(`✅ 已回應並把按鈕改成反灰（耗時 ${Date.now() - t}ms，上限 3000ms）`);
  console.log('\n三件事都成立：按鈕顯示得出來、伺服器收得到、改得動狀態。');
  await client.destroy();
  process.exit(0);
});

setTimeout(async () => {
  console.log('⏱️ 逾時，沒人按。按鈕本身有送出去，但「收不收得到」這件事這次沒驗到。');
  // 把訊息刪掉——留著的話按鈕還在，但已經沒有程式在聽，按下去只會顯示「此互動失敗」，
  // 那會讓人誤以為功能壞了
  try {
    const ch = await client.channels.fetch(channelId);
    if (sentId) await ch.messages.delete(sentId);
    console.log('（逾時的測試訊息已刪除，避免留下按了沒反應的按鈕）');
  } catch { /* 刪不掉就算了 */ }
  await client.destroy();
  process.exit(2);
}, TIMEOUT_MS);

client.login(token);
