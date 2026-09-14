/**
 * 規格書分批送 Gemini 的純判斷（切塊 + 合併後重編號）。
 *
 * 為什麼要分批：先前規格書是 `slice(0, 12000)` **靜默**砍掉超出的部分——生成照樣顯示
 * 成功，但 AI 只看過前面一段，後半的需求一條測試案例都沒有，而且沒有任何地方查得到。
 *
 * 設計決定（2026-09-14 跟 CodeX 討論定案）：
 *   ① 按段落邊界切，不硬切字數
 *   ② 批次之間**不重疊**
 *   ③ 編號在合併後由程式統一重編，不靠 prompt
 *   ④ 某批失敗要保留其他批並明確標示，不靜默當成完整
 *
 * 對應測試：npx tsx scripts/ui-checks/spec-chunk.test.ts
 */

/**
 * 按段落邊界把規格書切成每塊不超過 `limit` 字的批次。
 *
 * ⚠️ 刻意不硬切字數：硬切會把一條需求從中間剖開，前半批看到「當玩家點擊」、後半批看到
 * 「…則顯示錯誤」，**兩邊都產不出完整的測試案例**，而且產出來的東西看起來還很正常。
 * 代價是每批大小不平均，這個可以接受。
 *
 * ⚠️ 單一段落本身就超過 limit 時才會硬切——那種情況下不切就永遠送不出去。
 */
export function splitSpecIntoChunks(text: string, limit: number): string[] {
  if (limit <= 0) throw new Error('limit 必須大於 0')
  const src = text ?? ''
  if (src.length <= limit) return src.trim() ? [src] : []

  const paragraphs = src.split(/\n{2,}/)
  const chunks: string[] = []
  let buf = ''

  const flush = () => { if (buf.trim()) chunks.push(buf.trim()); buf = '' }

  for (const para of paragraphs) {
    // 單一段落就超過上限 → 只能硬切它自己（其餘段落仍走段落邊界）
    if (para.length > limit) {
      flush()
      for (let i = 0; i < para.length; i += limit) chunks.push(para.slice(i, i + limit))
      continue
    }
    // +2 是重新接回去時的 '\n\n'
    if (buf && buf.length + 2 + para.length > limit) flush()
    buf = buf ? `${buf}\n\n${para}` : para
  }
  flush()
  return chunks
}

/**
 * 從一批測試案例裡推出編號的前綴，例如 `POS_ROOM_001` → `POS_ROOM_`。
 * 推不出來回 null（代表這個模板本來就不編號，那就不要動它）。
 */
export function detectNumberPrefix(cases: { 編號?: unknown }[]): string | null {
  for (const c of cases) {
    const raw = typeof c?.編號 === 'string' ? c.編號.trim() : ''
    if (!raw) continue
    const m = /^(.*?)(\d+)$/.exec(raw)
    // 只認「前綴 + 結尾數字」，而且前綴不能是空的（純數字編號不改，避免動到別的模板）
    if (m && m[1]) return m[1]
  }
  return null
}

/** 把 `POS_ROOM_001` 拆成 `{ prefix: 'POS_ROOM_', n: 1 }`；拆不開回 null。 */
function parseCaseNumber(raw: unknown): { prefix: string } | null {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!s) return null
  const m = /^(.*?)(\d+)$/.exec(s)
  return m && m[1] ? { prefix: m[1] } : null
}

/**
 * 合併多批結果後統一重編號。
 *
 * ⚠️ 為什麼不叫 prompt「你這批從第 N 號開始」：模型偶爾會照做、偶爾會飄，而編號重複
 * 在合併後看起來完全正常（每筆都有編號、格式也對），是最難用肉眼發現的那種壞法。
 * 程式重編是可驗證的。
 *
 * 🚨 **一定要「依前綴分組」重編，不能全部套同一個前綴。**
 * CG_TestCase 模板的編號規則是「類型縮寫_類別縮寫_序號」（POS_ROOM_001、NEG_LOBBY_003…），
 * **前綴帶有語意**。用單一前綴全域重編的話，負面測試的案例會被改寫成 `POS_ROOM_xxx`
 * ——資料被竄改了，但每一筆看起來都格式正確、完全看不出來。
 *
 * ⚠️ 編號拆不出「前綴＋結尾數字」的（沒有編號、或純數字編號）**原樣不動**——
 * 有些模板根本不產編號，硬塞一個進去等於捏造資料。
 */
export function renumberCases<T extends { 編號?: unknown }>(cases: T[]): T[] {
  const counters = new Map<string, number>()
  // 每個前綴各自的補零位數，用該前綴實際的筆數決定
  const totals = new Map<string, number>()
  for (const c of cases) {
    const p = parseCaseNumber(c?.編號)
    if (p) totals.set(p.prefix, (totals.get(p.prefix) ?? 0) + 1)
  }
  return cases.map(c => {
    const p = parseCaseNumber(c?.編號)
    if (!p) return c
    const n = (counters.get(p.prefix) ?? 0) + 1
    counters.set(p.prefix, n)
    const width = Math.max(3, String(totals.get(p.prefix) ?? 0).length)
    return { ...c, 編號: `${p.prefix}${String(n).padStart(width, '0')}` }
  })
}

export interface BatchOutcome {
  /** 總共切成幾批 */
  total: number
  /** 成功幾批 */
  succeeded: number
  /** 失敗的批次序號（1-based）與原因 */
  failures: { index: number; error: string }[]
}

/**
 * 給使用者看的一行摘要。
 * ⚠️ 全部成功時也要回字串（而不是空），呼叫端才不會把「沒有訊息」誤當成「沒有分批」。
 */
