// 把 craft-office 的 web build 打包成一個文書工具版本（docs/features/34-office.md）。
// 在有 craft-office 的開發機上跑：
//   node scripts/office/pack-release.mjs <craft-office/live 目錄> [版本名]
// 產出 office-release/<版本名>/<app>/…（每個可壓縮檔旁邊多一份 .gz）與 office-release/<版本名>.tar.gz，
// 再把 tar.gz 傳到 Spug、用 install-release.sh 裝。
//
// ⚠️ 只收 OFFICE_APPS 裡的目錄名；live 底下多出來的東西不會被帶上去。
// ⚠️ 不即時壓縮：伺服器只送現成的 .gz（WASM 動輒幾十 MB，每次請求現壓會把 CPU 吃滿）。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'

const APPS = ['word', 'excel', 'ppt', 'pdf', 'photo', 'light', 'vector', 'design', 'fig', 'cad', 'film', 'effect', 'sound']
const GZIP_EXTS = new Set(['.html', '.js', '.mjs', '.wasm', '.css', '.json', '.svg', '.webmanifest'])

const [srcArg, nameArg] = process.argv.slice(2)
if (!srcArg) {
  console.error('用法：node scripts/office/pack-release.mjs <craft-office/live 目錄> [版本名]')
  process.exit(2)
}
const src = path.resolve(srcArg)
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
const name = nameArg || `r${stamp}`
if (!/^[A-Za-z0-9._-]{1,64}$/.test(name) || name === '.' || name === '..') {
  console.error(`版本名只能用英數、點、底線、連字號：${name}`)
  process.exit(2)
}
const outRoot = path.resolve('office-release')
const out = path.join(outRoot, name)
if (fs.existsSync(out)) {
  console.error(`已經有這個版本：${out}（版本目錄不覆寫，換一個名字）`)
  process.exit(1)
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true })
  let files = 0, bytes = 0, gz = 0
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, ent.name)
    const b = path.join(to, ent.name)
    const st = fs.statSync(a) // 跟著 junction／symlink 走
    if (st.isDirectory()) {
      const r = copyTree(a, b); files += r.files; bytes += r.bytes; gz += r.gz
    } else if (st.isFile()) {
      if (ent.name.endsWith('.gz')) continue
      fs.copyFileSync(a, b)
      files++; bytes += st.size
      if (GZIP_EXTS.has(path.extname(ent.name).toLowerCase())) {
        fs.writeFileSync(b + '.gz', zlib.gzipSync(fs.readFileSync(a), { level: 9 }))
        gz++
      }
    }
  }
  return { files, bytes, gz }
}

const missing = []
for (const app of APPS) {
  const from = path.join(src, app)
  if (!fs.existsSync(path.join(from, 'index.html'))) { missing.push(app); continue }
  const r = copyTree(from, path.join(out, app))
  console.log(`${app.padEnd(7)} ${String(r.files).padStart(4)} 檔  ${(r.bytes / 1048576).toFixed(1).padStart(6)} MB  .gz ${r.gz}`)
}
if (missing.length === APPS.length) {
  console.error(`在 ${src} 底下一個工具都沒找到（要指到 craft-office/live）`)
  fs.rmSync(out, { recursive: true, force: true })
  process.exit(1)
}
if (missing.length) console.log(`沒有 build、這版不含：${missing.join(', ')}`)

const tarball = path.join(outRoot, `${name}.tar.gz`)
// 用相對路徑＋cwd：Git Bash 的 GNU tar 會把 `C:\…` 的冒號當成遠端主機
execFileSync('tar', ['-czf', `${name}.tar.gz`, name], { cwd: outRoot, stdio: 'inherit' })
console.log(`\n版本 ${name}\n目錄 ${out}\n打包 ${tarball}（${(fs.statSync(tarball).size / 1048576).toFixed(1)} MB）`)
