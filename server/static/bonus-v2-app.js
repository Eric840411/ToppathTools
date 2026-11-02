/**
 * Bonus ColorGame V2 — 前端邏輯
 * SSE 即時收資料 → 統計比對 → CSV 匯出
 */

// ─── V2 規格書期望值 ──────────────────────────────────────
const V2_SPEC = {
  m2: {
    label: 'Single 2同',
    rates: [3, 4, 6, 8, 10],
    weights: { 3: 64, 4: 64, 6: 39, 8: 22, 10: 11 },
    totalWeight: 200
  },
  m3: {
    label: 'Single 3同',
    rates: [10, 20, 30, 60, 100],
    weights: { 10: 52, 20: 52, 30: 44, 60: 30, 100: 22 },
    totalWeight: 200
  },
  ad: {
    label: 'AnyDouble',
    rates: [2, 3, 5, 10, 20],
    weights: { 2: 86, 3: 57, 5: 33, 10: 16, 20: 8 },
    totalWeight: 200
  },
  at: {
    label: 'AnyTriple',
    rates: [50, 100, 150, 250, 500],
    weights: { 50: 100, 100: 49, 150: 30, 250: 14, 500: 7 },
    totalWeight: 200
  }
};

// ─── 應用狀態 ─────────────────────────────────────────────
const appStats = {
  totalRounds: 0,
  m2: { total: 0, counts: {} },
  m3: { total: 0, counts: {} },
  ad: { total: 0, counts: {} },
  at: { total: 0, counts: {} },
  // CGBOV2-17：主注區獎勵類型（每次 Single 抽是 2同 or 3同）
  bonusType: { total: 0, m2: 0, m3: 0 },
  // CGBOV2-18：旁注區獎勵類型（AD池 / AT池 / Both池）
  sidePool: { total: 0, ad: 0, at: 0, both: 0 },
  // CGBOV2-14：四次是否選顏色命中率（條件機率鏈）
  drawCount: { ge1: 0, ge2: 0, ge3: 0, eq4: 0 }
};

const allRounds = [];
let isCollecting = false;
let detailCollapsed = false;
let firstRow = true;
let collectedTarget = 0;  // 使用者設定的總目標局數
let roundOffset = 0;      // 本次開始時已有的局數（用於局號接續）

const RUN_CACHE_KEY = 'bonus-v2-active-run';

function readRunCache() {
  try { return JSON.parse(localStorage.getItem(RUN_CACHE_KEY) || 'null'); }
  catch { return null; }
}

function writeRunCache(data) {
  localStorage.setItem(RUN_CACHE_KEY, JSON.stringify({
    ...readRunCache(),
    ...data,
    updatedAt: Date.now()
  }));
}

function clearRunCache() {
  localStorage.removeItem(RUN_CACHE_KEY);
}

function restoreCachedRun() {
  const cached = readRunCache();
  if (!cached?.collecting) return;

  collectedTarget = cached.target || collectedTarget || 0;
  roundOffset = cached.roundOffset || 0;
  if (cached.url) document.getElementById('urlInput').value = cached.url;
  if (cached.target) document.getElementById('roundsInput').value = cached.target;
  updateStatus({
    collecting: true,
    current: appStats.totalRounds,
    target: collectedTarget,
    message: '偵測到先前仍在收集，已恢復停止按鈕'
  });
}

