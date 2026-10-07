/**
 * iDeck 按鈕的識別鍵（1007）：按鈕上的字去掉空白（例「PLAY 11 Credits」→「PLAY11Credits」），沒有字才用 SEND 的 action name。
 *
 * ⚠️ 這條規則只能有一份：runner（時間學習的「已確認不開局」清單比對）和 batch（confirmed 清單、learn 指標、WILD 排）都 import 這裡。
 *   CodeX ee40495 [P2]：confirmed 清單用的是按鈕字，runner 的 action name 是另一套（JJBXGRAND：BetMultiple1 ↔ BETx1），
 *   兩邊各寫一份時，runner 拿 action name 去查按鈕字的清單，短等待永遠不會生效（1008 收尾 D 時發現）。
 * @param {string | null | undefined} text
 * @param {string | null | undefined} name
 * @returns {string}
 */
export function ideckButtonKey(text, name) {
  return String(text ?? '').replace(/\s+/g, '') || String(name ?? '')
}
