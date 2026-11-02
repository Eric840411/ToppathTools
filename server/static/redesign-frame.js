/*
 * 新版外框（ui-redesign）用的 iframe 開機腳本：圖片比對、Bonus V2 共用一份。
 * 必須在 <head> 同步載入（不要 defer），否則會先閃一次舊版長相。
 *
 * - 首次：讀網址參數 ?ui=redesign&theme=classic|xianxia，寫到 <html data-ui / data-theme-mode>
 * - 之後：外框切模式用 postMessage 通知，這裡只改屬性，不重載（重載會清掉擷取結果與 SSE 連線）
 * - 只接受同源、而且是父視窗送來的訊息；值只收白名單。參數只控制外觀
 * - 沒帶參數（舊版外框、直接開網址）→ 什麼都不設，長相跟原本一樣
 * （CodeX 1102 定案 B）
 */
(function () {
  var root = document.documentElement
  var UI = { redesign: 1 }
  var THEME = { classic: 1, xianxia: 1 }
  function apply(ui, theme) {
    if (UI[ui] === 1) root.setAttribute('data-ui', ui)
    if (THEME[theme] === 1) root.setAttribute('data-theme-mode', theme)
  }
  try {
    var q = new URLSearchParams(location.search)
    apply(q.get('ui'), q.get('theme'))
  } catch (e) { /* 舊瀏覽器：維持原樣 */ }
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || e.source !== window.parent) return
    var d = e.data
    if (!d || d.type !== 'toppath-frame-theme') return
    apply(d.ui, d.theme)
  })
  // 載入期間外框可能已經切過模式：告訴外框「我好了」，它會補送最新設定
  if (window.parent !== window) {
    try { window.parent.postMessage({ type: 'toppath-frame-ready' }, location.origin) } catch (e) { /* ignore */ }
  }
})()
