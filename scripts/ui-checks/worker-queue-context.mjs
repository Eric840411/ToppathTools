// Bottleneck 排隊的工作會沿用「前一個工作」的 AsyncLocalStorage context。
// worker.ts 的 HTTP 佇列與 Gemini key 佇列都要把 callback 綁回呼叫端自己的 context，
// 否則排在後面的 request 會拿到別人的身分（2026-11-06：hub-dispatch／hub-stop 間歇 401「請先選擇帳號」）。
//
// ① 證明不綁一定會錯（不然 ② 的檢查沒有意義）
// ② 原始碼：兩個佇列都要經過 AsyncResource.bind
import Bottleneck from 'bottleneck'
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks'
import { readFileSync } from 'node:fs'

const fails = []
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) fails.push(name) }

const als = new AsyncLocalStorage()
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function run(bind) {
  const q = new Bottleneck({ maxConcurrent: 1 })
  const seen = {}
  const req = (who, ms) => als.run({ who }, () => {
    const next = () => { seen[who] = als.getStore()?.who }
    const go = bind ? AsyncResource.bind(next) : next
    return q.schedule(async () => { go(); await sleep(ms) })
  })
  await Promise.all([req('agent', 30), req('eric', 1), req('siara', 1)])
  return seen
}
const plain = await run(false)
check('不綁：排在後面的 request 拿到前一個的身分（前提成立）', plain.eric === 'agent' && plain.siara === 'agent', JSON.stringify(plain))
const bound = await run(true)
check('綁回：每個 request 都是自己的身分', bound.agent === 'agent' && bound.eric === 'eric' && bound.siara === 'siara', JSON.stringify(bound))

const strip = s => s.replace(/\/\/[^\r\n]*/g, '')
const worker = strip(readFileSync(new URL('../../server/worker.ts', import.meta.url), 'utf8'))
const qStart = worker.indexOf('function shouldQueueRequest')
const qBlock = worker.slice(qStart, worker.indexOf('app.use(gameshowRouter)', qStart))
check('worker HTTP 佇列：next() 經過 AsyncResource.bind', /const resume = AsyncResource\.bind\(\(\) => next\(\)\)/.test(qBlock) && /\bresume\(\)/.test(qBlock) && !/^\s*next\(\)\s*$/m.test(qBlock.slice(qBlock.indexOf('workerQueue.schedule'))))

const gemini = strip(readFileSync(new URL('../../server/routes/gemini.ts', import.meta.url), 'utf8'))
check('Gemini key 佇列：callback 經過 AsyncResource.bind', /getKeyLimiter\(primaryKey\)\.schedule\(AsyncResource\.bind\(/.test(gemini))

if (fails.length) { console.error(`FAIL ${fails.length}`); process.exit(1) }
console.log('ALL PASS')
