const fs = require('fs')

const filePath = process.argv[2]
const buf = fs.readFileSync(filePath)

const audioFormat = buf.readUInt16LE(20)
const channels = buf.readUInt16LE(22)
const sampleRate = buf.readUInt32LE(24)
const bitsPerSample = buf.readUInt16LE(34)

// Find 'data' chunk
let dataOffset = 12
while (dataOffset < buf.length - 8) {
  const chunkId = buf.toString('ascii', dataOffset, dataOffset + 4)
  const chunkSize = buf.readUInt32LE(dataOffset + 4)
  if (chunkId === 'data') { dataOffset += 8; break }
  dataOffset += 8 + chunkSize
}

const bytesPerSample = bitsPerSample / 8
const numSamples = Math.floor((buf.length - dataOffset) / (bytesPerSample * channels))
const duration = numSamples / sampleRate

console.log('Channels:', channels, '| Rate:', sampleRate, 'Hz | Bits:', bitsPerSample, '| Duration:', duration.toFixed(2) + 's')

const samples = []
for (let i = 0; i < numSamples; i++) {
  const offset = dataOffset + i * channels * bytesPerSample
  samples.push(buf.readInt16LE(offset))
}

const overallRms = Math.sqrt(samples.reduce((s, x) => s + x * x, 0) / samples.length)
console.log('Overall RMS:', (20 * Math.log10(overallRms / 32768)).toFixed(1), 'dB')

function dftCentroid(sub) {
  const N = sub.length
  let bestPower = 0, bestCentroid = 0
  const re = new Float64Array(N / 2)
  const im = new Float64Array(N / 2)
  let totalPow = 0
  let weightedSum = 0
  for (let k = 0; k < N / 2; k++) {
    let r = 0, i2 = 0
    for (let n = 0; n < N; n++) {
      const angle = 2 * Math.PI * k * n / N
      r += sub[n] * Math.cos(angle)
      i2 -= sub[n] * Math.sin(angle)
    }
    const p = r * r + i2 * i2
    totalPow += p
    weightedSum += k * p
  }
  return totalPow > 0 ? (weightedSum / totalPow) * sampleRate / N : 0
}

const winSize = sampleRate
for (let t = 0; t < samples.length - winSize; t += winSize) {
  const win = samples.slice(t, t + winSize)
  const winRms = Math.sqrt(win.reduce((s, x) => s + x * x, 0) / win.length)
  const winDb = 20 * Math.log10((winRms || 1) / 32768)
  if (winDb < -60) {
    console.log('t=' + (t / sampleRate).toFixed(0) + 's: SILENT (' + winDb.toFixed(1) + ' dB)')
    continue
  }

  const N = 512
  let bestPower = 0, bestCentroid = 0
  for (let s2 = 0; s2 < win.length - N; s2 += N) {
    const sub = win.slice(s2, s2 + N)
    const subRms = Math.sqrt(sub.reduce((a, x) => a + x * x, 0) / N)
    let totalPow = 0, weightedSum = 0
    for (let k = 0; k < N / 2; k++) {
      let r = 0, im = 0
      for (let n = 0; n < N; n++) {
        const angle = 2 * Math.PI * k * n / N
        r += sub[n] * Math.cos(angle)
        im -= sub[n] * Math.sin(angle)
      }
      const p = r * r + im * im
      totalPow += p
      weightedSum += k * p
    }
    if (totalPow > bestPower) {
      bestPower = totalPow
      bestCentroid = totalPow > 0 ? (weightedSum / totalPow) * sampleRate / N : 0
    }
  }
  console.log('t=' + (t / sampleRate).toFixed(0) + 's: RMS=' + winDb.toFixed(1) + ' dB, centroid=' + bestCentroid.toFixed(0) + ' Hz')
}
