/**
 * src/features/uat/pause-gate.ts
 *
 * H5/PC 錄製「暫停／繼續」那顆按鈕的**等待狀態機**。
 *
 * ## 為什麼要抽出來
 * 這段邏輯全是時序：送出、逾時、遲到的回應、輪詢帶回來的狀態，四件事會交錯。
 * 寫在元件裡的話只驗得到「原始碼長成那樣」——而這種 bug **每一個都是長得對、跑起來錯**：
 *
 *   - 計時器起在回應之後 → 連線失敗時它從來沒開始，按鈕永久卡住（v4.183.2 修）
 *   - **A 逾時之後送出 B，A 遲到的回應把 B 的等待一起清掉**（CodeX 2026-09-18 複驗指出）
 *
 * 抽成純函式之後，`scripts/ui-checks/uat-pause-gate.test.ts` 可以直接把這些時序造出來跑。
 * ⚠️ 元件與測試 **import 同一支**——各寫一份規則就是在驗自己。
 *
 * ## 不變量
 * 1. **一次只有一筆有效。** 每次 `begin()` 發一個 token，舊 token 立刻失效。
 * 2. **失效的 token 什麼都不能做**——不能解除等待、不能收別人的計時器、不能改畫面。
 * 3. **計時器在送出之前就起跑**，所以「請求永遠不回來」也一定會結束等待。
 * 4. 輪詢只有在**狀態等於這一筆要求的值**時才算確認；收到相反的值代表對方還沒處理完，
 *    留給逾時去收——不能把它當成已完成。
 */

export interface PauseGateOptions {
  /** 等待多久還沒確認就放棄（毫秒） */
  timeoutMs: number
  /** 等待狀態變化時通知畫面（按鈕禁用／顯示同步中） */
  setPending: (pending: boolean) => void
  /** 逾時了要說什麼。⚠️ 只能說「沒有得到確認」，不能說「已暫停」 */
  onTimeout: () => void
}

export interface PauseGate {
  /** 開始一筆新的請求，回傳這一筆的 token；舊的立刻失效 */
  begin: (want: boolean) => number
  /** 這個 token 還是當前那一筆嗎（遲到的回應要靠它擋掉） */
  isCurrent: (token: number) => boolean
  /** 這一筆結束了（成功或失敗）。stale 的話回 false 且**什麼都不做** */
  settle: (token: number) => boolean
  /** 輪詢回報的狀態。等於這一筆要求的值才算確認 */
  confirm: (paused: boolean) => boolean
  /** 錄製結束／切換 session：全部作廢 */
  cancel: () => void
  /** 目前這一筆在等哪個值（沒有在等就是 null）——測試與除錯用 */
  wanted: () => boolean | null
}

export function createPauseGate(options: PauseGateOptions): PauseGate {
  let seq = 0
  let want: boolean | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const stop = () => {
    if (timer) { clearTimeout(timer); timer = null }
    want = null
  }

  /** 讓所有在途的 token 失效。**序號只進不退**，所以舊的永遠追不回來 */
  const invalidate = () => { seq++; stop(); options.setPending(false) }

  return {
    begin(next) {
      const token = ++seq
      stop()
      want = next
      // ⚠️ **計時器要在呼叫端送出請求之前就起跑。** 起在回應之後的話，
      //    fetch 被拒絕／回的不是 JSON／請求根本沒回來時它從來沒開始，
      //    而 pending 已經是 true——按鈕再也回不來，而且沒有任何錯誤。
      timer = setTimeout(() => {
        // 這顆計時器屬於哪一筆要認清楚：舊的那筆逾時了，不能去動現在這一筆。
        if (token !== seq) return
        timer = null
        // ⚠️ **逾時本身也要讓這個 token 失效**（CodeX 2026-09-18 第三輪複驗指出）。
        //    只清 timer/want、不推進序號的話，「逾時之後**沒有**送出下一筆」那個情況
        //    `isCurrent(A)` 仍然是 true——A 遲到的成功回應會再把畫面改成已暫停，
        //    遲到的錯誤也會覆蓋提示。原本的測試先送了 B，剛好把這個缺口遮住。
        invalidate()
        options.onTimeout()
      }, options.timeoutMs)
      options.setPending(true)
      return token
    },

    isCurrent(token) { return token === seq },

    settle(token) {
      // ⚠️ 這裡是 CodeX 指出的那條：A 逾時之後使用者又送了 B，
      //    **A 遲到的回應不能把 B 的計時器與等待一起清掉**。
      if (token !== seq) return false
      invalidate()
      return true
    },

    confirm(paused) {
      // 收到相反的值代表對方還沒處理完，留給逾時去收——
      // 把它當成已完成的話，會把「agent 還沒動作」誤報成「已經切好了」。
      if (want === null || paused !== want) return false
      invalidate()
      return true
    },

    cancel() { invalidate() },

    wanted() { return want },
  }
}
