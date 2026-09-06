/**
 * scripts/ui-checks/agent-gone-grace.mjs
 *
 * 驗「agent 斷線 → 收尾 session」的判定。
 *
 * ⚠️ **為什麼要抽成純函式來測**：這段邏輯要有真的 agent 斷線才跑得到，
 * 不抽出來就只能等上線後出事才發現。而它有兩個相反的失敗方向，
 * 兩個都很貴：
 *
 *   殺太慢 → 孤兒 Python 繼續跑（實測發生過：停止後多寫 2,762 筆）
 *   殺太快 → 每次 `pm2 restart` 推程式碼都殺掉一輪正在跑的長壓測
 *
 * 所以「會殺」跟「不會誤殺」都要驗，只驗前者等於只做了一半。
 */
import { pathToFileURL } from 'url';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mod = await import(pathToFileURL(path.join(root, 'dist-server/server/routes/autospin.js')).href);
const { decideAgentGone } = mod;

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++;
};

const GRACE = 90_000;
const T = 1_788_700_000_000;

console.log('1) 會殺：agent 真的不見了');
{
  // 第一次發現斷線 → 開始計時，還不殺
  const a = decideAgentGone({ dispatchedAgentId: 'ag1' }, false, T, GRACE);
  check('剛斷線 → 還不收尾，但開始計時', !a.agentGone && a.goneSince === T);
  check('剛斷線 → agentAlive=false（心跳不會被續命）', a.agentAlive === false);

  // 超過寬限期 → 收尾
  const b = decideAgentGone({ dispatchedAgentId: 'ag1', agentGoneSince: T }, false, T + GRACE + 1, GRACE);
  check('超過寬限期 → 收尾', b.agentGone === true);
}

console.log('\n2) ⚠️ 不會誤殺：pm2 restart 這種短暫斷線');
{
  // 斷線 60 秒（小於 90 秒寬限）→ 不能殺
  const a = decideAgentGone({ dispatchedAgentId: 'ag1', agentGoneSince: T }, false, T + 60_000, GRACE);
  check('斷線 60 秒（< 寬限 90 秒）→ **不收尾**', a.agentGone === false);

  // 重連回來 → 計時清掉，下次再斷要重新算
  const b = decideAgentGone({ dispatchedAgentId: 'ag1', agentGoneSince: T }, true, T + 60_000, GRACE);
  check('重連之後計時被清掉', b.goneSince === undefined && b.agentAlive === true);
  const c = decideAgentGone({ dispatchedAgentId: 'ag1', agentGoneSince: undefined }, false, T + 60_000, GRACE);
  check('清掉之後再斷線 → 從新的時間點重新計時，不會沿用舊的', c.agentGone === false && c.goneSince === T + 60_000);
}

console.log('\n3) 伺服器端 fallback session 不適用這個機制');
{
  const a = decideAgentGone({}, false, T + 999_999, GRACE);
  check('沒有 dispatchedAgentId → 一律當活著，永不因此收尾', a.agentAlive === true && a.agentGone === false);
}

console.log('\n4) ⚠️ 兩道保險的時序：心跳逾時不能搶在寬限期之前開槍');
{
  // 讀原始碼確認常數關係——這兩個值一旦有人單獨調，就會回到「寬限期形同虛設」
  const { readFileSync } = await import('fs');
  const src = readFileSync(path.join(root, 'server/routes/autospin.ts'), 'utf8');
  const usesGrace = /const HEARTBEAT_TIMEOUT = AGENT_GONE_GRACE_MS \+/.test(src);
  check('HEARTBEAT_TIMEOUT 是由寬限期推導的，不是各寫一個數字', usesGrace,
    usesGrace ? '' : '⚠️ 兩個計時器會互相打架：掃描先開槍，寬限期等於白設');

  const noBlindHeartbeat = !/if \(s\.status === 'running'\) s\.lastHeartbeat = Date\.now\(\)\s*\n\s*res\.json/.test(src);
  check('should-stop 不再無條件更新心跳（殭屍不能自己續命）', noBlindHeartbeat);
}

console.log(`\n${fail === 0 ? '全部通過' : fail + ' 項未過'}（pass ${pass} / fail ${fail}）`);
process.exit(fail ? 1 : 0);
