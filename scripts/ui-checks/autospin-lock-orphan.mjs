/**
 * scripts/ui-checks/autospin-lock-orphan.mjs
 *
 * 守兩件 2026-09-07 真的害使用者卡住的事：
 *
 *   ① 孤兒鎖：鎖跟它保護的 session 存在兩張表、各自獨立復原。
 *      鎖回來、session 沒回來 → 那個帳號被鎖 24 小時。使用者一天踩兩次。
 *
 *   ② 控制狀態只在記憶體：`pauseRequested` 靠 5 秒一次的快照落 DB，
 *      worker 在那個空窗裡重啟就把使用者按下的暫停弄丟，機台自己繼續跑，
 *      而畫面徽章還停在「已暫停」。
 *
 * ⚠️ **這支跑完會完整還原 heavy_tasks 與 autospin_agent_sessions。**
 */
import { pathToFileURL } from 'url';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { readFileSync } from 'fs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const Database = require('better-sqlite3');
const db = new Database(path.join(root, 'server/data.db'));

const guard = await import(pathToFileURL(path.join(root, 'dist-server/server/heavy-task-guard.js')).href);
const { autospinLockHasLiveOwner, releaseHeavyTaskById, listRunningAutospinLocks } = guard;

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++;
};

const TEST_PREFIX = '__test_orphan_';
const cleanup = () => {
  db.prepare("DELETE FROM heavy_tasks WHERE id LIKE '__test_orphan_%'").run();
  db.prepare("DELETE FROM autospin_agent_sessions WHERE id LIKE '__test_orphan_%'").run();
};
cleanup();

const mkSession = (id, opts = {}) => {
  const status = opts.status ?? 'running';
  const userLabel = opts.userLabel ?? 'TestUser';
  db.prepare('INSERT OR REPLACE INTO autospin_agent_sessions (id, data, updatedAt) VALUES (?, ?, ?)')
    .run(id, JSON.stringify({ id, status, userLabel, lastHeartbeat: Date.now() }), Date.now());
};

const NOW = Date.now();
const GRACE = 5 * 60 * 1000;

