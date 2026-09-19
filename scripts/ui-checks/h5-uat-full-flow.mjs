/**
 * 完整 H5 流程，走**真正的派工路徑**（建立 run → 指派 agent → agent 執行 → 結果落地）。
 *
 * 流程是 2026-09-19 從真站台量出來的，不是照舊腳本抄：
 *   goto → 大廳斷言 → 點遊戲卡片 → 遊戲分頁 → Quick Join → 進機台 → 機台內功能
 *
 * ⚠️ **第一顆一定是 `goto`**：agent 開的是 about:blank，`startUrl` 是 goto 積木的預設目標。
 *    少了它，全部積木會在空白頁上跑完（選擇器全 0、網路 0 筆），看起來像網站掛了。
 * ⚠️ **不要自己從卡片列表挑「看起來沒人」的機台**——卡片 badge 讀不到，實測會挑到 Occupied。
 *    用 Quick Join 讓系統挑。
 * ⚠️ **沒有按 `.btn_play`（帶入 Credits）也沒有按 SPIN**：那會動到餘額，等使用者確認。
 */
const BASE = process.env.BASE ?? 'http://localhost:3000'
const AGENT = process.env.AGENT_ID ?? ''
const URL_H5 = process.env.H5_URL ?? ''
const COOKIE = process.env.COOKIE ?? ''
const NAME = process.env.SCRIPT_NAME ?? 'H5 完整流程（大廳→機台→機台內功能）'

const j = async (path, init) => {
  const res = await fetch(BASE + path, { ...init, headers: { ...(init?.headers ?? {}), ...(COOKIE ? { cookie: COOKIE } : {}) } })
  const text = await res.text()
  try { return { status: res.status, body: JSON.parse(text) } } catch { return { status: res.status, body: text.slice(0, 300) } }
}
const post = (path, data) => j(path, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(data) })

const steps = [
  { action: 'goto', name: '開啟 H5 大廳' },
  { action: 'wait', value: '12000', name: '等大廳載入' },

  // ── 大廳 ────────────────────────────────────────────────────────────────
  { action: 'assert_visible', selector: '.grid-item-name', name: '大廳有機台卡片' },
  { action: 'assert_visible', selector: '.section-title', name: '大廳有分區標題' },
  { action: 'screenshot', name: '大廳畫面' },

  // ── 進機台：卡片 → Game Preview → Quick Join ──────────────────────────
  { action: 'click', selector: '.grid-item >> nth=0', name: '點第一張遊戲卡片' },
  { action: 'wait', value: '9000', name: '等遊戲分頁' },
  { action: 'screenshot', name: '遊戲分頁' },
  { action: 'click', selector: ':text-is("Quick Join")', name: 'Quick Join 自動配台' },
  { action: 'wait', value: '15000', name: '等機台載入' },
  { action: 'screenshot', name: '進到機台' },

  // ── 機台內功能（選擇器是現場量的）──────────────────────────────────────
  { action: 'assert_visible', selector: '.video_cctv', name: '機台內：CCTV 畫面' },
  { action: 'assert_visible', selector: '.gm-info-watch', name: '機台內：觀看人數' },
  { action: 'assert_visible', selector: '.btn_cashout', name: '機台內：Cash Out 按鈕' },
  { action: 'assert_visible', selector: '.btn_help', name: '機台內：說明按鈕' },
  { action: 'assert_visible', selector: '.road', name: '機台內：路單' },
  { action: 'assert_visible', selector: '.btn_bet', name: '機台內：面額按鈕' },
  { action: 'assert_visible', selector: '.btn_play', name: '機台內：帶入額度按鈕' },
  { action: 'assert_visible', selector: '.header_btn_item_deposit', name: '機台內：Top Up' },
  /**
   * ⚠️ **進機台之後控制列是被「SELECT A DENOMINATION」面板蓋住的**，
   *    `.btn_help` 讀得到（assert 命中 1 個）但**點不下去**——實測 timeout 10 秒。
   *    要先選面額，面板收起來之後下面那排才真的能按。
   *    「看得到」跟「點得到」是兩件事，這裡就是活例子。
   * ⚠️ 選面額本身不會動到餘額；**動到餘額的是 `.btn_play`（帶入 Credits）**，沒有按。
   */
  { action: 'click', selector: '.btn_bet >> nth=1', name: '選面額 ₱2' },
  { action: 'wait', value: '6000', name: '等面額面板收起' },
  { action: 'screenshot', name: '選完面額' },

  { action: 'click', selector: '.btn_help >> nth=0', name: '打開說明' },
  { action: 'wait', value: '4000', name: '等說明開啟' },
  { action: 'screenshot', name: '說明畫面' },
]

const main = async () => {
  const created = await post('/api/frontend-auto/runs', {
    platform: 'h5', scriptName: NAME, ranBy: 'claude-osm', totalSteps: steps.length, result: 'running',
  })
  const runId = created.body?.run?.id
  console.log(JSON.stringify({ step: 'create', status: created.status, runId }))
  if (!runId) return

  const exec = await post(`/api/frontend-auto/runs/${runId}/execute`, {
    steps: JSON.stringify(steps), url: URL_H5, platform: 'h5',
    resolution: '500x877', failureMode: 'continue', headed: true, agentId: AGENT,
  })
  console.log(JSON.stringify({ step: 'execute', status: exec.status, body: exec.body }))
  if (exec.status !== 200) return

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 6000))
    const run = await j(`/api/frontend-auto/runs/${runId}`)
    const r = run.body?.run ?? run.body
    if (r?.finished_at || (r?.result && !['running', 'unknown'].includes(r.result))) {
      console.log(JSON.stringify({ result: r.result, passed: r.passed, failed: r.failed, skipped: r.skipped }))
      break
    }
  }
  console.log('runId=' + runId)
}
main().catch(e => console.log('FATAL', String(e).slice(0, 300)))
