/**
 * 後台對帳查不到資料——直接打真實 API 比對哪個參數是關鍵。
 *
 * 使用者回報：後台畫面同一天有 34 筆，我們的工具回 0 筆。
 *
 * 最可疑的是 `dateTime[]` 的格式。CLAUDE.md 有記載（用後台 DevTools 反推驗證過）：
 * 這支 API 要的是 **ISO UTC**（`2026-07-26T22:00:00.000Z`），不是空白分隔的
 * `YYYY-MM-DD HH:mm:ss`——而後台對帳送的正是後者。
 *
 * 但不猜，四種組合各打一次看誰回得到資料。
 *
 * ⚠️ 只讀不寫。用共用設定 meter_reconcile_config 的 osm_ 那組。
 * 跑法：node scripts/ui-checks/reconcile-param-probe.mjs [YYYY-MM-DD]
 */
import 'dotenv/config';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const db = new Database(path.join(root, 'server/data.db'));
const day = process.argv[2] || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });

const cfg = {};
for (const r of db.prepare("SELECT key, value FROM meter_reconcile_config WHERE key LIKE 'osm_%'").all()) {
  cfg[r.key.slice(4)] = r.value;
}
if (!cfg.token) { console.log('共用設定沒有 osm_token，先去 Performance Meter 對帳頁測一次連線'); process.exit(1) }

const base = (cfg.base_url || '').replace(/\/$/, '');
const origin = cfg.origin || 'https://qat-cp.osmslot.org';

/** 本地 YYYY-MM-DD HH:mm:ss → ISO UTC（台灣是 UTC+8） */
const toUtcIso = (d, h, m, s) => {
  const [y, mo, da] = d.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, da, h - 8, m, s)).toISOString();
};

const CASES = [
  ['空白分隔 + dateTimeType 0（目前的做法）', [`${day} 00:00:00`, `${day} 23:59:59`], '0'],
  ['ISO UTC + dateTimeType 0', [toUtcIso(day, 0, 0, 0), toUtcIso(day, 23, 59, 59)], '0'],
  ['空白分隔 + dateTimeType 1', [`${day} 00:00:00`, `${day} 23:59:59`], '1'],
  ['ISO UTC + dateTimeType 1', [toUtcIso(day, 0, 0, 0), toUtcIso(day, 23, 59, 59)], '1'],
];

console.log(`查詢日期：${day}（台北）\n`);
console.log(`${'組合'.padEnd(40)}${'total'.padStart(8)}${'items'.padStart(8)}   code`);
console.log('-'.repeat(70));

for (const [label, [from, to], dtType] of CASES) {
  const params = new URLSearchParams({
    'clientMachineName': '', 'playerId': '', 'playerName': '', 'orderId': '',
    'page': '1', 'pageSize': '10', 'dateTimeType': dtType,
    'playerstudioid': cfg.playerstudioid || 'cp,wf,tbr,tbp,ncl,bpo,mdr,dhs,cf,np,pf,igo,np2,ALL',
    'bgType': '0', 'dataType': '0', 'isall': 'false',
    'channelId': cfg.channel_id || '873',
  });
  params.append('dateTime[]', from);
  params.append('dateTime[]', to);

  try {
    const r = await fetch(`${base}/egm/reports/gameRecordList?${params}`, {
      method: 'POST',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        origin, referer: `${origin}/`,
        token: cfg.token, lastlogintime: cfg.lastlogintime || '',
      },
    });
    const d = await r.json();
    const total = d?.data?.total ?? d?.data?.totalCount ?? '—';
    const items = d?.data?.items?.length ?? 0;
    console.log(`${label.padEnd(38)}${String(total).padStart(8)}${String(items).padStart(8)}   ${d?.code ?? r.status}`);
    if (items > 0 && !globalThis.__shown) {
      globalThis.__shown = true;
      console.log(`      ↳ 第一筆：${JSON.stringify(d.data.items[0]).slice(0, 150)}`);
    }
  } catch (e) {
    console.log(`${label.padEnd(38)}   ❌ ${e instanceof Error ? e.message : e}`);
  }
}

console.log('\n有 items 的那一組就是正確參數；全部 0 的話問題在別處（例如 token 過期或 channel 不對）。');
