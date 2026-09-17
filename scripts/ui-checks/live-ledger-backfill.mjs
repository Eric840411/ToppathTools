/**
 * scripts/ui-checks/live-ledger-backfill.mjs
 *
 * 驗**分段補抓**（`fetchSegmented`）與**時間窗換軸**（`planFetchWindow`）。
 *
 * 🚨 **為什麼需要這個檢查**：2026-09-17 實測到 `recon_spin` 從 9/8 卡了整整 9 天。
 * 根因不是「沒開壓測」，是採集進了一個**單向閥門**：
 *
 *   查 [水位, now] → 太大 → 20 頁截斷 → （正確地）不推水位
 *                  → 下一輪窗更大 → 再截斷 → 永遠出不來
 *
 * 最惡劣的是它**看起來不像壞掉**：`failCount` 只有 3、其他三個資料來源都在正常更新，
 * 畫面上沒有任何一處會說「後台下注紀錄已經 9 天沒進來了」。
 *
 * 所以這支要守的**不是**「分段算得對」，是下面這條不變量：
 *
 *   **水位只會前進到「已經確認完整抓完」的位置——一格都不能多。**
 *
 * 推過頭 → 中間那段永久跳過、事後查不出少了什麼（v4.99.0 Jira 分頁同一個坑）。
 * 推不動 → 就是 9/8 那個死鎖。兩邊都要釘住，所以每一條都用注入的方式製造一次。
 *
 * 跑在正式 data.db 上，注入資料帶 `__backfill_` 前綴且用 uat 軸，結尾刪除。
 */
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// `LL_BACKFILL_TARGET` 讓突變測試 runner 把同一組斷言指向**改壞過**的副本。
// 沒設就是正常跑編譯產物。
const target = process.env.LL_BACKFILL_TARGET || 'dist-server/server/live-ledger-fetch.js';
const distUrl = pathToFileURL(path.join(root, target)).href;
const mod = await import(distUrl);
const { fetchSegmented, planFetchWindow, SEGMENT_MS, MIN_SEGMENT_MS, MAX_SEGMENTS_PER_CYCLE, SETTLE_MS } = mod;
const db = new Database(path.join(root, 'server/data.db'));

const TAG = '__backfill_';
const ENV = 'uat';            // 用 uat 軸，不碰 qat 的真實採集狀態
const SOURCE = TAG + 'src';
const USER = TAG + 'user';
const HOUR = 3600_000;

let pass = 0, fail = 0;
const failed = [];
const check = (n, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
  if (ok) pass++; else { fail++; failed.push(n); }
};

const cleanup = () => {
  db.prepare(`DELETE FROM recon_watermark WHERE source LIKE '${TAG}%'`).run();
  db.prepare(`DELETE FROM recon_source_health WHERE source LIKE '${TAG}%'`).run();
  db.prepare(`DELETE FROM recon_source_health WHERE env=? AND source='clock'`).run(ENV);
};
cleanup();

const readWm = () => {
  const r = db.prepare('SELECT cursorTs FROM recon_watermark WHERE env=? AND source=? AND scope=?')
    .get(ENV, SOURCE, USER);
  return r?.cursorTs ?? 0;
};
const setWm = (ts) => db.prepare(`
  INSERT INTO recon_watermark (env, source, scope, cursorTs, updatedAt) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(env, source, scope) DO UPDATE SET cursorTs=excluded.cursorTs
`).run(ENV, SOURCE, USER, ts, Date.now());

/**
 * 假的「抓一個窗」。
 *
 * `limitMs` 模擬後台的 4000 筆／20 頁上限：窗比它大就回 `reachedLimit`。
 * 真實世界是「筆數」爆掉，這裡用「時間跨度」代理——對分段邏輯來說兩者等價，
 * 而且可以精確控制哪一段會截斷。
 */
function makeFetcher({ limitMs = Infinity, alwaysTruncate = false, empty = () => false } = {}) {
  const calls = [];
  const okSegs = [];
  const fn = async (from, to) => {
    const span = to - from;
    const truncated = alwaysTruncate || span > limitMs;
    calls.push({ from, to, span, truncated });
    if (truncated) {
      return { ok: false, fetched: 4000, upserted: 0, pages: 20, reachedLimit: true, fromMs: from, toMs: to };
    }
    okSegs.push({ from, to });
    const n = empty(from, to) ? 0 : 3;
    return {
      ok: true, fetched: n, upserted: n, pages: 1, fromMs: from, toMs: to,
      maxTs: n ? to - 1000 : undefined,
    };
  };
  fn.calls = calls;
  fn.okSegs = okSegs;
  return fn;
}

