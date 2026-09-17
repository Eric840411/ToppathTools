/**
 * 錄製面板那顆「停止錄製」的四道靜默失敗防線。
 *
 * 這顆按鈕的所有壞法都是**安靜的**：按了沒反應、或是步驟少一筆，
 * 兩種都不會有錯誤訊息。所以每一條都要用「注入壞版本會不會轉紅」來驗，
 * 不能只看程式碼長得對不對。
 *
 * 四條：
 *   ① 兩個 console 前綴不得互為前綴
 *      host 端是 text.startsWith(marker) 判斷的。若停止前綴長成
 *      RECORDER_MARKER + '_STOP'，startsWith(RECORDER_MARKER) 會先命中，
 *      停止訊號被當成一顆內容解析不了的積木——按了沒反應，而且 JSON.parse
 *      失敗被 catch 吃掉，兩邊都不報錯。
 *
 *   ② 停止按鈕不得走 emit()
 *      emit() 第一行是 if (paused || !armed) return。走它的話「暫停中想停止」
 *      會完全沒反應——而那正是最常見的情境。
 *
 *   ③ 送出停止訊號之前一定要先 flush
 *      flushInput 是把「還停在輸入框、沒離開焦點」的內容轉成 type_text 積木的。
 *      少了它，打完字立刻按停止 → 那一步直接消失，沒有任何徵兆。
 *
 *   ④ 兩個 host 都要認得停止前綴
 *      錄製有 agent 模式（agent-runner.ts）與伺服器模式（uat-server-recorder.ts）
 *      兩條路，各自監聽自己的 console。只加一邊 → 另一種模式按了沒反應。
 *      而且兩邊都不得在 stopMarker 缺席時退回用 marker 比對（那會讓每顆正常積木
 *      都變成停止訊號，錄一步就關掉瀏覽器）。
 *
 * 跑法：node scripts/ui-checks/recorder-stop-button.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { stripComments as sharedStrip } from './lib/strip-comments.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const recorder = read('server/uat-runner/backend-recorder.js');
const agentRunner = read('server/agent-runner.ts');
const serverRecorder = read('server/uat-server-recorder.ts');
const osmUat = read('server/routes/osm-uat.ts');

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); };

// ── ① 兩個前綴不得互為前綴 ────────────────────────────────────────────────
const markerOf = (name) => {
  const m = recorder.match(new RegExp(`export const ${name} = '([^']+)'`));
  return m ? m[1] : null;
};
const MARKER = markerOf('RECORDER_MARKER');
const STOP = markerOf('RECORDER_STOP_MARKER');
check('① 兩個前綴都讀得到', !!MARKER && !!STOP, `marker=${MARKER} stop=${STOP}`);
check('① 前綴互不為前綴',
  !!MARKER && !!STOP && MARKER !== STOP && !STOP.startsWith(MARKER) && !MARKER.startsWith(STOP),
  `${STOP}.startsWith(${MARKER}) = ${STOP && MARKER ? STOP.startsWith(MARKER) : 'n/a'}`);

// ── ②③ 停止按鈕本體 ──────────────────────────────────────────────────────
// 只看那顆按鈕的 handler，不要掃到整份檔案的其他 emit/flush。
const handlerStart = recorder.indexOf("stopButton.addEventListener('click'");
const handlerEnd = recorder.indexOf('BUTTON_ROW.appendChild(stopButton)');
const handler = handlerStart >= 0 && handlerEnd > handlerStart
  ? recorder.slice(handlerStart, handlerEnd) : '';
check('②③ 找得到停止按鈕的 handler', handler.length > 0, `區段長度 ${handler.length}`);

// 剝掉註解再判，否則註解裡寫著「刻意不走 emit()」會讓 ② 永遠綠。
// ⚠️ **不要自己用正則剝。** 純正則版本會把 XPath 字串 "//*[...]" 裡的 /*
//    當成區塊註解開頭，一路吃到下一個 */——實測在 agent-runner.ts 上一次
//    刪掉全檔 31% 的真實程式碼，而被刪掉的部分會讓「不得出現某模式」那類
//    斷言**假通過**（CodeX review 點名這裡還沒接上）。
const stripComments = sharedStrip;
const handlerCode = stripComments(handler);

