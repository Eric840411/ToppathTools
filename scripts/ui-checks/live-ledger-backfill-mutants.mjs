/**
 * scripts/ui-checks/live-ledger-backfill-mutants.mjs
 *
 * **突變測試**：把 `live-ledger-fetch.js` 一處一處改壞，確認
 * `live-ledger-backfill.mjs` 真的會轉紅。
 *
 * 🚨 **為什麼需要這支**：19 項全綠只證明「規則有被執行」，證明不了「規則守得住」。
 * 這個 repo 已經吃過一次虧——`live-ledger-cycle.mjs` 的保留測試原本只寫 106 筆
 * （上限是 500），**把整段保留邏輯拿掉測試照樣全綠**，是突變測試抓到的空斷言。
 *
 * 每個突變體都對應一種「真的可能寫出來的錯」，尤其是 9/8 死鎖的幾種錯誤修法：
 * 提高上限、跳過壞掉的段、把水位直接推到現在。這些改法都能讓採集「看起來恢復了」，
 * 代價是資料裡多一段沒人知道的空洞——所以必須有測試擋著。
 *
 * 突變體存活（測試照樣全綠）= 那條防線是假的，這支就會失敗。
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(root, 'dist-server/server/live-ledger-fetch.js');
const TEST = path.join(root, 'scripts/ui-checks/live-ledger-backfill.mjs');

/**
 * 每個突變體：`find` 必須在編譯產物裡**唯一**命中，否則算設定錯誤而不是通過
 * （找不到就替換不到，突變體等於沒生效，會假裝被殺掉）。
 */
const MUTANTS = [
  {
    id: 'M1', kills: '永遠截斷時水位不前進',
    desc: '截斷的段照樣推水位、照樣往前走（「跳過壞掉的段」那種修法）',
    find: '        if (out.reachedLimit) {\n',
    repl: '        if (false) {\n',
  },
  {
    id: 'M2', kills: '歷史段 0 筆也要推水位',
    desc: '歷史段抓到 0 筆就不推水位 → 空檔會讓游標永遠卡住（死鎖回歸）',
    find: '        const isHistorical = segTo < nowSrv - SETTLE_MS;',
    repl: '        const isHistorical = false;',
  },
  {
    id: 'M3', kills: '最新段 0 筆不推水位',
    desc: '最新段 0 筆也推水位 → 後台還沒吐出來的局被永久跳過',
    find: '        const advanceTo = isHistorical ? segTo : (out.maxTs ?? 0);',
    repl: '        const advanceTo = segTo;',
  },
  {
    id: 'M4', kills: '9 天缺口能補完（9/8 死鎖的回歸）',
    desc: '截斷就放棄、不對半切 → 大窗永遠補不完（這就是 9/8 的原始 bug）',
    find: '            if (span <= MIN_SEGMENT_MS)\n                break;',
    repl: '            if (true)\n                break;',
  },
  {
    id: 'M5', kills: '補過的區間沒有空洞',
    desc: '每段往前多跳一秒 → 覆蓋範圍出現看不見的空洞',
    find: '        cursor = segTo;',
    repl: '        cursor = segTo + 1000;',
  },
  {
    id: 'M6', kills: '後續段不再重複試大窗（截斷次數只有第一段那 2 次）',
    desc: '不記住切到多小 → 每段都重新從 4h 試起，對後台多打幾百次註定失敗的請求',
    find: '            effSpan = span;',
    repl: '            effSpan = SEGMENT_MS;',
  },
  {
    id: 'M7', kills: '上界換到後台軸（用量到的 120100ms，不是寫死的 60s）',
    desc: '上界回到本機時鐘 → 偏移 120s 時最新一分鐘的局查不到（修好前的行為）',
    find: '    const nowSrv = nowOnObservedAxis(env, now);',
    repl: '    const nowSrv = now;',
  },
  {
    id: 'M8', kills: '下界不重複補償（wm 已經在後台軸上）',
    desc: '下界也加偏移 → 兩邊都補償，窗整個往未來平移、漏掉舊的那頭',
    find: '        fromMs: wm > 0 ? wm - OVERLAP_SEC * 1000 : nowSrv - COLD_START_SEC * 1000,',
    repl: '        fromMs: wm > 0 ? (wm + (nowSrv - now)) - OVERLAP_SEC * 1000 : nowSrv - COLD_START_SEC * 1000,',
  },
];

const original = fs.readFileSync(SRC, 'utf8');
let killed = 0, survived = 0, broken = 0;
const problems = [];

console.log(`\n突變測試：${MUTANTS.length} 個突變體\n`);

for (const m of MUTANTS) {
  const hits = original.split(m.find).length - 1;
  if (hits !== 1) {
    console.log(`  BROKEN  ${m.id}  找到 ${hits} 處（需要剛好 1 處）——突變體沒生效，不算通過`);
    broken++; problems.push(`${m.id} 命中 ${hits} 處`);
    continue;
  }

  const mutantPath = path.join(root, `dist-server/server/zz-mutant-${m.id}-live-ledger-fetch.js`);
  fs.writeFileSync(mutantPath, original.replace(m.find, m.repl));

  // 突變檔跟本尊同目錄，所以裡面的相對 import（'./shared.js' 等）照樣解析得到
  const rel = path.relative(root, mutantPath).split(path.sep).join('/');
  const r = spawnSync(process.execPath, [TEST], {
    cwd: root,
    env: { ...process.env, LL_BACKFILL_TARGET: rel },
    encoding: 'utf8',
    timeout: 120_000,
  });
  fs.unlinkSync(mutantPath);

  const out = (r.stdout || '') + (r.stderr || '');
  const died = r.status !== 0;
  // 不只看「有沒有紅」，還要看**紅在該紅的那一條**——否則換個地方壞掉也會被當成殺死
  const killedByRight = out.includes(`FAIL  ${m.kills}`);

  if (died && killedByRight) {
    console.log(`  KILLED  ${m.id}  ${m.desc}`);
    console.log(`          ↳ 被「${m.kills}」抓到`);
    killed++;
  } else if (died) {
    console.log(`  KILLED* ${m.id}  ${m.desc}`);
    console.log(`          ↳ ⚠️ 有轉紅，但不是預期的那條（預期「${m.kills}」）`);
    killed++; problems.push(`${m.id} 被非預期的斷言抓到`);
  } else {
    console.log(`  SURVIVED ${m.id}  ${m.desc}`);
    console.log(`          ↳ 🚨 測試照樣全綠 → 「${m.kills}」這條防線是假的`);
    survived++; problems.push(`${m.id} 存活：${m.kills}`);
  }
}

console.log(`\n結果：${killed} killed, ${survived} survived, ${broken} broken`);
if (problems.length) {
  console.log('要處理的：');
  for (const p of problems) console.log('  ·', p);
}
process.exit(survived || broken ? 1 : 0);
