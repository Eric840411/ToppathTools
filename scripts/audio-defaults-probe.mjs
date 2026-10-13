// server/machine-test/audio-defaults.ps1 探針（v5.50.4，CodeX ffb98dc [P2]）：node scripts/audio-defaults-probe.mjs
// 只能在 Windows 跑。正常讀一次＋用 -SimulateHr 模擬兩種失敗：
//   E_NOTFOUND（0x80070490）→「no default endpoint」；其他失敗（E_OUTOFMEMORY 0x8007000E）→ why 保留方法名＋HRESULT，
//   不能也被寫成 no default endpoint（原本 `|| d == null` 會在 Check(hr) 之前把所有失敗吞成同一句）
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'machine-test', 'audio-defaults.ps1')
let fail = 0, n = 0
const ok = (c, label, got) => { n++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${label}${!c && got !== undefined ? `：${JSON.stringify(got)}` : ''}`) }
const run = (...args) => JSON.parse(execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args], { encoding: 'utf8' }).trim().split(/\r?\n/).at(-1))

const real = run()
ok(real.render && real.capture && (real.render.name || real.render.why) && (real.capture.name || real.capture.why), '正常執行：播放／錄音各有名稱或原因', real)
console.log(`   這台：播放 ${real.render.name ?? real.render.why}／錄音 ${real.capture.name ?? real.capture.why}`)
const nf = run('-SimulateHr', String(0x80070490 | 0))
ok(nf.render.why === 'no default endpoint' && nf.render.name === null, 'E_NOTFOUND → no default endpoint', nf.render)
const oom = run('-SimulateHr', String(0x8007000E | 0))
ok(/GetDefaultAudioEndpoint HRESULT 0x8007000E/.test(oom.render.why ?? '') && oom.render.name === null, '⚠️ 其他失敗（E_OUTOFMEMORY）→ why 保留方法名與 HRESULT，不是 no default endpoint', oom.render)

console.log(`\n${n - fail}/${n} 通過`)
process.exit(fail ? 1 : 0)
