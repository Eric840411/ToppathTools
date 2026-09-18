/**
 * scripts/ui-checks/uat-h5-tc-binding.mjs
 *
 * 驗 H5／PC 腳本的 **Lark TC 綁定**（資料層）。
 *
 * ## 這在守什麼
 * 使用者要求「H5 也有 TC 的概念，跟 Backend 一樣要回填」。一份腳本綁多筆 TC、
 * 每顆積木標明屬於哪一筆。這一層只要錯，**症狀全都是「跑完沒回寫」或「回寫到錯的 TC」**，
 * 而那要等整支腳本跑完才看得到——所以在這裡擋：
 *
 *   ① 綁定存得進去、讀得回來
 *   ② 積木的 `tcId` **序列化之後還在**
 *      （⚠️ `step-model.ts` 的白名單漏欄位是這個專案的經典坑：畫面上編得好好的，
 *        存檔後參數消失，而且沒有任何錯誤）
 *   ③ 沒有 recordId 的綁定要丟掉，不是留著等回寫時才爆
 *   ④ ⚠️ **沒帶到綁定欄位的存檔不能把綁定洗掉**（存檔的呼叫端不只一個）
 *   ⑤ 明確傳空值才是清空
 *
 * 跑法：node scripts/ui-checks/uat-h5-tc-binding.mjs
 * ⚠️ 需要先 `npm run build`。
 */
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};

const express = (await import('express')).default;
const { router } = await load('dist-server/server/routes/frontend-auto.js');
const { db } = await load('dist-server/server/shared.js');

const app = express();
app.use(express.json());
app.use(router);
const server = app.listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

const call = async (method, url, body) => {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await response.json() } catch { /* 有些路徑不回 JSON */ }
  return { status: response.status, ok: response.ok, json };
};

const ACTOR = 'h5-tc-binding-test@toppath.invalid';
const made = [];
const rowOf = (id) => db.prepare('SELECT lark_url, table_id, bindings, steps FROM frontend_auto_scripts WHERE id = ?').get(id);

