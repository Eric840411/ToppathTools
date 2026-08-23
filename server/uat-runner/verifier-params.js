/**
 * server/uat-runner/verifier-params.js
 *
 * 內建驗證器的參數宣告。
 *
 * ## 為什麼獨立成檔案
 * 前端要照這份宣告長參數表單，所以 server（TS）要載得到；但
 * run-lark-tc-backend.js 一 import 就會開始跑整套測試，不能從 server 那邊 import。
 * 跟 block-engine.js 同一個理由，放這個目錄也是同一個理由——
 * scripts/build-server.cjs 只整包複製 uat-runner/，這裡是唯一三邊都載得到的位置。
 *
 * ## 為什麼不是另做一套 DSL
 * 參數化機制其實早就存在——config/backend-test-params.json（TEST_PARAMS）本來就是
 * 照 verifier 分群組的參數表，只是檔案式、全域、不能逐筆調。這裡只是把它「宣告
 * 出來」，讓編輯器長表單、讓單筆 TC 能覆寫，沒有新增概念。
 *
 * ## paramsGroup 要明講
 * 每支只能讀自己宣告的那一組，不能隨便撈 TEST_PARAMS 底下任意群組——不然耦合會
 * 變成隱性的，之後改參數檔不知道會影響到誰。
 *
 * ## envDependent
 * 標成 true 代表「換一套環境就要重填」（真實帳號、真實機台號）。這種值最危險的
 * 不是缺，是**沿用舊環境的值還測得過**——測起來綠色，驗的卻是一個不存在的東西。
 * 編輯器會另外標示。
 */

/** @type {Record<string, { paramsGroup: string, label: string, params: Array<object> }>} */
export const VERIFIER_PARAM_SCHEMAS = {
  verifyMachineReservation: {
    paramsGroup: 'machineReservation',
    label: '自動預約',
    params: [
      {
        key: 'realMachineNo', label: '真實機台號', type: 'text',
        required: true, envDependent: true, default: '873-DFDCGRAND-0023',
        help: '測「Account 不存在」時的對照組——機台要真的存在，錯誤訊息才會是帳號的問題。換環境要重填。',
      },
      {
        key: 'fakeMachineNo', label: '不存在的機台號', type: 'text',
        default: 'FAKE-MACHINE-NOTEXIST-999',
        help: '故意填一個查不到的值，預期後台回「machine no is not exist」',
      },
      { key: 'fakeAccount', label: '不存在的帳號', type: 'text', default: 'FAKE-ACCOUNT-NOTEXIST-999' },
      {
        key: 'expectMachineError', label: '預期的機台錯誤訊息', type: 'text',
        default: 'machine no is not exist',
        help: '不分大小寫的關鍵字比對。後台文案改了改這裡就好，不用動程式碼',
      },
      { key: 'expectAccountError', label: '預期的帳號錯誤訊息', type: 'text', default: 'account is not exist' },
    ],
  },
};

/**
 * 解析一支驗證器這次要用的參數。
 *
 * 取值優先序：單筆 TC 的 options → backend-test-params.json 的同名群組 → schema default
 * 沒宣告 schema 的就是零參數模組，options 原封不動傳過去。
 *
 * @param {string} name 驗證器名稱
 * @param {Record<string, unknown> | undefined} options 這顆積木上填的覆寫值
 * @param {Record<string, unknown> | undefined} fileParams TEST_PARAMS 整包
 * @returns {{ params: Record<string, unknown>, missing: string[] }}
 */
export function resolveVerifierParams(name, options, fileParams) {
  const schema = VERIFIER_PARAM_SCHEMAS[name];
  if (!schema) return { params: options ?? {}, missing: [] };
  const fromFile = (fileParams && fileParams[schema.paramsGroup]) || {};
  const params = {};
  const missing = [];
  for (const def of schema.params) {
    const v = options?.[def.key] ?? fromFile[def.key] ?? def.default;
    // 空字串當成沒填——參數檔裡把值清空的意思是「還沒設定」，不是「值就是空字串」
    if (def.required && (v === undefined || v === null || v === '')) { missing.push(def.label || def.key); continue }
    if (v !== undefined) params[def.key] = v;
  }
  return { params, missing };
}
