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

const MAX = 8 * 60 * 60 * 1000;

console.log('\n3) ⚠️ 沒有 dispatchedAgentId 的 session：靠絕對上限保護，不是靠判活');
{
  // 這種 session 沒有 WS 可判斷，只能當活著（判死會誤殺）——**保護完全落在絕對上限**
  const a = decideAgentGone({ startedAt: T }, false, T + 999_999, GRACE, MAX);
  check('未逾上限 → 當活著（判死會誤殺）', a.agentAlive === true && a.agentGone === false);

  // 🚨 這是規格方抓到的洞：原本這條路徑**永遠 agentAlive:true**，於是心跳照樣被
  //    Python 自己的輪詢更新、逾時永遠不觸發，跟修之前一模一樣。而且這種 session
  //    （agent 自己啟動、沒走 hub 派工）正是最容易沒人看著、最容易變孤兒的那類。
  //
  // ⚠️ 舊的測試寫的是「沒有 dispatchedAgentId → 一律當活著，永不因此收尾」——
  //    它測的是**照設計被排除**，不是**安全**。那條測試在有洞的版本上是綠的，
  //    給了假的安心。這一節就是為了取代它。
  const b = decideAgentGone({ startedAt: T }, false, T + MAX + 1, GRACE, MAX);
  check('🚨 超過絕對上限 → **一樣收尾**（這是舊測試漏掉的）',
    b.agentGone === true && b.hardExpired === true);
  check('   而且 agentAlive=false（心跳不會再被續命）', b.agentAlive === false);
}

console.log('\n3b) 絕對上限跟所有判活邏輯獨立');
{
  // 就算 agent 連線好好的，超過上限一樣收——這一道不受任何偵測結果影響
  const a = decideAgentGone({ dispatchedAgentId: 'ag1', startedAt: T }, true, T + MAX + 1, GRACE, MAX);
  check('agent 連線正常但超過上限 → **照樣收尾**', a.agentGone === true && a.hardExpired === true);

  // 沒有 startedAt 的舊 session 不會被誤殺
  const b = decideAgentGone({ dispatchedAgentId: 'ag1' }, true, T + 999_999_999, GRACE, MAX);
  check('沒有 startedAt → 不因上限收尾（不猜）', b.hardExpired === false);
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
