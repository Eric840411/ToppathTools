/**
 * 版本驗證表的測試。跑法：npx tsx server/osm-verify.test.ts
 * 記憶體 DB＋假 Meegle CLI＋真的 HTTP（buildOsmVerifyRouter 掛在臨時 express 上）。
 * 另外拿 osm-qa-agent 的 scripts/verify-form/pull-events.cjs（只讀 require、資料目錄指到暫存）實際打一次，確認契約相容。
 * fixture 全是合成的——repo 公開，不放真實驗證表內容。
 */
import Database from 'better-sqlite3'
import express from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import type { AddressInfo } from 'net'
import {
  initOsmVerifySchema, createBatch, updateBatch, createItem, updateItem, bindRelease, markReleased, checkBatch, insertTicketClaim, claimTicket,
  finishTicket, listEvents, ackEvent, getBatch, regenerateEventKey, releaseDeleteBlocker, setPlatformMap, getTicket, latestTicket,
} from './osm-verify-store.js'
import { upsertTab, addComponent, createRelease, deleteRelease, getRelease } from './osm-release-store.js'
import { buildOsmVerifyRouter } from './osm-verify-router.js'
import { parseVerifySheet, applyVerifySections } from './osm-verify-import.js'
import { releaseCheck, splitPlatforms, resolveCreateValues, ticketKey, keyLine } from '../shared/osm-verify-rules.js'
import type { CliResult } from './meegle-cli.js'

let pass = 0
const fails: string[] = []
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('✅ ' + name) }
  else { fails.push(`${name} | got: ${g} | want: ${w}`); console.log(`❌ ${name} | got: ${g} | want: ${w}`) }
}

const ITEM = { platform: 'H5,PC', type: 'OSM', description: '新增遊戲 demo', env: 'QAT', result: '驗證通過', okCount: 1, verifier: '測試員', attachments: '', remark: '' }

function freshDb() {
  const db = new Database(':memory:')
  initOsmVerifySchema(db)
  upsertTab(db, { id: 'osm', name: 'OSM', showComponents: true, showSql: false, showResult: false })
  const h5 = addComponent(db, { tabId: 'osm', name: 'H5' })
  const pc = addComponent(db, { tabId: 'osm', name: 'PC' })
  const relId = createRelease(db, { tabId: 'osm', statusId: 1, testDate: '2026-11-18', releaseDate: '2026-11-20', content: '合成內容', sqlText: '', resultText: '',
    values: [{ componentId: h5, state: 'updated', version: '1.0.1' }, { componentId: pc, state: 'updated', version: '3.0.1' }] }, 'tester')
  return { db, relId }
}

// ─── 共用規則 ─────────────────────────────────────────────────────────────────
{
  eq('平台拆分（逗號、全形逗號、頓號）', splitPlatforms('H5, PC，Middle、H5'), ['H5', 'PC', 'Middle'])
  const rel = [{ id: 1, valid: true, tabId: 'osm', tabName: 'OSM', updatedComponents: ['H5 Client'] }]
  eq('沒對應時只認完全同名：H5 ≠ H5 Client → 未涵蓋', releaseCheck([{ platform: 'H5' }], rel, {}).uncovered, ['H5'])
  eq('平台對應 分頁/元件 → 涵蓋', releaseCheck([{ platform: 'H5' }], rel, { H5: ['osm/H5 Client'] }).ok, true)
  eq('對應的元件沒有更新 → 未涵蓋', releaseCheck([{ platform: 'PC' }], rel, { PC: ['osm/PC Client'] }).uncovered, ['PC'])
  eq('已刪除的版本紀錄不算有效', releaseCheck([{ platform: 'osm' }], [{ ...rel[0], valid: false }], {}).missingBinding, true)
  const schema = { typeKey: 't', unsupported: [], fields: [{ key: 'f_sel', name: '任務類型', kind: 'select' as const, options: [{ id: 'o1', name: 'BUG' }] }, { key: 'f_rel', name: '關聯任務', kind: 'related' as const }] }
  eq('開單欄位：選項不存在 → 擋', Object.keys(resolveCreateValues(schema, { f_sel: 'x', f_rel: '12' }).errors), ['f_sel'])
  eq('開單欄位：關聯要數字', Object.keys(resolveCreateValues(schema, { f_sel: 'o1', f_rel: 'abc' }).errors), ['f_rel'])
  eq('開單欄位：通過', resolveCreateValues(schema, { f_sel: 'o1', f_rel: '12' }).fields, [{ field_key: 'f_sel', field_value: 'o1' }, { field_key: 'f_rel', field_value: '12' }])
}

