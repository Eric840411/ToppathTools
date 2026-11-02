/**
 * 註銷 /office 底下的 Service Worker 並清掉 Office 的快取。
 * Effect 的 build 會註冊 cache-first SW，登出後瀏覽器重開仍由快取開頁面、繞過登入（CodeX 審 5f7c6d0 [P1]）。
 * 文書工具頁進來、以及登出時都呼叫；後端把 sw.js 換成退役版是第二道。
 * 獨立成小檔：App.tsx 登出要用，直接 import OfficePage 會把整個 lazy 頁面拉進主 bundle。
 * http 的區網 IP 不是安全來源，沒有 serviceWorker／caches，直接略過。
 */
export async function retireOfficeServiceWorkers(): Promise<void> {
  try {
    const regs = await navigator.serviceWorker?.getRegistrations() ?? []
    await Promise.all(regs.filter(r => new URL(r.scope).pathname.startsWith('/office/')).map(r => r.unregister()))
    if (typeof caches !== 'undefined') {
      for (const k of await caches.keys()) {
        if (/^(effectcraft|filmcraft|lightcraft|craft)-/.test(k)) await caches.delete(k)
      }
    }
  } catch { /* 清不掉不影響 Toppath 本身 */ }
}
