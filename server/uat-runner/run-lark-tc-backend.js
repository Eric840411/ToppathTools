/**
 * run-lark-tc-backend.js
 * 執行後台 UAT TC，截圖上傳 Lark 附圖欄，勾選 UAT測試通過
 *
 * 用法: node run-lark-tc-backend.js
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';

// ─── Lark 設定 ───────────────────────────────────────────────────────
const LARK_TOKEN_URL = 'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal';
const APP_ID         = 'cli_a80489fc6d389028';
const APP_SECRET     = 'HFXG1sWdNDiX0Aa4MngsTgzFxUKAci8I';
const APP_TOKEN      = process.env.LARK_APP_TOKEN || 'RjiabXR3Ra2pm4shI05lD4azgjg';
const TABLE_ID       = process.env.LARK_TABLE_ID  || 'tbllkNHrRF5ii6Qc';
const LARK_BASE      = 'https://open.larksuite.com/open-apis';

// ─── 篩選設定（留空 = 跑全部，填入 subtype 名稱 = 只跑該分類）─────────
// 用法: node run-lark-tc-backend.js "Daily Dashboard"
//   或直接改這裡: const FILTER_SUBTYPES = ['Daily Dashboard'];
const FILTER_SUBTYPES = process.argv[2]
  ? process.argv[2].split(',').map(s => s.trim())
  : [];

// ─── 後台設定 ─────────────────────────────────────────────────────────
const BACKEND_URL = 'http://uat-cp.osmslot.org';
const SCREENSHOT_DIR = './data/raw/screenshots/lark_tc';

// ─── 欄位 ID ─────────────────────────────────────────────────────────
const FIELD = {
  uat_pass:  'fld8qizcOu',   // UAT測試 checkbox
  uat_time:  'fld2kLMXQ5',   // UAT測試通過時間
  attach:    'fldN42zhZL',   // 附圖
};

// ─── 每個 subtype 對應的後台路徑與測試邏輯 ────────────────────────────
const SUBTYPE_MAP = {
  'Dashboard':         { path: '/dashboard',                        action: 'screenshot_verify' },
  'Daily Dashboard':   { path: '/daily_dashboard',                   action: 'daily_dashboard_verify' },
  'EGM List':          { path: '/egm/egmList',                      action: 'screenshot_verify_data' },
  'EGM Status':        { path: '/egm/egmStatusList',                action: 'screenshot_verify_data' },
  'Gaming User':       { path: '/egm/onlineList',                   action: 'screenshot_verify_data' },
  'EGM Detail':        { path: '/egm/reports/egmCount',             action: 'screenshot_date_search' },
  'User Detail':       { path: '/egm/reports/plyerMachineCount',    action: 'screenshot_date_search' },
  'EGM Transfer':      { path: '/egm/reports/egmTransfer',          action: 'screenshot_date_search' },
  'Game Record':       { path: '/egm/reports/gameRecordList',       action: 'screenshot_date_search' },
  'EGM DayCount':      { path: '/egm/reports/gameCount',            action: 'screenshot_date_search' },
  'Player Credit Log': { path: '/egm/reports/rechargeRecordList',   action: 'screenshot_date_search' },
  'Jackpot Record':    { path: '/egm/reports/jackpotRecordList',     action: 'screenshot_date_search' },
  'Loading Tips':      { path: '/game/loadingTips',                 action: 'screenshot_verify_data' },
  'Channel Ranking':   { path: '/game/getChannelRankInfo',          action: 'screenshot_verify_data' },
  'White List':        { path: '/game/getWhiteList',                action: 'screenshot_verify_data' },
  'Game Jump Set':     { path: '/game/gameJumpSet',                 action: 'screenshot_verify_data' },
  'News Set':          { path: '/game/bannerSet',                   action: 'screenshot_verify_data' },
  'EGM JP Percent':    { path: '/game/egmJpPercent',                action: 'screenshot_verify_data' },
  'Advert Set':        { path: '/game/advertSet',                   action: 'screenshot_verify_data' },
  'EGM Hourly Meter':  { path: '/egm/meter/egmMeterHourList',       action: 'screenshot_date_search' },
  'EGM Performance Meter': { path: '/egm/meter/egmPerformanceMeter', action: 'screenshot_date_search' },
  'Jackpot Moment':    { path: '/game/upJackpotVideo',              action: 'screenshot_verify_data' },
  'Deposit Setting':   { path: '/game/getPayButtonToggle',          action: 'screenshot_verify' },
  '自動預約相關功能':   { path: '/game/machineReservationList',      action: 'screenshot_verify_data' },
  'Daily Ranking':     { path: '/rankinglist/dailyRanking',         action: 'screenshot_verify_data' },
  'Jackpot Ranking':   { path: '/rankinglist/jackpotRanking',       action: 'screenshot_verify_data' },
  '小額推薦影片':       { path: '/game/recommendSetting',           action: 'screenshot_verify_data' },
  'How To Play':           { path: '/game/howToPlay',                        action: 'screenshot_verify_data' },
  // ── 新增頁面 ──
  'Machine Monitoring':    { path: '/egm/monitoring',                       action: 'screenshot_verify_data' },
  'Player Watch':          { path: '/egm/reports/playerWatchList',           action: 'screenshot_verify_data' },
  'Fault List':            { path: '/egm/reports/faultList',                 action: 'screenshot_date_search' },
  'OSM Instant Meter':     { path: '/egm/meter/egmMeterList',               action: 'screenshot_verify_data' },
  'GCP Instant Meter':     { path: '/egm/gsameter/egmMeterList',            action: 'screenshot_verify_data' },
  'Stress Test Instant Meter': { path: '/egm/meter/egmMeterExtraList',      action: 'screenshot_verify_data' },
  'Recovery Meter':        { path: '/egm/meter/getSpinDataRecoveryList',    action: 'screenshot_verify_data' },
  'Daily Meter Reading':   { path: '/egm/gsameter/dailyMeterReadingReport', action: 'screenshot_verify_data' },
  'Record Abnormality':    { path: '/abnormality/gameHistorySyncFailed',    action: 'screenshot_verify_data' },
  'Machine Abnormality':   { path: '/abnormality/machine',                  action: 'screenshot_verify_data' },
  'Jackpot Abnormality':   { path: '/abnormality/getHandPayRecord',         action: 'screenshot_verify_data' },
  'Game Error Record':     { path: '/abnormality/gameErrorRecordList',      action: 'screenshot_verify_data' },
  'Machine Reservation Limit': { path: '/game/reservationLimit',            action: 'screenshot_verify_data' },
  'Special Entrance Set':  { path: '/game/denomSet',                        action: 'screenshot_verify_data' },
  'Test Setting':          { path: '/game/testTimeList',                    action: 'screenshot_verify_data' },
  'Log Third Http Req':    { path: '/log/logThirdHttpReq',                  action: 'screenshot_verify_data' },
  'Log Third Bet Req':     { path: '/log/logThirdHttpBetReq',               action: 'screenshot_verify_data' },
  'Log EGM Status':        { path: '/log/gmErrorLog',                       action: 'screenshot_verify_data' },
  'MeterCompensateSpinLog':{ path: '/log/meterCompensateSpinLog',           action: 'screenshot_verify_data' },
  'Error Meter Info':      { path: '/log/getErrorMeterInfoList',            action: 'screenshot_verify_data' },
  'Operation Log':         { path: '/log/operationlog',                     action: 'screenshot_verify_data' },
  'Login Log':             { path: '/log/loginlog',                         action: 'screenshot_verify_data' },
  'Out Log Records':       { path: '/log/sendOutLogRecord',                 action: 'screenshot_verify_data' },
};

if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// ─── Daily Ranking Bonus 計時器狀態（跨 TC 共享）────────────────────────
// 記錄 TC2 修改後的計時開始時間，5分鐘後回來驗證 TC2+TC3
let _bonusTimerState = null; // { startTime, pageUrl, newVals, fieldLabels }

// ─── Lark API helpers ────────────────────────────────────────────────
async function getLarkToken() {
  const res = await fetch(LARK_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const d = await res.json();
  return d.tenant_access_token;
}

async function uploadAttachment(token, filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  const form = new FormData();
  form.append('file_name', fileName);
  form.append('parent_type', 'bitable_file');
  form.append('parent_node', APP_TOKEN);
  form.append('size', String(fileBuffer.length));
  form.append('file', fileBuffer, { filename: fileName, contentType: 'image/png' });

  const res = await fetch(`${LARK_BASE}/drive/v1/medias/upload_all`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() },
    body: form,
  });
  const d = await res.json();
  if (d.code !== 0) throw new Error(`Upload failed: ${d.msg}`);
  return d.data.file_token;
}

async function updateRecord(token, recordId, fileTokens, pass) {
  // fileTokens: string (single) or string[] (multiple)
  const tokens = Array.isArray(fileTokens)
    ? fileTokens.filter(Boolean)
    : (fileTokens ? [fileTokens] : []);

  const putRecord = async (fields) => {
    const res = await fetch(`${LARK_BASE}/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records/${recordId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
    const d = await res.json();
    if (d.code !== 0) console.warn(`  ⚠️ updateRecord ${recordId}: ${d.msg}`);
    return d;
  };

  // Step 1: clear attachment first (two-step to ensure replacement)
  if (tokens.length > 0) {
    await putRecord({ '附圖': [] });
  }

  // Step 2: set remaining fields
  const fields = {};
  if (pass) {
    fields['UAT測試'] = true;
    fields['UAT測試通過時間'] = Date.now();
  }
  if (tokens.length > 0) {
    fields['附圖'] = tokens.map((ft, i) => ({
      file_token: ft,
      name: `screenshot_${i + 1}.png`,
    }));
  }
  if (Object.keys(fields).length === 0) return;
  return putRecord(fields);
}

// ─── 強制關閉所有 dialog（bypass overlay 攔截）────────────────────────
async function dismissDialogs(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.el-dialog button').forEach(btn => {
      const t = btn.innerText?.trim();
      if (t === 'Cancel' || t === '取消' || t === 'Close' || t === '關閉') btn.click();
    });
  });
  await page.waitForTimeout(500);
}

// ─── 共用工具函式 ──────────────────────────────────────────────────────

/**
 * getBaseInfo(page) → 回傳 { bodyText, h1, rowCount, allBtns, allHeaders }
 */
async function getBaseInfo(page) {
  const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  const h1 = await page.evaluate(() => document.querySelector('h1,h2,.page-title')?.innerText?.trim() || '').catch(() => '');
  const rowCount = await page.locator('.el-table__body tr').count().catch(() => 0);
  const allBtns = await page.evaluate(() =>
    [...document.querySelectorAll('button')].map(b => b.innerText?.trim()).filter(Boolean)
  ).catch(() => []);
  const allHeaders = await page.evaluate(() =>
    [...document.querySelectorAll('th, .el-table__header th')].map(h => h.innerText?.trim()).filter(Boolean)
  ).catch(() => []);
  return { bodyText, h1, rowCount, allBtns, allHeaders };
}

/**
 * detectManual(full) → 回傳 manualReason string 或 null
 */
function detectManual(full) {
  const manualPatterns = [
    [/盒子.*斷線|斷線.*紅色|egm.*disconnect/i, '需要EGM斷線環境'],
    [/前端進入機台.*後台.*即時更新|後台.*實時更新/i, '需要前端玩家進入機台才能驗證'],
    [/現場.*handpay|handpay.*後.*查看/i, '需要現場 handpay 操作'],
    [/機器門.*打開|kickout.*卡額度/i, '需要硬體操作（機器門）'],
    [/5.*分鐘.*更新|每5分鐘/i, '需要等待5分鐘觀察更新'],
    [/23:59:59|05:59:59|特殊時間段/i, '需要特定時間段歷史資料'],
    [/jackpot.*abr.*補發.*自動寫入|自動寫入.*jackpot.*raking/i, '需要 Jackpot Abnormality 補發事件'],
    [/不可以兩支.*帳號.*預約同機台/i, '需要兩個前端帳號同時操作'],
    [/前端預約後.*機台.*展示/i, '跨系統驗證（需前端操作）'],
    [/快速join.*直接跳轉遊戲/i, '跨系統驗證（需前端 quick join）'],
    [/前端可以看到|前端.*可以看到|前端.*能看到/i, '跨系統驗證（需前端確認）'],
    [/前端.*大廳.*後台.*設置後/i, '跨系統驗證（前台需觀察）'],
    [/先前.*前端.*確認後台|前後台.*同步/i, '需前後台同時操作'],
    [/玩家.*遊玩機台.*對照後台/i, '需要玩家實際遊玩資料'],
    [/帶入.*帶出.*金額.*是否正確/i, '需要實際 transfer 記錄驗證計算'],
    [/投注.*輸贏.*紀錄.*是否正確/i, '需要實際遊玩記錄驗證'],
    [/每10分鐘.*寫.*數據/i, '需等待10分鐘觀察定時寫入'],
    [/delay.*玩家.*遊玩資料|玩家遊玩資料.*沒被清空/i, '需前端玩家實際投注後點Delay確認數值不歸零'],
    [/maintenance.*是否.*把玩家提出|是否.*把玩家提出.*機台/i, '需前端帳號在機台內才能驗證 maintenance kick'],
    [/jackpotContribution|userbethistory.*bpo/i, '需前端遊玩 + BPO API 驗證 jackpotContribution'],
    [/預約時間到後.*繼續遊玩/i, '需等待預約時間到期後觀察計費行為'],
  ];
  for (const [pat, reason] of manualPatterns) {
    if (pat.test(full)) return reason;
  }
  return null;
}

/**
 * doExport(page) → 處理 Export button + 下載，回傳 { notes, criticalFails, exportedXlsxPath }
 */