// ─── 冪等 key 唯一搶占 ───────────────────────────────────────────────────────
{
  const { db } = freshDb()
  const b = createBatch(db, { year: 2026, batch: '1120', publishStatus: 'draft', prodVersion: '' }, 'a') as { id: string }
  const it = createItem(db, b.id, ITEM, 'a') as { id: number }
  const base = { itemId: it.id, batchId: b.id, seq: 1, key: ticketKey(b.id, it.id, 1), space: 'prod', typeKey: 't', name: 'n', actor: 'a@x', label: 'A', bindingRev: 'r1', now: Date.now() }
  eq('第一次搶占成功', !!insertTicketClaim(db, base), true)
  eq('同一把 key 第二次搶占 → 拿不到（DB 唯一約束，不覆蓋）', insertTicketClaim(db, { ...base, seq: 2 }), null)
  eq('同一項目同 seq 也拿不到', insertTicketClaim(db, { ...base, key: 'other' }), null)
  const c2 = claimTicket(db, { itemId: it.id, mode: 'create', actor: 'b@x', label: 'B', bindingRev: 'r2', space: 'prod', typeKey: 't', name: 'n' })
  eq('開單中再按開單 → busy', 'reason' in c2 ? c2.reason : 'ok', 'busy')
}

// ─── 開單流程：unknown 不自動重送、確認重送沿用 key、再開一張才換 key ─────────
{
  const { db } = freshDb()
  const b = createBatch(db, { year: 2026, batch: '1121', publishStatus: 'draft', prodVersion: '' }, 'a') as { id: string }
  const it = createItem(db, b.id, ITEM, 'a') as { id: number }
  const claim = (mode: 'create' | 'resend' | 'again', actor = 'a@x', bindingRev = 'r1') => claimTicket(db, { itemId: it.id, mode, actor, label: actor, bindingRev, space: 'prod', typeKey: 't', name: 'n' })
  const c1 = claim('create')
  const t1 = 'ticket' in c1 ? c1.ticket : null
  finishTicket(db, t1!.id, { kind: 'unknown', message: '逾時' })
  eq('逾時 → 結果不明', getTicket(db, t1!.id)?.status, 'unknown')
  const c2 = claim('create')
  eq('結果不明時再按開單 → 不重送，要使用者決定', 'reason' in c2 ? c2.reason : 'ok', 'unknown')
  eq('別人確認重送 → 擋（不能用別人的身分沿用同一把 key）', (() => { const r = claim('resend', 'b@x'); return 'reason' in r ? r.reason : 'ok' })(), 'not_owner')
  eq('綁定換過 → 擋', (() => { const r = claim('resend', 'a@x', 'r9'); return 'reason' in r ? r.reason : 'ok' })(), 'binding_changed')
  const c3 = claim('resend')
  eq('原開單人確認重送 → 沿用同一把 key', 'ticket' in c3 ? [c3.ticket.key, c3.reused, c3.ticket.attempts] : c3, [t1!.key, true, 2])
  finishTicket(db, t1!.id, { kind: 'created', workItemId: '900001', url: '' })
  const c4 = claim('create')
  eq('已開過再按開單 → already_created', 'reason' in c4 ? c4.reason : 'ok', 'already_created')
  const c5 = claim('again', 'b@x', 'rb')
  eq('再開一張 → 新 key（seq 2）', 'ticket' in c5 ? [c5.ticket.key !== t1!.key, c5.ticket.seq] : c5, [true, 2])
}

