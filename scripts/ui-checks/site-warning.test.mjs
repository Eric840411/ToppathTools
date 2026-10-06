/**
 * 站台「機台異常」警告彈窗的關閉規則（server/uat-runner/site-warning.js，CodeX 2026-10-06 定案）。
 *
 *   node scripts/ui-checks/site-warning.test.mjs
 *
 * 用真的瀏覽器＋Element UI 的 DOM 結構。守的是：
 *   ① 只關「標題 Warnning／Warning ＋ 內文 machines are abnormal」那一種窗
 *   ② **兩窗同時存在**：真的 Warning 確認框（例如刪除確認）與共用遮罩 .v-modal 一定要留著
 *   ③ 只有站台警告時，遮罩才拿掉
 */
import { chromium } from 'playwright';
import { dismissSiteWarning, markSiteWarnings } from '../../server/uat-runner/site-warning.js';

let pass = 0, fail = 0;
const check = (title, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${title}${ok || !extra ? '' : `  ← ${extra}`}`); ok ? pass++ : fail++; };

const dialog = (id, title, body) => `<div class="el-dialog__wrapper" id="${id}" style="position:fixed;inset:0;z-index:2001"><div class="el-dialog" style="width:400px;margin:40px auto;background:#fff">
  <div class="el-dialog__header"><span class="el-dialog__title">${title}</span></div><div class="el-dialog__body">${body}</div>
  <div class="el-dialog__footer"><button>Cancel</button><button>OK</button></div></div></div>`;
const SITE = dialog('site', 'Warnning', 'Currently 3 machines are abnormal, please check.');
const CONFIRM = dialog('confirm', 'Warning', 'Are you sure to delete this machine?');
const MODAL = '<div class="v-modal" style="position:fixed;inset:0;opacity:.5;background:#000;z-index:2000"></div>';

const browser = await chromium.launch();
const page = await browser.newPage();
const vis = (sel) => page.evaluate(s => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none'; }, sel);
console.log('站台警告彈窗');

await page.setContent(`<body>${SITE}${MODAL}</body>`);
check('只有站台警告 → 藏掉', await dismissSiteWarning(page, 0) === true && !(await vis('#site')));
check('只有站台警告 → 遮罩也拿掉', !(await vis('.v-modal')));

await page.setContent(`<body>${SITE}${CONFIRM}${MODAL}</body>`);
await dismissSiteWarning(page, 0);
check('兩窗同時存在 → 站台警告藏掉', !(await vis('#site')));
check('兩窗同時存在 → 真的 Warning 確認框留著', await vis('#confirm'));
check('兩窗同時存在 → 共用遮罩留著', await vis('.v-modal'));

await page.setContent(`<body>${CONFIRM}${MODAL}</body>`);
check('只有標題 Warning 的確認框 → 不認、不動', await dismissSiteWarning(page, 0) === false && await vis('#confirm') && await vis('.v-modal'));

await page.setContent(`<body>${dialog('other', 'Notice', 'Currently 3 machines are abnormal')}${MODAL}</body>`);
check('內文對但標題不是 Warning → 不認', (await markSiteWarnings(page)) === 0 && await vis('#other'));

await page.setContent(`<body>${dialog('site2', 'Warning', 'Currently 12 machines are abnormal')}${MODAL}</body>`);
check('標題拼對的 Warning＋內文對 → 也認', await dismissSiteWarning(page, 0) === true && !(await vis('#site2')));

await page.setContent('<body><p>no dialog</p></body>');
check('沒有任何彈窗 → 回 false、不報錯', await dismissSiteWarning(page, 0) === false);

await browser.close();
console.log(`\n${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