async function doExport(page) {
  const notes = [];
  const criticalFails = [];
  let exportedXlsxPath = null;

  const hasExportEl = await page.evaluate(() => {
    return !![...document.querySelectorAll('.img-btn, [class*="img-btn"], .export-btn, button')]
      .find(el => /export|csv|excel/i.test(el.innerText?.trim()));
  }).catch(() => false);

  if (hasExportEl) {
    try {
      const downloadPromise = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);
      await page.evaluate(() => {
        const el = [...document.querySelectorAll('.img-btn, [class*="img-btn"], .export-btn, button')]
          .find(e => /export|csv|excel/i.test(e.innerText?.trim()));
        if (el) el.click();
      });
      await page.waitForTimeout(1000);
      await page.evaluate(() => {
        const sureBtn = [...document.querySelectorAll('.el-message-box button')]
          .find(b => /sure|confirm|ok|yes/i.test(b.innerText?.trim()));
        if (sureBtn) sureBtn.click();
      });
      const download = await downloadPromise;
      if (download) {
        const fname = await download.suggestedFilename();
        const savePath = path.join('./data/raw/exports', fname);
        await download.saveAs(savePath);
        exportedXlsxPath = savePath;
        notes.push(`✅Export(已下載:${fname})`);
      } else {
        notes.push('✅Export(已確認Sure，下載中)');
      }
    } catch (e) {
      notes.push('✅Export(按鈕存在，下載監聽逾時)');
    }
  } else {
    notes.push('❌Export按鈕缺失');
    criticalFails.push('Export按鈕缺失');
  }

  return { notes: notes.join(' | '), criticalFails, exportedXlsxPath };
}

/**
 * doBonusSettings(page) → 完整 Bonus Settings 流程
 * 回傳 { notes, criticalFails, toastShotPath, extraShotPaths }
 */
async function doBonusSettings(page) {
  const notes = [];
  const criticalFails = [];
  const extraShotPaths = [];
  let toastShotPath = null;

  const apiLog = { getStatus: null, postStatus: null };
  const responseListener = (resp) => {
    const url = resp.url().toLowerCase();
    if (url.includes('getrankaward')) apiLog.getStatus = resp.status();
    if (url.includes('setrankaward')) apiLog.postStatus = resp.status();
  };
  page.on('response', responseListener);

  try {
    // ① 點擊 Bonus Settings 按鈕
    const clickedBonus = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button'))
        .find(b => /bonus\s*settings?/i.test(b.innerText));
      if (btn) { btn.click(); return true; }
      return false;
    });

    if (!clickedBonus) {
      notes.push('❌Bonus Settings 按鈕缺失');
      criticalFails.push('Bonus Settings 按鈕缺失');
      page.off('response', responseListener);
      return { notes: notes.join(' | '), criticalFails, toastShotPath, extraShotPaths };
    }

    // ② 等 Dialog 出現（最多 5s）
    await page.waitForSelector('.el-dialog__body input', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1000);

    // ③ 確認 GET API
    if (apiLog.getStatus !== null) {
      const getOk = apiLog.getStatus === 200;
      notes.push(getOk ? '✅GET /getrankaward 200' : `❌GET /getrankaward ${apiLog.getStatus}`);
      if (!getOk) criticalFails.push('GET /getrankaward 非 200');
    } else {
      notes.push('⚠️GET /getrankaward 未偵測到（可能已快取）');
    }

    // ④ 確認 Dialog 出現
    const inputCount = await page.locator('.el-dialog__body input').count().catch(() => 0);
    if (inputCount === 0) {
      notes.push('❌Bonus Settings Dialog 未開啟');
      criticalFails.push('Bonus Settings Dialog 未開啟');
      page.off('response', responseListener);
      return { notes: notes.join(' | '), criticalFails, toastShotPath, extraShotPaths };
    }
    notes.push(`✅Bonus Settings Dialog 已開啟（${inputCount}個輸入框）`);

    // ⑤ 讀取所有欄位 label + 原始值
    const fieldData = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.el-dialog__body .el-form-item'));
      return items.map((item, idx) => {
        const labelEl = item.querySelector('.el-form-item__label');
        const inputEl = item.querySelector('input');
        return {
          label: labelEl ? labelEl.innerText.trim() : `Field ${idx + 1}`,
          origVal: inputEl ? inputEl.value : '',
        };
      }).filter(f => f.origVal !== '' || f.label);
    });

    if (fieldData.length === 0) {
      notes.push('⚠️無法讀取任何欄位值');
      page.off('response', responseListener);
      return { notes: notes.join(' | '), criticalFails, toastShotPath, extraShotPaths };
    }

    // 截圖①：Dialog 開啟狀態（修改前）
    const dialogBeforePath = path.join(SCREENSHOT_DIR, `bonus_before_${Date.now()}.png`);
    await page.screenshot({ path: dialogBeforePath, fullPage: false });
    extraShotPaths.push(dialogBeforePath);

    // ⑥ 為每個欄位產生隨機值（1–7位隨機整數）
    const newVals = fieldData.map(f => {
      const digits = Math.floor(Math.random() * 5) + 2; // 2–6位
      const min = Math.pow(10, digits - 1);
      const max = Math.pow(10, digits) - 1;
      return String(Math.floor(Math.random() * (max - min + 1)) + min);
    });

    // ⑦ 依序 fill 每個 input
    const inputs = page.locator('.el-dialog__body .el-form-item input');
    const actualCount = await inputs.count().catch(() => 0);
    for (let i = 0; i < Math.min(actualCount, newVals.length); i++) {
      const inp = inputs.nth(i);
      await inp.click({ clickCount: 3 });
      await inp.fill(newVals[i]);
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(400);

    // 截圖②：填完後（修改後、儲存前）
    const dialogAfterPath = path.join(SCREENSHOT_DIR, `bonus_after_${Date.now()}.png`);
    await page.screenshot({ path: dialogAfterPath, fullPage: false });
    extraShotPaths.push(dialogAfterPath);

    // ⑧ 點 Save 按鈕
    const saveBtn = page.locator('.el-dialog__body button, .el-dialog__footer button')
      .filter({ hasText: /save/i }).first();
    await saveBtn.click().catch(async () => {
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('.el-dialog button'))
          .find(b => /save/i.test(b.innerText));
        if (btn) btn.click();
      });
    });

    // ⑧b 如果彈出確認 dialog（el-message-box），點 OK/Confirm
    await page.waitForTimeout(600);
    const msgBoxVisible = await page.locator('.el-message-box__wrapper').isVisible({ timeout: 1000 }).catch(() => false);
    if (msgBoxVisible) {
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('.el-message-box button'));
        const okBtn = btns.find(b => /ok|confirm|sure|yes/i.test(b.innerText));
        if (okBtn) okBtn.click();
      });
      await page.waitForTimeout(800);
    }

    // ⑨ 輪詢 success toast（最多等 4s）
    let toastFound = false;
    for (let t = 0; t < 20; t++) {
      await page.waitForTimeout(200);
      toastFound = await page.locator('.el-message--success').isVisible({ timeout: 100 }).catch(() => false);
      if (toastFound) break;
    }

    // ⑩ 截圖③：toast / 儲存後狀態
    toastShotPath = path.join(SCREENSHOT_DIR, `bonus_settings_${toastFound ? 'toast' : 'after'}_${Date.now()}.png`);
    await page.screenshot({ path: toastShotPath, fullPage: false });

    // ⑪ 確認 POST API 狀態
    await page.waitForTimeout(500);
    if (apiLog.postStatus !== null) {
      const postOk = apiLog.postStatus === 200;
      notes.push(postOk ? '✅POST /setrankaward 200' : `❌POST /setrankaward ${apiLog.postStatus}`);
      if (!postOk) criticalFails.push('POST /setrankaward 失敗');
    } else {
      if (toastFound) {
        notes.push('✅POST /setrankaward（由 success toast 間接確認）');
      } else {
        notes.push('❌POST /setrankaward 未觸發（無 toast）');
        criticalFails.push('Save 後無 success toast');
      }
    }
    notes.push(toastFound ? '✅Success toast 截圖完成' : '⚠️Toast 未偵測到，截取當前畫面');

    // ⑫a 關閉 Dialog，拍主畫面確認 Bonus 設定值已套用
    await page.evaluate(() => {
      document.querySelectorAll('.el-dialog__wrapper').forEach(el => el.style.display = 'none');
      const overlay = document.querySelector('.v-modal');
      if (overlay) overlay.style.display = 'none';
      document.querySelectorAll('.el-message-box__wrapper').forEach(el => el.style.display = 'none');
    });
    await page.waitForTimeout(1000);
    const mainPageShotPath = path.join(SCREENSHOT_DIR, `bonus_main_after_save_${Date.now()}.png`);
    await page.screenshot({ path: mainPageShotPath, fullPage: false });
    extraShotPaths.push(mainPageShotPath);
    notes.push('✅主畫面截圖（Bonus 套用後）');

    // ⑫ 產生 Before vs After 比對截圖（HTML table）
    const compareRows = fieldData.map((f, i) => {
      const nv = newVals[i] ?? '-';
      const changed = f.origVal !== nv;
      return `<tr style="background:${changed ? '#e6f4ea' : '#fff'}">
        <td style="padding:6px 12px;border:1px solid #ddd">${f.label}</td>
        <td style="padding:6px 12px;border:1px solid #ddd;text-align:right">${f.origVal}</td>
        <td style="padding:6px 12px;border:1px solid #ddd;text-align:right;color:#1a7a2e;font-weight:bold">${nv}</td>
        <td style="padding:6px 12px;border:1px solid #ddd;text-align:center">${changed ? '✅' : '—'}</td>
      </tr>`;
    }).join('');
    const compareHtml = `<div style="font-family:sans-serif;margin:20px">
      <h2 style="background:#1a56db;color:#fff;padding:10px 16px;margin:0 0 0 0;font-size:15px">
        Bonus Settings — 修改前後對照（${new Date().toLocaleString('zh-TW')}）
      </h2>
      <table style="border-collapse:collapse;width:100%;margin-top:0">
        <thead><tr style="background:#f0f0f0">
          <th style="padding:8px 12px;border:1px solid #ddd;text-align:left">欄位</th>
          <th style="padding:8px 12px;border:1px solid #ddd;text-align:right">修改前</th>
          <th style="padding:8px 12px;border:1px solid #ddd;text-align:right">修改後</th>
          <th style="padding:8px 12px;border:1px solid #ddd;text-align:center">變更</th>
        </tr></thead>
        <tbody>${compareRows}</tbody>
      </table>
    </div>`;
    const prevUrl = page.url();
    const compareShotPath = path.join(SCREENSHOT_DIR, `bonus_compare_${Date.now()}.png`);
    await page.setViewportSize({ width: 900, height: 600 });
    await page.setContent(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0">${compareHtml}</body></html>`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: compareShotPath, fullPage: true });
    extraShotPaths.push(compareShotPath);
    // 導航回原頁
    await page.goto(prevUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // ⑬ 啟動 5 分鐘計時器（不還原，等 TC3 驗證）
    _bonusTimerState = {
      startTime: Date.now(),
      pageUrl: prevUrl,
      newVals,
      fieldLabels: fieldData.map(f => f.label),
    };
    notes.push(`⏳5分鐘計時開始（TC3將於計時結束後驗證）`);

  } catch (e) {
    notes.push(`⚠️Bonus Settings 測試例外: ${e.message}`);
  } finally {
    page.off('response', responseListener);
  }

  return { notes: notes.join(' | '), criticalFails, toastShotPath, extraShotPaths };
}

/**
 * doShowcase(page) → Showcase dialog 流程
 * 回傳 { notes, criticalFails, extraShotPaths }
 */
async function doShowcase(page) {
  const notes = [];
  const criticalFails = [];
  const extraShotPaths = [];

  // 先關閉所有現有 dialog
  await page.evaluate(() => {
    document.querySelectorAll('.el-dialog__wrapper, .v-modal').forEach(el => el.style.display = 'none');
  });
  await page.waitForTimeout(300);
  // 點第一個 fa-edit icon 按鈕
  await page.evaluate(() => {
    const editBtn = Array.from(document.querySelectorAll('.el-table__row button'))
      .find(b => b.querySelector('.fa-edit'));
    if (editBtn) editBtn.click();
  });
  await page.waitForTimeout(2000);
  // 滾動 dialog 到底部
  await page.evaluate(() => {
    const d = document.querySelector('.el-dialog__body');
    if (d) d.scrollTop = 99999;
  });
  await page.waitForTimeout(500);
  // 確認 Showcase 欄位存在
  const hasShowcase = await page.evaluate(() => {
    const d = document.querySelector('.el-dialog__body');
    return d ? /showcase/i.test(d.innerText) : false;
  }).catch(() => false);
  if (hasShowcase) {
    notes.push('✅Showcase設定欄位');
  } else {
    notes.push('❌Showcase設定欄位缺失');
    criticalFails.push('Showcase設定欄位缺失');
  }
  // 截圖（Edit Dialog 開啟狀態）
  const showcaseShotPath = path.join(SCREENSHOT_DIR, `showcase_dialog_${Date.now()}.png`);
  await page.screenshot({ path: showcaseShotPath, fullPage: false });
  extraShotPaths.push(showcaseShotPath);
  // 關閉 dialog
  await page.evaluate(() => {
    document.querySelectorAll('.el-dialog__wrapper').forEach(el => el.style.display = 'none');
  });
  await page.waitForTimeout(300);

  return { notes: notes.join(' | '), criticalFails, extraShotPaths };
}

/**
 * doGearPanel(page) → Gear panel 流程
 * 回傳 { notes, criticalFails, extraShotPaths }
 */
async function doGearPanel(page) {
  const notes = [];
  const criticalFails = [];
  const extraShotPaths = [];

  await page.evaluate(() => {
    const rows = document.querySelectorAll('.el-table__row');
    for (const row of rows) {
      const cogBtn = Array.from(row.querySelectorAll('button')).find(b => b.querySelector('.fa-cog'));
      if (cogBtn) { cogBtn.click(); return; }
    }
  });
  await page.waitForTimeout(2000);
  const panelText = await page.evaluate(() => {
    const panels = document.querySelectorAll('.el-dialog__body, .el-drawer__body');
    return Array.from(panels).map(p => p.innerText?.substring(0, 200)).join(' ');
  }).catch(() => '');
  if (/machine.*name|machine.*credit|machine.*status/i.test(panelText)) {
    notes.push('✅齒輪面板有機台資訊');
  } else {
    notes.push('⚠️齒輪面板內容待確認');
  }
  // 截圖（齒輪面板開啟狀態）
  const gearShotPath = path.join(SCREENSHOT_DIR, `gear_panel_${Date.now()}.png`);
  await page.screenshot({ path: gearShotPath, fullPage: false });
  extraShotPaths.push(gearShotPath);

  return { notes: notes.join(' | '), criticalFails, extraShotPaths };
}

/**
 * doTimeSetting(page) → TimeSetting dialog 流程
 * 回傳 { notes, criticalFails, extraShotPaths }
 */
