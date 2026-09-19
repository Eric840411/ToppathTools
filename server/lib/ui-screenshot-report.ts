/**
 * UI 解析度截圖的驗收報告產生器。
 *
 * 版面在 2026-09-18 跟使用者確認過（先看總覽矩陣、再往下鑽每一組），重點是**量很大也要看得完**：
 * 一次可能是 89 個 model × 13 個解析度 ≈ 1,100 張圖。
 *
 * ⚠️ 縱軸是「**拍攝目標**」不是「model」，而且**分三段**（大廳／功能頁／機台 model）。
 *    不分段的話，大廳跟功能頁會被埋在幾十列機台裡面找不到。
 *
 * ⚠️ 這支**只組字串**，不碰檔案系統也不打網路——這樣才驗得起來
 *    （`scripts/ui-checks/ui-screenshot-report.mjs`）。IO 與上傳留在路由那層。
 */

export type ReportTone = 'ok' | 'warn' | 'err' | 'skip'

export interface ReportTask {
  gmid: string
  resolution: string
  status: string
  actual_gmid?: string | null
  error_msg?: string | null
}

export interface ReportRun {
  id: string
  agent_id?: string | null
  started_at?: number | null
  finished_at?: number | null
  options?: Record<string, unknown> | null
}

export interface ReportCell {
  resolution: string
  tone: ReportTone
  status: string
  actualGmid: string
  note: string
}

export interface ReportGroup {
  /** 任務上的原始 gmid：`__LOBBY__`／`GAME / Model`／機台號 */
  key: string
  kind: 'lobby' | 'feature' | 'model'
  game: string
  name: string
  /** 這一組實際用過的機台（可能不只一台——每張圖都可能被搶台而換台） */
  machines: string[]
  cells: ReportCell[]
  counts: Record<ReportTone, number>
  flagged: boolean
}

export interface ReportModel {
  run: ReportRun
  resolutions: string[]
  groups: ReportGroup[]
  totals: Record<ReportTone, number> & { shots: number; groups: number }
}

/**
 * 任務狀態 → 顯示色調。
 *
 * ⚠️ `popup` 不是失敗、也不是正常：它代表「拍到了，但畫面上有東西蓋住」。
 *    併進 ok 會讓被蓋住的圖混在乾淨的圖裡；併進 err 會讓人以為沒拍到。
 */
export function toneOf(status: string): ReportTone {
  if (status === 'ok') return 'ok'
  if (status === 'popup') return 'warn'
  if (status === 'err' || status === 'timeout') return 'err'
  return 'skip'
}

function classify(key: string): { kind: ReportGroup['kind']; game: string; name: string } {
  if (key === '__LOBBY__') return { kind: 'lobby', game: '', name: '大廳' }
  if (key.startsWith('__FEATURE__')) return { kind: 'feature', game: '', name: key.replace('__FEATURE__', '').replace(/^[:/]/, '') || '功能頁' }
  if (key.includes('/')) {
    const [g, m] = key.split('/')
    return { kind: 'model', game: g.trim(), name: m.trim() }
  }
  // 指定機台號的情況：機台號本身就是名字
  return { kind: 'model', game: (/^\d+-([A-Z0-9]+)-/.exec(key.toUpperCase()) ?? [])[1] ?? '', name: key }
}

const KIND_ORDER: Record<ReportGroup['kind'], number> = { lobby: 0, feature: 1, model: 2 }

