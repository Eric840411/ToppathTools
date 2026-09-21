export type UatMainTab = 'backend' | 'h5' | 'pc'
export type UatThemeMode = 'classic' | 'xianxia'
export type AutoPlatform = 'h5' | 'pc'
export type AutoFilter = 'all' | 'mine' | 'public'
export type RunStatus = 'idle' | 'running' | 'done' | 'error'
export type StepFailureMode = 'inherit' | 'continue' | 'stop' | 'retry'
export interface UatConfig {
  larkUrl: string
  filter: string
  dashGameType: string
  dashClientVersion: string
  /**
   * 要測哪一個後台站台：`cp`（預設）或 `nc`（NC）。
   *
   * ⚠️ 兩個站台的登入帳密**分開存**，選了站台就要有那個站台的帳密；
   *    配錯會停在登入頁，而症狀是後面每一步都說「找不到元素」。
   */
  site?: 'cp' | 'nc'
}

export interface TcGroup { name: string; count: number }

export interface AutoStep {
  id: string
  name: string
  action: string
  value?: string
  selector?: string
  x?: number
  y?: number
  baselineId?: string
  threshold?: number
  scrollStep?: number
  maxScrolls?: number
  retryCount?: number
  failureMode?: StepFailureMode
  collapsed?: boolean
  children?: AutoStep[]
  /**
   * 這顆積木屬於哪一筆 TC（Lark 的 recordId）。空＝共用步驟。
   *
   * ⚠️ **檢查／截圖類的積木一定要指定**，沒指定不給跑——沒有歸屬的檢查結果
   * 不知道要回寫到哪一筆，而「跑了但沒人收」跟「沒跑」在畫面上看起來一樣。
   * （跟 Backend 同一條規則。）
   */
  tcId?: string
  /**
   * `backend_snippet`：要跑哪一份後台設定片段。
   *
   * ⚠️ 只存 id，不存步驟——片段被改過之後這顆積木要**跟著改**，
   *    存一份快照的話會出現「你以為改好了、腳本還在跑舊的」。
   */
  snippetId?: string
  /** assert_api_called：要打到的 API 網址樣式（`*` 當萬用字元） */
  urlPattern?: string
  /** assert_api_called：狀態碼要求 */
  expectStatus?: '2xx' | 'any' | 'exact'
  /** assert_api_called：expectStatus 為 exact 時要比對的狀態碼 */
  statusCode?: number
  /** assert_api_called／assert_ws_called：至少要被打到幾次 */
  minCount?: number
  /** `read_value`：要存成哪個變數名 */
  as?: string
  /** `read_value`：同名變數是否允許覆寫（預設不允許，避免後面引用到哪一次讀的看不出來） */
  overwrite?: boolean
  /** `assert_compare`：右邊的算式（左邊用 `value`） */
  expect?: string
  /** `assert_compare`：容差 */
  tolerancePct?: number
  /** `assert_compare`：絕對容差 */
  absoluteTolerance?: number
  /** `wait_for`：等什麼（visible／hidden／text／node） */
  until?: 'visible' | 'hidden' | 'text' | 'node'
  /** `wait_for`：最多等幾毫秒 */
  timeoutMs?: number
  /** `assert_text`：要讀的 Cocos 節點名或路徑（PC 用；H5 走 `selector`） */
  nodeName?: string
  /** `assert_text`：比對方式。預設 contains */
  matchMode?: 'contains' | 'equals' | 'regex' | 'number'
  /**
   * 放行這一顆的危險操作（預約／帶入額度／充值…）。
   *
   * ⚠️ **只對這一顆有效**，不是整輪的開關——一次放行整輪的話，
   *    之後新加的危險步驟會自動被放行，而沒有人會注意到。
   * ⚠️ 正式環境**連這個也擋**（見 `dangerous-actions.js` 的 `isProdLike`）。
   */
  allowDangerous?: boolean
  /**
   * `require_precondition`：前置條件不成立時要寫進報告的說明（必填）。
   *
   * ⚠️ 這段字會直接出現在 Lark 的結果欄——寫「環境沒開」是沒用的，
   *    要寫清楚**缺的是什麼、誰能備好**，否則下一個看報告的人只知道它沒測到。
   */
  reason?: string
  /** 這條 selector 是階梯的哪一階產的。`cssPath` 是最脆的一階，編輯器會標出來 */
  selectorStrategy?: string
  /** 錄製當下驗過的結果（ok／none／many／mismatch／invalid／unknown）。
   *  ⚠️ `unknown` 不是失敗——措辭表 `SELECTOR_CHECK_LABEL` 刻意不收它 */
  selectorCheck?: string
  /** selectorCheck 為 unknown 時的理由（unsupported／gone／shadow），純診斷用 */
  selectorCheckReason?: string
}

export interface AutoScript {
  id: string
  name: string
  platform: AutoPlatform
  steps: string
  created_by: string
  is_public: number
  created_at?: number
  updated_at?: number
  /** Lark TC 綁定。⚠️ 舊腳本沒有這些欄位，一律當成「沒綁」處理，不要當成壞掉 */
  lark_url?: string
  table_id?: string
  /** JSON 字串（後端存的形狀），前端讀的時候要 parse */
  bindings?: string
}

export interface AutoBaseline {
  id: string
  script_id: string
  name: string
  image_path: string
  crop_x?: number
  crop_y?: number
  crop_w?: number
  crop_h?: number
  threshold?: number
}

export interface AutoTemplate {
  id: string
  name: string
  image_path: string
  last_confidence: number | null
}

export interface OcrRegion {
  id: string
  name: string
  label: string
  crop_x: number
  crop_y: number
  crop_w: number
  crop_h: number
  accuracy: number | null
}

export interface AutoRun {
  id: string
  script_id: string
  result: string
  started_at?: number
  finished_at?: number
  passed?: number
  failed?: number
  skipped?: number
}

export interface AgentOption {
  agentId: string
  label?: string
  hostname?: string
}

export interface AutoCropResult {
  id: string
  name: string
  imagePath: string
  x: number
  y: number
  w: number
  h: number
  threshold: number
}

export type StepStatus = 'pending' | 'running' | 'pass' | 'fail' | 'skip'
