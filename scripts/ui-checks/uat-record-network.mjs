/**
 * 錄製期間網路回報的端到端檢查：agent 的 WS 訊息 → server 收集 → /record/status 回傳。
 *
 * 用假的 agent 連線送事件，不需要真的開瀏覽器——重點是驗管線，不是驗 Playwright。
 *
 * ## register 的訊息格式
 * 是 agent_ready + operatorKey + agentToken，不是 register + ownerKey + token。
 * 我第一次照直覺猜，結果 server 靜默拒絕、只回「目前沒有連線中的 Local Agent」。
 *
 * 跑法：cd scripts/ui-checks && node uat-record-network.mjs
 */
// 驗證錄製期間的網路回報：從 agent 的 WS 訊息 → server 收集 → /record/status 回傳。
// 用假的 agent 連線送事件，不需要真的開瀏覽器。
import crypto from 'crypto';
import Database from 'better-sqlite3';
import WebSocket from 'ws';

const db = new Database('../../server/data.db');
const sid = db.prepare('SELECT sid FROM auth_sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 1').get(Date.now())?.sid;
if (!sid) { console.log('沒有有效登入 session'); process.exit(1) }

// 發一張測試 token 給假 agent 用（測完刪掉）
const owner = db.prepare('SELECT owner_key, owner_name FROM local_agent_tokens WHERE revoked=0 ORDER BY created_at DESC LIMIT 1').get();
const token = 'tla_' + crypto.randomBytes(32).toString('base64url');
const tokenId = 'VERIFY_' + Date.now().toString(36);
db.prepare('INSERT INTO local_agent_tokens (id, token_hash, owner_key, owner_name, label, created_at) VALUES (?,?,?,?,?,?)')
  .run(tokenId, crypto.createHash('sha256').update(token).digest('hex'), owner.owner_key, owner.owner_name, '【驗證用，測完刪】', Date.now());

const cleanup = () => { try { db.prepare('DELETE FROM local_agent_tokens WHERE id=?').run(tokenId) } catch {} };
process.on('exit', cleanup);

const ws = new WebSocket('ws://localhost:3010/ws/agent');
await new Promise(r => ws.on('open', r));
ws.send(JSON.stringify({
  type: 'agent_ready', agentId: 'VERIFY-RECNET', hostname: 'VERIFY-RECNET',
  operatorKey: owner.owner_key, operatorName: owner.owner_name,
  agentToken: token, capabilities: ['uat-record', 'backend-uat'], version: 'verify',
}));
await new Promise(r => setTimeout(r, 800));

// 開一個錄製 session（會派工給這個假 agent；它不會真的開瀏覽器，正好）
const startRes = await fetch('http://localhost:3000/api/osm-uat/record/start', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: `toppath_auth=${sid}` },
  body: JSON.stringify({ agentId: 'VERIFY-RECNET' }),
});
const start = await startRes.json();
console.log('開錄製:', JSON.stringify(start).slice(0, 160));
if (!start.ok) { cleanup(); process.exit(1) }
const sessionId = start.sessionId;

// 假 agent 回報 ready + 幾筆網路事件
ws.send(JSON.stringify({ type: 'backend_record_ready', sessionId }));
const CALLS = [
  { method: 'GET', url: 'http://uat-cp.osmslot.org/api/egm/list?page=1&t=999', urlPattern: 'http://uat-cp.osmslot.org/api/egm/list', status: 200, durationMs: 143, ts: Date.now() },
  { method: 'POST', url: 'http://uat-cp.osmslot.org/api/egm/update/12345', urlPattern: 'http://uat-cp.osmslot.org/api/egm/update/*', status: 200, durationMs: 88, ts: Date.now() + 1 },
  { method: 'POST', url: 'http://uat-cp.osmslot.org/api/egm/save', urlPattern: 'http://uat-cp.osmslot.org/api/egm/save', status: 500, durationMs: 2100, ts: Date.now() + 2 },
];
for (const call of CALLS) ws.send(JSON.stringify({ type: 'backend_record_net', sessionId, call }));
await new Promise(r => setTimeout(r, 900));

const st = await (await fetch(`http://localhost:3000/api/osm-uat/record/status/${sessionId}`, { headers: { Cookie: `toppath_auth=${sid}` } })).json();
console.log('\nstatus 回傳的 netCalls:', st.netCalls?.length ?? 0, '筆（送了', CALLS.length, '筆）');
for (const c of st.netCalls ?? []) {
  console.log(`  ${c.method.padEnd(5)} ${String(c.status).padEnd(4)} ${String(c.durationMs).padStart(5)}ms  ${c.urlPattern}`);
}
const ok = (st.netCalls?.length === CALLS.length)
  && st.netCalls.some(c => c.status === 500)
  && st.netCalls.every(c => c.urlPattern && !c.urlPattern.includes('?'));
console.log('\n判定:', ok ? '✅ 整條鏈路通（含非 2xx 與 pattern 化）' : '❌ 有問題');

// 收尾
await fetch(`http://localhost:3000/api/osm-uat/record/stop/${sessionId}`, { method: 'POST', headers: { Cookie: `toppath_auth=${sid}` } }).catch(() => {});
ws.close();
cleanup();
console.log('測試 token 已刪除');
process.exit(ok ? 0 : 1);
