/**
 * server/uat-runner/chrome-debug-port.js
 *
 * 取得「我剛剛開的那顆 Chrome」的 CDP port。
 *
 * ## 為什麼不能用亂數挑 port
 * 原本三個地方都是 `9300/9400 + Math.floor(Math.random() * 400)`。它有兩個問題，
 * 而且第二個比第一個嚴重得多：
 *
 * 1. **會撞號**。400 個 port，兩件並行約 0.25%、四件約 1.5%。
 * 2. **撞到之後不會失敗，會接到別人的瀏覽器。** 第二顆 Chrome 綁不上那個 port，
 *    但 `waitForJson(/json/version)` 照樣成功——因為**第一顆**正在那個 port 上聽。
 *    於是第二個 session 安靜地去操作第一個 session 的視窗：兩邊都跑完、
 *    結果交叉污染、沒有任何錯誤訊息。
 *
 * 換一組更大的亂數範圍只是把機率調小，**第二個問題完全沒解決**——
 * 真正要解的是「我連上的這顆，是不是我開的那顆」。
 *
 * ## 做法：讓 Chrome 自己挑，然後從它的 profile 目錄讀回來
 * `--remote-debugging-port=0` 讓 Chrome 挑一個真正空的 port，並把結果寫進
 * `<user-data-dir>/DevToolsActivePort`（第一行是 port，第二行是 browser ws 路徑）。
 *
 * 因為每個 session 的 `--user-data-dir` 本來就是獨立的，**從那個目錄讀到的 port
 * 必然屬於我們自己開的那顆**——撞號與歸屬兩個問題一起消失，不需要重試迴圈。
 *
 * 實測（2026-09-18，專案內建的 Chromium 145）：
 *   DevToolsActivePort = "63566\n/devtools/browser/cb08768f-..."
 */
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';

/** Chrome 冷啟動在忙碌的機器上可能要好幾秒；這個值只是上限，正常情況遠快於此 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 等 Chrome 把它選到的 port 寫出來。
 *
 * ⚠️ **一定要在 spawn 之前先清掉舊的 `DevToolsActivePort`。** 同一個 profile 目錄
 *    被重用時，上一輪的檔案還在——會讀到**上一顆瀏覽器**的 port，而那顆可能已經
 *    關掉（連不上）或更糟、還活著（於是又回到「操作別人的視窗」）。
 *
 * @param {string} profileDir 這次 spawn 用的 --user-data-dir
 * @param {{ timeoutMs?: number, isAlive?: () => boolean }} [options]
 *        isAlive 讓呼叫端傳「子程序還活著嗎」，Chrome 一啟動就死掉時不用空等滿 30 秒
 * @returns {Promise<number>}
 */
export async function waitForDebugPort(profileDir, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const isAlive = typeof options.isAlive === 'function' ? options.isAlive : () => true;
  const file = join(profileDir, 'DevToolsActivePort');
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (existsSync(file)) {
      // 檔案可能只寫了一半就被讀到，所以要確認第一行真的是數字
      const port = Number(String(readFileSync(file, 'utf8')).split('\n')[0]);
      if (Number.isInteger(port) && port > 0) return port;
    }
    if (!isAlive()) throw new Error('Chrome 啟動後隨即結束，拿不到偵錯連接埠');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`等不到 Chrome 的偵錯連接埠（${timeoutMs}ms）：${file}`);
}

/** spawn 之前呼叫。profile 目錄重用時，舊的檔案會讓我們讀到上一顆瀏覽器的 port。 */
export function clearStaleDebugPort(profileDir) {
  try { rmSync(join(profileDir, 'DevToolsActivePort'), { force: true }); } catch { /* 沒有就算了 */ }
}

/** 放進 Chrome 參數的那一項。集中在這裡，免得有人又寫回固定／亂數 port。 */
export const DEBUG_PORT_ARG = '--remote-debugging-port=0';
