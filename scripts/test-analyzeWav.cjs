// Mirrors server/machine-test/runner.ts analyzeWav() exactly
const fs = require('fs')

function analyzeWav(filePath) {
  const buf = fs.readFileSync(filePath)
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

  console.log(`channels=${channels} sampleRate=${sampleRate} bits=${bitsPerSample} frames=${frameCount}`)

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
  console.log(`Overall RMS: ${rmsDb.toFixed(1)} dB`)

  // NEW algorithm: average across active windows
  const WIN = 512
  const HOP = WIN
  let maxWinEnergy = 0
  for (let i = 0; i < frameCount - WIN; i += HOP) {
    let e = 0
    for (let j = 0; j < WIN; j++) e += mono[i + j] * mono[i + j]
    if (e > maxWinEnergy) maxWinEnergy = e
  }
  console.log(`maxWinEnergy=${maxWinEnergy.toExponential(3)}, threshold(10%)=${(maxWinEnergy*0.10).toExponential(3)}`)

  const silenceThresh = maxWinEnergy * 0.10
  let centroidSum = 0, centroidCount = 0
  for (let i = 0; i < frameCount - WIN; i += HOP) {
    let e = 0
    for (let j = 0; j < WIN; j++) e += mono[i + j] * mono[i + j]
    if (e < silenceThresh) continue
    const win = mono.slice(i, i + WIN)
    let centNum = 0, centDen = 0
    for (let k = 1; k < WIN / 2; k++) {
      let re = 0, im = 0
      for (let n = 0; n < WIN; n++) {
        const a = -2 * Math.PI * k * n / WIN
        re += win[n] * Math.cos(a)
        im += win[n] * Math.sin(a)
      }
      const mag = Math.sqrt(re * re + im * im)
      centNum += k * sampleRate / WIN * mag
      centDen += mag
    }
    if (centDen > 0) {
      const c = centNum / centDen
      const eDb = 10 * Math.log10(e / maxWinEnergy)
      console.log(`  win@t=${(i/sampleRate).toFixed(2)}s eDb=${eDb.toFixed(1)} centroid=${c.toFixed(0)} Hz`)
      centroidSum += c; centroidCount++
    }
  }
  const spectralCentroid = centroidCount > 0 ? centroidSum / centroidCount : 0
  console.log(`\nFinal centroid: ${spectralCentroid.toFixed(0)} Hz (${centroidCount} windows)`)
  return spectralCentroid
}

analyzeWav(process.argv[2])
