/**
 * 最小可用的 ZIP 產生器（只做 store，不壓縮）。
 *
 * **為什麼自己寫**：這個專案沒有 zip 依賴，而要打包的東西是 PNG——本來就壓過了，
 * 再 deflate 一次省不到多少，卻要多一個依賴。store 模式的 zip 規格很小，寫死比裝套件划算。
 *
 * ⚠️ 只支援 **store（method 0）**、不支援 zip64。超過 4GB 或超過 65,535 個檔案時會回錯，
 *    不要讓它默默產生一個壞掉的檔案——那種 zip 開起來像是空的，很難查。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

/** DOS 時間格式（ZIP 用的老格式，秒只有 2 秒精度） */
function dosDateTime(d: Date): { time: number; date: number } {
  const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1F)
  const date = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F)
  return { time, date }
}

export interface ZipEntry {
  /** zip 內的路徑，用 `/` 分隔 */
  name: string
  data: Buffer
  mtime?: Date
}

export function createStoreZip(entries: ZipEntry[]): Buffer {
  if (entries.length > 0xFFFF) {
    throw new Error(`zip 檔案數超過上限（${entries.length} > 65535），需要 zip64`)
  }
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8')
    const { time, date } = dosDateTime(e.mtime ?? new Date())
    const crc = crc32(e.data)
    const size = e.data.length

    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)              // version needed
    local.writeUInt16LE(0x0800, 6)          // flag: UTF-8 檔名（中文檔名要靠這個位元）
    local.writeUInt16LE(0, 8)               // method: store
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(size, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    nameBuf.copy(local, 30)
    locals.push(local, e.data)

    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)            // version made by
    central.writeUInt16LE(20, 6)            // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(size, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)            // extra len
    central.writeUInt16LE(0, 32)            // comment len
    central.writeUInt16LE(0, 34)            // disk number
    central.writeUInt16LE(0, 36)            // internal attrs
    central.writeUInt32LE(0, 38)            // external attrs
    central.writeUInt32LE(offset, 42)
    nameBuf.copy(central, 46)
    centrals.push(central)

    offset += local.length + size
  }

  const centralBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  const out = Buffer.concat([...locals, centralBuf, end])
  if (out.length > 0xFFFFFFFF) throw new Error('zip 超過 4GB，需要 zip64')
  return out
}
