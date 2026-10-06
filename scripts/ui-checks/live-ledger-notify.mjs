/**
 * scripts/ui-checks/live-ledger-notify.mjs
 *
 * 驗「對帳告警真的送得出去，而且送不出去時不會假裝送出去了」。
 *
 * ⚠️ **為什麼需要這個檢查**：2026-09-17 體檢查出 `recon_finding.notifiedAt` 這個欄位
 * 只存在於 `shared.ts` 的建表語句裡——整個 `server/` 底下沒有任何一行程式寫過它。
 * 庫裡躺著 3,491 筆 findings，**一則都沒有人被通知過**，而畫面上完全看不出來：
 * 「沒有告警」跟「告警根本沒接」長得一模一樣。
 *
 * 所以這支要守的不是「會不會發」，是**四種不發的情況能不能被分辨出來**：
 *   還在靜置期／水位線之前／被關掉／送失敗——前兩種是正常，後兩種必須看得見。
 *
 * ⚠️ 這支跑在**正式的 data.db** 上（本 repo ui-checks 的慣例）。三道自保：
 *   ① 注入的 finding 都帶 `__notify_check_` 前綴，結尾一律刪除
 *   ② 會動到的 `recon_settings` 先存後還原
 *   ③ **不改全域的 Lark 通知設定**——送出路徑走 notify-outlet 的 `__notifyTestSeam`
 *      （假的發送、假的補送佇列、假的「有沒有設定」）。改全域設定的話，這段期間正在跑的
 *      worker 真的要發的告警會被發到假的地方然後消失。（v5.13.0 Discord 刪除前是指到本機假 webhook）
 *
 * 突變測試結果（2026-09-17，六個突變體全數被殺）：拿掉 4xx/5xx 檢查、先標記再送、
 * 拿掉靜置期、拿掉水位線、拿掉「已解決不送」、關閉時不寫健康列——各自都會讓對應
 * 斷言轉紅。⚠️ 其中「水位線」那條原本**殺不掉**：查詢有 LIMIT，水位線拿掉後會先撈到
 * 庫裡幾千筆歷史告警，注入的那筆落在 LIMIT 之外，測試照樣綠。改成斷言不變式
 * 「回傳的每一筆都必須晚於水位線」才守得住。
 */
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const notify = await import(pathToFileURL(path.join(root, 'dist-server/server/live-ledger-notify.js')).href);
const { __notifyTestSeam: seam } = await import(pathToFileURL(path.join(root, 'dist-server/server/notify-outlet.js')).href);
const db = new Database(path.join(root, 'server/data.db'));

const ENV = 'qat';
const TAG = '__notify_check_';
const now = Date.now();
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++;
};

// ── 先備份會動到的設定 ───────────────────────────────────────────────
const TOUCHED = ['notifyWatermarkTs', 'notifyGraceSec', 'notifyIntervalSec', 'notifyEnabled', 'notifyLastSentTs'];
const backup = new Map(TOUCHED.map(k => [k,
  db.prepare('SELECT value FROM recon_settings WHERE env=? AND key=?').get(ENV, k)?.value ?? null]));
const setSetting = (k, v) => db.prepare(
  'INSERT INTO recon_settings (env, key, value) VALUES (?, ?, ?) ON CONFLICT(env, key) DO UPDATE SET value=excluded.value',
).run(ENV, k, String(v));

const insertFinding = (detectedAt, o = {}) => db.prepare(`
  INSERT INTO recon_finding (env, line, severity, refType, refId, amountDelta, detectedAt, notifiedAt, resolvedAt, note, userLabel)
  VALUES (?, ?, ?, 'spin', ?, ?, ?, ?, ?, ?, ?)
`).run(ENV, o.line ?? 'missing', o.severity ?? 'critical', String(o.refId ?? 999999),
  o.amountDelta ?? null, detectedAt, o.notifiedAt ?? null, o.resolvedAt ?? null,
  `${TAG}${o.note ?? ''}`, o.userLabel ?? '__check_user').lastInsertRowid;

// ── 假的 Lark：記下每一則卡片；mode 控制回成功／連不上／API 錯誤 ─────────────────
let received = [], mentioned = [], mode = 'ok', configured = true, fakeQueue = [];
Object.assign(seam.deps, {
  configured: () => configured,
  chatId: () => 'oc_notify_check',
  mention: async labels => { mentioned.push(...labels); return { line: labels.map(l => '@' + l).join(' '), unmapped: [], noPermission: false } },
  sendLark: async (_chat, card) => {
    if (mode === 'down') return { ok: false, code: 'NETWORK', message: 'fetch failed（連不上）' };
    if (mode === 'api_error') return { ok: false, code: 'API', message: 'Lark 回 code 230002（機器人不在群組）' };
    received.push(card); return { ok: true, value: 'om_check_' + received.length };
  },
  readQueue: () => fakeQueue,
  writeQueue: q => { fakeQueue = q; },
});