// ─── 上正式：必須綁版本、平台要涵蓋；被引用的版本紀錄不能刪 ─────────────────
{
  const { db, relId } = freshDb()
  const b = createBatch(db, { year: 2026, batch: '1122', publishStatus: 'verified', prodVersion: 'Center:2.1' }, 'a') as { id: string }
  createItem(db, b.id, ITEM, 'a')
  const r1 = markReleased(db, b.id, getBatch(db, b.id)!.rev, undefined, 'a')
  eq('沒綁版本紀錄 → 不能標上正式', 'reason' in r1 ? r1.reason : 'ok', 'check_failed')
  eq('檢查列出缺綁定', checkBatch(db, b.id).check.missingBinding, true)
  bindRelease(db, b.id, relId, 'a')
  eq('綁了、平台 H5／PC 跟元件同名 → 檢查通過', checkBatch(db, b.id).check.ok, true)
  createItem(db, b.id, { ...ITEM, platform: 'Middle' }, 'a')
  eq('多了 Middle 沒涵蓋 → 不通過', checkBatch(db, b.id).check.uncovered, ['Middle'])
  setPlatformMap(db, { Middle: ['osm'] })
  eq('設平台對應後通過', checkBatch(db, b.id).check.ok, true)
  const r2 = markReleased(db, b.id, getBatch(db, b.id)!.rev, undefined, 'a')
  eq('標上正式成功', 'rev' in r2, true)
  eq('發布狀態 released、學習未開始', [getBatch(db, b.id)?.publishStatus, getBatch(db, b.id)?.learnStatus], ['released', 'none'])
  eq('被綁的版本紀錄：刪除前檢查擋下', !!releaseDeleteBlocker(db, relId), true)
  let threw = ''
  try { deleteRelease(db, relId, getRelease(db, relId)!.rev, 'a') } catch (e) { threw = (e as Error).message }
  eq('直接呼叫 deleteRelease 也被 DB trigger 擋', threw.includes('OSM_VERIFY_RELEASE_REFERENCED'), true)
  eq('版本紀錄還在', !!getRelease(db, relId), true)
}

// ─── 樂觀鎖 ──────────────────────────────────────────────────────────────────
{
  const { db } = freshDb()
  const b = createBatch(db, { year: 2026, batch: '1123', publishStatus: 'draft', prodVersion: '' }, 'a') as { id: string }
  eq('rev 對 → 成功', 'rev' in updateBatch(db, b.id, 1, { year: 2026, batch: '1123', publishStatus: 'verified', prodVersion: 'x' }, 'a'), true)
  const stale = updateBatch(db, b.id, 1, { year: 2026, batch: '1123', publishStatus: 'draft', prodVersion: '' }, 'b')
  eq('rev 過舊 → conflict、不覆蓋', ['reason' in stale ? stale.reason : 'ok', getBatch(db, b.id)?.prodVersion], ['conflict', 'x'])
  const it = createItem(db, b.id, ITEM, 'a') as { id: number }
  updateItem(db, it.id, 1, { ...ITEM, result: 'A' }, 'a')
  const s2 = updateItem(db, it.id, 1, { ...ITEM, result: 'B' }, 'b')
  eq('項目 rev 過舊 → conflict', 'reason' in s2 ? s2.reason : 'ok', 'conflict')
  eq('同名批次 → 擋', (() => { const r = createBatch(db, { year: 2026, batch: '1123', publishStatus: 'draft', prodVersion: '' }, 'a'); return 'reason' in r ? r.reason : 'ok' })(), 'duplicate')
  eq('不同年份同 MMDD 可以（避免跨年覆寫）', 'id' in createBatch(db, { year: 2027, batch: '1123', publishStatus: 'draft', prodVersion: '' }, 'a'), true)
}

// ─── 事件：游標分頁、ack 冪等、rev 不符 409、舊事件不能把新版標成已完成 ─────
{
  const { db, relId } = freshDb()
  const b = createBatch(db, { year: 2026, batch: '1124', publishStatus: 'verified', prodVersion: '' }, 'a') as { id: string }
  const it = createItem(db, b.id, ITEM, 'a') as { id: number }
  bindRelease(db, b.id, relId, 'a')
  markReleased(db, b.id, getBatch(db, b.id)!.rev, undefined, 'a')                         // 事件 1 released
  updateItem(db, it.id, getBatch(db, b.id) && 1, { ...ITEM, result: '改過' }, 'a')         // 事件 2 revised
  createItem(db, b.id, { ...ITEM, description: '第二項' }, 'a')                            // 事件 3 revised
  const p1 = listEvents(db, null, 2)
  eq('第一頁 2 筆', p1.events.map(e => e.type), ['batch.released', 'batch.revised'])
  const p2 = listEvents(db, p1.nextCursor, 2)
  eq('第二頁從游標之後接著拿', p2.events.map(e => e.type), ['batch.revised'])
  const p3 = listEvents(db, p2.nextCursor, 2)
  eq('沒有更多 → 空、nextCursor 回原值', [p3.events.length, p3.nextCursor], [0, p2.nextCursor])
  eq('拿過＝學習中', getBatch(db, b.id)?.learnStatus, 'learning')
  const released = p1.events[0]
  eq('ack 成功', ackEvent(db, released.id, released.batchRev), { ok: true })
  eq('重複 ack → 冪等 ok', ackEvent(db, released.id, released.batchRev), { ok: true })
  const old = ackEvent(db, p1.events[1].id, p1.events[1].batchRev - 1)
  eq('ack 帶較舊的 rev → conflict', 'reason' in old ? old.reason : 'ok', 'conflict')
  eq('只 ack 了舊事件 → 不是已完成（新修訂還沒學）', getBatch(db, b.id)?.learnStatus, 'learning')
  for (const e of [...p1.events, ...p2.events]) ackEvent(db, e.id, e.batchRev)
  eq('全部 ack → 已完成', getBatch(db, b.id)?.learnStatus, 'done')
  eq('released payload 符合契約欄位', Object.keys(released.payload as object), ['batchName', 'prodVersion', 'releases', 'items'])
  eq('released 的 batchRev 是事件當下的', released.batchRev < getBatch(db, b.id)!.rev, true)
  // 上正式後開的單 → ticket_created
  const c = claimTicket(db, { itemId: it.id, mode: 'create', actor: 'a@x', label: 'A', bindingRev: 'r', space: 'prod', typeKey: 't', name: 'n' })
  finishTicket(db, ('ticket' in c ? c.ticket : null)!.id, { kind: 'created', workItemId: '777', url: '' })
  const p4 = listEvents(db, p2.nextCursor, 10)
  eq('上正式後開單 → batch.ticket_created { itemId, ticket }', p4.events.map(e => [e.type, e.payload]), [['batch.ticket_created', { itemId: it.id, ticket: '777' }]])
  eq('有新事件 → 學習狀態不再是已完成', getBatch(db, b.id)?.learnStatus, 'learning')
}

