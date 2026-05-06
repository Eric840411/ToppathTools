/**
 * 圖片比對工具 — 前端邏輯
 * 功能：擷取兩個環境的圖片 → 自動配對 → 大小比對 → 視覺像素比對 → CSV 匯出
 */

// ═══════════════════════════════════════════════════════════════
// 狀態管理
// ═══════════════════════════════════════════════════════════════
const State = {
  sessionId:   null,
  imagesA:     [],      // HTTP 成功（200–299 圖片、或 304 快取）— 比對只用這裡
  imagesB:     [],
  failedA:     [],      // 4xx/5xx 或非 image Content-Type
  failedB:     [],
  pairs:       [],      // [{ a: idx|null, b: idx|null, diffResult: null }]
  activeTab:   'overview',
  sizeFilter:  'all',   // all | diff | smaller | larger
  visualFilter:'all',   // all | diff | unmatched
  lbIndex:     0,       // 目前 lightbox 顯示的 pair index
  visualDone:  false,   // 視覺比對是否已觸發
  manualPendingA: null, // 手動配對暫存：選中的 A 版索引
  manualPairs: [],      // [{ a, b }]  手動新增的配對
};

// ═══════════════════════════════════════════════════════════════
// 工具函式
// ═══════════════════════════════════════════════════════════════
const $ = id => document.getElementById(id);

function fmtBytes(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024)       return bytes + ' B';
  if (bytes < 1048576)    return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(2) + ' MB';
}

/** 僅加總 HTTP 成功圖片（含 304 時 size 可能為 0） */
function sumOkBytes(images) {
  return images.reduce((acc, img) => acc + (Number(img.size) || 0), 0);
}

function diffPct(a, b) {
  if (!a || !b) return null;
  return ((b - a) / a * 100).toFixed(1);
}

function showToast(msg, duration = 2500) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), duration);
}

function simColor(pct) {
  if (pct >= 98) return 'var(--green)';
  if (pct >= 85) return 'var(--yellow)';
  return 'var(--red)';
}

function simBadgeClass(pct) {
  if (pct >= 98) return 'badge-green';
  if (pct >= 85) return 'badge-yellow';
  return 'badge-red';
}

/** 縮圖：無 imgSrc（304 無 body）顯示標記 */
function thumbHtml(img, pairIdx) {
  if (!img) return '<div class="thumb-wrap"><span class="no-img">—</span></div>';
  if (!img.imgSrc) {
    const label = img.httpStatus === 304 ? '304' : '無預覽';
    return `<div class="thumb-wrap" title="無本機預覽（${img.cacheOnly ? '快取命中' : '無 buffer'}）"><span class="no-img" style="font-size:10px">${label}</span></div>`;
  }
  const click = pairIdx !== undefined ? `onclick="openLightbox(${pairIdx})"` : '';
  return `<div class="thumb-wrap" ${click}>
    <img src="${img.imgSrc}" alt="" onerror="this.parentElement.innerHTML='<span class=no-img>🖼️</span>'">
  </div>`;
}

function httpStatusCell(img) {
  if (!img) return '—';
  const s = img.httpStatus != null ? img.httpStatus : '';
  if (img.cacheOnly) return `${s} <span class="badge badge-blue" style="font-size:9px">快取</span>`;
  return String(s);
}

// ═══════════════════════════════════════════════════════════════
// 初始化 Session
// ═══════════════════════════════════════════════════════════════
async function initSession() {
  const res = await fetch('/api/session');
  const { sessionId } = await res.json();
  State.sessionId = sessionId;
}

function getCaptureMode() {
  const el = document.querySelector('input[name="captureMode"]:checked');
  return el && el.value === 'polling' ? 'polling' : 'standard';
}

function setCaptureModeDisabled(disabled) {
  const fs = $('capture-mode-fieldset');
  if (fs) fs.disabled = disabled;
  document.querySelectorAll('input[name="captureMode"]').forEach(r => { r.disabled = disabled; });
}

// ═══════════════════════════════════════════════════════════════
// 擷取圖片（SSE 串流）
// ═══════════════════════════════════════════════════════════════
function captureImages(url, side) {
  return new Promise((resolve, reject) => {
    const msgEl  = $(`prog-msg-${side.toLowerCase()}`);
    const cntEl  = $(`prog-cnt-${side.toLowerCase()}`);
    const barEl  = $(`prog-bar-${side.toLowerCase()}`);

    const animate = () => { barEl.style.width = (parseFloat(barEl.style.width || 0) + 5) + '%'; };
    const ticker  = setInterval(animate, 400);
    let lastOk   = 0;
    let lastFail = 0;

    fetch('/api/capture', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        url,
        side,
        sessionId:   State.sessionId,
        captureMode: getCaptureMode()
      })
    }).then(resp => {
      const reader  = resp.body.getReader();
      const decoder = new TextDecoder();
      let   buf     = '';

      const pump = () => reader.read().then(({ done, value }) => {
        if (done) {
          clearInterval(ticker);
          barEl.style.width = '100%';
          return;
        }
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'status') {
              msgEl.textContent = data.message;
            } else if (data.type === 'progress') {
              lastOk = data.count;
              const hs = data.httpStatus != null ? data.httpStatus : '';
              msgEl.textContent = data.note
                ? `${data.filename} · HTTP ${hs}（${data.note}）`
                : `${data.filename} · HTTP ${hs}`;
              cntEl.textContent = `成功 ${lastOk} · 失敗 ${lastFail}`;
            } else if (data.type === 'progressFail') {
              lastFail = data.countFail;
              msgEl.textContent = `失敗 ${data.filename} · HTTP ${data.httpStatus}`;
              cntEl.textContent = `成功 ${lastOk} · 失敗 ${lastFail}`;
            } else if (data.type === 'warn') {
              console.warn('[capture warn]', data.message);
            } else if (data.type === 'done') {
              clearInterval(ticker);
              barEl.style.width = '100%';
              msgEl.textContent = `✅ 成功 ${data.totalOk} · 失敗 ${data.totalFailed}`;
              cntEl.textContent = '';
              resolve({ ok: data.ok || [], failed: data.failed || [] });
              return;
            } else if (data.type === 'error') {
              clearInterval(ticker);
              msgEl.textContent = `❌ 錯誤：${data.message}`;
              reject(new Error(data.message));
              return;
            }
          } catch (_e) { /* ignore parse error */ }
        }
        pump();
      }).catch(err => {
        clearInterval(ticker);
        reject(err);
      });

      pump();
    }).catch(err => {
      clearInterval(ticker);
      reject(err);
    });
  });
}

