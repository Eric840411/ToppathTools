/**
 * safeChildPath／isSafeId 的回歸。跑法：npx tsx server/lib/safe-path.test.ts
 * 拿掉任一條檢查（分隔字元、basename、startsWith）至少會紅一條。
 */
import { join, resolve } from 'path'
import { safeChildPath, isSafeId, IMAGE_EXTS } from './safe-path.js'

let pass = 0
const fails: string[] = []
function eq(name: string, got: unknown, want: unknown) {
  if (got === want) pass++
  else fails.push(`${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
}

const base = resolve('server/python/templates')

eq('普通檔名', safeChildPath(base, 'spin.png'), join(base, 'spin.png'))
eq('中文檔名', safeChildPath(base, '開始按鈕.png'), join(base, '開始按鈕.png'))
eq('../ 解碼後', safeChildPath(base, '../data.db'), null)
eq('..\\ 解碼後', safeChildPath(base, '..\\data.db'), null)
eq('兩層', safeChildPath(base, '../../.env'), null)
eq('單獨 ..', safeChildPath(base, '..'), null)
eq('單獨 .', safeChildPath(base, '.'), null)
eq('絕對路徑', safeChildPath(base, 'C:\\Windows\\win.ini'), null)
eq('posix 絕對', safeChildPath(base, '/etc/passwd'), null)
eq('NUL', safeChildPath(base, 'a.png\x00.txt'), null)
eq('空字串', safeChildPath(base, ''), null)
eq('非字串', safeChildPath(base, undefined), null)
eq('副檔名白名單 通過', safeChildPath(base, 'a.PNG', IMAGE_EXTS), join(base, 'a.PNG'))
eq('副檔名白名單 擋 html', safeChildPath(base, 'x.html', IMAGE_EXTS), null)
eq('副檔名白名單 擋 svg', safeChildPath(base, 'x.svg', IMAGE_EXTS), null)
eq('副檔名白名單 擋無副檔名', safeChildPath(base, 'data', IMAGE_EXTS), null)

eq('id 正常', isSafeId('WLZB_HELIX-9'), true)
eq('id 斜線', isSafeId('../../dist/x'), false)
eq('id 點', isSafeId('A.B'), false)
eq('id 空', isSafeId(''), false)
eq('id 太長', isSafeId('A'.repeat(65)), false)

console.log(`safe-path: ${pass} pass, ${fails.length} fail`)
if (fails.length) { for (const f of fails) console.log('  FAIL', f); process.exit(1) }