async function doTimeSetting(page) {
  const notes = [];
  const criticalFails = [];
  const extraShotPaths = [];

  // 點 Reservation List 按鈕（開啟內層面板）
  const clickedResList = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const btn = btns.find(b => /reservation.*list/i.test(b.innerText));
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (clickedResList) {
    await page.waitForTimeout(2000);
    // 點 Parameter Setting 按鈕
    const clickedParam = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const btn = btns.find(b => /parameter.*setting/i.test(b.innerText));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (clickedParam) {
      await page.waitForTimeout(1500);
      const dialogText = await page.evaluate(() => {
        const d = document.querySelector('.el-dialog__body');
        return d ? d.innerText : '';
      }).catch(() => '');
      if (/lock.*count|lock.*time|machine.*count/i.test(dialogText)) {
        notes.push('✅TimeSetting dialog（Lock Count / Lock Time / Machine Count）');
      } else {
        notes.push('❌TimeSetting dialog 內容異常');
        criticalFails.push('TimeSetting dialog 內容異常');
      }
      // 截圖（TimeSetting dialog 開啟狀態）
      const timeSettingShotPath = path.join(SCREENSHOT_DIR, `timesetting_dialog_${Date.now()}.png`);
      await page.screenshot({ path: timeSettingShotPath, fullPage: false });
      extraShotPaths.push(timeSettingShotPath);
      // 關閉 dialog
      await page.evaluate(() => {
        document.querySelectorAll('.el-dialog__wrapper').forEach(el => el.style.display = 'none');
      });
    } else {
      notes.push('❌Parameter Setting 按鈕缺失');
      criticalFails.push('Parameter Setting 按鈕缺失');
    }
  } else {
    notes.push('❌Reservation List 按鈕缺失（Time Setting 無法驗證）');
    criticalFails.push('Reservation List 按鈕缺失');
  }

  return { notes: notes.join(' | '), criticalFails, extraShotPaths };
}

// ─── 每頁獨立 verify functions ────────────────────────────────────────

async function verifyDashboard(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1 } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);

  const cardCount = await page.evaluate(() =>
    document.querySelectorAll('.el-card, [class*="card"], [class*="count"], [class*="stat"]').length
  ).catch(() => 0);
  notes.push(cardCount > 0 ? `✅儀錶板卡片×${cardCount}` : '⚠️儀錶板卡片未偵測到');

  return { notes: notes.join(' | '), criticalFails };
}

// ─── Daily Dashboard filter helpers ──────────────────────────────────────────

async function dashSetDate(page, dateStr) {
  // Try multiple selectors for the date input
  const selectors = [
    '.el-date-editor input',
    'input[placeholder*="Date"]',
    'input[placeholder*="date"]',
    '.el-input__inner[value*="20"]',  // value starts with year
    'input[type="text"][class*="input"]',
  ];
  let input = null;
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    const visible = await loc.isVisible({ timeout: 2000 }).catch(() => false);
    if (visible) { input = loc; break; }
  }
  if (!input) {
    // Fallback: first visible text input in the filter bar
    input = page.locator('input[type="text"]').first();
  }
  try {
    await input.click({ clickCount: 3, timeout: 5000 });
    await input.fill(dateStr);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  } catch {
    // If fill fails, try evaluate
    await page.evaluate((date) => {
      const inputs = document.querySelectorAll('input[type="text"]');
      for (const inp of inputs) {
        if (/\d{4}-\d{2}/.test(inp.value) || inp.placeholder?.toLowerCase().includes('date')) {
          const nativeInput = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
          nativeInput?.set?.call(inp, date);
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          break;
        }
      }
    }, dateStr);
    await page.waitForTimeout(500);
  }
}

async function dashSelectDropdown(page, labelText, optionText) {
  // Find the el-select closest to the label text, click it, pick option
  await page.evaluate((label) => {
    const labels = [...document.querySelectorAll('label, span, div')]
      .filter(el => el.childElementCount === 0 && el.innerText?.trim() === label);
    // Try parent's sibling el-select
    for (const lbl of labels) {
      const parent = lbl.closest('.el-form-item, .filter-item, div');
      const sel = parent?.querySelector('.el-select .el-input__inner');
      if (sel) { sel.click(); return; }
    }
    // Fallback: find by placeholder or current value
    const selects = [...document.querySelectorAll('.el-select .el-input__inner')];
    for (const s of selects) {
      if (s.placeholder?.includes(label) || s.closest('.el-select')?.previousElementSibling?.innerText?.includes(label)) {
        s.click(); return;
      }
    }
  }, labelText);
  await page.waitForTimeout(400);

  const clicked = await page.evaluate((opt) => {
    const items = [...document.querySelectorAll('.el-select-dropdown__item:not(.is-disabled)')];
    const item = items.find(i => i.innerText?.trim() === opt);
    if (item) { item.click(); return true; }
    return false;
  }, optionText);

  await page.waitForTimeout(300);
  // Close dropdown if still open
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  return clicked;
}

async function dashClickView(page) {
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /^view$/i.test(b.innerText?.trim()));
    if (btn) btn.click();
  });
  await page.waitForTimeout(1500);
}

async function dashReadCards(page) {
  return await page.evaluate(() => {
    const text = document.body?.innerText || '';
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

    function findAfter(label) {
      const idx = lines.findIndex(l => l.toLowerCase() === label.toLowerCase());
      if (idx === -1) return null;
      for (let i = idx + 1; i < lines.length && i <= idx + 3; i++) {
        const v = lines[i];
        if (v && v !== label) return v;
      }
      return null;
    }
    function parsePHP(s) {
      if (!s) return null;
      const m = s.replace(/,/g, '').match(/-?[\d.]+/);
      return m ? parseFloat(m[0]) : null;
    }
    function parseRatio(s) {
      if (!s) return null;
      const m = s.match(/-?[\d.]+/);
      return m ? parseFloat(m[0]) : null;
    }

    const betPlayerRaw = findAfter('Total bet player');
    const totalInRaw   = findAfter('Total in');
    const totalOutRaw  = findAfter('Total out');
    const totalBetRaw  = findAfter('Total bet');
    const winRaw       = findAfter('Total Actual Win');
    const ratioRaw     = findAfter('Total win lose ratio');

    return {
      betPlayer:    betPlayerRaw ? parseInt(betPlayerRaw.replace(/[^\d]/g, '')) : null,
      totalIn:      parsePHP(totalInRaw),
      totalOut:     parsePHP(totalOutRaw),
      totalBet:     parsePHP(totalBetRaw),
      actualWin:    parsePHP(winRaw),
      winLoseRatio: parseRatio(ratioRaw),
      raw: { betPlayerRaw, totalInRaw, totalOutRaw, totalBetRaw, winRaw, ratioRaw },
    };
  });
}

async function daycountRead(page, targetDate) {
  // Read the row matching targetDate from EGM DayCount table
  return await page.evaluate((date) => {
    // Try el-table rows first
    const rows = [...document.querySelectorAll('tr')].filter(r => r.querySelector('td'));
    for (const row of rows) {
      const cells = [...row.querySelectorAll('td')].map(td => td.innerText?.trim() || '');
      if (cells[0] === date || cells[0]?.startsWith(date)) {
        function parsePHP(s) {
          const m = (s || '').replace(/,/g, '').match(/-?[\d.]+/);
          return m ? parseFloat(m[0]) : null;
        }
        return {
          totalIn:      parsePHP(cells[1]),
          totalOut:     parsePHP(cells[2]),
          betUser:      parseInt((cells[3] || '').replace(/[^\d]/g, '')) || null,
          totalBet:     parsePHP(cells[5]),
          totalWinLose: parsePHP(cells[6]),
          winLoseRatio: parseFloat((cells[7] || '').replace(/[^-\d.]/g, '')) || null,
        };
      }
    }
    return null;
  }, targetDate);
}

function dashCompare(dashVals, dcVals, label) {
  if (!dcVals) return `⚠️${label}：EGM DayCount 無對應日期資料`;
  const results = [];
  function cmp(name, dv, dcv, pct = 0.01) {
    if (dv == null || dcv == null) { results.push(`⚠️${name}無法取得`); return; }
    const ok = Math.abs(dv - dcv) <= Math.max(Math.abs(dcv) * pct, 1);
    results.push(ok
      ? `✅${name}吻合(${dv})`
      : `❌${name}不符(Dashboard:${dv} DayCount:${dcv})`);
  }
  cmp('投注人數', dashVals.betPlayer, dcVals.betUser, 0);
  cmp('TotalIn', dashVals.totalIn, dcVals.totalIn);
  cmp('TotalOut', dashVals.totalOut, dcVals.totalOut);
  cmp('TotalBet', dashVals.totalBet, dcVals.totalBet);
  cmp('ActualWin', dashVals.actualWin, dcVals.totalWinLose);
  cmp('WinLoseRatio%', dashVals.winLoseRatio, dcVals.winLoseRatio, 0.1);
  return `【${label}】${results.join(' ')}`;
}

async function dismissWarningDialog(page) {
  // JS-hide Warning dialog to avoid triggering Vue Router navigation via Cancel button
  await page.locator('.el-dialog').filter({ hasText: /Warnning|Warning/i }).waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  await page.evaluate(() => {
    document.querySelectorAll('.el-dialog__wrapper').forEach(el => {
      if (/Warnning|Warning/i.test(el.textContent || '')) el.style.display = 'none';
    });
    const overlay = document.querySelector('.v-modal');
    if (overlay) overlay.style.display = 'none';
  });
  await page.waitForTimeout(500);
}