// ═══════════════════════════════════════════════════════════════
// 自動配對邏輯（先依檔名，再依載入順序）
// ═══════════════════════════════════════════════════════════════

// 正規化檔名：去除 query string、移除動態 hash 後綴
function normalizeName(name) {
  if (!name) return '';
  return name
    .split('?')[0]
    .replace(/\.[a-z0-9]{5,}\.(webp|jpg|jpeg|png|gif|avif|svg)/i, '.$1')
    .toLowerCase()
    .trim();
}

function buildPairs(imagesA, imagesB, manualPairs = []) {
  const usedA = new Set();
  const usedB = new Set();
  const pairs = [];

  // 第一步：套用手動配對
  for (const mp of manualPairs) {
    pairs.push({ a: mp.a, b: mp.b, diffResult: null, manual: true });
    usedA.add(mp.a);
    usedB.add(mp.b);
  }

  // 第二步：依檔名精確匹配（正規化後）
  // 建立 B 版的 normalizedName → [indexList] 對應表（允許同名多張）
  const bNameMap = new Map(); // normName -> [idx, ...]
  imagesB.forEach((img, i) => {
    if (usedB.has(i)) return;
    const key = normalizeName(img.filename);
    if (!key) return;
    if (!bNameMap.has(key)) bNameMap.set(key, []);
    bNameMap.get(key).push(i);
  });

  imagesA.forEach((imgA, i) => {
    if (usedA.has(i)) return;
    const key = normalizeName(imgA.filename);
    if (!key) return;
    const candidates = bNameMap.get(key);
    if (!candidates || candidates.length === 0) return;

    const bIdx = candidates.shift(); // 取第一個可用的 B
    if (candidates.length === 0) bNameMap.delete(key);

    pairs.push({ a: i, b: bIdx, diffResult: null, manual: false });
    usedA.add(i);
    usedB.add(bIdx);
  });

  // 第三步：剩餘未配對的，依載入順序補配
  const remA = imagesA.map((_, i) => i).filter(i => !usedA.has(i));
  const remB = imagesB.map((_, i) => i).filter(i => !usedB.has(i));
  const remLen = Math.max(remA.length, remB.length);

  for (let i = 0; i < remLen; i++) {
    pairs.push({
      a: i < remA.length ? remA[i] : null,
      b: i < remB.length ? remB[i] : null,
      diffResult: null,
      manual: false
    });
  }

  // 依 A 版索引排序，保持顯示順序一致
  pairs.sort((x, y) => {
    const ai = x.a !== null ? x.a : Infinity;
    const bi = y.a !== null ? y.a : Infinity;
    return ai - bi;
  });

  return pairs;
}

// ═══════════════════════════════════════════════════════════════
// Tab 切換
// ═══════════════════════════════════════════════════════════════
function switchTab(tab) {
  State.activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `tab-${tab}`);
    panel.style.display = panel.id === `tab-${tab}` ? 'block' : 'none';
  });

  if (tab === 'visual' && !State.visualDone) {
    State.visualDone = true;
    renderVisualTab();
    scheduleDiffComputation();
  }
  if (tab === 'http') {
    renderHttpTab();
  }
}

// ═══════════════════════════════════════════════════════════════
// 總覽 Tab
// ═══════════════════════════════════════════════════════════════
function renderOverview() {
  const pairs     = State.pairs;
  const matched   = pairs.filter(p => p.a !== null && p.b !== null).length;
  const unmatchedA = pairs.filter(p => p.a !== null && p.b === null).length;
  const unmatchedB = pairs.filter(p => p.a === null && p.b !== null).length;

  // 大小異常（差異 > 20%）
  let sizeAbnormal = 0;
  for (const p of pairs) {
    if (p.a === null || p.b === null) continue;
    const ia = State.imagesA[p.a];
    const ib = State.imagesB[p.b];
    const pct = Math.abs(parseFloat(diffPct(ia.size, ib.size) || 0));
    if (pct > 20) sizeAbnormal++;
  }

  const bytesA = sumOkBytes(State.imagesA);
  const bytesB = sumOkBytes(State.imagesB);
  let volDiffLabel = '—';
  let volCardClass = 'ok';
  if (bytesA > 0) {
    const p = ((bytesB - bytesA) / bytesA) * 100;
    volDiffLabel = (p >= 0 ? '+' : '') + p.toFixed(1) + '%';
    if (Math.abs(p) > 5) volCardClass = 'warn';
  } else if (bytesB > 0) {
    volDiffLabel = 'A 為 0';
    volCardClass = 'warn';
  } else {
    volDiffLabel = '0%';
  }

  const fmtTotalAB = (n, count) => {
    if (count === 0) return '—';
    if (n === 0) return '0 B';
    return fmtBytes(n);
  };

  const container = $('tab-overview');
  container.innerHTML = `
    <p style="font-size:11px;color:var(--muted);margin-bottom:12px;line-height:1.5">
      比對與「已配對／未配對」僅使用 <strong style="color:var(--blue)">HTTP 成功</strong>（200–299 且為圖片，或 304 快取命中）。<br>
      <strong style="color:var(--red)">失敗</strong>（4xx/5xx 或非圖片 Content-Type）請到「📡 載入狀態」查看。<br>
      「成功圖片合計」僅加總上述成功清單的位元組（304 無 body 者為 0，不計入體積）。
    </p>
    <div class="stat-grid">
      <div class="stat-card info"><div class="stat-value" style="font-size:clamp(16px,4vw,22px)">${fmtTotalAB(bytesA, State.imagesA.length)}</div><div class="stat-label">A版 成功圖片合計</div></div>
      <div class="stat-card info"><div class="stat-value" style="font-size:clamp(16px,4vw,22px)">${fmtTotalAB(bytesB, State.imagesB.length)}</div><div class="stat-label">B版 成功圖片合計</div></div>
      <div class="stat-card ${volCardClass}"><div class="stat-value" style="font-size:clamp(16px,4vw,22px)">${volDiffLabel}</div><div class="stat-label">B 相對 A 體積</div></div>
    </div>
    <div class="stat-grid">
      <div class="stat-card ok"><div class="stat-value">${State.imagesA.length}</div><div class="stat-label">A版 成功載入</div></div>
      <div class="stat-card ${State.failedA.length > 0 ? 'warn' : 'ok'}"><div class="stat-value">${State.failedA.length}</div><div class="stat-label">A版 失敗請求</div></div>
      <div class="stat-card ok"><div class="stat-value">${State.imagesB.length}</div><div class="stat-label">B版 成功載入</div></div>
      <div class="stat-card ${State.failedB.length > 0 ? 'warn' : 'ok'}"><div class="stat-value">${State.failedB.length}</div><div class="stat-label">B版 失敗請求</div></div>
      <div class="stat-card ok">  <div class="stat-value">${matched}</div><div class="stat-label">已配對（成功圖）</div></div>
      <div class="stat-card ${unmatchedA + unmatchedB > 0 ? 'warn' : 'ok'}">
        <div class="stat-value">${unmatchedA + unmatchedB}</div><div class="stat-label">未配對</div>
      </div>
      <div class="stat-card ${sizeAbnormal > 0 ? 'warn' : 'ok'}">
        <div class="stat-value">${sizeAbnormal}</div><div class="stat-label">大小異常（&gt;20%）</div>
      </div>
    </div>

    ${unmatchedA + unmatchedB > 0 ? renderUnmatchedSection() : ''}

    <div class="btn-row" style="margin-top:12px">
      <button class="btn-secondary btn-sm" id="btn-export-overview">📥 匯出總覽 CSV</button>
      <button class="btn-secondary btn-sm" id="btn-export-failed">📥 匯出失敗清單 CSV</button>
    </div>
  `;

  $('btn-export-overview').addEventListener('click', exportCSV);
  $('btn-export-failed').addEventListener('click', exportFailedCSV);
}

