/**
 * Game Preview 上的「新遊戲廣告」（右上黃色 ✕＋底下 PLAY GAME）要被關掉，PLAY GAME 絕對不能點。
 *
 *   npx tsx scripts/ui-checks/lobby-ad-close.test.ts
 *
 * 1007 osm-qa-agent 回報（873-SUPERBURSTLINK-0345，截圖 occupied-873-SUPERBURSTLINK-0345-*.png）：
 * 廣告蓋住 Join → 找不到 Join → 誤判 Occupied。機台測試的 Join 路徑改用 UAT 共用的 dismissLobbyPopups。
 * 真瀏覽器、照截圖的版面：Preview 面板（右上 .btn-close＝關掉 Preview 本身，不能點）、廣告（.closeBtn ✕、PLAY GAME 按鈕）、Join 在下面
 */
import { chromium } from 'playwright'
import { dismissLobbyPopups } from '../../server/uat-runner/lobby-popup.js'

let fail = 0, n = 0
const ok = (c: boolean, label: string, got?: unknown) => { n++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${got !== undefined ? `：${JSON.stringify(got)}` : ''}`) }

const html = `<!doctype html><script>window.__ran=[]</script>
<div class="gm-info-box" style="position:fixed;inset:0;background:#311">
  <div class="btn-close" style="position:absolute;right:8px;top:8px;width:33px;height:33px" onclick="__ran.push('preview-close')">✕</div>
  <button class="join-btn" style="position:absolute;left:30px;top:460px;width:120px;height:40px" onclick="__ran.push('join')">Join</button>
</div>
<div class="game-ad-mask" style="position:fixed;inset:0;background:rgba(0,0,0,.6)">
  <div class="game-ad" style="position:absolute;left:60px;top:140px;width:300px;height:380px;background:#a52">
    <img class="closeBtn" style="position:absolute;right:-10px;top:-10px;width:24px;height:24px;background:#fc0" onclick="__ran.push('ad-close');document.querySelector('.game-ad-mask').remove()">
    <div>Lightning Gongs – Brand New Game</div>
    <button class="play-game-btn" style="position:absolute;left:80px;bottom:-40px;width:150px;height:36px" onclick="__ran.push('play-game')">PLAY GAME</button>
  </div>
</div>`

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 428, height: 739 } })
try {
  await page.setContent(html)
  const r = await dismissLobbyPopups(page, { rounds: 3, settleMs: 100 })
  const ran = await page.evaluate(() => (window as unknown as { __ran: string[] }).__ran)
  ok(JSON.stringify(ran) === '["ad-close"]', '只點廣告的 ✕（PLAY GAME、Preview 的 btn-close 都沒點）', ran)
  ok(r.closed.length === 1 && /closeBtn/.test(r.closed[0]), '回報關掉的是 closeBtn', r)
  await page.click('.join-btn', { timeout: 2000 })
  ok((await page.evaluate(() => (window as unknown as { __ran: string[] }).__ran)).includes('join'), '廣告關掉之後 Join 按得到')
  // PLAY GAME 按鈕就算 class 帶 close 字樣也不能點（字樣像進場的一律跳過）
  await page.setContent(html.replace('class="play-game-btn"', 'class="closeBtn play-game-btn"').replace('>PLAY GAME<', '>PLAY NOW<'))
  await dismissLobbyPopups(page, { rounds: 3, settleMs: 100 })
  const ran2 = await page.evaluate(() => (window as unknown as { __ran: string[] }).__ran)
  ok(!ran2.includes('play-game'), '進場字樣的按鈕即使 class 是 closeBtn 也不點', ran2)
} finally {
  await browser.close()
}
console.log(fail ? `❌ ${fail}/${n} 失敗` : `✅ ${n}/${n} 通過`)
process.exit(fail ? 1 : 0)
