const qs = (s) => document.querySelector(s);
const qsa = (s) => Array.from(document.querySelectorAll(s));

const runModeEl = qs('#cmp-run-mode');
const oldFileLabelEl = qs('#cmp-old-file-label');
const oldFileTextEl = qs('#cmp-old-file-text');
const newFileLabelEl = qs('#cmp-new-file-label');
const fileGridEl = oldFileLabelEl?.closest('.compare-grid') || qs('.compare-grid');
const oldFileEl = qs('#cmp-old-file');
const newFileEl = qs('#cmp-new-file');
const matchModeEl = qs('#cmp-match-mode');
const customWrap = qs('#cmp-custom-wrap');
const requiredWrap = qs('#cmp-required-wrap');
const requiredFieldsEl = qs('#cmp-required-fields');
const autoFieldsWrap = qs('#cmp-auto-fields-wrap');
const autoFieldsNoteEl = qs('#cmp-auto-fields-note');
const autoFieldsSearchEl = qs('#cmp-auto-search');
const autoFieldsFilterEl = qs('#cmp-auto-filter');
const autoFieldsRootEl = qs('#cmp-auto-fields-root');
const autoFieldsDataEl = qs('#cmp-auto-fields-data');
const autoSelectRecommendedBtn = qs('#cmp-auto-select-recommended');
const autoSelectAllBtn = qs('#cmp-auto-select-all');
const autoClearBtn = qs('#cmp-auto-clear');
const autoApplyBtn = qs('#cmp-auto-apply');
const enableOuter = qs('#cmp-enable-outer');
const outerWrap = qs('#cmp-outer-wrap');
const runBtn = qs('#cmp-run');
const downloadBtn = qs('#cmp-download');
const summaryEl = qs('#cmp-summary');
const tabsEl = qs('#cmp-tabs');
const panelAll = qs('#cmp-panel-all');
const panelMissing = qs('#cmp-panel-missing-group');
const panelJson = qs('#cmp-panel-jsondata');
const panelOuter = qs('#cmp-panel-outer');
const tabMissingBtn = qs('.cmp-tab-btn[data-tab="missing-group"]');
const tabJsonBtn = qs('.cmp-tab-btn[data-tab="jsondata"]');
const tabOuterBtn = qs('.cmp-tab-btn[data-tab="outer"]');
let lastDiffRows = [];
let lastScannedAutoFields = [];
const selectedAutoFields = new Set();