function renderUnmatchedSection() {
  const unmatchedA = State.pairs.filter(p => p.a !== null && p.b === null).map(p => State.imagesA[p.a]);
  const unmatchedB = State.pairs.filter(p => p.a === null && p.b !== null).map(p => State.imagesB[p.b]);

  const itemsA = unmatchedA.map((img, i) => `
    <div class="unmatched-item" data-side="A" data-idx="${img.index}" onclick="selectUnmatched(this,'A',${img.index})">
      ${thumbHtml(img)}
      <div class="unmatched-info">
        <div class="unmatched-name" title="${img.filename}">${img.filename}</div>
        <div class="unmatched-size">${fmtBytes(img.size)}</div>
      </div>
    </div>`).join('');

  const itemsB = unmatchedB.map((img, i) => `
    <div class="unmatched-item" data-side="B" data-idx="${img.index}" onclick="selectUnmatched(this,'B',${img.index})">
      ${thumbHtml(img)}
      <div class="unmatched-info">
        <div class="unmatched-name" title="${img.filename}">${img.filename}</div>
        <div class="unmatched-size">${fmtBytes(img.size)}</div>
      </div>
    </div>`).join('');

  return `
    <div class="card" style="margin-top:0">
      <div class="card-title" style="justify-content:space-between">
        ⚠️ 未配對圖片
        <button class="btn-secondary btn-sm" onclick="openPairModal()">🔗 手動配對</button>
      </div>
      <div class="unmatched-grid">
        <div class="unmatched-col">
          <div class="unmatched-col-title a">🔵 A版 多出 ${unmatchedA.length} 張</div>
          ${itemsA || '<div style="color:var(--muted);font-size:12px">無</div>'}
        </div>
        <div class="unmatched-col">
          <div class="unmatched-col-title b">🟣 B版 多出 ${unmatchedB.length} 張</div>
          ${itemsB || '<div style="color:var(--muted);font-size:12px">無</div>'}
        </div>
      </div>
    </div>`;
}

// ═══════════════════════════════════════════════════════════════
// 載入狀態 Tab（HTTP 成功 / 失敗分開）
// ═══════════════════════════════════════════════════════════════
const HTTP_OK_COLLAPSE_THRESHOLD = 15;

function renderSideHttpBlock(sideLabel, okList, failedList, isA) {
  const okRows = okList.map((img, i) => `
    <tr>
      <td style="color:var(--muted)">${i + 1}</td>
      <td>${thumbHtml(img)}</td>
      <td><div class="fname" title="${img.filename}">${img.filename}</div></td>
      <td>${httpStatusCell(img)}</td>
      <td>${fmtBytes(img.size)}</td>
      <td style="font-size:10px;color:var(--muted)">${img.contentType || '—'}</td>
    </tr>`).join('');

  const failRows = failedList.map((f, i) => `
    <tr>
      <td style="color:var(--muted)">${i + 1}</td>
      <td><div class="fname" title="${f.filename}">${f.filename}</div></td>
      <td><span class="badge badge-red">HTTP ${f.httpStatus}</span></td>
      <td style="font-size:10px;max-width:120px;overflow:hidden;text-overflow:ellipsis">${f.contentType || '—'}</td>
      <td style="font-size:10px;color:var(--muted);max-width:280px;overflow:hidden;text-overflow:ellipsis">${(f.bodyPreview || '—').replace(/</g, '&lt;')}</td>
      <td style="font-size:10px;word-break:break-all;max-width:200px;overflow:hidden;text-overflow:ellipsis" title="${f.url}">${f.url}</td>
    </tr>`).join('');

  const okOpen   = okList.length <= HTTP_OK_COLLAPSE_THRESHOLD ? ' open' : '';
  const okHint   = okList.length > HTTP_OK_COLLAPSE_THRESHOLD
    ? ` — 超過 ${HTTP_OK_COLLAPSE_THRESHOLD} 筆，預設收合（點標題展開）`
    : '';

  return `
    <div class="card http-side-card">
      <div class="card-title" style="color:${isA ? 'var(--blue)' : 'var(--purple)'}">${sideLabel}</div>

      <details class="http-details"${okOpen}>
        <summary>✅ 成功（${okList.length}）${okHint}</summary>
        <div class="table-wrap http-table-scroll">
          <table>
            <thead><tr><th>#</th><th>預覽</th><th>檔名</th><th>HTTP</th><th>大小</th><th>類型</th></tr></thead>
            <tbody>${okRows || '<tr><td colspan="6"><div class="empty-state" style="padding:20px"><p>無</p></div></td></tr>'}</tbody>
          </table>
        </div>
      </details>

      <details class="http-details http-details-fail" open>
        <summary>❌ 失敗（${failedList.length}）</summary>
        <div class="table-wrap http-table-scroll">
          <table>
            <thead><tr><th>#</th><th>檔名</th><th>HTTP</th><th>Content-Type</th><th>回應摘要</th><th>URL</th></tr></thead>
            <tbody>${failRows || '<tr><td colspan="6"><div class="empty-state" style="padding:20px"><p>無</p></div></td></tr>'}</tbody>
          </table>
        </div>
      </details>
    </div>`;
}

