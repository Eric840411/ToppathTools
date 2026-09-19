/**
 * scripts/ui-checks/jackpot-watch-threshold.mjs
 *
 * 驗 Jackpot 監控的門檻來源解析（`server/lib/osm-watch.ts` + `server/lib/jp-threshold.ts`）。
 *
 * ⚠️ **這條線要守的是「門檻來自哪裡」這件事本身，不是算術。**
 *    使用者的痛點是：第一版看的是我們自己填的門檻，而真正控制辨識取值範圍的是
 *    辨識機上的 list.json——所以「用錯來源」與「把兩種失敗講成同一句話」才是這裡的 bug 形狀，
 *    而它們**全都不會讓程式壞掉**，只會讓畫面看起來一切正常。
 *
 * 最硬的幾條：
 *   ① 有 list.json 值時**不准**用手動／預設；手動不一致要標出來而不是被蓋掉
 *   ② 多台辨識機衝突時**不准合成**一個範圍（取最寬會放過辨識異常）
 *   ③ 「來源未提供」與「這次沒抓到」**不准**是同一個 flag（一個修不好、一個修得好）
 *   ④ 舊快取不准標成當下的設定值
 *
 * 跑法：npx tsx scripts/ui-checks/jackpot-watch-threshold.mjs
 */
import path from 'path'
import { pathToFileURL, fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const { buildWatchIndex, lookupWatchEntry, gameCodeOf } = await import(
  pathToFileURL(path.join(root, 'server/lib/osm-watch.ts')).href)
const { resolveJpThreshold, describeThreshold, summarizeCoverage } = await import(
  pathToFileURL(path.join(root, 'server/lib/jp-threshold.ts')).href)

// ── 測試資料：照真實 list.json 的形狀捏的 ────────────────────────────────────
// RISINGROCKETS = 正常兩層；ALLABOARD = 只有上界（真實資料就是這樣）；
// MOREPUFF = 兩台辨識機給不同範圍（真實資料有 4 組這種）；LIONLINK = 完全沒設。
const RAW = {
  gathered_at: '2026-09-18T00:00:00Z',
  server_count: 2,
  servers: {
    'Image-Recon-CP-1': {
      list_json: {
        ossAccessKeySecret: 'SHOULD-NEVER-LEAK',
        pool: [
          { channel: 'channel4171', high: 3000000, low: 1000000, mhigh: 10000000, mlow: 100000,
            gamelist: [{ id: '4171-RISINGROCKETS-0246' }, { id: '4171-RISINGROCKETS-0251' }] },
          { channel: 'channel4171', high: 200000000,
            gamelist: [{ id: '4171-ALLABOARD-0301' }] },
          { channel: 'channel4171', high: 6000000, low: 3000000,
            gamelist: [{ id: '4171-MOREPUFF-0401' }] },
          { channel: 'channel4171',
            gamelist: [{ id: '4171-LIONLINK-0501' }] },
          { channel: 'channel4171', high: 5555555, low: 555555,
            gamelist: [{ id: '4171-CROSSCHAN-0888' }] },
        ],
      },
    },
    'Image-Recon-CP-2': {
      list_json: {
        pool: [
          { channel: 'channel4171', high: 20000000, low: 8000000,
            gamelist: [{ id: '4171-MOREPUFF-0402' }] },
          // 別的 channel。⚠️ 比對**不看 channel**，所以這台也要查得到
          { channel: 'channel4182', high: 9000000, low: 2000000, mhigh: 50000, mlow: 5000,
            gamelist: [{ id: '4182-OTHERCHANNEL-0601' }] },
          // 同機種出現在不同 channel 且值不同 → 必須判衝突，不可以挑一個
          { channel: 'channel4182', high: 7777777, low: 1111111,
            gamelist: [{ id: '4182-CROSSCHAN-0999' }] },
        ],
      },
    },
  },
}

const index = buildWatchIndex(RAW)
const DEFAULTS = { grand: { min: 1_000_000, max: 999_999_999 }, major: { min: 1_000, max: 999_999_999 }, mini: { min: 10, max: 9_999_999 } }

const entryOf = (gameid, idx = index) => lookupWatchEntry(idx, gameid)

/** 受測的解析：包一層，讓突變體可以替換掉 resolveJpThreshold */
function makeResolve(fn) {
  return (opts) => fn({
    level: opts.level ?? 'grand',
    // role 由每款遊戲的設定決定；測試沿用預設對應（grand→top、major→second、其餘 null）
    role: opts.role !== undefined ? opts.role
      : (opts.level ?? 'grand') === 'grand' ? 'top'
      : (opts.level ?? 'grand') === 'major' ? 'second' : null,
    entry: opts.entry === undefined ? entryOf(opts.gameid ?? 'osmrisingrockets') : opts.entry,
    manual: opts.manual ?? null,
    defaults: DEFAULTS[opts.level ?? 'grand'] ?? DEFAULTS.grand,
    watchStale: opts.watchStale ?? false,
    watchNever: opts.watchNever ?? false,
  })
}

const ASSERTS = [
  ['索引：ALLABOARD 只有上界那筆抓得到', () => {
    const e = entryOf('osmallaboard')
    return e && e.grand.max === 200000000 && e.grand.min === undefined
  }],
  // ⚠️ 使用者 2026-09-18 定案：比對不看 channel（兩邊的 channel 不是同一個維度）
  ['別的 channel 的機種也查得到（比對不綁 channel）', () => {
    const e = entryOf('osmotherchannel')
    return e !== null && e.grand.min === 2000000 && e.grand.max === 9000000
  }],
  ['同機種跨 channel 值不同 → 判衝突，不可以挑一個', () => {
    const e = entryOf('osmcrosschan')
    return e !== null && e.grandConflict === true && e.grand === null
        && e.channels.includes('channel4171') && e.channels.includes('channel4182')
  }],
  // ① 有 list.json 值就不准用手動／預設
  ['list.json 有值時來源是 watch，不是 manual', r => {
    const t = r({ gameid: 'osmrisingrockets', manual: { min: 7, max: 8 } })
    return t.min === 1000000 && t.max === 3000000 && t.minSource === 'watch' && t.maxSource === 'watch'
  }],
  ['手動值與 list.json 不一致要標 manual_mismatch（不是被靜默蓋掉）', r =>
    r({ gameid: 'osmrisingrockets', manual: { min: 7, max: 8 } }).flags.includes('manual_mismatch')],
  ['手動值與 list.json 一致時不標 mismatch', r =>
    !r({ gameid: 'osmrisingrockets', manual: { min: 1000000, max: 3000000 } }).flags.includes('manual_mismatch')],
  // ② 衝突不合成
  ['衝突時不合成範圍，退回手動／預設並標 watch_conflict', r => {
    const t = r({ gameid: 'osmmorepuff', manual: { min: 111, max: 222 } })
    return t.flags.includes('watch_conflict') && t.min === 111 && t.max === 222
        && t.minSource === 'manual' && t.maxSource === 'manual'
  }],
  ['衝突時不得產生「最寬」範圍（3,000,000–20,000,000）', r => {
    const t = r({ gameid: 'osmmorepuff' })
    return !(t.min === 3000000 && t.max === 20000000)
  }],
  // ③ 兩種失敗要分開
  ['來源未提供 → watch_missing（不是 watch_unavailable）', r => {
    const t = r({ gameid: 'osmlionlink' })
    return t.flags.includes('watch_missing') && !t.flags.includes('watch_unavailable')
  }],
  ['從沒抓到過 list.json → watch_unavailable（不是 watch_missing）', r => {
    const t = r({ gameid: 'osmrisingrockets', watchNever: true, entry: null })
    return t.flags.includes('watch_unavailable') && !t.flags.includes('watch_missing')
  }],
  ['list.json 裡沒有這個機種 → watch_unmatched', r =>
    r({ entry: null }).flags.includes('watch_unmatched')],
  // ④ 舊快取
  ['沿用舊快取時來源是 watch_stale 且標 watch_unavailable', r => {
    const t = r({ gameid: 'osmrisingrockets', watchStale: true })
    return t.minSource === 'watch_stale' && t.flags.includes('watch_unavailable')
  }],
  // 單邊
  ['只設上界時：上界用 watch、下界用預設，標 half_range', r => {
    const t = r({ gameid: 'osmallaboard' })
    return t.max === 200000000 && t.maxSource === 'watch'
        && t.min === DEFAULTS.grand.min && t.minSource === 'default'
        && t.flags.includes('half_range')
  }],
  // 層級
  ['沒指定為最大／第二大的等級標 watch_not_applicable 且不套用最大池的範圍', r => {
    const t = r({ gameid: 'osmrisingrockets', level: 'mini', role: null })
    return t.flags.includes('watch_not_applicable') && t.min === DEFAULTS.mini.min && t.max === DEFAULTS.mini.max
  }],
  // ⚠️ 哪一層是「最大獎池」由每款遊戲設定，**不是看等級名稱**（使用者 2026-09-18：
  //    有些遊戲最大的是 Fortunate、有些沒有 Fortunate）。這兩條就是在釘這件事。
  ['Fortunate 被指定為最大池時，讀的是 high/low', r => {
    const t = r({ gameid: 'osmrisingrockets', level: 'fortunate', role: 'top' })
    return t.min === 1000000 && t.max === 3000000 && t.minSource === 'watch'
  }],
  ['Grand 被指定為第二池時，讀的是 mhigh/mlow', r => {
    const t = r({ gameid: 'osmrisingrockets', level: 'grand', role: 'second' })
    return t.min === 100000 && t.max === 10000000 && t.minSource === 'watch'
  }],
  // 配對
  ['gameid → 機種代號只做去前綴，不模糊比對（osmdfdc 配不到 DFDCGRAND）', () => {
    if (gameCodeOf('osmrisingrockets') !== 'RISINGROCKETS') return false
    const raw = { servers: { S: { list_json: { pool: [{ channel: 'channel4171', high: 9, low: 1, gamelist: [{ id: '4171-DFDCGRAND-0001' }] }] } } } }
    return lookupWatchEntry(buildWatchIndex(raw), 'osmdfdc') === null
  }],
  // 覆蓋率
  ['覆蓋率分母是監控對象，list.json 沒有的機種也要算進去', () => {
    const rows = [
      { gameid: 'a', role: 'top', source: 'watch', flags: [] },
      { gameid: 'a', role: 'second', source: 'watch', flags: [] },
      { gameid: 'b', role: 'top', source: 'default', flags: ['watch_unmatched'] },
      { gameid: 'b', role: 'second', source: 'default', flags: ['watch_unmatched'] },
      { gameid: 'c', role: 'top', source: 'watch', flags: [] },
      { gameid: 'c', role: 'second', source: 'default', flags: ['watch_missing'] },
    ]
    const s = summarizeCoverage(rows)
    return s.games === 3 && s.full === 1 && s.partial === 1 && s.none === 1 && s.unmatched === 1
  }],
  ['覆蓋率不把「沒指定為最大／第二大」的等級算進分母', () => {
    const rows = [
      { gameid: 'a', role: 'top', source: 'watch', flags: [] },
      { gameid: 'a', role: 'second', source: 'watch', flags: [] },
      { gameid: 'a', role: null, source: 'default', flags: ['watch_not_applicable'] },
    ]
    return summarizeCoverage(rows).full === 1
  }],
  // 用詞（CodeX：抓得到 list.json ≠ 辨識機已載入）
  ['文案不得把 list.json 講成「實際生效」', r => {
    const texts = [
      describeThreshold(r({ gameid: 'osmrisingrockets' })),
      describeThreshold(r({ gameid: 'osmrisingrockets', watchStale: true })),
      describeThreshold(r({ gameid: 'osmlionlink' })),
    ].join(' ')
    return !texts.includes('實際生效') && texts.includes('list.json')
  }],
  ['舊快取的文案要講「上次讀取值」', r =>
    describeThreshold(r({ gameid: 'osmrisingrockets', watchStale: true })).includes('上次讀取值')],
]

let pass = 0, fail = 0
console.log('— 本體 —')
const real = makeResolve(resolveJpThreshold)
for (const [name, run] of ASSERTS) {
  let ok = false
  try { ok = run(real) === true } catch (e) { ok = false; console.log(`    (throw) ${e.message}`) }
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
  ok ? pass++ : fail++
}

/**
 * 突變體：每個都是**真的可能寫出來的版本**，而且都還會正常吐出一組上下限，
 * 畫面照樣綠燈——這正是它們危險的地方。
 */
const base = (o) => resolveJpThreshold(o)
const MUTANTS = [
  ['M1 衝突時取最寬範圍（我原本的提議，CodeX 否決）', o => {
    if (o.entry && ((o.level === 'grand' && o.entry.grandConflict) || (o.level === 'major' && o.entry.majorConflict))) {
      const src = o.entry.sources
      const lo = Math.min(...src.map(s => (o.level === 'grand' ? s.low : s.mlow) ?? Infinity))
      const hi = Math.max(...src.map(s => (o.level === 'grand' ? s.high : s.mhigh) ?? -Infinity))
      return { min: lo, max: hi, minSource: 'watch', maxSource: 'watch', flags: ['watch_conflict'], servers: [] }
    }
    return base(o)
  }, '衝突時不合成範圍，退回手動／預設並標 watch_conflict'],
  ['M2 「來源未提供」與「這次沒抓到」共用同一個 flag', o => {
    const r = base(o)
    return { ...r, flags: r.flags.map(f => (f === 'watch_missing' ? 'watch_unavailable' : f)) }
  }, '來源未提供 → watch_missing（不是 watch_unavailable）'],
  ['M3 手動設定優先（第一版的行為）', o => {
    if (o.manual) return { min: o.manual.min, max: o.manual.max, minSource: 'manual', maxSource: 'manual', flags: [], servers: [] }
    return base(o)
  }, 'list.json 有值時來源是 watch，不是 manual'],
  ['M4 舊快取照樣標成當下的設定值', o => {
    const r = base({ ...o, watchStale: false })
    return o.watchStale ? { ...r, flags: [...r.flags] } : r
  }, '沿用舊快取時來源是 watch_stale 且標 watch_unavailable'],
  ['M5 單邊缺值時整組放棄，退回預設', o => {
    const r = base(o)
    return r.flags.includes('half_range')
      ? { min: o.defaults.min, max: o.defaults.max, minSource: 'default', maxSource: 'default', flags: ['watch_missing'], servers: [] }
      : r
  }, '只設上界時：上界用 watch、下界用預設，標 half_range'],
  ['M6 手動值與 list.json 不一致時靜靜蓋掉不標', o => {
    const r = base(o)
    return { ...r, flags: r.flags.filter(f => f !== 'manual_mismatch') }
  }, '手動值與 list.json 不一致要標 manual_mismatch（不是被靜默蓋掉）'],
]

console.log('\n— 突變體（每個都必須被預期的那條抓到）—')
let killed = 0
for (const [name, mutant, expected] of MUTANTS) {
  const r = makeResolve(mutant)
  const caught = []
  for (const [aName, run] of ASSERTS) {
    let ok = false
    try { ok = run(r) === true } catch { ok = false }
    if (!ok) caught.push(aName)
  }
  const dead = caught.includes(expected)
  console.log(`  ${dead ? 'KILLED' : 'SURVIVED'}  ${name}`)
  console.log(`            ↳ 預期防線：${expected}${dead ? '（抓到）' : '（沒抓到！）'}`)
  if (dead) killed++
  else fail++
}

console.log(`\n本體 ${pass} PASS / ${fail} FAIL｜突變體 ${killed}/${MUTANTS.length} 被殺`)
process.exit(fail === 0 && killed === MUTANTS.length ? 0 : 1)