export function buildReportModel(run: ReportRun, tasks: ReportTask[], resolutions: string[]): ReportModel {
  const byKey = new Map<string, ReportGroup>()
  for (const t of tasks) {
    const key = t.gmid
    let g = byKey.get(key)
    if (!g) {
      const c = classify(key)
      g = { key, ...c, machines: [], cells: [], counts: { ok: 0, warn: 0, err: 0, skip: 0 }, flagged: false }
      byKey.set(key, g)
    }
    const tone = toneOf(t.status)
    g.counts[tone]++
    const actual = (t.actual_gmid ?? '').trim()
    if (actual && actual !== '__LOBBY__' && !g.machines.includes(actual)) g.machines.push(actual)
    g.cells.push({ resolution: t.resolution, tone, status: t.status, actualGmid: actual, note: (t.error_msg ?? '').trim() })
  }

  const groups = [...byKey.values()]
  for (const g of groups) {
    // 每一列的格子照解析度順序排，缺的補上「未拍」——不補的話那一格會消失，看起來像沒這個尺寸
    const found = new Map(g.cells.map(c => [c.resolution, c]))
    g.cells = resolutions.map(r => found.get(r) ?? { resolution: r, tone: 'skip' as ReportTone, status: 'skipped', actualGmid: '', note: '' })
  }
  // ⚠️ 統計要從**補完之後的 cells** 重算，不能用前面逐筆累加的結果：
  //    補上去的「未拍」不在任務清單裡，用舊的累加值會少算——報告上的「未拍」數字會比實際少，
  //    而那正是最不該被少算的那一個。
  // ⚠️ 而且要在**排序之前**算完：排序要看 flagged，算在後面的話排序讀到的全是 false，
  //    有問題的那幾組就不會被排到前面（這個順序錯誤是測試抓出來的）
  const totals = { ok: 0, warn: 0, err: 0, skip: 0, shots: 0, groups: groups.length }
  for (const g of groups) {
    g.counts = { ok: 0, warn: 0, err: 0, skip: 0 }
    for (const c of g.cells) g.counts[c.tone]++
    g.flagged = g.counts.warn > 0 || g.counts.err > 0 || g.counts.skip > 0
    for (const tone of ['ok', 'warn', 'err', 'skip'] as ReportTone[]) totals[tone] += g.counts[tone]
  }

  groups.sort((a, b) =>
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    Number(b.flagged) - Number(a.flagged) ||
    a.key.localeCompare(b.key))
  totals.shots = totals.ok + totals.warn + totals.err + totals.skip
  return { run, resolutions, groups, totals }
}

// ─── HTML ─────────────────────────────────────────────────────────────────────

const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))

const TONE_LABEL: Record<ReportTone, string> = { ok: 'OK', warn: '需確認', err: '失敗', skip: '未拍' }