try {
  console.log('1) 鎖有綁 session id 時：直接看那個 session 還在不在');
  {
    mkSession(TEST_PREFIX + 'live');
    mkSession(TEST_PREFIX + 'dead', { status: 'stopped' });
    // ⚠️ 起始時間要拉到「剛建立保護期」之外，否則測到的是下面 1b 那道寬限期，
    //    而不是這裡真正要驗的判斷——那會讓這三條變成永遠通過的裝飾品。
    check('綁到的 session 還在 running → 有主人',
      autospinLockHasLiveOwner(TEST_PREFIX + 'live', 'TestUser', NOW - 61_000, NOW) === true);
    check('🚨 綁到的 session 已停止 → 判成孤兒',
      autospinLockHasLiveOwner(TEST_PREFIX + 'dead', 'TestUser', NOW - 61_000, NOW) === false);
    check('🚨 綁到的 session 完全不存在 → 判成孤兒',
      autospinLockHasLiveOwner(TEST_PREFIX + 'nope', 'TestUser', NOW - 61_000, NOW) === false);
  }

  console.log('\n1b) 🚨 剛建立的鎖一律不判死 —— 真的害使用者斷線的那個 bug');
  // session 建立時只在記憶體，最多 5 秒後才被快照寫進 DB。而判定讀的就是 DB，
  // 所以一個「剛建立、完全正常」的 session 在那個空窗裡看起來就像不存在。
  // 實測：鎖建立後 2 秒就被判成孤兒清掉，使用者的 AutoSpin 當場跟伺服器脫節、日誌停住。
  {
    check('🚨 鎖剛建立 2 秒、綁的 session 還沒被快照寫進去 → 不判死',
      autospinLockHasLiveOwner(TEST_PREFIX + 'not_yet_snapshotted', 'TestUser', NOW - 2000, NOW) === true);
    check('🚨 同一筆過了保護期之後 → 才判成孤兒（保護期不能變成永久豁免）',
      autospinLockHasLiveOwner(TEST_PREFIX + 'not_yet_snapshotted', 'TestUser', NOW - 61_000, NOW) === false);
  }

  console.log('\n2) ⚠️ 舊資料（沒綁 session id）不能直接判成孤兒');
  // lock_key 這欄以前從沒被寫過，升級當下所有既有的鎖都是 null。
  // 一律判死的話，會把升級那一刻正在跑的 session 保護整個拔掉。
  {
    check('沒綁 session、但有同帳號的 running session → 當作有主人',
      autospinLockHasLiveOwner(null, 'TestUser', NOW - GRACE * 2, NOW) === true);
    check('沒綁 session、剛建立不久（寬限期內）→ 不判死',
      autospinLockHasLiveOwner(null, '沒有這個人', NOW - 1000, NOW) === true);
    check('沒綁 session、且已超過寬限期、也沒有同帳號 session → 才判成孤兒',
      autospinLockHasLiveOwner(null, '沒有這個人', NOW - GRACE - 1, NOW) === false);
  }

  console.log('\n3) 釋放：只動 running 的，而且留下「非正常結束」的痕跡');
  {
    const id = TEST_PREFIX + 'lock1';
    db.prepare('INSERT INTO heavy_tasks (id,user_key,user_label,type,label,status,created_at,started_at,finished_at,error,lock_key)'
      + " VALUES (?,?,?,?,?,'running',?,?,NULL,NULL,?)")
      .run(id, 'TestUser', 'TestUser', 'autospin-agent', 'AutoSpin Agent', NOW, NOW, TEST_PREFIX + 'nope');
    check('釋放前列得到它', listRunningAutospinLocks().some(r => r.id === id));
    check('釋放回報成功', releaseHeavyTaskById(id, '測試') === true);
    const row = db.prepare('SELECT status, error FROM heavy_tasks WHERE id = ?').get(id);
    check('狀態是 error 不是 done（它不是正常結束）', row.status === 'error', `status=${row.status}`);
    check('留下原因', !!row.error);
    check('🚨 重複釋放回 false，不會假裝又清了一次', releaseHeavyTaskById(id, '測試') === false);
  }

  console.log('\n4) ⚠️ 只管 autospin-agent，不要掃到別的重任務');
  // 其他型別可能沒有 session 的概念，或鎖本身就是唯一真相，誤清比留著危險。
  {
    const id = TEST_PREFIX + 'other';
    db.prepare('INSERT INTO heavy_tasks (id,user_key,user_label,type,label,status,created_at,started_at,finished_at,error,lock_key)'
      + " VALUES (?,?,?,?,?,'running',?,?,NULL,NULL,NULL)")
      .run(id, 'TestUser', 'TestUser', 'machine-test', 'Machine Test', NOW, NOW);
    check('機測的鎖不會出現在 autospin 清單裡', !listRunningAutospinLocks().some(r => r.id === id));
  }

  console.log('\n5) 控制狀態必須「當場」落 DB，不能等 5 秒快照');
  {
    const src = readFileSync(path.join(root, 'server/routes/autospin.ts'), 'utf8');
    const sites = [
      ['暫停', /s\.pauseRequested = true\s*\r?\n\s*markControlChanged\(s\)/],
      ['繼續', /s\.pauseRequested = false\s*\r?\n\s*markControlChanged\(s\)/],
      ['改間隔', /s\.spinIntervalOverride = isNaN\(v\)[^\n]*\r?\n\s*markControlChanged\(s\)/],
    ];
    for (const [name, re] of sites) check(`${name} 有當場落 DB`, re.test(src));
    const stopSites = (src.match(/s\.stopRequested = true\s*\r?\n\s*markControlChanged\(s\)/g) ?? []).length;
    check('兩個停止路徑（stop-all／hub-stop）都有落 DB', stopSites === 2, `找到 ${stopSites} 處`);

    check('🚨 定時快照不准用舊控制狀態覆寫新的',
      /stored\.controlVersion \?\? 0\) > \(s\.controlVersion \?\? 0\)/.test(src));
    // 🚨 時鐘往回跳（NTP 校正）時，剛寫入的暫停會拿到比 DB 更小的時間戳
    //    → 快照判定「DB 比較新」→ 用舊值蓋掉使用者剛按的暫停。
    //    那正是這一版要修的 bug 原樣復活，而且只在時鐘飄動時發生、極難查。
    check('🚨 用單調遞增的版本號判斷新舊，不用時間戳（時鐘往回跳會讓舊意圖看起來比較新）',
      /s\.controlVersion = \(s\.controlVersion \?\? 0\) \+ 1/.test(src)
      && !/controlUpdatedAt \?\? 0\) > \(/.test(src));
    check('背景掃描有防重疊，而且歸位寫在 finally（放 try 尾端的話拋一次錯就永久停擺）',
      /if \(orphanScanRunning\) return/.test(src)
      && /finally \{[\s\S]{0,300}orphanScanRunning = false/.test(src));
    check('鎖有綁到它保護的 session（否則第 1 節那些判斷全部失效）',
      /bindHeavyTaskOwner\(heavyTask\.token, sessionId\)/.test(src));
    check('🚨 session 一建立就立刻落 DB，不等 5 秒快照（從源頭關掉那個空窗）',
      /persistNewSession\(created\)/.test(src));
    check('背景掃描不依賴任何請求（setInterval，不是掛在某支 API 裡）',
      /setInterval\(\(\) => \{[\s\S]{0,500}listRunningAutospinLocks\(\)/.test(src));
  }

  console.log('\n5b) 🚨 模組載入不可以有破壞性副作用');
  {
    const guardSrc = readFileSync(path.join(root, 'server/heavy-task-guard.ts'), 'utf8');
    // 那個 restore 區塊會在**任何 import 這支檔案的 process** 執行——包含 `npm run build`
    // 與檢查腳本。判定寫在那裡時，我跑 build 就把使用者兩秒前建立的鎖清掉了。
    // 建置工具不該有能力改動正式的鎖狀態。
    const restoreBlock = guardSrc.slice(0, guardSrc.indexOf('export function tryStartHeavyTask'));
    check('🚨 模組載入的 restore 不做 autospin 孤兒判定',
      !/autospinLockHasLiveOwner/.test(restoreBlock));
    check('孤兒清除只留在定時掃描裡（短命的 build／測試 process 活不到觸發）',
      /listRunningAutospinLocks\(\)/.test(readFileSync(path.join(root, 'server/routes/autospin.ts'), 'utf8')));
  }

  console.log('\n6) agent 端');
  {
    const py = readFileSync(path.join(root, 'server/python/toppath-agent.py'), 'utf8');
    check('重連時有帶 reconnect 旗標（伺服器只有看到它才會沿用暫停）',
      /'reconnect': True/.test(py) && /'prevSessionId': session_id/.test(py));
    check('🚨 Spin 失敗路徑有退避，不是全速空轉',
      /wait_with_stop\(backoff\)/.test(py) && /wait_with_stop\(min\(spin_interval, 2\.0\)\)/.test(py));
    check('⚠️ 退避用可被停止打斷的等待，不是 time.sleep（否則按停止要等兩分鐘）',
      /def wait_with_stop[\s\S]{0,500}stop_flag\.wait\(timeout=/.test(py));
    check('成功一次就把退避階梯歸零', /mp\['reload_attempts'\] = 0/.test(py));
  }
} finally {
  cleanup();
  const left = db.prepare("SELECT COUNT(*) n FROM heavy_tasks WHERE id LIKE '__test_orphan_%'").get().n
    + db.prepare("SELECT COUNT(*) n FROM autospin_agent_sessions WHERE id LIKE '__test_orphan_%'").get().n;
  console.log(`\n測試資料已清除（殘留 ${left} 筆）`);
}

console.log(`\n${fail === 0 ? '全部通過' : fail + ' 項未過'}（pass ${pass} / fail ${fail}）`);
process.exit(fail ? 1 : 0);