function renderHttpTab() {
  const el = $('tab-http');
  if (!el) return;
  el.innerHTML = `
    <p class="http-tab-hint">
      成功：HTTP <strong>200–299</strong> 且為圖片，或 <strong>304</strong>（快取、可能無預覽）。失敗：<strong>4xx/5xx</strong> 或非圖片 Content-Type。<br>
      寬螢幕（≥1000px）A/B 並排；表格區域可<strong>獨立捲動</strong>。成功超過 ${HTTP_OK_COLLAPSE_THRESHOLD} 筆時預設收合。
    </p>
    <div class="http-ab-grid">
      ${renderSideHttpBlock('🔵 A 版', State.imagesA, State.failedA, true)}
      ${renderSideHttpBlock('🟣 B 版', State.imagesB, State.failedB, false)}
    </div>
    <div class="btn-row" style="margin-top:12px">
      <button class="btn-secondary btn-sm" onclick="exportFailedCSV()">📥 匯出 A/B 失敗清單 CSV</button>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// 資源大小 Tab
// ═══════════════════════════════════════════════════════════════
function renderSizeTab() {
  const container = $('tab-size');
  container.innerHTML = `
    <div class="card">
      <div class="card-title">📦 資源大小比對</div>
      <div class="filter-row">
        <span class="filter-label">篩選：</span>
        <button class="filter-btn ${State.sizeFilter === 'all' ? 'active' : ''}"     onclick="setSizeFilter('all')">全部</button>
        <button class="filter-btn ${State.sizeFilter === 'diff' ? 'active' : ''}"    onclick="setSizeFilter('diff')">有差異</button>
        <button class="filter-btn ${State.sizeFilter === 'smaller' ? 'active' : ''}" onclick="setSizeFilter('smaller')">A版縮小 ↓</button>
        <button class="filter-btn ${State.sizeFilter === 'larger' ? 'active' : ''}"  onclick="setSizeFilter('larger')">A版放大 ↑</button>
        <button class="filter-btn ${State.sizeFilter === 'unmatched' ? 'active' : ''}" onclick="setSizeFilter('unmatched')">未配對</button>
        <span style="flex:1"></span>
        <button class="btn-secondary btn-sm" onclick="exportSizeCSV()">📥 匯出 CSV</button>
      </div>
      <div class="table-wrap">
        <table id="size-table">
          <thead>
            <tr>
              <th>#</th>
              <th>A版預覽</th>
              <th>B版預覽</th>
              <th>A版檔名</th>
              <th>B版檔名</th>
              <th>A HTTP</th>
              <th>B HTTP</th>
              <th>A版大小</th>
              <th>B版大小</th>
              <th>差異</th>
              <th>狀態</th>
            </tr>
          </thead>
          <tbody id="size-tbody"></tbody>
        </table>
      </div>
    </div>`;

  renderSizeRows();
}

function setSizeFilter(f) {
  State.sizeFilter = f;
  renderSizeTab();
}

function renderSizeRows() {
  const tbody = $('size-tbody');
  if (!tbody) return;

  const rows = [];
  State.pairs.forEach((pair, pairIdx) => {
    const ia = pair.a !== null ? State.imagesA[pair.a] : null;
    const ib = pair.b !== null ? State.imagesB[pair.b] : null;
    const pct = ia && ib ? parseFloat(diffPct(ia.size, ib.size)) : null;
    const hasDiff = pct !== null && Math.abs(pct) >= 1;
    const isUnmatched = ia === null || ib === null;

    const f = State.sizeFilter;
    if (f === 'diff'      && !hasDiff && !isUnmatched) return;
    if (f === 'smaller'   && !(pct !== null && pct < -1)) return;
    if (f === 'larger'    && !(pct !== null && pct > 1)) return;
    if (f === 'unmatched' && !isUnmatched) return;

    let diffCell = '—';
    let statusCell = `<span class="badge badge-muted">未配對</span>`;

    if (pct !== null) {
      const sign  = pct > 0 ? '+' : '';
      const cls   = pct > 1 ? 'diff-up' : pct < -1 ? 'diff-down' : 'diff-zero';
      diffCell    = `<span class="${cls}">${sign}${pct}%</span>`;
      const absPct = Math.abs(pct);
      if (absPct <= 1)  statusCell = `<span class="badge badge-green">✅ 相同</span>`;
      else if (absPct <= 10) statusCell = `<span class="badge badge-yellow">⚠️ 輕微差異</span>`;
      else              statusCell = `<span class="badge badge-red">🔴 差異大</span>`;
    }

    rows.push(`
      <tr>
        <td style="color:var(--muted)">${pairIdx + 1}</td>
        <td>${ia ? thumbHtml(ia, pairIdx) : thumbHtml(null)}</td>
        <td>${ib ? thumbHtml(ib, pairIdx) : thumbHtml(null)}</td>
        <td><div class="fname" title="${ia ? ia.filename : ''}">${ia ? ia.filename : '—'}</div></td>
        <td><div class="fname" title="${ib ? ib.filename : ''}">${ib ? ib.filename : '—'}</div></td>
        <td style="font-size:11px">${ia ? httpStatusCell(ia) : '—'}</td>
        <td style="font-size:11px">${ib ? httpStatusCell(ib) : '—'}</td>
        <td>${ia ? fmtBytes(ia.size) : '—'}</td>
        <td>${ib ? fmtBytes(ib.size) : '—'}</td>
        <td>${diffCell}</td>
        <td>${statusCell}</td>
      </tr>`);
  });

  tbody.innerHTML = rows.length
    ? rows.join('')
    : `<tr><td colspan="11"><div class="empty-state"><div class="icon">🔍</div><p>沒有符合條件的項目</p></div></td></tr>`;
}

// ═══════════════════════════════════════════════════════════════
// 視覺比對 Tab
// ═══════════════════════════════════════════════════════════════
function renderVisualTab() {
  const container = $('tab-visual');
  container.innerHTML = `
    <div class="card">
      <div class="card-title">🖼️ 視覺內容比對</div>
      <div class="filter-row">
        <span class="filter-label">篩選：</span>
        <button class="filter-btn ${State.visualFilter === 'all'       ? 'active' : ''}" onclick="setVisualFilter('all')">全部</button>
        <button class="filter-btn ${State.visualFilter === 'diff'      ? 'active' : ''}" onclick="setVisualFilter('diff')">有差異</button>
        <button class="filter-btn ${State.visualFilter === 'unmatched' ? 'active' : ''}" onclick="setVisualFilter('unmatched')">未配對</button>
        <span style="flex:1"></span>
        <button class="btn-secondary btn-sm" onclick="exportVisualCSV()">📥 匯出 CSV</button>
      </div>
      <div class="table-wrap">
        <table id="visual-table">
          <thead>
            <tr>
              <th>#</th>
              <th>A版預覽</th>
              <th>B版預覽</th>
              <th>差異圖</th>
              <th>A版檔名</th>
              <th>B版檔名</th>
              <th>A HTTP</th>
              <th>B HTTP</th>
              <th>相似度</th>
              <th>大小差異</th>
            </tr>
          </thead>
          <tbody id="visual-tbody"></tbody>
        </table>
      </div>
    </div>`;

  renderVisualRows();
}

function setVisualFilter(f) {
  State.visualFilter = f;
  if (!State.visualDone) {
    State.visualDone = true;
    scheduleDiffComputation();
  }
  renderVisualTab();
}

function renderVisualRows() {
  const tbody = $('visual-tbody');
  if (!tbody) return;

  const rows = [];
  State.pairs.forEach((pair, pairIdx) => {
    const ia = pair.a !== null ? State.imagesA[pair.a] : null;
    const ib = pair.b !== null ? State.imagesB[pair.b] : null;
    const dr = pair.diffResult;
    const isUnmatched = ia === null || ib === null;

    const f = State.visualFilter;
    if (f === 'diff'      && !isUnmatched && (!ia.imgSrc || !ib.imgSrc)) return;
    if (f === 'diff'      && !isUnmatched && dr && dr.similarity >= 98) return;
    if (f === 'unmatched' && !isUnmatched) return;

    let diffCell = `<div class="diff-loading" id="diff-cell-${pairIdx}">計算中…</div>`;
    let simCell  = `<span class="badge badge-muted" id="sim-cell-${pairIdx}">—</span>`;

    if (isUnmatched) {
      diffCell = '<div style="text-align:center;color:var(--muted)">—</div>';
      simCell  = '<span class="badge badge-muted">未配對</span>';
    } else if (!ia.imgSrc || !ib.imgSrc) {
      diffCell = '<div style="text-align:center;color:var(--muted);font-size:10px">無本體<br>無法 diff</div>';
      simCell  = '<span class="badge badge-muted">304/無預覽</span>';
    } else if (dr) {
      diffCell = `<div class="thumb-wrap" onclick="openLightbox(${pairIdx})" id="diff-cell-${pairIdx}">
        <img src="${dr.diffSrc}" alt="diff">
      </div>`;
      const simPct = dr.similarity;
      simCell = `
        <div class="sim-wrap" id="sim-cell-${pairIdx}">
          <div class="sim-bar-bg">
            <div class="sim-bar" style="width:${simPct}%;background:${simColor(simPct)}"></div>
          </div>
          <span class="sim-text ${simBadgeClass(simPct)}" style="color:${simColor(simPct)}">${simPct}%</span>
        </div>`;
    }

    const pct  = ia && ib ? parseFloat(diffPct(ia.size, ib.size)) : null;
    const sign = pct !== null && pct > 0 ? '+' : '';
    const cls  = pct !== null ? (pct > 1 ? 'diff-up' : pct < -1 ? 'diff-down' : 'diff-zero') : '';
    const sizeCell = pct !== null ? `<span class="${cls}">${sign}${pct}%</span>` : '—';

    rows.push(`
      <tr id="vrow-${pairIdx}">
        <td style="color:var(--muted)">${pairIdx + 1}</td>
        <td>${ia ? thumbHtml(ia, pairIdx) : thumbHtml(null)}</td>
        <td>${ib ? thumbHtml(ib, pairIdx) : thumbHtml(null)}</td>
        <td>${diffCell}</td>
        <td><div class="fname" title="${ia ? ia.filename : ''}">${ia ? ia.filename : '—'}</div></td>
        <td><div class="fname" title="${ib ? ib.filename : ''}">${ib ? ib.filename : '—'}</div></td>
        <td style="font-size:11px">${ia ? httpStatusCell(ia) : '—'}</td>
        <td style="font-size:11px">${ib ? httpStatusCell(ib) : '—'}</td>
        <td>${simCell}</td>
        <td>${sizeCell}</td>
      </tr>`);
  });

  tbody.innerHTML = rows.length
    ? rows.join('')
    : `<tr><td colspan="10"><div class="empty-state"><div class="icon">🔍</div><p>沒有符合條件的項目</p></div></td></tr>`;
}

// ═══════════════════════════════════════════════════════════════
// Canvas 像素比對
// ═══════════════════════════════════════════════════════════════
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error('圖片載入失敗: ' + src));
    img.src = src;
  });
}

async function computeDiff(imgSrcA, imgSrcB) {
  const [imgA, imgB] = await Promise.all([loadImage(imgSrcA), loadImage(imgSrcB)]);

  const MAX_DIM = 800;
  let w = Math.max(imgA.naturalWidth,  imgB.naturalWidth);
  let h = Math.max(imgA.naturalHeight, imgB.naturalHeight);

  // 縮小到最大尺寸以節省記憶體
  if (w > MAX_DIM) { h = Math.round(h * MAX_DIM / w); w = MAX_DIM; }
  if (h > MAX_DIM) { w = Math.round(w * MAX_DIM / h); h = MAX_DIM; }
  if (w < 1) w = 1;
  if (h < 1) h = 1;

  const mkCanvas = () => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  };

  const ca = mkCanvas(); ca.getContext('2d').drawImage(imgA, 0, 0, w, h);
  const cb = mkCanvas(); cb.getContext('2d').drawImage(imgB, 0, 0, w, h);
  const cd = mkCanvas();

  const da = ca.getContext('2d').getImageData(0, 0, w, h);
  const db = cb.getContext('2d').getImageData(0, 0, w, h);
  const dd = cd.getContext('2d').createImageData(w, h);

  const THRESHOLD = 0.1;
  let diffCount = 0;
  const total   = w * h;

  for (let i = 0; i < total * 4; i += 4) {
    const dr = Math.abs(da.data[i]   - db.data[i]);
    const dg = Math.abs(da.data[i+1] - db.data[i+1]);
    const dbl = Math.abs(da.data[i+2] - db.data[i+2]);
    const diff = (dr + dg + dbl) / (3 * 255);

    if (diff > THRESHOLD) {
      dd.data[i]   = 255;
      dd.data[i+1] = 0;
      dd.data[i+2] = 0;
      dd.data[i+3] = 255;
      diffCount++;
    } else {
      dd.data[i]   = da.data[i];
      dd.data[i+1] = da.data[i+1];
      dd.data[i+2] = da.data[i+2];
      dd.data[i+3] = Math.max(60, da.data[i+3] >> 1);
    }
  }

  cd.getContext('2d').putImageData(dd, 0, 0);
  const similarity = parseFloat(((total - diffCount) / total * 100).toFixed(1));
  const diffSrc    = cd.toDataURL('image/webp', 0.85);

  return { similarity, diffSrc, width: w, height: h, diffPixels: diffCount, totalPixels: total };
}

// 批次計算 diff（避免凍結 UI）
async function scheduleDiffComputation() {
  const BATCH = 5;
  for (let i = 0; i < State.pairs.length; i += BATCH) {
    const batch = State.pairs.slice(i, i + BATCH);
    await Promise.all(batch.map(async (pair, offset) => {
      const pairIdx = i + offset;
      if (pair.a === null || pair.b === null) return;
      if (pair.diffResult) return;

      const ia = State.imagesA[pair.a];
      const ib = State.imagesB[pair.b];
      if (!ia.imgSrc || !ib.imgSrc) {
        updateDiffCellNoBody(pairIdx);
        return;
      }

      try {
        const result = await computeDiff(ia.imgSrc, ib.imgSrc);
        State.pairs[pairIdx].diffResult = result;
        updateDiffCell(pairIdx, result);
      } catch (_e) {
        updateDiffCellError(pairIdx);
      }
    }));
    await new Promise(r => setTimeout(r, 16)); // yield
  }
}

function updateDiffCell(pairIdx, result) {
  const diffEl = $(`diff-cell-${pairIdx}`);
  const simEl  = $(`sim-cell-${pairIdx}`);
  if (diffEl) {
    diffEl.outerHTML = `<div class="thumb-wrap" onclick="openLightbox(${pairIdx})" id="diff-cell-${pairIdx}">
      <img src="${result.diffSrc}" alt="diff">
    </div>`;
  }
  if (simEl) {
    const pct = result.similarity;
    simEl.outerHTML = `
      <div class="sim-wrap" id="sim-cell-${pairIdx}">
        <div class="sim-bar-bg">
          <div class="sim-bar" style="width:${pct}%;background:${simColor(pct)}"></div>
        </div>
        <span class="sim-text" style="color:${simColor(pct)}">${pct}%</span>
      </div>`;
  }
}

function updateDiffCellError(pairIdx) {
  const el = $(`diff-cell-${pairIdx}`);
  if (el) el.innerHTML = '<span style="color:var(--muted);font-size:10px">無法比對</span>';
}

function updateDiffCellNoBody(pairIdx) {
  const diffEl = $(`diff-cell-${pairIdx}`);
  const simEl  = $(`sim-cell-${pairIdx}`);
  if (diffEl) diffEl.innerHTML = '<span style="color:var(--muted);font-size:10px">無本體</span>';
  if (simEl) {
    simEl.outerHTML = '<span class="badge badge-muted" id="sim-cell-' + pairIdx + '">304/無預覽</span>';
  }
}

// ═══════════════════════════════════════════════════════════════
// Lightbox
// ═══════════════════════════════════════════════════════════════
function openLightbox(pairIdx) {
  State.lbIndex = pairIdx;
  renderLightbox();
  $('lightbox').classList.add('open');
}

function closeLightbox() {
  $('lightbox').classList.remove('open');
}

async function renderLightbox() {
  const pair    = State.pairs[State.lbIndex];
  const ia      = pair.a !== null ? State.imagesA[pair.a] : null;
  const ib      = pair.b !== null ? State.imagesB[pair.b] : null;
  const total   = State.pairs.length;

  $('lb-title').textContent = `圖片 ${State.lbIndex + 1} / ${total}`;

  // A版
  $('lb-img-a').innerHTML  = ia
    ? (ia.imgSrc
      ? `<img src="${ia.imgSrc}" alt="A" onerror="this.outerHTML='<span style=color:var(--muted)>圖片無法顯示</span>'">`
      : '<span style="color:var(--muted)">HTTP ' + ia.httpStatus + '（快取命中，無本機預覽）</span>')
    : '<span style="color:var(--muted)">無圖片（未配對）</span>';
  $('lb-meta-a').innerHTML = ia
    ? `檔名：<span>${ia.filename}</span><br>HTTP：<span>${ia.httpStatus}</span><br>大小：<span>${fmtBytes(ia.size)}</span><br>類型：<span>${ia.contentType}</span>`
    : '—';

  // B版
  $('lb-img-b').innerHTML  = ib
    ? (ib.imgSrc
      ? `<img src="${ib.imgSrc}" alt="B" onerror="this.outerHTML='<span style=color:var(--muted)>圖片無法顯示</span>'">`
      : '<span style="color:var(--muted)">HTTP ' + ib.httpStatus + '（快取命中，無本機預覽）</span>')
    : '<span style="color:var(--muted)">無圖片（未配對）</span>';
  $('lb-meta-b').innerHTML = ib
    ? `檔名：<span>${ib.filename}</span><br>HTTP：<span>${ib.httpStatus}</span><br>大小：<span>${fmtBytes(ib.size)}</span><br>類型：<span>${ib.contentType}</span>`
    : '—';

  // Diff
  if (ia && ib) {
    if (!ia.imgSrc || !ib.imgSrc) {
      $('lb-img-diff').innerHTML  = '<span style="color:var(--muted)">兩邊皆需圖片本體才能算像素差異（304 無 body）</span>';
      $('lb-meta-diff').innerHTML = '';
      return;
    }
    $('lb-img-diff').innerHTML = '<span style="color:var(--muted)">計算中…</span>';
    $('lb-meta-diff').innerHTML = '';
    try {
      let dr = pair.diffResult;
      if (!dr) {
        dr = await computeDiff(ia.imgSrc, ib.imgSrc);
        State.pairs[State.lbIndex].diffResult = dr;
        updateDiffCell(State.lbIndex, dr);
      }
      $('lb-img-diff').innerHTML = `<img src="${dr.diffSrc}" alt="diff" style="max-width:100%;max-height:400px;object-fit:contain">`;
      $('lb-meta-diff').innerHTML =
        `相似度：<span style="color:${simColor(dr.similarity)};font-weight:700">${dr.similarity}%</span><br>` +
        `差異像素：<span>${dr.diffPixels.toLocaleString()} / ${dr.totalPixels.toLocaleString()}</span><br>` +
        `比對尺寸：<span>${dr.width} × ${dr.height}</span>`;
    } catch (e) {
      $('lb-img-diff').innerHTML = '<span style="color:var(--muted)">無法計算差異圖</span>';
    }
  } else {
    $('lb-img-diff').innerHTML  = '<span style="color:var(--muted)">需要兩張圖才能比較</span>';
    $('lb-meta-diff').innerHTML = '';
  }
}

// ═══════════════════════════════════════════════════════════════
// 手動配對
// ═══════════════════════════════════════════════════════════════
let pairSelA = null;
let pairSelB = null;
let pendingManualPairs = [];

function openPairModal() {
  pairSelA = null;
  pairSelB = null;
  pendingManualPairs = [...State.manualPairs];
  renderPairModal();
  $('pair-modal').classList.add('open');
}

function renderPairModal() {
  const usedA = new Set(pendingManualPairs.map(p => p.a));
  const usedB = new Set(pendingManualPairs.map(p => p.b));

  const freeA = State.pairs.filter(p => p.a !== null && p.b === null && !usedA.has(p.a)).map(p => State.imagesA[p.a]);
  const freeB = State.pairs.filter(p => p.a === null && p.b !== null && !usedB.has(p.b)).map(p => State.imagesB[p.b]);

  const listA = freeA.map(img => `
    <div class="unmatched-item ${pairSelA === img.index ? 'selected' : ''}"
         onclick="pairClickA(${img.index}, this)">
      ${thumbHtml(img)}
      <div class="unmatched-info">
        <div class="unmatched-name" title="${img.filename}">${img.filename}</div>
        <div class="unmatched-size">${fmtBytes(img.size)}</div>
      </div>
    </div>`).join('');

  const listB = freeB.map(img => `
    <div class="unmatched-item ${pairSelB === img.index ? 'selected' : ''}"
         onclick="pairClickB(${img.index}, this)">
      ${thumbHtml(img)}
      <div class="unmatched-info">
        <div class="unmatched-name" title="${img.filename}">${img.filename}</div>
        <div class="unmatched-size">${fmtBytes(img.size)}</div>
      </div>
    </div>`).join('');

  const paired = pendingManualPairs.map((mp, i) => {
    const ia = State.imagesA[mp.a];
    const ib = State.imagesB[mp.b];
    return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;background:var(--surface2);border-radius:6px;padding:8px">
      ${thumbHtml(ia)}
      <div class="fname" style="flex:1" title="${ia.filename}">${ia.filename}</div>
      <span style="color:var(--muted)">↔</span>
      <div class="fname" style="flex:1" title="${ib.filename}">${ib.filename}</div>
      ${thumbHtml(ib)}
      <button class="btn-danger btn-sm" onclick="removePending(${i})">✕</button>
    </div>`;
  }).join('');

  $('pair-modal-body').innerHTML = `
    ${pendingManualPairs.length ? `<div style="margin-bottom:12px"><div class="card-title" style="margin-bottom:8px;font-size:12px">已配對 ${pendingManualPairs.length} 組</div>${paired}</div>` : ''}
    <div class="unmatched-grid">
      <div class="unmatched-col">
        <div class="unmatched-col-title a">🔵 A版 未配對（點選後再點 B版）</div>
        ${listA || '<div style="color:var(--muted);font-size:12px">無未配對圖片</div>'}
      </div>
      <div class="unmatched-col">
        <div class="unmatched-col-title b">🟣 B版 未配對</div>
        ${listB || '<div style="color:var(--muted);font-size:12px">無未配對圖片</div>'}
      </div>
    </div>`;
}

