/**
 * 帳號池 H5 / PC 版本切換的 URL 換算。
 *
 *   npx tsx scripts/ui-checks/url-pool-device.test.ts
 *
 * 這支要守的不是「會不會換」，是**換太多**跟**換不乾淨**：
 *   1. token / username / gameid / studioid 被動到 → 變成「不是同一個帳號／不是同一款遊戲」在測
 *   2. `mode=live` 被吃掉或被改成 web → 進去是另一種模式，畫面看起來完全正常
 *   3. 反覆切換疊加（PC 再轉一次 PC）→ 參數重複
 * 這三種錯誤的共通點是**不會報錯**，只會讓人測錯東西。
 */
import { toDeviceUrl } from '../../src/data/urlPoolDevice.js'

let pass = 0
const fails: string[] = []
const eq = (name: string, got: unknown, want: unknown) => {
  if (got === want) { pass++; console.log('✅ ' + name) }
  else { fails.push(name); console.log(`❌ ${name}\n   got:  ${got}\n   want: ${want}`) }
}
const ok = (name: string, cond: boolean) => {
  if (cond) { pass++; console.log('✅ ' + name) }
  else { fails.push(name); console.log('❌ ' + name) }
}

// 帳號池裡真的長這樣（osmel002，QAT）
const H5 = 'https://osm-redirect.osmslot.org/?token=f76856cf4429ddc75925dbf98b14b1ab-325599&platform=pc&mode=live&language=zh_cn&studioid=cp&gameid=osmbwjl&lang=en_us&username=osmel002&device=mobile&isPwaClaimed=1'
// osm-qa-agent/test-rr-spin-investigate.js 用同一個 token 實際載入 PC Cocos 版的那條
const PC_EXPECTED = 'https://osm-redirect.osmslot.org/?token=f76856cf4429ddc75925dbf98b14b1ab-325599&platform=50&mode=live&language=zh_cn&studioid=cp&gameid=osmbwjl&lang=en_us&username=osmel002&device=pc&isPwaClaimed=1'

// ── 基本換算 ──────────────────────────────────────────────────────────────────
eq('h5 原樣回傳（不做任何加工）', toDeviceUrl(H5, 'h5'), H5)
eq('pc 只換 platform 與 device', toDeviceUrl(H5, 'pc'), PC_EXPECTED)

// ── 不該被動到的東西 ──────────────────────────────────────────────────────────
const pc = toDeviceUrl(H5, 'pc')
ok('token 不變', pc.includes('token=f76856cf4429ddc75925dbf98b14b1ab-325599'))
ok('username 不變', pc.includes('username=osmel002'))
ok('gameid 不變', pc.includes('gameid=osmbwjl'))
ok('studioid 不變', pc.includes('studioid=cp'))
ok('網域不變（不是模擬正式，不換 host）', pc.startsWith('https://osm-redirect.osmslot.org/?'))
ok('mode=live 留著', pc.includes('mode=live'))
ok('沒有偷加 mode=web（刻意不加，見 urlPoolDevice.ts 開頭）', !pc.includes('mode=web'))
eq('參數數量不變（只換值、不增不減）', pc.split('&').length, H5.split('&').length)

// ── 反覆切換不會疊加 ──────────────────────────────────────────────────────────
eq('PC 再轉一次 PC 還是同一條（冪等）', toDeviceUrl(pc, 'pc'), pc)
ok('PC 裡只有一個 platform', (pc.match(/[?&]platform=/g) ?? []).length === 1)
ok('PC 裡只有一個 device', (pc.match(/[?&]device=/g) ?? []).length === 1)

// ── 邊界：不能生出「看起來對、進去卻不對」的連結 ────────────────────────────
eq('空字串回空字串', toDeviceUrl('', 'pc'), '')
eq('沒有 query 就不動它（沒東西可換，硬湊只會騙人）',
  toDeviceUrl('https://osm-redirect.osmslot.org/', 'pc'), 'https://osm-redirect.osmslot.org/')
ok('原本就沒有 device 參數時會補上',
  toDeviceUrl('https://x/?token=a&platform=pc', 'pc') === 'https://x/?token=a&platform=50&device=pc')
ok('參數值裡含 "device" 字樣不會被誤判成參數名',
  toDeviceUrl('https://x/?gameid=osmdevice&platform=pc&device=mobile', 'pc')
    === 'https://x/?gameid=osmdevice&platform=50&device=pc')
ok('第一個參數就是 device 時也換得到',
  toDeviceUrl('https://x/?device=mobile&token=a', 'pc') === 'https://x/?device=pc&token=a&platform=50')

console.log(`\n${fails.length ? '❌' : '✅'} ${pass} 過 / ${fails.length} 失敗`)
if (fails.length) { fails.forEach(f => console.log('  - ' + f)); process.exit(1) }
