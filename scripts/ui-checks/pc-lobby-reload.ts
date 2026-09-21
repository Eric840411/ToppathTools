/**
 * PC 大廳「沒就緒 → reload 一次再等」這條補救路徑，**在真的客戶端上跑一次**。
 *
 *   PC_URL='<PC 版 token URL>' npx tsx scripts/ui-checks/pc-lobby-reload.ts
 *
 * 背景：這條分支是照一次現場觀察補上的防禦性程式碼，補上之後**從來沒有被實際觸發過**。
 * `pc-lobby-recovery.test.ts` 已經把**決策**逐個組合驗過了；這支補的是另一半——
 * **reload 之後大廳真的建得出來嗎**。
 *
 * ⚠️ **誠實說明這支證明到哪裡**：
 *    它用「等太短」製造出「沒就緒」的狀態（`pcWaitLobby(page, 3000)`），
 *    **不是**現場那個「上一輪被 /stop 砍掉、場景是 lobby 但 ScrollView-gms 建不出來」的壞狀態——
 *    那個狀態我無法穩定重現。所以這支證明的是：
 *      ① 在真的「沒就緒」狀態下，決策確實選 reload（不是只有在假資料上成立）
 *      ② reload ＋ 再等一次之後，大廳真的會就緒
 *    **沒有**證明 reload 能救得了那個損壞狀態。那一條仍然是未驗證的，要等它再現場發生一次。
 */
import { chromium } from 'playwright'
import { pcInstallEvalShim, pcWaitLobby, pcSceneName, pcScanLobby, describePcLobby, pcLobbyRecoveryPlan } from '../../server/lib/pc-cocos.js'

const PC_URL = process.env.PC_URL ?? ''
const OUT = process.env.OUT ?? '.'
if (!PC_URL) { console.log('要給 PC_URL'); process.exit(1) }

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++ }

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  await page.goto(PC_URL, { timeout: 60_000 })
  await pcInstallEvalShim(page)

  // ① 故意等太短，造出一個**真的**「沒就緒」狀態（不是假的 diag 物件）
  const early = await pcWaitLobby(page, 3_000)
  const scene = await pcSceneName(page)
  check('等 3 秒時大廳還沒就緒（製造出待補救的狀態）', !early.ready, describePcLobby(early))
  if (early.ready) {
    console.log('  ⚠️ 這台機器載入太快，3 秒就就緒了——這次沒有造出待補救狀態，下面的結論不成立')
  }

  // ② 決策：在真的狀態上，應該選 reload
  const plan = pcLobbyRecoveryPlan({ ready: early.ready, scene, reloadTried: false, leaveTried: false })
  check('決策選 reload', plan === 'reload', `scene=${scene || '(讀不到)'} → ${plan}`)

  // ③ 療效：照決策做一次，大廳要真的建出來
  if (plan === 'reload') {
    await page.goto(PC_URL, { timeout: 30_000 }).catch(() => {})
    const after = await pcWaitLobby(page, 40_000)
    await page.screenshot({ path: `${OUT}/pc-reload-after.png` })
    check('reload ＋ 再等一次之後大廳就緒', after.ready, describePcLobby(after))
    if (after.ready) {
      const machines = await pcScanLobby(page)
      // ⚠️ `ready` 只說清單建出來了。掃到 0 台的話下一步照樣全掛，所以要一起看
      check('掃得到機台（不是建了一個空清單）', machines.length > 0, `${machines.length} 台`)
    }
  }

  console.log(`\n${fail ? '❌' : '✅'} ${pass} 過 / ${fail} 失敗`)
  if (fail) process.exitCode = 1
} catch (e) {
  console.log('FATAL', String(e).split('\n')[0].slice(0, 200))
  process.exitCode = 1
} finally {
  await browser.close()
}
