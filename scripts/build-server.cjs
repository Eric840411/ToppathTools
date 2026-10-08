const { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } = require('fs')
const { join } = require('path')
const { spawnSync } = require('child_process')

const root = join(__dirname, '..')
const outDir = join(root, 'dist-server')
rmSync(outDir, { recursive: true, force: true })

const command = process.platform === 'win32' ? 'cmd.exe' : 'sh'
const args = process.platform === 'win32'
  ? ['/c', 'node_modules\\.bin\\tsc.cmd -p tsconfig.server.json']
  : ['-c', 'node_modules/.bin/tsc -p tsconfig.server.json']
const result = spawnSync(command, args, {
  cwd: root,
  encoding: 'utf8',
})

const output = `${result.stdout || ''}${result.stderr || ''}`
if (result.status === 0 && output.trim()) {
  process.stdout.write(output)
}

const serverEntry = join(outDir, 'server', 'index.js')
const workerEntry = join(outDir, 'server', 'worker.js')

if (!existsSync(serverEntry) || !existsSync(workerEntry)) {
  process.exit(result.status || 1)
}

// Copy non-TS runtime files that aren't compiled by tsc
const uatRunnerSrc = join(root, 'server', 'uat-runner')
const uatRunnerDst = join(outDir, 'server', 'uat-runner')
if (existsSync(uatRunnerSrc)) {
  cpSync(uatRunnerSrc, uatRunnerDst, { recursive: true })
}

/**
 * 1008：server/ 底下**其他資料夾**的手寫 .js 也要複製（tsc 沒開 allowJs，不會輸出它們）。
 * 🚨 v5.36.0 新增 server/machine-test/ideck-button-key.js，只有 uat-runner/ 會整包複製，
 *    worker 在 04:00 排程重啟時 import 不到它 → 每次啟動就崩（本機 restart 325 次）。部署到 Spug 也會一樣。
 */
const { readdirSync, readFileSync } = require('fs')
const copyJs = (dir, rel) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const src = join(dir, e.name), r = join(rel, e.name)
    if (e.isDirectory()) { if (r !== 'uat-runner') copyJs(src, r) }
    else if (/\.(js|mjs|cjs)$/.test(e.name)) { mkdirSync(join(outDir, 'server', rel), { recursive: true }); cpSync(src, join(outDir, 'server', r)) }
  }
}
copyJs(join(root, 'server'), '')

/**
 * 守門：dist-server 裡每個相對 import 都要找得到檔案。漏一個，server／worker 就會在 import 當下崩，而且只寫在 pm2 的 error log。
 */
const missing = []
const scan = dir => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { scan(p); continue }
    if (!/\.(js|mjs)$/.test(e.name)) continue
    const src = readFileSync(p, 'utf8')
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"\n]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      const spec = m[1] || m[2]
      if (!existsSync(join(dir, spec))) missing.push(`${p.slice(outDir.length + 1)} → ${spec}`)
    }
  }
}
if (existsSync(outDir)) scan(join(outDir, 'server'))
if (missing.length) {
  console.error(`[build:server] ❌ dist-server 有 ${missing.length} 個相對 import 找不到檔案（server／worker 會在啟動時崩）：\n  ${missing.slice(0, 20).join('\n  ')}`)
  process.exit(1)
}

if (result.status !== 0) {
  const logDir = join(root, 'logs')
  mkdirSync(logDir, { recursive: true })
  const logPath = join(logDir, 'server-typecheck.log')
  writeFileSync(logPath, output, 'utf8')
  console.warn(`[build:server] TypeScript reported type errors, but compiled server JS was emitted. Details: ${logPath}`)
}

/**
 * Local Agent 的檔案白名單完整性——**建置不過就不要送出去**。
 *
 * 🚨 `agent-source-closure.mjs` 這支守門**早就存在**，2026-09-21 還是漏了三個檔案
 *    （expr.js / dangerous-actions.js / pc-node-hittest.js），使用者在 Mac 上裝 agent
 *    時才炸出 `ERR_MODULE_NOT_FOUND`。原因不是守門不夠好，是**沒人會記得去跑它**。
 *
 *    所以把它接在建置流程裡：漏加檔案 → 建置直接失敗。
 *    這個檢查是純靜態分析、不連任何服務，失敗一定代表 agent 那端會起不來。
 */
const closure = spawnSync(process.execPath, [join(root, 'scripts', 'ui-checks', 'agent-source-closure.mjs')], {
  cwd: root, encoding: 'utf8',
})
if (closure.status !== 0) {
  process.stdout.write(closure.stdout || '')
  process.stderr.write(closure.stderr || '')
  console.error('[build:server] Local Agent 檔案白名單有缺漏 —— 少送的檔案會讓 agent 在 import 當下就炸掉。')
  console.error('[build:server] 請把上面列出的檔案加進 server/routes/machine-test.ts 的 AGENT_SOURCE_WHITELIST。')
  process.exit(1)
}

/**
 * 「哪些積木一定要指定所屬 TC」前後端一致——同樣是**守門早就存在、沒人記得跑**。
 *
 * v4.244.0 加的 read_value（category 'read'）後端會擋、編輯器卻不標紅，
 * 2026-10-02 才被發現：畫面看起來沒問題，按執行才被「請指定所屬 TC」擋下來。
 */
const tsxBin = join('node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx')
const parity = spawnSync(tsxBin, [join('scripts', 'ui-checks', 'uat-tc-ownership-parity.test.ts')], {
  cwd: root, encoding: 'utf8', shell: process.platform === 'win32',
})
if (parity.status !== 0) {
  process.stdout.write(parity.stdout || '')
  process.stderr.write(parity.stderr || '')
  console.error('[build:server] BlockEditor.tsx 的 TC_REQUIRED_ACTIONS 跟 frontend-tc-engine.js 的積木分類對不上。')
  process.exit(1)
}