window.pairClickA = function(idx, el) {
  pairSelA = idx;
  tryAutoPair();
  renderPairModal();
};

window.pairClickB = function(idx, el) {
  pairSelB = idx;
  tryAutoPair();
  renderPairModal();
};

function tryAutoPair() {
  if (pairSelA !== null && pairSelB !== null) {
    pendingManualPairs.push({ a: pairSelA, b: pairSelB });
    pairSelA = null;
    pairSelB = null;
    showToast('✅ 已加入配對');
  }
}

window.removePending = function(i) {
  pendingManualPairs.splice(i, 1);
  renderPairModal();
};

function applyManualPairs() {
  State.manualPairs = pendingManualPairs;
  State.pairs = buildPairs(State.imagesA, State.imagesB, State.manualPairs);
  State.visualDone = false;
  $('pair-modal').classList.remove('open');
  renderAll();
  showToast('✅ 手動配對已套用');
}

// ═══════════════════════════════════════════════════════════════
// 渲染全部
// ═══════════════════════════════════════════════════════════════
function renderAll() {
  renderOverview();
  renderSizeTab();
  if (State.activeTab === 'visual') {
    State.visualDone = true;
    renderVisualTab();
    scheduleDiffComputation();
  } else {
    $('tab-visual').innerHTML = '';
  }
  if (State.activeTab === 'http') {
    renderHttpTab();
  } else if ($('tab-http')) {
    $('tab-http').innerHTML = '';
  }
}

