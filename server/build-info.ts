/**
 * server/build-info.ts — 「這個 process 現在跑的是哪一份程式碼」。
 *
 * ⚠️ 為什麼需要這個：**「我下了 restart」跟「它真的重啟了」是兩件事。**
 *
 * 2026-09-05 實際發生：我在對帳改動之後說「兩支都要重啟」，然後只重啟了 server；
 * worker 繼續跑 698 分鐘前的舊碼，而指令沒有報任何錯。是規格方去查 PM2 的
 * uptime 才發現——當時**沒有任何端點能回答「worker 跑的是哪份碼」**，
 * 只能靠 PM2 uptime 間接推。
 *
 * 這一類錯誤的共同特徵是**沉默**：build 成功、restart 沒報錯、API 照常回應，
 * 只是行為是舊的。所以要有一個可以直接問的地方。
 *
 * ⚠️ 用**編譯產物的 mtime** 而不是啟動時間：啟動時間只說明「何時起來的」，
 *    說不出「起來的時候載入的是哪一版」。兩支 process 的 buildAt 不一致，
 *    就代表有一支沒跟上這次 build。
 */
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

function safeMtime(p: string): number | null {
  try { return statSync(p).mtimeMs } catch { return null }
}

function appVersion(): string {
  // src/version.ts 的第一行就是 APP_VERSION。讀不到不要讓端點掛掉。
  for (const rel of ['../src/version.ts', '../../src/version.ts']) {
    try {
      const m = /APP_VERSION\s*=\s*'([^']+)'/.exec(readFileSync(join(HERE, rel), 'utf8').slice(0, 200))
      if (m) return m[1]
    } catch { /* try next */ }
  }
  return 'unknown'
}

export interface BuildInfo {
  process: string
  version: string
  /** 這個 process 載入的編譯產物的 mtime（epoch ms）。兩支不一致＝有一支沒跟上 build */
  buildAt: number | null
  buildAtIso: string | null
  startedAt: number
  uptimeSec: number
  pid: number
}

const STARTED_AT = Date.now()

export function buildInfo(processName: string): BuildInfo {
  // 用「自己這個檔案的編譯產物」當代表——它跟其他 server 檔案是同一次 build 產出的
  const buildAt = safeMtime(join(HERE, 'build-info.js')) ?? safeMtime(fileURLToPath(import.meta.url))
  return {
    process: processName,
    version: appVersion(),
    buildAt,
    buildAtIso: buildAt ? new Date(buildAt).toISOString() : null,
    startedAt: STARTED_AT,
    uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    pid: process.pid,
  }
}