// ─── Lark 匯入（合成表，形狀照實讀：多段表頭、日期只在第一列、公式殘留）───────
{
  const { db } = freshDb()
  const H = ['編號', '日期', '填寫人', '嚴重度', '類別', '主題', '版本\nCenter Server:9.9.9', '摘要', '描述', '圖', '確認\nOK', '進度', '備註', null, null, null, null, null, null, 'Meegle 單號', null, null, '環境']
  const rows = [
    H,
    ['ROW()', 46345, null, null, 'H5,PC', 'OSM', 'h5 1.0', 'x', '合成項目一', [{ id: 1, type: 'attachment' }], 1, '驗證通過', '備註一', null, null, null, null, null, null, '#900100', null, null, 'QAT'],
    ['ROW()', null, null, null, 'Box', 'OSM', '', 'x', '合成項目二', '└─ 延伸問題', 0, null, null],
    [null, null, null, null, null, null, '', '', ''],
    ['', '日期', '', '', '類別', '主題', 'LL版本', '', '描述'],
    [null, null, null, null, null, null, '', '', 'IF(Q51<>"", 1)'],
  ]
  const secs = parseVerifySheet(rows as never)
  eq('兩段表頭', secs.length, 2)
  eq('第一段：日期序號 46345 → 2026-11-19、快照取表頭第二行', [secs[0].firstDate, secs[0].prodVersion, secs[0].items.length], ['2026-11-19', 'Center Server:9.9.9', 2])
  eq('第一段第一列欄位', (({ platform, type, okCount, result, ticket, env }) => ({ platform, type, okCount, result, ticket, env }))(secs[0].items[0]), { platform: 'H5,PC', type: 'OSM', okCount: 1, result: '驗證通過', ticket: '900100', env: 'QAT' })
  eq('第二段只有公式殘留 → 0 筆', secs[1].items.length, 0)
  const r1 = applyVerifySections(db, { sheetKey: 'S:1', sections: secs, actor: 'imp' })
  eq('匯入：批次 2026-1119、2 筆、1 張單', r1.map(r => [r.batch ?? null, r.added, r.tickets]), [['2026-1119', 2, 1], [null, 0, 0]])
  const r2 = applyVerifySections(db, { sheetKey: 'S:1', sections: secs, actor: 'imp' })
  eq('重跑匯入 → 只略過不重複', r2.map(r => [r.added, r.skipped]), [[0, 2], [0, 0]])
  eq('匯入的單號是已開單', (db.prepare("SELECT status, work_item_id FROM osm_verify_tickets").all() as unknown[]), [{ status: 'created', work_item_id: '900100' }])
}

// ─── HTTP：權限、事件 API 憑證、token 不外流、跟 agent 端 pull-events 相容 ─────
const SECRET = 'MEEGLE-TOKEN-SHOULD-NEVER-LEAK-7f3a'
const fixture = (n: string) => fs.readFileSync(path.join('server/fixtures/meegle', n), 'utf8')