/**
 * 覆蓋範圍有沒有**空洞**。
 *
 * ⚠️ 要守的是「沒有空洞」，**不是**「首尾剛好相接」——重疊是刻意的
 * （檔頭第 2 點：往回重疊一段再拉，靠 upsert 去重）。把重疊也判成失敗，
 * 等於用測試去禁止一個正確的行為。
 * 回傳第一個空洞方便判斷，`null` 代表全覆蓋。
 */
const findGap = (segs) => {
  const s = [...segs].sort((a, b) => a.from - b.from);
  if (!s.length) return { from: 0, to: 0 };
  let covered = s[0].to;
  for (let i = 1; i < s.length; i++) {
    if (s[i].from > covered) return { from: covered, to: s[i].from };
    covered = Math.max(covered, s[i].to);
  }
  return null;
};
const gapText = (g) => g ? `空洞 ${new Date(g.from).toISOString()} ~ ${new Date(g.to).toISOString()}` : '';

console.log('\n── 分段補抓：死鎖與不變量 ──');

// ① 9 天缺口要補得完。這就是 9/8 那個死鎖的回歸測試。
{
  const nowSrv = Date.now();
  const toMs = nowSrv + 60_000;
  const start = nowSrv - 9 * 24 * HOUR;
  setWm(start);
  const allSegs = [];
  let rounds = 0, done = false, lastOut = null;
  while (rounds < 80) {
    const wm = readWm();
    const f = makeFetcher({ limitMs: HOUR });
    lastOut = await fetchSegmented(ENV, SOURCE, USER, wm, wm, toMs, nowSrv, f);
    allSegs.push(...f.okSegs);
    rounds++;
    if (lastOut.ok) { done = true; break; }
    if (readWm() <= wm) break;   // 水位沒動 = 卡住了，別空轉
  }
  check('9 天缺口能補完（9/8 死鎖的回歸）', done, `rounds=${rounds}`);
  const gap1 = findGap(allSegs);
  check('補過的區間沒有空洞', gap1 === null, gap1 ? gapText(gap1) : `segs=${allSegs.length}`);
  check('水位最終追上現在', readWm() >= toMs - 2000, `wm=${new Date(readWm()).toISOString()}`);
  check('一輪不超過 MAX_SEGMENTS_PER_CYCLE 段',
    rounds > 1 && allSegs.length / rounds <= MAX_SEGMENTS_PER_CYCLE + 0.01);
}

// ② 塞不下就對半切，而且記住切到多小，不要每段重試一次
{
  const nowSrv = Date.now();
  const start = nowSrv - 20 * HOUR;
  setWm(start);
  const f = makeFetcher({ limitMs: HOUR });
  await fetchSegmented(ENV, SOURCE, USER, start, start, nowSrv + 60_000, nowSrv, f);
  const spans = f.calls.map(c => c.span);
  check('第一段會對半切到塞得下', spans[0] === SEGMENT_MS && spans[1] === SEGMENT_MS / 2 && spans[2] === SEGMENT_MS / 4,
    `${spans.slice(0, 3).map(s => s / HOUR + 'h').join(' → ')}`);
  const truncatedCalls = f.calls.filter(c => c.truncated).length;
  check('後續段不再重複試大窗（截斷次數只有第一段那 2 次）', truncatedCalls === 2, `truncated=${truncatedCalls}`);
}

// ③ 切到下限仍然截斷 → 水位一格都不能動，而且要報成異常
{
  const nowSrv = Date.now();
  const start = nowSrv - 10 * HOUR;
  setWm(start);
  const f = makeFetcher({ alwaysTruncate: true });
  const out = await fetchSegmented(ENV, SOURCE, USER, start, start, nowSrv + 60_000, nowSrv, f);
  check('永遠截斷時水位不前進', readWm() === start, `wm=${readWm() - start}ms 偏移`);
  check('永遠截斷時回報 truncated', out.errKind === 'truncated' && out.ok === false, out.errKind ?? '(無)');
  check('切到下限就停手，不無限切', f.calls.every(c => c.span >= MIN_SEGMENT_MS));
  const health = db.prepare('SELECT errKind, message FROM recon_source_health WHERE env=? AND source=?').get(ENV, SOURCE);
  check('異常有寫進 source_health（不是安靜失敗）', health?.errKind === 'truncated' && !!health?.message);
}