check('② 停止不走 emit()', !/\bemit\s*\(/.test(handlerCode),
  handlerCode.match(/\bemit\s*\([^)]*\)/)?.[0] ?? '(沒有 emit)');
check('② 停止直接用 console.info 送 STOP_MARK', /console\.info\(\s*STOP_MARK/.test(handlerCode),
  '需要 console.info(STOP_MARK, ...)');

const flushAt = handlerCode.indexOf('flushInput(');
const emitAt = handlerCode.indexOf('console.info(STOP_MARK');
check('③ flush 在送出停止訊號之前', flushAt >= 0 && emitAt >= 0 && flushAt < emitAt,
  `flushInput@${flushAt} < console.info@${emitAt}`);

// ── ④ 兩個 host ──────────────────────────────────────────────────────────
const agentCode = stripComments(agentRunner);
const serverCode = stripComments(serverRecorder);

check('④ agent-runner 認得停止前綴', /startsWith\(\s*m\.stopMarker\s*\)/.test(agentCode),
  '需要 text.startsWith(m.stopMarker)');
check('④ uat-server-recorder 認得停止前綴', /startsWith\(\s*options\.stopMarker\s*\)/.test(serverCode),
  '需要 text.startsWith(options.stopMarker)');
check('④ 缺席時不得退回用 marker（agent）',
  /m\.stopMarker\s*&&\s*text\.startsWith\(\s*m\.stopMarker\s*\)/.test(agentCode),
  '要有 m.stopMarker && … 的守衛');
check('④ 缺席時不得退回用 marker（server）',
  /options\.stopMarker\s*&&\s*text\.startsWith\(\s*options\.stopMarker\s*\)/.test(serverCode),
  '要有 options.stopMarker && … 的守衛');

// 停止訊號要比 armed 閘門先判——登入還沒完成時一樣要停得掉
const serverStopAt = serverCode.indexOf('options.stopMarker');
const serverArmedAt = serverCode.indexOf('if (finished || !armed) return');
check('④ 伺服器模式：停止判斷在 armed 閘門之前',
  serverStopAt >= 0 && serverArmedAt >= 0 && serverStopAt < serverArmedAt,
  `stopMarker@${serverStopAt} < armed@${serverArmedAt}`);

// server 兩條派工路徑都要帶 stopMarker，少一條那個模式就永遠沒有這顆按鈕的功能
const stopMarkerSends = (osmUat.match(/stopMarker:\s*RECORDER_STOP_MARKER/g) ?? []).length;
check('④ osm-uat 兩條派工路徑都帶 stopMarker', stopMarkerSends === 2,
  `找到 ${stopMarkerSends} 處（agent 派工 + 伺服器模式各一）`);

// ── 收尾共用：不得各寫一份 flush+close ────────────────────────────────────
const stopFnCount = (agentCode.match(/async function stopBackendRecording\b/g) ?? []).length;
check('⑤ agent-runner 的收尾只有一份實作', stopFnCount === 1, `找到 ${stopFnCount} 個 stopBackendRecording`);
// ⚠️ 要數的是**呼叫點**，不是字串出現次數。那一行同時有型別標註與呼叫
//    （`{ __toppathFlushRecorder?: () => void }).__toppathFlushRecorder?.()`），
//    用裸字串比對會數成 2、讓這條永遠紅——第一版就是這樣錯的。
const flushCalls = (src) => (src.match(/\.__toppathFlushRecorder\?\.\(\)/g) ?? []).length;
check('⑤ agent-runner 只有一個 flush 呼叫點', flushCalls(agentCode) === 1,
  `呼叫點 ${flushCalls(agentCode)} 個（>1 代表收尾又各寫了一份）`);
check('⑤ uat-server-recorder 只有一個 flush 呼叫點', flushCalls(serverCode) === 1,
  `呼叫點 ${flushCalls(serverCode)} 個（>1 代表 stop 與 stopNow 各寫了一份）`);

// ── 輸出 ─────────────────────────────────────────────────────────────────
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : `\n     ${r.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} 通過`);
process.exit(failed ? 1 : 0);