async function httpSuite() {
  const { db, relId } = freshDb()
  const users: Record<string, { email: string; label: string; role: string; perms: string[] }> = {
    viewer: { email: 'v@x', label: 'V', role: 'qa', perms: ['osm-verify'] },
    editor: { email: 'e@x', label: 'E', role: 'qa', perms: ['osm-verify-edit'] },
    manager: { email: 'm@x', label: 'M', role: 'qa', perms: ['osm-verify-manage'] },
    nobody: { email: 'n@x', label: 'N', role: 'qa', perms: [] },
  }
  const cliCalls: string[][] = []
  const tokensSeen: string[] = []
  let createMode: 'ok' | 'timeout' = 'timeout'
  let created = 0
  const out = (s: string): CliResult => ({ exitCode: 0, stdout: s, stderr: '', timedOut: false })
  const runner = async (args: string[], token: string): Promise<CliResult> => {
    cliCalls.push(args); tokensSeen.push(token)
    const sub = `${args[0]} ${args[1]}`
    if (sub === 'workitem meta-create-fields') return out(fixture('meta-create-fields.test-space.20261006.json'))
    if (sub === 'workitem meta-fields') return out(args.includes('--field-keys') ? fixture('meta-fields-tasktype.test-space.20261006.json') : fixture('meta-fields.test-space.20261006.json'))
    if (sub === 'workitem query') return out(JSON.stringify({ data: { g: [] }, list: [{ count: 0 }] }))
    if (sub === 'workitem create') {
      if (createMode === 'timeout') return { exitCode: null, stdout: '', stderr: '', timedOut: true }
      created++; return out(JSON.stringify({ work_item_id: 15000000 + created }))
    }
    if (sub === 'project search') return out(JSON.stringify({ projects: [{ project_key: '6abb348976c120f4f43c746a', simple_name: 'sp' }] }))
    if (sub === 'workitem meta-types') return out(JSON.stringify({ list: [{ api_name: 'task_normal', name: '任務項', type_key: '6abd3a436ef2d2a4b44051d8' }] }))
    return out('{}')
  }
  const app = express()
  app.use(express.json())
  app.use(buildOsmVerifyRouter({
    db,
    auth: req => { const u = users[String(req.headers['x-test-user'] ?? '')]; return u ? { email: u.email, label: u.label, role: u.role } : null },
    permissions: email => Object.values(users).find(u => u.email === email)?.perms ?? [],
    history: () => {},
    meegle: { binding: () => ({ ok: true, token: SECRET, bindingRev: 'bind-1' }), canUseSpace: (role, space) => space === 'prod' || role === 'admin', runner, baseEnv: {} },
  }))
  const server = app.listen(0)
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const bodies: string[] = []
  const call = async (method: string, url: string, who: string | null, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(who ? { 'x-test-user': who } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    bodies.push(text)
    let json: Record<string, unknown> = {}
    try { json = JSON.parse(text) } catch { /* */ }
    return { status: r.status, json }
  }
  try {
    eq('HTTP 沒登入 → 401', (await call('GET', '/api/osm-verify/batches', null)).status, 401)
    eq('HTTP 沒權限 → 403', (await call('GET', '/api/osm-verify/batches', 'nobody')).status, 403)
    eq('HTTP 只能看的人新增 → 403', (await call('POST', '/api/osm-verify/batches', 'viewer', { year: 2026, batch: '1130' })).status, 403)
    const nb = await call('POST', '/api/osm-verify/batches', 'editor', { year: 2026, batch: '1130', publishStatus: 'verified' })
    eq('HTTP 編輯者新增批次', nb.status, 200)
    const batchId = String(nb.json.id)
    const ni = await call('POST', `/api/osm-verify/batches/${batchId}/items`, 'editor', ITEM)
    const itemId = Number(ni.json.itemId)
    eq('HTTP 編輯者不能標上正式 → 403', (await call('POST', `/api/osm-verify/batches/${batchId}/release`, 'editor', { rev: 1 })).status, 403)
    const notBound = await call('POST', `/api/osm-verify/batches/${batchId}/release`, 'manager', { rev: 1 })
    eq('HTTP 沒綁版本就標上正式 → 409', [notBound.status, notBound.json.code], [409, 'CHECK_FAILED'])
    const stale = await call('PUT', `/api/osm-verify/batches/${batchId}`, 'editor', { rev: 99, year: 2026, batch: '1130' })
    eq('HTTP rev 過舊 → 409 CONFLICT', [stale.status, stale.json.code], [409, 'CONFLICT'])

    // 開單：Meegle 逾時 → unknown；再按開單不送 create；到遠端查查無 → 仍 unknown、也不送 create
    const ticketBody = { itemIds: [itemId], space: 'prod', typeKey: '6abd3a436ef2d2a4b44051d8', values: { field_eab776: '', field_ef5b10: '97y2igrb3' } }
    const noReq = await call('POST', '/api/osm-verify/tickets', 'editor', ticketBody)
    eq('HTTP 必填（關聯需求）沒填 → 400、沒開任何單', [noReq.status, cliCalls.filter(a => a[1] === 'create').length], [400, 0])
    // 關聯需求選項由 listRequirements（MQL）來，假 CLI 回空 → 換一個 typeKey 測不到；直接給 schema 認得的值
    cliCalls.length = 0
    const reqRunnerHit = async () => (await call('GET', `/api/osm-verify/meegle/schema?space=prod&type=6abd3a436ef2d2a4b44051d8`, 'editor')).json
    const sch = await reqRunnerHit() as { schema?: { fields: { key: string; kind: string }[]; unsupported: string[] } }
    eq('HTTP 任務項類型的必填：關聯需求＋任務類型（template 已驗證可省略）', sch.schema?.fields.map(f => [f.key, f.kind]), [['field_eab776', 'requirement'], ['field_ef5b10', 'select']])
    eq('HTTP 測試空間非管理員 → 403', (await call('GET', '/api/osm-verify/meegle/types?space=test', 'editor')).status, 403)
  } finally {
    server.close()
  }
  return { db, bodies, tokensSeen, relId }
}

// 開單＋事件＋agent 相容（另一組伺服器，關聯需求給假需求清單）
async function ticketAndEventSuite() {
  const { db, relId } = freshDb()
  const users: Record<string, { email: string; label: string; role: string; perms: string[] }> = {
    editor: { email: 'e@x', label: 'E', role: 'qa', perms: ['osm-verify-edit'] },
    editor2: { email: 'e2@x', label: 'E2', role: 'qa', perms: ['osm-verify-edit'] },
    manager: { email: 'm@x', label: 'M', role: 'qa', perms: ['osm-verify-manage'] },
  }
  let createMode: 'ok' | 'timeout' = 'timeout'
  let createCalls = 0
  const createdFields: string[] = []
  const out = (s: string): CliResult => ({ exitCode: 0, stdout: s, stderr: '', timedOut: false })
  const runner = async (args: string[], token: string): Promise<CliResult> => {
    if (token !== SECRET) throw new Error('runner 收到的不是本人 token')
    const sub = `${args[0]} ${args[1]}`
    if (sub === 'workitem meta-create-fields') return out(fixture('meta-create-fields.test-space.20261006.json'))
    if (sub === 'workitem meta-fields') return out(args.includes('--field-keys') ? fixture('meta-fields-tasktype.test-space.20261006.json') : fixture('meta-fields.test-space.20261006.json'))
    if (sub === 'workitem query') {
      const mql = args[args.indexOf('--mql') + 1] ?? ''
      if (mql.includes('`story`')) return out(JSON.stringify({ data: { g: [{ moql_field_list: [{ key: 'name', value: { string_value: '需求A' } }, { key: 'work_item_id', value: { long_value: 555 } }] }] }, list: [{ count: 1 }] }))
      return out(JSON.stringify({ data: { g: [] }, list: [{ count: 0 }] }))   // 遠端查：查無
    }
    if (sub === 'workitem create') {
      createCalls++
      createdFields.push(args[args.indexOf('--fields') + 1])
      if (createMode === 'timeout') return { exitCode: null, stdout: '', stderr: '', timedOut: true }
      return out(JSON.stringify({ work_item_id: 15000000 + createCalls }))
    }
    if (sub === 'project search') return out(JSON.stringify({ projects: [{ project_key: '6ac081a48614642b450645c5', simple_name: 'sp' }] }))
    if (sub === 'workitem meta-types') return out(JSON.stringify({ list: [{ api_name: 'task_normal', name: '任務項', type_key: '6abd3a436ef2d2a4b44051d8' }] }))
    return out('{}')
  }
  const app = express()
  app.use(express.json())
  app.use(buildOsmVerifyRouter({
    db,
    auth: req => { const u = users[String(req.headers['x-test-user'] ?? '')]; return u ? { email: u.email, label: u.label, role: u.role } : null },
    permissions: email => Object.values(users).find(u => u.email === email)?.perms ?? [],
    history: (t, s, d) => { historyDump.push(JSON.stringify([t, s, d])) },
    meegle: { binding: () => ({ ok: true, token: SECRET, bindingRev: 'bind-1' }), canUseSpace: (_r, space) => space === 'prod', runner, baseEnv: {} },
  }))
  const historyDump: string[] = []
  const server = app.listen(0)
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const bodies: string[] = []
  const call = async (method: string, url: string, who: string | null, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(who ? { 'x-test-user': who } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    bodies.push(text)
    let json: Record<string, unknown> = {}
    try { json = JSON.parse(text) } catch { /* */ }
    return { status: r.status, json }
  }
  try {
    const nb = await call('POST', '/api/osm-verify/batches', 'editor', { year: 2026, batch: '1201', publishStatus: 'verified' })
    const batchId = String(nb.json.id)
    const itemId = Number((await call('POST', `/api/osm-verify/batches/${batchId}/items`, 'editor', ITEM)).json.itemId)
    const body = { itemIds: [itemId], space: 'prod', typeKey: '6abd3a436ef2d2a4b44051d8', values: { field_eab776: '555', field_ef5b10: 'h5vz9jrd1' } }
    const t1 = await call('POST', '/api/osm-verify/tickets', 'editor', body)
    const r1 = (t1.json.results as { status: string; ticket: { id: number; key: string } }[])[0]
    eq('HTTP 開單逾時 → unknown', [t1.status, r1.status, createCalls], [200, 'unknown', 1])
    eq('HTTP 冪等 key 寫進描述最後一行', JSON.parse(createdFields[0]).find((f: { field_key: string }) => f.field_key === 'description').field_value.endsWith(keyLine(r1.ticket.key)), true)
    const t2 = await call('POST', '/api/osm-verify/tickets', 'editor', body)
    eq('HTTP unknown 再按開單 → 不送 create', [(t2.json.results as { status: string }[])[0].status, createCalls], ['unknown', 1])
    const lk = await call('POST', `/api/osm-verify/tickets/${r1.ticket.id}/lookup`, 'editor')
    eq('HTTP 到遠端查查無 → 仍 unknown、不自動重送', [lk.json.result, getTicket(db, r1.ticket.id)?.status, createCalls], ['not_found', 'unknown', 1])
    const other = await call('POST', '/api/osm-verify/tickets', 'editor2', { ...body, mode: 'resend' })
    eq('HTTP 別人確認重送 → not_owner、不送', [(other.json.results as { status: string }[])[0].status, createCalls], ['not_owner', 1])
    createMode = 'ok'
    const t3 = await call('POST', '/api/osm-verify/tickets', 'editor', { ...body, mode: 'resend' })
    const r3 = (t3.json.results as { status: string; ticket: { key: string; workItemId: string } }[])[0]
    eq('HTTP 確認重送 → 同一把 key 開成功', [r3.status, r3.ticket.key === r1.ticket.key, createCalls], ['created', true, 2])

    // 綁版本、標上正式、事件 API
    await call('POST', `/api/osm-verify/batches/${batchId}/releases`, 'editor', { releaseId: relId })
    const rev = (getBatch(db, batchId)!).rev
    const rel = await call('POST', `/api/osm-verify/batches/${batchId}/release`, 'manager', { rev })
    eq('HTTP 綁版本後標上正式', rel.status, 200)
    const k = await call('POST', '/api/osm-verify/settings/event-key', 'manager')
    const key = String(k.json.key)
    eq('HTTP 金鑰只回一次明文，DB 只存雜湊', [key.startsWith('ovk_'), !JSON.stringify(db.prepare('SELECT value FROM settings').all()).includes(key)], [true, true])
    eq('HTTP 事件 API 沒憑證 → 401', (await call('GET', '/api/osm-verify/events', null)).status, 401)
    eq('HTTP 事件 API 錯憑證 → 401', (await call('GET', '/api/osm-verify/events', null, undefined, { Authorization: 'Bearer ovk_wrong' })).status, 401)
    eq('HTTP 有登入 session 但沒憑證 → 仍 401（只收服務憑證）', (await call('GET', '/api/osm-verify/events', 'manager')).status, 401)
    eq('HTTP ack 沒憑證 → 401', (await call('POST', '/api/osm-verify/events/x/ack', 'manager', { batchRev: 1 })).status, 401)
    const auth = { Authorization: `Bearer ${key}` }
    const ev = await call('GET', '/api/osm-verify/events?limit=1', null, undefined, auth)
    const e0 = (ev.json.events as { id: string; type: string; batchRev: number; payload: { items: { tickets: string[] }[] } }[])[0]
    eq('HTTP 事件第一頁', [ev.status, e0.type, e0.payload.items[0].tickets], [200, 'batch.released', [r3.ticket.workItemId]])
    eq('HTTP ack', (await call('POST', `/api/osm-verify/events/${e0.id}/ack`, null, { batchRev: e0.batchRev }, auth)).json, { ok: true })
    eq('HTTP 重複 ack → ok', (await call('POST', `/api/osm-verify/events/${e0.id}/ack`, null, { batchRev: e0.batchRev }, auth)).json, { ok: true })
    eq('HTTP ack rev 過舊 → 409', (await call('POST', `/api/osm-verify/events/${e0.id}/ack`, null, { batchRev: e0.batchRev - 1 }, auth)).status, 409)
    eq('HTTP 重新產生金鑰 → 舊金鑰失效', [(await call('POST', '/api/osm-verify/settings/event-key', 'manager')).status, (await call('GET', '/api/osm-verify/events', null, undefined, auth)).status], [200, 401])
    const key2 = String(JSON.parse(bodies[bodies.length - 2]).key)

    // 上正式後修改項目 → revised；再開一張 → ticket_created
    const item = (await call('GET', `/api/osm-verify/batches/${batchId}`, 'editor')).json.items as { id: number; rev: number }[]
    await call('PUT', `/api/osm-verify/items/${itemId}`, 'editor', { ...ITEM, result: '改過', rev: item[0].rev })
    await call('POST', '/api/osm-verify/tickets', 'editor', { ...body, mode: 'again' })

    // agent 端 pull-events.cjs（只讀 require）實際跑：游標、ack、草稿
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-verify-agent-'))
    const prevHome = process.env.OSM_VERIFY_HOME
    process.env.OSM_VERIFY_HOME = home
    try {
      const req = createRequire(import.meta.url)
      const agent = req('C:/Users/user/Desktop/osm-qa-agent/scripts/verify-form/pull-events.cjs') as { run: (o: { base: string; limit: number; dry: boolean }, d: { token: string }) => Promise<{ fetched: number; processed: number; acked: number; draftPaths: string[] }> }
      let agentErr = ''
      const s1 = await agent.run({ base, limit: 1, dry: false }, { token: key2 }).catch((e: Error) => { agentErr = e.message; return { fetched: -1, processed: 0, acked: 0, draftPaths: [] } })
      eq('agent pull-events 沒有出錯', agentErr, '')
      eq('agent pull-events：逐頁拉完、全部 ack', [s1.fetched, s1.acked, s1.fetched >= 3], [s1.fetched, s1.fetched, true])
      eq('agent 產出學習草稿', s1.draftPaths.length, 1)
      const draft = s1.draftPaths[0] ? fs.readFileSync(s1.draftPaths[0], 'utf8') : ''
      eq('草稿有批次名稱與兩張單號', [draft.includes('2026-1201'), (draft.match(/1500000\d/g) ?? []).length >= 2], [true, true])
      eq('agent 全部 ack 後學習狀態＝已完成', getBatch(db, batchId)?.learnStatus, 'done')
      const s2 = await agent.run({ base, limit: 50, dry: false }, { token: key2 }).catch((e: Error) => ({ fetched: -1, error: e.message }))
      eq('agent 再跑一次：游標接著、沒有新事件', s2.fetched, 0)
    } finally {
      if (prevHome === undefined) delete process.env.OSM_VERIFY_HOME; else process.env.OSM_VERIFY_HOME = prevHome
      fs.rmSync(home, { recursive: true, force: true })
    }
  } finally {
    server.close()
  }
  return { bodies, historyDump }
}

const a = await httpSuite()
const b = await ticketAndEventSuite()
const all = [...a.bodies, ...b.bodies, ...b.historyDump].join('\n')
eq('token 不出現在任何回應或操作紀錄', all.includes(SECRET), false)
eq('回應不帶綁定 rev／開單人 email', [all.includes('bind-1'), all.includes('e@x'), all.includes('e2@x')], [false, false, false])

console.log(`\nosm-verify: ${pass} pass, ${fails.length} fail`)
if (fails.length) { for (const f of fails) console.log('  ' + f); process.exit(1) }
export { latestTicket }