// ═══════════════════════════════════════════════════════════════
// CSV 匯出
// ═══════════════════════════════════════════════════════════════
function downloadCSV(filename, rows) {
  const csv  = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function exportCSV() {
  const rows = [['#', 'A版檔名', 'A_HTTP', 'A版大小(bytes)', 'A版類型', 'B版檔名', 'B_HTTP', 'B版大小(bytes)', 'B版類型', '大小差異%', '相似度%', '配對方式']];
  State.pairs.forEach((pair, i) => {
    const ia = pair.a !== null ? State.imagesA[pair.a] : null;
    const ib = pair.b !== null ? State.imagesB[pair.b] : null;
    const pct = ia && ib ? diffPct(ia.size, ib.size) : '';
    const sim = pair.diffResult ? pair.diffResult.similarity : '';
    rows.push([
      i + 1,
      ia ? ia.filename : '—',
      ia ? (ia.httpStatus != null ? ia.httpStatus : '') : '',
      ia ? ia.size : '', ia ? ia.contentType : '',
      ib ? ib.filename : '—',
      ib ? (ib.httpStatus != null ? ib.httpStatus : '') : '',
      ib ? ib.size : '', ib ? ib.contentType : '',
      pct, sim,
      pair.manual ? '手動' : '自動'
    ]);
  });
  downloadCSV(`img-compare-${new Date().toISOString().slice(0,10)}.csv`, rows);
}

function exportFailedCSV() {
  const rows = [['版本', '#', '檔名', 'URL', 'HTTP', 'Content-Type', '回應摘要']];
  State.failedA.forEach((f, i) => rows.push(['A', i + 1, f.filename, f.url, f.httpStatus, f.contentType, f.bodyPreview || '']));
  State.failedB.forEach((f, i) => rows.push(['B', i + 1, f.filename, f.url, f.httpStatus, f.contentType, f.bodyPreview || '']));
  downloadCSV(`img-failed-${new Date().toISOString().slice(0, 10)}.csv`, rows);
}

function exportSizeCSV() {
  const rows = [['#', 'A版檔名', 'A版大小(bytes)', 'B版檔名', 'B版大小(bytes)', '差異%']];
  State.pairs.forEach((pair, i) => {
    const ia = pair.a !== null ? State.imagesA[pair.a] : null;
    const ib = pair.b !== null ? State.imagesB[pair.b] : null;
    rows.push([i+1, ia ? ia.filename : '—', ia ? ia.size : '', ib ? ib.filename : '—', ib ? ib.size : '', ia && ib ? diffPct(ia.size, ib.size) : '']);
  });
  downloadCSV(`img-size-${new Date().toISOString().slice(0,10)}.csv`, rows);
}

function exportVisualCSV() {
  const rows = [['#', 'A版檔名', 'B版檔名', '相似度%', '差異像素', '總像素']];
  State.pairs.forEach((pair, i) => {
    const ia = pair.a !== null ? State.imagesA[pair.a] : null;
    const ib = pair.b !== null ? State.imagesB[pair.b] : null;
    const dr = pair.diffResult;
    rows.push([i+1, ia ? ia.filename : '—', ib ? ib.filename : '—', dr ? dr.similarity : '', dr ? dr.diffPixels : '', dr ? dr.totalPixels : '']);
  });
  downloadCSV(`img-visual-${new Date().toISOString().slice(0,10)}.csv`, rows);
}

// ═══════════════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════════════
async function startCapture() {
  const urlA = $('url-a').value.trim();
  const urlB = $('url-b').value.trim();

  if (!urlA && !urlB) {
    showToast('⚠️ 請至少輸入一個網址');
    return;
  }

  const runA = !!urlA;
  const runB = !!urlB;

  // 重置狀態
  State.imagesA    = [];
  State.imagesB    = [];
  State.failedA    = [];
  State.failedB    = [];
  State.pairs      = [];
  State.manualPairs = [];
  State.visualDone  = false;

  // UI 更新
  $('btn-capture').disabled = true;
  setCaptureModeDisabled(true);
  $('btn-reset').style.display = 'none';
  $('progress-area').style.display = 'block';
  $('results').style.display = 'none';
  ['prog-bar-a','prog-bar-b'].forEach(id => { $(id).style.width = '0%'; });
  ['prog-msg-a','prog-msg-b'].forEach(id => { $(id).textContent = '準備中…'; });
  ['prog-cnt-a','prog-cnt-b'].forEach(id => { $(id).textContent = ''; });
  if (!runA) {
    $('prog-msg-a').textContent = '未執行（A 未填）';
    $('prog-bar-a').style.width = '100%';
  }
  if (!runB) {
    $('prog-msg-b').textContent = '未執行（B 未填）';
    $('prog-bar-b').style.width = '100%';
  }

  try {
    await initSession();

    // 有填寫的側邊才執行擷取；另一側保留空結果
    const taskA = runA ? captureImages(urlA, 'A') : Promise.resolve({ ok: [], failed: [] });
    const taskB = runB ? captureImages(urlB, 'B') : Promise.resolve({ ok: [], failed: [] });
    const [rA, rB] = await Promise.all([taskA, taskB]);

    State.imagesA = rA.ok;
    State.failedA = rA.failed;
    State.imagesB = rB.ok;
    State.failedB = rB.failed;
    State.pairs   = buildPairs(rA.ok, rB.ok, []);

    // 顯示結果
    $('results').style.display = 'block';
    $('btn-reset').style.display = 'inline-block';
    switchTab('overview');
    renderAll();

    showToast(`✅ A 成功 ${rA.ok.length} 失敗 ${rA.failed.length} · B 成功 ${rB.ok.length} 失敗 ${rB.failed.length}`);

  } catch (err) {
    showToast('❌ 擷取失敗：' + err.message, 4000);
  } finally {
    $('btn-capture').disabled = false;
    setCaptureModeDisabled(false);
  }
}

function resetAll() {
  State.imagesA = [];
  State.imagesB = [];
  State.failedA = [];
  State.failedB = [];
  State.pairs   = [];
  State.visualDone = false;
  $('results').style.display = 'none';
  $('progress-area').style.display = 'none';
  $('btn-reset').style.display = 'none';
  $('btn-capture').disabled = false;
  ['prog-bar-a','prog-bar-b'].forEach(id => { $(id).style.width = '0%'; });
}

// ═══════════════════════════════════════════════════════════════
// 事件綁定
// ═══════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  $('btn-capture').addEventListener('click', startCapture);
  $('btn-reset').addEventListener('click', resetAll);

  // Tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Lightbox
  $('lb-close').addEventListener('click', closeLightbox);
  $('lb-prev').addEventListener('click', () => {
    if (State.lbIndex > 0) { State.lbIndex--; renderLightbox(); }
  });
  $('lb-next').addEventListener('click', () => {
    if (State.lbIndex < State.pairs.length - 1) { State.lbIndex++; renderLightbox(); }
  });
  document.addEventListener('keydown', e => {
    if (!$('lightbox').classList.contains('open')) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft'  && State.lbIndex > 0)                       { State.lbIndex--; renderLightbox(); }
    if (e.key === 'ArrowRight' && State.lbIndex < State.pairs.length - 1)  { State.lbIndex++; renderLightbox(); }
  });

  // Manual pair modal
  $('btn-pair-confirm').addEventListener('click', applyManualPairs);
  $('btn-pair-cancel').addEventListener('click',  () => $('pair-modal').classList.remove('open'));

  // Enter 鍵觸發擷取
  [$('url-a'), $('url-b')].forEach(el => {
    el.addEventListener('keydown', e => { if (e.key === 'Enter') startCapture(); });
  });
});

// 暴露給 HTML inline onclick 使用
window.openLightbox   = openLightbox;
window.openPairModal  = openPairModal;
window.selectUnmatched = function() {}; // placeholder（overview 的 unmatched 點擊走 pairModal）
window.setSizeFilter   = setSizeFilter;
window.setVisualFilter = setVisualFilter;
window.exportCSV       = exportCSV;
window.exportFailedCSV = exportFailedCSV;
window.exportSizeCSV   = exportSizeCSV;
window.exportVisualCSV = exportVisualCSV;