function fmtTime(ms?: number | null): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function fmtDuration(a?: number | null, b?: number | null): string {
  if (!a || !b || b <= a) return '—'
  const s = Math.round((b - a) / 1000)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h} 小時 ${m} 分` : `${m} 分 ${s % 60} 秒`
}

const SECTION_TITLE: Record<ReportGroup['kind'], string> = { lobby: '大廳', feature: '功能頁', model: '機台 model' }

/**
 * @param imgUrl 給一張圖的網址。回空字串代表沒有圖（會畫成佔位格）。
 *               ⚠️ 報告不內嵌原圖：1,100 張塞進單一 HTML 會大到打不開。
 */
export function renderReportHtml(model: ReportModel, opts: { imgUrl: (t: { gmid: string; resolution: string }) => string; generatedAt: number }): string {
  const { run, resolutions, groups, totals } = model
  const o = (run.options ?? {}) as Record<string, unknown>
  const mode = [
    o.autoPickByGame ? '自動選機' : '指定機台',
    o.reloadPerResolution === false ? '只改視窗大小' : '每解析度重新載入',
  ].join(' · ')

  const tiles = [
    { k: '截圖', v: totals.shots, s: `${totals.groups} 組 × ${resolutions.length} 解析度`, tone: 'accent' },
    { k: '正常', v: totals.ok, s: '畫面完整、無提示', tone: 'ok' },
    { k: '需確認', v: totals.warn, s: '有彈窗或錯誤提示', tone: 'warn' },
    { k: '失敗', v: totals.err, s: '進不去或逾時', tone: 'err' },
    { k: '未拍', v: totals.skip, s: '沒拍到的格子', tone: 'skip' },
  ].map(t => `<div class="tile" style="--tone:var(--${t.tone})"><div class="k">${esc(t.k)}</div><div class="v">${t.v.toLocaleString()}</div><div class="s">${esc(t.s)}</div></div>`).join('')

  // 總覽矩陣：一列一個拍攝目標，段與段之間插一條分隔列
  let lastKind: ReportGroup['kind'] | null = null
  const matrixRows = groups.map(g => {
    const sep = g.kind !== lastKind
      ? `<tr class="sep"><td class="name">${esc(SECTION_TITLE[g.kind])}</td><td colspan="${resolutions.length}"></td></tr>`
      : ''
    lastKind = g.kind
    const cells = g.cells.map(c =>
      `<td><i class="cell ${c.tone}" title="${esc(`${g.name} ${c.resolution} — ${TONE_LABEL[c.tone]}${c.note ? ' · ' + c.note : ''}`)}"></i></td>`).join('')
    return `${sep}<tr><td class="name"><a href="#g-${esc(slug(g.key))}">${g.game ? `<span>${esc(g.game)}</span>` : ''}${esc(g.name)}</a></td>${cells}</tr>`
  }).join('')

  const details = groups.map(g => {
    const spark = g.cells.map(c => `<i class="${c.tone}"></i>`).join('')
    const shots = g.cells.map(c => {
      const url = c.tone === 'skip' ? '' : opts.imgUrl({ gmid: g.key, resolution: c.resolution })
      const img = url
        ? `<a href="${esc(url)}" target="_blank" rel="noreferrer"><img loading="lazy" src="${esc(url)}" alt="${esc(`${g.name} ${c.resolution}`)}"></a>`
        : `<span class="ph">未拍</span>`
      const swap = c.actualGmid && g.machines.length > 1 ? `<span class="swap">@${esc(c.actualGmid.split('-').pop() ?? '')}</span>` : ''
      return `<figure class="t-${c.tone}">
        <div class="shot">${img}</div>
        <figcaption>
          <span class="res">${esc(c.resolution)}</span>
          <span class="pill">${esc(TONE_LABEL[c.tone])}</span>${swap}
          ${c.note ? `<span class="why">${esc(c.note)}</span>` : ''}
        </figcaption>
      </figure>`
    }).join('')
    const machines = g.machines.length
      ? `· ${esc(g.machines[0])}${g.machines.length > 1 ? ` <span class="swap">換過 ${g.machines.length} 台</span>` : ''}`
      : (g.kind === 'lobby' ? '' : '· 未進入任何機台')
    return `<details class="model t-${worstTone(g)}" id="g-${esc(slug(g.key))}" data-flagged="${g.flagged ? 1 : 0}"${g.flagged ? ' open' : ''}>
      <summary>
        ${g.game ? `<span class="game">${esc(g.game)}</span>` : ''}
        <span class="mname">${esc(g.name)}</span>
        <span class="mach">${machines}</span>
        <span class="spark">${spark}</span>
        <span class="count">${g.counts.ok} / ${g.cells.length} 正常</span>
      </summary>
      <div class="strip">${shots}</div>
    </details>`
  }).join('')

  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>解析度驗收報告 ${esc(run.id.slice(0, 8))}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Noto+Sans+TC:wght@400;500;700&family=Outfit:wght@500;600;700&display=swap">
<style>${REPORT_CSS}</style></head>
<body>
<div class="wrap">
  <p class="eyebrow">UI Resolution Report</p>
  <h1>解析度驗收報告</h1>
  <div class="meta">
    <span>執行 <b>${esc(fmtTime(run.started_at))}</b></span>
    <span>耗時 <b>${esc(fmtDuration(run.started_at, run.finished_at))}</b></span>
    <span>Agent <b>${esc(run.agent_id ?? '—')}</b></span>
    <span>模式 <b>${esc(mode)}</b></span>
    <span>Run <code>${esc(run.id.slice(0, 8))}</code></span>
  </div>
  <div class="tiles">${tiles}</div>

  <div class="panel">
    <div class="panel-head">
      <h2>總覽矩陣</h2>
      <span class="hint">一格＝一個拍攝目標的一個解析度；點名稱跳到下面那一組</span>
      <span class="legend">
        <span><i style="background:var(--ok)"></i>正常</span>
        <span><i style="background:var(--warn)"></i>需確認</span>
        <span><i style="background:var(--err)"></i>失敗</span>
        <span><i style="background:var(--skip);opacity:.45"></i>未拍</span>
      </span>
    </div>
    <div class="matrix-scroll"><table class="matrix">
      <thead><tr><th></th>${resolutions.map(r => `<th class="res">${esc(r)}</th>`).join('')}</tr></thead>
      <tbody>${matrixRows}</tbody>
    </table></div>
  </div>

  <div class="filters">
    <button class="chip" id="f-all" aria-pressed="true">全部 ${totals.groups} 組</button>
    <button class="chip" id="f-flagged" aria-pressed="false">只看需確認與失敗 ${groups.filter(g => g.flagged).length}</button>
    <input id="q" type="search" placeholder="搜尋遊戲或 model…" aria-label="搜尋">
    <span class="hint">有問題的預設展開，正常的收合</span>
  </div>
  ${details}

  <footer>
    <span>報告產生於 ${esc(fmtTime(opts.generatedAt))}</span>
    <span>縮圖點開為原圖（原圖存放在工具的 run 資料夾）</span>
    <span>「需確認」不代表一定有問題，是「拍的當下有東西蓋住或出現過提示」</span>
  </footer>
</div>
<script>
  const all = document.getElementById('f-all'), flagged = document.getElementById('f-flagged'), q = document.getElementById('q');
  function setMode(only) {
    document.body.classList.toggle('only-flagged', only);
    all.setAttribute('aria-pressed', String(!only));
    flagged.setAttribute('aria-pressed', String(only));
  }
  all.addEventListener('click', () => setMode(false));
  flagged.addEventListener('click', () => setMode(true));
  q.addEventListener('input', () => {
    const term = q.value.trim().toLowerCase();
    document.querySelectorAll('details.model').forEach(d => {
      const text = d.querySelector('summary').textContent.toLowerCase();
      d.style.display = !term || text.includes(term) ? '' : 'none';
    });
  });
</script>
</body></html>`
}