async function runDashFilterTest(page, filterLabel, targetDate, gameType, clientVersion, extraShotPaths, notes, criticalFails) {
  // ① Navigate to Daily Dashboard
  await page.goto(`${BACKEND_URL}/daily_dashboard`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);
  await dismissWarningDialog(page);

  // ② Set filters
  await dashSetDate(page, targetDate);
  if (gameType && gameType !== 'All Game') await dashSelectDropdown(page, 'Game Type', gameType);
  if (clientVersion && clientVersion !== 'ALL') await dashSelectDropdown(page, 'Client Version', clientVersion);
  await dashClickView(page);
  await page.waitForTimeout(2000); // 等動畫跑完

  // ③ Screenshot Dashboard
  const dashShotPath = path.join(SCREENSHOT_DIR, `dash_filter_${filterLabel}_${Date.now()}.png`);
  await page.screenshot({ path: dashShotPath, fullPage: false });
  extraShotPaths.push(dashShotPath);

  // ④ Read Dashboard values
  const dashVals = await dashReadCards(page);

  // ⑤ Navigate to EGM DayCount
  await page.goto(`${BACKEND_URL}/egm/reports/gameCount`, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(1000);
  await dismissWarningDialog(page);

  // ⑥ Set same date range (from = to = targetDate)
  const dateInputs = page.locator('.el-date-editor input');
  const inputCount = await dateInputs.count().catch(() => 0);
  if (inputCount >= 2) {
    await dateInputs.nth(0).click({ clickCount: 3 });
    await dateInputs.nth(0).fill(targetDate);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(200);
    await dateInputs.nth(1).click({ clickCount: 3 });
    await dateInputs.nth(1).fill(targetDate);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
  } else if (inputCount === 1) {
    await dashSetDate(page, targetDate);
  }

  // ⑦ Set same Game Type / Client Version on DayCount
  if (gameType && gameType !== 'All Game') await dashSelectDropdown(page, 'Game Type', gameType);
  if (clientVersion && clientVersion !== 'ALL') await dashSelectDropdown(page, 'Client Version', clientVersion);

  // ⑧ Click View
  await dashClickView(page);

  // ⑨ Screenshot DayCount
  const dcShotPath = path.join(SCREENSHOT_DIR, `daycount_filter_${filterLabel}_${Date.now()}.png`);
  await page.screenshot({ path: dcShotPath, fullPage: false });
  extraShotPaths.push(dcShotPath);

  // ⑩ Read DayCount row
  const dcVals = await daycountRead(page, targetDate);

  // ⑩b Export + compare xlsx with on-screen values
  const exportResult = await doExport(page);
  notes.push(`Export(${filterLabel}):${exportResult.notes}`);
  criticalFails.push(...exportResult.criticalFails);

  // Declare xlsx vars at outer scope so they're available for return
  let xlsxVals = null;

  if (exportResult.exportedXlsxPath) {
    // Read xlsx and find row matching targetDate
    const { headers, rows } = extractXlsxData(exportResult.exportedXlsxPath);
    const dateColIdx = headers.findIndex(h => /^date$/i.test(h.trim()));
    const xlsxRow = rows.find(r => {
      const cellVal = String(r[dateColIdx >= 0 ? dateColIdx : 0] ?? '').trim();
      return cellVal === targetDate || cellVal.startsWith(targetDate);
    });

    if (xlsxRow) {
      const xlsxNum = (colPattern) => {
        const idx = headers.findIndex(h => new RegExp(colPattern, 'i').test(h));
        if (idx === -1) return null;
        const v = xlsxRow[idx];
        return v != null && v !== '' ? parseFloat(String(v).replace(/,/g, '')) : null;
      };
      const rawRatio = xlsxNum('win.lose.ratio');
      xlsxVals = {
        betUser:      xlsxNum('bet.user|bet user'),
        totalIn:      xlsxNum('transfer.in|in.amount'),
        totalOut:     xlsxNum('transfer.out|out.amount'),
        totalBet:     xlsxNum('bet.amount'),
        totalWinLose: xlsxNum('win.or.lose|win.lose.amount'),
        // xlsx stores ratio as decimal (e.g. 0.437), screen shows percentage (43.7) → ×100
        winLoseRatio: rawRatio != null ? parseFloat((rawRatio * 100).toFixed(4)) : null,
      };
      // Compare xlsx vs on-screen DayCount
      const xlsxCompare = dashCompare(
        { betPlayer: xlsxVals.betUser, totalIn: xlsxVals.totalIn, totalOut: xlsxVals.totalOut,
          totalBet: xlsxVals.totalBet, actualWin: xlsxVals.totalWinLose, winLoseRatio: xlsxVals.winLoseRatio },
        dcVals,
        `${filterLabel}(xlsx↔畫面)`
      );
      notes.push(xlsxCompare);
      if (xlsxCompare.includes('❌')) criticalFails.push(`DayCount xlsx與畫面數值不符(${filterLabel})`);
    } else {
      notes.push(`⚠️xlsx中找不到${targetDate}對應行`);
    }
  }

  // ⑪ Compare Dashboard ↔ DayCount
  const compareNote = dashCompare(dashVals, dcVals, filterLabel);
  const pass = !compareNote.includes('❌');
  notes.push(compareNote);
  if (!pass) criticalFails.push(`Daily Dashboard ${filterLabel} 篩選數據與DayCount不符`);

  // Return raw values for visual report generation
  return { pass, dashVals, dcVals, xlsxVals, filterLabel };
}

async function generateDashFilterReport(page, filterResults, targetDate) {
  function fmt(v) { return v == null ? '–' : typeof v === 'number' ? v.toLocaleString() : String(v); }
  function cmpColor(a, b, pct = 0.01) {
    if (a == null || b == null) return '#f59e0b'; // amber = unknown
    return Math.abs(a - b) <= Math.max(Math.abs(b) * pct, 1) ? '#16a34a' : '#dc2626';
  }

  const fields = [
    { key: 'betPlayer/betUser', label: '投注人數', dashKey: 'betPlayer', dcKey: 'betUser', xlsxKey: 'betUser', pct: 0 },
    { key: 'totalIn',           label: 'TotalIn',   dashKey: 'totalIn',   dcKey: 'totalIn',   xlsxKey: 'totalIn'   },
    { key: 'totalOut',          label: 'TotalOut',  dashKey: 'totalOut',  dcKey: 'totalOut',  xlsxKey: 'totalOut'  },
    { key: 'totalBet',          label: 'TotalBet',  dashKey: 'totalBet',  dcKey: 'totalBet',  xlsxKey: 'totalBet'  },
    { key: 'actualWin',         label: 'ActualWin', dashKey: 'actualWin', dcKey: 'totalWinLose', xlsxKey: 'totalWinLose' },
    { key: 'winLoseRatio',      label: 'WinLoseRatio%', dashKey: 'winLoseRatio', dcKey: 'winLoseRatio', xlsxKey: 'winLoseRatio', pct: 0.1 },
  ];

  let html = `<div style="font-family:sans-serif;padding:16px;background:#f8fafc;font-size:13px">
    <h2 style="color:#1e40af;margin:0 0 4px;font-size:16px">Daily Dashboard 篩選比對報告</h2>
    <p style="color:#64748b;margin:0 0 14px">目標日期: ${targetDate} | 比對: Dashboard ↔ EGM DayCount ↔ xlsx</p>`;

  for (const fr of filterResults) {
    const { filterLabel, dashVals, dcVals, xlsxVals } = fr;
    const hasXlsx = xlsxVals != null;
    html += `<div style="margin-bottom:14px;background:#fff;border:1px solid #e2e8f0;border-radius:6px;overflow:hidden">
      <div style="background:#1e40af;color:#fff;padding:6px 12px;font-weight:bold">${filterLabel}</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <tr style="background:#f1f5f9">
          <th style="padding:5px 10px;text-align:left;border-bottom:1px solid #e2e8f0">欄位</th>
          <th style="padding:5px 10px;text-align:right;border-bottom:1px solid #e2e8f0">Dashboard</th>
          <th style="padding:5px 10px;text-align:right;border-bottom:1px solid #e2e8f0">DayCount(畫面)</th>
          <th style="padding:5px 10px;text-align:right;border-bottom:1px solid #e2e8f0">Dash↔DC</th>
          ${hasXlsx ? `<th style="padding:5px 10px;text-align:right;border-bottom:1px solid #e2e8f0">xlsx</th><th style="padding:5px 10px;text-align:right;border-bottom:1px solid #e2e8f0">xlsx↔DC</th>` : ''}
        </tr>`;
    for (const f of fields) {
      const dv  = dashVals?.[f.dashKey] ?? null;
      const dcv = dcVals?.[f.dcKey]     ?? null;
      const xv  = xlsxVals?.[f.xlsxKey] ?? null;
      const dcColor  = cmpColor(dv, dcv, f.pct ?? 0.01);
      const xlsxColor = cmpColor(xv, dcv, f.pct ?? 0.01);
      const dcIcon  = dv == null || dcv == null ? '⚠' : (dcColor === '#16a34a' ? '✓' : '✗');
      const xlsxIcon = xv == null || dcv == null ? '⚠' : (xlsxColor === '#16a34a' ? '✓' : '✗');
      html += `<tr style="border-bottom:1px solid #f1f5f9">
        <td style="padding:4px 10px;color:#475569">${f.label}</td>
        <td style="padding:4px 10px;text-align:right">${fmt(dv)}</td>
        <td style="padding:4px 10px;text-align:right">${fmt(dcv)}</td>
        <td style="padding:4px 10px;text-align:center;color:${dcColor};font-weight:bold">${dcIcon}</td>
        ${hasXlsx ? `<td style="padding:4px 10px;text-align:right">${fmt(xv)}</td><td style="padding:4px 10px;text-align:center;color:${xlsxColor};font-weight:bold">${xlsxIcon}</td>` : ''}
      </tr>`;
    }
    html += `</table></div>`;
  }
  html += `</div>`;

  const reportPath = path.join(SCREENSHOT_DIR, `dash_filter_report_${Date.now()}.png`);
  const prevUrl = page.url();
  await page.setViewportSize({ width: 860, height: 600 });
  await page.setContent(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0">${html}</body></html>`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  await page.screenshot({ path: reportPath, fullPage: true });
  await page.goto(prevUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  return reportPath;
}

async function verifyDailyDashboard(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1 } = await getBaseInfo(page);
  if (!/daily.dashboard/i.test(h1 || '')) {
    const currentUrl = await page.evaluate(() => window.location.href).catch(() => '');
    if (!/daily.dashboard/i.test(currentUrl)) {
      notes.push('❌未進入Daily Dashboard');
      criticalFails.push('未進入Daily Dashboard');
      return { notes: notes.join(' | '), criticalFails };
    }
  }
  if (h1) notes.push(`頁面:${h1}`);

  const pageText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');

  if (/藍底|投注.*新用戶/i.test(full)) {
    const hasData = /Total bet player|Bet Player|New Player|Total.*Player|投注|新用戶/i.test(pageText);
    if (hasData) {
      notes.push('✅藍底有數據(Total bet player)');
    } else {
      notes.push('❌藍底 Total bet player 未找到');
      criticalFails.push('Daily Dashboard 藍底 Total bet player 缺失');
    }
  }

  if (/橘底|handpay.*金額/i.test(full)) {
    const hasHandpay = /Total Jackpot|HandPay|Handpay|handpay|手動支付/i.test(pageText);
    if (hasHandpay) {
      notes.push('✅橘底Total Jackpot有數據');
    } else {
      notes.push('❌橘底 Total Jackpot 未找到');
      criticalFails.push('Daily Dashboard 橘底 Total Jackpot 缺失');
    }
  }

  if (/綠底|輸贏率/i.test(full)) {
    const hasIn = /Total in/i.test(pageText);
    const hasRatio = /Total win lose ratio|Win.*Lose.*Ratio/i.test(pageText);
    if (hasIn && hasRatio) {
      notes.push('✅綠底(Total in + Total win lose ratio)');
    } else {
      notes.push(`❌綠底缺失(Total in:${hasIn}, Ratio:${hasRatio})`);
      criticalFails.push('Daily Dashboard 綠底資料缺失');
    }
  }

  if (/紅底|留存率|dau|mau/i.test(full)) {
    const hasDAU = /DAU/i.test(pageText);
    const hasMAU = /MAU/i.test(pageText);
    const hasRetention = /User retention rate|Retention/i.test(pageText);
    if (hasDAU && hasMAU && hasRetention) {
      notes.push('✅紅底(DAU/MAU/User retention rate)');
    } else {
      notes.push(`❌紅底缺失(DAU:${hasDAU}, MAU:${hasMAU}, Retention:${hasRetention})`);
      criticalFails.push('Daily Dashboard 紅底資料缺失');
    }
  }

  if (/game.*type.*client.*version|date.*功能|game\s*type.*date|client.*version.*date/i.test(full)) {
    const extraShotPaths = [];

    // Determine a target date: yesterday (YYYY-MM-DD)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const targetDate = yesterday.toISOString().split('T')[0];

    // ── TC: Date filter ──
    const r1 = await runDashFilterTest(page, 'Date篩選', targetDate, 'All Game', 'ALL', extraShotPaths, notes, criticalFails);

    // ── TC: Client Version filter ──
    const testClientVersion = process.env.DASH_CLIENT_VERSION || 'H5(1.5)';
    const r2 = await runDashFilterTest(page, `ClientVersion(${testClientVersion})`, targetDate, 'All Game', testClientVersion, extraShotPaths, notes, criticalFails);

    // ── TC: Game Type filter ──
    const testGameType = process.env.DASH_GAME_TYPE || 'BWJL';
    const r3 = await runDashFilterTest(page, `GameType(${testGameType})`, targetDate, testGameType, 'ALL', extraShotPaths, notes, criticalFails);

    // ── Generate visual comparison report screenshot ──
    // Put report FIRST so it's the primary thumbnail in Lark
    try {
      const reportPath = await generateDashFilterReport(page, [r1, r2, r3], targetDate);
      console.log(`[DashFilterReport] generated: ${reportPath}, exists: ${fs.existsSync(reportPath)}`);
      if (reportPath && fs.existsSync(reportPath)) extraShotPaths.unshift(reportPath);
    } catch (e) {
      console.log(`[DashFilterReport] ERROR: ${e.message}`);
      notes.push(`⚠️比對報告截圖生成失敗: ${e.message}`);
    }

    return { notes: notes.join(' | '), criticalFails, extraShotPaths };
  }

  return { notes: notes.join(' | '), criticalFails };
}

async function verifyEGMList(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';
  const desc = full.toLowerCase();

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, rowCount, allBtns } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);
  notes.push(`表格${rowCount}筆`);

  let exportedXlsxPath = null;
  const extraShotPaths = [];

  if (/\badd\b|新增/.test(desc)) {
    const hasAdd = allBtns.some(t => /^add$/i.test(t));
    if (hasAdd) {
      notes.push('✅Add按鈕');
    } else {
      notes.push('❌Add按鈕缺失');
      criticalFails.push('Add按鈕缺失');
    }
  }

  if (/set.*config|config.*按鈕/i.test(full)) {
    const hasConfig = allBtns.some(t => /config/i.test(t));
    notes.push(hasConfig ? '✅Set Config按鈕' : '⚠️Set Config按鈕未找到');
  }

  if (/batch.*set|批量設置/i.test(full)) {
    const hasBatch = allBtns.some(t => /batch/i.test(t));
    notes.push(hasBatch ? '✅Batch Set按鈕' : '⚠️Batch Set按鈕未找到');
  }

  if (/excel|export|匯出|導出|csv/.test(desc)) {
    const exportResult = await doExport(page);
    if (exportResult.notes) notes.push(exportResult.notes);
    criticalFails.push(...exportResult.criticalFails);
    exportedXlsxPath = exportResult.exportedXlsxPath;
  }

  if (/showcase/i.test(full)) {
    const showcaseResult = await doShowcase(page);
    if (showcaseResult.notes) notes.push(showcaseResult.notes);
    criticalFails.push(...showcaseResult.criticalFails);
    extraShotPaths.push(...showcaseResult.extraShotPaths);
  }

  if (/maintenance|維護.*喚醒/i.test(full)) {
    const hasMaint = allBtns.some(t => /maintenance|wake/i.test(t));
    notes.push(hasMaint ? '✅Maintenance按鈕' : '⚠️Maintenance/Wake按鈕未找到');
  }

  if (/可以.*編輯|可以.*刪除|edit.*delete|delete.*edit|編輯.*刪除|刪除.*編輯/.test(desc)) {
    if (rowCount === 0) {
      notes.push('⚠️操作按鈕待確認（表格無資料）');
    } else {
      const hasEdit = await page.evaluate(() =>
        document.querySelectorAll('.el-button--primary, .el-button--warning').length > 0
      ).catch(() => false);
      const hasDel = await page.evaluate(() =>
        document.querySelectorAll('.el-button--danger').length > 0
      ).catch(() => false);
      if (hasEdit || hasDel) {
        notes.push(`✅操作按鈕(edit:${hasEdit},del:${hasDel})`);
      } else {
        notes.push('❌編輯/刪除按鈕缺失');
        criticalFails.push('編輯/刪除按鈕缺失');
      }
    }
  }

  return { notes: notes.join(' | '), criticalFails, exportedXlsxPath, extraShotPaths };
}

async function verifyEGMStatus(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, rowCount, allBtns } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);
  notes.push(`表格${rowCount}筆`);

  const extraShotPaths = [];

  if (/齒輪|gear|機台詳細|machine.*detail|screen.*cctv|cctv.*grid/i.test(full)) {
    const gearResult = await doGearPanel(page);
    if (gearResult.notes) notes.push(gearResult.notes);
    criticalFails.push(...gearResult.criticalFails);
    extraShotPaths.push(...gearResult.extraShotPaths);
  }

  if (/maintenance|維護.*喚醒/i.test(full)) {
    const hasMaint = allBtns.some(t => /maintenance|wake/i.test(t));
    notes.push(hasMaint ? '✅Maintenance按鈕' : '⚠️Maintenance按鈕未找到');
  }

  return { notes: notes.join(' | '), criticalFails, extraShotPaths };
}

async function verifyGamingUser(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';
  const desc = full.toLowerCase();

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, rowCount } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);
  notes.push(`表格${rowCount}筆（UAT環境可能為0）`);

  let exportedXlsxPath = null;

  if (/excel|export|匯出|導出|csv/.test(desc)) {
    const exportResult = await doExport(page);
    if (exportResult.notes) notes.push(exportResult.notes);
    criticalFails.push(...exportResult.criticalFails);
    exportedXlsxPath = exportResult.exportedXlsxPath;
  }

  return { notes: notes.join(' | '), criticalFails, exportedXlsxPath };
}

async function verifyReportPage(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';
  const desc = full.toLowerCase();

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, rowCount } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);
  notes.push(`表格${rowCount}筆`);

  // 確認 Date filter 存在
  const hasDate = await page.evaluate(() =>
    document.querySelectorAll('.el-date-editor, input[type="date"]').length > 0
  ).catch(() => false);
  if (hasDate) {
    notes.push('✅日期篩選');
  } else {
    notes.push('❌日期篩選缺失');
    criticalFails.push('日期篩選缺失');
  }

  let exportedXlsxPath = null;

  if (/excel|export|匯出|導出|csv/.test(desc)) {
    const exportResult = await doExport(page);
    if (exportResult.notes) notes.push(exportResult.notes);
    criticalFails.push(...exportResult.criticalFails);
    exportedXlsxPath = exportResult.exportedXlsxPath;
  }

  return { notes: notes.join(' | '), criticalFails, exportedXlsxPath };
}