try {
  setSetting('notifyWatermarkTs', now - 24 * 3600_000);
  setSetting('notifyGraceSec', 120);
  setSetting('notifyIntervalSec', 180);
  setSetting('notifyEnabled', 1);
  setSetting('notifyLastSentTs', 0);

  console.log('1) pendingFindings 的過濾條件');
  const idOld = insertFinding(now - 600_000, { note: '過靜置期' });
  const idNew = insertFinding(now - 10_000, { note: '靜置期內' });
  const idResolved = insertFinding(now - 600_000, { note: '已解決', resolvedAt: now - 60_000 });
  const idNotified = insertFinding(now - 600_000, { note: '已通知', notifiedAt: now - 60_000 });
  const idBeforeWm = insertFinding(now - 48 * 3600_000, { note: '水位線之前' });

  const rows = notify.pendingFindings(ENV, now);
  const ids = rows.map(r => r.id);
  const wm = notify.notifyWatermark(ENV, now);
  check('過了靜置期的會被選出來', ids.includes(Number(idOld)));
  check('還在靜置期的不會被選出來', !ids.includes(Number(idNew)));
  check('已解決的不會被選出來', !ids.includes(Number(idResolved)));
  check('已通知過的不會被選出來', !ids.includes(Number(idNotified)));
  check('水位線之前的不會被選出來', !ids.includes(Number(idBeforeWm)));
  // ⚠️ 上面五條都是「某一筆在不在」，全都會被 LIMIT 掩護。下面兩條才是不變式。
  check('回傳的每一筆都晚於水位線（LIMIT 無關）',
    rows.length > 0 && rows.every(r => r.detectedAt > wm));
  check('回傳的每一筆都已過靜置期（LIMIT 無關）',
    rows.every(r => r.detectedAt <= now - 120_000));

  console.log('2) 送出成功 → 假 Lark 收得到、notifiedAt 被寫入');
  received = [];
  let r = await notify.runNotifyCycle(ENV, now);
  check('回報有送出', r.sent > 0, JSON.stringify(r));
  check('假 Lark 真的收到一則', received.length === 1, `收到 ${received.length} 則`);
  check('發起人有被交給 @ 人的邏輯', mentioned.includes('__check_user'), JSON.stringify(mentioned));
  check('卡片有內容區塊', (received[0]?.elements ?? []).length > 0);
  check('送出後 notifiedAt 被寫入',
    db.prepare('SELECT notifiedAt FROM recon_finding WHERE id=?').get(idOld)?.notifiedAt != null);
  check('靜置期內那筆沒有被誤標',
    db.prepare('SELECT notifiedAt FROM recon_finding WHERE id=?').get(idNew)?.notifiedAt === null);

  console.log('3) 節流：間隔內不重送，且被擋下的不會被標成已通知');
  const id2 = insertFinding(now - 600_000, { note: '節流' });
  received = [];
  r = await notify.runNotifyCycle(ENV, now + 10_000);
  check('回報 rate_limited', r.skipped === 'rate_limited', JSON.stringify(r));
  check('沒有再送出', received.length === 0);
  check('被節流的 notifiedAt 仍是 NULL',
    db.prepare('SELECT notifiedAt FROM recon_finding WHERE id=?').get(id2)?.notifiedAt === null);

  console.log('4) 送不出去時絕對不能標成已通知（連不上）');
  setSetting('notifyLastSentTs', 0);
  const id3 = insertFinding(now - 600_000, { note: '連不上' });
  mode = 'down';
  r = await notify.runNotifyCycle(ENV, now + 600_000);
  check('回報失敗', Boolean(r.failed) && r.sent === 0, JSON.stringify(r));
  check('失敗時 notifiedAt 仍是 NULL（下一輪會重試）',
    db.prepare('SELECT notifiedAt FROM recon_finding WHERE id=?').get(id3)?.notifiedAt === null);
  check('健康列記下 send_failed',
    db.prepare("SELECT errKind FROM recon_source_health WHERE env=? AND source='notify'").get(ENV)?.errKind === 'send_failed');

  check('失敗那批不排補送佇列（下一輪整批重送，排了會送兩次）', fakeQueue.length === 0, `佇列 ${fakeQueue.length}`);

  console.log('5) Lark API 回錯誤碼也算失敗（HTTP 200 但 code≠0）');
  setSetting('notifyLastSentTs', 0);
  const id4 = insertFinding(now - 600_000, { note: '404' });
  mode = 'api_error';
  r = await notify.runNotifyCycle(ENV, now + 1200_000);
  mode = 'ok';
  check('API 錯誤被當成失敗', Boolean(r.failed) && String(r.failed).includes('230002'), JSON.stringify(r));
  check('API 錯誤時 notifiedAt 仍是 NULL',
    db.prepare('SELECT notifiedAt FROM recon_finding WHERE id=?').get(id4)?.notifiedAt === null);

  console.log('6) 關閉開關 → 不送，但健康列要看得出是「被關掉」');
  setSetting('notifyEnabled', 0);
  setSetting('notifyLastSentTs', 0);
  received = [];
  r = await notify.runNotifyCycle(ENV, now + 1800_000);
  check('回報 disabled', r.skipped === 'disabled', JSON.stringify(r));
  check('沒有送出', received.length === 0);
  check('健康列記下 disabled（不是綠燈）',
    db.prepare("SELECT errKind FROM recon_source_health WHERE env=? AND source='notify'").get(ENV)?.errKind === 'disabled');
  setSetting('notifyEnabled', 1);

  console.log('7) 沒設定 Lark 通知 → not_configured，不是靜默跳過');
  setSetting('notifyLastSentTs', 0);
  configured = false;
  r = await notify.runNotifyCycle(ENV, now + 2400_000);
  configured = true;
  check('回報 not_configured', r.skipped === 'not_configured', JSON.stringify(r));
  check('健康列記下 not_configured',
    db.prepare("SELECT errKind FROM recon_source_health WHERE env=? AND source='notify'").get(ENV)?.errKind === 'not_configured');

  console.log('8) 水位線只建立一次（每輪往前推的話永遠沒東西可送）');
  db.prepare("DELETE FROM recon_settings WHERE env=? AND key='notifyWatermarkTs'").run(ENV);
  const wm1 = notify.notifyWatermark(ENV, now);
  const wm2 = notify.notifyWatermark(ENV, now + 999_000);
  check('第二次呼叫拿到同一個水位線', wm1 === wm2, `${wm1} vs ${wm2}`);

  console.log('9) buildBatch 的分組與排序');
  const sample = [
    { id: 1, line: 'missing', severity: 'critical', refId: '1', amountDelta: null, detectedAt: now - 300_000, note: '', userLabel: 'Eric Wu', machineType: 'DFDC3', spinSeq: 10 },
    { id: 2, line: 'missing', severity: 'critical', refId: '2', amountDelta: null, detectedAt: now - 300_000, note: '', userLabel: 'Eric Wu', machineType: 'DFDC3', spinSeq: 11 },
    { id: 3, line: 'l1_amount', severity: 'critical', refId: '3', amountDelta: -50, detectedAt: now - 300_000, note: '', userLabel: '__no_such_user', machineType: 'JJBX', spinSeq: 5 },
    { id: 4, line: 'ambiguous', severity: 'warn', refId: '4', amountDelta: null, detectedAt: now - 300_000, note: '', userLabel: 'Eric Wu', machineType: 'JJBX', spinSeq: 6 },
  ];
  const batch = notify.buildBatch(ENV, sample, now);
  check('三組（missing／l1_amount／ambiguous）', batch.embed.fields.length === 3);
  check('critical 排在 warn 前面', String(batch.embed.fields[2].name).includes('無法判定'));
  check('掉單那組顯示 2 筆', batch.embed.fields.some(f => String(f.name).includes('掉單') && String(f.name).includes('2 筆')));
  check('ids 涵蓋全部 4 筆', batch.ids.length === 4);
} finally {
  // ── 還原：測試資料刪掉、設定寫回原值 ──────────────────────────────
  const removed = db.prepare(`DELETE FROM recon_finding WHERE env=? AND note LIKE '${TAG}%'`).run(ENV).changes;
  for (const [k, v] of backup) {
    if (v === null) db.prepare('DELETE FROM recon_settings WHERE env=? AND key=?').run(ENV, k);
    else setSetting(k, v);
  }
  /**
   * ⚠️ 健康列也要清。測試會把 `notify` 那一列留在最後一個案例的狀態
   * （`not_configured`，failCount=4），而畫面上那盞燈會照實顯示——
   * **跑完一次測試就讓使用者看到一盞紅燈**，那正是這支檢查自己在防的東西。
   * 刪掉之後燈會回到「尚未跑過告警迴圈」，是正確的描述。
   */
  const lamps = db.prepare("DELETE FROM recon_source_health WHERE env=? AND source='notify'").run(ENV).changes;
  Object.assign(seam.deps, seam.original);
  console.log(`\n(已清除 ${removed} 筆測試 finding、${lamps} 列健康紀錄，${backup.size} 個設定還原)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
