/**
 * Machine Test Runner — Phase 1
 * Playwright-based automated test for casino slot machines.
 *
 * Steps per machine:
 *  1. entry  — navigate lobby, find machine by code, click to enter
 *  2. stream — detect <video> / <canvas> streaming elements
 *  3. spin   — click spin button and verify response
 *  4. audio  — inject Web Audio API monitor and sample for 5s
 *  5. exit   — click cashout/exit and verify return to lobby
 */

import { EventEmitter } from 'events'
import { AsyncLocalStorage } from 'async_hooks'
import { spawn } from 'child_process'
import { readFileSync, existsSync, unlinkSync, writeFileSync, mkdirSync } from 'fs'
import { join, basename, dirname } from 'path'
import { chromium, type Browser, type Page, type ElementHandle, type ConsoleMessage } from 'playwright'
import type { MachineTestSession, MachineResult, StepResult, StepStatus, TestEvent, MachineProfile } from './types.js'
import { callGeminiVision, callGeminiVisionMulti } from './gemini-agent.js'
import { matchPopup, isNeverClick, POPUP_SNAPSHOT_IN_PAGE, POPUP_BOX_SELECTORS, POPUP_PROBE_SELECTORS, POPUP_MIN_AREA, NEVER_BLOCK_IN_PAGE, NEVER_CLICK_SERIALIZED, ELEMENT_BOX_INFO_IN_PAGE } from '../uat-runner/popup-catalog.js'
import { dismissLobbyPopups } from '../uat-runner/lobby-popup.js'
import { ideckVerdict, streamRoles, runIdeckSequence, runTouchVisualFlow, runBlindBurst, runMenuGate, runTouchThenSpin, extraSpinDecision, runFeatureTaps, featureTapSummary, onFeatureSelectScreen, exitFeatureState, planExitAdvance, applyFeatureRound, inFeatureHold, REF_MATCH, superviseOpenRound, openRoundTrigger, stepGateBlock, decidePopup, popupStepBlock, ideckRoundState, ideckBeginWait, ideckQuietWaitMs, attributeBegin, ideckBackPick, isAudioTrueSilence, pickMinBetKeys, classifyBetKey, ideckFamilyOrder, lastBetFromMoneyLog, audioRetryPrecheck, audioRetrySummary, IDECK_CONSERVATIVE_BEGIN_MS, type IdeckTimingCfg, type PopupDecision, type PopupPhase, type FeatureTapPoint, type FeatureTapLog, type IdeckResult, type BlindBurstState, type MenuGateResult } from './verdicts.js'
import { ideckButtonKey } from './ideck-button-key.js'
import { installServerCfgDebug, describeServerCfgDebug } from './server-cfg-debug.js'
import pngjs from 'pngjs'
const { PNG } = pngjs

// ─── OS-level audio capture via VB-Cable ─────────────────────────────────────

const NIRCMD  = 'C:\\Users\\user\\AppData\\Local\\nircmd\\nircmd.exe'
const MACHINE_TEST_ROOT = join(process.cwd(), 'server', 'machine-test')
const RECORD_SCRIPT = join(MACHINE_TEST_ROOT, 'record-spin.ps1')
const CABLE_DEVICE  = 'CABLE Input (VB-Audio Virtual Cable)'
const CCTV_SAVE_DIR  = join(MACHINE_TEST_ROOT, 'cctv-saves')
// 推流截圖：2026-09-21 加。原本推流只數「幾個 video 在播」，完全沒留畫面，
// 於是「影像上下顛倒」這種問題查不到也證明不了。留圖才有辦法回報與比對。
const STREAM_SAVE_DIR = join(MACHINE_TEST_ROOT, 'stream-saves')
// 推流沒在播時最多再等多久才下結論。30 秒是初值、還沒量過推流實際要多久（1002 MONEYGONG 慢的幾台在 iDeck 步驟，約進場 40 秒後都有畫面）
const STREAM_WAIT_MS = 30000
const AUDIO_SAVE_DIR = join(MACHINE_TEST_ROOT, 'audio-saves')
const CCTV_REFS_DIR  = join(MACHINE_TEST_ROOT, 'cctv-refs')
// 1004 使用者：CCTV 要拍到「完整機台」才算過（COINCOMBO 0225／0226 浮水印編號相符，但只拍到側邊局部 → 不合格）。
// 單張問「有沒有完整入鏡」實測不可用（7 張裡 4 張不合格全判 full）；改 few-shot：合格範例＋不合格範例＋這張，三張一起問。
// 範例圖在 cctv-refs/_framing-good.png／_framing-bad.png（只含攝影機畫面）；單一來源 osm-qa-agent/knowledge/machine-test/cctv-framing/，
// 探針 osm-qa-agent/scripts/machine-test-cctv-framing-fewshot-probe.mjs（7 張實拍、連跑 3 輪全對）——改 prompt 要重跑
const CCTV_FRAMING_GOOD = join(CCTV_REFS_DIR, '_framing-good.png')
const CCTV_FRAMING_BAD = join(CCTV_REFS_DIR, '_framing-bad.png')
const CCTV_FRAMING_PROMPT = '三張都是賭場 CCTV 監控畫面（直式，浮水印文字是轉 90 度的，請忽略浮水印）。\n' +
  '第 1 張是【合格】範例：一台老虎機的正面完整入鏡，主螢幕整塊、機身左右邊框都在畫面內。\n' +
  '第 2 張是【不合格】範例：鏡頭太近／斜拍，只拍到機台側邊和部分螢幕，螢幕被畫面邊界切掉。\n' +
  '請判斷第 3 張比較像哪一種，只回 JSON：{"framing":"full|partial|none","framingNote":"一句話說明"}（none＝完全看不到機台）。\n' +
  '判斷重點：第 3 張的主要機台螢幕有沒有被畫面邊界切掉、是不是只拍到局部或拍到地板／遠處其他機台。'

const AUDIO_REFS_DIR = join(MACHINE_TEST_ROOT, 'audio-refs')

function runPS(script: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-File', script, ...args], { windowsHide: true })
    let out = ''
    p.stdout.on('data', d => { out += d.toString() })
    p.stderr.on('data', () => {})
    p.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(`PS exit ${code}: ${out}`)))
  })
}

function setDefaultAudio(deviceName: string): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn(NIRCMD, ['setdefaultsounddevice', deviceName], { windowsHide: true })
    p.on('close', () => setTimeout(resolve, 300))
  })
}

function getDefaultAudioDevice(): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn('powershell', ['-Command', 'Get-WmiObject Win32_SoundDevice | Where-Object { $_.StatusInfo -eq 3 } | Select-Object -First 1 -ExpandProperty Name'], { windowsHide: true })
    let out = ''
    p.stdout.on('data', d => { out += d.toString() })
    p.on('close', () => resolve(out.trim() || 'Realtek High Definition Audio'))
  })
}

/** Analyze a 16-bit PCM WAV file, returns RMS dB, peak dB, and spectral centroid */
function analyzeWav(filePath: string): { rmsDb: number; peakDb: number; samples: number; clipRatio: number; crestFactor: number; spectralCentroid: number } {
  try {
    const buf = readFileSync(filePath)
    // Find 'data' chunk
    let dataOffset = 12
    while (dataOffset < buf.length - 8) {
      const tag = buf.toString('ascii', dataOffset, dataOffset + 4)
      const size = buf.readUInt32LE(dataOffset + 4)
      if (tag === 'data') { dataOffset += 8; break }
      dataOffset += 8 + size
    }
    const channels = buf.readUInt16LE(22)
    const sampleRate = buf.readUInt32LE(24)
    const bitsPerSample = buf.readUInt16LE(34)
    const frameCount = Math.floor((buf.length - dataOffset) / ((bitsPerSample / 8) * channels))

    // Mix to mono while computing RMS/peak
    const mono = new Float32Array(frameCount)
    let sumSq = 0, peak = 0, clipCount = 0
    for (let i = 0; i < frameCount; i++) {
      let sum = 0
      for (let c = 0; c < channels; c++) {
        sum += buf.readInt16LE(dataOffset + (i * channels + c) * 2)
      }
      const s = sum / channels / 32768
      mono[i] = s
      const abs = Math.abs(s)
      if (abs > peak) peak = abs
      if (abs >= 0.98) clipCount++
      sumSq += s * s
    }
    const rms = Math.sqrt(sumSq / frameCount)
    const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity
    const peakDb = peak > 0 ? 20 * Math.log10(peak) : -Infinity
    const crestFactor = isFinite(peakDb) && isFinite(rmsDb) ? peakDb - rmsDb : 0

    // Timbre brightness via ZCR (Zero-Crossing Rate) on 4096-sample windows (~93ms)
    // ZCR-derived freq: nZC × sampleRate / (2 × WIN)
    // Normal slot audio: ~100–600 Hz  |  Crispy/metallic: ~3000+ Hz
    // Threshold CENTROID_WARN = 1500 Hz  (DFT was unreliable on 11ms transient windows)
    const WIN = 4096
    const HOP = WIN
    let maxWinEnergy = 0
    for (let i = 0; i < frameCount - WIN; i += HOP) {
      let e = 0
      for (let j = 0; j < WIN; j++) e += mono[i + j] * mono[i + j]
      if (e > maxWinEnergy) maxWinEnergy = e
    }
    const silenceThresh = maxWinEnergy * 0.10  // skip windows more than 10 dB below loudest
    let zcrSum = 0, zcrCount = 0
    for (let i = 0; i < frameCount - WIN; i += HOP) {
      let e = 0, zc = 0
      for (let j = 0; j < WIN; j++) {
        e += mono[i + j] * mono[i + j]
        if (j > 0 && mono[i + j - 1] * mono[i + j] < 0) zc++
      }
      if (e < silenceThresh) continue
      zcrSum += zc * sampleRate / (2 * WIN)
      zcrCount++
    }
    const spectralCentroid = zcrCount > 0 ? zcrSum / zcrCount : 0

    return { rmsDb, peakDb, samples: frameCount, clipRatio: clipCount / frameCount, crestFactor, spectralCentroid }
  } catch {
    return { rmsDb: -Infinity, peakDb: -Infinity, samples: 0, clipRatio: 0, crestFactor: 0, spectralCentroid: 0 }
  }
}

/**
 * Upload a file buffer to the central server.
 * Only runs when CENTRAL_URL env var is set (i.e. running as a remote agent).
 * Fails silently — local access still works even if upload fails.
 */
async function uploadToServer(buf: Buffer, endpoint: string, filename: string, contentType: string): Promise<void> {
  const centralUrl = process.env.CENTRAL_URL
  if (!centralUrl) return // running as local server, file is already in place
  const httpBase = centralUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/ws\/.*$/, '')
  const url = `${httpBase}${endpoint}?filename=${encodeURIComponent(filename)}`
  try {
    const resp = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: buf,
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      console.error(`[Agent] upload HTTP ${resp.status} (${endpoint}): ${text}`)
    } else {
      console.log(`[Agent] uploaded ${filename} → ${httpBase}`)
    }
  } catch (e) {
    console.error(`[Agent] upload failed (${endpoint}):`, e)
  }
}

const uploadAudioToServer = (buf: Buffer, filename: string) =>
  uploadToServer(buf, '/api/machine-test/audio-upload', filename, 'audio/wav')

const uploadCctvToServer = (buf: Buffer, filename: string) =>
  uploadToServer(buf, '/api/machine-test/cctv-upload', filename, 'image/png')

/**
 * Delegate Gemini Vision OCR to the central server's key pool.
 * When CENTRAL_URL is set (agent mode), use this instead of calling Gemini directly.
 * Falls back to a direct call only when the proxy cannot be reached.
 */
async function readOcrProxyResult(resp: Response, context: string): Promise<string> {
  const raw = await resp.text()
  let data: { ok?: boolean; result?: string; error?: string } = {}
  try {
    data = raw ? JSON.parse(raw) as typeof data : {}
  } catch {
    // Keep the raw response below so proxy failures remain diagnosable.
  }
  if (resp.ok && data.ok && data.result) return data.result
  const detail = data.error || raw || `HTTP ${resp.status}`
  throw new Error(`${context}失敗（HTTP ${resp.status}）：${detail}`)
}

async function callGeminiVisionViaProxy(prompt: string, imageBase64: string, mimeType = 'image/png'): Promise<string> {
  const centralUrl = process.env.CENTRAL_URL
  if (centralUrl) {
    const httpBase = centralUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/ws\/.*$/, '')
    let resp: Response
    try {
      resp = await fetch(`${httpBase}/api/machine-test/ocr-proxy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-agent-token': process.env.AGENT_TOKEN ?? '',
          'x-agent-owner': process.env.AGENT_OWNER_KEY ?? '',
          'x-jira-email': process.env.AGENT_OWNER_KEY ?? '',
        },
        body: JSON.stringify({ prompt, images: [{ base64: imageBase64, mimeType }] }),
      })
    } catch (e) {
      console.error('[Agent] ocr-proxy request failed:', e)
      return callGeminiVision(prompt, imageBase64, mimeType)
    }
    return readOcrProxyResult(resp, '中央 OCR proxy')
  }
  return callGeminiVision(prompt, imageBase64, mimeType)
}

async function callGeminiVisionMultiViaProxy(prompt: string, images: Array<{ base64: string; mimeType?: string }>): Promise<string> {
  const centralUrl = process.env.CENTRAL_URL
  if (centralUrl) {
    const httpBase = centralUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/ws\/.*$/, '')
    let resp: Response
    try {
      resp = await fetch(`${httpBase}/api/machine-test/ocr-proxy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-agent-token': process.env.AGENT_TOKEN ?? '',
          'x-agent-owner': process.env.AGENT_OWNER_KEY ?? '',
          'x-jira-email': process.env.AGENT_OWNER_KEY ?? '',
        },
        body: JSON.stringify({ prompt, images }),
      })
    } catch (e) {
      console.error('[Agent] ocr-proxy multi request failed:', e)
      return callGeminiVisionMulti(prompt, images)
    }
    return readOcrProxyResult(resp, '中央 OCR proxy multi')
  }
  return callGeminiVisionMulti(prompt, images)
}

/** Serial queue: ensures only one VB-Cable recording runs at a time.
 *  Multiple workers share the same CABLE device, so concurrent recordings mix signals. */
let audioRecordingQueue: Promise<unknown> = Promise.resolve()

// ─── 整段錄音（進機台 → 退出）────────────────────────────────────────────────
// 為什麼要：原本只在 Spin 前後錄 5 秒，**Spin 沒真的轉時那 5 秒等於錄空氣**，
// 於是「沒錄到音效」會被讀成「機台沒聲音」。整段錄的話，進場音效、iDeck、觸屏
// 這些事件都會落在錄音裡，判斷才有東西可看。
// ⚠️ 錄的是整台電腦的輸出（VB-Cable），**多 Worker 會把各機台的聲音混在一起**，
//    所以只在單 Worker 時啟用。
const SESSION_RECORD_SCRIPT = join(MACHINE_TEST_ROOT, 'record-session.ps1')

interface SessionRecording {
  outFile: string
  stopFile: string
  done: Promise<string>
}

function startSessionRecording(tag: string): SessionRecording | null {
  if (!existsSync(SESSION_RECORD_SCRIPT)) return null
  const base = `C:\\Users\\user\\AppData\\Local\\Temp\\session_${tag}_${Date.now()}`
  const outFile = `${base}.wav`
  const stopFile = `${base}.stop`
  const done = new Promise<string>((resolve) => {
    const p = spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SESSION_RECORD_SCRIPT,
        '-OutFile', outFile, '-StopFile', stopFile, '-MaxMs', '900000'],
      { windowsHide: true })
    let out = ''
    p.stdout.on('data', d => { out += d.toString() })
    p.on('close', () => resolve(out.trim()))
    p.on('error', () => resolve('FAIL:spawn'))
  })
  return { outFile, stopFile, done }
}

async function stopSessionRecording(rec: SessionRecording | null): Promise<string | null> {
  if (!rec) return null
  try { writeFileSync(rec.stopFile, 'stop') } catch { /* 停不下來就讓它撞 MaxMs */ }
  const result = await rec.done
  return result.startsWith('OK:') ? rec.outFile : null
}

function recordVBCableSerial(durationMs: number, keepWav = false, savePath?: string): Promise<ReturnType<typeof recordVBCable>> {
  const task = audioRecordingQueue.then(() => recordVBCable(durationMs, keepWav, savePath))
  audioRecordingQueue = task.catch(() => {})
  return task
}

/** Record from CABLE Output for durationMs while CABLE Input is default output.
 *  Returns null if VB-Cable or nircmd is not available.
 *  Set keepWav=true to also return the base64-encoded WAV for AI analysis. */
async function recordVBCable(durationMs: number, keepWav = false, savePath?: string): Promise<{ rmsDb: number; peakDb: number; samples: number; clipRatio: number; crestFactor: number; spectralCentroid: number; wavBase64?: string } | null> {
  if (!existsSync(NIRCMD)) return null
  if (!existsSync(RECORD_SCRIPT)) {
    console.error('[VBCable] record-spin.ps1 not found at:', RECORD_SCRIPT)
    return null
  }
  const outFile = `C:\\Users\\user\\AppData\\Local\\Temp\\spinaudio_${Date.now()}.wav`
  try {
    const result = await runPS(RECORD_SCRIPT, ['-OutFile', outFile, '-DurationMs', String(durationMs)])
    if (!result.startsWith('OK:')) {
      console.error('[VBCable] script output:', result)
      return null
    }
    if (!existsSync(outFile)) return null
    const analysis = analyzeWav(outFile)
    let wavBase64: string | undefined
    if (keepWav) {
      try { wavBase64 = readFileSync(outFile).toString('base64') } catch { /* ignore */ }
    }
    // Save a copy to local folder if savePath provided
    if (savePath) {
      try {
        mkdirSync(AUDIO_SAVE_DIR, { recursive: true })
        writeFileSync(savePath, readFileSync(outFile))
        // If running as a remote agent, also upload the WAV to the central server
        // so the public-facing API can serve it to the browser
        void uploadAudioToServer(readFileSync(outFile), basename(savePath))
      } catch { /* non-fatal */ }
    }
    try { unlinkSync(outFile) } catch {}
    return keepWav ? { ...analysis, wavBase64 } : analysis
  } catch (e) {
    console.error('[VBCable] recordVBCable error:', e)
    return null
  }
}

// ─── Machine Log API (daily-analysis) ────────────────────────────────────────

// learn 模式交給 batch 端的結構化資料版本；batch 對不上版本就整台不寫 profile
export const LEARN_VER = 1

const DAILY_ANALYSIS_URLS: Record<string, string> = {
  qat:  'https://qat-osmtrace.osmslot.org/api/machine/daily-analysis',
  prod: 'https://prod-osmtrace.osmslot.org/api/machine/daily-analysis',
}
let DAILY_ANALYSIS_BASE = DAILY_ANALYSIS_URLS.qat

export interface LogEntry {
  time: string                        // HH:MM:SS (local time)
  type: string                        // e.g. 'usb_coordinate', 'game_start', 'dealevent'
  data: Record<string, unknown>
  gmid: string
  userid: string | null
}

function toLocalDateStr(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function toLocalTimeStr(d: Date): string {
  return d.toTimeString().slice(0, 8)  // HH:MM:SS
}

/**
 * Poll the daily-analysis API until a log entry matching `condition` appears
 * after `afterTime`, or until `timeoutMs` elapses.
 *
 * Each machine polls its own endpoint independently — safe for parallel workers.
 *
 * @returns The first matching LogEntry, or null on timeout.
 */
export async function pollMachineLog(
  gmid: string,
  afterTime: Date,
  condition: (entry: LogEntry) => boolean,
  timeoutMs = 10000,
  intervalMs = 2000,
): Promise<LogEntry | null> {
  const date = toLocalDateStr(afterTime)
  const afterTimeStr = toLocalTimeStr(afterTime)
  const url = `${DAILY_ANALYSIS_BASE}?gmid=${encodeURIComponent(gmid)}&date=${encodeURIComponent(date)}`
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) {
        const json = await res.json() as { data?: { timeline?: LogEntry[] } }
        const timeline = json.data?.timeline ?? []
        const match = timeline.find(e => e.time >= afterTimeStr && condition(e))
        if (match) return match
      }
    } catch { /* network hiccup — retry */ }

    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await sleep(Math.min(intervalMs, remaining))
  }

  return null
}

/**
 * Poll window.__ideckEvents (written by IDECK_MONITOR_SCRIPT) across all frames
 * for an event that arrived after `afterTs`, within `timeoutMs`.
 */
async function pollIdeckEvent(page: Page, afterTs: number, timeoutMs = 5000): Promise<IdeckCmdData | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try {
        const events = await frame.evaluate((ts: number) => {
          const evts = (window as unknown as { __ideckEvents?: Array<{ cmd: string; error: number; ts: number }> }).__ideckEvents ?? []
          return evts.filter(e => e.ts >= ts)
        }, afterTs) as Array<{ cmd: string; error: number; ts: number }>
        if (events.length > 0) {
          // Clear consumed events from all frames to avoid re-matching on next button
          for (const f of page.frames()) {
            try {
              await f.evaluate((ts: number) => {
                const w = window as unknown as { __ideckEvents?: Array<{ ts: number }> }
                if (w.__ideckEvents) w.__ideckEvents = w.__ideckEvents.filter(e => e.ts < ts)
              }, events[events.length - 1].ts + 1)
            } catch { /* frame detached */ }
          }
          return { cmd: events[0].cmd, error: events[0].error }
        }
      } catch { /* frame detached */ }
    }
    await sleep(300)
  }
  return null
}

// ─── iDeck Monitor JS (injected before page load, runs in ALL frames) ────────
/**
 * Patches console.log in every frame to detect "successJson data: {cmd,error,...}"
 * responses from the hardware box and stores them in window.__ideckEvents.
 * stepIdeck polls this array via frame.evaluate() after each click.
 */
const IDECK_MONITOR_SCRIPT = `
(() => {
  if (window.__ideckMonitorInjected) return;
  window.__ideckMonitorInjected = true;
  window.__ideckEvents = [];
  var _origLog = console.log.bind(console);
  console.log = function() {
    _origLog.apply(console, arguments);
    try {
      var text = '';
      for (var i = 0; i < arguments.length; i++) {
        var a = arguments[i];
        text += (typeof a === 'string' ? a : JSON.stringify(a)) + ' ';
      }
      if (text.indexOf('successJson') !== -1) {
        var m = text.match(/"cmd"\\s*:\\s*"([^"]+)"[^}]{0,300}"error"\\s*:\\s*(\\d+)/);
        if (m) {
          window.__ideckEvents.push({ cmd: m[1], error: +m[2], ts: Date.now() });
        }
      }
    } catch(e) {}
  };
})();
`

// ─── GM Event Monitor JS (injected before page load, runs in ALL frames) ─────
/**
 * Hooks window.WebSocket to intercept raw frames and detect enterGMNtc / leaveGMNtc.
 * Falls back to patching console.log so pinus debug logs (e.g. "ON: enterGMNtc") are
 * also captured. Emits console.log("__gm_event:enterGMNtc", errcode, errcodedes) so
 * createGMEventWatcher's page.on('console') listener can pick it up.
 */
const GM_EVENT_MONITOR_SCRIPT = `
(() => {
  if (window.__gmMonitorInjected) return;
  window.__gmMonitorInjected = true;
  window.__gmEvents = [];

  function scanForGMEvent(text) {
    try {
      for (var i = 0; i < 2; i++) {
        var evName = i === 0 ? 'enterGMNtc' : 'leaveGMNtc';
        if (text.indexOf(evName) === -1) continue;
        var m1 = text.match(/"errcode"\\s*:\\s*(-?\\d+)/);
        var errcode = m1 ? parseInt(m1[1]) : 0;
        var m2 = text.match(/"errcodedes"\\s*:\\s*"([^"]*)"/);
        var errcodedes = m2 ? m2[1] : '';
        var m3 = text.match(/"machineType"\\s*:\\s*"([^"]*)"/);
        var machineType = m3 ? m3[1] : '';
        window.__gmEvents.push({ event: evName, errcode: errcode, errcodedes: errcodedes, machineType: machineType, ts: Date.now() });
        // Use a prefix that createGMEventWatcher's console listener recognises
        // Format: "__gm_event:<evName> <errcode> <errcodedes>||<machineType>"
        (window.__gmOrigLog || console.log)('__gm_event:' + evName, errcode, errcodedes + '||' + machineType);
        return;
      }
    } catch(e) {}
  }

  // Hook WebSocket constructor so we intercept frames before pinus decodes them
  var _OrigWS = window.WebSocket;
  function PatchedWS(url, protocols) {
    var ws = protocols !== undefined ? new _OrigWS(url, protocols) : new _OrigWS(url);
    ws.addEventListener('message', function(ev) {
      try {
        var text = '';
        if (typeof ev.data === 'string') {
          text = ev.data;
        } else if (ev.data instanceof ArrayBuffer) {
          text = new TextDecoder('iso-8859-1').decode(ev.data);
        }
        if (text) scanForGMEvent(text);
      } catch(e) {}
    });
    return ws; // returning non-undefined from constructor overrides 'this'
  }
  PatchedWS.prototype = _OrigWS.prototype;
  PatchedWS.CONNECTING = _OrigWS.CONNECTING;
  PatchedWS.OPEN = _OrigWS.OPEN;
  PatchedWS.CLOSING = _OrigWS.CLOSING;
  PatchedWS.CLOSED = _OrigWS.CLOSED;
  window.WebSocket = PatchedWS;

  // Also patch console.log to catch pinus debug style "ON: enterGMNtc" logs
  window.__gmOrigLog = console.log.bind(console);
  var _prev = console.log.bind(console);
  console.log = function() {
    _prev.apply(console, arguments);
    try {
      var text = '';
      for (var i = 0; i < arguments.length; i++) {
        var a = arguments[i];
        text += (typeof a === 'string' ? a : JSON.stringify(a)) + ' ';
      }
      // Skip our own emitted events to prevent loops
      if (text.indexOf('__gm_event:') !== -1) return;
      if (text.indexOf('enterGMNtc') !== -1 || text.indexOf('leaveGMNtc') !== -1) {
        scanForGMEvent(text);
      }
    } catch(e) {}
  };
})();
`

// ─── Audio Monitor JS (injected before page load) ────────────────────────────

const AUDIO_MONITOR_SCRIPT = `
(() => {
  if (window.__audioMonitorInjected) return;
  window.__audioMonitorInjected = true;
  window.__audioMonitor = { active: false, contexts: [], samples: [], error: null };

  const OrigAudioContext = window.AudioContext || window.webkitAudioContext;
  if (!OrigAudioContext) { window.__audioMonitor.error = 'AudioContext not supported'; return; }

  const origConnect = AudioNode.prototype.connect;

  const PatchedAudioContext = function(...args) {
    const ctx = new OrigAudioContext(...args);
    const mon = window.__audioMonitor;
    mon.active = true;

    const analyserMain = ctx.createAnalyser();
    analyserMain.fftSize = 2048;
    const splitter = ctx.createChannelSplitter(2);
    const analyserL = ctx.createAnalyser();
    const analyserR = ctx.createAnalyser();
    analyserL.fftSize = 2048;
    analyserR.fftSize = 2048;

    const inputGain = ctx.createGain();
    inputGain.gain.value = 1.0;
    inputGain.connect(analyserMain);
    inputGain.connect(splitter);
    splitter.connect(analyserL, 0);
    splitter.connect(analyserR, 1);
    inputGain.connect(ctx.destination);

    AudioNode.prototype.connect = function(dest, ...cArgs) {
      if (dest === ctx.destination) return origConnect.call(this, inputGain, ...cArgs);
      return origConnect.call(this, dest, ...cArgs);
    };

    mon.contexts.push({ ctx, analyserMain, analyserL, analyserR });

    const bufLen = analyserMain.frequencyBinCount;
    const dataMain = new Float32Array(bufLen);
    const dataL = new Float32Array(bufLen);
    const dataR = new Float32Array(bufLen);

    setInterval(() => {
      if (ctx.state !== 'running') return;
      analyserMain.getFloatTimeDomainData(dataMain);
      analyserL.getFloatTimeDomainData(dataL);
      analyserR.getFloatTimeDomainData(dataR);

      let sumSq = 0, peak = 0, clipCount = 0;
      let sumSqL = 0, sumSqR = 0, sumLR = 0;
      for (let i = 0; i < bufLen; i++) {
        const v = dataMain[i];
        sumSq += v * v;
        const absV = Math.abs(v);
        if (absV > peak) peak = absV;
        if (absV >= 0.95) clipCount++;
        const vL = dataL[i]; const vR = dataR[i];
        sumSqL += vL * vL; sumSqR += vR * vR; sumLR += vL * vR;
      }
      const rms = Math.sqrt(sumSq / bufLen);
      const rmsL = Math.sqrt(sumSqL / bufLen);
      const rmsR = Math.sqrt(sumSqR / bufLen);
      const denom = Math.sqrt(sumSqL * sumSqR);
      const correlation = denom > 0 ? sumLR / denom : 0;

      mon.samples.push({
        t: performance.now(),
        rms,
        rmsDb: rms > 0 ? 20 * Math.log10(rms) : -Infinity,
        peak,
        peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
        clipCount,
        clipRatio: clipCount / bufLen,
        rmsL, rmsR, correlation
      });
      if (mon.samples.length > 200) mon.samples.shift();
    }, 200);

    return ctx;
  };
  PatchedAudioContext.prototype = OrigAudioContext.prototype;
  window.AudioContext = PatchedAudioContext;
  if (window.webkitAudioContext) window.webkitAudioContext = PatchedAudioContext;
})();
`

// ─── Pinus Coin Tracker JS (injected before page load) ───────────────────────

export const PINUS_TRACKER_SCRIPT = `
(() => {
  if (window.__pinusTrackerInjected) return;
  window.__pinusTrackerInjected = true;
  window.__lastCoin = null;
  window.__coinUpdatedAt = 0;
  // 1007（0330 少 315 億）：__lastCoin 不分路由，任何帶 coin 的回應／推播都會寫進去——退出時大廳錢包會蓋掉機台餘額。
  // 機台餘額另外存，**只收 pinus.on 的 moneyNtc 推播**（request 回應一律不算）；開局／結束判斷也用這份流水（含 reason）。
  // 跟 AutoSpin（toppath-agent.py TOPPATH_MONITOR_SCRIPT）同一套做法
  window.__lastMachineCoin = null;
  window.__machineCoinAt = 0;
  window.__moneyLog = [];
  window.__moneySeq = 0;

  function tryPatch() {
    var p = window.pinus;
    if (!p) return false;
    if (p.__coinTracked) return true;
    p.__coinTracked = true;

    var origRequest = p.request.bind(p);
    p.request = function(route, msg, cb) {
      return origRequest(route, msg, function(resp) {
        if (resp && typeof resp.coin === 'number') {
          window.__lastCoin = resp.coin;
          window.__coinUpdatedAt = Date.now();
        }
        cb && cb(resp);
      });
    };

    var origOn = p.on.bind(p);
    p.on = function(route, cb) {
      return origOn(route, function(data) {
        if (data && typeof data.coin === 'number') {
          window.__lastCoin = data.coin;
          window.__coinUpdatedAt = Date.now();
        }
        if (route === 'moneyNtc' && data && typeof data.coin === 'number') {
          window.__lastMachineCoin = data.coin;
          window.__machineCoinAt = Date.now();
          window.__moneySeq = (window.__moneySeq || 0) + 1;
          window.__moneyLog.push({ seq: window.__moneySeq, coin: data.coin, reason: String(data.reason || ''), ts: Date.now() });
          if (window.__moneyLog.length > 200) window.__moneyLog.shift();
        }
        cb && cb(data);
      });
    };
    return true;
  }

  // 不在第一次成功後 clearInterval——center update/斷線重連時遊戲會建立全新的
  // window.pinus 物件（新 connector），__coinTracked 旗標掛在物件本身、不會延續，
  // 若只 patch 一次，重連後 coin 追蹤會永久停止（同步 toppath-agent.py 的修正）。
  setInterval(function() {
    tryPatch();
  }, 200);
})();
`

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

/** Sleep for `ms` but wake up early if `shouldStop()` returns true. Checks every 500ms. */
async function sleepOrStop(ms: number, shouldStop: () => boolean): Promise<void> {
  const interval = 500
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (shouldStop()) return
    await sleep(Math.min(interval, deadline - Date.now()))
  }
}

/**
 * Extract machine type from a code like "4179-JJBX-0001" → "JJBX"
 * Takes the segment that is all uppercase letters (no digits).
 */
function extractMachineType(machineCode: string): string {
  const parts = machineCode.split('-')
  for (const part of parts) {
    if (/^[A-Z]+$/.test(part)) return part
  }
  // fallback: return the longest non-numeric segment
  return parts.reduce((a, b) => (b.replace(/\d/g, '').length > a.replace(/\d/g, '').length ? b : a), '')
}

/**
 * OSMWatcher 回報「非 Normal」要連續維持多久才算特殊遊戲真的結束。
 * ⚠️ 2026-09-24（892-DRAGONLAW-0070／0073）：OSMWatcher 在兩次免費轉之間會短暫回 Normal，
 *    舊版一看到就判「特殊狀態結束」→ 跑去退出 → 人還坐在機台上 → 下一台一載入就回到這台的遊戲，
 *    連續汙染了 0071／0074／0075／0076 四台的結果。
 */
const NORMAL_STABLE_MS = 8000

/**
 * 每台機台最後一次收到 OSMWatcher 觀測的時間。OSMWatcher 每次推送都帶全部機台（不只變化的），
 * 所以「有沒有新觀測」可以拿來判斷資料是不是舊的——map 裡的值不會自己過期，
 * 不看時間的話，「連續正常 8 秒」可能只是同一筆舊資料放了 8 秒。
 * agent 收到 osm_status_update、伺服器收到 webhook 時呼叫 noteOsmObservation。
 */
const OSM_SEEN_AT = new Map<string, number>()
export function noteOsmObservation(machineId: string, at = Date.now()) { OSM_SEEN_AT.set(machineId, at) }
/** 觀測超過這麼久沒更新就當「現在狀態不明」，不依它點擊 */
const OSM_FRESH_MS = 15_000
/** 點了這麼多次、OSMWatcher 狀態都沒變，就停止補點改被動等（避免一直點、點到付費局） */
const MAX_ACTS_WITHOUT_CHANGE = 10

/**
 * 追蹤「特殊狀態是否真的結束」與「點擊有沒有效果」。
 * - 結束：非特殊狀態持續 NORMAL_STABLE_MS，且期間收到至少 2 筆**新的**觀測
 *   （來源沒有觀測時間可查時才退回純計時）。
 * - 可以點：最新觀測仍是特殊狀態、觀測是新鮮的、且沒有連續 MAX_ACTS_WITHOUT_CHANGE 次點了狀態沒變。
 */
export class OsmBonusTracker {
  private normalSince = 0
  private normalObs = 0
  private lastSeen = 0
  private lastStatus: number | undefined
  private actsSinceChange = 0
  gaveUpClicking = false
  constructor(private osmStatus: Map<string, number>, private machineCode: string, private seenAt: Map<string, number> = OSM_SEEN_AT) {}
  /** 每秒呼叫一次；回傳目前狀態與是否已確認結束 */
  tick(now = Date.now()): { status: number; inBonus: boolean; ended: boolean; fresh: boolean } {
    const status = this.osmStatus.get(this.machineCode) ?? 0
    const seen = this.seenAt.get(this.machineCode)
    const newObs = seen !== undefined && seen > this.lastSeen
    if (newObs) this.lastSeen = seen!
    const fresh = seen === undefined ? true : now - seen <= OSM_FRESH_MS
    if (status !== this.lastStatus) { this.lastStatus = status; this.actsSinceChange = 0; this.gaveUpClicking = false }
    const inBonus = BONUS_STATUSES.has(status)
    if (inBonus) { this.normalSince = 0; this.normalObs = 0; return { status, inBonus, ended: false, fresh } }
    if (!this.normalSince) { this.normalSince = now; this.normalObs = 0 }
    else if (newObs) this.normalObs++
    const obsOk = seen === undefined ? true : this.normalObs >= 2
    return { status, inBonus, ended: now - this.normalSince >= NORMAL_STABLE_MS && obsOk, fresh }
  }
  /** 現在可以做一次 bonus 動作嗎（呼叫端另外管 3 秒間隔） */
  mayAct(t: { inBonus: boolean; fresh: boolean }): boolean {
    if (!t.inBonus || !t.fresh) return false
    if (this.actsSinceChange >= MAX_ACTS_WITHOUT_CHANGE) { this.gaveUpClicking = true; return false }
    return true
  }
  noteAct() { this.actsSinceChange++ }
}

/**
 * Handle bonus round: execute the configured bonus action ONCE, then keep acting
 * until OSMWatcher status stays non-bonus for NORMAL_STABLE_MS (or 15-minute timeout).
 * Returns { waited, label } or null if OSMWatcher not connected / already normal.
 *
 * Flow:
 *  1. Execute the profile's bonusAction one time (spin / takewin / touchscreen) — see doBonusAction.
 *  2. Then repeat it every ~3s while status is still a bonus status.
 *  3. auto_wait: skip step 1 and 2 — just passively wait.
 *  Every loop also dismisses the game's own Tips dialog, which otherwise swallows all clicks.
 */
async function waitForNormalStatus(
  osmStatus: Map<string, number>,
  machineCode: string,
  page: Page,
  profile: MachineProfile | undefined,
  emit: (msg: string) => void,
  shouldStop: () => boolean = () => false,
  rescue?: () => Promise<MachineProfile | undefined>,   // 1003：特殊狀態 2 分鐘沒進展 → OCR 判斷＋自己學（回傳改過的 profile）
): Promise<{ waited: number; label: string } | null> {
  const current = osmStatus.get(machineCode)
  if (current === undefined) {
    emit(`ℹ️ OSMWatcher 未連線，跳過特殊狀態偵測`)
    return null
  }
  if (current === 0) {
    return null  // silent pass — called frequently between steps
  }
  if (current === 9) {
    emit(`⚠️ Handpay 狀態（需人工處理），跳過等待`)
    return { waited: 0, label: 'Handpay（跳過）' }
  }

  const label = OSM_STATUS_LABELS[current] ?? `狀態 ${current}`
  // 1003 使用者：新機種（沒有 profile）預設按 SPIN，不再預設只等
  let bonusAction = profile?.bonusAction ?? 'spin'
  emit(`偵測到特殊狀態：${label}，動作：${bonusAction}（依機台設定檔 ${profile?.machineType ?? '無'}）`)

  const start = Date.now()
  // Wait up to 15 min — no forced-continue WARN; real issues are caught by exit step
  const maxWait = 15 * 60 * 1000

  // ── Step 1: Execute the specified bonus action ONCE ──────────────────────
  await dismissGameTips(page, emit)
  if (bonusAction !== 'auto_wait') {
    await doBonusAction(page, profile, emit)
    await sleep(1000)
  }

  // ── Step 2: keep acting while in bonus; end after NORMAL_STABLE_MS of non-bonus (with fresh observations) ──
  let tracker = new OsmBonusTracker(osmStatus, machineCode)
  if (bonusAction !== 'auto_wait') tracker.noteAct()  // step 1 那一下
  let rescued = false
  let lastActAt = Date.now()
  let acts = bonusAction !== 'auto_wait' ? 1 : 0
  let warnedGiveUp = false
  while (Date.now() - start < maxWait) {
    if (shouldStop()) { emit(`⏹ 已停止，放棄等待特殊遊戲`); return { waited: Date.now() - start, label } }
    await sleep(1000)
    await dismissGameTips(page, emit)
    const t = tracker.tick()
    if (t.ended) {
      const waited = Date.now() - start
      emit(`特殊狀態結束（連續 ${NORMAL_STABLE_MS / 1000}s 正常且有新觀測），耗時 ${(waited / 1000).toFixed(0)}s，共操作 ${acts} 次`)
      return { waited, label }
    }
    // 1003：auto_wait 等了 2 分鐘、或照設定點了 10 次狀態都沒變 → 截圖 OCR 判斷怎麼推（只救一次）
    if (rescue && !rescued && Date.now() - start >= BONUS_STALL_MS && (bonusAction === 'auto_wait' || tracker.gaveUpClicking)) {
      rescued = true
      const p2 = await rescue()
      if (p2) { profile = p2; bonusAction = p2.bonusAction ?? bonusAction; tracker = new OsmBonusTracker(osmStatus, machineCode); lastActAt = 0; emit(`🧩 改用學到的方式推進：${bonusAction}`) }
    }
    if (bonusAction === 'auto_wait' || Date.now() - lastActAt <= 3000) continue
    if (tracker.mayAct(t)) {
      lastActAt = Date.now()
      await doBonusAction(page, profile, emit)
      tracker.noteAct()
      acts++
      if (acts % 10 === 0) emit(`（特殊遊戲進行中，已操作 ${acts} 次，${((Date.now() - start) / 1000).toFixed(0)}s）`)
    } else if (tracker.gaveUpClicking && !warnedGiveUp) {
      warnedGiveUp = true
      emit(`⚠️ 已操作 ${MAX_ACTS_WITHOUT_CHANGE} 次 OSMWatcher 狀態都沒變化，停止補點、改被動等待（請看畫面確認）`)
    }
  }

  // Exceeded 15 min — log and move on; exit step will catch real issues
  emit(`ℹ️ 等待超過 15 分鐘，強制繼續（退出步驟將驗證是否可正常離開）`)
  return { waited: maxWait, label }
}

/** 退出流程用（kind 'exit'：提示框擋著時仍可退出，但禁點名單照擋） */
async function safeClick(page: Page, selector: string): Promise<boolean> {
  try {
    const el = await page.$(selector)
    if (!el) return false
    return (await uiAct(page, 'exit', selector, el, () => page.evaluate((e: Element) => (e as HTMLElement).click(), el))) === 'clicked'
  } catch {
    return false
  }
}

async function safeClickXPath(page: Page, xpath: string): Promise<boolean> {
  try {
    const els = await page.$$(xpath)
    for (const el of els) {
      if (await el.isVisible()) {
        return (await uiAct(page, 'exit', xpath, el, () => page.evaluate((e: Element) => (e as HTMLElement).click(), el))) === 'clicked'
      }
    }
    return false
  } catch {
    return false
  }
}

/** Spin 按鈕候選，順序同 stepSpin（先內層可點的 .my-button，再外層）。 */
const SPIN_SELECTORS = [
  '.my-button.btn_spin',
  '.btn_spin .my-button',
  '.btn_spin',
  '[class*="btn_spin"] .my-button',
  '[class*="btn_spin"]',
]

/**
 * 真正的指標點擊：Playwright 原生 click → force click → 滑鼠點在元素中心。
 * ⚠️ 2026-09-24（892-DRAGONLAW-0070／0073）：FG 裡用 safeClick（DOM element.click()，
 *    不帶 pointer 事件）按 Spin 完全沒反應，畫面停在「PRESS SPIN BUTTON」空等 15 分鐘；
 *    同一顆鈕用真滑鼠按一下就開始轉。stepSpin 一直用原生 click，所以一般 Spin 沒這問題。
 * 回傳用了哪一種方式；找不到可見元素回 null。
 */
export async function nativeClick(page: Page, selectors: string[]): Promise<'native' | 'force' | 'mouse' | 'blocked' | null> {
  // 1007：每一種點法都走 uiAct（遊戲操作）；被擋就**整串停下**回 'blocked'，不改用 force／座標再點（CodeX）
  for (const sel of selectors) {
    let els: import('playwright').ElementHandle[] = []
    try { els = await page.$$(sel) } catch { continue }
    for (const el of els) {
      try { if (!await el.isVisible()) continue } catch { continue }
      try { const r = await uiAct(page, 'game', sel, el, () => el.click({ timeout: 3000 })); if (r === 'blocked') return 'blocked'; return 'native' } catch { /* try next */ }
      try { const r = await uiAct(page, 'game', sel, el, () => el.click({ force: true, timeout: 3000 })); if (r === 'blocked') return 'blocked'; return 'force' } catch { /* try next */ }
      try {
        const box = await el.boundingBox()
        if (box) { const r = await uiAct(page, 'game', sel, el, () => page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)); return r === 'blocked' ? 'blocked' : 'mouse' }
      } catch { /* give up on this element */ }
    }
  }
  return null
}
/** nativeClick 的結果算不算真的點到（'blocked' 不算） */
export const nativeClicked = (h: Awaited<ReturnType<typeof nativeClick>>): boolean => h === 'native' || h === 'force' || h === 'mouse'

/**
 * 遊戲自己跳的「Tips」確認框，會蓋住 Spin／Exit，讓後面所有點擊都落空。
 * 只處理已知、按 Confirm 無副作用的兩種：
 *   - 「Complete the bonus game within 15 minutes…」：FG 開頭提示（0924 DragonLaw 實測）
 *   - 「Game is running and cannot be quit」：遊戲進行中按了 Quit
 * 回傳命中的訊息（呼叫端用它判斷「遊戲是否進行中」），沒有就回 null。
 */
/**
 * 0930 使用者回報（BZZF）：退出被擋時，按過的 Exit（.reserve-btn-gray）會留下「Want to reserve this machine?」預約面板，
 * 我們只關了 cannot be quit 提示框、沒關這個面板 → 之後的 SPIN 全按在面板上（手動推 0254 時也中過）。
 * 只點右上角 X（.btn-close；Escape 無效，見 docs/reserve-and-troubleshooting.md）；**絕不點 Reserve Now**（會真的預約 24 小時）。
 */
export async function closeReservePanel(page: Page, emit: (msg: string) => void): Promise<boolean> {
  let open = false
  try { open = await page.evaluate(() => /Want to reserve this machine|Number of reservations remaining/i.test(document.body?.innerText ?? '')) } catch { return false }
  if (!open) return false
  try {
    const xs = page.locator('.btn-close')
    const n = await xs.count()
    for (let i = 0; i < n; i++) {
      const x = xs.nth(i)
      if (await x.isVisible()) { const h = await x.elementHandle(); await uiAct(page, 'popup', '預約面板 X', h, () => x.click({ timeout: 3000 })); emit('關閉預約面板（點 X，不預約）'); await sleep(500); return true }
    }
  } catch { /* 關不掉就讓呼叫端照原流程走 */ }
  emit('⚠️ 預約面板開著但找不到可見的 X（.btn-close）')
  return false
}

/**
 * 0930 使用者回報：別人中 JACKPOT 的全站廣播卡（前端元件 JackpotNotification，data-v-0bc5eb87）會蓋在機台畫面上，
 * 推流／CCTV／觸屏／iDeck 截圖都會拍到它（觸屏畫面比對也會被它干擾）。
 * 只點卡片右上角 X（`.notification-close`，emit clickClose）；**絕不點 `.view`（View）**——那會 emit watchMachine 跳去中獎那台。
 * 只在同一張卡片裡同時有 `.view` 時才點，避免誤點其他同名 class。
 */
export async function closeJackpotNotification(page: Page, emit?: (msg: string) => void): Promise<boolean> {
  const n = await page.evaluate(() => {
    let c = 0
    for (const x of Array.from(document.querySelectorAll('.notification-close'))) {
      const card = x.closest('.content')
      if (!card || !card.querySelector('.view')) continue
      const r = (x as HTMLElement).getBoundingClientRect()
      if (r.width < 4 || r.height < 4) continue
      ;(x as HTMLElement).click(); c++
    }
    return c
  }).catch(() => 0)
  if (n > 0) { emit?.(`關閉全站 JACKPOT 廣播卡 ${n} 張（點 X，不點 View）`); await sleep(600) }
  return n > 0
}

// ── 提示框處理（1007，規格 spec-mt-popup-handling-1007，CodeX 定案）──────────────────────────────────
// 辨識在 uat-runner/popup-catalog.js（兩邊共用），機台測試的處理方式在 verdicts.ts decidePopup。
// - scan()：掃**所有 frame** 的可見框 → close／ack 只點命中那個框裡的指定按鈕；stop／unknown 只記錄＋擋遊戲操作；wait 不動
// - 背景每 2 秒也掃（同一把操作鎖，拿到鎖後重查才點；擷取／錄音期間暫停），stop／never／unknown 背景只記錄
// - 所有遊戲操作的點擊都走 uiAct：被擋就回 blocked（不算成功、呼叫端不得改用 force／座標重試），逾時寫出蓋住它的前三層元素
export type PopupAct = 'game' | 'popup' | 'exit' | 'lobby'
export class PopupGuard {
  phase: PopupPhase = 'test'
  stop: Extract<PopupDecision, { kind: 'stop' }> | null = null
  unknown: { key: string; text: string; since: number; shot: string | null } | null = null
  /** 給步驟訊息用：上次 drain 之後遇到的框（一個框只記一次） */
  private pending: string[] = []
  private seen = new Set<string>()
  private tail: Promise<unknown> = Promise.resolve()
  private paused = 0
  private shots = 0
  private timer: ReturnType<typeof setInterval> | null = null
  constructor(readonly page: Page, private emit: (msg: string) => void, private file: string) {}
  /**
   * 操作鎖：背景掃描與步驟點擊序列化（CodeX：拿鎖後重查才點）。
   * **可重入**（CodeX 56e3d1b P1）：已經在這把鎖裡（例 scan 關面額 → dismissDenomOverlay → uiAct）就直接執行，
   * 不再排隊等自己——原本會互等死鎖，連退出都卡住。用 AsyncLocalStorage 認「是不是同一串呼叫」
   */
  private held = new AsyncLocalStorage<PopupGuard>()
  withLock<T>(fn: () => Promise<T>): Promise<T> {
    if (this.held.getStore() === this) return fn()
    const inner = () => this.held.run(this, fn)
    const run = this.tail.then(inner, inner)
    this.tail = run.catch(() => {})
    return run
  }
  /** stop／unknown 出現就擋遊戲操作（unknown 的 30 秒只是結案門檻） */
  blockReason(): string | null {
    if (this.stop) return `提示框「${this.stop.id}」：${this.stop.verdict}`
    if (this.unknown) return `未知提示框：${this.unknown.text.slice(0, 60)}`
    return null
  }
  unknownExpired(now = Date.now()): boolean { return !!this.unknown && now - this.unknown.since >= 30_000 }
  /** 退出前：未知框還沒滿 30 秒 → 每 stepMs 重查，直到框消失、滿 30 秒、或使用者停止（CodeX 56e3d1b P2） */
  async settleUnknown(stopped: () => boolean, stepMs = 2000): Promise<void> {
    while (!stopped() && this.unknown && !this.unknownExpired()) {
      await sleep(stepMs)
      await this.scan({ act: true, why: '退出前等未知框' }).catch(() => {})
    }
  }
  note(msg: string) { if (!this.seen.has(msg)) { this.seen.add(msg); this.pending.push(msg); this.emit(msg) } }
  drain(): string { const s = this.pending.join('｜'); this.pending = []; return s }
  pause() { this.paused++ }
  /** 擷取／錄音結束：恢復背景掃描並立刻補掃一次 */
  async resume() { this.paused = Math.max(0, this.paused - 1); if (!this.paused) await this.scan({ act: true, why: '擷取後補掃' }).catch(() => {}) }
  startWatch(intervalMs = 2000) {
    if (this.timer) return
    // exit()：計時器不繼承建立當下的鎖上下文（不然背景掃描會被當成「已在鎖裡」直接插隊）
    this.timer = this.held.exit(() => setInterval(() => { if (!this.paused) void this.scan({ act: true, why: '背景' }).catch(() => {}) }, intervalMs))
  }
  stopWatch() { if (this.timer) clearInterval(this.timer); this.timer = null }
  /** 掃一次。act＝要不要點 close／ack（背景與同步都會點，但都在鎖裡、點之前重查） */
  scan(o: { act: boolean; why: string }): Promise<PopupDecision[]> {
    return this.withLock(async () => {
      if (this.paused && o.why === '背景') return []
      const page = this.page
      if (popupGuardOf(page) === this) setInMachineFlag(page, true)   // 進機台後才載入／換頁的 frame 補設
      await closeJackpotNotification(page, this.emit)   // 全站 JP 廣播卡：只點 X（原本的處理）
      const found: Array<{ frame: import('playwright').Frame; box: PopupBox; d: PopupDecision }> = []
      for (const frame of page.frames()) {
        let boxes: PopupBox[] = []
        try { boxes = await frame.evaluate(POPUP_SNAPSHOT_IN_PAGE, { boxSelectors: POPUP_BOX_SELECTORS, probeSelectors: POPUP_PROBE_SELECTORS, minArea: POPUP_MIN_AREA }) as PopupBox[] } catch { continue }
        if (!Array.isArray(boxes)) continue
        for (const box of boxes) found.push({ frame, box, d: decidePopup(matchPopup(box), box.text, this.phase) })
      }
      // unknown：畫面上沒有任何認不得的框 → 解除；同一個框持續 → 保留起算時間
      const unk = found.find(f => f.d.kind === 'unknown')
      if (!unk) this.unknown = null
      else {
        const key = unk.box.text.slice(0, 80)
        if (!this.unknown || this.unknown.key !== key) {
          const shot = await this.evidence('unknown')
          this.unknown = { key, text: unk.box.text, since: Date.now(), shot }
          this.note(`未知提示框：${unk.box.text.slice(0, 200)}（class ${unk.box.cls.slice(0, 60)}）——不點，先擋遊戲操作${shot ? `｜截圖 ${shot}` : ''}`)
        }
      }
      for (const f of found) {
        const d = f.d
        if (d.kind === 'stop' && !this.stop) {
          this.stop = d
          const shot = await this.evidence(d.id)
          this.note(`🛑 提示框「${d.id}」：${f.box.text.slice(0, 120)} → 判定 ${d.verdict}（${d.scope === 'account' ? '換帳號' : '本台'}），停止遊戲操作${shot ? `｜截圖 ${shot}` : ''}`)
        }
        if (d.kind === 'wait') this.note(`提示框「${d.id}」：${f.box.text.slice(0, 80)} → 等它自己消失（最多 ${d.maxMs / 1000} 秒）`)
        if (!o.act || (d.kind !== 'ack' && d.kind !== 'close')) continue
        if (d.kind === 'close' && d.click === 'denom') { await dismissDenomOverlay(page, this.emit, `提示框（${o.why}）`); continue }
        const btn = pickPopupButton(f.box, d)
        if (!btn) { this.note(`提示框「${d.id}」：框裡找不到要按的鍵（${f.box.buttons.map(b => b.text || b.cls).join('／').slice(0, 80)}），不點`); continue }
        const never = isNeverClick(btn, f.box.text, { inMachine: true })
        if (never) { this.note(`⛔ 提示框「${d.id}」：要按的鍵「${btn.text}」在禁點名單（${never}），不點`); continue }
        // 點之前重查：同一個框、同一顆鍵還在（背景掃到之後畫面可能已經變了）
        const loc = f.frame.locator(`[data-mt-popup="${f.box.ref}"] [data-mt-btn="${btn.ref}"]`)
        const still = await loc.count().catch(() => 0)
        if (!still) continue
        const r = await clickLocatorCenter(page, loc)
        this.note(`提示框「${d.id}」（${o.why}）→ 按「${btn.text || btn.cls}」${r === 'clicked' ? '' : `失敗（${r}）`}`)
      }
      return found.map(f => f.d)
    })
  }
  private async evidence(tag: string): Promise<string | null> {
    if (this.shots >= 20) return null
    try {
      mkdirSync(POPUP_SAVE_DIR, { recursive: true })
      const p = join(POPUP_SAVE_DIR, `${this.file}-${++this.shots}-${tag}.png`)
      writeFileSync(p, await this.page.screenshot({ type: 'png' }))
      return p
    } catch { return null }
  }
}
type PopupBox = { ref: string; text: string; cls: string; selectors: string[]; buttons: Array<{ ref: string; text: string; selectors: string[]; cls: string }>; rect: { x: number; y: number; w: number; h: number } }
const POPUP_SAVE_DIR = join(MACHINE_TEST_ROOT, 'popup-saves')
/** 依決定挑框裡要按的那顆（Confirm 限定在這個框裡，優先 .box-btn_text2） */
export function pickPopupButton(box: PopupBox, d: PopupDecision): PopupBox['buttons'][number] | null {
  const b = box.buttons
  if (d.kind === 'ack' && d.click === 'confirm') return b.find(x => x.selectors.includes('.box-btn_text2')) ?? b.find(x => /^(confirm|ok|確認|确定)$/i.test(x.text)) ?? null
  if (d.kind === 'ack' && d.click === 'exitToLobby') return b.find(x => /^exit to lobby$/i.test(x.text)) ?? null
  if (d.kind === 'ack' && d.click === 'yes') return b.find(x => /^yes$/i.test(x.text)) ?? null
  if (d.kind === 'close' && d.click === 'closeX') return b.find(x => x.selectors.includes('.btn-close')) ?? null
  if (d.kind === 'close' && d.click === 'closeBtn') return b.find(x => x.selectors.includes('.closeBtn')) ?? null
  if (d.kind === 'close' && d.click === 'recommendClose') return b.find(x => x.selectors.includes('.recommend-close')) ?? null
  return null
}
const POPUP_GUARDS = new WeakMap<Page, PopupGuard>()
/** 1007 iDeck 時間學習：session → 機種 → 撤銷原因（同一批後面的台立刻改回保守；中控那邊由 batch 呼叫 revoke 寫入） */
const IDECK_REVOKED = new Map<string, Map<string, string>>()
export function popupGuardOf(page: Page): PopupGuard | undefined { return POPUP_GUARDS.get(page) }
export function attachPopupGuard(page: Page, emit: (msg: string) => void, file: string): PopupGuard {
  const g = new PopupGuard(page, emit, file)
  POPUP_GUARDS.set(page, g)
  setInMachineFlag(page, true)
  return g
}
export function detachPopupGuard(page: Page) { POPUP_GUARDS.get(page)?.stopWatch(); POPUP_GUARDS.delete(page); setInMachineFlag(page, false) }
/** 頁面內攔截的 inMachineOnly 規則（Join）只在機台裡生效：所有 frame 設 window.__mtInMachine（frame 換頁會重設成 undefined＝不擋，偏安全的方向是 runner 那層仍會擋） */
function setInMachineFlag(page: Page, on: boolean) {
  for (const f of page.frames()) f.evaluate((v: boolean) => { (window as unknown as { __mtInMachine?: boolean }).__mtInMachine = v }, on).catch(() => {})
}

/** 元素中心點最上層前三個元素（tag.class「字」），給點擊逾時的錯誤訊息用 */
async function describeCover(el: ElementHandle | null): Promise<string> {
  if (!el) return ''
  try {
    return await el.evaluate((node: Element) => {
      const r = node.getBoundingClientRect()
      const x = r.left + r.width / 2, y = r.top + r.height / 2
      return document.elementsFromPoint(x, y).slice(0, 3).map(e => `${e.tagName.toLowerCase()}${e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}${(e as HTMLElement).innerText ? `「${(e as HTMLElement).innerText.replace(/\s+/g, ' ').trim().slice(0, 20)}」` : ''}`).join(' ＞ ')
    })
  } catch { return '' }
}
/** 這個元素（或祖先）是不是禁點（在頁面裡判，跟 popup-catalog 的 NEVER_CLICK 同一份規則） */
type ElBoxInfo = { text: string; selectors: string[]; boxText: string; boxSelectors: string[]; inBox: boolean }
/** 元素所在的提示框（最外層那個，跟 POPUP_SNAPSHOT_IN_PAGE 一樣只算最外層）＋按鈕字。讀不到回 null */
async function elementBoxInfo(el: ElementHandle | null): Promise<ElBoxInfo | null> {
  if (!el) return null
  try {
    return await el.evaluate(ELEMENT_BOX_INFO_IN_PAGE as (node: Element, a: { probe: string[]; boxSel: string }) => ElBoxInfo, { probe: POPUP_PROBE_SELECTORS, boxSel: ['[data-mt-popup]', ...POPUP_BOX_SELECTORS].join(',') })
  } catch { return null }
}
/** 這個元素（或祖先）是不是禁點（跟 popup-catalog 的 NEVER_CLICK 同一份規則） */
function neverClickOf(info: ElBoxInfo | null, inMachine: boolean): string | null {
  if (!info) return null
  // selector 類（.view 等）只在提示框裡才算（CodeX：避免誤傷大廳別處的同名 class）
  return isNeverClick({ text: info.text, selectors: info.inBox ? info.selectors : [] }, info.boxText, { inMachine })
}
const CONFIRMISH = /^(confirm|ok|yes|確認|确定|確定|是)$/i
/**
 * 退出／關框類點擊的框限制（CodeX 56e3d1b P1）：按鈕在提示框裡 → 那個框要是**已辨識、而且這個階段可以按**的（ack／close）；
 * 認不得（unknown）或 stop 的框一律不按。按鈕不在任何框裡、但畫面上有未知框時，Confirm／OK 類也不按（可能就是未知框的鍵、只是框沒被認出來）
 */
function unrecognizedBoxBlock(info: ElBoxInfo | null, phase: PopupPhase, g: PopupGuard | undefined): string | null {
  // 讀不到元素資訊（evaluate 失敗、沒有元素）一律不按（CodeX c3831fe P1：fail closed，不看 guard 有沒有記到框——新框可能還沒被掃到）
  if (!info) return '讀不到按鈕所在的框，不按'
  if (info.inBox) {
    const d = decidePopup(matchPopup({ text: info.boxText, selectors: info.boxSelectors }), info.boxText, phase)
    // 只放行 ack／close（CodeX c3831fe P2：wait 框、例如 Quit game, please wait，也不能按）
    if (d.kind === 'ack' || d.kind === 'close') return null
    if (d.kind === 'unknown') return `框沒辨識出來（${info.boxText.slice(0, 40)}）`
    if (d.kind === 'stop') return `框是「${d.id}」（${d.verdict}），只記錄不按`
    return `框是「${d.id}」（${d.kind}），不按`
  }
  if (g?.unknown && CONFIRMISH.test(info.text)) return `畫面有未知提示框，不按「${info.text}」`
  return null
}
export type UiActResult = 'clicked' | 'blocked' | 'none'
/**
 * **所有點擊的唯一入口**（CodeX：38 處收斂）。kind：game＝遊戲操作（提示框擋著時不准）、exit＝退出流程、popup＝關框、lobby＝大廳。
 * - game 且 PopupGuard 有 stop／unknown → 'blocked'（不執行 fn）
 * - el 命中禁點名單 → 'blocked'
 * - 在操作鎖裡執行（背景掃描不會同時點）；fn 拋錯若像逾時，錯誤訊息補上蓋住它的前三層元素
 * 回 'blocked' 時呼叫端**不得**當成功、也不得改用 force／座標再點一次。
 */
export async function uiAct(page: Page, kind: PopupAct, label: string, el: ElementHandle | null, fn: () => Promise<unknown>): Promise<UiActResult> {
  const g = popupGuardOf(page)
  const run = async (): Promise<UiActResult> => {
    if (kind === 'game' && g?.blockReason()) { g.note(`⛔ 擋下「${label}」：${g.blockReason()}`); return 'blocked' }
    const info = await elementBoxInfo(el)
    // 大廳的 Join 是正常操作；guard 只在進機台之後才掛，所以「有 guard」＝在機台裡
    const never = neverClickOf(info, !!g)
    if (never) { g?.note(`⛔ 擋下「${label}」：禁點（${never}）`); return 'blocked' }
    if (kind === 'exit' || kind === 'popup') {
      const why = unrecognizedBoxBlock(info, kind === 'exit' ? 'exit' : (g?.phase ?? 'test'), g)
      if (why) { g?.note(`⛔ 擋下「${label}」：${why}`); return 'blocked' }
    }
    // 第二層（頁面內 capture 攔截）：fn 前後比對該 frame 的 __mtBlockedClicks，有增加＝事件被頁面內攔下，不算點到
    const blockedCount = async () => el ? el.evaluate(() => ((window as unknown as { __mtBlockedClicks?: unknown[] }).__mtBlockedClicks ?? []).length).catch(() => 0) : 0
    const before = await blockedCount()
    try {
      await fn()
      if ((await blockedCount()) > before) { g?.note(`⛔ 擋下「${label}」：頁面內攔截（禁點）`); return 'blocked' }
      return 'clicked'
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e)
      if (/timeout|intercepts pointer events/i.test(msg)) {
        const cover = await describeCover(el)
        const err = new Error(`點「${label}」逾時${cover ? `：被 ${cover} 蓋住` : ''}（${msg.split('\n')[0].slice(0, 120)}）`)
        if (e instanceof Error) err.name = e.name   // 呼叫端用 String(err) 判 TimeoutError
        throw err
      }
      throw e
    }
  }
  return g ? g.withLock(run) : run()
}
/** 觸屏格／遊戲元素的 force click（原本散在各處的 `t.click({ force: true, timeout: 5000 }).catch(() => {})`）。回 blocked＝沒點 */
export async function gameTap(page: Page, el: ElementHandle, label: string): Promise<UiActResult> {
  return uiAct(page, 'game', label, el, () => el.click({ force: true, timeout: 5000 })).catch(() => 'none' as const)
}

/** 用元素中心點一次真滑鼠點（提示框按鈕用；Locator 版） */
async function clickLocatorCenter(page: Page, loc: import('playwright').Locator): Promise<'clicked' | 'none'> {
  try {
    const box = await loc.first().boundingBox()
    if (!box) return 'none'
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    return 'clicked'
  } catch { return 'none' }
}

export async function dismissGameTips(page: Page, emit: (msg: string) => void): Promise<string | null> {
  // 1007：改走 PopupGuard.scan（所有 frame、處理表、Confirm 限定在命中的框裡）。沒有 guard（還沒進機台）時用一次性的
  const g = popupGuardOf(page) ?? new PopupGuard(page, emit, `adhoc-${Date.now()}`)
  const ds = await g.scan({ act: true, why: '同步' })
  // 回傳值沿用原本的意思：遊戲進行中的那兩種 Tips（decideExit 用「cannot be quit」判斷要不要推進）
  const hit = ds.find(d => d.id === 'cannot-quit') ? 'Game is running and cannot be quit' : ds.find(d => d.id === 'bonus-15min') ? 'Complete the bonus game within 15 minutes' : null
  return hit
}

/** 各機種特殊流程的補充設定（0930）：bonus-sequence.json，例 { "JJBXGRAND": { "thenSpin": true } } */
const BONUS_SEQUENCE_FILE = join(MACHINE_TEST_ROOT, 'bonus-sequence.json')
function bonusSequence(machineType?: string | null): { thenSpin?: boolean } | null {
  if (!machineType) return null
  try {
    const cfg = JSON.parse(readFileSync(BONUS_SEQUENCE_FILE, 'utf8')) as Record<string, { thenSpin?: boolean }>
    return cfg[machineType.toUpperCase()] ?? null
  } catch { return null }
}

/**
 * 依機台設定檔的 bonusAction 做「一次」啟動動作（FG／JP 需要玩家操作才會往下走）。
 * 設定檔是 Toppath Tools「機台配置」（machine_test_profiles）：spin／takewin／touchscreen／auto_wait。
 * 回傳是否真的有點到東西（auto_wait 固定 false）。
 */
async function doBonusAction(page: Page, profile: MachineProfile | undefined, emit: (msg: string) => void, extraSpinGuard?: () => Promise<{ ok: boolean; reason?: string }>): Promise<boolean> {
  const action = profile?.bonusAction ?? 'spin'   // 1003：沒有 profile 的新機種預設按 SPIN
  if (action === 'spin') {
    // 0929 0263 實況：iDeck 中了 DOUBLE feature 要按 SPIN 開始，但前端蓋著「SELECT A DENOMINATION」選單擋住 SPIN，
    // 退出重試按了 32 次 SPIN 都按在選單上、feature 從沒開始。Spin 步驟／iDeck 每次點之前都會先關這個選單，這裡原本漏了。
    await dismissDenomOverlay(page, emit, '特殊流程')
    const how = await nativeClick(page, [...(profile?.spinSelector ? [profile.spinSelector] : []), ...SPIN_SELECTORS])
    if (!how) emit(`（特殊流程：找不到可見的 Spin 按鈕）`)
    if (how === 'blocked') emit(`（特殊流程：提示框擋著，不按 SPIN）`)
    return nativeClicked(how)
  }
  if (action === 'takewin') {
    const how = await nativeClick(page, ['.btn_takewin', '[class*="takewin"]', '[class*="take-win"]', '[class*="take_win"]'])
    if (nativeClicked(how)) emit(`（執行特殊流程：TakeWin）`)
    return nativeClicked(how)
  }
  if (action === 'touchscreen') {
    // 流程（含兩段式「觸屏後 SPIN」的保護）在 verdicts.ts runTouchThenSpin，探針 scripts/touch-then-spin-probe.ts
    const r = await runTouchThenSpin({
      thenSpin: !!bonusSequence(profile?.machineType)?.thenSpin,
      taps: () => doTouchPoints(page, profile, emit),
      guard: extraSpinGuard,
      pressSpin: async () => {
        await dismissDenomOverlay(page, emit, '特殊流程（觸屏後 SPIN）')
        return nativeClicked(await nativeClick(page, [...(profile?.spinSelector ? [profile.spinSelector] : []), ...SPIN_SELECTORS]))
      },
    })
    if (r.spin === 'pressed') emit('（兩段式特殊流程：觸屏後按 SPIN）')
    else if (r.spin === 'blocked') emit(`（兩段式特殊流程：不按 SPIN——${r.reason}）`)
    else if (r.spin === 'noButton') emit('（兩段式特殊流程：找不到可見的 Spin 按鈕，這輪不按）')
    else if (r.spin === 'noGuard') emit('（兩段式特殊流程：這條呼叫路徑沒有額度保護，不多按 SPIN）')
    return r.tapped || r.spin === 'pressed'
  }
  return false
}

async function doTouchPoints(page: Page, profile: MachineProfile | undefined, emit: (msg: string) => void): Promise<boolean> {
  {
    const pts = profile?.touchPoints?.length ? profile.touchPoints : []
    let any = false
    for (const pt of pts) {
      try {
        const els = await page.$$(`//span[normalize-space(text())='${pt}']`)
        if (els.length > 0) {
          const r = await uiAct(page, 'game', `觸屏 ${pt}`, els[0], () => page.evaluate((el: Element) => (el as HTMLElement).click(), els[0]))
          if (r === 'blocked') { emit(`（觸屏「${pt}」被擋：提示框／禁點）`); break }
          emit(`（觸屏點擊: "${pt}"）`)
          any = true
        } else {
          emit(`（找不到觸屏元素: "${pt}"，略過）`)
        }
      } catch { /* ignore */ }
      await sleep(800)
    }
    if (profile?.clickTake) {
      if (nativeClicked(await nativeClick(page, ['.my-button.btn_take', '.btn_take']))) { emit(`（點擊 Take）`); any = true }
    }
    if (pts.length > 0) emit(`（特殊流程觸屏完成: ${pts.join(' → ')}）`)
    return any
  }
}
// ── JP／FG 點選 fallback（1006 ARUZE 0335）：特殊流程沒結束時依機種點位清單逐格點，流程在 verdicts.ts runFeatureTaps ──
// 清單放 feature-taps.json（機種＝代碼中段，例 873-ARUZE-0321 → ARUZE），跟 profile 的 touchPoints 分開——觸屏測試還在用那份。
// waitMs＝每格點完等多久看進展；minChange＝畫面變動要比「點之前兩張的雜訊」多出多少才算畫面有進展（只當暫停觀察訊號）。
// screenText＝「選擇畫面」的關鍵字。CodeX 1006：單靠逾時不夠，**OCR 確認畫面上真的是 JP／FG 選擇畫面才點**；
//   讀不到字、沒命中、OCR 失敗一律不點（決策紀錄在 docs/features/04-machine-test.md）
const FEATURE_TAPS_FILE = join(MACHINE_TEST_ROOT, 'feature-taps.json')
/** iDeck 開局卡住後，觸屏推進最多花多久（含每次畫面有進展後等 moneyNtc end 的 30 秒） */
const FEATURE_TAP_MAX_MS = 180_000
type FeatureTapsCfg = { points: FeatureTapPoint[]; waitMs: number; minChange: number; screenText: string[] }
function featureTapsConfig(machineCode: string): FeatureTapsCfg | null {
  try {
    const all = JSON.parse(readFileSync(FEATURE_TAPS_FILE, 'utf8')) as Record<string, { groups?: Array<{ name: string; taps: string[] }>; waitMs?: number; minChange?: number; screenText?: string[] }>
    const c = all[machineCode.split('-').slice(1, -1).join('-').toUpperCase()]
    const points = (c?.groups ?? []).flatMap(g => (g.taps ?? []).map(t => t.trim()).filter(t => /^\d+,\d+$/.test(t)).map(t => ({ point: t, group: g.name })))
    const screenText = (c?.screenText ?? []).filter(k => typeof k === 'string' && k.trim())
    // 沒有關鍵字＝沒辦法確認畫面 → 整份不啟用（寧可不點）
    return points.length && screenText.length ? { points, waitMs: c?.waitMs ?? 3000, minChange: c?.minChange ?? 0.05, screenText } : null
  } catch { return null }
}
/** 點一個「欄,列」觸屏格（.screen-touch 裡的透明 span，跟 doTouchPoints 同一種點法）；找不到回 false */
async function clickTouchCell(page: Page, pt: string, mustStop?: () => Promise<boolean>): Promise<boolean> {
  for (const frame of page.frames()) {
    try {
      const els = await frame.$$(`//span[normalize-space(text())='${pt}']`)
      if (!els.length) continue
      // 1007 CodeX 4c320d4 [P1]：查元素是非同步的，查的期間可能收到 end——找到之後、真的點之前再重查
      if (mustStop && await mustStop()) return false
      return (await uiAct(page, 'game', `觸屏 ${pt}`, els[0], () => els[0].evaluate((e: Element) => (e as HTMLElement).click()))) === 'clicked'
    } catch { /* frame detached */ }
  }
  return false
}
/**
 * 一輪：先 OCR 確認在選擇畫面 → 從 start 那格開始點，一有進展就回來。
 * 回傳 result：done／screen／exhausted／stopped／unsure（截圖失敗，要交人工）／notOnScreen（沒確認是選擇畫面，一下都沒點）。
 * 每一下都 emit「點觸屏 x,y → 有／無進展」（0335 那次 batch log 沒有任何點擊紀錄）。
 */
/** onTapped：每真的點下去一格就呼叫（呼叫端用它把這一輪的點擊即時算進動作上限，stop 才擋得住） */
async function featureTapRound(page: Page, emit: (msg: string) => void, cfg: FeatureTapsCfg, start: number, ended: () => boolean, stop: () => boolean, why: string, onTapped?: () => void, mustStop?: () => Promise<boolean>) {
  let sawEnd = false
  const onC = (m: ConsoleMessage) => {
    const t = m.text()
    if (!/moneyNtc/.test(t)) return
    if (/reason['"]?\s*:\s*['"]?end/.test(t)) { sawEnd = true; return }
    void Promise.all(m.args().slice(1).map(a => a.jsonValue().catch(() => null))).then(vs => {
      if (vs.some(v => v && typeof v === 'object' && (v as Record<string, unknown>).reason === 'end')) sawEnd = true
    })
  }
  const isOver = () => sawEnd || ended()
  const halt = () => isOver() || stop()
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`
  const shot = () => page.screenshot({ type: 'png' }).catch(() => null)
  const none = (result: 'unsure' | 'notOnScreen' | 'stopped', note: string) => ({ cursor: start, result, log: [] as FeatureTapLog[], tapped: 0, note })
  page.on('console', onC)
  try {
    await closeJackpotNotification(page, emit)
    const n0 = await shot()
    if (!n0) { emit(`🆘 ${why}：截圖失敗，沒辦法確認畫面 → 不點觸屏，請人工確認`); return none('unsure', '截圖失敗') }
    let ocr = ''
    try { ocr = (await callGeminiVisionViaProxy(BONUS_OCR_PROMPT, n0.toString('base64'))).trim() } catch (e) { emit(`（選擇畫面 OCR 失敗：${String(e).slice(0, 80)}）`) }
    const hit = onFeatureSelectScreen(ocr, cfg.screenText)
    if (!hit) {
      emit(`${why}：OCR 沒看到 JP／FG 選擇畫面（「${ocr.replace(/\s+/g, ' ').slice(0, 100) || '讀不到字'}」）→ 不點觸屏`)
      return none('notOnScreen', 'OCR 沒確認是選擇畫面')
    }
    await sleep(1000)
    const n1 = await shot()
    if (!n1) { emit(`🆘 ${why}：截圖失敗，量不到畫面雜訊 → 不點觸屏，請人工確認`); return none('unsure', '截圖失敗') }
    const noise = diffRatio(n0, n1)
    emit(`🎯 ${why} → OCR 命中「${hit}」，依機種點位清單逐格點（第 ${start + 1}/${cfg.points.length} 格起，畫面雜訊 ${pct(noise)}）`)
    let pre: Buffer | null = null
    const r = await runFeatureTaps({
      points: cfg.points, start, stop: halt,
      tap: async pt => {
        await closeJackpotNotification(page, emit)
        pre = await shot()
        if (!pre) return 'unsure'
        if (halt()) return 'stop'   // CodeX 1006：真的點下去之前再查一次結束／停止／時限
        if (mustStop && await mustStop()) return 'stop'   // 1007 CodeX 35d17c9：疑似特殊遊戲路徑逐下 await 重讀流水，不靠快取
        const ok = await clickTouchCell(page, pt, mustStop)
        if (ok) onTapped?.()
        return ok ? 'ok' : 'noElement'
      },
      check: async () => {
        const until = Date.now() + cfg.waitMs
        while (Date.now() < until && !isOver()) await sleep(250)
        if (isOver()) return { result: 'done' as const, note: 'moneyNtc end' }
        const post = await shot()
        if (!pre || !post) return { result: 'unsure' as const, note: '點之後截圖失敗' }
        const ch = diffRatio(pre, post)
        const note = `畫面變動 ${pct(ch)}（雜訊 ${pct(noise)}）`
        return ch > noise + cfg.minChange ? { result: 'screen' as const, note } : { result: 'none' as const, note }
      },
      onLog: (l: FeatureTapLog) => emit(`點觸屏 ${l.point}（${l.group}）→ ${l.result === 'done' || l.result === 'screen' ? '有進展' : l.result === 'unsure' ? '量不到' : '無進展'}${l.result === 'noElement' ? '（頁面找不到這格）' : l.note ? `｜${l.note}` : ''}`),
    })
    if (r.result === 'unsure') emit(`🆘 ${why}：截圖失敗，停止點觸屏，請人工確認這台畫面`)
    return { ...r, tapped: r.log.filter(l => l.result !== 'noElement' && !(l.result === 'unsure' && l.note?.startsWith('點之前'))).length, note: '' }
  } finally {
    page.off('console', onC)
  }
}

// 0930 JJBXGRAND 0337：feature 是兩段式——先點金幣（觸屏）翻完，再進 FREE GAMES 要按 SPIN。
// 中控的 bonusAction 只能選一種，所以用 bonus-sequence.json 標記「觸屏之後再按一下 SPIN」的機種（不動中控 schema）。
// 多按的 SPIN 只在呼叫端給了 guard（額度／停止／Handpay）時才按，目前只有盲推路徑給；guard 在點完觸屏之後才判斷。
// 選金幣階段按 SPIN 是否＝畫面的「PRESS PLAY TO AUTOPICK」**待實機驗證**。

// ── 特殊遊戲 2 分鐘沒進展 → 截圖 OCR 判斷 → 自己學怎麼推（2026-10-03，使用者規格）────────────────
// 使用者：「2 分鐘機制保留，但要先截圖做 OCR 判斷，因為有的遊戲不是按 SPIN，而是要點觸屏上的金幣點位，需要自行學習」
// 固定第一步：先關前端 SELECT A DENOMINATION 浮層（使用者：要記住；1562 沒關時按 40 下盒子 0 筆）。
// OCR 只取畫面文字，判斷用規則（純函式，探針可測）：叫玩家點東西＝touch、叫按 SPIN／PLAY＝spin、結算畫面＝wait、其他＝unknown（不亂按、回報人）。
// 每一下之前都確認影像辨識仍是特殊狀態（isSpecial），結束就停——避免變成付費下注。
export const BONUS_STALL_MS = 120_000
export type BonusPlanAction = 'spin' | 'touch' | 'wait' | 'unknown'
export function classifyBonusText(raw: string): BonusPlanAction {
  const t = ` ${String(raw ?? '').toLowerCase().replace(/\s+/g, ' ')} `
  // 選面額選單不算 bonus 指示（那是閘門的事）
  const s = t.replace(/(choose|select) (your|a) denomination/g, ' ')
  if (/[^a-z](pick|touch|tap)[^a-z]|(select|choose) (a|an|your|one|the) (coin|card|symbol|gem|envelope|box|chest|tile)|touch (the )?screen/.test(s)) return 'touch'
  if (/press (the )?(spin|play)|spin to (start|continue|play)|spins? remaining|free (game|spin)s?|re-?spins?|press (spin|play) to/.test(s)) return 'spin'
  if (/you win|total win|congratulations|bonus (complete|over|end)|collect/.test(s)) return 'wait'
  return 'unknown'
}
export interface BonusLearn { action: 'spin' | 'touchscreen'; touchPoints?: string[]; ocr: string; note: string; shots: string[] }
const BONUS_SAVE_DIR = join(MACHINE_TEST_ROOT, 'bonus-saves')
const BONUS_OCR_PROMPT = 'This is a screenshot of a slot machine screen during a bonus / free game / jackpot feature. Transcribe ALL visible English text exactly as shown (instructions, buttons, counters), one item per line. Output only the text.'
/**
 * 未監控機台「開局沒結束」的處理器（1007，規格 A；判斷與安全規則在 verdicts.ts superviseOpenRound／openRoundTrigger，探針 scripts/open-round-probe.ts）。
 * 綁定「這次進機台」：sinceSeq＝進機台時 moneyNtc 流水的序號，換台就是新的處理器。
 * 回傳 null＝不需要處理（沒有開著的局／沒有 moneyNtc 訊號／OSMWatcher 有監控交給原流程）。
 */
export type OpenRoundHandler = (where: string) => Promise<{ result: 'done' | 'stalled' | 'stopped'; note: string } | null>

/**
 * 疑似特殊遊戲時，畫面上的 SPIN 指示算不算「特殊遊戲中」的證據（CodeX 2d513b6 [P1]）。
 * classifyBonusText 會把普通局的「PRESS PLAY TO SPIN」也判成 spin——end 漏送時照它按就是付費下注。
 * 所以這裡另外要有**特殊遊戲字樣**（FREE GAMES／FREE SPINS／SPINS REMAINING／RE-SPIN／BONUS／FEATURE／JACKPOT），沒有就當看不出來。
 */
export function openRoundScreen(raw: string): 'spin' | 'touch' | 'wait' | 'unknown' {
  const t = String(raw ?? '').toLowerCase().replace(/\s+/g, ' ')
  // 結算畫面（BONUS COMPLETE／TOTAL WIN／CONGRATULATIONS…）不是局中：即使同畫面有 PRESS PLAY TO SPIN 也不按（CodeX 35d17c9 [P1]）
  if (/total win|bonus (complete|over|end)|feature (complete|over|end)|congratulations|you (have )?won?\b|collect/.test(t)) return 'wait'
  const k = classifyBonusText(raw)
  if (k !== 'spin') return k
  // 局中證據要是**計數器**（FREE GAMES 3／3 SPINS REMAINING／RE-SPINS: 2／SPINS LEFT 5）——
  // JACKPOT／BONUS／FEATURE 這種字普通局也常駐在畫面上（獎池看板、按鈕），不能當證據
  const counter = /(?:free ?(?:games?|spins?)|re-?spins?)\s*[:：x×]?\s*(\d+)|(\d+)\s*(?:free ?)?(?:games?|spins?|re-?spins?)\s*(?:remaining|left)|(?:games?|spins?) (?:remaining|left)\s*[:：]?\s*(\d+)/g
  const counts = [...t.matchAll(counter)].map(m => Number(m[1] ?? m[2] ?? m[3]))
  if (!counts.length) return 'unknown'
  // 剩 0 次＝已經跑完、等結算，不是局中證據（CodeX 4c320d4 [P1]：「0 SPINS REMAINING PRESS PLAY TO SPIN」會按下去）
  return counts.some(n => n > 0) ? 'spin' : 'wait'
}

/**
 * 疑似特殊遊戲路徑的點擊：每一種嘗試（原生 click → force → 滑鼠座標）**之前都 await 重查**（CodeX 35d17c9 [P1]：
 * nativeClick 第一次等待逾時期間收到 end，接著 force click 仍點下去）。回 'stopped'＝重查判定不能點，'none'＝找不到可見元素
 */
async function guardedClick(page: Page, selectors: string[], mustStop: () => Promise<boolean>): Promise<'clicked' | 'stopped' | 'none'> {
  // CodeX 4c320d4 [P1]：重查之後只要還隔著任何非同步查詢（boundingBox、Playwright click 的自動等待），end 都可能在中間到。
  // 所以只用一種點法：先取座標 → 重查 → 立刻一次真滑鼠點（9/24 DragonLaw FG 證實真滑鼠點得動 SPIN）；不做原生／force 的重試鏈
  for (const sel of selectors) {
    let els: ElementHandle[] = []
    try { els = await page.$$(sel) } catch { continue }
    for (const el of els) {
      let box: { x: number; y: number; width: number; height: number } | null = null
      try { if (!await el.isVisible()) continue; box = await el.boundingBox() } catch { continue }
      if (!box || box.width < 1 || box.height < 1) continue
      if (await mustStop()) return 'stopped'
      try {
        const r = await uiAct(page, 'game', sel, el, () => page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2))
        return r === 'blocked' ? 'stopped' : 'clicked'
      } catch { return 'none' }
    }
  }
  return 'none'
}

export function makeOpenRoundHandler(o: {
  page: Page; emit: (msg: string) => void; machineCode: string; getProfile: () => MachineProfile | undefined
  sinceSeq: number; osmStatus: () => number | undefined; stopped: () => boolean; filePrefix: string
  /** 測試用：換掉截圖 OCR（預設走 Gemini 代理） */
  ocr?: (png: Buffer) => Promise<string>
  /** 測試用：換掉每輪間隔／點擊間隔 */
  timing?: { pollMs?: number; quietMs?: number; maxMs?: number; maxActs?: number }
}): OpenRoundHandler {
  const { page, emit, machineCode } = o
  const ocr = o.ocr ?? (async (png: Buffer) => callGeminiVisionViaProxy(BONUS_OCR_PROMPT, png.toString('base64')))
  // 同一局已經判過 stalled／stopped → 之後再問直接回同一個結果，不重跑 8 分鐘（呼叫端據此停手交人工）
  let failed: { beginSeq: number; result: 'stalled' | 'stopped'; note: string } | null = null
  return async (where: string) => {
    let trg = openRoundTrigger({ log: await readMoneyLog(page), sinceSeq: o.sinceSeq, now: Date.now(), osmStatus: o.osmStatus() })
    // 局還年輕（< 35 秒）：等到滿門檻或收到 end 再判斷——正常局最長 28 秒
    // ⚠️ 用 === false 收窄（這個 tsconfig 下 !trg.start 不會把 union 收窄）
    while (trg.start === false && trg.why === 'young' && !o.stopped()) {
      await sleep(Math.min((trg.waitMs ?? 0) + 300, 5000))
      trg = openRoundTrigger({ log: await readMoneyLog(page), sinceSeq: o.sinceSeq, now: Date.now(), osmStatus: o.osmStatus() })
    }
    if (trg.start === false) return null
    const beginSeq = trg.beginSeq
    if (failed && failed.beginSeq === beginSeq) return { result: failed.result, note: failed.note }
    const maxActs = o.timing?.maxActs ?? 60
    let handpay = false, taps = 0
    // 每一下點擊前都**重讀** moneyNtc 流水（CodeX 2d513b6 [P1]：不能只看快取）
    const endedNow = async () => (await readMoneyLog(page)).some(e => e.seq > beginSeq && e.reason === 'end')
    let endedFlag = false
    const ended = async () => { if (await endedNow()) endedFlag = true; return endedFlag }
    const stop = () => o.stopped() || handpay
    /** 每一下真的點之前 await：重讀流水＋停止狀態（沒有快取） */
    // 讀流水是非同步的：讀的期間可能收到停止 → 讀完再看一次停止（CodeX edd347b [P1]）
    const mustStop = async () => stop() || await ended() || stop()
    const profile = o.getProfile()
    const action = profile?.bonusAction ?? 'spin'
    emit(`🎰 ${where}：疑似特殊遊戲（未監控，依 moneyNtc 判斷）——開局 ${(trg.ageMs / 1000).toFixed(0)} 秒還沒結束，依 ${action} 推進到收到 end 為止`)
    const ft = featureTapsConfig(machineCode)
    let ftCursor = 0
    try {
      const r = await superviseOpenRound({
        ended, stop,
        lastMoneyAgo: async () => { const l = await readMoneyLog(page); return l.length ? Date.now() - l[l.length - 1].ts : Number.POSITIVE_INFINITY },
        closeOverlays: async () => {
          await dismissGameTips(page, emit)
          await dismissDenomOverlay(page, emit, '疑似特殊遊戲')
          handpay = /hand\s*-?\s*pay/i.test(await page.evaluate(() => document.body?.innerText ?? '').catch(() => ''))
          if (handpay) emit('⚠️ 畫面出現 Handpay → 停止推進，需人工處理')
        },
        featureTaps: ft ? async (budget: number) => {
          let n = 0
          const fr = await featureTapRound(page, emit, ft, ftCursor, () => endedFlag, () => stop() || n >= budget, `${where} 疑似特殊遊戲（可能卡在 JP／FG 選擇畫面）`, () => { n++ }, mustStop)
          ftCursor = fr.cursor; taps += n
          return { kind: fr.result === 'screen' || fr.result === 'done' ? 'progress' : fr.result === 'stopped' ? 'none' : 'giveUp', taps: n }
        } : undefined,
        action,
        screen: async () => {
          const shot = await page.screenshot({ type: 'png' }).catch(() => null)
          if (!shot) return 'fail'
          try { return openRoundScreen(await ocr(shot)) } catch { return 'fail' }
        },
        pressSpin: async () => {
          const r = await guardedClick(page, [...(profile?.spinSelector ? [profile.spinSelector] : []), ...SPIN_SELECTORS], mustStop)
          if (r === 'clicked') taps++
          return r === 'clicked'
        },
        // 逐格點：每一格點之前都重讀流水與停止狀態（doTouchPoints 一次點完整串，中間不會停）
        touch: async (budget: number) => {
          let n = 0
          for (const pt of profile?.touchPoints ?? []) {
            if (n >= budget || await mustStop()) break
            if (await clickTouchCell(page, pt, mustStop)) { n++; emit(`（疑似特殊遊戲：觸屏點擊 "${pt}"）`) }
            await sleep(800)
          }
          taps += n
          return n
        },
        // ⚠️ 不接卡住救援（bonusStallRescue）：它用 classifyBonusText 判斷要不要按 SPIN，普通局畫面也會被判成 spin，
        //    內層點擊也沒有逐下重讀 end。卡住就 stalled、交人工（CodeX 2d513b6 [P1]）
        now: Date.now, sleep: async ms => { await sleep(ms) },
        maxMs: o.timing?.maxMs ?? 8 * 60_000, maxActs, quietMs: o.timing?.quietMs ?? 8_000, pollMs: o.timing?.pollMs ?? 8_000, stallMs: BONUS_STALL_MS,
      })
      const ways = [...new Set(r.how.map(h => h.replace(/\(.*\)$/, '')))].join('、') || '只等待'
      const note = `疑似特殊遊戲（未監控，依 moneyNtc 判斷）：處理方式 ${ways}，實際點擊 ${taps} 下，耗時 ${(r.ms / 1000).toFixed(0)} 秒，結果 ${r.result === 'done' ? 'done（收到 end）' : `${r.result}${handpay ? '（Handpay）' : ''}——已停止自動操作，請人工處理`}`
      emit(`${r.result === 'done' ? '✅' : '🆘'} ${where}：${note}`)
      if (r.result !== 'done') failed = { beginSeq, result: r.result, note }
      return { result: r.result, note }
    } finally { /* 沒有背景計時器要收 */ }
  }
}

async function bonusStallRescue(page: Page, emit: (msg: string) => void, machineCode: string, isSpecial: () => boolean, file: string): Promise<{ learn: BonusLearn | null; note: string }> {
  const shots: string[] = []
  const grab = async (tag: string) => {
    const box = await mainVideoBox(page, machineCode)
    if (!box) return null
    const buf = await page.screenshot({ type: 'png', clip: { x: Math.max(0, box.x), y: Math.max(0, box.y), width: box.width, height: box.height } }).catch(() => null)
    if (!buf) return null
    try { mkdirSync(BONUS_SAVE_DIR, { recursive: true }); const p = join(BONUS_SAVE_DIR, `${file}-${shots.length + 1}-${tag}.png`); writeFileSync(p, buf); shots.push(p) } catch { /* 證據存不了不影響 */ }
    return { buf, png: PNG.sync.read(buf), box }
  }
  const changed = (a: { png: InstanceType<typeof PNG> }, b: { buf: Buffer }) => regionDiff(b.buf, a.png, [0, 0, 1, 1])
  await dismissDenomOverlay(page, emit, '特殊遊戲卡住救援（固定第一步）')
  await dismissGameTips(page, emit)
  const s0 = await grab('before')
  if (!s0) return { learn: null, note: '找不到 main 推流畫面，沒辦法判斷' }
  let ocr = ''
  try { ocr = (await callGeminiVisionViaProxy(BONUS_OCR_PROMPT, s0.buf.toString('base64'))).trim() } catch (e) { emit(`（OCR 失敗：${String(e).slice(0, 80)}）`) }
  const plan = classifyBonusText(ocr)
  emit(`🧩 特殊遊戲 ${BONUS_STALL_MS / 60000} 分鐘沒進展 → OCR：「${ocr.replace(/\s+/g, ' ').slice(0, 160) || '（讀不到字）'}」→ 判斷：${plan}`)
  if (plan === 'spin') {
    if (!isSpecial()) return { learn: null, note: '已不是特殊狀態，不按' }
    const how = await nativeClick(page, SPIN_SELECTORS)
    await sleep(4000)
    const s1 = await grab('after-spin')
    const d = s1 ? changed(s0, s1) : 0
    emit(`🧩 按 SPIN（${how ?? '找不到按鈕'}）→ 畫面變化 ${(d * 100).toFixed(0)}%${isSpecial() ? '' : '、特殊狀態已結束'}`)
    if (how && (d > 0.05 || !isSpecial())) return { learn: { action: 'spin', ocr, note: `OCR 判斷要按 SPIN，按了畫面有變（${(d * 100).toFixed(0)}%）`, shots }, note: '學到：按 SPIN' }
    return { learn: null, note: `OCR 判斷要按 SPIN，但按了畫面沒變化（${(d * 100).toFixed(0)}%）` }
  }
  if (plan === 'touch') {
    // 自己學點位：在盤面（推流框中間 20%～90% 高、10%～90% 寬）逐格試點，「點了畫面有變」的格子就是有效點位（JJBXGRAND 金幣那種）
    const pts = [0.25, 0.4, 0.55, 0.7, 0.85].flatMap(fy => [0.15, 0.32, 0.5, 0.68, 0.85].map(fx => ({ label: '', fx, fy })))
    const { hits } = await touchCellsAt(page, s0.box, pts)
    const cells = [...new Set(hits.map(h => h.cell).filter((c): c is string => !!c))].slice(0, 20)
    emit(`🧩 OCR 判斷要點觸屏 → 盤面逐格試點，候選 ${cells.length} 格`)
    const good: string[] = []
    let prev = s0
    for (const c of cells) {
      if (!isSpecial()) { emit('🧩 特殊狀態已結束，停止試點'); break }
      const t = await findTouchTarget(page, c)
      if (!t) continue
      await gameTap(page, t, '觸屏')
      await sleep(2500)
      const s1 = await grab(`touch-${c.replace(',', '_')}`)
      if (!s1) continue
      const d = changed(prev, s1)
      if (d > 0.03) { good.push(c); emit(`🧩 點 ${c} → 畫面有變（${(d * 100).toFixed(0)}%），記下來`) }
      prev = s1
    }
    if (good.length) return { learn: { action: 'touchscreen', touchPoints: good, ocr, note: `OCR 判斷要點觸屏，試出 ${good.length} 格有效：${good.join('、')}`, shots }, note: `學到：點觸屏 ${good.join('、')}` }
    return { learn: null, note: `OCR 判斷要點觸屏，但試了 ${cells.length} 格畫面都沒變` }
  }
  if (plan === 'wait') return { learn: null, note: 'OCR 看起來是結算畫面，繼續等' }
  emit(`🆘 特殊遊戲卡住、看不懂畫面要做什麼（OCR：「${ocr.replace(/\s+/g, ' ').slice(0, 120)}」）→ 不亂按，請人看截圖 ${shots[0] ?? ''}`)
  return { learn: null, note: '看不懂畫面，交人工' }
}

export type ExitDecision =
  | { kind: 'done'; note: string }
  | { kind: 'unconfirmed'; note: string }
  | { kind: 'halt'; reason: string }
  | { kind: 'advance'; why: string }
  | { kind: 'retry' }

/**
 * 退出後下一步怎麼做（純函式，方便單獨測）。規則見 runMachine 裡 exitUntilLobby 的註解。
 * passed：stepExit 回 pass；inGame：此刻是否仍在遊戲內；code：leaveGMNtc errcode；
 * osm：OSMWatcher 狀態；tip：遊戲自己跳的提示（dismissGameTips 的回傳）。
 */
export function decideExit(i: { passed: boolean; inGame: boolean; code: number | null; osm: number | undefined; tip: string | null }): ExitDecision {
  // 成功要有「本次」leaveGMNtc errcode=0 ＋ 大廳可見；只有大廳畫面、沒收到回覆 → 不算成功（未確認）
  // （stepExit 在點退出前才掛 leaveGMNtc 監聽、不留緩衝，所以拿到的一定是這次退出的回覆）
  if (!i.inGame && i.code === 0) return { kind: 'done', note: '' }
  if (!i.inGame && i.code === 25) return { kind: 'done', note: 'leaveGMNtc errcode=25：玩家已不在機台上' }
  if (i.osm === 9 || i.code === 1026) {
    return { kind: 'halt', reason: `Handpay（${i.code === 1026 ? 'leaveGMNtc errcode=1026' : 'OSMWatcher 狀態 9'}），需人工處理` }
  }
  if (i.code !== null && i.code !== 0 && i.code !== 10002 && i.code !== 25) {
    return { kind: 'halt', reason: `leaveGMNtc errcode=${i.code}——可能是 AFT 轉出失敗，帳號額度可能還在機台上，需人工處理` }
  }
  if (i.code === 10002) return { kind: 'advance', why: 'leaveGMNtc errcode 10002' }
  if (i.osm !== undefined && BONUS_STATUSES.has(i.osm)) return { kind: 'advance', why: `OSMWatcher：${OSM_STATUS_LABELS[i.osm] ?? i.osm}` }
  if (i.tip && /cannot be quit/i.test(i.tip)) return { kind: 'advance', why: `遊戲提示「${i.tip}」` }
  if (!i.inGame && i.code === null) return { kind: 'unconfirmed', note: '已回到大廳但沒收到 leaveGMNtc，無法確認已轉出／離機' }
  return { kind: 'retry' }
}

/** 從 stepExit 的訊息取出 leaveGMNtc errcode（沒有就回 null） */
export function parseLeaveErrcode(message: string): number | null {
  const m = message.match(/errcode[ =](\d+)/)
  return m ? Number(m[1]) : null
}

/** Extract gameid from URL query string, e.g. "...&gameid=osmbwjl&..." → "osmbwjl" */
function extractGameId(url: string): string | null {
  try {
    const match = url.match(/[?&]gameid=([^&]+)/i)
    return match ? match[1].toLowerCase() : null
  } catch {
    return null
  }
}

async function isInGame(page: Page): Promise<boolean> {
  try {
    // 最強的訊號：有 frame 的網址進到 /game。
    // ⚠️ 2026-09-22：原本只靠下面那幾個 class，結果 Dragon's Law 的 spin 鈕 class 只有 `btn_spin`
    //    （不是 `my-button btn_spin`），於是「人在機台裡」被判成 false，
    //    工具回報「大廳載入超時」而不是「已在遊戲內」，連帶沒辦法自動把位子放掉。
    if (page.frames().some(f => /\/game\b/.test(f.url()))) return true
    const lobbySel = await page.$('#grid_gm_item')
    if (lobbySel && await lobbySel.isVisible()) return false
    for (const sel of ['[class*="btn_spin"]', '[class*="hand_balance"]', '.balance-bg', '.h-balance']) {
      const els = await page.$$(sel)
      for (const el of els) {
        if (await el.isVisible()) return true
      }
    }
    return false
  } catch {
    return false
  }
}

// ─── GM Event Watcher (enterGMNtc / leaveGMNtc via pinus WS frames) ─────────

interface GMEventData { errcode: number; errcodedes: string; machineType?: string }
interface IdeckCmdData { cmd: string; error: number }

/**
 * Scan a latin1-decoded pinus frame for enterGMNtc / leaveGMNtc JSON push bodies.
 * Returns parsed event data if found.
 */
function tryExtractGMEvent(text: string): { event: string } & GMEventData | null {
  for (const eventName of ['enterGMNtc', 'leaveGMNtc']) {
    const idx = text.indexOf(eventName)
    if (idx === -1) continue
    // Walk backwards to find the outermost '{' — scan further back to catch wrapper objects
    let start = idx
    while (start > 0 && text[start] !== '{') start--
    // Try to grab outermost JSON object (handles {"route":"...","body":{...}} wrapper)
    let outerStart = start
    let depth = 0
    for (let i = start; i >= 0; i--) {
      if (text[i] === '}') depth++
      else if (text[i] === '{') {
        if (depth === 0) { outerStart = i; break }
        depth--
      }
    }
    // Walk forwards counting braces to find matching '}'
    depth = 0
    let end = -1
    for (let i = outerStart; i < Math.min(text.length, outerStart + 2000); i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break } }
    }
    if (end === -1) continue
    try {
      const parsed = JSON.parse(text.slice(outerStart, end + 1)) as Record<string, unknown>
      // Support two pinus push formats:
      //   1. {"event":"enterGMNtc","errcode":0,"errcodedes":"..."}
      //   2. {"route":"enterGMNtc","body":{"errcode":0,"errcodedes":"..."}}
      const eventKey = (parsed['event'] ?? parsed['route']) as string | undefined
      if (eventKey === eventName) {
        const body = (parsed['body'] as Record<string, unknown> | undefined) ?? parsed
        const mt = String(body['machineType'] ?? parsed['machineType'] ?? '')
        return {
          event: eventName,
          errcode: Number(body['errcode'] ?? parsed['errcode'] ?? 0),
          errcodedes: String(body['errcodedes'] ?? parsed['errcodedes'] ?? ''),
          ...(mt ? { machineType: mt } : {}),
        }
      }
    } catch { /* malformed JSON, try next event name */ }
  }
  return null
}

/**
 * Extract iDeck cmd result from text.
 * Handles:
 *  1. Console log pattern: successJson data: {"cmd":"1838CR","res":"sucess","error":0}
 *  2. WS frame pattern: {"data":{"cmd":"...","is_ideck":true,"error":N}}
 */
function tryExtractIdeckCmd(text: string): IdeckCmdData | null {
  // Pattern 1: successJson response from hardware box (via console.log in game JS)
  // Note: "sucess" typo is intentional — that's what the game code outputs
  const successMatch = text.match(/successJson\s+data:\s*(\{[^}]+\})/i)
  if (successMatch) {
    try {
      const parsed = JSON.parse(successMatch[1]) as Record<string, unknown>
      if (parsed['cmd'] !== undefined) {
        return { cmd: String(parsed['cmd']), error: Number(parsed['error'] ?? 0) }
      }
    } catch { /* malformed */ }
  }

  // Pattern 2: WS frame {"data":{"cmd":"...","is_ideck":true,...}} or flat {"cmd":...,"is_ideck":...}
  if (text.includes('is_ideck')) {
    const idx = text.indexOf('is_ideck')
    let start = idx
    while (start > 0 && text[start] !== '{') start--
    let outerStart = start
    let depth = 0
    for (let i = start; i >= 0; i--) {
      if (text[i] === '}') depth++
      else if (text[i] === '{') {
        if (depth === 0) { outerStart = i; break }
        depth--
      }
    }
    depth = 0
    let end = -1
    for (let i = outerStart; i < Math.min(text.length, outerStart + 2000); i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break } }
    }
    if (end !== -1) {
      try {
        const parsed = JSON.parse(text.slice(outerStart, end + 1)) as Record<string, unknown>
        const inner = (parsed['data'] as Record<string, unknown> | undefined) ?? parsed
        if (inner['is_ideck'] === true || inner['is_ideck'] === 1) {
          return { cmd: String(inner['cmd'] ?? ''), error: Number(inner['error'] ?? 0) }
        }
      } catch { /* malformed */ }
    }
  }

  return null
}

type GMWaitFn = (timeoutMs: number) => Promise<GMEventData | null>
type IdeckWaitFn = (timeoutMs: number) => Promise<IdeckCmdData | null>

// ── WS 收發環形紀錄（1003 新增，退出紀錄用）──────────────────────────────────
// 使用者 1003：「離機 LOG 沒有包含 ws 嗎？」——console 只看得到埋點，看不到送了什麼請求、伺服器回了什麼。
// 所有 WS frame（送出＋收到）都進環形緩衝，退出步驟再取自己那段時間的。心跳（極短 frame）不記。
interface WsFrameRec { ts: number; dir: 'SEND' | 'RECV'; text: string }
const WS_RING_MAX = 600
const wsRings = new WeakMap<Page, WsFrameRec[]>()
const wsText = (payload: string | Buffer) => (typeof payload === 'string' ? Buffer.from(payload, 'binary') : payload)
  .toString('latin1').replace(/[^\x20-\x7e]/g, '').slice(0, 300)
export function wsFramesSince(page: Page, since: number): WsFrameRec[] {
  return (wsRings.get(page) ?? []).filter(f => f.ts >= since)
}

/** Create enter/leave GM event waiters backed by a shared WS frame listener. Must be called before page.goto(). */
function createGMEventWatcher(page: Page): { waitForEnterGM: GMWaitFn; waitForLeaveGM: GMWaitFn; waitForIdeckCmd: IdeckWaitFn } {
  const ring: WsFrameRec[] = []
  wsRings.set(page, ring)
  const record = (dir: WsFrameRec['dir'], payload: string | Buffer) => {
    try {
      const text = wsText(payload)
      if (text.length < 8) return   // 心跳／空 frame
      ring.push({ ts: Date.now(), dir, text })
      if (ring.length > WS_RING_MAX) ring.splice(0, ring.length - WS_RING_MAX)
    } catch { /* 紀錄失敗不影響測試 */ }
  }
  page.on('websocket', ws => {
    ws.on('framesent', f => record('SEND', f.payload))
    ws.on('framereceived', f => record('RECV', f.payload))
  })
  let enterResolve: ((v: GMEventData | null) => void) | null = null
  let leaveResolve: ((v: GMEventData | null) => void) | null = null
  // Buffer enterGMNtc that arrives before waitForEnterGM is called (e.g. during entry touchscreen)
  let enterBuffer: { data: GMEventData; ts: number } | null = null
  // Queue for iDeck cmd events (one waiter per button click)
  const ideckQueue: Array<(v: IdeckCmdData | null) => void> = []
  // Buffer for iDeck events that arrived before anyone was waiting (ts = arrival time)
  const ideckBuffer: Array<{ data: IdeckCmdData; ts: number }> = []

  const handleIdeckData = (ideck: IdeckCmdData) => {
    if (ideckQueue.length > 0) {
      const resolve = ideckQueue.shift()!
      resolve(ideck)
    } else {
      ideckBuffer.push({ data: ideck, ts: Date.now() })
    }
  }

  // WS frame listener (catches is_ideck pattern and pinus binary frames)
  page.on('websocket', ws => {
    ws.on('framereceived', frame => {
      try {
        const text = Buffer.from(frame.payload as string, 'binary').toString('latin1')

        // GM enter/leave events
        const ev = tryExtractGMEvent(text)
        if (ev) {
          if (ev.event === 'enterGMNtc') {
            const evData: GMEventData = { errcode: ev.errcode, errcodedes: ev.errcodedes, ...(ev.machineType ? { machineType: ev.machineType } : {}) }
            if (enterResolve) {
              enterResolve(evData)
              enterResolve = null
            } else {
              // Buffer it — may arrive before waitForEnterGM is called (e.g. during entry touchscreen)
              enterBuffer = { data: evData, ts: Date.now() }
            }
          } else if (ev.event === 'leaveGMNtc' && leaveResolve) {
            leaveResolve({ errcode: ev.errcode, errcodedes: ev.errcodedes })
            leaveResolve = null
          }
        }

        const ideck = tryExtractIdeckCmd(text)
        if (ideck) handleIdeckData(ideck)
      } catch { /* ignore malformed frame */ }
    })
  })

  // Console log listener — catches GM events from GM_EVENT_MONITOR_SCRIPT and iDeck events
  page.on('console', msg => {
    try {
      const text = msg.text()

      // GM_EVENT_MONITOR_SCRIPT emits: "__gm_event:<evName> <errcode> <errcodedes>||<machineType>"
      if (text.startsWith('__gm_event:')) {
        const parts = text.split(' ')
        const evName = parts[0].replace('__gm_event:', '')
        const errcode = parseInt(parts[1] ?? '0') || 0
        // errcodedes and machineType are packed as "errcodedes||machineType"
        const rawDes = parts.slice(2).join(' ')
        const sepIdx = rawDes.lastIndexOf('||')
        const errcodedes = sepIdx >= 0 ? rawDes.slice(0, sepIdx) : rawDes
        const machineType = sepIdx >= 0 ? rawDes.slice(sepIdx + 2) : undefined
        const evData: GMEventData = { errcode, errcodedes, ...(machineType ? { machineType } : {}) }
        if (evName === 'enterGMNtc') {
          if (enterResolve) {
            enterResolve(evData)
            enterResolve = null
          } else {
            enterBuffer = { data: evData, ts: Date.now() }
          }
        } else if (evName === 'leaveGMNtc' && leaveResolve) {
          leaveResolve(evData)
          leaveResolve = null
        }
        return
      }

      if (!text.includes('successJson')) return
      const ideck = tryExtractIdeckCmd(text)
      if (ideck) handleIdeckData(ideck)
    } catch { /* ignore */ }
  })

  const makeGMWaiter = (type: 'enter' | 'leave'): GMWaitFn => (timeoutMs) =>
    new Promise<GMEventData | null>(resolve => {
      // For enter: consume buffer first (event may have arrived during entry touchscreen stages)
      if (type === 'enter' && enterBuffer) {
        const buffered = enterBuffer
        enterBuffer = null
        resolve(buffered.data)
        return
      }
      const timer = setTimeout(() => {
        if (type === 'enter') enterResolve = null
        else leaveResolve = null
        resolve(null)
      }, timeoutMs)
      const wrapped = (v: GMEventData | null) => { clearTimeout(timer); resolve(v) }
      if (type === 'enter') enterResolve = wrapped
      else leaveResolve = wrapped
    })

  const waitForIdeckCmd: IdeckWaitFn = (timeoutMs) =>
    new Promise<IdeckCmdData | null>(resolve => {
      // Check buffer first — consume any event that arrived within the last 3s
      const cutoff = Date.now() - 3000
      const bufferedIdx = ideckBuffer.findIndex(e => e.ts >= cutoff)
      if (bufferedIdx !== -1) {
        const [buffered] = ideckBuffer.splice(bufferedIdx, 1)
        resolve(buffered.data)
        return
      }
      const timer = setTimeout(() => {
        const idx = ideckQueue.indexOf(wrapped)
        if (idx !== -1) ideckQueue.splice(idx, 1)
        resolve(null)
      }, timeoutMs)
      const wrapped = (v: IdeckCmdData | null) => { clearTimeout(timer); resolve(v) }
      ideckQueue.push(wrapped)
    })

  return { waitForEnterGM: makeGMWaiter('enter'), waitForLeaveGM: makeGMWaiter('leave'), waitForIdeckCmd }
}

// ─── Helper: wait for a <span> element across all frames ─────────────────────

async function waitForSpanText(page: Page, text: string, timeoutMs = 10000): Promise<import('playwright').ElementHandle | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try {
        const els = await frame.$$(`//span[normalize-space(text())='${text}']`)
        // Note: .screen-touch spans are transparent overlays — isVisible() returns false,
        // so we just check els.length > 0 (same as stepTouchscreen)
        if (els.length > 0) return els[0]
      } catch { /* frame detached */ }
    }
    await sleep(300)
  }
  return null
}

// ─── Test Steps ───────────────────────────────────────────────────────────────

/** Game Preview 顯示 Occupied 時：截圖留證，並判斷是不是 AUDIT MODE（Aristocrat 維修選單：預覽上半全黑、下半淺灰表格）。
 *  0929 用 7 張實拍校準：audit 上半黑 100%、下半灰 53~65%；一般佔用 黑 26~28%、灰 0~2%。沒看到 Occupied 回 null。 */
async function detectOccupied(page: Page, machineCode: string, emit: (msg: string) => void): Promise<{ audit: boolean; shot: string | null } | null> {
  const occ = await page.getByText('Occupied', { exact: true }).first().isVisible().catch(() => false)
  if (!occ) return null
  // 預覽畫面是**上下兩個 video**（上＝主畫面、下＝副畫面），取「Game Preview 標題」到「Occupied 按鈕」之間所有大 video 的聯集
  //（0249 第一次只取到其中一個 video，上下半比例整個錯位，audit 沒判出來）
  const tBox = await page.getByText('Game Preview', { exact: true }).first().boundingBox().catch(() => null)
  const oBox = await page.getByText('Occupied', { exact: true }).first().boundingBox().catch(() => null)
  const box = await page.evaluate(([top, bottom]) => {
    let u: { x0: number; y0: number; x1: number; y1: number } | null = null
    for (const el of Array.from(document.querySelectorAll('video,canvas,img'))) {
      const r = el.getBoundingClientRect()
      if (r.width < 250 || r.height < 100 || r.top < top || r.bottom > bottom) continue
      u = u ? { x0: Math.min(u.x0, r.left), y0: Math.min(u.y0, r.top), x1: Math.max(u.x1, r.right), y1: Math.max(u.y1, r.bottom) } : { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom }
    }
    return u ? { x: u.x0, y: u.y0, w: u.x1 - u.x0, h: u.y1 - u.y0 } : null
  }, [tBox ? tBox.y + tBox.height : 0, oBox ? oBox.y : 99999] as [number, number]).catch(() => null)
  await closeJackpotNotification(page)
  const buf = await page.screenshot({ type: 'png' }).catch(() => null)
  let shot: string | null = null
  if (buf) { try { mkdirSync(STREAM_SAVE_DIR, { recursive: true }); shot = join(STREAM_SAVE_DIR, `occupied-${machineCode}-${Date.now()}.png`); writeFileSync(shot, buf) } catch { shot = null } }
  let audit = false
  if (buf) {
    const A = PNG.sync.read(buf)
    const bx = box ?? { x: A.width * 0.06, y: A.height * 0.18, w: A.width * 0.88, h: A.height * 0.46 }
    const reg = (f0: number, f1: number, fn: (r: number, g: number, b: number) => boolean) => {
      let n = 0, c = 0
      for (let y = Math.floor(bx.y + bx.h * f0); y < bx.y + bx.h * f1 && y < A.height; y += 3) for (let x = Math.floor(bx.x + 4); x < bx.x + bx.w - 4 && x < A.width; x += 3) {
        const i = (y * A.width + x) * 4; n++; if (fn(A.data[i], A.data[i + 1], A.data[i + 2])) c++
      }
      return n ? c / n : 0
    }
    const black = reg(0.02, 0.48, (r, g, b) => r < 30 && g < 30 && b < 30)
    const grey = reg(0.52, 0.98, (r, g, b) => r > 170 && g > 170 && b > 170 && Math.abs(r - b) < 25)
    audit = black > 0.9 && grey > 0.4
    emit(`Game Preview 顯示 Occupied${audit ? '（AUDIT MODE）' : ''}：預覽上半黑 ${(black * 100).toFixed(0)}%、下半灰 ${(grey * 100).toFixed(0)}%${shot ? '，截圖 ' + shot : ''}`)
  }
  return { audit, shot }
}

async function stepEntry(page: Page, machineCode: string, emit: (msg: string) => void, profile?: MachineProfile, waitForEnterGM?: GMWaitFn): Promise<StepResult> {
  const t0 = Date.now()
  try {
    emit(`等待大廳載入...`)
    // Wait for lobby game items
    try {
      await page.waitForSelector('#grid_gm_item', { timeout: 15000 })
    } catch {
      // Maybe already in game, or page hasn't fully loaded — check
      // ⚠️ 2026-09-21：這條路**不能算正常通過**。它代表我們沒有從大廳點進這一台，
      //    而是「載入後就已經在某個機台裡」——最常見的成因是**上一台沒退乾淨**。
      //    實測：0033 退出 WARN（errcode=0 但 DOM 還在遊戲內）之後，0034 走了這條路，
      //    結果整輪其實跑在 0033 裡：iDeck 0/5、CCTV 讀到上一台的編號。
      //    判成 PASS 會讓髒結果一路傳下去，所以改成 WARN 並講清楚。
      if (await isInGame(page)) {
        return {
          step: '進入機台',
          status: 'warn',
          message: '載入後已在遊戲內（未從大廳點進本台）— 可能是上一台沒退乾淨，本輪結果不可信',
          durationMs: Date.now() - t0,
        }
      }
      return { step: '進入機台', status: 'fail', message: '大廳載入超時（15s），找不到機台列表', durationMs: Date.now() - t0 }
    }

    emit(`在大廳尋找機台: ${machineCode}`)
    const items = await page.$$('#grid_gm_item')
    let found = false
    let joinClicked = false
    let occupied: { audit: boolean; shot: string | null } | null = null
    for (const item of items) {
      const title = await item.getAttribute('title')
      if (title && title.includes(machineCode)) {
        await item.scrollIntoViewIfNeeded()
        await uiAct(page, 'lobby', `機台卡片 ${title}`, item, () => page.evaluate((el: Element) => (el as HTMLElement).click(), item))
        emit(`點擊機台卡片: ${title}`)
        await sleep(1500)
        found = true

        // Try Join button
        // ⚠️ 2026-09-21：Join 沒點到會停在 Game Preview 面板，而 `enterGMNtc errcode=0`
        //    照樣會送出來 → 進入機台判 PASS，後面每一步都對著 Preview 亂點。
        //    所以這裡要記下「到底有沒有按到 Join」，給下面的判定用。
        try {
          const clickJoin = async (): Promise<boolean> => {
            const joinEls = await page.$$("//div[contains(@class,'gm-info-box')]//span[normalize-space(text())='Join']")
            for (const j of joinEls) {
              if (await j.isVisible()) {
                if ((await uiAct(page, 'lobby', 'Join', j, () => page.evaluate((el: Element) => (el as HTMLElement).click(), j))) === 'blocked') return false
                emit(`點擊 Join 按鈕`)
                await sleep(3000)
                return true
              }
            }
            return false
          }

          joinClicked = await clickJoin()

          // 2026-09-21 實測：**全站中獎通知彈窗會蓋住 Join**
          //（畫面中央跳出別人中了 JACKPOT 的卡片＋PLAY NOW，Join 被壓在底下）。
          // 關掉再找一次，不要直接放棄——放棄的話會停在 Preview，而 enterGMNtc 照樣回 0。
          // ⚠️ 兩個絕對不能點的東西：
          //   1. `btn-close`（33×33，在 Preview 右上角）——那是**關掉 Preview 面板本身**
          //   2. 任何 `PLAY NOW`——那會把我們帶去**別台機台**
          if (!joinClicked) {
            emit(`⚠️ 找不到可見的 Join，嘗試關閉蓋住它的彈窗...`)
            const closed = await page.evaluate(() => {
              const panel = document.querySelector('[class*="gm-info-box"]')
              const SAFE = ['closeBtn', 'notification-close', 'icon_close', 'close-btn']
              let n = 0
              for (const el of Array.from(document.querySelectorAll('div,span,img,button'))) {
                const cls = typeof el.className === 'string' ? el.className : ''
                if (!SAFE.some(s => cls.includes(s))) continue
                if (panel && panel.contains(el)) continue        // Preview 自己的關閉鈕，跳過
                // 1007（CodeX 56e3d1b）：只關「中獎廣播卡」——卡片裡要有 View／PLAY NOW／JACKPOT 字樣；別的框的 X 不碰
                const card = el.closest('.content,[class*=notification],[class*=popup],[class*=dialog],[class*=card]')
                if (!card || card === document.body) continue
                if (!card.querySelector('.view') && !/play now|jackpot/i.test((card as HTMLElement).innerText || '')) continue
                const r = el.getBoundingClientRect()
                if (r.width < 8 || r.height < 8) continue
                ;(el as HTMLElement).click()
                n++
              }
              return n
            })
            if (closed > 0) {
              emit(`已關閉 ${closed} 個彈窗，重新尋找 Join...`)
              await sleep(1500)
              joinClicked = await clickJoin()
            }
          }

          // 1007 osm-qa-agent 回報（873-SUPERBURSTLINK-0345）：Preview 上蓋著「新遊戲廣告」（右上黃色 ✕＋底下 PLAY GAME），
          // 上面那段只關中獎廣播卡，這張被跳過 → Join 找不到 → 誤判 Occupied。
          // 改用跟 UAT 共用的大廳關彈窗規則（uat-runner/lobby-popup.js）：只點 class **完全等於** closeBtn／notification-close、
          // 尺寸 ≤ 80px 的關閉鍵，字樣像 PLAY NOW／JOIN／START 的一律不碰；**PLAY GAME 不是關閉鍵、不會被點**（會跳去別的遊戲）。
          // 判 Occupied 之前一定先做這一次。
          if (!joinClicked) {
            const lp = await dismissLobbyPopups(page, { rounds: 3, settleMs: 800 }).catch(() => ({ closed: [] as string[], skipped: [] as string[] }))
            if (lp.closed.length) {
              emit(`已關閉蓋住 Join 的廣告／彈窗 ${lp.closed.length} 個（${lp.closed.join('、')}），重新尋找 Join...`)
              await sleep(1200)
              joinClicked = await clickJoin()
            } else if (lp.skipped.length) emit(`（看到不在白名單的關閉鍵，沒點：${lp.skipped.join('、').slice(0, 120)}）`)
          }
          // 1007 osm-qa-agent（主使用者 13:45）：帳號離開機台後有約 10 秒緩衝，這段時間 Preview 顯示 Occupied、之後才變回 Join
          //（0345：試跑退出 13:36:59 → 13:37:02 整批進場就判 Occupied）。看到 Occupied 不馬上判：每 1.5 秒重掃 Join（含關廣告），
          // Join 一出現就點；最多 20 秒（緩衝 10 秒），還是沒有才判 Occupied。**不加固定等待**
          if (!joinClicked && await page.getByText('Occupied', { exact: true }).first().isVisible().catch(() => false)) {
            emit(`Preview 顯示 Occupied（可能是剛離開機台的 10 秒緩衝）→ 每 1.5 秒重找 Join，最多 20 秒`)
            const t0o = Date.now()
            while (!joinClicked && Date.now() - t0o < 20000) {
              await sleep(1500)
              const lp2 = await dismissLobbyPopups(page, { rounds: 2, settleMs: 500 }).catch(() => ({ closed: [] as string[], skipped: [] as string[] }))
              if (lp2.closed.length) emit(`已關閉蓋住 Join 的廣告／彈窗 ${lp2.closed.length} 個（${lp2.closed.join('、')}）`)
              joinClicked = await clickJoin()
            }
            if (joinClicked) emit(`${((Date.now() - t0o) / 1000).toFixed(1)} 秒後 Join 出現了（剛才是離開緩衝，不是佔用）`)
          }
          if (!joinClicked) emit(`⚠️ 仍找不到可見的 Join 按鈕（可能停在 Game Preview 面板，或此台不可加入）`)
          // 0929：Preview 顯示 Occupied＝機台被佔用／維修中（0249/0254/0262/0266~0269 實況），不是工具沒按到 → 直接判定、留證據
          if (!joinClicked) occupied = await detectOccupied(page, machineCode, emit)
        } catch { /* Join may not exist */ }
        break
      }
    }

    if (!found) {
      return { step: '進入機台', status: 'fail', message: `大廳找不到機台代碼: ${machineCode}`, durationMs: Date.now() - t0 }
    }
    if (occupied) {
      return { step: '進入機台', status: 'fail', message: occupied.audit ? `機台 Occupied（AUDIT MODE：Preview 畫面停在維修選單）${occupied.shot ? '｜截圖 ' + occupied.shot : ''}` : `機台 Occupied（Game Preview 顯示 Occupied，沒有 Join）${occupied.shot ? '｜截圖 ' + occupied.shot : ''}`, durationMs: Date.now() - t0 }
    }

    // Wait for game to load (baseline)
    emit(`等待遊戲載入...`)
    await sleep(2000)

    // Handle entry touchscreen Stage 1 (e.g. select DENOM)
    if (profile?.entryTouchPoints?.length) {
      emit(`進入觸屏第一階段（選擇 DENOM），等待元素出現...`)
      for (const pos of profile.entryTouchPoints) {
        emit(`  等待元素「${pos}」...`)
        const el = await waitForSpanText(page, pos, 10000)
        if (el) {
          await uiAct(page, 'lobby', `進入觸屏 ${pos}`, el, () => page.evaluate((e: Element) => (e as HTMLElement).click(), el))
          emit(`  ✅ 已點擊「${pos}」`)
          await sleep(400)
        } else {
          emit(`  ⚠️ 找不到元素「${pos}」（逾時 10s），跳過`)
        }
      }
      await sleep(800)
    }

    // Handle entry touchscreen Stage 2 (e.g. YES/NO confirmation)
    if (profile?.entryTouchPoints2?.length) {
      emit(`進入觸屏第二階段（YES/NO 確認），等待元素出現...`)
      for (const pos of profile.entryTouchPoints2) {
        emit(`  等待元素「${pos}」...`)
        const el = await waitForSpanText(page, pos, 10000)
        if (el) {
          await uiAct(page, 'lobby', `進入觸屏 ${pos}`, el, () => page.evaluate((e: Element) => (e as HTMLElement).click(), el))
          emit(`  ✅ 已點擊「${pos}」`)
          await sleep(400)
        } else {
          emit(`  ⚠️ 找不到元素「${pos}」（逾時 10s），跳過`)
        }
      }
      await sleep(800)
    }

    // Wait for enterGMNtc — server-side confirmation is the primary signal
    const enterEventPromise = waitForEnterGM ? waitForEnterGM(12000) : Promise.resolve(null)
    const enterEv = await enterEventPromise

    if (enterEv) {
      emit(`enterGMNtc errcode=${enterEv.errcode}: ${enterEv.errcodedes}${enterEv.machineType ? ` machineType=${enterEv.machineType}` : ''}`)
      const extraData = enterEv.machineType ? { machineType: enterEv.machineType } : undefined
      if (enterEv.errcode === 0) {
        // 協議說「進去了」還不夠——還要畫面真的離開大廳。
        // 2026-09-21 實測：停在 Game Preview 面板時 errcode 一樣是 0，
        // 於是判 PASS，後面每一步都對著 Preview 亂點，跑出一堆看不懂的失敗。
        //
        // ⚠️ 不能只用 isInGame()：它要看到 `.btn_spin` 或餘額元素，但**進場當下**
        //    `.btn_spin` 還不存在（要帶入額度才出現），而且「SELECT A DENOMINATION」
        //    面板會蓋住畫面 → 剛進去時它必然是 false，直接拿來判會**誤殺正常流程**
        //    （第一次這樣寫就把確定進得去的 0033 判成 FAIL）。
        //    真正穩定的訊號是**網址離開 /lobby 進到 /game**，再給它幾秒渲染時間。
        // ⚠️ 第二次修：**頂層網址不會變**，它一直是 /lobby——遊戲是跑在 iframe 裡的，
        //    所以要看的是「**有沒有某個 frame 的網址進到 /game**」。
        //    （第一版只看 page.url()，照樣把進得去的 0033 判成 FAIL。）
        const enteredGamePage = await (async () => {
          for (let i = 0; i < 16; i++) {
            if (page.frames().some(f => /\/game\b/.test(f.url()))) return true
            if (await isInGame(page)) return true
            await sleep(500)
          }
          return false
        })()
        if (!enteredGamePage) {
          const hint = joinClicked ? '' : '（整輪沒按到 Join，可能停在 Game Preview 面板）'
          return {
            step: '進入機台',
            status: 'fail',
            message: `協議回報進入成功（enterGMNtc errcode=0），但 8 秒後沒有任何 frame 進到 /game${hint}`
              + `｜frames=${page.frames().map(f => f.url().slice(0, 60)).join(' | ').slice(0, 200)}`,
            durationMs: Date.now() - t0,
            ...(extraData ? { extraData } : {}),
          }
        }
        const ident = await readGameIdentity(page)
        if (ident.gameName) emit(`遊戲：${ident.gameName}（${ident.gameMachineName}）`)
        return { step: '進入機台', status: 'pass', message: '成功進入遊戲（enterGMNtc errcode=0）', durationMs: Date.now() - t0, extraData: { ...(extraData ?? {}), ...ident } }
      }
      return { step: '進入機台', status: 'fail', message: `進入失敗：enterGMNtc errcode=${enterEv.errcode} — ${enterEv.errcodedes}`, durationMs: Date.now() - t0, extraData }
    }

    // No GMN event received — fall back to DOM detection
    emit(`未收到 enterGMNtc，改用 DOM 偵測...`)
    if (await isInGame(page)) {
      return { step: '進入機台', status: 'warn', message: '成功進入遊戲（未收到 enterGMNtc，DOM 偵測）', durationMs: Date.now() - t0, extraData: await readGameIdentity(page) }
    }
    await sleep(3000)
    if (await isInGame(page)) {
      return { step: '進入機台', status: 'warn', message: '成功進入遊戲（未收到 enterGMNtc，DOM 偵測）', durationMs: Date.now() - t0, extraData: await readGameIdentity(page) }
    }
    return { step: '進入機台', status: 'fail', message: '已點擊機台但遊戲未載入（找不到 Spin 或 Balance 元素，且無 enterGMNtc）', durationMs: Date.now() - t0 }
  } catch (e) {
    return { step: '進入機台', status: 'fail', message: `例外: ${e}`, durationMs: Date.now() - t0 }
  }
}

/**
 * 1007 遊戲身分（CodeX 定案）：進場成功後讀 /game iframe 左上角的機台名與遊戲名（H5 DOM，不用 OCR）。
 * `.header-top .gm-info-box .gm-info` 底下 `.machine-id`（例「Wild Luxury-CP0332」）與 `.game-id`（例「Fu Lai Cai Lai」）——
 * osm-qa-agent 實抓 0345 的 DOM。同一台機台可能換遊戲，所以**每次進場都讀**，batch 依遊戲名決定套哪套 iDeck 規則。
 * 等名稱載入（最多 8 秒）；讀不到就留空並寫原因，**不沿用上一次的值**。
 */
export async function readGameIdentity(page: Page, waitMs = 8000): Promise<Record<string, string>> {
  const end = Date.now() + waitMs
  let why = '找不到 /game 的 iframe'
  while (Date.now() < end) {
    for (const f of page.frames()) {
      if (!/\/game\b/.test(f.url())) continue
      why = '/game 裡找不到 .gm-info 的 .machine-id／.game-id'
      try {
        const r = await f.evaluate(() => {
          // ⚠️ 頁面內不寫具名箭頭函式：tsx 會包成 __name()，頁面裡沒有 → evaluate 丟錯被吞掉（1007 踩過）
          const box = document.querySelector('.header-top .gm-info-box .gm-info')
          if (!box) return null
          return {
            machine: (box.querySelector('.machine-id')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
            game: (box.querySelector('.game-id')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
          }
        })
        if (r && r.game) return { gameMachineName: r.machine, gameName: r.game }
        if (r) why = '.game-id 是空的（可能還沒載入）'
      } catch { why = '讀 /game iframe 失敗（frame 換頁中）' }
    }
    await sleep(500)
  }
  return { gameMachineName: '', gameName: '', gameNameWhy: why }
}

async function stepStream(
  page: Page,
  emit: (msg: string) => void,
  profile?: MachineProfile,
  machineCode = '',
  sessionPrefix = '',
): Promise<StepResult> {
  const t0 = Date.now()
  try {
    emit(`檢測推流（video / canvas）`)
    // tsx(esbuild keepNames) 會把下面的 rectOf 包成 __name()，瀏覽器端沒有這個 helper（0929 加方向檢查後推流步驟整個炸掉）
    await page.evaluate('window.__name = window.__name || (fn => fn)')
    const probe = () => page.evaluate(() => {
      const videos = Array.from(document.querySelectorAll('video'))
      const canvases = Array.from(document.querySelectorAll('canvas'))

      const playingVideos = videos.filter(v => !v.paused && v.readyState >= 2 && v.videoWidth > 0)
      const activeCanvases = canvases.filter(c => c.width > 100 && c.height > 100)

      // 2026-09-29 畫面方向檢查用：每塊在播的畫面在截圖上的位置（CSS px，截圖是 viewport，batch 端用 innerWidth 換算比例）
      const rectOf = (el: Element, kind: string) => { const r = el.getBoundingClientRect(); return { kind, x: r.left, y: r.top, w: r.width, h: r.height } }
      const screens = [...playingVideos.map(v => rectOf(v, 'video')), ...activeCanvases.map(c => rectOf(c, 'canvas'))].filter(r => r.w > 50 && r.h > 50)

      // 2026-09-29 main/pool 推流分開判：每個看得到的 video 位置＋有沒有在播（共通規則見 knowledge/h5-client-interaction.md）
      const videoRects = videos.map(v => ({ ...rectOf(v, 'video'), playing: !v.paused && v.readyState >= 2 && v.videoWidth > 0 })).filter(r => r.w > 50 && r.h > 50)

      return {
        screens, videoRects, viewportW: window.innerWidth, viewportH: window.innerHeight,
        totalVideos: videos.length,
        playingVideos: playingVideos.length,
        totalCanvases: canvases.length,
        activeCanvases: activeCanvases.length,
        videoDetails: playingVideos.map(v => ({
          w: v.videoWidth, h: v.videoHeight,
          src: v.src?.substring(0, 60) || v.currentSrc?.substring(0, 60) || '(embedded)',
          readyState: v.readyState
        }))
      }
    })

    // 1002 MONEYGONG：推流常常進場後十幾秒才出來（1559/1562/1569/1570 第一次都沒畫面，重跑都有）。
    // 只看一瞬間會把「慢」判成「壞」，或更糟——canvas-only 被當 WARN 放過（1562 G 欄是空框照樣 ok）。
    // → 沒在播就每 3 秒再看一次，最多等 STREAM_WAIT_MS；等完還沒有才下結論，截圖也拍等完之後的畫面。
    const roleOf = (r: Awaited<ReturnType<typeof probe>>) => streamRoles(r.videoRects, { expected: machineLayout(machineCode)?.screens, viewportH: r.viewportH })
    let result = await probe()
    let waitedMs = 0
    while ((result.playingVideos === 0 || roleOf(result).noShow.length) && waitedMs < STREAM_WAIT_MS) {
      await sleep(3000); waitedMs += 3000
      result = await probe()
    }
    if (waitedMs) emit(`推流等了 ${waitedMs / 1000} 秒：播放中 video ${result.playingVideos} 個`)
    const waitNote = waitedMs ? `（等了 ${waitedMs / 1000} 秒）` : ''

    const hasStream = result.playingVideos > 0 || result.activeCanvases > 0
    // main/pool（使用者 0929 確認，共通規則）：看得到的 video 依上下排，最上面＝pool（獎池畫面）、其餘＝main（滾輪）；只有一個＝main
    const { roles: videoRoles, noShow } = roleOf(result)
    // learn 模式（2026-09-29）：把觀察值結構化交給 batch 端，只當紀錄，不當規格（當下亮幾個≠應該有幾個）
    const learnX = { extraData: { learn: JSON.stringify({ v: LEARN_VER, totalVideos: result.totalVideos, playingVideos: result.playingVideos, totalCanvases: result.totalCanvases, activeCanvases: result.activeCanvases, screens: result.screens, viewportW: result.viewportW, viewportH: result.viewportH, videoRoles, noShow }) } }
    const msg = `video:${result.totalVideos}個（播放中: ${result.playingVideos}）/ canvas: ${result.totalCanvases}個（活躍: ${result.activeCanvases}）`
      + (videoRoles.length ? `｜${videoRoles.map(v => `${v.role}${v.playing ? '✓' : '✗'}`).join(' ')}` : '') + waitNote

    // 留一張推流畫面當證據。判定不依賴它（截圖失敗不能影響結果），但少了它，
    // 「畫面顛倒 / 黑畫面 / 雪花」這類問題就只能用嘴巴講。
    if (machineCode) {
      try {
        await closeJackpotNotification(page, emit)
        const buf = await page.screenshot({ type: 'png' })
        mkdirSync(STREAM_SAVE_DIR, { recursive: true })
        const filename = `${sessionPrefix}${machineCode}.png`
        writeFileSync(join(STREAM_SAVE_DIR, filename), buf)
        emit(`推流截圖已儲存：${join(STREAM_SAVE_DIR, filename)}`)
      } catch (e) {
        emit(`推流截圖失敗（不影響判定）：${String(e).slice(0, 120)}`)
      }
    }

    // 有畫面位置的 video 其中一塊沒在播 → 那一塊推流沒畫面
    // CodeX 0929：只要有一塊沒播就 FAIL，不能讓 canvas 把「全部停播」蓋成 WARN
    if (noShow.length) {
      return { step: '推流檢測', status: 'fail', message: `${noShow.join(', ')}：${msg}`, durationMs: Date.now() - t0, ...learnX }
    }

    // ── Expected screen count check ───────────────────────────────────────────
    const expectedScreens = profile?.expectedScreens ?? null
    if (expectedScreens !== null && expectedScreens > 0) {
      const detail = result.videoDetails.map(v => `${v.w}×${v.h}`).join(', ')
      const actualPlaying = result.playingVideos + result.activeCanvases
      if (actualPlaying < expectedScreens) {
        return {
          step: '推流檢測',
          status: 'fail',
          message: `螢幕數量不符：預期 ${expectedScreens} 個，實際播放 ${actualPlaying} 個。${msg}${detail ? ` — ${detail}` : ''}`,
          durationMs: Date.now() - t0, ...learnX,
        }
      }
      // Count matches expected
      if (result.playingVideos > 0) {
        return { step: '推流檢測', status: 'pass', message: `${msg} — ${detail}（螢幕數 ✓ ${expectedScreens}）`, durationMs: Date.now() - t0, ...learnX }
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (result.playingVideos > 0) {
      const detail = result.videoDetails.map(v => `${v.w}×${v.h}`).join(', ')
      return { step: '推流檢測', status: 'pass', message: `${msg} — ${detail}`, durationMs: Date.now() - t0, ...learnX }
    } else if (result.activeCanvases > 0) {
      // 1002：canvas 是遊戲 UI 自己（Galacean），不是推流——等完還是 0 個 video 在播＝推流沒畫面，FAIL
      return { step: '推流檢測', status: 'fail', message: `mainstream no show：沒有任何 video 在播（canvas 是遊戲 UI，不算推流）。${msg}`, durationMs: Date.now() - t0, ...learnX }
    } else if (result.totalVideos > 0) {
      return { step: '推流檢測', status: 'fail', message: `有 ${result.totalVideos} 個 video 但均未播放（paused / buffering）`, durationMs: Date.now() - t0, ...learnX }
    } else if (!hasStream) {
      return { step: '推流檢測', status: 'warn', message: `找不到 <video> 元素，可能此機型不使用影片推流`, durationMs: Date.now() - t0, ...learnX }
    }
    return { step: '推流檢測', status: 'pass', message: msg, durationMs: Date.now() - t0, ...learnX }
  } catch (e) {
    return { step: '推流檢測', status: 'fail', message: `例外: ${e}`, durationMs: Date.now() - t0 }
  }
}

// readBalance()（讀 __lastCoin）1007 移除：__lastCoin 不分路由、會被大廳錢包蓋掉，機台餘額一律用下面的 readMachineBalance

/**
 * 機台內餘額（1007，0330 少 315 億的修正）：只採兩個來源——
 *   ① moneyNtc 推播的 coin（tracker 的 __lastMachineCoin；遊戲 iframe 優先）
 *   ② Tips 框「Cash out credit: N」（退出流程中最可靠）
 * 兩個都沒有＝null（還沒有任何 moneyNtc，例如剛進機台還沒開過局）。**不退回 __lastCoin**——那份會被大廳錢包蓋掉。
 */
export function parseCashOutCredit(text: string): number | null {
  const m = String(text ?? '').match(/cash\s*-?\s*out\s+credit\s*[:：]?\s*([\d,]+(?:\.\d+)?)/i)
  if (!m) return null
  const n = Number(m[1].replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}
async function readMachineBalance(page: Page): Promise<number | null> {
  let fallback: number | null = null
  for (const frame of page.frames()) {
    try {
      const coin = await frame.evaluate(() => (window as unknown as Record<string, unknown>).__lastMachineCoin as number | null ?? null)
      if (coin === null) continue
      if (/\/game\b/.test(frame.url())) return coin
      if (fallback === null) fallback = coin
    } catch { /* frame detached */ }
  }
  if (fallback !== null) return fallback
  for (const frame of page.frames()) {
    try {
      const v = parseCashOutCredit(await frame.evaluate(() => document.body?.innerText ?? ''))
      if (v !== null) return v
    } catch { /* frame detached */ }
  }
  return null
}
export type MoneyEvent = { seq: number; coin: number; reason: string; ts: number }
/** 這頁到目前的 moneyNtc 流水（遊戲 iframe 優先；沒有就取筆數最多的那個 frame） */
/**
 * 1007 iDeck 時間學習：流水＋**同一個 frame 的現在時間**（頁面時鐘）一次讀回——歸屬判斷的 begin.ts 與按下時間要同一個時鐘。
 * 跟 readMoneyLog 一樣挑 game iframe；讀不到回 null（呼叫端當成「無法證明空閒」）
 */
export async function readMoneySnap(page: Page): Promise<{ log: MoneyEvent[]; now: number } | null> {
  let best: { log: MoneyEvent[]; now: number } | null = null
  for (const frame of page.frames()) {
    try {
      const r = await frame.evaluate(() => ({ log: ((window as unknown as Record<string, unknown>).__moneyLog as unknown[] | undefined) ?? [], now: Date.now() })) as { log: MoneyEvent[]; now: number }
      if (/\/game\b/.test(frame.url()) && r.log.length) return r
      if (!best || r.log.length > best.log.length) best = r
    } catch { /* frame detached */ }
  }
  return best
}
async function readMoneyLog(page: Page): Promise<MoneyEvent[]> {
  let best: MoneyEvent[] = []
  for (const frame of page.frames()) {
    try {
      const log = await frame.evaluate(() => ((window as unknown as Record<string, unknown>).__moneyLog as unknown[] | undefined) ?? []) as MoneyEvent[]
      if (/\/game\b/.test(frame.url()) && log.length) return log
      if (log.length > best.length) best = log
    } catch { /* frame detached */ }
  }
  return best
}

/** After certain actions (btn_bet click, cashout, re-entering the game...) the game may show a
 *  denomination-select overlay (.select-main). This overlay does NOT reject the click with
 *  Playwright's "intercepts pointer events" error — the game simply never receives the Spin
 *  action, so the try/catch-based force-click fallback never triggers and the spin silently
 *  does nothing until the 8s timeout. Must actively check for and dismiss this overlay BEFORE
 *  every spin attempt (mirrors AutoSpin.py's dismiss_denom_overlay(), called at the start of
 *  every do_spin() — see CLAUDE.md AutoSpin 選面額遮罩 notes), not just as an exception handler.
 *  Checks all frames, clicks the first available denomination option. Returns true if dismissed. */
async function dismissDenomOverlay(page: Page, emit: (msg: string) => void, source: string): Promise<boolean> {
  for (const frame of page.frames()) {
    try {
      const btns = await frame.$$('.select-main .select-btn, .select-main .my-button')
      if (btns.length > 0) {
        emit(`${source} → 面額選擇遮罩（${btns.length} 選項），點擊第一個...`)
        if ((await uiAct(page, 'popup', '面額選單第一個', btns[0], () => btns[0].evaluate((node: Element) => (node as HTMLElement).click()))) === 'blocked') return false
        await sleep(800)
        // 2026-10-01 JJBXGRAND 實測（0342 重新進場）：選面額是兩階段——選完面額後同一個遮罩變成 **YES / NO** 確認（約 1.5 秒內出現、
        // 不按就一直停著），按 YES 後約 1.5 秒機台的 SELECT A DENOMINATION 才關、SPIN 才有作用。原本只點一下，第二階段從沒按過
        // → 0338／0343 選單整輪關不掉。這裡等最多 3 秒，出現 YES 就按（**絕不按 NO**）
        // 1007（CodeX 56e3d1b）：找到 YES 之後走 uiAct（同一把鎖、禁點檢查、限 .select-main 框裡），被擋就不按
        for (let t = 0; t < 6; t++) {
          const yesEl = (await frame.evaluateHandle(() => {
            for (const e of Array.from(document.querySelectorAll('.select-main *'))) {
              if (e.children.length || (e.textContent ?? '').trim().toUpperCase() !== 'YES') continue
              const r = e.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) continue
              return e.closest('.select-btn,.my-button') ?? e
            }
            return null
          }).catch(() => null))?.asElement() as ElementHandle | null | undefined
          if (yesEl) {
            const r = await uiAct(page, 'popup', '面額確認 YES', yesEl, () => yesEl.evaluate((node: Element) => (node as HTMLElement).click())).catch(() => 'none' as const)
            if (r === 'blocked') { emit(`${source} → 面額確認 YES 被擋下，沒有按`); return false }
            emit(`${source} → 面額確認（第二階段）按 YES`); await sleep(1500); break
          }
          await sleep(500)
        }
        return true
      }
    } catch { /* frame detached */ }
  }
  return false
}

/** Diagnostic: log pinus/coin state across all frames. */
async function diagPinusFrames(page: Page, emit: (msg: string) => void): Promise<void> {
  const frames = page.frames()
  emit(`[診斷] 共 ${frames.length} 個 frame`)
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]
    try {
      const info = await frame.evaluate(() => {
        const w = window as unknown as Record<string, unknown>
        return {
          url: location.href.slice(0, 80),
          hasPinus: typeof w.pinus !== 'undefined',
          pinusCoinTracked: (w.pinus as Record<string,unknown>)?.__coinTracked ?? false,
          lastCoin: w.__lastCoin ?? null,
          coinUpdatedAt: (w.__coinUpdatedAt as number) ?? 0,
        }
      })
      const updatedAgo = info.coinUpdatedAt ? `${Date.now() - info.coinUpdatedAt}ms前` : '從未'
      emit(`[診斷] frame[${i}] ${info.url} | pinus=${info.hasPinus} tracked=${info.pinusCoinTracked} lastCoin=${info.lastCoin} coinUpdated=${updatedAgo}`)
    } catch { emit(`[診斷] frame[${i}] 無法評估（cross-origin 或已卸載）`) }
  }
}

/**
 * Actively sample audio from all frames during spin (non-destructive).
 * Uses captureStream() on <video>/<audio> elements to tap into their audio
 * without affecting playback. Returns peak dB across all frames/elements.
 */
async function sampleSpinAudio(page: Page, durationMs = 1500): Promise<{ peakDb: number; method: string; detail: string }> {
  let bestPeak = -Infinity
  let bestMethod = 'none'
  let bestDetail = '無 media 元素'

  for (const frame of page.frames()) {
    try {
      const result = await frame.evaluate((dur: number) => new Promise<{ peakDb: number; method: string; detail: string }>(resolve => {
        // Include ALL media — not just playing ones (audio element may be paused/autoplaying differently)
        const medias = Array.from(document.querySelectorAll('video, audio')) as HTMLMediaElement[]
        // Prioritise playing media, but also check paused ones that have audio tracks
        const playingMedia = medias.filter(m => !m.paused)
        const pausedWithAudio = medias.filter(m => m.paused && (m as any).srcObject instanceof MediaStream && ((m as any).srcObject as MediaStream).getAudioTracks().length > 0)
        const active = playingMedia.length > 0 ? playingMedia : pausedWithAudio
        if (active.length === 0) {
          resolve({ peakDb: -Infinity, method: 'no_media', detail: `找不到播放中的 media（共 ${medias.length} 個）` })
          return
        }

        const results: { peakDb: number; muted: boolean; vol: number }[] = []
        let pending = active.length

        const debugInfo: string[] = []

        // Also report ALL media elements (including paused/hidden) for debug
        medias.forEach(m => {
          const ms = (m as any).srcObject
          const audioTracks = ms instanceof MediaStream ? ms.getAudioTracks().length : '?'
          debugInfo.push(`<${m.tagName.toLowerCase()}> paused=${m.paused} muted=${m.muted} vol=${m.volume} audioTracks=${audioTracks}`)
        })

        for (const media of active) {
          try {
            // Temporarily unmute so audio track is active
            const wasMuted = media.muted
            if (wasMuted) media.muted = false

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const m = media as any

            // Strategy 1: use srcObject directly (WebRTC / MediaStream source — most reliable)
            // Strategy 2: captureStream() fallback (HLS/MP4/blob src)
            let stream: MediaStream | null = null
            let method = ''

            if (m.srcObject instanceof MediaStream) {
              const audioTracks = (m.srcObject as MediaStream).getAudioTracks()
              debugInfo.push(`srcObject MediaStream, audioTracks=${audioTracks.length}, enabled=${audioTracks.map((t: MediaStreamTrack) => t.enabled).join(',')}`)
              if (audioTracks.length > 0) {
                // Enable track if disabled
                audioTracks.forEach((t: MediaStreamTrack) => { t.enabled = true })
                stream = m.srcObject as MediaStream
                method = 'srcObject'
              }
            }

            if (!stream) {
              stream = m.captureStream?.() ?? m.mozCaptureStream?.() ?? null
              method = 'captureStream'
              if (stream) {
                const at = (stream as MediaStream).getAudioTracks()
                debugInfo.push(`captureStream audioTracks=${at.length}`)
              }
            }

            if (!stream) {
              if (wasMuted) media.muted = true
              results.push({ peakDb: -Infinity, muted: wasMuted, vol: media.volume })
              debugInfo.push('no stream available')
              if (--pending === 0) done()
              continue
            }

            const ctx = new AudioContext()
            ctx.resume()

            const src = ctx.createMediaStreamSource(stream)
            const analyser = ctx.createAnalyser()
            analyser.fftSize = 2048
            src.connect(analyser)

            setTimeout(() => {
              const data = new Float32Array(analyser.frequencyBinCount)
              analyser.getFloatTimeDomainData(data)
              let peak = 0, nonZero = 0
              for (let i = 0; i < data.length; i++) {
                const abs = Math.abs(data[i])
                if (abs > peak) peak = abs
                if (abs > 0.0001) nonZero++
              }
              const peakDb = peak > 0 ? 20 * Math.log10(peak) : -Infinity
              debugInfo.push(`${method} peak=${peak.toFixed(6)} nonZero=${nonZero}/${data.length} peakDb=${isFinite(peakDb) ? peakDb.toFixed(1) : '-∞'}`)
              ctx.close()
              if (wasMuted) media.muted = true
              results.push({ peakDb, muted: wasMuted, vol: media.volume })
              if (--pending === 0) done()
            }, dur)
          } catch (e) {
            debugInfo.push(`error: ${e}`)
            if (wasMuted) media.muted = true  // restore muted state even on error
            results.push({ peakDb: -Infinity, muted: wasMuted, vol: media.volume })
            if (--pending === 0) done()
          }
        }

        function done() {
          const best = results.reduce((a, b) => (
            (isFinite(b.peakDb) && b.peakDb > (isFinite(a.peakDb) ? a.peakDb : -Infinity)) ? b : a
          ), results[0])
          const peakDb = best?.peakDb ?? -Infinity
          const muted = active.filter(m => m.muted).length
          const detail = `${active.length} 個播放中（靜音: ${muted}，音量: ${active.map(m => m.volume.toFixed(1)).join('/')}）[debug: ${debugInfo.join(' | ')}]`
          resolve({ peakDb, method: 'captureStream', detail })
        }
      }), durationMs)

      if (isFinite(result.peakDb) && result.peakDb > bestPeak) {
        bestPeak = result.peakDb
        bestMethod = result.method
        bestDetail = result.detail
      } else if (!isFinite(bestPeak) && result.detail !== '找不到播放中的 media（共 0 個）') {
        bestMethod = result.method
        bestDetail = result.detail
      }
    } catch { /* frame detached */ }
  }

  return { peakDb: bestPeak, method: bestMethod, detail: bestDetail }
}

type SpinAudioData = { peakDb: number; method: string; detail: string; rmsDb?: number; clipRatio?: number; crestFactor?: number; spectralCentroid?: number; baselineRmsDb?: number; wavBase64?: string }
type SpinAudioRef = { data: SpinAudioData | null }

/**
 * 0930 CodeX：「沒開局」不能只靠餘額不變（餘額可能延遲更新）。Spin 期間另外聽 console 的 moneyNtc begin（iDeck 用同一個訊號判開局），
 * 結果訊息尾巴附「開局訊號 moneyNtc begin N 次」；batch 只有「餘額沒變＋begin 0 次」才判 spin no response，
 * 餘額沒變但有 begin → 當作餘額延遲、Spin 未驗；舊訊息沒有這段 → 維持原判（相容 0930 之前的結果）。
 */
async function stepSpin(page: Page, emit: (msg: string) => void, customSpinSel?: string | null, customBalanceSel?: string | null, spinAudioRef?: SpinAudioRef, aiAudio = false, spinCount = 3): Promise<StepResult> {
  let begins = 0
  const onConsole = (m: import('playwright').ConsoleMessage) => {
    const t = m.text()
    if (/moneyNtc/.test(t) && /reason['"]?\s*:\s*['"]?begin/.test(t)) begins++
  }
  page.on('console', onConsole)
  try {
    const r = await stepSpinCore(page, emit, customSpinSel, customBalanceSel, spinAudioRef, aiAudio, spinCount)
    await sleep(1500)   // begin 可能比餘額讀取晚一點印出來
    return { ...r, message: `${r.message}｜開局訊號 moneyNtc begin ${begins} 次` }
  } finally {
    page.off('console', onConsole)
  }
}

/** 10-01 JJBXGRAND 0342：進場後畫面跳「Inserting credits, please wait...」（CREDIT ₱0.00，額度還在轉入機台），
 *  這時按 SPIN 不會開局、餘額也讀不到。按之前等它消失（最多 30 秒），等不到就照按、由結果的開局訊號判斷 */
async function waitCreditsInserted(page: Page, emit: (msg: string) => void): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const busy = await page.evaluate(() => /Inserting credits/i.test(document.body?.innerText ?? '')).catch(() => false)
    if (!busy) { if (i > 0) emit(`額度轉入完成（等了 ${i} 秒）`); return }
    if (i === 0) emit('畫面顯示 Inserting credits（額度轉入中），等它完成再按 SPIN...')
    await sleep(1000)
  }
  emit('⚠️ 等 30 秒仍在 Inserting credits，照原流程繼續')
}

async function stepSpinCore(page: Page, emit: (msg: string) => void, customSpinSel?: string | null, customBalanceSel?: string | null, spinAudioRef?: SpinAudioRef, aiAudio = false, spinCount = 3): Promise<StepResult> {
  await waitCreditsInserted(page, emit)
  const t0 = Date.now()
  try {
    // Diagnostic: run first, before anything else
    await diagPinusFrames(page, emit)

    emit(`尋找 Spin 按鈕...`)

    const spinSelectors = [
      ...(customSpinSel ? [customSpinSel] : []),
      '.my-button.btn_spin',
      '.btn_spin .my-button',     // special games (BULLBLITZ, ALLABOARD): inner clickable element
      '.btn_spin',
      '[class*="btn_spin"] .my-button',
      '[class*="btn_spin"]',
      'button[class*="spin"]',
      '[class*="spin-btn"]',
    ]

    let spinSel = ''
    let spinEl = null
    for (const sel of spinSelectors) {
      try {
        const els = await page.$$(sel)
        for (const el of els) {
          if (await el.isVisible()) { spinEl = el; spinSel = sel; break }
        }
        if (spinEl) break
      } catch { /* continue */ }
    }

    if (!spinEl) {
      return { step: 'Spin 測試', status: 'fail', message: '找不到 Spin 按鈕（嘗試了所有已知 selector）', durationMs: Date.now() - t0 }
    }
    emit(`找到 Spin 按鈕（${spinSel}），確認可點擊...`)

    // Check button is not disabled
    const isDisabled = await page.evaluate(
      (el: Element) => (el as HTMLButtonElement).disabled || el.classList.contains('disabled'),
      spinEl
    )
    if (isDisabled) {
      return { step: 'Spin 測試', status: 'fail', message: 'Spin 按鈕存在但被禁用（disabled）', durationMs: Date.now() - t0 }
    }

    // Read balance before spin —— 1007：只用機台內餘額（moneyNtc／Cash out credit），剛進機台還沒開過局時是 null
    void customBalanceSel
    const balanceBefore = await readMachineBalance(page)
    const moneySeq0 = await (async () => { const l = await readMoneyLog(page); return l.length ? l[l.length - 1].seq : 0 })()
    emit(`Spin 前機台餘額：${balanceBefore !== null ? balanceBefore : '尚無（還沒有 moneyNtc）'}`)

    // Record pre-spin baseline to detect contamination from other machines playing audio
    let baselineRmsDb: number | undefined
    if (spinAudioRef && existsSync(NIRCMD)) {
      const bl = await recordVBCableSerial(1000)
      if (bl) baselineRmsDb = bl.rmsDb
    }

    // Click spin 3 times — more reliable balance-change detection
    // 1008：音頻重錄只按 1 下（每一下都是真下注）
    const SPIN_COUNT = Math.max(1, Math.min(3, spinCount))

    // Start audio recording BEFORE first spin click (10s covers full spin cycle)
    const audioSamplePromise: Promise<void> = spinAudioRef
      ? (async () => {
          if (existsSync(NIRCMD)) {
            emit(`VB-Cable 音頻錄製（10 秒，第一次 Spin 前開始）...`)
            const rec = await recordVBCableSerial(10000, true)  // always keep WAV for disk save + optional AI
            if (rec) {
              spinAudioRef.data = { peakDb: rec.peakDb, rmsDb: rec.rmsDb, clipRatio: rec.clipRatio, crestFactor: rec.crestFactor, spectralCentroid: rec.spectralCentroid, method: 'vbcable', detail: `${rec.samples} PCM 樣本（Spin 錄音）`, baselineRmsDb, wavBase64: rec.wavBase64 }
              return
            }
          }
          const r = await sampleSpinAudio(page, 1500)
          spinAudioRef.data = r
        })()
      : Promise.resolve()

    for (let spinIdx = 0; spinIdx < SPIN_COUNT; spinIdx++) {
      // Re-query spin button each iteration to avoid stale ElementHandle
      let currentSpinEl = spinEl
      if (spinIdx > 0) {
        for (const sel of spinSelectors) {
          try {
            const els = await page.$$(sel)
            for (const el of els) {
              if (await el.isVisible()) { currentSpinEl = el; break }
            }
          } catch { /* continue */ }
          if (currentSpinEl !== spinEl) break
        }
      }

      // 面額選擇遮罩（.select-main）點擊時不會拋 "intercepts pointer events" 例外——遊戲只是
      // 完全收不到 Spin 動作，下面的 force click fallback 不會被觸發，會固定卡滿逾時。
      // 每次點 Spin 前主動檢查並關閉，不能只靠例外處理（同步 AutoSpin.py 的作法）。
      await dismissDenomOverlay(page, emit, `Spin ${spinIdx + 1}`)

      // Capture coin state before this spin —— 1007：看機台內餘額與 moneyNtc 序號（不用 __coinUpdatedAt，大廳錢包也會動它）
      const coinBeforeSpin = await readMachineBalance(page)
      const seqBeforeSpin = await (async () => { const l = await readMoneyLog(page); return l.length ? l[l.length - 1].seq : 0 })()

      // Use Playwright native click (dispatches proper pointer/mouse events).
      // If an overlay intercepts (e.g., DFDC free-game overlay), fall back to force click.
      let spinAct: UiActResult = 'none'
      try {
        spinAct = await uiAct(page, 'game', `Spin ${spinIdx + 1}`, currentSpinEl, () => currentSpinEl.click({ timeout: 5000 }))
      } catch (clickErr) {
        if (String(clickErr).includes('intercepts pointer events') || String(clickErr).includes('TimeoutError')) {
          emit(`Spin ${spinIdx + 1} overlay 攔截，改用 force click...｜${String(clickErr).slice(0, 160)}`)
          spinAct = await uiAct(page, 'game', `Spin ${spinIdx + 1}（force）`, currentSpinEl, () => currentSpinEl.click({ force: true }))
        } else {
          throw clickErr
        }
      }
      // 被提示框／禁點擋下：不算按了 SPIN，也不改用別的方式再按（CodeX 1007）
      if (spinAct === 'blocked') {
        return { step: 'Spin 測試', status: 'skip', message: `未驗：第 ${spinIdx + 1} 下 SPIN 被擋（${popupGuardOf(page)?.blockReason() ?? '禁點'}）`, durationMs: Date.now() - t0 }
      }
      emit(`Spin ${spinIdx + 1}/${SPIN_COUNT} 已點擊，等待動畫完成...`)

      let spinStarted = false
      const deadline = Date.now() + 8000
      while (Date.now() < deadline) {
        await sleep(300)
        try {
          const dis = await page.evaluate(
            (el: Element) => (el as HTMLButtonElement).disabled || el.classList.contains('disabled'),
            currentSpinEl
          )
          if (dis && !spinStarted) {
            spinStarted = true
            emit(`Spin ${spinIdx + 1} 動畫開始（按鈕 disabled）...`)
          }
          if (spinStarted && !dis) break
        } catch { break }
      }

      // Check if pinus got a new coin message after this spin
      await sleep(1000)
      const coinAfterSpin = await readMachineBalance(page)
      const pinusUpdated = (await (async () => { const l = await readMoneyLog(page); return l.length ? l[l.length - 1].seq : 0 })()) > seqBeforeSpin
      const coinChanged = coinAfterSpin !== null && coinBeforeSpin !== null && coinAfterSpin !== coinBeforeSpin
      if (pinusUpdated || coinChanged) {
        emit(`Spin ${spinIdx + 1} 完成 | coin: ${coinBeforeSpin} → ${coinAfterSpin}`)
      } else {
        emit(`⚠️ Spin ${spinIdx + 1} 未偵測到餘額變化（按鈕 disabled=${spinStarted}，沒有新的 moneyNtc）`)
      }
      if (spinIdx < SPIN_COUNT - 1) await sleep(500)
    }

    // Ensure audio sample is done
    await audioSamplePromise

    // Wait a bit more for balance update
    await sleep(800)

    // Post-spin diagnostic
    await diagPinusFrames(page, emit)

    // Read balance after all spins
    const balanceAfter = await readMachineBalance(page)
    emit(`${SPIN_COUNT} 次 Spin 後機台餘額：${balanceAfter !== null ? balanceAfter : '無法讀取'}`)
    const newMoney = (await readMoneyLog(page)).filter(e => e.seq > moneySeq0)
    const nBegin = newMoney.filter(e => e.reason === 'begin').length, nEnd = newMoney.filter(e => e.reason === 'end').length

    if (balanceBefore !== null && balanceAfter !== null) {
      const diff = balanceAfter - balanceBefore
      const diffStr = diff >= 0 ? `+${diff}` : `${diff}`
      if (diff !== 0) {
        return {
          step: 'Spin 測試',
          status: 'pass',
          message: `✅ Spin 確認執行（${SPIN_COUNT} 次，餘額變化 ${diffStr}，${balanceBefore} → ${balanceAfter}）`,
          durationMs: Date.now() - t0,
        }
      } else {
        return {
          step: 'Spin 測試',
          status: 'warn',
          message: `${SPIN_COUNT} 次 Spin 已點擊，但餘額未變化（${balanceBefore}）。可能：餘額為 0、bet 為 0 或遊戲未實際執行`,
          durationMs: Date.now() - t0,
        }
      }
    }

    // CodeX 1007：Spin 前還沒有機台餘額（剛進機台沒開過局）時，不退回其他來源——用「這次點擊之後的新 begin」確認開局、end 確認完成，
    // 餘額變化標未驗
    if (nBegin > 0 && nEnd > 0) {
      return {
        step: 'Spin 測試',
        status: 'pass',
        message: `✅ Spin 確認執行（${SPIN_COUNT} 次，本次 moneyNtc begin ${nBegin}／end ${nEnd}；Spin 前尚無機台餘額，餘額變化未驗${balanceAfter !== null ? `，Spin 後 ${balanceAfter}` : ''}）`,
        durationMs: Date.now() - t0,
      }
    }
    return {
      step: 'Spin 測試',
      status: 'warn',
      message: `Spin 按鈕已找到並點擊 ${SPIN_COUNT} 次（無法讀取機台餘額，無法確認是否執行；本次 moneyNtc begin ${nBegin}／end ${nEnd}）`,
      durationMs: Date.now() - t0,
    }
  } catch (e) {
    return { step: 'Spin 測試', status: 'fail', message: `例外: ${e}`, durationMs: Date.now() - t0 }
  }
}

/** Check HTML5 <video>/<audio> elements across ALL frames (including cross-origin iframes) */
async function checkMediaElements(page: Page): Promise<{
  hasUnmutedMedia: boolean
  summary: string
}> {
  const allItems: { tag: string; muted: boolean; volume: number; paused: boolean }[] = []

  for (const frame of page.frames()) {
    try {
      const items = await frame.evaluate(() => {
        const result: { tag: string; muted: boolean; volume: number; paused: boolean }[] = []
        document.querySelectorAll('video, audio').forEach(el => {
          const m = el as HTMLMediaElement
          result.push({ tag: el.tagName.toLowerCase(), muted: m.muted, volume: m.volume, paused: m.paused })
        })
        return result
      })
      allItems.push(...items)
    } catch { /* frame detached or evaluate failed */ }
  }

  const playing = allItems.filter(i => !i.paused)
  const unmuted = playing.filter(i => !i.muted && i.volume > 0)
  const summary = allItems.length === 0
    ? '無 media 元素'
    : `${allItems.length} 個 media（播放中: ${playing.length}，未靜音: ${unmuted.length}）` +
      (unmuted.length > 0 ? `，音量: ${unmuted.map(i => i.volume.toFixed(2)).join(', ')}` : '')
  return { hasUnmutedMedia: unmuted.length > 0, summary }
}

/**
 * 1008 SPIN 一律最小注（使用者硬規則；先做後審）。Spin 前把面額／Credits／倍數三組各按到最小那顆，**每一顆都要確認**才 SPIN：
 *   - 按下去之後 5 秒內要有 SEND／ON（同一個 seq）——伺服器收到了
 *   - 按完 6 秒內**不能開局**（有些鍵本身就是開局鍵，例如按到已選中的 88Credits、ARUZE 的 BET 鍵）——開局了就不是「設注」，停手、不 SPIN
 *   - 找不到下注鍵、同組最小值有兩顆、字看不懂、被提示框擋、點不到 → 一律不 SPIN（回 ok:false＋原因）
 * 保守：不確定就不下注。回 ok:true 時 note 寫出按了哪幾顆。
 */
export async function ensureMinBet(page: Page, emit: (msg: string) => void, shouldStop?: () => boolean): Promise<{ ok: true; note: string } | { ok: false; why: string }> {
  // 1) 找下注鍵（跟 iDeck 自動偵測同一組選擇器），讀按鈕字
  let frame: import('playwright').Frame | null = null
  let keys: Array<{ idx: number; text: string; el: ElementHandle }> = []
  for (const f of page.frames()) {
    try {
      const els = await f.$$('[class*="btn_bet"], [class*="btn_play"]')
      const vis: Array<{ idx: number; text: string; el: ElementHandle }> = []
      for (const el of els) {
        if (!await el.isVisible().catch(() => false)) continue
        const text = ((await el.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()
        vis.push({ idx: vis.length, text, el })
      }
      if (vis.length) { frame = f; keys = vis; break }
    } catch { /* frame detached */ }
  }
  if (!frame || !keys.length) return { ok: false, why: '找不到下注鍵（btn_bet／btn_play），無法確認是最小注' }
  const pick = pickMinBetKeys(keys.map(k => ({ idx: k.idx, text: k.text })))
  if (pick.ambiguous.length) return { ok: false, why: `下注鍵最小值不唯一：${pick.ambiguous.join('；')}` }
  if (!pick.groups.length) return { ok: false, why: `下注鍵的字看不懂（${keys.map(k => k.text || '空').slice(0, 6).join('、')}），無法確認是最小注` }

  // 2) 依序按：面額 → Credits → 倍數；監聽 SEND／ON 與 moneyNtc begin
  const sends: Array<{ seq: number; ts: number }> = [], acks: Array<{ seq: number; ts: number }> = []
  const onConsole = (m: import('playwright').ConsoleMessage) => {
    const s = m.text().match(/^(SEND|ON):\s*(\d+)\s+hall\.hallHandler\.dealGMActionReq/)
    if (s) (s[1] === 'SEND' ? sends : acks).push({ seq: Number(s[2]), ts: Date.now() })
  }
  page.on('console', onConsole)
  const pressed: string[] = []
  try {
    for (const g of ['denom', 'credits', 'mult'] as const) {
      const k = pick.picks[g]; if (!k) continue
      if (shouldStop?.()) return { ok: false, why: '已停止' }
      const el = keys[k.idx].el
      const seq0 = await (async () => { const l = await readMoneyLog(page); return l.reduce((a, e) => Math.max(a, e.seq), 0) })()
      const t0 = Date.now()
      const act = await uiAct(page, 'game', `最小注：${k.text}`, el, () => el.evaluate((node: Element) => (node as HTMLElement).click()))
      if (act === 'blocked') return { ok: false, why: `按「${k.text}」被擋下（${popupGuardOf(page)?.blockReason() ?? '禁點'}）` }
      // 伺服器有收到：SEND 之後同一個 seq 的 ON
      const send = await (async () => { const end = Date.now() + 5000; while (Date.now() < end) { const s = sends.find(x => x.ts >= t0); if (s) return s; await sleep(150) } return null })()
      if (!send) return { ok: false, why: `按「${k.text}」後 5 秒沒有送出 dealGMActionReq（不確定有沒有設到）` }
      const acked = await (async () => { const end = Date.now() + 5000; while (Date.now() < end) { if (acks.some(a => a.seq === send.seq)) return true; await sleep(150) } return false })()
      if (!acked) return { ok: false, why: `按「${k.text}」後伺服器沒有回應（seq ${send.seq}）` }
      // 不能開局：6 秒內出現新的 begin＝這顆是開局鍵 → 等局結束，停手
      const opened = await (async () => { const end = Date.now() + IDECK_CONSERVATIVE_BEGIN_MS; while (Date.now() < end) { const l = await readMoneyLog(page); if (l.some(e => e.seq > seq0 && e.reason === 'begin')) return true; await sleep(300) } return false })()
      if (opened) {
        const end = Date.now() + 45_000
        while (Date.now() < end && !shouldStop?.()) { const s = await readMoneySnap(page); if (s && ideckRoundState(s.log) !== 'open') break; await sleep(500) }
        return { ok: false, why: `按「${k.text}」開了一局（這顆是開局鍵，不是單純設注），停手、不 SPIN` }
      }
      pressed.push(k.text)
      emit(`最小注：已設「${k.text}」（伺服器已回應、沒有開局）`)
    }
  } finally { page.off('console', onConsole) }
  return { ok: true, note: `最小注：${pressed.join('＋')}` }
}

/**
 * 1008 音頻判 no sound 時再 Spin 重錄（使用者定案、osm-qa-agent 規格 spec-mt-audio-retry-1008、CodeX 定案）。
 *   - 只有 VB-Cable 的真靜音觸發（isAudioTrueSilence）；low sound、音色、退路路徑都不觸發
 *   - 首次錄音＋最多重錄 2 次＝最多錄音 3 次；每一次都是真下注，按之前 audioRetryPrecheck 要明確通過
 *   - 任一次**有效**錄音（VB-Cable、讀得到）不再靜音 → 用那一次照正常規則判、停止；錄音失敗／退回別的路徑不算「有聲音」
 *   - 重錄的 Spin 沒開局、失敗、被擋 → 停止重錄，用已有錄音判（仍是 no sound），寫明原因；並等局結束確認機台回到安全狀態
 *   - 原本的 Spin 步驟結果不動（CodeX）；過程記在 extraData.audioRetries，最終判定記在 extraData.audioFinal（批次看這個，不看訊息裡的字）
 */
export async function audioSilenceRetry(p: {
  page: Page; emit: (msg: string) => void; first: StepResult; firstRef: SpinAudioRef; spinStep: StepResult | undefined
  spinOnce: (ref: SpinAudioRef) => Promise<StepResult>; audioOf: (ref: SpinAudioRef) => Promise<StepResult>; stopped: () => boolean
  /** 測試用：換掉讀頁面狀態的部分 */
  probe?: { snap: () => Promise<{ log: MoneyEvent[] } | null>; balance: () => Promise<number | null>; popup: () => { stop: boolean; unknown: boolean }; idleWaitMs?: number }
}): Promise<StepResult> {
  const silentOf = (ref: SpinAudioRef) => ref.data?.method === 'vbcable' && isAudioTrueSilence(ref.data.rmsDb ?? ref.data.peakDb, ref.data.crestFactor)
  const valid = (ref: SpinAudioRef) => ref.data?.method === 'vbcable'
  const issuesOf = (m: string) => { const i = m.indexOf('問題:'); return i >= 0 ? m.slice(i) : '' }
  const attemptOf = (ref: SpinAudioRef) => ({ rmsDb: ref.data?.rmsDb ?? null, peakDb: ref.data?.peakDb ?? null })
  const beginsOf = (s: StepResult | undefined) => { const x = String(s?.message ?? '').match(/開局訊號 moneyNtc begin (\d+) 次/); return x ? Number(x[1]) : null }
  const snapOf = p.probe?.snap ?? (() => readMoneySnap(p.page))
  const balanceOf = p.probe?.balance ?? (() => readMachineBalance(p.page))
  const popupOf = p.probe?.popup ?? (() => { const g = popupGuardOf(p.page); return { stop: !!g?.stop, unknown: !!g?.unknown } })
  if (!valid(p.firstRef)) return p.first   // 不是 VB-Cable 路徑：照舊，不加 audioFinal（批次退回看訊息）
  if (!silentOf(p.firstRef)) return { ...p.first, extraData: { ...(p.first.extraData ?? {}), audioFinal: JSON.stringify({ silent: false, issues: issuesOf(p.first.message), recordings: 1 }) } }

  const attempts = [attemptOf(p.firstRef)]
  const retries: Array<Record<string, unknown>> = []
  let final = p.first, finalRef = p.firstRef, stopReason: string | null = null, lastSpinBegins = beginsOf(p.spinStep)
  for (let k = 1; k <= 2; k++) {
    if (p.stopped()) { stopReason = '使用者停止'; break }
    const pop = popupOf()
    const snap = await snapOf()
    const why = audioRetryPrecheck({
      popupStop: pop.stop, popupUnknown: pop.unknown, lastSpinBegins,
      roundState: snap ? ideckRoundState(snap.log) : null,
      balance: await balanceOf(), lastBet: snap ? lastBetFromMoneyLog(snap.log) : null,
    })
    if (why) { stopReason = why; break }
    p.emit(`🔁 音頻靜音 → 第 ${k} 次重錄：再按 1 下 SPIN（真下注）`)
    const ref: SpinAudioRef = { data: null }
    const sr = await p.spinOnce(ref)
    lastSpinBegins = beginsOf(sr)
    retries.push({ k, spin: sr.status, spinMessage: String(sr.message).slice(0, 200), begins: lastSpinBegins, rmsDb: ref.data?.rmsDb ?? null, peakDb: ref.data?.peakDb ?? null, method: ref.data?.method ?? null })
    if (sr.status === 'fail' || sr.status === 'skip' || !lastSpinBegins) {
      stopReason = `第 ${k} 次重錄的 Spin ${sr.status === 'fail' || sr.status === 'skip' ? sr.status : '沒有開局'}（${String(sr.message).split('｜')[0].slice(0, 80)}）`
      // 沒反應／逾時後仍可能延遲起局：等局結束再交給後面的步驟（CodeX）
      const end = Date.now() + (p.probe?.idleWaitMs ?? 45_000)
      while (Date.now() < end && !p.stopped()) { const s2 = await snapOf(); if (s2 && ideckRoundState(s2.log) !== 'open') break; await sleep(500) }
      break
    }
    if (!valid(ref)) { stopReason = `第 ${k} 次重錄的錄音失敗或退回非 VB-Cable 路徑（不算有聲音）`; break }
    attempts.push(attemptOf(ref))
    if (!silentOf(ref)) { final = await p.audioOf(ref); finalRef = ref; break }
  }
  const recovered = !silentOf(finalRef)
  const summary = audioRetrySummary({ attempts, recovered, stopReason })
  p.emit(`🔁 ${summary}`)
  return {
    ...final,
    message: `${summary}｜${final.message}`,
    extraData: {
      ...(final.extraData ?? {}),
      audioRetries: JSON.stringify(retries),
      audioFinal: JSON.stringify({ silent: !recovered, issues: issuesOf(final.message), recordings: attempts.length, stopReason }),
    },
  }
}

async function stepAudio(page: Page, emit: (msg: string) => void, spinAudio?: SpinAudioRef, aiAudio = false, machineCode = '', sessionPrefix = '', audioConfig?: import('./types.js').AudioConfig | null): Promise<StepResult> {
  const t0 = Date.now()
  try {
    // Prefer the recording captured during Spin (real game audio while reels spin).
    // Only fall back to a fresh idle recording if the Spin step was skipped.
    let sa: SpinAudioData | null = spinAudio?.data ?? null

    const audioSavePath = machineCode
      ? (() => { try { mkdirSync(AUDIO_SAVE_DIR, { recursive: true }) } catch {}; return `${AUDIO_SAVE_DIR}\\${sessionPrefix}${machineCode}.wav` })()
      : undefined

    // Check for per-machine reference WAV. It is only a comparison baseline;
    // the actual test result must always come from the live recording.
    const machineType = machineCode ? (machineCode.split('-').find(p => /^[A-Z]+$/.test(p)) ?? '') : ''
    const audioRefPath = machineType ? join(AUDIO_REFS_DIR, `${machineType}.wav`) : ''
    let audioRefAnalysis: ReturnType<typeof analyzeWav> | null = null
    if (audioRefPath && existsSync(audioRefPath)) {
      audioRefAnalysis = analyzeWav(audioRefPath)
      emit(`Using audio reference file for comparison: ${machineType}.wav`)
    }

    // Save spin recording (already in base64) to local folder + upload to central server
    if (sa?.wavBase64 && audioSavePath) {
      try {
        const audioBuf = Buffer.from(sa.wavBase64, 'base64')
        writeFileSync(audioSavePath, audioBuf)
        void uploadAudioToServer(audioBuf, basename(audioSavePath))
      } catch { /* non-fatal */ }
    }

    if (!sa && existsSync(NIRCMD)) {
      // Spin step was skipped — do a best-effort idle recording
      emit(`VB-Cable 音頻錄製（5 秒，閒置補錄）...`)
      const freshRec = await recordVBCableSerial(5000, aiAudio, audioSavePath)
      if (freshRec) {
        sa = { peakDb: freshRec.peakDb, rmsDb: freshRec.rmsDb, clipRatio: freshRec.clipRatio, crestFactor: freshRec.crestFactor, method: 'vbcable', detail: `${freshRec.samples} PCM 樣本（閒置補錄）`, wavBase64: freshRec.wavBase64 }
      }
    }

    // Read __audioMonitor from any frame (game may be in a cross-origin iframe)
    type AudioMonitorData = { active: boolean; samples: { rmsDb: number; peakDb: number; clipRatio: number; correlation: number }[]; error: string | null }
    let monitor: AudioMonitorData | null = null
    for (const frame of page.frames()) {
      try {
        const m = await frame.evaluate(() => (window as unknown as Record<string, unknown>).__audioMonitor)
        if (m && (m as AudioMonitorData).active) { monitor = m as AudioMonitorData; break }
        if (m && !monitor) monitor = m as AudioMonitorData  // keep as fallback even if not active
      } catch { /* frame detached */ }
    }

    // Check HTML5 media elements across all frames
    const mediaCheck = await checkMediaElements(page)
    emit(`Media 元素掃描：${mediaCheck.summary}`)
    if (sa) {
      const rmsStr = sa.rmsDb !== undefined && isFinite(sa.rmsDb) ? `，RMS ${sa.rmsDb.toFixed(1)} dB` : ''
      emit(`音頻採樣（${sa.method}）：${sa.detail}，峰值 ${isFinite(sa.peakDb) ? sa.peakDb.toFixed(1) : '-∞'} dB${rmsStr}`)

      if (sa.method === 'vbcable') {
        // VB-Cable: full dB analysis with clipping and noise detection
        const rmsDb = sa.rmsDb ?? sa.peakDb
        const clipRatio = sa.clipRatio ?? 0
        const crestFactor = sa.crestFactor ?? 0
        const issues: string[] = []

        // Per-machine thresholds resolved below (after this block)
        // Hard silence: near digital floor (-80 dB), AI cannot override this
        // 1008：規則抽到 verdicts.ts，重錄判斷用同一份
        const isTrueSilence = isAudioTrueSilence(rmsDb, crestFactor)
        if (isTrueSilence) {
          issues.push(`靜音（RMS ${isFinite(rmsDb) ? rmsDb.toFixed(1) : '-∞'} dB，無音頻輸出）`)
        } else if (isFinite(rmsDb) && rmsDb < (audioConfig?.rmsMinDb ?? -60)) {
          issues.push(`音量偏低（RMS ${rmsDb.toFixed(1)} dB，正常範圍 ${audioConfig?.rmsMinDb ?? -60} ~ ${audioConfig?.rmsMaxDb ?? -20} dB）`)
        } else if (isFinite(rmsDb) && rmsDb > (audioConfig?.rmsMaxDb ?? -20)) {
          issues.push(`音量過大（RMS ${rmsDb.toFixed(1)} dB，正常範圍 ${audioConfig?.rmsMinDb ?? -60} ~ ${audioConfig?.rmsMaxDb ?? -20} dB）`)
        }
        // Per-machine thresholds (fallback to global defaults)
        const PEAK_WARN_DB     = audioConfig?.peakWarnDb     ?? -3
        const CENTROID_WARN    = audioConfig?.centroidWarnHz ?? 1500
        const RMS_MIN_DB       = audioConfig?.rmsMinDb       ?? -60
        const RMS_MAX_DB       = audioConfig?.rmsMaxDb       ?? -20

        if (isFinite(sa.peakDb) && sa.peakDb > PEAK_WARN_DB) {
          issues.push(`爆音風險（峰值 ${sa.peakDb.toFixed(1)} dB，閾值 ${PEAK_WARN_DB} dB）`)
        }
        if (clipRatio > 0.001) {
          issues.push(`爆音/失真（${(clipRatio * 100).toFixed(2)}% 樣本 clipping）`)
        }
        // Low crest factor with audible signal = possible sustained noise or heavy distortion
        if (isFinite(rmsDb) && rmsDb > RMS_MIN_DB && crestFactor < 6) {
          issues.push(`疑似雜訊/失真（Peak/RMS 差值僅 ${crestFactor.toFixed(1)} dB，正常應 > 6 dB）`)
        }
        // Cross-machine contamination: if baseline before spin was already loud AND spin isn't significantly louder,
        // the recorded audio likely came from another machine's browser, not this game.
        const bl = sa.baselineRmsDb
        if (bl !== undefined && isFinite(bl) && isFinite(rmsDb)) {
          const snr = rmsDb - bl
          if (bl > -55 && snr < 10) {
            issues.push(`可能受其他機台音頻干擾（Spin 前基準 ${bl.toFixed(1)} dB，Spin 期間 ${rmsDb.toFixed(1)} dB，差值僅 ${snr.toFixed(1)} dB）`)
          }
        }

        const blStr = bl !== undefined && isFinite(bl) ? `，基準 ${bl.toFixed(1)} dB` : ''
        const centroid = sa.spectralCentroid ?? 0
        if (audioRefAnalysis) {
          const refRms = audioRefAnalysis.rmsDb
          const refPeak = audioRefAnalysis.peakDb
          const refCentroid = audioRefAnalysis.spectralCentroid
          const rmsDelta = isFinite(rmsDb) && isFinite(refRms) ? Math.abs(rmsDb - refRms) : 0
          const peakDelta = isFinite(sa.peakDb) && isFinite(refPeak) ? Math.abs(sa.peakDb - refPeak) : 0
          const centroidDelta = centroid > 0 && refCentroid > 0 ? Math.abs(centroid - refCentroid) : 0

          if (rmsDelta > 10) {
            issues.push(`音頻與參考檔 RMS 差異過大（actual ${rmsDb.toFixed(1)} dB / ref ${refRms.toFixed(1)} dB / delta ${rmsDelta.toFixed(1)} dB）`)
          }
          if (peakDelta > 10) {
            issues.push(`音頻與參考檔 peak 差異過大（actual ${sa.peakDb.toFixed(1)} dB / ref ${refPeak.toFixed(1)} dB / delta ${peakDelta.toFixed(1)} dB）`)
          }
          if (centroidDelta > 1200) {
            issues.push(`音色與參考檔差異過大（actual ${centroid.toFixed(0)} Hz / ref ${refCentroid.toFixed(0)} Hz）`)
          }
          emit(`Audio reference comparison (${machineType}.wav): actual RMS ${isFinite(rmsDb) ? rmsDb.toFixed(1) : '-'} dB / ref ${isFinite(refRms) ? refRms.toFixed(1) : '-'} dB, actual peak ${isFinite(sa.peakDb) ? sa.peakDb.toFixed(1) : '-'} dB / ref ${isFinite(refPeak) ? refPeak.toFixed(1) : '-'} dB`)
        }
        if (isFinite(rmsDb) && rmsDb > RMS_MIN_DB && centroid >= CENTROID_WARN) {
          issues.push(`音色偏亮/清脆（頻譜重心 ${centroid.toFixed(0)} Hz，閾值 < ${CENTROID_WARN} Hz）`)
        }
        const centroidStr = centroid > 0 ? `，重心 ${centroid.toFixed(0)} Hz` : ''
        // 0930 0255：VB-Cable 整段數位靜音但使用者在 H5 聽得到 → 當下 media 狀態（muted／音量／播放中）要留在結果裡，事後才查得出漏在哪
        const summary = `VB-Cable 錄音：RMS ${isFinite(rmsDb) ? rmsDb.toFixed(1) : '-∞'} dB，峰值 ${isFinite(sa.peakDb) ? sa.peakDb.toFixed(1) : '-∞'} dB，Crest ${crestFactor.toFixed(1)} dB，Clip ${(clipRatio * 100).toFixed(2)}%${blStr}${centroidStr}｜${sa.detail}｜Media：${mediaCheck.summary}`

        // AI audio analysis (if enabled and WAV was retained from spin recording)
        if (aiAudio && sa.wavBase64) {
          try {
            emit(`傳送錄音至 Gemini 進行 AI 音頻分析...`)
            const blContext = bl !== undefined && isFinite(bl) ? `，Spin 前背景基準 ${bl.toFixed(1)} dB` : ''
            const AUDIO_PROMPT = `你是遊戲機台音頻測試工程師。以下是一段 10 秒的遊戲機台錄音（WAV 格式）。
測量數據：RMS ${rmsDb.toFixed(1)} dB，峰值 ${isFinite(sa.peakDb) ? sa.peakDb.toFixed(1) : '-∞'} dB，Crest Factor ${crestFactor.toFixed(1)} dB${blContext}
正常遊戲音量範圍：RMS -60 到 -20 dB。低於 -80 dB 視為靜音（無音頻輸出）。
請根據錄音內容及上述測量數據判斷：
1. 音量是否在正常範圍內（參考 RMS 值）
2. 是否有爆音（峰值超過 -3 dB）或明顯失真
3. 是否有持續背景雜訊（非遊戲音效）
4. 整體評估：正常 / 有問題

請用中文回答，格式：{"status":"正常"|"有問題","detail":"一句話說明"}`
            const aiRaw = await callGeminiVisionViaProxy(AUDIO_PROMPT, sa.wavBase64, 'audio/wav')
            const aiCleaned = aiRaw.trim().replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim()
            let aiStatus = ''
            let aiDetail = ''
            try {
              const parsed = JSON.parse(aiCleaned) as { status?: string; detail?: string }
              aiStatus = parsed.status ?? ''
              aiDetail = parsed.detail ?? aiRaw.trim()
            } catch {
              aiDetail = aiRaw.trim().slice(0, 120)
            }
            emit(`AI 音頻分析：${aiStatus} — ${aiDetail}`)
            const aiSuffix = `｜AI: ${aiDetail}`
            if (aiStatus === '有問題') {
              // AI takes priority — but keep hard silence flag if already detected
              if (!isTrueSilence) issues.length = 0
              issues.push(`AI判斷異常：${aiDetail}`)
            } else {
              // AI says normal — clear RMS-based issues; but never clear true silence
              if (!isTrueSilence) issues.length = 0
            }
            if (issues.length > 0) {
              return { step: '音頻檢測', status: 'warn', message: `${summary}${aiSuffix}｜問題: ${issues.join('、')}`, durationMs: Date.now() - t0 }
            }
            return { step: '音頻檢測', status: 'pass', message: `${summary}${aiSuffix}`, durationMs: Date.now() - t0 }
          } catch (aiErr) {
            emit(`AI 音頻分析失敗（${aiErr}），使用 dB 判斷`)
          }
        }

        if (issues.length > 0) {
          return { step: '音頻檢測', status: 'warn', message: `${summary}｜問題: ${issues.join('、')}`, durationMs: Date.now() - t0 }
        }
        return { step: '音頻檢測', status: 'pass', message: summary, durationMs: Date.now() - t0 }
      }

      // captureStream fallback
      if (isFinite(sa.peakDb) && sa.peakDb > -60) {
        return { step: '音頻檢測', status: 'pass', message: `Spin 期間偵測到音頻訊號（峰值 ${sa.peakDb.toFixed(1)} dB）｜${sa.detail}`, durationMs: Date.now() - t0 }
      }
    }

    if (!monitor) {
      if (mediaCheck.hasUnmutedMedia) {
        return { step: '音頻檢測', status: 'pass', message: `HTML5 Audio/Video（${mediaCheck.summary}）`, durationMs: Date.now() - t0 }
      }
      const spinNote = sa ? `｜Spin採樣: ${sa.detail}` : ''
      return { step: '音頻檢測', status: 'warn', message: `音頻監控未注入，${mediaCheck.summary}${spinNote}`, durationMs: Date.now() - t0 }
    }

    if (monitor.error) {
      if (mediaCheck.hasUnmutedMedia) {
        return { step: '音頻檢測', status: 'pass', message: `HTML5 Audio/Video（${mediaCheck.summary}）`, durationMs: Date.now() - t0 }
      }
      return { step: '音頻檢測', status: 'warn', message: `音頻 API 不支援: ${monitor.error}，${mediaCheck.summary}`, durationMs: Date.now() - t0 }
    }

    if (!monitor.active || monitor.samples.length === 0) {
      if (mediaCheck.hasUnmutedMedia) {
        return { step: '音頻檢測', status: 'pass', message: `HTML5 Audio/Video（${mediaCheck.summary}）`, durationMs: Date.now() - t0 }
      }
      return { step: '音頻檢測', status: 'warn', message: `未偵測到 AudioContext，${mediaCheck.summary}`, durationMs: Date.now() - t0 }
    }

    const samples = monitor.samples
    const validSamples = samples.filter(x => isFinite(x.rmsDb))
    const avgDb = validSamples.length > 0
      ? validSamples.reduce((s, x) => s + x.rmsDb, 0) / validSamples.length
      : -Infinity
    const peakDb = samples.reduce((max, x) => isFinite(x.peakDb) ? Math.max(max, x.peakDb) : max, -Infinity)
    const avgClip = samples.reduce((s, x) => s + x.clipRatio, 0) / samples.length
    const avgCorr = samples.reduce((s, x) => s + Math.abs(x.correlation), 0) / samples.length

    // If Web Audio is silent but HTML5 media is playing, pass via media check
    if (!isFinite(avgDb) || avgDb < -60) {
      if (mediaCheck.hasUnmutedMedia) {
        return { step: '音頻檢測', status: 'pass', message: `HTML5 Audio/Video（${mediaCheck.summary}）｜Web Audio: ${samples.length} 筆樣本但訊號為零（遊戲音效走 media 元素通道）`, durationMs: Date.now() - t0 }
      }
    }

    const issues: string[] = []
    if (!isFinite(avgDb) || avgDb < -60) issues.push(`靜音（平均 ${isFinite(avgDb) ? avgDb.toFixed(1) : '-∞'} dB）`)
    else if (avgDb < -40) issues.push(`音量偏小（${avgDb.toFixed(1)} dB）`)
    if (isFinite(peakDb) && peakDb > -3) issues.push(`音量過大 / 爆音風險（峰值 ${peakDb.toFixed(1)} dB）`)
    if (avgClip > 0.01) issues.push(`爆音/失真（clipping ${(avgClip * 100).toFixed(1)}%）`)
    if (avgCorr > 0.95) issues.push(`單聲道（L/R 相關性 ${avgCorr.toFixed(2)}）`)

    const summary = `平均 ${isFinite(avgDb) ? avgDb.toFixed(1) : '-∞'} dB，峰值 ${isFinite(peakDb) ? peakDb.toFixed(1) : '-∞'} dB，${samples.length} 筆樣本`
    if (issues.length > 0) {
      return { step: '音頻檢測', status: 'warn', message: `${summary}｜問題: ${issues.join('、')}`, durationMs: Date.now() - t0 }
    }
    return { step: '音頻檢測', status: 'pass', message: summary, durationMs: Date.now() - t0 }
  } catch (e) {
    return { step: '音頻檢測', status: 'fail', message: `例外: ${e}`, durationMs: Date.now() - t0 }
  }
}

export async function stepIdeck(
  page: Page,
  emit: (msg: string) => void,
  machineCode: string,
  profile: MachineProfile | undefined,
  _waitForIdeckCmd?: IdeckWaitFn,  // kept for signature compat, replaced by pollIdeckEvent
  betRandomXpaths?: string[],
  shouldStop?: () => boolean,
  debugGmid?: string,
  sessionPrefix = '',
  openRound?: OpenRoundHandler,   // 1007：未監控機台開局沒結束 → 疑似特殊遊戲處理器（收到 end 後繼續下一顆）
  // 1007 iDeck 時間學習。_probeNoQuietWindow 只給探針用（關掉靜默窗才能走到「歸屬不明」那條路），正式呼叫端不傳
  timing?: { cfg: IdeckTimingCfg | null; revoked: string | null; onRevoke: (reason: string) => void; _probeNoQuietWindow?: boolean },
): Promise<StepResult> {
  const t0 = Date.now()
  try {
    // Build button list: store XPath + frame index for lazy re-query at click time (avoids stale ElementHandle)
    // xpath: used at click time to re-query fresh; frameIdx: which frame the element was found in
    type BtnEntry = { label: string; xpath: string; frameIdx: number }
    let buttons: BtnEntry[] = []

    // 自動偵測一律先跑一次，只印結果不改行為——用有手寫 XPath 的機種當對照組，
    // 累積「自動偵測抓到的跟手寫的是不是同一組」的證據。夠有把握之後才談拿掉手動設定。
    try {
      let autoCount = 0
      for (const f of page.frames()) {
        try {
          const els = await f.$$('[class*="btn_bet"], [class*="btn_play"]')
          for (const el of els) if (await el.isVisible()) autoCount++
          if (autoCount > 0) break
        } catch { /* frame detached */ }
      }
      const configured = (betRandomXpaths?.length ?? 0) || (profile?.ideckRowClass ? -1 : 0)
      emit(`🔍 iDeck 自動偵測對照：btn_bet＋btn_play 可見 ${autoCount} 顆`
        + (configured > 0 ? `／設定檔 XPath ${configured} 條 → ${autoCount === configured ? '數量一致 ✅' : '數量不一致 ⚠️'}` : ''))
    } catch { /* 對照失敗不影響測試 */ }

    // 診斷用：把 iDeck 區塊的結構印出來（只讀不點）。SQUIDGAME 實際 9 顆但 btn_bet 只看得到 4 顆，
    // 要知道另外 5 顆是別的 class、被隱藏、還是在畫面外，才能決定自動偵測怎麼改。
    try {
      for (const f of page.frames()) {
        let dump: string | null = null
        try {
          // tsx(esbuild keepNames) 會在內部箭頭函式包 __name()，瀏覽器端沒有這個 helper
          await f.evaluate('window.__name = window.__name || (fn => fn)')
          dump = await f.evaluate(() => {
            const bets = Array.from(document.querySelectorAll('[class*="btn_bet"], [class*="btn_play"]')) as HTMLElement[]
            if (bets.length === 0) return null
            const vis = (el: HTMLElement) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0 }
            const onScreen = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight }
            const betInfo = bets.map(b => { const r = b.getBoundingClientRect(); return `${/btn_play/.test(String(b.className)) ? 'P' : 'B'}${vis(b) ? (onScreen(b) ? 'V' : 'OFF') : 'H'}@${Math.round(r.x)},${Math.round(r.y)}"${(b.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 14)}"` })
            // 往上找涵蓋所有 btn_bet 的最小容器，最多爬 8 層
            let box: HTMLElement | null = bets[0]
            for (let i = 0; i < 8 && box && !bets.every(b => box!.contains(b)); i++) box = box.parentElement
            if (box && box.parentElement) box = box.parentElement
            const cls: Record<string, [number, number]> = {}
            box?.querySelectorAll('*').forEach(n => {
              const c = String((n as HTMLElement).className || '')
              if (!/btn|bet|play|col|chip|denom/i.test(c)) return
              const k = c.split(/\s+/).filter(x => /btn|bet|play|col|chip|denom/i.test(x)).join('.')
              cls[k] ??= [0, 0]; cls[k][0]++; if (vis(n as HTMLElement)) cls[k][1]++
            })
            const clsLine = Object.entries(cls).map(([k, [a, v]]) => `${k}:${v}/${a}`).join(' ')
            return `btn_bet ${bets.length} 個 [${betInfo.join(' ')}] ｜容器 ${box?.tagName}.${String(box?.className || '').slice(0, 40)} 內 class(可見/總數)：${clsLine.slice(0, 700)}`
          })
        } catch { /* frame detached */ }
        if (dump) { emit(`🔍 iDeck DOM：${dump}`); break }
      }
    } catch { /* 診斷失敗不影響測試 */ }

    if (betRandomXpaths && betRandomXpaths.length > 0) {
      emit(`使用隨機下注 XPath 列表（${betRandomXpaths.length} 個）...`)
      const frames = page.frames()
      for (let i = 0; i < betRandomXpaths.length; i++) {
        const xp = betRandomXpaths[i]
        let found = false
        for (let fi = 0; fi < frames.length; fi++) {
          try {
            const els = await frames[fi].$$(xp)
            if (els.length > 0) {
              buttons.push({ label: `xpath[${i + 1}]`, xpath: xp, frameIdx: fi })
              found = true
              break
            }
          } catch { /* frame detached */ }
        }
        if (!found) emit(`xpath[${i + 1}] ⚠️ 找不到元素，跳過`)
      }
    } else if (!profile?.ideckRowClass) {
      // ── 自動偵測 iDeck 按鈕（2026-09-22 加）─────────────────────────────────
      // 為什麼：原本每個機種都要手動寫 XPath，新遊戲上線就得先有人去量一次，
      // 沒設定就直接 SKIP——而 SKIP 看起來像「測過了」，其實是完全沒測。
      //
      // 實測依據（892-DRAGONLAW-0070 / Dragon's Law，2026-09-22）：
      //   `[class*="btn_bet"]` 可見元素 → 剛好 5 顆（1x/2x/3x/5x/10x TOTAL BET 50/100/150/250/500），
      //   與手寫 XPath 指到的是同一組；`van-play-col` 容器同樣也是 5 個。
      // ⚠️ **不要用文字規則**：LuckyLooter 的標籤是「BETx1 80 Credits」、
      //    Dragon's Law 是「1x TOTAL BET 50」，文字格式各遊戲不同，class 才穩定。
      // 2026-09-24 加 btn_play：SQUIDGAME（4186-SQUIDGAME-0312）iDeck 有兩排——
      //   btn_bet ×4 是面額（₱1/2/5/10），btn_play ×6 是注額（30~450 Credits），只抓 btn_bet 會漏掉 6 顆。
      emit(`未設定 iDeck XPath／rowClass → 自動偵測（[class*="btn_bet"]、[class*="btn_play"] 可見元素）...`)
      const frames = page.frames()
      for (let fi = 0; fi < frames.length; fi++) {
        try {
          const els = await frames[fi].$$('[class*="btn_bet"], [class*="btn_play"]')
          let n = 0
          for (let i = 0; i < els.length; i++) {
            if (!await els[i].isVisible()) continue
            n++
            // 用 nth 形式的 XPath 回查，避免存 ElementHandle 造成 stale。
            // 索引要用「全部元素」裡的位置（含隱藏的），不能用可見的序號，否則前面有隱藏元素時會點錯顆
            buttons.push({
              label: `auto[${n}]`,
              xpath: `(//*[contains(@class,'btn_bet') or contains(@class,'btn_play')])[${i + 1}]`,
              frameIdx: fi,
            })
          }
          if (buttons.length > 0) { emit(`自動偵測到 ${buttons.length} 顆 iDeck 按鈕（frame[${fi}]）`); break }
        } catch { /* frame detached */ }
      }
      if (buttons.length === 0) {
        return { step: 'iDeck 測試', status: 'fail', message: '自動偵測找不到 iDeck 按鈕（沒有可見的 [class*="btn_bet"]），且此機種未設定 XPath／rowClass', durationMs: Date.now() - t0 }
      }
    } else {
      const rowClass = profile.ideckRowClass
      emit(`掃描 iDeck 按鈕（${rowClass}）...`)
      const rowXpath = `//div[@class='${rowClass}']//div[contains(@class,'btn_bet')]`
      const frames = page.frames()
      let count = 0
      for (let fi = 0; fi < frames.length; fi++) {
        try {
          const found = await frames[fi].$$(rowXpath)
          if (found.length > 0) {
            for (let bi = 0; bi < found.length; bi++) {
              buttons.push({ label: `btn[${bi + 1}]`, xpath: `(${rowXpath})[${bi + 1}]`, frameIdx: fi })
            }
            count = found.length
            break
          }
        } catch { /* frame detached */ }
      }
      if (count === 0) {
        return { step: 'iDeck 測試', status: 'fail', message: `找不到 iDeck 按鈕（${rowClass} 內無 btn_bet 元素）`, durationMs: Date.now() - t0 }
      }
    }

    if (buttons.length === 0) {
      return { step: 'iDeck 測試', status: 'fail', message: '所有 XPath 均找不到可見元素', durationMs: Date.now() - t0 }
    }

    // ── 2026-09-29 兩段式驗證（console 約定由使用者提供，規則跟 CodeX 對過）─────────────
    // ① 共用：點擊後前端印 `SEND: <seq> hall.hallHandler.dealGMActionReq {actionid, isspin}`，
    //    server 收下回 `ON: <seq> hall.hallHandler.dealGMActionReq {actionid}`；seq＋actionid 都對上才算點擊成功。
    //    這只證明 server 收到，還不能證明機台效果。
    // ② 畫面：每顆點完截推流畫面（BZZF 切 bet/play 畫面會立即變），batch 端交給人判讀 BET 值，先當影子模式。
    // 盒子 log（daily-analysis）降成選配診斷：查不到不影響結果；查得到且跟 ① 矛盾才標 WARN，不能把 FAIL 降成 WARN。
    // ⚠️ isspin:1（play 鍵＝下注開轉，會扣錢）逾時也**不補點**，避免重複扣款；等 moneyNtc end 才點下一顆。
    // ⚠️ 最後要按回 BetMultiple1（倍數留在 x10，下一輪 Spin 會用高注額，0929 實際多扣過一次），還原也要驗 ON。
    type SendRec = { seq: number; actionid: number | null; isspin: number | null; ts: number }
    const sends: SendRec[] = []
    const acks: Array<{ seq: number; actionid: number | null; ts: number }> = []
    const names: Array<{ name: string; actionid: number; ts: number }> = []
    let moneyEndTs = 0, moneyBeginTs = 0
    const num = (v: unknown) => (v === undefined || v === null || v === '' || isNaN(Number(v))) ? null : Number(v)
    const argObj = async (m: import('playwright').ConsoleMessage) => {
      for (const a of m.args().slice(1)) {
        try { const v = await a.jsonValue(); if (v && typeof v === 'object') return v as Record<string, unknown> } catch { /* handle 已失效 */ }
      }
      return null
    }
    const onIdeckConsole = (m: import('playwright').ConsoleMessage) => {
      const t = m.text()
      const inline = (k: string) => num(t.match(new RegExp(`${k}['"]?\\s*:\\s*(\\d+)`))?.[1])
      const w = t.match(/dealGMActionReq:\s*\d+\s+(\S+)\s+(\d+)/)
      if (w) { names.push({ name: w[1], actionid: Number(w[2]), ts: Date.now() }); return }
      const s = t.match(/^(SEND|ON):\s*(\d+)\s+hall\.hallHandler\.dealGMActionReq/)
      if (s) {
        const ts = Date.now(), seq = Number(s[2])
        void argObj(m).then(o => {
          const actionid = num(o?.actionid) ?? inline('actionid')
          if (s[1] === 'SEND') sends.push({ seq, actionid, isspin: num(o?.isspin) ?? inline('isspin'), ts })
          else acks.push({ seq, actionid, ts })
        })
        return
      }
      // 0929 實機第一次跑：45 秒內沒抓到 end → 放寬比對（不要求開頭），並把每一筆 moneyNtc 印出來當診斷
      if (/moneyNtc/.test(t)) {
        const ts = Date.now()
        void argObj(m).then(o => {
          const reason = typeof o?.reason === 'string' ? o.reason : (t.match(/reason['"]?\s*:\s*['"](\w+)/)?.[1] ?? '?')
          emit(`iDeck 診斷 moneyNtc：reason=${reason} coin=${o?.coin ?? '?'}｜text="${t.slice(0, 80)}"｜args=${m.args().length}`)
          if (reason === 'end') moneyEndTs = ts
          if (reason === 'begin') moneyBeginTs = ts
        })
      }
    }
    const until = async (cond: () => boolean, ms: number) => {
      const end = Date.now() + ms
      while (Date.now() < end) { if (cond()) return true; if (shouldStop?.()) return false; await sleep(200) }
      return cond()
    }

    type Outcome = { label: string; text: string; name: string | null; seq: number | null; actionid: number | null; isspin: number | null; result: IdeckResult; shot: string | null; note: string
      /** 1007：要中止本台 iDeck（零後續點擊）的原因——歸屬不明、noAck 後無法確認狀態、晚到的局沒結束 */
      halt?: string
      /** 1008：開局族群的大注鍵——沒有按（不算進 outcomes） */
      skipped?: string
      /** 1008：按下時的頁面時間與 moneyLog 最大 seq（族群判斷：最小那顆按完之後有沒有開局） */
      clickAt?: number
      moneySeqBefore?: number
      /** 1007：時間量測（毫秒；沒觀測到＝null）。t_ack＝點→ON、t_begin＝點→begin、t_round＝begin→end、t_ready 第一期不量（固定等待不能當實測） */
      timing?: { mode: 'fast' | 'conservative'; waitMs: number; why: string; t_ack: number | null; t_begin: number | null; t_round: number | null; t_ready: null; lateBeginMs?: number }
    }
    // ── 1007 iDeck 時間學習：狀態 ──
    // degraded：本台改回保守的原因（晚到的 begin／noAck／撤銷）；prev：上一顆按下時的頁面時間、是不是短等待、按之前流水的最大 seq
    let degraded: string | null = timing?.revoked ? `機種學習值已撤銷（${timing.revoked}）` : null
    let prev: { clickTs: number; fast: boolean; seqBefore: number; outcome: Outcome; round: boolean } | null = null
    let ambiguous: string | null = null
    const maxSeq = (log: MoneyEvent[]) => log.reduce((m, e) => Math.max(m, e.seq), 0)
    let revokedReason: string | null = null
    const revoke = (reason: string) => { if (!degraded) degraded = reason; if (!revokedReason) { revokedReason = reason; timing?.onRevoke(reason) } }
    /** 等到流水顯示局結束（單一來源 __moneyLog）；逾時或停止回 false */
    const waitRoundIdle = async (ms: number) => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        if (shouldStop?.()) return false
        const s = await readMoneySnap(page)
        if (s && ideckRoundState(s.log) !== 'open') return true
        await sleep(300)
      }
      return false
    }
    /**
     * 按之前的關卡（每一顆都做，含還原倍數）：
     *   ① 上一顆是短等待 → 等到它的保守窗口（6 秒）滿（靜默窗）
     *   ② 上一顆之後出現 begin、上一顆卻記「沒開局」→ 晚到的局：歸給上一顆、等 end、本台改回保守、機種撤銷
     *   ③ 還有局沒結束 → 等 end；逾時就停（不按）
     * 回傳 null＝可以按，附上按之前的流水狀態；否則回傳不能按的原因
     */
    const gateBeforePress = async (): Promise<{ ok: true; gate: 'idle' | 'unknown'; seqBefore: number; now: number } | { ok: false; why: string }> => {
      const snap0 = await readMoneySnap(page)
      const q = timing?._probeNoQuietWindow ? 0 : ideckQuietWaitMs(prev, snap0?.now ?? Date.now())
      if (q > 0) await sleepOrStop(q, shouldStop ?? (() => false))
      let snap = await readMoneySnap(page)
      if (prev && !prev.round && snap) {
        const late = snap.log.find(e => e.reason === 'begin' && e.seq > prev!.seqBefore)
        if (late) {
          const lateMs = late.ts - prev.clickTs
          prev.round = true
          prev.outcome.note = `${prev.outcome.note ? prev.outcome.note.replace(/；?沒開局(（[^）]*）)?$/, '') + '；' : ''}有開局（begin 晚到 ${lateMs}ms，按下一顆之前抓到）`
          if (prev.outcome.timing) { prev.outcome.timing.t_begin = lateMs; prev.outcome.timing.lateBeginMs = lateMs }
          emit(`⏱ iDeck ${prev.outcome.label}：begin 晚到 ${lateMs}ms → 記「有開局」，等 end，本台改回保守${prev.fast ? '、撤銷機種學習值' : ''}`)
          if (prev.fast) revoke(`${ideckButtonKey(prev.outcome.text, prev.outcome.name) || prev.outcome.label} 在 ${lateMs}ms 後才開局（學習值 ${timing?.cfg?.beginWaitMs ?? '?'}ms）`)
          else degraded ??= `${prev.outcome.label} begin 晚到`
        }
      }
      if (snap && ideckRoundState(snap.log) === 'open') {
        emit(`⏱ iDeck 按之前還有局沒結束 → 等 end（最多 45 秒）`)
        if (!await waitRoundIdle(45000)) return { ok: false, why: '按之前有局 45 秒沒結束，不按（iDeck 不補點）' }
        snap = await readMoneySnap(page)
      }
      const gate = snap ? ideckRoundState(snap.log) : 'unknown'
      return { ok: true, gate: gate === 'open' ? 'unknown' : gate, seqBefore: snap ? maxSeq(snap.log) : 0, now: snap?.now ?? Date.now() }
    }
    const outcomes: Outcome[] = []
    // 1007 learn 拍攝（ideckCapture）
    const learnDir = join(MACHINE_TEST_ROOT, 'ideck-learn')
    const learnTag = `${sessionPrefix}${machineCode}`
    const learnCap: { idle: Array<string | null>; buttons: Array<{ idx: string; label: string; text: string; name: string | null; pre: string | null; post1: string | null; post2: string | null }> } = { idle: [], buttons: [] }
    const btnTexts: Record<string, string> = {}
    const backDone = new Set<string>()
    const shotDir = join(MACHINE_TEST_ROOT, 'ideck-saves')
    // asIs：照當下畫面截、什麼都不點（中止／逾時的收尾用——CodeX：零後續點擊，連 JP 卡的 X 都不按）
    const shoot = async (tag: string, asIs = false) => {
      if (!machineCode) return null
      try {
        mkdirSync(shotDir, { recursive: true })
        const p = join(shotDir, `${sessionPrefix}${machineCode}-${tag}.png`)
        if (!asIs) await closeJackpotNotification(page)
        writeFileSync(p, await page.screenshot({ type: 'png' }))
        return p
      } catch { return null }
    }

    const clickOne = async (label: string, xpath: string, frameIdx: number, idx: string): Promise<Outcome> => {
      const o: Outcome = { label, text: '', name: null, seq: null, actionid: null, isspin: null, result: 'noElement', shot: null, note: '' }
      const allFrames = page.frames()
      const frame = allFrames[frameIdx] ?? allFrames[0]
      let el: ElementHandle | null = null
      try { el = (await frame.$$(xpath))[0] ?? null } catch (eq) { o.note = `重新查詢例外（${eq instanceof Error ? eq.message.split('\n')[0] : String(eq)}）` }
      if (!el) { o.note ||= '重新查詢找不到元素'; return o }
      try { o.text = ((await el.textContent()) ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) } catch { /* 讀不到字就留空 */ }
      btnTexts[label] = o.text

      // 1007 iDeck 時間學習：按之前的關卡（靜默窗、晚到的 begin、局沒結束）
      const g = await gateBeforePress()
      if (g.ok === false) { o.result = 'spinTimeout'; o.note = g.why; o.halt = g.why; return o }
      // 1007 learn 拍攝：按之前的 pre
      if (ideckCaptureOn) learnCap.buttons.push({ idx, label, text: o.text, name: null, pre: await grabMainCrop(page, machineCode, join(learnDir, `${learnTag}-${idx}-pre.png`)), post1: null, post2: null })
      const tClick = Date.now()
      const me = { clickTs: g.now, fast: false, seqBefore: g.seqBefore, outcome: o, round: false }
      o.clickAt = g.now; o.moneySeqBefore = g.seqBefore
      const prevPress = prev
      prev = me
      try {
        // evaluate click bypasses overlay/actionability checks
        const ideckEl = el
        const act = await uiAct(page, 'game', `iDeck ${label}`, ideckEl, () => ideckEl.evaluate((node: Element) => (node as HTMLElement).click()))
        // 被提示框／禁點擋下：這顆不算點過，也不改用座標再點（CodeX 1007）
        if (act === 'blocked') { o.note = `被擋下（${popupGuardOf(page)?.blockReason() ?? '禁點'}），沒有點`; return o }
      } catch (e1) {
        // Fallback: coordinate click via mouse
        emit(`${label} evaluate 失敗（${e1 instanceof Error ? e1.message.split('\n')[0] : String(e1)}），改座標點擊`)
        try {
          const box = await el.boundingBox()
          const fallbackEl = el
          if (box) { if ((await uiAct(page, 'game', `iDeck ${label}（座標）`, fallbackEl, () => page.mouse.click(box.x + box.width / 2, box.y + box.height / 2))) === 'blocked') { o.note = '被擋下，沒有點'; return o } }
          else o.note = '無法取得元素座標'
        } catch (e2) { o.note = `座標點擊也失敗（${e2 instanceof Error ? e2.message.split('\n')[0] : String(e2)}）` }
      }

      await until(() => sends.some(s => s.ts >= tClick), 5000)
      const s = sends.find(x => x.ts >= tClick)
      o.name = names.find(n => n.ts >= tClick)?.name ?? null
      if (!s) {
        o.result = 'notSent'
      } else {
        o.seq = s.seq; o.actionid = s.actionid; o.isspin = s.isspin
        await until(() => acks.some(a => a.seq === s.seq), 5000)
        const a = acks.find(x => x.seq === s.seq)
        if (!a) o.result = 'noAck'
        else if (s.actionid === null || a.actionid === null || s.actionid !== a.actionid) { o.result = 'mismatch'; o.note = `SEND actionid=${s.actionid ?? '?'}／ON actionid=${a.actionid ?? '?'}` }
        else o.result = 'ack'
        // 有沒有開局**不看 isspin**，看 moneyNtc begin（0929 實測 BZZF 0235）：
        //   上方 18/38 Credits 是 isspin:1 卻不開局（0 筆 moneyNtc）；下方 BET x1~x10 是 isspin:0，按下去 2~3 秒後反而有 begin→end（真的開局扣錢）。
        // 所以每一顆點完都等 6 秒看有沒有 begin：有＝開局 → 等 end 才點下一顆（逾時中止、不補點，避免局中連點）；沒有＝沒開局 → 照常往下。
        // 1008：清單是按鈕字（PLAY11Credits／BETx1），不是 SEND 的 action name（Bet11／BetMultiple1）——用同一個 ideckButtonKey 查
        const bw = ideckBeginWait({ cfg: timing?.cfg, key: ideckButtonKey(o.text, o.name), ackOk: o.result === 'ack', gate: g.gate, degraded })
        me.fast = bw.ms !== null
        const waitMs = bw.ms ?? IDECK_CONSERVATIVE_BEGIN_MS
        const started = await until(() => moneyBeginTs >= tClick, waitMs)
        const ackRec = acks.find(x => x.seq === s.seq)
        o.timing = { mode: me.fast ? 'fast' : 'conservative', waitMs, why: bw.why, t_ack: ackRec ? ackRec.ts - tClick : null, t_begin: started ? moneyBeginTs - tClick : null, t_round: null, t_ready: null }
        me.round = started
        if (started) {
          const isEnd = () => moneyEndTs >= moneyBeginTs && moneyEndTs >= tClick
          let done = await until(isEnd, 45000)
          // 1006 ARUZE 0335：開局 45 秒沒結束，常是中 JP（選元寶）／FG（選卡）要觸屏點才會往下走。
          // 機種在 feature-taps.json 有點位清單才點；只點觸屏格，iDeck 按鍵本身仍然不補點
          let ftNote = ''
          // 1007 規格 A：未監控機台交給共用處理器（含 featureTaps／bonusAction／救援，結束條件＝收到這一局的 end）；
          // 回 null＝不適用（OSMWatcher 有監控），照原本的點位清單流程
          const orr = !done && !shouldStop?.() && openRound ? await openRound(`iDeck ${label}`) : null
          if (orr) { ftNote = orr.note; done = isEnd() || orr.result === 'done' }
          const ft = !done && !orr && !shouldStop?.() ? featureTapsConfig(machineCode) : null
          if (ft) {
            const deadline = Date.now() + FEATURE_TAP_MAX_MS
            const all: FeatureTapLog[] = []
            let cursor = 0
            let ftStop = ''
            while (!isEnd() && cursor < ft.points.length && Date.now() < deadline && !shouldStop?.()) {
              const r = await featureTapRound(page, emit, ft, cursor, isEnd, () => (shouldStop?.() ?? false) || Date.now() >= deadline, `${label} 開局 45 秒沒結束（可能卡在 JP／FG 選擇畫面）`)
              cursor = r.cursor; all.push(...r.log)
              if (r.result === 'screen') await until(isEnd, 30000)
              if (r.result !== 'screen' && r.result !== 'done') { ftStop = r.result; break }
            }
            done = isEnd()
            const why = ftStop === 'notOnScreen' ? '，OCR 沒確認是 JP／FG 選擇畫面所以沒點' : ftStop === 'unsure' ? '，截圖失敗已停手、請人工確認' : ''
            ftNote = `JP／FG 觸屏推進 ${all.filter(l => l.result === 'done' || l.result === 'screen' || l.result === 'none').length} 下（${featureTapSummary(all) || '沒點到'}）${why}`
          }
          if (!done) { o.result = 'spinTimeout'; o.note = `${o.note ? o.note + '；' : ''}開局後 45 秒內沒等到 moneyNtc end（iDeck 不補點${ftNote ? '；' + ftNote + '仍未結束' : ''}）` }
          else o.note = `${o.note ? o.note + '；' : ''}有開局（moneyNtc begin→end${orr ? '，觸發特殊遊戲' : ''}）${ftNote ? '；' + ftNote : ''}`
          if (done && o.timing && moneyEndTs >= moneyBeginTs) o.timing.t_round = moneyEndTs - moneyBeginTs
        } else o.note = `${o.note ? o.note + '；' : ''}沒開局${me.fast ? `（短等待 ${waitMs}ms）` : ''}`
        // 1007：歸屬檢查——這顆按下之後出現的 begin，落在上一顆（短等待）的保守窗口內 → 分不出是誰開的局 → 中止本台 iDeck
        const snapA = await readMoneySnap(page)
        if (snapA) {
          for (const b of snapA.log.filter(e => e.reason === 'begin' && e.seq > me.seqBefore)) {
            if (attributeBegin({ beginTs: b.ts, prev: prevPress, nextClickTs: me.clickTs }) === 'ambiguous') {
              ambiguous = `begin（seq ${b.seq}）落在 ${prevPress?.outcome.label ?? '?'}（短等待）的保守窗口內、又在 ${label} 送出之後，分不出是哪一顆開的局`
              o.halt = ambiguous
              revoke(`歸屬不明：${ambiguous}`)
              break
            }
          }
        }
        // 1007（CodeX）：學習值套用中的機台，noAck 不重按；再等 6 秒沒任何事件＝無法確認已回到可操作狀態 → 停本台 iDeck
        if (!o.halt && o.result === 'noAck' && timing?.cfg?.status === 'confirmed' && !started) {
          o.halt = 'noAck 後 6 秒沒有任何 money 事件，無法確認機台已回到可操作狀態（不重按、停本台 iDeck）'
          o.note = `${o.note ? o.note + '；' : ''}${o.halt}`
          degraded ??= 'noAck'
        }
      }

      return o
    }
    const shotAndReport = async (o: Outcome, idx: string, asIs = false) => {
      // CodeX 139aa8d [P2]：asIs（中止／逾時的收尾）要傳給 shoot——不然還是會去點 JP 廣播卡的 X
      o.shot = await shoot(`ideck-${idx}${o.name ? '-' + o.name.replace(/[^\w-]/g, '') : ''}`, asIs)
      const tag = { ack: '✅ server 已回應', mismatch: '❌ actionid 對不上', noAck: '❌ 有送出但 server 沒回應', notSent: '❌ 前端沒送出 dealGMActionReq', noElement: '⚠️ 找不到元素', spinTimeout: '❌ 開轉後沒等到結束' }[o.result]
      emit(`iDeck 按鈕 ${o.label}「${o.text}」${o.name ? `(${o.name})` : ''} → ${tag}${o.seq !== null ? `（seq ${o.seq}, actionid ${o.actionid ?? '?'}, isspin ${o.isspin ?? '?'}）` : ''}${o.note ? '｜' + o.note : ''}`)
    }
    // 一般收尾：可能會再點（關面額選單）
    const settle = async (o: Outcome, idx: string) => {
      if (o.result !== 'noElement' && !o.halt) {
        // After clicking btn_bet, game may show denomination overlay — dismiss it to complete the iDeck interaction
        await sleep(500)
        await dismissDenomOverlay(page, emit, o.label)
      }
      // 推流有延遲，等 2.5 秒再截畫面證據
      await sleepOrStop(2500, shouldStop ?? (() => false))
      // 1007 learn 拍攝：按完穩定後 post1、隔 1.5 秒 post2（post1 對 post2 的差異＝動畫雜訊）
      if (ideckCaptureOn && o.result !== 'noElement') {
        const rec = learnCap.buttons.find(b => b.idx === idx)
        if (rec) {
          rec.post1 = await grabMainCrop(page, machineCode, join(learnDir, `${learnTag}-${idx}-post1.png`))
          await sleepOrStop(1500, shouldStop ?? (() => false))
          rec.post2 = await grabMainCrop(page, machineCode, join(learnDir, `${learnTag}-${idx}-post2.png`))
        }
      }
      await shotAndReport(o, idx)
    }
    // 開轉逾時的收尾：機台狀態不明，**不可再點任何東西**（CodeX 0929），只截圖留證據
    const afterTimeout = async (o: Outcome, idx: string) => { await shotAndReport(o, idx, true) }

    // 盒子 log 基準（選配診斷）
    const today = toLocalDateStr(new Date())
    // debugGmid replaces only the channel prefix (first segment), e.g. "873-BULLBLITZ-0135" → "873-BZZF-0136"
    const effectiveGmid = debugGmid ? machineCode.replace(/^[^-]+/, debugGmid) : machineCode
    if (debugGmid) emit(`[調適模式] iDeck 日誌渠道號替換為 ${debugGmid}，gmid：${effectiveGmid}`)
    const apiUrl = `${DAILY_ANALYSIS_BASE}?gmid=${encodeURIComponent(effectiveGmid)}&date=${encodeURIComponent(today)}`
    const isIdeck = (e: LogEntry) => {
      if (e.type !== 'success_json') return false
      const d = typeof e.data === 'string' ? JSON.parse(e.data) as Record<string, unknown> : e.data
      return d?.is_ideck === true || d?.is_ideck === 1
    }
    const fetchBox = async (): Promise<{ entries: LogEntry[]; err: string | null }> => {
      try {
        const res = await fetch(apiUrl)
        if (!res.ok) return { entries: [], err: `HTTP ${res.status}` }
        const json = await res.json() as { success?: boolean; message?: string; data?: { timeline?: LogEntry[] } }
        if (json.success === false) return { entries: [], err: json.message ?? 'success:false' }
        return { entries: (json.data?.timeline ?? []).filter(isIdeck), err: null }
      } catch (err) { return { entries: [], err: `例外 ${err}` } }
    }
    const keyOf = (e: LogEntry) => `${e.time}|${JSON.stringify(e.data)}`
    const baseline = await fetchBox()
    const baselineKeys = new Set(baseline.entries.map(keyOf))

    page.on('console', onIdeckConsole)
    let restore: Outcome | null = null
    let aborted = false
    const backOutcomes: Array<{ idx: string; o: Outcome }> = []
    let familySkipped: Outcome[] = [], restoreSkipped: string | null = null, finalGateDone = false
    try {
      const before = await shoot('ideck-0-before')
      // 1007 learn 拍攝：第一顆按之前，不按任何鍵連拍 4 張、每張隔 3 秒（約 9 秒；0345 實測 3 張 3 秒抓不到慢慢跳的獎池數字）
      if (ideckCaptureOn) {
        for (let k = 1; k <= IDECK_LEARN_IDLE_SHOTS && !shouldStop?.(); k++) {
          learnCap.idle.push(await grabMainCrop(page, machineCode, join(learnDir, `${learnTag}-idle${k}.png`)))
          if (k < IDECK_LEARN_IDLE_SHOTS) await sleepOrStop(IDECK_LEARN_IDLE_GAP_MS, shouldStop ?? (() => false))
        }
        emit(`📚 iDeck 指標學習：已拍 idle ${learnCap.idle.filter(Boolean).length} 張`)
      }
      if (before) emit(`iDeck 點擊前畫面：${before}`)
      emit(`共 ${buttons.length} 個按鈕，逐一點擊（每顆驗 SEND/ON 配對）...`)
      // 順序與中止規則在 verdicts.ts runIdeckSequence（有流程探針）：開轉逾時 → 後面零點擊（含面額選單、還原）；
      // 最後按回 BetMultiple1；有倍數鍵卻找不到這顆 → ideckVerdict 判失敗
      // 1008 別下大注：先讀每顆的字，同族群改成由小到大按（最小那顆先，用它判斷是不是開局鍵）
      const preTexts: Record<string, string> = {}
      for (const b of buttons) {
        try { const el = (await (page.frames()[b.frameIdx] ?? page.frames()[0]).$$(b.xpath))[0]; preTexts[b.label] = ((await el?.textContent()) ?? '').replace(/\s+/g, ' ').trim() } catch { preTexts[b.label] = '' }
      }
      const reordered = ideckFamilyOrder(buttons.map(b => preTexts[b.label] ?? '')).map(i => buttons[i])
      if (reordered.some((b, i) => b !== buttons[i])) emit(`iDeck 依族群由小到大重排：${reordered.map(b => preTexts[b.label] || b.label).join('、')}`)
      buttons.splice(0, buttons.length, ...reordered)
      const liveOutcomes: Outcome[] = []
      const familyMin: Partial<Record<'denom' | 'credits' | 'mult', string>> = {}
      for (const b of buttons) { const f = classifyBetKey(preTexts[b.label] ?? ''); if (f && !familyMin[f.group]) familyMin[f.group] = b.label }
      /** 這個族群的最小那顆按完之後有沒有開局；不確定也當成開局（回原因）。等滿保守窗口再看 */
      const familyRoundOpening = async (g: 'denom' | 'credits' | 'mult'): Promise<string | null> => {
        const minLabel = familyMin[g]
        const mo = liveOutcomes.find(o => o.label === minLabel)
        if (!mo) return '同族群最小那顆還沒按，不確定是不是開局鍵'
        if (mo.result !== 'ack') return `同族群最小那顆「${mo.text}」沒確認（${mo.result}），當成開局鍵`
        if (/有開局/.test(mo.note)) return `同族群最小那顆「${mo.text}」會開局（開局鍵），比它大的不按，避免大注`
        if (mo.clickAt === undefined || mo.moneySeqBefore === undefined) return `同族群最小那顆「${mo.text}」沒有時間紀錄，不確定`
        // 保守窗口內有沒有晚到的 begin
        for (;;) {
          const snap = await readMoneySnap(page)
          if (!snap) return '讀不到局狀態，不確定是不是開局鍵'
          if (snap.log.some(e => e.reason === 'begin' && e.seq > mo.moneySeqBefore!)) return `同族群最小那顆「${mo.text}」之後有開局，當成開局鍵`
          if (snap.now - mo.clickAt >= IDECK_CONSERVATIVE_BEGIN_MS) return null
          await sleep(300)
        }
      }
      const seq = await runIdeckSequence({
        buttons,
        press: async (b, idx) => {
          if (idx === 'restore') emit(`還原倍數：再按一次 ${b.label}（BetMultiple1）`)
          // 1008 別下大注：同族群的最小那顆按過、而且有開局（或不確定）→ 這個族群是開局鍵，比它大的不按
          const fam = classifyBetKey(preTexts[b.label] ?? '')
          const minOfFam = fam ? familyMin[fam.group] : null
          if (fam && minOfFam && minOfFam !== b.label && /^\d+$/.test(idx)) {
            const why = await familyRoundOpening(fam.group)
            if (why) {
              emit(`⏭ iDeck ${b.label}「${preTexts[b.label]}」不按：${why}`)
              return { label: b.label, text: preTexts[b.label] ?? '', name: null, seq: null, actionid: null, isspin: null, result: 'noElement' as IdeckResult, shot: null, note: why, skipped: why }
            }
          }
          const o = await clickOne(b.label, b.xpath, b.frameIdx, idx)
          if (/^\d+$/.test(idx)) liveOutcomes.push(o)
          return o
        },
        // 1008：倍數族群是開局鍵（x1 開了局、其他都沒按）→ 倍數本來就停在 x1，不再按（再按會再開一局）
        skipRestore: os => { const x1 = os.find(o => o.name === 'BetMultiple1'); return x1 && /有開局/.test(x1.note) ? '倍數鍵是開局鍵，只按了 x1，倍數本來就在 x1' : null },
        settle, afterTimeout,
        shouldStop: () => shouldStop?.() ?? false,
        // 1008 SPIN 一律最小注：還原時先按回最小的 Credits 鍵（再照舊按 BetMultiple1）。那一顆測試時開過局就不按（會再開一局）
        minRestore: async os => {
          // 1008：先過收尾關卡——最後一顆是短等待時，等滿保守窗口、抓晚到的 begin（不然會在局還沒被發現時又按一顆＝再下一注）
          if (prev && prev.fast && !shouldStop?.()) {
            const g = await gateBeforePress()
            finalGateDone = true
            if (g.ok === false) { emit(`🛑 iDeck：${g.why}`); prev.outcome.note += `；${g.why}`; prev.outcome.result = 'spinTimeout'; prev.outcome.halt = g.why; return 'stop' }
          }
          const cands = os.map((o, i) => ({ i, o, c: classifyBetKey(btnTexts[o.label] ?? o.text ?? '') })).filter(x => x.c?.group === 'credits')
          if (!cands.length) return null
          const min = Math.min(...cands.map(x => x.c!.value))
          const hits = cands.filter(x => x.c!.value === min)
          if (hits.length !== 1 || /有開局/.test(hits[0].o.note)) { emit(`⚠️ 還原最小 Credits：${hits.length !== 1 ? '最小值不唯一' : `「${hits[0].o.text}」測試時開過局`}，不按`); return null }
          // 最後按的 Credits 就是最小那顆 → 本來就在最小注，不再按（按到已選中的鍵，有些機種會直接開局）
          const lastCredits = [...cands].sort((a, b) => a.i - b.i).at(-1)!
          if (lastCredits.o.label === hits[0].o.label) return null
          const bi = buttons.findIndex(b => b.label === hits[0].o.label)
          return bi >= 0 ? bi : null
        },
        // 1007 learn 來回按：只在拍攝模式做（多按的那一下不算進 outcomes、不影響判定）
        ...(ideckCaptureOn ? { back: (os: Outcome[]) => ideckBackPick(os.map(o => ({ name: o.name, result: o.result, round: /有開局/.test(o.note) })), backDone) } : {}),
      })
      if (seq.backs.length) emit(`📚 iDeck 指標學習：來回按 ${seq.backs.map(b => `${b.o.name ?? b.o.label}${b.o.result === 'ack' ? '' : '✗'}`).join('、')}`)
      outcomes.push(...seq.outcomes)
      restore = seq.restore
      familySkipped = seq.skipped; restoreSkipped = seq.restoreSkipped ?? null
      if (seq.minRestore) emit(`還原最小 Credits：${seq.minRestore.label}「${seq.minRestore.text}」${seq.minRestore.result === 'ack' ? '✓' : '✗（' + seq.minRestore.result + '）'}`)
      backOutcomes.push(...seq.backs.map(b => ({ idx: `back-${b.of + 1}`, o: b.o })))
      aborted = seq.aborted
      const haltWhy = [...seq.outcomes, ...(seq.restore ? [seq.restore] : [])].find(o => o.halt)?.halt
      if (aborted) emit(haltWhy ? `🛑 iDeck：${haltWhy} → 中止後面的 iDeck 點擊（不補點、不還原）` : `🛑 iDeck：開轉後 45 秒沒結束，中止後面的點擊（不補點、不還原）`)
      // 1007：最後一顆（或還原）是短等待 → 等它的保守窗口滿，再看有沒有晚到的 begin（沒有下一顆的關卡可以抓）
      if (!aborted && !finalGateDone && prev && prev.fast && !shouldStop?.()) {
        const g = await gateBeforePress()
        // CodeX 139aa8d [P1]：收尾抓到晚開局、45 秒沒結束 → 那一顆要記成開轉逾時，不能留著 ack（沒有倍數鍵時 verdict 會放行成 PASS）
        if (g.ok === false) { aborted = true; emit(`🛑 iDeck：${g.why}`); prev.outcome.note += `；${g.why}`; prev.outcome.result = 'spinTimeout'; prev.outcome.halt = g.why }
      }
      // 歸屬不明：等局結束（被動、不點），之後交回 stepGate 接觸屏／CCTV／退出；逾時不算完成——還沒結束的局由下一步的 checkOsm（疑似特殊遊戲）接手
      if (ambiguous && !shouldStop?.()) {
        const idle = await waitRoundIdle(45000)
        emit(idle ? `⏱ iDeck 歸屬不明：局已結束，接著做後面的步驟` : `⚠️ iDeck 歸屬不明：45 秒內局沒結束，交給下一步的特殊遊戲處理`)
      }
    } finally {
      page.off('console', onIdeckConsole)
    }
    if (shouldStop?.()) return { step: 'iDeck 測試', status: 'skip', message: '已停止', durationMs: Date.now() - t0 }

    // 盒子 log（選配）：等同步後比對新增筆數
    emit(`等待盒子 log 同步（15s，選配診斷）...`)
    await sleepOrStop(15000, shouldStop ?? (() => false))
    const after = baseline.err ? baseline : await fetchBox()
    const apiErr = after.err
    const ideckEntries = apiErr ? [] : after.entries.filter(e => !baselineKeys.has(keyOf(e)))
    const boxCmds = ideckEntries.map(e => { const d = typeof e.data === 'string' ? JSON.parse(e.data) as Record<string, unknown> : e.data; return String(d?.cmd ?? '') })
    emit(apiErr ? `盒子 log 查不到（${apiErr}）→ 只記錄，不影響判定` : `盒子 log：新增 ${ideckEntries.length} 筆 iDeck（${boxCmds.join(', ')}）`)

    const acked = outcomes.filter(o => o.result === 'ack').length
    const shots = [...outcomes, ...(restore ? [restore] : [])].filter(o => o.shot).map(o => ({ label: o.label, name: o.name, text: o.text, path: o.shot! }))
    const learnI = { extraData: {
      learn: JSON.stringify({ v: LEARN_VER, source: (profile?.ideckXpaths ?? []).length > 0 ? 'profileXpaths' : (betRandomXpaths?.length ? 'betRandom' : 'auto'), buttons: buttons.map(b => ({ label: b.label, xpath: b.xpath, text: btnTexts[b.label] ?? '' })), serverAcked: acked, actions: outcomes.map(o => ({ label: o.label, name: o.name, actionid: o.actionid, isspin: o.isspin, result: o.result, round: /有開局/.test(o.note) })), boxAccepted: apiErr ? null : ideckEntries.length, boxCmds, apiErr }),
      ideckShots: JSON.stringify(shots),
      // 1007 learn 拍攝的路徑（只有 ideckCapture 時才有）；name 用 SEND 拿到的 action name 補上
      //   round：這一下有沒有開局（最後的 note，含晚到的 begin）；backOf：來回按的「按回」那一下，指回它第一次按的 idx
      ...(ideckCaptureOn ? { ideckLearn: JSON.stringify({ v: 2, idle: learnCap.idle, buttons: learnCap.buttons.map(b => {
        const o = b.idx.startsWith('back-') ? backOutcomes.find(x => x.idx === b.idx)?.o : [...outcomes, ...(restore ? [restore] : [])].find(x => x.label === b.label)
        return { ...b, name: o?.name ?? null, round: o ? /有開局/.test(o.note) : null, ...(b.idx.startsWith('back-') ? { backOf: b.idx.slice(5) } : {}) }
      }) }) } : {}),
    } }

    const v = ideckVerdict({ outcomes, restore, aborted, apiErr, boxCount: ideckEntries.length, ambiguous, restoreSkipped, skipped: familySkipped.map(o => ({ label: o.label, text: o.text, why: o.skipped ?? '' })) })
    // 1007 iDeck 時間學習：時間模式＋每顆量測（extraData.ideckTiming，batch 收）
    const all = [...outcomes, ...(restore ? [restore] : [])]
    const fastN = all.filter(o => o.timing?.mode === 'fast').length
    const cfg = timing?.cfg ?? null
    const modeTxt = !cfg || cfg.status !== 'confirmed' ? '時間模式：保守' : `時間模式：學習值（${extractMachineType(machineCode)}，confirmed 於 ${cfg.confirmedAt ?? '?'}）短等待 ${fastN}/${all.length} 顆${degraded ? `｜⚠️ 本台改回保守：${degraded}` : ''}`
    const timingX = JSON.stringify({ v: 1, mode: cfg?.status === 'confirmed' ? 'learned' : 'conservative', degraded, ambiguous, revoke: revokedReason, buttons: all.map(o => ({ label: o.label, name: o.name, key: ideckButtonKey(o.text, o.name), result: o.result, ...(o.timing ?? { mode: null }) })) })
    // 0930 JJBXGRAND 0338：批次工具用整段錄音判「沒聲音」時，要先確定這段期間真的有局在跑——選單一直沒關、一局都沒開的話，
    // 整段安靜不代表機台沒聲音。所以把 iDeck 實際開局的顆數記進結果
    const rounds = [...outcomes, ...(restore ? [restore] : [])].filter(o => /有開局/.test(String((o as { note?: string })?.note ?? ''))).length
    return { step: 'iDeck 測試', status: v.status, message: `${v.message}｜iDeck 開局 ${rounds} 顆｜${modeTxt}｜本次 ${Math.round((Date.now() - t0) / 1000)} 秒`, durationMs: Date.now() - t0, extraData: { ...learnI.extraData, ideckTiming: timingX } }
  } catch (e) {
    return { step: 'iDeck 測試', status: 'fail', message: `例外: ${e}`, durationMs: Date.now() - t0 }
  }
}

// ── 觸屏畫面判定（2026-09-29）────────────────────────────────────────────────
// 機種在 touch-visual.json 有設定就走這條：點一格會讓機台畫面變化的位置（BZZF：18,9 開賠率表），
// 看 main 推流有沒有打開、再點一次有沒有關回來。不靠盒子 log，CMDB 查不到的台也能驗。
// 判定規則在 verdicts.ts touchVisualVerdict（有探針）；這裡只負責截圖、算變動比例、點擊。
const TOUCH_VISUAL_FILE = join(MACHINE_TEST_ROOT, 'touch-visual.json')
const TOUCH_SAVE_DIR = join(MACHINE_TEST_ROOT, 'touch-saves')
// refRegion：預期畫面參考圖（touch-refs/<機種>.png）要比對的區域（相對座標 x0,y0,x1,y1），BZZF＝選面額選單的橫幅
type TouchVisualCfg = { point: string; expect: string; close: string; refRegion?: [number, number, number, number]; closeIfOpen?: boolean }
const TOUCH_REFS_DIR = join(MACHINE_TEST_ROOT, 'touch-refs')
/** 指定區域的差異比例（像素 RGB 平均差 > 40 算不同；兩張尺寸不同時用相對座標對應） */
/**
 * 自動學選單（1003，使用者：「learn 的時候就該知道，不該回頭學」）：
 * A＝進場時 main 推流畫面、B＝前端選面額等機台反應後的畫面。若變化**集中在一條區域**（選單消失）而其他地方幾乎沒動，
 * 那條區域就是選單 → 回傳比對區（比例座標）。整片都在動（滾輪轉、待機動畫）或幾乎沒變 → 不學（寧可不學，也不要學錯）。
 */
export function discoverMenuRegion(A: InstanceType<typeof PNG>, B: InstanceType<typeof PNG>, opt: { rows?: number; cols?: number } = {}) {
  const R = opt.rows ?? 40, C = opt.cols ?? 20
  const cell: number[][] = []
  for (let r = 0; r < R; r++) {
    cell.push([])
    for (let c = 0; c < C; c++) {
      let ch = 0, n = 0
      for (let y = Math.floor(r * A.height / R); y < (r + 1) * A.height / R; y += 2) for (let x = Math.floor(c * A.width / C); x < (c + 1) * A.width / C; x += 2) {
        const bx = Math.min(B.width - 1, Math.round(x * B.width / A.width)), by = Math.min(B.height - 1, Math.round(y * B.height / A.height))
        const i = (y * A.width + x) * 4, j = (by * B.width + bx) * 4
        const d = (Math.abs(A.data[i] - B.data[j]) + Math.abs(A.data[i + 1] - B.data[j + 1]) + Math.abs(A.data[i + 2] - B.data[j + 2])) / 3
        n++; if (d > 40) ch++
      }
      cell[r].push(n ? ch / n : 0)
    }
  }
  const rowHot = cell.map(row => row.filter(v => v > 0.5).length / C)
  // 最長一段「這列有一半以上的格子變了」的連續列（允許中間斷 1 列）
  let best: [number, number] | null = null
  for (let r = 0; r < R; r++) {
    if (rowHot[r] < 0.5) continue
    let e = r
    while (e + 1 < R && (rowHot[e + 1] >= 0.5 || (e + 2 < R && rowHot[e + 2] >= 0.5 && rowHot[e + 1] >= 0.2))) e++
    if (!best || e - r > best[1] - best[0]) best = [r, e]
    r = e
  }
  const total = cell.flat().filter(v => v > 0.5).length / (R * C)
  if (!best) return { ok: false as const, note: `沒有集中變化的區域（整體變動 ${(total * 100).toFixed(0)}%）` }
  const [r0, r1] = best
  const colHot = Array.from({ length: C }, (_, c) => { let k = 0; for (let r = r0; r <= r1; r++) if (cell[r][c] > 0.5) k++; return k / (r1 - r0 + 1) })
  const cs = colHot.map((v, c) => v >= 0.5 ? c : -1).filter(c => c >= 0)
  const c0 = Math.min(...cs), c1 = Math.max(...cs)
  const region: [number, number, number, number] = [c0 / C, r0 / R, (c1 + 1) / C, (r1 + 1) / R].map(v => Math.round(v * 1000) / 1000) as [number, number, number, number]
  let inHot = 0, inN = 0, outHot = 0, outN = 0
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) { const inside = r >= r0 && r <= r1 && c >= c0 && c <= c1; if (inside) { inN++; if (cell[r][c] > 0.5) inHot++ } else { outN++; if (cell[r][c] > 0.5) outHot++ } }
  const inside = inHot / inN, outside = outN ? outHot / outN : 0
  const h = region[3] - region[1], w = region[2] - region[0]
  const why = `區域 [${region.join(',')}]，區內變動 ${(inside * 100).toFixed(0)}%、區外 ${(outside * 100).toFixed(0)}%`
  if (h < 0.08 || h > 0.6 || w < 0.4) return { ok: false as const, note: `變化區大小不像選單（高 ${(h * 100).toFixed(0)}%、寬 ${(w * 100).toFixed(0)}%）｜${why}` }
  if (inside < 0.5 || outside > 0.25) return { ok: false as const, note: `變化不夠集中（${why}）` }
  return { ok: true as const, region, inside, outside, note: why }
}

function regionDiff(a: Buffer, ref: InstanceType<typeof PNG>, region: [number, number, number, number]): number {
  const A = PNG.sync.read(a)
  let ch = 0, n = 0
  for (let y = Math.floor(region[1] * A.height); y < region[3] * A.height; y += 2) {
    for (let x = Math.floor(region[0] * A.width); x < region[2] * A.width; x += 2) {
      const bx = Math.min(ref.width - 1, Math.round(x * ref.width / A.width)), by = Math.min(ref.height - 1, Math.round(y * ref.height / A.height))
      const i = (y * A.width + x) * 4, j = (by * ref.width + bx) * 4
      const d = (Math.abs(A.data[i] - ref.data[j]) + Math.abs(A.data[i + 1] - ref.data[j + 1]) + Math.abs(A.data[i + 2] - ref.data[j + 2])) / 3
      n++
      if (d > 40) ch++
    }
  }
  return n ? ch / n : 1
}
function touchVisualConfig(machineCode: string): TouchVisualCfg | null {
  try {
    const cfg = JSON.parse(readFileSync(TOUCH_VISUAL_FILE, 'utf8')) as Record<string, TouchVisualCfg>
    const type = machineCode.split('-').slice(1, -1).join('-').toUpperCase()
    return cfg[type] ?? null
  } catch { return null }
}
/** 兩張同尺寸 PNG 的變動像素比例（RGB 平均差 > 20/255 算變動；每 4 個像素取 1 個） */
function diffRatio(a: Buffer, b: Buffer): number {
  const A = PNG.sync.read(a), B = PNG.sync.read(b)
  if (A.width !== B.width || A.height !== B.height) return 1
  let changed = 0, n = 0
  for (let i = 0; i < A.data.length; i += 16) {
    const d = (Math.abs(A.data[i] - B.data[i]) + Math.abs(A.data[i + 1] - B.data[i + 1]) + Math.abs(A.data[i + 2] - B.data[i + 2])) / 3
    n++
    if (d > 20) changed++
  }
  return n ? changed / n : 0
}
// 各機種畫面配置（0929）：screens＝應該有幾個推流畫面；少畫面時 streamRoles 才能判出缺的是 main 還是 pool
const MACHINE_LAYOUT_FILE = join(MACHINE_TEST_ROOT, 'machine-layout.json')
function machineLayout(machineCode: string): { screens?: number } | null {
  try {
    const cfg = JSON.parse(readFileSync(MACHINE_LAYOUT_FILE, 'utf8')) as Record<string, { screens?: number }>
    return cfg[machineCode.split('-').slice(1, -1).join('-').toUpperCase()] ?? null
  } catch { return null }
}
/** main 推流的位置：角色判定跟 streamRoles 同一套（0243：只剩上方獎池時不能把它當 main）；找不到 main 回 null */
/**
 * 1007 learn 自動找 iDeck 畫面指標（規格 osm-qa-agent/reports/spec-mt-ideck-indicator-learn-1007.md）：
 * session 帶 ideckCapture（batch --learn 自動帶）時，iDeck 多拍 main 推流框：第一顆按之前 idle×3、每顆按之前 pre、按完 post1／post2。
 * 一般批次不拍（不拖慢）。agent 一次只跑一個 session，用模組層旗標即可
 */
let ideckCaptureOn = false
const IDECK_LEARN_IDLE_SHOTS = 4, IDECK_LEARN_IDLE_GAP_MS = 3000
export function setIdeckCapture(on: boolean) { ideckCaptureOn = on }
async function grabMainCrop(page: Page, machineCode: string, file: string): Promise<string | null> {
  try {
    const box = await mainVideoBox(page, machineCode)
    if (!box) return null
    const buf = await page.screenshot({ type: 'png', clip: { x: Math.max(0, box.x), y: Math.max(0, box.y), width: box.width, height: box.height } })
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, buf)
    return file
  } catch { return null }
}

async function mainVideoBox(page: Page, machineCode = '') {
  const boxes: Array<{ x: number; y: number; width: number; height: number; playing: boolean; time: number }> = []
  for (const f of page.frames()) {
    try {
      for (const v of await f.$$('video')) {
        const b = await v.boundingBox()
        if (!b || b.width < 50 || b.height < 50) continue
        const st = await v.evaluate((e: Element) => { const x = e as HTMLVideoElement; return { playing: !x.paused && x.readyState >= 2 && x.videoWidth > 0, time: x.currentTime } })
        boxes.push({ ...b, ...st })
      }
    } catch { /* frame detached */ }
  }
  boxes.sort((a, b) => a.y - b.y)
  const viewportH = page.viewportSize()?.height ?? await page.evaluate(() => window.innerHeight).catch(() => 0)
  const { roles } = streamRoles(boxes.map(b => ({ y: b.y, h: b.height, playing: b.playing })), { expected: machineLayout(machineCode)?.screens, viewportH })
  const i = roles.findIndex(r => r.role === 'main')
  return i >= 0 ? boxes[i] : null
}

/** 觸屏格子「列,行」→ 可點的元素（span 往外找第一個有尺寸的容器；DRAGONLAW 的 span 是 0x0） */
async function findTouchTarget(page: Page, point: string): Promise<ElementHandle | null> {
  for (const frame of page.frames()) {
    try {
      const els = await frame.$$(`//span[normalize-space(text())='${point}']`)
      if (!els.length) continue
      const h = await els[0].evaluateHandle((e: Element) => {
        let p: Element | null = e
        for (let k = 0; p && k < 5; p = p.parentElement, k++) { const r = p.getBoundingClientRect(); if (r.width >= 2 && r.height >= 2) return p }
        return e
      })
      const t = h.asElement()
      if (t) return t
    } catch { /* frame detached */ }
  }
  return null
}

/**
 * Spin 前的選面額選單閘門（0930）：流程在 verdicts.ts runMenuGate，這裡只提供「選單開著嗎／前端選面額／點觸屏」。
 * 選單開著＝main 推流畫面跟參考圖（touch-refs/<機種>.png 的 refRegion＝CHOOSE A DENOMINATION 橫幅）差異 < REF_MATCH。
 * 使用者：前端選完面額機台會自己關，約 5 秒內 → 等 10 秒（留一倍餘裕）；還開著就點 18,9 與設定檔的觸屏點位。
 */
const MENU_GATE_FILE = join(MACHINE_TEST_ROOT, 'menu-gate.json')
const MENU_REFS_DIR = join(MACHINE_TEST_ROOT, 'menu-refs')
// 1003：一個機種可以有多張參考圖（外觀變體，例 MONEYGONG 紅 Emperor／紫 Empress）——refs 額外的圖放 menu-refs/<file>，任一張對上就算選單開著
// openAt（1003 COINCOMBO，使用者教的）：選單不會自己出現、要點機台畫面某處才打開的機種——推流框內的比例位置（例：右下角 0.96,0.983）
type MenuGateCfg = { refRegion?: [number, number, number, number]; taps?: string[]; refs?: Array<{ file: string; region: [number, number, number, number] }>; openAt?: { fx: number; fy: number } }
const MENU_MAX_REFS = 4
function menuGateConfig(type: string): MenuGateCfg | null {
  try { return (JSON.parse(readFileSync(MENU_GATE_FILE, 'utf8')) as Record<string, MenuGateCfg>)[type] ?? null } catch { return null }
}

/**
 * 1003 量觸屏座標用：網頁上「列,行」觸屏格（透明 span）在頁面上的位置 → 找出蓋住指定點的那一格。
 * pts 是相對 main 推流框的比例座標（例：MONEYGONG ₱1 約 0.34,0.86）。回傳每個點對應的格子標籤＋整張格子的範圍。
 */
export async function touchCellsAt(page: Page, box: { x: number; y: number; width: number; height: number }, pts: Array<{ label: string; fx: number; fy: number }>) {
  const cells: Array<{ t: string; x: number; y: number; w: number; h: number }> = []
  for (const frame of page.frames()) {
    try {
      const off = frame === page.mainFrame() ? { x: 0, y: 0 } : await (await frame.frameElement()).boundingBox()
      if (!off) continue
      const list = await frame.evaluate(() => Array.from(document.querySelectorAll('span'))
        .filter(s => /^\d+,\d+$/.test((s.textContent ?? '').trim()))
        .map(s => {
          let p: Element | null = s, r = s.getBoundingClientRect()
          for (let k = 0; p && k < 5; p = p.parentElement, k++) { r = p.getBoundingClientRect(); if (r.width >= 2 && r.height >= 2) break }
          return { t: (s.textContent ?? '').trim(), x: r.left, y: r.top, w: r.width, h: r.height }
        }))
      for (const c of list) cells.push({ ...c, x: c.x + off.x, y: c.y + off.y })
    } catch { /* frame detached */ }
  }
  const hits = pts.map(p => {
    const X = box.x + p.fx * box.width, Y = box.y + p.fy * box.height
    const c = cells.find(c => X >= c.x && X < c.x + c.w && Y >= c.y && Y < c.y + c.h)
    return { label: p.label, x: Math.round(X), y: Math.round(Y), cell: c?.t ?? null }
  })
  const firsts = cells.map(c => Number(c.t.split(',')[0])), seconds = cells.map(c => Number(c.t.split(',')[1]))
  const range = cells.length ? `${cells.length} 格｜第一個數 ${Math.min(...firsts)}~${Math.max(...firsts)}、第二個數 ${Math.min(...seconds)}~${Math.max(...seconds)}｜格子大小約 ${Math.round(cells[0].w)}×${Math.round(cells[0].h)}` : '找不到觸屏格'
  return { hits, range }
}

// 1003 自動學選單的結果（batch 寫回 knowledge/games/<機種>/automation/machine-test.json）
export interface MenuLearn { region?: [number, number, number, number]; refPng?: string; taps?: string[]; note: string; variant?: boolean; openTap?: string }
const MENU_LEARN_DIR = join(MACHINE_TEST_ROOT, 'menu-learn')

async function spinMenuGate(page: Page, emit: (msg: string) => void, machineCode: string, profile: MachineProfile | undefined, stop: () => boolean): Promise<MenuGateResult & { learn?: MenuLearn }> {
  // 0930：選單參考圖有兩個來源——menu-gate.json＋menu-refs/<機種>.png（只給閘門用，JJBXGRAND），
  // 或沿用觸屏畫面判定的 touch-visual.json＋touch-refs/（BZZF）。前者不會把觸屏測試切成畫面判定模式。
  const type = machineCode.split('-').slice(1, -1).join('-').toUpperCase()
  const gateCfg = menuGateConfig(type)
  const cfg = gateCfg ?? touchVisualConfig(machineCode)
  const refPath = gateCfg ? join(MENU_REFS_DIR, `${type}.png`) : join(TOUCH_REFS_DIR, `${type}.png`)
  // 拍 main 推流框（要在播、而且畫面是新的——CodeX 0930：有播不代表畫面是新的，currentTime 要前進）
  let lastTime = -1
  const grab = async (): Promise<{ buf: Buffer; png: InstanceType<typeof PNG>; box: NonNullable<Awaited<ReturnType<typeof mainVideoBox>>> } | null> => {
    let box = await mainVideoBox(page, machineCode)
    if (!box || !box.playing) return null
    if (lastTime >= 0 && box.time <= lastTime) {
      await sleep(1000)
      box = await mainVideoBox(page, machineCode)
      if (!box || !box.playing || box.time <= lastTime) return null
    }
    lastTime = box.time
    await closeJackpotNotification(page, emit)
    const buf = await page.screenshot({ type: 'png', clip: { x: Math.max(0, box.x), y: Math.max(0, box.y), width: box.width, height: box.height } }).catch(() => null)
    return buf ? { buf, png: PNG.sync.read(buf), box } : null
  }

  // ── 沒有參考圖：自動學選單（1003，使用者：「learn 的時候就該知道，不該回頭學」）────────────
  // 進場畫面靜止 → 前端選面額 → 等 10 秒 → 畫面靜止，而且只有一條區域變了＝那條是選單 → 存參考圖＋比對區（batch 寫回機種設定）。
  // 學不到（畫面在動、沒有前端選面額、變化不集中）就照舊：選單狀態未知，Spin 沒開局交人工。
  // 自動學選單：進場畫面靜止 → 前端選面額 → 等 10 秒 → 畫面靜止，而且只有一條區域變了＝那條是選單。回傳學到的區域＋參考圖路徑，或學不到的原因
  type Discovered = { ok: boolean; region?: [number, number, number, number]; refPng?: string; note?: string; why?: string; frontSelected?: boolean }
  const discover = async (tag: string): Promise<Discovered> => {
    const a1 = await grab(); await sleep(2000); const a2 = await grab()
    if (!a1 || !a2) return { ok: false, why: '推流沒在播或停格', frontSelected: false }
    if (regionDiff(a2.buf, a1.png, [0, 0, 1, 1]) > 0.05) return { ok: false, why: '進場畫面在動，不是靜止的選單，不學', frontSelected: false }
    if (!await dismissDenomOverlay(page, emit, tag)) return { ok: false, why: '沒有前端選面額浮層，不學', frontSelected: false }
    await sleep(10_000)
    const b1 = await grab(); await sleep(2000); const b2 = await grab()
    if (!b1 || !b2) return { ok: false, why: '選面額後推流沒在播或停格', frontSelected: true }
    // 1003 COINCOMBO：選完面額後是滾輪／金幣待機動畫，畫面本來就會動——參考圖用的是 A（選單畫面，前面已要求靜止），
    // B 只拿來找「哪一塊變了」，所以 B 有動畫可以接受；只有整片劇烈變動（> 30%）才放棄，其餘交給 discoverMenuRegion 的「變化要集中」檢查
    const bMove = regionDiff(b2.buf, b1.png, [0, 0, 1, 1])
    if (bMove > 0.3) return { ok: false, why: `選面額後畫面整片在動（${(bMove * 100).toFixed(0)}%），不學`, frontSelected: true }
    const r = discoverMenuRegion(a1.png, b1.png)
    if (!r.ok) return { ok: false, why: `沒學到：${r.note}`, frontSelected: true }
    mkdirSync(MENU_LEARN_DIR, { recursive: true })
    const p = join(MENU_LEARN_DIR, `${type}-${Date.now()}.png`)
    writeFileSync(p, a1.buf)
    return { ok: true, region: r.region, refPng: p, note: r.note }
  }

  // 自動學選單（點開型，1003 COINCOMBO）：先關前端浮層 → 拍「選單關著」→ 點 openAt 打開機台選單 → 拍「選單開著」→
  // 變化集中的那塊＝選單（存參考圖）→ 在選單區域裡逐格點，選單一關就記下那格（＝選面額的觸屏座標）。
  // 點的都在選單區域內：最多是換了面額，不會下注。關不掉 → 再點一次 openAt、再走前端選面額，盡量讓機台回到可 Spin 的狀態。
  const discoverByOpen = async (openAt: { fx: number; fy: number }): Promise<{ ok: boolean; why?: string; learn?: MenuLearn; closed?: boolean }> => {
    const tag = '自動學選單（點開型）'
    if (await dismissDenomOverlay(page, emit, tag)) await sleep(5000)
    const c0 = await grab()
    if (!c0) return { ok: false, why: '推流沒在播或停格' }
    const { hits } = await touchCellsAt(page, c0.box, [{ label: 'open', fx: openAt.fx, fy: openAt.fy }])
    const openCell = hits[0]?.cell
    if (!openCell) return { ok: false, why: `打開選單的位置（${openAt.fx},${openAt.fy}）找不到觸屏格` }
    const ot = await findTouchTarget(page, openCell)
    if (!ot) return { ok: false, why: `找不到觸屏格子 ${openCell}` }
    emit(`📚 ${tag}（${type}）：點 ${openCell} 打開機台選單`)
    await gameTap(page, ot, '觸屏')
    await sleep(4000)
    const m1 = await grab(); await sleep(2000); const m2 = await grab()
    if (!m1 || !m2) return { ok: false, why: '點開後推流沒在播或停格' }
    const r = discoverMenuRegion(m1.png, c0.png)
    if (!r.ok) return { ok: false, why: `點 ${openCell} 後沒看到選單（${r.note}）`, closed: true }
    if (regionDiff(m2.buf, m1.png, r.region) >= REF_MATCH) return { ok: false, why: `點 ${openCell} 後那塊一直在變，不像選單（${r.note}）` }
    mkdirSync(MENU_LEARN_DIR, { recursive: true })
    const refPng = join(MENU_LEARN_DIR, `${type}-${Date.now()}.png`)
    writeFileSync(refPng, m1.buf)
    emit(`📚 ${tag}（${type}）：點 ${openCell} 打開選單，${r.note}｜參考圖 ${refPng}`)
    const open = async () => { const g = await grab(); return g ? regionDiff(g.buf, m1.png, r.region) < REF_MATCH : null }
    // 在選單區域裡找關選單（選面額）的格子：避開打開那格
    const [x0, y0, x1, y1] = r.region
    const pts = [0.2, 0.4, 0.6, 0.8].flatMap(t => [0.2, 0.35, 0.5, 0.65, 0.8].map(u => ({ label: '', fx: x0 + (x1 - x0) * u, fy: y0 + (y1 - y0) * t })))
    const { hits: hh } = await touchCellsAt(page, m1.box, pts)
    const cells = [...new Set(hh.map(h => h.cell).filter((c): c is string => !!c && c !== openCell))].slice(0, 12)
    let n = 0
    for (const c of cells) {
      if (stop()) break
      const t = await findTouchTarget(page, c)
      if (!t) continue
      await gameTap(page, t, '觸屏'); n++
      let closed = false
      for (let k = 0; k < 2 && !closed; k++) { await sleep(2000); closed = (await open()) === false }
      if (closed) {
        emit(`📚 ${tag}（${type}）：點 ${c} 選單就關了（試到第 ${n} 格）`)
        return { ok: true, closed: true, learn: { region: r.region, refPng, taps: [c], openTap: openCell, note: `點 ${openCell} 打開；${r.note}；點 ${c} 關（試 ${n} 格）` } }
      }
    }
    emit(`${tag}：選單區試了 ${n} 格都沒關 → 再點 ${openCell}、再走前端選面額，讓機台回到可 Spin`)
    await gameTap(page, ot, '觸屏'); await sleep(3000)
    if ((await open()) !== false) { await dismissDenomOverlay(page, emit, tag); await sleep(8000) }
    const closed = (await open()) === false
    return { ok: true, closed, learn: { region: r.region, refPng, taps: [], openTap: openCell, note: `點 ${openCell} 打開；${r.note}；選單區 ${n} 格都關不掉${closed ? '（後來關了）' : '（還開著）'}` } }
  }

  // 1003 量座標序列（只在 MT_GATE_PROBE=1）：menu-gate.json 的 probeSeq＝[{cell,label,waitMs}]，關前端浮層後依序點觸屏格，
  // 每點一下就拍 main 推流框存證（menu-learn/<機種>-seq-<n>-<label>-<時間>.png），給人看圖找下一顆按鈕（例 COINCOMBO 換面額的 YES/NO）
  const probeSeq = (gateCfg as { probeSeq?: Array<{ cell: string; label?: string; waitMs?: number }> } | null)?.probeSeq
  if (process.env.MT_GATE_PROBE === '1' && Array.isArray(probeSeq) && probeSeq.length) {
    if (await dismissDenomOverlay(page, emit, '量座標序列')) await sleep(5000)
    mkdirSync(MENU_LEARN_DIR, { recursive: true })
    const shot = async (tag: string) => { const g = await grab(); if (!g) { emit(`（量座標序列）${tag}：推流沒在播，沒拍到`); return } const p = join(MENU_LEARN_DIR, `${type}-seq-${tag}-${Date.now()}.png`); writeFileSync(p, g.buf); emit(`（量座標序列）${tag}：截圖 ${p}`) }
    await shot('0-before')
    for (const [i, s] of probeSeq.entries()) {
      if (stop()) break
      const t = await findTouchTarget(page, s.cell)
      if (!t) { emit(`（量座標序列）找不到觸屏格子 ${s.cell}`); continue }
      emit(`（量座標序列）第 ${i + 1} 下：點 ${s.cell}（${s.label ?? ''}）`)
      await gameTap(page, t, '觸屏')
      await sleep(s.waitMs ?? 3000)
      await shot(`${i + 1}-${(s.label ?? s.cell).replace(/[^\w.-]/g, '_')}`)
    }
    return { state: 'unknown', note: '量座標序列跑完（只拍證據，不判選單狀態）', taps: probeSeq.length }
  }

  // 使用者 1003：openAt 只是「記座標」，不當流程執行——進場沒停在面額畫面就直接 Spin。所以只在量座標模式（MT_GATE_PROBE=1）才會主動點開學
  if ((!cfg?.refRegion || !existsSync(refPath)) && gateCfg?.openAt && process.env.MT_GATE_PROBE === '1') {
    const d = await discoverByOpen(gateCfg.openAt)
    if (!d.ok) return { state: d.closed === false ? 'touchNoResponse' as const : 'unknown' as const, note: `選單狀態未知：點開型選單沒學到（${d.why}）`, taps: 0 }
    if (d.closed === false) return { state: 'touchNoResponse', note: `點開型選單學到了，但關不掉（${d.learn?.note}）`, taps: 0, learn: d.learn }
    return { state: 'closed', note: `點開型選單：${d.learn?.note}`, taps: 0, learn: d.learn }
  }

  if (!cfg?.refRegion || !existsSync(refPath)) {
    const d = await discover('自動學選單')
    if (!d.ok) return { state: 'unknown' as const, note: `選單狀態未知：這個機種沒有選單參考圖，看不出機台是不是停在選單（自動學選單：${d.why}）`, taps: 0 }
    emit(`📚 自動學到選單（${type}）：${d.note}｜參考圖 ${d.refPng}`)
    return { state: 'closed', note: `選單開著 → 前端選面額後關了（自動學到選單：${d.note}）`, taps: 0, learn: { region: d.region, refPng: d.refPng, note: d.note ?? '' } }
  }

  const ref = PNG.sync.read(readFileSync(refPath))
  const refs: Array<{ png: InstanceType<typeof PNG>; region: [number, number, number, number] }> = [{ png: ref, region: cfg.refRegion! }]
  for (const x of (gateCfg?.refs ?? [])) { try { refs.push({ png: PNG.sync.read(readFileSync(join(MENU_REFS_DIR, x.file))), region: x.region }) } catch { /* 檔案不在就略過 */ } }
  const matchAny = (buf: Buffer) => refs.some(r => regionDiff(buf, r.png, r.region) < REF_MATCH)
  const isOpen = async () => { const g = await grab(); return g ? matchAny(g.buf) : null }
  // 關選單的觸屏點：menu-gate.json 明確給的才點；沒給＝不知道點哪裡 → 選單關不掉時判「選單狀態未知」，不怪觸屏
  let points = gateCfg ? (gateCfg.taps ?? []) : [...new Set([(cfg as TouchVisualCfg).point, ...(profile?.touchPoints ?? [])])]
  // 1003 量座標模式（測試用，agent 帶 MT_GATE_PROBE=1 啟動）：用 menu-gate.json 的 probePoints（選單按鈕在推流框的比例位置）
  // 找出對應的觸屏格，**跳過前端選面額、只點觸屏格**，看機台選單會不會關——關了就是座標對
  const probe = process.env.MT_GATE_PROBE === '1' && Array.isArray((gateCfg as { probePoints?: unknown } | null)?.probePoints)
  if (probe) {
    const box = await mainVideoBox(page, machineCode)
    if (box) {
      const { hits, range } = await touchCellsAt(page, box, (gateCfg as unknown as { probePoints: Array<{ label: string; fx: number; fy: number }> }).probePoints)
      emit(`（量座標）觸屏格：${range}｜${hits.map(h => `${h.label}@(${h.x},${h.y})→${h.cell ?? '沒有格子'}`).join('、')}`)
      points = hits.map(h => h.cell).filter((c): c is string => !!c)
    } else emit('（量座標）找不到 main 推流框')
  }

  // ── 有參考圖，但這台一張都沒對上：可能是新外觀（1003，多參考圖）────────────────────
  // 只在前端有選面額浮層時試（浮層在＝機台很可能停在選單）；學到就當新的一張參考圖交給 batch 加進機種設定
  if (gateCfg && !probe && refs.length < MENU_MAX_REFS) {
    const g = await grab()
    const hasFront = await (async () => { for (const f of page.frames()) { if ((await f.$$('.select-main .select-btn, .select-main .my-button').catch(() => [])).length) return true } return false })()
    if (g && !matchAny(g.buf) && hasFront) {
      const d = await discover('自動學選單（新外觀）')
      if (d.ok) {
        emit(`📚 自動學到選單的新外觀（${type}，第 ${refs.length + 1} 張）：${d.note}｜參考圖 ${d.refPng}`)
        return { state: 'closed', note: `選單開著（新外觀）→ 前端選面額後關了（自動學到第 ${refs.length + 1} 張參考圖）`, taps: 0, learn: { region: d.region, refPng: d.refPng, note: d.note ?? '', variant: true } }
      }
      if (d.frontSelected) return { state: 'closed', note: `參考圖都沒對上，前端已選面額（學新外觀沒成功：${d.why}）`, taps: 0 }
    }
  }

  // ── 有參考圖、沒有關選單的觸屏點：自動找（1003）────────────────────────────────
  // 機台停在選單時，先不選前端面額，改點選單區域（比對區往下多 15%，按鈕常在字帶下面）裡的觸屏格，選單一關就記下那格。
  // 點的都是選單區域：最多就是選了某個面額，不會下注。都沒關 → 照舊走前端選面額，**不怪觸屏**（可能只是沒點到按鈕）。
  if (gateCfg && !points.length && !probe) {
    const g = await grab()
    const open0 = g ? matchAny(g.buf) : null
    if (open0 && g) {
      const [, y0, , y1] = cfg.refRegion!
      const yBot = Math.min(0.98, y1 + 0.15)
      const pts = [0.2, 0.4, 0.6, 0.8].flatMap(t => [0.2, 0.35, 0.5, 0.65, 0.8].map(fx => ({ label: '', fx, fy: y0 + (yBot - y0) * t })))
      const { hits } = await touchCellsAt(page, g.box, pts)
      const cells = [...new Set(hits.map(h => h.cell).filter((c): c is string => !!c))].slice(0, 12)
      emit(`📚 自動找關選單的觸屏格（${type}）：候選 ${cells.length} 格`)
      let n = 0
      for (const c of cells) {
        if (stop()) break
        const t = await findTouchTarget(page, c)
        if (!t) continue
        await gameTap(page, t, '觸屏'); n++
        let closed = false
        for (let k = 0; k < 2 && !closed; k++) { await sleep(2000); closed = (await isOpen()) === false }
        if (closed) {
          emit(`📚 自動學到關選單的觸屏格（${type}）：${c}（試到第 ${n} 格）`)
          return { state: 'closed', note: `選單開著 → 自動找觸屏格：點 ${c} 選單就關了`, taps: n, learn: { taps: [c], note: `點 ${c} 關選單（試 ${n} 格）` } }
        }
      }
      emit(`自動找觸屏格：試了 ${n} 格選單都沒關 → 改走前端選面額（不怪觸屏，可能只是沒點到按鈕）`)
    }
  }

  return runMenuGate({
    isOpen,
    selectFrontDenom: async () => { if (probe) { emit('（量座標）跳過前端選面額，只測觸屏格'); return } emit('Spin 前：機台停在選面額選單 → 前端選面額，等機台關選單'); await dismissDenomOverlay(page, emit, 'Spin 前選單閘門') },
    taps: points.map(p => ({ label: p, tap: async () => { const t = await findTouchTarget(page, p); if (t) { emit(`Spin 前：選單沒關，點觸屏 ${p}`); await gameTap(page, t, '觸屏') } else emit(`Spin 前：找不到觸屏格子 ${p}`) } })),
    wait: async ms => { await sleep(ms) },
    stop,
    loadingMs: 10_000,
    afterTapMs: 8_000,
  })
}

async function stepTouchVisual(page: Page, emit: (msg: string) => void, machineCode: string, cfg: TouchVisualCfg, shouldStop?: () => boolean, sessionPrefix = ''): Promise<StepResult> {
  const t0 = Date.now()
  const stop = shouldStop ?? (() => false)
  const shots: Record<string, string> = {}
  const save = (tag: string, buf: Buffer | null) => {
    if (!buf) return
    try { mkdirSync(TOUCH_SAVE_DIR, { recursive: true }); const p = join(TOUCH_SAVE_DIR, `${sessionPrefix}${machineCode}-touch-${tag}.png`); writeFileSync(p, buf); shots[tag] = p } catch { /* 證據存不了不影響判定 */ }
  }
  const learnOf = (extra: Record<string, unknown>) => ({ extraData: {
    learn: JSON.stringify({ v: LEARN_VER, autoPicked: false, candidates: null, clicked: [cfg.point], boxAccepted: null, reacted: null, visual: extra }),
    touchShots: JSON.stringify(shots),
  } })
  const done = (status: StepStatus, message: string, extra: Record<string, unknown> = {}) => {
    emit(`觸屏（畫面判定）${cfg.point}：${status.toUpperCase()} ${message}`)
    return { step: '觸屏測試', status, message: `【畫面判定】${cfg.point}→${cfg.expect}：${message}`, durationMs: Date.now() - t0, ...learnOf(extra) }
  }
  emit(`觸屏（畫面判定）：點 ${cfg.point} 應出現「${cfg.expect}」，關閉方式：${cfg.close === 'same' ? '再點一次' : cfg.close === 'none' ? '不關閉（留給退出帶走）' : cfg.close}`)

  const box = await mainVideoBox(page, machineCode)
  if (!box) return done('skip', `未驗：找不到 main 推流畫面（沒點）`)
  const clip = { x: Math.max(0, box.x), y: Math.max(0, box.y), width: box.width, height: box.height }

  // 找格子：「列,行」span 往外找第一個有尺寸的容器（DRAGONLAW 的 span 是 0x0，同 stepTouchscreen）；先找好，找不到就不必拍雜訊
  let target: ElementHandle | null = null
  for (const frame of page.frames()) {
    try {
      const els = await frame.$$(`//span[normalize-space(text())='${cfg.point}']`)
      if (!els.length) continue
      const h = await els[0].evaluateHandle((e: Element) => {
        let p: Element | null = e
        for (let k = 0; p && k < 5; p = p.parentElement, k++) { const r = p.getBoundingClientRect(); if (r.width >= 2 && r.height >= 2) return p }
        return e
      })
      target = h.asElement()
      if (target) break
    } catch { /* frame detached */ }
  }
  if (!target) return done('skip', `未驗：畫面上找不到觸屏格子 ${cfg.point}（沒點）`)

  // 流程（雜訊→閘門→點→開→點→關、逐次凍結、穩定窗）在 verdicts.ts runTouchVisualFlow，有點擊計數探針；這裡只提供截圖／點擊
  await closeJackpotNotification(page, emit)
  let base = await page.screenshot({ type: 'png', clip })
  save('0-base', base)
  let last: Buffer | null = null
  // 預期畫面參考圖（有才比）：點之前已經是預期畫面 → 不點；點之後確認打開的是不是它
  const refPath = join(TOUCH_REFS_DIR, `${machineCode.split('-').slice(1, -1).join('-').toUpperCase()}.png`)
  const ref = cfg.refRegion && existsSync(refPath) ? PNG.sync.read(readFileSync(refPath)) : null
  const r = await runTouchVisualFlow({
    sample: async () => {
      await closeJackpotNotification(page, emit)
      last = await page.screenshot({ type: 'png', clip })
      const v = await mainVideoBox(page, machineCode)
      return { ratio: diffRatio(base, last), time: v?.time ?? 0, playing: v?.playing ?? false, refDiff: ref ? regionDiff(last, ref, cfg.refRegion!) : undefined }
    },
    // 用真的滑鼠點——0924 實測滑鼠點可以走到 game=onTouchScreen；每次只點一次（再點會把畫面關掉）
    // 1007：走 uiAct；被提示框／禁點擋下就丟錯（不算點到，也不換別種點法）
    click: async () => { if ((await uiAct(page, 'game', '觸屏（畫面比對）', target!, () => target!.click({ force: true, timeout: 5000 }))) === 'blocked') throw new Error('被提示框／禁點擋下，沒有點') },
    wait: async ms => { await sleep(ms) },
    stop,
    save: tag => save(tag, last),
    rebase: async () => { base = await page.screenshot({ type: 'png', clip }); save('0-base', base) },
    expect: cfg.expect,
    noClose: cfg.close === 'none',
    closeIfOpen: !!cfg.closeIfOpen,
  }).catch(e => ({ status: 'fail' as const, message: `點擊／截圖例外：${String(e).slice(0, 120)}｜判定：flow fail`, clicks: -1, noise: 0, opened: [] as number[], closed: null }))
  return done(r.status, r.message, { noise: r.noise, opened: r.opened, closed: r.closed, clicks: r.clicks })
}

async function stepTouchscreen(
  page: Page,
  emit: (msg: string) => void,
  machineCode: string,
  profile: MachineProfile | undefined,
  shouldStop?: () => boolean,
  debugGmid?: string,
  sessionPrefix = '',
): Promise<StepResult> {
  // 機種有設定畫面判定（touch-visual.json）就改走畫面判定，不靠盒子 log（2026-09-29，使用者提供 BZZF 18,9→賠率表→再點一次）
  const visualCfg = touchVisualConfig(machineCode)
  if (visualCfg) return stepTouchVisual(page, emit, machineCode, visualCfg, shouldStop, sessionPrefix)
  const t0 = Date.now()
  try {
    let touchPoints = profile?.touchPoints?.filter(p => p.trim())
    let autoPicked = false
    let scanNote = ''
    let candidateCount: number | null = null  // 自動挑點時的可選格數（learn 紀錄用）
    if (!touchPoints || touchPoints.length === 0) {
      // ── 自動挑觸屏點位（2026-09-22 加）──────────────────────────────────────
      // 原本沒設定就 SKIP，而 SKIP 看起來像「測過了」，實際上觸屏完全沒測。
      // 觸屏格子是 `.screen-touch` 覆蓋層裡的透明 span，文字就是「列,行」（例 "5,4"、"11,7"）,
      // 所以可以直接掃出來隨機挑幾個。
      // ⚠️ 刻意**避開畫面上下緣**：下緣是機台自己的按鈕列（Cash Out 之類），
      //    隨機點到那裡會變成「測試把機台操作掉了」。只取中間帶。
      // ⚠️ 2026-09-22 第一版寫錯：只用 page.evaluate 掃**頂層 document**，
      //    但遊戲跑在 iframe 裡 → 永遠找不到，四台全部誤判成「沒有觸屏格子」。
      //    證據：同一輪的**進場步驟**用 frames 迴圈找 `11,7` 是找得到的。
      //    → 一定要逐個 frame 掃。
      // ⚠️ 2026-09-24：原本直接丟掉寬高 < 2px 的 span，但透明覆蓋層的 span 可能量不到尺寸
      //    （進場步驟點 `11,7` 不檢查尺寸所以點得到）→ DRAGONLAW 0077/0078 全被濾掉。
      //    改成往外層找第一個有尺寸的容器拿 y；真的都量不到才丟，並把各階段數量寫進診斷。
      const diag: string[] = []
      const scan = async () => {
        for (const [i, frame] of page.frames().entries()) {
          try {
            const res = await frame.evaluate(() => {
              const list: { label: string; y: number }[] = []
              let raw = 0, viaParent = 0, noRect = 0
              for (const sp of Array.from(document.querySelectorAll('span'))) {
                const t = (sp.textContent || '').trim()
                if (!/^\d+,\d+$/.test(t)) continue
                raw++
                let el: Element | null = sp, r = sp.getBoundingClientRect(), hops = 0
                while ((r.width < 2 || r.height < 2) && el?.parentElement && hops < 4) {
                  el = el.parentElement; r = el.getBoundingClientRect(); hops++
                }
                if (r.width < 2 || r.height < 2) { noRect++; continue }
                if (hops > 0) viaParent++
                list.push({ label: t, y: r.top + r.height / 2 })
              }
              if (list.length === 0) return { labels: [] as string[], raw, viaParent, noRect, distinctY: 0 }
              const ys = list.map(o => o.y)
              const lo = Math.min(...ys), hi = Math.max(...ys)
              const spanH = Math.max(1, hi - lo)
              // 只留中間 65%（丟掉最上 10%、最下 25%）——避開機台自己的按鈕列
              const labels = list.filter(o => (o.y - lo) / spanH > 0.10 && (o.y - lo) / spanH < 0.75).map(o => o.label)
              return { labels, raw, viaParent, noRect, distinctY: new Set(ys.map(Math.round)).size }
            })
            if (res.raw > 0) diag.push(`frame${i}: 文字符合 ${res.raw}、用外層定位 ${res.viaParent}、量不到尺寸 ${res.noRect}、不同高度 ${res.distinctY}、中間帶 ${res.labels.length}`)
            if (res.labels.length > 0) return res.labels
          } catch { /* frame detached */ }
        }
        return [] as string[]
      }
      const found = await scan()
      const uniq = [...new Set(found)]
      if (diag.length) emit(`觸屏格子掃描：${diag.join('；')}`)
      scanNote = diag.join('；')
      if (uniq.length === 0) {
        const why = diag.length ? `（${diag.join('；')}）` : `（${page.frames().length} 個 frame 都沒有文字符合「列,行」的 span）`
        return { step: '觸屏測試', status: 'fail', message: `未設定 touchPoints，且自動偵測找不到觸屏格子${why}`, durationMs: Date.now() - t0 }
      }
      candidateCount = uniq.length
      const pick = Math.min(3, uniq.length)
      const shuffled = uniq.sort(() => Math.random() - 0.5).slice(0, pick)
      touchPoints = shuffled
      autoPicked = true
      emit(`未設定 touchPoints → 自動挑 ${pick} 個觸屏格子（可選 ${uniq.length} 個，已避開上下緣）：${shuffled.join('、')}`)
    }

    // Build element list: find span by text content for each touchPoint label.
    // Note: .screen-touch overlay spans are transparent so isVisible() returns false —
    // just take els[0] and click via evaluate (same as waitForNormalStatus).
    type TpEntry = { label: string; el: ElementHandle }
    const buttons: TpEntry[] = []
    // 2026-09-24 診斷：DRAGONLAW 0069 點了三格機台 log 完全沒事件（進場點 11,7 卻有效），
    // 記下每格「幾個 frame 有、各幾份、點的那份在哪一層、樣式」，寫進結果訊息方便事後判讀。
    const clickDiag: string[] = []
    for (const pt of touchPoints) {
      let found = false
      const perFrame: string[] = []
      for (const [fi, frame] of page.frames().entries()) {
        try {
          const els = await frame.$$(`//span[normalize-space(text())='${pt}']`)
          if (els.length > 0) {
            perFrame.push(`f${fi}×${els.length}`)
            if (!found) {
              buttons.push({ label: pt, el: els[0] })
              found = true
              const info = await els[0].evaluate((e: Element) => {
                const cs = getComputedStyle(e), r = e.getBoundingClientRect()
                const chain: string[] = []
                for (let p: Element | null = e.parentElement, k = 0; p && k < 3; p = p.parentElement, k++) chain.push((p.className && typeof p.className === 'string' ? '.' + p.className.trim().split(/\s+/).join('.') : p.tagName.toLowerCase()).slice(0, 40))
                const pp = e.parentElement ? getComputedStyle(e.parentElement) : null
                return `${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.left)},${Math.round(r.top)} disp=${cs.display} pe=${cs.pointerEvents} vis=${cs.visibility} parentDisp=${pp?.display} parentPe=${pp?.pointerEvents} ${chain.join('<')}`
              }).catch(() => '?')
              clickDiag.push(`${pt}[${info}]`)
            }
          }
        } catch { /* frame detached */ }
      }
      if (found) clickDiag[clickDiag.length - 1] += ` 分布:${perFrame.join(',')}`
      else emit(`touchPoint "${pt}" ⚠️ 找不到元素，跳過`)
    }
    if (clickDiag.length) emit(`觸屏點擊目標：${clickDiag.join('；')}`)

    if (buttons.length === 0) {
      return { step: '觸屏測試', status: 'fail', message: '所有 touchPoints 均找不到元素（確認 profile 座標格式正確）', durationMs: Date.now() - t0 }
    }

    // Step 1: baseline before clicking
    const today = toLocalDateStr(new Date())
    // debugGmid replaces only the channel prefix (first segment)
    const effectiveGmid = debugGmid
      ? machineCode.replace(/^[^-]+/, debugGmid)
      : machineCode
    if (debugGmid) emit(`[調適模式] 觸屏日誌渠道號替換為 ${debugGmid}，gmid：${effectiveGmid}`)
    const apiUrl = `${DAILY_ANALYSIS_BASE}?gmid=${encodeURIComponent(effectiveGmid)}&date=${encodeURIComponent(today)}`

    const getTouchTimes = async (): Promise<Set<string>> => {
      try {
        const res = await fetch(apiUrl)
        if (!res.ok) return new Set()
        const json = await res.json() as { data?: { timeline?: LogEntry[] } }
        const tl = json.data?.timeline ?? []
        return new Set(
          tl.filter(e => {
            if (e.type !== 'success_json') return false
            const d = typeof e.data === 'string' ? JSON.parse(e.data) as Record<string, unknown> : e.data
            return d?.is_touch === true || d?.is_touch === 1
          }).map(e => `${e.time}|${JSON.stringify(e.data)}`)
        )
      } catch { return new Set() }
    }

    const baselineKeys = await getTouchTimes()
    emit(`基準線：點擊前已有 ${baselineKeys.size} 筆觸屏記錄`)

    // Step 2: click all touchPoints
    // 2026-09-24：先確認「前端有沒有真的送出」再看盒子。真人觸屏時前端 console 會印
    //   `touchAction 1514` → `dealGMActionReq->actionId: 1514` → SEND hall.hallHandler.dealGMActionReq
    // 所以每格點完看 console 有沒有這組訊息：沒有＝工具沒點到（前端沒送）；有但盒子 log 沒有＝後段問題。
    const sentIds: string[] = []
    // H5 真人點擊的 console 鏈（使用者 0924 提供）：
    //   ScreenJJBX touch (x,y)= 12 2 → ScreenJJBX touchId: 2212 → artcvideo:clickscreen= 2212 → game=onTouchScreen 2212
    //   → touchAction 2212 → dealGMActionReq->actionId: 2212 → SEND hall.hallHandler.dealGMActionReq
    // 每一段都記下來，才知道點擊卡在哪一段。
    const stages: string[] = []
    const onTouchConsole = (m: import('playwright').ConsoleMessage) => {
      const t = m.text()
      const x = t.match(/dealGMActionReq->actionId:\s*(\d+)/) ?? t.match(/^touchAction\s+(\d+)/)
      if (x) sentIds.push(x[1])
      const st = t.match(/ScreenJJBX touch \(x,y\)=\s*(\d+)\s+(\d+)/) ? '①touch'
        : /ScreenJJBX touchId:/.test(t) ? '②touchId'
        : /artcvideo:clickscreen=/.test(t) ? '③clickscreen'
        : /game=onTouchScreen/.test(t) ? '④onTouchScreen'
        : /^touchAction\s+\d+/.test(t) ? '⑤touchAction'
        : /dealGMActionReq->actionId/.test(t) ? '⑥dealGMActionReq' : ''
      if (st) stages.push(`${st}(${t.replace(/\s+/g, ' ').slice(0, 40)})`)
    }
    page.on('console', onTouchConsole)
    const sentPer: string[] = []
    let sentCount = 0
    let handledCount = 0
    const waitSent = async (before: number, ms: number) => {
      const end = Date.now() + ms
      while (Date.now() < end) { if (sentIds.length > before) return true; await sleep(200) }
      return sentIds.length > before
    }
    // 2026-09-24 診斷：直接問 Chrome 哪些元素掛了哪些事件（DOMDebugger.getEventListeners），
    // 以及第一格中心點最上層是誰（elementFromPoint），找出真正收觸屏的元素。
    let listenerDiag = ''
    try {
      const cdp = await page.context().newCDPSession(page)
      try {
        const parts: string[] = []
        const firstBox = buttons[0] ? await buttons[0].el.evaluate((e: Element) => {
          let p: Element | null = e
          for (let k = 0; p && k < 5; p = p.parentElement, k++) { const r = p.getBoundingClientRect(); if (r.width >= 2 && r.height >= 2) return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }
          return null
        }).catch(() => null) : null
        const exprs: Array<[string, string]> = [
          ['div_main', `document.getElementById('div_main')`],
          ['screen_touch', `document.getElementById('screen_touch')`],
          ['screen-touch1', `document.querySelector('.screen-touch1')`],
          ['child', `document.querySelector('.screen-touch1 .child')`],
          ['document', `document`],
          ['window', `window`],
        ]
        if (firstBox) exprs.push(['點擊點最上層', `document.elementFromPoint(${firstBox.x}, ${firstBox.y})`])
        for (const [name, expr] of exprs) {
          const r = await cdp.send('Runtime.evaluate', { expression: expr }) as { result: { objectId?: string; description?: string } }
          if (!r.result.objectId) { parts.push(`${name}:無`); continue }
          const ls = await cdp.send('DOMDebugger.getEventListeners', { objectId: r.result.objectId }) as { listeners: Array<{ type: string }> }
          const types = [...new Set(ls.listeners.map(l => l.type))].filter(t => /touch|pointer|mouse|click/.test(t))
          parts.push(`${name}${name === '點擊點最上層' ? `=${(r.result.description ?? '').slice(0, 50)}` : ''}:[${types.join(',')}]`)
        }
        // 被點那格的祖先鏈（對照真人畫面 #div_main > #screen_touch > .screen-touch1）＋ click handler 原始碼片段
        try {
          const h = await buttons[0].el.evaluateHandle((e: Element) => {
            let p: Element | null = e
            for (let k = 0; p && k < 5; p = p.parentElement, k++) { const r = p.getBoundingClientRect(); if (r.width >= 2 && r.height >= 2) return p }
            return e
          })
          const chain = await h.evaluate((e: Element) => {
            const out: string[] = []
            for (let p: Element | null = e, k = 0; p && k < 9; p = p.parentElement, k++) {
              const cs = getComputedStyle(p)
              out.push(`${p.tagName.toLowerCase()}${p.id ? '#' + p.id : ''}${typeof p.className === 'string' && p.className ? '.' + p.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}${cs.display === 'none' ? '(hidden)' : ''}`)
            }
            return out.join(' < ')
          })
          parts.push(`祖先:${chain}`)
          parts.push(`div_main數=${await page.evaluate(() => document.querySelectorAll('#div_main').length)} screen-touch1數=${await page.evaluate(() => document.querySelectorAll('.screen-touch1').length)}`)
          // 取 handler 位置 → 原始碼（先打標記再用 selector 拿 CDP objectId）
          await h.evaluate((e: Element) => e.setAttribute('data-qa-tp', '1'))
          const { result } = await cdp.send('Runtime.evaluate', { expression: `document.querySelector('[data-qa-tp]')` }) as { result: { objectId?: string } }
          await h.evaluate((e: Element) => e.removeAttribute('data-qa-tp'))
          if (result.objectId) {
            await cdp.send('Debugger.enable')
            const ls = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId }) as { listeners: Array<{ type: string; scriptId: string; lineNumber: number; columnNumber: number }> }
            const c = ls.listeners.find(l => l.type === 'click')
            if (c) {
              const src = (await cdp.send('Debugger.getScriptSource', { scriptId: c.scriptId }) as { scriptSource: string }).scriptSource
              const lines = src.split('\n'); const line = lines[c.lineNumber] ?? ''
              parts.push(`clickHandler@L${c.lineNumber}:${c.columnNumber}: ${line.slice(Math.max(0, c.columnNumber - 100), c.columnNumber + 500).replace(/\s+/g, ' ')}`)
            }
            await cdp.send('Debugger.disable').catch(() => {})
          }
        } catch (e) { parts.push(`祖先/handler診斷失敗 ${String(e).slice(0, 80)}`) }
        listenerDiag = parts.join(' ')
        emit(`觸屏事件監聽：${listenerDiag}`)
      } finally { await cdp.detach().catch(() => {}) }
    } catch (e) { listenerDiag = `監聽診斷失敗 ${String(e).slice(0, 60)}` }

    emit(`共 ${buttons.length} 個觸屏點位，逐一點擊...`)
    for (const { label, el } of buttons) {
      if (shouldStop?.()) { page.off('console', onTouchConsole); return { step: '觸屏測試', status: 'skip', message: '已停止', durationMs: Date.now() - t0 } }
      const before = sentIds.length
      const stBefore = stages.length
      try {
        // 2026-09-24：DRAGONLAW 的「列,行」span 是 display:none（0x0），真正的格子是外層 `.child`。
        // 對隱藏 span 做 JS click 機台 log 完全沒事件 → 改成找第一個有尺寸的外層，用真的滑鼠點它中心。
        // span 本身有尺寸（其他機種）就直接點 span；真的點不到才退回舊的 JS click。
        const target = await el.evaluateHandle((e: Element) => {
          let p: Element | null = e
          for (let k = 0; p && k < 5; p = p.parentElement, k++) {
            const r = p.getBoundingClientRect()
            if (r.width >= 2 && r.height >= 2) return p
          }
          return e
        })
        const tEl = target.asElement()
        // 依序試幾種點法，前端一送出 dealGMActionReq 就停。
        // 2026-09-24 實測 DRAGONLAW：滑鼠點與 JS click 前端都沒送 → 格子是 Vant 元件，多半只聽 touch 事件。
        const tried: string[] = []
        const box = tEl ? await tEl.boundingBox().catch(() => null) : null
        const methods: Array<[string, () => Promise<unknown>]> = [
          ['滑鼠', async () => { if (!tEl) throw new Error('no el'); await tEl.click({ force: true, timeout: 5000 }) }],
          ['CDP觸控', async () => {
            if (!box) throw new Error('no box')
            const x = box.x + box.width / 2, y = box.y + box.height / 2
            const cdp = await page.context().newCDPSession(page)
            try {
              await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
              await sleep(80)
              await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
            } finally { await cdp.detach().catch(() => {}) }
          }],
          ['JS觸控事件', async () => {
            await (tEl ?? el).evaluate((e: Element) => {
              const r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2
              const t = new Touch({ identifier: Date.now(), target: e, clientX: x, clientY: y })
              e.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [t], targetTouches: [t], changedTouches: [t] }))
              e.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [t] }))
            })
          }],
          ['JS click', async () => { await page.evaluate((e: Element) => (e as HTMLElement).click(), el) }],
        ]
        let ok = false, handled = false
        let blocked = false
        for (const [name, fn] of methods) {
          // 1007：每一種點法（含 CDP 觸控、JS 觸控事件）都走 uiAct；被擋就整串停下，不換下一種
          try { if ((await uiAct(page, 'game', `觸屏（${name}）`, tEl, fn)) === 'blocked') { tried.push(`${name}⛔`); blocked = true; break } } catch { tried.push(`${name}✗`); continue }
          tried.push(name)
          if (await waitSent(before, 1500)) { ok = true; break }
          // H5 走到 game=onTouchScreen 就代表遊戲已經收下這次點擊（H5 不一定走 dealGMActionReq）→ 不要再換點法重點
          if (stages.slice(stBefore).some(s => s.startsWith('④'))) { handled = true; break }
        }
        const how = tried.join('→')
        // 被提示框／禁點擋下：這一格不算點過，後面的格子也不點，交給步驟關卡處理（CodeX 1007）
        if (blocked) {
          sentPer.push(`${label}:被擋（${popupGuardOf(page)?.blockReason() ?? '禁點'}）`)
          emit(`"${label}" ⛔ 被擋下，沒有點（${popupGuardOf(page)?.blockReason() ?? '禁點'}）`)
          break
        }
        if (ok) sentCount++
        if (ok || handled) handledCount++
        const reached = stages.slice(stBefore)
        sentPer.push(`${label}@${new Date().toTimeString().slice(0, 8)}:${ok ?`送出 actionid=${sentIds.slice(before).join('/')}` : '前端沒送'}(${how})${reached.length ? ` 到達:${reached.join('→')}` : ' console鏈:無'}`)
        emit(`"${label}" 已點擊（${how}）→ ${ok ? `前端已送出 dealGMActionReq actionid=${sentIds.slice(before).join('/')}` : '⚠️ 前端沒有送出 dealGMActionReq'}`)
      } catch {
        emit(`"${label}" ✗ 點擊例外`)
        sentPer.push(`${label}:點擊例外`)
      }
      await sleepOrStop(5000, shouldStop ?? (() => false))
    }
    page.off('console', onTouchConsole)

    if (shouldStop?.()) return { step: '觸屏測試', status: 'skip', message: '已停止', durationMs: Date.now() - t0 }

    // Step 3: wait for API sync
    emit(`全部點擊完畢，等待 API 同步（15s）...`)
    await sleepOrStop(15000, shouldStop ?? (() => false))

    let touchEntries: LogEntry[] = []
    let tlAll: LogEntry[] = []
    // 同 iDeck：API 查不到機台時沒有盒子端證據，只能判未驗
    let apiErr: string | null = null
    try {
      const res = await fetch(apiUrl)
      if (res.ok) {
        const json = await res.json() as { success?: boolean; message?: string; data?: { timeline?: LogEntry[] } }
        if (json.success === false) apiErr = json.message ?? 'success:false'
        const tl = json.data?.timeline ?? []
        tlAll = tl
        touchEntries = tl.filter(e => {
          if (e.type !== 'success_json') return false
          const d = typeof e.data === 'string' ? JSON.parse(e.data) as Record<string, unknown> : e.data
          if (d?.is_touch !== true && d?.is_touch !== 1) return false
          return !baselineKeys.has(`${e.time}|${JSON.stringify(e.data)}`)
        })
        emit(`API 回傳：新增 ${touchEntries.length} 筆觸屏 success_json（點擊前基準 ${baselineKeys.size} 筆）`)
        touchEntries.forEach(e => {
          const d = typeof e.data === 'string' ? JSON.parse(e.data) as Record<string, unknown> : e.data
          emit(`  ${e.time} cmd=${d.cmd} error=${d.error}`)
        })
      } else {
        apiErr = `HTTP ${res.status}`
        emit(`API 請求失敗 status=${res.status}`)
      }
    } catch (err) {
      apiErr = `例外 ${err}`
      emit(`API 請求例外: ${err}`)
    }

    // 盒子端一次觸屏是一組：NoticeClientNtc(action_type 2) → success_json{cmd:"列,行",is_touch} →
    // DoactionResultReq/Res(action_type 2) → usb_coordinate{coord}。座標在 success_json.cmd，
    // 所以要比對 cmd 是不是我們點的那格，不能只數筆數（退出後盒子會自己送 18,9、進場會有 Denom5）。
    const clickedLabels = new Set(buttons.map(b => b.label))
    const matched = touchEntries.filter(e => {
      const d = typeof e.data === 'string' ? JSON.parse(e.data) as Record<string, unknown> : e.data
      return clickedLabels.has(String(d?.cmd ?? ''))
    })
    const passed = matched.length
    const total = buttons.length
    // learn 模式：「盒子收到指令」不算數，要後面 10 秒內跟著 usb_coordinate（盒子真的動作了）才算這格學得到
    const secs = (t: string) => { const [h, m, s] = t.split(':').map(Number); return h * 3600 + m * 60 + s }
    // 對應要綁在「這一筆」之後：usb_coordinate 必須出現在它後面、下一筆觸屏 success_json 之前（CodeX 0929：
    // 不能只是 10 秒內剛好有別的事件）。timeline 是依時間排序的原始順序。
    const isTouchJson = (e: LogEntry) => { if (e.type !== 'success_json') return false; const d = typeof e.data === 'string' ? JSON.parse(e.data) as Record<string, unknown> : e.data; return d?.is_touch === true || d?.is_touch === 1 }
    // API 的排序方向沒保證，頭尾比一下，統一成由舊到新
    const ordered = tlAll.length > 1 && secs(tlAll[0].time) > secs(tlAll[tlAll.length - 1].time) ? [...tlAll].reverse() : tlAll
    const followedByUsb = (m: LogEntry) => {
      const i = ordered.indexOf(m)
      if (i < 0) return false
      for (let k = i + 1; k < ordered.length; k++) {
        const u = ordered[k]
        if (secs(u.time) - secs(m.time) > 10) return false
        if (isTouchJson(u)) return false
        if (u.type === 'usb_coordinate') return true
      }
      return false
    }
    const reacted = [...new Set(matched.filter(followedByUsb).map(m => {
      const d = typeof m.data === 'string' ? JSON.parse(m.data) as Record<string, unknown> : m.data
      return String(d?.cmd ?? '')
    }))]
    const learnT = { extraData: { learn: JSON.stringify({ v: LEARN_VER, autoPicked, candidates: candidateCount, clicked: buttons.map(b => b.label), boxAccepted: apiErr ? null : [...new Set(matched.map(m => { const d = typeof m.data === 'string' ? JSON.parse(m.data) as Record<string, unknown> : m.data; return String(d?.cmd ?? '') }))], reacted: apiErr ? null : reacted, frontendHandled: handledCount, wsSent: sentCount, apiErr }) } }
    const message = `${autoPicked ? '【自動挑點】' : ''}${total} 個觸屏點位，遊戲收下(onTouchScreen) ${handledCount}/${total}、送出 dealGMActionReq ${sentCount}/${total}、API 確認 ${passed}/${total} 有觸屏回應`
      + `（${touchPoints.join('、')}）`
      + (sentPer.length ? ` ｜WS: ${sentPer.join('；')}` : '')
      + (sentCount < total && listenerDiag ? ` ｜監聽: ${listenerDiag}` : '')
      + (passed < total ? ` ｜診斷 ${[scanNote, ...clickDiag].filter(Boolean).join('；')}` : '')

    if (apiErr) {
      emit(`⚠️ 機台 log API 查不到資料（${apiErr}）→ 觸屏未驗`)
      return { step: '觸屏測試', status: 'skip', message: `未驗：機台 log API 查不到 ${effectiveGmid}（${apiErr}）｜${message}`, durationMs: Date.now() - t0, ...learnT }
    }
    if (passed === 0) {
      return { step: '觸屏測試', status: 'fail', message, durationMs: Date.now() - t0, ...learnT }
    } else if (passed < total) {
      return { step: '觸屏測試', status: 'warn', message, durationMs: Date.now() - t0, ...learnT }
    }
    return { step: '觸屏測試', status: 'pass', message, durationMs: Date.now() - t0, ...learnT }
  } catch (e) {
    return { step: '觸屏測試', status: 'fail', message: `例外: ${e}`, durationMs: Date.now() - t0 }
  }
}

/**
 * CCTV 截圖前清遮罩（從 stepCctv 抽出來給探針測）。只點**遮罩裡**的關閉鍵或遮罩本體，全部走 uiAct；
 * 任何一下被擋 → 立刻停、回 blocked（呼叫端記 CCTV 未驗、留證），不送 Escape、不換別種方式
 */
export async function clearCctvOverlays(page: Page, emit: (msg: string) => void): Promise<{ blocked: string[] }> {
  // Dismiss any animation overlays / floating popups that may cover the CCTV view.
  // Uses narrow selectors to avoid accidentally clicking game UI (no generic popup/dialog).
  // Strategy: 1) try close/OK buttons inside overlay first, 2) fall back to body click, 3) retry up to 3 rounds.
  {
    // Only known full-screen overlay types — avoid broad class*="popup"/"dialog" which can match CCTV panel
    const OVERLAY_SELS = ['div.bg', '[class*="win-frame"]', '[class*="bonus-popup"]', '[class*="float-layer"]']
    const CLOSE_BTN_SELS = ['[class*="btn_close"]', '[class*="close-btn"]', '.btn_ok', 'button[class*="close"]', 'button[class*="ok"]', '.btn_take']

    type OverlayEntry = { frame: import('playwright').Frame; el: import('playwright').ElementHandle; sel: string }
    const findOverlays = async (): Promise<OverlayEntry[]> => {
      const found: OverlayEntry[] = []
      for (const frame of page.frames()) {
        try {
          for (const sel of OVERLAY_SELS) {
            const els = await frame.$$(sel)
            for (const el of els) {
              if (!await el.isVisible()) continue
              const box = await el.boundingBox()
              if (box && box.width > 80 && box.height > 80) found.push({ frame, el, sel })
            }
          }
        } catch { /* frame detached */ }
      }
      return found
    }

    // 1007（CodeX 19d3b6b）：任何一下被擋（遮罩沒辨識出來／禁點）→ 這個遮罩不再換別種方式（本體、Escape）硬關，
    // 整個 CCTV 記「未驗：被遮擋」並留證，不拿被擋住的畫面去比號碼
    for (let round = 0; round < 3; round++) {
      const overlays = await findOverlays()
      if (overlays.length === 0) break
      emit(`清除彈窗第 ${round + 1} 輪（${overlays.length} 個）...`)
      for (const { el, sel } of overlays) {
        let closed = false, blocked = false
        // Prefer clicking close/OK button to avoid misfire on overlay body
        // 只找**這個遮罩裡**的關閉鍵（CodeX：原本找不到會搜整個 frame，可能按到別處的關閉鍵）
        for (const closeSel of CLOSE_BTN_SELS) {
          try {
            const btn = await el.$(closeSel)
            if (btn && await btn.isVisible()) {
              if ((await uiAct(page, 'popup', `CCTV 前關彈窗 ${closeSel}`, btn, () => btn.click({ timeout: 500 }))) === 'blocked') { blocked = true; break }
              emit(`已點擊關閉按鈕（${closeSel}）`)
              closed = true
              break
            }
          } catch { /* ignore */ }
        }
        if (!closed && !blocked) {
          const r = await uiAct(page, 'popup', `CCTV 前點彈窗本體 ${sel}`, el, () => el.click({ force: true, timeout: 500 })).catch(() => 'none' as const)
          if (r === 'blocked') blocked = true
          else if (r === 'clicked') emit(`已 force-click 彈窗本體：${sel}`)
        }
        // CodeX 2993fdf：被擋就**整個停**——同一輪後面的遮罩也不處理（原本只停這一個，接著還點了 float-layer 的關閉鍵）
        if (blocked) { emit(`⛔ CCTV 前的遮罩 ${sel} 沒辨識出來／被擋下，不點、不改用其他方式關，停止清遮罩`); return { blocked: [sel] } }
      }
      await sleep(1000)
    }

    await page.keyboard.press('Escape').catch(() => {})
    const remaining = await findOverlays()
    if (remaining.length > 0) {
      emit(`⚠️ 仍有 ${remaining.length} 個 overlay 未清除，繼續截圖`)
    } else {
      emit(`彈窗清除完成，等待畫面穩定...`)
      await sleep(500)
    }
    return { blocked: [] }
  }
}

/** CCTV 證據截圖。asIs：照當下畫面截、什麼都不點（被遮罩擋下時用——CodeX 2993fdf：留證前不能再點，要保留被擋當下的畫面） */
export async function saveCctvEvidenceShot(page: Page, emit: (msg: string) => void, machineCode: string, sessionPrefix: string, asIs = false): Promise<string> {
  if (!machineCode) return ''
  try {
    mkdirSync(CCTV_SAVE_DIR, { recursive: true })
    const p = join(CCTV_SAVE_DIR, `${sessionPrefix}${machineCode}.png`)
    if (!asIs) await closeJackpotNotification(page, emit)
    writeFileSync(p, await page.screenshot({ type: 'png', fullPage: false }))
    emit(`CCTV 沒畫面，已存當下畫面當證據：${p}`)
    return '（已截圖留證）'
  } catch { return '' }
}

async function stepCctv(page: Page, emit: (msg: string) => void, machineCode = '', sessionPrefix = ''): Promise<StepResult> {
  // 失敗路徑的證據：整個畫面存成跟正常 CCTV 截圖同一個檔名（batch 的 evidence.cctv 會讀到並貼 H 欄）
  const saveCctvEvidence = (asIs = false) => saveCctvEvidenceShot(page, emit, machineCode, sessionPrefix, asIs)
  const t0 = Date.now()
  try {
    // 1003：切 CCTV 之前先留一張遊戲推流畫面——拿來跟 CCTV 拍到的機台螢幕比對（使用者懷疑 1560/1561 的 CCTV 拍的是同一台）。
    // Spin 過後滾輪結果是隨機的，推流跟 CCTV 顯示同一組滾輪＝CCTV 拍的就是這台。
    if (machineCode) {
      try {
        mkdirSync(CCTV_SAVE_DIR, { recursive: true })
        const pre = join(CCTV_SAVE_DIR, `${sessionPrefix}${machineCode}-before-cctv.png`)
        writeFileSync(pre, await page.screenshot({ type: 'png', fullPage: false }))
        emit(`切 CCTV 前的推流畫面：${pre}`)
      } catch { /* 證據截圖失敗不影響判定 */ }
    }
    // Step 1: click the first header_btn_item to switch to CCTV view
    emit(`尋找 CCTV 按鈕（.header_btn_item）...`)
    let clicked = false
    for (const frame of page.frames()) {
      try {
        const els = await frame.$$('.header_btn_item')
        for (const el of els) {
          if (await el.isVisible()) {
            if ((await uiAct(page, 'lobby', 'CCTV 按鈕', el, () => page.evaluate((e: Element) => (e as HTMLElement).click(), el))) === 'blocked') break
            clicked = true
            emit(`已點擊 CCTV 按鈕`)
            break
          }
        }
        if (clicked) break
      } catch { /* frame detached */ }
    }
    if (!clicked) {
      return { step: 'CCTV 號碼比對', status: 'fail', message: `找不到 .header_btn_item 按鈕${await saveCctvEvidence()}`, durationMs: Date.now() - t0 }
    }

    // Step 2: save a full-page debug screenshot immediately after click, to confirm what opened
    try {
      const debugPath = `C:\\Users\\user\\AppData\\Local\\Temp\\cctv_debug_${Date.now()}.png`
      const { writeFileSync } = await import('fs')
      writeFileSync(debugPath, await page.screenshot({ type: 'png', fullPage: false }))
      emit(`點擊後截圖（debug）：${debugPath}`)
    } catch { /* ignore */ }

    // Wait for cctv_video container + video element (5s for stream to stabilize)
    emit(`等待 CCTV 畫面載入...`)
    await sleep(5000)

    // 先關掉「Lucky hour bonus has been transferred to the machine」這個 Tips 框。
    // 2026-09-22 實測（892-DRAGONLAW-0070）：它整片蓋住 CCTV 畫面，導致 OCR 讀不到編號、
    // 還被判成「畫面模糊／偵測到異常文字」——看起來像攝影機有問題，其實只是前景有彈窗。
    // ⚠️ 故意**只認這一句**，不做通用的「點掉所有 Confirm」——
    //    Cash Out／退出確認框上的 Confirm 按下去會直接把機台退掉。
    // 1007（CodeX 56e3d1b）：改走 PopupGuard.scan——lhb-transfer 已在目錄裡（ack Confirm），Confirm 限定在命中的那個框裡；
    // 原本頁面內往上找所有 div 祖先，不能保證只點到這個框
    try {
      const ds = await (popupGuardOf(page) ?? new PopupGuard(page, emit, `cctv-${Date.now()}`)).scan({ act: true, why: 'CCTV 前' })
      if (ds.some(d => d.id === 'lhb-transfer')) { emit(`已處理「Lucky hour bonus 已轉入機台」提示框`); await sleep(1200) }
    } catch { /* 關不掉就照原本流程走 */ }

    {
      const { blocked: blockedOverlays } = await clearCctvOverlays(page, emit)
      if (blockedOverlays.length) {
        const ev = await saveCctvEvidence(true)
        return { step: 'CCTV 號碼比對', status: 'skip', message: `未驗：CCTV 畫面被未辨識的遮罩擋住（${blockedOverlays.join('、')}），沒有點${ev}`, durationMs: Date.now() - t0 }
      }
    }

    let videoEl: import('playwright').ElementHandle | null = null
    let videoPlaying = false
    for (const frame of page.frames()) {
      try {
        const vid = await frame.$('video[id*="CCTV"], video[id*="cctv"]')
        if (vid && await vid.isVisible()) {
          videoEl = vid
          videoPlaying = await frame.evaluate((el: Element) => {
            const v = el as HTMLVideoElement
            return !v.paused && v.readyState >= 2 && v.videoWidth > 0
          }, vid) as boolean
          break
        }
      } catch { /* frame detached */ }
    }

    if (!videoEl) {
      // fallback: check div.cctv_video appeared
      const hasCctvDiv = await page.$('div.cctv_video')
      // 沒有 CCTV 畫面也要留證據（使用者 0929）：存當下整個畫面到 cctv-saves，batch 照樣會貼進 Lark H 欄
      const ev = await saveCctvEvidence()
      if (!hasCctvDiv) {
        return { step: 'CCTV 號碼比對', status: 'fail', message: `切換後找不到 CCTV 影片元素${ev}`, durationMs: Date.now() - t0 }
      }
      return { step: 'CCTV 號碼比對', status: 'warn', message: `CCTV 容器存在但找不到 video 元素${ev}`, durationMs: Date.now() - t0 }
    }

    // ── 等 CCTV 真的開始播再往下（2026-09-22 加）──────────────────────────────
    // 原本是「找到 video 元素就截圖」，但元素存在不代表畫面出來了。
    // 實測（892-DRAGONLAW-0071／0075）：截到的是**遊戲的載入動畫**，
    // 訊息卻寫「CCTV 未播放（黑畫面）」，看起來像攝影機壞掉——其實只是截太早。
    if (!videoPlaying) {
      emit(`CCTV video 尚未播放，等待最多 10 秒...`)
      for (let i = 0; i < 20 && !videoPlaying; i++) {
        await sleep(500)
        for (const frame of page.frames()) {
          try {
            const playing = await frame.evaluate(() => {
              const vs = Array.from(document.querySelectorAll('div.cctv_video video, video'))
              return vs.some(v => {
                const el = v as HTMLVideoElement
                return !el.paused && el.readyState >= 2 && el.videoWidth > 0
              })
            })
            if (playing) { videoPlaying = true; break }
          } catch { /* frame detached */ }
        }
      }
      emit(videoPlaying ? `CCTV 已開始播放` : `⚠️ 等了 10 秒 CCTV 仍未播放`)
    }

    emit(`CCTV video 元素已找到，播放中：${videoPlaying}`)

    // ── 截圖前確認畫面真的乾淨（2026-09-22 加）──────────────────────────────
    // 關彈窗只是「試著關」，不等於關成功。這裡直接量：**有沒有可見元素壓在 CCTV 範圍上**。
    // 為什麼非做不可：上面剛加了「影像編號不符 → FAIL」。
    // 如果畫面被彈窗蓋住、OCR 讀到殘缺數字，就會生出一個**假的「編號不符」FAIL**，
    // 然後被寫進 Lark 叫現場去查攝影機——那比漏報更糟。
    // 所以遮擋時要走「**未驗證**」，而不是給一個看起來很確定的錯答案。
    let cctvObstructed = false
    let obstructionDesc = ''
    try {
      const ob = await page.evaluate(() => {
        const cont = document.querySelector('div.cctv_video')
        if (!cont) return null
        const c = cont.getBoundingClientRect()
        if (c.width < 10 || c.height < 10) return null
        const area = c.width * c.height
        let worst: { cls: string; cover: number } | null = null
        for (const el of Array.from(document.querySelectorAll('div,img,section'))) {
          if (el === cont || cont.contains(el) || el.contains(cont)) continue
          const s = getComputedStyle(el)
          if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.3) continue
          if (s.pointerEvents === 'none') continue
          const r = el.getBoundingClientRect()
          const w = Math.max(0, Math.min(c.right, r.right) - Math.max(c.left, r.left))
          const h = Math.max(0, Math.min(c.bottom, r.bottom) - Math.max(c.top, r.top))
          const cover = (w * h) / area
          if (cover < 0.25) continue                       // 蓋不到四分之一就不算遮擋
          const cls = typeof el.className === 'string' ? el.className : ''
          if (!worst || cover > worst.cover) worst = { cls: cls.slice(0, 40) || el.tagName, cover }
        }
        return worst
      })
      if (ob) {
        cctvObstructed = true
        obstructionDesc = `${ob.cls}（覆蓋 ${Math.round(ob.cover * 100)}%）`
        emit(`⚠️ CCTV 畫面仍被遮擋：${obstructionDesc} → 這一輪不做編號比對，記為未驗證`)
      }
    } catch { /* 量不到就當作沒遮擋，照原流程走 */ }

    // Step 3: get bounding box of cctv_video container for accurate page-level screenshot
    // elementHandle.screenshot() doesn't respect CSS absolute positioning — use page.screenshot({ clip }) instead
    let clipBox: { x: number; y: number; width: number; height: number } | null = null
    for (const frame of page.frames()) {
      try {
        const container = await frame.$('div.cctv_video')
        if (container) {
          const box = await container.boundingBox()
          if (box && box.width > 0 && box.height > 0) {
            clipBox = box
            emit(`CCTV 容器位置：x=${box.x.toFixed(0)} y=${box.y.toFixed(0)} w=${box.width.toFixed(0)} h=${box.height.toFixed(0)}`)
            break
          }
        }
      } catch { /* frame detached */ }
    }
    // fallback: screenshot full viewport
    if (!clipBox) {
      emit(`找不到 div.cctv_video 位置，改截全頁`)
    }

    // Step 4: OCR + blur + timestamp detection via Gemini Vision (up to 3 attempts, 2s apart)
    // Returns JSON: { id, time, blur, unexpected }
    const OCR_PROMPT =
      '這是一張監控攝影機（CCTV）截圖。請分析畫面並回傳 JSON，共四個欄位：\n' +
      '1. id：機台識別碼（英文字母加數字，例如 NCH 1374），通常豎排在畫面右側或左側。看不出來填「無法識別」。\n' +
      '2. time：畫面上的時間戳記（通常是日期+時間，例如 01-10-2026 13:09:28），看不到填空字串。\n' +
      '3. blur：畫面背景是否清晰。明顯模糊/失焦填 "blurry"，清楚填 "clear"。\n' +
      '4. unexpected：畫面上是否出現除了識別碼和時間戳以外的異常文字或警告訊息（true/false）。\n' +
      '只回傳 JSON，不加任何說明。範例：\n' +
      '{"id":"NCH 1374","time":"01-10-2026 13:09:28","blur":"clear","unexpected":false}'

    // Check for reference image up-front — if present, merge OCR + alignment into one Gemini call
    const machineType = machineCode
      ? (machineCode.split('-').find(p => /^[A-Z]+$/.test(p)) ?? '')
      : ''
    const refPath = machineType ? join(CCTV_REFS_DIR, `${machineType}.png`) : ''
    const refBuf = refPath && existsSync(refPath) ? readFileSync(refPath) : null

    const COMBINED_PROMPT = refBuf
      ? '以下提供兩張截圖：第一張是基準圖（標準鏡頭位置），第二張是當前 CCTV 截圖。\n' +
        '請仔細比較兩張圖的構圖差異，回傳 JSON，包含以下欄位：\n' +
        '1. id：第二張截圖中的機台識別碼（英文字母加數字，如 NCH 1374），看不出來填「無法識別」\n' +
        '2. time：第二張截圖的時間戳記，看不到填空字串\n' +
        '3. blur：第二張截圖是否清晰（"clear" / "blurry"）\n' +
        '4. unexpected：第二張截圖是否有異常文字或警告（true/false）\n' +
        '5. aligned：鏡頭構圖是否與基準圖一致（true/false）。請逐項比較：\n' +
        '   - 機台在畫面左右方向的位置（左側黑色空白區域比例是否相近？）\n' +
        '   - 機台在畫面上下方向的位置（頂部/底部裁切比例是否相近？）\n' +
        '   - 機台傾斜/旋轉角度是否相同\n' +
        '   - 機台在畫面中的大小比例是否相近\n' +
        '   只要任一項有明顯差異（超過畫面寬度或高度的 10%），就填 false\n' +
        '6. alignNote：若 aligned=false，具體說明偏差（例如「機台偏右，左側黑邊過多」、「機台偏上，底部被裁切」）；aligned=true 填空字串\n' +
        '只回傳 JSON，例如：{"id":"NCH 1374","time":"","blur":"clear","unexpected":false,"aligned":false,"alignNote":"機台偏右，左側黑邊過多"}'
      : OCR_PROMPT

    let ocrText = '無法識別'
    let ocrTime = ''
    let blurStatus = 'unknown'
    let hasUnexpected = false
    let alignLabel = ''
    let alignFail = false
    let framing: 'full' | 'partial' | 'disputed' | 'unknown' = 'unknown'
    let framingNote = ''
    let screenshotPath = ''

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await closeJackpotNotification(page, emit)
        const buf = clipBox
          ? await page.screenshot({ type: 'png', clip: clipBox })
          : await page.screenshot({ type: 'png', fullPage: false })
        // Save screenshot for inspection (first attempt only)
        if (attempt === 1) {
          screenshotPath = `C:\\Users\\user\\AppData\\Local\\Temp\\cctv_ocr_${Date.now()}.png`
          try {
            writeFileSync(screenshotPath, buf)
            emit(`截圖已儲存：${screenshotPath}`)
          } catch { /* ignore save error */ }
          if (machineCode) {
            try {
              // Lark H 欄一律貼整頁（1006）：OCR 照樣用裁好的 CCTV 容器，存檔／上傳另截當下整個 viewport，跟失敗路徑的證據圖一致
              const fullBuf = clipBox ? await page.screenshot({ type: 'png', fullPage: false }) : buf
              mkdirSync(CCTV_SAVE_DIR, { recursive: true })
              const cctvFilename = `${sessionPrefix}${machineCode}.png`
              const savePath = join(CCTV_SAVE_DIR, cctvFilename)
              writeFileSync(savePath, fullBuf)
              emit(`CCTV 截圖已複製：${savePath}`)
              void uploadCctvToServer(fullBuf, cctvFilename)
            } catch { /* ignore save error */ }
          }
        }

        const raw = refBuf
          ? await callGeminiVisionMultiViaProxy(COMBINED_PROMPT, [
              { base64: refBuf.toString('base64') },
              { base64: buf.toString('base64') },
            ])
          : await callGeminiVisionViaProxy(OCR_PROMPT, buf.toString('base64'), 'image/png')

        const cleaned = raw.trim().replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim()
        try {
          const parsed = JSON.parse(cleaned) as {
            id?: string; time?: string; blur?: string; unexpected?: boolean
            aligned?: boolean; alignNote?: string
          }
          const parsedId = (parsed.id ?? '').trim()
          const parsedTime = (parsed.time ?? '').trim()
          const parsedBlur = (parsed.blur ?? '').trim()
          const parsedUnexpected = parsed.unexpected === true
          emit(`OCR 第${attempt}次：id=${parsedId} time=${parsedTime} blur=${parsedBlur} unexpected=${parsedUnexpected}`)
          if (parsedBlur === 'clear' || parsedBlur === 'blurry') blurStatus = parsedBlur
          if (parsedTime) ocrTime = parsedTime
          if (parsedUnexpected) hasUnexpected = true
          // Parse alignment result if present (combined call)
          if (refBuf && parsed.aligned !== undefined) {
            const aligned = parsed.aligned !== false
            const note = (parsed.alignNote ?? '').trim()
            emit(`鏡頭比對：aligned=${aligned}${note ? `，${note}` : ''}`)
            if (!aligned) { alignLabel = `，鏡頭跑位（${note || '與基準不符'}）`; alignFail = true }
            else { alignLabel = '，鏡頭位置正常' }
          }
          if (parsedId && parsedId !== '無法識別') {
            ocrText = parsedId
            break
          }
        } catch {
          emit(`OCR 第${attempt}次（非JSON）：${cleaned}`)
          if (cleaned && cleaned !== '無法識別') {
            ocrText = cleaned
            break
          }
        }
      } catch (err) {
        emit(`OCR 第${attempt}次失敗：${err}`)
      }
      if (attempt < 3) await sleep(2000)
    }
    if (screenshotPath) emit(`截圖路徑：${screenshotPath}`)

    // 構圖（1004）：有在播、沒被遮擋、範例圖在 → 拍 CCTV video 本身（不含網頁 UI），跟合格／不合格範例一起問
    if (videoPlaying && !cctvObstructed && existsSync(CCTV_FRAMING_GOOD) && existsSync(CCTV_FRAMING_BAD)) {
      try {
        let vbox: { x: number; y: number; width: number; height: number } | null = null
        for (const frame of page.frames()) {
          const v = await frame.$('div.cctv_video video').catch(() => null)
          const b = v ? await v.boundingBox().catch(() => null) : null
          if (b && b.width > 20 && b.height > 20) { vbox = b; break }
        }
        const clip = vbox ?? clipBox
        if (clip) {
          await closeJackpotNotification(page, emit)
          const fb = await page.screenshot({ type: 'png', clip })
          // 問兩次：兩次都說不完整才判 FAIL；一次說不完整＝待人工確認（WARN）；兩次都 full＝完整。
          // 實測（6 輪×7 張）單次判讀約 5% 會翻（不合格判 full、合格判 partial 都出現過），所以只靠一致的結果下 FAIL
          const votes: string[] = []
          for (let k = 0; k < 2; k++) {
            const raw = await callGeminiVisionMultiViaProxy(CCTV_FRAMING_PROMPT, [
              { base64: readFileSync(CCTV_FRAMING_GOOD).toString('base64') },
              { base64: readFileSync(CCTV_FRAMING_BAD).toString('base64') },
              { base64: fb.toString('base64') },
            ])
            const fj = JSON.parse(raw.trim().replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim()) as { framing?: string; framingNote?: string }
            const v = fj.framing === 'none' ? 'partial' : String(fj.framing ?? '?')
            votes.push(v)
            if (v === 'partial' && !framingNote) framingNote = (fj.framingNote ?? '').trim()
          }
          framing = votes.every(v => v === 'partial') ? 'partial' : votes.every(v => v === 'full') ? 'full' : votes.includes('partial') ? 'disputed' : 'unknown'
          emit(`CCTV 構圖：${framing}（兩次判讀 ${votes.join('／')}）${framingNote ? `｜${framingNote}` : ''}`)
        }
      } catch (e) { emit(`CCTV 構圖判讀失敗（不影響其他判定）：${String(e).slice(0, 120)}`) }
    }

    const playStatus = videoPlaying ? '播放中' : '未播放（黑畫面）'
    const ocrFailed = !ocrText || ocrText === '無法識別'
    const blurLabel = blurStatus === 'blurry' ? '，畫面模糊' : blurStatus === 'clear' ? '，畫面清晰' : ''
    const timeLabel = ocrTime ? `，時間：${ocrTime}` : ''
    const unexpectedLabel = hasUnexpected ? '，偵測到異常文字' : ''

    // ── 身分比對：影像內的編號，是不是我們這次進的這一台？────────────────────────
    // 2026-09-21 實測：892-LUCKYLOOTER-0035 的影像浮水印寫 DYB0034、-0036 寫 DYB0035，
    // 各少一號，而當時這一步照樣 PASS——因為它只驗「有在播／清晰／讀得出來」。
    // 使用者定案：**編號對不上要判 FAIL，不能算 PASS**（看錯機台比畫面模糊嚴重得多）。
    //
    // 只比「尾端數字」，不比字母：OCR 對 B/D/8 這類字形常誤讀（實測 DYB0034 被讀成 DYD0034），
    // 拿字母去比會製造假 FAIL；數字誤讀的機率低得多，而且數字才是區分機台的那一段。
    // 兩邊都取得出數字才下判斷——讀不到就是「未驗證」，不是「不一致」。
    //
    // ⚠️ 不要只取「最後一串數字」：OCR 有時會把時間一起吐回來（`DYB0035 2026-09-21`），
    // 那樣會抓到 21 然後判成不一致——假 FAIL。改成：把影像裡**長度 ≥3 的數字串全部列出來**，
    // 只要有一串等於機台編號就算相符；一串都對不上才算不符。
    const codeDigits = machineCode.match(/(\d+)\s*$/)?.[1] ?? ''
    const ocrRuns = (ocrFailed || cctvObstructed) ? [] : (ocrText.match(/\d{3,}/g) ?? [])
    // 1003 COINCOMBO-0212 實例：CCTV 模糊、浮水印只有「IP Camera」＋時間，OCR 卻回 NCH1562——
    // 1562 正是頁面跑馬燈「…H1562 machine in the Money Gong game」的機台號（全站中獎廣播），**不是攝影機上的字**。
    // 所以：①畫面模糊 ②讀到的數字也出現在網頁文字裡（跑馬燈等，不是 CCTV 影像）→ 都算「未驗證」，不判不符。
    const pageText = await (async () => { let t = ''; for (const f of page.frames()) t += ' ' + (await f.evaluate(() => document.body?.innerText ?? '').catch(() => '')); return t })()
    const pollutedRuns = ocrRuns.filter(r => Number(r) !== Number(codeDigits) && new RegExp(`(^|\\D)0*${Number(r)}(\\D|$)`).test(pageText))
    const blurry = blurStatus === 'blurry'
    // 被遮擋／模糊／數字來自網頁文字時一律走「未驗證」——讀到的數字不可信，不能拿來判不符
    const identityUnverified = cctvObstructed || !codeDigits || ocrRuns.length === 0 || (blurry && !ocrRuns.some(r => Number(r) === Number(codeDigits))) || (pollutedRuns.length > 0 && pollutedRuns.length === ocrRuns.length)
    const identityMismatch = !identityUnverified && !ocrRuns.some(r => Number(r) === Number(codeDigits))
    const identityLabel = identityMismatch
      ? `，🚨 影像編號不符：影像 ${ocrText} ↔ 機台 ${machineCode}`
      : cctvObstructed
        ? `，⚠️ 編號未驗證：畫面被遮擋（${obstructionDesc}）`
        : pollutedRuns.length && pollutedRuns.length === ocrRuns.length
          ? `，⚠️ 編號未驗證：OCR 讀到的 ${pollutedRuns.join('／')} 也出現在網頁文字（跑馬燈等），不是攝影機浮水印`
          : blurry && ocrRuns.length && !ocrRuns.some(r => Number(r) === Number(codeDigits))
            ? '，⚠️ 編號未驗證：畫面模糊，讀到的編號不可信'
            : identityUnverified
              ? '，編號未驗證（影像或機台代碼取不到數字）'
              : '，編號相符'
    if (identityMismatch) emit(`🚨 影像編號不符：影像內編號「${ocrText}」與本次機台「${machineCode}」對不上（只比數字，不比字母）`)

    // 1004：構圖判讀結果一律寫進訊息（full 也寫），報告上看得出這台有判過、判出什麼
    const framingLabel = framing === 'full' ? '，構圖完整' : framing === 'unknown' ? '，構圖未判讀' : ''
    const message = `CCTV ${playStatus}，識別碼：${ocrText}${timeLabel}${blurLabel}${unexpectedLabel}${alignLabel}${identityLabel}${framingLabel}`

    // 身分不符優先於其他判定——畫面再清楚，拍的不是這一台就沒有意義
    if (identityMismatch) {
      return { step: 'CCTV 號碼比對', status: 'fail', message, durationMs: Date.now() - t0 }
    }
    // 1003 使用者（COINCOMBO-0212：畫面模糊、浮水印只有「IP Camera」＋時間、沒有機台編號）：「這個 CCTV 不行，算 FAIL」——共通規則
    //   ①有在播但畫面模糊 → FAIL（cctv blurry）
    //   ②畫面讀得到（OCR 有讀到時間）但浮水印沒有機台編號（或讀到的號碼其實是網頁跑馬燈）→ FAIL（cctv no id）
    //   被彈窗遮擋、OCR 整個失敗（連時間都沒有）→ 還是未驗證，不怪 CCTV
    if (videoPlaying && !cctvObstructed && blurStatus === 'blurry') {
      return { step: 'CCTV 號碼比對', status: 'fail', message: `${message}｜判定：CCTV 畫面模糊（不合格）`, durationMs: Date.now() - t0 }
    }
    const noIdWatermark = videoPlaying && !cctvObstructed && !!ocrTime && (ocrFailed || ocrRuns.length === 0 || (pollutedRuns.length > 0 && pollutedRuns.length === ocrRuns.length))
    if (noIdWatermark) {
      return { step: 'CCTV 號碼比對', status: 'fail', message: `${message}｜判定：CCTV 浮水印沒有機台編號（不合格）`, durationMs: Date.now() - t0 }
    }
    // 1004 使用者（COINCOMBO-0225／0226：浮水印編號相符，但只拍到機台側邊局部）：「沒拍到完整機台不能算過」——共通規則
    if (videoPlaying && !cctvObstructed && framing === 'partial') {
      return { step: 'CCTV 號碼比對', status: 'fail', message: `${message}，構圖：只拍到機台局部${framingNote ? `（${framingNote}）` : ''}｜判定：CCTV 沒拍到完整機台（不合格）`, durationMs: Date.now() - t0 }
    }
    // 兩次判讀不一致 → 不判 FAIL，交人工看圖（Claude 讀 cctv-saves 原圖），訊息要讓 batch 認得「構圖待確認」
    if (videoPlaying && !cctvObstructed && framing === 'disputed') {
      return { step: 'CCTV 號碼比對', status: 'warn', message: `${message}，⚠️ 構圖待人工確認：兩次判讀不一致${framingNote ? `（其中一次：${framingNote}）` : ''}`, durationMs: Date.now() - t0 }
    }
    if (!videoPlaying || blurStatus === 'blurry' || hasUnexpected || ocrFailed || alignFail) {
      return { step: 'CCTV 號碼比對', status: 'warn', message, durationMs: Date.now() - t0 }
    }
    return { step: 'CCTV 號碼比對', status: 'pass', message, durationMs: Date.now() - t0 }
  } catch (e) {
    return { step: 'CCTV 號碼比對', status: 'fail', message: `例外: ${e}`, durationMs: Date.now() - t0 }
  }
}

// ── 退出紀錄（1002 新增）────────────────────────────────────────────────────
// 1002 MONEYGONG-1565：退出卡在「Tips｜Cash out credit」框 32 次、20 分鐘，事後說不出是「Confirm 沒按到」
// 「請求沒送出」還是「伺服器沒回」。所以每次退出都記：關鍵按鈕前後的截圖、畫面上的彈框文字、餘額、
// 退出期間 console 裡跟離機有關的訊息。截圖前 3 次每次都拍，之後每 5 次拍一輪（卡 150 次也不會塞爆硬碟）。
const EXIT_SAVE_DIR = join(MACHINE_TEST_ROOT, 'exit-saves')
const EXIT_TEXT_RE = /Cash ?out credit[^\n]{0,30}|Quit game[^\n]{0,30}|cannot be quit|Exit To Lobby|Want to reserve this machine\?|please wait|logged in from another device|Tips/gi
const EXIT_CONSOLE_RE = /leaveGM|leaveReq|quitGM|cash ?out|exitGM|onUserLeave/i
export interface ExitTrace { file: string; attempt: number; shots: string[]; texts?: string[]; wsStage?: ExitWsStage }
// 這次退出的 WS 停在哪一步（1003）：沒送 leaveGMReq／送了沒回／回了沒等到 leaveGMNtc／有 leaveGMNtc
export type ExitWsStage = 'no-leave-req' | 'req-no-resp' | 'resp-no-ntc' | 'ntc'
export function exitWsStage(frames: { dir: string; text: string }[]): ExitWsStage {
  const reqAt = frames.findIndex(f => f.dir === 'SEND' && /leaveGMReq/.test(f.text))
  if (reqAt < 0) return 'no-leave-req'
  if (frames.some(f => f.dir === 'RECV' && /leaveGMNtc/.test(f.text))) return 'ntc'
  return frames.slice(reqAt + 1).some(f => f.dir === 'RECV') ? 'resp-no-ntc' : 'req-no-resp'
}

// ── 退出異常處理手冊（1003，使用者：「告訴使用者現在的狀況…你就可以學習起來，後續遇到相同狀況可以自行解決」）──
// 檔案 exit-playbook.json（agent 本機，跟 bonus-sequence.json 同一層）：
//   [{ "name": "…", "match": { "text": "<regex，比對最後一次畫面文字>", "wsStage": "no-leave-req" }, "action": { "type": "click-text", "text": "Cancel" },
//      "learnedFrom": "<誰、哪天、哪台>" }]
// 只認白名單動作；會動到錢或預約的按鈕（Spin／Reserve Now／PLAY NOW／View）一律不做——那些第一次一定要問人。
const EXIT_PLAYBOOK_FILE = join(MACHINE_TEST_ROOT, 'exit-playbook.json')
export interface ExitPlaybookEntry { name: string; match: { text?: string; wsStage?: ExitWsStage }; action: { type: 'click-text' | 'reload' | 'wait' | 'escape'; text?: string; seconds?: number }; learnedFrom?: string }
const PLAYBOOK_FORBIDDEN_TEXT = /spin|reserve now|play now|^view$|bet|top ?up/i
export function matchExitPlaybook(entries: ExitPlaybookEntry[], texts: string[], wsStage: ExitWsStage | undefined): ExitPlaybookEntry | null {
  const joined = texts.join(' / ')
  return entries.find(e => {
    if (!e?.action?.type || !['click-text', 'reload', 'wait', 'escape'].includes(e.action.type)) return false
    if (e.action.type === 'click-text' && (!e.action.text || PLAYBOOK_FORBIDDEN_TEXT.test(e.action.text))) return false
    if (!e.match?.text && !e.match?.wsStage) return false   // 什麼都不比對＝什麼都套，太危險
    if (e.match.text) { try { if (!new RegExp(e.match.text, 'i').test(joined)) return false } catch { return false } }
    if (e.match.wsStage && e.match.wsStage !== wsStage) return false
    return true
  }) ?? null
}
function loadExitPlaybook(): ExitPlaybookEntry[] {
  try { const j = JSON.parse(readFileSync(EXIT_PLAYBOOK_FILE, 'utf8')); return Array.isArray(j) ? j : [] } catch { return [] }
}
async function applyPlaybookAction(page: Page, a: ExitPlaybookEntry['action'], emit: (msg: string) => void): Promise<boolean> {
  try {
    if (a.type === 'wait') { await sleep(Math.min(600, Math.max(1, a.seconds ?? 10)) * 1000); return true }
    if (a.type === 'escape') { await page.keyboard.press('Escape'); return true }
    if (a.type === 'reload') { await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }); await sleep(8000); return true }
    if (a.type === 'click-text' && a.text) {
      for (const f of page.frames()) {
        const b = f.getByText(a.text, { exact: true })
        const n = await b.count().catch(() => 0)
        for (let i = 0; i < n; i++) if (await b.nth(i).isVisible().catch(() => false)) {
          const h = await b.nth(i).elementHandle()
          return (await uiAct(page, 'exit', `手冊動作「${a.text}」`, h, () => b.nth(i).click({ timeout: 3000 }))) === 'clicked'
        }
      }
      emit(`（手冊動作：畫面上找不到「${a.text}」）`)
    }
  } catch (e) { emit(`（手冊動作失敗：${String(e).slice(0, 100)}）`) }
  return false
}
async function exitSnap(page: Page, emit: (msg: string) => void, trace: ExitTrace | undefined, tag: string): Promise<void> {
  if (!trace) return
  try {
    const texts = new Set<string>()
    for (const f of page.frames()) {
      const t = await f.evaluate(() => document.body?.innerText ?? '').catch(() => '')
      for (const m of t.match(EXIT_TEXT_RE) ?? []) texts.add(m.trim())
    }
    const bal = await readMachineBalance(page).catch(() => null)   // 1007：機台內餘額（不是大廳錢包）
    let shot = ''
    if (trace.attempt <= 3 || trace.attempt % 5 === 0) {
      mkdirSync(EXIT_SAVE_DIR, { recursive: true })
      shot = join(EXIT_SAVE_DIR, `${trace.file}-a${trace.attempt}-${trace.shots.length + 1}-${tag}.png`)
      writeFileSync(shot, await page.screenshot({ type: 'png' }))
      trace.shots.push(shot)
    }
    trace.texts = [...texts]
    emit(`退出紀錄 第${trace.attempt}次 ${tag}：畫面文字「${[...texts].join(' / ') || '（沒有彈框文字）'}」｜餘額 ${bal ?? '讀不到'}${shot ? `｜截圖 ${shot}` : ''}`)
  } catch (e) {
    emit(`退出紀錄 ${tag} 失敗（不影響判定）：${String(e).slice(0, 100)}`)
  }
}

async function stepExit(page: Page, emit: (msg: string) => void, customExitSel?: string | null, waitForLeaveGM?: GMWaitFn, trace?: ExitTrace): Promise<StepResult> {
  const lines: string[] = []
  const onConsole = (msg: ConsoleMessage) => { const t = msg.text(); if (EXIT_CONSOLE_RE.test(t)) lines.push(`${new Date().toISOString().slice(11, 19)} ${t.slice(0, 160)}`) }
  page.on('console', onConsole)
  const since = Date.now()
  try {
    const r = await stepExitInner(page, emit, customExitSel, waitForLeaveGM, trace)
    await exitSnap(page, emit, trace, 'end')
    return trace?.shots.length ? { ...r, extraData: { ...(r.extraData ?? {}), exitShots: JSON.stringify(trace.shots) } } : r
  } finally {
    page.off('console', onConsole)
    if (trace) {
      emit(`退出紀錄 第${trace.attempt}次 console（離機相關 ${lines.length} 行）：${lines.slice(-12).join(' ‖ ') || '（沒有）'}`)
      // WS：整段全文存檔（每次嘗試都存，文字檔很小），log 只印跟離機有關的幾則
      const frames = wsFramesSince(page, since)
      const hhmmss = (ts: number) => new Date(ts + 8 * 3600_000).toISOString().slice(11, 23)
      try {
        mkdirSync(EXIT_SAVE_DIR, { recursive: true })
        const f = join(EXIT_SAVE_DIR, `${trace.file}-a${trace.attempt}-ws.txt`)
        writeFileSync(f, frames.map(x => `${hhmmss(x.ts)} ${x.dir} ${x.text}`).join('\n') || '（這段時間沒有 WS frame）')
        trace.shots.push(f)
      } catch { /* 存檔失敗不影響判定 */ }
      trace.wsStage = exitWsStage(frames)
      const key = frames.filter(x => /leave|quit|cash|exit|errcode|kick|aft/i.test(x.text))
      emit(`退出紀錄 第${trace.attempt}次 WS（共 ${frames.length} 則，離機相關 ${key.length} 則）：${key.slice(-8).map(x => `${hhmmss(x.ts)} ${x.dir} ${x.text.slice(0, 140)}`).join(' ‖ ') || '（沒有）'}`)
    }
  }
}

async function stepExitInner(page: Page, emit: (msg: string) => void, customExitSel?: string | null, waitForLeaveGM?: GMWaitFn, trace?: ExitTrace): Promise<StepResult> {
  const t0 = Date.now()
  try {
    emit(`尋找退出按鈕...`)
    await exitSnap(page, emit, trace, 'before-quit')

    const exitSelectors = [
      ...(customExitSel ? [customExitSel] : []),
      '.handle-main .my-button.btn_cashout',
      '.my-button.btn_cashout',
      '.btn_cashout',
      '[class*="btn_cashout"]',
      '[class*="exit"]',
      '[class*="back"]',
    ]

    // Start listening BEFORE clicking — leaveGMNtc may fire immediately (e.g. errcode 10002)
    const leaveEventPromise = waitForLeaveGM ? waitForLeaveGM(10000) : Promise.resolve(null)

    let clicked = false
    for (const sel of exitSelectors) {
      if (await safeClick(page, sel)) {
        emit(`點擊退出/Cashout 按鈕`)
        clicked = true
        await sleep(3000)
        await exitSnap(page, emit, trace, 'after-quit')
        break
      }
    }

    if (!clicked) {
      // Try pressing Escape
      await page.keyboard.press('Escape')
      await sleep(1000)
      if (!await isInGame(page)) {
        return { step: '退出測試', status: 'pass', message: '按 Escape 後已退出遊戲', durationMs: Date.now() - t0 }
      }
      return { step: '退出測試', status: 'fail', message: '找不到退出按鈕', durationMs: Date.now() - t0 }
    }

    // leaveGMNtc is the primary signal for exit result
    const leaveEv = await leaveEventPromise
    if (leaveEv) {
      emit(`leaveGMNtc errcode=${leaveEv.errcode}: ${leaveEv.errcodedes}`)
      if (leaveEv.errcode === 10002) {
        return { step: '退出測試', status: 'fail', message: `退出被拒絕：遊戲正在運行中 (leaveGMNtc errcode 10002)，請等待 JP/Bonus 結束後重試`, durationMs: Date.now() - t0 }
      }
      if (leaveEv.errcode !== 0) {
        return { step: '退出測試', status: 'fail', message: `退出失敗：leaveGMNtc errcode=${leaveEv.errcode} — ${leaveEv.errcodedes}`, durationMs: Date.now() - t0 }
      }
      // errcode=0 — exit confirmed by server, wait for page transition then verify DOM
      await sleep(1500)
      if (!await isInGame(page)) {
        return { step: '退出測試', status: 'pass', message: '已成功退出至大廳（leaveGMNtc errcode=0）', durationMs: Date.now() - t0 }
      }
    }

    // No leaveGMNtc or DOM still shows in-game — proceed with Exit/Confirm buttons
    // Re-arm leaveGMNtc listener BEFORE clicking (first listener already timed out)
    emit(`未收到 leaveGMNtc 或仍在遊戲內，嘗試 Exit/Confirm 按鈕...`)
    const leaveEv2Promise = waitForLeaveGM ? waitForLeaveGM(15000) : Promise.resolve(null)

    await sleep(1000)
    const exitClicked = await safeClick(page, '.function-btn .reserve-btn-gray')
      || await safeClickXPath(page, "//button[normalize-space(text())='Exit']")
      || await safeClickXPath(page, "//button[normalize-space(text())='Exit To Lobby']")
    if (exitClicked) {
      emit(`點擊 Exit 按鈕`)
      await sleep(1000)
      await exitSnap(page, emit, trace, 'after-exit-to-lobby')
    }

    // Step 3: Try Confirm dialog
    const confirmClicked = await safeClickXPath(page, "//button[.//div[normalize-space(text())='Confirm']]")
      || await safeClickXPath(page, "//button[normalize-space(text())='Confirm']")
      || await safeClickXPath(page, "//button[normalize-space(text())='確認']")
    if (confirmClicked) {
      emit(`點擊確認對話框`)
      // 正常會馬上出現「Quit game, please wait...」；1565 卡住那次一直沒出現——這張就是要分辨這兩種
      await sleep(500)
      await exitSnap(page, emit, trace, 'after-confirm')
    }

    if (exitClicked || confirmClicked) {
      emit(`Exit/Confirm clicked, waiting up to 10s for leaveGMNtc...`)
      const evAfterClick = await Promise.race([
        leaveEv2Promise,
        new Promise<null>(r => setTimeout(() => r(null), 10000)),
      ])
      if (evAfterClick) {
        emit(`leaveGMNtc errcode=${evAfterClick.errcode}: ${evAfterClick.errcodedes}`)
        if (evAfterClick.errcode === 10002) {
          return { step: '退出測試', status: 'fail', message: '退出被拒絕：遊戲正在運行中 (leaveGMNtc errcode 10002)', durationMs: Date.now() - t0 }
        }
        if (evAfterClick.errcode !== 0) {
          return { step: '退出測試', status: 'fail', message: `退出失敗：leaveGMNtc errcode=${evAfterClick.errcode} — ${evAfterClick.errcodedes}`, durationMs: Date.now() - t0 }
        }
        await sleep(1500)
        if (!await isInGame(page)) {
          return { step: '退出測試', status: 'pass', message: '已成功退出至大廳（Exit/Confirm 後收到 leaveGMNtc errcode=0）', durationMs: Date.now() - t0 }
        }
        return { step: '退出測試', status: 'warn', message: 'Exit/Confirm 後收到 leaveGMNtc errcode=0，但 DOM 仍顯示在遊戲內', durationMs: Date.now() - t0 }
      }
    }

    // Poll for up to 12s — page transition to lobby can take longer than a fixed 3s sleep
    // Also race against the re-armed leaveGMNtc listener so errcode is captured
    const exitDeadline = Date.now() + 12000
    while (Date.now() < exitDeadline) {
      await sleep(500)
      if (!await isInGame(page)) {
        // Check if leaveGMNtc already fired (no additional wait needed — just peek)
        const ev2 = await Promise.race([
          leaveEv2Promise,
          new Promise<null>(r => setTimeout(() => r(null), 300)),
        ])
        if (ev2 && ev2.errcode !== 0) {
          emit(`leaveGMNtc errcode=${ev2.errcode}: ${ev2.errcodedes}`)
          return { step: '退出測試', status: 'warn', message: `已退出但收到錯誤通知 (errcode ${ev2.errcode}): ${ev2.errcodedes}`, durationMs: Date.now() - t0 }
        }
        return { step: '退出測試', status: 'pass', message: `已成功退出至大廳`, durationMs: Date.now() - t0 }
      }
    }

    // Exhausted DOM poll — check if leaveGMNtc arrived with a failure code
    const ev2Final = await Promise.race([
      leaveEv2Promise,
      new Promise<null>(r => setTimeout(() => r(null), 300)),
    ])
    if (ev2Final && ev2Final.errcode !== 0) {
      emit(`leaveGMNtc errcode=${ev2Final.errcode}: ${ev2Final.errcodedes}`)
      return { step: '退出測試', status: 'fail', message: `退出失敗：leaveGMNtc errcode=${ev2Final.errcode} — ${ev2Final.errcodedes}`, durationMs: Date.now() - t0 }
    }

    return { step: '退出測試', status: 'fail', message: '點擊退出後仍偵測為在遊戲內（可能有未處理的確認視窗）', durationMs: Date.now() - t0 }
  } catch (e) {
    return { step: '退出測試', status: 'fail', message: `例外: ${e}`, durationMs: Date.now() - t0 }
  }
}

// Status codes from OSMWatcher
const BONUS_STATUSES = new Set([1, 2, 3, 4, 5, 8])
const OSM_STATUS_LABELS: Record<number, string> = {
  1: 'Free Game 觸發',
  2: 'Free Game 觸發 (2)',
  3: 'Jackpot 觸發',
  4: 'Jackpot 進行中',
  5: 'Free Game 進行中',
  8: '面額切換',
  9: 'Handpay（需人工處理）',
}

// ─── Shared atomic queue (single-threaded Node.js, no locks needed) ───────────

class MachineQueue {
  private codes: string[]
  private index = 0

  constructor(codes: string[]) { this.codes = codes }

  /** Take next machine code; returns null when queue is exhausted */
  next(): string | null {
    if (this.index >= this.codes.length) return null
    return this.codes[this.index++]
  }

  get total() { return this.codes.length }
  get done()  { return this.index }
}

// ─── Main Runner ──────────────────────────────────────────────────────────────

export class MachineTestRunner extends EventEmitter {
  private stopped = false
  private osmStatus: Map<string, number>
  private profiles: Map<string, MachineProfile>
  private betRandomConfig: Record<string, string[]>
  /** Buffer of all emitted events — replayed to late SSE subscribers */
  private eventBuffer: TestEvent[] = []
  /** 調適模式：若設定則 daily-analysis API 強制使用此固定 gmid */
  private debugGmid: string | null = null
  /** 1007 iDeck 時間學習：本 session 的學習值、禁用短等待的機種 */
  private ideckTimings: Record<string, IdeckTimingCfg> = {}
  private ideckNoFast = new Set<string>()
  private sessionKey = ''
  /** Session ID prefix for cctv-saves / audio-saves filenames */
  private sessionPrefix: string = ''
  /** 整段錄音：只有單 Worker 時才開（多 Worker 會把各機台的聲音混在一起） */
  private sessionAudioEnabled = false
  /** 目前這一輪的瀏覽器——stop() 要能直接關掉它，不然在跑的步驟會繼續操作機台 */
  private browser: Browser | null = null
  /**
   * 無法自動收尾、必須人工處理的狀況（例如退出回 AFT 錯誤碼、Handpay、退出超時）。
   * 一旦設了就不再測下一台：帳號可能還坐在機台上，繼續跑只會汙染後面的結果。
   */
  private _haltReason: string | null = null
  get haltReason(): string | null { return this._haltReason }

  constructor(osmStatus?: Map<string, number>, profiles?: Map<string, MachineProfile>, betRandomConfig?: Record<string, string[]>) {
    super()
    this.osmStatus = osmStatus ?? new Map()
    this.profiles = profiles ?? new Map()
    this.betRandomConfig = betRandomConfig ?? {}
  }

  /**
   * 停止：先讓所有迴圈（特殊遊戲等待、退出重試）看到 stopped 不再 Spin，再關瀏覽器。
   * ⚠️ 2026-09-24：舊版只設旗標，正在跑的機台會繼續把 15 分鐘的 FG 等待跑完，
   *    瀏覽器一直開著、佔著帳號登入（再開一個會被「logged in from another device」踢掉），
   *    agent 也要等它跑完才回 agent_done → busy 卡住，只能重啟 agent。
   * ⚠️ 關瀏覽器 ≠ 伺服器端已離機——被中止的那台會在結果裡標「未確認離機」。
   */
  stop() {
    if (this.stopped) return
    this.stopped = true
    this.log('⏹ 收到停止指令：取消 Spin／退出重試，關閉瀏覽器')
    const b = this.browser
    if (b) void b.close().catch(() => { /* already closed */ })
  }

  /** Return a snapshot of all events emitted so far (for SSE replay) */
  getBufferedEvents(): TestEvent[] { return [...this.eventBuffer] }

  emit(event: 'event', data: TestEvent): boolean
  emit(event: string, ...args: unknown[]): boolean {
    return super.emit(event, ...args)
  }

  private static readonly EVENT_BUFFER_MAX = 5000

  private send(data: TestEvent) {
    this.eventBuffer.push(data)
    if (this.eventBuffer.length > MachineTestRunner.EVENT_BUFFER_MAX) {
      this.eventBuffer.splice(0, this.eventBuffer.length - MachineTestRunner.EVENT_BUFFER_MAX)
    }
    this.emit('event', data)
  }

  private log(message: string, machineCode?: string) {
    this.send({ type: 'log', machineCode, status: 'info', message, ts: new Date().toISOString() })
  }

  /** Run one machine through all configured steps */
  private async runMachine(
    browser: Browser,
    machineCode: string,
    lobbyUrl: string,
    workerId: number,
    steps: MachineTestSession['steps'],
    aiAudio = false,
  ): Promise<void> {
    const workerTag = `[Worker-${workerId}]`
    this.send({ type: 'machine_start', machineCode, status: 'info', message: `${workerTag} 開始測試 ${machineCode}`, ts: new Date().toISOString() })
    const startedAt = new Date().toISOString()
    const stepResults: StepResult[] = []

    const machineType = extractMachineType(machineCode)
    // Primary lookup by extracted type; gmid fallback resolved after entry (see below)
    let profile = this.profiles.get(machineType)

    const ctx = await browser.newContext({ viewport: { width: 428, height: 739 } })
    // Inject at context level so it applies to ALL frames (including iframes)
    await ctx.addInitScript(GM_EVENT_MONITOR_SCRIPT)
    await ctx.addInitScript(AUDIO_MONITOR_SCRIPT)
    await ctx.addInitScript(IDECK_MONITOR_SCRIPT)
    await ctx.addInitScript(PINUS_TRACKER_SCRIPT)
    // 1007 提示框處理第二層：頁面內 capture 攔截禁點（runner 的 uiAct 是第一層）
    await ctx.addInitScript(NEVER_BLOCK_IN_PAGE, NEVER_CLICK_SERIALIZED)
    // 1008：正式站 serverCfg debug:false → 前端不印 SEND／ON，iDeck／最小注／觸屏全部判成「前端沒送」。見 server-cfg-debug.ts
    const cfgDebug = await installServerCfgDebug(ctx)
    const page = await ctx.newPage()

    // Set up GM event watcher BEFORE goto so it catches the initial WS connection
    const { waitForEnterGM, waitForLeaveGM, waitForIdeckCmd } = createGMEventWatcher(page)

    const emit = (msg: string) => this.log(`${workerTag} ${msg}`, machineCode)

    const NOISE_PATTERNS = [
      /Failed to load resource/i,
      /net::ERR_/i,
      /404 \(Not Found\)/i,
      /403 \(Forbidden\)/i,
      /the server responded with a status of \d+/i,
    ]
    const consoleLogs: string[] = []
    page.on('console', msg => {
      const t = msg.type()
      if (t === 'error' || t === 'warn') {
        const text = `[console.${t}] ${msg.text()}`
        if (NOISE_PATTERNS.some(p => p.test(text))) return  // skip resource-load noise
        consoleLogs.push(text)
        this.send({ type: 'log', machineCode, status: t === 'error' ? 'fail' : 'warn', message: `${workerTag} ${text}`, ts: new Date().toISOString() })
      }
    })
    page.on('pageerror', err => {
      const text = `[JS Error] ${err.message}`
      consoleLogs.push(text)
      this.send({ type: 'log', machineCode, status: 'fail', message: `${workerTag} ${text}`, ts: new Date().toISOString() })
    })

    try {
      emit(`導航至大廳...`)
      await page.goto(lobbyUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await sleep(2000)
      {
        const d = describeServerCfgDebug(cfgDebug)
        if (d.level === 'warn') this.send({ type: 'log', machineCode, status: 'warn', message: `${workerTag} ${d.text}`, ts: new Date().toISOString() })
        else emit(d.text)
      }

      if (steps.entry) {
        const r = await stepEntry(page, machineCode, emit, profile, waitForEnterGM)
        stepResults.push(r)
        this.log(`${workerTag} [${r.status.toUpperCase()}] 進入機台: ${r.message}`, machineCode)

        // After entering, resolve final profile. Priority:
        // 1. enterMachineType exact match (overrides machine-code match)
        // 2. machine code match (already in `profile` from before entry)
        // gmid fallback intentionally removed — machine-code must match explicitly
        if (r.status !== 'fail') {
          const gmMachineType = r.extraData?.machineType ?? ''
          let matchedBy = profile ? 'machine-code' : ''

          // Priority 1: enterMachineType exact match — most specific, overrides all
          if (gmMachineType) {
            const lower = gmMachineType.toLowerCase()
            for (const [, p] of this.profiles) {
              if ((p.enterMachineType ?? '').toLowerCase() === lower && p.enterMachineType) {
                profile = p
                matchedBy = `enterMachineType=${gmMachineType}`
                break
              }
            }
          }

          if (profile) {
            emit(`✅ 使用設定檔：${profile.machineType}（${matchedBy} 比對）`)
          } else {
            emit(`⚠️ 未找到設定檔（機台代碼=${machineType}，enterGMNtc machineType=${gmMachineType}）— 使用預設行為`)
          }
        }

        if (r.status === 'fail') {
          if (steps.stream)      stepResults.push({ step: '推流檢測',  status: 'skip', message: '進入失敗，跳過', durationMs: 0 })
          if (steps.spin)        stepResults.push({ step: 'Spin 測試', status: 'skip', message: '進入失敗，跳過', durationMs: 0 })
          if (steps.audio)       stepResults.push({ step: '音頻檢測',  status: 'skip', message: '進入失敗，跳過', durationMs: 0 })
          if (steps.ideck)       stepResults.push({ step: 'iDeck 測試', status: 'skip', message: '進入失敗，跳過', durationMs: 0 })
          if (steps.touchscreen) stepResults.push({ step: '觸屏測試',  status: 'skip', message: '進入失敗，跳過', durationMs: 0 })
          if (steps.cctv)        stepResults.push({ step: 'CCTV 號碼比對', status: 'skip', message: '進入失敗，跳過', durationMs: 0 })
          if (steps.exit)        stepResults.push({ step: '退出測試',  status: 'skip', message: '進入失敗，跳過', durationMs: 0 })
        } else {
          // ── OSMWatcher continuous monitor ────────────────────────────────────
          // Monitoring starts the moment we enter the machine and ends on exit.
          // checkOsm() is called before every step: silently passes if status=0,
          // otherwise executes the bonus action and waits up to 3 min for status=0.
          // 1003：特殊遊戲卡住救援（OCR 判斷＋自己學）。學到的直接改這台後續用的 profile，並在退出步驟帶回 batch 寫回機種設定
          let bonusLearned: BonusLearn | null = null
          const isSpecialNow = () => [1, 2, 3, 4, 5].includes(this.osmStatus.get(machineCode) ?? 0)
          const stallRescue = async (): Promise<MachineProfile | undefined> => {
            const r = await bonusStallRescue(page, emit, machineCode, isSpecialNow, `${this.sessionPrefix}${machineCode}-${Date.now()}`)
            emit(`🧩 特殊遊戲救援結果：${r.note}`)
            if (!r.learn) return undefined
            bonusLearned = r.learn
            profile = { ...(profile ?? ({ machineType } as MachineProfile)), bonusAction: r.learn.action, ...(r.learn.touchPoints?.length ? { touchPoints: r.learn.touchPoints } : {}) }
            return profile
          }
          // 1007 規格 A：綁定這次進機台（moneyNtc 序號基準），未監控機台開局沒結束時由它處理
          const moneySeqAtEntry = await (async () => { const l = await readMoneyLog(page); return l.length ? l[l.length - 1].seq : 0 })()
          const openRound = makeOpenRoundHandler({
            page, emit, machineCode, getProfile: () => profile, sinceSeq: moneySeqAtEntry,
            osmStatus: () => this.osmStatus.get(machineCode), stopped: () => this.stopped, filePrefix: this.sessionPrefix,
          })
          // 疑似特殊遊戲 stalled／Handpay／停止 → 後續步驟（含退出）一律不做、交人工（CodeX 2d513b6 [P1]：只記 warn 的話後面照跑 Spin／iDeck）
          let openRoundHalt: string | null = null
          // 1007 提示框處理：進機台成功就開始監看（每 2 秒，只在操作鎖裡、點之前重查；擷取／錄音時暫停），退出完成才停
          const popupGuard = attachPopupGuard(page, emit, `${this.sessionPrefix}${machineCode}`)
          popupGuard.startWatch(2000)
          /** 擷取／錄音期間暫停背景掃描，結束立刻補掃（CodeX：等在途點擊結束——pause 前先過一次鎖） */
          const capture = async <T>(fn: () => Promise<T>): Promise<T> => {
            await popupGuard.withLock(async () => { popupGuard.pause() })
            try { return await fn() } finally { await popupGuard.resume() }
          }
          /** 把這段期間遇到的提示框紀錄補進最後一個步驟的訊息（「未知提示框：…」等） */
          const flushPopupNotes = () => {
            const n = popupGuard.drain()
            if (!n || !stepResults.length) return
            const last = stepResults[stepResults.length - 1]
            last.message = `${last.message}｜${n}`
          }
          const checkOsm = async () => {
            if (this.stopped) return
            const s = this.osmStatus.get(machineCode)
            if (s === undefined || s === 0) {
              const orr = await openRound('步驟之間')
              if (!orr) return
              stepResults.push({ step: '特殊遊戲等待', status: orr.result === 'done' ? 'pass' : 'fail', message: orr.note, durationMs: 0 })
              if (orr.result !== 'done') {   // 停止也算（CodeX 35d17c9 [P1]：!this.stopped 會讓停止後的步驟照跑）
                openRoundHalt = orr.note
                this._haltReason = `${machineCode} 疑似特殊遊戲未結束（帳號可能卡在這台）：${orr.note}｜⚠️ 額度可能還在機台上`
              }
              return
            }
            const bonusWait = await waitForNormalStatus(this.osmStatus, machineCode, page, profile, emit, () => this.stopped, stallRescue)
            if (bonusWait) {
              stepResults.push({ step: '特殊遊戲等待', status: 'pass', message: `偵測到「${bonusWait.label}」，等待 ${(bonusWait.waited / 1000).toFixed(0)}s 後完成`, durationMs: bonusWait.waited })
              this.log(`${workerTag} [PASS] 特殊遊戲等待完成: ${bonusWait.label}`, machineCode)
            }
          }

          /** 每個步驟之前：照舊看特殊狀態；疑似特殊遊戲已判 stalled 就不做這一步（退出也不做——帳號留在機台，交人工） */
          const stepGate = async (name: string): Promise<boolean> => {
            const isExit = name === '退出測試'
            flushPopupNotes()
            if (isExit) popupGuard.phase = 'exit'
            // 步驟之前同步掃一次（close／ack 會在這裡點掉）
            if (!this.stopped) await popupGuard.scan({ act: true, why: `${name}之前` }).catch(() => {})
            // CodeX 56e3d1b P2：未知框還沒滿 30 秒就到退出 → 原本直接退出、判定永遠不會記。改成每 2 秒重查，直到框消失或滿 30 秒
            if (isExit) await popupGuard.settleUnknown(() => this.stopped)
            flushPopupNotes()
            const pb = popupStepBlock({ stop: popupGuard.stop, unknown: popupGuard.unknown, unknownExpired: popupGuard.unknownExpired(), isExit })
            if (pb) {
              if (pb.verdictStep && !stepResults.some(s => s.step === '提示框')) stepResults.push({ step: '提示框', status: 'fail', message: pb.verdictStep, durationMs: 0 })
              if (pb.accountHalt && !this._haltReason) this._haltReason = `${machineCode} 帳號無法繼續使用（換帳號）：${pb.accountHalt}`
              if (pb.skip) { stepResults.push({ step: name, status: pb.skip.status, message: pb.skip.message, durationMs: 0 }); return false }
            }
            // 判斷在 verdicts.ts stepGateBlock（探針 open-round-probe）；檢查特殊狀態之前、之後各擋一次
            let block = stepGateBlock({ stopped: this.stopped, halt: openRoundHalt, isExit })
            if (!block) { await checkOsm(); block = stepGateBlock({ stopped: this.stopped, halt: openRoundHalt, isExit }) }
            if (!block) return true
            stepResults.push({ step: name, ...block, durationMs: 0 })
            return false
          }

          // ── 退出：一定要確認回到大廳才換下一台 ──────────────────────────────
          // ⚠️ 2026-09-24（DragonLaw）：舊版退出只重試 fail，「leaveGMNtc errcode=0 但 DOM 仍在遊戲內」
          //    是 WARN → 直接關掉換下一台 → 帳號其實還坐在 FG 裡 → 下一台一載入就回到這台，連鎖汙染。
          // 規則（使用者 2026-09-24 定案）：
          //   - 依 leaveGMNtc 的 errcode 分流，不能一律 Spin：
          //       0 且回到大廳 → 成功；25（玩家已不在機台上）且回到大廳 → 成功
          //       10002（遊戲進行中）或沒回到大廳且判定遊戲進行中 → 依設定檔動作推進遊戲，再試退出
          //       其他非 0（例如 AFT 轉出失敗）、Handpay → 不 Spin，停整批、人工處理
          //   - 「遊戲進行中」的證據要有一個：errcode 10002／OSMWatcher 特殊狀態／遊戲跳「cannot be quit」。
          //     沒有證據就只重試退出、不 Spin（一般狀態下 Spin 是真的付費下注）。
          //   - 上限從**第一次退出失敗**起算、重試不重置：20 分鐘或 150 次操作，到了就停整批告警。
          const EXIT_MAX_MS = 20 * 60 * 1000
          const EXIT_STUCK_RETRIES = 3
          const EXIT_MAX_ACTS = 150
          // 盲推（機台不在影像辨識監控時連續按 SPIN 推 feature）的整台上限：0259 實測 5 輪約 60 下推完，留 1.6 倍餘裕。
          // 扣款上限：BZZF 一般 Spin 約 7,000/下（0234 三下 -21,200），100,000 ≈ 14 下付費 Spin。
          // 單把估價 10,000 → 剩餘額度不到一把就不按（硬上限，最後一把也不會超過 BLIND_MAX_SPEND）。
          const BLIND_MAX_PRESSES = 96
          const BLIND_MAX_SPEND = 100_000
          const BLIND_SPIN_COST = 10_000
          // 每次退出嘗試的截圖都收起來（停批／失敗的回傳物件是重組的，不會帶到最後一次的 extraData）
          const exitShotsAll: string[] = []
          const exitUntilLobby = async (): Promise<StepResult> => {
            const t0 = Date.now()
            let firstFailAt = 0
            let acts = 0
            const blind: BlindBurstState = { presses: 0, bal0: undefined }
            let retryStreak = 0   // 連續「沒有遊戲進行中證據」的退出失敗次數；中間有推進遊戲就歸零
            let exitRescued = false   // 1003：特殊遊戲卡住救援每台只做一次
            // 1006 ARUZE：退出被擋、遊戲進行中 → 先照機種點位清單點觸屏（JP 選元寶／FG 選卡），每格最多點一次；
            // 有進展後 60 秒內不再點（讓 FG 自己跑、走原本的推進流程），清單點完就只走原本流程
            const featureCfg = featureTapsConfig(machineCode)
            let feat = exitFeatureState(featureCfg?.points.length ?? 0)   // 每一輪推不推、怎麼推：verdicts.ts planExitAdvance
            const playbookTried = new Set<string>()   // 每條已學處理每台只試一次，試過還卡就交給人
            for (let attempt = 1; ; attempt++) {
              const trace: ExitTrace = { file: `${this.sessionPrefix}${machineCode}`, attempt, shots: [] }
              // 測試用（1003）：MT_FAKE_EXIT_STUCK=<機台代碼> → 這台不按退出、假裝退出失敗（帳號真的會留在機台上），用來實測「帳號卡住 → 換帳號續跑」
              const fakeStuck = process.env.MT_FAKE_EXIT_STUCK === machineCode
              if (fakeStuck) emit(`（測試）MT_FAKE_EXIT_STUCK：不按退出，假裝第 ${attempt} 次退出失敗`)
              const r = fakeStuck
                ? { step: '退出測試', status: 'fail' as const, message: '（測試）假裝退出失敗', durationMs: 0 }
                : await stepExit(page, emit, profile?.exitSelector ?? null, waitForLeaveGM, trace)
              exitShotsAll.push(...trace.shots)
              const code = parseLeaveErrcode(r.message)
              const inGame = await isInGame(page)
              if (this.stopped && inGame) {
                return { step: '退出測試', status: 'fail', message: `使用者中止：未確認已離機 — ${r.message}`, durationMs: Date.now() - t0 }
              }
              const tip = inGame ? await dismissGameTips(page, emit) : null
              const d = decideExit({ passed: r.status === 'pass', inGame, code, osm: this.osmStatus.get(machineCode), tip })
              if (d.kind === 'done') {
                const extra = [d.note, attempt > 1 ? `第 ${attempt} 次退出成功，期間推進遊戲 ${acts} 次` : ''].filter(Boolean).join('；')
                return extra ? { ...r, status: 'pass', message: `${r.message}（${extra}）`, durationMs: Date.now() - t0 } : { ...r, status: 'pass' }
              }
              if (d.kind === 'unconfirmed') {
                return { step: '退出測試', status: 'warn', message: `${d.note}（${r.message.slice(0, 60)}）——請人工確認這台已離機、額度已轉出`, durationMs: Date.now() - t0 }
              }
              if (d.kind === 'halt') {
                // 使用者 1003：Handpay／AFT 也不停批——帳號留在這台（額度可能還在機台上），batch 換帳號跑剩下的
                this._haltReason = `${machineCode} 退出異常（帳號卡在這台）：退出受阻——${d.reason}｜⚠️ 額度可能還在機台上`
                return { step: '退出測試', status: 'fail', message: `🛑 ${this._haltReason}；未做任何 Spin（${r.message.slice(0, 80)}）`, durationMs: Date.now() - t0 }
              }

              if (!firstFailAt) firstFailAt = Date.now()
              if (Date.now() - firstFailAt > EXIT_MAX_MS || acts >= EXIT_MAX_ACTS) {
                this._haltReason = `${machineCode} 退出異常（帳號卡在這台）：退出超過上限（${((Date.now() - firstFailAt) / 60000).toFixed(1)} 分鐘／推進 ${acts} 次）仍未回到大廳｜⚠️ 額度可能還在機台上`
                return { step: '退出測試', status: 'fail', message: `🛑 ${this._haltReason}，最後一次：${r.message}`, durationMs: Date.now() - t0 }
              }

              if (d.kind === 'retry') {
                // 使用者 1003：不要硬試 20 分鐘再停批——「沒有遊戲進行中的證據」連續 EXIT_STUCK_RETRIES 次就停手，
                // 標成「退出異常、帳號卡在這台」，batch 會立刻回報＋換帳號跑剩下的（1565 那次卡了 32 次、20 分鐘）。
                // 有遊戲進行中證據（feature/FG）的不走這裡，照舊推進遊戲＋20 分鐘上限——那時換帳號會把額度留在機台上。
                // 1006 CodeX：JP／FG 觸屏推進後的觀察期，手冊動作也不做、連續失敗也不累計（判定在 verdicts.ts inFeatureHold）
                if (inFeatureHold(feat, Date.now())) {
                  emit(`退出未完成（第 ${attempt} 次）：觸屏推進後觀察中（剩 ${Math.ceil((feat.holdUntil - Date.now()) / 1000)}s），不套手冊、不做任何推進，5 秒後再試退出`)
                  await sleep(5000)
                  continue
                }
                retryStreak++
                if (retryStreak >= EXIT_STUCK_RETRIES) {
                  // 症狀簽名＝最後一次停在畫面上的文字（end 那張之前的最後狀態）＋WS 停在哪一步
                  const sigTexts = trace.texts ?? [], sigWs = trace.wsStage
                  const sig = `畫面「${sigTexts.join(' / ') || '沒有彈框文字'}」｜WS ${sigWs ?? '未知'}`
                  const pb = matchExitPlaybook(loadExitPlaybook(), sigTexts, sigWs)
                  if (pb && !playbookTried.has(pb.name)) {
                    playbookTried.add(pb.name)
                    emit(`📘 套用已學處理「${pb.name}」（${JSON.stringify(pb.action)}，學自 ${pb.learnedFrom ?? '?'}）｜症狀 ${sig}`)
                    await applyPlaybookAction(page, pb.action, emit)
                    retryStreak = 0
                    await sleep(3000)
                    continue
                  }
                  const tried = playbookTried.size ? `；已試過手冊「${[...playbookTried].join('、')}」仍不行` : ''
                  this._haltReason = `${machineCode} 退出異常（帳號卡在這台）：連續 ${retryStreak} 次退出都沒回到大廳、看不出遊戲進行中｜症狀 ${sig}${tried}`
                  return { step: '退出測試', status: 'fail', message: `🆘 ${this._haltReason}，最後一次：${r.message}`, durationMs: Date.now() - t0 }
                }
                emit(`退出未完成（第 ${attempt} 次，${r.message.slice(0, 60)}）：沒有遊戲進行中的證據 → 不 Spin，5 秒後重試退出`)
                await sleep(5000)
                continue
              }

              retryStreak = 0
              // CodeX 1006（兩輪 review）：這一輪推不推、怎麼推只聽 planExitAdvance——
              //   handOff＝觸屏推進量不到 → 結束本台自動操作、待人工確認；hold＝有進展後 60 秒觀察期，所有推進都不做
              const plan = planExitAdvance(feat, Date.now(), !!featureCfg && !this.stopped && (profile?.bonusAction ?? 'spin') !== 'auto_wait')
              if (plan === 'handOff') {
                this._haltReason = `${machineCode} 退出異常（帳號卡在這台）：JP／FG ${feat.handOff}，已停止所有自動操作｜⚠️ 待人工確認畫面與額度`
                return { step: '退出測試', status: 'fail', message: `🆘 ${this._haltReason}（推進 ${acts} 次）`, durationMs: Date.now() - t0 }
              }
              if (plan === 'hold') {
                emit(`退出未完成（第 ${attempt} 次）：觸屏推進後觀察中（剩 ${Math.ceil((feat.holdUntil - Date.now()) / 1000)}s），不做任何推進，5 秒後再試退出`)
                await sleep(5000)
                continue
              }
              if (plan === 'featureTap' && featureCfg) {
                let roundTaps = 0
                // 每一下點之前都查：停止、整台時限、動作上限（含這一輪已點的）
                const guard = () => this.stopped || Date.now() - firstFailAt > EXIT_MAX_MS || acts + roundTaps >= EXIT_MAX_ACTS
                const fr = await featureTapRound(page, emit, featureCfg, feat.cursor, () => false, guard, `退出未完成（第 ${attempt} 次）：遊戲進行中（${d.why}）`, () => { roundTaps++ })
                acts += roundTaps
                const next = applyFeatureRound(feat, fr, Date.now())
                feat = next.state
                if (next.then === 'handOff') {
                  // CodeX 第三輪 P1：**當輪**就結束——不能 continue，下一輪會先跑 stepExit（點 Cashout／Confirm）與手冊動作
                  this._haltReason = `${machineCode} 退出異常（帳號卡在這台）：JP／FG ${feat.handOff}，已停止所有自動操作｜⚠️ 待人工確認畫面與額度`
                  return { step: '退出測試', status: 'fail', message: `🆘 ${this._haltReason}（推進 ${acts} 次）`, durationMs: Date.now() - t0 }
                }
                if (next.then === 'retryExit') continue
                if (fr.result === 'exhausted') emit(`觸屏點位清單點完（${featureCfg.points.length} 格）都沒有進展 → 改走設定檔推進`)
              }
              emit(`退出未完成（第 ${attempt} 次）：遊戲進行中（${d.why}）→ 依設定檔推進遊戲後再試退出`)
              if ((profile?.bonusAction ?? 'spin') === 'auto_wait') {
                // 1003：被動等了 2 分鐘還被擋 → 截圖 OCR 判斷怎麼推、自己學（只救一次）；學到就改 profile，下一輪改走推進流程
                if (!exitRescued && firstFailAt && Date.now() - firstFailAt >= BONUS_STALL_MS) { exitRescued = true; await stallRescue() }
                await sleep(10000)  // 設定檔要求被動等待
              } else if (!OSM_SEEN_AT.has(machineCode)) {
                // 0930 BZZF 0254/0243 實況：不在影像辨識監控的機台，tracker 沒有觀測 → 按一下就判「已結束」→ 回去試退出（~30 秒）
                // → 等於 35 秒才推一下，feature 要推好幾分鐘，期間 agent 斷線整批停擺。使用者：「直接 SPIN 到結束」。
                // 改成：有遊戲進行中證據（10002／cannot be quit）時連續推 60 秒（每 5 秒一下）再試退出；推完仍被擋就再來一輪。
                // 代價：feature 在這 60 秒中途結束的話，剩下的幾下是一般付費 Spin（最多約 11 下）。
                // CodeX 0930：成本要有界——付費 Spin 可能再中 feature、跨輪累積。整台另外設盲推總次數與扣款上限，
                // 每一下都看停止／Handpay；任一條觸發就停整批（不換台，帳號可能還坐在這台）。
                // 整台總時限沿用 EXIT_MAX_MS（20 分）。扣款用機台內餘額（readMachineBalance：moneyNtc／Cash out credit，Spin 步驟同一個來源）；讀不到就停批（CodeX：無法確認就不按）。
                // 流程在 verdicts.ts runBlindBurst（探針 scripts/blind-burst-probe.ts 模擬各停止條件）
                emit(`不在影像辨識監控：連續推進 60 秒（每 5 秒一下）再試退出｜本台盲推累計 ${blind.presses}/${BLIND_MAX_PRESSES} 下`)
                const b = await runBlindBurst({
                  state: blind, maxPresses: BLIND_MAX_PRESSES, maxSpend: BLIND_MAX_SPEND, spinCost: BLIND_SPIN_COST,
                  burstMs: 60_000, intervalMs: 5000, now: Date.now, sleep: async ms => { await sleep(ms) },
                  isStopped: () => this.stopped,
                  deadlineExceeded: () => Date.now() - firstFailAt > EXIT_MAX_MS || acts >= EXIT_MAX_ACTS,
                  bodyText: () => page.evaluate(() => document.body?.innerText ?? '').catch(() => ''),
                  readBalance: () => readMachineBalance(page),   // 1007：只用機台內餘額（0330：大廳錢包蓋掉機台餘額，算成少 315 億）
                  press: async () => {
                    await dismissGameTips(page, emit)
                    // 兩段式機種（bonus-sequence.json thenSpin）點完觸屏後的那一下 SPIN：此刻重新檢查停止／Handpay／次數／剩餘額度，
                    // 跟盲推每一下前的關卡同一套，而且按了就計入次數（CodeX 0930）
                    const extraSpinGuard = async () => {
                      // 判定在 verdicts.ts extraSpinDecision（探針 touch-then-spin-probe 含 Handpay／次數已滿）；這裡只讀狀態
                      const d = extraSpinDecision({
                        stopped: this.stopped, presses: blind.presses, maxPresses: BLIND_MAX_PRESSES,
                        bodyText: await page.evaluate(() => document.body?.innerText ?? '').catch(() => ''),
                        bal: await readMachineBalance(page), bal0: blind.bal0,
                        maxSpend: BLIND_MAX_SPEND, spinCost: BLIND_SPIN_COST,
                      })
                      if (d.ok) { blind.presses++; acts++ }
                      return d
                    }
                    await doBonusAction(page, profile, emit, extraSpinGuard)
                    acts++
                  },
                })
                if (b.halt) {
                  // 使用者按停止＝真的停，不換帳號續跑；其他（上限、Handpay、讀不到餘額）一樣換帳號
                  this._haltReason = b.halt === '收到停止指令' ? `${machineCode} 盲推 feature 中止：${b.halt}` : `${machineCode} 退出異常（帳號卡在這台）：盲推 feature 中止——${b.halt}｜⚠️ 額度可能還在機台上`
                  return { step: '退出測試', status: 'fail', message: `🛑 ${this._haltReason}（本台已推 ${blind.presses} 下）`, durationMs: Date.now() - t0 }
                }
              } else {
                // 推進到特殊狀態確認結束（tracker：連續 8 秒正常且有新觀測），最多 90 秒一段，然後回去試退出。
                // 每一下點擊都算進 EXIT_MAX_ACTS（含補點）。
                // 證據只來自 10002／提示框、OSMWatcher 沒顯示特殊狀態時：只推第一下，之後交給退出重試判斷。
                const tracker = new OsmBonusTracker(this.osmStatus, machineCode)
                const chunkEnd = Date.now() + 90_000
                let lastAct = 0
                while (Date.now() < chunkEnd && !this.stopped && acts < EXIT_MAX_ACTS) {
                  const t = tracker.tick()
                  if (lastAct && t.ended) break
                  if (Date.now() - lastAct > 3000 && (lastAct === 0 || tracker.mayAct(t))) {
                    // 0929 0278 實況：試退出會跳「cannot be quit」提示框，原本先按 SPIN 才關提示框 → SPIN 全按在提示框上、feature 一直沒開始。先關再按。
                    await dismissGameTips(page, emit)
                    await doBonusAction(page, profile, emit)
                    tracker.noteAct()
                    acts++
                    lastAct = Date.now()
                  }
                  if (tracker.gaveUpClicking) { emit(`⚠️ 推進 ${MAX_ACTS_WITHOUT_CHANGE} 次 OSMWatcher 狀態都沒變化，停止補點`); break }
                  await sleep(1000)
                  await dismissGameTips(page, emit)
                }
              }
            }
          }

          // 進機台就開錄，退出前才停——這樣即使 Spin 沒觸發，進場/iDeck/觸屏的音效都還在錄音裡。
          // 這一份只負責「留下整段素材＋印出量測值」，**不參與 PASS/FAIL 判定**：
          // 合格門檻還沒校準（只有正常樣本、沒有已知異常樣本，訂了也不知道抓不抓得到異常）。
          let sessionRec: SessionRecording | null = null
          if (this.sessionAudioEnabled) {
            sessionRec = startSessionRecording(machineCode)
            if (sessionRec) emit(`🎙 整段錄音已開始（進機台 → 退出）`)
          }

          if (steps.stream && await stepGate('推流檢測')) {
            const r2 = await capture(() => stepStream(page, emit, profile, machineCode, this.sessionPrefix))
            stepResults.push(r2)
            this.log(`${workerTag} [${r2.status.toUpperCase()}] 推流: ${r2.message}`, machineCode)
          }

          const spinAudioRef: SpinAudioRef = { data: null }
          // 0930 使用者：機台停在選面額選單時 SPIN 本來就無效 → Spin 前先過選單閘門（verdicts.ts runMenuGate，探針 scripts/menu-gate-probe.ts）
          let menuGateTouchFail: string | null = null
          if (steps.spin && await stepGate('Spin 測試')) {
            const gate = await spinMenuGate(page, emit, machineCode, profile, () => this.stopped)
            if (gate.state === 'touchNoResponse') {
              menuGateTouchFail = gate.note
              const r3: StepResult = { step: 'Spin 測試', status: 'skip', message: `未驗：${gate.note}，沒按 SPIN（選單開著時 SPIN 無效）`, durationMs: 0 }
              stepResults.push(r3)
              this.log(`${workerTag} [SKIP] Spin: ${r3.message}`, machineCode)
            } else {
              emit(`Spin 前選單閘門：${gate.state}｜${gate.note}`)   // 1003：一律記，才知道閘門有沒有認出選單
              // 1008 使用者硬規則「SPIN 一律用最小注」：先把面額／Credits／倍數按到最小並確認，確認不了就不按 SPIN（判未驗）
              const minBet = await ensureMinBet(page, emit, () => this.stopped)
              let r3: StepResult
              if (minBet.ok === false) {
                r3 = { step: 'Spin 測試', status: 'skip', message: `未驗：沒按 SPIN——無法確認是最小注（${minBet.why}）｜使用者規則：SPIN 一律最小注，不確定就不下注`, durationMs: 0 }
              } else {
                r3 = await capture(() => stepSpin(page, emit, profile?.spinSelector ?? null, profile?.balanceSelector ?? null, steps.audio ? spinAudioRef : undefined, aiAudio))
                r3 = { ...r3, message: `${r3.message}｜${minBet.note}` }
              }
              // CodeX 0930：判斷不了選單時照原流程按，但要留註記——不能當成已排除選單干擾（batch 看到這段就不判 spin no response）
              if (gate.state === 'unknown' && /選單狀態未知/.test(gate.note)) r3 = { ...r3, message: `${r3.message}｜${gate.note}` }
              // 1003：自動學到的選單（參考圖＋比對區／關選單的觸屏格）交給 batch 寫回機種設定
              if (gate.learn) r3 = { ...r3, extraData: { ...(r3.extraData ?? {}), menuLearn: JSON.stringify(gate.learn) } }
              stepResults.push(r3)
              this.log(`${workerTag} [${r3.status.toUpperCase()}] Spin: ${r3.message}`, machineCode)
            }
          }

          if (steps.audio && await stepGate('音頻檢測')) {
            let r4 = await capture(() => stepAudio(page, emit, spinAudioRef, aiAudio, machineCode, this.sessionPrefix, profile?.audioConfig))
            // 1008 使用者：判成 no sound（VB-Cable 真靜音）就再 Spin 重錄，最多再 2 次（見 audioSilenceRetry）
            r4 = await audioSilenceRetry({
              page, emit, first: r4, firstRef: spinAudioRef,
              spinStep: stepResults.find(x => x.step === 'Spin 測試'),
              spinOnce: ref => stepSpin(page, emit, profile?.spinSelector ?? null, profile?.balanceSelector ?? null, ref, aiAudio, 1),
              audioOf: ref => stepAudio(page, emit, ref, aiAudio, machineCode, this.sessionPrefix, profile?.audioConfig),
              stopped: () => this.stopped,
            })
            stepResults.push(r4)
            this.log(`${workerTag} [${r4.status.toUpperCase()}] 音頻: ${r4.message}`, machineCode)
          }

          if (steps.ideck && await stepGate('iDeck 測試')) {
            const ideckXpaths = (profile?.ideckXpaths ?? []).length > 0 ? profile!.ideckXpaths! : this.betRandomConfig[machineCode]
            // 1007 iDeck 時間學習：機種學習值；本 session 已撤銷（agent 每台新建 runner，所以記在模組層、依 session 分）
            const ideckType = extractMachineType(machineCode).toUpperCase()
            const revokedMap = IDECK_REVOKED.get(this.sessionKey) ?? new Map<string, string>()
            IDECK_REVOKED.set(this.sessionKey, revokedMap)
            const ideckTiming = {
              cfg: this.ideckTimings[ideckType] ?? null,
              revoked: revokedMap.get(ideckType) ?? (this.ideckNoFast.has(ideckType) ? '撤銷沒寫進中控，本批禁用短等待' : null),
              onRevoke: (reason: string) => { revokedMap.set(ideckType, reason) },
            }
            const r6 = await stepIdeck(page, emit, machineCode, profile, waitForIdeckCmd, ideckXpaths, () => this.stopped, this.debugGmid ?? undefined, this.sessionPrefix, openRound, ideckTiming)
            stepResults.push(r6)
            this.log(`${workerTag} [${r6.status.toUpperCase()}] iDeck: ${r6.message}`, machineCode)
          }

          if (steps.touchscreen && menuGateTouchFail) {
            // Spin 前的閘門已經點過觸屏、選單都沒關 → 使用者定義就是 touchscreen no response，不再重點一次
            const r7: StepResult = { step: '觸屏測試', status: 'fail', message: `【Spin 前選單閘門】${menuGateTouchFail}｜判定：no response`, durationMs: 0 }
            stepResults.push(r7)
            this.log(`${workerTag} [FAIL] 觸屏: ${r7.message}`, machineCode)
          } else if (steps.touchscreen && await stepGate('觸屏測試')) {
            const r7 = await stepTouchscreen(page, emit, machineCode, profile, () => this.stopped, this.debugGmid ?? undefined, this.sessionPrefix)
            stepResults.push(r7)
            this.log(`${workerTag} [${r7.status.toUpperCase()}] 觸屏: ${r7.message}`, machineCode)
          }

          if (steps.cctv && await stepGate('CCTV 號碼比對')) {
            const r8 = await capture(() => stepCctv(page, emit, machineCode, this.sessionPrefix))
            stepResults.push(r8)
            this.log(`${workerTag} [${r8.status.toUpperCase()}] CCTV: ${r8.message}`, machineCode)
          }

          // 停整段錄音——要在退出**之前**停，退出之後的聲音跟這台機台無關
          if (sessionRec) {
            const wav = await stopSessionRecording(sessionRec)
            sessionRec = null
            if (wav && existsSync(wav)) {
              try {
                mkdirSync(AUDIO_SAVE_DIR, { recursive: true })
                const name = `${this.sessionPrefix}${machineCode}-session.wav`
                writeFileSync(join(AUDIO_SAVE_DIR, name), readFileSync(wav))
                const a = analyzeWav(wav)
                emit(`🎙 整段錄音：${name}（RMS ${a.rmsDb.toFixed(1)} dB／峰值 ${a.peakDb.toFixed(1)} dB／`
                  + `Clip ${(a.clipRatio * 100).toFixed(2)}%／重心 ${Math.round(a.spectralCentroid)} Hz）`)
                emit(`（整段錄音只做記錄，不參與判定——合格門檻尚未校準）`)
                unlinkSync(wav)
              } catch (e) {
                emit(`整段錄音存檔失敗（不影響判定）：${String(e).slice(0, 120)}`)
              }
            } else {
              emit(`整段錄音沒有產出檔案（不影響判定）`)
            }
          }

          if (steps.exit && await stepGate('退出測試')) {
            const r5raw = await exitUntilLobby()
            const r5ex = { ...(r5raw.extraData ?? {}), ...(exitShotsAll.length ? { exitShots: JSON.stringify(exitShotsAll) } : {}), ...(bonusLearned ? { bonusLearn: JSON.stringify(bonusLearned) } : {}) }
            const r5 = Object.keys(r5ex).length ? { ...r5raw, extraData: r5ex } : r5raw
            stepResults.push(r5)
            this.log(`${workerTag} [${r5.status.toUpperCase()}] 退出: ${r5.message}`, machineCode)
          }
          flushPopupNotes()
          detachPopupGuard(page)
        }
      }
    } catch (e) {
      if (this.stopped) {
        emit(`測試已被中止（${String(e).slice(0, 80)}）`)
        stepResults.push({ step: '測試流程', status: 'fail', message: '使用者中止：瀏覽器已關閉，未確認已離機（位子可能仍被佔用，請到大廳確認）', durationMs: 0 })
      } else {
        emit(`測試例外: ${e}`)
        stepResults.push({ step: '測試流程', status: 'fail', message: String(e), durationMs: 0 })
      }
    } finally {
      detachPopupGuard(page)
      await ctx.close().catch(() => { /* browser already closed by stop() */ })
    }

    const overall: StepStatus =
      stepResults.some(r => r.status === 'fail') ? 'fail'
      : stepResults.some(r => r.status === 'warn') ? 'warn'
      : 'pass'

    const result: MachineResult = { machineCode, overall, steps: stepResults, consoleLogs, startedAt, finishedAt: new Date().toISOString(), sessionId: this.sessionPrefix.replace(/-$/, '') || undefined }
    this.send({ type: 'machine_done', machineCode, status: overall, message: `${workerTag} ${machineCode} 測試完成：${overall.toUpperCase()}`, result, ts: new Date().toISOString() })
  }

  /** One worker: keeps pulling from the shared queue until empty */
  private async runWorker(browser: Browser, queue: MachineQueue, lobbyUrl: string, workerId: number, steps: MachineTestSession['steps'], aiAudio = false): Promise<void> {
    this.log(`[Worker-${workerId}] 啟動（大廳：${lobbyUrl.slice(0, 60)}...）`)
    while (!this.stopped) {
      const machineCode = queue.next()
      if (!machineCode) break
      await this.runMachine(browser, machineCode, lobbyUrl, workerId, steps, aiAudio)
      if (this._haltReason) {
        this.send({ type: 'error', message: `🛑 ${this._haltReason}——本批次後面的機台不再測試`, ts: new Date().toISOString() })
        break
      }
      if (!this.stopped) await sleep(800)
    }
    this.log(`[Worker-${workerId}] 完成，離開`)
  }

  async run(session: MachineTestSession) {
    setIdeckCapture(session.ideckCapture === true)
    this.debugGmid = session.debugGmid?.trim() || null
    this.ideckTimings = session.ideckTimings ?? {}
    this.ideckNoFast = new Set((session.ideckNoFast ?? []).map(t => t.toUpperCase()))
    this.sessionKey = session.sessionId ?? ''
    this.sessionPrefix = session.sessionId ? `${session.sessionId}-` : ''
    DAILY_ANALYSIS_BASE = DAILY_ANALYSIS_URLS[session.osmEnv ?? 'qat'] ?? DAILY_ANALYSIS_URLS.qat
    // Notify viewers that a new session is starting (clears previous results)
    this.send({ type: 'session_start', message: `開始測試 ${session.machineCodes.length} 台機器`, ts: new Date().toISOString() })
    if (this.debugGmid) this.log(`[調適模式] daily-analysis 渠道號固定為：${this.debugGmid}（機台代碼前綴替換）`)
    this.log(`📡 日誌 API 環境：${(session.osmEnv ?? 'qat').toUpperCase()} (${DAILY_ANALYSIS_BASE})`)
    let browser: Browser | null = null
    let originalAudioDevice = ''
    const useVBCable = existsSync(NIRCMD) && session.steps.audio
    this.sessionAudioEnabled = useVBCable && session.lobbyUrls.length === 1
    // Reset serial audio queue for this run
    audioRecordingQueue = Promise.resolve()
    try {
      const workerCount = session.lobbyUrls.length
      this.log(`啟動瀏覽器（${workerCount} 個 Worker，共 ${session.machineCodes.length} 台機器）...`)

      // OSMWatcher 連線狀態確認
      const osmCount = this.osmStatus.size
      if (osmCount > 0) {
        this.log(`✅ 圖像識別服務已連線（OSMWatcher 監控中 ${osmCount} 台機台）— 特殊遊戲偵測已啟用`)
        // ⚠️ 2026-09-21：「服務有連線」跟「**這幾台**有被監控」是兩件事。
        //    checkOsm() 對「查不到這台」和「狀態正常」的處理一模一樣——都直接放行、不留訊息，
        //    於是機台真的進了 FG/JP 也偵測不到，卡在裡面退不出來，再連鎖污染下一台。
        //    這裡把「要測但沒被監控」的機台明白列出來，不要讓上面那行綠字造成錯覺。
        const unmonitored = session.machineCodes.filter(c => !this.osmStatus.has(c))
        if (unmonitored.length > 0) {
          this.log(`⚠️ 下列 ${unmonitored.length} 台**不在影像辨識監控範圍**，FG／JP 無法偵測，`
            + `若機台進入特殊遊戲會退不出來並污染下一台：${unmonitored.join(', ')}`)
        }
      } else {
        this.log(`⚠️ 圖像識別服務未連線（OSMWatcher 未回報任何機台）— Spin 後不會等待特殊遊戲結束`)
      }

      if (useVBCable && workerCount > 1) {
        this.log(`⚠️ 音頻測試已啟用，但偵測到 ${workerCount} 個並行 Worker。VB-Cable 為共享設備，錄音將依序執行（一次一台），以確保每台機器的音頻獨立測量。`)
      }

      // If VB-Cable is available and audio test is enabled, route browser audio through it
      if (useVBCable) {
        originalAudioDevice = await getDefaultAudioDevice()
        await setDefaultAudio(CABLE_DEVICE)
        this.log(`🎙 已將系統音頻輸出切換至 VB-Cable（原設備：${originalAudioDevice}）`)
      }

      const launchArgs = [
        '--autoplay-policy=no-user-gesture-required',
        '--disable-web-security',
        '--no-mute-audio',
      ]
      if (!session.headedMode) {
        launchArgs.push('--window-position=-32000,-32000', '--window-size=428,739')
      }
      if (session.headedMode) {
        this.log('👀 Headed 模式已啟用：瀏覽器視窗將顯示在螢幕上')
      }
      browser = await chromium.launch({ headless: false, args: launchArgs })
      this.browser = browser

      const queue = new MachineQueue(session.machineCodes)
      const workerPromises = session.lobbyUrls.map((url, i) =>
        sleep(i * 1500).then(() => this.runWorker(browser!, queue, url, i + 1, session.steps, session.aiAudio ?? false))
      )

      await Promise.all(workerPromises)
    } catch (e) {
      this.send({ type: 'error', message: `Runner 例外: ${e}`, ts: new Date().toISOString() })
    } finally {
      await browser?.close()
      if (useVBCable && originalAudioDevice) {
        await setDefaultAudio(originalAudioDevice)
        this.log(`🔊 已還原系統音頻輸出至：${originalAudioDevice}`)
      }
      this.send({ type: 'session_done', message: '所有機台測試完成', ts: new Date().toISOString() })
    }
  }
}
