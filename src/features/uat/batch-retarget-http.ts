/**
 * 批次改綁用的 POST。**永遠不 throw**：斷線、逾時、回應讀到一半失敗都變成 `{ ok: false, network: true }`。
 *
 * ⚠️ 原本直接 await fetch，斷線時例外往外拋，`busy` 永遠停在「套用中」、關閉鍵停用，
 *    「結果待確認」那段也進不去（CodeX 1112 P2）。
 */
export async function safePost<T extends { ok: boolean; message?: string }>(
  url: string, body: unknown, fetchImpl: typeof fetch = fetch,
): Promise<T & { network?: boolean }> {
  try {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const text = await res.text()
    if (text.trimStart().startsWith('<')) {
      return { ok: false, message: `後端沒有這個路由（${res.status}）——server 可能還沒更新到有這個功能的版本` } as T
    }
    try { return JSON.parse(text) as T } catch { return { ok: false, message: `回應不是 JSON（${res.status}）：${text.slice(0, 80)}` } as T }
  } catch (e) {
    return { ok: false, network: true, message: `連線失敗：${e instanceof Error ? e.message : String(e)}` } as T & { network: true }
  }
}
