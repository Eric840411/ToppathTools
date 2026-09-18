/**
 * server/uat-runner/lark-writeback.js
 *
 * **回寫 Lark 那一列到底要寫什麼——只有這一份。**
 *
 * ## 為什麼抽出來
 * H5／PC 也要回寫之後，「PASS／FAIL 兩個勾選欄互斥、`附圖` 一律先清空、
 * manual 兩個都清」這套規則就會有第二個地方需要它。而這個 repo 的頭號慣性錯誤
 * 就是**同一條規則寫兩份然後漂掉**（CLAUDE.md 第 3 條）。
 *
 * 這裡特別危險的地方在於**漂掉的症狀是安靜的**：
 *   - 欄位名寫錯 → Lark 回 code≠0，但如果呼叫端沒檢查就變成「畫面全綠、表上什麼都沒有」
 *   - 互斥沒維護 → 同一列 PASS 和 FAIL 兩個框都是勾的（上次 FAIL、這次 PASS）
 *   - manual 沒清 → 留著上一輪的結果，看的人會以為這次有驗過
 *
 * ## 什麼留在這裡、什麼不留
 * **只有「寫什麼」在這裡**（純函式，好測）。「怎麼送出去」留在各自的 host——
 * 傳輸失敗是會大聲報錯的那種，不會安靜漂移。
 */

/** Lark 附件欄位一次最多帶幾個 file token。超過就截斷並在 notes 交代。 */
export const MAX_ATTACHMENTS = 20;

/**
 * 組出要 PUT 進 Lark 那一列的 `fields`。
 *
 * @param {'pass'|'fail'|'manual'} outcome 三態，**不是布林**：
 *   - `pass`   → 勾 PASS、清掉 FAIL
 *   - `fail`   → 勾 FAIL、清掉 PASS
 *   - `manual` → 兩個都清掉（機器判不了，既不是通過也不是失敗）
 * @param {string[]|string|null} fileTokens 這一列要掛的截圖
 * @param {{ includePassTimestamp?: boolean }} options
 *   `includePassTimestamp`：舊版單 TC 表才有「UAT測試通過時間」這一欄，
 *   多 TC 表沒有——寫進去會被 Lark 退回整筆失敗。
 * @returns {Record<string, unknown>}
 */
export function larkRecordFields(outcome, fileTokens, options = {}) {
  const tokens = (Array.isArray(fileTokens) ? fileTokens : fileTokens ? [fileTokens] : []).filter(Boolean);
  const fields = {};

  // ⚠️ **`附圖` 一律先清空，不是「有新圖才清」。**
  //    manual／blocked 的那幾筆不會上傳新圖，沿用「有新圖才清」的話它們列上會
  //    殘留更早以前的舊截圖，重跑幾次都清不掉——而畫面看起來完全正常。
  fields['附圖'] = [];

  if (outcome === 'pass') {
    fields['PASS'] = true;
    fields['FAIL'] = false;
    if (options.includePassTimestamp) fields['UAT測試通過時間'] = Date.now();
  } else if (outcome === 'fail') {
    fields['PASS'] = false;
    fields['FAIL'] = true;
  } else {
    // ⚠️ 只有 pass／fail／manual 三種。**不認得的值當成 manual**，不是當成通過——
    //    「不知道」要落在保守的那一邊。
    fields['PASS'] = false;
    fields['FAIL'] = false;
  }

  if (tokens.length) {
    fields['附圖'] = tokens.slice(0, MAX_ATTACHMENTS).map((ft, i) => ({
      file_token: ft,
      name: `screenshot_${i + 1}.png`,
    }));
  }
  return fields;
}

/**
 * 上傳一張截圖到 Lark，回 file_token。
 *
 * ⚠️ **拿不到 token 一定要 throw。** 回 null 的話那一列會被寫成「沒有附圖」
 * 而其他欄位照樣寫進去——結果是一筆看起來正常、實際少了證據的紀錄。
 *
 * @param {{ base: string, token: string, appToken: string }} auth
 * @param {string} fileName
 * @param {Buffer} bytes
 */
export async function uploadLarkAttachment(auth, fileName, bytes) {
  const form = new FormData();
  form.append('file_name', fileName);
  form.append('parent_type', 'bitable_file');
  form.append('parent_node', auth.appToken);
  form.append('size', String(bytes.length));
  form.append('file', new Blob([bytes], { type: 'image/png' }), fileName);
  const res = await fetch(`${auth.base}/open-apis/drive/v1/medias/upload_all`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth.token}` },
    body: form,
  });
  const data = await res.json();
  if (data.code !== 0 || !data.data?.file_token) throw new Error(`截圖上傳失敗：${data.msg || `HTTP ${res.status}`}`);
  return data.data.file_token;
}

/**
 * 把一列的結果 PUT 回 Lark。回傳 Lark 的原始回應，**由呼叫端檢查 `code`**
 * （`publishMultiTcResults` 會檢查，那是共用的那一份）。
 */
export async function updateLarkRecord(auth, tableId, recordId, fileTokens, outcome, options = {}) {
  const res = await fetch(`${auth.base}/open-apis/bitable/v1/apps/${auth.appToken}/tables/${tableId}/records/${recordId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: larkRecordFields(outcome, fileTokens, options) }),
  });
  return res.json();
}

/**
 * 從 Lark 多維表格的網址拆出 `appToken` 與 `tableId`。
 *
 * ⚠️ **拆不出來要明確失敗，不要猜。** 猜錯的結果是「回寫到另一張表」——
 * 那比寫不進去糟得多，因為兩邊都不會報錯。
 */
export function parseLarkBaseUrl(url) {
  const app = /\/(?:base|wiki)\/([A-Za-z0-9]+)/.exec(String(url ?? ''));
  const table = /[?&]table=([A-Za-z0-9]+)/.exec(String(url ?? ''));
  if (!app) throw new Error('Lark 表格網址看不出 app token（要像 .../base/XXXX?table=tblYYYY）');
  return { appToken: app[1], tableId: table?.[1] ?? '' };
}
