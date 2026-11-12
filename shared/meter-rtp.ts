/**
 * Performance Meter 的 RTP 顯示規則：小數兩位**直接捨去**，跟 OSM 後台 EGM Performance Meter 一致
 * （2026-11-12 同事比對：104,578 ÷ 1,871,480 = 5.588%，後台顯示 5.58%，工具原本四捨五入成 5.59%）。
 *
 * 只處理浮點誤差：RTP = winLoss ÷ coinIn × 100，兩者是整數，所以「RTP×100」離整數不是 0 就是至少 1/coinIn。
 * 離整數不到 1e-9 才當成浮點誤差（例 0.29×100 = 28.999…），其餘一律捨去——
 * 不能先四捨五入到固定小數位，那會把真實的 5.5899996% 變成 5.59%（CodeX 11-12 指出）。
 * coinIn 小於 1e9 時這條界線都成立。
 */
export function truncRtp2(n: number): number {
  const x = n * 100
  const r = Math.round(x)
  const cents = Math.abs(x - r) < 1e-9 ? r : Math.trunc(x)
  return cents / 100
}
