// 全站掃描：找出「修仙版視覺效果」四類效果的落點
//   ① 文字浮現  ② 靈光(hover)  ③ 陣法紋(loading/empty)  ④ 卡片光暈
// 純靜態分析，不連服務。輸出 JSON + 人看的摘要。
import { readFileSync, writeFileSync } from 'node:fs'
import { globSync } from 'node:fs'

const files = globSync('src/**/*.tsx')

// className="..." / className={`...`} 兩種寫法都要抓
const CLASS_RE = /className=(?:"([^"]*)"|\{`([^`]*)`\})/g

const buckets = {
  rune:   { label: '③ 陣法紋', re: /(^|[-_])(empty|loading|spinner|placeholder)([-_]|$)/i, hits: new Map() },
  aura:   { label: '② 靈光',   re: /(^|[-_])(card|row|item|tile|badge|chip|entry)([-_]|$)/i, hits: new Map() },
  glow:   { label: '④ 卡片光暈', re: /(^|[-_])(hero|quote|panel|banner|summary)([-_]|$)/i, hits: new Map() },
}

const xianxiaGated = new Set()
for (const f of files) {
  const src = readFileSync(f, 'utf8')
  if (/themeMode\s*===\s*'xianxia'/.test(src)) xianxiaGated.add(f)
  for (const m of src.matchAll(CLASS_RE)) {
    const raw = (m[1] ?? m[2] ?? '')
    for (const cls of raw.split(/[\s${}?:'"()|&+]+/).filter(c => /^[a-z][a-z0-9-]*$/.test(c))) {
      for (const b of Object.values(buckets)) {
        if (!b.re.test(cls)) continue
        if (!b.hits.has(cls)) b.hits.set(cls, new Set())
        b.hits.get(cls).add(f)
      }
    }
  }
}

// 這些 class 有沒有已經在 xianxia-complete.css 被處理過
const xxCss = readFileSync('public/xianxia-complete.css', 'utf8')
const report = {}
for (const [k, b] of Object.entries(buckets)) {
  report[k] = [...b.hits.entries()]
    .map(([cls, fs]) => ({ cls, files: [...fs].sort(), n: fs.size, inXxCss: xxCss.includes('.' + cls) }))
    .sort((a, z) => z.n - a.n || a.cls.localeCompare(z.cls))
}
report._meta = { tsxFiles: files.length, xianxiaGatedFiles: [...xianxiaGated].sort() }
writeFileSync('.tmp-xianxia-fx-scan.json', JSON.stringify(report, null, 2))

for (const [k, b] of Object.entries(buckets)) {
  const rows = report[k]
  const todo = rows.filter(r => !r.inXxCss)
  console.log(`\n${b.label}  共 ${rows.length} 種 class，其中 ${todo.length} 種尚未在 xianxia-complete.css 出現`)
  for (const r of rows.slice(0, 18)) {
    console.log(`  ${r.inXxCss ? '已有' : '待做'}  ${r.cls.padEnd(34)} ${r.n} 處`)
  }
  if (rows.length > 18) console.log(`  … 另外 ${rows.length - 18} 種`)
}
console.log(`\n掃描 ${files.length} 個 tsx；其中 ${xianxiaGated.size} 個已有 themeMode==='xianxia' 分支`)
