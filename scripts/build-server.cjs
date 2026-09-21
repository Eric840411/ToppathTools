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