async function verifyMeterPage(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';
  const desc = full.toLowerCase();

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, rowCount } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);
  notes.push(`表格${rowCount}筆`);

  let exportedXlsxPath = null;

  if (/excel|export|匯出|導出|csv/.test(desc)) {
    const exportResult = await doExport(page);
    if (exportResult.notes) notes.push(exportResult.notes);
    criticalFails.push(...exportResult.criticalFails);
    exportedXlsxPath = exportResult.exportedXlsxPath;
  }

  if (/date|日期/.test(desc)) {
    const hasDate = await page.evaluate(() =>
      document.querySelectorAll('.el-date-editor, input[type="date"], .el-date-picker, [class*="date-range"]').length > 0
    ).catch(() => false);
    notes.push(hasDate ? '✅日期篩選' : '⚠️日期篩選未偵測到');
  }

  return { notes: notes.join(' | '), criticalFails, exportedXlsxPath };
}

async function verifyLoadingTips(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';
  const desc = full.toLowerCase();

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, rowCount, allBtns } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);
  notes.push(`表格${rowCount}筆`);

  if (/\badd\b|新增/.test(desc)) {
    const hasAdd = allBtns.some(t => /^add$/i.test(t));
    if (hasAdd) {
      notes.push('✅Add按鈕');
    } else {
      notes.push('❌Add按鈕缺失');
      criticalFails.push('Add按鈕缺失');
    }
  }

  if (/可以.*編輯|可以.*刪除|edit.*delete|delete.*edit|編輯.*刪除|刪除.*編輯/.test(desc)) {
    if (rowCount === 0) {
      notes.push('⚠️操作按鈕待確認（表格無資料）');
    } else {
      const hasEdit = await page.evaluate(() =>
        document.querySelectorAll('.el-button--primary, .el-button--warning').length > 0
      ).catch(() => false);
      const hasDel = await page.evaluate(() =>
        document.querySelectorAll('.el-button--danger').length > 0
      ).catch(() => false);
      notes.push(`✅操作按鈕(edit:${hasEdit},del:${hasDel})`);
    }
  }

  return { notes: notes.join(' | '), criticalFails };
}

async function verifyChannelRanking(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';
  const desc = full.toLowerCase();

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, rowCount, allBtns } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);
  notes.push(`表格${rowCount}筆`);

  if (/\badd\b|channelrankid/i.test(full)) {
    const hasBtn = allBtns.some(t => /add|channelrankid/i.test(t));
    if (hasBtn) {
      notes.push(`✅Add/ChannelRankID按鈕(${allBtns.find(t => /add|channelrankid/i.test(t))})`);
    } else {
      notes.push('❌Add/ChannelRankID按鈕缺失');
      criticalFails.push('Add/ChannelRankID按鈕缺失');
    }
  }

  return { notes: notes.join(' | '), criticalFails };
}

async function verifyWhiteList(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';
  const desc = full.toLowerCase();

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, rowCount, allBtns } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);
  notes.push(`表格${rowCount}筆`);

  if (/\badd\b|white.*account/i.test(full)) {
    const hasBtn = allBtns.some(t => /white.*account/i.test(t));
    if (hasBtn) {
      notes.push('✅White Account按鈕');
    } else {
      notes.push('❌White Account按鈕缺失');
      criticalFails.push('White Account按鈕缺失');
    }
  }

  return { notes: notes.join(' | '), criticalFails };
}

async function verifyGameSettingPage(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';
  const desc = full.toLowerCase();

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, rowCount, allBtns } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);
  notes.push(`表格${rowCount}筆`);

  let exportedXlsxPath = null;

  if (/\badd\b|新增/.test(desc)) {
    const hasAdd = allBtns.some(t => /^add$/i.test(t));
    if (hasAdd) {
      notes.push('✅Add按鈕');
    } else {
      notes.push('❌Add按鈕缺失');
      criticalFails.push('Add按鈕缺失');
    }
  }

  if (/開啟.*關閉|關閉.*開啟|switch|toggle/.test(desc)) {
    const switchCount = await page.evaluate(() =>
      document.querySelectorAll('.el-switch, input[type="checkbox"]').length
    ).catch(() => 0);
    if (switchCount > 0) {
      notes.push(`✅開關×${switchCount}`);
    } else {
      notes.push('❌開關元件缺失');
      criticalFails.push('開關元件缺失');
    }
  }

  if (/可以.*編輯|可以.*刪除|edit.*delete|delete.*edit|編輯.*刪除|刪除.*編輯/.test(desc)) {
    if (rowCount === 0) {
      notes.push('⚠️操作按鈕待確認（表格無資料）');
    } else {
      const hasEdit = await page.evaluate(() =>
        document.querySelectorAll('.el-button--primary, .el-button--warning').length > 0
      ).catch(() => false);
      const hasDel = await page.evaluate(() =>
        document.querySelectorAll('.el-button--danger').length > 0
      ).catch(() => false);
      if (hasEdit || hasDel) {
        notes.push(`✅操作按鈕(edit:${hasEdit},del:${hasDel})`);
      } else {
        notes.push('❌編輯/刪除按鈕缺失');
        criticalFails.push('編輯/刪除按鈕缺失');
      }
    }
  }

  if (/excel|export|匯出|導出|csv/.test(desc)) {
    const exportResult = await doExport(page);
    if (exportResult.notes) notes.push(exportResult.notes);
    criticalFails.push(...exportResult.criticalFails);
    exportedXlsxPath = exportResult.exportedXlsxPath;
  }

  return { notes: notes.join(' | '), criticalFails, exportedXlsxPath };
}

async function verifyEGMJPPercent(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, allHeaders } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);

  const jpCols = ['Fortune', 'Grand', 'Major', 'Minor', 'Mini'];
  const missing = jpCols.filter(c => !allHeaders.some(h => h.includes(c)));
  if (missing.length === 0) {
    notes.push('✅JP欄位(Fortune/Grand/Major/Minor/Mini)');
  } else {
    notes.push(`❌JP欄位缺失:${missing.join(',')}`);
    criticalFails.push(`JP欄位缺失:${missing.join(',')}`);
  }

  return { notes: notes.join(' | '), criticalFails };
}

async function verifyJackpotMoment(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, allHeaders, rowCount } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);
  notes.push(`表格${rowCount}筆`);

  const reqCols = ['Account', 'Jp'];
  const missing = reqCols.filter(c => !allHeaders.some(h => new RegExp(c, 'i').test(h)));
  if (missing.length === 0) {
    notes.push('✅Jackpot記錄欄位(Account/JpAmount/Time)');
  } else {
    notes.push(`⚠️部分欄位缺失:${missing.join(',')}`);
  }

  return { notes: notes.join(' | '), criticalFails };
}

async function verifyDepositSetting(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1 } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);

  const switchCount = await page.evaluate(() =>
    document.querySelectorAll('.el-switch, input[type="checkbox"]').length
  ).catch(() => 0);
  if (switchCount > 0) {
    notes.push(`✅開關元件×${switchCount}`);
  } else {
    notes.push('❌開關元件缺失');
    criticalFails.push('開關元件缺失');
  }

  return { notes: notes.join(' | '), criticalFails };
}

async function verifyMachineReservation(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, rowCount, allBtns } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);
  notes.push(`表格${rowCount}筆`);

  const extraShotPaths = [];

  if (/reservation.*list|預約名單/i.test(full)) {
    const hasResBtn = allBtns.some(t => /reservation.*list/i.test(t));
    notes.push(hasResBtn ? '✅Reservation List按鈕' : '⚠️Reservation List按鈕未找到');
  }

  if (/time.*setting|parameter.*setting|自動預約.*時長|時長.*設置|lock.*time|lock.*count/i.test(full)) {
    const timeResult = await doTimeSetting(page);
    if (timeResult.notes) notes.push(timeResult.notes);
    criticalFails.push(...timeResult.criticalFails);
    extraShotPaths.push(...timeResult.extraShotPaths);
  }

  return { notes: notes.join(' | '), criticalFails, extraShotPaths };
}

async function verifyReservationLimit(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1 } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);

  const hasInput = await page.evaluate(() =>
    document.querySelectorAll('.el-switch, input[type="number"], input[type="text"]').length > 0
  ).catch(() => false);
  notes.push(hasInput ? '✅設定欄位(Switch/輸入框)存在' : '⚠️設定欄位未偵測到');

  return { notes: notes.join(' | '), criticalFails };
}