function esc(v) { return String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
function t(v) { if (Array.isArray(v)) return 'array'; if (v === null) return 'null'; return typeof v; }
function parseMaybeJson(v) { if (typeof v === 'string') { try { return JSON.parse(v); } catch { return {}; } } return v && typeof v === 'object' ? v : {}; }
function fmtSample(v) { if (v === undefined) return ''; if (v === null) return 'null'; if (typeof v === 'string') return v; try { return JSON.stringify(v); } catch { return String(v); } }
function pathLabel(p) { return p === '$' ? 'jsondata(根節點)' : p; }
function issueLabel(k) {
  return ({
    match: '一致',
    missing_group: '整組缺失',
    extra_path: '新增欄位',
    missing_path: '缺少欄位',
    type_mismatch: '型別變更',
    outer_extra: 'data/root 欄位新增',
    outer_missing: 'data/root 欄位缺失',
    outer_type_mismatch: 'data/root 欄位型別變更',
    validate_missing: '欄位缺失',
    validate_empty: '欄位為空',
    validate_partial_missing: '欄位部分缺失',
    validate_field_ok: '欄位完整'
  })[k] || k;
}
function issueDesc(row) {
  if (row.issue_type === 'missing_group') return `此匹配組在新舊其中一側不存在（舊版 ${row.old_value} 筆 / 新版 ${row.new_value} 筆）。`;
  if (row.issue_type === 'extra_path') return '新版出現舊版沒有的 jsondata 欄位。';
  if (row.issue_type === 'missing_path') return '新版缺少舊版已有的 jsondata 欄位。';
  if (row.issue_type === 'type_mismatch') return '同一路徑欄位型別不同，可能影響下游解析。';
  if (row.issue_type === 'outer_extra') return '新版多出 data/root 欄位。';
  if (row.issue_type === 'outer_missing') return '新版缺少 data/root 欄位。';
  if (row.issue_type === 'outer_type_mismatch') return 'data/root 欄位型別不同。';
  if (row.issue_type === 'validate_missing') return '此欄位在該匹配組中完全缺失。';
  if (row.issue_type === 'validate_empty') return '此欄位存在但為空字串，請確認是否可接受。';
  if (row.issue_type === 'validate_partial_missing') return '此欄位在該匹配組中僅部分筆數有值。';
  if (row.issue_type === 'validate_field_ok') return '此欄位在該匹配組完整。';
  if (row.issue_type === 'match') return '路徑存在且型別一致。';
  return '';
}
function matchTarget(key) { return key.replaceAll('(empty:function_name)', 'function_name(空)').replaceAll('(empty:event)', 'event(空)').replaceAll('|', ' / '); }

function toCsv(rows, headers) {
  const lines = [headers.join(',')];
  rows.forEach((row) => {
    const line = headers.map((h) => {
      const v = row[h] ?? '';
      const s = String(v).replace(/"/g, '""');
      return s.includes(',') || s.includes('\n') ? `"${s}"` : s;
    }).join(',');
    lines.push(line);
  });
  return `\uFEFF${lines.join('\n')}`;
}

function getPathValue(obj, path) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (path === '$') return obj;
  const parts = path.split('.');
  let cur = obj;
  for (const p0 of parts) {
    const p = p0.endsWith('[]') ? p0.slice(0, -2) : p0;
    cur = p ? cur?.[p] : cur;
    if (p0.endsWith('[]')) cur = Array.isArray(cur) ? cur[0] : undefined;
    if (cur === undefined || cur === null) return cur;
  }
  return cur;
}

function getDataOrRootValue(record, field) {
  if (!record || !field) return undefined;
  if (field.startsWith('root.')) return record.root?.[field.slice(5)];
  if (field.startsWith('data.')) return record.data?.[field.slice(5)];
  return record.data?.[field];
}

function collectSchema(value, prefix, out, ignore) {
  const p = prefix || '$';
  const leaf = p.split('.').pop().replace('[]', '');
  if (ignore.has(p) || ignore.has(leaf)) return;
  out[p] = t(value);
  if (out[p] === 'array') {
    if (value.length > 0) collectSchema(value[0], `${p}[]`, out, ignore); else out[`${p}[]`] = 'unknown';
    return;
  }
  if (out[p] === 'object') {
    Object.keys(value).sort().forEach((k) => {
      if (ignore.has(k)) return;
      collectSchema(value[k], p === '$' ? k : `${p}.${k}`, out, ignore);
    });
  }
}

function normalize(payload, ignore) {
  return (Array.isArray(payload) ? payload : []).map((item, idx) => {
    const root = item && typeof item === 'object' ? item : {};
    const body = root.payload && typeof root.payload === 'object' ? root.payload : root;
    const data = body.data && typeof body.data === 'object' ? body.data : body;
    const json = parseMaybeJson(data.jsondata);
    const schema = {};
    collectSchema(json, '$', schema, ignore);
    return {
      index: idx + 1,
      function_name: json.function_name || data.function_name || body.function_name || '',
      event: body.event || data.event || json.event || '',
      root: body,
      data,
      json,
      schema
    };
  });
}

function parseExcludeKeywords() {
  const input = qs('#cmp-exclude-events');
  return (input?.value || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function filterByExcludedEvents(records, excludeKeywords) {
  if (!excludeKeywords.length) return records;
  return records.filter((r) => {
    const ev = String(r.event || '').toLowerCase();
    return !excludeKeywords.some((kw) => ev.includes(kw));
  });
}

function scanValidateCandidates(records) {
  const total = records.length || 1;
  const stats = new Map();
  records.forEach((r) => {
    const root = r.root && typeof r.root === 'object' ? r.root : {};
    const data = r.data && typeof r.data === 'object' ? r.data : {};
    Object.keys(root).forEach((k) => {
      if (k === 'data' || k === 'extra' || k === 'abtest') return;
      const key = `root.${k}`;
      if (!stats.has(key)) stats.set(key, { present: 0, empty: 0 });
      const v = root[k];
      if (v === undefined || v === null) return;
      if (v === '') { stats.get(key).empty += 1; return; }
      stats.get(key).present += 1;
    });
    Object.keys(data).forEach((k) => {
      if (k === 'extra' || k === 'abtest' || k === 'jsondata') return;
      if (!stats.has(k)) stats.set(k, { present: 0, empty: 0 });
      const v = data[k];
      if (v === undefined || v === null) return;
      if (v === '') { stats.get(k).empty += 1; return; }
      stats.get(k).present += 1;
    });
  });
  return Array.from(stats.entries())
    .map(([field, st]) => {
      const presence = Math.round((st.present / total) * 1000) / 10;
      const missing = Math.max(total - st.present - st.empty, 0);
      return {
        field,
        present: st.present,
        empty: st.empty,
        missing,
        presence,
        recommended: presence >= 95
      };
    })
    .sort((a, b) => {
      if (b.recommended !== a.recommended) return Number(b.recommended) - Number(a.recommended);
      if (b.presence !== a.presence) return b.presence - a.presence;
      return a.field.localeCompare(b.field);
    });
}

function renderAutoFields(candidates) {
  if (!autoFieldsRootEl || !autoFieldsDataEl || !autoFieldsNoteEl) return;
  if (!candidates.length) {
    autoFieldsNoteEl.textContent = '找不到可推薦欄位（請確認 JSON 內容）。';
    autoFieldsRootEl.innerHTML = '<div class="cmp-auto-empty">無可顯示欄位</div>';
    autoFieldsDataEl.innerHTML = '<div class="cmp-auto-empty">無可顯示欄位</div>';
    return;
  }
  const keyword = (autoFieldsSearchEl?.value || '').trim().toLowerCase();
  const filter = autoFieldsFilterEl?.value || 'all';
  const filtered = candidates.filter((c) => {
    if (keyword && !c.field.toLowerCase().includes(keyword)) return false;
    if (filter === 'recommended' && !c.recommended) return false;
    if (filter === 'missing' && c.missing <= 0) return false;
    if (filter === 'checked') {
      if (!selectedAutoFields.has(c.field)) return false;
    }
    return true;
  });
  const recCount = candidates.filter((c) => c.recommended).length;
  autoFieldsNoteEl.textContent = `已掃描 ${candidates.length} 欄位，推薦 ${recCount} 個（出現率 >= 95%），目前顯示 ${filtered.length} 個`;
  const toItem = (c) => `
    <label class="cmp-auto-field-item">
      <span><input type="checkbox" class="cmp-auto-field-check" data-field="${esc(c.field)}" ${selectedAutoFields.has(c.field) ? 'checked' : ''}> ${esc(c.field)}</span>
      <span class="cmp-auto-field-meta">出現率 ${c.presence}%｜缺失 ${c.missing}｜空值 ${c.empty}</span>
    </label>
  `;
  const rootList = filtered.filter((c) => c.field.startsWith('root.'));
  const dataList = filtered.filter((c) => !c.field.startsWith('root.'));
  autoFieldsRootEl.innerHTML = rootList.length ? rootList.map(toItem).join('') : '<div class="cmp-auto-empty">無符合欄位</div>';
  autoFieldsDataEl.innerHTML = dataList.length ? dataList.map(toItem).join('') : '<div class="cmp-auto-empty">無符合欄位</div>';
}

function keyOf(r, mode, fields) {
  if (mode === 'function_name') return r.function_name || '(empty:function_name)';
  if (mode === 'custom') {
    const x = fields.map((f) => `${f}=${getDataOrRootValue(r, f) ?? ''}`).join('|');
    return x || '(custom:empty)';
  }
  return `${r.function_name || '(empty:function_name)'}|${r.event || '(empty:event)'}`;
}

function groupBy(list, mode, fields) {
  const m = new Map();
  list.forEach((r) => {
    const k = keyOf(r, mode, fields);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  });
  return m;
}

function mergeSchema(records) {
  const m = new Map();
  records.forEach((r) => Object.entries(r.schema).forEach(([p, ty]) => {
    if (!m.has(p)) m.set(p, new Set());
    m.get(p).add(ty);
  }));
  return m;
}

function mergeOuter(records, fields) {
  const m = new Map();
  records.forEach((r) => fields.forEach((f) => {
    const value = getDataOrRootValue(r, f);
    if (value === undefined) return;
    if (!m.has(f)) m.set(f, new Set());
    m.get(f).add(t(value));
  }));
  return m;
}

function samplePath(records, path, source) {
  const vals = new Set();
  records.forEach((r) => {
    const raw = source === 'outer' ? getDataOrRootValue(r, path) : getPathValue(r.json, path);
    const fv = fmtSample(raw);
    if (fv !== '') vals.add(fv);
  });
  const a = Array.from(vals);
  if (!a.length) return '';
  if (a.length <= 2) return a.join(' | ');
  return `${a.slice(0, 2).join(' | ')} ... (共${a.length}種)`;
}

function seqText(records) {
  const s = new Set();
  records.forEach((r) => {
    const v = r.data?.seq_index ?? r.root?.seq_index;
    if (v !== undefined && v !== null && v !== '') s.add(String(v));
  });
  const a = Array.from(s);
  if (!a.length) return '';
  if (a.length <= 3) return a.join(' | ');
  return `${a.slice(0, 3).join(' | ')} ... (共${a.length}筆)`;
}

function tableRows(rows, options = {}) {
  if (!rows.length) return '<p class="status-pass">此分頁未發現差異。</p>';
  const validateMode = options.validateMode === true;
  if (validateMode) {
    return `<table><thead><tr><th>比對對象</th><th>結果</th><th>差異分類</th><th>欄位</th><th>規則</th><th>結果摘要</th><th>seq_index</th><th>說明</th></tr></thead><tbody>${
      rows.map((r) => `<tr><td>${esc(matchTarget(r.key))}</td><td>${esc(r.status)}</td><td>${esc(issueLabel(r.issue_type))}</td><td>${esc(r.field || '-')}</td><td>${esc(r.old_value || '-')}</td><td>${esc(r.new_value || '-')}</td><td>${esc(r.new_seq_index || '-')}</td><td>${esc(issueDesc(r))}</td></tr>`).join('')
    }</tbody></table>`;
  }
  return `<table><thead><tr><th>比對對象</th><th>狀態</th><th>差異分類</th><th>差異欄位</th><th>舊版</th><th>新版</th><th>舊版 seq_index</th><th>新版 seq_index</th><th>說明</th></tr></thead><tbody>${
    rows.map((r) => `<tr><td>${esc(matchTarget(r.key))}</td><td>${esc(r.status)}</td><td>${esc(issueLabel(r.issue_type))}</td><td>${esc(r.field || '-')}</td><td>${esc(r.old_value || '-')}</td><td>${esc(r.new_value || '-')}</td><td>${esc(r.old_seq_index || '-')}</td><td>${esc(r.new_seq_index || '-')}</td><td>${esc(issueDesc(r))}</td></tr>`).join('')
  }</tbody></table>`;
}

function accordion(groups, type) {
  if (!groups.length) return '<p class="status-pass">此分頁目前沒有可展開資料。</p>';
  return groups.map((g, i) => {
    const id = `${type}-${i}`;
    const headCols = type === 'json'
      ? '<th>欄位路徑</th><th>結果</th><th>差異分類</th><th>舊版型別</th><th>新版型別</th><th>舊版樣本值</th><th>新版樣本值</th><th>說明</th>'
      : '<th>欄位</th><th>結果</th><th>差異分類</th><th>舊版型別/期望</th><th>新版型別/實際</th><th>舊版樣本值</th><th>新版樣本值</th><th>說明</th>';
    return `<article class="json-acc-card">
      <button class="json-acc-toggle" data-target="${id}" type="button">
        <span class="json-acc-title">${esc(matchTarget(g.key))}</span>
        <span class="json-acc-meta">PASS ${g.passCount} / WARN ${g.warnCount} / FAIL ${g.failCount}</span>
        <span class="json-acc-meta">舊版 seq_index: ${esc(g.oldSeq || '-')}</span>
        <span class="json-acc-meta">新版 seq_index: ${esc(g.newSeq || '-')}</span>
      </button>
      <div id="${id}" class="json-acc-panel">
        <table><thead><tr>${headCols}</tr></thead><tbody>${
          g.details.map((d) => `<tr>
            <td>${esc(type === 'json' ? pathLabel(d.path) : (d.field || '-'))}</td>
            <td>${esc(d.status)}</td>
            <td>${esc(issueLabel(d.issue_type))}</td>
            <td>${esc(d.old_type || d.old_value || '-')}</td>
            <td>${esc(d.new_type || d.new_value || '-')}</td>
            <td>${esc(d.old_sample || '-')}</td>
            <td>${esc(d.new_sample || '-')}</td>
            <td>${esc(issueDesc({ issue_type: d.issue_type, old_value: d.old_type || d.old_value, new_value: d.new_type || d.new_value }) || '結構一致')}</td>
          </tr>`).join('')
        }</tbody></table>
      </div>
    </article>`;
  }).join('');
}

function renderValidateJsonSummary(keys, groups) {
  if (!keys.length) return '<p class="status-pass">此分頁沒有可顯示的 jsondata。</p>';
  return keys.map((key, idx) => {
    const records = groups.get(key) || [];
    const panelId = `validate-json-${idx}`;
    const preview = records.slice(0, 3);
    const more = records.length - preview.length;
    const seq = seqText(records) || '-';
    return `<article class="json-acc-card">
      <button class="json-acc-toggle" data-target="${panelId}" type="button">
        <span class="json-acc-title">${esc(matchTarget(key))}</span>
        <span class="json-acc-meta">樣本 ${preview.length}${more > 0 ? ` / ${records.length}` : ''}</span>
        <span class="json-acc-meta">seq_index: ${esc(seq)}</span>
      </button>
      <div id="${panelId}" class="json-acc-panel">
        ${preview.map((r, i) => `<div class="cmp-json-log">
          <div class="cmp-json-log-head">樣本 #${i + 1}（record #${r.index}）</div>
          <pre>${esc(JSON.stringify(r.json || {}, null, 2))}</pre>
        </div>`).join('')}
        ${more > 0 ? `<div class="cmp-json-log-more">... 還有 ${more} 筆可於原始 JSON 查看</div>` : ''}
      </div>
    </article>`;
  }).join('');
}

function renderValidateFieldGroups(groups) {
  if (!groups.length) return '<p class="status-pass">此分頁目前沒有可展開資料。</p>';
  return groups.map((g, i) => {
    const id = `validate-field-${i}`;
    return `<article class="json-acc-card">
      <button class="json-acc-toggle" data-target="${id}" type="button">
        <span class="json-acc-title">${esc(matchTarget(g.key))}</span>
        <span class="json-acc-meta">PASS ${g.passCount} / WARN ${g.warnCount} / FAIL ${g.failCount}</span>
        <span class="json-acc-meta">seq_index: ${esc(g.newSeq || '-')}</span>
      </button>
      <div id="${id}" class="json-acc-panel">
        <table><thead><tr>
          <th>欄位</th><th>結果</th><th>差異分類</th><th>規則</th><th>結果摘要</th><th>期望說明</th><th>實際樣本值</th><th>說明</th>
        </tr></thead><tbody>${
          g.details.map((d) => `<tr>
            <td>${esc(d.field || '-')}</td>
            <td>${esc(d.status)}</td>
            <td>${esc(issueLabel(d.issue_type))}</td>
            <td>${esc(d.old_value || '-')}</td>
            <td>${esc(d.new_value || '-')}</td>
            <td>${esc('此欄位為必填（required）')}</td>
            <td>${esc(d.new_sample || '-')}</td>
            <td>${esc(issueDesc({ issue_type: d.issue_type, old_value: d.old_value, new_value: d.new_value }))}</td>
          </tr>`).join('')
        }</tbody></table>
      </div>
    </article>`;
  }).join('');
}

function switchTab(btn) {
  qsa('.cmp-tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
  panelAll.classList.toggle('hidden', btn.dataset.tab !== 'all');
  panelMissing.classList.toggle('hidden', btn.dataset.tab !== 'missing-group');
  panelJson.classList.toggle('hidden', btn.dataset.tab !== 'jsondata');
  panelOuter.classList.toggle('hidden', btn.dataset.tab !== 'outer');
}

qsa('.cmp-tab-btn').forEach((btn) => btn.addEventListener('click', () => switchTab(btn)));
matchModeEl.addEventListener('change', () => customWrap.classList.toggle('hidden', matchModeEl.value !== 'custom'));
enableOuter.addEventListener('change', () => outerWrap.classList.toggle('hidden', !enableOuter.checked));
panelJson.addEventListener('click', (e) => { const b = e.target.closest('.json-acc-toggle'); if (b) qs(`#${b.dataset.target}`).classList.toggle('hidden'); });
panelOuter.addEventListener('click', (e) => { const b = e.target.closest('.json-acc-toggle'); if (b) qs(`#${b.dataset.target}`).classList.toggle('hidden'); });

function updateUiByRunMode() {
  const isValidate = runModeEl.value === 'validate';
  if (oldFileTextEl) oldFileTextEl.textContent = isValidate ? '驗證 JSON(原始)' : '舊版 JSON(原始)';
  newFileLabelEl.classList.toggle('hidden', isValidate);
  if (fileGridEl) fileGridEl.classList.toggle('cmp-file-grid-single', isValidate);
  oldFileEl.disabled = false;
  newFileEl.disabled = isValidate;
  if (isValidate) newFileEl.value = '';
  requiredWrap.classList.toggle('hidden', !isValidate);
  autoFieldsWrap?.classList.toggle('hidden', !isValidate);
  customWrap.classList.toggle('hidden', isValidate || matchModeEl.value !== 'custom');
  enableOuter.closest('.compare-grid').classList.toggle('hidden', isValidate);
  outerWrap.classList.add('hidden');
  tabMissingBtn.textContent = isValidate ? '缺失明細' : '整組缺失';
  tabJsonBtn.textContent = isValidate ? 'jsondata 摘要' : 'jsondata 結構差異';
  tabOuterBtn.textContent = isValidate ? '欄位分組摘要' : 'data/root 欄位差異';
}

runModeEl.addEventListener('change', updateUiByRunMode);
updateUiByRunMode();

async function refreshAutoFieldsFromUpload() {
  if (runModeEl.value !== 'validate' || !oldFileEl.files?.[0]) {
    lastScannedAutoFields = [];
    selectedAutoFields.clear();
    if (autoFieldsRootEl) autoFieldsRootEl.innerHTML = '';
    if (autoFieldsDataEl) autoFieldsDataEl.innerHTML = '';
    if (autoFieldsNoteEl) autoFieldsNoteEl.textContent = '上傳單檔後會依欄位出現率自動推薦（預設 >= 95%）';
    return;
  }
  try {
    const text = await oldFileEl.files[0].text();
    const payload = JSON.parse(text);
    const ignore = new Set(qs('#cmp-ignore-fields').value.split(',').map((s) => s.trim()).filter(Boolean));
    const excludeKeywords = parseExcludeKeywords();
    const records = filterByExcludedEvents(normalize(payload, ignore), excludeKeywords);
    lastScannedAutoFields = scanValidateCandidates(records);
    selectedAutoFields.clear();
    lastScannedAutoFields.forEach((f) => { if (f.recommended) selectedAutoFields.add(f.field); });
    renderAutoFields(lastScannedAutoFields);
  } catch (_e) {
    lastScannedAutoFields = [];
    if (autoFieldsNoteEl) autoFieldsNoteEl.textContent = '掃描失敗，請確認上傳的是有效 JSON(原始)。';
    if (autoFieldsRootEl) autoFieldsRootEl.innerHTML = '';
    if (autoFieldsDataEl) autoFieldsDataEl.innerHTML = '';
  }
}

oldFileEl.addEventListener('change', refreshAutoFieldsFromUpload);
qs('#cmp-ignore-fields').addEventListener('change', refreshAutoFieldsFromUpload);
qs('#cmp-exclude-events').addEventListener('change', refreshAutoFieldsFromUpload);
autoFieldsSearchEl?.addEventListener('input', () => renderAutoFields(lastScannedAutoFields));
autoFieldsFilterEl?.addEventListener('change', () => renderAutoFields(lastScannedAutoFields));
autoFieldsWrap?.addEventListener('change', (e) => {
  if (e.target && e.target.classList?.contains('cmp-auto-field-check')) {
    const field = e.target.getAttribute('data-field');
    if (field) {
      if (e.target.checked) selectedAutoFields.add(field);
      else selectedAutoFields.delete(field);
    }
    if (autoFieldsFilterEl?.value === 'checked') {
      renderAutoFields(lastScannedAutoFields);
    }
  }
});
autoSelectRecommendedBtn?.addEventListener('click', () => {
  selectedAutoFields.clear();
  lastScannedAutoFields.forEach((f) => { if (f.recommended) selectedAutoFields.add(f.field); });
  renderAutoFields(lastScannedAutoFields);
});
autoSelectAllBtn?.addEventListener('click', () => {
  selectedAutoFields.clear();
  lastScannedAutoFields.forEach((f) => selectedAutoFields.add(f.field));
  renderAutoFields(lastScannedAutoFields);
});
autoClearBtn?.addEventListener('click', () => {
  selectedAutoFields.clear();
  renderAutoFields(lastScannedAutoFields);
});
autoApplyBtn?.addEventListener('click', () => {
  const fields = Array.from(selectedAutoFields);
  requiredFieldsEl.value = fields.join(',');
});

function resetResultPanels() {
  tabsEl.classList.add('hidden');
  panelAll.innerHTML = '';
  panelMissing.innerHTML = '';
  panelJson.innerHTML = '';
  panelOuter.innerHTML = '';
  lastDiffRows = [];
  downloadBtn.disabled = true;
}

function runCompareMode(oldList, newList, oldSkip, newSkip, onlyFn) {
  const mode = matchModeEl.value;
  const customFields = qs('#cmp-custom-fields').value.split(',').map((s) => s.trim()).filter(Boolean);
  const outerFields = qs('#cmp-outer-fields').value.split(',').map((s) => s.trim()).filter(Boolean);
  const compareOuter = enableOuter.checked && outerFields.length > 0;

  const oldMap = groupBy(oldList, mode, customFields);
  const newMap = groupBy(newList, mode, customFields);
  const keys = Array.from(new Set([...oldMap.keys(), ...newMap.keys()])).sort();

  const rows = []; const jsonGroups = []; const outerGroups = [];
  let pass = 0; let warn = 0; let fail = 0;
  keys.forEach((key) => {
    const og = oldMap.get(key) || []; const ng = newMap.get(key) || [];
    const oldSeq = seqText(og); const newSeq = seqText(ng);
    if (!og.length || !ng.length) { fail += 1; rows.push({ key, status: 'FAIL', issue_type: 'missing_group', field: '', old_value: String(og.length), new_value: String(ng.length), old_seq_index: oldSeq, new_seq_index: newSeq }); return; }

    let hasFail = false; let hasWarn = false;
    const oldS = mergeSchema(og); const newS = mergeSchema(ng);
    const paths = Array.from(new Set([...oldS.keys(), ...newS.keys()])).sort();
    let jp = 0; let jw = 0; let jf = 0; const jd = [];
    paths.forEach((p) => {
      const ot = oldS.get(p); const nt = newS.get(p);
      const osv = samplePath(og, p, 'json'); const nsv = samplePath(ng, p, 'json');
      if (!ot && nt) { hasWarn = true; jw += 1; jd.push({ path: p, status: 'WARN', issue_type: 'extra_path', old_type: '', new_type: Array.from(nt).sort().join('|'), old_sample: osv, new_sample: nsv }); rows.push({ key, status: 'WARN', issue_type: 'extra_path', field: p, old_value: '', new_value: Array.from(nt).join('|'), old_seq_index: oldSeq, new_seq_index: newSeq }); return; }
      if (ot && !nt) { hasFail = true; jf += 1; jd.push({ path: p, status: 'FAIL', issue_type: 'missing_path', old_type: Array.from(ot).sort().join('|'), new_type: '', old_sample: osv, new_sample: nsv }); rows.push({ key, status: 'FAIL', issue_type: 'missing_path', field: p, old_value: Array.from(ot).join('|'), new_value: '', old_seq_index: oldSeq, new_seq_index: newSeq }); return; }
      const ots = Array.from(ot).sort().join('|'); const nts = Array.from(nt).sort().join('|');
      if (ots !== nts) { hasFail = true; jf += 1; jd.push({ path: p, status: 'FAIL', issue_type: 'type_mismatch', old_type: ots, new_type: nts, old_sample: osv, new_sample: nsv }); rows.push({ key, status: 'FAIL', issue_type: 'type_mismatch', field: p, old_value: ots, new_value: nts, old_seq_index: oldSeq, new_seq_index: newSeq }); }
      else { jp += 1; jd.push({ path: p, status: 'PASS', issue_type: 'match', old_type: ots, new_type: nts, old_sample: osv, new_sample: nsv }); }
    });
    jsonGroups.push({ key, oldSeq, newSeq, passCount: jp, warnCount: jw, failCount: jf, details: jd });

    if (compareOuter) {
      const oO = mergeOuter(og, outerFields); const nO = mergeOuter(ng, outerFields);
      let op = 0; let ow = 0; let of = 0; const od = [];
      outerFields.forEach((f) => {
        const ot = oO.get(f); const nt = nO.get(f); if (!ot && !nt) return;
        const osv = samplePath(og, f, 'outer'); const nsv = samplePath(ng, f, 'outer');
        if (!ot && nt) { hasWarn = true; ow += 1; od.push({ field: f, status: 'WARN', issue_type: 'outer_extra', old_value: '', new_value: Array.from(nt).join('|'), old_sample: osv, new_sample: nsv }); rows.push({ key, status: 'WARN', issue_type: 'outer_extra', field: f, old_value: '', new_value: Array.from(nt).join('|'), old_seq_index: oldSeq, new_seq_index: newSeq }); return; }
        if (ot && !nt) { hasFail = true; of += 1; od.push({ field: f, status: 'FAIL', issue_type: 'outer_missing', old_value: Array.from(ot).join('|'), new_value: '', old_sample: osv, new_sample: nsv }); rows.push({ key, status: 'FAIL', issue_type: 'outer_missing', field: f, old_value: Array.from(ot).join('|'), new_value: '', old_seq_index: oldSeq, new_seq_index: newSeq }); return; }
        const ots = Array.from(ot).sort().join('|'); const nts = Array.from(nt).sort().join('|');
        if (ots !== nts) { hasFail = true; of += 1; od.push({ field: f, status: 'FAIL', issue_type: 'outer_type_mismatch', old_value: ots, new_value: nts, old_sample: osv, new_sample: nsv }); rows.push({ key, status: 'FAIL', issue_type: 'outer_type_mismatch', field: f, old_value: ots, new_value: nts, old_seq_index: oldSeq, new_seq_index: newSeq }); }
        else { op += 1; od.push({ field: f, status: 'PASS', issue_type: 'match', old_value: ots, new_value: nts, old_sample: osv, new_sample: nsv }); }
      });
      outerGroups.push({ key, oldSeq, newSeq, passCount: op, warnCount: ow, failCount: of, details: od });
    }
    if (hasFail) fail += 1; else if (hasWarn) warn += 1; else pass += 1;
  });

  lastDiffRows = rows;
  downloadBtn.disabled = rows.length === 0;
  const cls = fail > 0 ? 'status-fail' : (warn > 0 ? 'status-warn' : 'status-pass');
  summaryEl.innerHTML = `<p class="${cls}">比對完成：PASS ${pass} / WARN ${warn} / FAIL ${fail}（共 ${keys.length} 組）</p><p>參與比對筆數：舊版 ${oldList.length} / 新版 ${newList.length}${onlyFn ? `（已跳過無 function_name：舊版 ${oldSkip} / 新版 ${newSkip}）` : ''}</p>`;
  panelAll.innerHTML = tableRows(rows);
  panelMissing.innerHTML = tableRows(rows.filter((r) => r.issue_type === 'missing_group'));
  panelJson.innerHTML = accordion(jsonGroups, 'json');
  panelOuter.innerHTML = compareOuter ? accordion(outerGroups, 'outer') : '<p>未啟用 data/root 欄位比對，本次無資料。</p>';
  tabsEl.classList.remove('hidden');
  switchTab(qs('.cmp-tab-btn[data-tab="all"]'));
}

function runValidateMode(list, onlyFn, skipped) {
  const requiredFields = requiredFieldsEl.value.split(',').map((s) => s.trim()).filter(Boolean);
  if (requiredFields.length === 0) {
    summaryEl.innerHTML = '<p class="status-fail">請至少填一個單檔驗證欄位。</p>';
    return;
  }
  const mode = matchModeEl.value;
  const customFields = qs('#cmp-custom-fields').value.split(',').map((s) => s.trim()).filter(Boolean);
  const groups = groupBy(list, mode, customFields);
  const keys = Array.from(groups.keys()).sort();
  const rows = [];
  const fieldGroups = [];
  const fieldStats = new Map();
  let pass = 0; let warn = 0; let fail = 0;

  keys.forEach((key) => {
    const records = groups.get(key) || [];
    const total = records.length;
    const oldSeq = '-';
    const newSeq = seqText(records);
    let gp = 0; let gw = 0; let gf = 0;
    const details = [];
    let hasFail = false;
    let hasWarn = false;

    requiredFields.forEach((field) => {
      let missing = 0;
      let empty = 0;
      const samples = new Set();
      records.forEach((r) => {
        const value = getDataOrRootValue(r, field);
        if (value === undefined || value === null) {
          missing += 1;
          return;
        }
        if (value === '') {
          empty += 1;
          return;
        }
        const f = fmtSample(value);
        if (f !== '') samples.add(f);
      });

      if (!fieldStats.has(field)) fieldStats.set(field, { total: 0, missing: 0, empty: 0, pass: 0 });
      const stat = fieldStats.get(field);
      stat.total += total;
      stat.missing += missing;
      stat.empty += empty;
      stat.pass += Math.max(total - missing - empty, 0);

      let status = 'PASS';
      let issueType = 'validate_field_ok';
      if (missing === total && total > 0) {
        status = 'FAIL';
        issueType = 'validate_missing';
        gf += 1;
        hasFail = true;
      } else if (missing > 0 || empty > 0) {
        status = 'WARN';
        issueType = 'validate_partial_missing';
        gw += 1;
        hasWarn = true;
      } else {
        gp += 1;
      }

      const expected = '必填';
      const actual = missing > 0 || empty > 0
        ? `有值 ${Math.max(total - missing - empty, 0)} 筆、缺失 ${missing} 筆、空值 ${empty} 筆`
        : `有值 ${total} 筆、缺失 0 筆、空值 0 筆`;
      const sampleText = Array.from(samples).slice(0, 2).join(' | ');
      details.push({
        field,
        status,
        issue_type: issueType,
        old_value: expected,
        new_value: actual,
        old_sample: '-',
        new_sample: sampleText || '-'
      });
      if (status !== 'PASS') {
        rows.push({
          key,
          status,
          issue_type: issueType,
          field,
          old_value: expected,
          new_value: actual,
          old_seq_index: oldSeq,
          new_seq_index: newSeq
        });
      }
    });

    fieldGroups.push({ key, oldSeq, newSeq, passCount: gp, warnCount: gw, failCount: gf, details });
    if (hasFail) fail += 1;
    else if (hasWarn) warn += 1;
    else pass += 1;
  });

  const statsRows = Array.from(fieldStats.entries()).sort((a, b) => (b[1].missing + b[1].empty) - (a[1].missing + a[1].empty)).map(([field, st]) => ({
    key: field,
    status: (st.missing + st.empty) > 0 ? 'WARN' : 'PASS',
    issue_type: (st.missing + st.empty) > 0 ? 'validate_partial_missing' : 'validate_field_ok',
    field,
    old_value: 'required',
    new_value: `有值 ${st.pass} 筆、缺失 ${st.missing} 筆、空值 ${st.empty} 筆`,
    old_seq_index: '-',
    new_seq_index: '-'
  }));

  lastDiffRows = [...rows, ...statsRows];
  downloadBtn.disabled = lastDiffRows.length === 0;
  const cls = fail > 0 ? 'status-fail' : (warn > 0 ? 'status-warn' : 'status-pass');
  summaryEl.innerHTML = `<p class="${cls}">單檔驗證完成：PASS ${pass} / WARN ${warn} / FAIL ${fail}（共 ${keys.length} 組）</p><p>參與驗證筆數：${list.length}${onlyFn ? `（已跳過無 function_name：${skipped}）` : ''}；驗證欄位：${requiredFields.length}</p>`;
  panelAll.innerHTML = tableRows(rows, { validateMode: true });
  panelMissing.innerHTML = tableRows(rows.filter((r) => r.issue_type !== 'validate_field_ok'), { validateMode: true });
  panelJson.innerHTML = renderValidateJsonSummary(keys, groups);
  panelOuter.innerHTML = renderValidateFieldGroups(fieldGroups);
  tabsEl.classList.remove('hidden');
  switchTab(qs('.cmp-tab-btn[data-tab="all"]'));
}

runBtn.addEventListener('click', async () => {
  const runMode = runModeEl.value;
  const oldFile = oldFileEl.files?.[0];
  const newFile = newFileEl.files?.[0];
  resetResultPanels();

  if (runMode === 'compare' && (!oldFile || !newFile)) {
    summaryEl.innerHTML = '<p class="status-fail">請先上傳舊版與新版 JSON。</p>';
    return;
  }
  if (runMode === 'validate' && !oldFile) {
    summaryEl.innerHTML = '<p class="status-fail">請先上傳單檔驗證 JSON。</p>';
    return;
  }

  try {
    const ignore = new Set(qs('#cmp-ignore-fields').value.split(',').map((s) => s.trim()).filter(Boolean));
    const excludeKeywords = parseExcludeKeywords();
    const onlyFn = qs('#cmp-only-has-function-name').checked;

    if (runMode === 'compare') {
      const oldJson = JSON.parse(await oldFile.text());
      const newJson = JSON.parse(await newFile.text());
      const rawOld = filterByExcludedEvents(normalize(oldJson, ignore), excludeKeywords);
      const rawNew = filterByExcludedEvents(normalize(newJson, ignore), excludeKeywords);
      const oldList = onlyFn ? rawOld.filter((r) => String(r.function_name || '').trim()) : rawOld;
      const newList = onlyFn ? rawNew.filter((r) => String(r.function_name || '').trim()) : rawNew;
      runCompareMode(oldList, newList, rawOld.length - oldList.length, rawNew.length - newList.length, onlyFn);
      return;
    }

    const validateJson = JSON.parse(await oldFile.text());
    const raw = filterByExcludedEvents(normalize(validateJson, ignore), excludeKeywords);
    const list = onlyFn ? raw.filter((r) => String(r.function_name || '').trim()) : raw;
    runValidateMode(list, onlyFn, raw.length - list.length);
  } catch (e) {
    summaryEl.innerHTML = `<p class="status-fail">處理失敗：${esc(e.message || '請確認上傳的是有效 JSON')}</p>`;
  }
});

downloadBtn.addEventListener('click', () => {
  if (!lastDiffRows.length) return;
  const isValidate = runModeEl.value === 'validate';
  const rows = lastDiffRows.map((r) => (isValidate
    ? {
        compare_target: matchTarget(r.key),
        status: r.status,
        issue_type: issueLabel(r.issue_type),
        field: r.field || '',
        rule: r.old_value || '',
        result_summary: r.new_value || '',
        seq_index: r.new_seq_index || '',
        description: issueDesc(r)
      }
    : {
        compare_target: matchTarget(r.key),
        status: r.status,
        issue_type: issueLabel(r.issue_type),
        field: r.field || '',
        old_value: r.old_value || '',
        new_value: r.new_value || '',
        old_seq_index: r.old_seq_index || '',
        new_seq_index: r.new_seq_index || '',
        description: issueDesc(r)
      }));
  const headers = isValidate
    ? ['compare_target', 'status', 'issue_type', 'field', 'rule', 'result_summary', 'seq_index', 'description']
    : ['compare_target', 'status', 'issue_type', 'field', 'old_value', 'new_value', 'old_seq_index', 'new_seq_index', 'description'];
  const blob = new Blob([toCsv(rows, headers)], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = runModeEl.value === 'validate' ? `log_validate_result_${Date.now()}.csv` : `log_compare_diff_${Date.now()}.csv`;
  a.click();
});
