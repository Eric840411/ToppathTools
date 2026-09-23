/**
 * shared/uat-tc-retarget.ts
 *
 * **把一份錄好的腳本改綁到另一張 Lark TC 表——只有這一份規則。**
 *
 * ## 為什麼需要
 * 腳本存檔時把 `tableId` 一起存進去，候選 TC 清單又只顯示「這張表」的 TC。
 * 所以在新表建了 TC（實務上常常是**把舊表複製一份挪用**）之後，
 * 打開舊腳本會發現新 TC 一筆都不出現——錄了幾十步的腳本等於報廢。
 *
 * ## 為什麼放在 `shared/`
 * 這個流程 **Backend 與 H5／PC 兩邊都要**（`MultiTcRecorder` 與 `FrontendAutomationStudio`
 * 各存一份腳本），而伺服器端還要再驗一次。三個地方各寫一份規則，一定只會修好一個——
 * 這個專案今天才剛被同一件事咬過三次。
 *
 * ## 設計上的兩條硬規則（CodeX 2026-09-23）
 *
 * 1. **絕不自動套用。**編號相同不代表是同一個測項。這裡只產生「建議」，
 *    要不要接由人決定；配不上的一律留白，**不能保留舊的回寫目標**
 *    （舊 `recordId` 指向舊表，回寫會寫到別張表上，而且不會報錯）。
 * 2. **換綁定一定要同步搬步驟歸屬。**步驟是靠 `step.tcId === binding.recordId` 分配的
 *    （`server/uat-runner/multi-tc.js`）。只換 bindings 不換 `step.tcId`，
 *    輕則整份腳本驗證不過，重則步驟被清成「共用」——
 *    ⚠️ 現有的「解除綁定」就是把 `tcId` 設成 `null`，**換表絕對不能重用那條路**。
 */

/** 新表上的一筆 TC（從 Lark 掃出來的樣子） */
export interface RetargetTc {
  recordId: string
  number: string
  text?: string
  sub?: string
}

/** 腳本目前的一筆綁定 */
export interface RetargetBinding {
  recordId: string
  tableId: string
  number: string
  text: string
  sub: string
}

/** 為什麼沒有建議（或有） */
export type RetargetReason =
  | 'matched'            // 編號在兩邊都唯一且非空，找到對應
  | 'number-empty'       // 舊綁定沒有編號，無從配對
  | 'number-duplicate'   // 編號在舊表或新表出現多次，不敢猜
  | 'not-found'          // 新表沒有這個編號

export interface RetargetPlanRow {
  old: RetargetBinding
  /** 建議接到的新 TC。`null` = 沒有建議，必須人工指定 */
  suggestion: RetargetTc | null
  reason: RetargetReason
  /** 給畫面看的原因說明 */
  note: string
}

/**
 * 編號正規化。
 * ⚠️ 只做 trim ＋ 大小寫無視 ＋ 全形空白收斂。**不要做更聰明的正規化**
 * （例如去掉前綴、補零）——那等於在猜使用者的編號規則，猜錯會安靜地接到別的 TC 上。
 */
export function normalizeTcNumber(value: string | null | undefined): string {
  return String(value ?? '').replace(/[\s　]+/g, ' ').trim().toUpperCase()
}

