/**
 * UI 截圖的 Machine Model 選擇：把大廳一個「遊戲 / model」底下的機台，按 OSM 的 machineType 分組；
 * 勾選某個 Machine Model ＝ 開一個任務，只從那組 gmid（白名單）裡挑空機。前端與伺服器共用這一份。
 *
 * 規則（2026-10-02 需求方確認、CodeX review）：
 * - 勾 wlzbhelix9 ＝ 只從 wlzbhelix9 的機台挑一台空機，每個解析度各拍一次；全部被佔用就失敗，**不換到別的 Machine Model**
 * - 對不到 Machine Model 的 gmid 歸「未同步」，**不能選**（先到機台版本 Dashboard 同步）——不猜
 * - 任務名稱 `遊戲 / model / machineType`；白名單在建 run 時固定成快照，重試、各解析度都用同一池
 */

export type LobbyMachine = { gmid: string; occupied: boolean }

export type MachineModelGroup = {
  /** OSM 的 machineType；null ＝ 未同步（OSM 查不到這幾台） */
  machineType: string | null
  machines: LobbyMachine[]
  total: number
  free: number
}

/** 數字要照數值排（wlzbhelix9 在 wlzbhelix10 前面），不是字串排序 */
function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

/** 依 Machine Model 分組。types：gmid（大寫）→ machineType。未同步那組排最後。 */
export function groupByMachineModel(machines: LobbyMachine[], types: Map<string, string> | Record<string, string>): MachineModelGroup[] {
  const get = (g: string) => (types instanceof Map ? types.get(g) : types[g]) ?? null
  const byType = new Map<string, MachineModelGroup>()
  for (const m of machines) {
    const t = get(m.gmid.trim().toUpperCase())
    const k = t ?? ''
    const g = byType.get(k) ?? { machineType: t, machines: [], total: 0, free: 0 }
    g.machines.push(m)
    g.total++
    if (!m.occupied) g.free++
    byType.set(k, g)
  }
  for (const g of byType.values()) g.machines.sort((a, b) => naturalCompare(a.gmid, b.gmid))
  return [...byType.values()].sort((a, b) => {
    if (!a.machineType !== !b.machineType) return a.machineType ? -1 : 1
    return naturalCompare(a.machineType ?? '', b.machineType ?? '')
  })
}

/** 任務名稱（也是報表、Sheet 列名的來源）：`遊戲 / model / machineType` */
export function poolTarget(game: string, model: string, machineType: string): string {
  return `${game} / ${model} / ${machineType}`
}

/** 三段的任務名稱（遊戲 / model / Machine Model）一定要帶白名單 */
export function isPoolTarget(target: string): boolean {
  return target.split('/').length === 3
}

/**
 * 檢查要送出的白名單。回傳錯誤訊息清單，空陣列＝通過。
 * ⚠️ 有錯就整個 run 不建，不能「跳過有問題的那個、其他照跑」——使用者會以為全部都有拍。
 */
export function validatePools(targets: string[], pools: Record<string, unknown> | undefined): string[] {
  const errs: string[] = []
  // 每個三段任務都要有自己的白名單（CodeX review d3082af [P2]）：漏帶、帶 {}、少一組的話，
  // 那個任務到 agent 會被當成「遊戲 / model」比對 → 退回不限 Machine Model
  for (const t of targets) if (isPoolTarget(t) && !(pools && Object.prototype.hasOwnProperty.call(pools, t))) errs.push(`${t} 沒有帶 Machine Model 白名單`)
  if (!pools) return errs
  for (const [target, list] of Object.entries(pools)) {
    if (!targets.includes(target)) errs.push(`白名單對應的任務不存在：${target}`)
    if (!Array.isArray(list) || list.length === 0) { errs.push(`${target} 的白名單是空的`); continue }
    if (list.some(g => typeof g !== 'string' || !/^\d+-[A-Z0-9]+-\d+$/i.test(g.trim()))) errs.push(`${target} 的白名單有不是 gmid 的值`)
    if (target.split('/').length !== 3) errs.push(`白名單任務名稱格式不對（要是「遊戲 / model / Machine Model」）：${target}`)
  }
  return errs
}
