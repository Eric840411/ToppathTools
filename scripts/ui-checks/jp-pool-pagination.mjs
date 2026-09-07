/**
 * scripts/ui-checks/jp-pool-pagination.mjs
 *
 * 守「LuckyLink 池變動抓取不得靜默掉資料」。
 *
 * 🚨 舊做法：用「游標 → now」單一視窗，上限 500×10=5000。而這支 API 是
 *    **新到舊**排序——撞上限時拿到最新的 5000 筆，游標接著跳到最新那筆，
 *    **中間沒抓到的整段就永遠跳過去**。實測資料表有 13.7 小時與 16.9 小時兩個缺口。
 *
 *    跟 Jira 對帳 v4.99.0 同一種壞法：**截斷完全沒有徵兆**。
 *
 * ⚠️ 這支只做靜態檢查與常數確認，不打外部 API（打了會動到正式資料）。
 *    實際的補進度行為已用真實 API 驗過：把游標倒回 9/6 16:51 之後，
 *    一輪把它推進到 18:49（4 片 × 30 分鐘），會自己追上。
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const src = readFileSync(path.join(root, 'server/live-ledger-jp.ts'), 'utf8');
const l5 = src.split('L4：中獎')[0];

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++;
};

console.log('1) 撞到分頁上限必須是「看得見的」');
check('🚨 fetchSlice 明確回報 capped（不是只回筆數）',
  /capped: true/.test(src) && /capped: false/.test(src));
check('   十頁都填滿才算 capped（沒填滿就是拿完了）',
  /if \(r\.items\.length < PAGE_SIZE\) return \{ ok: true, items, capped: false \}/.test(src));

console.log('\n2) 🚨 游標不准用「抓到的資料最大時間」推進');
// 那正是舊做法：撞上限時拿到的是最新一批，推過去就跳過中間沒抓到的。
check('🚨 L5 區塊裡已經沒有 maxTs 那套', !/let maxTs = wm/.test(l5));
check('🚨 游標只由「補完整的切片」推進',
  /if \(cursor > wm\) writeWm\(env, 'poolChangeReport', cursor\)/.test(src));

console.log('\n3) 撞上限的收斂規則（跟 CodeX 定案）');
check('切片撞上限 → 對半切重試',
  /while \(got\.ok && got\.capped && \(sliceEnd - cursor\) > MIN_SLICE_SEC \* 1000\)/.test(src));
check('🚨 最小切片是 1 秒（時間精度到秒，再切已無法區分資料）',
  /const MIN_SLICE_SEC = 1$/m.test(src));
check('🚨 切到最小還撞上限 → **不推進游標**、明確報錯、停止自動補',
  /if \(got\.capped\) \{[\s\S]{0,1200}out\.errors\.push\([\s\S]{0,500}break/.test(src));
check('   錯誤訊息講出哪一段時間、打滿幾筆、以及要怎麼解',
  /秒內就打滿/.test(src) && /更細的條件/.test(src));

console.log('\n4) 即時視窗結構上不會撞上限');
check('即時視窗是固定小範圍，不是「游標 → now」',
  /const liveFrom = now - LIVE_WINDOW_SEC \* 1000/.test(src)
  && /const liveTo = now - LIVE_LAG_SEC \* 1000/.test(src));
const live = /const LIVE_WINDOW_SEC = (\d+)/.exec(src);
check('   視窗寬度大於 cycle 間隔（60 秒），才不會有縫',
  !!live && Number(live[1]) > 60, live ? live[1] + ' 秒' : '讀不到');
check('   上界往回留一點，避免讀到還在寫的那一秒',
  /const LIVE_LAG_SEC = \d+/.test(src));

console.log('\n4b) 🚨 查詢視窗的時區 —— 這支 API 吃「本地時間」不是 UTC');
// 實測（2026-09-08）：同一時段送 UTC 字串回 0 筆、送本地字串回 500 筆。
// 送錯的話整條管線會**穩定落後 8 小時**，而且看起來一切正常
// （資料一直在進來，只是永遠是 8 小時前的）——最難發現的那種壞法。
check('🚨 toIso 有加時區位移，不是直接 toISOString',
  /const LL_TZ_OFFSET_MS = 8 \* 3600_000/.test(src)
  && /new Date\(ms \+ LL_TZ_OFFSET_MS\)\.toISOString\(\)/.test(src));
check('   註解講清楚跟 OSM／GCP 後台相反（同名參數不同時區）',
  /OSM／GCP/.test(src) && /相反/.test(src));

console.log('\n5) 補進度要有界，不能把單輪拖死');
check('一輪最多補固定片數', /slices < CATCHUP_SLICES_PER_CYCLE/.test(src));
check('補到即時視窗就停（兩邊不重疊浪費）', /cursor < liveFrom/.test(src));

console.log(`\n${fail === 0 ? '全部通過' : fail + ' 項未過'}（pass ${pass} / fail ${fail}）`);
process.exit(fail ? 1 : 0);
