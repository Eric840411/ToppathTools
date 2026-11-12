/**
 * Performance Meter 的 RTP 顯示規則：小數兩位**直接捨去**，跟 OSM 後台 EGM Performance Meter 一致
 * （2026-11-12 同事比對：104,578 ÷ 1,871,480 = 5.588%，後台顯示 5.58%，工具原本四捨五入成 5.59%）。
 *
 * 用原始 meter 值做**精確**十進位運算（BigInt），不經過浮點 RTP：
 * - 先四捨五入到固定小數位再捨去，會把真實的 5.5899996% 進位成 5.59%（CodeX 11-12 指出）；
 * - 只把「離整數 < 某門檻」當浮點誤差，門檻對夠大的 coinIn 一樣會誤進位（CodeX 11-12 第二輪指出）。
 * WIN/LOSE 也在這裡用 coinIn − coinOut − jackpotWins 重算，後端那份是浮點相減、可能帶誤差。
 */

/** 數字的十進位精確表示（值 = int ÷ 10^scale）；指數表示法（極大／極小）回 null。 */
function toDecimal(n: number): { int: bigint; scale: number } | null {
  if (!Number.isFinite(n)) return null
  const s = String(n)
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s)
  if (!m) return null
  const frac = m[3] ?? ''
  const v = BigInt(m[2] + frac)
  return { int: m[1] ? -v : v, scale: frac.length }
}

/**
 * RTP（%）小數兩位往零捨去：(coinIn − coinOut − jackpotWins) ÷ coinIn × 100。
 * coinIn 為 0 回 0（跟後端一致）；任何值無法精確表示時回 null，呼叫端退回後端的浮點 rtp。
 */
export function rtpTrunc2(coinIn: number, coinOut: number, jackpotWins: number): number | null {
  const parts = [coinIn, coinOut, jackpotWins].map(toDecimal)
  if (parts.some(p => p === null)) return null
  const scale = Math.max(...parts.map(p => p!.scale))
  const [ci, co, jw] = parts.map(p => p!.int * 10n ** BigInt(scale - p!.scale))
  if (ci === 0n) return 0
  const wl = ci - co - jw
  const abs = (x: bigint) => (x < 0n ? -x : x)
  const cents = (abs(wl) * 10000n) / abs(ci) // BigInt 除法本身就是往零捨去
  const neg = (wl < 0n) !== (ci < 0n) && cents !== 0n
  return (neg ? -1 : 1) * Number(cents) / 100
}