export function describeBatchOutcome(o: BatchOutcome): string {
  if (o.total <= 1) return ''
  if (o.failures.length === 0) return `規格書分 ${o.total} 批生成，全部成功。`
  const list = o.failures.map(f => `第 ${f.index} 批`).join('、')
  return `⚠️ 規格書分 ${o.total} 批生成，${o.succeeded}/${o.total} 批成功；`
    + `${list}失敗，這些段落的測試案例**沒有包含在結果裡**。`
}

export interface BatchRunResult<T> {
  /** 各批成功結果攤平後的集合（尚未重編號）*/
  collected: T[]
  /** 第一個非空的 feature_name（Jira 格式才有）*/
  featureName: string
  failures: { index: number; error: string }[]
}

/**
 * 跑完所有批次並收集結果。`callOnce` 注入進來，這支才驗得到「合併」與「部分失敗」
 * 這兩條真正有風險的路徑——留在 route 裡的話只能靠肉眼看。
 *
 * ⚠️ 單批失敗不讓整次失敗，但**全部失敗要丟錯**——回一個空陣列會讓呼叫端以為
 * 「這份規格書就是沒有測試案例」，那是完全錯誤的結論。
 */
export async function runBatched<T>(
  chunks: string[],
  callOnce: (chunk: string, label: string, index: number) => Promise<T[] | { feature_name?: string; test_cases?: T[] }>,
): Promise<BatchRunResult<T>> {
  const collected: T[] = []
  let featureName = ''
  const failures: { index: number; error: string }[] = []

  for (const [i, chunk] of chunks.entries()) {
    const label = `第 ${i + 1}/${chunks.length} 批`
    try {
      const part = await callOnce(chunk, label, i)
      if (Array.isArray(part)) collected.push(...part)
      else {
        if (!featureName && part?.feature_name) featureName = part.feature_name
        collected.push(...(part?.test_cases ?? []))
      }
    } catch (e) {
      failures.push({ index: i + 1, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { collected, featureName, failures }
}

/**
 * 編號前綴第一段 ↔ 測試類型 的對照。
 *
 * ⚠️ **只對得起第一段**。真實資料實測的第二段是「功能模組」的縮寫而不是「類別」
 * （ENT／BAL／DRW／PAY／CON／SYS／LOT…，一次就出現 12 種），模型自己發明、沒有固定集合，
 * 所以第二段**不做比對**——硬要比只會產生一堆假警告，久了就沒人看警告了。
 */
const TYPE_BY_PREFIX: Record<string, string> = {
  POS: '正面測試',
  NEG: '負面測試',
  BND: '邊界測試',
}

export interface PrefixIssue {
  kind: 'unknown_type' | 'type_mismatch' | 'rare_prefix'
  prefix: string
  detail: string
}

/**
 * 檢查編號前綴是否可信（CodeX review 提的防線：不要只相信模型給的 prefix）。
 *
 * 🚨 這條防的是**打錯字變成新分組**：模型把 `POS_ROOM_` 打成 `POS_ROMO_` 時，
 * 依前綴分組的重編號會把它當成一個全新的系列、乖乖從 001 編起——
 * **編號看起來完全正常，沒有任何地方會說那是同一組打錯字的**。
 *
 * ⚠️ 只回報、**不自動改**。把 `POS_ROMO_` 改成 `POS_ROOM_` 是猜測，猜錯就是竄改資料；
 * 而打錯字這件事本來就該讓人看到，不是默默補好。
 */
export function checkPrefixConsistency(
  cases: { 編號?: unknown; 測試類型?: unknown }[],
): PrefixIssue[] {
  const issues: PrefixIssue[] = []
  const counts = new Map<string, number>()
  for (const c of cases) {
    const p = parseCaseNumber(c?.編號)
    if (p) counts.set(p.prefix, (counts.get(p.prefix) ?? 0) + 1)
  }

  const seenBadType = new Set<string>()
  const seenMismatch = new Set<string>()
  for (const c of cases) {
    const p = parseCaseNumber(c?.編號)
    if (!p) continue
    const head = p.prefix.split(/[_-]/)[0]?.toUpperCase() ?? ''
    const expected = TYPE_BY_PREFIX[head]
    if (!expected) {
      if (!seenBadType.has(p.prefix)) {
        seenBadType.add(p.prefix)
        issues.push({ kind: 'unknown_type', prefix: p.prefix, detail: `前綴第一段「${head}」不是 POS／NEG／BND` })
      }
      continue
    }
    const actual = typeof c?.測試類型 === 'string' ? c.測試類型.trim() : ''
    if (actual && actual !== expected && !seenMismatch.has(p.prefix + actual)) {
      seenMismatch.add(p.prefix + actual)
      issues.push({
        kind: 'type_mismatch', prefix: p.prefix,
        detail: `前綴是 ${head}（應為「${expected}」）但測試類型欄位寫「${actual}」`,
      })
    }
  }

  // 只出現一兩次、而別的前綴有一大票 → 多半是打錯字打出來的新分組
  const total = [...counts.values()].reduce((a, b) => a + b, 0)
  if (counts.size > 1 && total >= 20) {
    for (const [prefix, n] of counts) {
      if (n <= 1 && total / counts.size >= 3) {
        issues.push({ kind: 'rare_prefix', prefix, detail: `只出現 ${n} 次（其餘前綴平均 ${(total / counts.size).toFixed(1)} 次），可能是打錯字` })
      }
    }
  }
  return issues
}
