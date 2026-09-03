/**
 * 週報「P7-005-OSM 每人合併成一條」不能把**手動新增**的項目吃掉。
 *
 * ⚠️ 這個 bug 的壞法是「使用者打的字靜默消失」：
 *    真實案例（2026-09-03 使用者回報）——手動打了「熱更新測試」，專案填 P7-005-OSM，
 *    預覽裡變成「OSM需求」。資料沒掉，但文字被覆蓋，看起來像功能壞了。
 *    不會拋錯、build 乾淨、型別乾淨，只有真的打一筆進去才看得見。
 *
 * 也守住一條容易漂掉的：`countMergeable()` 的條件必須跟 `buildPreviewItems()`
 * 裡那一行完全一致，否則畫面會說「會合併 6 筆」但實際只併 5 筆。
 *
 * 跑法：node scripts/ui-checks/weekly-merge-manual-exempt.mjs
 */
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// ⚠️ Windows 上一定要 pathToFileURL——直接把 `C:\...` 丟給 import() 會被當成 protocol 'c:'
const m = await import(pathToFileURL(path.join(root, 'dist-server/shared/weekly-report-rules.js')).href);
const { buildPreviewItems, countMergeable, isManualItem, MERGE_PROJECT_NAME, MERGE_CONTENT, MANUAL_SOURCE_ROW_ID } = m;

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++ };

const P = MERGE_PROJECT_NAME;
const sheet = (row, content) => ({ sourceRowId: `0-${row}`, content, projectId: 'p1', projectName: P });
const manual = (content, project = P) => ({ sourceRowId: MANUAL_SOURCE_ROW_ID, content, projectId: 'p1', projectName: project });

// 使用者截圖的實際情形：Siara 5 筆 Sheet + 1 筆手動
const drafts = {
  Siara: [
    sheet(29, "[OSM][PC]dragonslaw 改成 dragon's law"),
    sheet(30, '[OSM][PC]修复dragonlaw和allaborad在切换面额的时候会返回1035错误码'),
    sheet(33, '[OSM][H5,PC]更新了loading图'),
    sheet(34, '[OSM][H5]支持長按空白鍵觸發SPIN'),
    sheet(38, '[OSM][H5]在機台內，無法透過預約介面進入其他機台'),
    manual('熱更新測試'),
  ],
};

console.log('\n1) 使用者回報的那個情境');
const merged = buildPreviewItems(drafts, { mergeOsm: true, mergeJiraTags: false });
const contents = merged.map(x => x.item.content);
check('手動新增的文字還在（這就是回報的 bug）', contents.includes('熱更新測試'), JSON.stringify(contents));
check('5 筆 Sheet 併成一條 OSM需求', contents.filter(c => c === MERGE_CONTENT).length === 1);
check('總共剩 2 列（1 合併 + 1 手動）', merged.length === 2, `實際 ${merged.length}`);
check('手動那列的專案沒被動到', merged.find(x => x.item.content === '熱更新測試')?.item.projectName === P);

console.log('\n2) 關掉開關要完全恢復逐筆');
const raw = buildPreviewItems(drafts, { mergeOsm: false, mergeJiraTags: false });
check('6 筆全在', raw.length === 6);
check('沒有任何一筆被改寫成 OSM需求', !raw.some(x => x.item.content === MERGE_CONTENT));

console.log('\n3) 畫面上的「會合併 N 筆」要跟實際一致');
// ⚠️ 這兩個數字漂掉不會報錯，只會讓畫面說謊。
const counted = countMergeable(drafts);
const actuallyMerged = 6 - merged.length + 1; // 被吃掉的筆數 + 產生的那一列
check('countMergeable 排除手動新增', counted === 5, `回 ${counted}`);
check('跟 buildPreviewItems 實際併掉的筆數一致', counted === actuallyMerged, `${counted} vs ${actuallyMerged}`);

console.log('\n4) 只豁免手動新增，其他來源照併（CodeX 明確要求不要一起豁免）');
const mixed = {
  Eric: [
    sheet(1, 'a'),
    { sourceRowId: 'Jira · DSFT-1', content: 'DSFT-1', projectId: 'p1', projectName: P },
    { sourceRowId: '手動指派 · 頁籤 · x:1', content: '20260901 NP', projectId: 'p1', projectName: P },
    manual('我自己打的'),
  ],
};
const mixedOut = buildPreviewItems(mixed, { mergeOsm: true, mergeJiraTags: false });
check('Jira 套用仍被合併', !mixedOut.some(x => x.item.sourceRowId.startsWith('Jira · ')));
check('手動指派仍被合併', !mixedOut.some(x => x.item.sourceRowId.startsWith('手動指派 · ')));
check('只有手動新增留下來', mixedOut.length === 2 && mixedOut.some(x => x.item.content === '我自己打的'),
  JSON.stringify(mixedOut.map(x => x.item.content)));

console.log('\n5) 邊界');
check('手動新增但專案不是 P7-005-OSM，本來就不該被碰',
  buildPreviewItems({ A: [manual('別的', 'P7-007-第三方測試')] }, { mergeOsm: true, mergeJiraTags: false })[0].item.content === '別的');
check('整個人只有手動新增時不會生出空的合併列',
  buildPreviewItems({ A: [manual('只有這筆')] }, { mergeOsm: true, mergeJiraTags: false }).length === 1);
check('多筆手動新增各自保留（不會互相吃掉）',
  buildPreviewItems({ A: [manual('一'), manual('二'), manual('三')] }, { mergeOsm: true, mergeJiraTags: false }).length === 3);
check('isManualItem 只認 sourceRowId 完全相等，不用前綴比對',
  isManualItem({ sourceRowId: MANUAL_SOURCE_ROW_ID }) && !isManualItem({ sourceRowId: '手動新增的東西' }));
// 每個人各自合併，不是全部人共用一條
check('兩個人各自產生自己的合併列',
  buildPreviewItems({ A: [sheet(1, 'a'), sheet(2, 'b')], B: [sheet(3, 'c'), sheet(4, 'd')] },
    { mergeOsm: true, mergeJiraTags: false }).length === 2);

console.log(`\n${fail === 0 ? '全部通過' : fail + ' 項未過'}（pass ${pass} / fail ${fail}）`);
process.exit(fail ? 1 : 0);
