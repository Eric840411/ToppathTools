/**
 * server/routes/audio.ts
 * Audio analysis utilities — WAV dBFS (RMS + Peak) analysis.
 *
 * POST /api/audio/analyze   — upload a WAV file, returns dBFS stats
 */
import { Router } from 'express'
import multer from 'multer'

export const router = Router()

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } })

// ── WAV parser ────────────────────────────────────────────────────────────────

interface WavInfo {
  channels: number
  sampleRate: number
  bitsPerSample: number
  durationSec: number
  channelStats: ChannelStat[]
}

interface ChannelStat {
  name: string
  rmsDbfs: number
  peakDbfs: number
  rmsLinear: number
  peakLinear: number
}

function analyzeWav(buf: Buffer): WavInfo {
  // Locate 'fmt ' chunk
  let fmtOffset = -1
  for (let i = 12; i < buf.length - 4; i++) {
    if (buf.toString('ascii', i, i + 4) === 'fmt ') { fmtOffset = i; break }
  }
  if (fmtOffset < 0) throw new Error('fmt chunk not found')

  const fmtSize    = buf.readUInt32LE(fmtOffset + 4)
  const audioFmt   = buf.readUInt16LE(fmtOffset + 8)   // 1=PCM, 3=float
  const channels   = buf.readUInt16LE(fmtOffset + 10)
  const sampleRate = buf.readUInt32LE(fmtOffset + 12)
  const bitsPerSample = buf.readUInt16LE(fmtOffset + 22)

  // Locate 'data' chunk
  let dataOffset = -1
  let dataSize   = 0
  for (let i = fmtOffset + 8 + fmtSize; i < buf.length - 4; i++) {
    if (buf.toString('ascii', i, i + 4) === 'data') {
      dataSize   = buf.readUInt32LE(i + 4)
      dataOffset = i + 8
      break
    }
  }
  if (dataOffset < 0) throw new Error('data chunk not found')

  const bytesPerSample = bitsPerSample / 8
  const totalSamples   = dataSize / bytesPerSample
  const framesPerChan  = totalSamples / channels

  // Read all samples as normalised floats (-1..1)
  const normalized: Float64Array[] = Array.from({ length: channels }, () => new Float64Array(framesPerChan))

  for (let i = 0; i < framesPerChan; i++) {
    for (let ch = 0; ch < channels; ch++) {
      const bytePos = dataOffset + (i * channels + ch) * bytesPerSample
      let val: number

      if (audioFmt === 3 && bitsPerSample === 32) {
        // 32-bit float
        val = buf.readFloatLE(bytePos)
      } else if (bitsPerSample === 8) {
        // unsigned 8-bit
        val = (buf.readUInt8(bytePos) - 128) / 128
      } else if (bitsPerSample === 16) {
        val = buf.readInt16LE(bytePos) / 32768
      } else if (bitsPerSample === 24) {
        const lo = buf.readUInt16LE(bytePos)
        const hi = buf.readInt8(bytePos + 2)
        val = ((hi << 16) | lo) / 8388608
      } else if (bitsPerSample === 32) {
        val = buf.readInt32LE(bytePos) / 2147483648
      } else {
        val = 0
      }
      normalized[ch][i] = val
    }
  }

  const MINUS_INF = -999

  const computeStat = (samples: Float64Array, name: string): ChannelStat => {
    let sumSq = 0, peak = 0
    for (let i = 0; i < samples.length; i++) {
      const v = Math.abs(samples[i])
      sumSq += v * v
      if (v > peak) peak = v
    }
    const rmsLinear = Math.sqrt(sumSq / samples.length)
    const rmsDbfs   = rmsLinear  > 0 ? 20 * Math.log10(rmsLinear)  : MINUS_INF
    const peakDbfs  = peak       > 0 ? 20 * Math.log10(peak)       : MINUS_INF
    return { name, rmsDbfs, peakDbfs, rmsLinear, peakLinear: peak }
  }

  const CHAN_NAMES = ['L', 'R', 'C', 'LFE', 'BL', 'BR']
  const channelStats: ChannelStat[] = normalized.map((s, i) =>
    computeStat(s, CHAN_NAMES[i] ?? `Ch${i + 1}`)
  )

  // Mix-down stat if stereo+
  if (channels >= 2) {
    const mixed = new Float64Array(framesPerChan)
    for (let i = 0; i < framesPerChan; i++) {
      let sum = 0
      for (let ch = 0; ch < channels; ch++) sum += normalized[ch][i]
      mixed[i] = sum / channels
    }
    channelStats.push(computeStat(mixed, 'Mix'))
  }

  return {
    channels,
    sampleRate,
    bitsPerSample,
    durationSec: framesPerChan / sampleRate,
    channelStats,
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /api/audio/analyze
 * Body: multipart/form-data  field: "file"  (WAV)
 *
 * Returns:
 * {
 *   filename, channels, sampleRate, bitsPerSample, durationSec,
 *   channels: [{ name, rmsDbufs, peakDbfs, rmsLinear, peakLinear }]
 *   summary: string   — human-readable one-liner
 * }
 */
router.post('/api/audio/analyze', upload.single('file'), (req, res) => {
  try {
    const file = req.file
    if (!file) {
      res.status(400).json({ error: 'No file uploaded (field name: file)' })
      return
    }

    const info = analyzeWav(file.buffer)
    const mix  = info.channelStats.find(s => s.name === 'Mix') ?? info.channelStats[0]

    const fmt = (v: number) => v <= -990 ? '-∞' : v.toFixed(2)
    const summary =
      `${info.channels === 1 ? 'Mono' : info.channels === 2 ? 'Stereo' : `${info.channels}ch`} ` +
      `${info.sampleRate / 1000}kHz ${info.bitsPerSample}bit | ` +
      `${info.durationSec.toFixed(2)}s | ` +
      `RMS ${fmt(mix.rmsDbfs)} dBFS | Peak ${fmt(mix.peakDbfs)} dBFS`

    res.json({
      filename:     file.originalname,
      channels:     info.channels,
      sampleRate:   info.sampleRate,
      bitsPerSample: info.bitsPerSample,
      durationSec:  parseFloat(info.durationSec.toFixed(3)),
      channelStats: info.channelStats.map(s => ({
        name:       s.name,
        rmsDbfs:    parseFloat(s.rmsDbfs.toFixed(2)),
        rmsDbfsStr: fmt(s.rmsDbfs),
        peakDbfs:   parseFloat(s.peakDbfs.toFixed(2)),
        peakDbfsStr: fmt(s.peakDbfs),
      })),
      summary,
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    res.status(400).json({ error: `WAV parse error: ${msg}` })
  }
})