async function verifyDailyRanking(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';

  // TC3（每5分鐘更新）：若計時器已啟動，標記為計時中（不走 MANUAL）
  if (/5.*分鐘.*更新|每5分鐘/i.test(full)) {
    if (_bonusTimerState) {
      const elapsed = Math.floor((Date.now() - _bonusTimerState.startTime) / 1000);
      notes.push(`⏳5分鐘計時中（已過${elapsed}秒）— 所有TC跑完後回來驗證`);
      return { notes: notes.join(' | '), criticalFails: [], manual: true };
    }
  }

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, rowCount, allHeaders } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);
  notes.push(`表格${rowCount}筆`);

  let toastShotPath = null;
  let exportedXlsxPath = null;
  const extraShotPaths = [];

  // ── TC1：排序規則驗證 — Total Bet Amount 必須降序 ─────────────────────
  if (/排序.*投注|投注.*排序|total.*bet.*amount|按照.*投注額/i.test(full)) {
    if (rowCount === 0) {
      notes.push('⚠️排序驗證跳過（今日無資料）');
    } else {
      const betColIdx = allHeaders.findIndex(h => /total.*bet.*amount/i.test(h));
      if (betColIdx === -1) {
        notes.push('❌Total Bet Amount欄位不存在');
        criticalFails.push('Total Bet Amount欄位缺失');
      } else {
        const betValues = await page.evaluate((colIdx) => {
          const rows = [...document.querySelectorAll('.el-table__body tr')];
          return rows.map(row => {
            const cells = row.querySelectorAll('td');
            const cell = cells[colIdx];
            if (!cell) return null;
            const txt = cell.innerText?.trim().replace(/,/g, '') || '';
            return txt === '' ? null : parseFloat(txt);
          }).filter(v => v !== null && !isNaN(v));
        }, betColIdx).catch(() => []);

        if (betValues.length === 0) {
          notes.push('⚠️Total Bet Amount欄位無數值可驗證');
        } else {
          let isDesc = true;
          for (let i = 1; i < betValues.length; i++) {
            if (betValues[i] > betValues[i - 1]) { isDesc = false; break; }
          }
          const today = new Date().toISOString().slice(0, 10);
          const rowsHtml = betValues.map((v, i) => {
            const ok = i === 0 || betValues[i] <= betValues[i - 1];
            const bg = ok ? '#f0fdf4' : '#fef2f2';
            const icon = ok ? '✅' : '❌';
            return `<tr style="background:${bg}"><td style="padding:6px 12px;font-weight:bold">#${i + 1}</td><td style="padding:6px 12px">${icon} ${v.toLocaleString()}</td><td style="padding:6px 12px;color:#666;font-size:11px">${i === 0 ? '—' : (ok ? `≤ ${betValues[i-1].toLocaleString()} ✓` : `> ${betValues[i-1].toLocaleString()} ✗`)}</td></tr>`;
          }).join('');
          const resultColor = isDesc ? '#16a34a' : '#dc2626';
          const resultText = isDesc ? '✅ PASS — 排序符合規格（Total Bet Amount 降序）' : '❌ FAIL — 排序不符（非 Total Bet Amount 降序）';
          const sortHtml = `<div style="padding:14px;font-family:sans-serif;font-size:12px;line-height:1.7;background:#f8f8f8;min-width:300px">
  <div style="font-size:14px;font-weight:bold;color:${resultColor};margin-bottom:10px">${resultText}</div>
  <div style="color:#444;margin-bottom:8px">📅 驗證日期：${today}<br>📐 規則：排名按 Total Bet Amount 降序（#1 最高）</div>
  <table border="1" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px;width:100%">
    <tr style="background:#dbeafe"><th style="padding:6px 12px">排名</th><th style="padding:6px 12px">Total Bet Amount</th><th style="padding:6px 12px">比較</th></tr>
    ${rowsHtml}
  </table>
  <div style="margin-top:10px;font-size:13px;font-weight:bold;color:${resultColor}">整體結果：${isDesc ? '✅ PASS' : '❌ FAIL'}</div>
</div>`;
          // 生成排序驗證截圖
          const sortShotPath = path.join(SCREENSHOT_DIR, `sort_verify_${Date.now()}.png`);
          await page.setContent(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0">${sortHtml}</body></html>`, { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(300);
          await page.screenshot({ path: sortShotPath, fullPage: true });
          // 回到原頁
          await page.goto(BACKEND_URL + '/rankinglist/dailyRanking', { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
          await page.waitForTimeout(1000);
          await dismissDialogs(page);
          extraShotPaths.push(sortShotPath);

          if (isDesc) {
            notes.push(`✅Total Bet Amount降序正確（排序驗證截圖已上傳）`);
          } else {
            notes.push(`❌排序錯誤：非降序`);
            criticalFails.push('Daily Ranking排序規則錯誤：非按Total Bet Amount降序');
          }
        }
      }
    }
  }

  // ── TC2：Bonus Settings 完整流程 ─────────────────────────────────────
  if (/bonus\s*settings?/i.test(full)) {
    // ① 修改前：讀取 Daily Ranking 表格 Bonus 欄位的值 + 截圖（before）
    const bonusColIdx = allHeaders.findIndex(h => /^bonus$/i.test(h.trim()));
    const beforeBonusVals = bonusColIdx >= 0
      ? await page.evaluate((colIdx) => {
          const rows = [...document.querySelectorAll('.el-table__body tr')];
          return rows.map(row => {
            const cell = row.querySelectorAll('td')[colIdx];
            return cell ? cell.innerText?.trim() : null;
          }).filter(v => v !== null);
        }, bonusColIdx).catch(() => [])
      : [];
    const beforeTableShotPath = path.join(SCREENSHOT_DIR, `bonus_table_before_${Date.now()}.png`);
    await page.screenshot({ path: beforeTableShotPath, fullPage: false });
    extraShotPaths.push(beforeTableShotPath);
    if (beforeBonusVals.length > 0) {
      notes.push(`📊修改前Bonus欄: [${beforeBonusVals.join(', ')}]`);
    }

    // ② 執行 Bonus Settings 修改流程
    const bonusResult = await doBonusSettings(page);
    if (bonusResult.notes) notes.push(bonusResult.notes);
    criticalFails.push(...bonusResult.criticalFails);
    toastShotPath = bonusResult.toastShotPath;
    extraShotPaths.push(...(bonusResult.extraShotPaths || []));

    // ③ 將 before 數據存入計時器狀態，供 5 分鐘後比對
    if (_bonusTimerState) {
      _bonusTimerState.beforeBonusVals = beforeBonusVals;
      _bonusTimerState.beforeTableShotPath = beforeTableShotPath;
      _bonusTimerState.bonusColIdx = bonusColIdx;
    }
  }

  // ── TC4：Export CSV 驗證 ──────────────────────────────────────────────
  if (/export|csv|導出|匯出/i.test(full)) {
    const expResult = await doExport(page);
    if (expResult.notes) notes.push(expResult.notes);   // doExport 回傳 string
    criticalFails.push(...expResult.criticalFails);
    exportedXlsxPath = expResult.exportedXlsxPath;
  }

  // ── TC5：Set Config 深層驗證 — Daily Rank + Daily Rank-Bonus 開關流程 ─
  if (/set.*config|config.*開關|開關.*日榜/i.test(full)) {
    try {
      // ① 點 Set Config 按鈕
      const setConfigBtn = page.locator('button').filter({ hasText: /set\s*config/i }).first();
      const btnVisible = await setConfigBtn.isVisible({ timeout: 3000 }).catch(() => false);
      if (!btnVisible) {
        notes.push('❌Set Config按鈕缺失');
        criticalFails.push('Set Config按鈕缺失');
      } else {
        await setConfigBtn.click();
        await page.waitForTimeout(1000);

        // ② 截圖（Set Config dialog 開啟初始狀態）
        const beforeShotPath = path.join(SCREENSHOT_DIR, `setconfig_before_${Date.now()}.png`);
        await page.screenshot({ path: beforeShotPath });
        extraShotPaths.push(beforeShotPath);

        // ③ 取得兩個 toggle 初始狀態（Daily Rank / Daily Rank-Bonus）
        const initialStates = await page.evaluate(() => {
          const switches = [...document.querySelectorAll('.el-dialog .el-switch')];
          return switches.map(sw => sw.classList.contains('is-checked'));
        }).catch(() => []);
        notes.push(`Set Config初始狀態: DailyRank=${initialStates[0] ? 'Open' : 'Close'} | DailyRank-Bonus=${initialStates[1] ? 'Open' : 'Close'}`);

        const toggleLabels = ['Daily Rank', 'Daily Rank-Bonus'];
        const toggleResults = [];

        // ④ 逐一切換兩個 toggle，確認 Info dialog + Confirm + 成功回應
        for (let t = 0; t < 2; t++) {
          const label = toggleLabels[t];
          // 點擊第 t 個 toggle
          const clicked = await page.evaluate((idx) => {
            const switches = [...document.querySelectorAll('.el-dialog .el-switch')];
            if (switches[idx]) { switches[idx].click(); return true; }
            return false;
          }, t);

          if (!clicked) {
            notes.push(`❌${label} toggle 找不到`);
            criticalFails.push(`${label} toggle 缺失`);
            toggleResults.push(false);
            continue;
          }
          await page.waitForTimeout(800);

          // 等待 Info dialog
          const infoDialog = page.locator('.el-message-box');
          const hasInfo = await infoDialog.isVisible({ timeout: 3000 }).catch(() => false);
          if (!hasInfo) {
            notes.push(`❌${label} 切換後未出現 Info dialog`);
            criticalFails.push(`${label} Info dialog 未出現`);
            toggleResults.push(false);
            continue;
          }

          // ⑤ 點 Confirm
          await page.locator('.el-message-box button').filter({ hasText: /confirm/i }).click().catch(async () => {
            await page.evaluate(() => {
              const btn = [...document.querySelectorAll('.el-message-box button')]
                .find(b => /confirm/i.test(b.innerText));
              if (btn) btn.click();
            });
          });
          await page.waitForTimeout(1000);

          // ⑥ 確認成功（success toast 或 dialog 自動關閉）
          const hasToast = await page.locator('.el-message--success').isVisible({ timeout: 2000 }).catch(() => false);

          // ⑦ 確認 toggle 狀態已翻轉
          const newState = await page.evaluate((idx) => {
            const switches = [...document.querySelectorAll('.el-dialog .el-switch')];
            return switches[idx]?.classList.contains('is-checked');
          }, t).catch(() => null);
          const stateFlipped = newState !== null && newState !== initialStates[t];

          // ⑧ 截圖（切換後）
          const afterShotPath = path.join(SCREENSHOT_DIR, `setconfig_${label.replace(/\s/g,'')}_after_${Date.now()}.png`);
          await page.screenshot({ path: afterShotPath });
          extraShotPaths.push(afterShotPath);

          if (stateFlipped) {
            notes.push(`✅${label} 開關切換成功(${hasToast ? 'toast確認' : '狀態已翻轉'})`);
            toggleResults.push(true);
          } else {
            notes.push(`❌${label} 開關切換後狀態未改變`);
            criticalFails.push(`${label} 開關切換失敗`);
            toggleResults.push(false);
          }
        }

        // ⑨ 還原：把兩個 toggle 切回原始狀態
        for (let t = 0; t < 2; t++) {
          const currentState = await page.evaluate((idx) => {
            const switches = [...document.querySelectorAll('.el-dialog .el-switch')];
            return switches[idx]?.classList.contains('is-checked');
          }, t).catch(() => null);
          if (currentState !== null && currentState !== initialStates[t]) {
            await page.evaluate((idx) => {
              const switches = [...document.querySelectorAll('.el-dialog .el-switch')];
              if (switches[idx]) switches[idx].click();
            }, t);
            await page.waitForTimeout(800);
            await page.locator('.el-message-box button').filter({ hasText: /confirm/i }).click().catch(async () => {
              await page.evaluate(() => {
                const btn = [...document.querySelectorAll('.el-message-box button')]
                  .find(b => /confirm/i.test(b.innerText));
                if (btn) btn.click();
              });
            });
            await page.waitForTimeout(800);
          }
        }
        notes.push('✅Set Config已還原原始狀態');

        // ⑩ 關閉 Set Config dialog
        await page.evaluate(() => {
          const closeBtn = [...document.querySelectorAll('.el-dialog button')]
            .find(b => /close/i.test(b.innerText));
          if (closeBtn) closeBtn.click();
        });
        await page.waitForTimeout(500);
      }
    } catch (e) {
      notes.push(`⚠️Set Config驗證例外: ${e.message}`);
    }
  }

  return { notes: notes.join(' | '), criticalFails, toastShotPath, exportedXlsxPath, extraShotPaths };
}

async function verifyJackpotRanking(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, allHeaders } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);

  const hasJpAmount = allHeaders.some(h => /jackpot.*amount/i.test(h));
  notes.push(hasJpAmount ? '✅Jackpot Amount欄位' : '⚠️未確認Jackpot Amount欄位');

  return { notes: notes.join(' | '), criticalFails };
}

async function verifyAbnormalityPage(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';
  const desc = full.toLowerCase();

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, rowCount } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);
  notes.push(`表格${rowCount}筆`);

  let exportedXlsxPath = null;

  if (/excel|export|匯出|導出|csv/.test(desc)) {
    const exportResult = await doExport(page);
    if (exportResult.notes) notes.push(exportResult.notes);
    criticalFails.push(...exportResult.criticalFails);
    exportedXlsxPath = exportResult.exportedXlsxPath;
  }

  return { notes: notes.join(' | '), criticalFails, exportedXlsxPath };
}

async function verifyLogPage(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';
  const desc = full.toLowerCase();

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, rowCount } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);
  notes.push(`表格${rowCount}筆`);

  let exportedXlsxPath = null;

  if (/excel|export|匯出|導出|csv/.test(desc)) {
    const exportResult = await doExport(page);
    if (exportResult.notes) notes.push(exportResult.notes);
    criticalFails.push(...exportResult.criticalFails);
    exportedXlsxPath = exportResult.exportedXlsxPath;
  }

  if (/date|日期/.test(desc)) {
    const hasDate = await page.evaluate(() =>
      document.querySelectorAll('.el-date-editor, input[type="date"], .el-date-picker, [class*="date-range"]').length > 0
    ).catch(() => false);
    notes.push(hasDate ? '✅日期篩選' : '⚠️日期篩選未偵測到');
  }

  return { notes: notes.join(' | '), criticalFails, exportedXlsxPath };
}

async function verifyMachineMonitoring(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1 } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);

  const hasContent = await page.evaluate(() =>
    document.querySelectorAll('table, .el-table, .el-card, [class*="card"]').length > 0
  ).catch(() => false);
  notes.push(hasContent ? '✅監控畫面存在' : '⚠️監控元素未偵測到');

  return { notes: notes.join(' | '), criticalFails };
}

async function verifyPlayerWatch(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, rowCount } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);
  notes.push(`表格${rowCount}筆`);

  return { notes: notes.join(' | '), criticalFails };
}

async function verifyGenericPage(page, tc) {
  const notes = [];
  const criticalFails = [];
  const full = tc || '';
  const desc = full.toLowerCase();

  const manualReason = detectManual(full);
  if (manualReason) {
    notes.push(`⚠️ MANUAL: ${manualReason}`);
    return { notes: notes.join(' | '), criticalFails: [], manual: true };
  }

  const { h1, rowCount, allBtns } = await getBaseInfo(page);
  if (h1) notes.push(`頁面:${h1}`);
  notes.push(`表格${rowCount}筆`);

  let exportedXlsxPath = null;

  if (/\badd\b|新增/.test(desc)) {
    const hasAdd = allBtns.some(t => /^add$/i.test(t));
    notes.push(hasAdd ? '✅Add按鈕' : '⚠️Add按鈕未找到');
  }

  if (/excel|export|匯出|導出|csv/.test(desc)) {
    const exportResult = await doExport(page);
    if (exportResult.notes) notes.push(exportResult.notes);
    criticalFails.push(...exportResult.criticalFails);
    exportedXlsxPath = exportResult.exportedXlsxPath;
  }

  if (/開啟.*關閉|關閉.*開啟|switch|toggle/.test(desc)) {
    const switchCount = await page.evaluate(() =>
      document.querySelectorAll('.el-switch, input[type="checkbox"]').length
    ).catch(() => 0);
    notes.push(switchCount > 0 ? `✅開關×${switchCount}` : '⚠️開關元件未偵測到');
  }

  return { notes: notes.join(' | '), criticalFails, exportedXlsxPath };
}

// ─── PAGE_VERIFIERS mapping ───────────────────────────────────────────
const PAGE_VERIFIERS = {
  'Dashboard':                verifyDashboard,
  'Daily Dashboard':          verifyDailyDashboard,
  'EGM List':                 verifyEGMList,
  'EGM Status':               verifyEGMStatus,
  'Gaming User':              verifyGamingUser,
  'EGM Detail':               verifyReportPage,
  'User Detail':              verifyReportPage,
  'EGM Transfer':             verifyReportPage,
  'Game Record':              verifyReportPage,
  'EGM DayCount':             verifyReportPage,
  'Player Credit Log':        verifyReportPage,
  'Jackpot Record':           verifyReportPage,
  'Fault List':               verifyReportPage,
  'Loading Tips':             verifyLoadingTips,
  'Channel Ranking':          verifyChannelRanking,
  'White List':               verifyWhiteList,
  'Game Jump Set':            verifyGameSettingPage,
  'News Set':                 verifyGameSettingPage,
  'EGM JP Percent':           verifyEGMJPPercent,
  'Advert Set':               verifyGameSettingPage,
  'EGM Hourly Meter':         verifyMeterPage,
  'EGM Performance Meter':    verifyMeterPage,
  'Jackpot Moment':           verifyJackpotMoment,
  'Deposit Setting':          verifyDepositSetting,
  '自動預約相關功能':           verifyMachineReservation,
  'Daily Ranking':            verifyDailyRanking,
  'Jackpot Ranking':          verifyJackpotRanking,
  '小額推薦影片':              verifyGameSettingPage,
  'How To Play':              verifyGameSettingPage,
  'Machine Monitoring':       verifyMachineMonitoring,
  'Player Watch':             verifyPlayerWatch,
  'OSM Instant Meter':        verifyMeterPage,
  'GCP Instant Meter':        verifyMeterPage,
  'Stress Test Instant Meter':verifyMeterPage,
  'Recovery Meter':           verifyMeterPage,
  'Daily Meter Reading':      verifyMeterPage,
  'Record Abnormality':       verifyAbnormalityPage,
  'Machine Abnormality':      verifyAbnormalityPage,
  'Jackpot Abnormality':      verifyAbnormalityPage,
  'Game Error Record':        verifyAbnormalityPage,
  'Machine Reservation Limit':verifyReservationLimit,
  'Special Entrance Set':     verifyGameSettingPage,
  'Test Setting':             verifyGameSettingPage,
  'Log Third Http Req':       verifyLogPage,
  'Log Third Bet Req':        verifyLogPage,
  'Log EGM Status':           verifyLogPage,
  'MeterCompensateSpinLog':   verifyLogPage,
  'Error Meter Info':         verifyLogPage,
  'Operation Log':            verifyLogPage,
  'Login Log':                verifyLogPage,
  'Out Log Records':          verifyLogPage,
};

async function callPageVerify(mapKey, page, tc) {
  const verifier = (mapKey && PAGE_VERIFIERS[mapKey]) ? PAGE_VERIFIERS[mapKey] : verifyGenericPage;
  return verifier(page, tc);
}

