(function () {
    'use strict';

    // =============================================
    //  設定區
    // =============================================
    const TARGET_URL = '/api/log';
    const DEFAULT_CHECK_FIELDS = ['balance', 'seq_index'];
    const PANEL_ID = '__logCheckerPanel';
    // 預設排除噪音事件（連線狀態 / 視訊事件）
    const EXCLUDED_EVENT_KEYWORDS = [
        'connecting',
        'connected',
        'disconnecting',
        'disconnected',
        'client.video.join',
        'client.video.leave',
        'video'
    ];

    // =============================================
    //  狀態
    // =============================================
    window.__logQueue = window.__logQueue || [];
    let firstLogReceived = false;

    // =============================================
    //  工具：解析 log payload
    //  回傳 { merged, rootKeys, outerKeys, innerKeys, rootData, outerData, innerJsondata, rawJsondata }
    //  - rootData      = response 最外層
    //  - outerData     = response.data（data 層，含 jsondata 字串）
    //  - innerJsondata = 解析後的內層物件
    //  - rawJsondata   = outerData.jsondata 原始字串
    //  - merged        = 兩層展平（供驗證用）
    // =============================================
    function parsePayload(response) {
        const rootData = (response && typeof response === 'object') ? response : {};
        const outerData = (response && response.data) ? response.data : (response || {});

        const rawJsondata = typeof outerData.jsondata === 'string'
            ? outerData.jsondata
            : (outerData.jsondata ? JSON.stringify(outerData.jsondata) : '');

        let innerJsondata = {};
        try {
            innerJsondata = rawJsondata ? JSON.parse(rawJsondata) : {};
        } catch (e) { /* ignore */ }

        // rootKeys：response 最外層欄位（排除 data 與雜訊）
        const ROOT_NOISE = new Set(['data', 'extra', 'abtest']);
        const rootKeys = Object.keys(rootData).filter(k => !ROOT_NOISE.has(k));
        // outerKeys：data 層所有欄位（含 jsondata，排除雜訊）
        const NOISE = new Set(['extra', 'abtest']);
        const outerKeys = Object.keys(outerData).filter(k => !NOISE.has(k));
        const innerKeys = Object.keys(innerJsondata);

        const prefixedRoot = {};
        rootKeys.forEach(k => { prefixedRoot[`root.${k}`] = rootData[k]; });

        const merged = Object.assign({}, outerData, innerJsondata, prefixedRoot);
        new Set(['jsondata', 'extra', 'abtest']).forEach(k => delete merged[k]);

        return { merged, rootKeys, outerKeys, innerKeys, rootData, outerData, innerJsondata, rawJsondata };
    }

    // =============================================
    //  工具：取得驗證欄位（手動輸入 + 驗證 checkbox）
    // =============================================
    function getSelectedFields() {
        const panel = document.getElementById(PANEL_ID);
        if (!panel) return [];

        const manualInput = panel.querySelector('#lcManualFields');
        const manualFields = manualInput
            ? manualInput.value.split(',').map(s => s.trim()).filter(Boolean)
            : [];

        const checked = Array.from(panel.querySelectorAll('.lcDynCheck:checked'))
            .map(cb => cb.value);

        return [...new Set([...manualFields, ...checked])];
    }

    // =============================================
    //  工具：取得導出欄位（外層導出 checkbox）
    // =============================================
    function getIncludeFields() {
        const panel = document.getElementById(PANEL_ID);
        const rootInclude = new Set(
            panel
                ? Array.from(panel.querySelectorAll('#lcRootFields .lcIncludeCheck:checked')).map(cb => cb.value)
                : []
        );
        const outerInclude = new Set(
            panel
                ? Array.from(panel.querySelectorAll('#lcOuterFields .lcIncludeCheck:checked')).map(cb => cb.value)
                : []
        );
        return { rootInclude, outerInclude };
    }

    // =============================================
    //  工具：驗證一筆 log
    // =============================================
    function validateLog(mergedData, fieldsToCheck) {
        let hasError = false;
        const reports = fieldsToCheck.map(field => {
            const val = mergedData[field];
            const valid = val !== undefined && val !== null && val !== '';
            if (!valid) hasError = true;
            return `${valid ? '✅' : '❌'} ${field}: ${valid ? val : '缺失'}`;
        });
        return {
            status: hasError ? '❌ 數據異常' : '✅ 數據正常',
            report: reports.join(' | ')
        };
    }

    function downloadJSON(filename, data) {
        const pretty = JSON.stringify(data, null, 2);
        const blob = new Blob([pretty], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
    }

    // =============================================
    //  CSV 匯出（白名單：只導出勾選的欄位）
    // =============================================
    window.exportLogCSV = function () {
        const queue = window.__logQueue;
        if (!queue.length) {
            alert('尚未收集到任何 log');
            return;
        }

        const { rootInclude, outerInclude } = getIncludeFields();
        if (rootInclude.size === 0 && outerInclude.size === 0) {
            alert('請至少勾選一個要導出的欄位（root / data 的「導」checkbox）');
            return;
        }

        const fieldsToCheck = getSelectedFields();
        const needValidate = fieldsToCheck.length > 0;
        const NOISE = new Set(['extra', 'abtest']);
        const allKeys = new Set();

        const rows = queue.map(item => {
            const { merged, rootData, outerData, innerJsondata, rawJsondata } = parsePayload(item.payload);
            const row = {};

            // root 層勾選的欄位（以 root. 前綴）
            rootInclude.forEach(k => {
                if (!k.startsWith('root.')) return;
                const rootKey = k.slice(5);
                if (rootData[rootKey] !== undefined) {
                    row[k] = rootData[rootKey];
                }
            });

            // 外層勾選的欄位
            outerInclude.forEach(k => {
                if (NOISE.has(k)) return;
                if (k === 'jsondata') {
                    // jsondata 格式化為 key: value 分行
                    try {
                        const parsed = innerJsondata && Object.keys(innerJsondata).length > 0
                            ? innerJsondata
                            : JSON.parse(rawJsondata);
                        row.jsondata = Object.entries(parsed)
                            .map(([fk, fv]) => `${fk}: ${fv}`)
                            .join('\n');
                    } catch (e) {
                        row.jsondata = rawJsondata;
                    }
                } else if (outerData[k] !== undefined) {
                    row[k] = outerData[k];
                }
            });

            row._capturedAt = new Date(item.server_time).toISOString();

            // 有指定驗證欄位才加驗證結果欄
            if (needValidate) {
                const { status, report } = validateLog(merged, fieldsToCheck);
                row._status = status;
                row._check_report = report;
            }

            Object.keys(row).forEach(k => allKeys.add(k));
            return row;
        });

        const headers = Array.from(allKeys);
        const csvLines = [
            headers.join(','),
            ...rows.map(r =>
                headers.map(h => {
                    const v = r[h] ?? '';
                    const s = String(v).replace(/"/g, '""');
                    return s.includes(',') || s.includes('\n') ? `"${s}"` : s;
                }).join(',')
            )
        ];
        const bom = '\uFEFF';
        const blob = new Blob([bom + csvLines.join('\n')], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `front_logs_${Date.now()}.csv`;
        a.click();

        console.log(`✅ [Log Checker] 已匯出 ${rows.length} 筆`);
        updatePanelCount();
    };

    // =============================================
    //  JSON 匯出（原始 queue）
    // =============================================
    window.exportLogJSONRaw = function () {
        const queue = window.__logQueue;
        if (!queue.length) {
            alert('尚未收集到任何 log');
            return;
        }
        downloadJSON(`front_logs_raw_${Date.now()}.json`, queue);
        console.log(`✅ [Log Checker] 已匯出 JSON（原始）${queue.length} 筆`);
    };

    // =============================================
    //  面板：更新計數（展開狀態 + 縮小 header）
    // =============================================
    function updatePanelCount() {
        const panel = document.getElementById(PANEL_ID);
        if (!panel) return;
        const total = window.__logQueue.length;
        const fields = getSelectedFields();
        const errorCount = fields.length > 0
            ? window.__logQueue.filter(item => {
                const { merged } = parsePayload(item.payload);
                return fields.some(f => merged[f] === undefined || merged[f] === null || merged[f] === '');
            }).length
            : 0;

        const countEl = panel.querySelector('#lcCount');
        if (countEl) {
            countEl.textContent = `已收集：${total} 筆`;
            countEl.style.color = errorCount > 0 ? '#ff6b6b' : '#51cf66';
        }
        const errorEl = panel.querySelector('#lcErrorCount');
        if (errorEl) {
            errorEl.textContent = errorCount > 0 ? `⚠️ ${errorCount} 筆異常` : '';
        }

        // 縮小狀態下 header 顯示筆數
        const headerCountEl = panel.querySelector('#lcHeaderCount');
        if (headerCountEl) {
            headerCountEl.textContent = total > 0
                ? `(${total}筆${errorCount > 0 ? ` ⚠️${errorCount}異常` : ''})`
                : '';
        }
    }

    // =============================================
    //  面板：新增動態欄位列
    //  root/data：驗證 + 導出 checkbox
    //  內層：驗證 checkbox 只（導出由外層 jsondata 控制）
    // =============================================
    function addDynamicFieldCheckbox(key, layer) {
        const panel = document.getElementById(PANEL_ID);
        if (!panel) return;
        const containerId = layer === 'inner'
            ? 'lcInnerFields'
            : (layer === 'root' ? 'lcRootFields' : 'lcOuterFields');
        const container = panel.querySelector('#' + containerId);
        if (!container) return;

        if (container.querySelector(`input[value="${CSS.escape(key)}"]`)) return;

        const rowEl = document.createElement('div');
        rowEl.style.cssText = 'display:flex;align-items:center;gap:6px;padding:2px 0;';

        // 驗證 checkbox（藍/橘）
        const cbValidate = document.createElement('input');
        cbValidate.type = 'checkbox';
        cbValidate.value = key;
        cbValidate.className = 'lcDynCheck';
        cbValidate.title = '加入驗證';
        cbValidate.style.cssText = 'cursor:pointer;flex-shrink:0;accent-color:' +
            (layer === 'inner' ? '#f59f00' : (layer === 'root' ? '#b197fc' : '#339af0')) + ';';

        rowEl.appendChild(cbValidate);

        // 外層才有導出 checkbox（綠）
        if (layer === 'outer' || layer === 'root') {
            const cbInclude = document.createElement('input');
            cbInclude.type = 'checkbox';
            cbInclude.value = key;
            cbInclude.className = 'lcIncludeCheck';
            cbInclude.title = '導出至 CSV';
            cbInclude.style.cssText = 'cursor:pointer;flex-shrink:0;accent-color:#40c057;';
            rowEl.appendChild(cbInclude);
        } else {
            // 內層：佔位讓欄位名稱對齊
            const placeholder = document.createElement('span');
            placeholder.style.cssText = 'display:inline-block;width:13px;flex-shrink:0;';
            rowEl.appendChild(placeholder);
        }

        // 欄位名稱
        const span = document.createElement('span');
        span.textContent = key === 'jsondata' ? 'jsondata (分行格式)' : key;
        span.style.cssText = 'font-size:12px;color:' +
            (key === 'jsondata' ? '#a9e34b' : '#dee2e6') +
            ';word-break:break-all;flex:1;';

        rowEl.appendChild(span);
        container.appendChild(rowEl);
    }

    // =============================================
    //  面板：第一筆 log 進來後，更新 UI
    // =============================================
    function onFirstLog({ rootKeys, outerKeys, innerKeys }) {
        const panel = document.getElementById(PANEL_ID);
        if (!panel) return;

        const waitingEl = panel.querySelector('#lcWaiting');
        if (waitingEl) waitingEl.style.display = 'none';

        const dynSection = panel.querySelector('#lcDynSection');
        if (dynSection) dynSection.style.display = 'block';

        const exportBtn = panel.querySelector('#lcExportBtn');
        if (exportBtn) { exportBtn.disabled = false; exportBtn.style.opacity = '1'; }
        const exportJsonRawBtn = panel.querySelector('#lcExportJsonRawBtn');
        if (exportJsonRawBtn) { exportJsonRawBtn.disabled = false; exportJsonRawBtn.style.opacity = '1'; }

        rootKeys.forEach(key => addDynamicFieldCheckbox(`root.${key}`, 'root'));
        outerKeys.forEach(key => addDynamicFieldCheckbox(key, 'outer'));
        innerKeys.forEach(key => addDynamicFieldCheckbox(key, 'inner'));
    }

    // =============================================
    //  面板：後續 log 補充新發現的欄位
    // =============================================
    function updateDynamicFields({ rootKeys, outerKeys, innerKeys }) {
        rootKeys.forEach(key => addDynamicFieldCheckbox(`root.${key}`, 'root'));
        outerKeys.forEach(key => addDynamicFieldCheckbox(key, 'outer'));
        innerKeys.forEach(key => addDynamicFieldCheckbox(key, 'inner'));
    }

    // =============================================
    //  工具：全選 / 全不選某容器的 lcIncludeCheck
    // =============================================
    function setAllInclude(containerId, checked) {
        const panel = document.getElementById(PANEL_ID);
        if (!panel) return;
        panel.querySelectorAll('#' + containerId + ' .lcIncludeCheck')
            .forEach(cb => { cb.checked = checked; });
    }

    // =============================================
    //  建立浮動面板
    // =============================================
    function createPanel() {
        if (document.getElementById(PANEL_ID)) return;

        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.style.cssText = [
            'position:fixed', 'top:20px', 'right:20px', 'z-index:2147483647',
            'width:300px', 'background:#1a1b1e', 'border:1px solid #373a40',
            'border-radius:10px', 'box-shadow:0 8px 32px rgba(0,0,0,.6)',
            'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
            'color:#c9cfd7', 'font-size:13px', 'user-select:none'
        ].join(';');

        const fieldBoxStyle = [
            'max-height:130px', 'overflow-y:auto',
            'background:#25262b', 'border:1px solid #373a40',
            'border-radius:6px', 'padding:6px 8px'
        ].join(';');

        const selectBtnStyle = [
            'background:none', 'border:1px solid #495057',
            'color:#868e96', 'border-radius:4px',
            'padding:1px 6px', 'font-size:10px',
            'cursor:pointer', 'line-height:1.6'
        ].join(';');

        panel.innerHTML = `
            <div id="lcHeader" style="
                display:flex;justify-content:space-between;align-items:center;
                padding:10px 14px;background:#25262b;border-radius:10px 10px 0 0;
                cursor:move;border-bottom:1px solid #373a40;">
                <div style="display:flex;align-items:center;gap:8px;">
                    <span style="font-weight:600;font-size:14px;">📋 Log Checker</span>
                    <span id="lcHeaderCount" style="font-size:11px;color:#868e96;"></span>
                </div>
                <button id="lcMinBtn" style="
                    background:none;border:none;color:#868e96;
                    cursor:pointer;font-size:16px;line-height:1;padding:0;">—</button>
            </div>

            <div id="lcBody" style="padding:12px 14px;">

                <!-- 計數 -->
                <div style="display:flex;justify-content:space-between;margin-bottom:10px;">
                    <span id="lcCount" style="font-weight:600;color:#51cf66;">已收集：0 筆</span>
                    <span id="lcErrorCount" style="color:#ff6b6b;font-size:12px;"></span>
                </div>

                <!-- 手動輸入驗證欄位 -->
                <div style="margin-bottom:10px;">
                    <div style="font-size:11px;color:#868e96;margin-bottom:4px;">
                        手動指定驗證欄位（逗號分隔）：
                    </div>
                    <input id="lcManualFields"
                        value="${DEFAULT_CHECK_FIELDS.join(', ')}"
                        style="
                            width:100%;box-sizing:border-box;padding:6px 8px;
                            background:#25262b;border:1px solid #495057;border-radius:6px;
                            color:#dee2e6;font-size:12px;outline:none;"/>
                </div>

                <!-- 等待第一筆 -->
                <div id="lcWaiting" style="
                    text-align:center;padding:10px 0;color:#868e96;font-size:12px;">
                    ⏳ 等待第一筆 log...
                </div>

                <!-- 動態欄位區（第一筆進來才顯示，分三層） -->
                <div id="lcDynSection" style="display:none;margin-bottom:10px;">

                    <!-- 欄頭說明 -->
                    <div style="
                        display:flex;align-items:center;gap:6px;
                        padding:0 2px 4px 2px;font-size:10px;color:#868e96;">
                        <span style="flex-shrink:0;width:14px;text-align:center;color:#339af0;" title="加入驗證">驗</span>
                        <span style="flex-shrink:0;width:14px;text-align:center;color:#40c057;" title="導出至CSV">導</span>
                        <span>欄位名稱</span>
                    </div>

                    <!-- 回應最外層 root -->
                    <div style="
                        display:flex;align-items:center;justify-content:space-between;
                        margin-bottom:4px;">
                        <div style="display:flex;align-items:center;gap:6px;
                            font-size:11px;color:#d0bfff;font-weight:600;">
                            <span>▌</span><span>回應最外層欄位（root）</span>
                        </div>
                        <div style="display:flex;gap:4px;">
                            <button id="lcRootSelectAll" style="${selectBtnStyle}">全選</button>
                            <button id="lcRootSelectNone" style="${selectBtnStyle}">全不選</button>
                        </div>
                    </div>
                    <div id="lcRootFields" style="${fieldBoxStyle};margin-bottom:8px;">
                    </div>

                    <!-- 外層 data -->
                    <div style="
                        display:flex;align-items:center;justify-content:space-between;
                        margin-bottom:4px;">
                        <div style="display:flex;align-items:center;gap:6px;
                            font-size:11px;color:#74c0fc;font-weight:600;">
                            <span>▌</span><span>data 欄位</span>
                        </div>
                        <div style="display:flex;gap:4px;">
                            <button id="lcOuterSelectAll" style="${selectBtnStyle}">全選</button>
                            <button id="lcOuterSelectNone" style="${selectBtnStyle}">全不選</button>
                        </div>
                    </div>
                    <div id="lcOuterFields" style="${fieldBoxStyle};margin-bottom:8px;">
                    </div>

                    <!-- 內層 jsondata -->
                    <div style="
                        display:flex;align-items:center;
                        margin-bottom:4px;">
                        <div style="display:flex;align-items:center;gap:6px;
                            font-size:11px;color:#ffd43b;font-weight:600;">
                            <span>▌</span><span>jsondata 欄位（data.jsondata，僅驗證）</span>
                        </div>
                    </div>
                    <div id="lcInnerFields" style="${fieldBoxStyle};">
                    </div>

                </div>

                <!-- 按鈕區 -->
                <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
                    <button id="lcExportBtn" disabled style="
                        flex:1 1 120px;padding:7px 0;background:#1971c2;color:#fff;
                        border:none;border-radius:6px;cursor:pointer;
                        font-size:12px;font-weight:600;opacity:.5;">
                        匯出 CSV
                    </button>
                    <button id="lcExportJsonRawBtn" disabled style="
                        flex:1 1 120px;padding:7px 0;background:#2f9e44;color:#fff;
                        border:none;border-radius:6px;cursor:pointer;
                        font-size:12px;font-weight:600;opacity:.5;">
                        匯出 JSON(原始)
                    </button>
                    <button id="lcClearBtn" style="
                        flex:1 1 120px;padding:7px 12px;background:#373a40;
                        color:#dee2e6;border:none;border-radius:6px;
                        cursor:pointer;font-size:12px;">
                        清空
                    </button>
                </div>

            </div>`;

        document.body.appendChild(panel);

        // 最小化 / 展開（縮小時 header 顯示筆數）
        const minBtn = panel.querySelector('#lcMinBtn');
        const body = panel.querySelector('#lcBody');
        minBtn.addEventListener('click', () => {
            const collapsed = body.style.display === 'none';
            body.style.display = collapsed ? 'block' : 'none';
            minBtn.textContent = collapsed ? '—' : '＋';
            if (!collapsed) updatePanelCount(); // 縮小時確保 header count 最新
        });

        // 匯出按鈕
        panel.querySelector('#lcExportBtn').addEventListener('click', () => {
            window.exportLogCSV();
        });
        panel.querySelector('#lcExportJsonRawBtn').addEventListener('click', () => {
            window.exportLogJSONRaw();
        });

        // 清空按鈕
        panel.querySelector('#lcClearBtn').addEventListener('click', () => {
            window.__logQueue = [];
            firstLogReceived = false;

            const dynSection = panel.querySelector('#lcDynSection');
            if (dynSection) dynSection.style.display = 'none';
            const waiting = panel.querySelector('#lcWaiting');
            if (waiting) waiting.style.display = 'block';
            const outerFields = panel.querySelector('#lcOuterFields');
            if (outerFields) outerFields.innerHTML = '';
            const rootFields = panel.querySelector('#lcRootFields');
            if (rootFields) rootFields.innerHTML = '';
            const innerFields = panel.querySelector('#lcInnerFields');
            if (innerFields) innerFields.innerHTML = '';
            const exportBtn = panel.querySelector('#lcExportBtn');
            if (exportBtn) { exportBtn.disabled = true; exportBtn.style.opacity = '.5'; }
            const exportJsonRawBtn = panel.querySelector('#lcExportJsonRawBtn');
            if (exportJsonRawBtn) { exportJsonRawBtn.disabled = true; exportJsonRawBtn.style.opacity = '.5'; }

            updatePanelCount();
            console.log('[Log Checker] Queue 已清空');
        });

        // root/data 全選 / 全不選 按鈕（只作用在導出 checkbox）
        panel.querySelector('#lcRootSelectAll').addEventListener('click', () => setAllInclude('lcRootFields', true));
        panel.querySelector('#lcRootSelectNone').addEventListener('click', () => setAllInclude('lcRootFields', false));
        panel.querySelector('#lcOuterSelectAll').addEventListener('click', () => setAllInclude('lcOuterFields', true));
        panel.querySelector('#lcOuterSelectNone').addEventListener('click', () => setAllInclude('lcOuterFields', false));

        // 可拖曳
        let dragging = false, ox = 0, oy = 0;
        panel.querySelector('#lcHeader').addEventListener('mousedown', e => {
            dragging = true;
            ox = e.clientX - panel.offsetLeft;
            oy = e.clientY - panel.offsetTop;
        });
        document.addEventListener('mousemove', e => {
            if (!dragging) return;
            panel.style.left = (e.clientX - ox) + 'px';
            panel.style.top  = (e.clientY - oy) + 'px';
            panel.style.right = 'auto';
        });
        document.addEventListener('mouseup', () => { dragging = false; });

        // export 按鈕 hover
        const exportBtn = panel.querySelector('#lcExportBtn');
        exportBtn.addEventListener('mouseenter', () => {
            if (!exportBtn.disabled) exportBtn.style.background = '#1864ab';
        });
        exportBtn.addEventListener('mouseleave', () => {
            if (!exportBtn.disabled) exportBtn.style.background = '#1971c2';
        });
    }

    // =============================================
    //  XHR 攔截器
    // =============================================
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
        this._url = url;
        return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function (data) {
        this.addEventListener('readystatechange', function () {
            if (this.readyState === 4 && this._url && this._url.includes(TARGET_URL)) {
                if (this.status === 200) {
                    try {
                        const response = JSON.parse(this.responseText);

                        // 過濾噪音事件（連線狀態 / 視訊事件）
                        const eventType = (response.event || '').toLowerCase();
                        if (EXCLUDED_EVENT_KEYWORDS.some(k => eventType.includes(k))) return;

                        if (response) {
                            window.__logQueue.push({
                                intercept_type: 'XHR_RESPONSE_FINAL',
                                payload: response,
                                server_time: response.timestamp || Date.now()
                            });

                            const parsed = parsePayload(response);

                            if (!firstLogReceived) {
                                firstLogReceived = true;
                                onFirstLog(parsed);
                            } else {
                                updateDynamicFields(parsed);
                            }

                            updatePanelCount();
                            console.log(`📦 [Log Checker] 收集第 ${window.__logQueue.length} 筆 | ${response.event || '(無 event)'}`);
                        }
                    } catch (err) {
                        console.error('❌ [Log Checker] XHR 解析失敗:', err);
                    }
                }
            }
        });
        return originalSend.apply(this, arguments);
    };

    // =============================================
    //  啟動
    // =============================================
    createPanel();
    console.log('%c✅ [Log Checker] 已啟動 — 面板在右上角，可匯出 CSV / JSON(原始)', 'color:#51cf66;font-weight:bold;');

})();
