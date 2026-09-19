// pcWaitLobby 只檢查「讀得到機台名稱」，沒有檢查場景真的是 lobby。
// 問題是：帳號如果還坐在上一輪進過的機台裡，重新載入會**直接回到機台畫面**，
// 而機台畫面左上角也有機台名稱 → labelled > 0 → pcWaitLobby 判定 ready。
// 接下來掃大廳當然 0 台。這支把每個尺寸的 scene 名稱印出來驗證這個假設。
import { chromium } from 'playwright'
import { pcWaitLobby, pcClosePopups, pcScanLobby, pcSceneName, pcInGameMachineName } from '../../server/lib/pc-cocos.ts'

const URL = process.env.PC_URL
const OUT = process.env.OUT ?? '.'
for (const size of (process.env.SIZES ?? '800x360,1024x768').split(',')) {
  const [w, h] = size.split('x').map(Number)
  const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  try {
    const page = await browser.newPage({ viewport: { width: w, height: h } })
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    const diag = await pcWaitLobby(page, 90_000)
    for (let i = 0; i < 2; i++) { await pcClosePopups(page); await page.waitForTimeout(400) }
    const scene = await pcSceneName(page)
    const inGame = await pcInGameMachineName(page)
    const all = await pcScanLobby(page)
    const onScreen = await pcScanLobby(page, { onScreenOnly: true })
    console.log(JSON.stringify({
      size, waitLobbySaysReady: diag.ready, diagScene: diag.scene, sceneNow: scene,
      inGameMachineName: inGame, machineItems: diag.machineItems, labelled: diag.labelled,
      scanned: all.length, onScreen: onScreen.length,
    }))
    await page.screenshot({ path: `${OUT}/pc-scene-${size}.png` })
  } catch (e) {
    console.log(JSON.stringify({ size, fatal: String(e).slice(0, 200) }))
  } finally { await browser.close() }
}
