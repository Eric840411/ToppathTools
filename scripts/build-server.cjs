const { existsSync, mkdirSync, rmSync, writeFileSync } = require('fs')
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

if (result.status !== 0) {
  const logDir = join(root, 'logs')
  mkdirSync(logDir, { recursive: true })
  const logPath = join(logDir, 'server-typecheck.log')
  writeFileSync(logPath, output, 'utf8')
  console.warn(`[build:server] TypeScript reported type errors, but compiled server JS was emitted. Details: ${logPath}`)
}
