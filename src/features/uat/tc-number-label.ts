/**
 * 卡片上的綁定 TC：直接列編號，同前綴只寫第一個（T-049/050/051），同事 1109 要求「不用列標題」。
 * 沒有編號的照筆數寫。滑鼠移上去看每一筆的標題。
 */
export function tcNumbersLabel(bindings: { number?: string }[]): string {
  if (!bindings.length) return '綁 0 TC'
  const nums = bindings.map(b => (b.number || '').trim())
  if (nums.some(n => !n)) return `綁 ${bindings.length} TC`
  const head = nums[0].match(/^(.*?)(\d+)$/)
  const prefix = head ? head[1] : null
  return '綁 ' + nums.map((n, i) => {
    if (i === 0 || prefix == null) return n
    const m = n.match(/^(.*?)(\d+)$/)
    return m && m[1] === prefix ? m[2] : n
  }).join('/')
}
