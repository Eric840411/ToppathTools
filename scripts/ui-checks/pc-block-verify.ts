/**
 * PC 積木（`pc_enter_machine`／`assert_pc_scene`）在**真的 PC 客戶端**上跑一次。
 *
 *   PC_URL='<PC 版 token URL>' npx tsx scripts/ui-checks/pc-block-verify.ts
 *
 * 🚨 **重點不是「會綠」，是「該紅的會紅」。** 一顆永遠通過的斷言比沒有斷言更糟：
 *    它會讓整份 TC 報告看起來驗過了。所以下面每個正向檢查都配一個**故意給錯**的反向檢查
 *    （錯的場景／不存在的機台／錯的機台名），錯的那些**必須失敗**才算數。
 *
 * ⚠️ 跑的是 `runFrontendStep` 本人 ＋ `pcEngineCapabilities` 本人，不是複製一份流程。
 * ⚠️ 會真的進機台（佔位子），結束前會退回大廳。請先鎖帳號。
 */
import { chromium } from 'playwright'
import { runFrontendStep } from '../../server/uat-runner/frontend-engine.js'
import { pcEngineCapabilities, pcSceneName, pcInGameMachineName, pcBackToLobby } from '../../server/lib/pc-cocos.js'

const PC_URL = process.env.PC_URL ?? ''
const WANT_GAME = process.env.WANT_GAME ?? 'Rising Rockets'
const OUT = process.env.OUT ?? '.'
if (!PC_URL) { console.log('要給 PC_URL'); process.exit(1) }

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`)
  if (ok) pass++; else fail++
}

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
try {
  const [VW, VH] = (process.env.VIEWPORT ?? '1280x800').split('x').map(Number)
  const ctx = await browser.newContext({ viewport: { width: VW, height: VH } })
  const page = await ctx.newPage()
  const log = async (l: string) => console.log('   ' + l)
  const host = {
    log, page, browser, recordedLocator: async () => { throw new Error('PC 沒有 DOM 選擇器') },
    netCapture: null, startUrl: PC_URL, viewportHeight: VH, backend: null,
    state: { netMark: Date.now() }, pc: pcEngineCapabilities,
  }
  /** 跑一顆積木，回傳它有沒有丟錯。**這支關心的就是「有沒有丟錯」**。 */
  const run = async (step: Record<string, unknown>) => {
    try { await runFrontendStep(step, { ...host, idx: '[*]', label: String(step.name) }); return { ok: true, err: '' } }
    catch (e) { return { ok: false, err: String((e as Error).message ?? e).split('\n')[0].slice(0, 120) } }
  }

  await run({ name: '前往 PC 大廳', action: 'goto' })

  // ── 大廳 ────────────────────────────────────────────────────────────────────
  const inLobby = await run({ name: '驗大廳', action: 'assert_pc_scene', value: 'lobby' })
  check('① 在大廳時「驗大廳」通過', inLobby.ok, inLobby.err)

  // 🚨 反向：同一個位置驗「機台內」必須紅
  const wrongScene = await run({ name: '（故意）驗機台內', action: 'assert_pc_scene', value: 'game' })
  check('② 在大廳時「驗機台內」必須失敗', !wrongScene.ok, wrongScene.err)

  // 🚨 反向：不存在的機台必須紅（而且訊息要看得出是「找不到」，不是別的錯）
  const noSuch = await run({ name: '（故意）進不存在的機台', action: 'pc_enter_machine', value: 'No Such Game ZZZ' })
  check('③ 不存在的機台必須失敗', !noSuch.ok, noSuch.err)
  check('③b 失敗訊息說得出是找不到', /找不到可用/.test(noSuch.err), noSuch.err)

  // ── 進機台 ──────────────────────────────────────────────────────────────────
  const entered = await run({ name: '進機台', action: 'pc_enter_machine', value: WANT_GAME })
  check('④ 進得了機台', entered.ok, entered.err)
  await page.screenshot({ path: `${OUT}/pc-block-entered.png` })

  if (entered.ok) {
    const actual = await pcInGameMachineName(page)
    const inGame = await run({ name: '驗機台內', action: 'assert_pc_scene', value: 'game' })
    check('⑤ 進去之後「驗機台內」通過', inGame.ok, `場景=${await pcSceneName(page)}`)

    const rightName = await run({ name: '驗機台身分', action: 'assert_pc_scene', value: 'game', selector: actual })
    check('⑥ 機台名稱對得上時通過', rightName.ok, `實際在 ${actual}`)

    // 🚨 這條是整支最重要的：**點座標會點到隔壁機台**，不核對的話報告會寫著 A、圖卻是 B
    const wrongName = await run({ name: '（故意）驗成別台', action: 'assert_pc_scene', value: 'game', selector: 'Totally-Wrong-Machine-9999' })
    check('⑦ 機台名稱對不上時必須失敗', !wrongName.ok, wrongName.err)

    // ⚠️ 名稱檢查只在 game 場景成立；選 lobby 又填名稱是使用者設定錯了，要擋下來而不是默默略過
    const nameInLobby = await run({ name: '（故意）大廳卻要驗機台名', action: 'assert_pc_scene', value: 'lobby', selector: actual })
    check('⑧ 場景選 lobby 卻填機台名要擋下來', !nameInLobby.ok, nameInLobby.err)

    // 收尾：位子還給人家
    const back = await pcBackToLobby(page)
    check('⑨ 收尾退回大廳（位子放掉）', back.ok, back.steps.join(' → ') || '(沒點到任何按鈕)')
  }

  console.log(`\n${fail ? '❌' : '✅'} ${pass} 過 / ${fail} 失敗`)
  if (fail) process.exitCode = 1
} catch (e) {
  console.log('FATAL', String(e).split('\n')[0].slice(0, 200))
  process.exitCode = 1
} finally {
  await browser.close()
}