// ─── 後台測試 actions ────────────────────────────────────────────────
async function performAction(page, pagePath, action, label, taskDesc) {
  try {
    await page.goto(BACKEND_URL + pagePath, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(1500);

    // ── Daily Dashboard 特殊處理 ──────────────────────────────────────────────────────────────
    // goto('/daily_dashboard') 已正確停在 Daily Dashboard（router-link-exact-active 確認）
    // Warning dialog 的 Cancel 按鈕會觸發 Vue Router 導航到 /dashboards，
    // 因此改用 JS 隱藏 dialog + overlay，不觸發任何按鈕。
    if (action === 'daily_dashboard_verify') {
      // 等待 Warning dialog 出現（UAT 環境幾乎必定出現）
      await page.locator('.el-dialog').filter({ hasText: 'Warnning' }).waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      // 用 JS 直接隱藏 Warning dialog 和 modal overlay（避免 Cancel 觸發導航）
      await page.evaluate(() => {
        document.querySelectorAll('.el-dialog__wrapper').forEach(el => {
          if (el.textContent?.includes('Warnning')) el.style.display = 'none';
        });
        const overlay = document.querySelector('.v-modal');
        if (overlay) overlay.style.display = 'none';
      });
      await page.waitForTimeout(800);
      // 點 Search 載入今日數據
      const searchBtn = page.locator('button').filter({ hasText: /^Search$/ }).first();
      if (await searchBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await searchBtn.click();
        await page.waitForTimeout(2000);
      }
    } else {
      await dismissDialogs(page);
    }

    // 確保 Vue router 已完成頁面切換（等 breadcrumb/h1 出現）
    await page.waitForFunction(
      (path) => {
        const url = window.location.pathname;
        return url.includes(path.replace(/^\//, ''));
      },
      pagePath,
      { timeout: 5000 }
    ).catch(() => {});
    await page.waitForTimeout(500);

    if (action === 'screenshot_verify_data' || action === 'screenshot_date_search') {
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => b.innerText?.trim() === 'View' || b.innerText?.trim() === 'Search');
        if (btn) btn.click();
      });
      await page.waitForTimeout(2500);
      await dismissDialogs(page);
    }

    const shotPath = path.join(SCREENSHOT_DIR, `${label.replace(/[^\w]/g,'_')}_${Date.now()}.png`);
    const useFullPage = action === 'daily_dashboard_verify';
    await page.screenshot({ path: shotPath, fullPage: useFullPage });

    // 404 偵測
    const bodyText = await page.evaluate(() => document.body?.innerText || '');
    const is404 = bodyText.includes('OOPS!') || bodyText.includes('can not enter this page') || bodyText.includes('404 Not Found');
    if (is404) return { pass: false, shotPath, error: '404 頁面 (路徑錯誤)' };

    // 錯誤訊息偵測
    const hasError = await page.locator('.el-message--error').isVisible({ timeout: 500 }).catch(() => false);
    if (hasError) return { pass: false, shotPath, error: '頁面有錯誤訊息' };

    // 依頁面呼叫對應 verify function
    const mapKeyForVerify = Object.keys(SUBTYPE_MAP).find(k => SUBTYPE_MAP[k].path === pagePath);
    const { notes: deepNotes, criticalFails, manual, exportedXlsxPath, toastShotPath, extraShotPaths = [] } = await callPageVerify(mapKeyForVerify, page, taskDesc);

    // 收集所有截圖路徑（支援多張上傳）
    const allShotPaths = [];

    if (exportedXlsxPath && fs.existsSync(exportedXlsxPath)) {
      try {
        const pageName = Object.keys(SUBTYPE_MAP).find(k => SUBTYPE_MAP[k].path === pagePath) || path.basename(pagePath);
        const comparePath = await generateExportCompareShot(page, exportedXlsxPath, pageName, label);
        allShotPaths.push(comparePath);
      } catch (e) {
        console.log(` (compare shot err: ${e.message})`);
        allShotPaths.push(shotPath);
      }
    } else if (toastShotPath) {
      // Bonus Settings：dialog 截圖（主頁面）+ toast 截圖
      if (fs.existsSync(shotPath)) allShotPaths.push(shotPath);
      if (fs.existsSync(toastShotPath)) allShotPaths.push(toastShotPath);
    } else {
      if (fs.existsSync(shotPath)) allShotPaths.push(shotPath);
    }

    // 加入 verify function 捕捉的額外截圖（操作中/Panel開啟/Dialog等）
    for (const ep of extraShotPaths) {
      if (ep && fs.existsSync(ep)) allShotPaths.push(ep);
    }

    const finalShotPath = allShotPaths[0] || shotPath;

    if (manual) {
      return { pass: true, skip: false, manual: true, shotPath: finalShotPath, allShotPaths, notes: deepNotes };
    }
    if (criticalFails.length > 0) {
      return { pass: false, shotPath: finalShotPath, allShotPaths, notes: deepNotes, error: criticalFails.join(', ') };
    }
    return { pass: true, shotPath: finalShotPath, allShotPaths, notes: deepNotes };
  } catch (e) {
    if (/crash|closed|Target|Session/i.test(e.message)) throw e; // re-throw crash so outer loop can recover
    return { pass: false, shotPath: null, error: e.message };
  }
}

// ─── 版本確認 ────────────────────────────────────────────────────────
async function testVersionConfirm(page, taskName) {
  await page.goto(`${BACKEND_URL}/manage/versionHistoryRecord`, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(1500);
  await dismissDialogs(page);
  // 先點 Update 刷新最新版號
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText?.trim() === 'Update');
    if (btn) btn.click();
  });
  await page.waitForTimeout(3000);
  await dismissDialogs(page);
  // 再點 View 載入資料
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText?.trim() === 'View');
    if (btn) btn.click();
  });
  await page.waitForTimeout(2000);
  await dismissDialogs(page);
  const shotPath = path.join(SCREENSHOT_DIR, `version_${taskName.replace(/[^\w]/g,'_')}_${Date.now()}.png`);
  await page.screenshot({ path: shotPath });
  const rows = await page.locator('.el-table__body tr').count();
  return { pass: rows > 0, shotPath };
}

// ─── 從 Lark API 拉取所有 TC ─────────────────────────────────────────
async function fetchAllTCsFromLark(token) {
  let allRecords = [];
  let pageToken = null;
  do {
    const url = new URL(`${LARK_BASE}/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records`);
    url.searchParams.set('page_size', '100');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    const d = await res.json();
    if (d.code !== 0) throw new Error(`fetchAllTCs: ${d.msg}`);
    allRecords = allRecords.concat(d.data.items || []);
    pageToken = d.data.has_more ? d.data.page_token : null;
  } while (pageToken);
  console.log(`📥 從 Lark 取得 ${allRecords.length} 筆 TC`);
  // 儲存備份
  const dir = './data/raw';
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/lark_tc_all.json`, JSON.stringify(allRecords, null, 2));
  return allRecords;
}

// ─── Export 比對截圖輔助函式 ──────────────────────────────────────────
function extractXlsxData(xlsxPath) {
  if (!fs.existsSync(xlsxPath)) return { headers: [], rows: [] };
  const wb = XLSX.readFile(xlsxPath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  let headerIdx = -1;
  for (let i = 0; i < raw.length; i++) {
    const nonEmpty = raw[i].filter(c => c !== '');
    const isMeta = nonEmpty.length > 0 && (new Set(nonEmpty).size === 1 || String(nonEmpty[0]).match(/Casino|Print|Total|Period|Date Type/i));
    if (!isMeta && nonEmpty.length > 1) { headerIdx = i; break; }
  }
  if (headerIdx === -1) return { headers: [], rows: [] };
  const headers = raw[headerIdx].map(c => String(c).trim());
  const rows = raw.slice(headerIdx + 1).filter(r => r.some(c => c !== '') && !String(r[0]).match(/^total$/i));
  return { headers, rows };
}

function xlsxToHtml(xlsxPath, title) {
  const { headers, rows } = extractXlsxData(xlsxPath);
  if (!headers.length) return `<p style="color:#999">${title}：今日無資料</p>`;
  let html = `<h3 style="margin:4px 0;font-size:13px;color:#1a56db">${title} xlsx (${rows.length} 筆)</h3>`;
  html += `<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-size:11px;min-width:100%">`;
  html += `<tr style="background:#dbeafe">${headers.map(h => `<th style="white-space:nowrap">${h}</th>`).join('')}</tr>`;
  rows.slice(0, 30).forEach(row => {
    html += `<tr>${headers.map((_, i) => `<td style="white-space:nowrap">${row[i] ?? ''}</td>`).join('')}</tr>`;
  });
  if (rows.length > 30) html += `<tr><td colspan="${headers.length}" style="text-align:center;color:#666">... 共 ${rows.length} 筆（顯示前 30）</td></tr>`;
  html += `</table>`;
  return html;
}

function buildCompareHtmlBlock(xData, bHeaders, bCount, bTotal, pageName, today) {
  const xCount = xData.rows.length;
  const total = bTotal !== null ? bTotal : bCount;
  const countMatch = xCount === total;
  const matchedCols = xData.headers.filter(h => h && bHeaders.some(bh => bh.toLowerCase().includes(h.toLowerCase()) || h.toLowerCase().includes(bh.toLowerCase())));
  let row1Lines = '';
  if (xCount > 0 && bCount > 0) {
    row1Lines = xData.headers.slice(0, 6).map(xh => {
      const bh = bHeaders.find(b => b.toLowerCase().includes(xh.toLowerCase()) || xh.toLowerCase().includes(b.toLowerCase()));
      if (!bh) return '';
      const xv = String(xData.rows[0][xData.headers.indexOf(xh)] ?? '').trim();
      return `  ${xh}: "${xv}"`;
    }).filter(Boolean).join('\n');
  }
  const ok = countMatch && matchedCols.length > 0;
  const col = ok ? '#16a34a' : '#dc2626';
  return `<div style="padding:14px;font-family:sans-serif;font-size:12px;line-height:1.7;background:#f0fdf4;border-left:4px solid ${col};min-width:260px">
  <div style="font-size:15px;font-weight:bold;color:${col};margin-bottom:10px">${ok ? '✅ PASS' : '❌ FAIL'} — ${pageName}</div>
  <div><b>📅 比對日期：</b>${today}<br><b>📁 xlsx：</b>${pageName}.xlsx</div>
  <hr style="border:none;border-top:1px solid #d1fae5;margin:8px 0">
  <div><b>📊 筆數比對</b><br>xlsx：${xCount} 筆<br>後台：${bTotal !== null ? `${bTotal}（pagination 總計）` : bCount} 筆<br>結果：${countMatch ? '✅ 一致' : `❌ 不符（差 ${Math.abs(xCount - total)} 筆）`}</div>
  <hr style="border:none;border-top:1px solid #d1fae5;margin:8px 0">
  <div><b>🗂 欄位比對</b><br>xlsx（${xData.headers.length}）：${xData.headers.slice(0,4).join(', ')}...<br>後台（${bHeaders.length}）：${bHeaders.slice(0,4).join(', ')}...<br>對應：${matchedCols.length} 個 ${matchedCols.length > 0 ? '✅' : '❌'}<br>${matchedCols.slice(0,5).map(c => `<span style="background:#dcfce7;padding:1px 4px;border-radius:3px;margin:1px;display:inline-block">${c}</span>`).join('')}</div>
  ${row1Lines ? `<hr style="border:none;border-top:1px solid #d1fae5;margin:8px 0"><div><b>🔍 第1筆</b><pre style="margin:4px 0;font-size:11px;background:#fff;padding:6px;border-radius:4px;border:1px solid #d1fae5">${row1Lines}</pre></div>` : ''}
  <hr style="border:none;border-top:1px solid #d1fae5;margin:8px 0">
  <div style="font-size:13px;font-weight:bold;color:${col}">整體結果：${ok ? '✅ PASS' : '❌ FAIL'}</div>
</div>`;
}

async function generateExportCompareShot(page, xlsxPath, pageName, label) {
  const today = new Date().toISOString().slice(0, 10);
  const xData = extractXlsxData(xlsxPath);
  const bHeaders = await page.evaluate(() =>
    [...document.querySelectorAll('.el-table__header th .cell')].map(c => c.innerText?.trim()).filter(Boolean)
  ).catch(() => []);
  const bRowCount = await page.locator('.el-table__body tr').count().catch(() => 0);
  const bTotal = await page.evaluate(() => {
    // Element UI pagination
    const elText = document.querySelector('.el-pagination__total, .el-pagination .total')?.innerText || '';
    const elMatch = elText.match(/(\d[\d,]*)/);
    if (elMatch) return parseInt(elMatch[1].replace(/,/g, ''));
    // DataTables style: "Showing X to Y of Z entries"
    const dtText = document.body.innerText.match(/Showing\s+\d+\s+to\s+\d+\s+of\s+([\d,]+)\s+entries/i);
    if (dtText) return parseInt(dtText[1].replace(/,/g, ''));
    return null;
  }).catch(() => null);

  // 後台截圖
  const backendShotPath = path.join(SCREENSHOT_DIR, `${label}_backend_${Date.now()}.png`);
  const tableEl = await page.locator('.el-table').first().boundingBox().catch(() => null);
  if (tableEl) {
    const formEl = await page.locator('.el-form').first().boundingBox().catch(() => null);
    const clip = formEl ? { x: Math.min(formEl.x, tableEl.x) - 10, y: formEl.y - 10, width: Math.max(formEl.width, tableEl.width) + 20, height: (tableEl.y + tableEl.height) - formEl.y + 20 } : { x: tableEl.x - 10, y: tableEl.y - 10, width: tableEl.width + 20, height: tableEl.height + 20 };
    await page.screenshot({ path: backendShotPath, clip });
  } else {
    await page.screenshot({ path: backendShotPath });
  }

  // xlsx HTML 截圖
  const xlsxShotPath = path.join(SCREENSHOT_DIR, `${label}_xlsx_${Date.now()}.png`);
  await page.setContent(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:12px;font-family:sans-serif}</style></head><body>${xlsxToHtml(xlsxPath, pageName)}</body></html>`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  await page.screenshot({ path: xlsxShotPath, fullPage: true });

  // 並排比對截圖
  const backendB64 = fs.readFileSync(backendShotPath).toString('base64');
  const xlsxB64 = fs.readFileSync(xlsxShotPath).toString('base64');
  const compareHtml = buildCompareHtmlBlock(xData, bHeaders, bRowCount, bTotal, pageName, today);
  const comparePath = path.join(SCREENSHOT_DIR, `${label}_compare_${Date.now()}.png`);

  await page.setViewportSize({ width: 1800, height: 1200 });
  await page.setContent(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{margin:0;font-family:sans-serif;background:#f8f8f8}
    .title{background:#1a56db;color:#fff;padding:8px 16px;font-size:14px;font-weight:bold}
    .container{display:flex;gap:0;align-items:flex-start}
    .panel{flex:1;padding:12px;background:#fff;border-right:2px solid #e5e7eb}
    .panel h4{margin:0 0 8px;font-size:12px;color:#444;border-bottom:1px solid #ddd;padding-bottom:4px}
    .result-panel{width:300px;flex-shrink:0}
    img{max-width:100%;border:1px solid #ddd}
  </style></head><body>
    <div class="title">📊 ${pageName} — Export 比對 (${today})</div>
    <div class="container">
      <div class="panel"><h4>🖥 後台表格</h4><img src="data:image/png;base64,${backendB64}"></div>
      <div class="panel"><h4>📄 xlsx 匯出資料</h4><img src="data:image/png;base64,${xlsxB64}"></div>
      <div class="result-panel">${compareHtml}</div>
    </div>
  </body></html>`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  await page.screenshot({ path: comparePath, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });

  // 清理暫存
  fs.existsSync(backendShotPath) && fs.unlinkSync(backendShotPath);
  fs.existsSync(xlsxShotPath) && fs.unlinkSync(xlsxShotPath);
  return comparePath;
}

