/**
 * 文書工具靜態檔解析的回歸。跑法：npx tsx server/office-files.test.ts
 * 拿掉逐段解碼後的檢查、appRoot 前綴檢查、CURRENT 名稱檢查，至少各會紅一條。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { availableApps, currentReleaseDir, isHashedAsset, resolveOfficePath } from './office-files.js'

let pass = 0
const fails: string[] = []
function eq(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else fails.push(`${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
}

const base = mkdtempSync(join(tmpdir(), 'office-test-'))
try {
  const rel = join(base, 'releases', 'v1')
  mkdirSync(join(rel, 'word', 'snippets'), { recursive: true })
  writeFileSync(join(rel, 'word', 'index.html'), '<html></html>')
  mkdirSync(join(rel, 'film'), { recursive: true }) // 沒有 index.html：不算有部署
  writeFileSync(join(base, 'secret.txt'), 'x')

  // ── CURRENT 指標 ──
  eq('沒有 CURRENT', currentReleaseDir(base), null)
  writeFileSync(join(base, 'CURRENT'), 'v1\n')
  eq('正常', currentReleaseDir(base)?.name, 'v1')
  writeFileSync(join(base, 'CURRENT'), '../..')
  eq('CURRENT 指到外面', currentReleaseDir(base), null)
  writeFileSync(join(base, 'CURRENT'), '..')
  eq('CURRENT 是 ..', currentReleaseDir(base), null)
  writeFileSync(join(base, 'CURRENT'), 'v2')
  eq('CURRENT 指到不存在的版本', currentReleaseDir(base), null)
  writeFileSync(join(base, 'CURRENT'), 'v1')

  eq('只列有 index.html 的工具', availableApps(rel).map(a => a.id), ['word'])

  // ── 路徑解析 ──
  const wordRoot = resolve(rel, 'word')
  const file = (p: string) => { const t = resolveOfficePath(rel, p); return t.kind === 'file' ? t.file : t.kind }
  eq('根目錄補 index.html', file('/office/word/'), join(wordRoot, 'index.html'))
  eq('子目錄', file('/office/word/snippets/a.js'), join(wordRoot, 'snippets', 'a.js'))
  eq('大小寫 app 名', file('/OFFICE/Word/'), join(wordRoot, 'index.html'))
  eq('少結尾斜線→導向', resolveOfficePath(rel, '/office/word'), { kind: 'redirect', to: '/office/word/' })
  eq('不在清單的 app', file('/office/secret/'), 'notfound')
  eq('/office 本身', file('/office'), 'notfound')
  eq('../ 跳出 app', file('/office/word/../film/index.html'), 'notfound')
  eq('%2e%2e 跳出', file('/office/word/%2e%2e/%2e%2e/secret.txt'), 'notfound')
  eq('%2F 夾帶分隔字元', file('/office/word/..%2F..%2Fsecret.txt'), 'notfound')
  eq('%5C 反斜線', file('/office/word/..%5C..%5Csecret.txt'), 'notfound')
  eq('NUL', file('/office/word/a%00.js'), 'notfound')
  eq('磁碟代號', file('/office/word/C:'), 'notfound')
  eq('壞掉的編碼', file('/office/word/%E0%A4%A'), 'notfound')
  eq('空段', file('/office/word//a.js'), 'notfound')
  eq('正常編碼仍可用', file('/office/word/a%20b.js'), join(wordRoot, 'a b.js'))

  eq('hash 檔名', isHashedAsset('wordcraft-web-9955286efc1d1503_bg.wasm'), true)
  eq('固定檔名', isHashedAsset('sw.js'), false)
} finally {
  rmSync(base, { recursive: true, force: true })
}

console.log(`office-files: ${pass} pass, ${fails.length} fail`)
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1) }
