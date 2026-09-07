import type { Request } from 'express'
import { getAuthAccount } from './auth-session.js'
import { db } from './shared.js'

type HeavyTask = {
  id: string
  userKey: string
  userLabel: string
  type: string
  label: string
  startedAt: number
}

export type HeavyTaskToken = {
  id: string
  userKey: string
}

type HeavyTaskRow = {
  id: string
  user_key: string
  user_label: string
  type: string
  label: string
  status: string
  created_at: number
  started_at: number | null
  finished_at: number | null
  error: string | null
  /** 這筆鎖保護的東西的識別碼（autospin-agent 存 session id）。舊資料是 null。 */
  lock_key: string | null
}

const activeTasks = new Map<string, HeavyTask>()

// activeTasks 只存在記憶體裡，worker process 一重啟就整批消失——不只是「鎖沒了、可能被誤重複
// 啟動」這麼單純，還會連帶讓已經復原（見 autospin.ts 的 agentSessions 快照復原）的 AutoSpin
// session 失去它原本綁定的重任務鎖保護，這個操作者理論上又能再啟動一次新的重任務。開機時從
// heavy_tasks 表把還沒結束的 row 讀回來，把鎖復原成重啟前的狀態。超過 24 小時還是 'running'
// 的 row 視為真的異常結束（process 死掉、從沒機會呼叫 finishHeavyTask），標記成 error 收尾，
// 不永久佔住這個操作者的名額——長時間任務（AutoSpin/Machine Test/OSM UAT）本來就可能跑好幾
// 小時，24 小時是留足夠寬裕的容錯空間。
{
  const STALE_MS = 24 * 60 * 60 * 1000
  const now = Date.now()
  const rows = db.prepare("SELECT * FROM heavy_tasks WHERE status = 'running'").all() as HeavyTaskRow[]
  for (const row of rows) {
    const startedAt = row.started_at ?? row.created_at
    if (now - startedAt > STALE_MS) {
      db.prepare("UPDATE heavy_tasks SET status = 'error', finished_at = ?, error = ? WHERE id = ?")
        .run(now, '重任務追蹤逾期未結束（伺服器重啟後復原時判定為異常，非正常結束）', row.id)
      continue
    }
    /**
     * ⚠️ **孤兒鎖不要復原。**
     *
     * 這段原本是「running 的一律復原」，但**鎖跟它保護的 session 存在兩張不同的表**，
     * 各自獨立復原——鎖回來了、session 沒回來，就變成一筆誰也對不上的鎖，
     * 而清理門檻是 24 小時，等於把那個帳號鎖一整天。實測 2026-09-07 一天內發生兩次。
     *
     * 只對 `autospin-agent` 做這個檢查（跟 CodeX 討論定案）：這種鎖本來就是
     * session 的附屬保護，沒有 session 就沒有意義。**其他型別不要套**——
     * 它們可能沒有 session 的概念，或鎖本身就是唯一真相，誤清比留著危險。
     */
    if (row.type === 'autospin-agent' && !autospinLockHasLiveOwner(row.lock_key, row.user_label, startedAt, now)) {
      db.prepare("UPDATE heavy_tasks SET status = 'error', finished_at = ?, error = ? WHERE id = ?")
        .run(now, '孤兒鎖：開機復原時找不到對應的 AutoSpin session（未復原此鎖）', row.id)
      console.log(`[heavy-task-guard] 未復原孤兒鎖 ${row.id}（user=${row.user_label}）`)
      continue
    }
    activeTasks.set(row.user_key, {
      id: row.id, userKey: row.user_key, userLabel: row.user_label,
      type: row.type, label: row.label, startedAt,
    })
  }
  if (activeTasks.size > 0) {
    console.log(`[heavy-task-guard] 已從 DB 復原 ${activeTasks.size} 筆重任務鎖`)
  }
}

function workerUrl() {
  return (process.env.WORKER_URL ?? 'http://127.0.0.1:3010').replace(/\/$/, '')
}