// ─── TC 任務分析：依描述內容判斷需要做什麼 ──────────────────────────
function analyzeTCTask(taskDesc) {
  const d = (taskDesc || '').toLowerCase();
  return {
    needAdd:        /add|新增|輸入|input|填入/.test(d),
    needSearch:     /search|查詢|view|搜尋/.test(d),
    needDelete:     /delete|刪除|remove/.test(d),
    needEdit:       /edit|修改|update|更新/.test(d),
    needExport:     /export|匯出|導出|csv|excel/.test(d),
    needSwitch:     /開啟.*關閉|關閉.*開啟|switch|toggle|enable|disable/.test(d),
    needErrorCheck: /提示|error|not exist|is wrong|reserved|not met|stress/.test(d),
    errorMsg:       (taskDesc || '').match(/提示[：:]\s*(.+?)($|\n)/)?.[1]?.trim() || null,
    isVersionCheck: /版本確認|version record|version.*confirm|確認.*版本號|client.*server.*version(?!.*game.type)|center.*server|middle.*server|bg.*client/.test(d),
    isReservation:  /reservation|預約/.test(d),
  };
}

// ─── 主程式 ─────────────────────────────────────────────────────────
async function main() {
  // 取新 token
  let larkToken = await getLarkToken();
  console.log('✅ Lark token 取得');

  // 從 Lark API 動態拉取所有 TC
  const allRecords = await fetchAllTCsFromLark(larkToken);

  // 篩後台 + UAT 服
  const REPORT_SUBTYPES = ['EGM Detail','User Detail','EGM Transfer','Game Record','EGM DayCount','Player Credit Log','Jackpot Record','EGM Hourly Meter','EGM Performance Meter'];
  const targets = allRecords.filter(r => {
    const envs = r.fields['環境'] || [];
    const devices = r.fields['裝置'] || [];
    const port = r.fields['端口'] || '';
    if (!envs.includes('UAT服') || !(devices.includes('後台') || port === '後台')) return false;
    const sub = r.fields['任務子類型'] || '';
    if (process.env.REPORT_ONLY) return REPORT_SUBTYPES.some(s => sub.includes(s));
    if (process.env.METER_ONLY) return ['EGM Hourly Meter','EGM Performance Meter'].some(s => sub.includes(s));
    if (process.env.SUBTYPE) return sub.includes(process.env.SUBTYPE);
    if (FILTER_SUBTYPES.length > 0) return FILTER_SUBTYPES.some(s => sub.includes(s));
    return true;
  });
  console.log(`📋 後台 UAT TC: ${targets.length} 筆`);

  // 匯出 Excel 儲存目錄
  const EXPORT_DIR = './data/raw/exports';
  if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });

  // 啟動瀏覽器
  const browser = await chromium.launch({ headless: false, slowMo: 50 });

  async function createLoginPage() {
    const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const p = await ctx2.newPage();
    await p.goto(`${BACKEND_URL}/login`, { waitUntil: 'networkidle', timeout: 30000 });
    await p.fill('input[type="text"], input[name*="user"], input[id*="user"]', 'admin');
    await p.fill('input[type="password"]', '123456');
    await p.click('button[type="submit"], button:has-text("Login")');
    await p.waitForTimeout(3000);
    return { page: p, ctx: ctx2 };
  }

  let { page, ctx } = await createLoginPage();
  console.log('✅ 後台登入完成\n');

  const results = [];
  let passCount = 0;
  let failCount = 0;
  let skipCount = 0;

  for (let i = 0; i < targets.length; i++) {
    const r = targets[i];
    const f = r.fields;
    const recordId = r.record_id;
    const taskType = f['任務類型'] || '';
    const subtype = f['任務子類型'] || '';
    const taskFull = f['任務'] || '';
    const task = taskFull.slice(0, 80);
    const label = `tc${i+1}_${taskType}_${subtype}`.replace(/[^\w]/g, '_');
    const analysis = analyzeTCTask(taskFull);

    process.stdout.write(`[${i+1}/${targets.length}] ${subtype || taskType} | ${task.slice(0,50)}...`);

    let result = { pass: false, shotPath: null };

    try {
      // 版本確認特殊處理
      if (taskType === '版本確認' || analysis.isVersionCheck) {
        result = await testVersionConfirm(page, taskFull || 'version');
      } else {
        // 優先完整匹配，再按鍵長度由長到短做 includes 匹配（避免 'Dashboard' 先匹配到 'Daily Dashboard'）
        const mapKey = Object.keys(SUBTYPE_MAP).find(k => k === subtype || k === taskType)
          || Object.keys(SUBTYPE_MAP)
              .sort((a, b) => b.length - a.length)
              .find(k => subtype.includes(k) || taskType.includes(k));
        const mapped = SUBTYPE_MAP[mapKey];
        if (mapped) {
          // 每筆 TC 獨立執行（不使用頁面快取）
          result = await performAction(page, mapped.path, mapped.action, label, taskFull);
        } else {
          result = { pass: false, shotPath: null, error: `未對應路徑: ${subtype}` };
        }
      }

      // 上傳所有截圖到 Lark（支援多張）
      const pathsToUpload = result.allShotPaths?.length > 0
        ? result.allShotPaths
        : (result.shotPath && fs.existsSync(result.shotPath) ? [result.shotPath] : []);
      console.log(`[Upload] ${label} → ${pathsToUpload.length} 張截圖待上傳: ${pathsToUpload.map(p => path.basename(p)).join(', ')}`);
      const fileTokens = [];
      for (const sp of pathsToUpload) {
        if (sp && fs.existsSync(sp)) {
          try {
            const ft = await uploadAttachment(larkToken, sp);
            fileTokens.push(ft);
            console.log(` ✅ 上傳成功: ${path.basename(sp)}`);
          } catch (e) {
            console.log(` ❌ 上傳失敗: ${path.basename(sp)} → ${e.message}`);
          }
        }
      }

      // 更新 Lark 記錄（多張圖以陣列形式傳入）
      // MANUAL TC：上傳截圖但不打勾（需人工確認，不算驗證通過）
      const markPass = result.pass && !result.manual;
      if (markPass || fileTokens.length > 0) {
        await updateRecord(larkToken, recordId, fileTokens, markPass);
      }

      if (result.pass && result.manual) skipCount++;
      else if (result.pass) passCount++;
      else if (result.skip) skipCount++;
      else failCount++;

      const noteStr = result.notes ? ` (${result.notes})` : '';
      const statusIcon = result.manual ? '🔧' : result.pass ? '✅' : result.skip ? '⏭' : '❌';
      console.log(` ${statusIcon}${noteStr}${result.error ? ' ' + result.error : ''}`);
      results.push({ recordId, subtype, task, pass: result.pass, manual: result.manual, skip: result.skip });

    } catch (e) {
      failCount++;
      console.log(` ❌ ${e.message}`);
      // 若 page 崩潰，重新建立
      if (/crash|closed|Target|Session/i.test(e.message)) {
        console.log('  🔄 偵測到 page crash，重新建立瀏覽器頁面...');
        try { await ctx.close(); } catch {}
        try {
          const r2 = await createLoginPage();
          page = r2.page;
          ctx = r2.ctx;
          console.log('  ✅ 重新登入完成');
        } catch (e2) {
          console.log(`  ❌ 重新登入失敗: ${e2.message}`);
        }
      }
    }

    // 每 20 筆刷新 token
    if ((i + 1) % 20 === 0) {
      larkToken = await getLarkToken();
      console.log('🔄 Lark token 刷新');
    }
  }

  // ─── Bonus 計時器驗證（TC2+TC3）────────────────────────────────────────
  if (_bonusTimerState) {
    const WAIT_MS = 5 * 60 * 1000; // 5 分鐘
    const elapsed = Date.now() - _bonusTimerState.startTime;
    const remaining = Math.max(0, WAIT_MS - elapsed);
    if (remaining > 0) {
      const remSec = Math.ceil(remaining / 1000);
      console.log(`\n⏳ 等待 Bonus 5分鐘更新計時...（剩餘 ${remSec} 秒）`);
      await new Promise(r => setTimeout(r, remaining));
    }
    console.log('⏰ 計時結束，回去驗證 Daily Ranking Bonus 更新...');
    try {
      await page.goto(_bonusTimerState.pageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(2000);
      await page.evaluate(() => {
        document.querySelectorAll('.el-dialog__wrapper').forEach(el => el.style.display = 'none');
        const overlay = document.querySelector('.v-modal');
        if (overlay) overlay.style.display = 'none';
      });
      await page.waitForTimeout(500);

      // 截圖 after
      const afterTableShotPath = path.join(SCREENSHOT_DIR, `bonus_table_after_${Date.now()}.png`);
      await page.screenshot({ path: afterTableShotPath, fullPage: false });

      // 讀取 after Bonus 欄位值
      const { bonusColIdx, beforeBonusVals = [] } = _bonusTimerState;
      const afterBonusVals = bonusColIdx >= 0
        ? await page.evaluate((colIdx) => {
            const rows = [...document.querySelectorAll('.el-table__body tr')];
            return rows.map(row => {
              const cell = row.querySelectorAll('td')[colIdx];
              return cell ? cell.innerText?.trim() : null;
            }).filter(v => v !== null);
          }, bonusColIdx).catch(() => [])
        : [];

      // 生成 before vs after 比對截圖
      const maxRows = Math.max(beforeBonusVals.length, afterBonusVals.length);
      const compareRows = Array.from({ length: maxRows }, (_, i) => {
        const bv = beforeBonusVals[i] ?? '—';
        const av = afterBonusVals[i] ?? '—';
        const changed = bv !== av;
        const bg = changed ? '#e6f4ea' : '#fff';
        const icon = changed ? '✅ 已更新' : '— 未變動';
        return `<tr style="background:${bg}">
          <td style="padding:6px 12px;border:1px solid #ddd;text-align:center">#${i + 1}</td>
          <td style="padding:6px 12px;border:1px solid #ddd;text-align:right">${bv}</td>
          <td style="padding:6px 12px;border:1px solid #ddd;text-align:right;font-weight:bold;color:#1a7a2e">${av}</td>
          <td style="padding:6px 12px;border:1px solid #ddd;text-align:center">${icon}</td>
        </tr>`;
      }).join('');
      const updatedCount = Array.from({ length: maxRows }, (_, i) => beforeBonusVals[i] !== afterBonusVals[i]).filter(Boolean).length;
      const overallResult = updatedCount > 0 ? `✅ PASS — ${updatedCount}/${maxRows} 筆 Bonus 已更新` : `⚠️ 待確認 — 所有 Bonus 欄位無變動（可能尚未到5分鐘週期）`;
      const compareHtml = `<div style="font-family:sans-serif;margin:0">
        <div style="background:#1a56db;color:#fff;padding:10px 16px;font-size:14px;font-weight:bold">
          Daily Ranking Bonus — 5分鐘更新驗證（${new Date().toLocaleString('zh-TW')}）
        </div>
        <div style="padding:10px 16px;font-size:13px;font-weight:bold;color:${updatedCount > 0 ? '#16a34a' : '#d97706'}">${overallResult}</div>
        <table style="border-collapse:collapse;width:100%">
          <thead><tr style="background:#f0f0f0">
            <th style="padding:8px 12px;border:1px solid #ddd">排名</th>
            <th style="padding:8px 12px;border:1px solid #ddd;text-align:right">修改前 Bonus</th>
            <th style="padding:8px 12px;border:1px solid #ddd;text-align:right">5分鐘後 Bonus</th>
            <th style="padding:8px 12px;border:1px solid #ddd">狀態</th>
          </tr></thead>
          <tbody>${compareRows}</tbody>
        </table>
      </div>`;

      const timerShotPath = path.join(SCREENSHOT_DIR, `bonus_timer_compare_${Date.now()}.png`);
      await page.setViewportSize({ width: 900, height: 600 });
      await page.setContent(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0">${compareHtml}</body></html>`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(300);
      await page.screenshot({ path: timerShotPath, fullPage: true });

      // 上傳截圖到 Lark（更新 TC3 記錄）
      const tc3Record = results.find(r => /5.*分鐘|每5分鐘/i.test(r.task));
      if (tc3Record) {
        const toUpload = [afterTableShotPath, timerShotPath].filter(p => fs.existsSync(p));
        const fts = [];
        for (const p of toUpload) {
          const ft = await uploadAttachment(larkToken, p).catch(() => null);
          if (ft) fts.push(ft);
        }
        if (fts.length > 0) {
          await updateRecord(larkToken, tc3Record.recordId, fts, false);
          console.log(`✅ TC3 5分鐘驗證截圖已上傳（${fts.length}張：after主畫面 + 比對表格）`);
        }
      }
      console.log(`✅ Bonus 5分鐘計時驗證完成 | ${overallResult}`);
    } catch (e) {
      console.log(`⚠️ Bonus 計時驗證例外: ${e.message}`);
    }
  }

  try { await ctx.close(); } catch {}
  await browser.close();

  const manualCount = results.filter(r => r.manual).length;
  console.log(`\n✅ 完成！通過: ${passCount}  🔧需人工: ${manualCount}  跳過: ${skipCount}  失敗: ${failCount}`);
  fs.writeFileSync('./data/raw/lark_tc_results.json', JSON.stringify(results, null, 2));
}

main().catch(console.error);
