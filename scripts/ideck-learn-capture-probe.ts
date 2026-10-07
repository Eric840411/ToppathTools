// learn 拍攝（1007 iDeck 指標學習）探針：npx tsx scripts/ideck-learn-capture-probe.ts
// 真瀏覽器、假遊戲頁（一個 <video> 當 main 推流框＋兩顆 iDeck 鍵），跑**真的** stepIdeck：
//   ideckCapture 開 → idle×4、每顆 pre／post1／post2 都有檔案、Denom0→Denom1 之後按回 Denom0（來回按）、extraData.ideckLearn 有路徑且 name 補上
//   ideckCapture 關 → 一張都不多拍、沒有 ideckLearn
import fs from 'node:fs'
import { chromium } from 'playwright'
import { stepIdeck, setIdeckCapture } from '../server/machine-test/runner.js'

let fail = 0, n = 0
const ok = (c: boolean, label: string, got?: unknown) => { n++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${!c && got !== undefined ? `：${JSON.stringify(got).slice(0, 300)}` : ''}`) }

const html = `<!doctype html><body style="margin:0;background:#123">
<video style="position:absolute;left:95px;top:107px;width:237px;height:422px;background:#444"></video>
<script>window.__moneyLog=[]; let s=100;
function press(name,aid){ const q=++s; console.log('dealGMActionReq: '+q+' '+name+' '+aid); console.log('SEND: '+q+' hall.hallHandler.dealGMActionReq',{actionid:aid,isspin:0}); setTimeout(()=>console.log('ON: '+q+' hall.hallHandler.dealGMActionReq',{actionid:aid}),60) }</script>
<div class="btn_bet" style="position:absolute;left:10px;top:600px;width:80px;height:40px" onclick="press('Denom0',1)">P0.5</div>
<div class="btn_bet" style="position:absolute;left:100px;top:600px;width:80px;height:40px" onclick="press('Denom1',2)">P1</div></body>`

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 428, height: 739 } })
await page.route('http://probe.local/**', r => r.fulfill({ contentType: 'text/html', body: html }))
try {
  for (const on of [true, false]) {
    await page.goto(`http://probe.local/game/${on ? 'cap' : 'nocap'}`)
    setIdeckCapture(on)
    const code = `873-PROBECAP-000${on ? 1 : 2}`
    const r = await stepIdeck(page, () => {}, code, undefined, undefined, undefined, () => false, undefined, 'probe-')
    const learn = r.extraData?.ideckLearn ? JSON.parse(r.extraData.ideckLearn) : null
    if (on) {
      ok(!!learn && learn.idle.filter(Boolean).length === 4, 'capture 開：idle 拍 4 張（約 9 秒）', learn?.idle)
      ok(learn?.buttons?.length === 3 && learn.buttons.every((b: { pre: string; post1: string; post2: string }) => b.pre && b.post1 && b.post2 && [b.pre, b.post1, b.post2].every(p => fs.existsSync(p))), 'capture 開：每顆 pre／post1／post2 都有檔案', learn?.buttons)
      ok(JSON.stringify(learn?.buttons?.map((b: { name: string }) => b.name)) === '["Denom0","Denom1","Denom0"]', 'capture 開：action name 補上（第三下是按回 Denom0）', learn?.buttons?.map((b: { name: string }) => b.name))
      ok(learn?.buttons?.[2]?.idx === 'back-1' && learn.buttons[2].backOf === '1' && learn.buttons.every((b: { round: boolean | null }) => b.round === false), 'capture 開：來回按記成 back-1／backOf 1，每下都記 round', learn?.buttons)
      ok(r.extraData?.learn ? JSON.parse(r.extraData.learn).actions.length === 2 : false, 'capture 開：按回那一下不算進 actions（不影響判定）', r.extraData?.learn)
      // 拍的是 main 推流框（237×422），不是整頁
      const { PNG } = await import('pngjs')
      const im = PNG.sync.read(fs.readFileSync(learn.buttons[0].pre))
      ok(im.width === 237 && im.height === 422, 'capture 開：裁的是 main 推流框', [im.width, im.height])
      for (const p of [...learn.idle, ...learn.buttons.flatMap((b: { pre: string; post1: string; post2: string }) => [b.pre, b.post1, b.post2])]) if (p) fs.rmSync(p, { force: true })
    } else ok(!learn, 'capture 關：沒有 ideckLearn、不多拍', learn)
  }
} finally {
  setIdeckCapture(false)
  await browser.close()
}
console.log(fail ? `❌ ${fail}/${n} 失敗` : `✅ ${n}/${n} 通過`)
process.exit(fail ? 1 : 0)