// ④ 歷史段抓到 0 筆**必須**推水位——不推就是另一種死鎖
{
  const nowSrv = Date.now();
  const start = nowSrv - 30 * HOUR;
  setWm(start);
  const f = makeFetcher({ empty: () => true });     // 整段都沒有局
  await fetchSegmented(ENV, SOURCE, USER, start, start, nowSrv + 60_000, nowSrv, f);
  check('歷史段 0 筆也要推水位（否則空檔會永久卡住）', readWm() > start,
    `前進了 ${Math.round((readWm() - start) / HOUR)}h`);
}

// ⑤ 最新段抓到 0 筆**不可以**推水位——後台可能還沒把剛成的局吐出來
{
  const nowSrv = Date.now();
  const start = nowSrv - 60_000;                    // 整個窗都在 SETTLE_MS 之內
  setWm(start);
  const f = makeFetcher({ empty: () => true });
  await fetchSegmented(ENV, SOURCE, USER, start, start, nowSrv + 30_000, nowSrv, f);
  check('最新段 0 筆不推水位（剛成的局還沒落庫）', readWm() === start,
    `wm 動了 ${readWm() - start}ms`);
}

// ⑥ 中斷重跑：不重複、也不漏。upsert 保證前者，區間連續保證後者。
{
  const nowSrv = Date.now();
  const toMs = nowSrv + 60_000;
  const start = nowSrv - 3 * 24 * HOUR;
  setWm(start);
  const segsA = [];
  for (let i = 0; i < 3; i++) {                     // 跑 3 輪就「中斷」
    const wm = readWm();
    const f = makeFetcher({ limitMs: 2 * HOUR });
    await fetchSegmented(ENV, SOURCE, USER, wm, wm, toMs, nowSrv, f);
    segsA.push(...f.okSegs);
  }
  const midWm = readWm();
  const segsB = [];
  let guard = 0;
  while (guard++ < 80) {                            // 重跑接續
    const wm = readWm();
    const f = makeFetcher({ limitMs: 2 * HOUR });
    const r = await fetchSegmented(ENV, SOURCE, USER, wm, wm, toMs, nowSrv, f);
    segsB.push(...f.okSegs);
    if (r.ok) break;
    if (readWm() <= wm) break;
  }
  check('中斷後重跑會從水位接續，不從頭來', segsB.every(s => s.to > midWm - 2 * HOUR),
    `midWm=${new Date(midWm).toISOString()}`);
  const gap2 = findGap([...segsA, ...segsB]);
  check('兩段跑合起來沒有空洞', gap2 === null, gapText(gap2));
  check('重跑後追上現在', readWm() >= toMs - 2000);
}

console.log('\n── 時間窗換軸（clockOffsetMs）──');

// ⑦ 上界要用**量到的**偏移，不是寫死的 60 秒
{
  db.prepare(`
    INSERT INTO recon_source_health (env, source, failCount, clockOffsetMs, clockCheckedAt)
    VALUES (?, 'clock', 0, ?, ?)
    ON CONFLICT(env, source) DO UPDATE SET clockOffsetMs=excluded.clockOffsetMs
  `).run(ENV, 120100, Date.now());

  const now = Date.now();
  const wm = now - 5 * HOUR;
  const w = planFetchWindow(ENV, wm, now);
  check('上界換到後台軸（用量到的 120100ms，不是寫死的 60s）',
    w.toMs === now + 120100 + 60_000, `toMs−now=${w.toMs - now}ms`);
  check('下界不重複補償（wm 已經在後台軸上）',
    w.fromMs === wm - 90_000, `fromMs−wm=${w.fromMs - wm}ms`);
  check('偏移 120s 時上界確實涵蓋「後台的現在」', w.toMs > now + 120100,
    '舊版 now+60s 會少 60 秒，最新一分鐘的局查不到');

  // 偏移為 0（或量不到）時要退回原本行為，不能因此漏掉窗
  db.prepare(`UPDATE recon_source_health SET clockOffsetMs=NULL WHERE env=? AND source='clock'`).run(ENV);
  const w0 = planFetchWindow(ENV, wm, now);
  check('量不到偏移時退回 now+60s（不是爆掉或變 NaN）', w0.toMs === now + 60_000, `toMs−now=${w0.toMs - now}ms`);
}

cleanup();
db.close();

console.log(`\n結果：${pass} passed, ${fail} failed`);
if (fail) {
  console.log('失敗項目：');
  for (const f of failed) console.log('  ·', f);
}
process.exit(fail ? 1 : 0);
