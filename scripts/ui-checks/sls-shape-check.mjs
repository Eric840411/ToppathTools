/**
 * 驗三路對帳的第一路：SLS recordBet 的**真實欄位形狀**，跟畫面上提供的選項對不對得上。
 *
 * 為什麼這是最該先驗的：比對群組的欄位是使用者從下拉選單挑的，選項寫死在
 * 前端的 FIELD_CATALOG。如果那些路徑跟真實 log 對不上，比對會**永遠回
 * missing_data**——而且不會報錯，看起來就像「還沒有資料」。
 * 這種錯誤可以放很久沒人發現。
 *
 * ⚠️ 只讀不寫。查詢窗口刻意拉長：`testSlsRecordBetConnection` 固定只查 60 分鐘，
 *    沒在跑 AutoSpin 時一定是 0 筆，看不到真實資料長怎樣。
 *
 * ⚠️ 必須從 repo 根目錄跑（dist-server 的模組用相對路徑開 DB）。
 * 跑法：node scripts/ui-checks/sls-shape-check.mjs [天數]
 */
// ⚠️ 憑證是從 env var 讀的，而 env var 是 server 啟動時由 dotenv 載進來的。
// 獨立腳本不載這行的話，會拿到「SLS 憑證尚未設定」——那是腳本自己沒載，
// 不是憑證真的沒設，很容易誤判成環境問題。
import 'dotenv/config';
import { pathToFileURL, fileURLToPath } from 'url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const days = Number(process.argv[2] || 30);

const sls = await import(pathToFileURL(path.join(root, 'dist-server/server/lib/sls.js')).href);

const to = Math.floor(Date.now() / 1000);
const from = to - days * 24 * 3600;
console.log(`查詢範圍：過去 ${days} 天\n`);

let rows;
try {
  rows = await sls.fetchRecordBet(from, to, undefined, 5);
} catch (e) {
  console.log('❌ 查詢失敗：', e instanceof Error ? e.message : String(e));
  process.exit(1);
}

console.log(`查到 ${rows.length} 筆`);
if (!rows.length) {
  console.log('\n⚠️ 這個範圍內沒有資料，驗不了欄位形狀。');
  console.log('   可能是：這段期間真的沒人下注／logstore 設定指到別的環境／保留期已過。');
  console.log('   在拿到真實樣本之前，「比對群組的欄位對不對」這件事是**未驗證**的。');
  process.exit(2);
}

const sample = rows[0];
console.log('\n=== 第一筆的頂層欄位 ===');
console.log(Object.keys(sample).join(', '));

const raw = sample.raw ?? sample;
const get = (obj, p) => p.split('.').reduce((a, k) => (a && typeof a === 'object' ? a[k] : undefined), obj);

// 畫面上 FIELD_CATALOG 提供給使用者挑的 SLS 欄位
const EXPECTED = [
  'requestJSON.amount', 'requestJSON.betTimestamp', 'requestJSON.initialMoneyMud',
  'requestJSON.machineId', 'requestJSON.moneyAfter', 'requestJSON.payout',
  'requestJSON.payoutTimestamp', 'requestJSON.remainingMoneyMud', 'requestJSON.roundId',
  'requestJSON.usedCash', 'requestJSON.usedMoneyMud', 'requestJSON.validBet',
];

console.log('\n=== 畫面提供的欄位 vs 真實資料 ===');
let missing = 0;
for (const p of EXPECTED) {
  const v = get(raw, p);
  const ok = v !== undefined;
  if (!ok) missing++;
  const shown = ok ? JSON.stringify(v).slice(0, 40) : '—';
  console.log(`  ${ok ? '✅' : '❌'} ${p.padEnd(32)} ${shown}`);
}

console.log('');
if (missing === 0) {
  console.log('✅ 畫面上提供的欄位全部對得到真實資料——比對群組不會因為路徑錯而永遠 missing_data');
} else {
  console.log(`❌ 有 ${missing} 個欄位在真實資料裡找不到。`);
  console.log('   用到這些欄位的比對群組會**永遠停在 missing_data 且不報錯**。');
  console.log('\n真實資料實際長這樣（第一層）：');
  const reqJson = get(raw, 'requestJSON');
  if (reqJson && typeof reqJson === 'object') {
    console.log('  requestJSON 的欄位:', Object.keys(reqJson).join(', '));
  } else {
    console.log('  requestJSON 不存在或不是物件，實際頂層:', Object.keys(raw).join(', '));
  }
}
process.exit(missing ? 1 : 0);
