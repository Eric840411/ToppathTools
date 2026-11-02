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
  const R = (p: string, cur: string | null = 'v1') => resolveOfficePath(base, p, cur)
  const file = (p: string) => { const t = R(p); return t.kind === 'file' ? t.file : t.kind }
  const V = '/office/v/v1/word'
  eq('根目錄補 index.html', file(`${V}/`), join(wordRoot, 'index.html'))
  eq('子目錄', file(`${V}/snippets/a.js`), join(wordRoot, 'snippets', 'a.js'))
  eq('大小寫 app 名', file('/OFFICE/V/v1/Word/'), join(wordRoot, 'index.html'))
  eq('少結尾斜線→導向', R(V), { kind: 'redirect', to: `${V}/` })
  eq('入口導到目前版本', R('/office/word/'), { kind: 'redirect', to: `${V}/` })
  eq('入口保留子路徑', R('/office/word/snippets/a.js'), { kind: 'redirect', to: `${V}/snippets/a.js` })
  eq('入口少斜線', R('/office/word'), { kind: 'redirect', to: `${V}/` })
  eq('沒部署', R('/office/word/', null), { kind: 'undeployed' })
  eq('不存在的版本', file('/office/v/v9/word/'), 'notfound')
  eq('版本名穿越', file('/office/v/../word/'), 'notfound')
  eq('版本名 %2e%2e', file('/office/v/%2e%2e/word/'), 'notfound')
  eq('sw.js 換成退役版', R(`${V}/sw.js`), { kind: 'sw' })
  eq('sw.js 不登入也要拿得到（不管版本存不存在）', R('/office/v/v9/effect/sw.js', null), { kind: 'sw' })
  eq('不在清單的 app', file('/office/secret/'), 'notfound')
  eq('版本裡不在清單的 app', file('/office/v/v1/secret/'), 'notfound')
  eq('/office 本身', file('/office'), 'notfound')
  eq('../ 跳出 app', file(`${V}/../film/index.html`), 'notfound')
  eq('%2e%2e 跳出', file(`${V}/%2e%2e/%2e%2e/%2e%2e/secret.txt`), 'notfound')
  eq('%2F 夾帶分隔字元', file(`${V}/..%2F..%2F..%2Fsecret.txt`), 'notfound')
  eq('%5C 反斜線', file(`${V}/..%5C..%5C..%5Csecret.txt`), 'notfound')
  eq('NUL', file(`${V}/a%00.js`), 'notfound')
  eq('磁碟代號', file(`${V}/C:`), 'notfound')
  eq('壞掉的編碼', file(`${V}/%E0%A4%A`), 'notfound')
  eq('空段', file(`${V}//a.js`), 'notfound')
  eq('正常編碼仍可用', file(`${V}/a%20b.js`), join(wordRoot, 'a b.js'))

  eq('hash 檔名', isHashedAsset('wordcraft-web-9955286efc1d1503_bg.wasm'), true)
  eq('固定檔名', isHashedAsset('sw.js'), false)
} finally {
  rmSync(base, { recursive: true, force: true })
}

console.log(`office-files: ${pass} pass, ${fails.length} fail`)
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1) }