function notifyWorker(path: string, payload: unknown) {
  fetch(`${workerUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(1000),
  }).catch(() => {
    // Worker visibility is best-effort; task execution must not depend on it.
  })
}

function taskUser(req: Request): { key: string; label: string } {
  const account = getAuthAccount(req)
  if (account) return { key: account.email, label: account.label || account.email }

  const jiraEmail = req.headers['x-jira-email']
  if (typeof jiraEmail === 'string' && jiraEmail) return { key: jiraEmail, label: jiraEmail }

  const body = req.body as { account?: string; jiraEmail?: string; userLabel?: string } | undefined
  const bodyAccount = body?.account || body?.jiraEmail || body?.userLabel
  if (bodyAccount) return { key: bodyAccount, label: bodyAccount }

  // 「帳號選單」系統送的 header（AutoSpin agent 註冊、其餘多數前端呼叫都會帶）。沒有這層
  // fallback 時，未登入/無 cookie 的請求（例如 Python agent 直接打 API）一律退回用來源 IP
  // 當 key——兩個不同帳號的 Local Agent 若剛好在同一個辦公室網路後面（同一個對外 IP），會被
  // 誤判成同一個操作者，導致其中一個帳號的重任務鎖擋住另一個帳號，明明是不同人卻互相衝突。
  const userLabelHeader = req.headers['x-user-label']
  if (typeof userLabelHeader === 'string' && userLabelHeader) return { key: userLabelHeader, label: userLabelHeader }

  return { key: req.ip ?? req.socket.remoteAddress ?? 'guest', label: 'guest' }
}

function toPublicTask(row: HeavyTaskRow) {
  return {
    id: row.id,
    userKey: row.user_key,
    userLabel: row.user_label,
    type: row.type,
    label: row.label,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
  }
}

/**
 * 鎖住多久之後視為卡死、自動釋放。
 *
 * ⚠️ 這個值要**大於任何一次合法的重任務**，否則會在跑到一半把鎖放掉、
 *    讓第二個任務插進來。AutoSpin／機測／UAT 都可能跑數小時，所以訂 6 小時：
 *    比實際任務長很多，又遠短於啟動復原用的 24 小時（那個是不同的情境）。
 */
const STALE_TASK_MS = 6 * 60 * 60 * 1000

export function tryStartHeavyTask(
  req: Request,
  type: string,
  label: string,
): { ok: true; token: HeavyTaskToken } | { ok: false; task: HeavyTask } {
  const user = taskUser(req)
  const existing = activeTasks.get(user.key)
  if (existing) {
    /**
     * ⚠️ **卡住的鎖必須能自癒。**
     *
     * 2026-09-06 實際發生：`hub-stop` 只設 `stopRequested`、不釋放鎖，而 Python 端
     * 若先死掉就沒有人回報 `/agent/:id/stop`——那筆 heavy task 於是永久留著，
     * **同一個帳號再也派不了工**。而且它持久化在 DB，重啟 worker 也清不掉。
     *
     * 更糟的是症狀（「你目前已有重任務正在執行」）**看起來像使用者自己的問題**，
     * 不像 bug——所以不會有人來報，只會有人放棄。
     *
     * 只靠「修好所有釋放路徑」不夠：漏掉任何一條，下一次又會卡死，而且一樣沒人發現。
     * 所以再加一道時間上的自癒。這裡刻意訂得比啟動時那個 24 小時緊得多——
     * 那個是「重啟後復原」的容錯，這個是「同一個 process 內鎖住太久」，兩者的
     * 合理上限差很遠。
     */
    if (Date.now() - existing.startedAt > STALE_TASK_MS) {
      console.warn(`[heavy-task] 自動釋放卡住的鎖：${existing.type} (${existing.id})`
        + ` 已 running ${Math.round((Date.now() - existing.startedAt) / 60000)} 分鐘`)
      finishHeavyTask({ id: existing.id, userKey: existing.userKey })
    } else {
      return { ok: false, task: existing }
    }
  }

  const now = Date.now()
  const task: HeavyTask = {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    userKey: user.key,
    userLabel: user.label,
    type,
    label,
    startedAt: now,
  }
  activeTasks.set(user.key, task)
  db.prepare(`
    INSERT OR REPLACE INTO heavy_tasks
      (id, user_key, user_label, type, label, status, created_at, started_at, finished_at, error, lock_key)
    VALUES (?, ?, ?, ?, ?, 'running', ?, ?, NULL, NULL, NULL)
  `).run(task.id, task.userKey, task.userLabel, task.type, task.label, now, now)
  notifyWorker('/internal/worker/tasks/start', task)
  return { ok: true, token: { id: task.id, userKey: user.key } }
}

/**
 * 這個 autospin-agent 鎖還有沒有活著的 session？
 *
 * ⚠️ **刻意直接查表，不 import autospin.ts**——那支檔案 import 了本檔，
 *    反向 import 會形成循環相依（跟 v4.10.0 `userJiraAuth()` 不 import
 *    `auth-session.ts` 是同一個理由）。
 *
 * `lock_key` 是 session id。舊資料沒有這個值（這欄以前從沒被寫過），
 * **不能因此直接判成孤兒**——那會把升級當下正在跑的 session 誤殺。
 * 沒有 lock_key 時退一步用 userLabel 比對，而且要過寬限期才敢判死。
 */
const UNBOUND_LOCK_GRACE_MS = 5 * 60 * 1000

export function autospinLockHasLiveOwner(
  lockKey: string | null | undefined, userLabel: string, startedAt: number, now: number,
): boolean {
  const rows = db.prepare('SELECT id, data FROM autospin_agent_sessions').all() as { id: string; data: string }[]
  const live: { id: string; userLabel?: string; status?: string }[] = []
  for (const r of rows) {
    try {
      const d = JSON.parse(r.data) as { userLabel?: string; status?: string }
      if (d.status === 'running') live.push({ id: r.id, userLabel: d.userLabel, status: d.status })
    } catch { /* 壞掉的 row 當作不存在 */ }
  }
  if (lockKey) return live.some(s => s.id === lockKey)
  // 舊資料：沒綁 session id，只能用 userLabel 猜，而且要夠老才敢判死
  if (live.some(s => s.userLabel === userLabel)) return true
  return now - startedAt < UNBOUND_LOCK_GRACE_MS
}

/** 把鎖綁到它保護的 session。⚠️ 一定要在建立 session 的同一個同步流程裡呼叫，中間不要有 await。 */
export function bindHeavyTaskOwner(token: HeavyTaskToken | null | undefined, ownerRef: string) {
  if (!token || !ownerRef) return
  db.prepare('UPDATE heavy_tasks SET lock_key = ? WHERE id = ?').run(ownerRef, token.id)
}

/**
 * 直接用 id 釋放一筆鎖——給背景掃描與「強制清除」用。
 * ⚠️ 跟 `finishHeavyTask` 分開是因為那支要求呼叫端手上有 token，
 *    而這兩個情境的前提正好是**沒有人握著 token**（token 隨 session 一起不見了）。
 * 收尾狀態用 `error` 不用 `done`：它不是正常結束，稽核軌跡要看得出差別。
 */
export function releaseHeavyTaskById(id: string, reason: string): boolean {
  const row = db.prepare("SELECT * FROM heavy_tasks WHERE id = ? AND status = 'running'").get(id) as HeavyTaskRow | undefined
  if (!row) return false
  const current = activeTasks.get(row.user_key)
  if (current?.id === id) activeTasks.delete(row.user_key)
  db.prepare("UPDATE heavy_tasks SET status = 'error', finished_at = ?, error = ? WHERE id = ?")
    .run(Date.now(), reason, id)
  notifyWorker('/internal/worker/tasks/finish', {
    id: row.id, userKey: row.user_key, userLabel: row.user_label,
    type: row.type, label: row.label,
    startedAt: row.started_at ?? row.created_at, finishedAt: Date.now(),
  })
  return true
}

/** 目前還 running 的 autospin-agent 鎖（給背景掃描與強制清除畫面用）。 */
export function listRunningAutospinLocks() {
  return db.prepare("SELECT * FROM heavy_tasks WHERE status = 'running' AND type = 'autospin-agent'")
    .all() as HeavyTaskRow[]
}

export function finishHeavyTask(token: HeavyTaskToken | null | undefined) {
  if (!token) return
  const current = activeTasks.get(token.userKey)
  if (current?.id !== token.id) return
  activeTasks.delete(token.userKey)
  db.prepare("UPDATE heavy_tasks SET status = 'done', finished_at = ? WHERE id = ?").run(Date.now(), current.id)
  notifyWorker('/internal/worker/tasks/finish', {
    id: current.id,
    userKey: current.userKey,
    userLabel: current.userLabel,
    type: current.type,
    label: current.label,
    startedAt: current.startedAt,
    finishedAt: Date.now(),
  })
}

export function heavyTaskConflict(task: HeavyTask) {
  return {
    ok: false,
    code: 'HEAVY_TASK_RUNNING',
    message: `你目前已有重任務正在執行：${task.label}`,
    task: {
      id: task.id,
      type: task.type,
      label: task.label,
      status: 'running',
      startedAt: task.startedAt,
      userLabel: task.userLabel,
    },
  }
}

export function getHeavyTaskForRequest(req: Request) {
  const user = taskUser(req)
  const active = activeTasks.get(user.key)
  if (active) return active
  const row = db.prepare(`
    SELECT * FROM heavy_tasks
    WHERE user_key = ? AND status IN ('queued', 'running')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(user.key) as HeavyTaskRow | undefined
  return row ? toPublicTask(row) : null
}

export function getActiveHeavyTasks() {
  const rows = db.prepare(`
    SELECT * FROM heavy_tasks
    WHERE status IN ('queued', 'running')
    ORDER BY created_at DESC
    LIMIT 100
  `).all() as HeavyTaskRow[]
  return rows.map(toPublicTask)
}

export function getRecentHeavyTasksForRequest(req: Request) {
  const user = taskUser(req)
  const rows = db.prepare(`
    SELECT * FROM heavy_tasks
    WHERE user_key = ?
    ORDER BY created_at DESC
    LIMIT 20
  `).all(user.key) as HeavyTaskRow[]
  return rows.map(toPublicTask)
}