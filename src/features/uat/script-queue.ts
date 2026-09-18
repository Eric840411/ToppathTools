/**
 * src/features/uat/script-queue.ts
 *
 * **「一份一份排隊跑」這條規則只有這一份。**
 *
 * Backend（`/api/osm-uat/*`）與 H5／PC（`/api/frontend-auto/*`）是兩組端點，但
 * 佇列要守的東西一模一樣：
 *
 *   ① **一次只跑一份**，前一份真的結束才派下一份
 *   ② **拿到的結果必須屬於自己派的那一次**——session／run id 對不上就整個停下來，
 *      不能拿別人的結果當成自己的（畫面會顯示一份**看起來合理**的假結果）
 *   ③ **中途失敗或取消 → 後面全部標成取消**，不是留在「等待中」
 *      （留著的話，使用者以為還會跑，其實不會）
 *   ④ 取消要**真的送出停止**，不是只改畫面上的狀態
 *
 * 各寫一份的話，②③ 這種「安靜地給出錯誤答案」的規則一定會有一邊漏掉。
 */

/** 佇列裡的一項。`results` 的型別由呼叫端決定（兩邊的結果形狀不同）。 */
export interface QueueItem<R = unknown> {
  id: string
  title: string
  state: 'waiting' | 'running' | 'done' | 'error' | 'cancelled'
  results: R[]
  sessionId?: string
  error?: string
  durationMs?: number
}

export interface QueueDriver<R> {
  /** 派工。回傳這一次的識別碼——之後所有比對都認它 */
  start: (item: QueueItem<R>) => Promise<{ sessionId: string }>
  /** 現在跑的是哪一次、結束了沒 */
  status: (sessionId: string) => Promise<{ sessionId?: string; running: boolean }>
  /** 使用者按了取消時，送出停止 */
  stop: (sessionId: string) => Promise<void>
  /** 取這一次的結果。拿不到回 undefined（呼叫端會重試幾次再放棄）*/
  results: (item: QueueItem<R>, sessionId: string) => Promise<{ results: R[]; stopped?: boolean } | undefined>
}

export interface QueueOptions<R> {
  cancelled: () => boolean
  update: (index: number, patch: Partial<QueueItem<R>>) => void
  started: () => void
  pause?: () => Promise<void>
}

/**
 * 依序跑完整個佇列。
 *
 * ⚠️ **這個函式不處理「同時有別人在跑」**——那要由端點自己擋（H5 是 409
 * `already running`）。在這裡用輪詢去猜會有競態：查到閒置、派工、對方也派了。
 */
/**
 * 取消之後最多再等幾輪。乘上 `pause`（預設 1.5 秒）大約是 30 秒——
 * 夠一次正常的收尾，又不會讓畫面永遠卡著。
 */
const CANCEL_WAIT_POLLS = 20

export async function runScriptQueue<R>(
  items: QueueItem<R>[],
  driver: QueueDriver<R>,
  options: QueueOptions<R>,
) {
  const pause = options.pause ?? (() => new Promise<void>(resolve => setTimeout(resolve, 1500)))
  const cancelRest = (from: number) => {
    for (let next = from; next < items.length; next++) options.update(next, { state: 'cancelled' })
  }

  for (let index = 0; index < items.length; index++) {
    if (options.cancelled()) { options.update(index, { state: 'cancelled' }); continue }
    const item = items[index]
    const startedAt = Date.now()
    try {
      const { sessionId } = await driver.start(item)
      if (!sessionId) throw new Error('沒有取得執行編號，已停止後續派工；請看即時日誌。')
      options.update(index, { state: 'running', sessionId })
      options.started()

      // 派工的瞬間剛好被按取消：要真的送出停止，不是只把畫面改掉
      if (options.cancelled()) {
        const now = await driver.status(sessionId)
        if (now.sessionId === sessionId && now.running) await driver.stop(sessionId)
      }

      // 🚨 **取消之後的等待要有上限。**
      //    原本是「還在跑就繼續等」——無限的。停止請求沒生效（agent 斷線、程序卡住）
      //    的話，佇列會**永遠停在這裡**：畫面顯示「執行中」、按什麼都沒反應，
      //    而且沒有任何錯誤訊息。等不到就認了，標成取消並說明。
      let pollsAfterCancel = 0
      while (true) {
        await pause()
        if (options.cancelled() && ++pollsAfterCancel > CANCEL_WAIT_POLLS) {
          options.update(index, {
            state: 'cancelled',
            error: '已送出停止，但這一次遲遲沒有結束——佇列不再等下去。請到執行紀錄確認它的狀態。',
            durationMs: Date.now() - startedAt,
          })
          cancelRest(index + 1)
          return
        }
        const now = await driver.status(sessionId)
        // ⚠️ 這一條是整支最重要的：**跑的已經不是我派的那一次**就停下來。
        //    繼續下去會把別人那一次的結果填進這一列——而畫面上完全看不出來。
        // ⚠️ 用**嚴格不等於**，不是「有值才比」。放寬成後者的話，狀態端點回空值
        //    （重啟、查不到、回應格式變了）會被當成「還是我那一次」而繼續往下——
        //    那正是要擋的情況。driver 必須保證回得出 sessionId。
        if (now.sessionId !== sessionId) {
          throw new Error('執行編號變了，為避免拿到別次的結果，佇列已停止。')
        }
        if (now.running) continue

        let found: { results: R[]; stopped?: boolean } | undefined
        for (let attempt = 0; attempt < 3 && !found; attempt++) {
          found = await driver.results(item, sessionId)
          if (!found && attempt < 2) await pause()
        }
        if (options.cancelled() || found?.stopped) {
          options.update(index, { state: 'cancelled', results: found?.results ?? [], durationMs: Date.now() - startedAt })
          cancelRest(index + 1)
          return
        }
        // ⚠️ 拿不到結果**不能當成通過**。這一次到底跑了什麼沒人知道，
        //    後面照跑的話只會累積更多不知道。
        if (!found) throw new Error('這一次結束了但取不到結果，已停止後續腳本。請看即時日誌。')
        options.update(index, { state: 'done', results: found.results, durationMs: Date.now() - startedAt })
        break
      }
    } catch (error) {
      options.update(index, {
        state: 'error',
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      })
      cancelRest(index + 1)
      return
    }
  }
}