function countByNumber(items: { number: string }[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const it of items) {
    const key = normalizeTcNumber(it.number)
    if (!key) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/**
 * 產生「舊綁定 → 新表 TC」的**建議**配對。
 *
 * 只有同時滿足下面全部才會給建議：
 *   ① 舊綁定的編號非空
 *   ② 該編號在**舊綁定裡**只出現一次
 *   ③ 該編號在**新表裡**只出現一次
 *
 * ⚠️ ②③ 都要查，而且要拿**完整的新表清單**來查。只查新表會漏掉
 * 「舊腳本裡兩筆綁定編號相同」這種——那時候接過去會是隨機的其中一筆。
 */
export function planTcRetarget(oldBindings: RetargetBinding[], newTcs: RetargetTc[]): RetargetPlanRow[] {
  const oldCounts = countByNumber(oldBindings)
  const newCounts = countByNumber(newTcs)
  const newByNumber = new Map<string, RetargetTc>()
  for (const tc of newTcs) {
    const key = normalizeTcNumber(tc.number)
    if (key && !newByNumber.has(key)) newByNumber.set(key, tc)
  }

  return oldBindings.map(old => {
    const key = normalizeTcNumber(old.number)
    if (!key) {
      return { old, suggestion: null, reason: 'number-empty' as const, note: '舊綁定沒有編號，無法自動配對' }
    }
    if ((oldCounts.get(key) ?? 0) > 1) {
      return { old, suggestion: null, reason: 'number-duplicate' as const, note: `編號「${old.number}」在這份腳本裡出現多次` }
    }
    if ((newCounts.get(key) ?? 0) > 1) {
      return { old, suggestion: null, reason: 'number-duplicate' as const, note: `編號「${old.number}」在新表裡出現多次` }
    }
    const hit = newByNumber.get(key)
    if (!hit) {
      return { old, suggestion: null, reason: 'not-found' as const, note: `新表找不到編號「${old.number}」` }
    }
    return { old, suggestion: hit, reason: 'matched' as const, note: '編號在兩邊都唯一' }
  })
}

export interface RetargetApplyInput<S extends { tcId?: string | null }> {
  /** 要改成的新表 */
  newTableId: string
  newLarkUrl: string
  oldBindings: RetargetBinding[]
  steps: S[]
  /** 舊 recordId → 新 recordId。沒有鍵或值為空字串 = 這筆不接 */
  decisions: Record<string, string>
  /** 新表的完整 TC 清單（決定的那筆必須在裡面） */
  newTcs: RetargetTc[]
}

export interface RetargetApplyResult<S> {
  newTableId: string
  newLarkUrl: string
  bindings: RetargetBinding[]
  steps: S[]
  /** 沒有接上的舊綁定——它們的步驟仍指著舊 recordId，執行前要被擋下來 */
  unresolved: RetargetBinding[]
  /** 決定裡指到新表沒有的 recordId（前端傳了髒資料）——一律視為未解決並回報 */
  invalidDecisions: string[]
}

/**
 * 套用配對決定。**表格、綁定、步驟歸屬一次更新**。
 *
 * ⚠️ 沒接上的那些，`step.tcId` **保留原值不動**（不是清成 `null`）。
 *    清掉的話步驟會變成「共用」，而畫面上只會顯示「待指定」——
 *    **看不出它原本屬於哪個 TC，等於把資訊弄丟了**。保留原值再靠
 *    `retargetBlockers()` 擋下執行，人才有機會處理。
 */
export function applyTcRetarget<S extends { tcId?: string | null }>(
  input: RetargetApplyInput<S>,
): RetargetApplyResult<S> {
  const newById = new Map(input.newTcs.map(tc => [tc.recordId, tc]))
  const bindings: RetargetBinding[] = []
  const unresolved: RetargetBinding[] = []
  const invalidDecisions: string[] = []
  /** 舊 recordId → 新 recordId，只收真的成立的 */
  const remap = new Map<string, string>()
  /** 防止兩筆舊綁定接到同一個新 TC——那會讓步驟歸屬合併，而且回寫會互相覆蓋 */
  const takenNew = new Set<string>()

  for (const old of input.oldBindings) {
    const wanted = (input.decisions[old.recordId] ?? '').trim()
    if (!wanted) { unresolved.push(old); continue }
    const tc = newById.get(wanted)
    if (!tc) { invalidDecisions.push(wanted); unresolved.push(old); continue }
    if (takenNew.has(wanted)) { invalidDecisions.push(wanted); unresolved.push(old); continue }
    takenNew.add(wanted)
    remap.set(old.recordId, wanted)
    bindings.push({
      recordId: tc.recordId,
      tableId: input.newTableId,
      number: tc.number,
      text: tc.text ?? '',
      sub: tc.sub ?? '',
    })
  }

  const steps = input.steps.map(step => {
    if (!step.tcId) return step
    const to = remap.get(step.tcId)
    return to ? { ...step, tcId: to } : step
  })

  return {
    newTableId: input.newTableId,
    newLarkUrl: input.newLarkUrl,
    bindings,
    steps,
    unresolved,
    invalidDecisions: [...new Set(invalidDecisions)],
  }
}

/**
 * 換表之後還不能跑的理由。空陣列 = 可以跑。
 *
 * ⚠️ 這支**不是**取代 `multi-tc.js` 的驗證，是在它之前先給一個看得懂的訊息。
 *    那邊只會說「第 N 步：找不到綁定的 TC」，看不出是換表沒接完造成的。
 */
export function retargetBlockers(args: {
  bindings: RetargetBinding[]
  steps: { tcId?: string | null }[]
  tableId: string
}): string[] {
  const out: string[] = []
  const ids = new Set(args.bindings.map(b => b.recordId))
  const orphan = args.steps.filter(s => s.tcId && !ids.has(s.tcId))
  if (orphan.length) {
    out.push(`有 ${orphan.length} 個步驟還指著換表前的 TC——請在「改綁 TC 表格」裡把它們接到新表的 TC，或解除歸屬`)
  }
  const wrongTable = args.bindings.filter(b => b.tableId !== args.tableId)
  if (wrongTable.length) {
    out.push(`有 ${wrongTable.length} 筆綁定不屬於目前的表格（${args.tableId}）`)
  }
  return out
}

/**
 * 備份的內容。
 * ⚠️ **步驟歸屬要一起存**（`stepOwners`）——只存 bindings 是還原不回來的：
 *    `step.tcId` 被換過之後，光有舊 bindings 也接不回哪一步屬於哪個 TC。
 *    存索引而不是整份步驟：步驟本身沒被這個流程改到，存整份只會讓備份變很大。
 */
export interface RetargetSnapshot {
  larkUrl: string
  tableId: string
  bindings: RetargetBinding[]
  /** [步驟索引, 當時的 tcId] */
  stepOwners: Array<[number, string | null]>
}

export function snapshotOf(args: {
  larkUrl: string; tableId: string
  bindings: RetargetBinding[]
  steps: Array<{ tcId?: string | null }>
}): RetargetSnapshot {
  return {
    larkUrl: args.larkUrl,
    tableId: args.tableId,
    bindings: args.bindings,
    stepOwners: args.steps.map((s, i) => [i, s.tcId ?? null] as [number, string | null]),
  }
}

/** 還原：把備份裡的 bindings 與步驟歸屬套回去 */
export function restoreFromSnapshot<S extends { tcId?: string | null }>(
  snapshot: RetargetSnapshot, steps: S[],
): { larkUrl: string; tableId: string; bindings: RetargetBinding[]; steps: S[] } {
  const owners = new Map(snapshot.stepOwners)
  return {
    larkUrl: snapshot.larkUrl,
    tableId: snapshot.tableId,
    bindings: snapshot.bindings,
    // ⚠️ 步驟數量可能已經變了（換表之後又編輯過）。只還原**索引仍存在**的那些，
    //    超出範圍的不動——硬套會把後來加的步驟歸屬弄壞。
    steps: steps.map((s, i) => (owners.has(i) ? { ...s, tcId: owners.get(i) ?? null } : s)),
  }
}