function worstTone(g: ReportGroup): ReportTone {
  if (g.counts.err > 0) return 'err'
  if (g.counts.warn > 0) return 'warn'
  if (g.counts.ok === 0) return 'skip'
  return 'ok'
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x'
}

const REPORT_CSS = `
:root{--paper:#F3F5F7;--card:#fff;--ink:#171A1F;--ink-soft:#5A6472;--ink-faint:#8C96A3;--rule:#DDE2E8;--accent:#1F6F68;--accent-soft:#E3EFED;--ok:#1F7A4D;--warn:#9A6410;--err:#B3372C;--skip:#6B7280;--none:#C7CDD5;--shadow:0 1px 2px rgba(16,24,40,.06),0 6px 18px rgba(16,24,40,.05)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--paper:#0F1216;--card:#161A20;--ink:#E7EBF0;--ink-soft:#A3AEBC;--ink-faint:#6C7885;--rule:#252B33;--accent:#5FCFC2;--accent-soft:#14282A;--ok:#4FBF83;--warn:#D9A441;--err:#E2685C;--skip:#7A8593;--none:#2C333C;--shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.35)}}
:root[data-theme="dark"]{--paper:#0F1216;--card:#161A20;--ink:#E7EBF0;--ink-soft:#A3AEBC;--ink-faint:#6C7885;--rule:#252B33;--accent:#5FCFC2;--accent-soft:#14282A;--ok:#4FBF83;--warn:#D9A441;--err:#E2685C;--skip:#7A8593;--none:#2C333C;--shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.35)}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:"Noto Sans TC",system-ui,-apple-system,"Segoe UI",sans-serif;font-size:15px;line-height:1.6}
.wrap{max-width:1240px;margin:0 auto;padding:30px 22px 70px}
.eyebrow{font-family:"IBM Plex Mono",monospace;font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}
h1{font-family:Outfit,"Noto Sans TC",sans-serif;font-size:clamp(25px,3.2vw,34px);font-weight:700;margin:6px 0 10px;letter-spacing:-.01em}
.meta{display:flex;flex-wrap:wrap;gap:4px 20px;color:var(--ink-soft);font-size:13px}
.meta b{color:var(--ink);font-weight:500}
code{font-family:"IBM Plex Mono",monospace;font-size:12px}
.meta code{background:var(--accent-soft);color:var(--accent);padding:1px 6px;border-radius:4px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(126px,1fr));gap:10px;margin:20px 0 6px}
.tile{background:var(--card);border:1px solid var(--rule);border-top:3px solid var(--tone,var(--rule));border-radius:10px;padding:11px 13px;box-shadow:var(--shadow)}
.tile .k{font-size:11.5px;color:var(--ink-soft)}
.tile .v{font-family:Outfit,sans-serif;font-variant-numeric:tabular-nums;font-size:25px;font-weight:600;line-height:1.15;color:var(--tone,var(--ink))}
.tile .s{font-size:11.5px;color:var(--ink-faint)}
.panel{background:var(--card);border:1px solid var(--rule);border-radius:12px;box-shadow:var(--shadow);margin-top:18px}
.panel-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 14px;padding:13px 16px;border-bottom:1px solid var(--rule)}
.panel-head h2{font-family:Outfit,"Noto Sans TC",sans-serif;font-size:15px;font-weight:600;margin:0}
.hint{font-size:12px;color:var(--ink-faint)}
.legend{margin-left:auto;display:flex;gap:12px;font-size:11.5px;color:var(--ink-soft)}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px}
.matrix-scroll{overflow-x:auto;padding:12px 16px 16px}
table.matrix{border-collapse:separate;border-spacing:3px;font-size:11.5px}
table.matrix th{font-weight:400;color:var(--ink-faint);font-family:"IBM Plex Mono",monospace;font-size:10.5px;text-align:left;white-space:nowrap;padding:0 4px}
table.matrix th.res{writing-mode:vertical-rl;transform:rotate(180deg);height:64px;padding:0}
table.matrix td.name{white-space:nowrap;padding-right:8px;font-size:12px;max-width:240px;overflow:hidden;text-overflow:ellipsis}
table.matrix td.name a{color:var(--ink);text-decoration:none}
table.matrix td.name a:hover{color:var(--accent);text-decoration:underline}
table.matrix td.name span{color:var(--ink-faint);font-family:"IBM Plex Mono",monospace;font-size:10.5px;margin-right:6px}
table.matrix tr.sep td{padding-top:10px;color:var(--accent);font-family:"IBM Plex Mono",monospace;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase}
.cell{width:17px;height:17px;border-radius:3px;background:var(--none);display:block}
.cell.ok{background:var(--ok)}.cell.warn{background:var(--warn)}.cell.err{background:var(--err)}.cell.skip{background:var(--skip);opacity:.45}
.filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:20px 0 10px}
.chip{font:500 12.5px/1 "Noto Sans TC",sans-serif;cursor:pointer;background:var(--card);color:var(--ink-soft);border:1px solid var(--rule);border-radius:999px;padding:7px 14px}
.chip[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:var(--card)}
.chip:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.filters input{flex:1 1 180px;max-width:280px;font:inherit;font-size:13px;padding:7px 12px;background:var(--card);color:var(--ink);border:1px solid var(--rule);border-radius:999px}
details.model{background:var(--card);border:1px solid var(--rule);border-radius:10px;box-shadow:var(--shadow);margin-top:8px;overflow:hidden;scroll-margin-top:12px}
details.model>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:10px;padding:11px 14px;border-left:3px solid var(--tone,var(--rule))}
details.model>summary::-webkit-details-marker{display:none}
summary .game{font-family:"IBM Plex Mono",monospace;font-size:11px;color:var(--ink-faint);min-width:118px}
summary .mname{font-weight:500}
summary .mach{font-family:"IBM Plex Mono",monospace;font-size:11.5px;color:var(--ink-soft)}
summary .spark{margin-left:auto;display:flex;gap:2px}
summary .spark i{width:9px;height:14px;border-radius:2px;background:var(--none);display:block}
summary .spark i.ok{background:var(--ok)}summary .spark i.warn{background:var(--warn)}summary .spark i.err{background:var(--err)}summary .spark i.skip{background:var(--skip);opacity:.45}
summary .count{font-family:"IBM Plex Mono",monospace;font-size:11.5px;color:var(--ink-soft);min-width:96px;text-align:right}
.strip{display:flex;gap:12px;overflow-x:auto;padding:12px 14px 16px}
figure{margin:0;flex:0 0 auto;width:132px}
.shot{height:150px;border-radius:7px;border:1px solid var(--rule);background:repeating-linear-gradient(135deg,var(--paper) 0 8px,transparent 8px 16px);display:grid;place-items:center;position:relative;overflow:hidden}
.shot::after{content:"";position:absolute;inset:0 auto 0 0;width:3px;background:var(--tone,transparent)}
.shot img{max-width:100%;max-height:100%;object-fit:contain;display:block}
.shot .ph{font-family:"IBM Plex Mono",monospace;font-size:10.5px;color:var(--ink-faint)}
figcaption{padding-top:6px;display:flex;flex-direction:column;gap:2px}
.res{font-family:"IBM Plex Mono",monospace;font-size:11.5px;font-variant-numeric:tabular-nums}
.pill{align-self:flex-start;font:500 10.5px/1 "IBM Plex Mono",monospace;padding:3px 6px;border-radius:5px;border:1px solid currentColor;color:var(--tone)}
.why{font-size:11px;color:var(--ink-soft)}
.swap{font-size:10.5px;color:var(--warn);font-family:"IBM Plex Mono",monospace}
.t-ok{--tone:var(--ok)}.t-warn{--tone:var(--warn)}.t-err{--tone:var(--err)}.t-skip{--tone:var(--skip)}
body.only-flagged details.model[data-flagged="0"]{display:none}
footer{margin-top:30px;padding-top:13px;border-top:1px solid var(--rule);font-size:12px;color:var(--ink-faint);display:flex;flex-wrap:wrap;gap:4px 18px}
`
