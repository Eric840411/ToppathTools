// Test ZCR-based centroid estimation
const fs = require('fs')

function analyzeWithZCR(filePath) {
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
  const frameCount = Math.floor((buf.length - dataOffset) / (2 * channels))

  const mono = new Float32Array(frameCount)
  let sumSq = 0
  for (let i = 0; i < frameCount; i++) {
    let sum = 0
    for (let c = 0; c < channels; c++) sum += buf.readInt16LE(dataOffset + (i * channels + c) * 2)
    mono[i] = sum / channels / 32768
    sumSq += mono[i] * mono[i]
  }
  const rmsDb = 20 * Math.log10(Math.sqrt(sumSq / frameCount))
  console.log(`Overall RMS: ${rmsDb.toFixed(1)} dB`)

  // Use 4096-sample windows (93ms) — smooths transients
  const WIN = 4096
  const HOP = WIN

  // Find max window energy
  let maxE = 0
  for (let i = 0; i < frameCount - WIN; i += HOP) {
    let e = 0
    for (let j = 0; j < WIN; j++) e += mono[i+j] * mono[i+j]
    if (e > maxE) maxE = e
  }

  const thresh = maxE * 0.10
  let zcrSum = 0, count = 0
  for (let i = 0; i < frameCount - WIN; i += HOP) {
    let e = 0, zc = 0
    for (let j = 0; j < WIN; j++) {
      e += mono[i+j] * mono[i+j]
      if (j > 0 && mono[i+j-1] * mono[i+j] < 0) zc++
    }
    if (e < thresh) continue
    const estFreq = zc * sampleRate / (2 * WIN)  // ZCR → mean freq
    const eDb = 10 * Math.log10(e / maxE)
    console.log(`  t=${(i/sampleRate).toFixed(2)}s eDb=${eDb.toFixed(1)} ZC=${zc} estFreq=${estFreq.toFixed(0)} Hz`)
    zcrSum += estFreq; count++
  }
  console.log(`\nAvg ZCR-freq: ${count > 0 ? (zcrSum/count).toFixed(0) : 'n/a'} Hz (${count} windows)`)
}

for (const f of process.argv.slice(2)) {
  console.log(`\n=== ${f.split('/').pop()} ===`)
  analyzeWithZCR(f)
}
