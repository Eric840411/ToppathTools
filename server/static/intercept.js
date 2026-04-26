/**
 * Log 攔截工具 — 注入腳本
 * 貼入瀏覽器 Console 後，自動攔截所有 /api/log XHR 請求
 * 解析雙層 JSON（outer + jsondata inner），驗證欄位完整性並顯示浮動面板
 */
(function () {
  if (window.__logChecker) { window.__logChecker.destroy(); }

  /* ─── 設定 ─── */
  const TARGET_PATH = '/api/log';
  const VALIDATE_FIELDS_DEFAULT = ['eventid', 'gameid', 'roundid', 'userid', 'bet', 'win'];
  const EXPORT_FIELDS_DEFAULT   = ['eventid', 'gameid', 'roundid', 'userid', 'bet', 'win', 'balance'];

  /* ─── 狀態 ─── */
  let records = [];
  let validateFields = [...VALIDATE_FIELDS_DEFAULT];
  let exportFields   = [...EXPORT_FIELDS_DEFAULT];
  let isPaused = false;

  /* ─── XHR 攔截 ─── */
  const OrigXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OrigXHR();
    let _url = '';
    const origOpen = xhr.open.bind(xhr);
    xhr.open = function (method, url, ...rest) {
      _url = url;
      return origOpen(method, url, ...rest);
    };
    xhr.addEventListener('load', function () {
      if (!_url.includes(TARGET_PATH)) return;
      if (isPaused) return;
      try {
        const outer = JSON.parse(xhr.responseText);
        let inner = {};
        if (outer.jsondata) {
          try { inner = JSON.parse(outer.jsondata); } catch (_) {}
        }
        const merged = { ...outer, ...inner };
        const missing = validateFields.filter(f => merged[f] == null || merged[f] === '');
        records.unshift({ ts: new Date().toLocaleTimeString(), data: merged, missing, url: _url });
        if (records.length > 500) records.pop();
        renderList();
      } catch (_) {}
    });
    return xhr;
  }
  PatchedXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;

  /* ─── 面板 DOM ─── */
  const panel = document.createElement('div');
  panel.id = '__log-checker-panel';
  Object.assign(panel.style, {
    position: 'fixed', bottom: '20px', right: '20px', width: '520px', maxHeight: '70vh',
    background: '#0f172a', color: '#e2e8f0', borderRadius: '12px', fontFamily: 'monospace',
    fontSize: '12px', boxShadow: '0 8px 32px rgba(0,0,0,0.5)', zIndex: '999999',
    display: 'flex', flexDirection: 'column', overflow: 'hidden', userSelect: 'none',
  });

  panel.innerHTML = `
    <div id="lc-header" style="padding:10px 14px;background:#1e293b;cursor:move;display:flex;align-items:center;gap:8px;border-radius:12px 12px 0 0">
      <span style="font-weight:700;color:#818cf8;font-size:13px">🔍 Log 攔截工具</span>
      <span id="lc-count" style="background:#334155;padding:2px 8px;border-radius:99px;font-size:11px">0 筆</span>
      <span style="flex:1"></span>
      <button id="lc-pause" style="background:#334155;border:none;color:#94a3b8;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:11px">暫停</button>
      <button id="lc-clear" style="background:#334155;border:none;color:#94a3b8;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:11px">清除</button>
      <button id="lc-export" style="background:#6366f1;border:none;color:#fff;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:11px">CSV</button>
      <button id="lc-settings-btn" style="background:#334155;border:none;color:#94a3b8;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:11px">⚙</button>
      <button id="lc-close" style="background:#dc2626;border:none;color:#fff;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:11px">✕</button>
    </div>
    <div id="lc-settings" style="display:none;padding:10px 14px;background:#1e293b;border-top:1px solid #334155">
      <div style="margin-bottom:6px;font-size:11px;color:#94a3b8">驗證欄位（逗號分隔）：</div>
      <input id="lc-vfields" style="width:100%;box-sizing:border-box;background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:4px 8px;border-radius:4px;font-family:monospace;font-size:11px" value="${validateFields.join(', ')}" />
      <div style="margin:6px 0 4px;font-size:11px;color:#94a3b8">匯出欄位（逗號分隔）：</div>
      <input id="lc-efields" style="width:100%;box-sizing:border-box;background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:4px 8px;border-radius:4px;font-family:monospace;font-size:11px" value="${exportFields.join(', ')}" />
      <button id="lc-apply" style="margin-top:8px;background:#6366f1;border:none;color:#fff;padding:4px 14px;border-radius:4px;cursor:pointer;font-size:11px">套用</button>
    </div>
    <div id="lc-list" style="overflow-y:auto;flex:1;padding:8px"></div>
  `;
  document.body.appendChild(panel);

  /* ─── 渲染 ─── */
  function renderList() {
    const list = document.getElementById('lc-list');
    const cnt  = document.getElementById('lc-count');
    if (!list || !cnt) return;
    cnt.textContent = `${records.length} 筆`;
    list.innerHTML = records.slice(0, 100).map((r, i) => {
      const hasErr = r.missing.length > 0;
      const bg = hasErr ? '#450a0a' : (i % 2 === 0 ? '#0f172a' : '#111827');
      const preview = validateFields.map(f => {
        const v = r.data[f];
        const ok = v != null && v !== '';
        return `<span style="color:${ok ? '#86efac' : '#f87171'}">${f}=${ok ? String(v).slice(0, 20) : '✗'}</span>`;
      }).join(' ');
      return `<div style="padding:6px 8px;border-radius:6px;margin-bottom:4px;background:${bg};cursor:pointer;border:1px solid ${hasErr ? '#7f1d1d' : 'transparent'}" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'">
        <div style="display:flex;justify-content:space-between;margin-bottom:3px">
          <span style="color:#64748b">${r.ts}</span>
          ${hasErr ? `<span style="color:#f87171;font-size:10px">缺：${r.missing.join(', ')}</span>` : '<span style="color:#86efac;font-size:10px">✅ 完整</span>'}
        </div>
        <div style="line-height:1.8;word-break:break-all">${preview}</div>
      </div>
      <pre style="display:none;background:#1e293b;padding:8px;border-radius:6px;margin-bottom:8px;white-space:pre-wrap;word-break:break-all;font-size:10px;color:#94a3b8;max-height:200px;overflow:auto">${JSON.stringify(r.data, null, 2)}</pre>`;
    }).join('');
  }

  /* ─── 拖曳 ─── */
  const header = document.getElementById('lc-header');
  let dragX = 0, dragY = 0;
  header.addEventListener('mousedown', e => {
    if (e.target !== header && !header.contains(e.target)) return;
    dragX = e.clientX - panel.getBoundingClientRect().left;
    dragY = e.clientY - panel.getBoundingClientRect().top;
    const move = ev => {
      panel.style.left = (ev.clientX - dragX) + 'px';
      panel.style.top  = (ev.clientY - dragY) + 'px';
      panel.style.bottom = 'auto'; panel.style.right = 'auto';
    };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  /* ─── 按鈕事件 ─── */
  document.getElementById('lc-close').onclick = () => destroy();
  document.getElementById('lc-clear').onclick = () => { records = []; renderList(); };
  document.getElementById('lc-pause').onclick = function() {
    isPaused = !isPaused;
    this.textContent = isPaused ? '▶ 繼續' : '暫停';
    this.style.background = isPaused ? '#f59e0b' : '#334155';
  };
  document.getElementById('lc-settings-btn').onclick = () => {
    const s = document.getElementById('lc-settings');
    s.style.display = s.style.display === 'none' ? 'block' : 'none';
  };
  document.getElementById('lc-apply').onclick = () => {
    validateFields = document.getElementById('lc-vfields').value.split(',').map(s => s.trim()).filter(Boolean);
    exportFields   = document.getElementById('lc-efields').value.split(',').map(s => s.trim()).filter(Boolean);
    document.getElementById('lc-settings').style.display = 'none';
    renderList();
  };
  document.getElementById('lc-export').onclick = () => {
    if (!records.length) return;
    const headers = [...exportFields, 'ts', 'missing'];
    const rows = records.map(r => [
      ...exportFields.map(f => String(r.data[f] ?? '')),
      r.ts,
      r.missing.join(' | ')
    ]);
    const csv = [headers, ...rows].map(row => row.map(v => `"${v.replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `log-checker-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.csv`; a.click();
  };

  /* ─── 清理 ─── */
  function destroy() {
    window.XMLHttpRequest = OrigXHR;
    panel.remove();
    delete window.__logChecker;
  }
  window.__logChecker = { destroy };
  console.log('%c[Log Checker] 已啟動，攔截路徑：' + TARGET_PATH, 'color:#818cf8;font-weight:bold');
})();
