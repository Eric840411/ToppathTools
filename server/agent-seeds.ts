/**
 * server/agent-seeds.ts — 機台測試的「種子檔」（v5.15.0；CodeX review 合併計畫時要求）。
 *
 * 這些是 runner **執行時讀、而且 agent 會自己學／自己改**的設定與參考圖（選單閘門、觸屏參考圖、CCTV 構圖範例…）。
 * 跟原始碼（AGENT_SOURCE_WHITELIST）不一樣：
 *  - 原始碼：伺服器為準，「更新程式碼」會**覆寫**
 *  - 種子檔：**本機為準**，只在 agent 那邊**缺檔才寫入**，已經有的一律不動（agent 學到的東西不能被伺服器那份蓋掉）
 * ⚠️ 所以**不能**加進 AGENT_SOURCE_WHITELIST——那條路會覆寫
 * ⚠️ 只 commit 不會送到 agent：agent 的 ensureSeeds()（agent-runner.ts）開機與更新程式碼後各跑一次
 *
 * key＝agent 那邊相對 server/ 的路徑；value＝repo 裡的來源檔。
 * cctv-refs/ 整個被 .gitignore（裡面是各機種的 CCTV 參考圖），構圖範例只好放 seed-assets/、送到 agent 時再擺回 cctv-refs/
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const SERVER_ROOT = join(process.cwd(), 'server')
const MT = join(SERVER_ROOT, 'machine-test')

export const AGENT_SEED_FILES: Record<string, string> = {
  'machine-test/menu-gate.json':       join(MT, 'menu-gate.json'),
  'machine-test/bonus-sequence.json':  join(MT, 'bonus-sequence.json'),
  'machine-test/machine-layout.json':  join(MT, 'machine-layout.json'),
  'machine-test/touch-visual.json':    join(MT, 'touch-visual.json'),
  'machine-test/exit-playbook.json':   join(MT, 'exit-playbook.json'),
  'machine-test/feature-taps.json':    join(MT, 'feature-taps.json'),
  'machine-test/menu-refs/JJBXGRAND.png':   join(MT, 'menu-refs', 'JJBXGRAND.png'),
  'machine-test/menu-refs/MONEYGONG.png':   join(MT, 'menu-refs', 'MONEYGONG.png'),
  'machine-test/menu-refs/COINCOMBO.png':   join(MT, 'menu-refs', 'COINCOMBO.png'),
  'machine-test/menu-refs/COINCOMBO-2.png': join(MT, 'menu-refs', 'COINCOMBO-2.png'),
  'machine-test/menu-refs/COINCOMBO-3.png': join(MT, 'menu-refs', 'COINCOMBO-3.png'),
  'machine-test/menu-refs/COINCOMBO-4.png': join(MT, 'menu-refs', 'COINCOMBO-4.png'),
  'machine-test/touch-refs/BZZF.png':       join(MT, 'touch-refs', 'BZZF.png'),
  'machine-test/cctv-refs/_framing-good.png': join(MT, 'seed-assets', 'cctv-framing-good.png'),
  'machine-test/cctv-refs/_framing-bad.png':  join(MT, 'seed-assets', 'cctv-framing-bad.png'),
}

/** 二進位內容的指紋（圖片不能走原始碼那套換行正規化） */
export const hashBytes = (b: Buffer) => createHash('sha256').update(b).digest('hex').slice(0, 16)

export function seedManifest(): Array<{ file: string; hash: string; size: number }> {
  return Object.entries(AGENT_SEED_FILES).flatMap(([file, src]) => {
    try { const b = readFileSync(src); return [{ file, hash: hashBytes(b), size: b.length }] } catch { return [] }
  })
}

/**
 * 伺服器自己（本機模式也會跑 runner）缺檔就補。來源跟目的同一個檔（大部分）就跳過；
 * 目的已存在一律不動。回傳補了哪些
 */
export function ensureLocalSeeds(root = SERVER_ROOT): string[] {
  const done: string[] = []
  for (const [file, src] of Object.entries(AGENT_SEED_FILES)) {
    const dst = join(root, ...file.split('/'))
    if (dst === src || existsSync(dst) || !existsSync(src)) continue
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(src, dst)
    done.push(file)
  }
  return done
}