try {
  // ── ① 綁定存得進去、讀得回來 ────────────────────────────────────────────
  const created = await call('POST', '/api/frontend-auto/scripts', {
    name: 'TC 綁定測試', platform: 'h5', createdBy: ACTOR,
    larkUrl: 'https://casinoplus.sg.larksuite.com/base/AAA?table=tblA',
    tableId: 'tblA',
    bindings: [
      { recordId: 'rec1', number: 'TC-014', text: '進大廳' },
      { recordId: 'rec2', number: 'TC-015', text: '開遊戲' },
      // ⚠️ 沒有 recordId：綁不到任何一筆，應該當場丟掉
      { recordId: '', number: '壞掉的', text: '沒有 recordId' },
    ],
    steps: [
      { id: 's1', name: '前往', action: 'goto', value: 'https://example.invalid/' },
      { id: 's2', name: '驗大廳', action: 'assert_visible', selector: '#lobby', tcId: 'rec1' },
      { id: 's3', name: '驗遊戲', action: 'assert_visible', selector: '#game', tcId: 'rec2' },
    ],
  });
  check('① 帶綁定的腳本建得起來', created.ok && !!created.json?.script?.id, JSON.stringify(created.json));
  const id = created.json?.script?.id;
  if (id) made.push(id);

  const row = id ? rowOf(id) : null;
  check('① Lark 路徑存得進去', row?.lark_url === 'https://casinoplus.sg.larksuite.com/base/AAA?table=tblA', row?.lark_url);
  check('① tableId 存得進去', row?.table_id === 'tblA', row?.table_id);

  const binds = JSON.parse(row?.bindings ?? '[]');
  check('③ ⚠️ 沒有 recordId 的綁定被丟掉（留著會變成「跑完才發現寫不進去」）',
    binds.length === 2 && binds.every(b => b.recordId), JSON.stringify(binds));
  check('① 綁定的 TC 編號與說明都留著', binds[0]?.number === 'TC-014' && binds[1]?.text === '開遊戲', JSON.stringify(binds));

  // ── ② 積木的 tcId 要進得了資料庫 ────────────────────────────────────────
  //    ⚠️ 這裡**驗不到前端的白名單**——後端是原樣收下 steps 的，白名單漏掉 tcId
  //    的時候這幾條照樣會綠。那一層在 `uat-step-tc.test.ts`（真的呼叫 serializeSteps）。
  //    這裡只證明「前端送得出來的話，後端存得下去」。
  const steps = JSON.parse(row?.steps ?? '[]');
  check('② 積木的 tcId 進得了資料庫（後端沒有把它過濾掉）',
    steps[1]?.tcId === 'rec1' && steps[2]?.tcId === 'rec2', JSON.stringify(steps));

  const listed = await call('GET', '/api/frontend-auto/scripts?platform=h5');
  const mine = (listed.json?.scripts ?? []).find(s => s.id === id);
  check('① 清單帶得出綁定欄位（前端才有東西可顯示）',
    !!mine && mine.table_id === 'tblA' && JSON.parse(mine.bindings ?? '[]').length === 2,
    JSON.stringify({ table_id: mine?.table_id, bindings: mine?.bindings }));

  // ── ④ 沒帶綁定欄位的存檔不能洗掉綁定 ────────────────────────────────────
  //    這是最容易靜默出錯的一條：錄完自動存、改名、切換公開與否都會打 PUT，
  //    只要其中一個沒把 larkUrl/bindings 一起帶上，綁定就沒了。
  const renamed = await call('PUT', `/api/frontend-auto/scripts/${id}`, {
    name: '改個名字', platform: 'h5', createdBy: ACTOR, steps,
  });
  check('④ 只改名字存得起來', renamed.ok, JSON.stringify(renamed.json));
  const afterRename = rowOf(id);
  check('④ 🚨 沒帶綁定欄位 → 綁定原封不動（不是被清空）',
    afterRename?.lark_url === 'https://casinoplus.sg.larksuite.com/base/AAA?table=tblA'
    && JSON.parse(afterRename?.bindings ?? '[]').length === 2,
    JSON.stringify({ lark_url: afterRename?.lark_url, bindings: afterRename?.bindings }));

  // ── ① 有帶就要真的改掉 ──────────────────────────────────────────────────
  await call('PUT', `/api/frontend-auto/scripts/${id}`, {
    name: '改個名字', platform: 'h5', createdBy: ACTOR, steps,
    larkUrl: 'https://casinoplus.sg.larksuite.com/base/BBB?table=tblB', tableId: 'tblB',
    bindings: [{ recordId: 'rec9', number: 'TC-020', text: '改過了' }],
  });
  const afterEdit = rowOf(id);
  check('① 有帶綁定 → 真的換成新的',
    afterEdit?.table_id === 'tblB' && JSON.parse(afterEdit?.bindings ?? '[]')[0]?.recordId === 'rec9',
    JSON.stringify({ table_id: afterEdit?.table_id, bindings: afterEdit?.bindings }));

  // ── ⑤ 明確清空才是清空 ──────────────────────────────────────────────────
  await call('PUT', `/api/frontend-auto/scripts/${id}`, {
    name: '改個名字', platform: 'h5', createdBy: ACTOR, steps,
    larkUrl: '', tableId: '', bindings: [],
  });
  const afterClear = rowOf(id);
  check('⑤ 明確傳空值 → 解除綁定（要留得住「我就是不要綁」這個意思）',
    afterClear?.lark_url === '' && afterClear?.table_id === '' && JSON.parse(afterClear?.bindings ?? '[]').length === 0,
    JSON.stringify({ lark_url: afterClear?.lark_url, bindings: afterClear?.bindings }));

  // ── ① 沒綁定的腳本照舊能存（不能用新欄位把舊用法弄壞）──────────────────
  const plain = await call('POST', '/api/frontend-auto/scripts', {
    name: '沒綁 TC 的舊腳本', platform: 'pc', createdBy: ACTOR,
    steps: [{ id: 'a', name: '前往', action: 'goto', value: 'https://example.invalid/' }],
  });
  check('① 沒帶任何綁定的腳本照舊建得起來', plain.ok && !!plain.json?.script?.id, JSON.stringify(plain.json));
  if (plain.json?.script?.id) {
    made.push(plain.json.script.id);
    const r = rowOf(plain.json.script.id);
    check('① 沒綁定時欄位是空的，不是 null（前端不用再判一次）',
      r?.lark_url === '' && r?.bindings === '[]', JSON.stringify({ lark_url: r?.lark_url, bindings: r?.bindings }));
  }
} finally {
  for (const id of made) {
    try { db.prepare('DELETE FROM frontend_auto_scripts WHERE id = ?').run(id) } catch { /* 清不掉就算了 */ }
  }
  server.close();
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
