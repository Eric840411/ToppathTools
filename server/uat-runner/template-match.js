/**
 * server/uat-runner/template-match.js
 *
 * 在一張截圖裡找一塊基準圖（「尋找基準圖」那顆積木用的）。
 *
 * ## 為什麼獨立成一支
 * 這段原本只活在 `routes/frontend-auto.ts` 裡，所以**只有伺服器端能跑基準圖比對**——
 * agent 端遇到那顆積木就掉進「不認得的動作 → 跳過」，**腳本照樣 PASS，而比對根本沒跑**。
 * 抽出來之後兩邊用同一份（而且 agent 的檔案白名單要帶上它）。
 *
 * ⚠️ 演算法一個字都沒改——這次是搬家不是改寫。合併前後的端到端測試跑同一支、結果要一樣。
 */
import { PNG } from 'pngjs';

export function decodePng(buffer) {
  return PNG.sync.read(buffer);
}

/**
 * 粗取樣的滑動視窗比對。
 *
 * `stride` 是取樣間隔、`step` 是視窗移動距離——兩個都按基準圖大小縮放，
 * 所以大圖不會慢到不能用，小圖也不會因為取樣太疏而誤判。
 *
 * @returns {{x:number,y:number,diff:number}|null} 找不到回 null（**不是回最接近的那個**——
 *          回最接近的等於「一定找得到」，那顆積木就永遠不會失敗了）
 */
export function findTemplateInPng(screen, template, threshold) {
  if (template.width > screen.width || template.height > screen.height) return null;
  const stride = Math.max(1, Math.floor(Math.min(template.width, template.height) / 24));
  const step = Math.max(1, Math.floor(Math.min(template.width, template.height) / 12));
  let best = { x: 0, y: 0, diff: Number.POSITIVE_INFINITY };

  for (let y = 0; y <= screen.height - template.height; y += step) {
    for (let x = 0; x <= screen.width - template.width; x += step) {
      let diff = 0;
      let samples = 0;
      for (let ty = 0; ty < template.height; ty += stride) {
        for (let tx = 0; tx < template.width; tx += stride) {
          const si = ((y + ty) * screen.width + (x + tx)) * 4;
          const ti = (ty * template.width + tx) * 4;
          diff += Math.abs(screen.data[si] - template.data[ti]);
          diff += Math.abs(screen.data[si + 1] - template.data[ti + 1]);
          diff += Math.abs(screen.data[si + 2] - template.data[ti + 2]);
          samples += 3;
        }
      }
      const normalized = diff / (samples * 255);
      if (normalized < best.diff) best = { x, y, diff: normalized };
      if (normalized <= threshold) return { x, y, diff: normalized };
    }
  }
  return best.diff <= threshold ? best : null;
}