// ─── 初始化統計表格（帶期望值）────────────────────────────
function initStatTables() {
  for (const [key, spec] of Object.entries(V2_SPEC)) {
    const tbody = document.getElementById(`tbody-${key}`);
    if (!tbody) continue;
    tbody.innerHTML = '';
    for (const rate of spec.rates) {
      const expPct = (spec.weights[rate] / spec.totalWeight * 100).toFixed(2);
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${rate}x</td>
        <td>${expPct}%</td>
        <td id="cnt-${key}-${rate}">0</td>
        <td id="pct-${key}-${rate}">—</td>
        <td id="diff-${key}-${rate}" class="diff-none">—</td>
      `;
      tbody.appendChild(tr);
    }
  }
}

// ─── 更新單一統計卡片 ─────────────────────────────────────
function updateStatCard(key) {
  const cat = appStats[key];
  const spec = V2_SPEC[key];
  const total = cat.total;

  document.getElementById(`total-${key}`).textContent = `共 ${total} 次抽中`;

  for (const rate of spec.rates) {
    const count = cat.counts[rate] || 0;
    const cntEl  = document.getElementById(`cnt-${key}-${rate}`);
    const pctEl  = document.getElementById(`pct-${key}-${rate}`);
    const diffEl = document.getElementById(`diff-${key}-${rate}`);
    if (!cntEl) continue;

    cntEl.textContent = count;

    if (total === 0) {
      pctEl.textContent  = '—';
      diffEl.textContent = '—';
      diffEl.className   = 'diff-none';
      continue;
    }

    const actualPct   = count / total * 100;
    const expectedPct = spec.weights[rate] / spec.totalWeight * 100;
    const diff        = actualPct - expectedPct;
    const absDiff     = Math.abs(diff);

    pctEl.textContent  = actualPct.toFixed(2) + '%';
    diffEl.textContent = (diff >= 0 ? '+' : '') + diff.toFixed(2) + '%';
    diffEl.className   = absDiff < 5 ? 'diff-ok' : absDiff < 10 ? 'diff-warn' : 'diff-bad';
  }
}

// ─── 更新主注區獎勵類型 (CGBOV2-17) ─────────────────────────
function updateBonusTypeCard() {
  const { total, m2, m3 } = appStats.bonusType;
  document.getElementById('total-bonus-type').textContent = `共 ${total} 次 Single`;

  const rows = [
    { id: 'm2', count: m2, expected: 100 / 3 },
    { id: 'm3', count: m3, expected: 200 / 3 }
  ];
  for (const r of rows) {
    const pctEl  = document.getElementById(`pct-bt-${r.id}`);
    const cntEl  = document.getElementById(`cnt-bt-${r.id}`);
    const diffEl = document.getElementById(`diff-bt-${r.id}`);
    cntEl.textContent = r.count;
    if (total === 0) {
      pctEl.textContent = '—'; diffEl.textContent = '—'; diffEl.className = 'diff-none';
    } else {
      const actual = r.count / total * 100;
      const diff   = actual - r.expected;
      const abs    = Math.abs(diff);
      pctEl.textContent  = actual.toFixed(2) + '%';
      diffEl.textContent = (diff >= 0 ? '+' : '') + diff.toFixed(2) + '%';
      diffEl.className   = abs < 5 ? 'diff-ok' : abs < 10 ? 'diff-warn' : 'diff-bad';
    }
  }
}

// ─── 更新旁注區獎勵類型 (CGBOV2-18) ─────────────────────────
function updateSidePoolCard() {
  const { total, ad, at, both } = appStats.sidePool;
  document.getElementById('total-side-pool').textContent = `共 ${total} 局`;

  const rows = [
    { id: 'ad',   count: ad,   expected: 40 },
    { id: 'at',   count: at,   expected: 31 },
    { id: 'both', count: both, expected: 29 }
  ];
  for (const r of rows) {
    const pctEl  = document.getElementById(`pct-sp-${r.id}`);
    const cntEl  = document.getElementById(`cnt-sp-${r.id}`);
    const diffEl = document.getElementById(`diff-sp-${r.id}`);
    cntEl.textContent = r.count;
    if (total === 0) {
      pctEl.textContent = '—'; diffEl.textContent = '—'; diffEl.className = 'diff-none';
    } else {
      const actual = r.count / total * 100;
      const diff   = actual - r.expected;
      const abs    = Math.abs(diff);
      pctEl.textContent  = actual.toFixed(2) + '%';
      diffEl.textContent = (diff >= 0 ? '+' : '') + diff.toFixed(2) + '%';
      diffEl.className   = abs < 5 ? 'diff-ok' : abs < 10 ? 'diff-warn' : 'diff-bad';
    }
  }
}

// ─── 更新四次是否選顏色命中率 (CGBOV2-14) ────────────────────
function updateDrawCountCard() {
  const total = appStats.totalRounds;
  const { ge1, ge2, ge3, eq4 } = appStats.drawCount;
  document.getElementById('total-draw-count').textContent = `共 ${total} 局`;

  const draws = [
    { n: 1, base: total, hit: ge1, expected: 96 },
    { n: 2, base: ge1,   hit: ge2, expected: 79 },
    { n: 3, base: ge2,   hit: ge3, expected: 53 },
    { n: 4, base: ge3,   hit: eq4, expected: 12 }
  ];
  for (const d of draws) {
    document.getElementById(`base-dc-${d.n}`).textContent = d.base;
    document.getElementById(`cnt-dc-${d.n}`).textContent  = d.hit;
    const pctEl  = document.getElementById(`pct-dc-${d.n}`);
    const diffEl = document.getElementById(`diff-dc-${d.n}`);
    if (d.base === 0) {
      pctEl.textContent = '—'; diffEl.textContent = '—'; diffEl.className = 'diff-none';
    } else {
      const actual = d.hit / d.base * 100;
      const diff   = actual - d.expected;
      const abs    = Math.abs(diff);
      pctEl.textContent  = actual.toFixed(2) + '%';
      diffEl.textContent = (diff >= 0 ? '+' : '') + diff.toFixed(2) + '%';
      diffEl.className   = abs < 5 ? 'diff-ok' : abs < 10 ? 'diff-warn' : 'diff-bad';
    }
  }
}

// ─── 處理每局資料 ─────────────────────────────────────────
function processRound(roundData) {
  appStats.totalRounds++;
  allRounds.push(roundData);

  for (const item of (roundData.single_m2 || [])) {
    appStats.m2.total++;
    appStats.m2.counts[item.rate] = (appStats.m2.counts[item.rate] || 0) + 1;
  }
  for (const item of (roundData.single_m3 || [])) {
    appStats.m3.total++;
    appStats.m3.counts[item.rate] = (appStats.m3.counts[item.rate] || 0) + 1;
  }
  if (roundData.any_double) {
    appStats.ad.total++;
    const r = roundData.any_double.rate;
    appStats.ad.counts[r] = (appStats.ad.counts[r] || 0) + 1;
  }
  if (roundData.any_triple) {
    appStats.at.total++;
    const r = roundData.any_triple.rate;
    appStats.at.counts[r] = (appStats.at.counts[r] || 0) + 1;
  }

  // CGBOV2-17：計算每次 Single 抽的類型分布
  for (let i = 0; i < (roundData.single_m2 || []).length; i++) {
    appStats.bonusType.total++;
    appStats.bonusType.m2++;
  }
  for (let i = 0; i < (roundData.single_m3 || []).length; i++) {
    appStats.bonusType.total++;
    appStats.bonusType.m3++;
  }

  // CGBOV2-18：判斷旁注區所屬獎池
  const hasAD = !!roundData.any_double;
  const hasAT = !!roundData.any_triple;
  appStats.sidePool.total++;
  if (hasAD && hasAT)     appStats.sidePool.both++;
  else if (hasAD)         appStats.sidePool.ad++;
  else if (hasAT)         appStats.sidePool.at++;

  // CGBOV2-14：條件機率鏈（每局 Single 加乘數量決定抽了幾次）
  const singleCount = (roundData.single_m2 || []).length + (roundData.single_m3 || []).length;
  if (singleCount >= 1) appStats.drawCount.ge1++;
  if (singleCount >= 2) appStats.drawCount.ge2++;
  if (singleCount >= 3) appStats.drawCount.ge3++;
  if (singleCount === 4) appStats.drawCount.eq4++;

  updateStatCard('m2');
  updateStatCard('m3');
  updateStatCard('ad');
  updateStatCard('at');
  updateBonusTypeCard();
  updateSidePoolCard();
  updateDrawCountCard();
  addDetailRow(roundData);

  document.getElementById('exportStatsBtn').disabled  = false;
  document.getElementById('exportDetailBtn').disabled = false;
}

// ─── 明細列格式化 ─────────────────────────────────────────
function fmtM2(items) {
  if (!items || items.length === 0) return '<span class="tag-none">—</span>';
  return items.map(i => `<span class="tag tag-m2">${i.color} ${i.rate}x</span>`).join('');
}
function fmtM3(items) {
  if (!items || items.length === 0) return '<span class="tag-none">—</span>';
  return items.map(i => `<span class="tag tag-m3">${i.color} ${i.rate}x</span>`).join('');
}
function fmtAD(item) {
  if (!item) return '<span class="tag-none">—</span>';
  return `<span class="tag tag-ad">${item.color}${item.color} ${item.rate}x</span>`;
}
function fmtAT(item) {
  if (!item) return '<span class="tag-none">—</span>';
  return `<span class="tag tag-at">${item.color}${item.color}${item.color} ${item.rate}x</span>`;
}

function addDetailRow(roundData) {
  const tbody = document.getElementById('detailTbody');

  if (firstRow) {
    const emptyRow = document.getElementById('emptyRow');
    if (emptyRow) emptyRow.remove();
    firstRow = false;
  }

  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="col-num">${roundData.round}</td>
    <td class="col-time">${roundData.time}</td>
    <td>${fmtM2(roundData.single_m2)}</td>
    <td>${fmtM3(roundData.single_m3)}</td>
    <td>${fmtAD(roundData.any_double)}</td>
    <td>${fmtAT(roundData.any_triple)}</td>
  `;

  tbody.insertBefore(tr, tbody.firstChild);
  document.getElementById('detailCount').textContent = `(${allRounds.length} 局)`;
}

// ─── 狀態列更新 ───────────────────────────────────────────
function updateStatus({ collecting, current, target, message }) {
  const dot   = document.getElementById('statusDot');
  const count = document.getElementById('statusCount');
  const bar   = document.getElementById('progressBar');
  const msg   = document.getElementById('statusMsg');

  if (collecting) {
    isCollecting = true;
    document.getElementById('startBtn').disabled = true;
    document.getElementById('stopBtn').disabled  = false;
    dot.className = 'status-dot active';
    count.textContent = `收集中：${current} / ${target} 局`;
    bar.style.width   = target > 0 ? `${Math.min(100, current / target * 100)}%` : '0%';
    if (message) msg.textContent = message;
    writeRunCache({
      collecting: true,
      current,
      target,
      url: document.getElementById('urlInput').value.trim(),
      roundOffset
    });
  } else {
    dot.className     = current > 0 ? 'status-dot done' : 'status-dot';
    count.textContent = current > 0 ? `已完成 ${current} 局` : '尚未開始';
    if (target > 0 && current >= target) bar.style.width = '100%';
    if (message) msg.textContent = message;

    isCollecting = false;
    document.getElementById('startBtn').disabled = false;
    document.getElementById('stopBtn').disabled  = true;
    clearRunCache();
  }
}

// ─── 偵錯日誌 ─────────────────────────────────────────────
let debugCount = 0;
let debugCollapsed = true;

function addDebugLog(msg, color) {
  debugCount++;
  const log = document.getElementById('debugLog');
  if (!log) return;

  // 清除「等待偵錯訊息...」
  if (debugCount === 1) log.innerHTML = '';

  const span = document.createElement('span');
  span.style.color = color || 'var(--muted)';
  span.textContent = `[${new Date().toLocaleTimeString('zh-TW', { hour12: false })}] ${msg}`;
  log.insertBefore(span, log.firstChild);

  document.getElementById('debugCount').textContent = `(${debugCount} 筆)`;
}

document.getElementById('debugToggle').addEventListener('click', e => {
  if (e.target.closest('#debugCopyBtn')) return; // 避免點複製按鈕時觸發收合
  const body = document.getElementById('debugBody');
  const icon = document.getElementById('debugToggleIcon');
  debugCollapsed = !debugCollapsed;
  body.style.display = debugCollapsed ? 'none' : 'block';
  icon.textContent   = debugCollapsed ? '▼ 展開' : '▲ 收合';
});

document.getElementById('debugCopyBtn').addEventListener('click', e => {
  e.stopPropagation();
  const entries = Array.from(document.querySelectorAll('#debugLog span'))
    .map(s => s.textContent)
    .reverse()
    .join('\n');
  navigator.clipboard.writeText(entries).then(() => {
    const btn = document.getElementById('debugCopyBtn');
    btn.textContent = '已複製！';
    setTimeout(() => { btn.textContent = '複製全部'; }, 1500);
  });
});

// ─── SSE 連線 ─────────────────────────────────────────────
function connectSSE() {
  addDebugLog('正在連線 Debug/SSE...', 'var(--muted)');
  const es = new EventSource('/api/events');

  es.onopen = () => {
    addDebugLog('Debug/SSE 已連線', 'var(--green)');
  };

  es.addEventListener('round', e => {
    const roundData = JSON.parse(e.data);
    roundData.round += roundOffset;  // 接續局號
    processRound(roundData);
    addDebugLog(`收到第 ${roundData.round} 局資料`, 'var(--green)');
  });

  es.addEventListener('status', e => {
    const data = JSON.parse(e.data);
    // 將伺服器的相對進度換算成實際絕對進度
    if (data.collecting) {
      data.current = (data.current || 0) + roundOffset;
      data.target  = collectedTarget || data.target || 0;
    } else {
      data.current = appStats.totalRounds;
      data.target  = collectedTarget || data.target || 0;
    }
    updateStatus(data);
  });

  es.addEventListener('debug', e => {
    addDebugLog(JSON.parse(e.data).msg);
  });

  es.addEventListener('error', e => {
    if (!e.data) return;
    const data = JSON.parse(e.data);
    addDebugLog(`${data.message}`, 'var(--red)');
    alert(`錯誤：${data.message}`);
    updateStatus({ collecting: false, current: appStats.totalRounds, target: 0, message: `錯誤：${data.message}` });
  });

  es.onerror = () => {
    addDebugLog('Debug/SSE 連線中斷，3 秒後重連', 'var(--red)');
    es.close();
    setTimeout(connectSSE, 3000);
  };
}

// ─── 開始收集 ─────────────────────────────────────────────
document.getElementById('startBtn').addEventListener('click', async () => {
  const url    = document.getElementById('urlInput').value.trim();
  const target = parseInt(document.getElementById('roundsInput').value) || 100;

  if (!url) { alert('請輸入遊戲網址'); return; }

  // 計算剩餘需要收集的局數
  const already   = appStats.totalRounds;
  const remaining = target - already;

  if (remaining <= 0) {
    alert(`已收集 ${already} 局，已達到或超過目標 ${target} 局。\n請清空後重新設定。`);
    return;
  }

  // 快照本次 offset 與目標
  collectedTarget = target;
  roundOffset     = already;

  document.getElementById('startBtn').disabled = true;
  document.getElementById('stopBtn').disabled  = false;
  isCollecting = true;
  writeRunCache({ collecting: true, url, target, current: already, roundOffset });

  const res  = await fetch('/api/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, rounds: remaining })
  });
  const json = await res.json();

  if (!json.ok) {
    alert(`${json.error}`);
    if (String(json.error || '').includes('已在收集中')) {
      updateStatus({ collecting: true, current: already, target: collectedTarget, message: '後端仍在收集中，可直接停止' });
    } else {
      clearRunCache();
      document.getElementById('startBtn').disabled = false;
      document.getElementById('stopBtn').disabled  = true;
      isCollecting = false;
    }
  } else {
    updateStatus({ collecting: true, current: already, target: collectedTarget, message: '啟動中...' });
  }
});

// ─── 停止 ─────────────────────────────────────────────────
document.getElementById('stopBtn').addEventListener('click', async () => {
  document.getElementById('stopBtn').disabled = true;
  await fetch('/api/stop', { method: 'POST' });
  clearRunCache();
  updateStatus({ collecting: false, current: appStats.totalRounds, target: collectedTarget, message: `已停止，共收集 ${appStats.totalRounds} 局` });
});

// ─── 清空 ─────────────────────────────────────────────────
document.getElementById('clearBtn').addEventListener('click', async () => {
  if (isCollecting && !confirm('目前正在收集中，確定要清空並停止嗎？')) return;
  if (isCollecting) await fetch('/api/stop', { method: 'POST' });

  Object.assign(appStats, {
    totalRounds: 0,
    m2: { total: 0, counts: {} },
    m3: { total: 0, counts: {} },
    ad: { total: 0, counts: {} },
    at: { total: 0, counts: {} },
    bonusType: { total: 0, m2: 0, m3: 0 },
    sidePool:  { total: 0, ad: 0, at: 0, both: 0 },
    drawCount: { ge1: 0, ge2: 0, ge3: 0, eq4: 0 }
  });
  allRounds.length = 0;
  firstRow = true;
  isCollecting = false;
  collectedTarget = 0;
  roundOffset     = 0;
  clearRunCache();

  initStatTables();
  updateBonusTypeCard();
  updateSidePoolCard();
  updateDrawCountCard();
  document.getElementById('detailTbody').innerHTML =
    '<tr id="emptyRow"><td colspan="6" style="text-align:center;padding:24px;color:var(--muted);">等待資料...</td></tr>';
  document.getElementById('detailCount').textContent  = '(0 局)';
  document.getElementById('exportStatsBtn').disabled  = true;
  document.getElementById('exportDetailBtn').disabled = true;
  document.getElementById('startBtn').disabled = false;
  document.getElementById('stopBtn').disabled  = true;
  document.getElementById('progressBar').style.width = '0%';

  // 清空偵錯日誌
  debugCount = 0;
  document.getElementById('debugLog').innerHTML = '<span style="color:var(--muted);">等待偵錯訊息...</span>';
  document.getElementById('debugCount').textContent = '(0 筆)';

  updateStatus({ collecting: false, current: 0, target: 0, message: '已清空，可重新開始' });
});

// ─── 明細展開/收合 ────────────────────────────────────────
const detailToggle = document.getElementById('detailToggle');
if (detailToggle) {
  detailToggle.addEventListener('click', () => {
    const body = document.getElementById('detailBody');
    const icon = document.getElementById('toggleIcon');
    if (!body || !icon) return;
    detailCollapsed = !detailCollapsed;
    body.style.display  = detailCollapsed ? 'none' : 'block';
    icon.textContent    = detailCollapsed ? '▼ 展開' : '▲ 收合';
  });
}

// ─── CSV 工具函式 ─────────────────────────────────────────
function downloadCSV(rows, filename) {
  const lines = rows.map(row =>
    row.map(cell => {
      const s = String(cell ?? '').replace(/"/g, '""');
      return /[,"\n]/.test(s) ? `"${s}"` : s;
    }).join(',')
  );
  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ─── 匯出統計 CSV ─────────────────────────────────────────
document.getElementById('exportStatsBtn').addEventListener('click', () => {
  const rows = [['類別', '倍率', '權重', '期望%', '實際次數', '實際%', '差值%', '狀態']];

  for (const [key, spec] of Object.entries(V2_SPEC)) {
    const cat   = appStats[key];
    const total = cat.total;

    for (const rate of spec.rates) {
      const count = cat.counts[rate] || 0;
      const expPct = (spec.weights[rate] / spec.totalWeight * 100).toFixed(2);
      let actPct = '—', diffStr = '—', status = '—';

      if (total > 0) {
        const ap   = count / total * 100;
        const ep   = spec.weights[rate] / spec.totalWeight * 100;
        const diff = ap - ep;
        actPct  = ap.toFixed(2);
        diffStr = (diff >= 0 ? '+' : '') + diff.toFixed(2);
        status  = Math.abs(diff) < 5 ? '正常' : Math.abs(diff) < 10 ? '留意' : '偏差';
      }

      rows.push([
        spec.label, `${rate}x`, spec.weights[rate],
        `${expPct}%`, count,
        total > 0 ? `${actPct}%` : '—',
        total > 0 ? `${diffStr}%` : '—',
        status
      ]);
    }
  }

  // CGBOV2-17：主注區獎勵類型
  rows.push(['', '', '', '', '', '', '', '']);
  const btTotal = appStats.bonusType.total;
  for (const { key, label, expected } of [
    { key: 'm2', label: '2同', expected: 100 / 3 },
    { key: 'm3', label: '3同', expected: 200 / 3 }
  ]) {
    const count = appStats.bonusType[key];
    let actPct = '—', diffStr = '—', status = '—';
    if (btTotal > 0) {
      const ap = count / btTotal * 100;
      const diff = ap - expected;
      actPct  = ap.toFixed(2);
      diffStr = (diff >= 0 ? '+' : '') + diff.toFixed(2);
      status  = Math.abs(diff) < 5 ? '正常' : Math.abs(diff) < 10 ? '留意' : '偏差';
    }
    rows.push([
      '主注區獎勵類型', label, '—',
      expected.toFixed(2) + '%', count,
      btTotal > 0 ? actPct + '%' : '—',
      btTotal > 0 ? diffStr + '%' : '—',
      status
    ]);
  }

  // CGBOV2-18：旁注區獎勵類型
  rows.push(['', '', '', '', '', '', '', '']);
  const spTotal = appStats.sidePool.total;
  for (const { key, label, expected } of [
    { key: 'ad',   label: 'AD 池',   expected: 40 },
    { key: 'at',   label: 'AT 池',   expected: 31 },
    { key: 'both', label: 'Both 池', expected: 29 }
  ]) {
    const count = appStats.sidePool[key];
    let actPct = '—', diffStr = '—', status = '—';
    if (spTotal > 0) {
      const ap = count / spTotal * 100;
      const diff = ap - expected;
      actPct  = ap.toFixed(2);
      diffStr = (diff >= 0 ? '+' : '') + diff.toFixed(2);
      status  = Math.abs(diff) < 5 ? '正常' : Math.abs(diff) < 10 ? '留意' : '偏差';
    }
    rows.push([
      '旁注區獎勵類型', label, '—',
      expected.toFixed(2) + '%', count,
      spTotal > 0 ? actPct + '%' : '—',
      spTotal > 0 ? diffStr + '%' : '—',
      status
    ]);
  }

  // CGBOV2-14：四次是否選顏色命中率
  rows.push(['', '', '', '', '', '', '', '']);
  const total = appStats.totalRounds;
  const { ge1, ge2, ge3, eq4 } = appStats.drawCount;
  for (const { label, base, hit, expected } of [
    { label: '第一抽', base: total, hit: ge1, expected: 96 },
    { label: '第二抽', base: ge1,   hit: ge2, expected: 79 },
    { label: '第三抽', base: ge2,   hit: ge3, expected: 53 },
    { label: '第四抽', base: ge3,   hit: eq4, expected: 12 }
  ]) {
    let actPct = '—', diffStr = '—', status = '—';
    if (base > 0) {
      const ap = hit / base * 100;
      const diff = ap - expected;
      actPct  = ap.toFixed(2);
      diffStr = (diff >= 0 ? '+' : '') + diff.toFixed(2);
      status  = Math.abs(diff) < 5 ? '正常' : Math.abs(diff) < 10 ? '留意' : '偏差';
    }
    rows.push([
      '四次是否選顏色命中率', label, `母數 ${base} / 命中 ${hit}`,
      expected.toFixed(2) + '%', hit,
      base > 0 ? actPct + '%' : '—',
      base > 0 ? diffStr + '%' : '—',
      status
    ]);
  }

  downloadCSV(rows, `bonus_v2_stats_${Date.now()}.csv`);
});

// ─── 匯出明細 CSV ─────────────────────────────────────────
document.getElementById('exportDetailBtn').addEventListener('click', () => {
  const rows = [[
    '局號', '時間',
    'Single_M2_顏色', 'Single_M2_倍率',
    'Single_M3_顏色', 'Single_M3_倍率',
    'AnyDouble_顏色', 'AnyDouble_倍率',
    'AnyTriple_顏色', 'AnyTriple_倍率'
  ]];

  for (const r of allRounds) {
    rows.push([
      r.round, r.time,
      (r.single_m2 || []).map(i => i.color).join(';'),
      (r.single_m2 || []).map(i => i.rate).join(';'),
      (r.single_m3 || []).map(i => i.color).join(';'),
      (r.single_m3 || []).map(i => i.rate).join(';'),
      r.any_double?.color ?? '',
      r.any_double?.rate  ?? '',
      r.any_triple?.color ?? '',
      r.any_triple?.rate  ?? ''
    ]);
  }

  downloadCSV(rows, `bonus_v2_detail_${Date.now()}.csv`);
});

// ─── 啟動 ────────────────────────────────────────────────
initStatTables();
restoreCachedRun();
connectSSE();
