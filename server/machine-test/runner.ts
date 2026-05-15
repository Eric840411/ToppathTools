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
import { spawn } from 'child_process'
import { readFileSync, existsSync, unlinkSync, writeFileSync, mkdirSync } from 'fs'
import { join, basename } from 'path'
import { chromium, type Browser, type Page, type ElementHandle } from 'playwright'
import type { MachineTestSession, MachineResult, StepResult, StepStatus, TestEvent, MachineProfile } from './types.js'
import { callGeminiVision, callGeminiVisionMulti } from '../routes/gemini.js'

// ─── OS-level audio capture via VB-Cable ─────────────────────────────────────

const NIRCMD  = 'C:\\Users\\user\\AppData\\Local\\nircmd\\nircmd.exe'
const MACHINE_TEST_ROOT = join(process.cwd(), 'server', 'machine-test')
const RECORD_SCRIPT = join(MACHINE_TEST_ROOT, 'record-spin.ps1')
const CABLE_DEVICE  = 'CABLE Input (VB-Audio Virtual Cable)'
const CCTV_SAVE_DIR  = join(MACHINE_TEST_ROOT, 'cctv-saves')
const AUDIO_SAVE_DIR = join(MACHINE_TEST_ROOT, 'audio-saves')
const CCTV_REFS_DIR  = join(MACHINE_TEST_ROOT, 'cctv-refs')
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
  try {
    await fetch(`${httpBase}${endpoint}?filename=${encodeURIComponent(filename)}`, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: buf,
    })
  } catch (e) {
    console.error(`[Agent] upload failed (${endpoint}):`, e)
  }
}

const uploadAudioToServer = (buf: Buffer, filename: string) =>
  uploadToServer(buf, '/api/machine-test/audio-upload', filename, 'audio/wav')

const uploadCctvToServer = (buf: Buffer, filename: string) =>
  uploadToServer(buf, '/api/machine-test/cctv-upload', filename, 'image/png')

/** Serial queue: ensures only one VB-Cable recording runs at a time.
 *  Multiple workers share the same CABLE device, so concurrent recordings mix signals. */
let audioRecordingQueue: Promise<unknown> = Promise.resolve()

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
 * Handle bonus round: execute the configured bonus action ONCE, then keep spinning
 * until OSMWatcher status returns to 0 (or 3-minute timeout).
 * Returns { waited, label } or null if OSMWatcher not connected / already normal.
 *
 * Flow:
 *  1. Execute the profile's bonusAction one time (spin / takewin / touchscreen).
 *  2. Then spin every ~3s until status=0 (bonuses typically require continued spins to complete).
 *  3. auto_wait: skip step 1 and 2 — just passively wait for status=0.
 */
async function waitForNormalStatus(
  osmStatus: Map<string, number>,
  machineCode: string,
  page: Page,
  profile: MachineProfile | undefined,
  emit: (msg: string) => void
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
  const bonusAction = profile?.bonusAction ?? 'auto_wait'
  const spinSel = profile?.spinSelector || '.my-button.btn_spin, .btn_spin .my-button, .btn_spin, [class*="btn_spin"] .my-button, [class*="btn_spin"]'
  emit(`偵測到特殊狀態：${label}，動作：${bonusAction}`)

  const start = Date.now()
  // Wait up to 15 min — no forced-continue WARN; real issues are caught by exit step
  const maxWait = 15 * 60 * 1000

  // ── Step 1: Execute the specified bonus action ONCE ──────────────────────
  if (bonusAction !== 'auto_wait') {
    try {
      if (bonusAction === 'spin') {
        await safeClick(page, spinSel)
        emit(`（執行特殊流程：Spin）`)
      } else if (bonusAction === 'takewin') {
        await safeClick(page, '.btn_takewin, [class*="takewin"], [class*="take-win"], [class*="take_win"]')
        emit(`（執行特殊流程：TakeWin）`)
      } else if (bonusAction === 'touchscreen') {
        const pts = profile?.touchPoints?.length ? profile.touchPoints : []
        for (const pt of pts) {
          try {
            const els = await page.$$(`//span[normalize-space(text())='${pt}']`)
            if (els.length > 0) {
              await page.evaluate((el: Element) => (el as HTMLElement).click(), els[0])
              emit(`（觸屏點擊: "${pt}"）`)
            } else {
              emit(`（找不到觸屏元素: "${pt}"，略過）`)
            }
          } catch { /* ignore */ }
          await sleep(800)
        }
        if (profile?.clickTake) {
          try { await safeClick(page, '.my-button.btn_take, .btn_take'); emit(`（點擊 Take）`) } catch { /* ignore */ }
        }
        if (pts.length > 0) emit(`（特殊流程觸屏完成: ${pts.join(' → ')}）`)
      }
    } catch { /* ignore click errors */ }
    await sleep(1000)
  }

  // ── Step 2: Spin continuously until OSM status=0 ─────────────────────────
  let lastSpinAt = 0
  while (Date.now() - start < maxWait) {
    await sleep(1000)
    const s = osmStatus.get(machineCode) ?? 0
    if (!BONUS_STATUSES.has(s)) {
      const waited = Date.now() - start
      emit(`特殊狀態結束，耗時 ${(waited / 1000).toFixed(0)}s，繼續 Spin 10 秒 cooldown...`)

      // ── Step 3: Spin 10s cooldown after status=0 ────────────────────────
      const cooldownEnd = Date.now() + 10_000
      while (Date.now() < cooldownEnd) {
        await sleep(1000)
        if (bonusAction !== 'auto_wait') {
          await safeClick(page, spinSel)
          emit(`（Cooldown Spin...）`)
          await sleep(2000)
        } else {
          await sleep(1000)
        }
      }
      emit(`Cooldown 完成，繼續下一步驟`)
      return { waited: Date.now() - start, label }
    }

    if (bonusAction !== 'auto_wait' && Date.now() - lastSpinAt > 3000) {
      lastSpinAt = Date.now()
      await safeClick(page, spinSel)
      emit(`（Spin 中，等待特殊遊戲結束...）`)
    }
  }

  // Exceeded 15 min — log and move on; exit step will catch real issues
  emit(`ℹ️ 等待超過 15 分鐘，強制繼續（退出步驟將驗證是否可正常離開）`)
  return { waited: maxWait, label }
}

async function safeClick(page: Page, selector: string): Promise<boolean> {
  try {
    const el = await page.$(selector)
    if (!el) return false
    await page.evaluate((e: Element) => (e as HTMLElement).click(), el)
    return true
  } catch {
    return false
  }
}

async function safeClickXPath(page: Page, xpath: string): Promise<boolean> {
  try {
    const els = await page.$$(xpath)
    for (const el of els) {
      if (await el.isVisible()) {
        await page.evaluate((e: Element) => (e as HTMLElement).click(), el)
        return true
      }
    }
    return false
  } catch {
    return false
  }
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
    const lobbySel = await page.$('#grid_gm_item')
    if (lobbySel && await lobbySel.isVisible()) return false
    for (const sel of ['.my-button.btn_spin', '.balance-bg.hand_balance', '.h-balance.hand_balance']) {
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

/** Create enter/leave GM event waiters backed by a shared WS frame listener. Must be called before page.goto(). */
function createGMEventWatcher(page: Page): { waitForEnterGM: GMWaitFn; waitForLeaveGM: GMWaitFn; waitForIdeckCmd: IdeckWaitFn } {
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

async function stepEntry(page: Page, machineCode: string, emit: (msg: string) => void, profile?: MachineProfile, waitForEnterGM?: GMWaitFn): Promise<StepResult> {
  const t0 = Date.now()
  try {
    emit(`等待大廳載入...`)
    // Wait for lobby game items
    try {
      await page.waitForSelector('#grid_gm_item', { timeout: 15000 })
    } catch {
      // Maybe already in game, or page hasn't fully loaded — check
      if (await isInGame(page)) {
        return { step: '進入機台', status: 'pass', message: '已在遊戲內', durationMs: Date.now() - t0 }
      }
      return { step: '進入機台', status: 'fail', message: '大廳載入超時（15s），找不到機台列表', durationMs: Date.now() - t0 }
    }

    emit(`在大廳尋找機台: ${machineCode}`)
    const items = await page.$$('#grid_gm_item')
    let found = false
    for (const item of items) {
      const title = await item.getAttribute('title')
      if (title && title.includes(machineCode)) {
        await item.scrollIntoViewIfNeeded()
        await page.evaluate((el: Element) => (el as HTMLElement).click(), item)
        emit(`點擊機台卡片: ${title}`)
        await sleep(1500)
        found = true

        // Try Join button
        try {
          const joinEls = await page.$$("//div[contains(@class,'gm-info-box')]//span[normalize-space(text())='Join']")
          for (const j of joinEls) {
            if (await j.isVisible()) {
              await page.evaluate((el: Element) => (el as HTMLElement).click(), j)
              emit(`點擊 Join 按鈕`)
              await sleep(3000)
              break
            }
          }
        } catch { /* Join may not exist */ }
        break
      }
    }

    if (!found) {
      return { step: '進入機台', status: 'fail', message: `大廳找不到機台代碼: ${machineCode}`, durationMs: Date.now() - t0 }
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
          await page.evaluate((e: Element) => (e as HTMLElement).click(), el)
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
          await page.evaluate((e: Element) => (e as HTMLElement).click(), el)
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
        return { step: '進入機台', status: 'pass', message: '成功進入遊戲（enterGMNtc errcode=0）', durationMs: Date.now() - t0, extraData }
      }
      return { step: '進入機台', status: 'fail', message: `進入失敗：enterGMNtc errcode=${enterEv.errcode} — ${enterEv.errcodedes}`, durationMs: Date.now() - t0, extraData }
    }

    // No GMN event received — fall back to DOM detection
    emit(`未收到 enterGMNtc，改用 DOM 偵測...`)
    if (await isInGame(page)) {
      return { step: '進入機台', status: 'warn', message: '成功進入遊戲（未收到 enterGMNtc，DOM 偵測）', durationMs: Date.now() - t0 }
    }
    await sleep(3000)
    if (await isInGame(page)) {
      return { step: '進入機台', status: 'warn', message: '成功進入遊戲（未收到 enterGMNtc，DOM 偵測）', durationMs: Date.now() - t0 }
    }
    return { step: '進入機台', status: 'fail', message: '已點擊機台但遊戲未載入（找不到 Spin 或 Balance 元素，且無 enterGMNtc）', durationMs: Date.now() - t0 }
  } catch (e) {
    return { step: '進入機台', status: 'fail', message: `例外: ${e}`, durationMs: Date.now() - t0 }
  }
}

async function stepStream(page: Page, emit: (msg: string) => void, profile?: MachineProfile): Promise<StepResult> {
  const t0 = Date.now()
  try {
    emit(`檢測推流（video / canvas）`)
    const result = await page.evaluate(() => {
      const videos = Array.from(document.querySelectorAll('video'))
      const canvases = Array.from(document.querySelectorAll('canvas'))

      const playingVideos = videos.filter(v => !v.paused && v.readyState >= 2 && v.videoWidth > 0)
      const activeCanvases = canvases.filter(c => c.width > 100 && c.height > 100)

      return {
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

    const hasStream = result.playingVideos > 0 || result.activeCanvases > 0
    const msg = `video: ${result.totalVideos}個（播放中: ${result.playingVideos}）/ canvas: ${result.totalCanvases}個（活躍: ${result.activeCanvases}）`

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
          durationMs: Date.now() - t0,
        }
      }
      // Count matches expected
      if (result.playingVideos > 0) {
        return { step: '推流檢測', status: 'pass', message: `${msg} — ${detail}（螢幕數 ✓ ${expectedScreens}）`, durationMs: Date.now() - t0 }
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (result.playingVideos > 0) {
      const detail = result.videoDetails.map(v => `${v.w}×${v.h}`).join(', ')
      return { step: '推流檢測', status: 'pass', message: `${msg} — ${detail}`, durationMs: Date.now() - t0 }
    } else if (result.activeCanvases > 0) {
      return { step: '推流檢測', status: 'warn', message: `無 <video> 播放，但有 canvas 畫面，可能為 WebGL 推流。${msg}`, durationMs: Date.now() - t0 }
    } else if (result.totalVideos > 0) {
      return { step: '推流檢測', status: 'fail', message: `有 ${result.totalVideos} 個 video 但均未播放（paused / buffering）`, durationMs: Date.now() - t0 }
    } else if (!hasStream) {
      return { step: '推流檢測', status: 'warn', message: `找不到 <video> 元素，可能此機型不使用影片推流`, durationMs: Date.now() - t0 }
    }
    return { step: '推流檢測', status: 'pass', message: msg, durationMs: Date.now() - t0 }
  } catch (e) {
    return { step: '推流檢測', status: 'fail', message: `例外: ${e}`, durationMs: Date.now() - t0 }
  }
}

/** Read visible credit balance text from the page, returns number or null.
 *  Mirrors Python's parse_balance: targets .text2 child specifically,
 *  strips commas, returns integer value.
 */
async function readBalance(page: Page, customSel?: string | null): Promise<number | null> {
  return page.evaluate((custom) => {
    const selectors = [
      ...(custom ? [custom] : []),
      // Special games (BULLBLITZ, ALLABOARD etc.) use .h-balance
      '.h-balance.hand_balance .text2',
      '.balance-bg.hand_balance .text2',
      // Fallback: container without .text2
      '.h-balance.hand_balance',
      '.balance-bg.hand_balance',
      '[class*="hand_balance"] .text2',
      '[class*="hand_balance"]',
    ]
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel)
      for (const el of els) {
        if ((el as HTMLElement).offsetParent === null) continue  // hidden
        const text = (el.textContent ?? '').replace(/,/g, '').trim()
        const nums = text.replace(/[^0-9]/g, '')
        const val = parseInt(nums, 10)
        if (!isNaN(val) && val >= 0) return val
      }
    }
    return null
  }, customSel ?? null)
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

async function stepSpin(page: Page, emit: (msg: string) => void, customSpinSel?: string | null, customBalanceSel?: string | null, spinAudioRef?: SpinAudioRef, aiAudio = false): Promise<StepResult> {
  const t0 = Date.now()
  try {
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

    // Read balance before spin
    const balanceBefore = await readBalance(page, customBalanceSel)
    emit(`Spin 前餘額：${balanceBefore !== null ? balanceBefore : '無法讀取'}`)

    // Record pre-spin baseline to detect contamination from other machines playing audio
    let baselineRmsDb: number | undefined
    if (spinAudioRef && existsSync(NIRCMD)) {
      const bl = await recordVBCableSerial(1000)
      if (bl) baselineRmsDb = bl.rmsDb
    }

    // Click spin 3 times — more reliable balance-change detection
    const SPIN_COUNT = 3

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

      await page.evaluate((el: Element) => (el as HTMLElement).click(), currentSpinEl)
      emit(`Spin ${spinIdx + 1}/${SPIN_COUNT} 已點擊，等待動畫完成...`)

      let spinStarted = false
      const deadline = Date.now() + 15000
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
      if (!spinStarted) {
        emit(`⚠️ Spin ${spinIdx + 1} 未偵測到按鈕 disabled，可能速度太快或 selector 不匹配`)
      }
      if (spinIdx < SPIN_COUNT - 1) await sleep(500)
    }

    // Ensure audio sample is done
    await audioSamplePromise

    // Wait a bit more for balance update
    await sleep(800)

    // Read balance after all spins
    const balanceAfter = await readBalance(page, customBalanceSel)
    emit(`${SPIN_COUNT} 次 Spin 後餘額：${balanceAfter !== null ? balanceAfter : '無法讀取'}`)

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

    return {
      step: 'Spin 測試',
      status: 'warn',
      message: `Spin 按鈕已找到並點擊 ${SPIN_COUNT} 次（無法讀取餘額，無法確認是否執行）`,
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

    // Save spin recording (already in base64) to local folder
    if (sa?.wavBase64 && audioSavePath) {
      try { writeFileSync(audioSavePath, Buffer.from(sa.wavBase64, 'base64')) } catch { /* non-fatal */ }
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
        const isTrueSilence = !isFinite(rmsDb) || rmsDb < -80 || (rmsDb < -60 && crestFactor < 6)
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
        const summary = `VB-Cable 錄音：RMS ${isFinite(rmsDb) ? rmsDb.toFixed(1) : '-∞'} dB，峰值 ${isFinite(sa.peakDb) ? sa.peakDb.toFixed(1) : '-∞'} dB，Crest ${crestFactor.toFixed(1)} dB，Clip ${(clipRatio * 100).toFixed(2)}%${blStr}${centroidStr}｜${sa.detail}`

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
            const aiRaw = await callGeminiVision(AUDIO_PROMPT, sa.wavBase64, 'audio/wav')
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

async function stepIdeck(
  page: Page,
  emit: (msg: string) => void,
  machineCode: string,
  profile: MachineProfile | undefined,
  _waitForIdeckCmd?: IdeckWaitFn,  // kept for signature compat, replaced by pollIdeckEvent
  betRandomXpaths?: string[],
  shouldStop?: () => boolean,
  debugGmid?: string,
): Promise<StepResult> {
  const t0 = Date.now()
  try {
    // Build button list: store XPath + frame index for lazy re-query at click time (avoids stale ElementHandle)
    // xpath: used at click time to re-query fresh; frameIdx: which frame the element was found in
    type BtnEntry = { label: string; xpath: string; frameIdx: number }
    let buttons: BtnEntry[] = []

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
    } else {
      const rowClass = profile?.ideckRowClass
      if (!rowClass) {
        return { step: 'iDeck 測試', status: 'skip', message: '此機種未設定 ideckRowClass 且無隨機下注 XPath，跳過', durationMs: 0 }
      }
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

    // Step 1: fetch baseline BEFORE clicking — record all existing iDeck entry times
    const today = toLocalDateStr(new Date())
    // debugGmid replaces only the channel prefix (first segment), e.g. "873-BULLBLITZ-0135" → "873-BZZF-0136"
    const effectiveGmid = debugGmid
      ? machineCode.replace(/^[^-]+/, debugGmid)
      : machineCode
    if (debugGmid) emit(`[調適模式] iDeck 日誌渠道號替換為 ${debugGmid}，gmid：${effectiveGmid}`)
    const apiUrl = `${DAILY_ANALYSIS_BASE}?gmid=${encodeURIComponent(effectiveGmid)}&date=${encodeURIComponent(today)}`

    const getIdeckTimes = async (): Promise<Set<string>> => {
      try {
        const res = await fetch(apiUrl)
        if (!res.ok) return new Set()
        const json = await res.json() as { data?: { timeline?: LogEntry[] } }
        const tl = json.data?.timeline ?? []
        return new Set(
          tl.filter(e => {
            if (e.type !== 'success_json') return false
            const d = typeof e.data === 'string' ? JSON.parse(e.data) as Record<string, unknown> : e.data
            return d?.is_ideck === true || d?.is_ideck === 1
          }).map(e => `${e.time}|${JSON.stringify(e.data)}`)
        )
      } catch { return new Set() }
    }

    const baselineKeys = await getIdeckTimes()
    emit(`基準線：點擊前已有 ${baselineKeys.size} 筆 iDeck 記錄`)

    /** After each btn_bet click, the game may show a denomination overlay (select-main).
     *  Clicking a denomination option IS part of the iDeck interaction — like AutoSpin.py's
     *  approach of handling select-main after cashout click.
     *  This helper checks all frames for the overlay and clicks the first option. */
    const dismissDenomOverlay = async (source: string): Promise<boolean> => {
      for (const frame of page.frames()) {
        try {
          const btns = await frame.$$('.select-main .select-btn, .select-main .my-button')
          if (btns.length > 0) {
            emit(`${source} → 面額選擇遮罩（${btns.length} 選項），點擊第一個...`)
            await btns[0].evaluate((node: Element) => (node as HTMLElement).click())
            await sleep(800)
            return true
          }
        } catch { /* frame detached */ }
      }
      return false
    }

    // Step 2: click all buttons — re-query fresh at click time to avoid stale ElementHandle
    emit(`共 ${buttons.length} 個按鈕，逐一點擊...`)
    const allFrames = page.frames()
    for (const { label, xpath, frameIdx } of buttons) {
      if (shouldStop?.()) return { step: 'iDeck 測試', status: 'skip', message: '已停止', durationMs: Date.now() - t0 }

      // Re-query fresh (stale ElementHandles cause 30s Playwright timeout)
      const frame = allFrames[frameIdx] ?? allFrames[0]
      let el: ElementHandle | null = null
      try {
        const fresh = await frame.$$(xpath)
        el = fresh[0] ?? null
      } catch (eq) {
        emit(`${label} ✗ 重新查詢例外（${eq instanceof Error ? eq.message.split('\n')[0] : String(eq)}），跳過`)
        await sleepOrStop(5000, shouldStop ?? (() => false))
        continue
      }
      if (!el) {
        emit(`${label} ⚠️ 重新查詢找不到元素，跳過`)
        await sleepOrStop(5000, shouldStop ?? (() => false))
        continue
      }

      try {
        // evaluate click bypasses overlay/actionability checks
        await el.evaluate((node: Element) => (node as HTMLElement).click())
        emit(`${label} 已點擊`)
      } catch (e1) {
        // Fallback: coordinate click via mouse
        emit(`${label} evaluate 失敗（${e1 instanceof Error ? e1.message.split('\n')[0] : String(e1)}），嘗試座標點擊...`)
        try {
          const box = await el.boundingBox()
          if (box) {
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
            emit(`${label} 座標點擊完成 (${Math.round(box.x + box.width/2)}, ${Math.round(box.y + box.height/2)})`)
          } else {
            emit(`${label} ✗ 無法取得元素座標`)
          }
        } catch (e2) {
          emit(`${label} ✗ 座標點擊也失敗（${e2 instanceof Error ? e2.message.split('\n')[0] : String(e2)}）`)
        }
      }

      // After clicking btn_bet, game may show denomination overlay — dismiss it to complete the iDeck interaction
      await sleep(500)
      await dismissDenomOverlay(label)

      await sleepOrStop(4500, shouldStop ?? (() => false))
    }

    if (shouldStop?.()) return { step: 'iDeck 測試', status: 'skip', message: '已停止', durationMs: Date.now() - t0 }

    // Step 3: wait for API to sync, then find NEW entries (not in baseline)
    emit(`全部點擊完畢，等待 API 同步（15s）...`)
    await sleepOrStop(15000, shouldStop ?? (() => false))

    let ideckEntries: LogEntry[] = []
    try {
      const res = await fetch(apiUrl)
      if (res.ok) {
        const json = await res.json() as { data?: { timeline?: LogEntry[] } }
        const tl = json.data?.timeline ?? []
        ideckEntries = tl.filter(e => {
          if (e.type !== 'success_json') return false
          const d = typeof e.data === 'string' ? JSON.parse(e.data) as Record<string, unknown> : e.data
          if (d?.is_ideck !== true && d?.is_ideck !== 1) return false
          // Only count entries NOT in the baseline
          return !baselineKeys.has(`${e.time}|${JSON.stringify(e.data)}`)
        })
        emit(`API 回傳：新增 ${ideckEntries.length} 筆 iDeck success_json（點擊前基準 ${baselineKeys.size} 筆）`)
        ideckEntries.forEach(e => {
          const d = typeof e.data === 'string' ? JSON.parse(e.data) as Record<string, unknown> : e.data
          emit(`  ${e.time} cmd=${d.cmd} error=${d.error}`)
        })
      } else {
        emit(`API 請求失敗 status=${res.status}`)
      }
    } catch (err) {
      emit(`API 請求例外: ${err}`)
    }

    const passed = ideckEntries.length
    const total = buttons.length

    const source = betRandomXpaths && betRandomXpaths.length > 0 ? `隨機下注XPath` : `ideckRowClass(${profile?.ideckRowClass})`
    const cmdList = ideckEntries.map(e => {
      const d = typeof e.data === 'string' ? JSON.parse(e.data) as Record<string, unknown> : e.data
      return `${d.cmd}`
    }).join(', ')
    const message = `${source}，${total} 個按鈕，API 確認 ${passed}/${total} 有 iDeck 回應${cmdList ? `（${cmdList}）` : ''}`

    if (passed === 0) {
      return { step: 'iDeck 測試', status: 'fail', message, durationMs: Date.now() - t0 }
    } else if (passed < total) {
      return { step: 'iDeck 測試', status: 'warn', message, durationMs: Date.now() - t0 }
    }
    return { step: 'iDeck 測試', status: 'pass', message, durationMs: Date.now() - t0 }
  } catch (e) {
    return { step: 'iDeck 測試', status: 'fail', message: `例外: ${e}`, durationMs: Date.now() - t0 }
  }
}

async function stepTouchscreen(
  page: Page,
  emit: (msg: string) => void,
  machineCode: string,
  profile: MachineProfile | undefined,
  shouldStop?: () => boolean,
  debugGmid?: string,
): Promise<StepResult> {
  const t0 = Date.now()
  try {
    const touchPoints = profile?.touchPoints?.filter(p => p.trim())
    if (!touchPoints || touchPoints.length === 0) {
      return { step: '觸屏測試', status: 'skip', message: '此機種未設定 touchPoints，跳過', durationMs: 0 }
    }

    // Build element list: find span by text content for each touchPoint label.
    // Note: .screen-touch overlay spans are transparent so isVisible() returns false —
    // just take els[0] and click via evaluate (same as waitForNormalStatus).
    type TpEntry = { label: string; el: ElementHandle }
    const buttons: TpEntry[] = []
    for (const pt of touchPoints) {
      let found = false
      for (const frame of page.frames()) {
        try {
          const els = await frame.$$(`//span[normalize-space(text())='${pt}']`)
          if (els.length > 0) {
            buttons.push({ label: pt, el: els[0] })
            found = true
            break
          }
        } catch { /* frame detached */ }
      }
      if (!found) emit(`touchPoint "${pt}" ⚠️ 找不到元素，跳過`)
    }

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
    emit(`共 ${buttons.length} 個觸屏點位，逐一點擊...`)
    for (const { label, el } of buttons) {
      if (shouldStop?.()) return { step: '觸屏測試', status: 'skip', message: '已停止', durationMs: Date.now() - t0 }
      try {
        await page.evaluate((e: Element) => (e as HTMLElement).click(), el)
        emit(`"${label}" 已點擊`)
      } catch {
        emit(`"${label}" ✗ 點擊例外`)
      }
      await sleepOrStop(5000, shouldStop ?? (() => false))
    }

    if (shouldStop?.()) return { step: '觸屏測試', status: 'skip', message: '已停止', durationMs: Date.now() - t0 }

    // Step 3: wait for API sync
    emit(`全部點擊完畢，等待 API 同步（15s）...`)
    await sleepOrStop(15000, shouldStop ?? (() => false))

    let touchEntries: LogEntry[] = []
    try {
      const res = await fetch(apiUrl)
      if (res.ok) {
        const json = await res.json() as { data?: { timeline?: LogEntry[] } }
        const tl = json.data?.timeline ?? []
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
        emit(`API 請求失敗 status=${res.status}`)
      }
    } catch (err) {
      emit(`API 請求例外: ${err}`)
    }

    const passed = touchEntries.length
    const total = buttons.length
    const message = `${total} 個觸屏點位，API 確認 ${passed}/${total} 有觸屏回應`

    if (passed === 0) {
      return { step: '觸屏測試', status: 'fail', message, durationMs: Date.now() - t0 }
    } else if (passed < total) {
      return { step: '觸屏測試', status: 'warn', message, durationMs: Date.now() - t0 }
    }
    return { step: '觸屏測試', status: 'pass', message, durationMs: Date.now() - t0 }
  } catch (e) {
    return { step: '觸屏測試', status: 'fail', message: `例外: ${e}`, durationMs: Date.now() - t0 }
  }
}

async function stepCctv(page: Page, emit: (msg: string) => void, machineCode = '', sessionPrefix = ''): Promise<StepResult> {
  const t0 = Date.now()
  try {
    // Step 1: click the first header_btn_item to switch to CCTV view
    emit(`尋找 CCTV 按鈕（.header_btn_item）...`)
    let clicked = false
    for (const frame of page.frames()) {
      try {
        const els = await frame.$$('.header_btn_item')
        for (const el of els) {
          if (await el.isVisible()) {
            await page.evaluate((e: Element) => (e as HTMLElement).click(), el)
            clicked = true
            emit(`已點擊 CCTV 按鈕`)
            break
          }
        }
        if (clicked) break
      } catch { /* frame detached */ }
    }
    if (!clicked) {
      return { step: 'CCTV 號碼比對', status: 'fail', message: '找不到 .header_btn_item 按鈕', durationMs: Date.now() - t0 }
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
      if (!hasCctvDiv) {
        return { step: 'CCTV 號碼比對', status: 'fail', message: '切換後找不到 CCTV 影片元素', durationMs: Date.now() - t0 }
      }
      return { step: 'CCTV 號碼比對', status: 'warn', message: 'CCTV 容器存在但找不到 video 元素', durationMs: Date.now() - t0 }
    }

    emit(`CCTV video 元素已找到，播放中：${videoPlaying}`)

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
    let screenshotPath = ''

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
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
              mkdirSync(CCTV_SAVE_DIR, { recursive: true })
              const cctvFilename = `${sessionPrefix}${machineCode}.png`
              const savePath = join(CCTV_SAVE_DIR, cctvFilename)
              writeFileSync(savePath, buf)
              emit(`CCTV 截圖已複製：${savePath}`)
              void uploadCctvToServer(buf, cctvFilename)
            } catch { /* ignore save error */ }
          }
        }

        const raw = refBuf
          ? await callGeminiVisionMulti(COMBINED_PROMPT, [
              { base64: refBuf.toString('base64') },
              { base64: buf.toString('base64') },
            ])
          : await callGeminiVision(OCR_PROMPT, buf.toString('base64'), 'image/png')

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

    const playStatus = videoPlaying ? '播放中' : '未播放（黑畫面）'
    const ocrFailed = !ocrText || ocrText === '無法識別'
    const blurLabel = blurStatus === 'blurry' ? '，畫面模糊' : blurStatus === 'clear' ? '，畫面清晰' : ''
    const timeLabel = ocrTime ? `，時間：${ocrTime}` : ''
    const unexpectedLabel = hasUnexpected ? '，偵測到異常文字' : ''
    const message = `CCTV ${playStatus}，識別碼：${ocrText}${timeLabel}${blurLabel}${unexpectedLabel}${alignLabel}`

    if (!videoPlaying || blurStatus === 'blurry' || hasUnexpected || ocrFailed || alignFail) {
      return { step: 'CCTV 號碼比對', status: 'warn', message, durationMs: Date.now() - t0 }
    }
    return { step: 'CCTV 號碼比對', status: 'pass', message, durationMs: Date.now() - t0 }
  } catch (e) {
    return { step: 'CCTV 號碼比對', status: 'fail', message: `例外: ${e}`, durationMs: Date.now() - t0 }
  }
}

async function stepExit(page: Page, emit: (msg: string) => void, customExitSel?: string | null, waitForLeaveGM?: GMWaitFn): Promise<StepResult> {
  const t0 = Date.now()
  try {
    emit(`尋找退出按鈕...`)

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
    }

    // Step 3: Try Confirm dialog
    const confirmClicked = await safeClickXPath(page, "//button[.//div[normalize-space(text())='Confirm']]")
      || await safeClickXPath(page, "//button[normalize-space(text())='Confirm']")
      || await safeClickXPath(page, "//button[normalize-space(text())='確認']")
    if (confirmClicked) {
      emit(`點擊確認對話框`)
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
  /** Session ID prefix for cctv-saves / audio-saves filenames */
  private sessionPrefix: string = ''

  constructor(osmStatus?: Map<string, number>, profiles?: Map<string, MachineProfile>, betRandomConfig?: Record<string, string[]>) {
    super()
    this.osmStatus = osmStatus ?? new Map()
    this.profiles = profiles ?? new Map()
    this.betRandomConfig = betRandomConfig ?? {}
  }

  stop() { this.stopped = true }

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

      if (steps.entry) {
        const r = await stepEntry(page, machineCode, emit, profile, waitForEnterGM)
        stepResults.push(r)
        this.log(`${workerTag} [${r.status.toUpperCase()}] 進入機台: ${r.message}`, machineCode)

        // After entering, resolve final profile. Priority:
        // 1. enterMachineType exact match (overrides machine-code match)
        // 2. machine code match (already in `profile` from before entry)
        // 3. gmid from URL
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

          // Priority 3: gmid fallback if still nothing
          if (!profile) {
            const gameId = extractGameId(page.url())
            if (gameId) {
              for (const [, p] of this.profiles) {
                if (p.gmid && p.gmid.toLowerCase() === gameId) {
                  profile = p
                  matchedBy = `gmid=${gameId}`
                  break
                }
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
          const checkOsm = async () => {
            if (this.stopped) return
            const s = this.osmStatus.get(machineCode)
            if (s === undefined || s === 0) return  // normal — no log, proceed immediately
            const bonusWait = await waitForNormalStatus(this.osmStatus, machineCode, page, profile, emit)
            if (bonusWait) {
              stepResults.push({ step: '特殊遊戲等待', status: 'pass', message: `偵測到「${bonusWait.label}」，等待 ${(bonusWait.waited / 1000).toFixed(0)}s 後完成`, durationMs: bonusWait.waited })
              this.log(`${workerTag} [PASS] 特殊遊戲等待完成: ${bonusWait.label}`, machineCode)
            }
          }

          if (steps.stream) {
            await checkOsm()
            const r2 = await stepStream(page, emit, profile)
            stepResults.push(r2)
            this.log(`${workerTag} [${r2.status.toUpperCase()}] 推流: ${r2.message}`, machineCode)
          }

          const spinAudioRef: SpinAudioRef = { data: null }
          if (steps.spin) {
            await checkOsm()
            const r3 = await stepSpin(page, emit, profile?.spinSelector ?? null, profile?.balanceSelector ?? null, steps.audio ? spinAudioRef : undefined, aiAudio)
            stepResults.push(r3)
            this.log(`${workerTag} [${r3.status.toUpperCase()}] Spin: ${r3.message}`, machineCode)
          }

          if (steps.audio) {
            await checkOsm()
            const r4 = await stepAudio(page, emit, spinAudioRef, aiAudio, machineCode, this.sessionPrefix, profile?.audioConfig)
            stepResults.push(r4)
            this.log(`${workerTag} [${r4.status.toUpperCase()}] 音頻: ${r4.message}`, machineCode)
          }

          if (steps.ideck) {
            await checkOsm()
            const ideckXpaths = (profile?.ideckXpaths ?? []).length > 0 ? profile!.ideckXpaths! : this.betRandomConfig[machineCode]
            const r6 = await stepIdeck(page, emit, machineCode, profile, waitForIdeckCmd, ideckXpaths, () => this.stopped, this.debugGmid ?? undefined)
            stepResults.push(r6)
            this.log(`${workerTag} [${r6.status.toUpperCase()}] iDeck: ${r6.message}`, machineCode)
          }

          if (steps.touchscreen) {
            await checkOsm()
            const r7 = await stepTouchscreen(page, emit, machineCode, profile, () => this.stopped, this.debugGmid ?? undefined)
            stepResults.push(r7)
            this.log(`${workerTag} [${r7.status.toUpperCase()}] 觸屏: ${r7.message}`, machineCode)
          }

          if (steps.cctv) {
            await checkOsm()
            const r8 = await stepCctv(page, emit, machineCode, this.sessionPrefix)
            stepResults.push(r8)
            this.log(`${workerTag} [${r8.status.toUpperCase()}] CCTV: ${r8.message}`, machineCode)
          }

          if (steps.exit) {
            await checkOsm()

            // Exit with retry when leaveGMNtc errcode=10002 (Game is running):
            // check OSMWatcher — if still in bonus wait for it, then retry exit.
            let r5: StepResult | null = null
            const MAX_EXIT_ATTEMPTS = 3
            for (let attempt = 1; attempt <= MAX_EXIT_ATTEMPTS; attempt++) {
              r5 = await stepExit(page, emit, profile?.exitSelector ?? null, waitForLeaveGM)
              if (r5.status !== 'fail') break  // pass or warn → done

              // Any exit failure: check OSMWatcher — Jackpot/FG may have prevented exit
              // without returning errcode 10002 (game just silently refuses exit)
              const osmCurrent = this.osmStatus.get(machineCode)
              const osmInBonus = osmCurrent !== undefined && (BONUS_STATUSES.has(osmCurrent) || osmCurrent === 9)
              emit(`⚠️ 退出失敗（第 ${attempt}/${MAX_EXIT_ATTEMPTS} 次），檢查 OSMWatcher 狀態...`)
              if (osmInBonus) {
                emit(`OSMWatcher：${OSM_STATUS_LABELS[osmCurrent!] ?? osmCurrent}，等待特殊遊戲結束後重試退出...`)
                await checkOsm()
              } else {
                emit(`OSMWatcher 狀態正常（${osmCurrent ?? '未連線'}），3s 後重試退出...`)
                await sleep(3000)
              }
            }

            if (r5!.status === 'fail') {
              const hasSpecialGameStep = stepResults.some(s => s.step === '特殊遊戲等待')
              const osmCurrent = this.osmStatus.get(machineCode) ?? -1
              const osmInBonus = BONUS_STATUSES.has(osmCurrent) || osmCurrent === 9
              const gameKeywords = /game[_\s]|bonus|jackpot|special|grand|major|minor|mini|free.?spin/i
              const consoleLogs_snapshot = consoleLogs.join('\n')
              const hasGameLog = gameKeywords.test(consoleLogs_snapshot) || gameKeywords.test(r5!.message)
              const hasErrcode10002 = r5!.message.includes('errcode 10002')
              if (hasSpecialGameStep || osmInBonus || hasGameLog || hasErrcode10002) {
                const reason = hasErrcode10002 ? 'leaveGMNtc errcode 10002（遊戲正在運行中）'
                  : hasSpecialGameStep ? '特殊遊戲等待步驟'
                  : osmInBonus ? 'OSM 狀態碼異常'
                  : '日誌含 game 關鍵字'
                emit(`⚠️ 退出失敗原因分析：偵測到特殊遊戲狀態（${reason}），降級為 WARN`)
                r5 = { ...r5!, status: 'warn', message: `退出失敗（疑似卡在特殊遊戲/Bonus 中，請人工確認）— 原始: ${r5!.message}` }
              }
            }
            stepResults.push(r5!)
            this.log(`${workerTag} [${r5!.status.toUpperCase()}] 退出: ${r5!.message}`, machineCode)
          }
        }
      }
    } catch (e) {
      emit(`測試例外: ${e}`)
      stepResults.push({ step: '測試流程', status: 'fail', message: String(e), durationMs: 0 })
    } finally {
      await ctx.close()
    }

    const overall: StepStatus =
      stepResults.some(r => r.status === 'fail') ? 'fail'
      : stepResults.some(r => r.status === 'warn') ? 'warn'
      : 'pass'

    const result: MachineResult = { machineCode, overall, steps: stepResults, consoleLogs, startedAt, finishedAt: new Date().toISOString() }
    this.send({ type: 'machine_done', machineCode, status: overall, message: `${workerTag} ${machineCode} 測試完成：${overall.toUpperCase()}`, result, ts: new Date().toISOString() })
  }

  /** One worker: keeps pulling from the shared queue until empty */
  private async runWorker(browser: Browser, queue: MachineQueue, lobbyUrl: string, workerId: number, steps: MachineTestSession['steps'], aiAudio = false): Promise<void> {
    this.log(`[Worker-${workerId}] 啟動（大廳：${lobbyUrl.slice(0, 60)}...）`)
    while (!this.stopped) {
      const machineCode = queue.next()
      if (!machineCode) break
      await this.runMachine(browser, machineCode, lobbyUrl, workerId, steps, aiAudio)
      if (!this.stopped) await sleep(800)
    }
    this.log(`[Worker-${workerId}] 完成，離開`)
  }

  async run(session: MachineTestSession) {
    this.debugGmid = session.debugGmid?.trim() || null
    this.sessionPrefix = session.sessionId ? `${session.sessionId}-` : ''
    DAILY_ANALYSIS_BASE = DAILY_ANALYSIS_URLS[session.osmEnv ?? 'qat'] ?? DAILY_ANALYSIS_URLS.qat
    // Notify viewers that a new session is starting (clears previous results)
    this.send({ type: 'session_start', message: `開始測試 ${session.machineCodes.length} 台機器`, ts: new Date().toISOString() })
    if (this.debugGmid) this.log(`[調適模式] daily-analysis 渠道號固定為：${this.debugGmid}（機台代碼前綴替換）`)
    this.log(`📡 日誌 API 環境：${(session.osmEnv ?? 'qat').toUpperCase()} (${DAILY_ANALYSIS_BASE})`)
    let browser: Browser | null = null
    let originalAudioDevice = ''
    const useVBCable = existsSync(NIRCMD) && session.steps.audio
    // Reset serial audio queue for this run
    audioRecordingQueue = Promise.resolve()
    try {
      const workerCount = session.lobbyUrls.length
      this.log(`啟動瀏覽器（${workerCount} 個 Worker，共 ${session.machineCodes.length} 台機器）...`)

      // OSMWatcher 連線狀態確認
      const osmCount = this.osmStatus.size
      if (osmCount > 0) {
        this.log(`✅ 圖像識別服務已連線（OSMWatcher 監控中 ${osmCount} 台機台）— 特殊遊戲偵測已啟用`)
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
